import { useCallback, useMemo } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { chatStore, connectionStore } from '../stores'
import { useChatStore, useConnectionStore } from '../react/storeHooks'
import { useXMPPContext } from '../provider'
import type { Conversation, ChatStateNotification, FileAttachment, MAMQueryState, Message } from '../core'
import { NS_MAM } from '../core/namespaces'
import { createFetchOlderHistory, pickOldestArchiveId } from './shared'
import { findContinueCatchUpCursor, buildCatchUpStartTime, MAM_CACHE_LOAD_LIMIT, MAM_CATCHUP_FORWARD_MAX, MAM_ROOM_FORWARD_MAX_PAGES_MANUAL } from '../utils/mamCatchUpUtils'

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

  // Target message for scroll-to (from activity log click, etc.)
  const targetMessageId = useChatStore((s) => s.targetMessageId)

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
  // Gap marker sourced from the PERSISTED conversationGaps (survives reload), parity with rooms.
  const mamForwardGapTimestamp = useChatStore((s) => {
    if (!s.activeConversationId) return undefined
    return s.conversationGaps.get(s.activeConversationId)?.start
  })

  const activeMAMState = useMemo((): MAMQueryState | null => {
    if (!activeConversationId) return null
    return {
      isLoading: mamIsLoading,
      hasQueried: mamHasQueried,
      isHistoryComplete: mamIsHistoryComplete,
      isCaughtUpToLive: mamIsCaughtUpToLive,
      oldestFetchedId: mamOldestFetchedId,
      forwardGapTimestamp: mamForwardGapTimestamp,
      error: null,
    }
  }, [activeConversationId, mamIsLoading, mamHasQueried, mamIsHistoryComplete, mamIsCaughtUpToLive, mamOldestFetchedId, mamForwardGapTimestamp])

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

  // Hydrates the message cache before marking active (see chatStore.activateConversation)
  const setActiveConversation = useCallback(async (id: string | null) => {
    await chatStore.getState().activateConversation(id)
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

  const retryMessage = useCallback(
    async (conversationId: string, messageId: string) => {
      const message = chatStore.getState().getMessage(conversationId, messageId)
      if (!message || !message.deliveryError) return

      // Clear the error before resending
      chatStore.getState().updateMessage(conversationId, messageId, { deliveryError: undefined })

      await client.chat.resendMessage(conversationId, message.body, messageId, message.attachment)
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

  const clearTargetMessageId = useCallback(() => {
    chatStore.getState().setTargetMessageId(null)
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
        getOldestMessageId: (id) => pickOldestArchiveId(chatStore.getState().messages.get(id) ?? []),
        getOldestTimestamp: (id) => chatStore.getState().messages.get(id)?.[0]?.timestamp,
        queryMAM: async (id, beforeId) => {
          const conversation = chatStore.getState().conversations.get(id)
          if (conversation) {
            await client.chat.queryMAM({ with: conversation.id, before: beforeId })
          }
        },
        queryMAMByEndTime: async (id, endIso) => {
          const conversation = chatStore.getState().conversations.get(id)
          if (conversation) {
            await client.chat.queryMAM({ with: conversation.id, end: endIso, before: '' })
          }
        },
        errorLogPrefix: 'Failed to fetch older chat history',
      }),
    [client]
  )

  // "Load missing messages": continue a forward catch-up from the recorded gap
  // boundary (parity with rooms' continueRoomCatchUp). Paginates oldest-first to
  // completion via the manual cap.
  const continueChatCatchUp = useCallback(async () => {
    const conversationId = chatStore.getState().activeConversationId
    if (!conversationId) return
    if (connectionStore.getState().status !== 'online') return

    const mamState = chatStore.getState().getMAMQueryState(conversationId)
    if (mamState.isLoading) return

    chatStore.getState().setMAMLoading(conversationId, true)

    try {
      await chatStore.getState().loadMessagesFromCache(conversationId, { limit: MAM_CACHE_LOAD_LIMIT })
      const messages = chatStore.getState().messages.get(conversationId) || []
      const gapStart = chatStore.getState().conversationGaps.get(conversationId)?.start
      const cursor = findContinueCatchUpCursor(messages, gapStart)
      if (cursor?.timestamp) {
        await client.chat.queryMAM({
          with: conversationId,
          start: buildCatchUpStartTime(cursor.timestamp),
          max: MAM_CATCHUP_FORWARD_MAX,
          maxAutoPages: MAM_ROOM_FORWARD_MAX_PAGES_MANUAL,
        })
      }
    } catch {
      // Swallow — the gap marker stays so the user can retry.
    } finally {
      // Always clear the loading flag, even when no cursor was found and no
      // query ran (otherwise the "load missing messages" button spins forever).
      // On the success path queryMAM's own finally already emitted
      // isLoading:false; this idempotent backstop covers the no-query and error
      // paths.
      chatStore.getState().setMAMLoading(conversationId, false)
    }
  }, [client])

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
      retryMessage,
      sendEasterEgg,
      clearAnimation,
      clearTargetMessageId,
      setDraft,
      getDraft,
      clearDraft,
      clearFirstNewMessageId,
      updateLastSeenMessageId,
      fetchHistory,
      fetchOlderHistory,
      continueChatCatchUp,
    }),
    [
      sendMessage, setActiveConversation, addConversation, deleteConversation,
      markAsRead, archiveConversation, unarchiveConversation, isArchived,
      sendChatState, sendReaction, sendCorrection, retractMessage, retryMessage,
      sendEasterEgg, clearAnimation, clearTargetMessageId, setDraft, getDraft, clearDraft,
      clearFirstNewMessageId, updateLastSeenMessageId, fetchHistory, fetchOlderHistory,
      continueChatCatchUp,
    ]
  )

  return useMemo(
    () => ({
      activeConversationId,
      activeConversation,
      activeMessages,
      activeTypingUsers,
      activeAnimation,
      targetMessageId,
      supportsMAM,
      activeMAMState,
      ...actions,
    }),
    [
      activeConversationId, activeConversation, activeMessages,
      activeTypingUsers, activeAnimation, targetMessageId, supportsMAM, activeMAMState,
      actions,
    ]
  )
}
