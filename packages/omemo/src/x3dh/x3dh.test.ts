import { describe, it, expect } from 'vitest'
import { createIdentity } from '../identity/identity'
import { generateSignedPreKey, generatePreKeys } from '../prekeys/prekeys'
import { x3dhInitiator, x3dhResponder } from './x3dh'

// Counter-based rng so each 32-byte draw differs.
function counterRng() {
  let c = 0
  return (n: number) => Uint8Array.from({ length: n }, () => (c = (c + 1) & 0xff))
}

describe('x3dh', () => {
  it('initiator and responder agree on the shared secret', () => {
    const rng = counterRng()
    const alice = createIdentity(rng, 1)
    const bob = createIdentity(rng, 2)
    const bobSpk = generateSignedPreKey(rng, 0, bob.edSeed, 1)
    const bobOtk = generatePreKeys(rng, 1, 1)[0]

    const init = x3dhInitiator({
      identitySeed: alice.edSeed,
      rng,
      remoteIdentityEd: bob.edPub,
      remoteSignedPreKey: bobSpk.pub,
      remoteOneTimePreKey: bobOtk.pub,
    })
    const resp = x3dhResponder({
      identitySeed: bob.edSeed,
      signedPreKeyPriv: bobSpk.priv,
      oneTimePreKeyPriv: bobOtk.priv,
      remoteIdentityEd: alice.edPub,
      remoteEphemeral: init.ephemeralPub,
    })
    expect(resp.sharedSecret).toEqual(init.sharedSecret)
    expect(init.sharedSecret.length).toBe(32)
  })

  it('agrees WITHOUT a one-time prekey (DH1..DH3 only)', () => {
    const rng = counterRng()
    const alice = createIdentity(rng, 1)
    const bob = createIdentity(rng, 2)
    const bobSpk = generateSignedPreKey(rng, 0, bob.edSeed, 1)

    const init = x3dhInitiator({
      identitySeed: alice.edSeed,
      rng,
      remoteIdentityEd: bob.edPub,
      remoteSignedPreKey: bobSpk.pub,
      // no remoteOneTimePreKey
    })
    const resp = x3dhResponder({
      identitySeed: bob.edSeed,
      signedPreKeyPriv: bobSpk.priv,
      // no oneTimePreKeyPriv
      remoteIdentityEd: alice.edPub,
      remoteEphemeral: init.ephemeralPub,
    })
    expect(resp.sharedSecret).toEqual(init.sharedSecret)
    expect(init.sharedSecret.length).toBe(32)
  })

  it('differs when the responder uses a DIFFERENT signed-prekey private', () => {
    const rng = counterRng()
    const alice = createIdentity(rng, 1)
    const bob = createIdentity(rng, 2)
    const bobSpk = generateSignedPreKey(rng, 0, bob.edSeed, 1)
    const otherSpk = generateSignedPreKey(rng, 0, bob.edSeed, 2)

    const init = x3dhInitiator({
      identitySeed: alice.edSeed,
      rng,
      remoteIdentityEd: bob.edPub,
      remoteSignedPreKey: bobSpk.pub,
    })
    const resp = x3dhResponder({
      identitySeed: bob.edSeed,
      signedPreKeyPriv: otherSpk.priv, // mismatched: does not correspond to bobSpk.pub
      remoteIdentityEd: alice.edPub,
      remoteEphemeral: init.ephemeralPub,
    })
    expect(resp.sharedSecret).not.toEqual(init.sharedSecret)
  })

  it('produces a 32-byte, non-zero shared secret', () => {
    const rng = counterRng()
    const alice = createIdentity(rng, 1)
    const bob = createIdentity(rng, 2)
    const bobSpk = generateSignedPreKey(rng, 0, bob.edSeed, 1)
    const bobOtk = generatePreKeys(rng, 1, 1)[0]

    const init = x3dhInitiator({
      identitySeed: alice.edSeed,
      rng,
      remoteIdentityEd: bob.edPub,
      remoteSignedPreKey: bobSpk.pub,
      remoteOneTimePreKey: bobOtk.pub,
    })
    expect(init.sharedSecret.length).toBe(32)
    expect(init.sharedSecret.some((b) => b !== 0)).toBe(true)
  })
})
