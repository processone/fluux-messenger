import { describe, it, expect } from 'vitest'
import { fingerprintsEqual, normalizeFingerprint } from './fingerprintCompare'

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
})
