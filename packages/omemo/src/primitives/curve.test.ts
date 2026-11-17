import { describe, it, expect } from 'vitest'
import { x25519, generateX25519, generateEd25519, ed25519PubToMontgomery } from './curve'
import type { Rng } from './bytes'

const hex = (s: string) => Uint8Array.from(s.match(/.{2}/g)!.map((b) => parseInt(b, 16)))
const toHex = (u: Uint8Array) => [...u].map((b) => b.toString(16).padStart(2, '0')).join('')

/** Counter-based deterministic rng: each call advances an internal counter so
 * successive invocations produce distinct byte streams (unlike a constant fill). */
function makeCounterRng(): Rng {
  let counter = 0
  return (n: number) =>
    Uint8Array.from({ length: n }, (_, i) => {
      counter = (counter + 1) & 0xff
      return (counter + i) & 0xff
    })
}

describe('curve primitives', () => {
  it('X25519 RFC 7748 scalar mult vector', () => {
    const k = hex('a546e36bf0527c9d3b16154b82465edd62144c0ac1fc5a18506a2244ba449ac4')
    const u = hex('e6db6867583030db3594c1a424b15f7c726624ec26b3353b10a903a6d0ab1c4c')
    expect(toHex(x25519.scalarMult(k, u))).toBe(
      'c3da55379de9c6908e94ea4df28d084f32eccf03491c71f754b4075577a28552',
    )
  })

  it('ed25519 public converts to a 32-byte montgomery u-coordinate', () => {
    let seed = 1
    const rng = (n: number) => Uint8Array.from({ length: n }, () => (seed = (seed * 1103515245 + 12345) & 0xff))
    const kp = generateEd25519(rng)
    const mont = ed25519PubToMontgomery(kp.pub)
    expect(mont.length).toBe(32)
  })

  it('x25519.getPublicKey of a known scalar is 32 bytes', () => {
    const scalar = hex('a546e36bf0527c9d3b16154b82465edd62144c0ac1fc5a18506a2244ba449ac4')
    const pub = x25519.getPublicKey(scalar)
    expect(pub.length).toBe(32)
  })

  it('DH agreement round-trips between two generated keypairs', () => {
    const rng = makeCounterRng()
    const alice = generateX25519(rng)
    const bob = generateX25519(rng)

    // Distinct keys since the rng advances between calls.
    expect(toHex(alice.priv)).not.toBe(toHex(bob.priv))
    expect(toHex(alice.pub)).not.toBe(toHex(bob.pub))

    const sharedFromAlice = x25519.scalarMult(alice.priv, bob.pub)
    const sharedFromBob = x25519.scalarMult(bob.priv, alice.pub)
    expect(toHex(sharedFromAlice)).toBe(toHex(sharedFromBob))
    expect(sharedFromAlice.length).toBe(32)
  })

  it('ed25519PubToMontgomery is deterministic and 32 bytes', () => {
    let seed = 7
    const rng = (n: number) => Uint8Array.from({ length: n }, () => (seed = (seed * 1103515245 + 12345) & 0xff))
    const kp = generateEd25519(rng)
    const mont1 = ed25519PubToMontgomery(kp.pub)
    const mont2 = ed25519PubToMontgomery(kp.pub)
    expect(mont1.length).toBe(32)
    expect(toHex(mont1)).toBe(toHex(mont2))
  })
})
