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

import {
  advance,
  hasFloorResolutionEvidence,
  makeReadPointer,
  type PointerSource,
  type ReadPointer,
} from './readPointer'
import {
  isAfterBoundary,
  mayAdvanceTo,
  computeFloor,
  isRenderableStoredMessage,
  exactPosition,
  type PointerOrder,
  type RenderabilityCheckFields,
} from './readState'

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
   * transition was given, so a pointer THESE transitions produce carries that
   * message's own timestamp — so it is an `exact` order. Not a universal
   * invariant of the type: pointers built by the #1081 migration from a legacy
   * `lastSeenMessageId` + `lastReadAt` pair carry `lastReadAt` and are a `floor`,
   * which sits at or behind the named message deliberately — see
   * `readPointer.ts`. Only `order` is used for ordering, and nothing derives a
   * message from it, so the two populations are interchangeable here.
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

/**
 * Minimal message shape needed for notification decisions.
 *
 * Extends {@link RenderabilityCheckFields} (content fields, all optional) so
 * the increment branch of {@link onMessageReceived} can gate on
 * `isRenderableStoredMessage` directly — every existing caller already
 * constructs these objects from a real `Message`/`RoomMessage`, or omits the
 * content fields entirely (falling back to "not renderable", which is only
 * consulted by the one branch that needs it).
 */
export interface NotificationMessage extends RenderabilityCheckFields {
  id: string
  timestamp: Date
  isOutgoing: boolean
  isDelayed?: boolean
  isMention?: boolean
  /** Sender's JID — feeds the ROOM cache order key's (from, id) tie-break. */
  from?: string
  /**
   * XEP-0359 archive id, when the server has assigned one.
   *
   * Threaded through so a pointer minted from this arrival is `addressable`
   * immediately (see `makeReadPointer`) — the free convergence path for every
   * peer message and every MUC reflection. A caller that narrows a real message
   * into this shape and omits `stanzaId` does not break anything, but it does
   * silently give up that convergence, so pass it.
   */
  stanzaId?: string
}

/** Context about the entity's current visibility and unread state. */
export interface EntityContext {
  isActive: boolean
  windowVisible: boolean
  /** Current unread count for the entity; used to decide notify-worthiness. */
  unreadCount?: number
  /** The entity's read position; suppresses re-notify of already-seen content. */
  readPointer?: ReadPointer
  /**
   * Whether the viewport is DEMONSTRABLY at the live edge, for the CURRENT
   * activation generation — derived by the store as
   * `currentViewportEvidence(key) === 'at-edge'` (see `viewportEvidence.ts`).
   *
   * `undefined` (and any non-`true` value) is the safe default and means "not
   * at the edge": missing / stale / unknown viewport evidence must never
   * authorize {@link onMessageReceived} to advance the read pointer — an
   * active, focused conversation scrolled up into history is exactly the case
   * this field exists to distinguish from one genuinely parked at the bottom.
   */
  viewportAtLiveEdge?: boolean
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
 * - Delayed/historical: no changes (preserve existing state) unless treatDelayedAsNew
 * - Incoming or outgoing + user sees message: no unread, advance the pointer
 * - Incoming + user doesn't see + entity active + window hidden: set marker if not set
 * - Incoming + user doesn't see + entity not active: increment unread (renderable only)
 * - Outgoing: never increments unread or mentions, and always clears the divider on the
 *   branches it reaches
 *
 * There is NO outgoing early return. "I sent this, so I must have
 * read up to here" is an inference, and `isOutgoing` is true for a carbon from another
 * device and for a nick-misattributed MUC reflection — the vector #1081 exists to close.
 * An outgoing message advances the pointer only via `userSeesMessage`, i.e. for the
 * same reason any VISIBLE message does. Note the consequence for a DELAYED outgoing
 * message: it returns at the delayed guard, so a MUC history replay of our own message
 * does not dismiss the divider (deliberate — see the spec's D1 table).
 *
 * "User sees message" requires all three of: the entity is active,
 * the window is visible/focused, AND the viewport is demonstrably at the live
 * edge for the CURRENT activation generation (`ctx.viewportAtLiveEdge ===
 * true`). An active, focused conversation the user has scrolled UP in is
 * exactly the case this precondition exists to catch: `isActive &&
 * windowVisible` alone would advance the pointer there, silently marking
 * unseen history as read. Missing/stale/unknown viewport evidence (the
 * `undefined` default) is treated conservatively as NOT at the edge — see
 * `EntityContext.viewportAtLiveEdge` and `viewportEvidence.ts`.
 */
export function onMessageReceived(
  state: EntityNotificationState,
  msg: NotificationMessage,
  ctx: EntityContext,
  kind: 'chat' | 'room',
  options?: MessageReceivedOptions
): EntityNotificationState {
  const { incrementUnread = true, incrementMentions = false, treatDelayedAsNew = false } = options ?? {}
  const userSeesMessage = ctx.isActive && ctx.windowVisible && ctx.viewportAtLiveEdge === true

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
      readPointer: advance(state.readPointer, makeReadPointer(msg, kind)),
      firstNewMessageId: msg.isOutgoing ? undefined : state.firstNewMessageId,
    }
  }

  // User doesn't see the message. A message with nothing to display (a stray
  // XEP-0333 marker, a XEP-0428-fallback-only body — see
  // `isRenderableStoredMessage`) never becomes a visible bubble, so it must
  // never inflate the badge either: that phantom `+1` is exactly the class of
  // bug this guard closes. `noLocalStore` messages (never archived) are
  // EXCLUDED from this ad hoc `+1` by the caller passing `incrementUnread:
  // false` for them — their contribution comes entirely from the transient
  // overlay (`stores/shared/transientUnread.ts`), wired at the chatStore/
  // roomStore call sites, so it is never double-counted here.
  const newUnreadCount =
    incrementUnread && !msg.isOutgoing && isRenderableStoredMessage(msg)
      ? state.unreadCount + 1
      : state.unreadCount
  const newMentionsCount = incrementMentions && !msg.isOutgoing ? state.mentionsCount + 1 : state.mentionsCount

  // Set marker if: entity is active AND window hidden AND no existing marker
  const newFirstNewMessageId = msg.isOutgoing
    ? undefined
    : ctx.isActive && !ctx.windowVisible && !state.firstNewMessageId
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
 * Whether {@link onMessageReceived} would reach its final "user doesn't see
 * the message" branch — i.e. treat `msg` as a genuine unseen arrival rather
 * than short-circuiting on outgoing, delayed-historical, or seen-live.
 *
 * Exported so a caller that needs to gate a SIDE EFFECT on that exact same
 * condition (the transient overlay's `noteTransient`, in chatStore/roomStore —
 * see `stores/shared/transientUnread.ts`) mirrors this pure transition's own
 * branching instead of re-deriving a similar-but-possibly-different check
 * inline, which is exactly the kind of drift this module exists to prevent.
 *
 * `ctx.viewportAtLiveEdge` mirrors {@link onMessageReceived}'s own
 * `userSeesMessage` three-way check EXACTLY, viewport-evidence dimension
 * included rather than the coarser `isActive && windowVisible`. An active,
 * focused, but SCROLLED-UP conversation correctly counts as unseen here
 * too: `onMessageReceived` already does the live `+1` for it (it never
 * advances the pointer without `viewportAtLiveEdge === true`), but a
 * `noLocalStore` message can ONLY ever be represented by the transient
 * overlay — it is never archived, so nothing else records it, and a later
 * exact recount (deriving purely from the archive) would otherwise silently
 * drop its contribution the moment it commits.
 */
export function isUnseenIncomingMessage(
  msg: Pick<NotificationMessage, 'isOutgoing' | 'isDelayed'>,
  ctx: Pick<EntityContext, 'isActive' | 'windowVisible' | 'viewportAtLiveEdge'>,
  options?: { treatDelayedAsNew?: boolean }
): boolean {
  if (msg.isOutgoing) return false
  if (msg.isDelayed && !(options?.treatDelayedAsNew ?? false)) return false
  if (ctx.isActive && ctx.windowVisible && ctx.viewportAtLiveEdge === true) return false
  return true
}

/**
 * Compute new notification state when the user opens/activates an entity.
 *
 * The divider is **the first message the canonical count would count**:
 * incoming, renderable, and strictly after the read boundary in
 * `(timestamp, tiebreak)` order. Sharing the count's exact predicate AND
 * its exact floor is what makes "the divider labels the count" true by
 * construction rather than by coincidence — see `countUnreadInArchive`.
 *
 * `isDelayed` plays no part: with a timestamp floor, a delayed message after the
 * boundary simply IS new. That is why this function does not take
 * `treatDelayedAsNew` (the live arrival paths do — chat and room genuinely
 * differ there; see `onMessageReceived`).
 *
 * This function NEVER moves the read pointer and never changes `unreadCount`.
 * No fallback ladder stands behind it — no `lastReadAt` timestamp probe, no
 * Nth-from-end placement driven by `unreadCount`, no resume-preserving snap: a
 * durably reconstructible `tiebreak` locates the pointer outside the resident
 * slice, and a snap would be a pointer write inside a function whose job is to
 * place a divider.
 *
 * With neither a pointer nor a `historyFloor` there is no boundary, so there is
 * no divider — the same stand-down the count makes when `computeFloor` yields
 * nothing.
 */
export function onActivate(
  state: EntityNotificationState,
  messages: NotificationMessage[],
  kind: 'chat' | 'room'
): EntityNotificationState {
  const floor = computeFloor(state.readPointer, state.historyFloor)

  let firstNewMessageId: string | undefined = undefined
  if (floor) {
    // The pointer's own order when there is one, so the comparison is not blind
    // to a message sharing its exact millisecond; a historyFloor-derived
    // boundary knows only a millisecond and says so.
    const floorPos: PointerOrder = state.readPointer?.order ?? { role: 'floor', timestamp: floor.getTime() }

    for (const m of messages) {
      if (m.isOutgoing) continue
      if (!isRenderableStoredMessage(m)) continue
      // The DIVIDER question: a `floor` boundary means at-or-after its
      // millisecond, placing the divider conservatively early (#1173).
      if (isAfterBoundary(exactPosition(m, kind), floorPos)) {
        firstNewMessageId = m.id
        break
      }
    }
  }

  // mentionsCount stays zeroed here: clearing the @-mention badge on open is
  // pre-existing behaviour, unrelated to the read pointer. unreadCount is
  // DELIBERATELY left unchanged — the canonical count is archive-derived and
  // converges to 0 only through genuine live-edge convergence.
  return {
    unreadCount: state.unreadCount,
    mentionsCount: 0,
    readPointer: state.readPointer,
    historyFloor: state.historyFloor,
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
 * Compute new notification state when an entity is explicitly marked as read.
 *
 * Clears unreadCount and mentionsCount. Preserves firstNewMessageId — the marker
 * has a separate lifecycle (set on activate, cleared on deactivate or explicit
 * clear).
 *
 * The pointer advances to the newest loaded message ONLY when the loaded window
 * and the current-generation viewport are both at the live edge. Otherwise the
 * counts clear but the position stays where the user actually read, so the
 * XEP-0490 publisher never speaks past what they saw.
 *
 * Picking the message from the two independent live-edge facts is this
 * function's job.
 */
export function onMarkAsRead(
  state: EntityNotificationState,
  messages: Array<PointerSource>,
  kind: 'chat' | 'room',
  options: { windowAtLiveEdge: boolean; viewportAtLiveEdge: boolean }
): EntityNotificationState {
  const newest =
    options.windowAtLiveEdge && options.viewportAtLiveEdge
      ? messages[messages.length - 1]
      : undefined
  const seenUnchanged = newest === undefined || newest.id === state.readPointer?.identity.messageId
  if (state.unreadCount === 0 && state.mentionsCount === 0 && seenUnchanged) {
    return state
  }
  return {
    ...state,
    unreadCount: 0,
    mentionsCount: 0,
    readPointer: newest ? makeReadPointer(newest, kind) : state.readPointer,
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
 * Update the read pointer when a message becomes visible in the viewport.
 *
 * An exact pointer advances only to a later cache position. A floor may also
 * become exact on the message it already names when the evidence below proves
 * the identity; this refines the position without moving it to another message.
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
 * An EXACT current pointer (`order.role === 'exact'`) is ordered by cache
 * POSITION via `mayAdvanceTo`, not by array index — its position is provable
 * without being resident in `messages`. The off-slice guard, the `atLiveEdge`
 * escape hatch and the same-message resolution below apply only to a FLOOR
 * (migrated) pointer, whose bare timestamp cannot certify a position.
 *
 * A floor reported on the message it already NAMES is resolved to an exact
 * position only with a matching XEP-0359 server ID, or for a local chat pointer
 * confined to a unique newest resident row under the cache's `id` key. Resolution
 * preserves the pointer's identity and replaces only its approximate order.
 *
 * @param state - Current notification state
 * @param messageId - ID of the message that became visible
 * @param messages - Full messages array, for ordering and for the timestamp the
 *   updated pointer is built from. Every caller already holds full messages.
 * @returns Updated state (or same reference if no change)
 */
export function onMessageSeen(
  state: EntityNotificationState,
  messageId: string,
  messages: Array<PointerSource>,
  kind: 'chat' | 'room',
  options?: { atLiveEdge?: boolean }
): EntityNotificationState {
  const newIdx = messages.findIndex((m) => m.id === messageId)
  // Unresolvable target — see the note above. Checked before everything else so
  // no branch below can advance to a position it cannot name.
  if (newIdx === -1) return state
  const advanced = (): EntityNotificationState => ({
    ...state,
    readPointer: makeReadPointer(messages[newIdx], kind),
  })

  // No read position yet: any resolvable message is an advancement.
  if (!state.readPointer) return advanced()

  // EXACT pointer: compare cache POSITIONS. The pointer does not have to be
  // resident, and a same-millisecond sibling that sorts after it is a genuine
  // advance. Safe against the resident array because `messageArrayUtils`
  // uses the same tie-break, so array index and cache order
  // agree.
  const current = state.readPointer.order
  if (current.role === 'exact') {
    // The ADVANCE question: never overtake at a shared millisecond (#1173).
    return mayAdvanceTo(exactPosition(messages[newIdx], kind), current) ? advanced() : state
  }

  // FLOOR (migrated) pointer: its timestamp proves nothing about its position,
  // so keep ordering by index — including the off-slice guard and the live-edge
  // escape hatch that stops it getting stuck.
  const currentIdx = messages.findIndex((m) => m.id === state.readPointer!.identity.messageId)
  if (currentIdx === -1) {
    if (options?.atLiveEdge && newIdx === messages.length - 1) return advanced()
    return state
  }
  if (newIdx > currentIdx) return advanced()

  // RESOLVE, do not advance. Server identity proof or constrained local evidence
  // licenses replacing only the floor's approximate order; the pointer's
  // existing identity remains the authority.
  //
  // Without this, a floor naming the NEWEST message is unreachable: the divider
  // and the count are at-or-after (`isAfterBoundary`), so that message reads as
  // unread, while the advance rule is strictly-after (`mayAdvanceTo`), so no
  // read of it can move past. Both rules are right; the pointer resolves the
  // deadlock, not the comparators.
  //
  if (newIdx !== currentIdx) return state
  if (!hasFloorResolutionEvidence(state.readPointer, messages, newIdx, kind)) return state

  const reportedPosition = exactPosition(messages[newIdx], kind)
  const identity = state.readPointer.identity
  return {
    ...state,
    readPointer: { order: reportedPosition, identity },
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
  if (msg.id === ctx.readPointer?.identity.messageId) return false
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
