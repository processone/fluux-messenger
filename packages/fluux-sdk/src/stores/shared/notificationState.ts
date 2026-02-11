/**
 * Notification state machine — pure transition functions.
 *
 * This module is the single source of truth for all notification-related
 * state transitions (unread counts, new message markers, last seen position).
 * Both chatStore and roomStore delegate their notification logic here.
 *
 * All functions are pure: (state, event) → newState, with no side effects.
 * This makes them trivially testable and guarantees consistency across stores.
 *
 * Key invariant: unreadCount, firstNewMessageId, lastReadAt, and lastSeenMessageId
 * are always updated atomically through these transition functions.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Notification state for a single entity (conversation or room).
 *
 * This is the canonical representation of all notification-related metadata.
 * chatStore and roomStore delegate ALL notification state transitions to
 * the pure functions in this module to guarantee consistency.
 */
export interface EntityNotificationState {
  /** Number of unread messages. Always 0 when user is actively viewing. */
  unreadCount: number
  /** Number of @-mentions (rooms only, 0 for conversations). */
  mentionsCount: number
  /**
   * When this entity was last read by the user.
   * Used as a reference timestamp for various operations.
   * Set to epoch (Date(0)) when first unread arrives and lastReadAt was undefined.
   */
  lastReadAt?: Date
  /**
   * ID of the last message the user actually saw in the viewport.
   * Updated via IntersectionObserver as the user scrolls.
   * Only advances forward (never goes backwards).
   * Persisted across sessions.
   */
  lastSeenMessageId?: string
  /**
   * ID of the first unread message for the visual "new messages" divider.
   * Set when user opens entity with messages after lastSeenMessageId.
   * Cleared on: entity deactivation, outgoing message, or explicit clear.
   */
  firstNewMessageId?: string
}

/** Minimal message shape needed for notification decisions. */
export interface NotificationMessage {
  id: string
  timestamp: Date
  isOutgoing: boolean
  isDelayed?: boolean
  isMention?: boolean
}

/** Context about the entity's current visibility. */
export interface EntityContext {
  isActive: boolean
  windowVisible: boolean
}

/** Options for message-received notification handling. */
export interface MessageReceivedOptions {
  /** Whether to increment unreadCount (default: true for incoming non-delayed) */
  incrementUnread?: boolean
  /** Whether to increment mentionsCount (rooms only) */
  incrementMentions?: boolean
  /**
   * If true, treat delayed messages as regular incoming messages for unread counting.
   * Needed for 1:1 chats where isDelayed means "offline delivery" (new messages
   * sent while user was offline), unlike rooms where isDelayed means "MUC history replay".
   */
  treatDelayedAsNew?: boolean
}

// ---------------------------------------------------------------------------
// Transition Functions
// ---------------------------------------------------------------------------

/**
 * Compute new notification state when a message arrives.
 *
 * Rules:
 * - Outgoing message: clear unread + mentions, update lastReadAt, clear marker
 * - Delayed/historical: no changes (preserve existing state)
 * - Incoming + user sees message: no unread increment, update lastReadAt
 * - Incoming + user doesn't see + entity active + window hidden: set marker if not set
 * - Incoming + user doesn't see + entity not active: increment unread, don't set marker
 */
export function onMessageReceived(
  state: EntityNotificationState,
  msg: NotificationMessage,
  ctx: EntityContext,
  options?: MessageReceivedOptions
): EntityNotificationState {
  const { incrementUnread = true, incrementMentions = false, treatDelayedAsNew = false } = options ?? {}
  const userSeesMessage = ctx.isActive && ctx.windowVisible

  // Outgoing message: user is actively engaging, clear notification state
  if (msg.isOutgoing) {
    return {
      unreadCount: 0,
      mentionsCount: 0,
      lastReadAt: msg.timestamp,
      lastSeenMessageId: state.lastSeenMessageId,
      firstNewMessageId: undefined,
    }
  }

  // Delayed/historical: preserve existing state unchanged
  // Exception: treatDelayedAsNew allows delayed messages to be treated as new
  // (used for 1:1 offline delivery where isDelayed means "sent while offline")
  if (msg.isDelayed && !treatDelayedAsNew) {
    return state
  }

  // User sees the message: update lastReadAt, keep unread at 0
  if (userSeesMessage) {
    return {
      unreadCount: 0,
      mentionsCount: 0,
      lastReadAt: msg.timestamp,
      lastSeenMessageId: state.lastSeenMessageId,
      firstNewMessageId: state.firstNewMessageId,
    }
  }

  // User doesn't see the message
  const newUnreadCount = incrementUnread ? state.unreadCount + 1 : state.unreadCount
  const newMentionsCount = incrementMentions ? state.mentionsCount + 1 : state.mentionsCount

  // Initialize lastReadAt to epoch if undefined (so marker position is correct)
  const newLastReadAt = state.lastReadAt === undefined ? new Date(0) : state.lastReadAt

  // Set marker if: entity is active AND window hidden AND no existing marker
  const newFirstNewMessageId =
    ctx.isActive && !ctx.windowVisible && !state.firstNewMessageId
      ? msg.id
      : state.firstNewMessageId

  return {
    unreadCount: newUnreadCount,
    mentionsCount: newMentionsCount,
    lastReadAt: newLastReadAt,
    lastSeenMessageId: state.lastSeenMessageId,
    firstNewMessageId: newFirstNewMessageId,
  }
}

/**
 * Compute new notification state when user opens/activates an entity.
 *
 * Scans messages to find the first unseen message (after lastSeenMessageId)
 * and sets the marker, then marks as read.
 *
 * The marker is placed at the first incoming (non-outgoing, non-delayed) message
 * after the lastSeenMessageId position.
 */
export function onActivate(
  state: EntityNotificationState,
  messages: NotificationMessage[]
): EntityNotificationState {
  let firstNewMessageId: string | undefined = undefined
  let updatedLastSeenMessageId = state.lastSeenMessageId

  if (state.lastSeenMessageId && messages.length > 0) {
    // Find the position of the last seen message
    const lastSeenIdx = messages.findIndex((m) => m.id === state.lastSeenMessageId)

    if (lastSeenIdx !== -1) {
      // Scan forward from lastSeenMessageId to find first unseen incoming message
      for (let i = lastSeenIdx + 1; i < messages.length; i++) {
        const msg = messages[i]
        if (!msg.isOutgoing && !msg.isDelayed) {
          firstNewMessageId = msg.id
          break
        }
      }
    } else {
      // lastSeenMessageId not found in loaded messages — it's older than the
      // loaded slice (e.g., cache loaded latest 100 of 500+ messages).
      // Use lastReadAt as a timestamp-based fallback to find the correct
      // marker position within the loaded messages.
      if (state.lastReadAt) {
        const fallbackReadAt = state.lastReadAt instanceof Date
          ? state.lastReadAt
          : new Date(state.lastReadAt as unknown as string)
        const firstNew = messages.find(
          (msg) => msg.timestamp > fallbackReadAt && !msg.isOutgoing && !msg.isDelayed
        )
        if (firstNew) {
          firstNewMessageId = firstNew.id
        }
      } else if (state.unreadCount > 0) {
        // No lastReadAt available either — absolute last resort.
        const firstIncoming = messages.find((m) => !m.isOutgoing && !m.isDelayed)
        if (firstIncoming) {
          firstNewMessageId = firstIncoming.id
        }
      }

      // Update stale lastSeenMessageId to the last message in the loaded array
      // so subsequent activations don't repeat the stale-ID fallback path.
      const lastMsg = messages[messages.length - 1]
      if (lastMsg) {
        updatedLastSeenMessageId = lastMsg.id
      }
    }
  } else if (!state.lastSeenMessageId && state.lastReadAt) {
    // No lastSeenMessageId yet (migration path) — fall back to lastReadAt
    const lastReadAt = state.lastReadAt instanceof Date
      ? state.lastReadAt
      : new Date(state.lastReadAt as unknown as string)
    const firstNew = messages.find(
      (msg) => msg.timestamp > lastReadAt && !msg.isOutgoing && !msg.isDelayed
    )
    if (firstNew) {
      firstNewMessageId = firstNew.id
    }
  }

  // Mark as read: set lastReadAt to last message timestamp, clear unread
  const lastMessage = messages[messages.length - 1]
  const lastReadAt = lastMessage?.timestamp ?? state.lastReadAt ?? new Date()

  return {
    unreadCount: 0,
    mentionsCount: 0,
    lastReadAt,
    lastSeenMessageId: updatedLastSeenMessageId,
    firstNewMessageId,
  }
}

/**
 * Compute new notification state when user leaves/deactivates an entity.
 * Clears the firstNewMessageId marker.
 *
 * This replaces the useNewMessageMarker React hook's cleanup effect.
 */
export function onDeactivate(
  state: EntityNotificationState
): EntityNotificationState {
  if (!state.firstNewMessageId) return state
  return {
    ...state,
    firstNewMessageId: undefined,
  }
}

/**
 * Compute new notification state when entity is explicitly marked as read.
 *
 * Clears unreadCount and mentionsCount, updates lastReadAt.
 * Preserves firstNewMessageId — the marker has a separate lifecycle
 * (set on activate, cleared on deactivate or explicit clear).
 */
export function onMarkAsRead(
  state: EntityNotificationState,
  lastMessageTimestamp?: Date
): EntityNotificationState {
  const lastReadAt = lastMessageTimestamp ?? new Date()
  // Skip update if nothing to change (prevents unnecessary state updates)
  const existingTime = state.lastReadAt instanceof Date
    ? state.lastReadAt.getTime()
    : state.lastReadAt ? new Date(state.lastReadAt as unknown as string).getTime() : 0
  if (state.unreadCount === 0 && state.mentionsCount === 0 && existingTime === lastReadAt.getTime()) {
    return state
  }
  return {
    ...state,
    unreadCount: 0,
    mentionsCount: 0,
    lastReadAt,
  }
}

/**
 * Clear the firstNewMessageId marker.
 * Called when the user scrolls past the marker or explicitly dismisses it.
 */
export function onClearMarker(
  state: EntityNotificationState
): EntityNotificationState {
  if (!state.firstNewMessageId) return state
  return {
    ...state,
    firstNewMessageId: undefined,
  }
}

/**
 * Compute new notification state when the window becomes visible/focused
 * while this entity is active.
 *
 * When the user returns to the window and the entity is active,
 * we mark it as read (the user is now seeing the messages).
 */
export function onWindowBecameVisible(
  state: EntityNotificationState,
  isActive: boolean,
  lastMessageTimestamp?: Date
): EntityNotificationState {
  if (!isActive) return state
  if (state.unreadCount === 0 && state.mentionsCount === 0) return state

  return {
    ...state,
    unreadCount: 0,
    mentionsCount: 0,
    lastReadAt: lastMessageTimestamp ?? state.lastReadAt ?? new Date(),
  }
}

/**
 * Update lastSeenMessageId when a message becomes visible in the viewport.
 *
 * Only advances forward in the message list (never goes backwards).
 * The `messages` array is used to determine ordering — the message must be
 * at a later position than the current lastSeenMessageId.
 *
 * @param state - Current notification state
 * @param messageId - ID of the message that became visible
 * @param messages - Full messages array for ordering comparison
 * @returns Updated state (or same reference if no change)
 */
export function onMessageSeen(
  state: EntityNotificationState,
  messageId: string,
  messages: Array<{ id: string }>
): EntityNotificationState {
  // If no current lastSeenMessageId, any message is an advancement
  if (!state.lastSeenMessageId) {
    return {
      ...state,
      lastSeenMessageId: messageId,
    }
  }

  // Find positions to compare ordering
  const currentIdx = messages.findIndex((m) => m.id === state.lastSeenMessageId)
  const newIdx = messages.findIndex((m) => m.id === messageId)

  // Only advance forward
  if (newIdx > currentIdx) {
    return {
      ...state,
      lastSeenMessageId: messageId,
    }
  }

  return state
}

// ---------------------------------------------------------------------------
// Should-Notify Functions
// ---------------------------------------------------------------------------

/** Freshness threshold: messages older than 5 minutes never trigger notifications. */
const FRESHNESS_THRESHOLD_MS = 5 * 60 * 1000

/**
 * Should a conversation message trigger a notification?
 *
 * Returns true for incoming, non-delayed, fresh messages when the user
 * can't see the conversation (not active, or window hidden).
 */
export function shouldNotifyConversation(
  msg: NotificationMessage,
  ctx: EntityContext
): boolean {
  if (msg.isOutgoing || msg.isDelayed) return false
  if (Date.now() - msg.timestamp.getTime() > FRESHNESS_THRESHOLD_MS) return false
  if (ctx.isActive && ctx.windowVisible) return false
  return true
}

/**
 * Should a room message trigger a notification?
 *
 * Returns { shouldNotify, isMention } for the notification handler.
 * Notifies for mentions (always) or all messages (when notifyAll enabled),
 * but only when the user can't see the room.
 */
export function shouldNotifyRoom(
  msg: NotificationMessage,
  ctx: EntityContext,
  notifyAll: boolean
): { shouldNotify: boolean; isMention: boolean } {
  const isMention = msg.isMention ?? false
  if (msg.isOutgoing || msg.isDelayed) return { shouldNotify: false, isMention }
  if (Date.now() - msg.timestamp.getTime() > FRESHNESS_THRESHOLD_MS) return { shouldNotify: false, isMention }
  if (ctx.isActive && ctx.windowVisible) return { shouldNotify: false, isMention }

  return { shouldNotify: isMention || notifyAll, isMention }
}

// ---------------------------------------------------------------------------
// Badge Computation
// ---------------------------------------------------------------------------

export interface BadgeInput {
  conversationsUnreadCount: number
  roomsWithUnreadCount: number
  eventsPendingCount: number
}

/**
 * Compute the total badge count from all notification sources.
 *
 * This is a simple sum because onWindowBecameVisible keeps store unreadCounts
 * accurate, eliminating the need for independent focus tracking in the badge.
 */
export function computeBadgeCount(input: BadgeInput): number {
  return input.conversationsUnreadCount + input.roomsWithUnreadCount + input.eventsPendingCount
}

// ---------------------------------------------------------------------------
// Initial State
// ---------------------------------------------------------------------------

/**
 * Create initial notification state for a new entity.
 */
export function createInitialNotificationState(): EntityNotificationState {
  return {
    unreadCount: 0,
    mentionsCount: 0,
    lastReadAt: undefined,
    lastSeenMessageId: undefined,
    firstNewMessageId: undefined,
  }
}
