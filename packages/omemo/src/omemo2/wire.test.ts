import { describe, it, expect } from 'vitest'
import {
  encodeOmemoMessage,
  decodeOmemoMessage,
  encodeAuthMessage,
  decodeAuthMessage,
  encodeKeyExchange,
  decodeKeyExchange,
} from './wire'

// --- local byte-crafting helpers, independent of wire.ts internals, for edge-case tests ---
function rawVarint(n: number): number[] {
  const out: number[] = []
  let v = n >>> 0
  while (v > 0x7f) {
    out.push((v & 0x7f) | 0x80)
    v >>>= 7
  }
  out.push(v)
  return out
}
function rawTag(fieldNo: number, wireType: number): number[] {
  return rawVarint((fieldNo << 3) | wireType)
}
function rawVarintField(fieldNo: number, value: number): number[] {
  return [...rawTag(fieldNo, 0), ...rawVarint(value)]
}
function rawBytesField(fieldNo: number, value: number[]): number[] {
  return [...rawTag(fieldNo, 2), ...rawVarint(value.length), ...value]
}

describe('omemo2 wire protobuf', () => {
  it('OMEMOMessage round-trips (with and without ciphertext)', () => {
    const m = { n: 5, pn: 3, dhPub: new Uint8Array(32).fill(7), ciphertext: new Uint8Array([1, 2, 3]) }
    expect(decodeOmemoMessage(encodeOmemoMessage(m))).toEqual(m)
    const empty = { n: 0, pn: 0, dhPub: new Uint8Array(32).fill(1) }
    expect(decodeOmemoMessage(encodeOmemoMessage(empty))).toEqual(empty)
  })

  it('OMEMOAuthenticatedMessage round-trips', () => {
    const m = { mac: new Uint8Array(16).fill(9), message: new Uint8Array([4, 5, 6]) }
    expect(decodeAuthMessage(encodeAuthMessage(m))).toEqual(m)
  })

  it('OMEMOKeyExchange round-trips', () => {
    const m = {
      pkId: 42,
      spkId: 1,
      ik: new Uint8Array(32).fill(2),
      ek: new Uint8Array(32).fill(3),
      message: new Uint8Array([7, 8, 9]),
    }
    expect(decodeKeyExchange(encodeKeyExchange(m))).toEqual(m)
  })

  it('OMEMOMessage with n=0, pn=0 and no ciphertext omits field 4 (not empty bytes)', () => {
    const m = { n: 0, pn: 0, dhPub: new Uint8Array(32).fill(3) }
    const encoded = encodeOmemoMessage(m)
    const decoded = decodeOmemoMessage(encoded)
    expect(decoded.ciphertext).toBeUndefined()
    expect('ciphertext' in decoded).toBe(false)
    expect(decoded).toEqual(m)
  })

  it('large multi-byte varint values round-trip for n, pn, and pk_id', () => {
    const largeValues = [300, 16384, 2 ** 28, 0x7fffffff, 0xffffffff]
    for (const v of largeValues) {
      const m = { n: v, pn: v, dhPub: new Uint8Array(4).fill(5) }
      expect(decodeOmemoMessage(encodeOmemoMessage(m))).toEqual(m)

      const kex = { pkId: v, spkId: v, ik: new Uint8Array(4), ek: new Uint8Array(4), message: new Uint8Array(4) }
      expect(decodeKeyExchange(encodeKeyExchange(kex))).toEqual(kex)
    }
  })

  it('decoding skips an unknown varint field number gracefully (forward-compat)', () => {
    const m = { n: 5, pn: 3, dhPub: new Uint8Array([1, 2, 3, 4]), ciphertext: new Uint8Array([9, 9]) }
    const bytes = [
      ...rawVarintField(1, m.n),
      ...rawVarintField(2, m.pn),
      ...rawBytesField(3, Array.from(m.dhPub)),
      ...rawVarintField(50, 123456), // unknown field, varint wire type
      ...rawBytesField(4, Array.from(m.ciphertext)),
    ]
    const decoded = decodeOmemoMessage(new Uint8Array(bytes))
    expect(decoded).toEqual(m)
  })

  it('decoding skips an unknown length-delimited field number gracefully (forward-compat)', () => {
    const m = { mac: new Uint8Array([1, 2, 3]), message: new Uint8Array([4, 5, 6]) }
    const bytes = [
      ...rawBytesField(1, Array.from(m.mac)),
      ...rawBytesField(99, [10, 20, 30, 40, 50]), // unknown field, length-delimited
      ...rawBytesField(2, Array.from(m.message)),
    ]
    const decoded = decodeAuthMessage(new Uint8Array(bytes))
    expect(decoded).toEqual(m)
  })

  it('decoding skips multiple interleaved unknown fields across a full KeyExchange message', () => {
    const m = {
      pkId: 7,
      spkId: 8,
      ik: new Uint8Array(32).fill(1),
      ek: new Uint8Array(32).fill(2),
      message: new Uint8Array([1, 2, 3]),
    }
    const bytes = [
      ...rawVarintField(77, 999), // unknown varint before any known field
      ...rawVarintField(1, m.pkId),
      ...rawVarintField(2, m.spkId),
      ...rawBytesField(88, [1, 1, 1]), // unknown bytes
      ...rawBytesField(3, Array.from(m.ik)),
      ...rawBytesField(4, Array.from(m.ek)),
      ...rawVarintField(89, 42), // unknown varint
      ...rawBytesField(5, Array.from(m.message)),
    ]
    const decoded = decodeKeyExchange(new Uint8Array(bytes))
    expect(decoded).toEqual(m)
  })

  it('empty bytes fields (zero-length dh_pub) round-trip', () => {
    const m = { n: 1, pn: 2, dhPub: new Uint8Array(0) }
    const decoded = decodeOmemoMessage(encodeOmemoMessage(m))
    expect(decoded).toEqual(m)
    expect(decoded.dhPub.length).toBe(0)
  })

  it('empty bytes ciphertext field round-trips as present-but-empty, distinct from omitted', () => {
    const withEmptyCiphertext = { n: 1, pn: 1, dhPub: new Uint8Array([1]), ciphertext: new Uint8Array(0) }
    const decoded = decodeOmemoMessage(encodeOmemoMessage(withEmptyCiphertext))
    expect(decoded.ciphertext).toBeDefined()
    expect(decoded.ciphertext).toEqual(new Uint8Array(0))
  })
})
