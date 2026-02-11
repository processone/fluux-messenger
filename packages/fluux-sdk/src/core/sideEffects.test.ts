/**
 * Tests for store-based side effects.
 *
 * These tests verify that MAM queries are triggered at the right times:
 * - When a conversation/room becomes active
 * - When connection status changes (reconnection)
 * - When MAM support is discovered for the active conversation/room
 */
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest'

// Mock localStorage before importing stores
const localStorageMock = (() => {
  let store: Record<string, string> = {}
  return {
    getItem: vi.fn((key: string) => store[key] || null),
    setItem: vi.fn((key: string, value: string) => {
      store[key] = value
    }),
    removeItem: vi.fn((key: string) => {
      delete store[key]
    }),
    clear: vi.fn(() => {
      store = {}
    }),
    get _store() {
      return store
    },
  }
})()

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

import { setupRoomSideEffects, setupChatSideEffects } from './sideEffects'
import { roomStore } from '../stores/roomStore'
import { chatStore } from '../stores/chatStore'
import { connectionStore } from '../stores/connectionStore'
import type { XMPPClient } from './XMPPClient'
import { NS_MAM } from './namespaces'

// Create a minimal mock XMPPClient for testing side effects
function createMockClient(): XMPPClient {
  return {
    chat: {
      queryMAM: vi.fn().mockResolvedValue(undefined),
      queryRoomMAM: vi.fn().mockResolvedValue(undefined),
    },
  } as unknown as XMPPClient
}

describe('sideEffects', () => {
  let mockClient: XMPPClient
  let cleanup: () => void

  beforeEach(() => {
    // Reset all stores
    roomStore.getState().reset()
    chatStore.getState().reset()
    connectionStore.getState().reset()

    // Create fresh mock client
    mockClient = createMockClient()
  })

  afterEach(() => {
    // Clean up subscriptions
    cleanup?.()
  })

  describe('setupRoomSideEffects', () => {
    describe('supportsMAM subscription', () => {
      it('should trigger MAM fetch when supportsMAM becomes true on active room', async () => {
        // Set up connection as online
        connectionStore.getState().setStatus('online')

        // Add a room without MAM support
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

        // Set room as active (simulating session restore)
        roomStore.getState().setActiveRoom('room@conference.example.com')

        // Set up side effects AFTER setting active room
        // (simulating the race condition where view is restored before joining)
        cleanup = setupRoomSideEffects(mockClient)

        // Wait for any immediate async effects
        await vi.waitFor(() => {
          // At this point, supportsMAM is false, so no MAM query should have been made
          expect((mockClient.chat.queryRoomMAM as ReturnType<typeof vi.fn>).mock.calls.length).toBe(0)
        })

        // Now simulate room joining and disco#info discovering MAM support
        roomStore.getState().updateRoom('room@conference.example.com', {
          joined: true,
          supportsMAM: true,
        })

        // Wait for the subscription to trigger MAM fetch
        await vi.waitFor(() => {
          expect(mockClient.chat.queryRoomMAM).toHaveBeenCalledWith(
            expect.objectContaining({
              roomJid: 'room@conference.example.com',
            })
          )
        })
      })

      it('should not trigger MAM fetch if supportsMAM was already true', async () => {
        // Set up connection as online
        connectionStore.getState().setStatus('online')

        // Add a room WITH MAM support already
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

        // Set up side effects
        cleanup = setupRoomSideEffects(mockClient)

        // Set room as active
        roomStore.getState().setActiveRoom('room@conference.example.com')

        // Wait for MAM fetch from activeRoomJid change
        await vi.waitFor(() => {
          expect(mockClient.chat.queryRoomMAM).toHaveBeenCalledTimes(1)
        })

        // Clear mock to track new calls
        ;(mockClient.chat.queryRoomMAM as ReturnType<typeof vi.fn>).mockClear()

        // Update room but supportsMAM stays true
        roomStore.getState().updateRoom('room@conference.example.com', {
          name: 'Updated Room Name',
        })

        // Wait a bit and verify no additional MAM query was triggered
        await new Promise(resolve => setTimeout(resolve, 50))
        expect(mockClient.chat.queryRoomMAM).not.toHaveBeenCalled()
      })

      it('should not trigger MAM fetch when supportsMAM becomes true on inactive room', async () => {
        // Set up connection as online
        connectionStore.getState().setStatus('online')

        // Add two rooms without MAM support
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

        // Set one room as active
        roomStore.getState().setActiveRoom('active-room@conference.example.com')

        // Set up side effects
        cleanup = setupRoomSideEffects(mockClient)

        // Update supportsMAM on the INACTIVE room
        roomStore.getState().updateRoom('inactive-room@conference.example.com', {
          joined: true,
          supportsMAM: true,
        })

        // Wait a bit and verify no MAM query was triggered (neither room has been fetched)
        await new Promise(resolve => setTimeout(resolve, 50))
        expect(mockClient.chat.queryRoomMAM).not.toHaveBeenCalled()
      })

      it('should not trigger MAM fetch when no room is active', async () => {
        // Set up connection as online
        connectionStore.getState().setStatus('online')

        // Add a room without MAM support
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

        // Set up side effects WITHOUT setting an active room
        cleanup = setupRoomSideEffects(mockClient)

        // Update supportsMAM
        roomStore.getState().updateRoom('room@conference.example.com', {
          joined: true,
          supportsMAM: true,
        })

        // Wait a bit and verify no MAM query was triggered
        await new Promise(resolve => setTimeout(resolve, 50))
        expect(mockClient.chat.queryRoomMAM).not.toHaveBeenCalled()
      })

      it('should not trigger MAM fetch for Quick Chat rooms even when supportsMAM becomes true', async () => {
        // Set up connection as online
        connectionStore.getState().setStatus('online')

        // Add a Quick Chat room
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

        // Set room as active
        roomStore.getState().setActiveRoom('quickchat@conference.example.com')

        // Set up side effects
        cleanup = setupRoomSideEffects(mockClient)

        // Update supportsMAM
        roomStore.getState().updateRoom('quickchat@conference.example.com', {
          joined: true,
          supportsMAM: true,
        })

        // Wait a bit and verify no MAM query was triggered
        await new Promise(resolve => setTimeout(resolve, 50))
        expect(mockClient.chat.queryRoomMAM).not.toHaveBeenCalled()
      })
    })

    describe('cache loading with existing messages', () => {
      it('should load from cache even when room already has live messages in memory', async () => {
        // Regression test: When a room receives live messages while the user views
        // another room, those live messages are the only messages in memory.
        // Cache loading must NOT be skipped just because messages exist.
        connectionStore.getState().setStatus('online')

        // Add a room with live messages already in memory (simulating messages
        // received while viewing another conversation)
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
          messages: [liveMessage], // Room already has a live message
          unreadCount: 1,
          mentionsCount: 0,
          typingUsers: new Set(),
          isBookmarked: true,
        })

        // Spy on loadMessagesFromCache
        const loadSpy = vi.spyOn(roomStore.getState(), 'loadMessagesFromCache')

        // Set up side effects
        cleanup = setupRoomSideEffects(mockClient)

        // Switch to the room (triggers side effect)
        roomStore.getState().setActiveRoom('room@conference.example.com')

        // Wait for async cache loading
        await vi.waitFor(() => {
          expect(loadSpy).toHaveBeenCalledWith('room@conference.example.com', { limit: 100 })
        })

        loadSpy.mockRestore()
      })
    })

    describe('reconnection', () => {
      it('should trigger MAM catchup on reconnection for active room', async () => {
        // Add a room with MAM support
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

        // Set room as active
        roomStore.getState().setActiveRoom('room@conference.example.com')

        // Set up side effects while disconnected
        connectionStore.getState().setStatus('disconnected')
        cleanup = setupRoomSideEffects(mockClient)

        // Simulate reconnection
        connectionStore.getState().setStatus('online')

        // Wait for MAM catchup
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

  describe('setupChatSideEffects', () => {
    describe('cache loading with existing messages', () => {
      it('should load from cache even when conversation already has live messages in memory', async () => {
        // Regression test: When a conversation receives live messages while the user
        // views another conversation, those live messages are the only messages in memory.
        // Cache loading must NOT be skipped just because messages exist.
        connectionStore.getState().setStatus('online')
        connectionStore.getState().setServerInfo({
          identities: [],
          domain: 'example.com',
          features: [NS_MAM],
        })

        // Add a conversation with a live message already in memory
        chatStore.getState().addConversation({
          id: 'contact@example.com',
          name: 'contact@example.com',
          type: 'chat',
          lastMessage: undefined,
          unreadCount: 1,
        })
        chatStore.getState().addMessage({
          type: 'chat',
          id: 'live-msg-1',
          conversationId: 'contact@example.com',
          from: 'contact@example.com',
          body: 'New live message',
          timestamp: new Date('2026-02-04T12:00:00Z'),
          isOutgoing: false,
        })

        // Spy on loadMessagesFromCache
        const loadSpy = vi.spyOn(chatStore.getState(), 'loadMessagesFromCache')

        // Set up side effects
        cleanup = setupChatSideEffects(mockClient)

        // Switch to the conversation (triggers side effect)
        chatStore.getState().setActiveConversation('contact@example.com')

        // Wait for async cache loading
        await vi.waitFor(() => {
          expect(loadSpy).toHaveBeenCalledWith('contact@example.com', { limit: 100 })
        })

        loadSpy.mockRestore()
      })
    })

    describe('serverInfo MAM support subscription', () => {
      it('should trigger MAM fetch when server MAM support is discovered', async () => {
        // Set up connection as online
        connectionStore.getState().setStatus('online')

        // Add a conversation
        chatStore.getState().addConversation({
          id: 'contact@example.com',
          name: 'contact@example.com',
          type: 'chat',
          lastMessage: undefined,
          unreadCount: 0,
        })

        // Set conversation as active
        chatStore.getState().setActiveConversation('contact@example.com')

        // Set up side effects WITHOUT MAM support initially
        cleanup = setupChatSideEffects(mockClient)

        // Wait a bit - no MAM query should happen yet
        await new Promise(resolve => setTimeout(resolve, 50))
        expect(mockClient.chat.queryMAM).not.toHaveBeenCalled()

        // Now set server info with MAM support
        connectionStore.getState().setServerInfo({
          identities: [],
          domain: 'example.com',
          features: [NS_MAM],
        })

        // Wait for MAM fetch
        await vi.waitFor(() => {
          expect(mockClient.chat.queryMAM).toHaveBeenCalledWith(
            expect.objectContaining({
              with: 'contact@example.com',
            })
          )
        })
      })
    })
  })
})
