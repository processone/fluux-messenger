/**
 * Granular selectors for chatStore to reduce re-renders.
 *
 * Using these selectors with Zustand's shallow comparison allows components
 * to subscribe to specific pieces of state instead of entire Maps/objects.
 *
 * @example
 * ```tsx
 * import { useChatStore, chatSelectors } from '@fluux/sdk'
 * import { shallow } from 'zustand/shallow'
 *
 * // Only re-renders when conversation IDs change (not when messages/content change)
 * const conversationIds = useChatStore(chatSelectors.conversationIds, shallow)
 *
 * // Only re-renders when this specific conversation changes
 * const conversation = useChatStore(chatSelectors.conversationById('user@example.com'))
 * ```
 *
 * @packageDocumentation
 * @module Stores/ChatSelectors
 */

import type { ChatState } from './chatStore'
import type { Message, Conversation, ConversationEntity, ConversationMetadata, MAMQueryState } from '../core/types'

/**
 * Stable empty references to prevent infinite re-renders.
 */
const EMPTY_STRING_ARRAY: string[] = []
const EMPTY_MESSAGE_ARRAY: Message[] = []
const EMPTY_JID_SET: Set<string> = new Set()

/**
 * Granular selectors for chatStore.
 *
 * These selectors enable fine-grained subscriptions to reduce unnecessary
 * re-renders. Use with Zustand's shallow comparison for array/object returns.
 *
 * @category Selectors
 */
export const chatSelectors = {
  /**
   * Get all conversation IDs (sorted by last message timestamp, most recent first).
   * Use with shallow() to only re-render when IDs change.
   */
  conversationIds: (state: ChatState): string[] => {
    const ids = Array.from(state.conversations.keys())
    if (ids.length === 0) return EMPTY_STRING_ARRAY

    // Sort by last message timestamp (most recent first)
    return ids.sort((a, b) => {
      const convA = state.conversations.get(a)
      const convB = state.conversations.get(b)
      const timeA = convA?.lastMessage?.timestamp?.getTime() ?? 0
      const timeB = convB?.lastMessage?.timestamp?.getTime() ?? 0
      return timeB - timeA
    })
  },

  /**
   * Get non-archived conversation IDs (sorted by last message timestamp).
   */
  activeConversationIds: (state: ChatState): string[] => {
    const ids: string[] = []
    for (const [id] of state.conversations) {
      if (!state.archivedConversations.has(id)) {
        ids.push(id)
      }
    }
    if (ids.length === 0) return EMPTY_STRING_ARRAY

    return ids.sort((a, b) => {
      const convA = state.conversations.get(a)
      const convB = state.conversations.get(b)
      const timeA = convA?.lastMessage?.timestamp?.getTime() ?? 0
      const timeB = convB?.lastMessage?.timestamp?.getTime() ?? 0
      return timeB - timeA
    })
  },

  /**
   * Get archived conversation IDs.
   */
  archivedConversationIds: (state: ChatState): string[] => {
    const ids = Array.from(state.archivedConversations)
    return ids.length > 0 ? ids : EMPTY_STRING_ARRAY
  },

  /**
   * Get a specific conversation by ID.
   * Returns a selector function for the given conversation ID.
   */
  conversationById: (id: string) => (state: ChatState): Conversation | undefined => {
    return state.conversations.get(id)
  },

  /**
   * Get messages for a specific conversation.
   * Returns a selector function for the given conversation ID.
   */
  messagesForConversation: (conversationId: string) => (state: ChatState): Message[] => {
    return state.messages.get(conversationId) ?? EMPTY_MESSAGE_ARRAY
  },

  /**
   * Get the currently active conversation ID.
   */
  activeConversationId: (state: ChatState): string | null => {
    return state.activeConversationId
  },

  /**
   * Get the currently active conversation.
   */
  activeConversation: (state: ChatState): Conversation | undefined => {
    if (!state.activeConversationId) return undefined
    return state.conversations.get(state.activeConversationId)
  },

  /**
   * Get messages for the currently active conversation.
   */
  activeMessages: (state: ChatState): Message[] => {
    if (!state.activeConversationId) return EMPTY_MESSAGE_ARRAY
    return state.messages.get(state.activeConversationId) ?? EMPTY_MESSAGE_ARRAY
  },

  /**
   * Get total unread message count across all conversations.
   */
  totalUnreadCount: (state: ChatState): number => {
    let total = 0
    for (const meta of state.conversationMeta.values()) {
      total += meta.unreadCount
    }
    return total
  },

  /**
   * Get unread count for a specific conversation.
   */
  unreadCountFor: (conversationId: string) => (state: ChatState): number => {
    return state.conversations.get(conversationId)?.unreadCount ?? 0
  },

  /**
   * Check if a conversation is archived.
   */
  isArchived: (conversationId: string) => (state: ChatState): boolean => {
    return state.archivedConversations.has(conversationId)
  },

  /**
   * Get typing JIDs for a specific conversation.
   */
  typingFor: (conversationId: string) => (state: ChatState): Set<string> => {
    return state.typingStates.get(conversationId) ?? EMPTY_JID_SET
  },

  /**
   * Get draft text for a specific conversation.
   */
  draftFor: (conversationId: string) => (state: ChatState): string => {
    return state.drafts.get(conversationId) ?? ''
  },

  /**
   * Check if a conversation has a draft.
   */
  hasDraft: (conversationId: string) => (state: ChatState): boolean => {
    const draft = state.drafts.get(conversationId)
    return !!draft && draft.length > 0
  },

  /**
   * Get MAM query state for a specific conversation.
   */
  mamStateFor: (conversationId: string) => (state: ChatState): MAMQueryState | undefined => {
    return state.mamQueryStates.get(conversationId)
  },

  /**
   * Check if MAM is loading for a specific conversation.
   */
  isMAMLoading: (conversationId: string) => (state: ChatState): boolean => {
    return state.mamQueryStates.get(conversationId)?.isLoading ?? false
  },

  /**
   * Get the active animation state.
   */
  activeAnimation: (state: ChatState): { conversationId: string; animation: string } | null => {
    return state.activeAnimation
  },

  /**
   * Get conversation count (total).
   */
  conversationCount: (state: ChatState): number => {
    return state.conversations.size
  },

  /**
   * Get count of conversations with unread messages.
   */
  conversationsWithUnreadCount: (state: ChatState): number => {
    let count = 0
    for (const conv of state.conversations.values()) {
      if (conv.unreadCount > 0) count++
    }
    return count
  },

  /**
   * Check if a conversation exists.
   */
  hasConversation: (conversationId: string) => (state: ChatState): boolean => {
    return state.conversations.has(conversationId)
  },

  /**
   * Get lastMessage for a specific conversation (for sidebar preview).
   */
  lastMessageFor: (conversationId: string) => (state: ChatState): Message | undefined => {
    return state.conversations.get(conversationId)?.lastMessage
  },

  /**
   * Get firstNewMessageId for a specific conversation (for new message marker).
   */
  firstNewMessageIdFor: (conversationId: string) => (state: ChatState): string | undefined => {
    return state.conversations.get(conversationId)?.firstNewMessageId
  },

  // ============================================================
  // METADATA SELECTORS - Fine-grained subscriptions (Phase 6)
  // ============================================================
  // These selectors use the separated entity/metadata maps to enable
  // subscriptions that only re-render when specific data changes.

  /**
   * Get conversation entity by ID (stable identity data only).
   * Use this when you only need id, name, type - not unread counts or last message.
   */
  entityById: (id: string) => (state: ChatState): ConversationEntity | undefined => {
    return state.conversationEntities.get(id)
  },

  /**
   * Get conversation metadata by ID (frequently-changing data only).
   * Use this for sidebar badges, unread counts, last message preview.
   */
  metadataById: (id: string) => (state: ChatState): ConversationMetadata | undefined => {
    return state.conversationMeta.get(id)
  },

  /**
   * Get all conversation metadata as a Map.
   * Use with shallow() for sidebar list that only needs badge/preview data.
   */
  allMetadata: (state: ChatState): Map<string, ConversationMetadata> => {
    return state.conversationMeta
  },

  /**
   * Get all conversation entities as a Map.
   * Use with shallow() for components that only need identity data.
   */
  allEntities: (state: ChatState): Map<string, ConversationEntity> => {
    return state.conversationEntities
  },

  /**
   * Get sidebar list items with minimal data for efficient rendering.
   * Combines entity + metadata for each conversation, sorted by last message time.
   * Use this instead of full conversations when rendering the sidebar list.
   */
  sidebarListItems: (state: ChatState): Array<{
    id: string
    name: string
    type: 'chat' | 'groupchat'
    unreadCount: number
    lastMessage?: Message
    isArchived: boolean
    hasDraft: boolean
  }> => {
    const items: Array<{
      id: string
      name: string
      type: 'chat' | 'groupchat'
      unreadCount: number
      lastMessage?: Message
      isArchived: boolean
      hasDraft: boolean
    }> = []

    for (const [id, entity] of state.conversationEntities) {
      const meta = state.conversationMeta.get(id)
      items.push({
        id,
        name: entity.name,
        type: entity.type,
        unreadCount: meta?.unreadCount ?? 0,
        lastMessage: meta?.lastMessage,
        isArchived: state.archivedConversations.has(id),
        hasDraft: !!state.drafts.get(id),
      })
    }

    // Sort by last message timestamp (most recent first)
    return items.sort((a, b) => {
      const timeA = a.lastMessage?.timestamp?.getTime() ?? 0
      const timeB = b.lastMessage?.timestamp?.getTime() ?? 0
      return timeB - timeA
    })
  },

  /**
   * Get active sidebar items (non-archived), sorted by last message time.
   */
  activeSidebarListItems: (state: ChatState): Array<{
    id: string
    name: string
    type: 'chat' | 'groupchat'
    unreadCount: number
    lastMessage?: Message
    hasDraft: boolean
  }> => {
    const items: Array<{
      id: string
      name: string
      type: 'chat' | 'groupchat'
      unreadCount: number
      lastMessage?: Message
      hasDraft: boolean
    }> = []

    for (const [id, entity] of state.conversationEntities) {
      if (state.archivedConversations.has(id)) continue
      const meta = state.conversationMeta.get(id)
      items.push({
        id,
        name: entity.name,
        type: entity.type,
        unreadCount: meta?.unreadCount ?? 0,
        lastMessage: meta?.lastMessage,
        hasDraft: !!state.drafts.get(id),
      })
    }

    // Sort by last message timestamp (most recent first)
    return items.sort((a, b) => {
      const timeA = a.lastMessage?.timestamp?.getTime() ?? 0
      const timeB = b.lastMessage?.timestamp?.getTime() ?? 0
      return timeB - timeA
    })
  },

  /**
   * Get archived sidebar items, sorted by last message time.
   */
  archivedSidebarListItems: (state: ChatState): Array<{
    id: string
    name: string
    type: 'chat' | 'groupchat'
    unreadCount: number
    lastMessage?: Message
    hasDraft: boolean
  }> => {
    const items: Array<{
      id: string
      name: string
      type: 'chat' | 'groupchat'
      unreadCount: number
      lastMessage?: Message
      hasDraft: boolean
    }> = []

    for (const [id, entity] of state.conversationEntities) {
      if (!state.archivedConversations.has(id)) continue
      const meta = state.conversationMeta.get(id)
      items.push({
        id,
        name: entity.name,
        type: entity.type,
        unreadCount: meta?.unreadCount ?? 0,
        lastMessage: meta?.lastMessage,
        hasDraft: !!state.drafts.get(id),
      })
    }

    // Sort by last message timestamp (most recent first)
    return items.sort((a, b) => {
      const timeA = a.lastMessage?.timestamp?.getTime() ?? 0
      const timeB = b.lastMessage?.timestamp?.getTime() ?? 0
      return timeB - timeA
    })
  },
}
