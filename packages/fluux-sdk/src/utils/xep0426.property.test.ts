/**
 * Property tests for XEP-0426 character counting.
 *
 * The oracle is `Array.from(text)`, which iterates a string by code point and is
 * therefore an independent model of what the XEP mandates — independent of the
 * UTF-16 arithmetic under test. Example-based tests miss this class of bug
 * because a hand-written case is almost always BMP-only, where the two counts
 * coincide.
 */
import { describe, it, expect } from 'vitest'
import fc from 'fast-check'
import { codePointLength, toCodePointOffset, fromCodePointOffset } from './xep0426'

/** Strings that actually contain supplementary-plane characters. */
const anyText = fc.string({ unit: 'grapheme', maxLength: 40 })
/** Arbitrary UTF-16, including lone surrogates, for totality checks. */
const anyUtf16 = fc.string({ unit: 'binary', maxLength: 40 })

describe('XEP-0426 offsets (properties)', () => {
  it('counts code points the way Array.from does', () => {
    fc.assert(
      fc.property(anyUtf16, (text) => {
        expect(codePointLength(text)).toBe(Array.from(text).length)
      }),
    )
  })

  it('round-trips every code-point offset through UTF-16 and back', () => {
    fc.assert(
      fc.property(anyText, fc.nat(), (text, raw) => {
        const offset = raw % (codePointLength(text) + 1)
        expect(toCodePointOffset(text, fromCodePointOffset(text, offset))).toBe(offset)
      }),
    )
  })

  it('slices identically to the code-point model', () => {
    // The property the wire format actually depends on: a peer that counted in
    // code points and we who slice in UTF-16 must select the same characters.
    fc.assert(
      fc.property(anyText, fc.nat(), fc.nat(), (text, a, b) => {
        const total = codePointLength(text)
        const start = a % (total + 1)
        const end = start + (b % (total - start + 1))

        const sliced = text.slice(fromCodePointOffset(text, start), fromCodePointOffset(text, end))
        const model = Array.from(text).slice(start, end).join('')
        expect(sliced).toBe(model)
      }),
    )
  })

  it('maps the end of the string to the total code-point count', () => {
    fc.assert(
      fc.property(anyText, (text) => {
        expect(toCodePointOffset(text, text.length)).toBe(codePointLength(text))
        expect(fromCodePointOffset(text, codePointLength(text))).toBe(text.length)
      }),
    )
  })

  it('is monotonic in both directions', () => {
    fc.assert(
      fc.property(anyText, fc.nat(), fc.nat(), (text, a, b) => {
        const lo = Math.min(a, b)
        const hi = Math.max(a, b)
        expect(fromCodePointOffset(text, lo)).toBeLessThanOrEqual(fromCodePointOffset(text, hi))
        expect(toCodePointOffset(text, lo)).toBeLessThanOrEqual(toCodePointOffset(text, hi))
      }),
    )
  })

  it('stays in bounds for hostile offsets', () => {
    const hostile = fc.oneof(
      fc.integer({ min: -1000, max: 1000 }),
      fc.constantFrom(NaN, Infinity, -Infinity, 0.5, -0),
    )
    fc.assert(
      fc.property(anyUtf16, hostile, (text, offset) => {
        const utf16 = fromCodePointOffset(text, offset)
        expect(utf16).toBeGreaterThanOrEqual(0)
        expect(utf16).toBeLessThanOrEqual(text.length)

        const cp = toCodePointOffset(text, offset)
        expect(cp).toBeGreaterThanOrEqual(0)
        expect(cp).toBeLessThanOrEqual(codePointLength(text))
      }),
    )
  })

  it('never splits a surrogate pair', () => {
    fc.assert(
      fc.property(anyText, fc.nat(), (text, raw) => {
        const index = fromCodePointOffset(text, raw % (codePointLength(text) + 1))
        if (index > 0 && index < text.length) {
          // A high surrogate at index-1 paired with a low surrogate at index
          // would mean the boundary landed inside a character.
          const before = text.charCodeAt(index - 1)
          const after = text.charCodeAt(index)
          const splits = before >= 0xd800 && before <= 0xdbff && after >= 0xdc00 && after <= 0xdfff
          expect(splits).toBe(false)
        }
      }),
    )
  })
})
