import { describe, it, expect } from 'vitest'
import { chatSelectors } from './chatSelectors'
import type { ChatState } from './chatStore'
import type { Message, Conversation, ConversationEntity, ConversationMetadata, MAMQueryState } from '../core/types'

/**
 * Create a minimal ChatState mock for testing selectors.
 */
function createMockState(overrides: Partial<ChatState> = {}): ChatState {
  return {
    conversations: new Map(),
    conversationEntities: new Map(),
    conversationMeta: new Map(),
    messages: new Map(),
    activeConversationId: null,
    archivedConversations: new Set(),
    typingStates: new Map(),
    activeAnimation: null,
    drafts: new Map(),
    mamQueryStates: new Map(),
    // Actions are not needed for selector tests
    activeConversation: () => null,
    activeMessages: () => [],
    isArchived: () => false,
    setActiveConversation: () => {},
    addConversation: () => {},
    updateConversationName: () => {},
    deleteConversation: () => {},
    addMessage: () => {},
    markAsRead: () => {},
    clearFirstNewMessageId: () => {},
    hasConversation: () => false,
    archiveConversation: () => {},
    unarchiveConversation: () => {},
    setTyping: () => {},
    clearAllTyping: () => {},
    updateReactions: () => {},
    updateMessage: () => {},
    getMessage: () => undefined,
    triggerAnimation: () => {},
    clearAnimation: () => {},
    setDraft: () => {},
    getDraft: () => '',
    clearDraft: () => {},
    setMAMLoading: () => {},
    setMAMError: () => {},
    mergeMAMMessages: () => {},
    getMAMQueryState: () => ({ isLoading: false, hasQueried: false, error: null, isHistoryComplete: false, isCaughtUpToLive: false }),
    resetMAMStates: () => {},
    loadMessagesFromCache: async () => [],
    loadOlderMessagesFromCache: async () => [],
    activeConversations: () => [],
    reset: () => {},
    ...overrides,
  } as ChatState
}

function createMockConversation(id: string, overrides: Partial<Conversation> = {}): Conversation {
  return {
    id,
    name: `Contact ${id}`,
    type: 'chat',
    unreadCount: 0,
    ...overrides,
  }
}

function createMockMessage(id: string, conversationId: string, overrides: Partial<Message> = {}): Message {
  return {
    type: 'chat',
    id,
    conversationId,
    from: 'sender@example.com',
    body: `Message ${id}`,
    timestamp: new Date(),
    isOutgoing: false,
    ...overrides,
  }
}

describe('chatSelectors', () => {
  describe('conversationIds', () => {
    it('should return empty array when no conversations', () => {
      const state = createMockState()
      const result = chatSelectors.conversationIds(state)
      expect(result).toEqual([])
    })

    it('should return conversation IDs sorted by last message timestamp', () => {
      const conversations = new Map<string, Conversation>([
        ['user1@example.com', createMockConversation('user1@example.com', {
          lastMessage: createMockMessage('1', 'user1@example.com', { timestamp: new Date('2024-01-01') }),
        })],
        ['user2@example.com', createMockConversation('user2@example.com', {
          lastMessage: createMockMessage('2', 'user2@example.com', { timestamp: new Date('2024-01-03') }),
        })],
        ['user3@example.com', createMockConversation('user3@example.com', {
          lastMessage: createMockMessage('3', 'user3@example.com', { timestamp: new Date('2024-01-02') }),
        })],
      ])
      const state = createMockState({ conversations })
      const result = chatSelectors.conversationIds(state)
      // Most recent first
      expect(result).toEqual(['user2@example.com', 'user3@example.com', 'user1@example.com'])
    })

    it('should return stable empty array reference', () => {
      const state = createMockState()
      const result1 = chatSelectors.conversationIds(state)
      const result2 = chatSelectors.conversationIds(state)
      expect(result1).toBe(result2)
    })
  })

  describe('activeConversationIds', () => {
    it('should exclude archived conversations', () => {
      const conversations = new Map<string, Conversation>([
        ['user1@example.com', createMockConversation('user1@example.com')],
        ['user2@example.com', createMockConversation('user2@example.com')],
      ])
      const archivedConversations = new Set(['user1@example.com'])
      const state = createMockState({ conversations, archivedConversations })
      const result = chatSelectors.activeConversationIds(state)
      expect(result).toEqual(['user2@example.com'])
    })
  })

  describe('archivedConversationIds', () => {
    it('should return archived conversation IDs', () => {
      const archivedConversations = new Set(['user1@example.com', 'user2@example.com'])
      const state = createMockState({ archivedConversations })
      const result = chatSelectors.archivedConversationIds(state)
      expect(result).toContain('user1@example.com')
      expect(result).toContain('user2@example.com')
    })
  })

  describe('conversationById', () => {
    it('should return conversation for given ID', () => {
      const conv = createMockConversation('user@example.com')
      const conversations = new Map([['user@example.com', conv]])
      const state = createMockState({ conversations })
      const result = chatSelectors.conversationById('user@example.com')(state)
      expect(result).toBe(conv)
    })

    it('should return undefined for unknown ID', () => {
      const state = createMockState()
      const result = chatSelectors.conversationById('unknown@example.com')(state)
      expect(result).toBeUndefined()
    })
  })

  describe('messagesForConversation', () => {
    it('should return messages for given conversation', () => {
      const messages = [createMockMessage('1', 'user@example.com')]
      const messagesMap = new Map([['user@example.com', messages]])
      const state = createMockState({ messages: messagesMap })
      const result = chatSelectors.messagesForConversation('user@example.com')(state)
      expect(result).toBe(messages)
    })

    it('should return empty array for unknown conversation', () => {
      const state = createMockState()
      const result = chatSelectors.messagesForConversation('unknown@example.com')(state)
      expect(result).toEqual([])
    })
  })

  describe('activeConversationId', () => {
    it('should return null when no active conversation', () => {
      const state = createMockState()
      expect(chatSelectors.activeConversationId(state)).toBeNull()
    })

    it('should return active conversation ID', () => {
      const state = createMockState({ activeConversationId: 'user@example.com' })
      expect(chatSelectors.activeConversationId(state)).toBe('user@example.com')
    })
  })

  describe('totalUnreadCount', () => {
    it('should return 0 when no conversations', () => {
      const state = createMockState()
      expect(chatSelectors.totalUnreadCount(state)).toBe(0)
    })

    it('should sum unread counts across conversations', () => {
      const conversationMeta = new Map<string, ConversationMetadata>([
        ['user1@example.com', { unreadCount: 3 }],
        ['user2@example.com', { unreadCount: 5 }],
      ])
      const state = createMockState({ conversationMeta })
      expect(chatSelectors.totalUnreadCount(state)).toBe(8)
    })
  })

  describe('unreadCountFor', () => {
    it('should return unread count for specific conversation', () => {
      const conversations = new Map([
        ['user@example.com', createMockConversation('user@example.com', { unreadCount: 7 })],
      ])
      const state = createMockState({ conversations })
      expect(chatSelectors.unreadCountFor('user@example.com')(state)).toBe(7)
    })

    it('should return 0 for unknown conversation', () => {
      const state = createMockState()
      expect(chatSelectors.unreadCountFor('unknown@example.com')(state)).toBe(0)
    })
  })

  describe('isArchived', () => {
    it('should return true for archived conversation', () => {
      const archivedConversations = new Set(['user@example.com'])
      const state = createMockState({ archivedConversations })
      expect(chatSelectors.isArchived('user@example.com')(state)).toBe(true)
    })

    it('should return false for non-archived conversation', () => {
      const state = createMockState()
      expect(chatSelectors.isArchived('user@example.com')(state)).toBe(false)
    })
  })

  describe('typingFor', () => {
    it('should return typing JIDs for conversation', () => {
      const typingSet = new Set(['user1@example.com', 'user2@example.com'])
      const typingStates = new Map([['conv@example.com', typingSet]])
      const state = createMockState({ typingStates })
      const result = chatSelectors.typingFor('conv@example.com')(state)
      expect(result).toBe(typingSet)
    })

    it('should return empty set for no typing', () => {
      const state = createMockState()
      const result = chatSelectors.typingFor('conv@example.com')(state)
      expect(result.size).toBe(0)
    })
  })

  describe('draftFor', () => {
    it('should return draft for conversation', () => {
      const drafts = new Map([['user@example.com', 'Hello draft']])
      const state = createMockState({ drafts })
      expect(chatSelectors.draftFor('user@example.com')(state)).toBe('Hello draft')
    })

    it('should return empty string for no draft', () => {
      const state = createMockState()
      expect(chatSelectors.draftFor('user@example.com')(state)).toBe('')
    })
  })

  describe('hasDraft', () => {
    it('should return true when draft exists', () => {
      const drafts = new Map([['user@example.com', 'Hello']])
      const state = createMockState({ drafts })
      expect(chatSelectors.hasDraft('user@example.com')(state)).toBe(true)
    })

    it('should return false when no draft', () => {
      const state = createMockState()
      expect(chatSelectors.hasDraft('user@example.com')(state)).toBe(false)
    })

    it('should return false for empty draft', () => {
      const drafts = new Map([['user@example.com', '']])
      const state = createMockState({ drafts })
      expect(chatSelectors.hasDraft('user@example.com')(state)).toBe(false)
    })
  })

  describe('mamStateFor', () => {
    it('should return MAM state for conversation', () => {
      const mamState: MAMQueryState = {
        isLoading: true,
        hasQueried: false,
        error: null,
        isHistoryComplete: false,
        isCaughtUpToLive: false,
      }
      const mamQueryStates = new Map([['user@example.com', mamState]])
      const state = createMockState({ mamQueryStates })
      expect(chatSelectors.mamStateFor('user@example.com')(state)).toBe(mamState)
    })
  })

  describe('isMAMLoading', () => {
    it('should return true when loading', () => {
      const mamQueryStates = new Map<string, MAMQueryState>([['user@example.com', {
        isLoading: true,
        hasQueried: false,
        error: null,
        isHistoryComplete: false,
        isCaughtUpToLive: false,
      }]])
      const state = createMockState({ mamQueryStates })
      expect(chatSelectors.isMAMLoading('user@example.com')(state)).toBe(true)
    })

    it('should return false when not loading', () => {
      const state = createMockState()
      expect(chatSelectors.isMAMLoading('user@example.com')(state)).toBe(false)
    })
  })

  describe('conversationCount', () => {
    it('should return conversation count', () => {
      const conversations = new Map<string, Conversation>([
        ['user1@example.com', createMockConversation('user1@example.com')],
        ['user2@example.com', createMockConversation('user2@example.com')],
      ])
      const state = createMockState({ conversations })
      expect(chatSelectors.conversationCount(state)).toBe(2)
    })
  })

  describe('conversationsWithUnreadCount', () => {
    it('should count conversations with unread messages', () => {
      const conversations = new Map<string, Conversation>([
        ['user1@example.com', createMockConversation('user1@example.com', { unreadCount: 3 })],
        ['user2@example.com', createMockConversation('user2@example.com', { unreadCount: 0 })],
        ['user3@example.com', createMockConversation('user3@example.com', { unreadCount: 1 })],
      ])
      const state = createMockState({ conversations })
      expect(chatSelectors.conversationsWithUnreadCount(state)).toBe(2)
    })
  })

  describe('hasConversation', () => {
    it('should return true for existing conversation', () => {
      const conversations = new Map([['user@example.com', createMockConversation('user@example.com')]])
      const state = createMockState({ conversations })
      expect(chatSelectors.hasConversation('user@example.com')(state)).toBe(true)
    })

    it('should return false for non-existing conversation', () => {
      const state = createMockState()
      expect(chatSelectors.hasConversation('user@example.com')(state)).toBe(false)
    })
  })

  describe('lastMessageFor', () => {
    it('should return last message for conversation', () => {
      const msg = createMockMessage('1', 'user@example.com')
      const conversations = new Map([
        ['user@example.com', createMockConversation('user@example.com', { lastMessage: msg })],
      ])
      const state = createMockState({ conversations })
      expect(chatSelectors.lastMessageFor('user@example.com')(state)).toBe(msg)
    })
  })

  describe('firstNewMessageIdFor', () => {
    it('should return firstNewMessageId for conversation', () => {
      const conversations = new Map([
        ['user@example.com', createMockConversation('user@example.com', { firstNewMessageId: 'msg-123' })],
      ])
      const state = createMockState({ conversations })
      expect(chatSelectors.firstNewMessageIdFor('user@example.com')(state)).toBe('msg-123')
    })
  })

  // ============================================================
  // METADATA SELECTORS TESTS (Phase 6)
  // ============================================================

  describe('entityById', () => {
    it('should return entity for existing conversation', () => {
      const entity: ConversationEntity = { id: 'user@example.com', name: 'User', type: 'chat' }
      const conversationEntities = new Map([['user@example.com', entity]])
      const state = createMockState({ conversationEntities })
      expect(chatSelectors.entityById('user@example.com')(state)).toEqual(entity)
    })

    it('should return undefined for non-existing conversation', () => {
      const state = createMockState()
      expect(chatSelectors.entityById('nonexistent@example.com')(state)).toBeUndefined()
    })
  })

  describe('metadataById', () => {
    it('should return metadata for existing conversation', () => {
      const meta: ConversationMetadata = { unreadCount: 5, lastMessage: undefined, lastReadAt: new Date() }
      const conversationMeta = new Map([['user@example.com', meta]])
      const state = createMockState({ conversationMeta })
      expect(chatSelectors.metadataById('user@example.com')(state)).toEqual(meta)
    })

    it('should return undefined for non-existing conversation', () => {
      const state = createMockState()
      expect(chatSelectors.metadataById('nonexistent@example.com')(state)).toBeUndefined()
    })
  })

  describe('allMetadata', () => {
    it('should return all conversation metadata', () => {
      const meta1: ConversationMetadata = { unreadCount: 3 }
      const meta2: ConversationMetadata = { unreadCount: 7 }
      const conversationMeta = new Map([
        ['user1@example.com', meta1],
        ['user2@example.com', meta2],
      ])
      const state = createMockState({ conversationMeta })
      const result = chatSelectors.allMetadata(state)
      expect(result.size).toBe(2)
      expect(result.get('user1@example.com')).toEqual(meta1)
      expect(result.get('user2@example.com')).toEqual(meta2)
    })
  })

  describe('allEntities', () => {
    it('should return all conversation entities', () => {
      const entity1: ConversationEntity = { id: 'user1@example.com', name: 'User 1', type: 'chat' }
      const entity2: ConversationEntity = { id: 'user2@example.com', name: 'User 2', type: 'chat' }
      const conversationEntities = new Map([
        ['user1@example.com', entity1],
        ['user2@example.com', entity2],
      ])
      const state = createMockState({ conversationEntities })
      const result = chatSelectors.allEntities(state)
      expect(result.size).toBe(2)
      expect(result.get('user1@example.com')).toEqual(entity1)
    })
  })

  describe('sidebarListItems', () => {
    it('should combine entity and metadata for sidebar display', () => {
      const entity: ConversationEntity = { id: 'user@example.com', name: 'User', type: 'chat' }
      const msg = createMockMessage('1', 'user@example.com')
      const meta: ConversationMetadata = { unreadCount: 3, lastMessage: msg }
      const conversationEntities = new Map([['user@example.com', entity]])
      const conversationMeta = new Map([['user@example.com', meta]])
      const state = createMockState({ conversationEntities, conversationMeta })

      const result = chatSelectors.sidebarListItems(state)
      expect(result).toHaveLength(1)
      expect(result[0]).toEqual({
        id: 'user@example.com',
        name: 'User',
        type: 'chat',
        unreadCount: 3,
        lastMessage: msg,
        isArchived: false,
        hasDraft: false,
      })
    })

    it('should sort by last message timestamp', () => {
      const entity1: ConversationEntity = { id: 'user1@example.com', name: 'User 1', type: 'chat' }
      const entity2: ConversationEntity = { id: 'user2@example.com', name: 'User 2', type: 'chat' }
      const msg1 = createMockMessage('1', 'user1@example.com', { timestamp: new Date('2024-01-01') })
      const msg2 = createMockMessage('2', 'user2@example.com', { timestamp: new Date('2024-01-02') })
      const meta1: ConversationMetadata = { unreadCount: 0, lastMessage: msg1 }
      const meta2: ConversationMetadata = { unreadCount: 0, lastMessage: msg2 }
      const conversationEntities = new Map([
        ['user1@example.com', entity1],
        ['user2@example.com', entity2],
      ])
      const conversationMeta = new Map([
        ['user1@example.com', meta1],
        ['user2@example.com', meta2],
      ])
      const state = createMockState({ conversationEntities, conversationMeta })

      const result = chatSelectors.sidebarListItems(state)
      expect(result[0].id).toBe('user2@example.com') // More recent
      expect(result[1].id).toBe('user1@example.com')
    })

    it('should include archive and draft status', () => {
      const entity: ConversationEntity = { id: 'user@example.com', name: 'User', type: 'chat' }
      const meta: ConversationMetadata = { unreadCount: 0 }
      const conversationEntities = new Map([['user@example.com', entity]])
      const conversationMeta = new Map([['user@example.com', meta]])
      const archivedConversations = new Set(['user@example.com'])
      const drafts = new Map([['user@example.com', 'Draft text']])
      const state = createMockState({ conversationEntities, conversationMeta, archivedConversations, drafts })

      const result = chatSelectors.sidebarListItems(state)
      expect(result[0].isArchived).toBe(true)
      expect(result[0].hasDraft).toBe(true)
    })
  })

  describe('activeSidebarListItems', () => {
    it('should exclude archived conversations', () => {
      const entity1: ConversationEntity = { id: 'user1@example.com', name: 'User 1', type: 'chat' }
      const entity2: ConversationEntity = { id: 'user2@example.com', name: 'User 2', type: 'chat' }
      const meta1: ConversationMetadata = { unreadCount: 0 }
      const meta2: ConversationMetadata = { unreadCount: 0 }
      const conversationEntities = new Map([
        ['user1@example.com', entity1],
        ['user2@example.com', entity2],
      ])
      const conversationMeta = new Map([
        ['user1@example.com', meta1],
        ['user2@example.com', meta2],
      ])
      const archivedConversations = new Set(['user1@example.com'])
      const state = createMockState({ conversationEntities, conversationMeta, archivedConversations })

      const result = chatSelectors.activeSidebarListItems(state)
      expect(result).toHaveLength(1)
      expect(result[0].id).toBe('user2@example.com')
    })
  })
})
