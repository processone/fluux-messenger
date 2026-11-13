import { describe, expect, it } from 'vitest'
import { buildRoomMessageLink, parseRoomMessageLink } from './roomMessageLink'

// Room links (docs/URL_SCHEMES.md) preserve the server's opaque archive identity.
// Numeric (ejabberd) and UUID (Prosody) ids follow the project's stanza-id contract.
describe('room message links', () => {
  it.each(['1731490000123456', '550e8400-e29b-41d4-a716-446655440000', 'archive;id=?#%/é'])('round-trips an opaque room id: %s', stanzaId => {
    const roomJid = 'team@conference.example.org'
    const link = buildRoomMessageLink(roomJid, stanzaId)
    expect(link).toBe(`xmpp:${roomJid}?join;msg=${encodeURIComponent(stanzaId)}`)
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
    'xmpp:team@conference.example.org?message;msg=id',
    'xmpp:team@conference.example.org?join;msg=%ZZ',
    'https://example.org/?join;msg=id',
  ])('rejects a link without a valid room-message target: %s', link => {
    expect(parseRoomMessageLink(link)).toBeNull()
  })
})
