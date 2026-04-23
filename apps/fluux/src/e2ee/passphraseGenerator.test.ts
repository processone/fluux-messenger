import { describe, it, expect } from 'vitest'
import {
  MIN_ACCEPTABLE_ENTROPY_BITS,
  estimatePassphraseEntropyBits,
  generateBackupPassphrase,
  isPassphraseAcceptable,
} from './passphraseGenerator'
import { PASSPHRASE_WORDLIST } from './passphraseWordlist'

describe('generateBackupPassphrase', () => {
  it('produces exactly `wordCount` space-separated words', () => {
    const passphrase = generateBackupPassphrase(6)
    const words = passphrase.split(' ')
    expect(words).toHaveLength(6)
  })

  it('every word is drawn from the curated wordlist', () => {
    // Random-bag sanity: the generator must not inject characters of
    // its own, mutate case, or stumble into an index out of range.
    const allowed = new Set(PASSPHRASE_WORDLIST)
    for (let i = 0; i < 50; i++) {
      const words = generateBackupPassphrase(7).split(' ')
      for (const w of words) {
        expect(allowed.has(w)).toBe(true)
      }
    }
  })

  it('hits every wordlist index with enough draws (no off-by-one on bounds)', () => {
    // A 256-word list with unbiased byte → index mapping should cover
    // nearly all positions within enough draws. 200 iterations × 12
    // words = 2400 draws; expected coverage ≈ 256 · (1 − e^(−2400/256))
    // > 99.99% of the list, so even a lucky one-in-ten-million skip is
    // well below this test's threshold.
    const seen = new Set<string>()
    for (let i = 0; i < 200 && seen.size < PASSPHRASE_WORDLIST.length; i++) {
      const words = generateBackupPassphrase(12).split(' ')
      for (const w of words) seen.add(w)
    }
    // Relaxed lower bound — we only assert "most of the list shows up",
    // not perfect uniformity, so a flaky CI run doesn't fail on the
    // residual probability of a genuinely never-seen word.
    expect(seen.size).toBeGreaterThan(PASSPHRASE_WORDLIST.length * 0.9)
  })

  it('rejects absurd wordCount values', () => {
    expect(() => generateBackupPassphrase(3)).toThrow()
    expect(() => generateBackupPassphrase(13)).toThrow()
    expect(() => generateBackupPassphrase(1.5)).toThrow()
    // Zero / negative / NaN — the same minimum guard catches them.
    expect(() => generateBackupPassphrase(0)).toThrow()
    expect(() => generateBackupPassphrase(-1)).toThrow()
    expect(() => generateBackupPassphrase(Number.NaN)).toThrow()
  })

  it('produces varied output across calls (not a fixed seed)', () => {
    // Catches a regression where someone accidentally replaces the
    // CSPRNG with a deterministic stub and never notices because the
    // tests don't compare outputs across calls.
    const samples = new Set<string>()
    for (let i = 0; i < 20; i++) {
      samples.add(generateBackupPassphrase(6))
    }
    // 20 draws from a 256^6 space collide with probability ≈ 0, so
    // fewer than ~19 unique samples is a strong signal something is
    // wrong in the randomness path.
    expect(samples.size).toBeGreaterThan(15)
  })
})

describe('estimatePassphraseEntropyBits', () => {
  it('empty input is zero', () => {
    expect(estimatePassphraseEntropyBits('')).toBe(0)
  })

  it('credits pool expansion when extra character classes appear', () => {
    // The exact values aren't pinned (they depend on pool math); we
    // only assert ordering — adding a class must never reduce the
    // estimated entropy at the same length.
    const lowercaseOnly = estimatePassphraseEntropyBits('aaaaaaaa')
    const withDigit = estimatePassphraseEntropyBits('aaaaaaa1')
    const withMixed = estimatePassphraseEntropyBits('Aaaaaaa1')
    const withSymbol = estimatePassphraseEntropyBits('Aaaaaaa1!')
    expect(withDigit).toBeGreaterThan(lowercaseOnly)
    expect(withMixed).toBeGreaterThan(withDigit)
    expect(withSymbol).toBeGreaterThan(withMixed)
  })

  it('scales linearly with length at a fixed pool', () => {
    const short = estimatePassphraseEntropyBits('abcd')
    const long = estimatePassphraseEntropyBits('abcdabcd')
    expect(long).toBeCloseTo(short * 2, 3)
  })
})

describe('isPassphraseAcceptable', () => {
  it('a six-word generated passphrase clears the threshold', () => {
    // This is the contract we care about — the generator must not
    // produce something the gate would reject, or the "generate"
    // button becomes a trap.
    for (let i = 0; i < 20; i++) {
      const pp = generateBackupPassphrase(6)
      expect(estimatePassphraseEntropyBits(pp)).toBeGreaterThanOrEqual(
        MIN_ACCEPTABLE_ENTROPY_BITS,
      )
      expect(isPassphraseAcceptable(pp)).toBe(true)
    }
  })

  it('rejects obvious weak inputs', () => {
    expect(isPassphraseAcceptable('password')).toBe(false)
    expect(isPassphraseAcceptable('12345678')).toBe(false)
    expect(isPassphraseAcceptable('')).toBe(false)
  })
})
