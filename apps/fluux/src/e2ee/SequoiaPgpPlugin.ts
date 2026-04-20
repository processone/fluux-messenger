/**
 * Sequoia-PGP plugin skeleton for XEP-0373 (OpenPGP for XMPP, "OX").
 *
 * TypeScript side of the E2EE plugin that bridges to Rust-side crypto
 * operations via Tauri commands (see `apps/fluux/src-tauri/src/openpgp.rs`).
 *
 * The Rust crypto is currently stubbed (base64 round-trip behind real
 * OpenPGP-shaped APIs) — see the TODO(sequoia) markers in `openpgp.rs`.
 * The TS plugin is itself complete: swapping in real Sequoia on the Rust
 * side is a drop-in change that does not touch this file.
 */

import type {
  BareJID,
  ConversationHandle,
  ConversationTarget,
  DecryptResult,
  E2EEPlugin,
  E2EEProtocolDescriptor,
  EncryptedPayload,
  IdentityInfo,
  PeerSupport,
  PluginContext,
  SecurityContext,
  TrustState,
  VerificationFlow,
  VerificationMethod,
  XMLElementData,
} from '@fluux/sdk'

/** PEP node where account public keys are published (XEP-0373). */
const PUBLIC_KEYS_NODE = 'urn:xmpp:openpgp:0:public-keys'
/** XEP-0373 encrypted payload namespace. */
const OX_NAMESPACE = 'urn:xmpp:openpgp:0'

/** Shape of the Rust-side `KeyBundle` (kept in sync with `openpgp.rs`). */
interface KeyBundle {
  fingerprint: string
  publicArmored: string
  secretArmored: string
}

/**
 * Typed wrapper over Tauri's `invoke`. Abstracted so tests can inject a
 * fake implementation without dynamically importing `@tauri-apps/api/core`.
 */
export type InvokeFn = <T>(cmd: string, args?: Record<string, unknown>) => Promise<T>

export interface SequoiaPgpPluginOptions {
  /** Tauri command dispatcher. Tests pass a mock; app code passes the real one. */
  invoke: InvokeFn
}

const descriptor: E2EEProtocolDescriptor = {
  id: 'openpgp',
  displayName: 'OpenPGP (XEP-0373)',
  securityLevel: 30,
  features: {
    forwardSecrecy: false,
    postCompromiseSecurity: false,
    multiDevice: true,
    groupChat: false,
    asynchronous: true,
    deniability: false,
  },
}

export class SequoiaPgpPlugin implements E2EEPlugin {
  readonly descriptor = descriptor

  private readonly invoke: InvokeFn
  private ctx: PluginContext | null = null
  private ownBundle: KeyBundle | null = null
  /** Cached peer public keys, keyed on bare JID. */
  private readonly peerKeys = new Map<BareJID, KeyBundle>()

  constructor(options: SequoiaPgpPluginOptions) {
    this.invoke = options.invoke
  }

  async init(ctx: PluginContext): Promise<void> {
    this.ctx = ctx
    if (!ctx.account.jid) {
      throw new Error('SequoiaPgpPlugin requires a logged-in account JID')
    }
    await this.ensureIdentity()
  }

  async shutdown(): Promise<void> {
    // Intentionally does NOT call `openpgp_forget_account`. Shutdown means
    // "this plugin instance is no longer attached to the E2EEManager" —
    // e.g. the user toggled E2EE off in Settings. Preserving the Rust-side
    // key material means a subsequent re-enable reuses the same identity
    // for the rest of the session, rather than silently cycling the user's
    // fingerprint on every toggle. An explicit "delete key" action in the
    // settings UI is the right place to call `openpgp_forget_account`.
    this.ownBundle = null
    this.peerKeys.clear()
    this.ctx = null
  }

  /**
   * Permanently destroy the local key material for this account. Intended
   * to be called from a confirmed, destructive "Delete my OpenPGP key"
   * action — not from shutdown. The next `init` will generate a fresh key
   * with a new fingerprint.
   */
  async deleteIdentity(): Promise<void> {
    const accountJid = this.ctx?.account.jid
    if (accountJid) {
      await this.invoke<void>('openpgp_forget_account', { accountJid }).catch(() => {})
    }
    this.ownBundle = null
    this.peerKeys.clear()
  }

  /**
   * Generate or load our key via Rust, then publish the public block to
   * our own PEP node. Idempotent on the Rust side (returns the existing
   * bundle for an account that already has one).
   */
  async ensureIdentity(): Promise<IdentityInfo> {
    const ctx = this.requireCtx()
    const bundle = await this.invoke<KeyBundle>('openpgp_generate_key', {
      accountJid: ctx.account.jid,
      userId: ctx.account.jid,
    })
    this.ownBundle = bundle

    const publicKeyItem: XMLElementData = {
      name: 'pubkey',
      attrs: { xmlns: OX_NAMESPACE },
      children: [base64Encode(bundle.publicArmored)],
    }
    try {
      await ctx.xmpp.publishPEP(PUBLIC_KEYS_NODE, {
        id: bundle.fingerprint,
        payload: publicKeyItem,
      })
    } catch (err) {
      ctx.logger.warn(`SequoiaPgpPlugin: public key publish failed: ${formatError(err)}`)
    }

    return { fingerprint: bundle.fingerprint }
  }

  async probePeer(peer: BareJID): Promise<PeerSupport> {
    const ctx = this.requireCtx()
    if (this.peerKeys.has(peer)) {
      return { supported: true, ttl: 300 }
    }
    try {
      const items = await ctx.xmpp.queryPEP(peer, PUBLIC_KEYS_NODE)
      for (const item of items) {
        const bundle = parsePublicKeyItem(item.payload)
        if (bundle) {
          this.peerKeys.set(peer, bundle)
          return { supported: true, ttl: 300 }
        }
      }
    } catch (err) {
      ctx.logger.debug(`SequoiaPgpPlugin: probePeer(${peer}) failed: ${formatError(err)}`)
    }
    return { supported: false, ttl: 300 }
  }

  async openConversation(target: ConversationTarget): Promise<ConversationHandle> {
    if (target.kind !== 'direct') {
      throw new Error('SequoiaPgpPlugin: MUC encryption is not supported in this phase')
    }
    return { protocolId: descriptor.id, state: { peer: target.peer } }
  }

  async closeConversation(_handle: ConversationHandle): Promise<void> {
    // Stateless — no per-conversation resources to release.
  }

  async encrypt(handle: ConversationHandle, plaintext: Uint8Array): Promise<EncryptedPayload> {
    const peer = extractPeer(handle)
    const peerBundle = this.peerKeys.get(peer)
    if (!peerBundle) {
      throw new Error(`SequoiaPgpPlugin: no cached public key for ${peer} — probe first`)
    }

    const plaintextStr = new TextDecoder().decode(plaintext)
    const ciphertext = await this.invoke<string>('openpgp_encrypt', {
      recipientPublicArmored: peerBundle.publicArmored,
      plaintext: plaintextStr,
    })

    const stanzaElement: XMLElementData = {
      name: 'openpgp',
      attrs: { xmlns: OX_NAMESPACE },
      children: [base64Encode(ciphertext)],
    }
    return {
      protocolId: descriptor.id,
      stanzaElement,
      fallbackBody: '[OpenPGP-encrypted message]',
    }
  }

  async decrypt(handle: ConversationHandle, payload: EncryptedPayload): Promise<DecryptResult> {
    const ctx = this.requireCtx()
    if (payload.protocolId !== descriptor.id) {
      throw new Error(`SequoiaPgpPlugin cannot decrypt protocol: ${payload.protocolId}`)
    }
    const encodedCiphertext = firstText(payload.stanzaElement)
    if (!encodedCiphertext) {
      throw new Error('SequoiaPgpPlugin: encrypted element has no payload')
    }
    const ciphertext = base64Decode(encodedCiphertext)

    const plaintextStr = await this.invoke<string>('openpgp_decrypt', {
      accountJid: ctx.account.jid,
      ciphertext,
    })
    const plaintext = new TextEncoder().encode(plaintextStr)

    const peer = extractPeer(handle)
    const trust = await this.evaluatePeerTrust(peer)
    const securityContext: SecurityContext = {
      protocolId: descriptor.id,
      trust: trust === 'unknown' ? 'untrusted' : trust,
    }
    return {
      plaintext,
      senderDevice: { jid: peer, deviceId: this.peerKeys.get(peer)?.fingerprint ?? 'unknown' },
      securityContext,
    }
  }

  getVerificationMethods(): VerificationMethod[] {
    return [
      {
        id: 'fingerprint',
        displayName: 'Fingerprint comparison',
        description: "Compare the 40-character fingerprint with your contact's other client.",
      },
    ]
  }

  async startVerification(_peer: BareJID, _method: VerificationMethod): Promise<VerificationFlow> {
    // UX slice — deferred. The flow will hang a modal off a
    // VerificationUIAdapter provided by the host (see architecture doc).
    throw new Error('SequoiaPgpPlugin: verification UI not wired yet')
  }

  async getPeerTrust(peer: BareJID): Promise<TrustState> {
    return this.evaluatePeerTrust(peer)
  }

  async getDeviceTrust(peer: BareJID, _deviceId: string): Promise<TrustState> {
    return this.evaluatePeerTrust(peer)
  }

  tryClaimInbound(stanzaChild: XMLElementData): EncryptedPayload | null {
    if (stanzaChild.name !== 'openpgp') return null
    if (stanzaChild.attrs?.xmlns !== OX_NAMESPACE) return null
    return {
      protocolId: descriptor.id,
      stanzaElement: stanzaChild,
    }
  }

  /** Own fingerprint, or `null` if ensureIdentity hasn't completed. */
  getOwnFingerprint(): string | null {
    return this.ownBundle?.fingerprint ?? null
  }

  /** Cached peer fingerprint, or `null` if not probed / not published. */
  getPeerFingerprint(peer: BareJID): string | null {
    return this.peerKeys.get(peer)?.fingerprint ?? null
  }

  /**
   * TOFU for the skeleton: a peer we've seen a key from is "trusted",
   * unseen peers are "unknown". The follow-up verification UX will lift
   * confirmed peers to "verified"; a key rotation without re-verification
   * drops back to "trusted".
   */
  private async evaluatePeerTrust(peer: BareJID): Promise<TrustState> {
    return this.peerKeys.has(peer) ? 'trusted' : 'unknown'
  }

  private requireCtx(): PluginContext {
    if (!this.ctx) throw new Error('SequoiaPgpPlugin: not initialized')
    return this.ctx
  }
}

function extractPeer(handle: ConversationHandle): BareJID {
  const state = handle.state as { peer?: BareJID } | undefined
  const peer = state?.peer
  if (!peer) throw new Error('SequoiaPgpPlugin: conversation handle is missing peer JID')
  return peer
}

function parsePublicKeyItem(payload: XMLElementData): KeyBundle | null {
  if (payload.name !== 'pubkey' || payload.attrs?.xmlns !== OX_NAMESPACE) return null
  const encoded = firstText(payload)
  if (!encoded) return null
  const armored = base64Decode(encoded)
  const fingerprint = extractFingerprint(armored)
  if (!fingerprint) return null
  return {
    fingerprint,
    publicArmored: armored,
    // We never receive a peer's secret; carrying an empty string keeps the
    // shape aligned with our own bundle without tempting the encrypt path.
    secretArmored: '',
  }
}

/** Mirrors the Rust `extract_fingerprint` — reads `Fingerprint: <hex>`. */
function extractFingerprint(armored: string): string | null {
  for (const line of armored.split('\n')) {
    if (line.startsWith('Fingerprint:')) {
      return line.slice('Fingerprint:'.length).trim()
    }
  }
  return null
}

function firstText(el: XMLElementData): string | null {
  const child = el.children[0]
  return typeof child === 'string' ? child : null
}

function base64Encode(input: string): string {
  if (typeof btoa === 'function') return btoa(unescape(encodeURIComponent(input)))
  return Buffer.from(input, 'utf-8').toString('base64')
}

function base64Decode(encoded: string): string {
  if (typeof atob === 'function') return decodeURIComponent(escape(atob(encoded)))
  return Buffer.from(encoded, 'base64').toString('utf-8')
}

function formatError(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
