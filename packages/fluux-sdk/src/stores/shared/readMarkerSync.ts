/**
 * XEP-0490 (Message Displayed Synchronization) remote-read-position
 * resolution — shared by chatStore and roomStore, whose applyRemoteDisplayed
 * implementations were ~100-line twins that had to be kept in sync by hand.
 *
 * The stores keep their map fan-out and apply the returned read-state
 * resolution; divider placement stays outside this state machine.
 */

import type { NotificationMessage } from './notificationState'
import * as notifState from './notificationState'
import { mayAdvanceTo, exactPosition } from './readState'
import { makeReadPointer, pointerRowRef, type ReadPointer } from './readPointer'
import {
  findMessageRowIndex,
  messageRowRef,
  sameMessageRow,
  type MessageRowRef,
} from '../../utils/messageIdentity'

/** The notification-relevant slice of a conversation/room metadata entry. */
export interface ReadMarkerMeta {
  unreadCount: number
  mentionsCount: number
  /** The entity's read position — the sole representation of it (#1081). */
  readPointer?: ReadPointer
  pendingRemoteDisplayedStanzaId?: string
}

export type RemoteDisplayedResolution =
  /**
   * The loaded slice cannot yet order the remote marker against the local read
   * pointer — remember the stanza-id as a pending high-water mark for a later
   * merge or activation fold.
   */
  | { kind: 'stash-pending' }
  /** No advance and nothing stale to clean up — state untouched. */
  | { kind: 'unchanged' }
  /**
   * No advance (local position at or past the marker), but the marker is now
   * resolved — clear the stale pending mark so it doesn't re-fire a no-op on
   * every merge.
   */
  | { kind: 'clear-pending' }
  /**
   * The marker resolved but sits at or behind the local read pointer, on an ACTIVE entity that
   * still shows a divider. No pointer moves — but the line might: the marker is another device
   * stating it read that far, and the line may still stand in front of what it read. It carries the
   * MARKER's own position, not ours, because that is the boundary the line is compared against.
   */
  | { kind: 'resolved-active'; markerPointer: ReadPointer }
  /**
   * Forward advance. The whole read position travels as one `readPointer`
   * (#1081); divider placement remains owned by activation.
   */
  | { kind: 'advanced'; readPointer: ReadPointer }
  /**
   * Forward advance on the active entity. Kept distinct so callers can run the
   * active archive recount without coupling read synchronization to divider
   * placement.
   */
  | { kind: 'advanced-active'; readPointer: ReadPointer }

/**
 * Decide whether the remote marker `match` is a forward advance over `current`.
 *
 * Three branches, because the no-pointer case is NOT the
 * same as the floor one:
 *
 * - **No pointer** — any resolvable marker is an advance. Stated explicitly,
 *   rather than falling out of a vacuously-true residency check, so it cannot
 *   be lost by refactoring.
 * - **Exact pointer** — decide by cache position, with no residency
 *   requirement. An exact order certifies that the pointer's timestamp is its
 *   named message's own, which is exactly the guarantee the old comment here
 *   said we lacked.
 * - **Floor (migrated) pointer** — its timestamp is `lastReadAt`, which can
 *   sit on EITHER side of the message it names, so nothing is provable from it.
 *   Keep the resident-index path, and stash when the pointer is off-slice.
 *
 * `match` is the resolved local row for an inbound XEP-0490 marker, so it
 * carries the archive id we just matched on: `makeReadPointer` mints an
 * `addressable` pointer from it directly. That archive id is bound by IDENTITY
 * — it is the very id this row was found by — never by position.
 */
function resolveAdvance<T extends NotificationMessage & { stanzaId?: string }>(
  current: ReadPointer | undefined,
  match: T,
  messages: T[],
  meta: ReadMarkerMeta,
  currentFirstNewMessageRow: MessageRowRef | undefined,
  kind: 'chat' | 'room'
): ReadPointer | 'no-advance' | 'undecidable' {
  if (!current) return makeReadPointer(match, kind)

  if (current.order.role === 'exact') {
    // The ADVANCE question — never overtake at a shared millisecond (#1173).
    const ahead = mayAdvanceTo(exactPosition(match, kind), current.order)
    return ahead ? makeReadPointer(match, kind) : 'no-advance'
  }

  if (findMessageRowIndex(messages, pointerRowRef(current)) === -1) return 'undecidable'

  const updated = notifState.onMessageSeen(
    {
      unreadCount: meta.unreadCount,
      mentionsCount: meta.mentionsCount,
      readPointer: current,
      firstNewMessageRow: currentFirstNewMessageRow,
    },
    messageRowRef(match),
    messages,
    kind
  )
  const next = updated.readPointer
  return next && !sameMessageRow(pointerRowRef(next), pointerRowRef(current)) ? next : 'no-advance'
}

export function resolveRemoteDisplayed<T extends NotificationMessage & { stanzaId?: string }>(
  meta: ReadMarkerMeta,
  messages: T[],
  currentFirstNewMessageRow: MessageRowRef | undefined,
  stanzaId: string,
  kind: 'chat' | 'room',
  options: { isActive: boolean }
): RemoteDisplayedResolution {
  // Re-recording the stanza already stashed changes nothing, and the stores rebuild an entry for
  // every resolution that is not `unchanged`. A duplicate notification, a reconnect seed and a
  // stream-management replay all deliver the same marker again, so saying so costs a re-render each.
  const alreadyStashed = meta.pendingRemoteDisplayedStanzaId === stanzaId
  const stash = (): RemoteDisplayedResolution =>
    alreadyStashed ? { kind: 'unchanged' } : { kind: 'stash-pending' }

  const match = messages.find((m) => m.stanzaId === stanzaId)
  if (!match) return stash()

  const outcome = resolveAdvance(meta.readPointer, match, messages, meta, currentFirstNewMessageRow, kind)
  if (outcome === 'undecidable') return stash()
  if (outcome === 'no-advance') {
    if (options.isActive && currentFirstNewMessageRow !== undefined) {
      return { kind: 'resolved-active', markerPointer: makeReadPointer(match, kind) }
    }
    return meta.pendingRemoteDisplayedStanzaId === stanzaId
      ? { kind: 'clear-pending' }
      : { kind: 'unchanged' }
  }
  const readPointer = outcome

  if (!options.isActive) {
    return { kind: 'advanced', readPointer }
  }
  return { kind: 'advanced-active', readPointer }
}

// ============================================================================
// First-open-per-session gate for the activation fold
// ============================================================================

/**
 * XEP-0490 markers broadcast live over PEP, so the activation fold applies a
 * pending marker only ONCE per distinct value per session — re-folding the same
 * marker on every open would reposition the divider on each return, and the live
 * `read:displayed-synced` notifies already keep LOADED entities current.
 *
 * The gate keys on (id, stanzaId), not just id: a live notify that arrives while
 * an entity is INACTIVE has no resident message array to advance against (memory
 * windowing evicts it), so it can only stash the position as
 * `pendingRemoteDisplayedStanzaId`. The next activation fold is then the only way
 * to apply it. Keying on id alone would suppress that fold (the entity was opened
 * before), leaving reads synced from another device stuck as unread. Keying on
 * the stanza-id instead re-arms for a genuinely newer marker while still skipping
 * the identical one.
 *
 * Only RESOLVED folds are recorded (via `markFolded`, called by
 * {@link foldPendingRemoteDisplayed} when the apply actually advanced or cleared
 * the marker). A fold that stashed — the loaded slice could not order the marker
 * against the local pointer — never took effect, so recording it would strand
 * the marker: the next activation would skip the fold as "already consumed"
 * while no merge may ever retry it. Each store owns one gate instance; `reset()`
 * on account switch.
 */
export interface MdsSessionGate {
  /**
   * True when `stanzaId` has not been folded-and-RESOLVED for `id` this
   * session — the first marker, any newer/different one, or a marker whose
   * earlier fold attempts all stashed.
   */
  shouldFold(id: string, stanzaId: string): boolean
  /** Record a fold that actually resolved (advanced or cleared the marker). */
  markFolded(id: string, stanzaId: string): void
  reset(): void
}

export function createMdsSessionGate(): MdsSessionGate {
  const folded = new Map<string, string>()
  return {
    shouldFold(id: string, stanzaId: string): boolean {
      return folded.get(id) !== stanzaId
    },
    markFolded(id: string, stanzaId: string): void {
      folded.set(id, stanzaId)
    },
    reset(): void {
      folded.clear()
    },
  }
}

/** Outcome of one activation-fold attempt, for the caller's debug logging. */
export interface ActivationFoldResult {
  /** The pending stanza-id that was considered (undefined = nothing pending). */
  pending?: string
  /** True when the fold ran (a marker was pending and the gate allowed it). */
  attempted: boolean
  /** True when the fold resolved the marker (advanced or cleared) — the pending mark is gone. */
  resolved: boolean
}

/**
 * One activation-fold attempt: apply the pending XEP-0490 marker (if any and
 * not already resolved this session) and record it on the gate ONLY when it
 * actually resolved. Shared by chatStore.activateConversation and
 * roomStore.activateRoom, which call it twice per activation:
 * once against the freshly loaded latest slice, and again after a load-around
 * may have brought the marker and local pointer into one orderable slice.
 */
export function foldPendingRemoteDisplayed(
  gate: MdsSessionGate,
  id: string,
  getPending: () => string | undefined,
  apply: (stanzaId: string) => void
): ActivationFoldResult {
  const pending = getPending()
  if (pending === undefined) return { attempted: false, resolved: false }
  if (!gate.shouldFold(id, pending)) return { pending, attempted: false, resolved: false }
  apply(pending)
  const resolved = getPending() !== pending
  if (resolved) gate.markFolded(id, pending)
  return { pending, attempted: true, resolved }
}
