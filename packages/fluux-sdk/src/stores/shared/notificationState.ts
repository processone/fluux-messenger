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
 * Key invariant: unreadCount, firstNewMessageId and readPointer are always
 * updated atomically through these transition functions.
 *
 * Read position (#1081): `readPointer` is the ONE representation. It replaced a
 * `lastSeenMessageId` + `lastReadAt` pair that described one fact with two
 * independently writable fields, and drifted. A transition either moves the
 * whole pointer or moves nothing; there is no half-write to express. A position
 * that cannot be resolved to a message in the supplied slice is not advanced to
 * at all — under-advancing costs a few re-read messages, over-advancing is
 * permanent (the pointer is forward-only).
 */

import { makeReadPointer, type PointerSource, type ReadPointer } from './readPointer'

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
   * Where the user has read to — the sole read position (#1081).
   *
   * Advances forward only, and only to a message present in the slice the
   * transition was given, so its timestamp is always that message's own.
   * `undefined` until the entity is first read.
   *
   * REQUIRED, not optional, deliberately: several transitions build a fresh
   * object literal rather than spreading `state`, and an optional property
   * would let one of them silently ship a pointerless state. Declared
   * `ReadPointer | undefined` so "no read position yet" still has to be
   * written down.
   */
  readPointer: ReadPointer | undefined
  /** Entity-creation watermark. Not a read position. */
  historyFloor?: Date
  /**
   * ID of the first unread message for the visual "new messages" divider.
   * Set when the user opens an entity holding messages after the read pointer.
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

/** Context about the entity's current visibility and unread state. */
export interface EntityContext {
  isActive: boolean
  windowVisible: boolean
  /** Current unread count for the entity; used to decide notify-worthiness. */
  unreadCount?: number
  /** The entity's read position; suppresses re-notify of already-seen content. */
  readPointer?: ReadPointer
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
 * - Outgoing message: clear unread + mentions, advance the pointer, clear marker
 * - Delayed/historical: no changes (preserve existing state)
 * - Incoming + user sees message: no unread increment, advance the pointer
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
      readPointer: makeReadPointer(msg),
      firstNewMessageId: undefined,
    }
  }

  // Delayed/historical: preserve existing state unchanged
  // Exception: treatDelayedAsNew allows delayed messages to be treated as new
  // (used for 1:1 offline delivery where isDelayed means "sent while offline")
  if (msg.isDelayed && !treatDelayedAsNew) {
    return state
  }

  // User sees the message: advance the read pointer, keep unread at 0.
  // Advancing here ensures the "new messages" marker is correctly positioned (or
  // absent) when the user leaves and re-enters the entity — without relying
  // solely on the IntersectionObserver, which may lag due to throttling.
  if (userSeesMessage) {
    return {
      unreadCount: 0,
      mentionsCount: 0,
      readPointer: makeReadPointer(msg),
      firstNewMessageId: state.firstNewMessageId,
    }
  }

  // User doesn't see the message
  const newUnreadCount = incrementUnread ? state.unreadCount + 1 : state.unreadCount
  const newMentionsCount = incrementMentions ? state.mentionsCount + 1 : state.mentionsCount

  // Set marker if: entity is active AND window hidden AND no existing marker
  const newFirstNewMessageId =
    ctx.isActive && !ctx.windowVisible && !state.firstNewMessageId
      ? msg.id
      : state.firstNewMessageId

  return {
    unreadCount: newUnreadCount,
    mentionsCount: newMentionsCount,
    // Read position untouched — carried through explicitly because this branch
    // builds a fresh object rather than spreading `state`.
    readPointer: state.readPointer,
    firstNewMessageId: newFirstNewMessageId,
  }
}

/**
 * Compute new notification state when user opens/activates an entity.
 *
 * Scans messages to find the first unseen message (after the read pointer)
 * and sets the marker, then marks as read.
 *
 * The marker is placed at the first incoming message after the read pointer's
 * position. Whether a delayed message qualifies depends on `treatDelayedAsNew`,
 * mirroring `onMessageReceived`. Both 1:1 chats and rooms now pass `true` —
 * `isDelayed` means "delivered while offline" (1:1) or "MAM/MUC history replay"
 * (rooms), and either way it counts as new relative to the read pointer, so the
 * divider is unified across chats and rooms. A fresh join/conversation with no
 * prior read state has nothing to resume from — the fresh-entity guard (see
 * `recomputeCountsFromPointer` and the activation call sites) keeps that case
 * marker-free rather than `treatDelayedAsNew` doing it.
 */
export function onActivate(
  state: EntityNotificationState,
  messages: NotificationMessage[],
  options?: { treatDelayedAsNew?: boolean }
): EntityNotificationState {
  const { treatDelayedAsNew = false } = options ?? {}
  // A message qualifies as a "new" marker candidate when it's incoming and either
  // we treat delayed messages as new (1:1) or it isn't a delayed/history message.
  const isNewCandidate = (msg: NotificationMessage) =>
    !msg.isOutgoing && (treatDelayedAsNew || !msg.isDelayed)

  let firstNewMessageId: string | undefined = undefined
  let updatedSeenMessageId = state.readPointer?.messageId

  if (state.readPointer && messages.length > 0) {
    // Find the position of the message the pointer names
    const lastSeenIdx = messages.findIndex((m) => m.id === state.readPointer!.messageId)

    if (lastSeenIdx !== -1) {
      // Scan forward from the read pointer to find first unseen incoming message
      for (let i = lastSeenIdx + 1; i < messages.length; i++) {
        const msg = messages[i]
        if (isNewCandidate(msg)) {
          firstNewMessageId = msg.id
          break
        }
      }
    } else {
      // The pointer's message is not in the loaded slice — it's older than what
      // was loaded (e.g. cache loaded the latest 100 of 500+ messages). Fall back
      // to the pointer's own timestamp to place the marker within the slice.
      const fallbackReadAt = state.readPointer.timestamp

      // Only usable if it's a real timestamp (not epoch). Epoch is the historic
      // "no prior read time" sentinel — it would match the very first message in
      // the array, placing the marker far too early.
      const hasUsableReadAt = fallbackReadAt.getTime() > 0

      if (hasUsableReadAt) {
        const firstNew = messages.find(
          (msg) => msg.timestamp > fallbackReadAt && isNewCandidate(msg)
        )
        if (firstNew) {
          firstNewMessageId = firstNew.id
        }
      } else if (state.unreadCount > 0) {
        // No usable pointer timestamp — use unreadCount to place the marker at
        // the Nth message from the end (counting only incoming candidates).
        let remaining = state.unreadCount
        for (let i = messages.length - 1; i >= 0; i--) {
          const m = messages[i]
          if (isNewCandidate(m)) {
            remaining--
            if (remaining === 0) {
              firstNewMessageId = m.id
              break
            }
          }
        }
        // If we ran out of messages before exhausting unreadCount,
        // place marker at the first incoming new-candidate message.
        if (remaining > 0) {
          const firstIncoming = messages.find(isNewCandidate)
          if (firstIncoming) {
            firstNewMessageId = firstIncoming.id
          }
        }
      }

      // Resume-preserving pointer placement: snap the pointer to the message
      // just BEFORE the derived divider so viewport advance works inside this
      // slice. Snapping to the NEWEST (previous behavior) destroyed the resume
      // point whenever the backlog was deeper than the loaded window. When no
      // divider could be derived there is nothing to resume — snap to newest
      // as before so the stale-fallback doesn't repeat forever.
      if (firstNewMessageId) {
        const dividerIdx = messages.findIndex((m) => m.id === firstNewMessageId)
        if (dividerIdx > 0) updatedSeenMessageId = messages[dividerIdx - 1].id
        // dividerIdx === 0: whole slice is unread — keep the old pointer;
        // onMessageSeen's atLiveEdge escape hatch prevents a stuck pointer.
      } else {
        const lastMsg = messages[messages.length - 1]
        if (lastMsg) updatedSeenMessageId = lastMsg.id
      }
    }
  } else if (!state.readPointer && state.unreadCount > 0 && messages.length > 0) {
    // Brand-new conversation: no read position at all.
    // Use unreadCount to place marker N incoming messages from the end.
    let remaining = state.unreadCount
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i]
      if (isNewCandidate(m)) {
        remaining--
        if (remaining === 0) {
          firstNewMessageId = m.id
          break
        }
      }
    }
    if (remaining > 0) {
      const firstIncoming = messages.find(isNewCandidate)
      if (firstIncoming) {
        firstNewMessageId = firstIncoming.id
      }
    }
  }

  // Resolve the position derived above to a pointer (#1081). When the id
  // resolves nowhere in this slice the position did not move — it is the
  // caller's stale pointer — so that pointer, equally stale, is kept.
  const pointerMessage = updatedSeenMessageId
    ? messages.find((m) => m.id === updatedSeenMessageId)
    : undefined
  const updatedPointer = pointerMessage ? makeReadPointer(pointerMessage) : state.readPointer

  // Mark as read: clear the counts. The read position is the pointer above and
  // nothing else — there is no separate "when I last activated" timestamp to
  // stamp with the newest loaded message, which is what used to let the two
  // fields disagree about where the user had actually read to.
  return {
    unreadCount: 0,
    mentionsCount: 0,
    readPointer: updatedPointer,
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
 * Clears unreadCount and mentionsCount.
 * Preserves firstNewMessageId — the marker has a separate lifecycle
 * (set on activate, cleared on deactivate or explicit clear).
 *
 * When `advanceSeenTo` is supplied, the read pointer is advanced to it. Callers
 * pass the newest MESSAGE ONLY when the user has genuinely caught up to it (the
 * loaded window is at the live edge) — this is what lets the XEP-0490
 * publisher, which watches the read position, sync the read marker to other
 * devices. Omitting it (the scrolled-into-history case) clears the local badge
 * without publishing a read position past what the user actually saw. The
 * advance is forward-only in practice because the caller only ever supplies the
 * tail of a live-edge window (>= the current pointer).
 *
 * `advanceSeenTo` is the message rather than its id (#1081): the id and the
 * timestamp of one read position are written together or not at all, and taking
 * them as one argument makes a half-write unrepresentable.
 */
export function onMarkAsRead(
  state: EntityNotificationState,
  advanceSeenTo?: PointerSource
): EntityNotificationState {
  // Skip update if nothing to change (prevents unnecessary state updates).
  // Marking read no longer stamps a wall-clock/newest-message timestamp, so a
  // repeat mark-as-read on an already-read entity is now genuinely a no-op and
  // returns the same reference.
  const seenUnchanged = advanceSeenTo === undefined || advanceSeenTo.id === state.readPointer?.messageId
  if (state.unreadCount === 0 && state.mentionsCount === 0 && seenUnchanged) {
    return state
  }
  return {
    ...state,
    unreadCount: 0,
    mentionsCount: 0,
    // No extra forward-only guard: the caller owns the "the user is caught up
    // to this message" call, and the pointer moves whole or not at all.
    readPointer: advanceSeenTo ? makeReadPointer(advanceSeenTo) : state.readPointer,
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
  isActive: boolean
): EntityNotificationState {
  if (!isActive) return state
  if (state.unreadCount === 0 && state.mentionsCount === 0) return state

  // Counts only. This transition never knew WHICH message the user had reached,
  // so it never moved the read position and still does not — clearing the badge
  // is not evidence of a new read position (#1076).
  return {
    ...state,
    unreadCount: 0,
    mentionsCount: 0,
  }
}

/**
 * Advance the read pointer when a message becomes visible in the viewport.
 *
 * Only advances forward in the message list (never goes backwards).
 * The `messages` array is used to determine ordering — the message must be
 * at a later position than the one the current pointer names.
 *
 * A `messageId` that is absent from `messages` is NEVER advanced to (#1081).
 * The pointer is one object: its timestamp has to be the named message's own,
 * and a caller reporting a message it does not hold gives us no honest
 * timestamp to pair with the id. The previous two-field shape had no way to
 * express that — it moved the id and left the timestamp behind, producing a
 * pair that disagreed about the same read position. Refusing to move
 * under-counts at worst (the next viewport report or activation re-derives it);
 * moving on a fabricated timestamp would push a forward-only floor past unread
 * messages for good.
 *
 * @param state - Current notification state
 * @param messageId - ID of the message that became visible
 * @param messages - Full messages array, for ordering and for the timestamp the
 *   advanced pointer is built from. Every caller already holds full messages.
 * @returns Updated state (or same reference if no change)
 */
export function onMessageSeen(
  state: EntityNotificationState,
  messageId: string,
  messages: Array<PointerSource>,
  options?: { atLiveEdge?: boolean }
): EntityNotificationState {
  const newIdx = messages.findIndex((m) => m.id === messageId)
  // Unresolvable target — see the note above. Checked before everything else so
  // no branch below can advance to a position it cannot name.
  if (newIdx === -1) return state
  const advanced = (): EntityNotificationState => ({
    ...state,
    readPointer: makeReadPointer(messages[newIdx]),
  })

  // No read position yet: any resolvable message is an advancement.
  if (!state.readPointer) return advanced()

  // Find the current position to compare ordering
  const currentIdx = messages.findIndex((m) => m.id === state.readPointer!.messageId)

  // If the current pointer is not in the loaded messages array (stale/trimmed),
  // don't update — the stale position is resolved properly on the next
  // onActivate. Without this guard, any visible message would "win" against -1,
  // potentially regressing the pointer to an earlier position.
  if (currentIdx === -1) {
    // Unresolvable pointer (older than the slice, or evicted). Viewing the
    // NEWEST message while the window is at the live edge is an unambiguous
    // maximum — advancing cannot regress. Off the live edge the slice's last
    // message may be older than the pointer, so stay guarded.
    if (options?.atLiveEdge && newIdx === messages.length - 1) return advanced()
    return state
  }

  // Only advance forward
  if (newIdx > currentIdx) return advanced()

  return state
}

/** Options for {@link recomputeCountsFromPointer}. */
export interface RecomputeCountsOptions {
  /** Count `isMention` messages into mentionsCount (rooms). */
  countMentions?: boolean
  /**
   * True when an XEP-0490 marker for this entity is stashed but not yet resolved
   * (`pendingRemoteDisplayedStanzaId`). Such an entity has a read position — we
   * simply cannot express it as a local message id yet — so the fresh-entity
   * guard below must NOT claim it is caught up. See {@link recomputeCountsFromPointer}.
   */
  hasPendingRemoteMarker?: boolean
}

/**
 * Recompute unreadCount/mentionsCount from the persisted read pointer against
 * a freshly merged message slice (sorted oldest → newest). Used by MAM
 * catch-up hydration and inbound XEP-0490 marker handling — never by the live
 * message path (onMessageReceived owns incremental counting).
 *
 * Fresh-entity guard: an entity with NO read pointer is caught up — the pointer
 * snaps to the newest message and counts stay zero. History replay of a newly
 * joined room, or a new device with no MDS position, never manufactures unread
 * debt.
 *
 * The guard does NOT apply while an XEP-0490 marker is still pending
 * (`hasPendingRemoteMarker`). On a fresh instance the marker from the user's
 * other client always arrives before the room has any messages to resolve it
 * against, so it sits stashed while this runs. Snapping the pointer to newest
 * then would put it PAST the marker, and the fold that follows is forward-only —
 * silently discarding the position the user actually left off at. Leaving the
 * state untouched lets that fold resolve the marker and the counts follow.
 *
 * An outgoing message inside the counted range is a read boundary (the user
 * replied, here or on another device): counting restarts after the last one
 * and the pointer advances to it.
 */
export function recomputeCountsFromPointer(
  state: EntityNotificationState,
  messages: NotificationMessage[],
  options?: RecomputeCountsOptions
): EntityNotificationState {
  const { countMentions = false, hasPendingRemoteMarker = false } = options ?? {}
  if (messages.length === 0) return state

  if (!state.readPointer) {
    // An unresolved remote marker IS read state — defer to the fold that will
    // resolve it rather than claiming this entity is caught up.
    if (hasPendingRemoteMarker) return state
    const newest = messages[messages.length - 1]
    return {
      ...state,
      unreadCount: 0,
      mentionsCount: 0,
      readPointer: makeReadPointer(newest),
    }
  }

  let startIdx: number
  const pointerIdx = messages.findIndex((m) => m.id === state.readPointer!.messageId)
  if (pointerIdx !== -1) {
    startIdx = pointerIdx + 1
  } else {
    const readAt = state.readPointer.timestamp
    if (readAt.getTime() > 0) {
      const idx = messages.findIndex((m) => m.timestamp > readAt)
      startIdx = idx === -1 ? messages.length : idx
    } else {
      // Pointer resolves nowhere and its timestamp is the epoch sentinel: the
      // slice is entirely past the read horizon — count it all (a lower bound).
      startIdx = 0
    }
  }

  let newReadPointer = state.readPointer
  for (let i = messages.length - 1; i >= startIdx; i--) {
    if (messages[i].isOutgoing) {
      newReadPointer = makeReadPointer(messages[i])
      startIdx = i + 1
      break
    }
  }

  let unread = 0
  let mentions = 0
  for (let i = startIdx; i < messages.length; i++) {
    const m = messages[i]
    if (m.isOutgoing) continue
    unread++
    if (countMentions && m.isMention) mentions++
  }

  const mentionsOut = countMentions ? mentions : state.mentionsCount
  // `newReadPointer` starts as `state.readPointer` and is only ever replaced by
  // a freshly built object, so reference identity is exactly "did it move".
  if (unread === state.unreadCount && mentionsOut === state.mentionsCount && newReadPointer === state.readPointer) {
    return state
  }
  return {
    ...state,
    unreadCount: unread,
    mentionsCount: mentionsOut,
    readPointer: newReadPointer,
  }
}

// ---------------------------------------------------------------------------
// Should-Notify Functions
// ---------------------------------------------------------------------------

/**
 * Should a conversation message trigger a notification?
 *
 * Notify-worthiness mirrors unread-worthiness: notify for an incoming message the
 * user has not yet seen, when they can't currently see it (not active, or window
 * hidden). Delivery mechanism (isDelayed) and message age are intentionally NOT
 * discriminators — an offline/replayed message delivered on reconnect is "new to me".
 * The unseen check (unreadCount + read pointer) keeps MAM history backfill and
 * re-synced duplicates silent and is self-limiting (the pointer only advances).
 */
export function shouldNotifyConversation(
  msg: NotificationMessage,
  ctx: EntityContext
): boolean {
  if (msg.isOutgoing) return false
  if (ctx.isActive && ctx.windowVisible) return false
  if ((ctx.unreadCount ?? 0) <= 0) return false
  if (msg.id === ctx.readPointer?.messageId) return false
  return true
}

/**
 * Room freshness threshold: MUC messages older than 5 minutes never trigger
 * notifications. Rooms (unlike conversations) still gate on age to suppress
 * history replay; conversations use the unseen check instead.
 */
const ROOM_FRESHNESS_THRESHOLD_MS = 5 * 60 * 1000

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
  if (Date.now() - msg.timestamp.getTime() > ROOM_FRESHNESS_THRESHOLD_MS) return { shouldNotify: false, isMention }
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
    readPointer: undefined,
    firstNewMessageId: undefined,
  }
}
