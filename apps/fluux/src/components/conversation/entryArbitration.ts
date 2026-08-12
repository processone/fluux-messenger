/**
 * Pure arbitration of what a conversation entry positions to.
 *
 * Entry selects exactly ONE provisional request, in this priority order:
 *
 *   1. an already-resolved synced live edge, which invalidates stale local state;
 *   2. a saved position (fixed anchor, or a transitional raw-only offset);
 *   3. the first unread message;
 *   4. the live edge.
 *
 * An explicit reply/search/activity target is deliberately NOT folded into that table. It is a
 * separate, newer request that supersedes the provisional entry choice, so entry only steps aside
 * for it.
 *
 * Value-only: no DOM, no controller, no persistence. The caller supplies what the persistence
 * adapter and the store already decided, and applies the verdict.
 */

import type { ScrollEntryAction } from './scrollPersistenceAdapter'

/**
 * What the persistence adapter concluded from the stored state. Only `restore-position` is
 * distinguished here: `no-action` and `scroll-to-bottom` both leave entry free to choose from the
 * remaining priority table.
 */
export type PersistedEntryAction = ScrollEntryAction

export type EntryBranch =
  | 'saved-position'
  | 'unread-marker'
  | 'defer-to-target'
  | 'live-edge'

export interface EntryArbitrationInput {
  persistedAction: PersistedEntryAction
  /** Read pointer the saved position was written against. */
  savedReadPositionId: string | undefined
  firstUnreadMessageId: string | undefined
  /** The read pointer as currently known, including one synced from another device. */
  readPointerId: string | undefined
  lastMessageId: string | undefined
  targetMessageId: string | null | undefined
}

export interface EntryArbitration {
  /**
   * The remote pointer already identifies the newest downloaded row, and it is not the pointer the
   * saved position was written against. The saved position is therefore stale and must not win
   * merely because no unread divider exists.
   */
  syncedLiveEdgeSupersedes: boolean
  /** Retire the persisted position, because the synced pointer superseded it. */
  clearSavedPosition: boolean
  /**
   * Watch for a pointer that resolves AFTER this entry. With no divider, observing that transition
   * is the only signal that the restore became obsolete.
   */
  armPendingSyncedLiveEdge: boolean
  branch: EntryBranch
  /**
   * Entry marks the list not-at-bottom for every branch but the live edge, so the content-growth
   * observer cannot auto-pin while entry is still aiming somewhere else.
   */
  entersAtBottom: boolean
}

/**
 * Does an already-resolved synced read pointer invalidate the saved position?
 *
 * All five conditions matter. Dropping any one of them lets a saved position lose to a pointer that
 * is not actually newer, or lets a genuine unread divider be skipped.
 */
export function isSyncedLiveEdgeEntry(input: EntryArbitrationInput): boolean {
  return (
    input.persistedAction === 'restore-position' &&
    // An unread divider is a stronger, more specific signal; never override it here.
    input.firstUnreadMessageId === undefined &&
    input.readPointerId !== undefined &&
    // The pointer must name the newest row we hold, not merely some newer row.
    input.readPointerId === input.lastMessageId &&
    // Equal pointers mean the saved position already reflects this read state.
    input.readPointerId !== input.savedReadPositionId
  )
}

export function arbitrateEntry(input: EntryArbitrationInput): EntryArbitration {
  const syncedLiveEdgeSupersedes = isSyncedLiveEdgeEntry(input)
  const restoring =
    input.persistedAction === 'restore-position' && !syncedLiveEdgeSupersedes

  const branch: EntryBranch = restoring
    ? 'saved-position'
    : input.firstUnreadMessageId !== undefined
      ? 'unread-marker'
      : input.targetMessageId
        ? 'defer-to-target'
        : 'live-edge'

  return {
    syncedLiveEdgeSupersedes,
    clearSavedPosition: syncedLiveEdgeSupersedes,
    armPendingSyncedLiveEdge: restoring,
    branch,
    entersAtBottom: branch === 'live-edge',
  }
}

export interface LateSyncedLiveEdgeInput {
  /** Entry armed the watch for this conversation. */
  armedForConversation: string | undefined
  conversationId: string
  staticMode: boolean
  /** The reader has taken over, so no automatic correction may follow. */
  hasGenuineInput: boolean
  firstUnreadMessageId: string | undefined
  readPointerId: string | undefined
  lastMessageId: string | undefined
  /** Pointer the armed restore was written against. */
  armedSavedReadPositionId: string | undefined
}

/**
 * The zero-unread twin of the divider-clear settle: a restore can land BEFORE MAM resolves another
 * device's pointer to the newest downloaded row. With no divider, that pointer transition is the
 * only evidence the restore is obsolete.
 */
export function shouldSupersedeWithLateSyncedLiveEdge(
  input: LateSyncedLiveEdgeInput,
): boolean {
  if (input.armedForConversation !== input.conversationId) return false
  if (input.staticMode || input.hasGenuineInput) return false
  if (input.firstUnreadMessageId !== undefined) return false
  if (input.readPointerId === undefined) return false
  if (input.readPointerId !== input.lastMessageId) return false
  return input.readPointerId !== input.armedSavedReadPositionId
}
