import { describe, it, expect } from 'vitest'
import { createIdentity } from '../identity/identity'
import { generateSignedPreKey, generatePreKeys, verifySignedPreKey } from './prekeys'

const rng = (n: number) => new Uint8Array(n).fill(5)

/** Deterministic counter-based rng: each call advances an internal counter so
 * successive calls produce different key material. */
function counterRng() {
  let counter = 0
  return (n: number) => {
    const out = new Uint8Array(n)
    for (let i = 0; i < n; i++) out[i] = (counter + i) & 0xff
    counter++
    return out
  }
}

describe('prekeys', () => {
  it('signed prekey verifies against the identity key', () => {
    const id = createIdentity(rng, 1)
    const spk = generateSignedPreKey(rng, 0, id.edSeed, 1)
    expect(spk.id).toBe(1)
    expect(spk.pub.length).toBe(32)
    expect(verifySignedPreKey(id.edPub, spk)).toBe(true)
  })

  it('generates the requested number of prekeys with sequential ids', () => {
    const pks = generatePreKeys(rng, 100, 25)
    expect(pks).toHaveLength(25)
    expect(pks[0].id).toBe(100)
    expect(pks[24].id).toBe(124)
  })

  it('verifySignedPreKey returns false if the spk public key is tampered', () => {
    const id = createIdentity(rng, 1)
    const spk = generateSignedPreKey(rng, 0, id.edSeed, 1)
    const tampered = { ...spk, pub: spk.pub.slice() }
    tampered.pub[0] ^= 0xff
    expect(verifySignedPreKey(id.edPub, tampered)).toBe(false)
  })

  it('verifySignedPreKey returns false against the wrong identity key', () => {
    const gen = counterRng()
    const id = createIdentity(gen, 1)
    const otherId = createIdentity(gen, 2)
    const spk = generateSignedPreKey(gen, 0, id.edSeed, 1)
    expect(verifySignedPreKey(otherId.edPub, spk)).toBe(false)
  })

  it('generatePreKeys with count 0 returns an empty array', () => {
    const pks = generatePreKeys(rng, 100, 0)
    expect(pks).toEqual([])
  })

  it('generatePreKeys with a counter rng produces prekeys with distinct public keys', () => {
    const gen = counterRng()
    const pks = generatePreKeys(gen, 0, 5)
    const pubHexes = pks.map((pk) => Buffer.from(pk.pub).toString('hex'))
    expect(new Set(pubHexes).size).toBe(5)
  })
})
