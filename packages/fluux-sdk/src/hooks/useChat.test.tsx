/**
 * @vitest-environment happy-dom
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import type { ReactNode } from 'react'
import { useChat } from './useChat'
import { chatStore } from '../stores'
import { XMPPProvider } from '../provider'

// Wrapper component that provides XMPP context
function wrapper({ children }: { children: ReactNode }) {
  return <XMPPProvider>{children}</XMPPProvider>
}

describe('useChat hook', () => {
  beforeEach(() => {
    // Reset store state before each test
    chatStore.setState({
      conversations: new Map(),
      messages: new Map(),
      activeConversationId: null,
    })
  })

  describe('conversations reactivity', () => {
    it('should update when a conversation is added to the store', () => {
      const { result } = renderHook(() => useChat(), { wrapper })

      // Initially empty
      expect(result.current.conversations).toHaveLength(0)

      // Add a conversation directly to the store
      act(() => {
        chatStore.getState().addConversation({
          id: 'alice@example.com',
          name: 'Alice',
          type: 'chat',
          unreadCount: 0,
        })
      })

      // Hook should reflect the new conversation
      expect(result.current.conversations).toHaveLength(1)
      expect(result.current.conversations[0].id).toBe('alice@example.com')
    })

    it('should update when multiple conversations are added', () => {
      const { result } = renderHook(() => useChat(), { wrapper })

      act(() => {
        chatStore.getState().addConversation({
          id: 'alice@example.com',
          name: 'Alice',
          type: 'chat',
          unreadCount: 0,
        })
      })

      act(() => {
        chatStore.getState().addConversation({
          id: 'bob@example.com',
          name: 'Bob',
          type: 'chat',
          unreadCount: 0,
        })
      })

      expect(result.current.conversations).toHaveLength(2)
    })
  })

  describe('activeMessages reactivity', () => {
    it('should update when a message is added to the active conversation', () => {
      const { result } = renderHook(() => useChat(), { wrapper })

      // Set up a conversation and make it active
      act(() => {
        chatStore.getState().addConversation({
          id: 'alice@example.com',
          name: 'Alice',
          type: 'chat',
          unreadCount: 0,
        })
        chatStore.getState().setActiveConversation('alice@example.com')
      })

      // Initially no messages
      expect(result.current.activeMessages).toHaveLength(0)

      // Add a message directly to the store (simulating incoming message)
      act(() => {
        chatStore.getState().addMessage({
          type: 'chat',
          id: 'msg-1',
          conversationId: 'alice@example.com',
          from: 'alice@example.com',
          body: 'Hello!',
          timestamp: new Date(),
          isOutgoing: false,
        })
      })

      // Hook should reflect the new message
      expect(result.current.activeMessages).toHaveLength(1)
      expect(result.current.activeMessages[0].body).toBe('Hello!')
    })

    it('should update when multiple messages are added', () => {
      const { result } = renderHook(() => useChat(), { wrapper })

      // Set up active conversation
      act(() => {
        chatStore.getState().addConversation({
          id: 'alice@example.com',
          name: 'Alice',
          type: 'chat',
          unreadCount: 0,
        })
        chatStore.getState().setActiveConversation('alice@example.com')
      })

      // Add first message
      act(() => {
        chatStore.getState().addMessage({
          type: 'chat',
          id: 'msg-1',
          conversationId: 'alice@example.com',
          from: 'alice@example.com',
          body: 'Hello!',
          timestamp: new Date(),
          isOutgoing: false,
        })
      })

      expect(result.current.activeMessages).toHaveLength(1)

      // Add second message
      act(() => {
        chatStore.getState().addMessage({
          type: 'chat',
          id: 'msg-2',
          conversationId: 'alice@example.com',
          from: 'me@example.com',
          body: 'Hi there!',
          timestamp: new Date(),
          isOutgoing: true,
        })
      })

      expect(result.current.activeMessages).toHaveLength(2)
      expect(result.current.activeMessages[1].body).toBe('Hi there!')
    })

    it('should not include messages from other conversations', () => {
      const { result } = renderHook(() => useChat(), { wrapper })

      // Set up two conversations
      act(() => {
        chatStore.getState().addConversation({
          id: 'alice@example.com',
          name: 'Alice',
          type: 'chat',
          unreadCount: 0,
        })
        chatStore.getState().addConversation({
          id: 'bob@example.com',
          name: 'Bob',
          type: 'chat',
          unreadCount: 0,
        })
        chatStore.getState().setActiveConversation('alice@example.com')
      })

      // Add message to Bob's conversation (not active)
      act(() => {
        chatStore.getState().addMessage({
          type: 'chat',
          id: 'msg-1',
          conversationId: 'bob@example.com',
          from: 'bob@example.com',
          body: 'Hey!',
          timestamp: new Date(),
          isOutgoing: false,
        })
      })

      // Active messages (Alice's) should still be empty
      expect(result.current.activeMessages).toHaveLength(0)

      // Add message to Alice's conversation
      act(() => {
        chatStore.getState().addMessage({
          type: 'chat',
          id: 'msg-2',
          conversationId: 'alice@example.com',
          from: 'alice@example.com',
          body: 'Hi from Alice!',
          timestamp: new Date(),
          isOutgoing: false,
        })
      })

      expect(result.current.activeMessages).toHaveLength(1)
      expect(result.current.activeMessages[0].body).toBe('Hi from Alice!')
    })
  })

  describe('activeConversation reactivity', () => {
    it('should update when active conversation changes', () => {
      const { result } = renderHook(() => useChat(), { wrapper })

      // Add conversations
      act(() => {
        chatStore.getState().addConversation({
          id: 'alice@example.com',
          name: 'Alice',
          type: 'chat',
          unreadCount: 0,
        })
        chatStore.getState().addConversation({
          id: 'bob@example.com',
          name: 'Bob',
          type: 'chat',
          unreadCount: 0,
        })
      })

      expect(result.current.activeConversation).toBeNull()

      // Set active conversation
      act(() => {
        chatStore.getState().setActiveConversation('alice@example.com')
      })

      expect(result.current.activeConversation?.id).toBe('alice@example.com')
      expect(result.current.activeConversation?.name).toBe('Alice')

      // Switch active conversation
      act(() => {
        chatStore.getState().setActiveConversation('bob@example.com')
      })

      expect(result.current.activeConversation?.id).toBe('bob@example.com')
      expect(result.current.activeConversation?.name).toBe('Bob')
    })

    it('should update activeMessages when switching conversations', () => {
      const { result } = renderHook(() => useChat(), { wrapper })

      // Set up conversations with messages
      act(() => {
        chatStore.getState().addConversation({
          id: 'alice@example.com',
          name: 'Alice',
          type: 'chat',
          unreadCount: 0,
        })
        chatStore.getState().addConversation({
          id: 'bob@example.com',
          name: 'Bob',
          type: 'chat',
          unreadCount: 0,
        })
        chatStore.getState().addMessage({
          type: 'chat',
          id: 'msg-alice',
          conversationId: 'alice@example.com',
          from: 'alice@example.com',
          body: 'From Alice',
          timestamp: new Date(),
          isOutgoing: false,
        })
        chatStore.getState().addMessage({
          type: 'chat',
          id: 'msg-bob',
          conversationId: 'bob@example.com',
          from: 'bob@example.com',
          body: 'From Bob',
          timestamp: new Date(),
          isOutgoing: false,
        })
      })

      // Switch to Alice
      act(() => {
        chatStore.getState().setActiveConversation('alice@example.com')
      })

      expect(result.current.activeMessages).toHaveLength(1)
      expect(result.current.activeMessages[0].body).toBe('From Alice')

      // Switch to Bob
      act(() => {
        chatStore.getState().setActiveConversation('bob@example.com')
      })

      expect(result.current.activeMessages).toHaveLength(1)
      expect(result.current.activeMessages[0].body).toBe('From Bob')
    })
  })

  describe('draft management', () => {
    beforeEach(() => {
      // Reset drafts state
      chatStore.setState({ drafts: new Map() })
    })

    it('should set and get drafts via hook functions', () => {
      const { result } = renderHook(() => useChat(), { wrapper })

      act(() => {
        result.current.setDraft('alice@example.com', 'Hello Alice!')
      })

      expect(result.current.getDraft('alice@example.com')).toBe('Hello Alice!')
    })

    it('should clear drafts via hook functions', () => {
      const { result } = renderHook(() => useChat(), { wrapper })

      act(() => {
        result.current.setDraft('alice@example.com', 'Hello Alice!')
      })

      act(() => {
        result.current.clearDraft('alice@example.com')
      })

      expect(result.current.getDraft('alice@example.com')).toBe('')
    })

    it('should maintain separate drafts for different conversations', () => {
      const { result } = renderHook(() => useChat(), { wrapper })

      act(() => {
        result.current.setDraft('alice@example.com', 'Draft for Alice')
        result.current.setDraft('bob@example.com', 'Draft for Bob')
      })

      expect(result.current.getDraft('alice@example.com')).toBe('Draft for Alice')
      expect(result.current.getDraft('bob@example.com')).toBe('Draft for Bob')
    })

    it('should preserve drafts when switching active conversation', () => {
      const { result } = renderHook(() => useChat(), { wrapper })

      // Set up conversations
      act(() => {
        chatStore.getState().addConversation({
          id: 'alice@example.com',
          name: 'Alice',
          type: 'chat',
          unreadCount: 0,
        })
        chatStore.getState().addConversation({
          id: 'bob@example.com',
          name: 'Bob',
          type: 'chat',
          unreadCount: 0,
        })
      })

      // Set draft for Alice
      act(() => {
        result.current.setActiveConversation('alice@example.com')
        result.current.setDraft('alice@example.com', 'Private message for Alice')
      })

      // Switch to Bob
      act(() => {
        result.current.setActiveConversation('bob@example.com')
      })

      // Alice's draft should still be intact
      expect(result.current.getDraft('alice@example.com')).toBe('Private message for Alice')
      expect(result.current.getDraft('bob@example.com')).toBe('')
    })

    it('should not mix up drafts after multiple conversation switches', () => {
      const { result } = renderHook(() => useChat(), { wrapper })

      // Set up multiple conversations
      act(() => {
        chatStore.getState().addConversation({
          id: 'alice@example.com',
          name: 'Alice',
          type: 'chat',
          unreadCount: 0,
        })
        chatStore.getState().addConversation({
          id: 'bob@example.com',
          name: 'Bob',
          type: 'chat',
          unreadCount: 0,
        })
        chatStore.getState().addConversation({
          id: 'charlie@example.com',
          name: 'Charlie',
          type: 'chat',
          unreadCount: 0,
        })
      })

      // Set drafts for multiple conversations
      act(() => {
        result.current.setDraft('alice@example.com', 'CONFIDENTIAL: Alice only')
        result.current.setDraft('bob@example.com', 'CONFIDENTIAL: Bob only')
      })

      // Rapidly switch between conversations
      act(() => {
        result.current.setActiveConversation('alice@example.com')
        result.current.setActiveConversation('charlie@example.com')
        result.current.setActiveConversation('bob@example.com')
        result.current.setActiveConversation('alice@example.com')
        result.current.setActiveConversation('bob@example.com')
      })

      // Verify drafts are still correctly associated
      expect(result.current.getDraft('alice@example.com')).toBe('CONFIDENTIAL: Alice only')
      expect(result.current.getDraft('bob@example.com')).toBe('CONFIDENTIAL: Bob only')
      expect(result.current.getDraft('charlie@example.com')).toBe('')
    })
  })

  describe('setActiveConversation cache loading', () => {
    it('should load cache before setting active conversation (regression: firstNewMessageId needs full history)', async () => {
      // Regression test for bug where opening a conversation with only live messages
      // showed no historical context above the "new messages" marker.
      // The fix: load cache BEFORE calling setActiveConversation in the store,
      // so firstNewMessageId is calculated with the full message history.
      const { result } = renderHook(() => useChat(), { wrapper })

      act(() => {
        chatStore.getState().addConversation({
          id: 'alice@example.com',
          name: 'Alice',
          type: 'chat',
          unreadCount: 1,
        })
        chatStore.getState().addMessage({
          type: 'chat',
          id: 'live-msg-1',
          conversationId: 'alice@example.com',
          from: 'alice@example.com',
          body: 'New live message',
          timestamp: new Date('2026-02-04T12:00:00Z'),
          isOutgoing: false,
        })
      })

      // Replace loadMessagesFromCache on the store to record activeConversationId at call time.
      // Must use setState() because Zustand creates new state objects on set(), so
      // vi.spyOn on a previous getState() reference won't intercept future calls.
      const originalLoad = chatStore.getState().loadMessagesFromCache
      let activeIdDuringCacheLoad: string | null | undefined = undefined
      let loadCallCount = 0
      chatStore.setState({
        loadMessagesFromCache: async (id: string, options?: { limit?: number }) => {
          if (loadCallCount === 0) {
            activeIdDuringCacheLoad = chatStore.getState().activeConversationId
          }
          loadCallCount++
          return originalLoad(id, options)
        },
      })

      await act(async () => {
        await result.current.setActiveConversation('alice@example.com')
      })

      // Cache was loaded while active conversation was still null → correct ordering
      expect(activeIdDuringCacheLoad).toBeNull()
      expect(loadCallCount).toBeGreaterThanOrEqual(1)

      chatStore.setState({ loadMessagesFromCache: originalLoad })
    })

    it('should always load cache even when conversation has messages', async () => {
      // Regression test: cache loading must not be skipped when messages exist.
      // Previously, conversations with live messages in memory would skip cache
      // loading, leaving only new messages visible without historical context.
      const { result } = renderHook(() => useChat(), { wrapper })

      act(() => {
        chatStore.getState().addConversation({
          id: 'alice@example.com',
          name: 'Alice',
          type: 'chat',
          unreadCount: 0,
        })
        chatStore.getState().addMessage({
          type: 'chat',
          id: 'msg-1',
          conversationId: 'alice@example.com',
          from: 'alice@example.com',
          body: 'Existing message',
          timestamp: new Date(),
          isOutgoing: false,
        })
      })

      const originalLoad = chatStore.getState().loadMessagesFromCache
      let cacheLoadId: string | null = null
      chatStore.setState({
        loadMessagesFromCache: async (id: string, options?: { limit?: number }) => {
          cacheLoadId = id
          return originalLoad(id, options)
        },
      })

      await act(async () => {
        await result.current.setActiveConversation('alice@example.com')
      })

      // Cache should be loaded regardless of existing messages
      expect(cacheLoadId).toBe('alice@example.com')

      chatStore.setState({ loadMessagesFromCache: originalLoad })
    })

    it('should not load cache when setting active conversation to null', async () => {
      const { result } = renderHook(() => useChat(), { wrapper })

      const originalLoad = chatStore.getState().loadMessagesFromCache
      let cacheLoadCalled = false
      chatStore.setState({
        loadMessagesFromCache: async (id: string, options?: { limit?: number }) => {
          cacheLoadCalled = true
          return originalLoad(id, options)
        },
      })

      await act(async () => {
        await result.current.setActiveConversation(null)
      })

      expect(cacheLoadCalled).toBe(false)

      chatStore.setState({ loadMessagesFromCache: originalLoad })
    })
  })

  describe('conversation updates', () => {
    it('should update conversation lastMessage when message is added', () => {
      const { result } = renderHook(() => useChat(), { wrapper })

      act(() => {
        chatStore.getState().addConversation({
          id: 'alice@example.com',
          name: 'Alice',
          type: 'chat',
          unreadCount: 0,
        })
      })

      expect(result.current.conversations[0].lastMessage).toBeUndefined()

      act(() => {
        chatStore.getState().addMessage({
          type: 'chat',
          id: 'msg-1',
          conversationId: 'alice@example.com',
          from: 'alice@example.com',
          body: 'New message!',
          timestamp: new Date(),
          isOutgoing: false,
        })
      })

      expect(result.current.conversations[0].lastMessage?.body).toBe('New message!')
    })

    it('should update unread count for non-active conversation', () => {
      const { result } = renderHook(() => useChat(), { wrapper })

      act(() => {
        chatStore.getState().addConversation({
          id: 'alice@example.com',
          name: 'Alice',
          type: 'chat',
          unreadCount: 0,
        })
        // Don't set as active
      })

      expect(result.current.conversations[0].unreadCount).toBe(0)

      // Add incoming message
      act(() => {
        chatStore.getState().addMessage({
          type: 'chat',
          id: 'msg-1',
          conversationId: 'alice@example.com',
          from: 'alice@example.com',
          body: 'Hello!',
          timestamp: new Date(),
          isOutgoing: false,
        })
      })

      expect(result.current.conversations[0].unreadCount).toBe(1)
    })
  })

  describe('fetchOlderHistory (lazy MAM loading)', () => {
    beforeEach(() => {
      // Reset MAM states
      chatStore.setState({ mamQueryStates: new Map() })
    })

    it('should not throw when called without active conversation', async () => {
      const { result } = renderHook(() => useChat(), { wrapper })

      // No active conversation
      await act(async () => {
        await result.current.fetchOlderHistory()
      })
    })

    it('should not throw when conversation is not chat type', async () => {
      const { result } = renderHook(() => useChat(), { wrapper })

      // Add a groupchat conversation (not chat type)
      act(() => {
        chatStore.getState().addConversation({
          id: 'room@conference.example.com',
          name: 'Room',
          type: 'groupchat',
          unreadCount: 0,
        })
        chatStore.getState().setActiveConversation('room@conference.example.com')
      })

      await act(async () => {
        await result.current.fetchOlderHistory()
      })
    })

    it('should not fetch when history is already complete', async () => {
      const { result } = renderHook(() => useChat(), { wrapper })

      act(() => {
        chatStore.getState().addConversation({
          id: 'alice@example.com',
          name: 'Alice',
          type: 'chat',
          unreadCount: 0,
        })
        chatStore.getState().setActiveConversation('alice@example.com')
        // Mark history as complete (backward query)
        chatStore.getState().mergeMAMMessages(
          'alice@example.com',
          [],
          { count: 0 },
          true, // complete
          'backward' // direction
        )
      })

      const mamStateBefore = chatStore.getState().getMAMQueryState('alice@example.com')
      expect(mamStateBefore.isHistoryComplete).toBe(true)

      // Should not throw and should not change loading state
      await act(async () => {
        await result.current.fetchOlderHistory()
      })

      const mamStateAfter = chatStore.getState().getMAMQueryState('alice@example.com')
      expect(mamStateAfter.isLoading).toBe(false)
    })

    it('should not fetch when already loading', async () => {
      const { result } = renderHook(() => useChat(), { wrapper })

      act(() => {
        chatStore.getState().addConversation({
          id: 'alice@example.com',
          name: 'Alice',
          type: 'chat',
          unreadCount: 0,
        })
        chatStore.getState().setActiveConversation('alice@example.com')
        // Set loading state
        chatStore.getState().setMAMLoading('alice@example.com', true)
      })

      const mamStateBefore = chatStore.getState().getMAMQueryState('alice@example.com')
      expect(mamStateBefore.isLoading).toBe(true)

      // Should not throw
      await act(async () => {
        await result.current.fetchOlderHistory()
      })
    })

    it('should not fetch when no pagination cursor exists', async () => {
      const { result } = renderHook(() => useChat(), { wrapper })

      act(() => {
        chatStore.getState().addConversation({
          id: 'alice@example.com',
          name: 'Alice',
          type: 'chat',
          unreadCount: 0,
        })
        chatStore.getState().setActiveConversation('alice@example.com')
        // No mergeMAMMessages called, so no oldestFetchedId
      })

      const mamState = chatStore.getState().getMAMQueryState('alice@example.com')
      expect(mamState.oldestFetchedId).toBeUndefined()

      // Should not throw
      await act(async () => {
        await result.current.fetchOlderHistory()
      })
    })

    it('should allow explicit conversationId parameter', async () => {
      const { result } = renderHook(() => useChat(), { wrapper })

      act(() => {
        chatStore.getState().addConversation({
          id: 'alice@example.com',
          name: 'Alice',
          type: 'chat',
          unreadCount: 0,
        })
        // Different active conversation
        chatStore.getState().addConversation({
          id: 'bob@example.com',
          name: 'Bob',
          type: 'chat',
          unreadCount: 0,
        })
        chatStore.getState().setActiveConversation('bob@example.com')
      })

      // Should not throw when called with explicit ID
      await act(async () => {
        await result.current.fetchOlderHistory('alice@example.com')
      })
    })
  })

  describe('reference stability (prevents render loops)', () => {
    it('should return stable empty array reference for conversations when no conversations exist', () => {
      const { result, rerender } = renderHook(() => useChat(), { wrapper })

      const conversations1 = result.current.conversations
      rerender()
      const conversations2 = result.current.conversations

      // Should be the exact same reference (toBe), not just equal content (toEqual)
      expect(conversations1).toBe(conversations2)
    })

    it('should return stable empty array reference for activeMessages when no active conversation', () => {
      const { result, rerender } = renderHook(() => useChat(), { wrapper })

      const messages1 = result.current.activeMessages
      rerender()
      const messages2 = result.current.activeMessages

      expect(messages1).toBe(messages2)
    })

    it('should return stable empty array reference for activeMessages when active conversation has no messages', () => {
      const { result, rerender } = renderHook(() => useChat(), { wrapper })

      act(() => {
        chatStore.getState().addConversation({
          id: 'alice@example.com',
          name: 'Alice',
          type: 'chat',
          unreadCount: 0,
        })
        chatStore.getState().setActiveConversation('alice@example.com')
      })

      const messages1 = result.current.activeMessages
      rerender()
      const messages2 = result.current.activeMessages

      expect(messages1.length).toBe(0)
      expect(messages1).toBe(messages2)
    })

    it('should maintain stable array reference when unrelated state changes', () => {
      const { result } = renderHook(() => useChat(), { wrapper })

      act(() => {
        chatStore.getState().addConversation({
          id: 'alice@example.com',
          name: 'Alice',
          type: 'chat',
          unreadCount: 0,
        })
        chatStore.getState().addConversation({
          id: 'bob@example.com',
          name: 'Bob',
          type: 'chat',
          unreadCount: 0,
        })
      })

      const conversations1 = result.current.conversations

      // Arrays should have content
      expect(conversations1.length).toBe(2)
    })

    it('should update array reference when conversations actually change', () => {
      const { result } = renderHook(() => useChat(), { wrapper })

      act(() => {
        chatStore.getState().addConversation({
          id: 'alice@example.com',
          name: 'Alice',
          type: 'chat',
          unreadCount: 0,
        })
      })

      const conversations1 = result.current.conversations

      act(() => {
        chatStore.getState().addConversation({
          id: 'bob@example.com',
          name: 'Bob',
          type: 'chat',
          unreadCount: 0,
        })
      })

      const conversations2 = result.current.conversations

      // Content should have changed
      expect(conversations1.length).toBe(1)
      expect(conversations2.length).toBe(2)
      // References should be different (new array created)
      expect(conversations1).not.toBe(conversations2)
    })

    it('should update activeMessages reference when messages actually change', () => {
      const { result } = renderHook(() => useChat(), { wrapper })

      act(() => {
        chatStore.getState().addConversation({
          id: 'alice@example.com',
          name: 'Alice',
          type: 'chat',
          unreadCount: 0,
        })
        chatStore.getState().setActiveConversation('alice@example.com')
      })

      const messages1 = result.current.activeMessages

      act(() => {
        chatStore.getState().addMessage({
          type: 'chat',
          id: 'msg-1',
          conversationId: 'alice@example.com',
          from: 'alice@example.com',
          body: 'Hello!',
          timestamp: new Date(),
          isOutgoing: false,
        })
      })

      const messages2 = result.current.activeMessages

      // Content should have changed
      expect(messages1.length).toBe(0)
      expect(messages2.length).toBe(1)
      // References should be different (new array created)
      expect(messages1).not.toBe(messages2)
    })
  })
})
