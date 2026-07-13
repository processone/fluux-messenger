import { x25519, generateX25519, ed25519SeedToMontgomeryPriv, ed25519PubToMontgomery } from '../primitives/curve'
import { hkdf } from '../primitives/hash'
import { concatBytes } from '../primitives/bytes'
import type { Rng } from '../primitives/bytes'

const X3DH_INFO = new TextEncoder().encode('OMEMO X3DH')
// X3DH prepends 32 0xFF bytes (curve identifier) before the DH concatenation.
const F = new Uint8Array(32).fill(0xff)

function kdf(dhConcat: Uint8Array): Uint8Array {
  return hkdf(concatBytes(F, dhConcat), new Uint8Array(32), X3DH_INFO, 32)
}

export interface X3DHInitiatorParams {
  identitySeed: Uint8Array // our Ed25519 seed
  rng: Rng
  remoteIdentityEd: Uint8Array // peer Ed25519 IK
  remoteSignedPreKey: Uint8Array // peer X25519 SPK pub
  remoteOneTimePreKey?: Uint8Array // peer X25519 OTK pub (optional)
}

export function x3dhInitiator(p: X3DHInitiatorParams): { sharedSecret: Uint8Array; ephemeralPub: Uint8Array } {
  const ikPriv = ed25519SeedToMontgomeryPriv(p.identitySeed)
  const spkPub = p.remoteSignedPreKey
  const remoteIkMont = ed25519PubToMontgomery(p.remoteIdentityEd)
  const eph = generateX25519(p.rng)

  const dh1 = x25519.scalarMult(ikPriv, spkPub) // IK_a * SPK_b
  const dh2 = x25519.scalarMult(eph.priv, remoteIkMont) // EK_a * IK_b
  const dh3 = x25519.scalarMult(eph.priv, spkPub) // EK_a * SPK_b
  let concat = concatBytes(dh1, dh2, dh3)
  if (p.remoteOneTimePreKey) {
    const dh4 = x25519.scalarMult(eph.priv, p.remoteOneTimePreKey) // EK_a * OTK_b
    concat = concatBytes(concat, dh4)
  }
  return { sharedSecret: kdf(concat), ephemeralPub: eph.pub }
}

export interface X3DHResponderParams {
  identitySeed: Uint8Array // our Ed25519 seed
  signedPreKeyPriv: Uint8Array // our X25519 SPK priv
  oneTimePreKeyPriv?: Uint8Array // our X25519 OTK priv (if the initiator used one)
  remoteIdentityEd: Uint8Array // peer Ed25519 IK
  remoteEphemeral: Uint8Array // peer ephemeral X25519 pub
}

export function x3dhResponder(p: X3DHResponderParams): { sharedSecret: Uint8Array } {
  const ikPriv = ed25519SeedToMontgomeryPriv(p.identitySeed)
  const remoteIkMont = ed25519PubToMontgomery(p.remoteIdentityEd)

  const dh1 = x25519.scalarMult(p.signedPreKeyPriv, remoteIkMont) // SPK_b * IK_a
  const dh2 = x25519.scalarMult(ikPriv, p.remoteEphemeral) // IK_b * EK_a
  const dh3 = x25519.scalarMult(p.signedPreKeyPriv, p.remoteEphemeral) // SPK_b * EK_a
  let concat = concatBytes(dh1, dh2, dh3)
  if (p.oneTimePreKeyPriv) {
    const dh4 = x25519.scalarMult(p.oneTimePreKeyPriv, p.remoteEphemeral) // OTK_b * EK_a
    concat = concatBytes(concat, dh4)
  }
  return { sharedSecret: kdf(concat) }
}
