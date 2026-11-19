import { describe, expect, it } from 'vitest'
import { buildRoomMessageLink, parseRoomMessageLink, roomMessageLinkReferences } from './roomMessageLink'

// Room links (docs/URL_SCHEMES.md) preserve the server's opaque archive identity.
// Numeric (ejabberd) and UUID (Prosody) ids follow the project's stanza-id contract.
describe('room message links', () => {
  it.each(['1731490000123456', '550e8400-e29b-41d4-a716-446655440000', 'archive;id=?#%/é'])('round-trips an opaque room id: %s', stanzaId => {
    const roomJid = 'team@conference.example.org'
    const link = buildRoomMessageLink(roomJid, stanzaId)
    expect(link).toBe(`xmpp:${roomJid}?join;msg=${encodeURIComponent(stanzaId)}`)
    expect(parseRoomMessageLink(link)).toEqual({ roomJid, stanzaId })
  })

  // IRC gateway room addresses are supported by MUC discovery (isIrcGateway).
  it.each(['#chan%irc.example.org@biboumi.example.org', '#chan?topic%irc.example.org@biboumi.example.org'])('round-trips a gateway room address: %s', roomJid => {
    const stanzaId = '1731490000123456'
    const link = buildRoomMessageLink(roomJid, stanzaId)
    expect(link).toBe(`xmpp:${encodeURIComponent(roomJid).replace(/%40/g, '@')}?join;msg=${stanzaId}`)
    expect(parseRoomMessageLink(link)).toEqual({ roomJid, stanzaId })
  })

  it('escapes punctuation that message text would otherwise trim from a URL', () => {
    const stanzaId = "opaque!'()*"
    const link = buildRoomMessageLink('team@conference.example.org', stanzaId)
    expect(link).toMatch(/;msg=opaque%21%27%28%29%2A$/)
    expect(parseRoomMessageLink(link)?.stanzaId).toBe(stanzaId)
  })

  it.each([
    'xmpp:team@conference.example.org?join',
    'xmpp:team@conference.example.org?join;msg=',
    'xmpp:team@conference.example.org/nick?join;msg=id',
    'xmpp:team%40other@conference.example.org?join;msg=id',
    'xmpp:team@conference.example.org?message;msg=id',
    'xmpp:team@conference.example.org?join;msg=%ZZ',
    'https://example.org/?join;msg=id',
  ])('rejects a link without a valid room-message target: %s', link => {
    expect(parseRoomMessageLink(link)).toBeNull()
  })
})

// FLM-322: a peer-sent body is only bounded by the server's stanza limit.
describe('room message link detection on long bodies', () => {
  const link = 'xmpp:team@conference.example.org?join;msg=42'

  it('trims trailing punctuation from a pasted link', () => {
    const body = `see (${link}).`
    const [reference] = roomMessageLinkReferences(body)
    expect(reference.uri).toBe(link)
    expect(body.slice(reference.begin, reference.end)).toBe(link)
  })

  it('scans an 80 KB punctuation run followed by a letter in linear time', () => {
    const body = `xmpp:${'.'.repeat(80_000)}x`
    const started = performance.now()
    expect(roomMessageLinkReferences(body)).toEqual([])
    expect(performance.now() - started).toBeLessThan(250)
  })

  it('still finds a link after a long punctuation run', () => {
    const body = `xmpp:${'!'.repeat(80_000)}x ${link}`
    expect(roomMessageLinkReferences(body).map(r => r.uri)).toEqual([link])
  })
})
