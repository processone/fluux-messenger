/**
 * Property tests for the RFC 5122 `xmpp:` URI parser.
 *
 * Two oracles, neither derived from the implementation:
 *  - totality — the documented contract is "returns null if the URI is
 *    invalid", so no input may raise. These URIs arrive inside peer-controlled
 *    message bodies, where a throw becomes a remotely triggered failure.
 *  - round-trip — components encoded per RFC 5122 must parse back unchanged.
 */
import { describe, it, expect } from 'vitest'
import fc from 'fast-check'
import { parseXmppUri } from './xmppUri'

const jidPart = fc
  .string({ unit: fc.constantFrom(...'abcdefghijklmnopqrstuvwxyz0123456789-'), minLength: 1, maxLength: 8 })

const jid = fc.tuple(jidPart, jidPart, jidPart).map(([local, host, tld]) => `${local}@${host}.${tld}`)
const action = fc.constantFrom('message', 'join', 'subscribe', 'roster', 'remove', 'disco')
const params = fc.dictionary(
  // '__proto__' is included deliberately: it is a legal parameter name a peer
  // may send, and plain assignment would drop it.
  fc.oneof(fc.string({ unit: 'grapheme', minLength: 1, maxLength: 8 }), fc.constant('__proto__')),
  fc.string({ unit: 'grapheme', maxLength: 12 }),
  { maxKeys: 4 },
)

describe('parseXmppUri (properties)', () => {
  it('never throws, whatever it is handed', () => {
    fc.assert(
      fc.property(fc.string({ unit: 'binary', maxLength: 60 }), (raw) => {
        expect(() => parseXmppUri(raw)).not.toThrow()
        expect(() => parseXmppUri(`xmpp:${raw}`)).not.toThrow()
      }),
    )
  })

  it('round-trips a well-formed URI', () => {
    fc.assert(
      fc.property(jid, action, params, (address, act, query) => {
        const encoded = Object.entries(query)
          .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
          .join(';')
        const uri = `xmpp:${address}?${act}${encoded ? `;${encoded}` : ''}`

        const parsed = parseXmppUri(uri)
        expect(parsed).not.toBeNull()
        expect(parsed?.jid).toBe(address)
        expect(parsed?.action).toBe(act)
        expect(parsed?.params).toEqual(query)
      }),
    )
  })

  it('rejects rather than throws on a malformed percent-escape', () => {
    const broken = fc.constantFrom('%', '%A', '%ZZ', '%E0%A4%A', '%C0', '%F8%A1')
    fc.assert(
      fc.property(jid, broken, (address, bad) => {
        // In the JID, in the action, and in a parameter value.
        expect(parseXmppUri(`xmpp:${address}${bad}`)).toBeNull()
        expect(parseXmppUri(`xmpp:${address}?${bad}`)).toBeNull()
        expect(parseXmppUri(`xmpp:${address}?message;body=${bad}`)).toBeNull()
      }),
    )
  })
})
