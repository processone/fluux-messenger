import { describe, it, expect } from 'vitest'
import { normalizeLoginPrefill } from './loginPrefill'

describe('normalizeLoginPrefill', () => {
  it('keeps a valid jid and ws server', () => {
    expect(
      normalizeLoginPrefill({ jid: 'alice@example.com', server: 'wss://host:5443/ws' })
    ).toEqual({ jid: 'alice@example.com', server: 'wss://host:5443/ws' })
  })

  it('accepts an http(s) BOSH server', () => {
    expect(normalizeLoginPrefill({ jid: 'a@b.com', server: 'https://b.com/http-bind' }))
      .toEqual({ jid: 'a@b.com', server: 'https://b.com/http-bind' })
  })

  it('accepts a tls:// native-proxy server (with and without a port)', () => {
    expect(normalizeLoginPrefill({ jid: 'a@b.com', server: 'tls://chat.example.com:5223' }))
      .toEqual({ jid: 'a@b.com', server: 'tls://chat.example.com:5223' })
    expect(normalizeLoginPrefill({ jid: 'a@b.com', server: 'tls://chat.example.com' }))
      .toEqual({ jid: 'a@b.com', server: 'tls://chat.example.com' })
  })

  it('accepts a tcp:// native-proxy server', () => {
    expect(normalizeLoginPrefill({ jid: 'a@b.com', server: 'tcp://chat.example.com:5222' }))
      .toEqual({ jid: 'a@b.com', server: 'tcp://chat.example.com:5222' })
  })

  it('accepts a bare domain server (SRV resolution)', () => {
    expect(normalizeLoginPrefill({ jid: 'a@b.com', server: 'process-one.net' }))
      .toEqual({ jid: 'a@b.com', server: 'process-one.net' })
  })

  it('accepts a host:port shorthand server', () => {
    expect(normalizeLoginPrefill({ jid: 'a@b.com', server: 'chat.example.com:5222' }))
      .toEqual({ jid: 'a@b.com', server: 'chat.example.com:5222' })
  })

  it('drops a server with a dangerous scheme but keeps the jid', () => {
    for (const bad of ['javascript:alert(1)', 'file:///etc/passwd', 'data:text/html,x', 'blob:abc', 'javascript://x']) {
      expect(normalizeLoginPrefill({ jid: 'a@b.com', server: bad })).toEqual({ jid: 'a@b.com' })
    }
  })

  it('drops a host:port with a non-numeric or out-of-range port', () => {
    expect(normalizeLoginPrefill({ jid: 'a@b.com', server: 'chat.example.com:notaport' }))
      .toEqual({ jid: 'a@b.com' })
    expect(normalizeLoginPrefill({ jid: 'a@b.com', server: 'chat.example.com:99999' }))
      .toEqual({ jid: 'a@b.com' })
  })

  it('drops a bare single-label host (no dot) as a server', () => {
    expect(normalizeLoginPrefill({ jid: 'a@b.com', server: 'localhost' }))
      .toEqual({ jid: 'a@b.com' })
  })

  it('drops a server that contains whitespace', () => {
    expect(normalizeLoginPrefill({ jid: 'a@b.com', server: 'not a url' }))
      .toEqual({ jid: 'a@b.com' })
  })

  it('strips a resource from the jid path', () => {
    expect(normalizeLoginPrefill({ jid: 'alice@example.com/phone' }))
      .toEqual({ jid: 'alice@example.com' })
  })

  it('accepts a bare domain jid', () => {
    expect(normalizeLoginPrefill({ jid: 'example.com' })).toEqual({ jid: 'example.com' })
  })

  it('rejects a malformed jid (no domain dot, no @)', () => {
    expect(normalizeLoginPrefill({ jid: 'nonsense' })).toBeNull()
  })

  it('trims and keeps resource and lang', () => {
    expect(
      normalizeLoginPrefill({ jid: 'a@b.com', resource: ' desktop ', lang: ' fr ' })
    ).toEqual({ jid: 'a@b.com', resource: 'desktop', lang: 'fr' })
  })

  it('returns null when nothing usable is present', () => {
    expect(normalizeLoginPrefill({})).toBeNull()
    expect(normalizeLoginPrefill({ resource: 'x', lang: 'y' })).toBeNull()
  })
})
