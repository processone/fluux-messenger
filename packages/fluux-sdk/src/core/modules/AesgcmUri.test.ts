import { describe, expect, it } from 'vitest'
import { build, parse, isAesgcmUri } from './AesgcmUri'

function randomBytes(n: number): Uint8Array {
  const out = new Uint8Array(n)
  for (let i = 0; i < n; i++) out[i] = (i * 7 + 3) & 0xff
  return out
}

describe('AesgcmUri', () => {
  describe('build', () => {
    it('encodes https URL + IV + key as aesgcm:// with hex fragment', () => {
      const httpsUrl = 'https://upload.example.org/abc.bin'
      const key = randomBytes(32)
      const iv = randomBytes(12)
      const uri = build({ httpsUrl, key, iv })
      expect(uri.startsWith('aesgcm://upload.example.org/abc.bin#')).toBe(true)
      const fragment = uri.split('#')[1]
      expect(fragment.length).toBe(24 + 64)
      expect(/^[0-9a-f]+$/.test(fragment)).toBe(true)
    })

    it('rejects http (non-https) base URLs', () => {
      expect(() =>
        build({
          httpsUrl: 'http://upload.example.org/f.bin',
          key: randomBytes(32),
          iv: randomBytes(12),
        }),
      ).toThrow(/https/)
    })

    it('rejects wrong-length key', () => {
      expect(() =>
        build({
          httpsUrl: 'https://u.example.org/f.bin',
          key: randomBytes(16),
          iv: randomBytes(12),
        }),
      ).toThrow(/key must be 32/)
    })

    it('rejects wrong-length IV', () => {
      expect(() =>
        build({
          httpsUrl: 'https://u.example.org/f.bin',
          key: randomBytes(32),
          iv: randomBytes(10),
        }),
      ).toThrow(/iv must be 12/)
    })

    it('preserves query string on signed upload URLs', () => {
      const uri = build({
        httpsUrl: 'https://u.example.org/f.bin?sig=abcd',
        key: randomBytes(32),
        iv: randomBytes(12),
      })
      expect(uri.startsWith('aesgcm://u.example.org/f.bin?sig=abcd#')).toBe(true)
    })
  })

  describe('parse', () => {
    it('round-trips build + parse', () => {
      const httpsUrl = 'https://upload.example.org/abc.bin'
      const key = randomBytes(32)
      const iv = randomBytes(12)
      const uri = build({ httpsUrl, key, iv })
      const parsed = parse(uri)
      expect(parsed.httpsUrl).toBe(httpsUrl)
      expect(Array.from(parsed.key)).toEqual(Array.from(key))
      expect(Array.from(parsed.iv)).toEqual(Array.from(iv))
    })

    it('rejects non-aesgcm scheme', () => {
      expect(() => parse('https://u.example.org/f#000')).toThrow(/scheme/)
    })

    it('rejects missing fragment', () => {
      expect(() => parse('aesgcm://u.example.org/f')).toThrow(/fragment/)
    })

    it('rejects short fragment', () => {
      expect(() => parse('aesgcm://u.example.org/f#deadbeef')).toThrow(/fragment must be/)
    })

    it('rejects non-hex fragment', () => {
      const bad = 'aesgcm://u.example.org/f#' + 'z'.repeat(88)
      expect(() => parse(bad)).toThrow(/non-hex/)
    })
  })

  describe('isAesgcmUri', () => {
    it('detects aesgcm://', () => {
      expect(isAesgcmUri('aesgcm://u.example.org/f#abc')).toBe(true)
    })
    it('rejects https', () => {
      expect(isAesgcmUri('https://example.org/f')).toBe(false)
    })
    it('rejects plain text', () => {
      expect(isAesgcmUri('look at this aesgcm://... something')).toBe(false)
    })
  })
})
