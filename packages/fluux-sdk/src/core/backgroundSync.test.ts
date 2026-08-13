/**
 * Tests for background sync side effects.
 *
 * Verifies the multi-stage background process that runs after a fresh session:
 * - Conversation catch-up (excluding active conversation)
 * - Roster discovery (hourly cooldown)
 * - Daily archived conversation check
 * - Room catch-up (delayed, excluding active room)
 */
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest'

// Mock localStorage before importing stores
import { localStorageMock } from './sideEffects.testHelpers'

Object.defineProperty(globalThis, 'localStorage', {
  value: localStorageMock,
  writable: true,
})

// Mock messageCache to prevent IndexedDB operations
vi.mock('../utils/messageCache', () => ({
  saveRoomMessage: vi.fn().mockResolvedValue(undefined),
  saveRoomMessages: vi.fn().mockResolvedValue(undefined),
  getRoomMessages: vi.fn().mockResolvedValue([]),
  getRoomMessage: vi.fn().mockResolvedValue(null),
  getRoomMessageByStanzaId: vi.fn().mockResolvedValue(null),
  updateRoomMessage: vi.fn().mockResolvedValue(undefined),
  deleteRoomMessage: vi.fn().mockResolvedValue(undefined),
  deleteRoomMessages: vi.fn().mockResolvedValue(undefined),
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

import { setupBackgroundSyncSideEffects } from './backgroundSync'
import { setupRoomSideEffects } from './roomSideEffects'
import { connectionStore } from '../stores/connectionStore'
import { chatStore } from '../stores/chatStore'
import { roomStore } from '../stores/roomStore'
import { NS_MAM } from './namespaces'
import { createMockClient, simulateFreshSession, simulateSmResumption } from './sideEffects.testHelpers'
import { _resetStorageScopeForTesting } from '../utils/storageScope'
import type { RoomMessage } from './types'

describe('setupBackgroundSyncSideEffects', () => {
  const ARCHIVED_CHECK_KEY = 'fluux:lastArchivedPreviewCheck'
  const ROSTER_DISCOVERY_KEY = 'fluux:lastRosterDiscovery'
  let mockClient: ReturnType<typeof createMockClient>
  let cleanup: () => void
  let roomCleanup: (() => void) | undefined

  beforeEach(() => {
    _resetStorageScopeForTesting()
    connectionStore.getState().reset()
    mockClient = createMockClient()
    localStorageMock.clear()
  })

  afterEach(() => {
    roomCleanup?.()
    roomCleanup = undefined
    cleanup?.()
  })

  describe('conversation catch-up on connect', () => {
    it('should trigger catchUpAllConversations when going online with MAM support', async () => {
      connectionStore.getState().setServerInfo({
        identities: [],
        domain: 'example.com',
        features: [NS_MAM],
      })

      connectionStore.getState().setStatus('disconnected')
      cleanup = setupBackgroundSyncSideEffects(mockClient)

      simulateFreshSession(mockClient)

      await vi.waitFor(() => {
        expect(mockClient.internal.mam.catchUpAllConversations).toHaveBeenCalledTimes(1)
      })
      // Must pass sessionStartTime so the 1:1 forward cursor excludes live messages
      // that arrive during catch-up (parity with rooms / Bug A).
      expect(mockClient.internal.mam.catchUpAllConversations).toHaveBeenCalledWith(
        expect.objectContaining({ sessionStartTime: expect.any(Number) })
      )
    })

    it('should defer catch-up to serverInfo discovery when MAM not immediately available', async () => {
      connectionStore.getState().setStatus('disconnected')
      cleanup = setupBackgroundSyncSideEffects(mockClient)

      simulateFreshSession(mockClient)

      await new Promise(resolve => setTimeout(resolve, 50))
      expect(mockClient.internal.mam.catchUpAllConversations).not.toHaveBeenCalled()

      connectionStore.getState().setServerInfo({
        identities: [],
        domain: 'example.com',
        features: [NS_MAM],
      })

      await vi.waitFor(() => {
        expect(mockClient.internal.mam.catchUpAllConversations).toHaveBeenCalledTimes(1)
      })
    })

    it('should not double-trigger catch-up', async () => {
      connectionStore.getState().setServerInfo({
        identities: [],
        domain: 'example.com',
        features: [NS_MAM],
      })

      connectionStore.getState().setStatus('disconnected')
      cleanup = setupBackgroundSyncSideEffects(mockClient)

      simulateFreshSession(mockClient)

      await vi.waitFor(() => {
        expect(mockClient.internal.mam.catchUpAllConversations).toHaveBeenCalledTimes(1)
      })

      connectionStore.getState().setServerInfo({
        identities: [],
        domain: 'example.com',
        features: [NS_MAM, 'some:other:feature'],
      })

      await new Promise(resolve => setTimeout(resolve, 50))
      expect(mockClient.internal.mam.catchUpAllConversations).toHaveBeenCalledTimes(1)
    })

    it('should reset and re-trigger after disconnect/reconnect cycle', async () => {
      connectionStore.getState().setServerInfo({
        identities: [],
        domain: 'example.com',
        features: [NS_MAM],
      })

      connectionStore.getState().setStatus('disconnected')
      cleanup = setupBackgroundSyncSideEffects(mockClient)

      simulateFreshSession(mockClient)
      await vi.waitFor(() => {
        expect(mockClient.internal.mam.catchUpAllConversations).toHaveBeenCalledTimes(1)
      })

      connectionStore.getState().setStatus('disconnected')

      simulateFreshSession(mockClient)
      await vi.waitFor(() => {
        expect(mockClient.internal.mam.catchUpAllConversations).toHaveBeenCalledTimes(2)
      })
    })

    it('should pass exclude with activeConversationId', async () => {
      // Set active conversation before connecting
      chatStore.getState().setActiveConversation('alice@example.com')

      connectionStore.getState().setServerInfo({
        identities: [],
        domain: 'example.com',
        features: [NS_MAM],
      })

      connectionStore.getState().setStatus('disconnected')
      cleanup = setupBackgroundSyncSideEffects(mockClient)

      simulateFreshSession(mockClient)

      await vi.waitFor(() => {
        expect(mockClient.internal.mam.catchUpAllConversations).toHaveBeenCalledWith(
          expect.objectContaining({ exclude: 'alice@example.com' })
        )
      })

      // Clean up
      chatStore.getState().setActiveConversation(null)
    })

    it('should not call refreshConversationPreviews (removed stage)', async () => {
      connectionStore.getState().setServerInfo({
        identities: [],
        domain: 'example.com',
        features: [NS_MAM],
      })

      connectionStore.getState().setStatus('disconnected')
      cleanup = setupBackgroundSyncSideEffects(mockClient)

      simulateFreshSession(mockClient)

      await vi.waitFor(() => {
        expect(mockClient.internal.mam.catchUpAllConversations).toHaveBeenCalledTimes(1)
      })

      expect(mockClient.internal.mam.refreshConversationPreviews).not.toHaveBeenCalled()
    })
  })

  describe('daily archived check', () => {
    it('should trigger refreshArchivedConversationPreviews on first connect (no localStorage entry)', async () => {
      connectionStore.getState().setServerInfo({
        identities: [],
        domain: 'example.com',
        features: [NS_MAM],
      })

      connectionStore.getState().setStatus('disconnected')
      cleanup = setupBackgroundSyncSideEffects(mockClient)

      simulateFreshSession(mockClient)

      await vi.waitFor(() => {
        expect(mockClient.internal.mam.refreshArchivedConversationPreviews).toHaveBeenCalledTimes(1)
      })
    })

    it('should skip archived check if less than 24h since last check', async () => {
      localStorageMock.setItem(ARCHIVED_CHECK_KEY, String(Date.now() - 1000))

      connectionStore.getState().setServerInfo({
        identities: [],
        domain: 'example.com',
        features: [NS_MAM],
      })

      connectionStore.getState().setStatus('disconnected')
      cleanup = setupBackgroundSyncSideEffects(mockClient)

      simulateFreshSession(mockClient)

      await vi.waitFor(() => {
        expect(mockClient.internal.mam.catchUpAllConversations).toHaveBeenCalledTimes(1)
      })

      await new Promise(resolve => setTimeout(resolve, 50))
      expect(mockClient.internal.mam.refreshArchivedConversationPreviews).not.toHaveBeenCalled()
    })

    it('should trigger archived check after 24h', async () => {
      const staleTimestamp = Date.now() - (25 * 60 * 60 * 1000)
      localStorageMock.setItem(ARCHIVED_CHECK_KEY, String(staleTimestamp))

      connectionStore.getState().setServerInfo({
        identities: [],
        domain: 'example.com',
        features: [NS_MAM],
      })

      connectionStore.getState().setStatus('disconnected')
      cleanup = setupBackgroundSyncSideEffects(mockClient)

      simulateFreshSession(mockClient)

      await vi.waitFor(() => {
        expect(mockClient.internal.mam.refreshArchivedConversationPreviews).toHaveBeenCalledTimes(1)
      })
    })
  })

  describe('roster discovery cooldown', () => {
    it('should trigger discoverNewConversationsFromRoster on first connect (no localStorage entry)', async () => {
      connectionStore.getState().setServerInfo({
        identities: [],
        domain: 'example.com',
        features: [NS_MAM],
      })

      connectionStore.getState().setStatus('disconnected')
      cleanup = setupBackgroundSyncSideEffects(mockClient)

      simulateFreshSession(mockClient)

      await vi.waitFor(() => {
        expect(mockClient.internal.mam.discoverNewConversationsFromRoster).toHaveBeenCalledTimes(1)
      })
    })

    it('should skip roster discovery if less than 1h since last check', async () => {
      localStorageMock.setItem(ROSTER_DISCOVERY_KEY, String(Date.now() - 1000))

      connectionStore.getState().setServerInfo({
        identities: [],
        domain: 'example.com',
        features: [NS_MAM],
      })

      connectionStore.getState().setStatus('disconnected')
      cleanup = setupBackgroundSyncSideEffects(mockClient)

      simulateFreshSession(mockClient)

      await vi.waitFor(() => {
        expect(mockClient.internal.mam.catchUpAllConversations).toHaveBeenCalledTimes(1)
      })

      await new Promise(resolve => setTimeout(resolve, 50))
      expect(mockClient.internal.mam.discoverNewConversationsFromRoster).not.toHaveBeenCalled()
    })

    it('should trigger roster discovery after 1h', async () => {
      const staleTimestamp = Date.now() - (2 * 60 * 60 * 1000)
      localStorageMock.setItem(ROSTER_DISCOVERY_KEY, String(staleTimestamp))

      connectionStore.getState().setServerInfo({
        identities: [],
        domain: 'example.com',
        features: [NS_MAM],
      })

      connectionStore.getState().setStatus('disconnected')
      cleanup = setupBackgroundSyncSideEffects(mockClient)

      simulateFreshSession(mockClient)

      await vi.waitFor(() => {
        expect(mockClient.internal.mam.discoverNewConversationsFromRoster).toHaveBeenCalledTimes(1)
      })
    })

    it('should persist roster discovery timestamp to localStorage', async () => {
      connectionStore.getState().setServerInfo({
        identities: [],
        domain: 'example.com',
        features: [NS_MAM],
      })

      connectionStore.getState().setStatus('disconnected')
      cleanup = setupBackgroundSyncSideEffects(mockClient)

      simulateFreshSession(mockClient)

      await vi.waitFor(() => {
        expect(mockClient.internal.mam.discoverNewConversationsFromRoster).toHaveBeenCalledTimes(1)
      })

      expect(localStorageMock.setItem).toHaveBeenCalledWith(ROSTER_DISCOVERY_KEY, expect.any(String))
    })
  })

  describe('background catch-up on connect', () => {
    beforeEach(() => {
      vi.useFakeTimers()
    })

    afterEach(() => {
      vi.useRealTimers()
      roomStore.getState().setActiveRoom(null)
      roomStore.getState().reset()
    })

    const addRoom = (
      jid: string,
      overrides: { supportsMAM?: boolean; isQuickChat?: boolean; joined?: boolean } = {},
    ) =>
      roomStore.getState().addRoom({
        jid, name: jid, nickname: 'me', joined: true, isBookmarked: true, supportsMAM: true,
        occupants: new Map(), messages: [], unreadCount: 0, mentionsCount: 0, typingUsers: new Set(),
        ...overrides,
      })

    /** Confirm the current-session join the fresh-session room pass requires. */
    const confirmJoin = (jid: string) =>
      mockClient._emitSDK('room:joined', { roomJid: jid, joined: true })

    const caughtUpRooms = () =>
      (mockClient.internal.mam.catchUpRoomHistory as ReturnType<typeof vi.fn>).mock.calls
        .map(([jid]) => jid as string)
        .sort()

    it('should trigger catchUpAllConversations with concurrency 2', async () => {
      ;(mockClient.internal.mam.catchUpAllConversations as ReturnType<typeof vi.fn>).mockResolvedValue(undefined)

      connectionStore.getState().setServerInfo({
        identities: [],
        domain: 'example.com',
        features: [NS_MAM],
      })

      connectionStore.getState().setStatus('disconnected')
      cleanup = setupBackgroundSyncSideEffects(mockClient)

      simulateFreshSession(mockClient)

      await vi.waitFor(() => {
        expect(mockClient.internal.mam.catchUpAllConversations).toHaveBeenCalledTimes(1)
      })

      expect(mockClient.internal.mam.catchUpAllConversations).toHaveBeenCalledWith(
        expect.objectContaining({ concurrency: 2 })
      )
    })

    it('catches up rooms joined this session after the delay', async () => {
      // The delayed pass covers exactly the rooms that confirmed a join during
      // THIS fresh session and are not otherwise owned: not the active room
      // (roomSideEffects owns it), not Quick Chat rooms, not MAM-less rooms, and
      // not a room whose `joined` flag merely hydrated from persisted state (#1149).
      addRoom('active@conference.example.com')
      addRoom('a@conference.example.com')
      addRoom('b@conference.example.com')
      addRoom('quick@conference.example.com', { isQuickChat: true })
      addRoom('nomam@conference.example.com', { supportsMAM: false })
      addRoom('hydrated@conference.example.com') // joined in the store, never confirmed this session
      roomStore.getState().setActiveRoom('active@conference.example.com')

      connectionStore.getState().setServerInfo({
        identities: [],
        domain: 'example.com',
        features: [NS_MAM],
      })

      connectionStore.getState().setStatus('disconnected')
      cleanup = setupBackgroundSyncSideEffects(mockClient)

      simulateFreshSession(mockClient)
      for (const jid of [
        'active@conference.example.com',
        'a@conference.example.com',
        'b@conference.example.com',
        'quick@conference.example.com',
        'nomam@conference.example.com',
      ]) {
        confirmJoin(jid)
      }

      await vi.advanceTimersByTimeAsync(1_000)
      expect(mockClient.internal.mam.catchUpRoomHistory).not.toHaveBeenCalled()

      await vi.advanceTimersByTimeAsync(10_000)

      await vi.waitFor(() => {
        expect(caughtUpRooms()).toEqual([
          'a@conference.example.com',
          'b@conference.example.com',
        ])
      })
      // Must pass the session-start time so the forward cursor excludes live
      // messages that arrive during the 10s catch-up window (silent-gap fix).
      expect(mockClient.internal.mam.catchUpRoomHistory).toHaveBeenCalledWith(
        'a@conference.example.com',
        expect.any(Array),
        expect.objectContaining({
          sessionStartTime: expect.any(Number),
          stitchReadPointer: true,
        }),
      )
    })

    it('retries pending decrypts after conversation catch-up completes (catch-up-tail race)', async () => {
      // A message fetched and stashed during the long catch-up TAIL — after the
      // one-shot key-unlock retry already ran its snapshot — would otherwise stay
      // "could not be decrypted" until the next launch. Re-running retryPendingDecrypts
      // when catch-up settles decrypts it in the same session.
      ;(mockClient.internal.mam.catchUpAllConversations as ReturnType<typeof vi.fn>).mockResolvedValue(undefined)

      connectionStore.getState().setServerInfo({
        identities: [],
        domain: 'example.com',
        features: [NS_MAM],
      })

      connectionStore.getState().setStatus('disconnected')
      cleanup = setupBackgroundSyncSideEffects(mockClient)

      simulateFreshSession(mockClient)

      await vi.waitFor(() => {
        expect(mockClient.internal.mam.catchUpAllConversations).toHaveBeenCalledTimes(1)
      })
      await vi.waitFor(() => {
        expect(mockClient.retryPendingDecrypts).toHaveBeenCalled()
      })
    })

    it('retries pending decrypts again after room catch-up completes', async () => {
      addRoom('room@conference.example.com')

      connectionStore.getState().setServerInfo({
        identities: [],
        domain: 'example.com',
        features: [NS_MAM],
      })

      connectionStore.getState().setStatus('disconnected')
      cleanup = setupBackgroundSyncSideEffects(mockClient)

      simulateFreshSession(mockClient)
      confirmJoin('room@conference.example.com')

      // Conversation catch-up settles first and triggers its own retry.
      await vi.waitFor(() => {
        expect(mockClient.internal.mam.catchUpAllConversations).toHaveBeenCalledTimes(1)
      })
      await vi.waitFor(() => {
        expect(mockClient.retryPendingDecrypts).toHaveBeenCalled()
      })
      const afterConversation =
        (mockClient.retryPendingDecrypts as ReturnType<typeof vi.fn>).mock.calls.length

      // Room catch-up runs after the 10s delay; its completion must trigger another
      // retry so room messages stashed during that later pass also self-heal in-session.
      await vi.advanceTimersByTimeAsync(10_000)
      await vi.waitFor(() => {
        expect(mockClient.internal.mam.catchUpRoomHistory).toHaveBeenCalledTimes(1)
      })
      await vi.waitFor(() => {
        expect(
          (mockClient.retryPendingDecrypts as ReturnType<typeof vi.fn>).mock.calls.length,
        ).toBeGreaterThan(afterConversation)
      })
    })

    it('should cancel room catch-up timer on disconnect', async () => {
      addRoom('room@conference.example.com')

      connectionStore.getState().setServerInfo({
        identities: [],
        domain: 'example.com',
        features: [NS_MAM],
      })

      connectionStore.getState().setStatus('disconnected')
      cleanup = setupBackgroundSyncSideEffects(mockClient)

      simulateFreshSession(mockClient)
      confirmJoin('room@conference.example.com')

      await vi.advanceTimersByTimeAsync(5_000)
      connectionStore.getState().setStatus('disconnected')

      await vi.advanceTimersByTimeAsync(10_000)

      expect(mockClient.internal.mam.catchUpRoomHistory).not.toHaveBeenCalled()
    })

    it('should re-trigger catch-up on reconnect', async () => {
      ;(mockClient.internal.mam.catchUpAllConversations as ReturnType<typeof vi.fn>).mockResolvedValue(undefined)
      addRoom('room@conference.example.com')

      connectionStore.getState().setServerInfo({
        identities: [],
        domain: 'example.com',
        features: [NS_MAM],
      })

      connectionStore.getState().setStatus('disconnected')
      cleanup = setupBackgroundSyncSideEffects(mockClient)

      simulateFreshSession(mockClient)
      confirmJoin('room@conference.example.com')
      await vi.waitFor(() => {
        expect(mockClient.internal.mam.catchUpAllConversations).toHaveBeenCalledTimes(1)
      })

      await vi.advanceTimersByTimeAsync(10_000)
      await vi.waitFor(() => {
        expect(mockClient.internal.mam.catchUpRoomHistory).toHaveBeenCalledTimes(1)
      })

      connectionStore.getState().setStatus('disconnected')

      simulateFreshSession(mockClient)
      confirmJoin('room@conference.example.com')
      await vi.waitFor(() => {
        expect(mockClient.internal.mam.catchUpAllConversations).toHaveBeenCalledTimes(2)
      })

      await vi.advanceTimersByTimeAsync(10_000)
      await vi.waitFor(() => {
        expect(mockClient.internal.mam.catchUpRoomHistory).toHaveBeenCalledTimes(2)
      })
    })

    it('reads the active room at pass time, not at trigger time', async () => {
      // The room active when sync starts can stop being active before the delayed
      // pass fires. Exclusion must follow the room that is active THEN: the room
      // released in the meantime still needs its catch-up.
      addRoom('first@conference.example.com')
      addRoom('second@conference.example.com')
      roomStore.getState().setActiveRoom('first@conference.example.com')

      connectionStore.getState().setServerInfo({
        identities: [],
        domain: 'example.com',
        features: [NS_MAM],
      })

      connectionStore.getState().setStatus('disconnected')
      cleanup = setupBackgroundSyncSideEffects(mockClient)

      simulateFreshSession(mockClient)
      confirmJoin('first@conference.example.com')
      confirmJoin('second@conference.example.com')

      // User switches rooms during the 10s window.
      await vi.advanceTimersByTimeAsync(5_000)
      roomStore.getState().setActiveRoom('second@conference.example.com')

      await vi.advanceTimersByTimeAsync(10_000)

      await vi.waitFor(() => {
        expect(caughtUpRooms()).toEqual(['first@conference.example.com'])
      })
    })

    it('does not catch up a newly active room without a current-session join', async () => {
      roomStore.getState().reset()
      for (const jid of ['a@conference.example.com', 'b@conference.example.com']) {
        roomStore.getState().addRoom({
          jid,
          name: jid,
          nickname: 'me',
          joined: true,
          supportsMAM: true,
          isBookmarked: true,
          occupants: new Map(),
          messages: [],
          unreadCount: 0,
          mentionsCount: 0,
          typingUsers: new Set(),
        })
      }
      roomStore.getState().setActiveRoom('a@conference.example.com')
      connectionStore.getState().setServerInfo({
        identities: [],
        domain: 'example.com',
        features: [NS_MAM],
      })
      connectionStore.getState().setStatus('disconnected')
      cleanup = setupBackgroundSyncSideEffects(mockClient)

      simulateFreshSession(mockClient)
      roomStore.getState().setActiveRoom('b@conference.example.com')
      await vi.advanceTimersByTimeAsync(10_000)

      expect(mockClient.internal.mam.catchUpRoomHistory).not.toHaveBeenCalled()
      roomStore.getState().reset()
    })

    it('revalidates the active room after background cache hydration', async () => {
      roomStore.getState().reset()
      let resolveCache!: (messages: []) => void
      const cache = new Promise<[]>((resolve) => {
        resolveCache = resolve
      })
      const loadSpy = vi.spyOn(
        roomStore.getState(),
        'loadMessagesFromCache',
      ).mockReturnValue(cache)
      for (const jid of ['a@conference.example.com', 'b@conference.example.com']) {
        roomStore.getState().addRoom({
          jid,
          name: jid,
          nickname: 'me',
          joined: false,
          supportsMAM: true,
          isBookmarked: true,
          occupants: new Map(),
          messages: [],
          unreadCount: 0,
          mentionsCount: 0,
          typingUsers: new Set(),
        })
      }
      roomStore.getState().setActiveRoom('a@conference.example.com')
      connectionStore.getState().setServerInfo({
        identities: [],
        domain: 'example.com',
        features: [NS_MAM],
      })
      connectionStore.getState().setStatus('disconnected')
      cleanup = setupBackgroundSyncSideEffects(mockClient)

      simulateFreshSession(mockClient)
      roomStore.getState().setRoomJoined('b@conference.example.com', true)
      mockClient._emitSDK('room:joined', {
        roomJid: 'b@conference.example.com',
        joined: true,
      })
      await vi.advanceTimersByTimeAsync(10_000)
      roomStore.getState().setActiveRoom('b@conference.example.com')
      resolveCache([])
      await Promise.resolve()
      await Promise.resolve()

      expect(mockClient.internal.mam.catchUpRoomHistory).not.toHaveBeenCalled()
      loadSpy.mockRestore()
      roomStore.getState().reset()
    })

    it('catches up an excluded room that confirms join after becoming inactive', async () => {
      roomStore.getState().reset()
      const roomJid = 'late-join@conference.example.com'
      roomStore.getState().addRoom({
        jid: roomJid,
        name: roomJid,
        nickname: 'me',
        joined: true,
        supportsMAM: true,
        isBookmarked: true,
        occupants: new Map(),
        messages: [],
        unreadCount: 0,
        mentionsCount: 0,
        typingUsers: new Set(),
      })
      roomStore.getState().setActiveRoom(roomJid)
      connectionStore.getState().setServerInfo({
        identities: [],
        domain: 'example.com',
        features: [NS_MAM],
      })
      connectionStore.getState().setStatus('disconnected')
      cleanup = setupBackgroundSyncSideEffects(mockClient)

      simulateFreshSession(mockClient)
      await vi.advanceTimersByTimeAsync(10_000)
      roomStore.getState().setActiveRoom(null)
      mockClient._emitSDK('room:joined', { roomJid, joined: true })
      mockClient._emitSDK('room:joined', { roomJid, joined: true })

      await vi.waitFor(() => {
        expect(mockClient.internal.mam.catchUpRoomHistory).toHaveBeenCalledTimes(1)
      })
      roomStore.getState().reset()
    })

    it('retains the resume boundary across synthetic online', async () => {
      roomStore.getState().reset()
      const roomJid = 'resumed@conference.example.com'
      roomStore.getState().addRoom({
        jid: roomJid,
        name: roomJid,
        nickname: 'me',
        joined: false,
        supportsMAM: true,
        isBookmarked: true,
        occupants: new Map(),
        messages: [],
        unreadCount: 0,
        mentionsCount: 0,
        typingUsers: new Set(),
      })
      connectionStore.getState().setServerInfo({
        identities: [],
        domain: 'example.com',
        features: [NS_MAM],
      })
      connectionStore.getState().setStatus('disconnected')
      cleanup = setupBackgroundSyncSideEffects(mockClient)

      vi.setSystemTime(1_754_000_000_000)
      simulateSmResumption(mockClient)
      roomStore.getState().setRoomJoined(roomJid, true)
      mockClient._emitSDK('room:joined', { roomJid, joined: true })
      vi.setSystemTime(1_754_000_005_000)
      mockClient._emit('online')
      await vi.advanceTimersByTimeAsync(10_000)

      await vi.waitFor(() => {
        expect(mockClient.internal.mam.catchUpRoomHistory).toHaveBeenCalledWith(
          roomJid,
          expect.any(Array),
          expect.objectContaining({ sessionStartTime: 1_754_000_000_000 }),
        )
      })
      roomStore.getState().reset()
    })

    it('does not let an old pass unlock replacement-session joins early', async () => {
      roomStore.getState().reset()
      const oldRoomJid = 'old@conference.example.com'
      const replacementRoomJid = 'replacement@conference.example.com'
      for (const jid of [oldRoomJid, replacementRoomJid]) {
        roomStore.getState().addRoom({
          jid,
          name: jid,
          nickname: 'me',
          joined: false,
          supportsMAM: true,
          isBookmarked: true,
          occupants: new Map(),
          messages: [],
          unreadCount: 0,
          mentionsCount: 0,
          typingUsers: new Set(),
        })
      }
      let resolveOldCatchUp!: () => void
      const oldCatchUp = new Promise<void>((resolve) => {
        resolveOldCatchUp = resolve
      })
      vi.mocked(mockClient.internal.mam.catchUpRoomHistory)
        .mockReturnValueOnce(oldCatchUp)
        .mockResolvedValue(undefined)
      connectionStore.getState().setServerInfo({
        identities: [],
        domain: 'example.com',
        features: [NS_MAM],
      })
      connectionStore.getState().setStatus('disconnected')
      cleanup = setupBackgroundSyncSideEffects(mockClient)

      simulateFreshSession(mockClient)
      roomStore.getState().setRoomJoined(oldRoomJid, true)
      mockClient._emitSDK('room:joined', { roomJid: oldRoomJid, joined: true })
      await vi.advanceTimersByTimeAsync(10_000)
      await vi.waitFor(() => {
        expect(mockClient.internal.mam.catchUpRoomHistory).toHaveBeenCalledWith(
          oldRoomJid,
          expect.any(Array),
          expect.any(Object),
        )
      })

      connectionStore.getState().setStatus('disconnected')
      simulateFreshSession(mockClient)
      resolveOldCatchUp()
      await vi.advanceTimersByTimeAsync(0)

      roomStore.getState().setRoomJoined(replacementRoomJid, true)
      mockClient._emitSDK('room:joined', {
        roomJid: replacementRoomJid,
        joined: true,
      })
      await vi.advanceTimersByTimeAsync(0)
      expect(mockClient.internal.mam.catchUpRoomHistory).not.toHaveBeenCalledWith(
        replacementRoomJid,
        expect.any(Array),
        expect.any(Object),
      )

      await vi.advanceTimersByTimeAsync(10_000)
      await vi.waitFor(() => {
        expect(mockClient.internal.mam.catchUpRoomHistory).toHaveBeenCalledWith(
          replacementRoomJid,
          expect.any(Array),
          expect.any(Object),
        )
      })
      roomStore.getState().reset()
    })

    it('retries once after a join catch-up aborts during hydration', async () => {
      roomStore.getState().reset()
      const roomJid = 'retry@conference.example.com'
      roomStore.getState().addRoom({
        jid: roomJid,
        name: roomJid,
        nickname: 'me',
        joined: false,
        supportsMAM: true,
        isBookmarked: true,
        occupants: new Map(),
        messages: [],
        unreadCount: 0,
        mentionsCount: 0,
        typingUsers: new Set(),
      })
      let resolveFirstCache!: (messages: []) => void
      const firstCache = new Promise<[]>((resolve) => {
        resolveFirstCache = resolve
      })
      let resolveReplacementCache!: (messages: []) => void
      const replacementCache = new Promise<[]>((resolve) => {
        resolveReplacementCache = resolve
      })
      let roomLoadCount = 0
      const loadSpy = vi.spyOn(
        roomStore.getState(),
        'loadMessagesFromCache',
      )
        .mockImplementation((jid) => {
          if (jid !== roomJid) return Promise.resolve([])
          roomLoadCount += 1
          return roomLoadCount === 1 ? firstCache : replacementCache
        })
      connectionStore.getState().setServerInfo({
        identities: [],
        domain: 'example.com',
        features: [NS_MAM],
      })
      connectionStore.getState().setStatus('disconnected')
      cleanup = setupBackgroundSyncSideEffects(mockClient)

      simulateFreshSession(mockClient)
      await vi.advanceTimersByTimeAsync(10_000)
      roomStore.getState().setRoomJoined(roomJid, true)
      mockClient._emitSDK('room:joined', { roomJid, joined: true })
      await vi.waitFor(() => {
        expect(loadSpy.mock.calls.filter(([jid]) => jid === roomJid)).toHaveLength(1)
      })

      roomStore.getState().setRoomJoined(roomJid, false)
      mockClient._emitSDK('room:joined', { roomJid, joined: false })
      roomStore.getState().setRoomJoined(roomJid, true)
      mockClient._emitSDK('room:joined', { roomJid, joined: true })
      mockClient._emitSDK('room:joined', { roomJid, joined: true })
      await vi.waitFor(() => {
        expect(loadSpy.mock.calls.filter(([jid]) => jid === roomJid)).toHaveLength(2)
      })

      resolveFirstCache([])
      await vi.advanceTimersByTimeAsync(0)
      expect(mockClient.internal.mam.catchUpRoomHistory).not.toHaveBeenCalled()

      resolveReplacementCache([])
      await vi.waitFor(() => {
        expect(mockClient.internal.mam.catchUpRoomHistory).toHaveBeenCalledTimes(1)
      })
      expect(loadSpy.mock.calls.filter(([jid]) => jid === roomJid)).toHaveLength(2)
      loadSpy.mockRestore()
      roomStore.getState().reset()
    })

    it('hands an inactive foreground hydration to background catch-up once', async () => {
      roomStore.getState().reset()
      const roomJid = 'handoff@conference.example.com'
      roomStore.getState().addRoom({
        jid: roomJid,
        name: roomJid,
        nickname: 'me',
        joined: false,
        supportsMAM: true,
        isBookmarked: true,
        occupants: new Map(),
        messages: [],
        unreadCount: 0,
        mentionsCount: 0,
        typingUsers: new Set(),
      })
      roomStore.getState().setActiveRoom(roomJid)
      let resolveForegroundCache!: (messages: []) => void
      const foregroundCache = new Promise<[]>((resolve) => {
        resolveForegroundCache = resolve
      })
      let resolveBackgroundCache!: (messages: []) => void
      const backgroundCache = new Promise<[]>((resolve) => {
        resolveBackgroundCache = resolve
      })
      let roomLoadCount = 0
      const loadSpy = vi.spyOn(
        roomStore.getState(),
        'loadMessagesFromCache',
      ).mockImplementation((jid) => {
        if (jid !== roomJid) return Promise.resolve([])
        roomLoadCount += 1
        return roomLoadCount === 1 ? foregroundCache : backgroundCache
      })
      connectionStore.getState().setServerInfo({
        identities: [],
        domain: 'example.com',
        features: [NS_MAM],
      })
      connectionStore.getState().setStatus('disconnected')
      roomCleanup = setupRoomSideEffects(mockClient)
      cleanup = setupBackgroundSyncSideEffects(mockClient)

      simulateFreshSession(mockClient)
      roomStore.getState().setRoomJoined(roomJid, true)
      mockClient._emitSDK('room:joined', { roomJid, joined: true })
      await vi.waitFor(() => {
        expect(loadSpy.mock.calls.filter(([jid]) => jid === roomJid)).toHaveLength(1)
      })
      await vi.advanceTimersByTimeAsync(10_000)

      roomStore.getState().setActiveRoom(null)
      resolveForegroundCache([])
      await vi.waitFor(() => {
        expect(loadSpy.mock.calls.filter(([jid]) => jid === roomJid)).toHaveLength(2)
      })
      expect(mockClient.internal.mam.catchUpRoomHistory).not.toHaveBeenCalled()
      expect(roomStore.getState().getRoomMAMQueryState(roomJid).isLoading).toBe(false)

      resolveBackgroundCache([])
      await vi.waitFor(() => {
        expect(mockClient.internal.mam.catchUpRoomHistory).toHaveBeenCalledTimes(1)
      })
      expect(mockClient.internal.mam.catchUpRoomHistory).toHaveBeenCalledWith(
        roomJid,
        [],
        expect.objectContaining({ stitchReadPointer: true }),
      )
      expect(loadSpy.mock.calls.filter(([jid]) => jid === roomJid)).toHaveLength(2)
      loadSpy.mockRestore()
      roomStore.getState().reset()
    })

    it('queues a foreground handoff while the initial room pass is pending', async () => {
      roomStore.getState().reset()
      const handoffRoomJid = 'queued-handoff@conference.example.com'
      const blockingRoomJid = 'blocking-pass@conference.example.com'
      for (const roomJid of [handoffRoomJid, blockingRoomJid]) {
        roomStore.getState().addRoom({
          jid: roomJid,
          name: roomJid,
          nickname: 'me',
          joined: false,
          supportsMAM: true,
          isBookmarked: true,
          occupants: new Map(),
          messages: [],
          unreadCount: 0,
          mentionsCount: 0,
          typingUsers: new Set(),
        })
      }
      roomStore.getState().setActiveRoom(handoffRoomJid)
      let resolveForegroundCache!: (messages: []) => void
      const foregroundCache = new Promise<[]>((resolve) => {
        resolveForegroundCache = resolve
      })
      let handoffRoomLoadCount = 0
      const loadSpy = vi.spyOn(
        roomStore.getState(),
        'loadMessagesFromCache',
      ).mockImplementation((jid) => {
        if (jid !== handoffRoomJid) return Promise.resolve([])
        handoffRoomLoadCount += 1
        return handoffRoomLoadCount === 1
          ? foregroundCache
          : Promise.resolve([])
      })
      let resolveBlockingCatchUp!: () => void
      const blockingCatchUp = new Promise<void>((resolve) => {
        resolveBlockingCatchUp = resolve
      })
      vi.mocked(mockClient.internal.mam.catchUpRoomHistory).mockImplementation(
        async (roomJid) => {
          if (roomJid === blockingRoomJid) {
            await blockingCatchUp
          }
        },
      )
      connectionStore.getState().setServerInfo({
        identities: [],
        domain: 'example.com',
        features: [NS_MAM],
      })
      connectionStore.getState().setStatus('disconnected')
      roomCleanup = setupRoomSideEffects(mockClient)
      cleanup = setupBackgroundSyncSideEffects(mockClient)

      simulateFreshSession(mockClient)
      for (const roomJid of [handoffRoomJid, blockingRoomJid]) {
        roomStore.getState().setRoomJoined(roomJid, true)
        mockClient._emitSDK('room:joined', { roomJid, joined: true })
      }
      await vi.waitFor(() => {
        expect(
          loadSpy.mock.calls.filter(([jid]) => jid === handoffRoomJid),
        ).toHaveLength(1)
      })
      await vi.advanceTimersByTimeAsync(10_000)
      await vi.waitFor(() => {
        expect(mockClient.internal.mam.catchUpRoomHistory).toHaveBeenCalledWith(
          blockingRoomJid,
          [],
          expect.objectContaining({ stitchReadPointer: true }),
        )
      })

      roomStore.getState().setActiveRoom(null)
      resolveForegroundCache([])
      await vi.waitFor(() => {
        expect(
          roomStore.getState().getRoomMAMQueryState(handoffRoomJid).isLoading,
        ).toBe(false)
      })
      expect(
        vi.mocked(mockClient.internal.mam.catchUpRoomHistory).mock.calls
          .filter(([jid]) => jid === handoffRoomJid),
      ).toHaveLength(0)

      resolveBlockingCatchUp()
      await vi.waitFor(() => {
        expect(
          vi.mocked(mockClient.internal.mam.catchUpRoomHistory).mock.calls
            .filter(([jid]) => jid === handoffRoomJid),
        ).toHaveLength(1)
      })
      expect(
        loadSpy.mock.calls.filter(([jid]) => jid === handoffRoomJid),
      ).toHaveLength(2)
      loadSpy.mockRestore()
      roomStore.getState().reset()
    })

    it.each([
      ['self-presence', 'join'],
      ['MAM support', 'mam'],
    ] as const)(
      'reconciles %s received during a pending initial pass',
      async (_transitionName, transition) => {
        roomStore.getState().reset()
        const targetRoomJid = `post-snapshot-${transition}@conference.example.com`
        const blockingRoomJid = `blocking-${transition}@conference.example.com`
        roomStore.getState().addRoom({
          jid: targetRoomJid,
          name: targetRoomJid,
          nickname: 'me',
          joined: false,
          supportsMAM: transition === 'join',
          isBookmarked: true,
          occupants: new Map(),
          messages: [],
          unreadCount: 0,
          mentionsCount: 0,
          typingUsers: new Set(),
        })
        roomStore.getState().addRoom({
          jid: blockingRoomJid,
          name: blockingRoomJid,
          nickname: 'me',
          joined: false,
          supportsMAM: true,
          isBookmarked: true,
          occupants: new Map(),
          messages: [],
          unreadCount: 0,
          mentionsCount: 0,
          typingUsers: new Set(),
        })
        let resolveBlockingCatchUp!: () => void
        const blockingCatchUp = new Promise<void>((resolve) => {
          resolveBlockingCatchUp = resolve
        })
        vi.mocked(mockClient.internal.mam.catchUpRoomHistory).mockImplementation(
          async (roomJid) => {
            if (roomJid === blockingRoomJid) {
              await blockingCatchUp
            }
          },
        )
        connectionStore.getState().setServerInfo({
          identities: [],
          domain: 'example.com',
          features: [NS_MAM],
        })
        connectionStore.getState().setStatus('disconnected')
        cleanup = setupBackgroundSyncSideEffects(mockClient)

        simulateFreshSession(mockClient)
        roomStore.getState().setRoomJoined(blockingRoomJid, true)
        mockClient._emitSDK('room:joined', {
          roomJid: blockingRoomJid,
          joined: true,
        })
        if (transition === 'mam') {
          roomStore.getState().setRoomJoined(targetRoomJid, true)
          mockClient._emitSDK('room:joined', {
            roomJid: targetRoomJid,
            joined: true,
          })
        }
        await vi.advanceTimersByTimeAsync(10_000)
        await vi.waitFor(() => {
          expect(mockClient.internal.mam.catchUpRoomHistory).toHaveBeenCalledWith(
            blockingRoomJid,
            [],
            expect.objectContaining({ stitchReadPointer: true }),
          )
        })

        if (transition === 'join') {
          roomStore.getState().setRoomJoined(targetRoomJid, true)
          mockClient._emitSDK('room:joined', {
            roomJid: targetRoomJid,
            joined: true,
          })
        } else {
          roomStore.getState().updateRoom(targetRoomJid, {
            supportsMAM: true,
          })
        }
        expect(
          vi.mocked(mockClient.internal.mam.catchUpRoomHistory).mock.calls
            .filter(([jid]) => jid === targetRoomJid),
        ).toHaveLength(0)

        resolveBlockingCatchUp()
        await vi.waitFor(() => {
          expect(
            vi.mocked(mockClient.internal.mam.catchUpRoomHistory).mock.calls
              .filter(([jid]) => jid === targetRoomJid),
          ).toHaveLength(1)
        })
        roomStore.getState().reset()
      },
    )

    it('does not duplicate foreground catch-up during reconciliation', async () => {
      roomStore.getState().reset()
      const foregroundRoomJid = 'foreground-in-flight@conference.example.com'
      const blockingRoomJid = 'blocking-foreground@conference.example.com'
      for (const roomJid of [foregroundRoomJid, blockingRoomJid]) {
        roomStore.getState().addRoom({
          jid: roomJid,
          name: roomJid,
          nickname: 'me',
          joined: false,
          supportsMAM: true,
          isBookmarked: true,
          occupants: new Map(),
          messages: [],
          unreadCount: 0,
          mentionsCount: 0,
          typingUsers: new Set(),
        })
      }
      roomStore.getState().setActiveRoom(foregroundRoomJid)
      let resolveForegroundCatchUp!: () => void
      const foregroundCatchUp = new Promise<void>((resolve) => {
        resolveForegroundCatchUp = resolve
      })
      let resolveBlockingCatchUp!: () => void
      const blockingCatchUp = new Promise<void>((resolve) => {
        resolveBlockingCatchUp = resolve
      })
      let foregroundCatchUpCount = 0
      vi.mocked(mockClient.internal.mam.catchUpRoomHistory).mockImplementation(
        async (roomJid) => {
          if (roomJid === foregroundRoomJid) {
            foregroundCatchUpCount += 1
            if (foregroundCatchUpCount === 1) {
              await foregroundCatchUp
            }
          }
          if (roomJid === blockingRoomJid) {
            await blockingCatchUp
          }
        },
      )
      connectionStore.getState().setServerInfo({
        identities: [],
        domain: 'example.com',
        features: [NS_MAM],
      })
      connectionStore.getState().setStatus('disconnected')
      roomCleanup = setupRoomSideEffects(mockClient)
      cleanup = setupBackgroundSyncSideEffects(mockClient)

      simulateFreshSession(mockClient)
      for (const roomJid of [foregroundRoomJid, blockingRoomJid]) {
        roomStore.getState().setRoomJoined(roomJid, true)
        mockClient._emitSDK('room:joined', { roomJid, joined: true })
      }
      await vi.waitFor(() => {
        expect(foregroundCatchUpCount).toBe(1)
      })
      await vi.advanceTimersByTimeAsync(10_000)
      await vi.waitFor(() => {
        expect(mockClient.internal.mam.catchUpRoomHistory).toHaveBeenCalledWith(
          blockingRoomJid,
          [],
          expect.objectContaining({ stitchReadPointer: true }),
        )
      })

      roomStore.getState().setActiveRoom(null)
      resolveBlockingCatchUp()
      await vi.waitFor(() => {
        expect(mockClient.muc.queryRoomMembers).toHaveBeenCalled()
      })
      expect(foregroundCatchUpCount).toBe(1)

      resolveForegroundCatchUp()
      await vi.advanceTimersByTimeAsync(0)
      expect(foregroundCatchUpCount).toBe(1)
      roomStore.getState().reset()
    })

    it('does not repeat completed foreground catch-up during reconciliation', async () => {
      roomStore.getState().reset()
      const foregroundRoomJid = 'foreground-complete@conference.example.com'
      const blockingRoomJid = 'blocking-complete@conference.example.com'
      for (const roomJid of [foregroundRoomJid, blockingRoomJid]) {
        roomStore.getState().addRoom({
          jid: roomJid,
          name: roomJid,
          nickname: 'me',
          joined: false,
          supportsMAM: true,
          isBookmarked: true,
          occupants: new Map(),
          messages: [],
          unreadCount: 0,
          mentionsCount: 0,
          typingUsers: new Set(),
        })
      }
      roomStore.getState().setActiveRoom(foregroundRoomJid)
      let resolveBlockingCatchUp!: () => void
      const blockingCatchUp = new Promise<void>((resolve) => {
        resolveBlockingCatchUp = resolve
      })
      vi.mocked(mockClient.internal.mam.catchUpRoomHistory).mockImplementation(
        async (roomJid) => {
          if (roomJid === blockingRoomJid) {
            await blockingCatchUp
          }
        },
      )
      connectionStore.getState().setServerInfo({
        identities: [],
        domain: 'example.com',
        features: [NS_MAM],
      })
      connectionStore.getState().setStatus('disconnected')
      roomCleanup = setupRoomSideEffects(mockClient)
      cleanup = setupBackgroundSyncSideEffects(mockClient)

      simulateFreshSession(mockClient)
      for (const roomJid of [foregroundRoomJid, blockingRoomJid]) {
        roomStore.getState().setRoomJoined(roomJid, true)
        mockClient._emitSDK('room:joined', { roomJid, joined: true })
      }
      await vi.waitFor(() => {
        expect(
          vi.mocked(mockClient.internal.mam.catchUpRoomHistory).mock.calls
            .filter(([jid]) => jid === foregroundRoomJid),
        ).toHaveLength(1)
      })
      await vi.advanceTimersByTimeAsync(0)
      await vi.advanceTimersByTimeAsync(10_000)
      await vi.waitFor(() => {
        expect(mockClient.internal.mam.catchUpRoomHistory).toHaveBeenCalledWith(
          blockingRoomJid,
          [],
          expect.objectContaining({ stitchReadPointer: true }),
        )
      })

      roomStore.getState().setActiveRoom(null)
      resolveBlockingCatchUp()
      await vi.waitFor(() => {
        expect(mockClient.muc.queryRoomMembers).toHaveBeenCalled()
      })
      expect(
        vi.mocked(mockClient.internal.mam.catchUpRoomHistory).mock.calls
          .filter(([jid]) => jid === foregroundRoomJid),
      ).toHaveLength(1)
      roomStore.getState().reset()
    })

    it('retries released foreground catch-up once in the background', async () => {
      roomStore.getState().reset()
      const roomJid = 'foreground-failure@conference.example.com'
      roomStore.getState().addRoom({
        jid: roomJid,
        name: roomJid,
        nickname: 'me',
        joined: false,
        supportsMAM: true,
        isBookmarked: true,
        occupants: new Map(),
        messages: [],
        unreadCount: 0,
        mentionsCount: 0,
        typingUsers: new Set(),
      })
      roomStore.getState().setActiveRoom(roomJid)
      let rejectForegroundCatchUp!: (error: Error) => void
      const foregroundCatchUp = new Promise<void>((_resolve, reject) => {
        rejectForegroundCatchUp = reject
      })
      let roomCatchUpCount = 0
      vi.mocked(mockClient.internal.mam.catchUpRoomHistory).mockImplementation(
        async (caughtUpRoomJid) => {
          if (caughtUpRoomJid !== roomJid) return
          roomCatchUpCount += 1
          if (roomCatchUpCount === 1) {
            await foregroundCatchUp
          }
        },
      )
      connectionStore.getState().setServerInfo({
        identities: [],
        domain: 'example.com',
        features: [NS_MAM],
      })
      connectionStore.getState().setStatus('disconnected')
      roomCleanup = setupRoomSideEffects(mockClient)
      cleanup = setupBackgroundSyncSideEffects(mockClient)

      simulateFreshSession(mockClient)
      roomStore.getState().setRoomJoined(roomJid, true)
      mockClient._emitSDK('room:joined', { roomJid, joined: true })
      await vi.waitFor(() => {
        expect(roomCatchUpCount).toBe(1)
      })
      await vi.advanceTimersByTimeAsync(10_000)
      await vi.waitFor(() => {
        expect(mockClient.muc.queryRoomMembers).toHaveBeenCalled()
      })

      roomStore.getState().setActiveRoom(null)
      rejectForegroundCatchUp(new Error('Not connected during foreground query'))
      await vi.waitFor(() => {
        expect(roomCatchUpCount).toBe(2)
      })
      await vi.advanceTimersByTimeAsync(0)
      expect(roomCatchUpCount).toBe(2)
      roomStore.getState().reset()
    })

    it('defers an active foreground failure until the room becomes inactive', async () => {
      roomStore.getState().reset()
      const roomJid = 'active-foreground-failure@conference.example.com'
      roomStore.getState().addRoom({
        jid: roomJid,
        name: roomJid,
        nickname: 'me',
        joined: false,
        supportsMAM: true,
        isBookmarked: true,
        occupants: new Map(),
        messages: [],
        unreadCount: 0,
        mentionsCount: 0,
        typingUsers: new Set(),
      })
      roomStore.getState().setActiveRoom(roomJid)
      let rejectForegroundCatchUp!: (error: Error) => void
      const foregroundCatchUp = new Promise<void>((_resolve, reject) => {
        rejectForegroundCatchUp = reject
      })
      let roomCatchUpCount = 0
      vi.mocked(mockClient.internal.mam.catchUpRoomHistory).mockImplementation(
        async (caughtUpRoomJid) => {
          if (caughtUpRoomJid !== roomJid) return
          roomCatchUpCount += 1
          if (roomCatchUpCount === 1) {
            await foregroundCatchUp
          }
        },
      )
      connectionStore.getState().setServerInfo({
        identities: [],
        domain: 'example.com',
        features: [NS_MAM],
      })
      connectionStore.getState().setStatus('disconnected')
      roomCleanup = setupRoomSideEffects(mockClient)
      cleanup = setupBackgroundSyncSideEffects(mockClient)

      simulateFreshSession(mockClient)
      roomStore.getState().setRoomJoined(roomJid, true)
      mockClient._emitSDK('room:joined', { roomJid, joined: true })
      await vi.waitFor(() => {
        expect(roomCatchUpCount).toBe(1)
      })
      await vi.advanceTimersByTimeAsync(10_000)
      await vi.waitFor(() => {
        expect(mockClient.muc.queryRoomMembers).toHaveBeenCalled()
      })

      rejectForegroundCatchUp(new Error('Not connected during foreground query'))
      await vi.waitFor(() => {
        expect(
          roomStore.getState().getRoomMAMQueryState(roomJid).isLoading,
        ).toBe(false)
      })
      expect(roomCatchUpCount).toBe(1)

      roomStore.getState().setActiveRoom(null)
      await vi.waitFor(() => {
        expect(roomCatchUpCount).toBe(2)
      })
      await vi.advanceTimersByTimeAsync(0)
      expect(roomCatchUpCount).toBe(2)
      roomStore.getState().reset()
    })

    it('drops an active failure handoff on session replacement', async () => {
      roomStore.getState().reset()
      const roomJid = 'replaced-foreground-failure@conference.example.com'
      roomStore.getState().addRoom({
        jid: roomJid,
        name: roomJid,
        nickname: 'me',
        joined: false,
        supportsMAM: true,
        isBookmarked: true,
        occupants: new Map(),
        messages: [],
        unreadCount: 0,
        mentionsCount: 0,
        typingUsers: new Set(),
      })
      roomStore.getState().setActiveRoom(roomJid)
      let rejectForegroundCatchUp!: (error: Error) => void
      const foregroundCatchUp = new Promise<void>((_resolve, reject) => {
        rejectForegroundCatchUp = reject
      })
      let roomCatchUpCount = 0
      vi.mocked(mockClient.internal.mam.catchUpRoomHistory).mockImplementation(
        async (caughtUpRoomJid) => {
          if (caughtUpRoomJid !== roomJid) return
          roomCatchUpCount += 1
          if (roomCatchUpCount === 1) {
            await foregroundCatchUp
          }
        },
      )
      connectionStore.getState().setServerInfo({
        identities: [],
        domain: 'example.com',
        features: [NS_MAM],
      })
      connectionStore.getState().setStatus('disconnected')
      roomCleanup = setupRoomSideEffects(mockClient)
      cleanup = setupBackgroundSyncSideEffects(mockClient)

      simulateFreshSession(mockClient)
      roomStore.getState().setRoomJoined(roomJid, true)
      mockClient._emitSDK('room:joined', { roomJid, joined: true })
      await vi.waitFor(() => {
        expect(roomCatchUpCount).toBe(1)
      })
      await vi.advanceTimersByTimeAsync(10_000)
      await vi.waitFor(() => {
        expect(mockClient.muc.queryRoomMembers).toHaveBeenCalled()
      })

      rejectForegroundCatchUp(new Error('Not connected during foreground query'))
      await vi.waitFor(() => {
        expect(
          roomStore.getState().getRoomMAMQueryState(roomJid).isLoading,
        ).toBe(false)
      })
      connectionStore.getState().setStatus('disconnected')
      simulateFreshSession(mockClient)
      roomStore.getState().setActiveRoom(null)
      await vi.advanceTimersByTimeAsync(10_000)

      expect(roomCatchUpCount).toBe(1)
      roomStore.getState().reset()
    })
  })

  describe('late MAM-ready room retry (issue D)', () => {
    beforeEach(() => {
      vi.useFakeTimers()
    })

    afterEach(() => {
      vi.useRealTimers()
      roomStore.getState().setActiveRoom(null)
      roomStore.getState().reset()
    })

    const addRoom = (jid: string, supportsMAM: boolean) =>
      roomStore.getState().addRoom({
        jid, name: jid, nickname: 'me', joined: true, isBookmarked: true, supportsMAM,
        occupants: new Map(), messages: [], unreadCount: 0, mentionsCount: 0, typingUsers: new Set(),
      })

    it('catches up a non-active room whose MAM support resolves AFTER the initial 10s pass', async () => {
      addRoom('late@conference.example.com', false) // disco not resolved at pass time
      connectionStore.getState().setServerInfo({ identities: [], domain: 'example.com', features: [NS_MAM] })
      connectionStore.getState().setStatus('disconnected')
      cleanup = setupBackgroundSyncSideEffects(mockClient)
      simulateFreshSession(mockClient)
      mockClient._emitSDK('room:joined', {
        roomJid: 'late@conference.example.com',
        joined: true,
      })

      // Initial 10s pass — room is not MAM-ready, so it's not covered and not retried yet.
      await vi.advanceTimersByTimeAsync(10_000)
      expect(mockClient.internal.mam.catchUpRoom).not.toHaveBeenCalled()

      // Disco resolves AFTER the pass → late retry fires for this room.
      roomStore.getState().updateRoom('late@conference.example.com', { supportsMAM: true })

      await vi.waitFor(() => {
        expect(mockClient.internal.mam.catchUpRoomHistory).toHaveBeenCalledWith(
          'late@conference.example.com',
          expect.any(Array),
          expect.objectContaining({
            sessionStartTime: expect.any(Number),
            stitchReadPointer: true,
          }),
        )
      })
    })

    it('does not retry the ACTIVE room (handled by roomSideEffects) when its MAM resolves late', async () => {
      addRoom('active@conference.example.com', false)
      roomStore.getState().setActiveRoom('active@conference.example.com')
      connectionStore.getState().setServerInfo({ identities: [], domain: 'example.com', features: [NS_MAM] })
      connectionStore.getState().setStatus('disconnected')
      cleanup = setupBackgroundSyncSideEffects(mockClient)
      simulateFreshSession(mockClient)

      await vi.advanceTimersByTimeAsync(10_000)
      roomStore.getState().updateRoom('active@conference.example.com', { supportsMAM: true })
      await vi.advanceTimersByTimeAsync(100)

      expect(mockClient.internal.mam.catchUpRoom).not.toHaveBeenCalledWith('active@conference.example.com', expect.anything())
    })

    it('does not retry before the initial pass (the pass will cover it)', async () => {
      addRoom('early@conference.example.com', false)
      connectionStore.getState().setServerInfo({ identities: [], domain: 'example.com', features: [NS_MAM] })
      connectionStore.getState().setStatus('disconnected')
      cleanup = setupBackgroundSyncSideEffects(mockClient)
      simulateFreshSession(mockClient)

      // MAM resolves BEFORE the 10s pass — covered by that pass, not the watcher.
      await vi.advanceTimersByTimeAsync(2_000)
      roomStore.getState().updateRoom('early@conference.example.com', { supportsMAM: true })
      await vi.advanceTimersByTimeAsync(100)

      expect(mockClient.internal.mam.catchUpRoom).not.toHaveBeenCalled()
    })
  })

  describe('resume preview seeding (SM resumption)', () => {
    beforeEach(() => {
      vi.useFakeTimers()
    })

    afterEach(() => {
      vi.useRealTimers()
      roomStore.getState().setActiveRoom(null)
      roomStore.getState().reset()
    })

    const addRoom = (
      jid: string,
      opts: { supportsMAM?: boolean; isQuickChat?: boolean } = {},
    ) =>
      roomStore.getState().addRoom({
        jid, name: jid, nickname: 'me', joined: true, isBookmarked: true,
        supportsMAM: opts.supportsMAM ?? true,
        isQuickChat: opts.isQuickChat,
        occupants: new Map(), messages: [], unreadCount: 0, mentionsCount: 0, typingUsers: new Set(),
      })

    const seedPreview = (jid: string) =>
      roomStore.getState().updateLastMessagePreview(jid, {
        type: 'groupchat', id: 'm1', roomJid: jid,
        from: `${jid}/alice`, nick: 'alice', body: 'hi',
        timestamp: new Date(), isOutgoing: false,
      } as RoomMessage)

    const markCaughtUp = (jid: string) =>
      roomStore.setState((s) => ({
        mamQueryStates: new Map(s.mamQueryStates).set(jid, {
          isLoading: false, error: null, hasQueried: true,
          isHistoryComplete: false, isCaughtUpToLive: true,
        }),
      }))

    it('catches up a joined MAM room with no preview on SM resumption', async () => {
      addRoom('unseeded@conference.example.com')
      connectionStore.getState().setStatus('disconnected')
      cleanup = setupBackgroundSyncSideEffects(mockClient)

      simulateSmResumption(mockClient)

      await vi.waitFor(() => {
        expect(mockClient.internal.mam.catchUpRoom).toHaveBeenCalledTimes(1)
      })
      expect(
        (mockClient.internal.mam.catchUpRoom as ReturnType<typeof vi.fn>).mock.calls[0][0],
      ).toBe('unseeded@conference.example.com')
    })

    it('does not catch up a room already caught up to live', async () => {
      addRoom('live@conference.example.com')
      markCaughtUp('live@conference.example.com')
      connectionStore.getState().setStatus('disconnected')
      cleanup = setupBackgroundSyncSideEffects(mockClient)

      simulateSmResumption(mockClient)
      await vi.advanceTimersByTimeAsync(100)

      expect(mockClient.internal.mam.catchUpRoom).not.toHaveBeenCalled()
    })

    it('catches up a previewed room that is not caught up to live (open gap)', async () => {
      // Widened scope: a room with a preview but an unfilled forward gap
      // (isCaughtUpToLive false) is refreshed on resume, not left stale until opened.
      addRoom('gap@conference.example.com')
      seedPreview('gap@conference.example.com')
      connectionStore.getState().setStatus('disconnected')
      cleanup = setupBackgroundSyncSideEffects(mockClient)

      simulateSmResumption(mockClient)

      await vi.waitFor(() => {
        expect(mockClient.internal.mam.catchUpRoom).toHaveBeenCalledTimes(1)
      })
      expect(
        (mockClient.internal.mam.catchUpRoom as ReturnType<typeof vi.fn>).mock.calls[0][0],
      ).toBe('gap@conference.example.com')
    })

    it('does not catch up QuickChat rooms', async () => {
      addRoom('quick@conference.example.com', { isQuickChat: true })
      connectionStore.getState().setStatus('disconnected')
      cleanup = setupBackgroundSyncSideEffects(mockClient)

      simulateSmResumption(mockClient)
      await vi.advanceTimersByTimeAsync(100)

      expect(mockClient.internal.mam.catchUpRoom).not.toHaveBeenCalled()
    })

    it('does not catch up rooms that do not support MAM', async () => {
      addRoom('nomam@conference.example.com', { supportsMAM: false })
      connectionStore.getState().setStatus('disconnected')
      cleanup = setupBackgroundSyncSideEffects(mockClient)

      simulateSmResumption(mockClient)
      await vi.advanceTimersByTimeAsync(100)

      expect(mockClient.internal.mam.catchUpRoom).not.toHaveBeenCalled()
    })

    it('does not catch up the active room (handled by roomSideEffects)', async () => {
      addRoom('active@conference.example.com')
      roomStore.getState().setActiveRoom('active@conference.example.com')
      connectionStore.getState().setStatus('disconnected')
      cleanup = setupBackgroundSyncSideEffects(mockClient)

      simulateSmResumption(mockClient)
      await vi.advanceTimersByTimeAsync(100)

      expect(mockClient.internal.mam.catchUpRoom).not.toHaveBeenCalledWith(
        'active@conference.example.com',
        expect.anything(),
      )
    })

    // The resume seed is evaluated ONCE, synchronously, when 'resumed' fires —
    // but handleSmResumption re-fetches bookmarks after a long disconnect and
    // joins every room that is not currently joined, which lands hundreds of ms
    // LATER. Such a room was not in joinedRooms() when the predicate ran, so it
    // never got a seed; and every other trigger that could have covered it is
    // gated on a FRESH session (the room:joined catch-up and the late-MAM retry)
    // or on `!isSmResumed()` (the mucJoined preview fetch). It therefore received
    // no archive coverage at all for the whole session: no preview, sidebar order
    // pinned at epoch 0, and `isCaughtUpToLive` false, which keeps the unread
    // recount deferring behind the coverage gate.
    it('catches up a room that joins AFTER resumption (bookmark re-join)', async () => {
      addRoom('late@conference.example.com')
      roomStore.getState().setRoomJoined('late@conference.example.com', false)
      connectionStore.getState().setStatus('disconnected')
      cleanup = setupBackgroundSyncSideEffects(mockClient)

      simulateSmResumption(mockClient)
      await vi.advanceTimersByTimeAsync(300)
      // Nothing was eligible at resume time — the room was still unjoined.
      expect(mockClient.internal.mam.catchUpRoom).not.toHaveBeenCalled()

      roomStore.getState().setRoomJoined('late@conference.example.com', true)
      mockClient._emitSDK('room:joined', {
        roomJid: 'late@conference.example.com', joined: true,
      })

      await vi.waitFor(() => {
        expect(mockClient.internal.mam.catchUpRoom).toHaveBeenCalledTimes(1)
      })
      expect(
        (mockClient.internal.mam.catchUpRoom as ReturnType<typeof vi.fn>).mock.calls[0][0],
      ).toBe('late@conference.example.com')
    })

    it('catches up a room whose MAM support resolves AFTER it joins on a resumed session', async () => {
      // The post-join disco re-query (MUC) can flip supportsMAM well after
      // self-presence. On a fresh session the late-MAM retry covers that; on a
      // resumed one it must too, or the disco race reopens the same hole.
      addRoom('latemam@conference.example.com', { supportsMAM: false })
      roomStore.getState().setRoomJoined('latemam@conference.example.com', false)
      connectionStore.getState().setStatus('disconnected')
      cleanup = setupBackgroundSyncSideEffects(mockClient)

      simulateSmResumption(mockClient)
      await vi.advanceTimersByTimeAsync(300)

      roomStore.getState().setRoomJoined('latemam@conference.example.com', true)
      mockClient._emitSDK('room:joined', {
        roomJid: 'latemam@conference.example.com', joined: true,
      })
      await vi.advanceTimersByTimeAsync(100)
      expect(mockClient.internal.mam.catchUpRoom).not.toHaveBeenCalled()

      roomStore.getState().updateRoom('latemam@conference.example.com', { supportsMAM: true })

      await vi.waitFor(() => {
        expect(mockClient.internal.mam.catchUpRoom).toHaveBeenCalledTimes(1)
      })
      expect(
        (mockClient.internal.mam.catchUpRoom as ReturnType<typeof vi.fn>).mock.calls[0][0],
      ).toBe('latemam@conference.example.com')
    })

    // Discrimination for the two tests above: seeding EVERY room that joins on a
    // resumed session would satisfy them while re-querying archives SM already
    // covered — the exact cost the coverage predicate exists to avoid. A room
    // that is caught up to live must still be skipped when it re-joins.
    it('does not catch up a caught-up room that re-joins on a resumed session', async () => {
      addRoom('livelate@conference.example.com')
      markCaughtUp('livelate@conference.example.com')
      roomStore.getState().setRoomJoined('livelate@conference.example.com', false)
      connectionStore.getState().setStatus('disconnected')
      cleanup = setupBackgroundSyncSideEffects(mockClient)

      simulateSmResumption(mockClient)
      await vi.advanceTimersByTimeAsync(300)

      roomStore.getState().setRoomJoined('livelate@conference.example.com', true)
      mockClient._emitSDK('room:joined', {
        roomJid: 'livelate@conference.example.com', joined: true,
      })
      await vi.advanceTimersByTimeAsync(1_000)

      expect(mockClient.internal.mam.catchUpRoom).not.toHaveBeenCalled()
    })

    // Second discrimination axis: the seed must be scoped to RESUMED sessions.
    // A fresh session owns its rooms through the delayed pass
    // (catchUpRoomHistory, which carries the session-start cursor and read-pointer
    // stitching); routing them through catchUpRoom as well would double-query
    // every room on every fresh connect.
    it('does not seed a fresh-session join through the resume path', async () => {
      addRoom('fresh@conference.example.com')
      roomStore.getState().setRoomJoined('fresh@conference.example.com', false)
      connectionStore.getState().setServerInfo({
        identities: [], domain: 'example.com', features: [NS_MAM],
      })
      connectionStore.getState().setStatus('disconnected')
      cleanup = setupBackgroundSyncSideEffects(mockClient)

      simulateFreshSession(mockClient)
      await vi.advanceTimersByTimeAsync(300)

      roomStore.getState().setRoomJoined('fresh@conference.example.com', true)
      mockClient._emitSDK('room:joined', {
        roomJid: 'fresh@conference.example.com', joined: true,
      })
      await vi.advanceTimersByTimeAsync(30_000)

      expect(mockClient.internal.mam.catchUpRoom).not.toHaveBeenCalled()
    })

    // A room joining while the transport is DOWN must not seed either: the
    // offline transition ends the session, and the next 'online'/'resumed' owns
    // the catch-up decision.
    it('does not seed a join that lands after the session went offline', async () => {
      addRoom('offline@conference.example.com')
      roomStore.getState().setRoomJoined('offline@conference.example.com', false)
      connectionStore.getState().setStatus('disconnected')
      cleanup = setupBackgroundSyncSideEffects(mockClient)

      simulateSmResumption(mockClient)
      await vi.advanceTimersByTimeAsync(100)
      connectionStore.getState().setStatus('reconnecting')

      roomStore.getState().setRoomJoined('offline@conference.example.com', true)
      mockClient._emitSDK('room:joined', {
        roomJid: 'offline@conference.example.com', joined: true,
      })
      await vi.advanceTimersByTimeAsync(1_000)

      expect(mockClient.internal.mam.catchUpRoom).not.toHaveBeenCalled()
    })
  })

  describe('room member discovery (Stage 5)', () => {
    beforeEach(() => {
      vi.useFakeTimers()
    })

    afterEach(() => {
      vi.useRealTimers()
      roomStore.getState().reset()
    })

    it('should query members for joined non-quickchat rooms after room catch-up', async () => {
      // Add joined rooms
      roomStore.getState().addRoom({
        jid: 'room1@conference.example.com',
        name: 'Room 1',
        nickname: 'me',
        joined: true,
        isBookmarked: true,
        occupants: new Map(),
        messages: [],
        unreadCount: 0,
        mentionsCount: 0,
        typingUsers: new Set(),
      })
      roomStore.getState().addRoom({
        jid: 'room2@conference.example.com',
        name: 'Room 2',
        nickname: 'me',
        joined: true,
        isBookmarked: true,
        isQuickChat: true, // Should be excluded
        occupants: new Map(),
        messages: [],
        unreadCount: 0,
        mentionsCount: 0,
        typingUsers: new Set(),
      })

      connectionStore.getState().setServerInfo({
        identities: [],
        domain: 'example.com',
        features: [NS_MAM],
      })

      connectionStore.getState().setStatus('disconnected')
      cleanup = setupBackgroundSyncSideEffects(mockClient)

      simulateFreshSession(mockClient)

      // Advance past room catch-up timer (10s)
      await vi.advanceTimersByTimeAsync(10_000)

      // Wait for room catch-up to complete and member discovery to start
      await vi.waitFor(() => {
        expect(mockClient.muc.queryRoomMembers).toHaveBeenCalledTimes(1)
      })

      // Should query Room 1 but NOT quickchat Room 2
      expect(mockClient.muc.queryRoomMembers).toHaveBeenCalledWith('room1@conference.example.com')
      expect(mockClient.muc.queryRoomMembers).not.toHaveBeenCalledWith('room2@conference.example.com')
    })

    it('should not crash if member discovery fails', async () => {
      roomStore.getState().addRoom({
        jid: 'room1@conference.example.com',
        name: 'Room 1',
        nickname: 'me',
        joined: true,
        isBookmarked: true,
        occupants: new Map(),
        messages: [],
        unreadCount: 0,
        mentionsCount: 0,
        typingUsers: new Set(),
      })

      ;(mockClient.muc.queryRoomMembers as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('network error'))

      connectionStore.getState().setServerInfo({
        identities: [],
        domain: 'example.com',
        features: [NS_MAM],
      })

      connectionStore.getState().setStatus('disconnected')
      cleanup = setupBackgroundSyncSideEffects(mockClient)

      simulateFreshSession(mockClient)

      await vi.advanceTimersByTimeAsync(10_000)

      // Should not throw — error is silently caught
      await vi.waitFor(() => {
        expect(mockClient.muc.queryRoomMembers).toHaveBeenCalled()
      })
    })
  })
})

// ---------------------------------------------------------------------------
// E2EE capability warm-up tests
// ---------------------------------------------------------------------------
describe('E2EE capability warm-up on fresh session', () => {
  let mockClient: ReturnType<typeof createMockClient>
  let cleanup: () => void

  function makeE2EEManager(canEncryptTo = vi.fn().mockResolvedValue(true)) {
    return { canEncryptTo }
  }

  function seedConversations(entries: { id: string; type: 'chat' | 'groupchat' }[]) {
    chatStore.setState({
      conversationEntities: new Map(
        entries.map(e => [e.id, { id: e.id, name: e.id, type: e.type }]),
      ),
    })
  }

  beforeEach(() => {
    vi.useFakeTimers()
    _resetStorageScopeForTesting()
    connectionStore.getState().reset()
    chatStore.getState().reset()
    mockClient = createMockClient()
    localStorageMock.clear()
  })

  afterEach(() => {
    vi.useRealTimers()
    cleanup?.()
    chatStore.getState().reset()
  })

  it('probes all 1:1 conversation JIDs on fresh session', async () => {
    seedConversations([
      { id: 'alice@example.com', type: 'chat' },
      { id: 'bob@example.com', type: 'chat' },
    ])
    const canEncryptTo = vi.fn().mockResolvedValue(true)
    mockClient.e2ee = makeE2EEManager(canEncryptTo) as any

    cleanup = setupBackgroundSyncSideEffects(mockClient)
    simulateFreshSession(mockClient)
    await vi.runAllTimersAsync()

    expect(canEncryptTo).toHaveBeenCalledWith({ kind: 'direct', peer: 'alice@example.com' })
    expect(canEncryptTo).toHaveBeenCalledWith({ kind: 'direct', peer: 'bob@example.com' })
    expect(canEncryptTo).toHaveBeenCalledTimes(2)
  })

  it('does NOT probe groupchat conversations', async () => {
    seedConversations([
      { id: 'alice@example.com', type: 'chat' },
      { id: 'room@conference.example.com', type: 'groupchat' },
    ])
    const canEncryptTo = vi.fn().mockResolvedValue(false)
    mockClient.e2ee = makeE2EEManager(canEncryptTo) as any

    cleanup = setupBackgroundSyncSideEffects(mockClient)
    simulateFreshSession(mockClient)
    await vi.runAllTimersAsync()

    expect(canEncryptTo).toHaveBeenCalledTimes(1)
    expect(canEncryptTo).toHaveBeenCalledWith({ kind: 'direct', peer: 'alice@example.com' })
    expect(canEncryptTo).not.toHaveBeenCalledWith(
      expect.objectContaining({ peer: 'room@conference.example.com' }),
    )
  })

  it('does NOT probe during SM resumption', async () => {
    seedConversations([{ id: 'alice@example.com', type: 'chat' }])
    const canEncryptTo = vi.fn().mockResolvedValue(true)
    mockClient.e2ee = makeE2EEManager(canEncryptTo) as any

    cleanup = setupBackgroundSyncSideEffects(mockClient)
    // SM resumption fires 'resumed', not 'online'
    connectionStore.getState().setStatus('online')
    mockClient._emit('resumed')
    await vi.runAllTimersAsync()

    expect(canEncryptTo).not.toHaveBeenCalled()
  })

  it('stops probing when disconnected mid-warmup', async () => {
    seedConversations([
      { id: 'alice@example.com', type: 'chat' },
      { id: 'bob@example.com', type: 'chat' },
      { id: 'carol@example.com', type: 'chat' },
      { id: 'dave@example.com', type: 'chat' },
    ])
    // Disconnect after the first batch (2 probes)
    mockClient.isConnected
      .mockReturnValueOnce(true)  // batch 1 guard — proceed
      .mockReturnValue(false)     // batch 2 guard — abort

    const canEncryptTo = vi.fn().mockResolvedValue(true)
    mockClient.e2ee = makeE2EEManager(canEncryptTo) as any

    cleanup = setupBackgroundSyncSideEffects(mockClient)
    simulateFreshSession(mockClient)
    await vi.runAllTimersAsync()

    // Only first batch of 2 should have been probed
    expect(canEncryptTo).toHaveBeenCalledTimes(2)
  })

  it('silently ignores probe errors and continues remaining batches', async () => {
    seedConversations([
      { id: 'alice@example.com', type: 'chat' },
      { id: 'bob@example.com', type: 'chat' },
    ])
    const canEncryptTo = vi.fn().mockRejectedValue(new Error('PEP timeout'))
    mockClient.e2ee = makeE2EEManager(canEncryptTo) as any

    cleanup = setupBackgroundSyncSideEffects(mockClient)
    // Should not throw despite every probe failing
    await expect(
      (async () => {
        simulateFreshSession(mockClient)
        await vi.runAllTimersAsync()
      })(),
    ).resolves.not.toThrow()

    expect(canEncryptTo).toHaveBeenCalledTimes(2)
  })

  it('skips warm-up when no E2EE manager is registered', async () => {
    seedConversations([{ id: 'alice@example.com', type: 'chat' }])
    mockClient.e2ee = null as any

    cleanup = setupBackgroundSyncSideEffects(mockClient)
    // Should not throw when e2ee is null
    await expect(
      (async () => {
        simulateFreshSession(mockClient)
        await vi.runAllTimersAsync()
      })(),
    ).resolves.not.toThrow()
  })

  it('skips warm-up when there are no conversations', async () => {
    // conversationEntities is empty (reset() above)
    const canEncryptTo = vi.fn().mockResolvedValue(true)
    mockClient.e2ee = makeE2EEManager(canEncryptTo) as any

    cleanup = setupBackgroundSyncSideEffects(mockClient)
    simulateFreshSession(mockClient)
    await vi.runAllTimersAsync()

    expect(canEncryptTo).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// Deferred E2EE decryption triggers
// ---------------------------------------------------------------------------
describe('deferred E2EE decryption triggers', () => {
  let mockClient: ReturnType<typeof createMockClient>
  let cleanup: () => void

  beforeEach(() => {
    _resetStorageScopeForTesting()
    connectionStore.getState().reset()
    mockClient = createMockClient()
    localStorageMock.clear()
  })

  afterEach(() => {
    cleanup?.()
  })

  it('calls retryPendingDecrypts when e2ee:plugin-registered fires', () => {
    cleanup = setupBackgroundSyncSideEffects(mockClient)

    mockClient._emitSDK('e2ee:plugin-registered', { pluginId: 'openpgp' })

    expect(mockClient.retryPendingDecrypts).toHaveBeenCalledTimes(1)
  })

  it('calls retryPendingDecrypts when e2ee:key-unlocked fires', () => {
    cleanup = setupBackgroundSyncSideEffects(mockClient)

    mockClient._emitSDK('e2ee:key-unlocked', undefined)

    expect(mockClient.retryPendingDecrypts).toHaveBeenCalledTimes(1)
  })
})
