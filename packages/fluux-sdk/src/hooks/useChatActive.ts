import { useCallback, useMemo } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { chatStore, connectionStore } from '../stores'
import { chatSelectors } from '../stores/chatSelectors'
import { useChatStore, useConnectionStore } from '../react/storeHooks'
import { useXMPPContext } from '../provider'
import type { Conversation, MAMQueryState, Message } from '../core'
import { NS_MAM } from '../core/namespaces'
import { useChatActions } from './useChatActions'
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

  // Shared actions sourced from useChatActions (which subscribes to no store,
  // so it adds no re-render triggers). Only the actions this hook already
  // exposed are destructured — the public surface is unchanged. The
  // active-specific actions (retryMessage, scroll-window helpers, catch-up)
  // stay defined below.
  const {
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
    resyncDividerToReadPointer,
    updateLastSeenMessageId,
    fetchHistory,
    fetchOlderHistory,
  } = useChatActions()

  // --- Active conversation state (focused selectors) ---

  const activeConversationId = useChatStore((s) => s.activeConversationId)

  // Use focused selectors from separated entity/meta maps to avoid re-renders
  // when unrelated conversations change. Entity fields (id, name, type) are stable;
  // the new-message divider comes from the session-only firstNewMessageMarkers map.
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
    return s.firstNewMessageMarkers.get(s.activeConversationId)
  })
  // Persisted read pointer (XEP-0490 sync marker) for the active conversation. Drives the FAB badge
  // count and the divider resync-on-scroll-up trigger in MessageList.
  const activeLastSeenMessageId = useChatStore((s) => {
    if (!s.activeConversationId) return undefined
    return s.conversationMeta.get(s.activeConversationId)?.lastSeenMessageId
  })
  // Provisional divider: derived from the local pointer while a synced XEP-0490
  // read position is still unresolved — rendered muted until confirmed.
  const activeFirstNewMessageIsProvisional = useChatStore((s) => {
    if (!s.activeConversationId) return false
    return chatSelectors.firstNewMessageIsProvisionalFor(s.activeConversationId)(s)
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
      // Not used by active view components — sidebar uses useChat() for these
      unreadCount: 0,
      lastMessage: undefined,
      lastReadAt: undefined,
      lastSeenMessageId: undefined,
    }
  }, [activeConversationId, activeConvName, activeConvType])

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

  // --- Active-specific actions (not in useChatActions) ---

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

  const clearTargetMessageId = useCallback(() => {
    chatStore.getState().setTargetMessageId(null)
  }, [])

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
      const gap = chatStore.getState().conversationGaps.get(conversationId)
      const cursor = findContinueCatchUpCursor(messages, gap?.start)
      if (gap?.startId) {
        // Id-exact resume: the recorded seam carries the last-downloaded
        // archive id, immune to same-millisecond timestamp collisions.
        await client.chat.queryMAM({
          with: conversationId,
          after: gap.startId,
          max: MAM_CATCHUP_FORWARD_MAX,
          maxAutoPages: MAM_ROOM_FORWARD_MAX_PAGES_MANUAL,
        })
      } else if (cursor?.timestamp) {
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

  // Hydrate the resident array with the cache slice CONTAINING a specific message, used by scroll
  // restore / search navigation when the target/anchor isn't in the latest-N slice. Bound to the
  // currently-active conversation (the one being viewed when restore runs).
  const loadMessagesAround = useCallback(
    (anchorMessageId: string) => {
      const id = chatStore.getState().activeConversationId
      if (!id) return Promise.resolve([])
      return chatStore.getState().loadMessagesAroundFromCache(id, anchorMessageId)
    },
    []
  )

  // Sliding window: load the next-newer cache slice for the active conversation and append it
  // (evicting the oldest). Driven by the load-newer scroll trigger when scrolled back down.
  const loadNewer = useCallback(() => {
    const id = chatStore.getState().activeConversationId
    if (!id) return Promise.resolve([])
    return chatStore.getState().loadNewerMessagesFromCache(id)
  }, [])

  // Sliding window: reset the resident window to the newest slice (jump-to-latest affordance).
  const recenterToLatest = useCallback(() => {
    const id = chatStore.getState().activeConversationId
    if (!id) return Promise.resolve()
    return chatStore.getState().recenterToLatest(id)
  }, [])

  // Sliding window: whether the resident window includes the newest message. The chat flag is a
  // Map keyed by conversation; absent ⇒ at edge. `false` = slid up (load-newer trigger + jump-to-latest on).
  const activeWindowAtLiveEdge = useChatStore((s) => {
    if (!s.activeConversationId) return true
    return s.windowAtLiveEdge.get(s.activeConversationId) !== false
  })

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
      resyncDividerToReadPointer,
      updateLastSeenMessageId,
      fetchHistory,
      fetchOlderHistory,
      loadMessagesAround,
      loadNewer,
      recenterToLatest,
      continueChatCatchUp,
    }),
    [
      sendMessage, setActiveConversation, addConversation, deleteConversation,
      markAsRead, archiveConversation, unarchiveConversation, isArchived,
      sendChatState, sendReaction, sendCorrection, retractMessage, retryMessage,
      sendEasterEgg, clearAnimation, clearTargetMessageId, setDraft, getDraft, clearDraft,
      clearFirstNewMessageId, resyncDividerToReadPointer, updateLastSeenMessageId, fetchHistory, fetchOlderHistory,
      loadMessagesAround, loadNewer, recenterToLatest, continueChatCatchUp,
    ]
  )

  return useMemo(
    () => ({
      activeConversationId,
      activeConversation,
      firstNewMessageId: activeFirstNewMessageId,
      firstNewMessageIsProvisional: activeFirstNewMessageIsProvisional,
      lastSeenMessageId: activeLastSeenMessageId,
      activeMessages,
      activeTypingUsers,
      activeAnimation,
      targetMessageId,
      supportsMAM,
      activeMAMState,
      windowAtLiveEdge: activeWindowAtLiveEdge,
      ...actions,
    }),
    [
      activeConversationId, activeConversation, activeFirstNewMessageId, activeFirstNewMessageIsProvisional,
      activeLastSeenMessageId, activeMessages,
      activeTypingUsers, activeAnimation, targetMessageId, supportsMAM, activeMAMState,
      activeWindowAtLiveEdge, actions,
    ]
  )
}
