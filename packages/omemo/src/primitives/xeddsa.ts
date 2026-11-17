import { ed25519 } from '@noble/curves/ed25519'
import type { Rng } from './bytes'

/**
 * OMEMO-2 signs the SignedPreKey with the Ed25519 identity key. `rng` is accepted
 * for signature interface symmetry with true XEdDSA (which needs 64 random bytes);
 * Ed25519 is deterministic so it is unused here.
 */
export function xeddsaSign(edSeed: Uint8Array, message: Uint8Array, _rng: Rng): Uint8Array {
  return ed25519.sign(message, edSeed)
}

export function xeddsaVerify(edPub: Uint8Array, message: Uint8Array, sig: Uint8Array): boolean {
  try {
    return ed25519.verify(sig, message, edPub)
  } catch {
    return false
  }
}
