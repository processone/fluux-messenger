/**
 * Tests for chat-related side effects.
 *
 * Verifies that MAM queries are triggered at the right times:
 * - When a conversation becomes active
 * - When connection status changes (reconnection)
 * - When MAM support is discovered for the active conversation
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

import { setupChatSideEffects } from './chatSideEffects'
import { chatStore } from '../stores/chatStore'
import { connectionStore } from '../stores/connectionStore'
import { NS_MAM } from './namespaces'
import { createMockClient, simulateFreshSession, simulateSmResumption } from './sideEffects.testHelpers'

describe('setupChatSideEffects', () => {
  let mockClient: ReturnType<typeof createMockClient>
  let cleanup: () => void

  beforeEach(() => {
    chatStore.getState().reset()
    connectionStore.getState().reset()
    mockClient = createMockClient()
  })

  afterEach(() => {
    cleanup?.()
  })

  describe('cache loading with existing messages', () => {
    it('should load from cache even when conversation already has live messages in memory', async () => {
      connectionStore.getState().setStatus('online')
      connectionStore.getState().setServerInfo({
        identities: [],
        domain: 'example.com',
        features: [NS_MAM],
      })

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

      const loadSpy = vi.spyOn(chatStore.getState(), 'loadMessagesFromCache')

      cleanup = setupChatSideEffects(mockClient)

      chatStore.getState().setActiveConversation('contact@example.com')

      await vi.waitFor(() => {
        expect(loadSpy).toHaveBeenCalledWith('contact@example.com', { limit: 100 })
      })

      loadSpy.mockRestore()
    })
  })

  describe('serverInfo MAM support subscription', () => {
    it('should trigger MAM fetch when server MAM support is discovered', async () => {
      chatStore.getState().addConversation({
        id: 'contact@example.com',
        name: 'contact@example.com',
        type: 'chat',
        lastMessage: undefined,
        unreadCount: 0,
      })

      chatStore.getState().setActiveConversation('contact@example.com')

      cleanup = setupChatSideEffects(mockClient)

      // Simulate fresh session (this sets isFreshSession = true)
      simulateFreshSession(mockClient)

      // Wait a bit - no MAM query should happen yet (no MAM support)
      await new Promise(resolve => setTimeout(resolve, 50))
      expect(mockClient.chat.queryMAM).not.toHaveBeenCalled()

      // Now set server info with MAM support
      connectionStore.getState().setServerInfo({
        identities: [],
        domain: 'example.com',
        features: [NS_MAM],
      })

      await vi.waitFor(() => {
        expect(mockClient.chat.queryMAM).toHaveBeenCalledWith(
          expect.objectContaining({
            with: 'contact@example.com',
          })
        )
      })
    })
  })

  describe('reconnection', () => {
    it('should use forward query (start) when cache has messages after reconnection', async () => {
      const cachedTimestamp = new Date('2026-02-15T10:00:00Z')

      connectionStore.getState().setServerInfo({
        identities: [],
        domain: 'example.com',
        features: [NS_MAM],
      })

      chatStore.getState().addConversation({
        id: 'contact@example.com',
        name: 'contact@example.com',
        type: 'chat',
        lastMessage: undefined,
        unreadCount: 0,
      })

      chatStore.getState().setActiveConversation('contact@example.com')

      // Mock loadMessagesFromCache to simulate populating the store with a cached message
      const cachedMsg = {
        type: 'chat' as const,
        id: 'cached-msg-1',
        conversationId: 'contact@example.com',
        from: 'contact@example.com',
        body: 'Cached message',
        timestamp: cachedTimestamp,
        isOutgoing: false,
      }
      const loadSpy = vi.spyOn(chatStore.getState(), 'loadMessagesFromCache')
        .mockImplementation(async (conversationId: string) => {
          chatStore.getState().addMessage({
            ...cachedMsg,
            conversationId,
          })
          return [cachedMsg]
        })

      connectionStore.getState().setStatus('disconnected')
      cleanup = setupChatSideEffects(mockClient)

      simulateFreshSession(mockClient)

      await vi.waitFor(() => {
        expect(mockClient.chat.queryMAM).toHaveBeenCalledWith(
          expect.objectContaining({
            with: 'contact@example.com',
            start: expect.any(String),
          })
        )
      })

      // Verify it used 'start' (forward catch-up from cached message)
      const call = (mockClient.chat.queryMAM as ReturnType<typeof vi.fn>).mock.calls[0][0]
      expect(new Date(call.start).getTime()).toBe(cachedTimestamp.getTime() + 1)

      loadSpy.mockRestore()
    })

    it('should use query without start when cache is empty after reconnection', async () => {
      connectionStore.getState().setServerInfo({
        identities: [],
        domain: 'example.com',
        features: [NS_MAM],
      })

      chatStore.getState().addConversation({
        id: 'contact@example.com',
        name: 'contact@example.com',
        type: 'chat',
        lastMessage: undefined,
        unreadCount: 0,
      })

      chatStore.getState().setActiveConversation('contact@example.com')

      connectionStore.getState().setStatus('disconnected')
      cleanup = setupChatSideEffects(mockClient)

      simulateFreshSession(mockClient)

      await vi.waitFor(() => {
        expect(mockClient.chat.queryMAM).toHaveBeenCalledWith(
          expect.objectContaining({
            with: 'contact@example.com',
          })
        )
      })

      // Verify it did NOT include 'start' (no cached messages to catch up from)
      const call = (mockClient.chat.queryMAM as ReturnType<typeof vi.fn>).mock.calls[0][0]
      expect(call).not.toHaveProperty('start')
    })
  })

  describe('SM resumption', () => {
    it('should NOT trigger MAM catchup on SM resumption for active conversation', async () => {
      connectionStore.getState().setServerInfo({
        identities: [],
        domain: 'example.com',
        features: [NS_MAM],
      })

      chatStore.getState().addConversation({
        id: 'contact@example.com',
        name: 'contact@example.com',
        type: 'chat',
        lastMessage: undefined,
        unreadCount: 0,
      })

      chatStore.getState().setActiveConversation('contact@example.com')

      connectionStore.getState().setStatus('disconnected')
      cleanup = setupChatSideEffects(mockClient)

      // SM resumption instead of fresh session
      simulateSmResumption(mockClient)

      await new Promise(resolve => setTimeout(resolve, 50))
      expect(mockClient.chat.queryMAM).not.toHaveBeenCalled()
    })

    it('should NOT trigger MAM when serverInfo MAM support discovered during SM resumption', async () => {
      chatStore.getState().addConversation({
        id: 'contact@example.com',
        name: 'contact@example.com',
        type: 'chat',
        lastMessage: undefined,
        unreadCount: 0,
      })

      chatStore.getState().setActiveConversation('contact@example.com')

      cleanup = setupChatSideEffects(mockClient)

      // SM resumption (not fresh session)
      simulateSmResumption(mockClient)

      // Server info with MAM support arrives — should NOT trigger MAM because isFreshSession is false
      connectionStore.getState().setServerInfo({
        identities: [],
        domain: 'example.com',
        features: [NS_MAM],
      })

      await new Promise(resolve => setTimeout(resolve, 50))
      expect(mockClient.chat.queryMAM).not.toHaveBeenCalled()
    })
  })
})
