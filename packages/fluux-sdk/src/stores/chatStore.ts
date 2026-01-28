import { createStore } from 'zustand/vanilla'
import { persist, subscribeWithSelector } from 'zustand/middleware'
import type { Message, Conversation, ConversationEntity, ConversationMetadata, MAMQueryState, RSMResponse } from '../core'
import { setTypingTimeout, clearTypingTimeout, clearAllTypingTimeouts } from './typingTimeout'
import { findMessageById } from '../utils/messageLookup'
import * as messageCache from '../utils/messageCache'
import * as mamState from './shared/mamState'
import type { MAMQueryDirection } from './shared/mamState'
import * as draftState from './shared/draftState'
import { buildMessageKeySet, isMessageDuplicate, sortMessagesByTimestamp, trimMessages, prependOlderMessages, mergeAndProcessMessages } from './shared/messageArrayUtils'
import { connectionStore } from './connectionStore'

// Maximum messages to keep in memory per conversation (display buffer)
// This is a memory/performance tradeoff - higher values allow smoother scrolling
// but use more RAM. 1000 is enough for typical usage with lazy loading.
// All messages are stored in IndexedDB regardless of this limit.
const MAX_MESSAGES_PER_CONVERSATION = 1000
const STORAGE_KEY = 'xmpp-chat-storage'

/**
 * Stable empty array reference to prevent infinite re-renders.
 * When activeMessages() returns empty results, it should return this
 * constant instead of creating a new [] instances each time.
 */
const EMPTY_MESSAGE_ARRAY: Message[] = []

/**
 * Extract deduplication keys for a chat message.
 * Chat messages use two keys: stanzaId (if present) and from+id combo.
 * This handles both client-generated IDs and server-assigned stanza IDs from MAM.
 */
function getChatMessageKeys(m: Message): string[] {
  const keys: string[] = []
  if (m.stanzaId) keys.push(`stanzaId:${m.stanzaId}`)
  keys.push(`from:${m.from}:id:${m.id}`)
  return keys
}

/**
 * Chat state interface for 1:1 conversations.
 *
 * Manages direct message conversations, message history, typing indicators,
 * drafts, and MAM (Message Archive Management) state. Conversations and messages
 * are persisted to localStorage for offline access.
 *
 * @remarks
 * Most applications should use the `useChat` hook instead of accessing this
 * store directly. The hook provides a cleaner API with memoized actions.
 *
 * The store separates entity data (stable) from metadata (frequently-changing)
 * to enable fine-grained subscriptions:
 * - `conversationEntities`: Rarely changes (id, name, type)
 * - `conversationMeta`: Changes often (unreadCount, lastMessage, etc.)
 * - `conversations`: Combined view for backward compatibility
 *
 * @example Direct store access (advanced)
 * ```ts
 * import { useChatStore } from '@fluux/sdk'
 *
 * // Get all conversations (combined entity + metadata)
 * const conversations = useChatStore.getState().conversations
 *
 * // Subscribe to metadata only (sidebar optimization)
 * useChatStore.subscribe(
 *   (state) => state.conversationMeta,
 *   (meta) => console.log('Metadata changed')
 * )
 * ```
 *
 * @category Stores
 */
interface ChatState {
  // Separated entity/metadata for fine-grained subscriptions
  conversationEntities: Map<string, ConversationEntity>
  conversationMeta: Map<string, ConversationMetadata>
  // Combined view for backward compatibility (computed from entities + meta)
  conversations: Map<string, Conversation>
  messages: Map<string, Message[]>
  activeConversationId: string | null
  // Archived conversation IDs - hidden from main list but reappear on new activity
  archivedConversations: Set<string>
  // Typing indicators: conversationId -> Set of JIDs currently typing (ephemeral, not persisted)
  typingStates: Map<string, Set<string>>
  // Easter egg animation state (ephemeral, not persisted)
  activeAnimation: { conversationId: string; animation: string } | null
  // Message drafts per conversation (persisted to localStorage)
  drafts: Map<string, string>
  // XEP-0313: MAM query state per conversation (ephemeral, not persisted)
  mamQueryStates: Map<string, MAMQueryState>

  // Computed
  activeConversation: () => Conversation | null
  activeMessages: () => Message[]
  isArchived: (id: string) => boolean
  /** Get all non-archived conversations (visible in sidebar) */
  activeConversations: () => Conversation[]

  // Actions
  setActiveConversation: (id: string | null) => void
  addConversation: (conv: Conversation) => void
  updateConversationName: (id: string, name: string) => void
  deleteConversation: (id: string) => void
  addMessage: (msg: Message) => void
  markAsRead: (conversationId: string) => void
  clearFirstNewMessageId: (conversationId: string) => void
  hasConversation: (id: string) => boolean
  archiveConversation: (id: string) => void
  unarchiveConversation: (id: string) => void
  setTyping: (conversationId: string, jid: string, isTyping: boolean) => void
  clearAllTyping: () => void
  updateReactions: (conversationId: string, messageId: string, reactorJid: string, emojis: string[]) => void
  updateMessage: (conversationId: string, messageId: string, updates: Partial<Message>) => void
  getMessage: (conversationId: string, messageId: string) => Message | undefined
  triggerAnimation: (conversationId: string, animation: string) => void
  clearAnimation: () => void
  // Draft management
  setDraft: (conversationId: string, text: string) => void
  getDraft: (conversationId: string) => string
  clearDraft: (conversationId: string) => void
  // XEP-0313: MAM (Message Archive Management)
  setMAMLoading: (conversationId: string, isLoading: boolean) => void
  setMAMError: (conversationId: string, error: string | null) => void
  /**
   * Merge MAM messages into conversation and update query state.
   * @param conversationId - Conversation JID
   * @param messages - Messages from MAM query
   * @param rsm - RSM pagination response
   * @param complete - Whether server indicated query is complete
   * @param direction - Query direction: 'backward' for older history, 'forward' for catching up
   */
  mergeMAMMessages: (conversationId: string, messages: Message[], rsm: RSMResponse, complete: boolean, direction: MAMQueryDirection) => void
  getMAMQueryState: (conversationId: string) => MAMQueryState
  resetMAMStates: () => void
  /** Mark all conversations as needing a catch-up MAM query (called on reconnect) */
  markAllNeedsCatchUp: () => void
  /** Clear the needsCatchUp flag for a specific conversation */
  clearNeedsCatchUp: (conversationId: string) => void
  /**
   * Update only the lastMessage preview for a conversation without affecting the messages array.
   * Used for background preview refresh to sync sidebar with server state after being offline.
   * @param conversationId - Conversation JID
   * @param lastMessage - The most recent message from MAM
   */
  updateLastMessagePreview: (conversationId: string, lastMessage: Message) => void
  // IndexedDB message loading
  loadMessagesFromCache: (conversationId: string, options?: { limit?: number; before?: Date }) => Promise<Message[]>
  loadOlderMessagesFromCache: (conversationId: string, limit?: number) => Promise<Message[]>
  reset: () => void
}

// Serialization types for localStorage
// Note: messages are NOT persisted in localStorage - they're in IndexedDB
// Only conversations metadata, archivedConversations, and drafts are persisted here
interface PersistedState {
  // New separated storage (Phase 6)
  conversationEntities?: [string, ConversationEntity][]
  conversationMeta?: [string, ConversationMetadata][]
  // Legacy combined storage for backward compatibility
  conversations: [string, Conversation][]
  archivedConversations?: string[] // Optional for backwards compatibility
  drafts?: [string, string][] // Optional for backwards compatibility
  // Legacy fields, kept for backwards compatibility when reading old storage
  messages?: [string, Message[]][] // May exist in old storage, will be migrated
  activeConversationId?: string | null
}

// Serialize Maps to arrays for JSON storage
function serializeState(state: Pick<ChatState, 'conversationEntities' | 'conversationMeta' | 'conversations' | 'messages' | 'archivedConversations' | 'drafts'>): PersistedState {
  return {
    // Serialize separated maps (Phase 6)
    conversationEntities: Array.from(state.conversationEntities.entries()),
    conversationMeta: Array.from(state.conversationMeta.entries()),
    // Also serialize combined map for backward compatibility
    conversations: Array.from(state.conversations.entries()),
    // Messages are NOT stored in localStorage - they're in IndexedDB
    archivedConversations: Array.from(state.archivedConversations),
    drafts: Array.from(state.drafts.entries()),
  }
}

// Deserialize arrays back to Maps, reset unread counts, restore Date objects
// Also handles migration of old localStorage messages to IndexedDB
function deserializeState(persisted: PersistedState): Pick<ChatState, 'conversationEntities' | 'conversationMeta' | 'conversations' | 'messages' | 'activeConversationId' | 'archivedConversations' | 'drafts'> {
  // Helper to restore Date objects in lastMessage
  const restoreLastMessage = (lastMessage?: Message): Message | undefined => {
    if (!lastMessage) return undefined
    return { ...lastMessage, timestamp: new Date(lastMessage.timestamp) }
  }

  // Helper to restore Date objects in lastReadAt
  const restoreLastReadAt = (lastReadAt?: Date | string): Date | undefined => {
    if (!lastReadAt) return undefined
    return lastReadAt instanceof Date ? lastReadAt : new Date(lastReadAt)
  }

  // Check if we have the new separated format
  const hasNewFormat = persisted.conversationEntities && persisted.conversationMeta

  let conversationEntities: Map<string, ConversationEntity>
  let conversationMeta: Map<string, ConversationMetadata>
  let conversations: Map<string, Conversation>

  if (hasNewFormat) {
    // New format: deserialize separated maps
    conversationEntities = new Map(persisted.conversationEntities!)
    conversationMeta = new Map(
      persisted.conversationMeta!.map(([id, meta]) => [
        id,
        {
          ...meta,
          unreadCount: 0, // Reset unread on restore
          lastMessage: restoreLastMessage(meta.lastMessage),
          lastReadAt: restoreLastReadAt(meta.lastReadAt),
        },
      ])
    )

    // Rebuild combined map from separated maps
    conversations = new Map()
    for (const [id, entity] of conversationEntities) {
      const meta = conversationMeta.get(id)
      if (meta) {
        conversations.set(id, { ...entity, ...meta })
      }
    }
  } else {
    // Legacy format: deserialize combined map and extract separated maps
    conversations = new Map(
      persisted.conversations.map(([id, conv]) => [
        id,
        {
          ...conv,
          unreadCount: 0, // Reset unread on restore
          lastMessage: restoreLastMessage(conv.lastMessage),
          lastReadAt: restoreLastReadAt(conv.lastReadAt),
        },
      ])
    )

    // Extract entity and metadata from combined conversations (migration)
    conversationEntities = new Map()
    conversationMeta = new Map()
    for (const [id, conv] of conversations) {
      conversationEntities.set(id, {
        id: conv.id,
        name: conv.name,
        type: conv.type,
      })
      conversationMeta.set(id, {
        unreadCount: conv.unreadCount,
        lastMessage: conv.lastMessage,
        lastReadAt: conv.lastReadAt,
        firstNewMessageId: conv.firstNewMessageId,
      })
    }
  }

  // Migrate old localStorage messages to IndexedDB (one-time migration)
  if (persisted.messages && persisted.messages.length > 0) {
    const allMessages: Message[] = []
    for (const [, msgs] of persisted.messages) {
      for (const m of msgs) {
        allMessages.push({
          ...m,
          timestamp: new Date(m.timestamp),
        })
      }
    }
    if (allMessages.length > 0) {
      // Save to IndexedDB asynchronously (fire-and-forget migration)
      void messageCache.saveMessages(allMessages).then(() => {
        console.log(`Migrated ${allMessages.length} messages from localStorage to IndexedDB`)
      })
    }
  }

  // Restore archived conversations (backwards compatible - default to empty set)
  const archivedConversations = new Set(persisted.archivedConversations || [])

  // Restore drafts (backwards compatible - default to empty map)
  const drafts = new Map(persisted.drafts || [])

  return {
    conversationEntities,
    conversationMeta,
    conversations,
    // Messages are NOT loaded from localStorage - they'll be loaded from IndexedDB on demand
    messages: new Map(),
    // Always null - activeConversationId is managed by ChatLayout's session storage
    activeConversationId: null,
    archivedConversations,
    drafts,
  }
}

export const chatStore = createStore<ChatState>()(
  subscribeWithSelector(
    persist(
    (set, get) => ({
      conversationEntities: new Map(),
      conversationMeta: new Map(),
      conversations: new Map(),
      messages: new Map(),
      activeConversationId: null,
      archivedConversations: new Set(),
      typingStates: new Map(),
      activeAnimation: null,
      drafts: new Map(),
      mamQueryStates: new Map(),

      activeConversation: () => {
        const { activeConversationId, conversations } = get()
        if (!activeConversationId) return null
        return conversations.get(activeConversationId) || null
      },

      activeMessages: () => {
        const { activeConversationId, messages } = get()
        if (!activeConversationId) return EMPTY_MESSAGE_ARRAY
        return messages.get(activeConversationId) || EMPTY_MESSAGE_ARRAY
      },

      isArchived: (id) => {
        return get().archivedConversations.has(id)
      },

      activeConversations: () => {
        const state = get()
        const result: Conversation[] = []
        for (const conv of state.conversations.values()) {
          if (!state.archivedConversations.has(conv.id)) {
            result.push(conv)
          }
        }
        return result
      },

      setActiveConversation: (id) => {
        // Calculate firstNewMessageId BEFORE marking as read
        // This ensures the marker can be shown before lastReadAt is updated
        if (id) {
          // Try metadata map first, fall back to conversations for backward compatibility
          // (e.g., during migration from old storage format, or when state is directly manipulated)
          const meta = get().conversationMeta.get(id)
          const conv = get().conversations.get(id)
          const lastReadAtSource = meta?.lastReadAt ?? conv?.lastReadAt
          const messages = get().messages.get(id) || []
          if (lastReadAtSource) {
            // Note: lastReadAt may be a string after JSON deserialization from persist middleware
            const lastReadAt = lastReadAtSource instanceof Date
              ? lastReadAtSource
              : new Date(lastReadAtSource)
            // Find first message that is:
            // 1. After lastReadAt
            // 2. Not outgoing (we wrote it)
            // 3. Not delayed (historical message)
            const firstNewMessage = messages.find(
              (msg) => msg.timestamp > lastReadAt && !msg.isOutgoing && !msg.isDelayed
            )
            if (firstNewMessage) {
              // Store the marker position before updating lastReadAt
              set((state) => {
                // Update metadata map (if entry exists)
                const newMeta = new Map(state.conversationMeta)
                const existingMeta = newMeta.get(id)
                if (existingMeta) {
                  newMeta.set(id, { ...existingMeta, firstNewMessageId: firstNewMessage.id })
                }

                // Update combined map
                const newConversations = new Map(state.conversations)
                const existing = newConversations.get(id)
                if (existing) {
                  newConversations.set(id, { ...existing, firstNewMessageId: firstNewMessage.id })
                }
                return { conversationMeta: newMeta, conversations: newConversations, activeConversationId: id }
              })
              // Now mark as read (which updates lastReadAt)
              get().markAsRead(id)
              return
            }
          }
        }
        // Default case: no marker needed, just set active and mark as read
        set({ activeConversationId: id })
        if (id) {
          get().markAsRead(id)
        }
      },

      addConversation: (conv) => {
        set((state) => {
          // Extract entity fields (stable)
          const entity: ConversationEntity = {
            id: conv.id,
            name: conv.name,
            type: conv.type,
          }
          // Extract metadata fields (frequently-changing)
          const meta: ConversationMetadata = {
            unreadCount: conv.unreadCount,
            lastMessage: conv.lastMessage,
            lastReadAt: conv.lastReadAt,
            firstNewMessageId: conv.firstNewMessageId,
          }

          const newEntities = new Map(state.conversationEntities)
          newEntities.set(conv.id, entity)

          const newMeta = new Map(state.conversationMeta)
          newMeta.set(conv.id, meta)

          // Also update combined map for backward compatibility
          const newConversations = new Map(state.conversations)
          newConversations.set(conv.id, conv)

          return {
            conversationEntities: newEntities,
            conversationMeta: newMeta,
            conversations: newConversations,
          }
        })
      },

      updateConversationName: (id, name) => {
        set((state) => {
          const entity = state.conversationEntities.get(id)
          if (!entity) return state

          // Update entity (name is entity data)
          const newEntities = new Map(state.conversationEntities)
          newEntities.set(id, { ...entity, name })

          // Update combined map
          const conv = state.conversations.get(id)
          if (conv) {
            const newConversations = new Map(state.conversations)
            newConversations.set(id, { ...conv, name })
            return { conversationEntities: newEntities, conversations: newConversations }
          }

          return { conversationEntities: newEntities }
        })
      },

      deleteConversation: (id) => {
        // Delete messages from IndexedDB asynchronously
        void messageCache.deleteConversationMessages(id)

        set((state) => {
          // Remove from separated maps
          const newEntities = new Map(state.conversationEntities)
          newEntities.delete(id)

          const newMeta = new Map(state.conversationMeta)
          newMeta.delete(id)

          // Remove from combined map
          const newConversations = new Map(state.conversations)
          newConversations.delete(id)

          // Also delete all messages for this conversation from memory
          const newMessages = new Map(state.messages)
          newMessages.delete(id)

          // Remove from archived set if present
          const newArchived = new Set(state.archivedConversations)
          newArchived.delete(id)

          // Clear active conversation if it's the one being deleted
          const newActiveId = state.activeConversationId === id ? null : state.activeConversationId

          return {
            conversationEntities: newEntities,
            conversationMeta: newMeta,
            conversations: newConversations,
            messages: newMessages,
            archivedConversations: newArchived,
            activeConversationId: newActiveId,
          }
        })
      },

      addMessage: (msg) => {
        set((state) => {
          const convMessages = state.messages.get(msg.conversationId) || []

          // XEP-0359: Deduplicate messages
          // 1. If stanzaId present: check for existing message with same stanzaId (globally unique)
          // 2. If no stanzaId: check for existing message with same from + id (unique per sender)
          const isDuplicate = convMessages.some((existing) => {
            if (msg.stanzaId && existing.stanzaId) {
              return existing.stanzaId === msg.stanzaId
            }
            // Fallback: dedupe by from + id (message id is only unique per sender)
            return existing.from === msg.from && existing.id === msg.id
          })

          if (isDuplicate) {
            return state // Don't add duplicate message
          }

          // XEP-0334: Save to IndexedDB only if message doesn't have noStore hint
          if (!msg.noStore) {
            void messageCache.saveMessage(msg)
          }

          const newMessages = new Map(state.messages)
          newMessages.set(msg.conversationId, [...convMessages, msg])

          const conv = state.conversations.get(msg.conversationId)
          const meta = state.conversationMeta.get(msg.conversationId)
          if (conv && meta) {
            const isActive = state.activeConversationId === msg.conversationId
            const windowVisible = connectionStore.getState().windowVisible

            // Determine if user can actually see this message
            // User sees it only if: conversation is active AND window is visible
            const userSeesMessage = isActive && windowVisible

            // When user sees message, update lastReadAt to message timestamp
            // When user doesn't see it and lastReadAt not set, initialize to epoch so new messages show marker
            // When user doesn't see it and lastReadAt is set, preserve it (marker position stays correct)
            let newLastReadAt: Date | undefined
            let newFirstNewMessageId = meta.firstNewMessageId
            if (userSeesMessage) {
              newLastReadAt = msg.timestamp
            } else if (meta.lastReadAt === undefined && !msg.isOutgoing) {
              // First unread message in this conversation - set marker to show it as new
              newLastReadAt = new Date(0)
            } else {
              newLastReadAt = meta.lastReadAt
            }

            // Set firstNewMessageId for the new message marker when:
            // - Window is not visible AND conversation is active AND incoming message
            // - This ensures marker is shown when user returns to visible window
            if (isActive && !windowVisible && !msg.isOutgoing && !meta.firstNewMessageId) {
              newFirstNewMessageId = msg.id
            }

            // Calculate new metadata values
            const newUnreadCount = userSeesMessage ? 0 : meta.unreadCount + (msg.isOutgoing ? 0 : 1)

            // Update metadata map
            const newMeta = new Map(state.conversationMeta)
            newMeta.set(msg.conversationId, {
              ...meta,
              unreadCount: newUnreadCount,
              lastReadAt: newLastReadAt,
              lastMessage: msg,
              firstNewMessageId: newFirstNewMessageId,
            })

            // Update combined map for backward compatibility
            const newConversations = new Map(state.conversations)
            newConversations.set(msg.conversationId, {
              ...conv,
              unreadCount: newUnreadCount,
              lastReadAt: newLastReadAt,
              lastMessage: msg,
              firstNewMessageId: newFirstNewMessageId,
            })

            // Auto-unarchive conversation when new incoming message arrives
            // (outgoing messages should not trigger unarchive)
            if (!msg.isOutgoing) {
              const newArchived = new Set(state.archivedConversations)
              if (newArchived.has(msg.conversationId)) {
                newArchived.delete(msg.conversationId)
                return {
                  messages: newMessages,
                  conversationMeta: newMeta,
                  conversations: newConversations,
                  archivedConversations: newArchived,
                }
              }
            }

            return { messages: newMessages, conversationMeta: newMeta, conversations: newConversations }
          }

          return { messages: newMessages }
        })
      },

      markAsRead: (conversationId) => {
        set((state) => {
          const conv = state.conversations.get(conversationId)
          if (!conv) {
            return {} // No change - conversation doesn't exist
          }

          // Try metadata map first, fall back to conversations for backward compatibility
          const meta = state.conversationMeta.get(conversationId)
          const currentUnreadCount = meta?.unreadCount ?? conv.unreadCount
          const currentLastReadAt = meta?.lastReadAt ?? conv.lastReadAt

          // Always update lastReadAt when conversation becomes active
          // This ensures the "new messages" marker is always correct
          const messages = state.messages.get(conversationId) || []
          const lastMessage = messages[messages.length - 1]
          const lastReadAt = lastMessage?.timestamp ?? new Date()
          // Only update if there's actually a change to make
          // Compare timestamps by value (getTime) not by reference to avoid infinite loops
          // Note: lastReadAt may be a string after JSON deserialization from persist middleware
          const existingLastReadAt = currentLastReadAt instanceof Date
            ? currentLastReadAt.getTime()
            : currentLastReadAt ? new Date(currentLastReadAt).getTime() : 0
          const lastReadAtChanged = existingLastReadAt !== lastReadAt.getTime()
          if (currentUnreadCount > 0 || lastReadAtChanged) {
            // Update metadata map (if entry exists)
            const newMeta = new Map(state.conversationMeta)
            if (meta) {
              newMeta.set(conversationId, { ...meta, unreadCount: 0, lastReadAt })
            }

            // Update combined map
            const newConversations = new Map(state.conversations)
            newConversations.set(conversationId, { ...conv, unreadCount: 0, lastReadAt })

            return { conversationMeta: newMeta, conversations: newConversations }
          }
          return {} // No change needed
        })
      },

      clearFirstNewMessageId: (conversationId) => {
        set((state) => {
          const meta = state.conversationMeta.get(conversationId)
          const conv = state.conversations.get(conversationId)
          if (meta && meta.firstNewMessageId) {
            // Update metadata map
            const newMeta = new Map(state.conversationMeta)
            newMeta.set(conversationId, { ...meta, firstNewMessageId: undefined })

            // Update combined map
            if (conv) {
              const newConversations = new Map(state.conversations)
              newConversations.set(conversationId, { ...conv, firstNewMessageId: undefined })
              return { conversationMeta: newMeta, conversations: newConversations }
            }

            return { conversationMeta: newMeta }
          }
          return state
        })
      },

      hasConversation: (id) => {
        return get().conversations.has(id)
      },

      archiveConversation: (id) => {
        set((state) => {
          const newArchived = new Set(state.archivedConversations)
          newArchived.add(id)
          // Clear active conversation if we're archiving it
          const newActiveId = state.activeConversationId === id ? null : state.activeConversationId
          return { archivedConversations: newArchived, activeConversationId: newActiveId }
        })
      },

      unarchiveConversation: (id) => {
        set((state) => {
          const newArchived = new Set(state.archivedConversations)
          newArchived.delete(id)
          return { archivedConversations: newArchived }
        })
      },

      setTyping: (conversationId, jid, isTyping) => {
        if (isTyping) {
          // Set auto-clear timeout in case "paused" is missed
          setTypingTimeout(conversationId, jid, () => {
            // Auto-clear this user's typing state after timeout
            get().setTyping(conversationId, jid, false)
          })
        } else {
          // Clear the timeout when explicitly stopping
          clearTypingTimeout(conversationId, jid)
        }

        set((state) => {
          const newTypingStates = new Map(state.typingStates)
          const typingSet = new Set(newTypingStates.get(conversationId) || [])

          if (isTyping) {
            typingSet.add(jid)
          } else {
            typingSet.delete(jid)
          }

          if (typingSet.size > 0) {
            newTypingStates.set(conversationId, typingSet)
          } else {
            newTypingStates.delete(conversationId)
          }

          return { typingStates: newTypingStates }
        })
      },

      clearAllTyping: () => {
        clearAllTypingTimeouts()
        set({ typingStates: new Map() })
      },

      updateReactions: (conversationId, messageId, reactorJid, emojis) => {
        set((state) => {
          const convMessages = state.messages.get(conversationId)
          if (!convMessages) return state

          const messageIndex = convMessages.findIndex((m) => m.id === messageId)
          if (messageIndex === -1) return state

          const message = convMessages[messageIndex]
          const currentReactions = message.reactions || {}

          // Remove reactor from all existing reactions
          const newReactions: Record<string, string[]> = {}
          for (const [emoji, reactors] of Object.entries(currentReactions)) {
            const filtered = reactors.filter((jid) => jid !== reactorJid)
            if (filtered.length > 0) {
              newReactions[emoji] = filtered
            }
          }

          // Add reactor to new emojis
          for (const emoji of emojis) {
            if (!newReactions[emoji]) {
              newReactions[emoji] = []
            }
            newReactions[emoji].push(reactorJid)
          }

          const updatedMessage = {
            ...message,
            reactions: Object.keys(newReactions).length > 0 ? newReactions : undefined,
          }

          // Update in IndexedDB asynchronously
          void messageCache.updateMessage(message.id, { reactions: updatedMessage.reactions })

          const newMessages = new Map(state.messages)
          const updatedConvMessages = [...convMessages]
          updatedConvMessages[messageIndex] = updatedMessage
          newMessages.set(conversationId, updatedConvMessages)

          return { messages: newMessages }
        })
      },

      updateMessage: (conversationId, messageId, updates) => {
        set((state) => {
          const convMessages = state.messages.get(conversationId)
          if (!convMessages) return state

          // Find message by id or stanzaId (corrections may reference either)
          const messageIndex = convMessages.findIndex((m) => m.id === messageId || m.stanzaId === messageId)
          if (messageIndex === -1) return state

          const newMessages = new Map(state.messages)
          const updatedConvMessages = [...convMessages]
          const updatedMessage = {
            ...convMessages[messageIndex],
            ...updates,
          }
          updatedConvMessages[messageIndex] = updatedMessage
          newMessages.set(conversationId, updatedConvMessages)

          // Update in IndexedDB asynchronously (non-blocking)
          // Use the actual message id (not the lookup id which could be stanzaId)
          void messageCache.updateMessage(convMessages[messageIndex].id, updates)

          // Update lastMessage if this was the last message in the conversation
          const isLastMessage = messageIndex === updatedConvMessages.length - 1
          if (isLastMessage) {
            const meta = state.conversationMeta.get(conversationId)
            const conv = state.conversations.get(conversationId)
            if (meta && conv) {
              // Update metadata map
              const newMeta = new Map(state.conversationMeta)
              newMeta.set(conversationId, { ...meta, lastMessage: updatedMessage })

              // Update combined map
              const newConversations = new Map(state.conversations)
              newConversations.set(conversationId, { ...conv, lastMessage: updatedMessage })

              return { messages: newMessages, conversationMeta: newMeta, conversations: newConversations }
            }
          }

          return { messages: newMessages }
        })
      },

      getMessage: (conversationId, messageId) => {
        const convMessages = get().messages.get(conversationId)
        if (!convMessages) return undefined
        return findMessageById(convMessages, messageId)
      },

      triggerAnimation: (conversationId, animation) => {
        set({ activeAnimation: { conversationId, animation } })
      },

      clearAnimation: () => {
        set({ activeAnimation: null })
      },

      setDraft: (conversationId, text) => {
        set((state) => ({
          drafts: draftState.setDraft(state.drafts, conversationId, text),
        }))
      },

      getDraft: (conversationId) => {
        return draftState.getDraft(get().drafts, conversationId)
      },

      clearDraft: (conversationId) => {
        set((state) => ({
          drafts: draftState.clearDraft(state.drafts, conversationId),
        }))
      },

      // XEP-0313: MAM (Message Archive Management)
      setMAMLoading: (conversationId, isLoading) => {
        set((state) => ({
          mamQueryStates: mamState.setMAMLoading(state.mamQueryStates, conversationId, isLoading),
        }))
      },

      setMAMError: (conversationId, error) => {
        set((state) => ({
          mamQueryStates: mamState.setMAMError(state.mamQueryStates, conversationId, error),
        }))
      },

      mergeMAMMessages: (conversationId, mamMessages, rsm, complete, direction) => {
        set((state) => {
          // Get existing messages for this conversation
          const existingMessages = state.messages.get(conversationId) || []

          // Choose merge strategy based on direction:
          // - Backward (scroll up for older): optimized prepend avoids full re-sort
          // - Forward (catching up with newer): requires full sort since messages are newer
          const { merged: trimmed, newMessages } =
            direction === 'backward'
              ? prependOlderMessages(
                  existingMessages,
                  mamMessages,
                  getChatMessageKeys,
                  MAX_MESSAGES_PER_CONVERSATION
                )
              : mergeAndProcessMessages(
                  existingMessages,
                  mamMessages,
                  getChatMessageKeys,
                  MAX_MESSAGES_PER_CONVERSATION
                )

          // Update MAM query state with pagination cursor using the two-marker approach
          // This must always be updated to track query completion and cursors
          const newStates = mamState.setMAMQueryCompleted(
            state.mamQueryStates,
            conversationId,
            complete,
            direction,
            rsm.first // Pagination cursor for fetching older messages
          )

          // If no new messages (all duplicates), only update MAM state - skip messages/conversations
          // This prevents unnecessary re-renders when merging duplicates
          if (newMessages.length === 0) {
            return { mamQueryStates: newStates }
          }

          // XEP-0334: Save only messages without noStore hint to IndexedDB
          const persistableMessages = newMessages.filter(msg => !msg.noStore)
          if (persistableMessages.length > 0) {
            void messageCache.saveMessages(persistableMessages)
          }

          // Update messages map (only when we have new messages)
          const newMessagesMap = new Map(state.messages)
          newMessagesMap.set(conversationId, trimmed)

          // Update lastMessage if we have messages (use the last one after merge/sort)
          const lastMessage = trimmed.length > 0 ? trimmed[trimmed.length - 1] : undefined
          const meta = state.conversationMeta.get(conversationId)
          const conv = state.conversations.get(conversationId)
          if (meta && conv && lastMessage) {
            // Only update if this message is newer than existing lastMessage
            const existingTime = meta.lastMessage?.timestamp?.getTime() ?? 0
            const newTime = lastMessage.timestamp?.getTime() ?? 0
            if (newTime > existingTime) {
              // Update metadata map
              const newMeta = new Map(state.conversationMeta)
              newMeta.set(conversationId, { ...meta, lastMessage })

              // Update combined map
              const newConversations = new Map(state.conversations)
              newConversations.set(conversationId, { ...conv, lastMessage })

              return { messages: newMessagesMap, mamQueryStates: newStates, conversationMeta: newMeta, conversations: newConversations }
            }
          }

          return { messages: newMessagesMap, mamQueryStates: newStates }
        })
      },

      getMAMQueryState: (conversationId) => {
        return mamState.getMAMQueryState(get().mamQueryStates, conversationId)
      },

      resetMAMStates: () => {
        set({ mamQueryStates: new Map() })
      },

      markAllNeedsCatchUp: () => {
        set((state) => ({
          mamQueryStates: mamState.markAllNeedsCatchUp(state.mamQueryStates),
        }))
      },

      clearNeedsCatchUp: (conversationId) => {
        set((state) => ({
          mamQueryStates: mamState.clearNeedsCatchUp(state.mamQueryStates, conversationId),
        }))
      },

      updateLastMessagePreview: (conversationId, lastMessage) => {
        set((state) => {
          const meta = state.conversationMeta.get(conversationId)
          const conv = state.conversations.get(conversationId)
          if (!meta || !conv) return state

          // Only update if this message is newer than existing lastMessage
          const existingTime = meta.lastMessage?.timestamp?.getTime() ?? 0
          const newTime = lastMessage.timestamp?.getTime() ?? 0
          if (newTime <= existingTime) return state

          // Update metadata map
          const newMeta = new Map(state.conversationMeta)
          newMeta.set(conversationId, { ...meta, lastMessage })

          // Update combined map for backward compatibility
          const newConversations = new Map(state.conversations)
          newConversations.set(conversationId, { ...conv, lastMessage })

          return { conversationMeta: newMeta, conversations: newConversations }
        })
      },

      // Load messages from IndexedDB cache for a conversation
      // For initial load (no 'before'), loads the LATEST 100 messages to show most recent first
      loadMessagesFromCache: async (conversationId, options = {}) => {
        const { limit = 100, before } = options
        try {
          const cachedMessages = await messageCache.getMessages(conversationId, {
            limit,
            before,
            // When loading without 'before', get the latest messages (most recent)
            // This prevents showing old messages and jumping to recent ones
            latest: !before,
          })

          if (cachedMessages.length > 0) {
            set((state) => {
              const existingMessages = state.messages.get(conversationId) || []

              // Build key set and filter duplicates using shared utilities
              const existingKeySet = buildMessageKeySet(existingMessages, getChatMessageKeys)
              const newMessages = cachedMessages.filter(
                (m) => !isMessageDuplicate(m, existingKeySet, getChatMessageKeys)
              )

              if (newMessages.length === 0) {
                return state
              }

              // Merge, sort, and trim using shared utilities
              const merged = sortMessagesByTimestamp([...existingMessages, ...newMessages])
              const trimmed = trimMessages(merged, MAX_MESSAGES_PER_CONVERSATION)

              const newMessagesMap = new Map(state.messages)
              newMessagesMap.set(conversationId, trimmed)

              // Update lastMessage if we have messages (use the last one after merge/sort)
              const lastMessage = trimmed.length > 0 ? trimmed[trimmed.length - 1] : undefined
              const meta = state.conversationMeta.get(conversationId)
              const conv = state.conversations.get(conversationId)
              if (meta && conv && lastMessage) {
                // Only update if this message is newer than existing lastMessage
                const existingTime = meta.lastMessage?.timestamp?.getTime() ?? 0
                const newTime = lastMessage.timestamp?.getTime() ?? 0
                if (newTime > existingTime) {
                  // Update metadata map
                  const newMeta = new Map(state.conversationMeta)
                  newMeta.set(conversationId, { ...meta, lastMessage })

                  // Update combined map
                  const newConversations = new Map(state.conversations)
                  newConversations.set(conversationId, { ...conv, lastMessage })

                  return { messages: newMessagesMap, conversationMeta: newMeta, conversations: newConversations }
                }
              }

              return { messages: newMessagesMap }
            })
          }

          return cachedMessages
        } catch (error) {
          console.warn('Failed to load messages from cache:', error)
          return []
        }
      },

      // Load older messages from IndexedDB (for lazy scrolling before hitting MAM)
      loadOlderMessagesFromCache: async (conversationId, limit = 50) => {
        const state = get()
        const existingMessages = state.messages.get(conversationId) || []
        const oldestMessage = existingMessages[0]

        if (!oldestMessage) {
          return []
        }

        try {
          const olderMessages = await messageCache.getMessages(conversationId, {
            limit,
            before: oldestMessage.timestamp,
          })

          if (olderMessages.length > 0) {
            set((state) => {
              const currentMessages = state.messages.get(conversationId) || []

              // Merge older messages at the beginning and trim using shared utility
              const merged = [...olderMessages, ...currentMessages]
              const trimmed = trimMessages(merged, MAX_MESSAGES_PER_CONVERSATION)

              const newMessagesMap = new Map(state.messages)
              newMessagesMap.set(conversationId, trimmed)

              return { messages: newMessagesMap }
            })
          }

          return olderMessages
        } catch (error) {
          console.warn('Failed to load older messages from cache:', error)
          return []
        }
      },

      reset: () => {
        // Clear persisted data on logout
        localStorage.removeItem(STORAGE_KEY)
        // Clear IndexedDB messages asynchronously
        void messageCache.clearAllMessages()
        set({
          conversationEntities: new Map(),
          conversationMeta: new Map(),
          conversations: new Map(),
          messages: new Map(),
          activeConversationId: null,
          archivedConversations: new Set(),
          typingStates: new Map(),
          activeAnimation: null,
          drafts: new Map(),
          mamQueryStates: new Map(),
        })
      },
    }),
    {
      name: STORAGE_KEY,
      storage: {
        getItem: (name) => {
          try {
            const str = localStorage.getItem(name)
            if (!str) return null
            const parsed = JSON.parse(str)
            return { state: deserializeState(parsed.state) }
          } catch {
            // Corrupted data, clear and start fresh
            localStorage.removeItem(name)
            return null
          }
        },
        setItem: (name, value) => {
          try {
            const state = value.state as ChatState
            const serialized = serializeState(state)
            localStorage.setItem(name, JSON.stringify({ state: serialized }))
          } catch {
            // Storage quota exceeded or other error, continue without persistence
          }
        },
        removeItem: (name) => localStorage.removeItem(name),
      },
      partialize: (state) => ({
        // Persist separated maps (Phase 6)
        conversationEntities: state.conversationEntities,
        conversationMeta: state.conversationMeta,
        // Also persist combined map for backward compatibility
        conversations: state.conversations,
        // Note: messages are NOT persisted in localStorage anymore - they're in IndexedDB
        // This allows unlimited message storage and efficient pagination
        messages: new Map(), // Empty - messages loaded from IndexedDB on demand
        // Note: activeConversationId is NOT meaningfully persisted - always null.
        // It's managed by ChatLayout's session storage (ViewStateData) to avoid
        // dual-persistence conflicts that cause incorrect unread badge behavior.
        activeConversationId: null,
        archivedConversations: state.archivedConversations,
        // Persist drafts so they survive page reloads
        drafts: state.drafts,
      }),
    }
    )
  )
)

export type { ChatState }
