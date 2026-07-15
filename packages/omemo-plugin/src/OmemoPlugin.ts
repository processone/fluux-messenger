// `OmemoPlugin` — the `E2EEPlugin` adapter over `@fluux/omemo`.
//
// Task 10 covered the identity/probe/trust half of the trait; Task 11 adds the
// encrypt/claim/decrypt half — the XEP-0420 SCE seam where host plaintext meets
// OMEMO ciphertext. The host hands `encrypt` a serialized
// `<payload xmlns='jabber:client'>…</payload>` fragment; we SCE-wrap its children,
// OMEMO-encrypt the envelope, and emit an `<encrypted xmlns='urn:xmpp:omemo:2'>`.
// `decrypt` reverses that, returning a re-serialized `<payload>` (or a
// control-message / broken-session status — never unauthenticated content).
import { serializePayloadEnvelope, parsePayloadEnvelope } from '@fluux/sdk'
import type {
  E2EEPlugin,
  E2EEProtocolDescriptor,
  PluginContext,
  IdentityInfo,
  PeerSupport,
  BareJID,
  TrustState,
  VerificationMethod,
  VerificationFlow,
  ConversationTarget,
  ConversationHandle,
  EncryptedPayload,
  DecryptResult,
  InboundDecryptContext,
  ArchiveDecryptItem,
  SecurityContext,
  XMLElementData,
} from '@fluux/sdk'
import { OmemoAccount } from '@fluux/omemo'
import type { OmemoMessage } from '@fluux/omemo'
import { PluginStorageOmemoStore } from './store'
import { publishDeviceList, fetchDeviceList, fetchBundle, publishBundle } from './pep'
import { resolveInboundTrust, toTrustState, type BtbvState } from './trust'
import { buildEnvelope, parseEnvelope } from './sce'
import { buildEncrypted, parseEncrypted } from './encryptedElement'
import { elementToData, dataToElement, parseXml } from './stanzaData'
import { NS_OMEMO } from './namespaces'

/** Upper bound on devices we encrypt to per recipient JID (defensive against a hostile device list). */
const DEVICE_CAP = 50

const hex = (u: Uint8Array): string => [...u].map((b) => b.toString(16).padStart(2, '0')).join('')

/**
 * Narrow a stored/derived {@link TrustState} to the `SecurityContext.trust`
 * shape (which has no `unknown`). After a successful decrypt BTBV always yields
 * `tofu`/`untrusted`; `unknown` should not occur, but if it ever did we surface
 * the conservative `untrusted` rather than an over-trusting default.
 */
function toSecurityTrust(t: TrustState): SecurityContext['trust'] {
  return t === 'unknown' ? 'untrusted' : t
}

export class OmemoPlugin implements E2EEPlugin {
  readonly descriptor: E2EEProtocolDescriptor = {
    id: 'omemo:2',
    displayName: 'OMEMO',
    securityLevel: 80,
    features: {
      forwardSecrecy: true,
      postCompromiseSecurity: true,
      multiDevice: true,
      groupChat: false,
      asynchronous: true,
      deniability: true,
    },
  }

  private ctx!: PluginContext
  private account: OmemoAccount | null = null
  private readonly rng: (n: number) => Uint8Array = (n) => crypto.getRandomValues(new Uint8Array(n))

  async init(ctx: PluginContext): Promise<void> {
    this.ctx = ctx
  }

  async shutdown(): Promise<void> {
    this.account = null
  }

  /** Lazily creates/loads the local `OmemoAccount`. Idempotent across restarts (`OmemoAccount.create` loads an existing identity when the store has one). */
  private async ensureAccount(): Promise<OmemoAccount> {
    if (this.account) return this.account
    const store = new PluginStorageOmemoStore(this.ctx.storage)
    this.account = await OmemoAccount.create(store, this.rng)
    return this.account
  }

  async ensureIdentity(): Promise<IdentityInfo> {
    const acc = await this.ensureAccount()
    const myDeviceId = acc.publishableDeviceId()
    await publishBundle(this.ctx.xmpp, myDeviceId, await acc.publishableBundleAsync())
    const existing = await fetchDeviceList(this.ctx.xmpp, this.ctx.account.jid)
    if (!existing.includes(myDeviceId)) {
      await publishDeviceList(this.ctx.xmpp, [...existing, myDeviceId])
    }
    return {
      fingerprint: hex(acc.identityFingerprint()),
      devices: [{ jid: this.ctx.account.jid, deviceId: String(myDeviceId) }],
    }
  }

  async probePeer(peer: BareJID): Promise<PeerSupport> {
    const ids = await fetchDeviceList(this.ctx.xmpp, peer)
    return { supported: ids.length > 0, ttl: 300, variant: NS_OMEMO }
  }

  getVerificationMethods(): VerificationMethod[] {
    return [
      {
        id: 'fingerprint-compare',
        displayName: 'Compare fingerprints',
        description: 'Confirm the safety number out of band.',
      },
    ]
  }

  async startVerification(_peer: BareJID, _method: VerificationMethod): Promise<VerificationFlow> {
    throw new Error('fingerprint-compare verification UI is a later sub-project')
  }

  async getPeerTrust(peer: BareJID): Promise<TrustState> {
    const store = new PluginStorageOmemoStore(this.ctx.storage)
    const ids = await fetchDeviceList(this.ctx.xmpp, peer)
    // Surface the STRONGEST concern with priority: a single untrusted device
    // dominates (attention needed), then any explicitly verified device, then
    // blind-trusted (tofu), else unknown. Never drop an untrusted/verified
    // signal the way a naive "promote unknown->tofu only" pass would.
    let sawUntrusted = false
    let sawVerified = false
    let sawTofu = false
    for (const id of ids) {
      const t = await store.loadTrust(peer, id)
      const s = toTrustState((t?.state as BtbvState) ?? 'undecided')
      if (s === 'untrusted') sawUntrusted = true
      else if (s === 'verified') sawVerified = true
      else if (s === 'tofu') sawTofu = true
    }
    if (sawUntrusted) return 'untrusted'
    if (sawVerified) return 'verified'
    if (sawTofu) return 'tofu'
    return 'unknown'
  }

  async getDeviceTrust(peer: BareJID, deviceId: string): Promise<TrustState> {
    const store = new PluginStorageOmemoStore(this.ctx.storage)
    const t = await store.loadTrust(peer, Number(deviceId))
    return toTrustState((t?.state as BtbvState) ?? 'undecided')
  }

  // --- Task 11: encrypt / claim / decrypt (the SCE seam). ---

  async openConversation(target: ConversationTarget): Promise<ConversationHandle> {
    if (target.kind !== 'direct') throw new Error('OMEMO M2a supports 1:1 conversations only')
    return { protocolId: this.descriptor.id, state: { peer: target.peer } }
  }

  async closeConversation(_handle: ConversationHandle): Promise<void> {}

  private peerOf(handle: ConversationHandle): string {
    return (handle.state as { peer: string }).peer
  }

  /**
   * Ensure a session exists for every device in `deviceIds`, fetching+processing
   * bundles only for devices we have no session with. Crucially it NEVER
   * re-processes a bundle for an existing session: `processBundle` overwrites the
   * stored ratchet with a fresh X3DH, so re-processing an established session
   * would desync the peer (their ratchet no longer matches ours). Devices whose
   * bundle is missing or unusable are skipped, not fatal.
   */
  private async ensureSessions(acc: OmemoAccount, jid: string, deviceIds: number[]): Promise<void> {
    const store = new PluginStorageOmemoStore(this.ctx.storage)
    for (const rid of deviceIds) {
      if (await store.loadSession(jid, rid)) continue // established — do not clobber the ratchet
      const bundle = await fetchBundle(this.ctx.xmpp, jid, rid)
      if (!bundle) continue
      try {
        await acc.processBundle(jid, rid, bundle)
      } catch {
        /* unusable/invalid bundle for this device — skip it, encrypt to the rest */
      }
    }
  }

  async encrypt(handle: ConversationHandle, plaintext: Uint8Array): Promise<EncryptedPayload> {
    const acc = await this.ensureAccount()
    const peer = this.peerOf(handle)

    // Host boundary: `plaintext` is a serialized <payload xmlns='jabber:client'>
    // fragment. Recover its children and SCE-wrap them (XEP-0420 envelope with a
    // <to>/<from> affix, a sender-attested <time>, and mandatory <rpad>).
    const children = parsePayloadEnvelope(new TextDecoder().decode(plaintext)) ?? []
    const envelope = buildEnvelope(
      children,
      { to: peer, from: this.ctx.account.jid, timeIso: new Date().toISOString() },
      this.rng,
    )
    const sceBytes = new TextEncoder().encode(envelope.toString())

    // Recipients = the peer's devices + our OWN other devices (encrypt-to-self so
    // sibling devices and MAM replay stay readable), never our own sending device.
    const myDev = acc.publishableDeviceId()
    const peerDevs = (await fetchDeviceList(this.ctx.xmpp, peer)).slice(0, DEVICE_CAP)
    // The conversation PEER must have at least one OMEMO device. Otherwise the
    // encrypt-to-self recipients below would keep `recipients` non-empty (self
    // only) and we'd emit an <encrypted> addressed to NONE of the peer's devices —
    // ciphertext the intended recipient can never read, reported to the host as a
    // secure send. Fail LOUD (a peer with no published devices, or a transient PEP
    // miss) so the host applies its plaintext policy rather than silently sending.
    if (peerDevs.length === 0) {
      throw new Error(`OMEMO: peer ${peer} has no usable OMEMO devices`)
    }
    const ownDevs = (await fetchDeviceList(this.ctx.xmpp, this.ctx.account.jid))
      .filter((d) => d !== myDev)
      .slice(0, DEVICE_CAP)

    await this.ensureSessions(acc, peer, peerDevs)
    await this.ensureSessions(acc, this.ctx.account.jid, ownDevs)

    const recipients = [
      { jid: peer, deviceIds: peerDevs },
      { jid: this.ctx.account.jid, deviceIds: ownDevs },
    ].filter((r) => r.deviceIds.length > 0)
    // Fail LOUD rather than ever transmitting the body in the clear.
    if (recipients.length === 0) {
      throw new Error('OMEMO: no recipient devices to encrypt to; refusing to send plaintext')
    }

    const msg = await acc.encrypt(recipients, sceBytes)
    return {
      protocolId: this.descriptor.id,
      stanzaElement: elementToData(buildEncrypted(msg)),
      fallbackBody: '[This message is OMEMO-encrypted.]',
    }
  }

  tryClaimInbound(stanzaChild: XMLElementData): EncryptedPayload | null {
    if (stanzaChild.name !== 'encrypted' || stanzaChild.attrs?.xmlns !== NS_OMEMO) return null
    return { protocolId: this.descriptor.id, stanzaElement: stanzaChild }
  }

  async decrypt(
    handle: ConversationHandle,
    payload: EncryptedPayload,
    context?: InboundDecryptContext,
  ): Promise<DecryptResult> {
    return this.decryptWith(handle, payload, context, false)
  }

  async decryptArchive(
    handle: ConversationHandle,
    payload: EncryptedPayload,
    context?: InboundDecryptContext,
  ): Promise<DecryptResult> {
    return this.decryptWith(handle, payload, context, true)
  }

  async decryptArchiveBatch(
    handle: ConversationHandle,
    items: ArchiveDecryptItem[],
  ): Promise<DecryptResult[]> {
    const out: DecryptResult[] = []
    for (const it of items) {
      // Keep the result array index-aligned with `items`: a failure occupies its
      // slot with a broken-session result rather than shifting later results.
      try {
        out.push(await this.decryptWith(handle, it.payload, it.context, true))
      } catch {
        out.push(this.brokenResult(this.peerOf(handle)))
      }
    }
    return out
  }

  private brokenResult(jid: string, deviceId: number | string = '0'): DecryptResult {
    return {
      status: 'broken-session',
      senderDevice: { jid, deviceId: String(deviceId) },
      securityContext: {
        protocolId: this.descriptor.id,
        trust: 'untrusted',
        notes: ['session could not be established'],
      },
    }
  }

  /**
   * Resolve + persist BTBV trust for a just-decrypted (authenticated) device, and
   * build the `SecurityContext` for the result. `OmemoAccount.decrypt` records a
   * device's identity key on first contact as `undecided`; here we promote that to
   * the blind-trust decision (or preserve an explicit prior decision — never a
   * downgrade). Archive-only decrypts leave no `undecided` record to promote.
   */
  private async resolveInboundSecurity(senderJid: string, sid: number): Promise<SecurityContext> {
    const store = new PluginStorageOmemoStore(this.ctx.storage)
    const existing = await store.loadTrust(senderJid, sid)
    const peerHasVerified = await this.peerHasVerifiedDevice(store, senderJid)
    const resolved = resolveInboundTrust(peerHasVerified, (existing?.state as BtbvState | undefined) ?? null)
    if (existing) {
      // Promote a blank/undecided record IN PLACE, keeping its bound identity key.
      // resolveInboundTrust preserves any explicit prior decision, so this never
      // downgrades an existing verified/untrusted verdict.
      if (existing.state !== resolved.store) {
        await store.saveTrust(senderJid, sid, { ...existing, state: resolved.store })
      }
    } else {
      // First-seen device with NO record to promote. `OmemoAccount.decrypt` records
      // the BTBV identity key + `undecided` state on non-archive first contact, but
      // an ARCHIVE-mode decrypt skips that write — so without persisting here,
      // getPeerTrust/getDeviceTrust would report `unknown` for a device the message
      // just surfaced as `tofu`. Record the resolved decision now, bound to the
      // sender's published identity key when we can fetch it (best-effort empty bytes
      // otherwise — we never drop the decision over a transient bundle miss). There is
      // no prior explicit decision to overwrite, so the no-downgrade rule holds.
      const identityKey = await this.fetchIdentityKey(senderJid, sid)
      await store.saveTrust(senderJid, sid, { state: resolved.store, identityKey })
    }
    return { protocolId: this.descriptor.id, trust: toSecurityTrust(resolved.surfaced) }
  }

  /**
   * Best-effort fetch of a device's published Ed25519 identity key, to bind onto a
   * first-seen `TrustRecord`. Returns empty bytes if the bundle is unavailable; the
   * caller persists the trust *state* regardless so trust queries stay consistent.
   */
  private async fetchIdentityKey(jid: string, deviceId: number): Promise<Uint8Array> {
    try {
      const bundle = await fetchBundle(this.ctx.xmpp, jid, deviceId)
      if (bundle) return bundle.ik
    } catch {
      /* bundle unavailable (retracted device, PEP miss) — persist state with empty IK */
    }
    return new Uint8Array(0)
  }

  /**
   * BTBV gate: has the peer any EXPLICITLY out-of-band-verified device? Explicit
   * verification is tracked by a separate marker introduced with the verification
   * flow (see `trust.ts`); until that lands no device counts as verified, so new
   * devices are blind-trusted. Blind-trusted (`'trusted'`) devices deliberately do
   * NOT count here — otherwise the second device a peer adds would be forced to
   * `untrusted`, defeating blind-trust-before-verification.
   */
  private async peerHasVerifiedDevice(_store: PluginStorageOmemoStore, _peer: string): Promise<boolean> {
    return false
  }

  private async decryptWith(
    handle: ConversationHandle,
    payload: EncryptedPayload,
    context: InboundDecryptContext | undefined,
    archive: boolean,
  ): Promise<DecryptResult> {
    const acc = await this.ensureAccount()
    // For a self-outgoing carbon/MAM replay the ciphertext came from OUR other
    // device, so the session partner is our own JID, not the conversation peer.
    const senderJid = context?.isSelfOutgoing ? this.ctx.account.jid : this.peerOf(handle)

    let msg: OmemoMessage
    try {
      msg = parseEncrypted(dataToElement(payload.stanzaElement))
    } catch {
      return this.brokenResult(senderJid)
    }

    let content: Uint8Array
    try {
      content = await acc.decrypt(senderJid, msg.sid, msg, { archive })
    } catch {
      // Auth/session failure (bad HMAC, no key for us, desync). Map to
      // broken-session — never throw to the host, never surface content.
      return this.brokenResult(senderJid, msg.sid)
    }

    const securityContext = await this.resolveInboundSecurity(senderJid, msg.sid)
    const senderDevice = { jid: senderJid, deviceId: String(msg.sid) }

    // 0-length recovered content = key-transport / empty ratchet advance.
    if (content.length === 0) return { status: 'control-message', senderDevice, securityContext }

    let env: ReturnType<typeof parseEnvelope>
    try {
      env = parseEnvelope(parseXml(new TextDecoder().decode(content)))
    } catch {
      // Authenticated bytes that are not a valid SCE envelope: treat as a broken
      // session rather than surfacing malformed content as a decrypted body.
      return this.brokenResult(senderJid, msg.sid)
    }

    const plaintext = new TextEncoder().encode(serializePayloadEnvelope(env.content))
    const authoredAt = env.timeIso ? new Date(env.timeIso) : undefined
    return { plaintext, status: 'ok', senderDevice, securityContext, ...(authoredAt ? { authoredAt } : {}) }
  }

  async repairSession(_handle: ConversationHandle, peer: BareJID): Promise<void> {
    // Rebuild a desynced session: force a fresh X3DH for the peer's devices
    // (overwriting the broken ratchet — unlike `ensureSessions`, which preserves
    // existing sessions) and send an empty key-transport so the peer re-handshakes.
    const acc = await this.ensureAccount()
    const devs = (await fetchDeviceList(this.ctx.xmpp, peer)).slice(0, DEVICE_CAP)
    const fresh: number[] = []
    for (const rid of devs) {
      const bundle = await fetchBundle(this.ctx.xmpp, peer, rid)
      if (!bundle) continue
      try {
        await acc.processBundle(peer, rid, bundle)
        fresh.push(rid)
      } catch {
        /* skip devices with unusable bundles */
      }
    }
    if (fresh.length === 0) return
    const msg = await acc.encrypt([{ jid: peer, deviceIds: fresh }], new Uint8Array(0))
    await this.ctx.xmpp.sendStanza(this.wrapMessage(peer, elementToData(buildEncrypted(msg))))
  }

  private wrapMessage(to: string, encrypted: XMLElementData): XMLElementData {
    return { name: 'message', attrs: { to, type: 'chat' }, children: [encrypted] }
  }
}
