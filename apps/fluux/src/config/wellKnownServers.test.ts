import { describe, it, expect } from 'vitest'
import { getConnectionServerOptions, getFallbackWebsocketUrlForDomain, getDomainFromJid } from './wellKnownServers'

describe('getFallbackWebsocketUrlForDomain', () => {
  it('returns URL for exact match', () => {
    expect(getFallbackWebsocketUrlForDomain('process-one.net')).toBe('wss://chat.process-one.net/xmpp')
  })

  it('is case-insensitive', () => {
    expect(getFallbackWebsocketUrlForDomain('Process-One.NET')).toBe('wss://chat.process-one.net/xmpp')
  })

  it('returns null for unknown domain', () => {
    expect(getFallbackWebsocketUrlForDomain('unknown.org')).toBeNull()
  })

  it('has no entry for a domain that advertises its own endpoint', () => {
    // jabber.fr publishes a host-meta (through a redirect) advertising
    // wss://ws.jabberfr.org/, so it needs no configured fallback.
    expect(getFallbackWebsocketUrlForDomain('jabber.fr')).toBeNull()
  })

  it('matches wildcard suffix for *.m.in-app.io', () => {
    expect(getFallbackWebsocketUrlForDomain('chat.m.in-app.io')).toBe('wss://chat.m.in-app.io/xmpp')
    expect(getFallbackWebsocketUrlForDomain('demo.m.in-app.io')).toBe('wss://demo.m.in-app.io/xmpp')
  })

  it('does not match bare suffix domain', () => {
    // 'm.in-app.io' alone should not match the '*.m.in-app.io' wildcard
    expect(getFallbackWebsocketUrlForDomain('m.in-app.io')).toBeNull()
  })

  it('wildcard match is case-insensitive', () => {
    expect(getFallbackWebsocketUrlForDomain('Chat.M.In-App.IO')).toBe('wss://chat.m.in-app.io/xmpp')
  })
})

describe('getConnectionServerOptions', () => {
  it('adds the configured fallback when connecting to the JID domain', () => {
    expect(getConnectionServerOptions('alice@process-one.net', '')).toEqual({
      server: 'process-one.net',
      fallbackWebSocketUrl: 'wss://chat.process-one.net/xmpp',
    })
    expect(getConnectionServerOptions('alice@process-one.net', 'PROCESS-ONE.NET')).toEqual({
      server: 'PROCESS-ONE.NET',
      fallbackWebSocketUrl: 'wss://chat.process-one.net/xmpp',
    })
  })

  it('does not attach the JID domain fallback to an explicit custom target', () => {
    expect(getConnectionServerOptions('alice@process-one.net', 'chat.custom.net')).toEqual({
      server: 'chat.custom.net',
      fallbackWebSocketUrl: undefined,
    })
  })
})

describe('getDomainFromJid', () => {
  it('extracts domain from bare JID', () => {
    expect(getDomainFromJid('user@example.com')).toBe('example.com')
  })

  it('extracts domain from full JID', () => {
    expect(getDomainFromJid('user@chat.m.in-app.io/resource')).toBe('chat.m.in-app.io')
  })

  it('returns null for invalid input', () => {
    expect(getDomainFromJid('')).toBeNull()
    expect(getDomainFromJid('nodomain')).toBeNull()
  })
})
