import { describe, it, expect } from 'vitest'
import { derivePayloadKeys, payloadEncrypt, payloadDecrypt } from './aead'

describe('OMEMO payload AEAD', () => {
  const master = new Uint8Array(32).fill(9)

  it('derives 32|32|16 keys from "OMEMO Payload"', () => {
    const k = derivePayloadKeys(master)
    expect(k.encKey.length).toBe(32)
    expect(k.authKey.length).toBe(32)
    expect(k.iv.length).toBe(16)
  })

  it('encrypt then decrypt round-trips', () => {
    const pt = new TextEncoder().encode('hello omemo')
    const { ciphertext, tag } = payloadEncrypt(master, pt)
    expect(tag.length).toBe(16)
    expect(payloadDecrypt(master, ciphertext, tag)).toEqual(pt)
  })

  it('rejects a tampered tag', () => {
    const { ciphertext, tag } = payloadEncrypt(master, new Uint8Array([1, 2, 3]))
    tag[0] ^= 0xff
    expect(() => payloadDecrypt(master, ciphertext, tag)).toThrow()
  })

  it('rejects a tampered ciphertext', () => {
    const { ciphertext, tag } = payloadEncrypt(master, new TextEncoder().encode('tamper me'))
    ciphertext[0] ^= 0xff
    expect(() => payloadDecrypt(master, ciphertext, tag)).toThrow()
  })

  it('rejects the wrong master key', () => {
    const { ciphertext, tag } = payloadEncrypt(master, new TextEncoder().encode('secret'))
    const wrongMaster = new Uint8Array(32).fill(7)
    expect(() => payloadDecrypt(wrongMaster, ciphertext, tag)).toThrow()
  })

  it('round-trips empty plaintext (PKCS#7 pads a full block)', () => {
    const pt = new Uint8Array(0)
    const { ciphertext, tag } = payloadEncrypt(master, pt)
    expect(ciphertext.length).toBe(16)
    expect(payloadDecrypt(master, ciphertext, tag)).toEqual(pt)
  })

  it('round-trips a plaintext exactly one block (16 bytes)', () => {
    const pt = new Uint8Array(16).fill(0x42)
    const { ciphertext, tag } = payloadEncrypt(master, pt)
    expect(ciphertext.length).toBe(32)
    expect(payloadDecrypt(master, ciphertext, tag)).toEqual(pt)
  })
})
