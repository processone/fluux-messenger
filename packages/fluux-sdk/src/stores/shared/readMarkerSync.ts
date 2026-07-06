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
 * XEP-0490 markers broadcast live over PEP, so a pending marker is folded
 * into the divider only on the FIRST open of an entity per session — later
 * opens rely on the live notifies (re-folding would reposition the divider on
 * every return). Each store owns one gate instance; `reset()` on account
 * switch.
 */
export interface MdsSessionGate {
  /** True on the first call for this id since the last reset. Records the id. */
  consume(id: string): boolean
  reset(): void
}

export function createMdsSessionGate(): MdsSessionGate {
  const consumed = new Set<string>()
  return {
    consume(id: string): boolean {
      const first = !consumed.has(id)
      consumed.add(id)
      return first
    },
    reset(): void {
      consumed.clear()
    },
  }
}
