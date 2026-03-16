import { describe, it, expect } from 'vitest'
import { buildRoomContactSuggestions } from './roomSuggestions'
import type { Room } from '@fluux/sdk'

function createRoom(overrides: Partial<Room> = {}): Room {
  return {
    jid: 'room@conference.example.com',
    name: 'Test Room',
    joined: true,
    nickname: 'Me',
    messages: [],
    occupants: new Map(),
    typingUsers: new Set(),
    unreadCount: 0,
    mentionsCount: 0,
    isBookmarked: true,
    ...overrides,
  }
}

describe('buildRoomContactSuggestions', () => {
  it('returns empty array for empty room', () => {
    expect(buildRoomContactSuggestions(createRoom())).toEqual([])
  })

  it('collects occupants with real JIDs', () => {
    const occupants = new Map([
      ['alice', { nick: 'alice', jid: 'alice@example.com', affiliation: 'member' as const, role: 'participant' as const }],
      ['bob', { nick: 'bob', jid: 'bob@example.com', affiliation: 'member' as const, role: 'participant' as const }],
    ])
    const result = buildRoomContactSuggestions(createRoom({ occupants }))
    expect(result).toEqual([
      { jid: 'alice@example.com', name: 'alice' },
      { jid: 'bob@example.com', name: 'bob' },
    ])
  })

  it('skips occupants without a real JID', () => {
    const occupants = new Map([
      ['alice', { nick: 'alice', jid: 'alice@example.com', affiliation: 'member' as const, role: 'participant' as const }],
      ['anon', { nick: 'anon', affiliation: 'none' as const, role: 'participant' as const }],
    ])
    const result = buildRoomContactSuggestions(createRoom({ occupants }))
    expect(result).toEqual([{ jid: 'alice@example.com', name: 'alice' }])
  })

  it('includes affiliated members', () => {
    const affiliatedMembers = [
      { jid: 'carol@example.com', nick: 'Carol', affiliation: 'member' as const },
    ]
    const result = buildRoomContactSuggestions(createRoom({ affiliatedMembers }))
    expect(result).toEqual([{ jid: 'carol@example.com', name: 'Carol' }])
  })

  it('deduplicates occupants and affiliated members', () => {
    const occupants = new Map([
      ['alice', { nick: 'alice', jid: 'alice@example.com', affiliation: 'member' as const, role: 'participant' as const }],
    ])
    const affiliatedMembers = [
      { jid: 'alice@example.com', nick: 'Alice Full', affiliation: 'member' as const },
      { jid: 'dave@example.com', nick: 'Dave', affiliation: 'member' as const },
    ]
    const result = buildRoomContactSuggestions(createRoom({ occupants, affiliatedMembers }))
    expect(result).toEqual([
      { jid: 'alice@example.com', name: 'alice' },   // from occupant, not duplicated
      { jid: 'dave@example.com', name: 'Dave' },
    ])
  })

  it('handles undefined affiliatedMembers', () => {
    const occupants = new Map([
      ['alice', { nick: 'alice', jid: 'alice@example.com', affiliation: 'member' as const, role: 'participant' as const }],
    ])
    const result = buildRoomContactSuggestions(createRoom({ occupants, affiliatedMembers: undefined }))
    expect(result).toEqual([{ jid: 'alice@example.com', name: 'alice' }])
  })
})
