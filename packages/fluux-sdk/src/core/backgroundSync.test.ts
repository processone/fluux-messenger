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
import { connectionStore } from '../stores/connectionStore'
import { chatStore } from '../stores/chatStore'
import { roomStore } from '../stores/roomStore'
import { NS_MAM } from './namespaces'
import { createMockClient, simulateFreshSession } from './sideEffects.testHelpers'
import { _resetStorageScopeForTesting } from '../utils/storageScope'

describe('setupBackgroundSyncSideEffects', () => {
  const ARCHIVED_CHECK_KEY = 'fluux:lastArchivedPreviewCheck'
  const ROSTER_DISCOVERY_KEY = 'fluux:lastRosterDiscovery'
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
        expect(mockClient.mam.catchUpAllConversations).toHaveBeenCalledTimes(1)
      })
      // Must pass sessionStartTime so the 1:1 forward cursor excludes live messages
      // that arrive during catch-up (parity with rooms / Bug A).
      expect(mockClient.mam.catchUpAllConversations).toHaveBeenCalledWith(
        expect.objectContaining({ sessionStartTime: expect.any(Number) })
      )
    })

    it('should defer catch-up to serverInfo discovery when MAM not immediately available', async () => {
      connectionStore.getState().setStatus('disconnected')
      cleanup = setupBackgroundSyncSideEffects(mockClient)

      simulateFreshSession(mockClient)

      await new Promise(resolve => setTimeout(resolve, 50))
      expect(mockClient.mam.catchUpAllConversations).not.toHaveBeenCalled()

      connectionStore.getState().setServerInfo({
        identities: [],
        domain: 'example.com',
        features: [NS_MAM],
      })

      await vi.waitFor(() => {
        expect(mockClient.mam.catchUpAllConversations).toHaveBeenCalledTimes(1)
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
        expect(mockClient.mam.catchUpAllConversations).toHaveBeenCalledTimes(1)
      })

      connectionStore.getState().setServerInfo({
        identities: [],
        domain: 'example.com',
        features: [NS_MAM, 'some:other:feature'],
      })

      await new Promise(resolve => setTimeout(resolve, 50))
      expect(mockClient.mam.catchUpAllConversations).toHaveBeenCalledTimes(1)
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
        expect(mockClient.mam.catchUpAllConversations).toHaveBeenCalledTimes(1)
      })

      connectionStore.getState().setStatus('disconnected')

      simulateFreshSession(mockClient)
      await vi.waitFor(() => {
        expect(mockClient.mam.catchUpAllConversations).toHaveBeenCalledTimes(2)
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
        expect(mockClient.mam.catchUpAllConversations).toHaveBeenCalledWith(
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
        expect(mockClient.mam.catchUpAllConversations).toHaveBeenCalledTimes(1)
      })

      expect(mockClient.mam.refreshConversationPreviews).not.toHaveBeenCalled()
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
        expect(mockClient.mam.refreshArchivedConversationPreviews).toHaveBeenCalledTimes(1)
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
        expect(mockClient.mam.catchUpAllConversations).toHaveBeenCalledTimes(1)
      })

      await new Promise(resolve => setTimeout(resolve, 50))
      expect(mockClient.mam.refreshArchivedConversationPreviews).not.toHaveBeenCalled()
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
        expect(mockClient.mam.refreshArchivedConversationPreviews).toHaveBeenCalledTimes(1)
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
        expect(mockClient.mam.discoverNewConversationsFromRoster).toHaveBeenCalledTimes(1)
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
        expect(mockClient.mam.catchUpAllConversations).toHaveBeenCalledTimes(1)
      })

      await new Promise(resolve => setTimeout(resolve, 50))
      expect(mockClient.mam.discoverNewConversationsFromRoster).not.toHaveBeenCalled()
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
        expect(mockClient.mam.discoverNewConversationsFromRoster).toHaveBeenCalledTimes(1)
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
        expect(mockClient.mam.discoverNewConversationsFromRoster).toHaveBeenCalledTimes(1)
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
    })

    it('should trigger catchUpAllConversations with concurrency 2', async () => {
      ;(mockClient.mam.catchUpAllConversations as ReturnType<typeof vi.fn>).mockResolvedValue(undefined)

      connectionStore.getState().setServerInfo({
        identities: [],
        domain: 'example.com',
        features: [NS_MAM],
      })

      connectionStore.getState().setStatus('disconnected')
      cleanup = setupBackgroundSyncSideEffects(mockClient)

      simulateFreshSession(mockClient)

      await vi.waitFor(() => {
        expect(mockClient.mam.catchUpAllConversations).toHaveBeenCalledTimes(1)
      })

      expect(mockClient.mam.catchUpAllConversations).toHaveBeenCalledWith(
        expect.objectContaining({ concurrency: 2 })
      )
    })

    it('should trigger catchUpAllRooms after a delay', async () => {
      connectionStore.getState().setServerInfo({
        identities: [],
        domain: 'example.com',
        features: [NS_MAM],
      })

      connectionStore.getState().setStatus('disconnected')
      cleanup = setupBackgroundSyncSideEffects(mockClient)

      simulateFreshSession(mockClient)

      await vi.advanceTimersByTimeAsync(1_000)
      expect(mockClient.mam.catchUpAllRooms).not.toHaveBeenCalled()

      await vi.advanceTimersByTimeAsync(10_000)

      expect(mockClient.mam.catchUpAllRooms).toHaveBeenCalledTimes(1)
      // Must pass the session-start time so the forward cursor excludes live
      // messages that arrive during the 10s catch-up window (silent-gap fix).
      expect(mockClient.mam.catchUpAllRooms).toHaveBeenCalledWith(
        expect.objectContaining({ concurrency: 2, sessionStartTime: expect.any(Number) })
      )
    })

    it('should cancel room catch-up timer on disconnect', async () => {
      connectionStore.getState().setServerInfo({
        identities: [],
        domain: 'example.com',
        features: [NS_MAM],
      })

      connectionStore.getState().setStatus('disconnected')
      cleanup = setupBackgroundSyncSideEffects(mockClient)

      simulateFreshSession(mockClient)

      await vi.advanceTimersByTimeAsync(5_000)
      connectionStore.getState().setStatus('disconnected')

      await vi.advanceTimersByTimeAsync(10_000)

      expect(mockClient.mam.catchUpAllRooms).not.toHaveBeenCalled()
    })

    it('should re-trigger catch-up on reconnect', async () => {
      ;(mockClient.mam.catchUpAllConversations as ReturnType<typeof vi.fn>).mockResolvedValue(undefined)

      connectionStore.getState().setServerInfo({
        identities: [],
        domain: 'example.com',
        features: [NS_MAM],
      })

      connectionStore.getState().setStatus('disconnected')
      cleanup = setupBackgroundSyncSideEffects(mockClient)

      simulateFreshSession(mockClient)
      await vi.waitFor(() => {
        expect(mockClient.mam.catchUpAllConversations).toHaveBeenCalledTimes(1)
      })

      await vi.advanceTimersByTimeAsync(10_000)
      await vi.waitFor(() => {
        expect(mockClient.mam.catchUpAllRooms).toHaveBeenCalledTimes(1)
      })

      connectionStore.getState().setStatus('disconnected')

      simulateFreshSession(mockClient)
      await vi.waitFor(() => {
        expect(mockClient.mam.catchUpAllConversations).toHaveBeenCalledTimes(2)
      })

      await vi.advanceTimersByTimeAsync(10_000)
      await vi.waitFor(() => {
        expect(mockClient.mam.catchUpAllRooms).toHaveBeenCalledTimes(2)
      })
    })

    it('should pass exclude with activeRoomJid to catchUpAllRooms', async () => {
      // Set active room before connecting
      roomStore.getState().setActiveRoom('room@conference.example.com')

      connectionStore.getState().setServerInfo({
        identities: [],
        domain: 'example.com',
        features: [NS_MAM],
      })

      connectionStore.getState().setStatus('disconnected')
      cleanup = setupBackgroundSyncSideEffects(mockClient)

      simulateFreshSession(mockClient)

      await vi.advanceTimersByTimeAsync(10_000)

      await vi.waitFor(() => {
        expect(mockClient.mam.catchUpAllRooms).toHaveBeenCalledWith(
          expect.objectContaining({ exclude: 'room@conference.example.com' })
        )
      })

      // Clean up
      roomStore.getState().setActiveRoom(null)
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

      // Initial 10s pass — room is not MAM-ready, so it's not covered and not retried yet.
      await vi.advanceTimersByTimeAsync(10_000)
      expect(mockClient.mam.catchUpRoom).not.toHaveBeenCalled()

      // Disco resolves AFTER the pass → late retry fires for this room.
      roomStore.getState().updateRoom('late@conference.example.com', { supportsMAM: true })

      await vi.waitFor(() => {
        expect(mockClient.mam.catchUpRoom).toHaveBeenCalledWith('late@conference.example.com', expect.any(Number))
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

      expect(mockClient.mam.catchUpRoom).not.toHaveBeenCalledWith('active@conference.example.com', expect.anything())
    })

    it('does not retry before the initial pass (the pass will cover it)', async () => {
      addRoom('early@conference.example.com', false)
      connectionStore.getState().setServerInfo({ identities: [], domain: 'example.com', features: [NS_MAM] })
      connectionStore.getState().setStatus('disconnected')
      cleanup = setupBackgroundSyncSideEffects(mockClient)
      simulateFreshSession(mockClient)

      // MAM resolves BEFORE the 10s pass — covered by catchUpAllRooms, not the watcher.
      await vi.advanceTimersByTimeAsync(2_000)
      roomStore.getState().updateRoom('early@conference.example.com', { supportsMAM: true })
      await vi.advanceTimersByTimeAsync(100)

      expect(mockClient.mam.catchUpRoom).not.toHaveBeenCalled()
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
