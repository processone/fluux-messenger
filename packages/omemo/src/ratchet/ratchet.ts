import { cbc } from '@noble/ciphers/aes'
import { x25519, generateX25519 } from '../primitives/curve'
import { hkdf, hmacSha256 } from '../primitives/hash'
import { concatBytes, bytesEqual } from '../primitives/bytes'
import type { Rng } from '../primitives/bytes'
import { encodeOmemoMessage, decodeOmemoMessage } from '../omemo2/wire'

// OMEMO 2 Double Ratchet message cipher (XEP-0384 §4.3). The exact KDF labels, chain
// constants, MAC-over-AD construction, and AES-256-CBC cipher below are an interop
// contract with Conversations / python-omemo and MUST NOT be changed casually.
const ROOT_INFO = new TextEncoder().encode('OMEMO Root Chain')
const MSG_INFO = new TextEncoder().encode('OMEMO Message Key Material')
const ZERO32 = new Uint8Array(32)
const MAX_SKIP = 1000

interface Header {
  dhPub: Uint8Array
  pn: number
  n: number
}

export interface RatchetState {
  rng: Rng
  dhSelfPriv: Uint8Array
  dhSelfPub: Uint8Array
  dhRemote: Uint8Array | null
  rootKey: Uint8Array
  sendChain: Uint8Array | null
  recvChain: Uint8Array | null
  ns: number
  nr: number
  pn: number
  skipped: Map<string, Uint8Array> // `${dhPubHex}:${n}` -> messageKey
}

// KDF_RK: HKDF(dh_out, salt=rootKey, info="OMEMO Root Chain", 64) -> rk' | ck
function kdfRoot(rootKey: Uint8Array, dhOut: Uint8Array): { rootKey: Uint8Array; chainKey: Uint8Array } {
  const okm = hkdf(dhOut, rootKey, ROOT_INFO, 64)
  return { rootKey: okm.slice(0, 32), chainKey: okm.slice(32, 64) }
}

// Chain step: mk = HMAC(ck, [0x01]) (DIRECT HMAC output, not further expanded);
// ck' = HMAC(ck, [0x02]).
function kdfChain(chainKey: Uint8Array): { chainKey: Uint8Array; messageKey: Uint8Array } {
  const messageKey = hmacSha256(chainKey, new Uint8Array([0x01]))
  const nextChain = hmacSha256(chainKey, new Uint8Array([0x02]))
  return { chainKey: nextChain, messageKey }
}

// Message keys: HKDF(mk, salt=32 zero bytes, info="OMEMO Message Key Material", 80)
// -> enc(32) | auth(32) | iv(16).
function deriveMsgKeys(mk: Uint8Array): { enc: Uint8Array; auth: Uint8Array; iv: Uint8Array } {
  const okm = hkdf(mk, ZERO32, MSG_INFO, 80)
  return { enc: okm.slice(0, 32), auth: okm.slice(32, 64), iv: okm.slice(64, 80) }
}

function hexKey(dhPub: Uint8Array, n: number): string {
  return [...dhPub].map((b) => b.toString(16).padStart(2, '0')).join('') + ':' + n
}

function sealMessage(
  mk: Uint8Array,
  ad: Uint8Array,
  header: Header,
  plaintext: Uint8Array,
): { mac: Uint8Array; message: Uint8Array } {
  const { enc, auth, iv } = deriveMsgKeys(mk)
  const ciphertext = cbc(enc, iv).encrypt(plaintext)
  const message = encodeOmemoMessage({ n: header.n, pn: header.pn, dhPub: header.dhPub, ciphertext })
  const mac = hmacSha256(auth, concatBytes(ad, message)).slice(0, 16)
  return { mac, message }
}

function openMessage(
  mk: Uint8Array,
  ad: Uint8Array,
  authMessage: { mac: Uint8Array; message: Uint8Array },
): Uint8Array {
  const { enc, auth, iv } = deriveMsgKeys(mk)
  // Verify-before-decrypt: recompute the MAC over ad || message and compare
  // constant-time. Throw BEFORE touching AES-decrypt on mismatch.
  if (!bytesEqual(hmacSha256(auth, concatBytes(ad, authMessage.message)).slice(0, 16), authMessage.mac)) {
    throw new Error('ratchet message authentication failed')
  }
  const parsed = decodeOmemoMessage(authMessage.message)
  return cbc(enc, iv).decrypt(parsed.ciphertext!)
}

export function initRatchetInitiator(sharedSecret: Uint8Array, remoteSpkPub: Uint8Array, rng: Rng): RatchetState {
  const dh = generateX25519(rng)
  const first = kdfRoot(sharedSecret, x25519.scalarMult(dh.priv, remoteSpkPub))
  return {
    rng,
    dhSelfPriv: dh.priv,
    dhSelfPub: dh.pub,
    dhRemote: remoteSpkPub,
    rootKey: first.rootKey,
    sendChain: first.chainKey,
    recvChain: null,
    ns: 0,
    nr: 0,
    pn: 0,
    skipped: new Map(),
  }
}

export function initRatchetResponder(sharedSecret: Uint8Array, spkPriv: Uint8Array, spkPub: Uint8Array): RatchetState {
  return {
    rng: () => new Uint8Array(0),
    dhSelfPriv: spkPriv,
    dhSelfPub: spkPub,
    dhRemote: null,
    rootKey: sharedSecret,
    sendChain: null,
    recvChain: null,
    ns: 0,
    nr: 0,
    pn: 0,
    skipped: new Map(),
  }
}

export function ratchetEncrypt(
  state: RatchetState,
  plaintext: Uint8Array,
  ad: Uint8Array,
): { state: RatchetState; authMessage: { mac: Uint8Array; message: Uint8Array } } {
  const s = { ...state, skipped: new Map(state.skipped) }
  const step = kdfChain(s.sendChain!)
  s.sendChain = step.chainKey
  const header: Header = { dhPub: s.dhSelfPub, pn: s.pn, n: s.ns }
  s.ns += 1
  return { state: s, authMessage: sealMessage(step.messageKey, ad, header, plaintext) }
}

export function ratchetDecrypt(
  state: RatchetState,
  authMessage: { mac: Uint8Array; message: Uint8Array },
  ad: Uint8Array,
): { state: RatchetState; plaintext: Uint8Array } {
  const header = decodeOmemoMessage(authMessage.message)
  let s: RatchetState = { ...state, skipped: new Map(state.skipped) }

  // A previously-skipped (out-of-order) message: consume its stored key exactly once.
  const skipId = hexKey(header.dhPub, header.n)
  const skippedKey = s.skipped.get(skipId)
  if (skippedKey) {
    s.skipped.delete(skipId)
    return { state: s, plaintext: openMessage(skippedKey, ad, authMessage) }
  }

  const isNewRemote = !s.dhRemote || !bytesEqual(s.dhRemote, header.dhPub)
  if (isNewRemote) {
    s = skipMessageKeys(s, header.pn)
    s = dhRatchet(s, header.dhPub)
  }
  s = skipMessageKeys(s, header.n)

  const step = kdfChain(s.recvChain!)
  s.recvChain = step.chainKey
  s.nr += 1
  return { state: s, plaintext: openMessage(step.messageKey, ad, authMessage) }
}

function skipMessageKeys(state: RatchetState, until: number): RatchetState {
  if (state.recvChain === null) return state
  if (state.nr + MAX_SKIP < until) throw new Error('too many skipped messages')
  const s = { ...state, skipped: new Map(state.skipped) }
  while (s.nr < until) {
    const step = kdfChain(s.recvChain!)
    s.recvChain = step.chainKey
    s.skipped.set(hexKey(s.dhRemote!, s.nr), step.messageKey)
    s.nr += 1
  }
  return s
}

function dhRatchet(state: RatchetState, remoteDhPub: Uint8Array): RatchetState {
  const s = { ...state }
  s.pn = s.ns
  s.ns = 0
  s.nr = 0
  s.dhRemote = remoteDhPub
  const recv = kdfRoot(s.rootKey, x25519.scalarMult(s.dhSelfPriv, remoteDhPub))
  s.rootKey = recv.rootKey
  s.recvChain = recv.chainKey
  const dh = generateX25519(s.rng)
  s.dhSelfPriv = dh.priv
  s.dhSelfPub = dh.pub
  const send = kdfRoot(s.rootKey, x25519.scalarMult(s.dhSelfPriv, remoteDhPub))
  s.rootKey = send.rootKey
  s.sendChain = send.chainKey
  return s
}

interface SerializableState {
  dhSelfPriv: number[]
  dhSelfPub: number[]
  dhRemote: number[] | null
  rootKey: number[]
  sendChain: number[] | null
  recvChain: number[] | null
  ns: number
  nr: number
  pn: number
  skipped: [string, number[]][]
}

export function serializeRatchet(s: RatchetState): Uint8Array {
  const obj: SerializableState = {
    dhSelfPriv: [...s.dhSelfPriv],
    dhSelfPub: [...s.dhSelfPub],
    dhRemote: s.dhRemote ? [...s.dhRemote] : null,
    rootKey: [...s.rootKey],
    sendChain: s.sendChain ? [...s.sendChain] : null,
    recvChain: s.recvChain ? [...s.recvChain] : null,
    ns: s.ns,
    nr: s.nr,
    pn: s.pn,
    skipped: [...s.skipped.entries()].map(([k, v]) => [k, [...v]]),
  }
  return new TextEncoder().encode(JSON.stringify(obj))
}

export function deserializeRatchet(bytes: Uint8Array): RatchetState {
  const o: SerializableState = JSON.parse(new TextDecoder().decode(bytes))
  return {
    rng: (n: number) => new Uint8Array(n), // account layer re-injects the real rng before sending
    dhSelfPriv: Uint8Array.from(o.dhSelfPriv),
    dhSelfPub: Uint8Array.from(o.dhSelfPub),
    dhRemote: o.dhRemote ? Uint8Array.from(o.dhRemote) : null,
    rootKey: Uint8Array.from(o.rootKey),
    sendChain: o.sendChain ? Uint8Array.from(o.sendChain) : null,
    recvChain: o.recvChain ? Uint8Array.from(o.recvChain) : null,
    ns: o.ns,
    nr: o.nr,
    pn: o.pn,
    skipped: new Map(o.skipped.map(([k, v]) => [k, Uint8Array.from(v)])),
  }
}
