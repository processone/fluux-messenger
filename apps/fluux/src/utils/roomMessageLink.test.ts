import { describe, expect, it } from 'vitest'
import type { RoomMessage } from '@fluux/sdk'
import { roomMessageLinkFor } from './roomMessageLink'

const message: RoomMessage = { type: 'groupchat', roomJid: 'team@conference.example.org', id: 'team-update',
  stanzaId: '1731490000123456', originId: undefined, from: 'team@conference.example.org/Bob', nick: 'Bob',
  occupantId: 'bob', body: 'Team update', timestamp: new Date('2026-05-01T10:00:00Z'), isOutgoing: false }

// Room links (docs/URL_SCHEMES.md) are independent of delete permission, but
// exclude whispers, pending messages, missing room ids and rooms without MAM.
describe('room message link eligibility', () => {
  it('offers the same room-scoped link for incoming and outgoing messages', () => {
    for (const isOutgoing of [false, true]) {
      expect(roomMessageLinkFor({ ...message, isOutgoing }, true)).toBe('xmpp:team@conference.example.org?join;msg=1731490000123456')
    }
  })

  it.each([
    { isPrivate: true }, { stanzaId: undefined }, { isRetracted: true },
    { from: 'bob@example.org' },
  ])('does not offer a message link for an ineligible room row: %j', change => {
    expect(roomMessageLinkFor({ ...message, ...change }, true)).toBeUndefined()
  })

  // Link actions run during MessageBubble rendering, so bad stored addresses
  // must not escape into the app's error boundary.
  it('omits the action for a malformed cached room address without throwing', () => {
    const roomJid = 'team@other@conference.example.org'
    const cached: RoomMessage = { ...message, roomJid, from: `${roomJid}/Bob` }
    expect(roomMessageLinkFor(cached, true)).toBeUndefined()
  })

  it('does not offer a link for rooms without an archive or direct messages', () => {
    expect(roomMessageLinkFor(message, false)).toBeUndefined()
    expect(roomMessageLinkFor({ ...message, type: 'chat' }, true)).toBeUndefined()
  })
})
