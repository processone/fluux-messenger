import { describe, it, expect, vi } from 'vitest'
import { createMockElement, parseElement } from '../core/test-utils'
// xmpp.js ships no types for this internal module; it is the class iqCaller rejects with.
// @ts-expect-error TS7016
import StanzaError from '@xmpp/middleware/lib/StanzaError.js'
// @ts-expect-error TS7016
import SASLError from '@xmpp/sasl/lib/SASLError.js'
import type { Element } from '@xmpp/client'
import { parseXMPPError, formatXMPPError, installOrderTolerantErrors, putErrorConditionFirst, type XMPPStanzaError } from './xmppError'

// test-utils mocks '@xmpp/client'; the redirect and FAST paths need the real client.
const { client } = await vi.importActual<typeof import('@xmpp/client')>('@xmpp/client')

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
// Issue #1808: ejabberd 26.09 (xmpp 1.13.5) sends <text/> before the condition,
// and xmpp.js 0.14 reads the first child as the condition. Both child orders
// are valid XMPP, so each case runs with the text before and after it.
const STANZAS = 'urn:ietf:params:xml:ns:xmpp-stanzas'
const orders = (text: string, condition: string): Array<[string, string]> => [
  ['text first (ejabberd 26.09)', text + condition],
  ['condition first (RFC examples)', condition + text],
]

describe('installOrderTolerantErrors', () => {
  // The real xmpp.js client: its own _onElement decides on redirects and errors.
  function connectionSeeing(xmlText: string) {
    const conn = client({ service: 'ws://localhost:1', domain: 'example.com' }) as unknown as {
      _onElement(el: Element): void
      _onSeeOtherHost(error: { condition: string }): void
      on(event: string, handler: (...args: unknown[]) => void): void
    }
    installOrderTolerantErrors(conn)
    const seen = { redirect: undefined as string | undefined, errors: [] as Array<{ condition: string }> }
    conn._onSeeOtherHost = (error) => { seen.redirect = error.condition }
    conn.on('error', (err) => seen.errors.push(err as { condition: string }))
    conn._onElement(parseElement(xmlText))
    return seen
  }

  it.each(orders(
    '<text xmlns="urn:ietf:params:xml:ns:xmpp-streams">Moved</text>',
    '<see-other-host xmlns="urn:ietf:params:xml:ns:xmpp-streams">other.example.com</see-other-host>',
  ))('follows a see-other-host stream error: %s', (_label, children) => {
    const seen = connectionSeeing(`<stream:error xmlns:stream="http://etherx.jabber.org/streams">${children}</stream:error>`)
    expect(seen.redirect).toBe('see-other-host')
    expect(seen.errors).toEqual([])
  })

  it.each(orders(
    '<text xmlns="urn:ietf:params:xml:ns:xmpp-streams">Replaced</text>',
    '<conflict xmlns="urn:ietf:params:xml:ns:xmpp-streams"/>',
  ))('reports a conflict stream error as conflict: %s', (_label, children) => {
    const seen = connectionSeeing(`<stream:error xmlns:stream="http://etherx.jabber.org/streams">${children}</stream:error>`)
    expect(seen.errors.map(e => e.condition)).toEqual(['conflict'])
  })

  it.each(orders('<text xml:lang="en">Invalid token</text>', '<not-authorized/>'))(
    'lets SASLError (read by the FAST and auth paths) see not-authorized: %s',
    (_label, children) => {
      const el = parseElement(`<failure xmlns="urn:ietf:params:xml:ns:xmpp-sasl">${children}</failure>`)
      putErrorConditionFirst(el)
      expect(SASLError.fromElement(el).condition).toBe('not-authorized')
    },
  )

  it.each(orders(
    `<text xmlns="${STANZAS}" xml:lang="en">Node not found</text>`,
    `<item-not-found xmlns="${STANZAS}"/>`,
  ))('lets an IQ error reject as item-not-found with its text: %s', (_label, children) => {
    const iq = parseElement(`<iq type="error" id="1"><error type="cancel" code="404">${children}</error></iq>`)
    putErrorConditionFirst(iq)
    const err = StanzaError.fromElement(iq.getChild('error'))
    expect([err.condition, err.message]).toEqual(['item-not-found', 'item-not-found - Node not found'])
  })

  it.each(orders(
    `<text xmlns="${STANZAS}" xml:lang="en">Node not found</text>`,
    `<item-not-found xmlns="${STANZAS}"/>`,
  ))('rejects a real iqCaller request with item-not-found: %s', async (_label, children) => {
    const conn = client({ service: 'ws://localhost:1', domain: 'example.com' }) as unknown as {
      _onElement(el: Element): void
      send(el: Element): Promise<void>
      iqCaller: { request(el: Element): Promise<unknown> }
    }
    installOrderTolerantErrors(conn)
    conn.send = async () => {}
    const request = conn.iqCaller.request(parseElement('<iq type="get" id="q1"><pubsub xmlns="http://jabber.org/protocol/pubsub"/></iq>'))
    conn._onElement(parseElement(`<iq type="error" id="q1"><error type="cancel" code="404">${children}</error></iq>`))
    await expect(request).rejects.toMatchObject({ condition: 'item-not-found', message: 'item-not-found - Node not found' })
  })

  it('leaves an application-specific child after the condition', () => {
    const iq = parseElement(
      `<iq type="error"><error type="wait"><text xmlns="${STANZAS}">slow</text>`
      + `<resource-constraint xmlns="${STANZAS}"/><too-many xmlns="urn:example:app"/></error></iq>`)
    putErrorConditionFirst(iq)
    const err = StanzaError.fromElement(iq.getChild('error'))
    expect(err.condition).toBe('resource-constraint')
    expect(err.application?.name).toBe('too-many')
  })

  it('does nothing to a non-error element or a client without the entry point', () => {
    const msg = parseElement('<message><body>hi</body></message>')
    putErrorConditionFirst(msg)
    expect(msg.children).toHaveLength(1)
    expect(() => installOrderTolerantErrors({})).not.toThrow()
  })
})
