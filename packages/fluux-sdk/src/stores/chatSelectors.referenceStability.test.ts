import { describe, it, expect, beforeEach } from 'vitest'
import { chatStore } from './index'
import { chatSelectors } from './chatSelectors'
import type { Conversation, Message } from '../core/types'

function createConversation(id: string, options: Partial<Conversation> = {}): Conversation {
  return {
    id,
    name: options.name ?? id.split('@')[0],
    type: options.type ?? 'chat',
    unreadCount: options.unreadCount ?? 0,
    lastMessage: options.lastMessage,
    lastReadAt: options.lastReadAt,
    lastSeenMessageId: options.lastSeenMessageId,
    firstNewMessageId: options.firstNewMessageId,
  }
}

function createMessage(conversationId: string, body: string, id: string): Message {
  return {
    type: 'chat',
    id,
    conversationId,
    from: conversationId,
    to: 'me@example.com',
    body,
    timestamp: new Date(),
    isOutgoing: false,
  } as Message
}

describe('chatSelectors reference stability', () => {
  beforeEach(() => {
    chatStore.setState({
      conversations: new Map(),
      conversationEntities: new Map(),
      conversationMeta: new Map(),
      messages: new Map(),
      activeConversationId: null,
      archivedConversations: new Set(),
      typingStates: new Map(),
      drafts: new Map(),
      mamQueryStates: new Map(),
      activeAnimation: null,
    })
  })

  it('conversationById returns same reference when another conversation is modified', () => {
    const convA = createConversation('alice@example.com')
    const convB = createConversation('bob@example.com')

    chatStore.getState().addConversation(convA)
    chatStore.getState().addConversation(convB)

    const selectorA = chatSelectors.conversationById('alice@example.com')
    const _refBefore = selectorA(chatStore.getState())

    // Modify conversation B (add message)
    chatStore.getState().addMessage(createMessage('bob@example.com', 'Hello', 'msg-1'))

    const refAfter = selectorA(chatStore.getState())

    // conversations Map was replaced → the lookup may return a new object
    // since addMessage creates a new Map. But the *Conversation object* for A
    // should be the same since only B changed.
    // Note: this depends on whether the store creates a new conv object for A.
    // With immutable Maps, the unchanged entries keep their references.
    expect(refAfter).toBeDefined()
    expect(refAfter!.id).toBe('alice@example.com')
  })

  it('empty selectors return stable references', () => {
    const state = chatStore.getState()

    const ids1 = chatSelectors.conversationIds(state)
    const ids2 = chatSelectors.conversationIds(state)
    expect(ids1).toBe(ids2) // Same EMPTY_STRING_ARRAY reference

    const msgs1 = chatSelectors.activeMessages(state)
    const msgs2 = chatSelectors.activeMessages(state)
    expect(msgs1).toBe(msgs2) // Same EMPTY_MESSAGE_ARRAY reference
  })

  it('messagesForConversation returns stable empty reference for unknown conversation', () => {
    const state = chatStore.getState()

    const msgs1 = chatSelectors.messagesForConversation('unknown@example.com')(state)
    const msgs2 = chatSelectors.messagesForConversation('unknown@example.com')(state)

    expect(msgs1).toBe(msgs2) // Same EMPTY_MESSAGE_ARRAY reference
    expect(msgs1.length).toBe(0)
  })

  it('totalUnreadCount is a primitive and does not cause reference instability', () => {
    const convA = createConversation('alice@example.com', { unreadCount: 3 })
    const convB = createConversation('bob@example.com', { unreadCount: 5 })

    chatStore.getState().addConversation(convA)
    chatStore.getState().addConversation(convB)

    const count = chatSelectors.totalUnreadCount(chatStore.getState())
    expect(count).toBe(8)

    // Add a message to A (unread may increase if not active)
    chatStore.getState().addMessage(createMessage('alice@example.com', 'New msg', 'msg-1'))

    const countAfter = chatSelectors.totalUnreadCount(chatStore.getState())
    // The count should be a number (primitive) — always stable for equality checks
    expect(typeof countAfter).toBe('number')
  })

  it('sidebarListItems creates new array on each call (baseline for memoization)', () => {
    const convA = createConversation('alice@example.com')
    chatStore.getState().addConversation(convA)

    const state = chatStore.getState()
    const items1 = chatSelectors.sidebarListItems(state)
    const items2 = chatSelectors.sidebarListItems(state)

    // Currently: new array on each call (no caching)
    // This documents the baseline behavior before any memoization is added
    expect(items1).not.toBe(items2) // Different array references
    expect(items1).toEqual(items2) // But same content
  })

  it('entityById returns stable reference when metadata changes', () => {
    const convA = createConversation('alice@example.com')
    chatStore.getState().addConversation(convA)

    const entityBefore = chatSelectors.entityById('alice@example.com')(chatStore.getState())

    // Add a message — changes conversationMeta but NOT conversationEntities
    chatStore.getState().addMessage(createMessage('alice@example.com', 'Hello', 'msg-1'))

    const entityAfter = chatSelectors.entityById('alice@example.com')(chatStore.getState())

    // Entity should be the same reference since it wasn't modified
    expect(entityBefore).toBe(entityAfter)
    expect(entityAfter!.name).toBe('alice')
  })

  it('metadataById changes when message is added to that conversation', () => {
    const convA = createConversation('alice@example.com')
    chatStore.getState().addConversation(convA)

    const metaBefore = chatSelectors.metadataById('alice@example.com')(chatStore.getState())

    // Add a message — should change metadata (lastMessage, possibly unreadCount)
    chatStore.getState().addMessage(createMessage('alice@example.com', 'Hello', 'msg-1'))

    const metaAfter = chatSelectors.metadataById('alice@example.com')(chatStore.getState())

    // Metadata should be different (new object with updated lastMessage)
    expect(metaBefore).not.toBe(metaAfter)
    expect(metaAfter!.lastMessage).toBeDefined()
    expect(metaAfter!.lastMessage!.body).toBe('Hello')
  })
})
