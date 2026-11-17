/**
 * Identify what an ASCII-armored OpenPGP blob contains, based on its
 * armor preamble. Used by the import flow to route either to the
 * passphrase-wrapped Fluux backup decoder or to the raw transferable
 * secret key decoder.
 *
 * The check is intentionally lenient: it tolerates a BOM and leading
 * whitespace/blank lines, since text-mode file readers occasionally
 * prepend them. It does NOT parse the body — that's the caller's job.
 */
export type ArmorKind = 'message' | 'private-key' | 'unknown'

const MESSAGE_HEADER = '-----BEGIN PGP MESSAGE-----'
const PRIVATE_KEY_HEADER = '-----BEGIN PGP PRIVATE KEY BLOCK-----'

export function detectArmorKind(armored: string): ArmorKind {
  if (!armored) return 'unknown'
  // trimStart() also strips a leading BOM: U+FEFF (ZWNBSP) is an ECMAScript
  // whitespace code point, so it is removed along with any leading
  // whitespace/blank lines. No separate BOM-strip step is needed.
  const trimmed = armored.trimStart()
  if (trimmed.startsWith(MESSAGE_HEADER)) return 'message'
  if (trimmed.startsWith(PRIVATE_KEY_HEADER)) return 'private-key'
  return 'unknown'
}
