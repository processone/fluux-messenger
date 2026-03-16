/**
 * Tests for conversation sync side effects.
 *
 * Verifies debounced publishing of the conversation list to PEP:
 * - Publishes after store changes with debounce
 * - Skips redundant publishes (snapshot comparison)
 * - Disables publishing during SM resumption
 * - Cancels timers on disconnect
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
  flushPendingRoomMessages: vi.fn().mockResolvedValue(undefined),
}))

import { setupConversationSyncSideEffects } from './conversationSyncSideEffects'
import { connectionStore } from '../stores/connectionStore'
import { chatStore } from '../stores/chatStore'
import { createMockClient, simulateFreshSession, simulateSmResumption } from './sideEffects.testHelpers'

describe('setupConversationSyncSideEffects', () => {
  let mockClient: ReturnType<typeof createMockClient>
  let cleanup: () => void

  beforeEach(() => {
    vi.useFakeTimers()
    connectionStore.getState().reset()
    chatStore.getState().reset()
    mockClient = createMockClient()
    // Add conversationSync mock to the client
    ;(mockClient as any).conversationSync = {
      fetchConversations: vi.fn().mockResolvedValue([]),
      publishConversations: vi.fn().mockResolvedValue(undefined),
    }
    localStorageMock.clear()
  })

  afterEach(() => {
    cleanup?.()
    vi.useRealTimers()
    vi.clearAllMocks()
  })

  describe('publishing on store changes', () => {
    it('should publish after conversation is added with debounce', async () => {
      connectionStore.getState().setStatus('disconnected')
      cleanup = setupConversationSyncSideEffects(mockClient)

      simulateFreshSession(mockClient)

      // Add a conversation
      chatStore.getState().addConversation({
        id: 'alice@example.com',
        name: 'Alice',
        type: 'chat',
        unreadCount: 0,
      })

      // Should not publish immediately
      expect((mockClient as any).conversationSync.publishConversations).not.toHaveBeenCalled()

      // Advance past debounce (3 seconds)
      await vi.advanceTimersByTimeAsync(3_000)

      expect((mockClient as any).conversationSync.publishConversations).toHaveBeenCalledTimes(1)
      expect((mockClient as any).conversationSync.publishConversations).toHaveBeenCalledWith(
        expect.arrayContaining([
          expect.objectContaining({ jid: 'alice@example.com', archived: false }),
        ])
      )
    })

    it('should debounce multiple rapid changes into a single publish', async () => {
      connectionStore.getState().setStatus('disconnected')
      cleanup = setupConversationSyncSideEffects(mockClient)

      simulateFreshSession(mockClient)

      // Rapidly add multiple conversations
      chatStore.getState().addConversation({
        id: 'alice@example.com', name: 'Alice', type: 'chat', unreadCount: 0,
      })
      chatStore.getState().addConversation({
        id: 'bob@example.com', name: 'Bob', type: 'chat', unreadCount: 0,
      })
      chatStore.getState().addConversation({
        id: 'carol@example.com', name: 'Carol', type: 'chat', unreadCount: 0,
      })

      // Advance past debounce
      await vi.advanceTimersByTimeAsync(3_000)

      // Should have published once with all three conversations
      expect((mockClient as any).conversationSync.publishConversations).toHaveBeenCalledTimes(1)
      const publishedList = (mockClient as any).conversationSync.publishConversations.mock.calls[0][0]
      expect(publishedList).toHaveLength(3)
    })

    it('should publish when a conversation is archived', async () => {
      // Start with a conversation
      chatStore.getState().addConversation({
        id: 'alice@example.com', name: 'Alice', type: 'chat', unreadCount: 0,
      })

      connectionStore.getState().setStatus('disconnected')
      cleanup = setupConversationSyncSideEffects(mockClient)

      simulateFreshSession(mockClient)

      // Archive it
      chatStore.getState().archiveConversation('alice@example.com')

      await vi.advanceTimersByTimeAsync(3_000)

      expect((mockClient as any).conversationSync.publishConversations).toHaveBeenCalledTimes(1)
      expect((mockClient as any).conversationSync.publishConversations).toHaveBeenCalledWith(
        expect.arrayContaining([
          expect.objectContaining({ jid: 'alice@example.com', archived: true }),
        ])
      )
    })

    it('should publish when a conversation is unarchived', async () => {
      // Start with an archived conversation
      chatStore.getState().addConversation({
        id: 'alice@example.com', name: 'Alice', type: 'chat', unreadCount: 0,
      })
      chatStore.getState().archiveConversation('alice@example.com')

      connectionStore.getState().setStatus('disconnected')
      cleanup = setupConversationSyncSideEffects(mockClient)

      simulateFreshSession(mockClient)

      // Unarchive it
      chatStore.getState().unarchiveConversation('alice@example.com')

      await vi.advanceTimersByTimeAsync(3_000)

      expect((mockClient as any).conversationSync.publishConversations).toHaveBeenCalledTimes(1)
      expect((mockClient as any).conversationSync.publishConversations).toHaveBeenCalledWith(
        expect.arrayContaining([
          expect.objectContaining({ jid: 'alice@example.com', archived: false }),
        ])
      )
    })

    it('should publish when a conversation is deleted', async () => {
      // Start with two conversations
      chatStore.getState().addConversation({
        id: 'alice@example.com', name: 'Alice', type: 'chat', unreadCount: 0,
      })
      chatStore.getState().addConversation({
        id: 'bob@example.com', name: 'Bob', type: 'chat', unreadCount: 0,
      })

      connectionStore.getState().setStatus('disconnected')
      cleanup = setupConversationSyncSideEffects(mockClient)

      simulateFreshSession(mockClient)

      // Delete one
      chatStore.getState().deleteConversation('alice@example.com')

      await vi.advanceTimersByTimeAsync(3_000)

      expect((mockClient as any).conversationSync.publishConversations).toHaveBeenCalledTimes(1)
      const publishedList = (mockClient as any).conversationSync.publishConversations.mock.calls[0][0]
      expect(publishedList).toHaveLength(1)
      expect(publishedList[0].jid).toBe('bob@example.com')
    })
  })

  describe('snapshot comparison', () => {
    it('should not publish if conversation list has not changed', async () => {
      chatStore.getState().addConversation({
        id: 'alice@example.com', name: 'Alice', type: 'chat', unreadCount: 0,
      })

      connectionStore.getState().setStatus('disconnected')
      cleanup = setupConversationSyncSideEffects(mockClient)

      simulateFreshSession(mockClient)

      // The initial snapshot matches the current state, so no publish should happen
      // unless something changes. Wait for debounce to pass.
      await vi.advanceTimersByTimeAsync(5_000)

      // No publish because snapshot was taken on 'online' and nothing changed
      expect((mockClient as any).conversationSync.publishConversations).not.toHaveBeenCalled()
    })
  })

  describe('sync disabled during SM resumption', () => {
    it('should not publish on SM resumption', async () => {
      connectionStore.getState().setStatus('disconnected')
      cleanup = setupConversationSyncSideEffects(mockClient)

      simulateSmResumption(mockClient)

      // Add a conversation (simulating stanza replay)
      chatStore.getState().addConversation({
        id: 'alice@example.com', name: 'Alice', type: 'chat', unreadCount: 0,
      })

      await vi.advanceTimersByTimeAsync(3_000)

      expect((mockClient as any).conversationSync.publishConversations).not.toHaveBeenCalled()
    })
  })

  describe('disconnect handling', () => {
    it('should cancel pending timer on disconnect', async () => {
      connectionStore.getState().setStatus('disconnected')
      cleanup = setupConversationSyncSideEffects(mockClient)

      simulateFreshSession(mockClient)

      // Add a conversation (starts debounce timer)
      chatStore.getState().addConversation({
        id: 'alice@example.com', name: 'Alice', type: 'chat', unreadCount: 0,
      })

      // Disconnect before debounce fires
      await vi.advanceTimersByTimeAsync(1_000)
      connectionStore.getState().setStatus('disconnected')

      // Advance past original debounce time
      await vi.advanceTimersByTimeAsync(5_000)

      // Should not have published because disconnect cancelled the timer
      expect((mockClient as any).conversationSync.publishConversations).not.toHaveBeenCalled()
    })

    it('should not publish when disconnected even if timer fires', async () => {
      connectionStore.getState().setStatus('disconnected')
      cleanup = setupConversationSyncSideEffects(mockClient)

      simulateFreshSession(mockClient)

      chatStore.getState().addConversation({
        id: 'alice@example.com', name: 'Alice', type: 'chat', unreadCount: 0,
      })

      // Go offline
      connectionStore.getState().setStatus('disconnected')

      // Advance past debounce
      await vi.advanceTimersByTimeAsync(5_000)

      expect((mockClient as any).conversationSync.publishConversations).not.toHaveBeenCalled()
    })
  })

  describe('reconnect cycle', () => {
    it('should re-enable publishing after disconnect and reconnect', async () => {
      connectionStore.getState().setStatus('disconnected')
      cleanup = setupConversationSyncSideEffects(mockClient)

      // First session
      simulateFreshSession(mockClient)

      chatStore.getState().addConversation({
        id: 'alice@example.com', name: 'Alice', type: 'chat', unreadCount: 0,
      })

      await vi.advanceTimersByTimeAsync(3_000)
      expect((mockClient as any).conversationSync.publishConversations).toHaveBeenCalledTimes(1)

      // Disconnect
      connectionStore.getState().setStatus('disconnected')

      // Reconnect
      simulateFreshSession(mockClient)

      // Add another conversation
      chatStore.getState().addConversation({
        id: 'bob@example.com', name: 'Bob', type: 'chat', unreadCount: 0,
      })

      await vi.advanceTimersByTimeAsync(3_000)
      expect((mockClient as any).conversationSync.publishConversations).toHaveBeenCalledTimes(2)
    })
  })

  describe('error handling', () => {
    it('should not crash if publish fails', async () => {
      ;(mockClient as any).conversationSync.publishConversations.mockRejectedValue(
        new Error('network error')
      )

      connectionStore.getState().setStatus('disconnected')
      cleanup = setupConversationSyncSideEffects(mockClient)

      simulateFreshSession(mockClient)

      chatStore.getState().addConversation({
        id: 'alice@example.com', name: 'Alice', type: 'chat', unreadCount: 0,
      })

      await vi.advanceTimersByTimeAsync(3_000)

      // Should not throw — error is silently caught
      expect((mockClient as any).conversationSync.publishConversations).toHaveBeenCalledTimes(1)
    })
  })
})
