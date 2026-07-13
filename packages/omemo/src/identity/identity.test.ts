import { describe, it, expect } from 'vitest'
import { createIdentity, fingerprint, randomDeviceId } from './identity'

const rng = (n: number) => new Uint8Array(n).fill(3)

/** Deterministic counter-based rng: each call advances an internal counter so
 * successive calls (and successive identities) produce different key material. */
function counterRng() {
  let counter = 0
  return (n: number) => {
    const out = new Uint8Array(n)
    for (let i = 0; i < n; i++) out[i] = (counter + i) & 0xff
    counter++
    return out
  }
}

describe('identity', () => {
  it('creates an identity with a stable curve fingerprint', () => {
    const id = createIdentity(rng, 42)
    expect(id.deviceId).toBe(42)
    expect(id.edPub.length).toBe(32)
    const fp = fingerprint(id.edPub)
    expect(fp.length).toBe(32)
    expect(fingerprint(id.edPub)).toEqual(fp) // deterministic
  })

  it('randomDeviceId is a positive 31-bit int', () => {
    const d = randomDeviceId((n) => new Uint8Array(n).fill(0xff))
    expect(d).toBeGreaterThan(0)
    expect(d).toBeLessThanOrEqual(0x7fffffff)
  })

  it('randomDeviceId never returns 0 even when the rng yields all-zero bytes', () => {
    const d = randomDeviceId((n) => new Uint8Array(n).fill(0))
    expect(d).toBe(1)
  })

  it('randomDeviceId masks the top bit so all-0xff bytes stay within 31 bits', () => {
    const d = randomDeviceId((n) => new Uint8Array(n).fill(0xff))
    expect(d).toBe(0x7fffffff)
    expect(d).toBeLessThanOrEqual(0x7fffffff)
  })

  it('produces different fingerprints for different identities', () => {
    const gen = counterRng()
    const a = createIdentity(gen, 1)
    const b = createIdentity(gen, 2)
    expect(fingerprint(a.edPub)).not.toEqual(fingerprint(b.edPub))
  })

  it('fingerprint differs from the raw Ed25519 public key bytes', () => {
    const id = createIdentity(rng, 1)
    const fp = fingerprint(id.edPub)
    expect(fp).not.toEqual(id.edPub)
  })
})
