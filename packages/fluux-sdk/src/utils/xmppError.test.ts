import { describe, it, expect } from 'vitest'
import { createMockElement } from '../core/test-utils'
import { parseXMPPError, formatXMPPError, type XMPPStanzaError } from './xmppError'

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
