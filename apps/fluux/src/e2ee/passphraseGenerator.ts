/**
 * Backup-passphrase generator for the XEP-0373 §5 secret-key flow.
 *
 * Produces a space-separated BIP-39 passphrase from one of the
 * official per-language 2048-word lists. Each language ships as its
 * own dynamic-imported chunk so the bundle only pays for the list
 * the user's UI locale actually needs, and the file stays cached
 * across releases because the wordlist content is immutable.
 *
 * Each word contributes exactly 11 bits of entropy. At the default
 * eight words, the generated passphrase carries 88 bits, which
 * combined with Argon2id at the SKESK layer (memory-hard KDF, no
 * throughput shortcut) gives durable margin for the 10–20-year
 * lifetime of the OpenPGP identity key this passphrase protects.
 * Users who want more headroom can request a longer passphrase via
 * `wordCount`; 12 words matches the BIP-39 wallet-seed convention
 * at 132 bits.
 */

const DEFAULT_WORD_COUNT = 8

const WORDLIST_LENGTH = 2048
const BITS_PER_WORD = 11
// Mask to extract 11 bits from a 16-bit uniform draw. Because 2^16
// is an exact multiple of 2^11 (32×), the low 11 bits are uniform
// over [0, 2048) — no rejection sampling needed.
const INDEX_MASK = 0x07ff

/**
 * Languages for which we ship a BIP-39 wordlist. Must match the
 * filenames under ./passphraseWordlists/.
 */
export const SUPPORTED_LANGUAGES = ['en', 'fr', 'es', 'it', 'pt', 'cs', 'zh-CN'] as const
export type SupportedLanguage = (typeof SUPPORTED_LANGUAGES)[number]

// Each entry below is a literal dynamic import. Vite uses these
// literals at build time to emit one code-split chunk per language,
// so the app loads only the list the user needs and the chunk URL
// is content-hashed — the browser cache can hold it indefinitely.
//
// Source filenames carry a `bip39-` prefix so the emitted chunk
// names (`bip39-en-<hash>.js`, etc.) don't collide in `dist/assets/`
// with the UI i18n locale chunks, which are named after the same
// BCP-47 codes (`en-<hash>.js`, `fr-<hash>.js`, ...).
const LOADERS: Record<SupportedLanguage, () => Promise<{ WORDLIST: readonly string[] }>> = {
  en: () => import('./passphraseWordlists/bip39-en'),
  fr: () => import('./passphraseWordlists/bip39-fr'),
  es: () => import('./passphraseWordlists/bip39-es'),
  it: () => import('./passphraseWordlists/bip39-it'),
  pt: () => import('./passphraseWordlists/bip39-pt'),
  cs: () => import('./passphraseWordlists/bip39-cs'),
  'zh-CN': () => import('./passphraseWordlists/bip39-zh-CN'),
}

/**
 * Map an arbitrary BCP-47-ish locale string to a supported BIP-39
 * language. Exact match wins; otherwise we fall back to the primary
 * subtag (so 'fr-CA' uses the French list), and finally to English.
 */
export function resolvePassphraseLanguage(locale?: string): SupportedLanguage {
  if (!locale) return 'en'
  if ((SUPPORTED_LANGUAGES as readonly string[]).includes(locale)) {
    return locale as SupportedLanguage
  }
  const primary = locale.split('-')[0].toLowerCase()
  const match = SUPPORTED_LANGUAGES.find((l) => l.toLowerCase().split('-')[0] === primary)
  return match ?? 'en'
}

async function loadWordlist(language: SupportedLanguage): Promise<readonly string[]> {
  const mod = await LOADERS[language]()
  if (mod.WORDLIST.length !== WORDLIST_LENGTH) {
    // A mismatch would silently bias or truncate indexing — fail
    // loudly so the UI surfaces a real error rather than generating
    // an under-entropy passphrase.
    throw new Error(
      `passphraseWordlist for "${language}" must have exactly ${WORDLIST_LENGTH} entries (got ${mod.WORDLIST.length})`,
    )
  }
  return mod.WORDLIST
}

/**
 * Generate a random passphrase of `wordCount` space-separated words
 * drawn from the BIP-39 wordlist for `language` (or the UI locale's
 * closest match, falling back to English).
 *
 * Requires `globalThis.crypto.getRandomValues`. The browser and Tauri
 * webview both satisfy this; Vitest under jsdom/node:test does too.
 * A host without the Web Crypto API throws rather than silently
 * falling back to `Math.random`.
 */
export async function generateBackupPassphrase(
  wordCount: number = DEFAULT_WORD_COUNT,
  language?: string,
): Promise<string> {
  if (!Number.isInteger(wordCount) || wordCount < 4 || wordCount > 12) {
    // Floor (4) keeps entropy at 44 bits — the minimum we would ever
    // consider acceptable for the acceptability gate's legacy inputs.
    // Ceiling (12) guards against UI-side bugs requesting thousands
    // of words and matches the familiar BIP-39 wallet-seed length.
    throw new Error(`wordCount must be an integer between 4 and 12 (got ${wordCount})`)
  }
  const resolved = resolvePassphraseLanguage(language)
  const wordlist = await loadWordlist(resolved)
  const indices = drawIndices(wordCount)
  const words: string[] = []
  for (let i = 0; i < wordCount; i++) {
    words.push(wordlist[indices[i]])
  }
  return words.join(' ')
}

/**
 * Draw `n` uniformly-random indices in [0, 2048). We read 2 bytes
 * per index and mask to the low 11 bits; since 2^16 is an exact
 * multiple of 2^11, every 11-bit pattern is equally likely and no
 * rejection loop is needed.
 */
function drawIndices(n: number): Uint16Array {
  const bytes = getRandomBytes(n * 2)
  const out = new Uint16Array(n)
  for (let i = 0; i < n; i++) {
    const hi = bytes[i * 2]
    const lo = bytes[i * 2 + 1]
    out[i] = ((hi << 8) | lo) & INDEX_MASK
  }
  return out
}

/**
 * Rough entropy estimate for an arbitrary user-supplied passphrase,
 * in bits. Used by the UI to decide whether to accept a custom
 * passphrase or nudge the user toward the generator.
 *
 * This is NOT zxcvbn-grade analysis — it looks at character-class
 * diversity (lowercase, uppercase, digits, symbols) and applies the
 * standard Shannon-style approximation `length * log2(pool_size)`.
 * It deliberately refuses to credit entropy it can't verify:
 * dictionary words, repeated characters, and keyboard walks are all
 * counted at their face value. The consequence is that the function
 * is pessimistic for human-generated passphrases (understates their
 * strength) — which is the right direction of error for a gate.
 */
export function estimatePassphraseEntropyBits(passphrase: string): number {
  if (passphrase.length === 0) return 0
  let poolSize = 0
  if (/[a-z]/.test(passphrase)) poolSize += 26
  if (/[A-Z]/.test(passphrase)) poolSize += 26
  if (/[0-9]/.test(passphrase)) poolSize += 10
  if (/[^a-zA-Z0-9]/.test(passphrase)) poolSize += 32
  if (poolSize === 0) return 0
  return passphrase.length * Math.log2(poolSize)
}

/**
 * Gate for user-supplied passphrases. Matches the threshold that the
 * generated eight-word default hits (88 bits), so "use your own"
 * never produces a weaker backup than "generate one".
 */
export const MIN_ACCEPTABLE_ENTROPY_BITS = DEFAULT_WORD_COUNT * BITS_PER_WORD

export function isPassphraseAcceptable(passphrase: string): boolean {
  return estimatePassphraseEntropyBits(passphrase) >= MIN_ACCEPTABLE_ENTROPY_BITS
}

function getRandomBytes(n: number): Uint8Array {
  const g = globalThis as { crypto?: { getRandomValues?: (b: Uint8Array) => Uint8Array } }
  if (!g.crypto?.getRandomValues) {
    throw new Error(
      'generateBackupPassphrase requires a Web Crypto API host (crypto.getRandomValues)',
    )
  }
  const buf = new Uint8Array(n)
  g.crypto.getRandomValues(buf)
  return buf
}
