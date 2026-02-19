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
 * Lightweight hook for components that display the active conversation.
 *
 * Unlike `useChat()`, this hook does NOT subscribe to the conversation list
 * (`conversationsRaw`), which prevents re-renders when background MAM sync
 * updates other conversations. Use this in ChatView, MessageComposer, and
 * other components that only need active conversation state + actions.
 *
 * For sidebar/conversation list rendering, use `useChat()` which provides
 * the full `conversations` array.
 *
 * @returns Active conversation state and all chat actions
 *
 * @example
 * ```tsx
 * function ChatView() {
 *   const { activeConversation, activeMessages, sendMessage } = useChatActive()
 *   // Only re-renders when active conversation changes, not on background sync
 * }
 * ```
 *
 * @category Hooks
 */
export function useChatActive() {
  const { client } = useXMPPContext()

  // --- Active conversation state (focused selectors) ---

  const activeConversationId = useChatStore((s) => s.activeConversationId)

  // Use focused selectors from separated entity/meta maps to avoid re-renders
  // when unrelated conversations change. Entity fields (id, name, type) are stable;
  // metadata fields (firstNewMessageId) change rarely compared to lastMessage/unreadCount.
  const activeConvName = useChatStore((s) => {
    if (!s.activeConversationId) return null
    return s.conversationEntities.get(s.activeConversationId)?.name ?? null
  })
  const activeConvType = useChatStore((s) => {
    if (!s.activeConversationId) return null
    return s.conversationEntities.get(s.activeConversationId)?.type ?? null
  })
  const activeFirstNewMessageId = useChatStore((s) => {
    if (!s.activeConversationId) return undefined
    return s.conversationMeta.get(s.activeConversationId)?.firstNewMessageId
  })

  // Reconstruct a stable activeConversation object from individual primitive fields.
  // Only changes when the specific fields change, not when lastMessage/unreadCount
  // change on background sync of other conversations.
  const activeConversation = useMemo((): Conversation | null => {
    if (!activeConversationId || activeConvName === null || !activeConvType) return null
    return {
      id: activeConversationId,
      name: activeConvName,
      type: activeConvType,
      firstNewMessageId: activeFirstNewMessageId,
      // Not used by active view components — sidebar uses useChat() for these
      unreadCount: 0,
      lastMessage: undefined,
      lastReadAt: undefined,
      lastSeenMessageId: undefined,
    }
  }, [activeConversationId, activeConvName, activeConvType, activeFirstNewMessageId])

  // Don't use useShallow for messages - when messages are prepended, we need React to re-render
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

  // Easter egg animation state
  const activeAnimation = useChatStore((s) => s.activeAnimation)

  // XEP-0313: MAM support
  const supportsMAM = useConnectionStore((s) => {
    return s.serverInfo?.features?.includes(NS_MAM) ?? false
  })

  // Get MAM query state for active conversation (individual fields for granularity)
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

  // --- Actions (all stable callbacks) ---

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

  const setActiveConversation = useCallback(async (id: string | null) => {
    if (id) {
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

  const fetchHistory = useCallback(
    async (conversationId?: string): Promise<void> => {
      const connectionStatus = connectionStore.getState().status
      if (connectionStatus !== 'online') return

      const targetId = conversationId ?? chatStore.getState().activeConversationId
      if (!targetId) return

      const conversation = chatStore.getState().conversations.get(targetId)
      if (!conversation || conversation.type !== 'chat') return

      const mamState = chatStore.getState().getMAMQueryState(targetId)
      if (mamState.isLoading) return

      chatStore.getState().setMAMLoading(targetId, true)

      try {
        let cachedMessages = chatStore.getState().messages.get(targetId)
        if (!cachedMessages || cachedMessages.length === 0) {
          await chatStore.getState().loadMessagesFromCache(targetId, { limit: 100 })
          cachedMessages = chatStore.getState().messages.get(targetId)
        }

        const newestCachedMessage = cachedMessages?.[cachedMessages.length - 1]
        const queryOptions: { with: string; start?: string } = { with: conversation.id }

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

  // --- Return ---

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
      sendMessage, setActiveConversation, addConversation, deleteConversation,
      markAsRead, archiveConversation, unarchiveConversation, isArchived,
      sendChatState, sendReaction, sendCorrection, retractMessage,
      sendEasterEgg, clearAnimation, setDraft, getDraft, clearDraft,
      clearFirstNewMessageId, updateLastSeenMessageId, fetchHistory, fetchOlderHistory,
    ]
  )

  return useMemo(
    () => ({
      activeConversationId,
      activeConversation,
      activeMessages,
      activeTypingUsers,
      activeAnimation,
      supportsMAM,
      activeMAMState,
      ...actions,
    }),
    [
      activeConversationId, activeConversation, activeMessages,
      activeTypingUsers, activeAnimation, supportsMAM, activeMAMState,
      actions,
    ]
  )
}
