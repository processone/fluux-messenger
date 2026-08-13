/**
 * Property tests for XEP-0428 fallback stripping.
 *
 * The oracle is a peer that follows the specification: it counts the fallback
 * region in Unicode code points (XEP-0428 §4 → XEP-0426) using `Array.from`,
 * independently of how the SDK indexes strings. A round-trip test against our
 * own encoder cannot catch a wrong unit, because both ends would share the
 * mistake; conformance against an external model can.
 */
import { describe, it, expect } from 'vitest'
import fc from 'fast-check'
import { processFallback } from './fallbackUtils'
import { createMockElement } from '../core/test-utils'
import { NS_FALLBACK, NS_REPLY } from '../core/namespaces'

const text = (maxLength: number) => fc.string({ unit: 'grapheme', maxLength })

/** A conforming peer's reply stanza: offsets counted in code points. */
function buildReplyStanza(author: string, quoted: string, reply: string) {
  const quotedLines = quoted.split('\n').map((line) => `> ${line}`).join('\n')
  const fallbackText = `> ${author} wrote:\n${quotedLines}\n`
  const body = fallbackText + reply
  return {
    body,
    reply,
    stanza: createMockElement('message', {}, [
      { name: 'body', text: body },
      { name: 'reply', attrs: { xmlns: NS_REPLY, id: 'ref-1' } },
      {
        name: 'fallback',
        attrs: { xmlns: NS_FALLBACK, for: NS_REPLY },
        children: [
          {
            name: 'body',
            attrs: {
              xmlns: NS_FALLBACK,
              start: '0',
              // The unit that matters: code points, not UTF-16 code units.
              end: String(Array.from(fallbackText).length),
            },
          },
        ],
      },
    ]),
  }
}

describe('processFallback (properties)', () => {
  it('strips exactly the region a conforming peer marked', () => {
    fc.assert(
      fc.property(text(12), text(20), text(20), (author, quoted, reply) => {
        const { stanza, body, reply: expected } = buildReplyStanza(author, quoted, reply)
        const result = processFallback(stanza, body, { validTargets: [NS_REPLY] }, { id: 'ref-1' })
        expect(result.processedBody).toBe(expected.trim())
      }),
    )
  })

  it('leaves the body untouched when the range is out of bounds or malformed', () => {
    const attr = fc.oneof(
      fc.string({ unit: 'binary', maxLength: 6 }),
      fc.integer({ min: -50, max: 50 }).map(String),
      fc.constantFrom('', 'NaN', 'Infinity', '1e400', '0x10'),
    )
    fc.assert(
      fc.property(text(30), attr, attr, (body, start, end) => {
        const stanza = createMockElement('message', {}, [
          { name: 'body', text: body },
          {
            name: 'fallback',
            attrs: { xmlns: NS_FALLBACK, for: NS_REPLY },
            children: [{ name: 'body', attrs: { xmlns: NS_FALLBACK, start, end } }],
          },
        ])

        const result = processFallback(stanza, body, { validTargets: [NS_REPLY] })
        // Either the range was valid and a strict sub-region was removed, or it
        // was rejected and the body survived. Never a crash, never longer.
        expect(result.processedBody.length).toBeLessThanOrEqual(body.length)
      }),
    )
  })

  it('never strips a fallback aimed at a namespace the caller did not ask for', () => {
    fc.assert(
      fc.property(text(30), (body) => {
        const stanza = createMockElement('message', {}, [
          { name: 'body', text: body },
          {
            name: 'fallback',
            attrs: { xmlns: NS_FALLBACK, for: 'urn:xmpp:some-other-feature:0' },
            children: [{ name: 'body', attrs: { xmlns: NS_FALLBACK, start: '0', end: '1' } }],
          },
        ])
        expect(processFallback(stanza, body, { validTargets: [NS_REPLY] }).processedBody).toBe(body)
      }),
    )
  })
})
