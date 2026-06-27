import { describe, it, expect, beforeEach } from 'vitest'
import { loginPrefillFromXmppUri, captureWebLoginPrefill } from './loginPrefillSources'

describe('loginPrefillFromXmppUri', () => {
  it('parses a bare jid uri', () => {
    expect(loginPrefillFromXmppUri('xmpp:alice@example.com')).toEqual({ jid: 'alice@example.com' })
  })

  it('parses a connect uri with a server override', () => {
    const uri = 'xmpp:alice@example.com?connect;server=wss%3A%2F%2Fhost%3A5443%2Fws;resource=desktop'
    expect(loginPrefillFromXmppUri(uri)).toEqual({
      jid: 'alice@example.com',
      server: 'wss://host:5443/ws',
      resource: 'desktop',
    })
  })

  it('returns null for a non-xmpp uri', () => {
    expect(loginPrefillFromXmppUri('https://example.com')).toBeNull()
  })
})

describe('captureWebLoginPrefill', () => {
  beforeEach(() => {
    window.history.replaceState(null, '', '/')
  })

  it('returns null when no prefill params are present', () => {
    window.history.replaceState(null, '', '/?foo=bar#/chat')
    expect(captureWebLoginPrefill()).toBeNull()
    expect(window.location.search).toBe('?foo=bar')
  })

  it('parses jid and server and strips them from the url', () => {
    window.history.replaceState(null, '', '/?jid=alice@example.com&server=wss://host/ws&keep=1#/x')
    expect(captureWebLoginPrefill()).toEqual({ jid: 'alice@example.com', server: 'wss://host/ws' })
    // consumed params removed, unrelated params + hash preserved
    expect(window.location.search).toBe('?keep=1')
    expect(window.location.hash).toBe('#/x')
  })
})
