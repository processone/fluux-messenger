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
import { buildEnvelope, parseEnvelope } from '../omemo2/sce'
import { concatBytes } from '../primitives/bytes'
import { encodeAuthMessage, decodeAuthMessage, encodeKeyExchange, decodeKeyExchange } from '../omemo2/wire'
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

export class OmemoAccount {
  private constructor(
    private store: OmemoStore,
    private rng: Rng,
    private id: { edSeed: Uint8Array; edPub: Uint8Array; deviceId: number },
  ) {}

  static async create(store: OmemoStore, rng: Rng): Promise<OmemoAccount> {
    const existing = await store.loadIdentity()
    if (existing) return new OmemoAccount(store, rng, existing)
    const deviceId = randomDeviceId(rng)
    const identity = createIdentity(rng, deviceId)
    await store.saveIdentity(identity)
    const spk = generateSignedPreKey(rng, 0, identity.edSeed, SPK_ID)
    await store.saveSignedPreKey(SPK_ID, spk)
    for (const pk of generatePreKeys(rng, PREKEY_START, PREKEY_COUNT)) await store.savePreKey(pk.id, pk)
    return new OmemoAccount(store, rng, identity)
  }

  static async load(store: OmemoStore, rng: Rng): Promise<OmemoAccount> {
    const identity = await store.loadIdentity()
    if (!identity) throw new Error('no identity in store; call create() first')
    return new OmemoAccount(store, rng, identity)
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

  async publishableBundleAsync(): Promise<Bundle> {
    const spk = await this.store.loadSignedPreKey(SPK_ID)
    if (!spk) throw new Error('signed prekey missing')
    const preKeys: Bundle['preKeys'] = []
    for (let i = PREKEY_START; i < PREKEY_START + PREKEY_COUNT; i++) {
      const pk = await this.store.loadPreKey(i)
      if (pk) preKeys.push({ id: pk.id, key: pk.pub })
    }
    const bundle: Bundle = { ik: this.id.edPub, spkId: spk.id, spk: spk.pub, spkSig: spk.signature, preKeys }
    assertValidBundle(bundle)
    return bundle
  }

  async processBundle(peer: string, rid: number, bundle: Bundle): Promise<void> {
    assertValidBundle(bundle)
    // Cryptographic binding check: the signed prekey must carry a valid signature by the
    // identity key. This authenticates the SPK before any X3DH / session establishment.
    // (This is NOT a trust-policy decision — it verifies the bundle is internally consistent.)
    if (!xeddsaVerify(bundle.ik, bundle.spk, bundle.spkSig)) {
      throw new Error('OMEMO bundle signed-prekey signature verification failed')
    }
    const otk = bundle.preKeys[0]
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
    // Mirror the decrypt path: only record trust on first contact, never clobber an
    // existing decision (e.g. a manual 'trusted' verification) if a bundle is re-processed.
    const existingTrust = await this.store.loadTrust(peer, rid)
    if (!existingTrust) await this.store.saveTrust(peer, rid, { state: 'undecided', identityKey: bundle.ik })
  }

  async encrypt(peer: string, deviceIds: number[], plaintext: Uint8Array): Promise<OmemoMessage> {
    const envelope = buildEnvelope({ body: new TextDecoder().decode(plaintext) }, this.rng)
    const k = this.rng(32)
    const { ciphertext, tag } = payloadEncrypt(k, envelope)
    const keyAndHmac = concatBytes(k, tag) // 48 bytes

    const keys: OmemoKey[] = []
    for (const rid of deviceIds) {
      const stored = await this.store.loadSession(peer, rid)
      if (!stored) throw new Error(`no session for ${peer}/${rid}; call processBundle first`)
      const { meta, ratchet } = unpackSession(stored)
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
      keys.push({ rid, kex: meta.kexPending, data })
      await this.store.saveSession(peer, rid, packSession(meta, serializeRatchet(step.state)))
    }
    return { sid: this.id.deviceId, keys, payload: ciphertext }
  }

  async decrypt(peer: string, sid: number, msg: OmemoMessage, opts?: { archive?: boolean }): Promise<Uint8Array> {
    const mine = msg.keys.find((k) => k.rid === this.id.deviceId)
    if (!mine) throw new Error('message has no key for this device')

    // Idempotency / duplicate handling: if a session already exists for (peer, sid),
    // always decrypt against the ESTABLISHED ratchet — regardless of the kex flag. The
    // initiator keeps sending kex:true until it hears back, so a kex-flagged message when
    // we already have a session is either a normal next message on the initiator's chain
    // or a duplicate of the initial one; both are handled correctly by the ratchet's
    // replay/skip logic (which rejects true duplicates cleanly instead of rebuilding X3DH).
    const stored = await this.store.loadSession(peer, sid)

    let state: RatchetState
    let ad: Uint8Array
    let meta: SessionMeta
    let authMessage: { mac: Uint8Array; message: Uint8Array }
    // Set only on genuine first contact (no existing session + kex): drives the
    // authenticated-first side effects (OTK consumption + trust) after ratchetDecrypt.
    let firstContact: { ik: Uint8Array; pkId: number; hadOtk: boolean } | undefined

    if (stored) {
      const unpacked = unpackSession(stored)
      meta = unpacked.meta
      state = deserializeRatchet(unpacked.ratchet)
      state.rng = this.rng // receiving a new remote DH triggers a dhRatchet -> needs real rng
      ad = Uint8Array.from(meta.ad)
      // A kex-flagged message over an established session still embeds the auth message.
      const authBytes = mine.kex ? decodeKeyExchange(mine.data).message : mine.data
      authMessage = decodeAuthMessage(authBytes)
    } else if (mine.kex) {
      // First contact. Authenticate BEFORE any persistent mutation: all reads below are
      // safe pre-auth; no write happens until ratchetDecrypt (the HMAC check) succeeds.
      const kex = decodeKeyExchange(mine.data)
      authMessage = decodeAuthMessage(kex.message)
      const spk = await this.store.loadSignedPreKey(kex.spkId)
      if (!spk) throw new Error('signed prekey missing for kex')
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
      meta = { ad: [...ad], kexPending: false }
      firstContact = { ik: kex.ik, pkId: kex.pkId, hadOtk: !!otk }
    } else {
      throw new Error(`no session for ${peer}/${sid}`)
    }

    // ratchetDecrypt performs the HMAC check. If it throws, NO writes have happened.
    const result = ratchetDecrypt(state, authMessage, ad)
    const keyAndHmac = result.plaintext
    const k = keyAndHmac.slice(0, 32)
    const tag = keyAndHmac.slice(32, 48)

    // Receiving any message clears our kex-pending flag (peer now has our session).
    meta.kexPending = false
    if (!opts?.archive) {
      // First-contact side effects run ONLY after successful authentication.
      if (firstContact) {
        if (firstContact.hadOtk) await this.store.removePreKey(firstContact.pkId) // consume OTK once
        // Preserve any prior trust decision: only record trust on genuine first contact,
        // never clobber an existing record (e.g. a manual 'trusted' verification).
        const existingTrust = await this.store.loadTrust(peer, sid)
        if (!existingTrust) await this.store.saveTrust(peer, sid, { state: 'undecided', identityKey: firstContact.ik })
      }
      await this.store.saveSession(peer, sid, packSession(meta, serializeRatchet(result.state)))
    }

    if (!msg.payload) return new Uint8Array(0) // empty/key-transport message
    const envelopeBytes = payloadDecrypt(k, msg.payload, tag)
    return new TextEncoder().encode(parseEnvelope(envelopeBytes).body ?? '')
  }
}

export type { Bundle, OmemoMessage } from '../omemo2/codec'
