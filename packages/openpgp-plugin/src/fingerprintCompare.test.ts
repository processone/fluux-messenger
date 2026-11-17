import { describe, it, expect } from 'vitest'
import {
  fingerprintsEqual,
  normalizeFingerprint,
  toXep0373Fingerprint,
  pubkeyMetadataFingerprintAttrs,
} from './fingerprintCompare'

describe('fingerprintCompare', () => {
  it('treats UPPERCASE (Sequoia) and lowercase (openpgp.js) of the same key as equal', () => {
    const upper = 'AABBCCDDEEFF00112233445566778899AABBCCDD'
    const lower = 'aabbccddeeff00112233445566778899aabbccdd'
    expect(fingerprintsEqual(upper, lower)).toBe(true)
    expect(fingerprintsEqual(lower, upper)).toBe(true)
  })

  it('ignores whitespace separators', () => {
    expect(fingerprintsEqual('AABB CCDD EEFF', 'aabbccddeeff')).toBe(true)
  })

  it('returns false for genuinely different fingerprints', () => {
    expect(fingerprintsEqual('AABBCCDD', 'AABBCCDE')).toBe(false)
  })

  it('normalizeFingerprint lower-cases and strips whitespace', () => {
    expect(normalizeFingerprint('AA BB\tCC\nDD')).toBe('aabbccdd')
  })

  describe('toXep0373Fingerprint', () => {
    it('upper-cases lowercase (openpgp.js) hex per XEP-0373 §4.1', () => {
      expect(toXep0373Fingerprint('9e0b9bc6f81e0b27cb74dbdb8dce4320ca12b83e')).toBe(
        '9E0B9BC6F81E0B27CB74DBDB8DCE4320CA12B83E',
      )
    })

    it('strips whitespace separators', () => {
      expect(toXep0373Fingerprint('9e0b 9bc6\tf81e\n0b27')).toBe('9E0B9BC6F81E0B27')
    })

    it('is idempotent on already upper-case input (Sequoia)', () => {
      const upper = 'AABBCCDDEEFF00112233445566778899AABBCCDD'
      expect(toXep0373Fingerprint(upper)).toBe(upper)
    })
  })

  describe('pubkeyMetadataFingerprintAttrs', () => {
    // A v4 fingerprint is 40 hex chars (SHA-1); a v6 fingerprint is 64 hex
    // chars (SHA-256). Advertising a 40-hex value under `v6-fingerprint` is a
    // malformed v6 advertisement — emit only the attribute that matches the
    // key version.
    it('advertises a 40-hex (v4) fingerprint as v4-fingerprint only', () => {
      const fp = 'aabbccddeeff00112233445566778899aabbccdd' // 40 hex, lower
      const attrs = pubkeyMetadataFingerprintAttrs(fp)
      expect(attrs['v4-fingerprint']).toBe(fp.toUpperCase())
      expect(attrs['v6-fingerprint']).toBeUndefined()
    })

    it('advertises a 64-hex (v6) fingerprint as v6-fingerprint only', () => {
      const fp = 'a'.repeat(64) // 64 hex, v6
      const attrs = pubkeyMetadataFingerprintAttrs(fp)
      expect(attrs['v6-fingerprint']).toBe('A'.repeat(64))
      expect(attrs['v4-fingerprint']).toBeUndefined()
    })
  })
})
