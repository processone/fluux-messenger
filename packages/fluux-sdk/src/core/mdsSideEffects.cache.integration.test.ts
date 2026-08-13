/**
 * Protocol-level integration evidence for cache-resolved XEP-0490 positions.
 *
 * Unlike mdsSideEffects.cache.test.ts, this file uses the real messageCache
 * implementation against fake IndexedDB. It proves the backgrounded store
 * shape can flow through IndexedDB resolution into the MDS publish boundary.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import 'fake-indexeddb/auto'
import { IDBFactory } from 'fake-indexeddb'
import { setupMdsSideEffects } from './mdsSideEffects'
import { chatStore } from '../stores/chatStore'
import { connectionStore } from '../stores/connectionStore'
import { roomStore } from '../stores/roomStore'
import * as messageCache from '../utils/messageCache'
import { _resetStorageScopeForTesting, setStorageScopeJid } from '../utils/storageScope'
import { localStorageMock } from './sideEffects.testHelpers'
import type { Message, Room, RoomMessage } from './types'

Object.defineProperty(globalThis, 'localStorage', {
  value: localStorageMock,
  writable: true,
})

const OWN_BARE = 'romeo@montague.example'
const OWN_JID = `${OWN_BARE}/phone`
const EXACT_CHAT = 'juliet@capulet.example'
const FALLBACK_CHAT = 'benvolio@montague.example'
const ROOM = 'tech@conference.example'

function chatMessage(
  conversationId: string,
  id: string,
  stanzaId: string | undefined,
  timestamp: number,
  isOutgoing = false
): Message {
  return {
    type: 'chat',
    id,
    stanzaId,
    originId: isOutgoing ? `origin-${id}` : undefined,
    conversationId,
    from: isOutgoing ? OWN_BARE : conversationId,
    body: id,
    timestamp: new Date(timestamp),
    isOutgoing,
  } as Message
}

function roomMessage(id: string, stanzaId: string, from: string): RoomMessage {
  return {
    type: 'groupchat',
    id,
    stanzaId,
    roomJid: ROOM,
    from,
    nick: from.split('/')[1],
    body: `${from}:${id}`,
    timestamp: new Date(8_000),
    isOutgoing: false,
  } as RoomMessage
}

function makeClient() {
  const handlers: Record<string, Array<(payload?: unknown) => void>> = {}
  const register = (event: string, handler: (payload?: unknown) => void) => {
    ;(handlers[event] ||= []).push(handler)
    return () => {
      handlers[event] = (handlers[event] ?? []).filter((candidate) => candidate !== handler)
    }
  }
  const mds = {
    publishDisplayed: vi.fn().mockResolvedValue(undefined),
    fetchAllDisplayed: vi.fn().mockResolvedValue([]),
    fetchAllDisplayedResult: vi.fn().mockResolvedValue({
      status: 'authoritative' as const,
      markers: [],
    }),
    retractDisplayed: vi.fn().mockResolvedValue(undefined),
  }
  return {
    on: register,
    subscribe: register,
    _emit: (event: string, payload?: unknown) => {
      for (const handler of handlers[event] ?? []) handler(payload)
    },
    internal: { mds },
  }
}

async function waitForPublishes(
  publishDisplayed: ReturnType<typeof vi.fn>,
  expected: number
): Promise<void> {
  await vi.waitFor(() => {
    expect(publishDisplayed).toHaveBeenCalledTimes(expected)
  }, { timeout: 3_000, interval: 20 })
}

describe('mdsSideEffects real IndexedDB cache integration', () => {
  beforeEach(() => {
    globalThis.indexedDB = new IDBFactory()
    messageCache._resetDBForTesting()
    _resetStorageScopeForTesting()
    setStorageScopeJid(OWN_BARE)
    connectionStore.getState().reset()
    chatStore.getState().reset()
    roomStore.getState().reset()
    localStorageMock.clear()
  })

  afterEach(() => {
    messageCache._resetDBForTesting()
    _resetStorageScopeForTesting()
    vi.restoreAllMocks()
  })

  it('publishes exact chat, conservative chat fallback, and exact room positions from the real cache', async () => {
    await messageCache.saveMessages([
      chatMessage(EXACT_CHAT, 'exact-7', 'exact-stanza-7', 7_000),
      chatMessage(FALLBACK_CHAT, 'fallback-3', 'fallback-stanza-3', 3_000),
      chatMessage(FALLBACK_CHAT, 'own-4', undefined, 4_000, true),
      // Newer unread cache data must not move the published marker ahead.
      chatMessage(FALLBACK_CHAT, 'unread-5', 'unread-stanza-5', 5_000),
    ])

    const alice = `${ROOM}/alice`
    const bob = `${ROOM}/bob`
    await messageCache.saveRoomMessages([
      roomMessage('shared-id', 'alice-stanza', alice),
      roomMessage('shared-id', 'bob-stanza', bob),
    ])

    chatStore.getState().addConversation({
      id: EXACT_CHAT,
      name: EXACT_CHAT,
      type: 'chat',
      unreadCount: 0,
    })
    chatStore.getState().addConversation({
      id: FALLBACK_CHAT,
      name: FALLBACK_CHAT,
      type: 'chat',
      unreadCount: 0,
    })
    const room: Room = {
      jid: ROOM,
      name: 'tech',
      nickname: 'romeo',
      joined: true,
      isBookmarked: false,
      occupants: new Map(),
      messages: [],
      unreadCount: 0,
      mentionsCount: 0,
      typingUsers: new Set(),
    }
    roomStore.getState().addRoom(room)

    // These are genuinely backgrounded store shapes: no resident arrays and no
    // lastMessage previews can satisfy the resolver before it reaches IndexedDB.
    expect(chatStore.getState().messages.has(EXACT_CHAT)).toBe(false)
    expect(chatStore.getState().messages.has(FALLBACK_CHAT)).toBe(false)
    expect(roomStore.getState().roomRuntime.get(ROOM)?.messages).toEqual([])

    const client = makeClient()
    connectionStore.setState({ status: 'online', jid: OWN_JID } as never)
    const cleanup = setupMdsSideEffects(client as never)
    client._emit('online')
    await vi.waitFor(() => {
      expect(client.internal.mds.fetchAllDisplayedResult).toHaveBeenCalledTimes(1)
    })

    chatStore.setState((state) => {
      const conversationMeta = new Map(state.conversationMeta)
      conversationMeta.set(EXACT_CHAT, {
        ...conversationMeta.get(EXACT_CHAT)!,
        readPointer: { order: { role: 'exact', timestamp: new Date(7_000).getTime(), tiebreak: { kind: 'chat', id: 'exact-7' } }, identity: { state: 'local', messageId: 'exact-7' } },
      })
      conversationMeta.set(FALLBACK_CHAT, {
        ...conversationMeta.get(FALLBACK_CHAT)!,
        readPointer: { order: { role: 'exact', timestamp: new Date(4_000).getTime(), tiebreak: { kind: 'chat', id: 'own-4' } }, identity: { state: 'local', messageId: 'own-4' } },
      })
      return { conversationMeta }
    })
    roomStore.setState((state) => {
      const roomMeta = new Map(state.roomMeta)
      roomMeta.set(ROOM, {
        ...roomMeta.get(ROOM)!,
        readPointer: { order: { role: 'exact', timestamp: new Date(8_000).getTime(), tiebreak: { kind: 'room', from: alice, id: 'shared-id' } }, identity: { state: 'local', messageId: 'shared-id' } },
      })
      return { roomMeta }
    })

    await waitForPublishes(client.internal.mds.publishDisplayed, 3)

    const calls = client.internal.mds.publishDisplayed.mock.calls
    expect(calls).toContainEqual([EXACT_CHAT, 'exact-stanza-7', OWN_BARE])
    expect(calls).toContainEqual([FALLBACK_CHAT, 'fallback-stanza-3', OWN_BARE])
    expect(calls).not.toContainEqual([FALLBACK_CHAT, 'unread-stanza-5', OWN_BARE])
    expect(calls).toContainEqual([ROOM, 'alice-stanza', ROOM])
    expect(calls).not.toContainEqual([ROOM, 'bob-stanza', ROOM])

    if (process.env.MDS_EVIDENCE === '1') {
      console.info('MDS_EVIDENCE', JSON.stringify({
        cache: 'real messageCache over fake IndexedDB',
        residentArrays: {
          exactChat: false,
          fallbackChat: false,
          roomMessageCount: 0,
        },
        published: calls,
        suppressed: [
          [FALLBACK_CHAT, 'unread-stanza-5', OWN_BARE],
          [ROOM, 'bob-stanza', ROOM],
        ],
      }, null, 2))
    }

    cleanup()
  })
})
