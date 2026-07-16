/**
 * Backup-passphrase generator for the XEP-0373 §5 secret-key flow.
 *
 * Two formats are supported, controlled by {@link USE_V6_KEYS}:
 *
 * - **v4 (default)**: XEP-0373 §5.4 backup code — 24 upper-case chars
 *   from "123456789ABCDEFGHIJKLMNPQRSTUVWXYZ" (no O or 0), grouped
 *   into 4-char chunks with dashes. ~121 bits of entropy. Interoperates
 *   with Gajim and other current XEP-0373 implementations.
 *
 * - **v6**: BIP-39 word passphrase — 8 words from a per-language
 *   2048-word list (88 bits), combined with Argon2id at the SKESK
 *   layer for memory-hard key derivation.
 */

/**
 * Match the Rust-side `USE_V6_KEYS` in openpgp.rs. Controls key
 * version, backup code format, and SKESK encryption mode.
 */
export const USE_V6_KEYS = false

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

// ---------------------------------------------------------------------------
// XEP-0373 §5.4 backup code generator
// ---------------------------------------------------------------------------

const BACKUP_CODE_ALPHABET = '123456789ABCDEFGHIJKLMNPQRSTUVWXYZ'
const BACKUP_CODE_CHAR_COUNT = 24
const BACKUP_CODE_CHUNK_SIZE = 4

/**
 * Generate a backup code per XEP-0373 §5.4:
 *
 *   24 upper-case characters from "123456789ABCDEFGHIJKLMNPQRSTUVWXYZ"
 *   (no O or 0) grouped into 4-character chunks with dashes.
 *   Example: TWNK-KD5Y-MT3T-E1GS-DRDB-KVTW
 *
 * The 33-character alphabet yields ~5.04 bits per character × 24 = ~121
 * bits of entropy. The full 29-character string (including dashes) is
 * used as the SKESK passphrase per the spec.
 */
export function generateBackupCode(): string {
  const alphabetLen = BACKUP_CODE_ALPHABET.length // 33
  const bytes = getRandomBytes(BACKUP_CODE_CHAR_COUNT)
  const chars: string[] = []
  for (let i = 0; i < BACKUP_CODE_CHAR_COUNT; i++) {
    // Rejection sampling: draw from [0, 255] and reject values that
    // would bias the distribution. 255 / 33 ≈ 7.7, so values ≥ 231
    // (33 * 7 = 231) must be redrawn to keep uniform distribution.
    let value = bytes[i]
    const limit = 256 - (256 % alphabetLen) // 231
    while (value >= limit) {
      value = getRandomBytes(1)[0]
    }
    chars.push(BACKUP_CODE_ALPHABET[value % alphabetLen])
  }
  const chunks: string[] = []
  for (let i = 0; i < chars.length; i += BACKUP_CODE_CHUNK_SIZE) {
    chunks.push(chars.slice(i, i + BACKUP_CODE_CHUNK_SIZE).join(''))
  }
  return chunks.join('-')
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
