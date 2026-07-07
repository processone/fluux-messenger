import { useMemo } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { useChatStore, useConnectionStore } from '../react/storeHooks'
import type { MAMQueryState, Message } from '../core'
import { NS_MAM } from '../core/namespaces'
import { useChatActions } from './useChatActions'

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
  // Actions live in useChatActions (zero store subscriptions). useChat composes
  // it and adds the conversation-list/active-conversation state subscriptions
  // below — so the action definitions exist ONCE (they previously drifted
  // between the two hooks).
  const actions = useChatActions()

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

  // NOTE: useChat() deliberately does NOT subscribe to the whole typingStates /
  // drafts Maps. Those are replaced on every keystroke in ANY conversation, so a
  // list-level subscription would storm every useChat() consumer (the sidebar
  // conversation list, command palette) during background activity. Per-conversation
  // typing and drafts are read inside the memoized ConversationItem via narrow
  // selectors: useChatStore((s) => s.typingStates.get(id)). The active
  // conversation's typing indicator is covered by activeTypingUsers above.

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
      activeAnimation,
      supportsMAM,
      activeMAMState,
      actions,
    ]
  )
}
