import { describe, it, expect } from 'vitest'
import { getWebsocketUrlForDomain, getDomainFromJid } from './wellKnownServers'

describe('getWebsocketUrlForDomain', () => {
  it('returns URL for exact match', () => {
    expect(getWebsocketUrlForDomain('process-one.net')).toBe('wss://chat.process-one.net/xmpp')
    expect(getWebsocketUrlForDomain('jabber.fr')).toBe('wss://jabber.fr/ws')
  })

  it('is case-insensitive', () => {
    expect(getWebsocketUrlForDomain('Jabber.FR')).toBe('wss://jabber.fr/ws')
  })

  it('returns null for unknown domain', () => {
    expect(getWebsocketUrlForDomain('unknown.org')).toBeNull()
  })

  it('matches wildcard suffix for *.m.in-app.io', () => {
    expect(getWebsocketUrlForDomain('chat.m.in-app.io')).toBe('wss://chat.m.in-app.io/xmpp')
    expect(getWebsocketUrlForDomain('demo.m.in-app.io')).toBe('wss://demo.m.in-app.io/xmpp')
  })

  it('does not match bare suffix domain', () => {
    // 'm.in-app.io' alone should not match the '*.m.in-app.io' wildcard
    expect(getWebsocketUrlForDomain('m.in-app.io')).toBeNull()
  })

  it('wildcard match is case-insensitive', () => {
    expect(getWebsocketUrlForDomain('Chat.M.In-App.IO')).toBe('wss://chat.m.in-app.io/xmpp')
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
