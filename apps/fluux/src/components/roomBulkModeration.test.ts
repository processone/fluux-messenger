import { describe, expect, it } from 'vitest'
import type { Room, RoomMessage } from '@fluux/sdk'
import { bulkModerationCandidates, canBulkModerate } from './roomBulkModeration'

const room: Room = {
  jid: 'room@conference.example.com', name: 'Room', nickname: 'Me', joined: true,
  supportsModeration: true, isBookmarked: true, unreadCount: 0, mentionsCount: 0, typingUsers: new Set(),
  occupants: new Map([
    ['Me', { nick: 'Me', role: 'moderator', affiliation: 'admin' }],
    ['Owner', { nick: 'Owner', role: 'moderator', affiliation: 'owner', occupantId: 'owner' }],
  ]),
}

const message = (overrides: Partial<RoomMessage> = {}): RoomMessage => {
  const row: RoomMessage = {
    type: 'groupchat', roomJid: room.jid, id: 'reused-client-id', stanzaId: 'server-1',
    from: `${room.jid}/Spammer`, nick: 'Spammer', occupantId: 'spammer',
    body: 'Spam', timestamp: new Date(), isOutgoing: false, ...overrides,
  }
  return { ...row, ...overrides }
}

describe('bulk moderation selection', () => {
  it('selects distinct server targets even when senders reuse client ids or nicknames', () => {
    const first = message()
    const second = message({ stanzaId: 'server-2', occupantId: 'other-person' })
    expect(bulkModerationCandidates(room, [first, second, { ...first }])).toEqual([first, second])
  })

  it('excludes private, own, removed, system, foreign-room and unaddressable messages', () => {
    const eligible = message()
    const excluded = [
      message({ isPrivate: true }), message({ isOutgoing: true }), message({ isRetracted: true }),
      message({ stanzaId: undefined }), message({ stanzaId: '' }),
      message({ roomJid: 'other@conference.example.com' }),
      message({ systemEvent: { kind: 'nick-changed', oldNick: 'A', newNick: 'B' } }),
    ]
    expect(bulkModerationCandidates(room, [...excluded, eligible])).toEqual([eligible])
  })

  it('respects moderator role, room support, join state, and protected authors', () => {
    expect(canBulkModerate(room)).toBe(true)
    for (const unavailable of [
      { ...room, joined: false }, { ...room, supportsModeration: false },
      { ...room, isIrcGateway: true }, { ...room, occupants: new Map() },
      { ...room, occupants: new Map([['Me', { nick: 'Me', role: 'participant' as const, affiliation: 'owner' as const }]]) },
    ]) {
      expect(canBulkModerate(unavailable)).toBe(false)
      expect(bulkModerationCandidates(unavailable, [message()])).toEqual([])
    }
    expect(bulkModerationCandidates(room, [message({ nick: 'Owner', occupantId: 'owner' })])).toEqual([])
    // A departed spammer's historical nickname must not inherit its new owner's protection.
    expect(bulkModerationCandidates(room, [message({ nick: 'Owner' })])).toHaveLength(1)
  })
})
