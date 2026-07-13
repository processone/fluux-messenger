import { describe, it, expect } from 'vitest'
import { generateEd25519 } from './curve'
import { xeddsaSign, xeddsaVerify } from './xeddsa'

const rng = (n: number) => new Uint8Array(n).fill(7)

describe('xeddsa', () => {
  it('signs and verifies', () => {
    const kp = generateEd25519(rng)
    const msg = new TextEncoder().encode('signed prekey bytes')
    const sig = xeddsaSign(kp.priv, msg, rng)
    expect(sig.length).toBe(64)
    expect(xeddsaVerify(kp.pub, msg, sig)).toBe(true)
  })

  it('rejects a tampered message', () => {
    const kp = generateEd25519(rng)
    const sig = xeddsaSign(kp.priv, new TextEncoder().encode('a'), rng)
    expect(xeddsaVerify(kp.pub, new TextEncoder().encode('b'), sig)).toBe(false)
  })

  it('rejects a tampered signature (single flipped byte)', () => {
    const kp = generateEd25519(rng)
    const msg = new TextEncoder().encode('signed prekey bytes')
    const sig = xeddsaSign(kp.priv, msg, rng)
    const tampered = Uint8Array.from(sig)
    tampered[0] ^= 0xff
    expect(xeddsaVerify(kp.pub, msg, tampered)).toBe(false)
  })

  it('rejects a signature verified against the wrong public key', () => {
    const kp = generateEd25519(rng)
    const other = generateEd25519((n) => new Uint8Array(n).fill(9))
    const msg = new TextEncoder().encode('signed prekey bytes')
    const sig = xeddsaSign(kp.priv, msg, rng)
    expect(xeddsaVerify(other.pub, msg, sig)).toBe(false)
  })

  it('rejects a truncated (malformed) signature without throwing', () => {
    const kp = generateEd25519(rng)
    const msg = new TextEncoder().encode('signed prekey bytes')
    const truncated = new Uint8Array(10).fill(1)
    expect(() => xeddsaVerify(kp.pub, msg, truncated)).not.toThrow()
    expect(xeddsaVerify(kp.pub, msg, truncated)).toBe(false)
  })

  it('rejects an empty signature without throwing', () => {
    const kp = generateEd25519(rng)
    const msg = new TextEncoder().encode('signed prekey bytes')
    expect(() => xeddsaVerify(kp.pub, msg, new Uint8Array(0))).not.toThrow()
    expect(xeddsaVerify(kp.pub, msg, new Uint8Array(0))).toBe(false)
  })

  it('rejects an oversized (malformed) signature without throwing', () => {
    const kp = generateEd25519(rng)
    const msg = new TextEncoder().encode('signed prekey bytes')
    const oversized = new Uint8Array(128).fill(3)
    expect(() => xeddsaVerify(kp.pub, msg, oversized)).not.toThrow()
    expect(xeddsaVerify(kp.pub, msg, oversized)).toBe(false)
  })

  it('rejects a malformed public key without throwing', () => {
    const kp = generateEd25519(rng)
    const msg = new TextEncoder().encode('signed prekey bytes')
    const sig = xeddsaSign(kp.priv, msg, rng)
    const badPub = new Uint8Array(4).fill(2)
    expect(() => xeddsaVerify(badPub, msg, sig)).not.toThrow()
    expect(xeddsaVerify(badPub, msg, sig)).toBe(false)
  })
})
