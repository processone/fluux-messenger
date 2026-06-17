/**
 * Read/write the `Passphrase-Format` ASCII-armor header on a Fluux backup
 * MESSAGE. The header key matches OpenKeychain's verbatim, so a single parser
 * reads both Fluux and OpenKeychain backups; the value tells the importing
 * side which passphrase input mask to show.
 *
 * The header is added only to the *file* export — never to the PEP/server
 * backup, which dearmors to Base64 and would strip it anyway.
 */
import { USE_V6_KEYS } from './passphraseGenerator'

/** Passphrase families Fluux itself generates (see passphraseGenerator). */
export type PassphraseFormat = 'xep0373' | 'bip39'

const HEADER_KEY = 'Passphrase-Format'
const MESSAGE_HEADER = '-----BEGIN PGP MESSAGE-----'

/** The format Fluux generates for backups, fixed by the key-version mode. */
export function currentPassphraseFormat(): PassphraseFormat {
  return USE_V6_KEYS ? 'bip39' : 'xep0373'
}

/**
 * Insert a `Passphrase-Format: <format>` armor header into an armored OpenPGP
 * MESSAGE, immediately after the BEGIN line. Idempotent; a no-op if the input
 * is not a MESSAGE block.
 */
export function withPassphraseFormatHeader(
  armored: string,
  format: PassphraseFormat = currentPassphraseFormat(),
): string {
  if (armored.includes(`${HEADER_KEY}:`)) return armored
  const idx = armored.indexOf(MESSAGE_HEADER)
  if (idx === -1) return armored
  const insertAt = idx + MESSAGE_HEADER.length
  return `${armored.slice(0, insertAt)}\n${HEADER_KEY}: ${format}${armored.slice(insertAt)}`
}

/**
 * Return the `Passphrase-Format` header value, or null when absent. The token
 * (`-`, `:`, space) cannot occur in Base64 body lines, so scanning the whole
 * blob is safe. Tolerates a leading BOM/whitespace.
 */
export function parseArmorPassphraseFormat(armored: string): string | null {
  if (!armored) return null
  const match = armored.match(/^Passphrase-Format:[ \t]*(\S+)[ \t]*$/m)
  return match ? match[1] : null
}
