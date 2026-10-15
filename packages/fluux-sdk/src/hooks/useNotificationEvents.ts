import { useEffect, useRef } from 'react'
import { chatStore } from '../stores/chatStore'
import { roomStore } from '../stores/roomStore'
import { connectionStore } from '../stores/connectionStore'
import { ignoreStore, isMessageFromIgnoredUser, isReplyToIgnoredUser } from '../stores/ignoreStore'
import { isPreviewableMessage, shouldNotifyConversation, shouldNotifyRoom } from '../stores/shared'
import type { Conversation, Message, Room, RoomMessage } from '../core/types'
import { isNoLocalStore } from '../core/types/message-internal'
import { isSpamModerated } from '../utils/moderation'
import { getBareJid } from '../core/jid'
import { checkForMention } from '../core/mentionDetection'
import { findNotificationMessage, isNotificationMessageReady, isNotificationMessageUnread, resolveNotificationMessage } from '../utils/notificationMessage'
import { subscribeMessageCacheUpdates } from '../utils/messageCacheUpdates'
import { getStorageScopeJid } from '../utils/storageScope'

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
function isVisibleRoomMessage(room: Room, msg: RoomMessage, resident: RoomMessage[] | undefined, checkContent = true): boolean {
  if (isSpamModerated(msg)) return false
  if (msg.systemEvent && isNoLocalStore(msg) && !resident?.includes(msg)) return false
  if (checkContent && !msg.systemEvent && !isPreviewableMessage(msg)) return false
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
 * - Hold unresolved encrypted or empty arrivals until their content becomes usable.
 *   Re-evaluate only those held arrivals after a repair, checking that they remain
 *   after the read boundary; cache imports are not arrivals.
 *   Unsupported encryption notices remain eligible without waiting for decryption.
 * - Skip outgoing messages
 * - For 1:1 conversations: notify only when the message is unseen (unreadCount > 0 and
 *   message row differs from the read pointer); delivery mechanism and message age are not
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

  useEffect(() => {
    const pendingChats = new Map<string, Message[]>()
    const pendingRooms = new Map<string, RoomMessage[]>()
    let account = getBareJid(connectionStore.getState().jid ?? '')
    let stopped = false

    const remove = <T,>(pending: Map<string, T[]>, id: string, message: T) => {
      const remaining = pending.get(id)?.filter(candidate => candidate !== message) ?? []
      if (remaining.length) pending.set(id, remaining)
      else pending.delete(id)
    }
    const finishChat = (conv: Conversation, held: Message, message: Message, activeId: string | null) => {
      if (!isNotificationMessageReady(message) && !message.isRetracted) return
      remove(pendingChats, conv.id, held)
      if (message.isRetracted || !isNotificationMessageUnread(message, conv.readPointer)) return
      if (shouldNotifyConversation(message, {
        isActive: conv.id === activeId,
        windowVisible: connectionStore.getState().windowVisible,
        unreadCount: conv.unreadCount,
        readPointer: conv.readPointer,
      })) handlersRef.current.onConversationMessage?.(conv, message)
    }
    const finishRoom = (room: Room, held: RoomMessage, message: RoomMessage, state: ReturnType<typeof roomStore.getState>) => {
      if (!isNotificationMessageReady(message) && !message.isRetracted) return
      remove(pendingRooms, room.jid, held)
      if (!room.joined || message.isRetracted || !isNotificationMessageUnread(message, room.readPointer) ||
        !isVisibleRoomMessage(room, message, state.messages.get(room.jid))) return
      // Mentions sealed inside a payload become observable only after recovery.
      const isMention = message.isMentionAll || checkForMention(message.body, room.nickname) || /@all\b/i.test(message.body)
      const recovered = { ...message, isMention }
      const result = shouldNotifyRoom(recovered, {
        isActive: room.jid === state.activeRoomJid,
        windowVisible: connectionStore.getState().windowVisible,
      }, room.notifyAll ?? room.notifyAllPersistent ?? false)
      if (result.shouldNotify) handlersRef.current.onRoomMessage?.(room, recovered, result.isMention)
    }

    const unsubscribeChat = chatStore.subscribe(state => {
      const conversations = Array.from(state.conversations.values())
      const previous = prevConversationsRef.current
      prevConversationsRef.current = conversations
      const arrivals = state.lastArrivedMessage ?? new Map<string, Message>()
      const { onConversationMessage, onConversationRead } = handlersRef.current
      for (const conv of conversations) {
        const prev = previous.find(candidate => candidate.id === conv.id)
        if (conv.unreadCount === 0) pendingChats.delete(conv.id)
        if (prev && prev.unreadCount > 0 && conv.unreadCount === 0) onConversationRead?.(conv.id)
        if (onConversationMessage) {
          for (const held of pendingChats.get(conv.id) ?? []) {
            const current = findNotificationMessage(held, [
              ...(state.messages?.get(conv.id) ?? []), ...(conv.lastMessage ? [conv.lastMessage] : []),
            ])
            if (current) finishChat(conv, held, current, state.activeConversationId)
          }
        } else pendingChats.delete(conv.id)

        const arrived = arrivals.get(conv.id)
        if (!arrived || arrived.id === prevArrivedMessageIdsRef.current.get(conv.id)) continue
        prevArrivedMessageIdsRef.current.set(conv.id, arrived.id)
        if (!onConversationMessage || !shouldNotifyConversation(arrived, {
          isActive: conv.id === state.activeConversationId,
          windowVisible: connectionStore.getState().windowVisible,
          unreadCount: conv.unreadCount,
          readPointer: conv.readPointer,
        })) continue
        if (!isNotificationMessageReady(arrived)) {
          const pending = pendingChats.get(conv.id) ?? []
          pendingChats.set(conv.id, [...pending, arrived])
        } else onConversationMessage(conv, arrived)
      }
      for (const id of pendingChats.keys()) if (!state.conversations.has(id)) pendingChats.delete(id)
    })

    prevRoomArrivalsRef.current = roomStore.getState().lastArrivedMessage
    const unsubscribeRoom = roomStore.subscribe(state => {
      const rooms = state.allRooms()
      const previous = prevRoomsRef.current
      const arrivals = prevRoomArrivalsRef.current
      prevRoomArrivalsRef.current = state.lastArrivedMessage
      prevRoomsRef.current = new Map(rooms.map(room => [room.jid, { unreadCount: room.unreadCount ?? 0 }]))
      const { onRoomMessage, onRoomRead } = handlersRef.current
      for (const room of rooms) {
        if (room.unreadCount === 0 && previous.get(room.jid)?.unreadCount) pendingRooms.delete(room.jid)
        if (previous.get(room.jid)?.unreadCount && room.unreadCount === 0) onRoomRead?.(room.jid)
        if (!onRoomMessage || !room.joined) { pendingRooms.delete(room.jid); continue }
        for (const held of pendingRooms.get(room.jid) ?? []) {
          const current = findNotificationMessage(held, [
            ...(state.messages.get(room.jid) ?? []), ...(room.lastMessage ? [room.lastMessage] : []),
          ])
          if (current) finishRoom(room, held, current, state)
        }
        const message = state.lastArrivedMessage.get(room.jid)
        if (!message || message === arrivals.get(room.jid)) continue
        const ready = message.systemEvent ? !message.encryptedPayload : isNotificationMessageReady(message)
        if (!isVisibleRoomMessage(room, message, state.messages.get(room.jid), ready)) continue
        const result = shouldNotifyRoom(message, {
          isActive: room.jid === state.activeRoomJid,
          windowVisible: connectionStore.getState().windowVisible,
        }, ready ? room.notifyAll ?? room.notifyAllPersistent ?? false : true)
        if (!result.shouldNotify) continue
        if (ready) onRoomMessage(room, message, result.isMention)
        else pendingRooms.set(room.jid, [...(pendingRooms.get(room.jid) ?? []), message])
      }
      for (const id of pendingRooms.keys()) if (!state.rooms.has(id)) pendingRooms.delete(id)
    })

    // Off-window repairs can commit only to IndexedDB; they still resolve an
    // arrival held by this hook, without turning cache writes into arrivals.
    const unsubscribeCache = subscribeMessageCacheUpdates(event => {
      if (event.account !== getStorageScopeJid()) return
      const currentAccount = account
      const recover = async (held: Message | RoomMessage) => {
        const message = await resolveNotificationMessage(held)
        if (!message || stopped || account !== currentAccount) return
        if (message.type === 'chat') {
          if (!pendingChats.get(event.conversationId)?.includes(held as Message)) return
          const state = chatStore.getState()
          const conv = state.conversations.get(event.conversationId)
          if (conv) finishChat(conv, held as Message, message, state.activeConversationId)
        } else {
          if (!pendingRooms.get(event.conversationId)?.includes(held as RoomMessage)) return
          const state = roomStore.getState()
          const room = state.rooms.get(event.conversationId)
          if (room) finishRoom(room, held as RoomMessage, message, state)
        }
      }
      const pending = event.kind === 'chat' ? pendingChats.get(event.conversationId) : pendingRooms.get(event.conversationId)
      for (const held of pending ?? []) {
        if (findNotificationMessage(held, [event.target])) void recover(held)
      }
    })
    const unsubscribeAccount = connectionStore.subscribe?.(state => {
      const nextAccount = getBareJid(state.jid ?? '')
      if (nextAccount === account) return
      account = nextAccount
      pendingChats.clear()
      pendingRooms.clear()
      prevArrivedMessageIdsRef.current.clear()
      prevRoomArrivalsRef.current = roomStore.getState().lastArrivedMessage
      prevConversationsRef.current = []
      prevRoomsRef.current.clear()
    })
    return () => {
      stopped = true
      pendingChats.clear()
      pendingRooms.clear()
      unsubscribeChat()
      unsubscribeRoom()
      unsubscribeCache()
      unsubscribeAccount?.()
    }
  }, [])
}
