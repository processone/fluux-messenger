import { describe, expect, it } from 'vitest'
import { encryptFile, decryptFile } from './MediaEncryption'

function randomPlaintext(n: number): Uint8Array {
  const out = new Uint8Array(n)
  // getRandomValues caps at 65_536 bytes per call — fill in chunks for
  // larger buffers so the stress test still sees high-entropy input.
  const CHUNK = 65_536
  for (let off = 0; off < n; off += CHUNK) {
    const view = out.subarray(off, Math.min(off + CHUNK, n))
    crypto.getRandomValues(view)
  }
  return out
}

describe('MediaEncryption', () => {
  it('encrypt → decrypt round-trips identity on small payloads', async () => {
    const plaintext = randomPlaintext(64)
    const { ciphertext, key, iv } = await encryptFile(plaintext)
    const decrypted = await decryptFile(ciphertext, key, iv)
    expect(Array.from(decrypted)).toEqual(Array.from(plaintext))
  })

  it('encrypt → decrypt round-trips identity on empty input', async () => {
    const plaintext = new Uint8Array(0)
    const { ciphertext, key, iv } = await encryptFile(plaintext)
    // Ciphertext is just the 16-byte GCM auth tag for empty input.
    expect(ciphertext.byteLength).toBe(16)
    const decrypted = await decryptFile(ciphertext, key, iv)
    expect(decrypted.byteLength).toBe(0)
  })

  it('encrypt → decrypt round-trips identity on 1 MiB payload', async () => {
    const plaintext = randomPlaintext(1024 * 1024)
    const { ciphertext, key, iv } = await encryptFile(plaintext)
    expect(ciphertext.byteLength).toBe(plaintext.byteLength + 16)
    const decrypted = await decryptFile(ciphertext, key, iv)
    expect(decrypted.byteLength).toBe(plaintext.byteLength)
    // Spot-check first/last bytes to confirm identity without large deep equals.
    expect(decrypted[0]).toBe(plaintext[0])
    expect(decrypted[decrypted.byteLength - 1]).toBe(plaintext[plaintext.byteLength - 1])
  })

  it('rejects on tampered ciphertext', async () => {
    const plaintext = randomPlaintext(128)
    const { ciphertext, key, iv } = await encryptFile(plaintext)
    const tampered = new Uint8Array(ciphertext)
    tampered[0] ^= 0x01
    await expect(decryptFile(tampered, key, iv)).rejects.toThrow()
  })

  it('rejects on wrong key', async () => {
    const plaintext = randomPlaintext(128)
    const { ciphertext, iv } = await encryptFile(plaintext)
    const wrongKey = randomPlaintext(32)
    await expect(decryptFile(ciphertext, wrongKey, iv)).rejects.toThrow()
  })

  it('rejects on wrong IV', async () => {
    const plaintext = randomPlaintext(128)
    const { ciphertext, key } = await encryptFile(plaintext)
    const wrongIv = randomPlaintext(12)
    await expect(decryptFile(ciphertext, key, wrongIv)).rejects.toThrow()
  })

  it('rejects wrong-length key at decrypt input validation', async () => {
    const plaintext = randomPlaintext(32)
    const { ciphertext, iv } = await encryptFile(plaintext)
    await expect(
      decryptFile(ciphertext, randomPlaintext(16), iv),
    ).rejects.toThrow(/key must be 32/)
  })

  it('rejects wrong-length IV at decrypt input validation', async () => {
    const plaintext = randomPlaintext(32)
    const { ciphertext, key } = await encryptFile(plaintext)
    await expect(
      decryptFile(ciphertext, key, randomPlaintext(16)),
    ).rejects.toThrow(/iv must be 12/)
  })

  it('each encrypt call produces a fresh key and IV', async () => {
    const plaintext = randomPlaintext(16)
    const results = await Promise.all(
      Array.from({ length: 20 }, () => encryptFile(plaintext)),
    )
    const keySet = new Set(results.map((r) => r.key.join(',')))
    const ivSet = new Set(results.map((r) => r.iv.join(',')))
    expect(keySet.size).toBe(20)
    expect(ivSet.size).toBe(20)
  })
})
