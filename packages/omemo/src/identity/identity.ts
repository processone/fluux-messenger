import { generateEd25519, ed25519PubToMontgomery } from '../primitives/curve'
import type { Rng } from '../primitives/bytes'
import type { IdentityRecord } from '../store/types'

export function createIdentity(rng: Rng, deviceId: number): IdentityRecord {
  const kp = generateEd25519(rng)
  return { edSeed: kp.priv, edPub: kp.pub, deviceId }
}

/** OMEMO fingerprint is the identity key in Curve25519 (Montgomery) byte form. */
export function fingerprint(edPub: Uint8Array): Uint8Array {
  return ed25519PubToMontgomery(edPub)
}

export function randomDeviceId(rng: Rng): number {
  const b = rng(4)
  const n = ((b[0] << 24) | (b[1] << 16) | (b[2] << 8) | b[3]) & 0x7fffffff
  return n === 0 ? 1 : n
}
