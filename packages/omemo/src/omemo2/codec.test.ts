import { describe, it, expect } from 'vitest'
import { b64encode, b64decode, assertValidBundle, type Bundle } from './codec'

function makeValidBundle(overrides: Partial<Bundle> = {}): Bundle {
  return {
    ik: new Uint8Array(32),
    spkId: 1,
    spk: new Uint8Array(32),
    spkSig: new Uint8Array(64),
    preKeys: Array.from({ length: 25 }, (_, i) => ({ id: i, key: new Uint8Array(32) })),
    ...overrides,
  }
}

describe('omemo2 codec', () => {
  it('base64 round-trips', () => {
    const u = new Uint8Array([0, 1, 2, 250, 255])
    expect(b64decode(b64encode(u))).toEqual(u)
  })

  it('rejects a bundle with fewer than 25 prekeys', () => {
    const bundle: Bundle = {
      ik: new Uint8Array(32),
      spkId: 1,
      spk: new Uint8Array(32),
      spkSig: new Uint8Array(64),
      preKeys: [{ id: 1, key: new Uint8Array(32) }],
    }
    expect(() => assertValidBundle(bundle)).toThrow(/at least 25/)
  })

  it('accepts a well-formed bundle with exactly 25 prekeys', () => {
    expect(() => assertValidBundle(makeValidBundle())).not.toThrow()
  })

  it('rejects a bundle whose ik is not 32 bytes', () => {
    expect(() => assertValidBundle(makeValidBundle({ ik: new Uint8Array(31) }))).toThrow(/ik must be 32 bytes/)
    expect(() => assertValidBundle(makeValidBundle({ ik: new Uint8Array(33) }))).toThrow(/ik must be 32 bytes/)
  })

  it('rejects a bundle whose spk is not 32 bytes', () => {
    expect(() => assertValidBundle(makeValidBundle({ spk: new Uint8Array(16) }))).toThrow(/spk must be 32 bytes/)
  })

  it('rejects a bundle whose spkSig is not 64 bytes', () => {
    expect(() => assertValidBundle(makeValidBundle({ spkSig: new Uint8Array(63) }))).toThrow(
      /spkSig must be 64 bytes/,
    )
    expect(() => assertValidBundle(makeValidBundle({ spkSig: new Uint8Array(65) }))).toThrow(
      /spkSig must be 64 bytes/,
    )
  })

  it('base64 round-trips bytes with the high bit set (0x80..0xff)', () => {
    const u = new Uint8Array(Array.from({ length: 128 }, (_, i) => 0x80 + i))
    expect(b64decode(b64encode(u))).toEqual(u)
  })

  it('base64 round-trips empty input', () => {
    const u = new Uint8Array(0)
    const encoded = b64encode(u)
    expect(encoded).toBe('')
    expect(b64decode(encoded)).toEqual(u)
  })

  it('base64 round-trips all 256 byte values', () => {
    const u = new Uint8Array(Array.from({ length: 256 }, (_, i) => i))
    expect(b64decode(b64encode(u))).toEqual(u)
  })
})
