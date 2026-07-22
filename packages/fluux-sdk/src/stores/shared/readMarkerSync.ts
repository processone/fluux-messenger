/**
 * XEP-0490 (Message Displayed Synchronization) remote-read-position
 * resolution — shared by chatStore and roomStore, whose applyRemoteDisplayed
 * implementations were ~100-line twins that had to be kept in sync by hand.
 *
 * The stores keep their map fan-out (meta / combined / markers) and apply the
 * returned resolution; everything decision-shaped lives here.
 */

import type { NotificationMessage } from './notificationState'
import * as notifState from './notificationState'
import { makeReadPointer, type ReadPointer } from './readPointer'

/** The notification-relevant slice of a conversation/room metadata entry. */
export interface ReadMarkerMeta {
  unreadCount: number
  mentionsCount: number
  lastReadAt?: Date
  lastSeenMessageId?: string
  /** Canonical read position, written alongside lastSeenMessageId (#1081). */
  readPointer?: ReadPointer
  pendingRemoteDisplayedStanzaId?: string
}

export type RemoteDisplayedResolution =
  /**
   * The referenced message is not loaded — remember the stanza-id as a
   * pending high-water mark, to be resolved when messages arrive.
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
   * Forward advance on a non-active entity (divider recomputes on next
   * activation). `readPointer` names the same message as `lastSeenMessageId` —
   * the store writes both together (#1081).
   */
  | { kind: 'advanced'; lastSeenMessageId: string; readPointer: ReadPointer }
  /**
   * Forward advance on the ACTIVE entity: the new-message divider was already
   * derived at activation from the now-stale local position, so it is
   * recomputed here from the advanced position. `firstNewMessageId`
   * undefined = no divider (delete the marker).
   */
  | {
      kind: 'advanced-with-divider'
      lastSeenMessageId: string
      readPointer: ReadPointer
      firstNewMessageId: string | undefined
    }

export function resolveRemoteDisplayed<T extends NotificationMessage & { stanzaId?: string }>(
  meta: ReadMarkerMeta,
  messages: T[],
  currentFirstNewMessageId: string | undefined,
  stanzaId: string,
  options: { isActive: boolean; treatDelayedAsNew?: boolean }
): RemoteDisplayedResolution {
  const match = messages.find((m) => m.stanzaId === stanzaId)
  if (!match) return { kind: 'stash-pending' }

  // Forward-only advance using the shared comparator (compares by index).
  const updated = notifState.onMessageSeen(
    {
      unreadCount: meta.unreadCount,
      mentionsCount: meta.mentionsCount,
      lastReadAt: meta.lastReadAt,
      lastSeenMessageId: meta.lastSeenMessageId,
      readPointer: meta.readPointer,
      firstNewMessageId: currentFirstNewMessageId,
    },
    match.id,
    messages
  )

  if (updated.lastSeenMessageId === meta.lastSeenMessageId || updated.lastSeenMessageId === undefined) {
    return meta.pendingRemoteDisplayedStanzaId === undefined
      ? { kind: 'unchanged' }
      : { kind: 'clear-pending' }
  }

  // An advance always lands on `match` (onMessageSeen only ever moves to the id
  // it was given), so `onMessageSeen` has already resolved `updated.readPointer`
  // to `makeReadPointer(match)` for us — reuse it instead of recomputing the
  // same pointer a second time. It can only be undefined here if `match.id`
  // were absent from `messages`, which can't happen: `match` itself came from
  // `messages.find(...)` above.
  const readPointer = updated.readPointer ?? makeReadPointer(match)

  if (!options.isActive) {
    return { kind: 'advanced', lastSeenMessageId: updated.lastSeenMessageId, readPointer }
  }

  // Recompute the divider from the advanced position (reuses onActivate's
  // forward scan). Both callers pass treatDelayedAsNew: chats because delayed
  // means offline delivery, rooms because delayed history after the pointer
  // is unread (unified divider semantics).
  const divider = notifState.onActivate(
    {
      unreadCount: 0,
      mentionsCount: 0,
      lastReadAt: meta.lastReadAt,
      lastSeenMessageId: updated.lastSeenMessageId,
      readPointer,
      firstNewMessageId: undefined,
    },
    messages,
    options.treatDelayedAsNew ? { treatDelayedAsNew: true } : undefined
  ).firstNewMessageId

  return {
    kind: 'advanced-with-divider',
    lastSeenMessageId: updated.lastSeenMessageId,
    readPointer,
    firstNewMessageId: divider,
  }
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
 * the marker). A fold that stashed — the marker's message wasn't in the loaded
 * slice — never took effect, so recording it would strand the marker: the next
 * activation would skip the fold as "already consumed" while no merge may ever
 * retry it. Each store owns one gate instance; `reset()` on account switch.
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
 * of a deep stale pointer may have brought the marker's message into the slice.
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
