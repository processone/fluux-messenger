import { describe, it, expect } from 'vitest'
import {
  MIN_ACCEPTABLE_ENTROPY_BITS,
  SUPPORTED_LANGUAGES,
  estimatePassphraseEntropyBits,
  generateBackupPassphrase,
  isPassphraseAcceptable,
  resolvePassphraseLanguage,
} from './passphraseGenerator'
import { WORDLIST as EN_WORDLIST } from './passphraseWordlists/bip39-en'
import { WORDLIST as FR_WORDLIST } from './passphraseWordlists/bip39-fr'
import { WORDLIST as ZH_CN_WORDLIST } from './passphraseWordlists/bip39-zh-CN'

describe('SUPPORTED_LANGUAGES', () => {
  it('lists exactly the languages for which we ship a wordlist chunk', () => {
    // Guard against drift: if someone adds/removes a wordlist file
    // without updating the exported constant, the UI's language
    // selector and the loader would disagree. Pin the list here.
    expect(SUPPORTED_LANGUAGES).toEqual(['en', 'fr', 'es', 'it', 'pt', 'cs', 'zh-CN'])
  })
})

describe('resolvePassphraseLanguage', () => {
  it('returns the input unchanged for an exact match', () => {
    expect(resolvePassphraseLanguage('en')).toBe('en')
    expect(resolvePassphraseLanguage('fr')).toBe('fr')
    expect(resolvePassphraseLanguage('zh-CN')).toBe('zh-CN')
  })

  it('falls back to the primary subtag when the region is not supported', () => {
    // 'fr-CA' has no dedicated BIP-39 list; the French list is the
    // right choice rather than silently switching to English.
    expect(resolvePassphraseLanguage('fr-CA')).toBe('fr')
    expect(resolvePassphraseLanguage('pt-BR')).toBe('pt')
    expect(resolvePassphraseLanguage('es-MX')).toBe('es')
  })

  it('falls back to English for unknown locales', () => {
    expect(resolvePassphraseLanguage('de')).toBe('en')
    expect(resolvePassphraseLanguage('ja')).toBe('en')
    expect(resolvePassphraseLanguage('xx-YY')).toBe('en')
  })

  it('defaults to English when no locale is provided', () => {
    expect(resolvePassphraseLanguage()).toBe('en')
    expect(resolvePassphraseLanguage(undefined)).toBe('en')
    expect(resolvePassphraseLanguage('')).toBe('en')
  })

  it('handles mixed case primary subtags', () => {
    // i18next sometimes surfaces locales like 'EN-us' depending on
    // upstream negotiation. The resolver should be case-insensitive
    // on the primary subtag.
    expect(resolvePassphraseLanguage('FR')).toBe('fr')
    expect(resolvePassphraseLanguage('FR-ca')).toBe('fr')
  })
})

describe('generateBackupPassphrase', () => {
  it('defaults to 8 words when wordCount is omitted', async () => {
    // 8 × 11 bits = 88 bits — the documented default and the gate
    // threshold. A regression that silently moved the default would
    // weaken every new backup until someone noticed in review.
    const passphrase = await generateBackupPassphrase()
    expect(passphrase.split(' ')).toHaveLength(8)
  })

  it('produces exactly `wordCount` space-separated words', async () => {
    for (const n of [4, 6, 8, 10, 12]) {
      const passphrase = await generateBackupPassphrase(n)
      expect(passphrase.split(' ')).toHaveLength(n)
    }
  })

  it('every word is drawn from the BIP-39 English list by default', async () => {
    // Random-bag sanity: the generator must not inject characters of
    // its own, mutate case, or stumble into an index out of range.
    const allowed = new Set(EN_WORDLIST)
    for (let i = 0; i < 30; i++) {
      const words = (await generateBackupPassphrase(8)).split(' ')
      for (const w of words) {
        expect(allowed.has(w)).toBe(true)
      }
    }
  })

  it('uses the French wordlist when the French locale is requested', async () => {
    // BIP-39 French and English share ~100 cognates ("acide",
    // "radio", etc.), so we can't test by overlap. Instead, draw
    // many passphrases and assert at least one word appears that is
    // French-only — catches a regression that silently fell through
    // to English for a supported locale.
    const enAllowed = new Set(EN_WORDLIST)
    const frOnly = FR_WORDLIST.filter((w) => !enAllowed.has(w))
    const frOnlySet = new Set(frOnly)
    const frAllowed = new Set(FR_WORDLIST)

    const seen = new Set<string>()
    for (let i = 0; i < 40; i++) {
      const words = (await generateBackupPassphrase(8, 'fr')).split(' ')
      for (const w of words) {
        expect(frAllowed.has(w)).toBe(true)
        seen.add(w)
      }
    }
    // 40 × 8 = 320 draws from 2048; ~1948 candidates are French-only,
    // so the probability of zero French-only hits is ≈ (100/2048)^320
    // which is astronomically small. A single hit is sufficient proof.
    const hitFrenchOnly = [...seen].some((w) => frOnlySet.has(w))
    expect(hitFrenchOnly).toBe(true)
  })

  it('uses the Chinese Simplified list for zh-CN', async () => {
    // Different-script check — protects against a regression where
    // the loader silently falls through to English for any locale
    // whose code contains a region subtag.
    const allowed = new Set(ZH_CN_WORDLIST)
    const words = (await generateBackupPassphrase(8, 'zh-CN')).split(' ')
    for (const w of words) {
      expect(allowed.has(w)).toBe(true)
    }
  })

  it('falls back to English for unsupported locales without throwing', async () => {
    // German is not in the BIP-39 official set; the resolver should
    // route 'de' to English rather than surfacing an error to the UI.
    const allowed = new Set(EN_WORDLIST)
    const words = (await generateBackupPassphrase(8, 'de')).split(' ')
    for (const w of words) {
      expect(allowed.has(w)).toBe(true)
    }
  })

  it('covers the full 2048-word index space over enough draws (no off-by-one)', async () => {
    // With 11-bit uniform indexing, a 2048-word list should be
    // almost fully covered after enough draws. 100 × 12 = 1200
    // words; expected coverage is only ~45% per the coupon
    // collector approximation, so we don't demand full coverage —
    // we only assert the distribution reaches into the upper-index
    // region, guarding against a regression that masked too few
    // bits (e.g. using `& 0xff` would cap indices at 255).
    const seen = new Set<string>()
    for (let i = 0; i < 100; i++) {
      const words = (await generateBackupPassphrase(12)).split(' ')
      for (const w of words) seen.add(w)
    }
    // If indexing were truncated to 8 bits we would see at most 256
    // unique words; demand well more than that.
    expect(seen.size).toBeGreaterThan(500)

    // At least one draw must land in the upper half of the list —
    // catches a bug where the high bit is masked off.
    const upperHalf = EN_WORDLIST.slice(1024)
    const upperSet = new Set(upperHalf)
    const hitUpperHalf = [...seen].some((w) => upperSet.has(w))
    expect(hitUpperHalf).toBe(true)
  })

  it('rejects absurd wordCount values', async () => {
    await expect(generateBackupPassphrase(3)).rejects.toThrow()
    await expect(generateBackupPassphrase(13)).rejects.toThrow()
    await expect(generateBackupPassphrase(1.5)).rejects.toThrow()
    // Zero / negative / NaN — the same minimum guard catches them.
    await expect(generateBackupPassphrase(0)).rejects.toThrow()
    await expect(generateBackupPassphrase(-1)).rejects.toThrow()
    await expect(generateBackupPassphrase(Number.NaN)).rejects.toThrow()
  })

  it('produces varied output across calls (not a fixed seed)', async () => {
    // Catches a regression where someone accidentally replaces the
    // CSPRNG with a deterministic stub and never notices because the
    // tests don't compare outputs across calls.
    const samples = new Set<string>()
    for (let i = 0; i < 20; i++) {
      samples.add(await generateBackupPassphrase(8))
    }
    // 20 draws from a 2048^8 space collide with probability ≈ 0, so
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
  it('MIN_ACCEPTABLE_ENTROPY_BITS matches the generator default', () => {
    // Invariant: "use your own" must not produce a weaker backup
    // than "generate one". 8 words × 11 bits = 88 bits.
    expect(MIN_ACCEPTABLE_ENTROPY_BITS).toBe(88)
  })

  it('rejects obvious weak inputs', () => {
    expect(isPassphraseAcceptable('password')).toBe(false)
    expect(isPassphraseAcceptable('12345678')).toBe(false)
    expect(isPassphraseAcceptable('')).toBe(false)
  })

  it('rejects a merely-long lowercase passphrase', () => {
    // The character-class estimator is pessimistic about natural
    // English — "correct horse battery staple" scores ~127 on
    // lowercase-only math which clears 88, but a single 14-char
    // lowercase run should not.
    expect(isPassphraseAcceptable('aaaaaaaaaaaaaa')).toBe(false)
  })

  it('accepts a passphrase with mixed classes above the threshold', () => {
    // 14 × log2(94) ≈ 91.7 bits with all four character classes.
    expect(isPassphraseAcceptable('Aaaaaaaaaaaa1!')).toBe(true)
  })
})
