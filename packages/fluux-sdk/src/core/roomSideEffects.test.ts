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
  flushPendingRoomMessages: vi.fn().mockResolvedValue(undefined),
}))

import { setupRoomSideEffects } from './roomSideEffects'
import { roomStore } from '../stores/roomStore'
import { connectionStore } from '../stores/connectionStore'
import { createMockClient, simulateFreshSession, simulateSmResumption } from './sideEffects.testHelpers'

describe('setupRoomSideEffects', () => {
  let mockClient: ReturnType<typeof createMockClient>
  let cleanup: () => void

  beforeEach(() => {
    roomStore.getState().reset()
    connectionStore.getState().reset()
    mockClient = createMockClient()
  })

  afterEach(() => {
    cleanup?.()
  })

  describe('supportsMAM subscription', () => {
    it('should trigger MAM fetch when supportsMAM becomes true on active room (fresh session)', async () => {
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

      roomStore.getState().setActiveRoom('room@conference.example.com')

      cleanup = setupRoomSideEffects(mockClient)

      // Simulate fresh session so isFreshSession = true
      simulateFreshSession(mockClient)

      await vi.waitFor(() => {
        expect((mockClient.chat.queryRoomMAM as ReturnType<typeof vi.fn>).mock.calls.length).toBe(0)
      })

      roomStore.getState().updateRoom('room@conference.example.com', {
        joined: true,
        supportsMAM: true,
      })

      await vi.waitFor(() => {
        expect(mockClient.chat.queryRoomMAM).toHaveBeenCalledWith(
          expect.objectContaining({
            roomJid: 'room@conference.example.com',
          })
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

      roomStore.getState().setActiveRoom('room@conference.example.com')

      await vi.waitFor(() => {
        expect(mockClient.chat.queryRoomMAM).toHaveBeenCalledTimes(1)
      })

      ;(mockClient.chat.queryRoomMAM as ReturnType<typeof vi.fn>).mockClear()

      roomStore.getState().updateRoom('room@conference.example.com', {
        name: 'Updated Room Name',
      })

      await new Promise(resolve => setTimeout(resolve, 50))
      expect(mockClient.chat.queryRoomMAM).not.toHaveBeenCalled()
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
      expect(mockClient.chat.queryRoomMAM).not.toHaveBeenCalled()
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
      expect(mockClient.chat.queryRoomMAM).not.toHaveBeenCalled()
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
      expect(mockClient.chat.queryRoomMAM).not.toHaveBeenCalled()
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

  describe('reconnection', () => {
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

      await vi.waitFor(() => {
        expect(mockClient.chat.queryRoomMAM).toHaveBeenCalledWith(
          expect.objectContaining({
            roomJid: 'room@conference.example.com',
          })
        )
      })
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
      expect(mockClient.chat.queryRoomMAM).not.toHaveBeenCalled()
    })

    it('should NOT trigger MAM when supportsMAM becomes true during SM resumption', async () => {
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

      // SM resumption (not fresh session)
      simulateSmResumption(mockClient)

      // supportsMAM transition during SM resumed session
      roomStore.getState().updateRoom('room@conference.example.com', {
        supportsMAM: true,
      })

      await new Promise(resolve => setTimeout(resolve, 50))
      expect(mockClient.chat.queryRoomMAM).not.toHaveBeenCalled()
    })

    it('should NOT trigger MAM when room joined state changes during SM resumption', async () => {
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

      // SM resumption (not fresh session)
      simulateSmResumption(mockClient)

      // joined transition during SM resumed session (e.g., server replaying self-presence)
      roomStore.getState().setRoomJoined('room@conference.example.com', true)

      await new Promise(resolve => setTimeout(resolve, 50))
      expect(mockClient.chat.queryRoomMAM).not.toHaveBeenCalled()
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
      expect(mockClient.chat.queryRoomMAM).not.toHaveBeenCalled()

      // Then: disconnect and fresh session — should trigger MAM
      connectionStore.getState().setStatus('reconnecting')
      simulateFreshSession(mockClient)

      await vi.waitFor(() => {
        expect(mockClient.chat.queryRoomMAM).toHaveBeenCalledWith(
          expect.objectContaining({
            roomJid: 'room@conference.example.com',
          })
        )
      })
    })
  })
})
