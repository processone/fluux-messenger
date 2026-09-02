/**
 * The generation a read pointer belongs to.
 *
 * "Forward-only" holds WITHIN one generation. Several normal transitions replace a
 * pointer wholesale — an account switch, a logout, deleting and re-creating a
 * conversation — and a consumer that cannot see those boundaries would read every
 * one of them as the pointer moving backwards.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { chatStore, chatReadStateGeneration } from './chatStore'
import { roomStore, roomReadStateGeneration } from './roomStore'
import { _resetStorageScopeForTesting } from '../utils/storageScope'
import { _resetForTesting as _resetThrottledStorageForTesting } from './shared/throttledStorage'
import type { Conversation, Room } from '../core/types'

const localStorageMock = (() => {
  let store: Record<string, string> = {}
  return {
    getItem: (key: string) => store[key] ?? null,
    setItem: (key: string, value: string) => {
      store[key] = value
    },
    removeItem: (key: string) => {
      delete store[key]
    },
    clear: () => {
      store = {}
    },
  }
})()
Object.defineProperty(globalThis, 'localStorage', { value: localStorageMock, writable: true })

vi.mock('../utils/messageCache', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../utils/messageCache')>()
  return {
    ...actual,
    isMessageCacheAvailable: vi.fn().mockReturnValue(true),
    deleteConversationMessages: vi.fn().mockResolvedValue(undefined),
    deleteRoomMessages: vi.fn().mockResolvedValue(undefined),
    getMessages: vi.fn().mockResolvedValue([]),
    getRoomMessages: vi.fn().mockResolvedValue([]),
  }
})

const CONV = 'alice@example.com'
const ROOM = 'general@conference.example.com'

function conversation(id: string, name: string): Conversation {
  return { id, name, type: 'chat', unreadCount: 0 }
}

function room(jid: string): Room {
  return {
    jid,
    name: jid,
    nickname: 'me',
    joined: true,
    isBookmarked: false,
    occupants: new Map(),
    unreadCount: 0,
    mentionsCount: 0,
    typingUsers: new Set(),
  }
}

beforeEach(() => {
  localStorageMock.clear()
  _resetStorageScopeForTesting()
  _resetThrottledStorageForTesting()
})

describe('chatReadStateGeneration', () => {
  it('reads zero for an entity the store has never seen', () => {
    expect(chatReadStateGeneration('nobody@example.com').entity).toBe(0)
  })

  it('holds still across ordinary writes', () => {
    chatStore.getState().addConversation(conversation(CONV, 'Alice'))
    const before = chatReadStateGeneration(CONV)

    chatStore.getState().setActiveConversation(CONV)
    chatStore.getState().setActiveConversation(null)

    expect(chatReadStateGeneration(CONV)).toEqual(before)
  })

  it('bumps only the entity scope when a conversation is deleted', () => {
    chatStore.getState().addConversation(conversation(CONV, 'Alice'))
    const before = chatReadStateGeneration(CONV)

    chatStore.getState().deleteConversation(CONV)
    const after = chatReadStateGeneration(CONV)

    expect(after.entity).toBe(before.entity + 1)
    // A deleted conversation must not invalidate everything else's read state:
    // a global counter here would forgive a real regression elsewhere.
    expect(after.store).toBe(before.store)
  })

  it('leaves another conversation alone when one is deleted', () => {
    const other = 'bob@example.com'
    chatStore.getState().addConversation(conversation(CONV, 'Alice'))
    chatStore.getState().addConversation(conversation(other, 'Bob'))
    const before = chatReadStateGeneration(other)

    chatStore.getState().deleteConversation(CONV)

    expect(chatReadStateGeneration(other)).toEqual(before)
  })

  it('bumps the store scope on reset', () => {
    const before = chatReadStateGeneration(CONV)

    chatStore.getState().reset()

    expect(chatReadStateGeneration(CONV).store).toBe(before.store + 1)
  })
})

describe('roomReadStateGeneration', () => {
  it('bumps only the entity scope when a room is removed', () => {
    roomStore.getState().addRoom(room(ROOM))
    const before = roomReadStateGeneration(ROOM)

    roomStore.getState().removeRoom(ROOM)
    const after = roomReadStateGeneration(ROOM)

    expect(after.entity).toBe(before.entity + 1)
    expect(after.store).toBe(before.store)
  })

  it('bumps the store scope on reset', () => {
    const before = roomReadStateGeneration(ROOM)

    roomStore.getState().reset()

    expect(roomReadStateGeneration(ROOM).store).toBe(before.store + 1)
  })
})
