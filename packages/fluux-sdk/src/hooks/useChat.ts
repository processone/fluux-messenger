import { useCallback, useMemo } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { chatStore, connectionStore } from '../stores'
import { useChatStore, useConnectionStore } from '../react/storeHooks'
import { useXMPPContext } from '../provider'
import type { Conversation, ChatStateNotification, FileAttachment, MAMQueryState, Message } from '../core'
import { NS_MAM } from '../core/namespaces'
import { createFetchOlderHistory } from './shared'

/**
 * Stable empty array references to prevent infinite re-renders.
 * These are returned instead of creating new [] instances each time.
 */
const EMPTY_MESSAGE_ARRAY: Message[] = []
const EMPTY_TYPING_ARRAY: string[] = []

/**
 * Hook for managing 1:1 chat conversations.
 *
 * Provides state and actions for direct messaging, including sending messages,
 * reactions, corrections, typing indicators, and message history (MAM).
 *
 * @returns An object containing chat state and actions
 *
 * @example Displaying conversations
 * ```tsx
 * function ConversationList() {
 *   const { conversations, setActiveConversation } = useChat()
 *
 *   return (
 *     <ul>
 *       {conversations.map(conv => (
 *         <li key={conv.id} onClick={() => setActiveConversation(conv.id)}>
 *           {conv.name} ({conv.unreadCount} unread)
 *         </li>
 *       ))}
 *     </ul>
 *   )
 * }
 * ```
 *
 * @example Sending messages
 * ```tsx
 * function ChatInput() {
 *   const { sendMessage, activeConversationId } = useChat()
 *   const [text, setText] = useState('')
 *
 *   const handleSend = async () => {
 *     if (!activeConversationId || !text.trim()) return
 *     await sendMessage(activeConversationId, text)
 *     setText('')
 *   }
 *
 *   return <input value={text} onChange={e => setText(e.target.value)} onKeyDown={...} />
 * }
 * ```
 *
 * @example Typing indicators
 * ```tsx
 * function ChatInput() {
 *   const { sendChatState, activeConversationId } = useChat()
 *
 *   const handleTyping = () => {
 *     sendChatState(activeConversationId, 'composing')
 *   }
 *
 *   const handleStopTyping = () => {
 *     sendChatState(activeConversationId, 'paused')
 *   }
 * }
 * ```
 *
 * @example Message reactions
 * ```tsx
 * function MessageReaction({ messageId, conversationId }) {
 *   const { sendReaction } = useChat()
 *
 *   const handleReact = (emoji: string) => {
 *     sendReaction(conversationId, messageId, [emoji])
 *   }
 * }
 * ```
 *
 * @category Hooks
 */
export function useChat() {
  const { client } = useXMPPContext()

  // Use useShallow for derived arrays to properly detect changes
  // Note: We compute values directly from state snapshot (s) rather than calling
  // computed functions that use get(), to ensure proper reactivity
  const conversationsRaw = useChatStore(useShallow((s) => Array.from(s.conversations.values())))

  // Get archived conversation IDs
  const archivedConversationIds = useChatStore(useShallow((s) => Array.from(s.archivedConversations)))

  // Sort and filter conversations by last activity (most recent first)
  // Active conversations exclude archived ones
  // NOTE: lastMessage is stored in the conversation object and updated by the store
  // when messages are added/merged/loaded. This avoids subscribing to the entire
  // messagesMap which would cause render loops during message loading.
  const { conversations, archivedConversations } = useMemo(() => {
    const archivedSet = new Set(archivedConversationIds)
    const sorted = [...conversationsRaw].sort((a, b) => {
      // Handle cases where timestamp might be a string (from localStorage) or Date
      const aTimestamp = a.lastMessage?.timestamp
      const bTimestamp = b.lastMessage?.timestamp
      const aTime = aTimestamp instanceof Date ? aTimestamp.getTime() : (aTimestamp ? new Date(aTimestamp).getTime() : 0)
      const bTime = bTimestamp instanceof Date ? bTimestamp.getTime() : (bTimestamp ? new Date(bTimestamp).getTime() : 0)
      return bTime - aTime // Descending (most recent first)
    })
    return {
      conversations: sorted.filter(c => !archivedSet.has(c.id)),
      archivedConversations: sorted.filter(c => archivedSet.has(c.id)),
    }
  }, [conversationsRaw, archivedConversationIds])
  const activeConversationId = useChatStore((s) => s.activeConversationId)
  // Get activeConversation directly from store (lastMessage is stored in the conversation)
  const activeConversation = useChatStore((s) => {
    if (!s.activeConversationId) return null
    return s.conversations.get(s.activeConversationId) ?? null
  })
  // Don't use useShallow for messages - when messages are prepended, we need React to re-render
  // useShallow's element-by-element comparison can miss updates in large arrays
  const activeMessages = useChatStore((s) => {
    if (!s.activeConversationId) return EMPTY_MESSAGE_ARRAY
    return s.messages.get(s.activeConversationId) || EMPTY_MESSAGE_ARRAY
  })

  // Get typing users for active conversation
  const activeTypingUsers = useChatStore(useShallow((s) => {
    if (!s.activeConversationId) return EMPTY_TYPING_ARRAY
    const typingSet = s.typingStates.get(s.activeConversationId)
    if (!typingSet || typingSet.size === 0) return EMPTY_TYPING_ARRAY
    return Array.from(typingSet)
  }))

  // Get all typing states (Map of conversationId -> Set of JIDs typing)
  const typingStates = useChatStore(useShallow((s) => s.typingStates))

  // Get all drafts (Map of conversationId -> draft text)
  const drafts = useChatStore(useShallow((s) => s.drafts))

  // Easter egg animation state
  const activeAnimation = useChatStore((s) => s.activeAnimation)

  // XEP-0313: MAM support
  const supportsMAM = useConnectionStore((s) => {
    return s.serverInfo?.features?.includes(NS_MAM) ?? false
  })

  // Get MAM query state for active conversation
  // Select individual fields to avoid re-renders when other conversations' MAM states change
  const mamIsLoading = useChatStore((s) => {
    if (!s.activeConversationId) return false
    return s.mamQueryStates.get(s.activeConversationId)?.isLoading ?? false
  })
  const mamHasQueried = useChatStore((s) => {
    if (!s.activeConversationId) return false
    return s.mamQueryStates.get(s.activeConversationId)?.hasQueried ?? false
  })
  const mamIsHistoryComplete = useChatStore((s) => {
    if (!s.activeConversationId) return false
    return s.mamQueryStates.get(s.activeConversationId)?.isHistoryComplete ?? false
  })
  const mamIsCaughtUpToLive = useChatStore((s) => {
    if (!s.activeConversationId) return false
    return s.mamQueryStates.get(s.activeConversationId)?.isCaughtUpToLive ?? false
  })
  const mamOldestFetchedId = useChatStore((s) => {
    if (!s.activeConversationId) return undefined
    return s.mamQueryStates.get(s.activeConversationId)?.oldestFetchedId
  })

  // Memoize the MAM state object to maintain stable reference
  const activeMAMState = useMemo((): MAMQueryState | null => {
    if (!activeConversationId) return null
    return {
      isLoading: mamIsLoading,
      hasQueried: mamHasQueried,
      isHistoryComplete: mamIsHistoryComplete,
      isCaughtUpToLive: mamIsCaughtUpToLive,
      oldestFetchedId: mamOldestFetchedId,
      error: null,
    }
  }, [activeConversationId, mamIsLoading, mamHasQueried, mamIsHistoryComplete, mamIsCaughtUpToLive, mamOldestFetchedId])

  // Note: Auto-fetch logic (load cache + MAM query) has been moved to store subscriptions
  // in sideEffects.ts. This eliminates the useEffect → action → state change pattern
  // that could cause render loops. The side effects now run outside React's render cycle.

  const sendMessage = useCallback(
    async (
      to: string,
      body: string,
      type: 'chat' | 'groupchat' = 'chat',
      replyTo?: { id: string; to?: string; fallback?: { author: string; body: string } },
      attachment?: FileAttachment
    ): Promise<string> => {
      return await client.chat.sendMessage(to, body, type, replyTo, undefined, attachment)
    },
    [client]
  )

  // Load cache BEFORE setting active conversation so that setActiveConversation() in the
  // store calculates firstNewMessageId with the full message history (cached + live messages).
  // Without this, conversations that only have live messages (received while viewing another
  // conversation) would show only new messages without historical context above the marker.
  const setActiveConversation = useCallback(async (id: string | null) => {
    if (id) {
      // Always load from cache first - deduplication is handled by loadMessagesFromCache
      await chatStore.getState().loadMessagesFromCache(id, { limit: 100 })
    }
    chatStore.getState().setActiveConversation(id)
  }, [])

  const addConversation = useCallback((conv: Conversation) => {
    chatStore.getState().addConversation(conv)
  }, [])

  const deleteConversation = useCallback((id: string) => {
    chatStore.getState().deleteConversation(id)
  }, [])

  const markAsRead = useCallback((conversationId: string) => {
    chatStore.getState().markAsRead(conversationId)
  }, [])

  const sendChatState = useCallback(
    async (to: string, state: ChatStateNotification, type: 'chat' | 'groupchat' = 'chat') => {
      await client.chat.sendChatState(to, state, type)
    },
    [client]
  )

  const sendReaction = useCallback(
    async (to: string, messageId: string, emojis: string[], type: 'chat' | 'groupchat' = 'chat') => {
      await client.chat.sendReaction(to, messageId, emojis, type)
    },
    [client]
  )

  const sendCorrection = useCallback(
    async (conversationId: string, messageId: string, newBody: string, attachment?: FileAttachment) => {
      await client.chat.sendCorrection(conversationId, messageId, newBody, 'chat', attachment)
    },
    [client]
  )

  const retractMessage = useCallback(
    async (conversationId: string, messageId: string) => {
      await client.chat.sendRetraction(conversationId, messageId, 'chat')
    },
    [client]
  )

  const sendEasterEgg = useCallback(
    async (to: string, type: 'chat' | 'groupchat', animation: string) => {
      await client.chat.sendEasterEgg(to, type, animation)
    },
    [client]
  )

  const clearAnimation = useCallback(() => {
    chatStore.getState().clearAnimation()
  }, [])

  const archiveConversation = useCallback((id: string) => {
    chatStore.getState().archiveConversation(id)
  }, [])

  const unarchiveConversation = useCallback((id: string) => {
    chatStore.getState().unarchiveConversation(id)
  }, [])

  const isArchived = useCallback((id: string) => {
    return chatStore.getState().isArchived(id)
  }, [])

  const setDraft = useCallback((conversationId: string, text: string) => {
    chatStore.getState().setDraft(conversationId, text)
  }, [])

  const getDraft = useCallback((conversationId: string) => {
    return chatStore.getState().getDraft(conversationId)
  }, [])

  const clearDraft = useCallback((conversationId: string) => {
    chatStore.getState().clearDraft(conversationId)
  }, [])

  const clearFirstNewMessageId = useCallback((conversationId: string) => {
    chatStore.getState().clearFirstNewMessageId(conversationId)
  }, [])

  const updateLastSeenMessageId = useCallback((conversationId: string, messageId: string) => {
    chatStore.getState().updateLastSeenMessageId(conversationId, messageId)
  }, [])

  // XEP-0313: Fetch message history from server archive
  // If we have cached messages, fetch NEW messages after the newest cached.
  // If no cache, fetch latest messages.
  // NOTE: hasQueried guard is intentionally removed to allow re-fetching when
  // returning to a conversation (to catch messages from other devices).
  const fetchHistory = useCallback(
    async (conversationId?: string): Promise<void> => {
      // Guard: Don't attempt MAM query if not connected
      // This prevents infinite retry loops when socket is dead (e.g., after sleep)
      const connectionStatus = connectionStore.getState().status
      if (connectionStatus !== 'online') return

      const targetId = conversationId ?? chatStore.getState().activeConversationId
      if (!targetId) return

      // Get the conversation to find the partner JID
      const conversation = chatStore.getState().conversations.get(targetId)
      if (!conversation || conversation.type !== 'chat') return

      // Guard: only prevent concurrent queries
      const mamState = chatStore.getState().getMAMQueryState(targetId)
      if (mamState.isLoading) return

      // Set loading IMMEDIATELY to prevent race conditions with concurrent calls
      chatStore.getState().setMAMLoading(targetId, true)

      try {
        // First ensure messages are loaded from IndexedDB cache
        let cachedMessages = chatStore.getState().messages.get(targetId)
        if (!cachedMessages || cachedMessages.length === 0) {
          await chatStore.getState().loadMessagesFromCache(targetId, { limit: 100 })
          cachedMessages = chatStore.getState().messages.get(targetId)
        }

        const newestCachedMessage = cachedMessages?.[cachedMessages.length - 1]

        // Build query options
        const queryOptions: { with: string; start?: string } = { with: conversation.id }

        // If we have cached messages, use 'start' to only fetch messages AFTER the newest
        // Add 1ms to avoid re-fetching the exact same message
        if (newestCachedMessage?.timestamp) {
          const startTime = new Date(newestCachedMessage.timestamp.getTime() + 1)
          queryOptions.start = startTime.toISOString()
        }

        await client.chat.queryMAM(queryOptions)
      } catch (error) {
        console.error('Failed to fetch history:', error)
      } finally {
        chatStore.getState().setMAMLoading(targetId, false)
      }
    },
    [client]
  )

  // XEP-0313: Fetch older messages (pagination) - for lazy loading on scroll up
  // First checks IndexedDB cache, then falls back to MAM if needed
  const fetchOlderHistory = useMemo(
    () =>
      createFetchOlderHistory({
        getActiveId: () => chatStore.getState().activeConversationId,
        isValidTarget: (id) => {
          const conversation = chatStore.getState().conversations.get(id)
          return !!conversation && conversation.type === 'chat'
        },
        getMAMState: (id) => chatStore.getState().getMAMQueryState(id),
        setMAMLoading: (id, loading) => chatStore.getState().setMAMLoading(id, loading),
        loadFromCache: (id, limit) => chatStore.getState().loadOlderMessagesFromCache(id, limit),
        getOldestMessageId: (id) => {
          const messages = chatStore.getState().messages.get(id)
          if (!messages || messages.length === 0) return undefined
          // Use stanzaId (MAM archive ID) for pagination cursor, fall back to message id
          return messages[0].stanzaId || messages[0].id
        },
        queryMAM: async (id, beforeId) => {
          const conversation = chatStore.getState().conversations.get(id)
          if (conversation) {
            await client.chat.queryMAM({ with: conversation.id, before: beforeId })
          }
        },
        errorLogPrefix: 'Failed to fetch older chat history',
      }),
    [client]
  )

  // Memoize actions object to prevent re-renders when only state changes
  const actions = useMemo(
    () => ({
      sendMessage,
      setActiveConversation,
      addConversation,
      deleteConversation,
      markAsRead,
      archiveConversation,
      unarchiveConversation,
      isArchived,
      sendChatState,
      sendReaction,
      sendCorrection,
      retractMessage,
      sendEasterEgg,
      clearAnimation,
      setDraft,
      getDraft,
      clearDraft,
      clearFirstNewMessageId,
      updateLastSeenMessageId,
      fetchHistory,
      fetchOlderHistory,
    }),
    [
      sendMessage,
      setActiveConversation,
      addConversation,
      deleteConversation,
      markAsRead,
      archiveConversation,
      unarchiveConversation,
      isArchived,
      sendChatState,
      sendReaction,
      sendCorrection,
      retractMessage,
      sendEasterEgg,
      clearAnimation,
      setDraft,
      getDraft,
      clearDraft,
      clearFirstNewMessageId,
      updateLastSeenMessageId,
      fetchHistory,
      fetchOlderHistory,
    ]
  )

  // Memoize the entire return value to prevent render loops
  return useMemo(
    () => ({
      // State
      conversations,
      archivedConversations,
      archivedConversationIds,
      activeConversationId,
      activeConversation,
      activeMessages,
      activeTypingUsers,
      typingStates,
      drafts,
      activeAnimation,
      // XEP-0313: MAM state
      supportsMAM,
      activeMAMState,

      // Actions (spread memoized actions)
      ...actions,
    }),
    [
      conversations,
      archivedConversations,
      archivedConversationIds,
      activeConversationId,
      activeConversation,
      activeMessages,
      activeTypingUsers,
      typingStates,
      drafts,
      activeAnimation,
      supportsMAM,
      activeMAMState,
      actions,
    ]
  )
}
