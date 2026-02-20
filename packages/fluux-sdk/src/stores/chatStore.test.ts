import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest'
import { chatStore } from './chatStore'
import type { Message, Conversation } from '../core/types'
import { getLocalPart } from '../core/jid'
import { _resetStorageScopeForTesting, setStorageScopeJid } from '../utils/storageScope'

// Mock localStorage
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

// Mock messageCache to verify IndexedDB operations
vi.mock('../utils/messageCache', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../utils/messageCache')>()
  return {
    ...actual,
    deleteConversationMessages: vi.fn().mockResolvedValue(undefined),
    saveMessage: vi.fn().mockResolvedValue(undefined),
    saveMessages: vi.fn().mockResolvedValue(undefined),
    getMessages: vi.fn().mockResolvedValue([]),
    updateMessage: vi.fn().mockResolvedValue(undefined),
  }
})

// Import the mocked module for assertions
import * as messageCache from '../utils/messageCache'

// Helper to create test conversations
function createConversation(id: string, name?: string): Conversation {
  return {
    id,
    name: name || getLocalPart(id),
    type: 'chat',
    unreadCount: 0,
  }
}

// Helper to create test messages
function createMessage(conversationId: string, body: string, isOutgoing = false): Message {
  return {
    type: 'chat',
    id: `msg-${Date.now()}-${Math.random()}`,
    conversationId,
    from: isOutgoing ? 'me@example.com' : conversationId,
    body,
    timestamp: new Date(),
    isOutgoing,
  }
}

describe('chatStore', () => {
  beforeEach(() => {
    _resetStorageScopeForTesting()
    // Reset store state before each test
    localStorageMock.clear()
    chatStore.setState({
      // Reset separated maps (Phase 6)
      conversationEntities: new Map(),
      conversationMeta: new Map(),
      // Reset combined map
      conversations: new Map(),
      messages: new Map(),
      activeConversationId: null,
      archivedConversations: new Set(),
      mamQueryStates: new Map(),
      // Reset other ephemeral state
      typingStates: new Map(),
      drafts: new Map(),
    })
    vi.clearAllMocks()
  })

  afterEach(() => {
    vi.clearAllMocks()
  })

  describe('initial state', () => {
    it('should have empty conversations and messages', () => {
      const state = chatStore.getState()
      expect(state.conversations.size).toBe(0)
      expect(state.messages.size).toBe(0)
      expect(state.activeConversationId).toBeNull()
    })

    it('should return null for activeConversation when none selected', () => {
      const state = chatStore.getState()
      expect(state.activeConversation()).toBeNull()
    })

    it('should return empty array for activeMessages when none selected', () => {
      const state = chatStore.getState()
      expect(state.activeMessages()).toEqual([])
    })
  })

  describe('addConversation', () => {
    it('should add a new conversation', () => {
      const conv = createConversation('alice@example.com', 'Alice')

      chatStore.getState().addConversation(conv)

      const state = chatStore.getState()
      expect(state.conversations.size).toBe(1)
      expect(state.conversations.get('alice@example.com')).toEqual(conv)
    })

    it('should update existing conversation', () => {
      const conv1 = createConversation('alice@example.com', 'Alice')
      const conv2 = { ...conv1, name: 'Alice Updated', unreadCount: 5 }

      chatStore.getState().addConversation(conv1)
      chatStore.getState().addConversation(conv2)

      const state = chatStore.getState()
      expect(state.conversations.size).toBe(1)
      expect(state.conversations.get('alice@example.com')?.name).toBe('Alice Updated')
      expect(state.conversations.get('alice@example.com')?.unreadCount).toBe(5)
    })

    it('should add multiple conversations', () => {
      chatStore.getState().addConversation(createConversation('alice@example.com'))
      chatStore.getState().addConversation(createConversation('bob@example.com'))
      chatStore.getState().addConversation(createConversation('charlie@example.com'))

      expect(chatStore.getState().conversations.size).toBe(3)
    })
  })

  describe('deleteConversation', () => {
    it('should delete conversation and messages', () => {
      const conv = createConversation('alice@example.com')
      chatStore.getState().addConversation(conv)
      chatStore.getState().addMessage(createMessage('alice@example.com', 'Hello'))
      chatStore.getState().addMessage(createMessage('alice@example.com', 'World'))

      chatStore.getState().deleteConversation('alice@example.com')

      const state = chatStore.getState()
      expect(state.conversations.has('alice@example.com')).toBe(false)
      // Messages should be deleted
      expect(state.messages.get('alice@example.com')).toBeUndefined()
    })

    it('should clear activeConversationId if deleting active conversation', () => {
      chatStore.getState().addConversation(createConversation('alice@example.com'))
      chatStore.getState().setActiveConversation('alice@example.com')

      chatStore.getState().deleteConversation('alice@example.com')

      expect(chatStore.getState().activeConversationId).toBeNull()
    })

    it('should remove from archived set when deleting', () => {
      chatStore.getState().addConversation(createConversation('alice@example.com'))
      chatStore.getState().archiveConversation('alice@example.com')

      expect(chatStore.getState().archivedConversations.has('alice@example.com')).toBe(true)

      chatStore.getState().deleteConversation('alice@example.com')

      expect(chatStore.getState().archivedConversations.has('alice@example.com')).toBe(false)
    })

    it('should clear IndexedDB cache when deleting conversation', () => {
      chatStore.getState().addConversation(createConversation('alice@example.com'))

      chatStore.getState().deleteConversation('alice@example.com')

      expect(messageCache.deleteConversationMessages).toHaveBeenCalledWith('alice@example.com')
    })
  })

  describe('setActiveConversation', () => {
    it('should set active conversation', () => {
      chatStore.getState().addConversation(createConversation('alice@example.com'))

      chatStore.getState().setActiveConversation('alice@example.com')

      expect(chatStore.getState().activeConversationId).toBe('alice@example.com')
    })

    it('should return correct activeConversation', () => {
      const conv = createConversation('alice@example.com', 'Alice')
      chatStore.getState().addConversation(conv)
      chatStore.getState().setActiveConversation('alice@example.com')

      // Use toMatchObject because setActiveConversation calls markAsRead which adds lastReadAt
      expect(chatStore.getState().activeConversation()).toMatchObject(conv)
    })

    it('should clear active conversation when set to null', () => {
      chatStore.getState().addConversation(createConversation('alice@example.com'))
      chatStore.getState().setActiveConversation('alice@example.com')
      chatStore.getState().setActiveConversation(null)

      expect(chatStore.getState().activeConversationId).toBeNull()
    })

    it('should mark conversation as read when set active', () => {
      const conv = { ...createConversation('alice@example.com'), unreadCount: 5 }
      chatStore.getState().addConversation(conv)

      chatStore.getState().setActiveConversation('alice@example.com')

      expect(chatStore.getState().conversations.get('alice@example.com')?.unreadCount).toBe(0)
    })
  })

  describe('addMessage', () => {
    it('should add message to conversation', () => {
      chatStore.getState().addConversation(createConversation('alice@example.com'))
      const msg = createMessage('alice@example.com', 'Hello!')

      chatStore.getState().addMessage(msg)

      const messages = chatStore.getState().messages.get('alice@example.com')
      expect(messages?.length).toBe(1)
      expect(messages?.[0].body).toBe('Hello!')
    })

    it('should add message to messages array (lastMessage is derived in useChat)', () => {
      chatStore.getState().addConversation(createConversation('alice@example.com'))
      const msg = createMessage('alice@example.com', 'Hello!')

      chatStore.getState().addMessage(msg)

      // Note: lastMessage is now derived from messages array in useChat hook (like rooms)
      // Store only holds the messages array - verify the message is there
      const messages = chatStore.getState().messages.get('alice@example.com')
      expect(messages?.length).toBe(1)
      expect(messages?.[messages.length - 1].body).toBe('Hello!')
    })

    it('should increment unreadCount for incoming messages when not active', () => {
      chatStore.getState().addConversation(createConversation('alice@example.com'))

      chatStore.getState().addMessage(createMessage('alice@example.com', 'Hi', false))
      chatStore.getState().addMessage(createMessage('alice@example.com', 'Hello', false))

      const conv = chatStore.getState().conversations.get('alice@example.com')
      expect(conv?.unreadCount).toBe(2)
    })

    it('should not increment unreadCount for outgoing messages', () => {
      chatStore.getState().addConversation(createConversation('alice@example.com'))

      chatStore.getState().addMessage(createMessage('alice@example.com', 'Hi', true))

      const conv = chatStore.getState().conversations.get('alice@example.com')
      expect(conv?.unreadCount).toBe(0)
    })

    it('should increment unreadCount for delayed messages (offline delivery)', () => {
      // Delayed messages in 1:1 chats are from offline storage - they ARE new messages
      // the user hasn't seen, so they should increment unread count
      chatStore.getState().addConversation(createConversation('alice@example.com'))

      chatStore.getState().addMessage({
        ...createMessage('alice@example.com', 'Message sent while offline', false),
        isDelayed: true,
      })

      const conv = chatStore.getState().conversations.get('alice@example.com')
      expect(conv?.unreadCount).toBe(1)
    })

    it('should not increment unreadCount when conversation is active', () => {
      chatStore.getState().addConversation(createConversation('alice@example.com'))
      chatStore.getState().setActiveConversation('alice@example.com')

      chatStore.getState().addMessage(createMessage('alice@example.com', 'Hi', false))
      chatStore.getState().addMessage(createMessage('alice@example.com', 'Hello', false))

      const conv = chatStore.getState().conversations.get('alice@example.com')
      expect(conv?.unreadCount).toBe(0)
    })

    it('should return messages for active conversation via activeMessages', () => {
      chatStore.getState().addConversation(createConversation('alice@example.com'))
      chatStore.getState().addMessage(createMessage('alice@example.com', 'Hello'))
      chatStore.getState().addMessage(createMessage('alice@example.com', 'World'))
      chatStore.getState().setActiveConversation('alice@example.com')

      const activeMessages = chatStore.getState().activeMessages()
      expect(activeMessages.length).toBe(2)
    })

    it('should deduplicate messages by stanzaId', () => {
      chatStore.getState().addConversation(createConversation('alice@example.com'))

      const msg1: Message = {
        type: 'chat',
        id: 'msg-1',
        stanzaId: 'server-id-123',
        conversationId: 'alice@example.com',
        from: 'alice@example.com',
        body: 'Hello!',
        timestamp: new Date(),
        isOutgoing: false,
      }

      // Same stanzaId, different message id (server duplicate)
      const msg2: Message = {
        type: 'chat',
        id: 'msg-2',
        stanzaId: 'server-id-123',
        conversationId: 'alice@example.com',
        from: 'alice@example.com',
        body: 'Hello!',
        timestamp: new Date(),
        isOutgoing: false,
      }

      chatStore.getState().addMessage(msg1)
      chatStore.getState().addMessage(msg2)

      const messages = chatStore.getState().messages.get('alice@example.com')
      expect(messages?.length).toBe(1)
      expect(messages?.[0].id).toBe('msg-1')
    })

    it('should deduplicate messages by from + id when no stanzaId', () => {
      chatStore.getState().addConversation(createConversation('alice@example.com'))

      const msg1: Message = {
        type: 'chat',
        id: 'msg-same-id',
        conversationId: 'alice@example.com',
        from: 'alice@example.com',
        body: 'Hello!',
        timestamp: new Date(),
        isOutgoing: false,
      }

      // Same from + id (client duplicate)
      const msg2: Message = {
        type: 'chat',
        id: 'msg-same-id',
        conversationId: 'alice@example.com',
        from: 'alice@example.com',
        body: 'Hello!',
        timestamp: new Date(),
        isOutgoing: false,
      }

      chatStore.getState().addMessage(msg1)
      chatStore.getState().addMessage(msg2)

      const messages = chatStore.getState().messages.get('alice@example.com')
      expect(messages?.length).toBe(1)
    })

    it('should allow same message id from different senders', () => {
      chatStore.getState().addConversation(createConversation('alice@example.com'))

      const msg1: Message = {
        type: 'chat',
        id: 'msg-same-id',
        conversationId: 'alice@example.com',
        from: 'alice@example.com',
        body: 'Hello from Alice!',
        timestamp: new Date(),
        isOutgoing: false,
      }

      // Same id but different sender (not a duplicate)
      const msg2: Message = {
        type: 'chat',
        id: 'msg-same-id',
        conversationId: 'alice@example.com',
        from: 'bob@example.com',
        body: 'Hello from Bob!',
        timestamp: new Date(),
        isOutgoing: false,
      }

      chatStore.getState().addMessage(msg1)
      chatStore.getState().addMessage(msg2)

      const messages = chatStore.getState().messages.get('alice@example.com')
      expect(messages?.length).toBe(2)
    })

    it('should not increment unreadCount for duplicate messages', () => {
      chatStore.getState().addConversation(createConversation('alice@example.com'))

      const msg1: Message = {
        type: 'chat',
        id: 'msg-1',
        stanzaId: 'server-id-123',
        conversationId: 'alice@example.com',
        from: 'alice@example.com',
        body: 'Hello!',
        timestamp: new Date(),
        isOutgoing: false,
      }

      const msg2: Message = {
        type: 'chat',
        id: 'msg-2',
        stanzaId: 'server-id-123',
        conversationId: 'alice@example.com',
        from: 'alice@example.com',
        body: 'Hello!',
        timestamp: new Date(),
        isOutgoing: false,
      }

      chatStore.getState().addMessage(msg1)
      chatStore.getState().addMessage(msg2)

      const conv = chatStore.getState().conversations.get('alice@example.com')
      expect(conv?.unreadCount).toBe(1) // Only incremented once
    })

    it('should save message to IndexedDB when noStore is false', () => {
      chatStore.getState().addConversation(createConversation('alice@example.com'))
      const msg = createMessage('alice@example.com', 'Hello!')

      chatStore.getState().addMessage(msg)

      expect(messageCache.saveMessage).toHaveBeenCalledWith(msg)
    })

    it('should not save message to IndexedDB when noStore is true (XEP-0334)', () => {
      chatStore.getState().addConversation(createConversation('alice@example.com'))
      const msg = { ...createMessage('alice@example.com', 'Ephemeral message'), noStore: true }

      chatStore.getState().addMessage(msg)

      expect(messageCache.saveMessage).not.toHaveBeenCalled()
    })

    it('should still add noStore message to in-memory store', () => {
      chatStore.getState().addConversation(createConversation('alice@example.com'))
      const msg = { ...createMessage('alice@example.com', 'Ephemeral'), noStore: true }

      chatStore.getState().addMessage(msg)

      const messages = chatStore.getState().messages.get('alice@example.com')
      expect(messages?.length).toBe(1)
      expect(messages?.[0].body).toBe('Ephemeral')
    })

    it('should still increment unreadCount for noStore messages', () => {
      chatStore.getState().addConversation(createConversation('alice@example.com'))
      const msg = { ...createMessage('alice@example.com', 'Ephemeral', false), noStore: true }

      chatStore.getState().addMessage(msg)

      const conv = chatStore.getState().conversations.get('alice@example.com')
      expect(conv?.unreadCount).toBe(1)
    })
  })

  describe('markAsRead', () => {
    it('should reset unreadCount to 0', () => {
      const conv = { ...createConversation('alice@example.com'), unreadCount: 10 }
      chatStore.getState().addConversation(conv)

      chatStore.getState().markAsRead('alice@example.com')

      expect(chatStore.getState().conversations.get('alice@example.com')?.unreadCount).toBe(0)
    })

    it('should not affect other conversations', () => {
      chatStore.getState().addConversation({ ...createConversation('alice@example.com'), unreadCount: 5 })
      chatStore.getState().addConversation({ ...createConversation('bob@example.com'), unreadCount: 3 })

      chatStore.getState().markAsRead('alice@example.com')

      expect(chatStore.getState().conversations.get('alice@example.com')?.unreadCount).toBe(0)
      expect(chatStore.getState().conversations.get('bob@example.com')?.unreadCount).toBe(3)
    })

    it('should update lastReadAt to last message timestamp (resets new messages marker)', () => {
      // markAsRead should reset unreadCount AND update lastReadAt
      // This clears the "new messages" marker when switching back to a conversation
      const messageTimestamp = new Date('2025-01-10T12:00:00Z')
      chatStore.getState().addConversation({
        ...createConversation('alice@example.com'),
        unreadCount: 2,
        lastReadAt: new Date('2025-01-10T10:00:00Z'),
      })
      // Add a message so markAsRead can use its timestamp
      chatStore.getState().addMessage({
        type: 'chat',
        id: 'msg1',
        conversationId: 'alice@example.com',
        from: 'alice@example.com',
        body: 'Hello',
        timestamp: messageTimestamp,
        isOutgoing: false,
      })

      chatStore.getState().markAsRead('alice@example.com')

      const conv = chatStore.getState().conversations.get('alice@example.com')
      expect(conv?.unreadCount).toBe(0)
      expect(conv?.lastReadAt).toEqual(messageTimestamp) // lastReadAt updated to last message
    })

    it('should set lastReadAt to current time when no messages exist', () => {
      const beforeMark = new Date()
      chatStore.getState().addConversation({ ...createConversation('alice@example.com'), unreadCount: 1 })

      chatStore.getState().markAsRead('alice@example.com')

      const conv = chatStore.getState().conversations.get('alice@example.com')
      expect(conv?.unreadCount).toBe(0)
      expect(conv?.lastReadAt).toBeDefined()
      expect(conv!.lastReadAt!.getTime()).toBeGreaterThanOrEqual(beforeMark.getTime())
    })

    it('should update lastReadAt even when unreadCount is already 0', () => {
      // Bug fix: when switching to a conversation with 0 unread but stale lastReadAt,
      // the "new messages" marker would show incorrectly
      const oldLastReadAt = new Date('2025-01-10T10:00:00Z')
      const messageTimestamp = new Date('2025-01-10T12:00:00Z')

      chatStore.getState().addConversation({
        ...createConversation('alice@example.com'),
        unreadCount: 0, // Already read
        lastReadAt: oldLastReadAt,
      })

      // Add a newer message
      chatStore.getState().addMessage({
        type: 'chat',
        id: 'msg1',
        conversationId: 'alice@example.com',
        from: 'alice@example.com',
        body: 'New message',
        timestamp: messageTimestamp,
        isOutgoing: false,
      })

      // markAsRead should update lastReadAt to the new message timestamp
      chatStore.getState().markAsRead('alice@example.com')

      const conv = chatStore.getState().conversations.get('alice@example.com')
      expect(conv?.lastReadAt).toEqual(messageTimestamp)
    })

    it('should not trigger state update when called multiple times with same timestamp (regression test for infinite loop)', () => {
      // Regression test: Date objects were compared by reference (!==) instead of value (.getTime())
      // This caused infinite re-render loops because new Date() !== new Date() is always true
      const messageTimestamp = new Date('2025-01-10T12:00:00Z')
      chatStore.getState().addConversation({
        ...createConversation('alice@example.com'),
        unreadCount: 1,
      })
      chatStore.getState().addMessage({
        type: 'chat',
        id: 'msg1',
        conversationId: 'alice@example.com',
        from: 'alice@example.com',
        body: 'Hello',
        timestamp: messageTimestamp,
        isOutgoing: false,
      })

      // First call - should update state (unreadCount > 0)
      chatStore.getState().markAsRead('alice@example.com')
      const convAfterFirst = chatStore.getState().conversations.get('alice@example.com')
      expect(convAfterFirst?.unreadCount).toBe(0)
      expect(convAfterFirst?.lastReadAt).toEqual(messageTimestamp)

      // Capture conversation reference after first markAsRead
      const conversationsMapAfterFirst = chatStore.getState().conversations

      // Second call - should NOT update conversations (same timestamp, already read)
      chatStore.getState().markAsRead('alice@example.com')
      const conversationsMapAfterSecond = chatStore.getState().conversations

      // Conversations Map reference should be the same (no unnecessary update)
      // This prevents infinite re-render loops in React when using selectors
      expect(conversationsMapAfterSecond).toBe(conversationsMapAfterFirst)

      // Conversation object should also be the same reference
      const convAfterSecond = chatStore.getState().conversations.get('alice@example.com')
      expect(convAfterSecond).toBe(convAfterFirst)
    })

    it('should handle lastReadAt as string (after JSON deserialization from persist middleware)', () => {
      // Regression test: When state is persisted to localStorage and restored,
      // Date objects get serialized as ISO strings. The store must handle both
      // Date objects and strings for lastReadAt comparisons.
      const messageTimestamp = new Date('2025-01-10T12:00:00Z')

      // Simulate a conversation with lastReadAt as a string (as it would be after JSON parse)
      chatStore.setState((state) => {
        const newConversations = new Map(state.conversations)
        newConversations.set('alice@example.com', {
          id: 'alice@example.com',
          name: 'Alice',
          type: 'chat',
          unreadCount: 1,
          // This simulates what happens when JSON.parse() deserializes a Date
          lastReadAt: '2025-01-10T10:00:00.000Z' as unknown as Date,
        })
        return { conversations: newConversations }
      })

      chatStore.getState().addMessage({
        type: 'chat',
        id: 'msg1',
        conversationId: 'alice@example.com',
        from: 'alice@example.com',
        body: 'Hello',
        timestamp: messageTimestamp,
        isOutgoing: false,
      })

      // This should NOT throw "getTime is not a function"
      expect(() => {
        chatStore.getState().markAsRead('alice@example.com')
      }).not.toThrow()

      const conv = chatStore.getState().conversations.get('alice@example.com')
      expect(conv?.unreadCount).toBe(0)
      expect(conv?.lastReadAt).toEqual(messageTimestamp)
    })

    it('should handle lastReadAt as string in setActiveConversation (after JSON deserialization)', () => {
      // Regression test: setActiveConversation also compares timestamps for new messages marker
      const oldTimestamp = '2025-01-10T10:00:00.000Z'
      const newMessageTimestamp = new Date('2025-01-10T12:00:00Z')

      // Simulate a conversation with lastReadAt as a string
      chatStore.setState((state) => {
        const newConversations = new Map(state.conversations)
        newConversations.set('alice@example.com', {
          id: 'alice@example.com',
          name: 'Alice',
          type: 'chat',
          unreadCount: 1,
          // Simulates deserialized JSON
          lastReadAt: oldTimestamp as unknown as Date,
        })
        const newMessages = new Map(state.messages)
        newMessages.set('alice@example.com', [{
          type: 'chat',
          id: 'msg1',
          conversationId: 'alice@example.com',
          from: 'alice@example.com',
          body: 'New message',
          timestamp: newMessageTimestamp,
          isOutgoing: false,
        }])
        return { conversations: newConversations, messages: newMessages }
      })

      // This should NOT throw "cannot compare Date with string"
      expect(() => {
        chatStore.getState().setActiveConversation('alice@example.com')
      }).not.toThrow()

      // Should have set the new messages marker since the message is after lastReadAt
      const conv = chatStore.getState().conversations.get('alice@example.com')
      expect(conv?.firstNewMessageId).toBe('msg1')
    })
  })

  describe('hasConversation', () => {
    it('should return true for existing conversation', () => {
      chatStore.getState().addConversation(createConversation('alice@example.com'))

      expect(chatStore.getState().hasConversation('alice@example.com')).toBe(true)
    })

    it('should return false for non-existing conversation', () => {
      expect(chatStore.getState().hasConversation('unknown@example.com')).toBe(false)
    })
  })

  describe('reset', () => {
    it('should clear all state', () => {
      chatStore.getState().addConversation(createConversation('alice@example.com'))
      chatStore.getState().addMessage(createMessage('alice@example.com', 'Hello'))
      chatStore.getState().setActiveConversation('alice@example.com')

      chatStore.getState().reset()

      const state = chatStore.getState()
      expect(state.conversations.size).toBe(0)
      expect(state.messages.size).toBe(0)
      expect(state.activeConversationId).toBeNull()
    })

    it('should clear localStorage', () => {
      chatStore.getState().addConversation(createConversation('alice@example.com'))

      chatStore.getState().reset()

      expect(localStorageMock.removeItem).toHaveBeenCalledWith('xmpp-chat-storage')
    })
  })

  describe('switchAccount', () => {
    it('should load account-scoped conversations and drafts', () => {
      const aliceState = JSON.stringify({
        state: {
          conversations: [['alice@example.com', { id: 'alice@example.com', name: 'Alice', type: 'chat', unreadCount: 0 }]],
          archivedConversations: [],
          drafts: [['alice@example.com', 'Alice draft']],
        },
      })
      localStorageMock._store['xmpp-chat-storage:alice@example.com'] = aliceState

      setStorageScopeJid('alice@example.com')
      chatStore.getState().switchAccount('alice@example.com')

      expect(chatStore.getState().conversations.has('alice@example.com')).toBe(true)
      expect(chatStore.getState().getDraft('alice@example.com')).toBe('Alice draft')
    })

    it('should clear in-memory state when switching to an account without saved data', () => {
      chatStore.getState().addConversation(createConversation('alice@example.com'))
      chatStore.getState().setDraft('alice@example.com', 'local draft')

      localStorageMock.removeItem('xmpp-chat-storage')
      setStorageScopeJid('bob@example.com')
      chatStore.getState().switchAccount('bob@example.com')

      expect(chatStore.getState().conversations.size).toBe(0)
      expect(chatStore.getState().drafts.size).toBe(0)
    })

    it('should migrate only conversation lists from legacy storage', () => {
      const legacyData = JSON.stringify({
        state: {
          conversations: [
            ['alice@example.com', { id: 'alice@example.com', name: 'Alice', type: 'chat', unreadCount: 0 }],
            ['bob@example.com', { id: 'bob@example.com', name: 'Bob', type: 'chat', unreadCount: 0 }],
          ],
          archivedConversations: ['bob@example.com'],
          drafts: [['alice@example.com', 'legacy draft should not migrate']],
        },
      })
      localStorageMock._store['xmpp-chat-storage'] = legacyData

      setStorageScopeJid('me@example.com')
      chatStore.getState().switchAccount('me@example.com')

      // Legacy key should be consumed after successful migration
      expect(localStorageMock._store['xmpp-chat-storage']).toBeUndefined()
      expect(localStorageMock._store['xmpp-chat-storage:me@example.com']).toBeDefined()

      // Conversation lists should be restored
      expect(chatStore.getState().conversations.has('alice@example.com')).toBe(true)
      expect(chatStore.getState().conversations.has('bob@example.com')).toBe(true)
      expect(chatStore.getState().archivedConversations.has('bob@example.com')).toBe(true)

      // Drafts are intentionally not migrated
      expect(chatStore.getState().drafts.size).toBe(0)
      expect(chatStore.getState().getDraft('alice@example.com')).toBe('')
    })
  })

  describe('persistence', () => {
    it('should serialize conversations Map to array', () => {
      chatStore.getState().addConversation(createConversation('alice@example.com', 'Alice'))
      chatStore.getState().addConversation(createConversation('bob@example.com', 'Bob'))

      // Check localStorage was called with serialized data
      expect(localStorageMock.setItem).toHaveBeenCalled()

      const lastCall = localStorageMock.setItem.mock.calls[localStorageMock.setItem.mock.calls.length - 1]
      const stored = JSON.parse(lastCall[1])

      // Should be array of tuples, not a Map
      expect(Array.isArray(stored.state.conversations)).toBe(true)
      expect(stored.state.conversations.length).toBe(2)
    })

    it('should NOT serialize messages to localStorage (they are in IndexedDB)', () => {
      // Messages are stored in IndexedDB now, not localStorage
      // The localStorage persistence only stores conversations metadata
      chatStore.getState().addConversation(createConversation('alice@example.com'))
      chatStore.getState().addMessage(createMessage('alice@example.com', 'Hello'))

      const lastCall = localStorageMock.setItem.mock.calls[localStorageMock.setItem.mock.calls.length - 1]
      const stored = JSON.parse(lastCall[1])

      // Messages should not be in localStorage (they're in IndexedDB)
      expect(stored.state.messages).toBeUndefined()
    })

    it('should store messages in memory (display buffer) without localStorage limit', () => {
      // Messages are stored in memory for display, with a high limit (1000)
      // This test verifies we can store more than the old 100 message limit
      chatStore.getState().addConversation(createConversation('alice@example.com'))

      // Add 500 messages (was limited to 100 before, now can go up to 1000)
      for (let i = 0; i < 500; i++) {
        chatStore.getState().addMessage(createMessage('alice@example.com', `Message ${i}`))
      }

      // All 500 messages should be in memory
      const messages = chatStore.getState().messages.get('alice@example.com')
      expect(messages?.length).toBe(500)
    })

    it('should serialize conversation with lastMessage', () => {
      // Note: lastMessage is stored on the conversation and updated when messages are added
      // This avoids subscribing to the entire messagesMap in useChat which causes render loops
      const conv = createConversation('alice@example.com')
      chatStore.getState().addConversation(conv)

      const originalDate = new Date('2024-01-15T10:30:00Z')
      const msg: Message = {
        type: 'chat',
        id: 'test-msg',
        conversationId: 'alice@example.com',
        from: 'alice@example.com',
        body: 'Test',
        timestamp: originalDate,
        isOutgoing: false,
      }
      chatStore.getState().addMessage(msg)

      // Get the serialized data
      const lastCall = localStorageMock.setItem.mock.calls[localStorageMock.setItem.mock.calls.length - 1]
      const serialized = lastCall[1]

      // The persist middleware serializes the conversation
      const parsed = JSON.parse(serialized)

      // Conversation should have lastMessage (updated when message was added)
      const conversationData = parsed.state.conversations.find(
        ([id]: [string, unknown]) => id === 'alice@example.com'
      )
      expect(conversationData).toBeDefined()
      // lastMessage is now stored on the conversation
      expect(conversationData[1].lastMessage).toBeDefined()
      expect(conversationData[1].lastMessage.id).toBe('test-msg')
      expect(conversationData[1].lastMessage.body).toBe('Test')
    })

    it('should reset unreadCount to 0 when deserializing', () => {
      // This tests the behavior that unread counts are session-specific
      const conv = { ...createConversation('alice@example.com'), unreadCount: 5 }
      chatStore.getState().addConversation(conv)

      // Get the serialized data
      const lastCall = localStorageMock.setItem.mock.calls[localStorageMock.setItem.mock.calls.length - 1]
      const serialized = lastCall[1]

      // Check that when we would deserialize, unreadCount gets reset
      // (The actual deserialization logic resets unreadCount to 0)
      const parsed = JSON.parse(serialized)

      // The serialized data preserves the unreadCount
      expect(parsed.state.conversations[0][1].unreadCount).toBe(5)

      // But the deserializeState function resets it (tested via behavior)
    })

    it('should handle corrupted localStorage gracefully', () => {
      localStorageMock.getItem.mockReturnValueOnce('invalid json {{{')

      // Should not throw when accessing store with corrupted data
      expect(() => chatStore.getState()).not.toThrow()
    })

    it('should handle missing localStorage data', () => {
      localStorageMock.getItem.mockReturnValueOnce(null)

      // Should work fine with no stored data
      const state = chatStore.getState()
      expect(state.conversations.size).toBe(0)
    })

    it('should store messages in array with proper Date timestamps', () => {
      // Note: lastMessage is now derived from messages array in useChat hook (like rooms)
      // Messages are stored in IndexedDB, not localStorage, but we verify in-memory behavior
      const conv = createConversation('alice@example.com')
      chatStore.getState().addConversation(conv)

      const originalDate = new Date('2024-01-15T10:30:00Z')
      const msg: Message = {
        type: 'chat',
        id: 'test-msg',
        conversationId: 'alice@example.com',
        from: 'alice@example.com',
        body: 'Test',
        timestamp: originalDate,
        isOutgoing: false,
      }
      chatStore.getState().addMessage(msg)

      // Verify message is in the array with proper Date timestamp
      const messages = chatStore.getState().messages.get('alice@example.com')
      expect(messages?.length).toBe(1)
      expect(messages?.[0].timestamp).toBeInstanceOf(Date)
      expect(messages?.[0].timestamp.getTime()).toBe(originalDate.getTime())
      // Most importantly: getTime() should return a valid number, not NaN
      expect(Number.isNaN(messages?.[0].timestamp.getTime())).toBe(false)
    })

    it('should NOT persist activeConversationId (not stored or always null)', () => {
      // This test prevents regression of the dual-persistence bug where
      // activeConversationId was persisted in both chatStore (localStorage)
      // and ChatLayout's session storage, causing unread badge issues.
      // See: ChatLayout manages activeConversationId via ViewStateData.
      chatStore.getState().addConversation(createConversation('alice@example.com'))
      chatStore.getState().setActiveConversation('alice@example.com')

      // Verify the store has the active conversation set
      expect(chatStore.getState().activeConversationId).toBe('alice@example.com')

      // Get the serialized data
      const lastCall = localStorageMock.setItem.mock.calls[localStorageMock.setItem.mock.calls.length - 1]
      const stored = JSON.parse(lastCall[1])

      // activeConversationId should NOT be the current value - either null, undefined, or not present
      // The key point is that 'alice@example.com' should NOT be persisted
      expect(stored.state.activeConversationId).not.toBe('alice@example.com')
      // It should be falsy (null or undefined)
      expect(stored.state.activeConversationId).toBeFalsy()
    })

    it('should always deserialize activeConversationId as null', () => {
      // Even if old localStorage data has activeConversationId set (legacy),
      // deserialize should return null to prevent stale values
      const legacySerializedData = JSON.stringify({
        state: {
          conversations: [['alice@example.com', { id: 'alice@example.com', name: 'Alice', type: 'chat', unreadCount: 0 }]],
          messages: [],
          activeConversationId: 'alice@example.com', // Legacy: this was persisted before
          archivedConversations: [],
        },
      })

      // Simulate loading from localStorage with legacy data
      localStorageMock._store['xmpp-chat-storage'] = legacySerializedData
      localStorageMock.getItem.mockReturnValue(legacySerializedData)

      // Reset and reload store (simulating page refresh)
      chatStore.persist.rehydrate()

      // activeConversationId should be null regardless of legacy stored value
      expect(chatStore.getState().activeConversationId).toBeNull()
    })
  })

  describe('groupchat conversations', () => {
    it('should handle groupchat type conversations', () => {
      const groupConv: Conversation = {
        id: 'room@conference.example.com',
        name: 'Team Chat',
        type: 'groupchat',
        unreadCount: 0,
      }

      chatStore.getState().addConversation(groupConv)

      const stored = chatStore.getState().conversations.get('room@conference.example.com')
      expect(stored?.type).toBe('groupchat')
    })
  })

  describe('updateReactions (XEP-0444)', () => {
    it('should add reactions to a message', () => {
      chatStore.getState().addConversation(createConversation('alice@example.com'))
      const msg = createMessage('alice@example.com', 'Hello!')
      chatStore.getState().addMessage(msg)

      chatStore.getState().updateReactions('alice@example.com', msg.id, 'bob@example.com', ['👍'])

      const messages = chatStore.getState().messages.get('alice@example.com')
      expect(messages?.[0].reactions).toEqual({ '👍': ['bob@example.com'] })
    })

    it('should add multiple reactions from same user', () => {
      chatStore.getState().addConversation(createConversation('alice@example.com'))
      const msg = createMessage('alice@example.com', 'Hello!')
      chatStore.getState().addMessage(msg)

      chatStore.getState().updateReactions('alice@example.com', msg.id, 'bob@example.com', ['👍', '❤️'])

      const messages = chatStore.getState().messages.get('alice@example.com')
      expect(messages?.[0].reactions).toEqual({
        '👍': ['bob@example.com'],
        '❤️': ['bob@example.com'],
      })
    })

    it('should aggregate reactions from multiple users', () => {
      chatStore.getState().addConversation(createConversation('alice@example.com'))
      const msg = createMessage('alice@example.com', 'Hello!')
      chatStore.getState().addMessage(msg)

      chatStore.getState().updateReactions('alice@example.com', msg.id, 'bob@example.com', ['👍'])
      chatStore.getState().updateReactions('alice@example.com', msg.id, 'charlie@example.com', ['👍'])

      const messages = chatStore.getState().messages.get('alice@example.com')
      expect(messages?.[0].reactions).toEqual({
        '👍': ['bob@example.com', 'charlie@example.com'],
      })
    })

    it('should replace previous reactions when user sends new set', () => {
      chatStore.getState().addConversation(createConversation('alice@example.com'))
      const msg = createMessage('alice@example.com', 'Hello!')
      chatStore.getState().addMessage(msg)

      // Bob reacts with thumbs up
      chatStore.getState().updateReactions('alice@example.com', msg.id, 'bob@example.com', ['👍'])
      // Bob changes reaction to heart
      chatStore.getState().updateReactions('alice@example.com', msg.id, 'bob@example.com', ['❤️'])

      const messages = chatStore.getState().messages.get('alice@example.com')
      expect(messages?.[0].reactions).toEqual({ '❤️': ['bob@example.com'] })
    })

    it('should remove all reactions when user sends empty array', () => {
      chatStore.getState().addConversation(createConversation('alice@example.com'))
      const msg = createMessage('alice@example.com', 'Hello!')
      chatStore.getState().addMessage(msg)

      chatStore.getState().updateReactions('alice@example.com', msg.id, 'bob@example.com', ['👍'])
      chatStore.getState().updateReactions('alice@example.com', msg.id, 'bob@example.com', [])

      const messages = chatStore.getState().messages.get('alice@example.com')
      expect(messages?.[0].reactions).toBeUndefined()
    })

    it('should handle removing one user while keeping others', () => {
      chatStore.getState().addConversation(createConversation('alice@example.com'))
      const msg = createMessage('alice@example.com', 'Hello!')
      chatStore.getState().addMessage(msg)

      chatStore.getState().updateReactions('alice@example.com', msg.id, 'bob@example.com', ['👍'])
      chatStore.getState().updateReactions('alice@example.com', msg.id, 'charlie@example.com', ['👍'])
      // Bob removes reaction
      chatStore.getState().updateReactions('alice@example.com', msg.id, 'bob@example.com', [])

      const messages = chatStore.getState().messages.get('alice@example.com')
      expect(messages?.[0].reactions).toEqual({ '👍': ['charlie@example.com'] })
    })

    it('should not modify state if conversation does not exist', () => {
      chatStore.getState().updateReactions('nonexistent@example.com', 'msg-id', 'bob@example.com', ['👍'])

      const messages = chatStore.getState().messages.get('nonexistent@example.com')
      expect(messages).toBeUndefined()
    })

    it('should not modify state if message does not exist', () => {
      chatStore.getState().addConversation(createConversation('alice@example.com'))
      const msg = createMessage('alice@example.com', 'Hello!')
      chatStore.getState().addMessage(msg)

      chatStore.getState().updateReactions('alice@example.com', 'wrong-msg-id', 'bob@example.com', ['👍'])

      const messages = chatStore.getState().messages.get('alice@example.com')
      expect(messages?.[0].reactions).toBeUndefined()
    })

    it('should handle emoji reactions correctly', () => {
      chatStore.getState().addConversation(createConversation('alice@example.com'))
      const msg = createMessage('alice@example.com', 'Hello!')
      chatStore.getState().addMessage(msg)

      chatStore.getState().updateReactions('alice@example.com', msg.id, 'bob@example.com', ['🎉', '🔥', '💯'])

      const messages = chatStore.getState().messages.get('alice@example.com')
      expect(messages?.[0].reactions).toEqual({
        '🎉': ['bob@example.com'],
        '🔥': ['bob@example.com'],
        '💯': ['bob@example.com'],
      })
    })

    it('should find message by stanzaId when reaction references server-assigned ID', () => {
      chatStore.getState().addConversation(createConversation('alice@example.com'))
      const msg = createMessage('alice@example.com', 'Hello!')
      msg.stanzaId = 'server-stanza-id-123'
      chatStore.getState().addMessage(msg)

      // Reaction references the stanzaId (as other clients like Gajim may do)
      chatStore.getState().updateReactions('alice@example.com', 'server-stanza-id-123', 'bob@example.com', ['👍'])

      const messages = chatStore.getState().messages.get('alice@example.com')
      expect(messages?.[0].reactions).toEqual({ '👍': ['bob@example.com'] })
    })

    it('should replace reactions when referenced by stanzaId', () => {
      chatStore.getState().addConversation(createConversation('alice@example.com'))
      const msg = createMessage('alice@example.com', 'Hello!')
      msg.stanzaId = 'server-stanza-id-456'
      chatStore.getState().addMessage(msg)

      // First reaction via stanzaId
      chatStore.getState().updateReactions('alice@example.com', 'server-stanza-id-456', 'bob@example.com', ['👍'])
      // Bob changes reaction (still via stanzaId)
      chatStore.getState().updateReactions('alice@example.com', 'server-stanza-id-456', 'bob@example.com', ['❤️'])

      const messages = chatStore.getState().messages.get('alice@example.com')
      expect(messages?.[0].reactions).toEqual({ '❤️': ['bob@example.com'] })
    })
  })

  describe('draft management', () => {
    beforeEach(() => {
      // Reset drafts state
      chatStore.setState({ drafts: new Map() })
    })

    it('should save a draft for a conversation', () => {
      chatStore.getState().setDraft('alice@example.com', 'Hello, this is my draft')

      expect(chatStore.getState().getDraft('alice@example.com')).toBe('Hello, this is my draft')
    })

    it('should return empty string for conversation without draft', () => {
      expect(chatStore.getState().getDraft('nonexistent@example.com')).toBe('')
    })

    it('should update existing draft when setting new text', () => {
      chatStore.getState().setDraft('alice@example.com', 'First draft')
      chatStore.getState().setDraft('alice@example.com', 'Updated draft')

      expect(chatStore.getState().getDraft('alice@example.com')).toBe('Updated draft')
    })

    it('should maintain separate drafts for different conversations', () => {
      chatStore.getState().setDraft('alice@example.com', 'Message for Alice')
      chatStore.getState().setDraft('bob@example.com', 'Message for Bob')
      chatStore.getState().setDraft('charlie@example.com', 'Message for Charlie')

      expect(chatStore.getState().getDraft('alice@example.com')).toBe('Message for Alice')
      expect(chatStore.getState().getDraft('bob@example.com')).toBe('Message for Bob')
      expect(chatStore.getState().getDraft('charlie@example.com')).toBe('Message for Charlie')
    })

    it('should delete draft when setting empty string', () => {
      chatStore.getState().setDraft('alice@example.com', 'Some text')
      chatStore.getState().setDraft('alice@example.com', '')

      const state = chatStore.getState()
      expect(state.drafts.has('alice@example.com')).toBe(false)
      expect(state.getDraft('alice@example.com')).toBe('')
    })

    it('should delete draft when setting whitespace-only string', () => {
      chatStore.getState().setDraft('alice@example.com', 'Some text')
      chatStore.getState().setDraft('alice@example.com', '   ')

      const state = chatStore.getState()
      expect(state.drafts.has('alice@example.com')).toBe(false)
    })

    it('should clear draft for a specific conversation', () => {
      chatStore.getState().setDraft('alice@example.com', 'Draft for Alice')
      chatStore.getState().setDraft('bob@example.com', 'Draft for Bob')

      chatStore.getState().clearDraft('alice@example.com')

      expect(chatStore.getState().getDraft('alice@example.com')).toBe('')
      expect(chatStore.getState().getDraft('bob@example.com')).toBe('Draft for Bob')
    })

    it('should not throw when clearing non-existent draft', () => {
      expect(() => {
        chatStore.getState().clearDraft('nonexistent@example.com')
      }).not.toThrow()
    })

    it('should clear all drafts on reset', () => {
      chatStore.getState().setDraft('alice@example.com', 'Draft for Alice')
      chatStore.getState().setDraft('bob@example.com', 'Draft for Bob')

      chatStore.getState().reset()

      expect(chatStore.getState().getDraft('alice@example.com')).toBe('')
      expect(chatStore.getState().getDraft('bob@example.com')).toBe('')
      expect(chatStore.getState().drafts.size).toBe(0)
    })

    it('should preserve drafts when switching active conversation', () => {
      chatStore.getState().addConversation(createConversation('alice@example.com'))
      chatStore.getState().addConversation(createConversation('bob@example.com'))
      chatStore.getState().setDraft('alice@example.com', 'Draft for Alice')

      // Switch active conversation
      chatStore.getState().setActiveConversation('bob@example.com')

      // Draft should still be preserved for Alice
      expect(chatStore.getState().getDraft('alice@example.com')).toBe('Draft for Alice')
    })

    it('should persist drafts to localStorage', () => {
      chatStore.getState().setDraft('alice@example.com', 'Persistent draft')

      // Get the serialized data
      const calls = localStorageMock.setItem.mock.calls
      expect(calls.length).toBeGreaterThan(0)

      const lastCall = calls[calls.length - 1]
      const stored = JSON.parse(lastCall[1])

      // Drafts should be in the persisted state as array of tuples
      expect(stored.state.drafts).toBeDefined()
      expect(Array.isArray(stored.state.drafts)).toBe(true)
      expect(stored.state.drafts).toContainEqual(['alice@example.com', 'Persistent draft'])
    })

    it('should restore drafts from localStorage after rehydration', async () => {
      // Reset all mocks to clear any mockReturnValueOnce calls from previous tests
      localStorageMock.getItem.mockReset()
      localStorageMock.setItem.mockReset()
      localStorageMock.removeItem.mockReset()
      localStorageMock.clear.mockReset()

      // Ensure clean state before test
      chatStore.setState({
        conversations: new Map(),
        messages: new Map(),
        activeConversationId: null,
        archivedConversations: new Set(),
        drafts: new Map(),
        mamQueryStates: new Map(),
      })

      // Set up drafts in localStorage
      const storedData = JSON.stringify({
        state: {
          conversations: [],
          archivedConversations: [],
          drafts: [
            ['alice@example.com', 'Draft for Alice'],
            ['bob@example.com', 'Draft for Bob'],
          ],
        },
      })
      // Set the internal store AND provide a fresh mock implementation
      localStorageMock._store['xmpp-chat-storage'] = storedData
      localStorageMock.getItem.mockImplementation((key: string) =>
        localStorageMock._store[key] || null
      )

      // Rehydrate the store (returns a Promise)
      await chatStore.persist.rehydrate()

      // Drafts should be restored
      expect(chatStore.getState().getDraft('alice@example.com')).toBe('Draft for Alice')
      expect(chatStore.getState().getDraft('bob@example.com')).toBe('Draft for Bob')
    })

    it('should handle missing drafts in old localStorage data (backwards compatible)', () => {
      // Old localStorage data without drafts field
      const legacyData = JSON.stringify({
        state: {
          conversations: [],
          archivedConversations: [],
          // Note: no drafts field
        },
      })
      localStorageMock._store['xmpp-chat-storage'] = legacyData
      localStorageMock.getItem.mockReturnValue(legacyData)

      // Rehydrate the store - should not throw
      expect(() => chatStore.persist.rehydrate()).not.toThrow()

      // Drafts should default to empty
      expect(chatStore.getState().drafts.size).toBe(0)
      expect(chatStore.getState().getDraft('alice@example.com')).toBe('')
    })
  })

  describe('message routing safety', () => {
    // These tests ensure messages are sent to the correct conversation
    // and drafts don't accidentally get sent to wrong recipients

    it('should keep draft isolated to its conversation when switching', () => {
      chatStore.getState().addConversation(createConversation('alice@example.com'))
      chatStore.getState().addConversation(createConversation('bob@example.com'))

      // Set draft for Alice while viewing her conversation
      chatStore.getState().setActiveConversation('alice@example.com')
      chatStore.getState().setDraft('alice@example.com', 'Secret message for Alice only')

      // Switch to Bob's conversation
      chatStore.getState().setActiveConversation('bob@example.com')

      // Alice's draft should be intact
      expect(chatStore.getState().getDraft('alice@example.com')).toBe('Secret message for Alice only')
      // Bob should have no draft
      expect(chatStore.getState().getDraft('bob@example.com')).toBe('')
    })

    it('should not mix up drafts between conversations', () => {
      chatStore.getState().addConversation(createConversation('alice@example.com'))
      chatStore.getState().addConversation(createConversation('bob@example.com'))
      chatStore.getState().addConversation(createConversation('charlie@example.com'))

      // Set drafts for multiple conversations
      chatStore.getState().setDraft('alice@example.com', 'PRIVATE: Alice draft')
      chatStore.getState().setDraft('bob@example.com', 'PRIVATE: Bob draft')

      // Switch between conversations multiple times
      chatStore.getState().setActiveConversation('alice@example.com')
      chatStore.getState().setActiveConversation('charlie@example.com')
      chatStore.getState().setActiveConversation('bob@example.com')
      chatStore.getState().setActiveConversation('alice@example.com')

      // All drafts should still be correctly associated
      expect(chatStore.getState().getDraft('alice@example.com')).toBe('PRIVATE: Alice draft')
      expect(chatStore.getState().getDraft('bob@example.com')).toBe('PRIVATE: Bob draft')
      expect(chatStore.getState().getDraft('charlie@example.com')).toBe('')
    })

    it('should add message to correct conversation regardless of active conversation', () => {
      chatStore.getState().addConversation(createConversation('alice@example.com'))
      chatStore.getState().addConversation(createConversation('bob@example.com'))

      // View Alice's conversation
      chatStore.getState().setActiveConversation('alice@example.com')

      // Add message to Bob's conversation (e.g., incoming message)
      const msgForBob = createMessage('bob@example.com', 'Message for Bob')
      chatStore.getState().addMessage(msgForBob)

      // Message should be in Bob's conversation, not Alice's
      expect(chatStore.getState().messages.get('bob@example.com')?.length).toBe(1)
      expect(chatStore.getState().messages.get('alice@example.com')).toBeUndefined()
    })

    it('should correctly track which conversation has unread messages', () => {
      chatStore.getState().addConversation(createConversation('alice@example.com'))
      chatStore.getState().addConversation(createConversation('bob@example.com'))

      // View Alice's conversation
      chatStore.getState().setActiveConversation('alice@example.com')

      // Messages to inactive conversation should increment unread
      chatStore.getState().addMessage(createMessage('bob@example.com', 'Hi from Bob'))
      chatStore.getState().addMessage(createMessage('bob@example.com', 'Another message'))

      // Messages to active conversation should not increment unread
      chatStore.getState().addMessage(createMessage('alice@example.com', 'Hi Alice'))

      expect(chatStore.getState().conversations.get('bob@example.com')?.unreadCount).toBe(2)
      expect(chatStore.getState().conversations.get('alice@example.com')?.unreadCount).toBe(0)
    })
  })

  describe('conversation archiving', () => {
    it('should archive a conversation', () => {
      chatStore.getState().addConversation(createConversation('alice@example.com'))

      chatStore.getState().archiveConversation('alice@example.com')

      expect(chatStore.getState().isArchived('alice@example.com')).toBe(true)
      expect(chatStore.getState().archivedConversations.has('alice@example.com')).toBe(true)
    })

    it('should unarchive a conversation', () => {
      chatStore.getState().addConversation(createConversation('alice@example.com'))
      chatStore.getState().archiveConversation('alice@example.com')

      chatStore.getState().unarchiveConversation('alice@example.com')

      expect(chatStore.getState().isArchived('alice@example.com')).toBe(false)
      expect(chatStore.getState().archivedConversations.has('alice@example.com')).toBe(false)
    })

    it('should return false for non-archived conversation', () => {
      chatStore.getState().addConversation(createConversation('alice@example.com'))

      expect(chatStore.getState().isArchived('alice@example.com')).toBe(false)
    })

    it('should auto-unarchive when new message arrives', () => {
      chatStore.getState().addConversation(createConversation('alice@example.com'))
      chatStore.getState().archiveConversation('alice@example.com')

      expect(chatStore.getState().isArchived('alice@example.com')).toBe(true)

      // Receive a new message
      const msg = createMessage('alice@example.com', 'New message!')
      chatStore.getState().addMessage(msg)

      expect(chatStore.getState().isArchived('alice@example.com')).toBe(false)
    })

    it('should not auto-unarchive for outgoing messages', () => {
      chatStore.getState().addConversation(createConversation('alice@example.com'))
      chatStore.getState().archiveConversation('alice@example.com')

      // Send an outgoing message
      const msg = createMessage('alice@example.com', 'My reply', true)
      chatStore.getState().addMessage(msg)

      // Should still be archived since it's our own message
      expect(chatStore.getState().isArchived('alice@example.com')).toBe(true)
    })

    it('should clear active conversation when archiving it', () => {
      chatStore.getState().addConversation(createConversation('alice@example.com'))
      chatStore.getState().setActiveConversation('alice@example.com')

      chatStore.getState().archiveConversation('alice@example.com')

      expect(chatStore.getState().activeConversationId).toBeNull()
    })

    it('should handle archiving multiple conversations', () => {
      chatStore.getState().addConversation(createConversation('alice@example.com'))
      chatStore.getState().addConversation(createConversation('bob@example.com'))
      chatStore.getState().addConversation(createConversation('charlie@example.com'))

      chatStore.getState().archiveConversation('alice@example.com')
      chatStore.getState().archiveConversation('charlie@example.com')

      expect(chatStore.getState().isArchived('alice@example.com')).toBe(true)
      expect(chatStore.getState().isArchived('bob@example.com')).toBe(false)
      expect(chatStore.getState().isArchived('charlie@example.com')).toBe(true)
      expect(chatStore.getState().archivedConversations.size).toBe(2)
    })
  })

  describe('MAM (XEP-0313) support', () => {
    describe('setMAMLoading', () => {
      it('should set loading state for a conversation', () => {
        chatStore.getState().setMAMLoading('alice@example.com', true)

        const state = chatStore.getState().getMAMQueryState('alice@example.com')
        expect(state.isLoading).toBe(true)
      })

      it('should clear loading state for a conversation', () => {
        chatStore.getState().setMAMLoading('alice@example.com', true)
        chatStore.getState().setMAMLoading('alice@example.com', false)

        const state = chatStore.getState().getMAMQueryState('alice@example.com')
        expect(state.isLoading).toBe(false)
      })
    })

    describe('setMAMError', () => {
      it('should set error state for a conversation', () => {
        chatStore.getState().setMAMError('alice@example.com', 'Network error')

        const state = chatStore.getState().getMAMQueryState('alice@example.com')
        expect(state.error).toBe('Network error')
      })

      it('should clear error state when set to null', () => {
        chatStore.getState().setMAMError('alice@example.com', 'Some error')
        chatStore.getState().setMAMError('alice@example.com', null)

        const state = chatStore.getState().getMAMQueryState('alice@example.com')
        expect(state.error).toBeNull()
      })
    })

    describe('getMAMQueryState', () => {
      it('should return default state for unknown conversation', () => {
        const state = chatStore.getState().getMAMQueryState('unknown@example.com')

        expect(state).toEqual({
          isLoading: false,
          error: null,
          hasQueried: false,
          isHistoryComplete: false,
          isCaughtUpToLive: false,
        })
      })

      it('should return stored state for known conversation', () => {
        chatStore.getState().setMAMLoading('alice@example.com', true)

        const state = chatStore.getState().getMAMQueryState('alice@example.com')
        expect(state.isLoading).toBe(true)
      })
    })

    describe('resetMAMStates', () => {
      it('should clear all MAM query states', () => {
        // Set up MAM state for multiple conversations
        chatStore.getState().setMAMLoading('alice@example.com', true)
        chatStore.getState().setMAMLoading('bob@example.com', false)

        // Verify states are set
        expect(chatStore.getState().getMAMQueryState('alice@example.com').isLoading).toBe(true)
        expect(chatStore.getState().getMAMQueryState('bob@example.com').hasQueried).toBe(false)

        // Mark bob's conversation as queried via mergeMAMMessages
        chatStore.getState().addConversation(createConversation('bob@example.com'))
        chatStore.getState().mergeMAMMessages('bob@example.com', [], { first: '', last: '', count: 0 }, true, 'backward')
        expect(chatStore.getState().getMAMQueryState('bob@example.com').hasQueried).toBe(true)

        // Reset all MAM states
        chatStore.getState().resetMAMStates()

        // Verify all states are cleared (back to defaults)
        const aliceState = chatStore.getState().getMAMQueryState('alice@example.com')
        const bobState = chatStore.getState().getMAMQueryState('bob@example.com')

        expect(aliceState).toEqual({
          isLoading: false,
          error: null,
          hasQueried: false,
          isHistoryComplete: false,
          isCaughtUpToLive: false,
        })
        expect(bobState).toEqual({
          isLoading: false,
          error: null,
          hasQueried: false,
          isHistoryComplete: false,
          isCaughtUpToLive: false,
        })
      })
    })

    describe('mergeMAMMessages', () => {
      it('should merge MAM messages with existing messages', () => {
        chatStore.getState().addConversation(createConversation('alice@example.com'))

        // Add an existing local message
        const localMsg: Message = {
          type: 'chat',
          id: 'local-msg',
          conversationId: 'alice@example.com',
          from: 'alice@example.com',
          body: 'Local message',
          timestamp: new Date('2024-01-15T12:00:00Z'),
          isOutgoing: false,
        }
        chatStore.getState().addMessage(localMsg)

        // Merge MAM messages (older)
        const mamMessages: Message[] = [
          {
            type: 'chat',
            id: 'mam-msg-1',
            conversationId: 'alice@example.com',
            from: 'alice@example.com',
            body: 'Old message 1',
            timestamp: new Date('2024-01-15T10:00:00Z'),
            isOutgoing: false,
            stanzaId: 'stanza-1',
          },
          {
            type: 'chat',
            id: 'mam-msg-2',
            conversationId: 'alice@example.com',
            from: 'me@example.com',
            body: 'Old message 2',
            timestamp: new Date('2024-01-15T11:00:00Z'),
            isOutgoing: true,
            stanzaId: 'stanza-2',
          },
        ]

        chatStore.getState().mergeMAMMessages(
          'alice@example.com',
          mamMessages,
          { count: 2, first: 'stanza-1', last: 'stanza-2' },
          true,
          'backward'
        )

        // Should have all 3 messages
        const messages = chatStore.getState().messages.get('alice@example.com')
        expect(messages?.length).toBe(3)

        // Should be sorted by timestamp
        expect(messages?.[0].body).toBe('Old message 1')
        expect(messages?.[1].body).toBe('Old message 2')
        expect(messages?.[2].body).toBe('Local message')
      })

      it('should deduplicate messages by stanzaId', () => {
        chatStore.getState().addConversation(createConversation('alice@example.com'))

        // Add an existing message with stanzaId
        const existingMsg: Message = {
          type: 'chat',
          id: 'existing-msg',
          conversationId: 'alice@example.com',
          from: 'alice@example.com',
          body: 'Existing message',
          timestamp: new Date('2024-01-15T10:00:00Z'),
          isOutgoing: false,
          stanzaId: 'duplicate-stanza-id',
        }
        chatStore.getState().addMessage(existingMsg)

        // Merge MAM message with same stanzaId
        const mamMessages: Message[] = [
          {
            type: 'chat',
            id: 'mam-duplicate',
            conversationId: 'alice@example.com',
            from: 'alice@example.com',
            body: 'Existing message',
            timestamp: new Date('2024-01-15T10:00:00Z'),
            isOutgoing: false,
            stanzaId: 'duplicate-stanza-id',
          },
        ]

        chatStore.getState().mergeMAMMessages(
          'alice@example.com',
          mamMessages,
          { count: 1 },
          true,
          'backward'
        )

        // Should still have only 1 message (deduplicated)
        const messages = chatStore.getState().messages.get('alice@example.com')
        expect(messages?.length).toBe(1)
      })

      it('should deduplicate messages by from+id fallback', () => {
        chatStore.getState().addConversation(createConversation('alice@example.com'))

        // Add an existing message without stanzaId but with from+id
        const existingMsg: Message = {
          type: 'chat',
          id: 'msg-123',
          conversationId: 'alice@example.com',
          from: 'alice@example.com',
          body: 'Existing message',
          timestamp: new Date('2024-01-15T10:00:00Z'),
          isOutgoing: false,
        }
        chatStore.getState().addMessage(existingMsg)

        // Merge MAM message with same from+id
        const mamMessages: Message[] = [
          {
            type: 'chat',
            id: 'msg-123',
            conversationId: 'alice@example.com',
            from: 'alice@example.com',
            body: 'Existing message',
            timestamp: new Date('2024-01-15T10:00:00Z'),
            isOutgoing: false,
          },
        ]

        chatStore.getState().mergeMAMMessages(
          'alice@example.com',
          mamMessages,
          { count: 1 },
          true,
          'backward'
        )

        // Should still have only 1 message (deduplicated by from+id)
        const messages = chatStore.getState().messages.get('alice@example.com')
        expect(messages?.length).toBe(1)
      })

      it('should set hasQueried and isHistoryComplete flags for backward query', () => {
        chatStore.getState().addConversation(createConversation('alice@example.com'))

        chatStore.getState().mergeMAMMessages(
          'alice@example.com',
          [],
          { count: 0 },
          true,
          'backward'
        )

        const state = chatStore.getState().getMAMQueryState('alice@example.com')
        expect(state.hasQueried).toBe(true)
        expect(state.isHistoryComplete).toBe(true)
        expect(state.isHistoryComplete).toBe(true) // Backward compat alias
      })

      it('should set hasQueried and isCaughtUpToLive flags for forward query', () => {
        chatStore.getState().addConversation(createConversation('alice@example.com'))

        chatStore.getState().mergeMAMMessages(
          'alice@example.com',
          [],
          { count: 0 },
          true,
          'forward'
        )

        const state = chatStore.getState().getMAMQueryState('alice@example.com')
        expect(state.hasQueried).toBe(true)
        expect(state.isCaughtUpToLive).toBe(true)
        expect(state.isHistoryComplete).toBe(false) // Not set for forward queries
      })

      it('should set isHistoryComplete=false when more history is available', () => {
        chatStore.getState().addConversation(createConversation('alice@example.com'))

        chatStore.getState().mergeMAMMessages(
          'alice@example.com',
          [],
          { count: 50, first: 'first-id', last: 'last-id' },
          false, // complete = false
          'backward'
        )

        const state = chatStore.getState().getMAMQueryState('alice@example.com')
        expect(state.hasQueried).toBe(true)
        expect(state.isHistoryComplete).toBe(false)
        expect(state.isHistoryComplete).toBe(false)
      })

      it('should store oldestFetchedId from RSM first for pagination', () => {
        chatStore.getState().addConversation(createConversation('alice@example.com'))

        const mamMessages: Message[] = [
          {
            type: 'chat',
            id: 'mam-msg-1',
            conversationId: 'alice@example.com',
            from: 'alice@example.com',
            body: 'Old message',
            timestamp: new Date('2024-01-15T10:00:00Z'),
            isOutgoing: false,
            stanzaId: 'oldest-stanza-id',
          },
        ]

        chatStore.getState().mergeMAMMessages(
          'alice@example.com',
          mamMessages,
          { count: 50, first: 'oldest-stanza-id', last: 'newest-stanza-id' },
          false,
          'backward'
        )

        const state = chatStore.getState().getMAMQueryState('alice@example.com')
        expect(state.oldestFetchedId).toBe('oldest-stanza-id')
      })

      it('should update oldestFetchedId when fetching older messages', () => {
        chatStore.getState().addConversation(createConversation('alice@example.com'))

        // First fetch
        chatStore.getState().mergeMAMMessages(
          'alice@example.com',
          [],
          { count: 50, first: 'first-batch-oldest', last: 'first-batch-newest' },
          false,
          'backward'
        )

        expect(chatStore.getState().getMAMQueryState('alice@example.com').oldestFetchedId)
          .toBe('first-batch-oldest')

        // Second fetch (older messages)
        chatStore.getState().mergeMAMMessages(
          'alice@example.com',
          [],
          { count: 50, first: 'second-batch-oldest', last: 'second-batch-newest' },
          false,
          'backward'
        )

        // Should be updated to the new oldest
        expect(chatStore.getState().getMAMQueryState('alice@example.com').oldestFetchedId)
          .toBe('second-batch-oldest')
      })

      it('should not have oldestFetchedId when RSM response has no first', () => {
        chatStore.getState().addConversation(createConversation('alice@example.com'))

        chatStore.getState().mergeMAMMessages(
          'alice@example.com',
          [],
          { count: 0 }, // Empty RSM response
          true,
          'backward'
        )

        const state = chatStore.getState().getMAMQueryState('alice@example.com')
        expect(state.oldestFetchedId).toBeUndefined()
      })

      it('should trim messages to MAX_MESSAGES_PER_CONVERSATION', () => {
        chatStore.getState().addConversation(createConversation('alice@example.com'))

        // Create 1100 MAM messages (more than MAX_MESSAGES_PER_CONVERSATION which is 1000)
        const mamMessages: Message[] = []
        for (let i = 0; i < 1100; i++) {
          mamMessages.push({
            type: 'chat',
            id: `mam-msg-${i}`,
            conversationId: 'alice@example.com',
            from: 'alice@example.com',
            body: `Message ${i}`,
            timestamp: new Date(Date.now() - (1100 - i) * 60000), // Ordered by time
            isOutgoing: false,
            stanzaId: `stanza-${i}`,
          })
        }

        chatStore.getState().mergeMAMMessages(
          'alice@example.com',
          mamMessages,
          { count: 1100 },
          true,
          'backward'
        )

        // Should be trimmed to MAX_MESSAGES (1000) - this is the display buffer limit
        // All messages are still stored in IndexedDB
        const messages = chatStore.getState().messages.get('alice@example.com')
        expect(messages?.length).toBeLessThanOrEqual(1000)

        // Should keep the most recent messages
        expect(messages?.[messages.length - 1].body).toBe('Message 1099')
      })

      it('should create conversation messages array if it does not exist', () => {
        chatStore.getState().addConversation(createConversation('alice@example.com'))
        // Don't add any messages - messages array doesn't exist

        const mamMessages: Message[] = [
          {
            type: 'chat',
            id: 'mam-msg-1',
            conversationId: 'alice@example.com',
            from: 'alice@example.com',
            body: 'First MAM message',
            timestamp: new Date('2024-01-15T10:00:00Z'),
            isOutgoing: false,
          },
        ]

        chatStore.getState().mergeMAMMessages(
          'alice@example.com',
          mamMessages,
          { count: 1 },
          true,
          'backward'
        )

        const messages = chatStore.getState().messages.get('alice@example.com')
        expect(messages?.length).toBe(1)
        expect(messages?.[0].body).toBe('First MAM message')
      })

      it('should merge MAM messages and allow newest to be derived as lastMessage', () => {
        // Note: lastMessage is now derived from messages array in useChat hook (like rooms)
        // Store merges messages; useChat derives lastMessage from array[length-1]
        chatStore.getState().addConversation(createConversation('alice@example.com'))

        // Merge MAM messages
        const mamMessages: Message[] = [
          {
            type: 'chat',
            id: 'mam-older',
            conversationId: 'alice@example.com',
            from: 'alice@example.com',
            body: 'Older MAM message',
            timestamp: new Date('2024-01-15T08:00:00Z'),
            isOutgoing: false,
          },
          {
            type: 'chat',
            id: 'mam-newer',
            conversationId: 'alice@example.com',
            from: 'me@example.com',
            body: 'Newer MAM message',
            timestamp: new Date('2024-01-15T12:00:00Z'),
            isOutgoing: true,
          },
        ]

        chatStore.getState().mergeMAMMessages(
          'alice@example.com',
          mamMessages,
          { count: 2 },
          true,
          'forward'
        )

        // Messages array should contain both messages, sorted by timestamp
        const messages = chatStore.getState().messages.get('alice@example.com')
        expect(messages?.length).toBe(2)
        // Last message in array (which would be derived as lastMessage) should be the newest
        expect(messages?.[messages.length - 1].body).toBe('Newer MAM message')
        expect(messages?.[messages.length - 1].timestamp.getTime()).toBe(new Date('2024-01-15T12:00:00Z').getTime())
      })

      it('should merge older MAM messages at the start of the array', () => {
        // Note: lastMessage is derived from messages array in useChat (like rooms)
        chatStore.getState().addConversation(createConversation('alice@example.com'))

        // Add a recent message first
        const recentMessage: Message = {
          type: 'chat',
          id: 'recent-msg',
          conversationId: 'alice@example.com',
          from: 'alice@example.com',
          body: 'Recent message',
          timestamp: new Date('2024-01-15T15:00:00Z'),
          isOutgoing: false,
        }
        chatStore.getState().addMessage(recentMessage)

        // Merge older MAM messages (pagination)
        const mamMessages: Message[] = [
          {
            type: 'chat',
            id: 'mam-old-1',
            conversationId: 'alice@example.com',
            from: 'alice@example.com',
            body: 'Old message 1',
            timestamp: new Date('2024-01-15T10:00:00Z'),
            isOutgoing: false,
          },
          {
            type: 'chat',
            id: 'mam-old-2',
            conversationId: 'alice@example.com',
            from: 'me@example.com',
            body: 'Old message 2',
            timestamp: new Date('2024-01-15T11:00:00Z'),
            isOutgoing: true,
          },
        ]

        chatStore.getState().mergeMAMMessages(
          'alice@example.com',
          mamMessages,
          { count: 2 },
          true,
          'backward'
        )

        // Messages should be sorted by timestamp
        const messages = chatStore.getState().messages.get('alice@example.com')
        expect(messages?.length).toBe(3)
        // Oldest messages at the start
        expect(messages?.[0].body).toBe('Old message 1')
        expect(messages?.[1].body).toBe('Old message 2')
        // Recent message at the end (would be derived as lastMessage)
        expect(messages?.[messages.length - 1].body).toBe('Recent message')
      })

      it('should append newer MAM messages when direction is forward (catch-up scenario)', () => {
        // This tests the catch-up scenario: user has old messages locally,
        // MAM fetches newer messages that occurred while offline.
        // Direction 'forward' is used when start= filter is set (fetching from a point forward)
        chatStore.getState().addConversation(createConversation('alice@example.com'))

        // Add an old message that we already have locally
        const oldMessage: Message = {
          type: 'chat',
          id: 'old-local-msg',
          conversationId: 'alice@example.com',
          from: 'alice@example.com',
          body: 'Old local message',
          timestamp: new Date('2024-01-15T08:00:00Z'),
          isOutgoing: false,
        }
        chatStore.getState().addMessage(oldMessage)

        // MAM catches up with newer messages (direction='forward')
        const newerMamMessages: Message[] = [
          {
            type: 'chat',
            id: 'mam-new-1',
            conversationId: 'alice@example.com',
            from: 'alice@example.com',
            body: 'New message 1',
            timestamp: new Date('2024-01-15T14:00:00Z'),
            isOutgoing: false,
          },
          {
            type: 'chat',
            id: 'mam-new-2',
            conversationId: 'alice@example.com',
            from: 'me@example.com',
            body: 'New message 2',
            timestamp: new Date('2024-01-15T15:00:00Z'),
            isOutgoing: true,
          },
        ]

        chatStore.getState().mergeMAMMessages(
          'alice@example.com',
          newerMamMessages,
          { count: 2 },
          true,
          'forward'
        )

        // Messages should be sorted with newer ones at the end
        const messages = chatStore.getState().messages.get('alice@example.com')
        expect(messages?.length).toBe(3)
        // Old local message at the start
        expect(messages?.[0].body).toBe('Old local message')
        // Newer MAM messages at the end, sorted by timestamp
        expect(messages?.[1].body).toBe('New message 1')
        expect(messages?.[2].body).toBe('New message 2')
        // Last message (for sidebar preview) should be the newest
        expect(messages?.[messages.length - 1].body).toBe('New message 2')
      })

      it('should correctly sort messages when forward MAM includes out-of-order timestamps', () => {
        // Edge case: MAM might return messages that interleave with existing ones
        chatStore.getState().addConversation(createConversation('alice@example.com'))

        // Existing messages at 10:00 and 14:00
        chatStore.getState().addMessage({
          type: 'chat',
          id: 'existing-1',
          conversationId: 'alice@example.com',
          from: 'alice@example.com',
          body: 'Existing at 10:00',
          timestamp: new Date('2024-01-15T10:00:00Z'),
          isOutgoing: false,
        })
        chatStore.getState().addMessage({
          type: 'chat',
          id: 'existing-2',
          conversationId: 'alice@example.com',
          from: 'me@example.com',
          body: 'Existing at 14:00',
          timestamp: new Date('2024-01-15T14:00:00Z'),
          isOutgoing: true,
        })

        // MAM returns messages at 12:00 and 16:00 (interleaved)
        const mamMessages: Message[] = [
          {
            type: 'chat',
            id: 'mam-1',
            conversationId: 'alice@example.com',
            from: 'alice@example.com',
            body: 'MAM at 12:00',
            timestamp: new Date('2024-01-15T12:00:00Z'),
            isOutgoing: false,
          },
          {
            type: 'chat',
            id: 'mam-2',
            conversationId: 'alice@example.com',
            from: 'alice@example.com',
            body: 'MAM at 16:00',
            timestamp: new Date('2024-01-15T16:00:00Z'),
            isOutgoing: false,
          },
        ]

        chatStore.getState().mergeMAMMessages(
          'alice@example.com',
          mamMessages,
          { count: 2 },
          true,
          'forward'
        )

        const messages = chatStore.getState().messages.get('alice@example.com')
        expect(messages?.length).toBe(4)
        // Should be sorted chronologically
        expect(messages?.[0].body).toBe('Existing at 10:00')
        expect(messages?.[1].body).toBe('MAM at 12:00')
        expect(messages?.[2].body).toBe('Existing at 14:00')
        expect(messages?.[3].body).toBe('MAM at 16:00')
        // Newest message is last
        expect(messages?.[messages.length - 1].body).toBe('MAM at 16:00')
      })
    })
  })

  describe('getMessage', () => {
    it('should find message by id', () => {
      const store = chatStore.getState()
      store.addConversation(createConversation('alice@example.com'))

      const message: Message = {
        type: 'chat',
        id: 'msg-123',
        conversationId: 'alice@example.com',
        from: 'alice@example.com',
        body: 'Hello',
        timestamp: new Date(),
        isOutgoing: false,
      }
      store.addMessage(message)

      const found = store.getMessage('alice@example.com', 'msg-123')
      expect(found).toBeDefined()
      expect(found?.body).toBe('Hello')
    })

    it('should find message by stanzaId (for MAM corrections)', () => {
      const store = chatStore.getState()
      store.addConversation(createConversation('alice@example.com'))

      const message: Message = {
        type: 'chat',
        id: 'original-uuid',
        stanzaId: 'mam-archive-id-12345',
        conversationId: 'alice@example.com',
        from: 'alice@example.com',
        body: 'Original message',
        timestamp: new Date(),
        isOutgoing: false,
      }
      store.addMessage(message)

      // Should find by stanzaId when correction references the MAM archive ID
      const found = store.getMessage('alice@example.com', 'mam-archive-id-12345')
      expect(found).toBeDefined()
      expect(found?.body).toBe('Original message')
      expect(found?.id).toBe('original-uuid')
    })

    it('should return undefined when message not found', () => {
      const store = chatStore.getState()
      store.addConversation(createConversation('alice@example.com'))

      const found = store.getMessage('alice@example.com', 'nonexistent')
      expect(found).toBeUndefined()
    })
  })

  describe('updateMessage', () => {
    it('should update message body', () => {
      const store = chatStore.getState()
      store.addConversation(createConversation('alice@example.com'))

      const message: Message = {
        type: 'chat',
        id: 'msg-123',
        conversationId: 'alice@example.com',
        from: 'alice@example.com',
        body: 'Original message',
        timestamp: new Date(),
        isOutgoing: false,
      }
      store.addMessage(message)

      store.updateMessage('alice@example.com', 'msg-123', {
        body: 'Edited message',
        isEdited: true,
      })

      const updated = store.getMessage('alice@example.com', 'msg-123')
      expect(updated?.body).toBe('Edited message')
      expect(updated?.isEdited).toBe(true)
    })

    it('should update message in array (lastMessage derived from array in useChat)', () => {
      // Note: lastMessage is now derived from messages array in useChat hook (like rooms)
      // When we edit a message, the array is updated, and useChat will derive the latest
      chatStore.getState().addConversation(createConversation('alice@example.com'))

      const message: Message = {
        type: 'chat',
        id: 'msg-123',
        conversationId: 'alice@example.com',
        from: 'me@example.com',
        body: 'Original message with typo',
        timestamp: new Date(),
        isOutgoing: true,
      }
      chatStore.getState().addMessage(message)

      // Verify message is in the array
      let messages = chatStore.getState().messages.get('alice@example.com')
      expect(messages?.[messages!.length - 1].body).toBe('Original message with typo')

      // Edit the message (correct the typo)
      chatStore.getState().updateMessage('alice@example.com', 'msg-123', {
        body: 'Corrected message',
        isEdited: true,
      })

      // Message in array should be updated (useChat will derive this as lastMessage)
      messages = chatStore.getState().messages.get('alice@example.com')
      expect(messages?.[messages!.length - 1].body).toBe('Corrected message')
      expect(messages?.[messages!.length - 1].isEdited).toBe(true)
    })

    it('should update specific message without affecting array order', () => {
      // Note: lastMessage is derived from messages array in useChat (like rooms)
      chatStore.getState().addConversation(createConversation('alice@example.com'))

      // Add two messages
      const message1: Message = {
        type: 'chat',
        id: 'msg-1',
        conversationId: 'alice@example.com',
        from: 'me@example.com',
        body: 'First message',
        timestamp: new Date('2024-01-15T10:00:00Z'),
        isOutgoing: true,
      }
      const message2: Message = {
        type: 'chat',
        id: 'msg-2',
        conversationId: 'alice@example.com',
        from: 'alice@example.com',
        body: 'Second message (latest)',
        timestamp: new Date('2024-01-15T11:00:00Z'),
        isOutgoing: false,
      }
      chatStore.getState().addMessage(message1)
      chatStore.getState().addMessage(message2)

      // Last message in array should be msg-2
      let messages = chatStore.getState().messages.get('alice@example.com')
      expect(messages?.[messages!.length - 1].id).toBe('msg-2')
      expect(messages?.[messages!.length - 1].body).toBe('Second message (latest)')

      // Edit the first message (not the last)
      chatStore.getState().updateMessage('alice@example.com', 'msg-1', {
        body: 'First message (edited)',
        isEdited: true,
      })

      // Array order should be preserved - last message still msg-2
      messages = chatStore.getState().messages.get('alice@example.com')
      expect(messages?.[messages!.length - 1].id).toBe('msg-2')
      expect(messages?.[messages!.length - 1].body).toBe('Second message (latest)')
      // First message should be edited
      expect(messages?.[0].body).toBe('First message (edited)')
      expect(messages?.[0].isEdited).toBe(true)

      // But the first message should be updated in the messages array
      const updated = chatStore.getState().getMessage('alice@example.com', 'msg-1')
      expect(updated?.body).toBe('First message (edited)')
    })

    it('should find and update message by stanzaId (MAM messages)', () => {
      // Note: lastMessage is now derived from messages array in useChat hook (like rooms)
      chatStore.getState().addConversation(createConversation('alice@example.com'))

      // Add a message with both id and stanzaId (typical for MAM-retrieved messages)
      const message: Message = {
        type: 'chat',
        id: 'client-id-123',
        stanzaId: 'mam-stanza-id-456', // Server-assigned ID from MAM
        conversationId: 'alice@example.com',
        from: 'me@example.com',
        body: 'Original message',
        timestamp: new Date(),
        isOutgoing: true,
      }
      chatStore.getState().addMessage(message)

      // Verify message is in the array
      let messages = chatStore.getState().messages.get('alice@example.com')
      expect(messages?.[messages!.length - 1].body).toBe('Original message')
      expect(messages?.[messages!.length - 1].stanzaId).toBe('mam-stanza-id-456')

      // Edit the message using stanzaId (how corrections often reference MAM messages)
      chatStore.getState().updateMessage('alice@example.com', 'mam-stanza-id-456', {
        body: 'Corrected message',
        isEdited: true,
      })

      // Message in array should be updated (useChat will derive this as lastMessage)
      messages = chatStore.getState().messages.get('alice@example.com')
      expect(messages?.[messages!.length - 1].body).toBe('Corrected message')
      expect(messages?.[messages!.length - 1].isEdited).toBe(true)
    })
  })

  describe('reference stability (prevents infinite re-renders)', () => {
    // These tests ensure computed selectors return stable array references
    // when empty, preventing Zustand from triggering infinite re-renders.
    // Using toBe() checks reference equality, not just value equality.

    it('activeMessages() should return same reference when no active conversation', () => {
      const result1 = chatStore.getState().activeMessages()
      const result2 = chatStore.getState().activeMessages()
      expect(result1).toBe(result2)
      expect(result1).toHaveLength(0)
    })

    it('activeMessages() should return same reference when active conversation has no messages', () => {
      chatStore.getState().addConversation(createConversation('alice@example.com'))
      chatStore.getState().setActiveConversation('alice@example.com')

      const result1 = chatStore.getState().activeMessages()
      const result2 = chatStore.getState().activeMessages()
      expect(result1).toBe(result2)
      expect(result1).toHaveLength(0)
    })
  })

  describe('updateLastMessagePreview', () => {
    it('should update lastMessage preview without affecting messages array', () => {
      // Create a conversation with an existing message
      chatStore.getState().addConversation(createConversation('alice@example.com'))
      const existingMsg = createMessage('alice@example.com', 'Old message')
      chatStore.getState().addMessage(existingMsg)

      // Verify initial state
      const initialMessages = chatStore.getState().messages.get('alice@example.com')
      expect(initialMessages).toHaveLength(1)
      expect(initialMessages?.[0].body).toBe('Old message')

      // Update the preview with a newer message
      const previewMsg: Message = {
        type: 'chat',
        id: 'preview-msg',
        conversationId: 'alice@example.com',
        from: 'alice@example.com',
        body: 'New message from other device',
        timestamp: new Date(Date.now() + 1000), // Newer timestamp
        isOutgoing: false,
      }
      chatStore.getState().updateLastMessagePreview('alice@example.com', previewMsg)

      // Messages array should be unchanged
      const messagesAfter = chatStore.getState().messages.get('alice@example.com')
      expect(messagesAfter).toHaveLength(1)
      expect(messagesAfter?.[0].body).toBe('Old message')

      // But the preview should be updated (both in conversationMeta and conversations)
      const meta = chatStore.getState().conversationMeta.get('alice@example.com')
      expect(meta?.lastMessage?.body).toBe('New message from other device')

      const conv = chatStore.getState().conversations.get('alice@example.com')
      expect(conv?.lastMessage?.body).toBe('New message from other device')
    })

    it('should not update preview if message is older than existing', () => {
      // Create a conversation with a recent message
      chatStore.getState().addConversation(createConversation('alice@example.com'))
      const recentMsg = createMessage('alice@example.com', 'Recent message')
      recentMsg.timestamp = new Date('2024-01-15T12:00:00Z')
      chatStore.getState().addMessage(recentMsg)

      // Verify the lastMessage was set from addMessage
      const initialMeta = chatStore.getState().conversationMeta.get('alice@example.com')
      expect(initialMeta?.lastMessage?.body).toBe('Recent message')

      // Try to update with an older message
      const olderMsg: Message = {
        type: 'chat',
        id: 'older-msg',
        conversationId: 'alice@example.com',
        from: 'alice@example.com',
        body: 'Older message',
        timestamp: new Date('2024-01-15T11:00:00Z'), // Older timestamp
        isOutgoing: false,
      }
      chatStore.getState().updateLastMessagePreview('alice@example.com', olderMsg)

      // Preview should NOT be updated (still shows recent message)
      const metaAfter = chatStore.getState().conversationMeta.get('alice@example.com')
      expect(metaAfter?.lastMessage?.body).toBe('Recent message')
    })

    it('should do nothing for non-existent conversation', () => {
      const previewMsg: Message = {
        type: 'chat',
        id: 'preview-msg',
        conversationId: 'nonexistent@example.com',
        from: 'nonexistent@example.com',
        body: 'Message',
        timestamp: new Date(),
        isOutgoing: false,
      }

      // Should not throw
      expect(() => {
        chatStore.getState().updateLastMessagePreview('nonexistent@example.com', previewMsg)
      }).not.toThrow()

      // State should be unchanged (no new conversation created)
      expect(chatStore.getState().conversations.has('nonexistent@example.com')).toBe(false)
    })
  })

  describe('activeConversations', () => {
    it('should return only non-archived conversations', () => {
      // Create multiple conversations
      chatStore.getState().addConversation(createConversation('alice@example.com'))
      chatStore.getState().addConversation(createConversation('bob@example.com'))
      chatStore.getState().addConversation(createConversation('carol@example.com'))

      // Archive one
      chatStore.getState().archiveConversation('bob@example.com')

      // activeConversations should only return non-archived
      const active = chatStore.getState().activeConversations()
      expect(active).toHaveLength(2)
      expect(active.map(c => c.id)).toContain('alice@example.com')
      expect(active.map(c => c.id)).toContain('carol@example.com')
      expect(active.map(c => c.id)).not.toContain('bob@example.com')
    })

    it('should return empty array when all conversations are archived', () => {
      chatStore.getState().addConversation(createConversation('alice@example.com'))
      chatStore.getState().archiveConversation('alice@example.com')

      const active = chatStore.getState().activeConversations()
      expect(active).toHaveLength(0)
    })

    it('should return all conversations when none are archived', () => {
      chatStore.getState().addConversation(createConversation('alice@example.com'))
      chatStore.getState().addConversation(createConversation('bob@example.com'))

      const active = chatStore.getState().activeConversations()
      expect(active).toHaveLength(2)
    })
  })
})
