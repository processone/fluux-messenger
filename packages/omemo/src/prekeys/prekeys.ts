import { generateX25519 } from '../primitives/curve'
import { xeddsaSign, xeddsaVerify } from '../primitives/xeddsa'
import type { Rng } from '../primitives/bytes'
import type { SignedPreKeyRecord, PreKeyRecord } from '../store/types'

/**
 * Generate a signed prekey: an X25519 keypair whose public key is signed
 * with the caller's Ed25519 identity key (`edSeed`). `_idSeed` is accepted
 * for interface symmetry with `generatePreKeys` but is unused — key material
 * comes entirely from `rng`.
 */
export function generateSignedPreKey(rng: Rng, _idSeed: number, edSeed: Uint8Array, id: number): SignedPreKeyRecord {
  const kp = generateX25519(rng)
  const signature = xeddsaSign(edSeed, kp.pub, rng)
  return { id, priv: kp.priv, pub: kp.pub, signature }
}

/** Generate `count` one-time X25519 prekeys with sequential ids starting at `startId`. */
export function generatePreKeys(rng: Rng, startId: number, count: number): PreKeyRecord[] {
  const out: PreKeyRecord[] = []
  for (let i = 0; i < count; i++) {
    const kp = generateX25519(rng)
    out.push({ id: startId + i, priv: kp.priv, pub: kp.pub })
  }
  return out
}

/** Verify a signed prekey's signature (over `spk.pub`) against an Ed25519 identity public key. */
export function verifySignedPreKey(edPub: Uint8Array, spk: SignedPreKeyRecord): boolean {
  return xeddsaVerify(edPub, spk.pub, spk.signature)
}
