import { describe, it, expect } from 'vitest'
import { unreadConversations } from './unreadConversations'
import { roomSelectors } from './roomSelectors'
import type { RoomState } from './roomStore'
import type { RoomEntity, RoomMetadata, Message } from '../core/types'

const at = (iso: string) => ({ timestamp: new Date(iso) }) as Message

function rooms(
  entries: Array<[string, Partial<RoomEntity>, Partial<RoomMetadata>]>,
): RoomState {
  const roomEntities = new Map<string, RoomEntity>()
  const roomMeta = new Map<string, RoomMetadata>()
  for (const [jid, entity, meta] of entries) {
    roomEntities.set(jid, { jid, name: jid, nickname: 'me', joined: true, isBookmarked: true, ...entity } as RoomEntity)
    roomMeta.set(jid, { unreadCount: 0, mentionsCount: 0, typingUsers: new Set(), ...meta } as RoomMetadata)
  }
  return { roomEntities, roomMeta } as RoomState
}

describe('unreadConversations', () => {
  const state = rooms([
    ['dev@conference.example.com', { name: 'ejabberd-dev' }, { unreadCount: 14, mentionsCount: 1, lastMessage: { timestamp: new Date('2026-11-04T10:31:00Z') } as never }],
    ['busy@conference.example.com', { name: 'Busy' }, { unreadCount: 40 }],
    ['all@conference.example.com', { name: 'Release team' }, { unreadCount: 4, notifyAllPersistent: true, lastInteractedAt: new Date('2026-11-03T09:00:00Z') }],
    ['left@conference.example.com', { joined: false }, { unreadCount: 3, mentionsCount: 3 }],
  ])
  const chats = [
    { id: 'alice@example.com', name: 'Alice Martin', unreadCount: 2, lastMessage: at('2026-11-04T10:42:00Z') },
    { id: 'bruno@example.com', name: 'Bruno Roux', unreadCount: 0, lastMessage: at('2026-11-04T11:00:00Z') },
    { id: 'chloe@example.com', name: 'Chloé Lambert', unreadCount: 1, lastMessage: at('2026-11-03T18:00:00Z') },
  ]

  it('lists what the badge counts, newest activity first', () => {
    const rows = unreadConversations(chats, state)
    expect(rows.map(r => r.id)).toEqual([
      'alice@example.com',
      'dev@conference.example.com',
      'chloe@example.com',
      'all@conference.example.com',
    ])
  })

  it('leaves out quiet rooms and rooms not joined, like the badge', () => {
    const ids = unreadConversations(chats, state).map(r => r.id)
    expect(ids).not.toContain('busy@conference.example.com')
    expect(ids).not.toContain('left@conference.example.com')
  })

  it('has as many rows as the badge counts conversations', () => {
    const rows = unreadConversations(chats, state)
    const badged = chats.filter(c => c.unreadCount > 0).length + roomSelectors.roomsWithUnread(state).length
    expect(rows).toHaveLength(badged)
  })

  it('carries the counts, the kind and the mention count', () => {
    const dev = unreadConversations(chats, state).find(r => r.id === 'dev@conference.example.com')
    expect(dev).toEqual({
      id: 'dev@conference.example.com', kind: 'groupchat', name: 'ejabberd-dev',
      unreadCount: 14, mentionsCount: 1, lastActivity: Date.parse('2026-11-04T10:31:00Z'),
    })
    expect(unreadConversations(chats, state)[0]).toMatchObject({ kind: 'chat', mentionsCount: 0, unreadCount: 2 })
  })
})
