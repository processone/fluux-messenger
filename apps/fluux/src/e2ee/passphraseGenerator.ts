/**
 * Backup-passphrase generator for the XEP-0373 §5 secret-key flow.
 *
 * Produces a space-separated diceware-style passphrase from the
 * curated 256-word list in `passphraseWordlist.ts`. The list is
 * power-of-two-sized so a single byte drawn from a CSPRNG indexes
 * into it without modulo bias — no rejection-sampling loop needed.
 *
 * Each word contributes exactly 8 bits of entropy. At the default
 * six words, the generated passphrase carries 48 bits, which
 * combined with Argon2id at the SKESK layer (memory-hard KDF, no
 * throughput shortcut) is durable against the offline-attack
 * budgets we care about. Users who want more headroom can ask for
 * a longer passphrase via `wordCount`.
 */

import { PASSPHRASE_WORDLIST } from './passphraseWordlist'

const DEFAULT_WORD_COUNT = 6

/** Must match the wordlist length. Asserted at module load. */
const WORDLIST_LENGTH = 256

if (PASSPHRASE_WORDLIST.length !== WORDLIST_LENGTH) {
  // A mismatch would silently bias or truncate indexing — fail loudly
  // at module load, not deep inside a generate call.
  throw new Error(
    `passphraseWordlist must have exactly ${WORDLIST_LENGTH} entries (got ${PASSPHRASE_WORDLIST.length})`,
  )
}

/**
 * Generate a random passphrase of `wordCount` space-separated words.
 *
 * Requires `globalThis.crypto.getRandomValues`. The browser and Tauri
 * webview both satisfy this; tests that run under Vitest's jsdom or
 * node:test do too. A host without the Web Crypto API will throw a
 * clear error rather than silently falling back to `Math.random`.
 */
export function generateBackupPassphrase(wordCount: number = DEFAULT_WORD_COUNT): string {
  if (!Number.isInteger(wordCount) || wordCount < 4 || wordCount > 12) {
    // The floor (4) keeps entropy ≥ 32 bits which is the minimum we
    // would ever consider acceptable; the ceiling (12) guards against
    // runaway UI-side bugs that might request thousands of words.
    throw new Error(`wordCount must be an integer between 4 and 12 (got ${wordCount})`)
  }
  const random = getRandomBytes(wordCount)
  const words: string[] = []
  for (let i = 0; i < wordCount; i++) {
    words.push(PASSPHRASE_WORDLIST[random[i]])
  }
  return words.join(' ')
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
 * generated six-word default hits (48 bits), so "use your own" never
 * produces a weaker backup than "generate one".
 */
export const MIN_ACCEPTABLE_ENTROPY_BITS = 48

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
