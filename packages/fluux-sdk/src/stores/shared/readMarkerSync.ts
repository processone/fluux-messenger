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

/** The notification-relevant slice of a conversation/room metadata entry. */
export interface ReadMarkerMeta {
  unreadCount: number
  mentionsCount: number
  lastReadAt?: Date
  lastSeenMessageId?: string
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
  /** Forward advance on a non-active entity (divider recomputes on next activation). */
  | { kind: 'advanced'; lastSeenMessageId: string }
  /**
   * Forward advance on the ACTIVE entity: the new-message divider was already
   * derived at activation from the now-stale local position, so it is
   * recomputed here from the advanced position. `firstNewMessageId`
   * undefined = no divider (delete the marker).
   */
  | { kind: 'advanced-with-divider'; lastSeenMessageId: string; firstNewMessageId: string | undefined }

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

  if (!options.isActive) {
    return { kind: 'advanced', lastSeenMessageId: updated.lastSeenMessageId }
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
      firstNewMessageId: undefined,
    },
    messages,
    options.treatDelayedAsNew ? { treatDelayedAsNew: true } : undefined
  ).firstNewMessageId

  return {
    kind: 'advanced-with-divider',
    lastSeenMessageId: updated.lastSeenMessageId,
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
 * the identical one. Each store owns one gate instance; `reset()` on account switch.
 */
export interface MdsSessionGate {
  /**
   * True when `stanzaId` has not yet been folded for `id` this session — the
   * first marker, or any newer/different one. Re-presenting the same value
   * returns false. Records id → stanzaId.
   */
  consume(id: string, stanzaId: string): boolean
  reset(): void
}

export function createMdsSessionGate(): MdsSessionGate {
  const consumed = new Map<string, string>()
  return {
    consume(id: string, stanzaId: string): boolean {
      const first = consumed.get(id) !== stanzaId
      consumed.set(id, stanzaId)
      return first
    },
    reset(): void {
      consumed.clear()
    },
  }
}
