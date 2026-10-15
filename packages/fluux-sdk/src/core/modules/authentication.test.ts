import { describe, expect, it, vi } from 'vitest'
import { xml } from '@xmpp/client'
import { AuthenticationTracker } from './authentication'

describe('authentication evidence', () => {
  it('does not treat an anonymous mechanism as password validation', () => {
    const tracker = new AuthenticationTracker(vi.fn(), vi.fn())
    tracker.sent(xml('auth', { xmlns: 'urn:ietf:params:xml:ns:xmpp-sasl', mechanism: 'ANONYMOUS' }))
    tracker.succeeded()
    expect(tracker.result()).toBeNull()
  })

  it('requires client verification after a server success and forgets earlier evidence', () => {
    const tracker = new AuthenticationTracker(vi.fn(), vi.fn())
    tracker.sent(xml('auth', { xmlns: 'urn:ietf:params:xml:ns:xmpp-sasl', mechanism: 'SCRAM-SHA-1' }))
    tracker.received(xml('success', { xmlns: 'urn:ietf:params:xml:ns:xmpp-sasl' }))
    expect(tracker.result()).toBeNull()
    tracker.succeeded()
    expect(tracker.result()).toEqual({ method: 'password', mechanism: 'SCRAM-SHA-1' })
    tracker.begin()
    expect(tracker.result()).toBeNull()
  })

  it.each(['not-authorized', 'credentials-expired', 'account-disabled', 'invalid-authzid',
    'invalid-mechanism', 'mechanism-too-weak', 'temporary-auth-failure',
    'malformed-request', 'incorrect-encoding', 'aborted', 'encryption-required', 'unknown-condition'])(
    'tracks SASL refusal %s until a new attempt or success', (condition) => {
      const tracker = new AuthenticationTracker(vi.fn(), vi.fn())
      tracker.begin()
      tracker.received(xml('failure', { xmlns: 'urn:xmpp:sasl:2' }, xml(condition)))
      tracker.failed()
      tracker.received(xml('error', { xmlns: 'http://etherx.jabber.org/streams' }, xml('host-unknown')))
      expect(tracker.wasRefused()).toBe(true)
      tracker.sent(xml('auth', { xmlns: 'urn:ietf:params:xml:ns:xmpp-sasl', mechanism: 'PLAIN' }))
      expect(tracker.wasRefused()).toBe(false)
      tracker.received(xml('failure', { xmlns: 'urn:ietf:params:xml:ns:xmpp-sasl' }, xml(condition)))
      expect(tracker.wasRefused()).toBe(true)
      tracker.succeeded()
      expect(tracker.wasRefused()).toBe(false)
      tracker.received(xml('failure', { xmlns: 'urn:xmpp:sasl:2' }, xml(condition)))
      tracker.begin()
      expect(tracker.wasRefused()).toBe(false)
    }
  )

  it.each([
    ['failure', 'urn:ietf:params:xml:ns:xmpp-sasl', 'SASL'],
    ['failure', 'urn:xmpp:sasl:2', 'SASL2'],
    ['error', 'http://etherx.jabber.org/streams', 'stream'],
  ])('reports the refusal source %s/%s without copying server text', (name, xmlns, source) => {
    const report = vi.fn()
    const tracker = new AuthenticationTracker(report, vi.fn())
    tracker.sent(xml('auth', { xmlns: 'urn:ietf:params:xml:ns:xmpp-sasl', mechanism: 'PLAIN' }))
    tracker.received(xml(name, { xmlns }, xml('not-authorized'), xml('text', {}, 'private-fixture-detail')))
    expect(report).toHaveBeenLastCalledWith(expect.stringContaining(`source: ${source}, condition: not-authorized`), 'error')
    expect(JSON.stringify(report.mock.calls)).not.toContain('private-fixture-detail')
    expect(tracker.result()).toBeNull()
    expect(tracker.wasRefused()).toBe(true)
  })
})
