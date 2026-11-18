import type { Rng } from '../primitives/bytes'
import type { OmemoStore } from '../store/types'
import { createIdentity, fingerprint, randomDeviceId } from '../identity/identity'
import { generateSignedPreKey, generatePreKeys } from '../prekeys/prekeys'
import { x3dhInitiator, x3dhResponder } from '../x3dh/x3dh'
import {
  initRatchetInitiator,
  initRatchetResponder,
  ratchetEncrypt,
  ratchetDecrypt,
  serializeRatchet,
  deserializeRatchet,
  type RatchetState,
} from '../ratchet/ratchet'
import { payloadEncrypt, payloadDecrypt } from '../primitives/aead'
import { concatBytes, bytesEqual } from '../primitives/bytes'
import { OmemoError } from '../errors'
import {
  encodeAuthMessage,
  decodeAuthMessage,
  decodeOmemoMessage,
  encodeKeyExchange,
  decodeKeyExchange,
  type OmemoKeyExchange,
} from '../omemo2/wire'
import { assertValidBundle, type Bundle, type OmemoMessage, type OmemoKey } from '../omemo2/codec'
import { xeddsaVerify } from '../primitives/xeddsa'

const SPK_ID = 1
const PREKEY_START = 1
const PREKEY_COUNT = 100

interface SessionMeta {
  ad: number[] // Ed25519(IK_initiator) || Ed25519(IK_responder), fixed for the session's life
  kexPending: boolean
  pkId?: number
  spkId?: number
  ek?: number[] // ephemeral pub, initiator side, while kexPending
  peerEk?: number[] // ephemeral pub of the key exchange that created this session, responder side
  rejectedEks?: number[][] // ephemeral pubs of crossed initiations this session won against
}

/** Session record = [u32 metaLen][meta JSON][ratchet blob]. */
function packSession(meta: SessionMeta, ratchet: Uint8Array): Uint8Array {
  const m = new TextEncoder().encode(JSON.stringify(meta))
  const len = new Uint8Array([(m.length >>> 24) & 0xff, (m.length >>> 16) & 0xff, (m.length >>> 8) & 0xff, m.length & 0xff])
  return concatBytes(len, m, ratchet)
}
function unpackSession(blob: Uint8Array): { meta: SessionMeta; ratchet: Uint8Array } {
  const len = ((blob[0] << 24) | (blob[1] << 16) | (blob[2] << 8) | blob[3]) >>> 0
  const meta: SessionMeta = JSON.parse(new TextDecoder().decode(blob.slice(4, 4 + len)))
  return { meta, ratchet: blob.slice(4 + len) }
}

/**
 * Everything session setup needs from a bundle: it is well formed, every one-time prekey
 * carries a 32-byte public key (any of them may be selected), and the signed prekey has a valid
 * signature by the identity key. The signature check authenticates the SPK before any X3DH; it
 * is not a trust-policy decision. Throws when the bundle is unusable.
 */
function assertUsableBundle(bundle: Bundle): void {
  assertValidBundle(bundle)
  for (const otk of bundle.preKeys) {
    if (otk.key.length !== 32) throw new Error(`OMEMO bundle one-time prekey must be 32 bytes, got ${otk.key.length}`)
  }
  if (!xeddsaVerify(bundle.ik, bundle.spk, bundle.spkSig)) {
    throw new Error('OMEMO bundle signed-prekey signature verification failed')
  }
}

export class OmemoAccount {
  /** Tail of the operation queue: session read/modify/write sequences run one at a time. */
  private queue: Promise<unknown> = Promise.resolve()
  /** Bumped whenever the published bundle goes out of date; compared with {@link publishedRev}. */
  private bundleRev = 0
  private publishedRev = 0

  private constructor(
    private store: OmemoStore,
    private rng: Rng,
    private id: { edSeed: Uint8Array; edPub: Uint8Array; deviceId: number },
  ) {}

  /** Runs `fn` after every earlier queued operation has settled. */
  private serialize<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn)
    this.queue = run.catch(() => undefined)
    return run
  }

  static async create(store: OmemoStore, rng: Rng): Promise<OmemoAccount> {
    const existing = await store.loadIdentity()
    if (existing) {
      const account = new OmemoAccount(store, rng, existing)
      await account.completeKeyMaterial()
      return account
    }
    // The identity is written LAST: an interrupted initialization leaves no
    // identity, so the next call starts over instead of adopting an identity
    // whose signed prekey or prekeys were never stored.
    const deviceId = randomDeviceId(rng)
    const identity = createIdentity(rng, deviceId)
    await store.saveSignedPreKey(SPK_ID, generateSignedPreKey(rng, 0, identity.edSeed, SPK_ID))
    for (const pk of generatePreKeys(rng, PREKEY_START, PREKEY_COUNT)) await store.savePreKey(pk.id, pk)
    await store.saveIdentity(identity)
    return new OmemoAccount(store, rng, identity)
  }

  static async load(store: OmemoStore, rng: Rng): Promise<OmemoAccount> {
    const identity = await store.loadIdentity()
    if (!identity) throw new Error('no identity in store; call create() first')
    return new OmemoAccount(store, rng, identity)
  }

  /** Restores a missing signed prekey and tops the prekey pool up (recovers an interrupted initialization). */
  private async completeKeyMaterial(): Promise<void> {
    if (!(await this.store.loadSignedPreKey(SPK_ID))) {
      await this.store.saveSignedPreKey(SPK_ID, generateSignedPreKey(this.rng, 0, this.id.edSeed, SPK_ID))
      this.bundleRev++
    }
    await this.topUpPreKeys()
  }

  deviceId(): number {
    return this.id.deviceId
  }
  publishableDeviceId(): number {
    return this.id.deviceId
  }
  identityFingerprint(): Uint8Array {
    return fingerprint(this.id.edPub)
  }

  /** True while the published bundle is out of date (a prekey was consumed or replaced). */
  isBundleDirty(): boolean {
    return this.bundleRev !== this.publishedRev
  }

  /** The bundle revision to hand back to {@link markBundlePublished} once a publish of it succeeded. */
  bundleRevision(): number {
    return this.bundleRev
  }

  /** Records that the bundle as of `revision` reached the server; a later change keeps it dirty. */
  markBundlePublished(revision: number): void {
    this.publishedRev = Math.max(this.publishedRev, revision)
  }

  /** Generates prekeys with fresh random ids until the pool holds {@link PREKEY_COUNT}. */
  private async topUpPreKeys(): Promise<void> {
    const used = new Set(await this.store.listPreKeyIds())
    while (used.size < PREKEY_COUNT) {
      // Random ids avoid reusing a consumed id; fall back to counting up if the rng keeps colliding.
      let id = randomDeviceId(this.rng)
      for (let tries = 0; used.has(id) && tries < 8; tries++) id = randomDeviceId(this.rng)
      while (used.has(id)) id = id >= 0x7fffffff ? 1 : id + 1
      const [pk] = generatePreKeys(this.rng, id, 1)
      await this.store.savePreKey(pk.id, pk)
      used.add(pk.id)
      this.bundleRev++
    }
  }

  /** Replaces consumed prekeys; check {@link isBundleDirty} afterwards to learn whether to republish. */
  replenishPreKeys(): Promise<void> {
    return this.serialize(() => this.topUpPreKeys())
  }

  async publishableBundleAsync(): Promise<Bundle> {
    const spk = await this.store.loadSignedPreKey(SPK_ID)
    if (!spk) throw new Error('signed prekey missing')
    const preKeys: Bundle['preKeys'] = []
    for (const id of await this.store.listPreKeyIds()) {
      const pk = await this.store.loadPreKey(id)
      if (pk) preKeys.push({ id: pk.id, key: pk.pub })
    }
    const bundle: Bundle = { ik: this.id.edPub, spkId: spk.id, spk: spk.pub, spkSig: spk.signature, preKeys }
    assertValidBundle(bundle)
    return bundle
  }

  /**
   * Binds a remote device's identity key to its trust record. First contact records
   * `undecided`; a record with no key yet adopts it; a DIFFERENT key replaces the
   * binding and drops the device to `untrusted`, so a decision (e.g. 'trusted') made
   * for the old key never carries over to a replacement identity.
   */
  private async bindRemoteIdentity(peer: string, rid: number, ik: Uint8Array): Promise<void> {
    const existing = await this.store.loadTrust(peer, rid)
    if (!existing) {
      await this.store.saveTrust(peer, rid, { state: 'undecided', identityKey: ik })
    } else if (existing.identityKey.length === 0) {
      await this.store.saveTrust(peer, rid, { ...existing, identityKey: ik })
    } else if (!bytesEqual(existing.identityKey, ik)) {
      await this.store.saveTrust(peer, rid, { state: 'untrusted', identityKey: ik })
    }
  }

  /**
   * Establishes an initiator session for (peer, rid) from the peer's bundle, using one
   * randomly chosen published one-time prekey. An existing session is kept (returns
   * `false`) unless `replace` is set, because a second X3DH over a live ratchet would
   * desynchronise the peer; repair passes `replace: true`.
   */
  processBundle(peer: string, rid: number, bundle: Bundle, opts?: { replace?: boolean }): Promise<boolean> {
    return this.serialize(async () => {
      assertUsableBundle(bundle)
      if (!opts?.replace && (await this.store.loadSession(peer, rid))) return false
      const pick = this.rng(4)
      const index = (((pick[0] << 24) | (pick[1] << 16) | (pick[2] << 8) | pick[3]) >>> 0) % bundle.preKeys.length
      const otk = bundle.preKeys[index]
      const init = x3dhInitiator({
        identitySeed: this.id.edSeed,
        rng: this.rng,
        remoteIdentityEd: bundle.ik,
        remoteSignedPreKey: bundle.spk,
        remoteOneTimePreKey: otk.key,
      })
      const ratchet = initRatchetInitiator(init.sharedSecret, bundle.spk, this.rng)
      const meta: SessionMeta = {
        ad: [...this.id.edPub, ...bundle.ik], // initiator=us, responder=them
        kexPending: true,
        pkId: otk.id,
        spkId: bundle.spkId,
        ek: [...init.ephemeralPub],
      }
      await this.store.saveSession(peer, rid, packSession(meta, serializeRatchet(ratchet)))
      await this.bindRemoteIdentity(peer, rid, bundle.ik)
      return true
    })
  }

  /**
   * Content-agnostic, multi-recipient encrypt. `content` is opaque bytes (the SDK adapter owns
   * any XEP-0420 SCE framing): we generate ONE payload key, `payloadEncrypt(content)` ONCE, and
   * wrap the resulting 48-byte `k || tag` per device across every recipient JID (the peer's
   * devices AND the sender's own other devices). Each returned key carries its recipient `jid`.
   *
   * Empty `content` is a key-transport message (XEP-0384): the ratchet carries 32 zero bytes
   * and the message has no payload.
   */
  encrypt(
    recipients: Array<{ jid: string; deviceIds: number[] }>,
    content: Uint8Array,
    opts?: { authorize?: (jid: string, rid: number, identityKey: Uint8Array) => Promise<boolean> },
  ): Promise<OmemoMessage> {
    return this.serialize(async () => {
      let keyAndHmac: Uint8Array
      let payload: Uint8Array | undefined
      if (content.length === 0) {
        keyAndHmac = new Uint8Array(32)
      } else {
        const k = this.rng(32)
        const { ciphertext, tag } = payloadEncrypt(k, content)
        keyAndHmac = concatBytes(k, tag) // 48 bytes
        payload = ciphertext
      }

      const keys: OmemoKey[] = []
      for (const { jid, deviceIds } of recipients) {
        for (const rid of deviceIds) {
          const stored = await this.store.loadSession(jid, rid)
          if (!stored) throw new Error(`no session for ${jid}/${rid}; call processBundle first`)
          const { meta, ratchet } = unpackSession(stored)
          // Authorize against the identity that actually backs THIS session, read inside the
          // serialized operation, so a session replaced or re-bound since the caller checked
          // trust is never wrapped for. A refused device is skipped without advancing its ratchet.
          if (opts?.authorize && !(await opts.authorize(jid, rid, this.peerKeyFromAd(Uint8Array.from(meta.ad))))) continue
          const state = deserializeRatchet(ratchet)
          state.rng = this.rng // re-inject real rng before any ratchet step (fail-loud stub otherwise)
          const ad = Uint8Array.from(meta.ad)
          const step = ratchetEncrypt(state, keyAndHmac, ad)
          const authBytes = encodeAuthMessage(step.authMessage)

          let data: Uint8Array
          if (meta.kexPending) {
            data = encodeKeyExchange({
              pkId: meta.pkId!,
              spkId: meta.spkId!,
              ik: this.id.edPub,
              ek: Uint8Array.from(meta.ek!),
              message: authBytes,
            })
          } else {
            data = authBytes
          }
          keys.push({ jid, rid, kex: meta.kexPending, data })
          await this.store.saveSession(jid, rid, packSession(meta, serializeRatchet(step.state)))
        }
      }
      return payload ? { sid: this.id.deviceId, keys, payload } : { sid: this.id.deviceId, keys }
    })
  }

  /**
   * Content-agnostic decrypt: authenticates the message and returns the RAW recovered content
   * bytes (no SCE/envelope parsing — that is the adapter's job). `senderJid` is the session
   * partner JID (the label under which the (senderJid, sid) session is stored).
   *
   * `opts.ownJid` is this account's bare JID: device ids are only unique per account, so the
   * key for this device is selected by (jid, rid), not rid alone. Failures throw an
   * {@link OmemoError} whose `code` separates a broken session from a replay or bad input.
   */
  decrypt(
    senderJid: string,
    sid: number,
    msg: OmemoMessage,
    opts?: { archive?: boolean; ownJid?: string },
  ): Promise<Uint8Array> {
    return this.decryptAuthenticated(senderJid, sid, msg, opts).then((r) => r.content)
  }

  /**
   * Like {@link decrypt}, but also returns the identity key that authenticated THIS message
   * (the one the session was built with), so callers derive trust from the key that actually
   * vouched for the content instead of from a mutable record or a fresh bundle lookup.
   */
  decryptAuthenticated(
    senderJid: string,
    sid: number,
    msg: OmemoMessage,
    opts?: { archive?: boolean; ownJid?: string },
  ): Promise<{ content: Uint8Array; senderIdentityKey: Uint8Array }> {
    return this.serialize(() => this.decryptNow(senderJid, sid, msg, opts))
  }

  /**
   * The identity key that backs the stored session with `peer`/`rid`, or `null` when there is
   * none. Read-only: it never creates or changes a session.
   */
  async sessionPeerKey(peer: string, rid: number): Promise<Uint8Array | null> {
    const stored = await this.store.loadSession(peer, rid)
    if (!stored) return null
    return this.peerKeyFromAd(Uint8Array.from(unpackSession(stored).meta.ad))
  }

  /** Whether {@link processBundle} would accept this bundle: well formed, with a valid signed-prekey signature. */
  static isUsableBundle(bundle: Bundle): boolean {
    try {
      assertUsableBundle(bundle)
      return true
    } catch {
      return false
    }
  }

  /** The peer's Ed25519 identity key inside a session's `ad` (initiator || responder). */
  private peerKeyFromAd(ad: Uint8Array): Uint8Array {
    const first = ad.slice(0, 32)
    return bytesEqual(first, this.id.edPub) ? ad.slice(32, 64) : first
  }

  private async decryptNow(
    senderJid: string,
    sid: number,
    msg: OmemoMessage,
    opts?: { archive?: boolean; ownJid?: string },
  ): Promise<{ content: Uint8Array; senderIdentityKey: Uint8Array }> {
    const ownJid = opts?.ownJid?.toLowerCase()
    const mine = msg.keys.find(
      (k) => k.rid === this.id.deviceId && (ownJid === undefined || k.jid.toLowerCase() === ownJid),
    )
    if (!mine) throw new OmemoError('not-addressed', 'message has no key for this device')

    let kex: OmemoKeyExchange | undefined
    let authMessage: { mac: Uint8Array; message: Uint8Array }
    try {
      kex = mine.kex ? decodeKeyExchange(mine.data) : undefined
      authMessage = decodeAuthMessage(kex ? kex.message : mine.data)
      decodeOmemoMessage(authMessage.message)
    } catch (e) {
      throw new OmemoError('malformed', e instanceof Error ? e.message : 'malformed OMEMO key data')
    }

    // A kex-flagged message over an established session is either another message of the
    // initial exchange (the initiator keeps sending kex:true until it hears back; same
    // ephemeral key) or a genuinely NEW key exchange (crossed initiation, a repair). The
    // former continues the existing ratchet; the latter builds a replacement session.
    const stored = await this.store.loadSession(senderJid, sid)
    const existing = stored ? unpackSession(stored) : undefined
    const continuesExisting =
      existing !== undefined &&
      (!kex || (existing.meta.peerEk !== undefined && bytesEqual(Uint8Array.from(existing.meta.peerEk), kex.ek)))

    // Crossed initiation: both sides started a session and each sent a key exchange. Both
    // must keep the SAME one, so the exchange whose initiator identity key sorts higher wins
    // on both ends. When ours loses, the incoming message is still read, from a throwaway
    // responder session that is never stored.
    const crossedAndLost =
      existing !== undefined &&
      !continuesExisting &&
      kex !== undefined &&
      ((existing.meta.kexPending && compareBytes(kex.ik, this.id.edPub) < 0) ||
        // A later message of a handshake this session already won against: our reply may have
        // cleared kexPending, but the losing exchange stays rejected.
        (existing.meta.rejectedEks ?? []).some((ek) => bytesEqual(Uint8Array.from(ek), kex.ek)))
    const persist = !opts?.archive && !crossedAndLost

    let state: RatchetState
    let ad: Uint8Array
    let meta: SessionMeta
    let senderIdentityKey: Uint8Array
    // Set when this message builds a session (first contact or replacement): drives the
    // authenticated-first side effects (OTK consumption + trust) once the content is verified.
    let newSession: { ik: Uint8Array; pkId: number; hadOtk: boolean } | undefined

    if (existing && continuesExisting) {
      meta = existing.meta
      state = deserializeRatchet(existing.ratchet)
      state.rng = this.rng // receiving a new remote DH triggers a dhRatchet -> needs real rng
      ad = Uint8Array.from(meta.ad)
      senderIdentityKey = this.peerKeyFromAd(ad)
    } else if (kex) {
      // Authenticate BEFORE any persistent mutation: all reads below are safe pre-auth;
      // no write happens until the HMAC and the payload have both verified.
      const spk = await this.store.loadSignedPreKey(kex.spkId)
      // We never publish any signed prekey but the ones we hold, so an unknown id is
      // unreadable input, not a desynchronised session.
      if (!spk) throw new OmemoError('malformed', 'key exchange names an unknown signed prekey')
      const otk = await this.store.loadPreKey(kex.pkId)
      const resp = x3dhResponder({
        identitySeed: this.id.edSeed,
        signedPreKeyPriv: spk.priv,
        oneTimePreKeyPriv: otk?.priv,
        remoteIdentityEd: kex.ik,
        remoteEphemeral: kex.ek,
      })
      state = initRatchetResponder(resp.sharedSecret, spk.priv, spk.pub)
      state.rng = this.rng // responder's FIRST ratchetDecrypt does a dhRatchet -> needs real rng
      ad = concatBytes(kex.ik, this.id.edPub) // initiator=them, responder=us
      meta = { ad: [...ad], kexPending: false, peerEk: [...kex.ek] }
      senderIdentityKey = kex.ik
      newSession = { ik: kex.ik, pkId: kex.pkId, hadOtk: !!otk }
    } else {
      throw new OmemoError('session-broken', `no session for ${senderJid}/${sid}`)
    }

    // ratchetDecrypt performs the HMAC check. If it throws, NO writes have happened.
    let result: ReturnType<typeof ratchetDecrypt>
    try {
      result = ratchetDecrypt(state, authMessage, ad)
    } catch (e) {
      if (e instanceof OmemoError) {
        if (e.code === 'duplicate') throw new OmemoError('duplicate', e.message, senderIdentityKey)
        throw e
      }
      // Counter gaps and header oddities are read before the MAC, so anyone can produce them.
      throw new OmemoError('malformed', e instanceof Error ? e.message : 'ratchet failure')
    }
    const keyAndHmac = result.plaintext
    if (keyAndHmac.length !== (msg.payload ? 48 : 32)) {
      throw new OmemoError('malformed', 'unexpected key material length')
    }

    // The payload must verify BEFORE anything is committed: a message with a valid ratchet
    // MAC but a bad payload tag must not consume a one-time prekey, bind an identity or
    // advance the stored ratchet.
    let content: Uint8Array
    if (!msg.payload) {
      content = new Uint8Array(0) // key-transport message (32 zero key bytes)
    } else {
      try {
        content = payloadDecrypt(keyAndHmac.slice(0, 32), msg.payload, keyAndHmac.slice(32, 48))
      } catch (e) {
        throw new OmemoError('malformed', e instanceof Error ? e.message : 'payload authentication failed')
      }
    }

    if (crossedAndLost && !opts?.archive && existing && kex) {
      // Authenticated: remember the rejected handshake next to the session that won.
      const rejected = [...(existing.meta.rejectedEks ?? []), [...kex.ek]].slice(-8)
      const kept: SessionMeta = { ...existing.meta, rejectedEks: rejected }
      await this.store.saveSession(senderJid, sid, packSession(kept, existing.ratchet))
    }
    if (persist) {
      // Receiving any message clears our kex-pending flag (peer now has our session).
      meta.kexPending = false
      if (newSession) {
        // Authenticated: consume the one-time prekey once and replace it in the published bundle.
        if (newSession.hadOtk) {
          await this.store.removePreKey(newSession.pkId)
          await this.topUpPreKeys()
          this.bundleRev++
        }
        await this.bindRemoteIdentity(senderJid, sid, newSession.ik)
      }
      await this.store.saveSession(senderJid, sid, packSession(meta, serializeRatchet(result.state)))
    }
    return { content, senderIdentityKey }
  }
}

/** Lexicographic comparison of two byte strings: negative, zero or positive. */
function compareBytes(a: Uint8Array, b: Uint8Array): number {
  const n = Math.min(a.length, b.length)
  for (let i = 0; i < n; i++) if (a[i] !== b[i]) return a[i] - b[i]
  return a.length - b.length
}

export type { Bundle, OmemoMessage } from '../omemo2/codec'
