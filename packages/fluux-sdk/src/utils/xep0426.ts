/**
 * XEP-0426: Character counting in message bodies.
 *
 * Offsets carried on the wire are counted in Unicode code points: "When counting
 * characters in a body, they shall be counted by their number of Unicode code
 * points." This governs every offset-bearing extension the SDK speaks, notably
 * XEP-0372 references (`begin`/`end`) and XEP-0428 fallback ranges
 * (`start`/`end`, via XEP-0428 §4).
 *
 * JavaScript string indices are UTF-16 code units, so the two counts diverge by
 * one for every character outside the BMP — emoji, many CJK extension blocks,
 * mathematical alphanumerics. A body containing a single emoji before an offset
 * is enough to misplace it.
 *
 * In-memory offsets stay UTF-16. They index JS strings directly, and a
 * textarea's `selectionStart`/`selectionEnd` are UTF-16 by definition, so
 * converting the whole codebase to code points would push the conversion into
 * every renderer and composer instead of removing it. Convert at the stanza
 * boundary only: {@link toCodePointOffset} when writing an attribute,
 * {@link fromCodePointOffset} when reading one.
 */

/** True when `code` is a UTF-16 code unit that starts a surrogate pair. */
function isSupplementary(code: number | undefined): boolean {
  return code !== undefined && code > 0xffff
}

/**
 * Number of Unicode code points in `text`, per XEP-0426 §3.
 *
 * This is the value a conforming peer uses as the end-of-body offset, and the
 * bound an inbound offset must be validated against.
 */
export function codePointLength(text: string): number {
  let count = 0
  for (let i = 0; i < text.length; count++) {
    i += isSupplementary(text.codePointAt(i)) ? 2 : 1
  }
  return count
}

/**
 * Convert a UTF-16 string index into the code-point offset to put on the wire.
 *
 * `utf16Index` is clamped to `[0, text.length]`. An index that falls between the
 * two halves of a surrogate pair rounds up to the end of that pair, since a
 * code-point offset cannot address the inside of a character.
 */
export function toCodePointOffset(text: string, utf16Index: number): number {
  const limit = Math.max(0, Math.min(utf16Index, text.length))
  let count = 0
  for (let i = 0; i < limit; count++) {
    i += isSupplementary(text.codePointAt(i)) ? 2 : 1
  }
  return count
}

/**
 * Convert a code-point offset read off the wire into a UTF-16 string index.
 *
 * An offset past the end of `text` clamps to `text.length`; callers that must
 * reject an out-of-range offset should compare it against
 * {@link codePointLength} first rather than relying on the clamp.
 */
export function fromCodePointOffset(text: string, codePointOffset: number): number {
  if (codePointOffset <= 0) return 0
  let count = 0
  for (let i = 0; i < text.length; count++) {
    if (count === codePointOffset) return i
    i += isSupplementary(text.codePointAt(i)) ? 2 : 1
  }
  return text.length
}
