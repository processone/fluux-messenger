import { describe, it, expect } from 'vitest'
import { hmacSha256, hkdf } from './hash'

const hex = (s: string) => Uint8Array.from(s.match(/.{2}/g)!.map((b) => parseInt(b, 16)))
const toHex = (u: Uint8Array) => [...u].map((b) => b.toString(16).padStart(2, '0')).join('')

describe('hash primitives', () => {
  it('HMAC-SHA256 RFC 4231 test case 1', () => {
    const key = hex('0b'.repeat(20))
    const data = new TextEncoder().encode('Hi There')
    expect(toHex(hmacSha256(key, data))).toBe(
      'b0344c61d8db38535ca8afceaf0bf12b881dc200c9833da726e9376c2e32cff7',
    )
  })

  it('HMAC-SHA256 over an empty message', () => {
    const key = hex('0b'.repeat(20))
    const data = new Uint8Array(0)
    const mac = hmacSha256(key, data)
    expect(mac.length).toBe(32)
    // RFC 4231 has no empty-message vector; cross-checked against Node's built-in crypto
    // (independent implementation) for HMAC-SHA256('', key=0x0b*20).
    expect(toHex(mac)).toBe('999a901219f032cd497cadb5e6051e97b6a29ab297bd6ae722bd6062a2f59542')
  })

  it('HKDF-SHA256 RFC 5869 test case 1', () => {
    const ikm = hex('0b'.repeat(22))
    const salt = hex('000102030405060708090a0b0c')
    const info = hex('f0f1f2f3f4f5f6f7f8f9')
    expect(toHex(hkdf(ikm, salt, info, 42))).toBe(
      '3cb25f25faacd57a90434f64d0362f2a2d2d0a90cf1a5a4c5db02d56ecc4c5bf34007208d5b887185865',
    )
  })

  it('HKDF-SHA256 with zero-length info', () => {
    const ikm = hex('0b'.repeat(22))
    const salt = hex('000102030405060708090a0b0c')
    const info = new Uint8Array(0)
    const okm = hkdf(ikm, salt, info, 32)
    expect(okm.length).toBe(32)
    // Deterministic: re-derive with same inputs must match (HKDF has no hidden randomness).
    expect(toHex(hkdf(ikm, salt, info, 32))).toBe(toHex(okm))
  })

  it('HKDF-SHA256 requesting a length spanning multiple SHA-256 blocks', () => {
    const ikm = hex('0b'.repeat(22))
    const salt = hex('000102030405060708090a0b0c')
    const info = hex('f0f1f2f3f4f5f6f7f8f9')
    // 64 bytes = 2 SHA-256 output blocks (32 bytes each); exercises the T(1) || T(2) expand loop.
    const okm = hkdf(ikm, salt, info, 64)
    expect(okm.length).toBe(64)
    // First 42 bytes must match the RFC 5869 test case 1 vector (HKDF-Expand is a prefix-consistent stream).
    expect(toHex(okm.slice(0, 42))).toBe(
      '3cb25f25faacd57a90434f64d0362f2a2d2d0a90cf1a5a4c5db02d56ecc4c5bf34007208d5b887185865',
    )
  })
})
