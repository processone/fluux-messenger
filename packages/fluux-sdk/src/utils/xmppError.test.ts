import { describe, it, expect } from 'vitest'
import { createMockElement, parseElement } from '../core/test-utils'
// xmpp.js ships no types for this internal module; it is the class iqCaller rejects with.
// @ts-expect-error TS7016
import StanzaError from '@xmpp/middleware/lib/StanzaError.js'
// @ts-expect-error TS7016
import StreamError from '@xmpp/connection/lib/StreamError.js'
// @ts-expect-error TS7016
import SASLError from '@xmpp/sasl/lib/SASLError.js'
import { parseXMPPError, formatXMPPError, normalizeXmppError, type XMPPStanzaError } from './xmppError'

describe('parseXMPPError', () => {
  it('should parse a standard error element with type, condition, and text', () => {
    const errorEl = createMockElement('error', { type: 'auth' }, [
      { name: 'forbidden', attrs: { xmlns: 'urn:ietf:params:xml:ns:xmpp-stanzas' } },
      { name: 'text', attrs: { xmlns: 'urn:ietf:params:xml:ns:xmpp-stanzas' }, text: 'Not allowed to invite' },
    ])

    const result = parseXMPPError(errorEl)

    expect(result).toEqual({
      type: 'auth',
      condition: 'forbidden',
      text: 'Not allowed to invite',
    })
  })

  it('should parse error with condition only (no text)', () => {
    const errorEl = createMockElement('error', { type: 'cancel' }, [
      { name: 'not-allowed', attrs: { xmlns: 'urn:ietf:params:xml:ns:xmpp-stanzas' } },
    ])

    const result = parseXMPPError(errorEl)

    expect(result).toEqual({
      type: 'cancel',
      condition: 'not-allowed',
      text: undefined,
    })
  })

  it('should handle all RFC 6120 error types', () => {
    for (const type of ['cancel', 'continue', 'modify', 'auth', 'wait']) {
      const errorEl = createMockElement('error', { type }, [
        { name: 'bad-request', attrs: { xmlns: 'urn:ietf:params:xml:ns:xmpp-stanzas' } },
      ])
      const result = parseXMPPError(errorEl)
      expect(result?.type).toBe(type)
    }
  })

  it('should default to cancel for unknown error type', () => {
    const errorEl = createMockElement('error', { type: 'invalid-type' }, [
      { name: 'forbidden', attrs: { xmlns: 'urn:ietf:params:xml:ns:xmpp-stanzas' } },
    ])

    const result = parseXMPPError(errorEl)
    expect(result?.type).toBe('cancel')
  })

  it('should default to cancel when type attribute is missing', () => {
    const errorEl = createMockElement('error', {}, [
      { name: 'forbidden', attrs: { xmlns: 'urn:ietf:params:xml:ns:xmpp-stanzas' } },
    ])

    const result = parseXMPPError(errorEl)
    expect(result?.type).toBe('cancel')
  })

  it('should use undefined-condition when no condition element found', () => {
    const errorEl = createMockElement('error', { type: 'cancel' }, [])

    const result = parseXMPPError(errorEl)
    expect(result?.condition).toBe('undefined-condition')
  })

  it('should ignore non-stanza-namespace children when finding condition', () => {
    const errorEl = createMockElement('error', { type: 'cancel' }, [
      { name: 'custom-error', attrs: { xmlns: 'urn:example:custom' } },
      { name: 'item-not-found', attrs: { xmlns: 'urn:ietf:params:xml:ns:xmpp-stanzas' } },
    ])

    const result = parseXMPPError(errorEl)
    expect(result?.condition).toBe('item-not-found')
  })

  it('should extract error from parent stanza when passed a non-error element', () => {
    const stanza = createMockElement('message', { type: 'error', from: 'room@example.com' }, [
      { name: 'body', text: 'Hello' },
      {
        name: 'error',
        attrs: { type: 'auth' },
        children: [
          { name: 'forbidden', attrs: { xmlns: 'urn:ietf:params:xml:ns:xmpp-stanzas' } },
        ],
      },
    ])

    const result = parseXMPPError(stanza)
    expect(result).toEqual({
      type: 'auth',
      condition: 'forbidden',
      text: undefined,
    })
  })

  it('should return null for undefined input', () => {
    expect(parseXMPPError(undefined)).toBeNull()
  })

  it('should return null for null input', () => {
    expect(parseXMPPError(null)).toBeNull()
  })

  it('should return null when stanza has no error child', () => {
    const stanza = createMockElement('message', { from: 'user@example.com' }, [
      { name: 'body', text: 'Hello' },
    ])

    expect(parseXMPPError(stanza)).toBeNull()
  })

  it('should parse common XMPP error conditions', () => {
    const conditions = [
      'bad-request', 'conflict', 'feature-not-implemented', 'forbidden',
      'gone', 'internal-server-error', 'item-not-found', 'jid-malformed',
      'not-acceptable', 'not-allowed', 'not-authorized', 'policy-violation',
      'recipient-unavailable', 'redirect', 'registration-required',
      'remote-server-not-found', 'remote-server-timeout',
      'resource-constraint', 'service-unavailable', 'subscription-required',
      'unexpected-request',
    ]

    for (const condition of conditions) {
      const errorEl = createMockElement('error', { type: 'cancel' }, [
        { name: condition, attrs: { xmlns: 'urn:ietf:params:xml:ns:xmpp-stanzas' } },
      ])
      const result = parseXMPPError(errorEl)
      expect(result?.condition).toBe(condition)
    }
  })

  it('should parse error with application-specific condition alongside standard condition', () => {
    const errorEl = createMockElement('error', { type: 'cancel' }, [
      { name: 'forbidden', attrs: { xmlns: 'urn:ietf:params:xml:ns:xmpp-stanzas' } },
      { name: 'app-error', attrs: { xmlns: 'urn:example:app' } },
    ])

    const result = parseXMPPError(errorEl)
    // Should pick the standard condition, not the app-specific one
    expect(result?.condition).toBe('forbidden')
  })

  it('should return undefined text when text element is empty', () => {
    const errorEl = createMockElement('error', { type: 'cancel' }, [
      { name: 'forbidden', attrs: { xmlns: 'urn:ietf:params:xml:ns:xmpp-stanzas' } },
      { name: 'text', attrs: { xmlns: 'urn:ietf:params:xml:ns:xmpp-stanzas' }, text: '' },
    ])

    const result = parseXMPPError(errorEl)
    expect(result?.text).toBeUndefined()
    expect(result?.condition).toBe('forbidden')
  })

  it('should pick the first standard condition when multiple exist', () => {
    const errorEl = createMockElement('error', { type: 'cancel' }, [
      { name: 'not-allowed', attrs: { xmlns: 'urn:ietf:params:xml:ns:xmpp-stanzas' } },
      { name: 'forbidden', attrs: { xmlns: 'urn:ietf:params:xml:ns:xmpp-stanzas' } },
    ])

    const result = parseXMPPError(errorEl)
    expect(result?.condition).toBe('not-allowed')
  })

  it('should extract error from presence stanza', () => {
    const stanza = createMockElement('presence', { type: 'error', from: 'room@conf.example.com' }, [
      {
        name: 'error',
        attrs: { type: 'cancel' },
        children: [
          { name: 'not-allowed', attrs: { xmlns: 'urn:ietf:params:xml:ns:xmpp-stanzas' } },
          { name: 'text', attrs: { xmlns: 'urn:ietf:params:xml:ns:xmpp-stanzas' }, text: 'Registration required' },
        ],
      },
    ])

    const result = parseXMPPError(stanza)
    expect(result).toEqual({
      type: 'cancel',
      condition: 'not-allowed',
      text: 'Registration required',
    })
  })
})

describe('formatXMPPError', () => {
  it('should return text when available', () => {
    const error: XMPPStanzaError = {
      type: 'auth',
      condition: 'forbidden',
      text: 'You are not allowed to invite users',
    }
    expect(formatXMPPError(error)).toBe('You are not allowed to invite users')
  })

  it('should format condition as sentence case when no text', () => {
    const error: XMPPStanzaError = {
      type: 'cancel',
      condition: 'not-allowed',
    }
    expect(formatXMPPError(error)).toBe('Not allowed')
  })

  it('should capitalize single-word conditions', () => {
    const error: XMPPStanzaError = {
      type: 'auth',
      condition: 'forbidden',
    }
    expect(formatXMPPError(error)).toBe('Forbidden')
  })

  it('should handle multi-word conditions', () => {
    const error: XMPPStanzaError = {
      type: 'cancel',
      condition: 'remote-server-not-found',
    }
    expect(formatXMPPError(error)).toBe('Remote server not found')
  })

  it('should handle undefined-condition', () => {
    const error: XMPPStanzaError = {
      type: 'cancel',
      condition: 'undefined-condition',
    }
    expect(formatXMPPError(error)).toBe('Undefined condition')
  })
})

// Issue #1808: ejabberd 26.09 (xmpp 1.13.5) sends <text/> before the condition,
// and xmpp.js 0.14 reads the first child as the condition.
// Literal error child of ejabberd 26.09's reply to a PEP items request on a missing node.
const textFirst = () => parseElement(
  '<error type="cancel" code="404">'
  + '<text xmlns="urn:ietf:params:xml:ns:xmpp-stanzas" xml:lang="en">Node not found</text>'
  + '<item-not-found xmlns="urn:ietf:params:xml:ns:xmpp-stanzas"/></error>')
const conditionFirst = () => parseElement(
  '<error type="cancel" code="404">'
  + '<item-not-found xmlns="urn:ietf:params:xml:ns:xmpp-stanzas"/>'
  + '<text xmlns="urn:ietf:params:xml:ns:xmpp-stanzas" xml:lang="en">Node not found</text></error>')

describe('normalizeXmppError', () => {
  it('xmpp.js alone misreads the 26.09 reply as condition "text"', () => {
    expect(StanzaError.fromElement(textFirst()).condition).toBe('text')
  })

  it('recovers the item-not-found condition from the 26.09 reply', () => {
    const err = normalizeXmppError(StanzaError.fromElement(textFirst()))
    expect(err.condition).toBe('item-not-found')
    expect(err.message).toBe('item-not-found - Node not found')
    expect(err.text).toBe('Node not found')
  })

  it('gives the same result for either child order', () => {
    const a = normalizeXmppError(StanzaError.fromElement(textFirst()))
    const b = normalizeXmppError(StanzaError.fromElement(conditionFirst()))
    expect([a.condition, a.message, a.text]).toEqual([b.condition, b.message, b.text])
  })

  it('recovers the condition of a stream error with <text/> first', () => {
    const el = parseElement(
      '<error xmlns="http://etherx.jabber.org/streams">'
      + '<text xmlns="urn:ietf:params:xml:ns:xmpp-streams">Replaced</text>'
      + '<conflict xmlns="urn:ietf:params:xml:ns:xmpp-streams"/></error>')
    expect(StreamError.fromElement(el).condition).toBe('text')
    expect(normalizeXmppError(StreamError.fromElement(el)).message).toBe('conflict - Replaced')
  })

  it('recovers the condition of a SASL failure with <text/> first', () => {
    const el = parseElement(
      '<failure xmlns="urn:ietf:params:xml:ns:xmpp-sasl">'
      + '<text xml:lang="en">Invalid username or password</text><not-authorized/></failure>')
    expect(SASLError.fromElement(el).condition).toBe('text')
    expect(normalizeXmppError(SASLError.fromElement(el)).condition).toBe('not-authorized')
  })

  it('keeps an application-specific child out of the condition', () => {
    const el = parseElement(
      '<error type="wait"><text xmlns="urn:ietf:params:xml:ns:xmpp-stanzas">slow</text>'
      + '<resource-constraint xmlns="urn:ietf:params:xml:ns:xmpp-stanzas"/>'
      + '<too-many xmlns="urn:example:app"/></error>')
    expect(normalizeXmppError(StanzaError.fromElement(el)).condition).toBe('resource-constraint')
  })

  it('ignores errors that carry no xmpp.js element', () => {
    const err = new Error('socket closed')
    expect(normalizeXmppError(err)).toBe(err)
    expect(err.message).toBe('socket closed')
  })
})
