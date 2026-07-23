import { useCallback, useMemo } from 'react'
import { chatStore } from '../stores/chatStore'
import { connectionStore } from '../stores/connectionStore'
import { useXMPPContext } from '../provider'
import type { Conversation, ChatStateNotification, FileAttachment } from '../core'
import { createFetchOlderHistory, pickOldestArchiveId } from './shared'

/**
 * Action-only counterpart to `useChat()`.
 *
 * Returns the same actions as `useChat()` but performs ZERO store subscriptions.
 * Use this in components that only need to invoke chat actions and do not need
 * to react to chat state changes.
 *
 * Calling `useChat()` subscribes the component to many chat store values
 * (`conversations`, `activeMessages`, `typingStates`, `drafts`, MAM state, etc.).
 * `useChatActions()` reads actions directly via `chatStore.getState()`, avoiding
 * any subscription.
 *
 * @returns A stable object of chat action callbacks
 *
 * @category Hooks
 */
export function useChatActions() {
  const { client } = useXMPPContext()

  const sendMessage = useCallback(
    async (
      to: string,
      body: string,
      options?: {
        replyTo?: { id: string; to?: string; fallback?: { author: string; body: string } }
        attachment?: FileAttachment
      }
    ): Promise<string> => {
      // 1:1 chat hook: always a 'chat'-type message (rooms use useRoomActions).
      return await client.chat.sendMessage(to, body, 'chat', options?.replyTo, undefined, options?.attachment)
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

  const markReadToNewest = useCallback((conversationId: string) => {
    chatStore.getState().markReadToNewest(conversationId)
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

  const resyncDividerToReadPointer = useCallback((conversationId: string) => {
    chatStore.getState().resyncDividerToReadPointer(conversationId)
  }, [])

  const advanceReadPointer = useCallback((conversationId: string, messageId: string) => {
    chatStore.getState().advanceReadPointer(conversationId, messageId)
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

        // Latest-first orchestrator (same as chatSideEffects' active-conversation
        // catch-up). The ACTIVE conversation must not stitch: Phase B's
        // keep-oldest-evict would trim its resident live edge out from under the
        // open view. A NON-active target (e.g. background prefetch for a conversation
        // the user isn't looking at) SHOULD stitch, so its unread region becomes
        // contiguous with the read pointer instead of leaving a gap.
        const isActive = targetId === chatStore.getState().activeConversationId
        await client.mam.catchUpConversationHistory(conversation.id, cachedMessages ?? [], {
          stitchReadPointer: !isActive,
        })
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
        clearInvalidArchiveCursor: (id, cursor) => chatStore.getState().clearMessageStanzaId(id, cursor),
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

  return useMemo(
    () => ({
      sendMessage,
      setActiveConversation,
      addConversation,
      deleteConversation,
      markAsRead,
      markReadToNewest,
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
      resyncDividerToReadPointer,
      advanceReadPointer,
      fetchHistory,
      fetchOlderHistory,
    }),
    [
      sendMessage,
      setActiveConversation,
      addConversation,
      deleteConversation,
      markAsRead,
      markReadToNewest,
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
      resyncDividerToReadPointer,
      advanceReadPointer,
      fetchHistory,
      fetchOlderHistory,
    ]
  )
}
