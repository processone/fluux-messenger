import { useEffect, useRef } from 'react'
import { chatStore } from '../stores/chatStore'
import { roomStore } from '../stores/roomStore'
import { connectionStore } from '../stores/connectionStore'
import { ignoreStore, isMessageFromIgnoredUser, isReplyToIgnoredUser } from '../stores/ignoreStore'
import { isPreviewableMessage, shouldNotifyConversation, shouldNotifyRoom } from '../stores/shared'
import type { Conversation, Message, Room, RoomMessage } from '../core/types'
import { isNoLocalStore } from '../core/types/message-internal'
import { isSpamModerated } from '../utils/moderation'

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
   * Eligibility and room notification settings are described by
   * {@link useNotificationEvents}.
   * @param room - The room that received the message
   * @param message - The new message
   * @param isMention - Whether this message mentions the current user
   */
  onRoomMessage?: (room: Room, message: RoomMessage, isMention: boolean) => void

  /**
   * Called when a conversation's unreadCount drops from >0 to 0 — i.e. it was
   * read. This fires regardless of how the store established the transition,
   * including a local read or a synced cross-device read marker (MDS).
   * Consumers use it to dismiss a delivered native notification that the
   * navigation/focus paths would otherwise leave behind. A sent carbon alone
   * is not read evidence and does not advance the read pointer.
   * @param conversationId - The conversation that became read
   */
  onConversationRead?: (conversationId: string) => void

  /**
   * Called when a room's unreadCount drops from >0 to 0 — see
   * {@link NotificationEventHandlers.onConversationRead} for the rationale.
   * @param roomJid - The room that became read
   */
  onRoomRead?: (roomJid: string) => void
}

/**
 * A transient system notice outside the resident window cannot be viewed
 * later. Resident notices and retrievable messages remain eligible.
 * See useNotificationEvents.invisible.test.tsx for the parked-window cases.
 */
function isVisibleRoomMessage(room: Room, msg: RoomMessage, resident: RoomMessage[] | undefined): boolean {
  if (isSpamModerated(msg)) return false
  if (msg.systemEvent && isNoLocalStore(msg) && !resident?.includes(msg)) return false
  if (!msg.systemEvent && !isPreviewableMessage(msg)) return false
  const ignored = ignoreStore.getState().getIgnoredForRoom(room.jid)
  return !(
    isMessageFromIgnoredUser(ignored, msg, room.nickToJidCache) ||
    isReplyToIgnoredUser(ignored, msg.replyTo, room.nickToJidCache)
  )
}

interface PrevRoomState {
  unreadCount: number
}

/**
 * Hook that detects notification-worthy events and fires callbacks.
 *
 * Centralizes the logic for determining when to notify, so consumers
 * (sound, desktop notifications, badges, etc.) can focus on their specific actions.
 *
 * Message eligibility is shared by all consumers; application preferences,
 * Do Not Disturb and OS permission checks belong to those consumers.
 * This hook applies the following rules:
 * - Skip outgoing messages
 * - For 1:1 conversations: notify only when the message is unseen (unreadCount > 0 and
 *   message id differs from the read pointer); delivery mechanism and message age are not
 *   discriminators — an offline-delivered message is "new to me"
 * - Skip if window is visible AND conversation/room is active
 * - For rooms: use new live arrivals, not message-window growth, so cache reloads
 *   and history fetches do not replay notifications. Arrivals already present at
 *   mount or observed without a handler are not replayed when a handler attaches.
 * - Skip delayed room messages and messages older than 5 minutes; notify for
 *   mentions or when notifyAll/notifyAllPersistent is enabled.
 * - Skip room rows hidden by ignore rules (including replies to ignored users),
 *   spam moderation or absent previewable content. System notices remain
 *   eligible only if resident or eligible for local persistence; visible
 *   retraction placeholders remain eligible. Messages may notify while the
 *   resident window is scrolled away from the live edge.
 *
 * @remarks
 * Uses Zustand store subscriptions instead of reactive hooks to avoid
 * re-rendering the parent component during MAM loading. The subscription
 * callbacks run in response to store changes but don't trigger React re-renders.
 *
 * @example Desktop notifications
 * ```tsx
 * function NotificationHandler() {
 *   const handlers: NotificationEventHandlers = useMemo(() => ({
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

  const prevRoomArrivalsRef = useRef<Map<string, RoomMessage>>(new Map())

  // Last ARRIVED message id we've seen per conversation, mirroring
  // chatStore.lastArrivedMessage. Diffing that store field — rather than the
  // sidebar preview — is what makes one delivery produce exactly one
  // notification: the store writes it only in addMessage past the duplicate
  // early-returns, so it cannot move for a merge, a duplicate echo, or a
  // preview swap. See its declaration in chatStore for the full rationale.
  const prevArrivedMessageIdsRef = useRef<Map<string, string>>(new Map())

  // Watch for new messages in 1:1 conversations
  // Uses Zustand subscribe() to avoid re-rendering the parent component
  useEffect(() => {
    const unsubscribe = chatStore.subscribe((state) => {
      const conversations = Array.from(state.conversations.values())
      const activeConversationId = state.activeConversationId
      const prevConversations = prevConversationsRef.current
      // Defensive default: the field is always present on a real store, but the
      // SDK is consumed by apps that mock chatStore in their own test setups.
      const arrivedMessages = state.lastArrivedMessage ?? new Map()
      const prevArrived = prevArrivedMessageIdsRef.current
      const onConversationMessage = handlersRef.current.onConversationMessage
      const onConversationRead = handlersRef.current.onConversationRead

      if (!onConversationMessage && !onConversationRead) {
        prevConversationsRef.current = conversations
        // Keep the arrival baseline current, or attaching a handler later would
        // replay every delivery buffered since mount as if it were new.
        for (const [id, msg] of arrivedMessages) prevArrived.set(id, msg.id)
        return
      }

      const windowVisible = connectionStore.getState().windowVisible

      for (const conv of conversations) {
        const prevConv = prevConversations.find(c => c.id === conv.id)

        // Read transition: unreadCount dropped from >0 to 0 (for example, a
        // local read or a synced MDS marker). Fire so the consumer can dismiss
        // a lingering native notification.
        if (
          onConversationRead &&
          prevConv &&
          (prevConv.unreadCount ?? 0) > 0 &&
          conv.unreadCount === 0
        ) {
          onConversationRead(conv.id)
        }

        // Did a message ARRIVE in this conversation? Ask the store's arrival
        // signal, which moves once per delivery — never for the preview swaps
        // and merges that also rewrite conv.lastMessage.
        if (onConversationMessage) {
          const arrived = arrivedMessages.get(conv.id)
          if (!arrived) continue
          if (arrived.id === prevArrived.get(conv.id)) continue

          // Mark it seen before deciding: a delivery we chose NOT to notify for
          // has still been handled, and must not be reconsidered on every tick.
          prevArrived.set(conv.id, arrived.id)

          // An undecrypted bodiless stanza may later resolve to a reaction or
          // retraction rather than a user-visible message. It is deliberately
          // excluded from previews, and must not post a blank notification or
          // play the message sound while its contents are still unknown.
          if (!isPreviewableMessage(arrived)) continue

          const isActive = conv.id === activeConversationId
          const notify = shouldNotifyConversation(
            {
              id: arrived.id,
              timestamp: arrived.timestamp,
              isOutgoing: arrived.isOutgoing,
              isDelayed: arrived.isDelayed,
            },
            {
              isActive,
              windowVisible,
              unreadCount: conv.unreadCount,
              readPointer: conv.readPointer,
            }
          )

          // Notify with the message that ARRIVED, not the current preview —
          // they can differ, and the preview would put the wrong body in the
          // banner.
          if (notify) onConversationMessage(conv, arrived)
        }
      }

      prevConversationsRef.current = conversations
    })

    return unsubscribe
  }, [])

  // Watch for new messages/mentions in rooms
  // Uses Zustand subscribe() to avoid re-rendering the parent component
  useEffect(() => {
    prevRoomArrivalsRef.current = roomStore.getState().lastArrivedMessage
    const unsubscribe = roomStore.subscribe((state) => {
      const allRooms = state.allRooms()
      const activeRoomJid = state.activeRoomJid
      const prevRooms = prevRoomsRef.current
      const prevArrivals = prevRoomArrivalsRef.current
      prevRoomArrivalsRef.current = state.lastArrivedMessage
      const onRoomMessage = handlersRef.current.onRoomMessage
      const onRoomRead = handlersRef.current.onRoomRead

      const snapshotRooms = () =>
        new Map(
          allRooms.map(r => [
            r.jid,
            {
              unreadCount: r.unreadCount ?? 0,
            },
          ])
        )

      if (!onRoomMessage && !onRoomRead) {
        // Still update refs even if no handler
        prevRoomsRef.current = snapshotRooms()
        return
      }

      const windowVisible = connectionStore.getState().windowVisible

      for (const room of allRooms) {
        if (!room.joined) continue

        const prev = prevRooms.get(room.jid)

        // Read transition: unreadCount dropped from >0 to 0 (local read or a
        // synced cross-device read marker). Fire so the consumer can dismiss a
        // lingering native notification.
        if (onRoomRead && prev && prev.unreadCount > 0 && (room.unreadCount ?? 0) === 0) {
          onRoomRead(room.jid)
        }

        if (!onRoomMessage) continue

        const msg = state.lastArrivedMessage.get(room.jid)
        if (!msg || msg === prevArrivals.get(room.jid)) continue
        if (!isVisibleRoomMessage(room, msg, state.messages.get(room.jid))) continue

        const result = shouldNotifyRoom(
          {
            id: msg.id,
            timestamp: msg.timestamp,
            isOutgoing: msg.isOutgoing ?? false,
            isDelayed: msg.isDelayed,
            isMention: msg.isMention,
          },
          { isActive: room.jid === activeRoomJid, windowVisible },
          room.notifyAll ?? room.notifyAllPersistent ?? false,
        )

        if (result.shouldNotify) onRoomMessage(room, msg, result.isMention)
      }

      // Update refs
      prevRoomsRef.current = snapshotRooms()
    })

    return unsubscribe
  }, [])
}
