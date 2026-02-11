import { useEffect, useRef } from 'react'
import { chatStore, roomStore, connectionStore } from '../stores'
import { shouldNotifyConversation, shouldNotifyRoom } from '../stores/shared'
import type { Conversation, Message, Room, RoomMessage } from '../core/types'

/**
 * Handlers for notification-worthy events.
 */
export interface NotificationEventHandlers {
  /**
   * Called when a new message arrives in a 1:1 conversation that warrants notification.
   * Only fires for incoming messages when window is not visible or conversation is not active.
   * @param conversation - The conversation that received the message
   * @param message - The new message
   */
  onConversationMessage?: (conversation: Conversation, message: Message) => void

  /**
   * Called when a new message arrives in a room that warrants notification.
   * Fires for mentions (always) or all messages (when notifyAll is enabled).
   * Only fires when window is not visible or room is not active.
   * @param room - The room that received the message
   * @param message - The new message
   * @param isMention - Whether this message mentions the current user
   */
  onRoomMessage?: (room: Room, message: RoomMessage, isMention: boolean) => void
}

interface PrevRoomState {
  mentionsCount: number
  messagesLength: number
}

/**
 * Hook that detects notification-worthy events and fires callbacks.
 *
 * Centralizes the logic for determining when to notify, so consumers
 * (sound, desktop notifications, badges, etc.) can focus on their specific actions.
 *
 * This hook handles all the filtering logic:
 * - Skip outgoing messages
 * - Skip delayed/historical messages (from MAM)
 * - Skip messages older than 5 minutes
 * - Skip if window is visible AND conversation/room is active
 * - For rooms: respect notifyAll/notifyAllPersistent settings
 *
 * @remarks
 * Uses Zustand store subscriptions instead of reactive hooks to avoid
 * re-rendering the parent component during MAM loading. The subscription
 * callbacks run in response to store changes but don't trigger React re-renders.
 *
 * @example Desktop notifications
 * ```tsx
 * function NotificationHandler() {
 *   const handlers = useMemo(() => ({
 *     onConversationMessage: (conv, msg) => {
 *       new Notification(conv.name, { body: msg.body })
 *     },
 *     onRoomMessage: (room, msg, isMention) => {
 *       const title = isMention ? `Mention in ${room.name}` : room.name
 *       new Notification(title, { body: msg.body })
 *     }
 *   }), [])
 *
 *   useNotificationEvents(handlers)
 *   return null
 * }
 * ```
 *
 * @example Sound notifications
 * ```tsx
 * function SoundNotificationHandler() {
 *   const playSound = useCallback(() => {
 *     const audio = new Audio('/notification.wav')
 *     audio.play()
 *   }, [])
 *
 *   useNotificationEvents({
 *     onConversationMessage: playSound,
 *     onRoomMessage: playSound
 *   })
 *   return null
 * }
 * ```
 *
 * @param handlers - Callbacks to fire when notification-worthy events occur
 * @category Hooks
 */
export function useNotificationEvents(handlers: NotificationEventHandlers): void {
  // Store handlers in refs to avoid re-running effects when callbacks change
  const handlersRef = useRef(handlers)
  useEffect(() => {
    handlersRef.current = handlers
  }, [handlers])

  // Track previous state for change detection
  const prevConversationsRef = useRef<Conversation[]>([])
  const prevRoomsRef = useRef<Map<string, PrevRoomState>>(new Map())

  // Watch for new messages in 1:1 conversations
  // Uses Zustand subscribe() to avoid re-rendering the parent component
  useEffect(() => {
    const unsubscribe = chatStore.subscribe((state) => {
      const conversations = Array.from(state.conversations.values())
      const activeConversationId = state.activeConversationId
      const prevConversations = prevConversationsRef.current
      const onConversationMessage = handlersRef.current.onConversationMessage

      if (!onConversationMessage) {
        prevConversationsRef.current = conversations
        return
      }

      const windowVisible = connectionStore.getState().windowVisible

      for (const conv of conversations) {
        const prevConv = prevConversations.find(c => c.id === conv.id)

        // Check if this conversation has a new message
        if (conv.lastMessage) {
          const isNewMessage = !prevConv?.lastMessage ||
            prevConv.lastMessage.id !== conv.lastMessage.id
          if (!isNewMessage) continue

          const isActive = conv.id === activeConversationId
          const notify = shouldNotifyConversation(
            {
              id: conv.lastMessage.id,
              timestamp: conv.lastMessage.timestamp,
              isOutgoing: conv.lastMessage.isOutgoing,
              isDelayed: conv.lastMessage.isDelayed,
            },
            { isActive, windowVisible }
          )

          if (notify) {
            onConversationMessage(conv, conv.lastMessage)
          }
        }
      }

      prevConversationsRef.current = conversations
    })

    return unsubscribe
  }, [])

  // Watch for new messages/mentions in rooms
  // Uses Zustand subscribe() to avoid re-rendering the parent component
  useEffect(() => {
    const unsubscribe = roomStore.subscribe((state) => {
      const allRooms = state.allRooms()
      const activeRoomJid = state.activeRoomJid
      const prevRooms = prevRoomsRef.current
      const onRoomMessage = handlersRef.current.onRoomMessage

      if (!onRoomMessage) {
        // Still update refs even if no handler
        prevRoomsRef.current = new Map(
          allRooms.map(r => [r.jid, { mentionsCount: r.mentionsCount, messagesLength: r.messages.length }])
        )
        return
      }

      const windowVisible = connectionStore.getState().windowVisible

      for (const room of allRooms) {
        if (!room.joined) continue

        const prev = prevRooms.get(room.jid)
        const prevMessagesLength = prev?.messagesLength ?? 0
        const hasNewMessages = room.messages.length > prevMessagesLength
        const newMessageCount = room.messages.length - prevMessagesLength

        if (!hasNewMessages) continue

        // Skip if this looks like initial history load (many messages at once from empty state)
        if (prevMessagesLength === 0 && newMessageCount > 5) continue

        const notifyAllEnabled = room.notifyAll ?? room.notifyAllPersistent ?? false
        const isActive = room.jid === activeRoomJid

        // Find the most recent message that warrants notification
        const searchStartIndex = room.messages.length - 1
        const searchEndIndex = Math.max(0, room.messages.length - newMessageCount)

        for (let i = searchStartIndex; i >= searchEndIndex; i--) {
          const msg = room.messages[i]

          const result = shouldNotifyRoom(
            {
              id: msg.id,
              timestamp: msg.timestamp,
              isOutgoing: msg.isOutgoing ?? false,
              isDelayed: msg.isDelayed,
              isMention: msg.isMention,
            },
            { isActive, windowVisible },
            notifyAllEnabled
          )

          if (result.shouldNotify) {
            onRoomMessage(room, msg, result.isMention)
            break // Only notify for the latest relevant message
          }

          // If we're only looking for mentions and this isn't one, stop searching
          if (!notifyAllEnabled && !msg.isMention) break
        }
      }

      // Update refs
      prevRoomsRef.current = new Map(
        allRooms.map(r => [r.jid, { mentionsCount: r.mentionsCount, messagesLength: r.messages.length }])
      )
    })

    return unsubscribe
  }, [])
}
