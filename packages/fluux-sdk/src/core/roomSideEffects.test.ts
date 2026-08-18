/**
 * Tests for room-related side effects.
 *
 * Verifies that MAM queries are triggered at the right times:
 * - When a room becomes active
 * - When supportsMAM becomes true on the active room
 * - When a room finishes joining
 * - On reconnection for the active room
 */
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest'
import { localStorageMock } from './sideEffects.testHelpers'

Object.defineProperty(globalThis, 'localStorage', {
  value: localStorageMock,
  writable: true,
})

// Mock messageCache to prevent IndexedDB operations
vi.mock('../utils/messageCache', () => ({
  saveRoomMessageWithResult: vi.fn().mockResolvedValue(true),
  saveRoomMessage: vi.fn().mockResolvedValue(undefined),
  saveRoomMessages: vi.fn().mockResolvedValue(undefined),
  getRoomMessages: vi.fn().mockResolvedValue([]),
  getRoomMessage: vi.fn().mockResolvedValue(null),
  getRoomMessageByStanzaId: vi.fn().mockResolvedValue(null),
  updateRoomMessage: vi.fn().mockResolvedValue(undefined),
  deleteRoomMessage: vi.fn().mockResolvedValue(undefined),
  deleteRoomMessages: vi.fn().mockResolvedValue(undefined),
  saveMessageWithResult: vi.fn().mockResolvedValue(true),
  saveMessage: vi.fn().mockResolvedValue(undefined),
  saveMessages: vi.fn().mockResolvedValue(undefined),
  getMessages: vi.fn().mockResolvedValue([]),
  getMessage: vi.fn().mockResolvedValue(null),
  getMessageByStanzaId: vi.fn().mockResolvedValue(null),
  updateMessage: vi.fn().mockResolvedValue(undefined),
  deleteMessage: vi.fn().mockResolvedValue(undefined),
  deleteConversationMessages: vi.fn().mockResolvedValue(undefined),
  clearAllMessages: vi.fn().mockResolvedValue(undefined),
  isMessageCacheAvailable: vi.fn().mockReturnValue(false),
  getOldestMessageTimestamp: vi.fn().mockResolvedValue(null),
  getOldestRoomMessageTimestamp: vi.fn().mockResolvedValue(null),
  getMessageCount: vi.fn().mockResolvedValue(0),
  getRoomMessageCount: vi.fn().mockResolvedValue(0),
}))

import { setupRoomSideEffects } from './roomSideEffects'
import { roomStore } from '../stores/roomStore'
import { connectionStore } from '../stores/connectionStore'
import { createMockClient, simulateFreshSession, simulateSmResumption } from './sideEffects.testHelpers'

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((r, j) => {
    resolve = r
    reject = j
  })
  return { promise, resolve, reject }
}

describe('setupRoomSideEffects', () => {
  let mockClient: ReturnType<typeof createMockClient>
  let cleanup: () => void

  const ROOM = 'room@conference.example.com'

  function confirmRoomJoin(roomJid = ROOM) {
    roomStore.getState().setRoomJoined(roomJid, true)
    mockClient._emitSDK('room:joined', { roomJid, joined: true })
  }

  beforeEach(() => {
    roomStore.getState().reset()
    connectionStore.getState().reset()
    mockClient = createMockClient()
  })

  afterEach(() => {
    cleanup?.()
  })

  describe('supportsMAM subscription', () => {
    it('should trigger MAM fetch when supportsMAM becomes true on active room', async () => {
      roomStore.getState().addRoom({
        jid: 'room@conference.example.com',
        name: 'Test Room',
        nickname: 'testuser',
        joined: true,
        supportsMAM: false,
        occupants: new Map(),
        messages: [],
        unreadCount: 0,
        mentionsCount: 0,
        typingUsers: new Set(),
        isBookmarked: true,
      })

      roomStore.getState().setActiveRoom('room@conference.example.com')

      cleanup = setupRoomSideEffects(mockClient)
      simulateFreshSession(mockClient)
      roomStore.getState().markAllRoomsNotJoined()
      confirmRoomJoin()

      await vi.waitFor(() => {
        // Confirmed join sees MAM is unsupported, so it is skipped.
        expect((mockClient.internal.mam.catchUpRoomHistory as ReturnType<typeof vi.fn>).mock.calls.length).toBe(0)
      })

      // supportsMAM becomes true — triggers MAM fetch via supportsMAM watcher
      roomStore.getState().updateRoom('room@conference.example.com', {
        supportsMAM: true,
      })

      await vi.waitFor(() => {
        expect(mockClient.internal.mam.catchUpRoomHistory).toHaveBeenCalledWith(
          'room@conference.example.com',
          expect.any(Array),
          expect.objectContaining({}),
        )
      })
    })

    it('should not trigger MAM fetch if supportsMAM was already true', async () => {
      roomStore.getState().addRoom({
        jid: 'room@conference.example.com',
        name: 'Test Room',
        nickname: 'testuser',
        joined: true,
        supportsMAM: true,
        occupants: new Map(),
        messages: [],
        unreadCount: 0,
        mentionsCount: 0,
        typingUsers: new Set(),
        isBookmarked: true,
      })

      cleanup = setupRoomSideEffects(mockClient)
      simulateFreshSession(mockClient)

      roomStore.getState().markAllRoomsNotJoined()
      roomStore.getState().setActiveRoom('room@conference.example.com')
      confirmRoomJoin()

      await vi.waitFor(() => {
        expect(mockClient.internal.mam.catchUpRoomHistory).toHaveBeenCalledTimes(1)
      })

      ;(mockClient.internal.mam.catchUpRoomHistory as ReturnType<typeof vi.fn>).mockClear()

      roomStore.getState().updateRoom('room@conference.example.com', {
        name: 'Updated Room Name',
      })

      await new Promise(resolve => setTimeout(resolve, 50))
      expect(mockClient.internal.mam.catchUpRoomHistory).not.toHaveBeenCalled()
    })

    it('should not trigger MAM fetch when supportsMAM becomes true on inactive room', async () => {
      connectionStore.getState().setStatus('online')

      roomStore.getState().addRoom({
        jid: 'active-room@conference.example.com',
        name: 'Active Room',
        nickname: 'testuser',
        joined: false,
        supportsMAM: false,
        occupants: new Map(),
        messages: [],
        unreadCount: 0,
        mentionsCount: 0,
        typingUsers: new Set(),
        isBookmarked: true,
      })

      roomStore.getState().addRoom({
        jid: 'inactive-room@conference.example.com',
        name: 'Inactive Room',
        nickname: 'testuser',
        joined: false,
        supportsMAM: false,
        occupants: new Map(),
        messages: [],
        unreadCount: 0,
        mentionsCount: 0,
        typingUsers: new Set(),
        isBookmarked: true,
      })

      roomStore.getState().setActiveRoom('active-room@conference.example.com')

      cleanup = setupRoomSideEffects(mockClient)

      roomStore.getState().updateRoom('inactive-room@conference.example.com', {
        joined: true,
        supportsMAM: true,
      })

      await new Promise(resolve => setTimeout(resolve, 50))
      expect(mockClient.internal.mam.catchUpRoomHistory).not.toHaveBeenCalled()
    })

    it('should not trigger MAM fetch when no room is active', async () => {
      connectionStore.getState().setStatus('online')

      roomStore.getState().addRoom({
        jid: 'room@conference.example.com',
        name: 'Test Room',
        nickname: 'testuser',
        joined: false,
        supportsMAM: false,
        occupants: new Map(),
        messages: [],
        unreadCount: 0,
        mentionsCount: 0,
        typingUsers: new Set(),
        isBookmarked: true,
      })

      cleanup = setupRoomSideEffects(mockClient)

      roomStore.getState().updateRoom('room@conference.example.com', {
        joined: true,
        supportsMAM: true,
      })

      await new Promise(resolve => setTimeout(resolve, 50))
      expect(mockClient.internal.mam.catchUpRoomHistory).not.toHaveBeenCalled()
    })

    it('should not trigger MAM fetch for Quick Chat rooms even when supportsMAM becomes true', async () => {
      connectionStore.getState().setStatus('online')

      roomStore.getState().addRoom({
        jid: 'quickchat@conference.example.com',
        name: 'Quick Chat',
        nickname: 'testuser',
        joined: false,
        supportsMAM: false,
        isQuickChat: true,
        occupants: new Map(),
        messages: [],
        unreadCount: 0,
        mentionsCount: 0,
        typingUsers: new Set(),
        isBookmarked: false,
      })

      roomStore.getState().setActiveRoom('quickchat@conference.example.com')

      cleanup = setupRoomSideEffects(mockClient)

      roomStore.getState().updateRoom('quickchat@conference.example.com', {
        joined: true,
        supportsMAM: true,
      })

      await new Promise(resolve => setTimeout(resolve, 50))
      expect(mockClient.internal.mam.catchUpRoomHistory).not.toHaveBeenCalled()
    })
  })

  describe('cache loading with existing messages', () => {
    it('should load from cache even when room already has live messages in memory', async () => {
      connectionStore.getState().setStatus('online')

      const liveMessage = {
        type: 'groupchat' as const,
        id: 'live-msg-1',
        roomJid: 'room@conference.example.com',
        from: 'room@conference.example.com/alice',
        nick: 'alice',
        body: 'New live message',
        timestamp: new Date('2026-02-04T12:00:00Z'),
        isOutgoing: false,
      }
      roomStore.getState().addRoom({
        jid: 'room@conference.example.com',
        name: 'Test Room',
        nickname: 'testuser',
        joined: true,
        supportsMAM: true,
        occupants: new Map(),
        messages: [liveMessage],
        unreadCount: 1,
        mentionsCount: 0,
        typingUsers: new Set(),
        isBookmarked: true,
      })

      const loadSpy = vi.spyOn(roomStore.getState(), 'loadMessagesFromCache')

      cleanup = setupRoomSideEffects(mockClient)

      roomStore.getState().setActiveRoom('room@conference.example.com')

      await vi.waitFor(() => {
        expect(loadSpy).toHaveBeenCalledWith('room@conference.example.com', { limit: 100 })
      })

      loadSpy.mockRestore()
    })
  })

  describe('re-entry of a caught-up resident room', () => {
    // Re-entering a room you're still joined to (no reconnect) should be a no-op for
    // side effects: the messages are already resident (activateRoom's own cache load
    // ran on the way in) and MAM was already caught up this session. Reloading the
    // cache here churns the message array AFTER the list has mounted and scrolled,
    // which knocks the restored scroll position off (lands mid-list). See the
    // activeRoomJid subscriber guard in roomSideEffects.ts.
    it('does not reload cache or query MAM when activating a joined, resident, caught-up room', async () => {
      // Distinct jid + jid-scoped assertions: sibling tests leave their Step-2
      // fetchMAMForRoom async in flight (they only await the Step-1 load), which can
      // fire loadMessagesFromCache/catchUpRoomHistory on the shared store during this test.
      const ROOM = 'reentry@conference.example.com'
      const liveMessage = {
        type: 'groupchat' as const,
        id: 'live-1',
        roomJid: ROOM,
        from: `${ROOM}/alice`,
        nick: 'alice',
        body: 'hi',
        timestamp: new Date('2026-02-04T12:00:00Z'),
        isOutgoing: false,
      }
      // Joined room with messages already resident (as activateRoom leaves it on the
      // way in). SM resumption marks every joined room caught up for the session
      // without a reconnect — exactly the "joined, did not reconnect" case.
      roomStore.getState().addRoom({
        jid: ROOM,
        name: 'Test Room',
        nickname: 'me',
        joined: true,
        supportsMAM: true,
        occupants: new Map(),
        messages: [liveMessage],
        unreadCount: 0,
        mentionsCount: 0,
        typingUsers: new Set(),
        isBookmarked: true,
      })

      cleanup = setupRoomSideEffects(mockClient)
      simulateSmResumption(mockClient) // seeds fetchInitiated for joined rooms; no MAM

      const loadSpy = vi.spyOn(roomStore.getState(), 'loadMessagesFromCache')

      // Activating it now is a no-op: caught up this session AND still resident.
      roomStore.getState().setActiveRoom(ROOM)

      await new Promise((resolve) => setTimeout(resolve, 50))
      expect(loadSpy).not.toHaveBeenCalledWith(ROOM, expect.anything())
      expect(mockClient.internal.mam.catchUpRoomHistory).not.toHaveBeenCalledWith(
        ROOM,
        expect.anything(),
        expect.anything(),
      )
      loadSpy.mockRestore()
    })
  })

  describe('post-cache eligibility', () => {
    it('replaces a pending fetch when the active room leaves and rejoins', async () => {
      const staleCache = deferred<[]>()
      const replacementCache = deferred<[]>()
      roomStore.getState().addRoom({
        jid: ROOM,
        name: 'Test Room',
        nickname: 'testuser',
        joined: false,
        supportsMAM: true,
        occupants: new Map(),
        messages: [],
        unreadCount: 0,
        mentionsCount: 0,
        typingUsers: new Set(),
        isBookmarked: true,
      })
      roomStore.getState().setActiveRoom(ROOM)
      let roomLoadCount = 0
      const loadSpy = vi.spyOn(
        roomStore.getState(),
        'loadMessagesFromCache',
      ).mockImplementation((jid) => {
        if (jid !== ROOM) return Promise.resolve([])
        roomLoadCount += 1
        return roomLoadCount === 1 ? staleCache.promise : replacementCache.promise
      })
      cleanup = setupRoomSideEffects(mockClient)
      simulateFreshSession(mockClient)

      confirmRoomJoin()
      roomStore.getState().setRoomJoined(ROOM, false)
      mockClient._emitSDK('room:joined', { roomJid: ROOM, joined: false })
      confirmRoomJoin()

      await vi.waitFor(() => {
        expect(loadSpy.mock.calls.filter(([jid]) => jid === ROOM)).toHaveLength(2)
      })

      staleCache.resolve([])
      await Promise.resolve()
      await Promise.resolve()
      expect(mockClient.internal.mam.catchUpRoomHistory).not.toHaveBeenCalled()
      expect(roomStore.getState().getRoomMAMQueryState(ROOM).isLoading).toBe(true)

      replacementCache.resolve([])
      await vi.waitFor(() => {
        expect(mockClient.internal.mam.catchUpRoomHistory).toHaveBeenCalledTimes(1)
      })
      loadSpy.mockRestore()
    })

    it('disposes a pending hydration before replacement side effects take ownership', async () => {
      const staleCache = deferred<[]>()
      const replacementCache = deferred<[]>()
      roomStore.getState().addRoom({
        jid: ROOM,
        name: 'Test Room',
        nickname: 'testuser',
        joined: false,
        supportsMAM: true,
        occupants: new Map(),
        messages: [],
        unreadCount: 0,
        mentionsCount: 0,
        typingUsers: new Set(),
        isBookmarked: true,
      })
      roomStore.getState().setActiveRoom(ROOM)
      const loadSpy = vi.spyOn(
        roomStore.getState(),
        'loadMessagesFromCache',
      )
        .mockReturnValueOnce(staleCache.promise)
        .mockReturnValueOnce(replacementCache.promise)

      cleanup = setupRoomSideEffects(mockClient)
      simulateFreshSession(mockClient)
      confirmRoomJoin()
      expect(roomStore.getState().getRoomMAMQueryState(ROOM).isLoading).toBe(true)

      cleanup()
      cleanup = setupRoomSideEffects(mockClient)
      simulateFreshSession(mockClient)
      roomStore.getState().markAllRoomsNotJoined()
      confirmRoomJoin()
      expect(roomStore.getState().getRoomMAMQueryState(ROOM).isLoading).toBe(true)

      staleCache.resolve([])
      await Promise.resolve()
      await Promise.resolve()

      expect(mockClient.internal.mam.catchUpRoomHistory).not.toHaveBeenCalled()
      expect(roomStore.getState().getRoomMAMQueryState(ROOM).isLoading).toBe(true)

      replacementCache.resolve([])
      await vi.waitFor(() => {
        expect(mockClient.internal.mam.catchUpRoomHistory).toHaveBeenCalledTimes(1)
      })

      loadSpy.mockRestore()
    })

    it('aborts before MAM when the room leaves during cache hydration', async () => {
      const cache = deferred<[]>()
      roomStore.getState().addRoom({
        jid: ROOM,
        name: 'Test Room',
        nickname: 'testuser',
        joined: false,
        supportsMAM: true,
        occupants: new Map(),
        messages: [],
        unreadCount: 0,
        mentionsCount: 0,
        typingUsers: new Set(),
        isBookmarked: true,
      })
      roomStore.getState().setActiveRoom(ROOM)
      cleanup = setupRoomSideEffects(mockClient)
      simulateFreshSession(mockClient)

      const loadSpy = vi.spyOn(
        roomStore.getState(),
        'loadMessagesFromCache',
      ).mockReturnValue(cache.promise)

      confirmRoomJoin()
      expect(roomStore.getState().getRoomMAMQueryState(ROOM).isLoading).toBe(true)

      roomStore.getState().setRoomJoined(ROOM, false)
      cache.resolve([])

      await vi.waitFor(() => {
        expect(roomStore.getState().getRoomMAMQueryState(ROOM).isLoading).toBe(false)
      })
      expect(mockClient.internal.mam.catchUpRoomHistory).not.toHaveBeenCalled()

      loadSpy.mockResolvedValue([])
      roomStore.getState().setRoomJoined(ROOM, true)
      mockClient._emitSDK('room:joined', { roomJid: ROOM, joined: true })

      await vi.waitFor(() => {
        expect(mockClient.internal.mam.catchUpRoomHistory).toHaveBeenCalledTimes(1)
      })

      loadSpy.mockRestore()
    })

    it('aborts before MAM when the connection drops during cache hydration', async () => {
      const cache = deferred<[]>()
      roomStore.getState().addRoom({
        jid: ROOM,
        name: 'Test Room',
        nickname: 'testuser',
        joined: false,
        supportsMAM: true,
        occupants: new Map(),
        messages: [],
        unreadCount: 0,
        mentionsCount: 0,
        typingUsers: new Set(),
        isBookmarked: true,
      })
      roomStore.getState().setActiveRoom(ROOM)
      cleanup = setupRoomSideEffects(mockClient)
      simulateFreshSession(mockClient)

      const loadSpy = vi.spyOn(
        roomStore.getState(),
        'loadMessagesFromCache',
      ).mockReturnValue(cache.promise)

      confirmRoomJoin()

      connectionStore.getState().setStatus('reconnecting')
      cache.resolve([])

      await vi.waitFor(() => {
        expect(roomStore.getState().getRoomMAMQueryState(ROOM).isLoading).toBe(false)
      })
      expect(mockClient.internal.mam.catchUpRoomHistory).not.toHaveBeenCalled()

      loadSpy.mockRestore()
    })

    it('aborts before MAM when another room becomes active during cache hydration', async () => {
      const cache = deferred<[]>()
      const OTHER = 'other@conference.example.com'
      roomStore.getState().addRoom({
        jid: ROOM,
        name: 'Test Room',
        nickname: 'testuser',
        joined: false,
        supportsMAM: true,
        occupants: new Map(),
        messages: [],
        unreadCount: 0,
        mentionsCount: 0,
        typingUsers: new Set(),
        isBookmarked: true,
      })
      roomStore.getState().addRoom({
        jid: OTHER,
        name: 'Other Room',
        nickname: 'testuser',
        joined: false,
        supportsMAM: false,
        occupants: new Map(),
        messages: [],
        unreadCount: 0,
        mentionsCount: 0,
        typingUsers: new Set(),
        isBookmarked: true,
      })
      roomStore.getState().setActiveRoom(ROOM)
      cleanup = setupRoomSideEffects(mockClient)
      simulateFreshSession(mockClient)

      const loadSpy = vi.spyOn(
        roomStore.getState(),
        'loadMessagesFromCache',
      ).mockImplementation((roomJid) => {
        return roomJid === ROOM ? cache.promise : Promise.resolve([])
      })

      confirmRoomJoin()
      roomStore.getState().setActiveRoom(OTHER)
      cache.resolve([])

      await vi.waitFor(() => {
        expect(roomStore.getState().getRoomMAMQueryState(ROOM).isLoading).toBe(false)
      })
      expect(mockClient.internal.mam.catchUpRoomHistory).not.toHaveBeenCalledWith(
        ROOM,
        expect.anything(),
        expect.anything(),
      )

      loadSpy.mockRestore()
    })

    it('lets only the replacement attempt query or clear loading after a fresh-session retry', async () => {
      const cacheA = deferred<[]>()
      const cacheB = deferred<[]>()
      roomStore.getState().addRoom({
        jid: ROOM,
        name: 'Test Room',
        nickname: 'testuser',
        joined: false,
        supportsMAM: true,
        occupants: new Map(),
        messages: [],
        unreadCount: 0,
        mentionsCount: 0,
        typingUsers: new Set(),
        isBookmarked: true,
      })
      roomStore.getState().setActiveRoom(ROOM)
      cleanup = setupRoomSideEffects(mockClient)
      simulateFreshSession(mockClient)

      const loadSpy = vi.spyOn(
        roomStore.getState(),
        'loadMessagesFromCache',
      )
        .mockReturnValueOnce(cacheA.promise)
        .mockReturnValueOnce(cacheB.promise)
      vi.mocked(mockClient.internal.mam.catchUpRoomHistory)
        .mockImplementation(async (roomJid: string) => {
          // Mirror the real MAM module's successful loading-state event.
          roomStore.getState().setRoomMAMLoading(roomJid, false)
        })

      // Attempt A starts after the first confirmed join and pauses in hydration.
      confirmRoomJoin()
      expect(loadSpy).toHaveBeenCalledTimes(1)
      expect(roomStore.getState().getRoomMAMQueryState(ROOM).isLoading).toBe(true)

      // Fresh-session setup resets MAM state, so the confirmed rejoin can start B.
      connectionStore.getState().setStatus('reconnecting')
      simulateFreshSession(mockClient)
      roomStore.getState().resetRoomMAMStates()
      roomStore.getState().markAllRoomsNotJoined()
      confirmRoomJoin()
      expect(loadSpy).toHaveBeenCalledTimes(2)
      expect(roomStore.getState().getRoomMAMQueryState(ROOM).isLoading).toBe(true)

      cacheA.resolve([])
      await cacheA.promise

      expect(mockClient.internal.mam.catchUpRoomHistory).not.toHaveBeenCalled()
      expect(roomStore.getState().getRoomMAMQueryState(ROOM).isLoading).toBe(true)

      cacheB.resolve([])
      await vi.waitFor(() => {
        expect(mockClient.internal.mam.catchUpRoomHistory).toHaveBeenCalledTimes(1)
      })
      expect(roomStore.getState().getRoomMAMQueryState(ROOM).isLoading).toBe(false)

      loadSpy.mockRestore()
    })

    it('prevents a superseded cache failure from clearing replacement loading state', async () => {
      const cacheA = deferred<[]>()
      const cacheB = deferred<[]>()
      roomStore.getState().addRoom({
        jid: ROOM,
        name: 'Test Room',
        nickname: 'testuser',
        joined: false,
        supportsMAM: true,
        occupants: new Map(),
        messages: [],
        unreadCount: 0,
        mentionsCount: 0,
        typingUsers: new Set(),
        isBookmarked: true,
      })
      roomStore.getState().setActiveRoom(ROOM)
      cleanup = setupRoomSideEffects(mockClient)
      simulateFreshSession(mockClient)

      const loadSpy = vi.spyOn(
        roomStore.getState(),
        'loadMessagesFromCache',
      )
        .mockReturnValueOnce(cacheA.promise)
        .mockReturnValueOnce(cacheB.promise)

      confirmRoomJoin()
      connectionStore.getState().setStatus('reconnecting')
      simulateFreshSession(mockClient)
      roomStore.getState().resetRoomMAMStates()
      roomStore.getState().markAllRoomsNotJoined()
      confirmRoomJoin()

      cacheA.reject(new Error('stale cache failure'))
      await cacheA.promise.catch(() => {})

      expect(roomStore.getState().getRoomMAMQueryState(ROOM).isLoading).toBe(true)
      expect(mockClient.internal.mam.catchUpRoomHistory).not.toHaveBeenCalled()

      cacheB.resolve([])
      await vi.waitFor(() => {
        expect(mockClient.internal.mam.catchUpRoomHistory).toHaveBeenCalledTimes(1)
      })

      loadSpy.mockRestore()
    })
  })

  describe('reconnection', () => {
    it('waits for a fresh-session room:joined before catching up a hydrated active room', async () => {
      roomStore.getState().addRoom({
        jid: ROOM,
        name: 'Test Room',
        nickname: 'testuser',
        joined: true, // hydrated SM snapshot, not confirmed in the new stream
        supportsMAM: true,
        occupants: new Map(),
        messages: [],
        unreadCount: 0,
        mentionsCount: 0,
        typingUsers: new Set(),
        isBookmarked: true,
      })
      roomStore.getState().setActiveRoom(ROOM)
      connectionStore.getState().setStatus('disconnected')
      cleanup = setupRoomSideEffects(mockClient)

      simulateFreshSession(mockClient)
      await new Promise(resolve => setTimeout(resolve, 50))

      expect(mockClient.internal.mam.catchUpRoomHistory).not.toHaveBeenCalled()

      roomStore.getState().markAllRoomsNotJoined()
      confirmRoomJoin()

      await vi.waitFor(() => {
        expect(mockClient.internal.mam.catchUpRoomHistory).toHaveBeenCalledTimes(1)
      })
      expect(mockClient.internal.mam.catchUpRoomHistory).toHaveBeenCalledWith(
        ROOM,
        expect.any(Array),
        expect.objectContaining({ sessionStartTime: expect.any(Number) }),
      )
    })

    it('should trigger MAM catchup on reconnection for active room', async () => {
      roomStore.getState().addRoom({
        jid: 'room@conference.example.com',
        name: 'Test Room',
        nickname: 'testuser',
        joined: true,
        supportsMAM: true,
        occupants: new Map(),
        messages: [],
        unreadCount: 0,
        mentionsCount: 0,
        typingUsers: new Set(),
        isBookmarked: true,
      })

      roomStore.getState().setActiveRoom('room@conference.example.com')

      connectionStore.getState().setStatus('disconnected')
      cleanup = setupRoomSideEffects(mockClient)

      simulateFreshSession(mockClient)
      roomStore.getState().markAllRoomsNotJoined()
      confirmRoomJoin()

      await vi.waitFor(() => {
        expect(mockClient.internal.mam.catchUpRoomHistory).toHaveBeenCalledWith(
          'room@conference.example.com',
          expect.any(Array),
          expect.objectContaining({}),
        )
      })
    })

    it('should use forward query (start) when cache has messages after reconnection', async () => {
      const cachedTimestamp = new Date('2026-02-15T10:00:00Z')

      roomStore.getState().addRoom({
        jid: 'room@conference.example.com',
        name: 'Test Room',
        nickname: 'testuser',
        joined: true,
        supportsMAM: true,
        occupants: new Map(),
        messages: [],
        unreadCount: 0,
        mentionsCount: 0,
        typingUsers: new Set(),
        isBookmarked: true,
      })

      roomStore.getState().setActiveRoom('room@conference.example.com')

      // Mock loadMessagesFromCache to simulate populating the store with a cached message
      const cachedMsg = {
        type: 'groupchat' as const,
        id: 'cached-msg-1',
        roomJid: 'room@conference.example.com',
        from: 'room@conference.example.com/alice',
        nick: 'alice',
        body: 'Cached message',
        timestamp: cachedTimestamp,
        isOutgoing: false,
      }
      const loadSpy = vi.spyOn(roomStore.getState(), 'loadMessagesFromCache')
        .mockImplementation(async (roomJid: string) => {
          const room = roomStore.getState().rooms.get(roomJid)
          if (room) {
            roomStore.getState().updateRoom(roomJid, {
              messages: [cachedMsg],
            })
          }
          return [cachedMsg]
        })

      connectionStore.getState().setStatus('disconnected')
      cleanup = setupRoomSideEffects(mockClient)

      simulateFreshSession(mockClient)
      roomStore.getState().markAllRoomsNotJoined()
      confirmRoomJoin()

      // Cursor-policy specifics (start vs after) are covered by the orchestrator
      // and mamCatchUpUtils tests; this asserts delegation with the cached message.
      await vi.waitFor(() => {
        expect(mockClient.internal.mam.catchUpRoomHistory).toHaveBeenCalledWith(
          'room@conference.example.com',
          expect.arrayContaining([expect.objectContaining({ id: 'cached-msg-1' })]),
          expect.objectContaining({}),
        )
      })

      loadSpy.mockRestore()
    })

    it('uses the newest PRE-session message as the catch-up cursor, ignoring a live message from this session', async () => {
      // Regression for the silent month-long gap: after a long offline period the
      // active room's cache ends a month ago; a live message lands during catch-up.
      // The forward cursor must be the month-old message, not the live one.
      const monthOld = new Date(Date.now() - 30 * 86_400_000)
      const liveThisSession = new Date(Date.now() + 60_000) // clearly after sessionStart

      roomStore.getState().addRoom({
        jid: 'room@conference.example.com',
        name: 'Test Room',
        nickname: 'testuser',
        joined: true,
        supportsMAM: true,
        occupants: new Map(),
        messages: [],
        unreadCount: 0,
        mentionsCount: 0,
        typingUsers: new Set(),
        isBookmarked: true,
      })

      roomStore.getState().setActiveRoom('room@conference.example.com')

      const messages = [
        { type: 'groupchat' as const, id: 'old', roomJid: 'room@conference.example.com', from: 'room@conference.example.com/alice', nick: 'alice', body: 'month-old', timestamp: monthOld, isOutgoing: false },
        { type: 'groupchat' as const, id: 'live', roomJid: 'room@conference.example.com', from: 'room@conference.example.com/bob', nick: 'bob', body: 'live', timestamp: liveThisSession, isOutgoing: false },
      ]
      const loadSpy = vi.spyOn(roomStore.getState(), 'loadMessagesFromCache')
        .mockImplementation(async (roomJid: string) => {
          const room = roomStore.getState().rooms.get(roomJid)
          if (room) roomStore.getState().updateRoom(roomJid, { messages })
          return messages
        })

      connectionStore.getState().setStatus('disconnected')
      cleanup = setupRoomSideEffects(mockClient)

      simulateFreshSession(mockClient)
      roomStore.getState().markAllRoomsNotJoined()
      confirmRoomJoin()

      // Ignoring the this-session live message is now the orchestrator's job
      // (selectCatchUpQuery's sessionStartTime handling, covered in
      // mamCatchUpUtils.test.ts / MAM.catchup.test.ts). This asserts the side
      // effect forwards BOTH cached messages and a concrete sessionStartTime.
      await vi.waitFor(() => {
        expect(mockClient.internal.mam.catchUpRoomHistory).toHaveBeenCalledWith(
          'room@conference.example.com',
          expect.arrayContaining([
            expect.objectContaining({ id: 'old' }),
            expect.objectContaining({ id: 'live' }),
          ]),
          expect.objectContaining({ sessionStartTime: expect.any(Number) }),
        )
      })

      loadSpy.mockRestore()
    })

    it('should use backward query (before) when cache is empty after reconnection', async () => {
      roomStore.getState().addRoom({
        jid: 'room@conference.example.com',
        name: 'Test Room',
        nickname: 'testuser',
        joined: true,
        supportsMAM: true,
        occupants: new Map(),
        messages: [],
        unreadCount: 0,
        mentionsCount: 0,
        typingUsers: new Set(),
        isBookmarked: true,
      })

      roomStore.getState().setActiveRoom('room@conference.example.com')

      connectionStore.getState().setStatus('disconnected')
      cleanup = setupRoomSideEffects(mockClient)

      simulateFreshSession(mockClient)
      roomStore.getState().markAllRoomsNotJoined()
      confirmRoomJoin()

      // Empty cache → delegates with an empty messages array; the orchestrator
      // resolves the fetch-latest fallback (covered by orchestrator tests).
      await vi.waitFor(() => {
        expect(mockClient.internal.mam.catchUpRoomHistory).toHaveBeenCalledWith(
          'room@conference.example.com',
          [],
          expect.objectContaining({}),
        )
      })
    })
  })

  describe('room:joined SDK event', () => {
    it('should trigger MAM fetch when room:joined fires for active room', async () => {
      roomStore.getState().addRoom({
        jid: 'room@conference.example.com',
        name: 'Test Room',
        nickname: 'testuser',
        joined: false,
        supportsMAM: true,
        occupants: new Map(),
        messages: [],
        unreadCount: 0,
        mentionsCount: 0,
        typingUsers: new Set(),
        isBookmarked: false,
      })

      roomStore.getState().setActiveRoom('room@conference.example.com')

      cleanup = setupRoomSideEffects(mockClient)
      simulateFreshSession(mockClient)

      // Room wasn't joined yet, so initial MAM fetch was skipped
      await new Promise(resolve => setTimeout(resolve, 50))
      expect(mockClient.internal.mam.catchUpRoomHistory).not.toHaveBeenCalled()

      // Self-presence arrives — room is now joined
      roomStore.getState().setRoomJoined('room@conference.example.com', true)
      mockClient._emitSDK('room:joined', { roomJid: 'room@conference.example.com', joined: true })

      await vi.waitFor(() => {
        expect(mockClient.internal.mam.catchUpRoomHistory).toHaveBeenCalledWith(
          'room@conference.example.com',
          expect.any(Array),
          expect.objectContaining({}),
        )
      })
    })

    it('should NOT trigger MAM when room:joined fires for non-active room', async () => {
      roomStore.getState().addRoom({
        jid: 'active-room@conference.example.com',
        name: 'Active Room',
        nickname: 'testuser',
        joined: true,
        supportsMAM: true,
        occupants: new Map(),
        messages: [],
        unreadCount: 0,
        mentionsCount: 0,
        typingUsers: new Set(),
        isBookmarked: true,
      })

      roomStore.getState().addRoom({
        jid: 'other-room@conference.example.com',
        name: 'Other Room',
        nickname: 'testuser',
        joined: false,
        supportsMAM: true,
        occupants: new Map(),
        messages: [],
        unreadCount: 0,
        mentionsCount: 0,
        typingUsers: new Set(),
        isBookmarked: true,
      })

      roomStore.getState().setActiveRoom('active-room@conference.example.com')

      cleanup = setupRoomSideEffects(mockClient)
      simulateFreshSession(mockClient)
      roomStore.getState().markAllRoomsNotJoined()
      confirmRoomJoin('active-room@conference.example.com')

      // Wait for confirmed active-room MAM fetch.
      await vi.waitFor(() => {
        expect(mockClient.internal.mam.catchUpRoomHistory).toHaveBeenCalledTimes(1)
      })
      ;(mockClient.internal.mam.catchUpRoomHistory as ReturnType<typeof vi.fn>).mockClear()

      // Non-active room joins — should not trigger MAM
      confirmRoomJoin('other-room@conference.example.com')

      await new Promise(resolve => setTimeout(resolve, 50))
      expect(mockClient.internal.mam.catchUpRoomHistory).not.toHaveBeenCalled()
    })

    it('should NOT trigger MAM when room:joined fires with joined=false (leaving)', async () => {
      roomStore.getState().addRoom({
        jid: 'room@conference.example.com',
        name: 'Test Room',
        nickname: 'testuser',
        joined: true,
        supportsMAM: true,
        occupants: new Map(),
        messages: [],
        unreadCount: 0,
        mentionsCount: 0,
        typingUsers: new Set(),
        isBookmarked: true,
      })

      roomStore.getState().setActiveRoom('room@conference.example.com')

      cleanup = setupRoomSideEffects(mockClient)
      simulateFreshSession(mockClient)
      roomStore.getState().markAllRoomsNotJoined()
      confirmRoomJoin()

      await vi.waitFor(() => {
        expect(mockClient.internal.mam.catchUpRoomHistory).toHaveBeenCalledTimes(1)
      })
      ;(mockClient.internal.mam.catchUpRoomHistory as ReturnType<typeof vi.fn>).mockClear()

      // Room leaves — should not trigger MAM
      mockClient._emitSDK('room:joined', { roomJid: 'room@conference.example.com', joined: false })

      await new Promise(resolve => setTimeout(resolve, 50))
      expect(mockClient.internal.mam.catchUpRoomHistory).not.toHaveBeenCalled()
    })
  })

  describe('SM resumption', () => {
    it('should NOT trigger MAM catchup on SM resumption for active room', async () => {
      roomStore.getState().addRoom({
        jid: 'room@conference.example.com',
        name: 'Test Room',
        nickname: 'testuser',
        joined: true,
        supportsMAM: true,
        occupants: new Map(),
        messages: [],
        unreadCount: 0,
        mentionsCount: 0,
        typingUsers: new Set(),
        isBookmarked: true,
      })

      roomStore.getState().setActiveRoom('room@conference.example.com')

      connectionStore.getState().setStatus('disconnected')
      cleanup = setupRoomSideEffects(mockClient)

      // SM resumption instead of fresh session
      simulateSmResumption(mockClient)

      await new Promise(resolve => setTimeout(resolve, 50))
      expect(mockClient.internal.mam.catchUpRoomHistory).not.toHaveBeenCalled()
    })

    it('triggers MAM when supportsMAM becomes true after SM resumption for a never-fetched room', async () => {
      // SM resume must NOT mark a never-fetched room caught up: supportsMAM was false
      // so its archive was never queried, and the SM queue has nothing to replay for
      // it. When MAM support is discovered the archive must be fetched for the first
      // time (the "archive not retrieved after a reconnect" bug).
      roomStore.getState().addRoom({
        jid: 'room@conference.example.com',
        name: 'Test Room',
        nickname: 'testuser',
        joined: true,
        supportsMAM: false,
        occupants: new Map(),
        messages: [],
        unreadCount: 0,
        mentionsCount: 0,
        typingUsers: new Set(),
        isBookmarked: true,
      })

      roomStore.getState().setActiveRoom('room@conference.example.com')

      cleanup = setupRoomSideEffects(mockClient)

      // SM resumption: room is empty + never queried -> NOT seeded into fetchInitiated.
      simulateSmResumption(mockClient)

      roomStore.getState().updateRoom('room@conference.example.com', {
        supportsMAM: true,
      })

      await vi.waitFor(() => {
        expect(mockClient.internal.mam.catchUpRoomHistory).toHaveBeenCalledWith(
          'room@conference.example.com',
          expect.any(Array),
          expect.objectContaining({}),
        )
      })
    })

    it('triggers MAM when room:joined fires after SM resumption for a never-fetched room', async () => {
      // A bookmarked room autojoined in the background but never opened has no archive.
      // After an SM resume its (possibly belated) room:joined must still fetch the
      // archive on first activation — the resume seeding must not suppress it.
      roomStore.getState().addRoom({
        jid: 'room@conference.example.com',
        name: 'Test Room',
        nickname: 'testuser',
        joined: false,
        supportsMAM: true,
        occupants: new Map(),
        messages: [],
        unreadCount: 0,
        mentionsCount: 0,
        typingUsers: new Set(),
        isBookmarked: true,
      })

      roomStore.getState().setActiveRoom('room@conference.example.com')

      cleanup = setupRoomSideEffects(mockClient)

      // SM resumption: room is empty + never queried -> NOT seeded into fetchInitiated.
      simulateSmResumption(mockClient)

      // Server replays self-presence during SM resumption.
      roomStore.getState().setRoomJoined('room@conference.example.com', true)
      mockClient._emitSDK('room:joined', { roomJid: 'room@conference.example.com', joined: true })

      await vi.waitFor(() => {
        expect(mockClient.internal.mam.catchUpRoomHistory).toHaveBeenCalledWith(
          'room@conference.example.com',
          expect.any(Array),
          expect.objectContaining({}),
        )
      })
    })

    it('preserves resume-seeded archive tracking across synthetic online', async () => {
      const resident = {
        type: 'groupchat' as const,
        id: 'm1',
        roomJid: ROOM,
        from: `${ROOM}/alice`,
        nick: 'alice',
        body: 'hi',
        timestamp: new Date('2026-02-04T12:00:00Z'),
        isOutgoing: false,
      }
      roomStore.getState().addRoom({
        jid: ROOM,
        name: 'Test Room',
        nickname: 'testuser',
        joined: true,
        supportsMAM: true,
        occupants: new Map(),
        messages: [resident],
        unreadCount: 0,
        mentionsCount: 0,
        typingUsers: new Set(),
        isBookmarked: true,
      })
      roomStore.getState().setActiveRoom(ROOM)
      cleanup = setupRoomSideEffects(mockClient)

      simulateSmResumption(mockClient)
      roomStore.getState().markAllRoomsNotJoined()
      confirmRoomJoin()
      mockClient._emit('online')

      mockClient._emitSDK('room:joined', { roomJid: ROOM, joined: true })
      expect(mockClient.internal.mam.catchUpRoomHistory).not.toHaveBeenCalled()

      connectionStore.getState().setStatus('reconnecting')
      simulateFreshSession(mockClient)
      roomStore.getState().markAllRoomsNotJoined()
      confirmRoomJoin()

      await vi.waitFor(() => {
        expect(mockClient.internal.mam.catchUpRoomHistory).toHaveBeenCalledTimes(1)
      })
    })

    it('preserves a confirmed join across the uninterrupted post-resume synthetic online', async () => {
      const cache = deferred<[]>()
      roomStore.getState().addRoom({
        jid: ROOM,
        name: 'Test Room',
        nickname: 'testuser',
        joined: false,
        supportsMAM: true,
        occupants: new Map(),
        messages: [],
        unreadCount: 0,
        mentionsCount: 0,
        typingUsers: new Set(),
        isBookmarked: true,
      })
      roomStore.getState().setActiveRoom(ROOM)
      cleanup = setupRoomSideEffects(mockClient)

      simulateSmResumption(mockClient)
      const loadSpy = vi.spyOn(
        roomStore.getState(),
        'loadMessagesFromCache',
      ).mockReturnValue(cache.promise)

      // A missing cache marker upgrades this uninterrupted resume to fresh setup.
      // Its rejoin self-presence arrives before SessionLifecycle emits synthetic online.
      confirmRoomJoin()
      expect(roomStore.getState().getRoomMAMQueryState(ROOM).isLoading).toBe(true)
      mockClient._emit('online')

      cache.resolve([])

      await vi.waitFor(() => {
        expect(mockClient.internal.mam.catchUpRoomHistory).toHaveBeenCalledTimes(1)
      })
      expect(mockClient.internal.mam.catchUpRoomHistory).toHaveBeenCalledWith(
        ROOM,
        expect.any(Array),
        expect.objectContaining({ sessionStartTime: expect.any(Number) }),
      )

      roomStore.getState().setRoomMAMLoading(ROOM, false)
      mockClient._emitSDK('room:joined', { roomJid: ROOM, joined: true })
      expect(roomStore.getState().getRoomMAMQueryState(ROOM).isLoading).toBe(false)
      expect(mockClient.internal.mam.catchUpRoomHistory).toHaveBeenCalledTimes(1)

      // A later fresh transport session must not inherit that confirmation.
      connectionStore.getState().setStatus('reconnecting')
      simulateFreshSession(mockClient)
      vi.mocked(mockClient.internal.mam.catchUpRoomHistory).mockClear()

      roomStore.getState().updateRoom(ROOM, { supportsMAM: false })
      roomStore.getState().updateRoom(ROOM, { supportsMAM: true })
      await Promise.resolve()
      expect(mockClient.internal.mam.catchUpRoomHistory).not.toHaveBeenCalled()

      roomStore.getState().markAllRoomsNotJoined()
      confirmRoomJoin()
      await vi.waitFor(() => {
        expect(mockClient.internal.mam.catchUpRoomHistory).toHaveBeenCalledTimes(1)
      })

      loadSpy.mockRestore()
    })

    it('retains an empty-archive resume proof across synthetic online and re-entry', async () => {
      roomStore.getState().addRoom({
        jid: ROOM,
        name: 'Test Room',
        nickname: 'testuser',
        joined: true,
        supportsMAM: true,
        occupants: new Map(),
        messages: [],
        unreadCount: 0,
        mentionsCount: 0,
        typingUsers: new Set(),
        isBookmarked: true,
      })
      roomStore.setState((state) => ({
        mamQueryStates: new Map(state.mamQueryStates).set(ROOM, {
          isLoading: false,
          error: null,
          hasQueried: true,
          isHistoryComplete: true,
          isCaughtUpToLive: true,
        }),
      }))
      roomStore.getState().setActiveRoom(ROOM)
      cleanup = setupRoomSideEffects(mockClient)

      simulateSmResumption(mockClient)
      roomStore.getState().resetRoomMAMStates()
      roomStore.getState().markAllRoomsNotJoined()
      confirmRoomJoin()
      mockClient._emit('online')

      roomStore.getState().setActiveRoom(null)
      roomStore.getState().setActiveRoom(ROOM)
      await Promise.resolve()
      await Promise.resolve()

      expect(mockClient.internal.mam.catchUpRoomHistory).not.toHaveBeenCalled()
    })

    it('retains the resume boundary when hydration finishes after synthetic online', async () => {
      const cache = deferred<[]>()
      const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(1_754_000_000_000)
      roomStore.getState().addRoom({
        jid: ROOM,
        name: 'Test Room',
        nickname: 'testuser',
        joined: false,
        supportsMAM: true,
        occupants: new Map(),
        messages: [],
        unreadCount: 0,
        mentionsCount: 0,
        typingUsers: new Set(),
        isBookmarked: true,
      })
      roomStore.getState().setActiveRoom(ROOM)
      cleanup = setupRoomSideEffects(mockClient)
      const loadSpy = vi.spyOn(
        roomStore.getState(),
        'loadMessagesFromCache',
      ).mockReturnValue(cache.promise)

      simulateSmResumption(mockClient)
      confirmRoomJoin()
      nowSpy.mockReturnValue(1_754_000_005_000)
      mockClient._emit('online')
      cache.resolve([])

      await vi.waitFor(() => {
        expect(mockClient.internal.mam.catchUpRoomHistory).toHaveBeenCalledWith(
          ROOM,
          expect.any(Array),
          expect.objectContaining({ sessionStartTime: 1_754_000_000_000 }),
        )
      })

      loadSpy.mockRestore()
      nowSpy.mockRestore()
    })

    it('does NOT re-trigger MAM after SM resumption for a room whose archive we already hold', async () => {
      // A room with resident messages IS caught up: SM resume seeds it into
      // fetchInitiated, so a belated room:joined skips the redundant MAM query.
      const resident = {
        type: 'groupchat' as const,
        id: 'm1',
        roomJid: 'room@conference.example.com',
        from: 'room@conference.example.com/alice',
        nick: 'alice',
        body: 'hi',
        timestamp: new Date('2026-02-04T12:00:00Z'),
        isOutgoing: false,
      }
      roomStore.getState().addRoom({
        jid: 'room@conference.example.com',
        name: 'Test Room',
        nickname: 'testuser',
        joined: true,
        supportsMAM: true,
        occupants: new Map(),
        messages: [resident],
        unreadCount: 0,
        mentionsCount: 0,
        typingUsers: new Set(),
        isBookmarked: true,
      })

      roomStore.getState().setActiveRoom('room@conference.example.com')

      cleanup = setupRoomSideEffects(mockClient)

      // SM resumption: room holds an archive -> seeded into fetchInitiated.
      simulateSmResumption(mockClient)

      mockClient._emitSDK('room:joined', { roomJid: 'room@conference.example.com', joined: true })

      await new Promise(resolve => setTimeout(resolve, 50))
      expect(mockClient.internal.mam.catchUpRoomHistory).not.toHaveBeenCalled()
    })

    it('does NOT trigger MAM on a post-resumption room:joined for a NON-ACTIVE room', async () => {
      // Two rooms joined, only room1 active. A belated room:joined for the non-active
      // room2 must not fetch its archive (it is not the foreground room) — independent
      // of whether the resume seeded it.
      roomStore.getState().addRoom({
        jid: 'room1@conference.example.com',
        name: 'Room 1',
        nickname: 'testuser',
        joined: true,
        supportsMAM: true,
        occupants: new Map(),
        messages: [],
        unreadCount: 0,
        mentionsCount: 0,
        typingUsers: new Set(),
        isBookmarked: true,
      })
      roomStore.getState().addRoom({
        jid: 'room2@conference.example.com',
        name: 'Room 2',
        nickname: 'testuser',
        joined: true,
        supportsMAM: true,
        occupants: new Map(),
        messages: [],
        unreadCount: 0,
        mentionsCount: 0,
        typingUsers: new Set(),
        isBookmarked: true,
      })

      roomStore.getState().setActiveRoom('room1@conference.example.com')

      cleanup = setupRoomSideEffects(mockClient)

      simulateSmResumption(mockClient)

      // room:joined for the non-active room (from rejoin flow after SM resume).
      roomStore.getState().setRoomJoined('room2@conference.example.com', true)
      mockClient._emitSDK('room:joined', { roomJid: 'room2@conference.example.com', joined: true })

      await new Promise(resolve => setTimeout(resolve, 50))

      // room2 is not the active room, so no foreground catch-up is needed.
      expect(mockClient.internal.mam.catchUpRoomHistory).not.toHaveBeenCalled()
    })

    it('should trigger MAM correctly after SM resume then fresh session', async () => {
      roomStore.getState().addRoom({
        jid: 'room@conference.example.com',
        name: 'Test Room',
        nickname: 'testuser',
        joined: true,
        supportsMAM: true,
        occupants: new Map(),
        messages: [],
        unreadCount: 0,
        mentionsCount: 0,
        typingUsers: new Set(),
        isBookmarked: true,
      })

      roomStore.getState().setActiveRoom('room@conference.example.com')

      cleanup = setupRoomSideEffects(mockClient)

      // First: SM resumption — no MAM
      simulateSmResumption(mockClient)

      await new Promise(resolve => setTimeout(resolve, 50))
      expect(mockClient.internal.mam.catchUpRoomHistory).not.toHaveBeenCalled()

      // Then: disconnect and fresh session — wait for a confirmed room join.
      connectionStore.getState().setStatus('reconnecting')
      simulateFreshSession(mockClient)

      await new Promise(resolve => setTimeout(resolve, 50))
      expect(mockClient.internal.mam.catchUpRoomHistory).not.toHaveBeenCalled()

      roomStore.getState().markAllRoomsNotJoined()
      confirmRoomJoin()

      await vi.waitFor(() => {
        expect(mockClient.internal.mam.catchUpRoomHistory).toHaveBeenCalledWith(
          'room@conference.example.com',
          expect.any(Array),
          expect.objectContaining({}),
        )
      })
    })
  })

  describe('first-open archive fetch after reconnect (autojoin / bookmark)', () => {
    // Autojoin (and double-clicking a not-yet-joined bookmark) joins a room in the
    // BACKGROUND — it is not the active room, so the room:joined trigger is skipped
    // and its archive is fetched lazily on first open. An SM resume in between must
    // not mark such a never-fetched room "caught up" and suppress that first fetch.
    const ROOM = 'autojoined@conference.example.com'

    function addBackgroundRoom() {
      roomStore.getState().addRoom({
        jid: ROOM,
        name: 'Autojoined Room',
        nickname: 'me',
        joined: false,
        supportsMAM: true,
        occupants: new Map(),
        messages: [],
        unreadCount: 0,
        mentionsCount: 0,
        typingUsers: new Set(),
        isBookmarked: true,
        autojoin: true,
      })
    }

    function confirmBackgroundJoin() {
      // self-presence arrives while the room is NOT active (background autojoin).
      roomStore.getState().setRoomJoined(ROOM, true)
      mockClient._emitSDK('room:joined', { roomJid: ROOM, joined: true })
    }

    it('fetches the archive when opening a background-autojoined room (fresh session)', async () => {
      cleanup = setupRoomSideEffects(mockClient)
      simulateFreshSession(mockClient) // online, fetchInitiated cleared, no active room

      addBackgroundRoom()
      confirmBackgroundJoin() // room:joined while NOT active -> trigger skipped

      await roomStore.getState().activateRoom(ROOM)

      await vi.waitFor(() => {
        expect(mockClient.internal.mam.catchUpRoomHistory).toHaveBeenCalledWith(
          ROOM,
          [],
          expect.objectContaining({}),
        )
      })
    })

    it('fetches the archive when opening a background-autojoined room AFTER an SM resume', async () => {
      cleanup = setupRoomSideEffects(mockClient)
      simulateFreshSession(mockClient)

      addBackgroundRoom()
      confirmBackgroundJoin() // joined in background, archive NEVER fetched

      // Network blip -> SM resumption. Must NOT seed this never-fetched room.
      simulateSmResumption(mockClient)

      await roomStore.getState().activateRoom(ROOM)

      await vi.waitFor(() => {
        expect(mockClient.internal.mam.catchUpRoomHistory).toHaveBeenCalledWith(
          ROOM,
          [],
          expect.objectContaining({}),
        )
      })
    })
  })
})
