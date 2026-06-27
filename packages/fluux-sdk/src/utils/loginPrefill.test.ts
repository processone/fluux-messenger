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

  it('drops a server with a disallowed scheme but keeps the jid', () => {
    expect(normalizeLoginPrefill({ jid: 'a@b.com', server: 'javascript:alert(1)' }))
      .toEqual({ jid: 'a@b.com' })
  })

  it('drops a server that is not a URL', () => {
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
