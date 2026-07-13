// Typed structures and base64 helpers for OMEMO 2 (XEP-0384) bundles, device lists, and messages.
// XMPP-agnostic: no XML, no PEP here — callers in the XMPP layer map these to/from stanzas.

export interface Bundle {
  ik: Uint8Array // Ed25519 identity public key (32 bytes)
  spkId: number
  spk: Uint8Array // X25519 signed prekey public (32 bytes)
  spkSig: Uint8Array // Ed25519 signature over spk (64 bytes)
  preKeys: { id: number; key: Uint8Array }[]
}

export type DeviceList = number[]

export interface OmemoKey {
  rid: number
  kex: boolean // true => data is a byte-serialized OMEMOKeyExchange, false => an OMEMOAuthenticatedMessage
  data: Uint8Array
}

export interface OmemoMessage {
  sid: number
  keys: OmemoKey[]
  payload?: Uint8Array // AES-256-CBC ciphertext of the SCE envelope; omitted for key-transport (empty) messages
}

/** Minimum number of one-time prekeys a published bundle must carry, per XEP-0384 recommendation. */
export const MIN_BUNDLE_PREKEYS = 25

export function b64encode(u: Uint8Array): string {
  let s = ''
  for (let i = 0; i < u.length; i++) s += String.fromCharCode(u[i])
  return btoa(s)
}

export function b64decode(s: string): Uint8Array {
  const bin = atob(s)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

export function assertValidBundle(b: Bundle): void {
  if (b.ik.length !== 32) throw new Error(`bundle ik must be 32 bytes, got ${b.ik.length}`)
  if (b.spk.length !== 32) throw new Error(`bundle spk must be 32 bytes, got ${b.spk.length}`)
  if (b.spkSig.length !== 64) throw new Error(`bundle spkSig must be 64 bytes, got ${b.spkSig.length}`)
  if (b.preKeys.length < MIN_BUNDLE_PREKEYS) {
    throw new Error(`bundle must contain at least ${MIN_BUNDLE_PREKEYS} prekeys, got ${b.preKeys.length}`)
  }
}
