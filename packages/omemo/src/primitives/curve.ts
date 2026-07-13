import { x25519 as nobleX } from '@noble/curves/ed25519'
import { ed25519, edwardsToMontgomeryPub, edwardsToMontgomeryPriv } from '@noble/curves/ed25519'
import type { Rng } from './bytes'

export const x25519 = {
  scalarMult(scalar: Uint8Array, u: Uint8Array): Uint8Array {
    return nobleX.scalarMult(scalar, u)
  },
  getPublicKey(scalar: Uint8Array): Uint8Array {
    return nobleX.getPublicKey(scalar)
  },
}

export function generateX25519(rng: Rng): { priv: Uint8Array; pub: Uint8Array } {
  const priv = rng(32)
  return { priv, pub: nobleX.getPublicKey(priv) }
}

export function generateEd25519(rng: Rng): { priv: Uint8Array; pub: Uint8Array } {
  const seed = rng(32)
  return { priv: seed, pub: ed25519.getPublicKey(seed) }
}

/** Convert an Ed25519 public key to its Curve25519 (Montgomery) u-coordinate. */
export function ed25519PubToMontgomery(edPub: Uint8Array): Uint8Array {
  return edwardsToMontgomeryPub(edPub)
}

/** Convert an Ed25519 seed to the clamped Montgomery scalar usable for X25519 DH. */
export function ed25519SeedToMontgomeryPriv(seed: Uint8Array): Uint8Array {
  return edwardsToMontgomeryPriv(seed)
}
