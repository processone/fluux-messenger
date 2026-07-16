/**
 * Shared MAM (Message Archive Management) state utilities.
 *
 * These utilities provide common MAM state management logic used by both
 * chatStore and roomStore to reduce code duplication.
 *
 * MAM queries can go in two directions:
 * - **Backward** (using `before` cursor): Load older history when scrolling up
 * - **Forward** (using `start` filter): Catch up to present time after reconnect
 *
 * The two completion markers track these independently:
 * - `isHistoryComplete`: No more older messages (reached beginning of archive)
 * - `isCaughtUpToLive`: Synced with real-time (no gap to present)
 */

import type { MAMQueryState } from '../../core/types'

/**
 * Default MAM query state for conversations/rooms that haven't been queried yet.
 */
export const DEFAULT_MAM_STATE: MAMQueryState = {
  isLoading: false,
  error: null,
  hasQueried: false,
  isHistoryComplete: false,
  isCaughtUpToLive: false,
}

/**
 * Get MAM query state for a conversation/room, returning default if not found.
 */
export function getMAMQueryState(
  states: Map<string, MAMQueryState>,
  id: string
): MAMQueryState {
  return states.get(id) || DEFAULT_MAM_STATE
}

/**
 * Create a new MAM states map with loading state updated.
 */
export function setMAMLoading(
  states: Map<string, MAMQueryState>,
  id: string,
  isLoading: boolean
): Map<string, MAMQueryState> {
  const newStates = new Map(states)
  const current = newStates.get(id) || DEFAULT_MAM_STATE
  newStates.set(id, { ...current, isLoading })
  return newStates
}

/**
 * Create a new MAM states map with error state updated.
 */
export function setMAMError(
  states: Map<string, MAMQueryState>,
  id: string,
  error: string | null
): Map<string, MAMQueryState> {
  const newStates = new Map(states)
  const current = newStates.get(id) || DEFAULT_MAM_STATE
  newStates.set(id, { ...current, error, isLoading: false })
  return newStates
}

/**
 * Query direction for MAM queries.
 */
export type MAMQueryDirection = 'backward' | 'forward'

/**
 * Newest fetched message timestamp (epoch ms), for gap marker positioning by
 * a forward catch-up. `undefined` for backward queries or an empty page —
 * matches the `newestFetchedTimestamp` argument expected by
 * `setMAMQueryCompleted` below. Shared by `chatStore`/`roomStore` to fold
 * their identical inline computation.
 */
export function computeNewestFetchedTimestamp(
  fetched: Array<{ timestamp?: Date }>,
  direction: MAMQueryDirection
): number | undefined {
  return direction === 'forward' && fetched.length > 0
    ? Math.max(...fetched.map(m => m.timestamp?.getTime() ?? 0))
    : undefined
}

/**
 * Create a new MAM states map with query completed state.
 *
 * @param states - Current MAM states map
 * @param id - Conversation/room ID
 * @param complete - Whether the server indicated the query is complete
 * @param direction - Query direction: 'backward' for older history, 'forward' for catching up
 * @param oldestFetchedId - ID of oldest fetched message for pagination
 * @param newestFetchedTimestamp - Epoch ms of the newest fetched message (for gap marker positioning)
 * @param preserveGapMarker - Leave forwardGapTimestamp untouched (bounded windowed queries)
 * @param isFetchLatest - A `before:''` fetch-latest merge: the window is the live edge by
 *   definition (SM/carbons own everything newer), regardless of `complete`.
 */
export function setMAMQueryCompleted(
  states: Map<string, MAMQueryState>,
  id: string,
  complete: boolean,
  direction: MAMQueryDirection,
  oldestFetchedId?: string,
  newestFetchedTimestamp?: number,
  preserveGapMarker = false,
  isFetchLatest = false
): Map<string, MAMQueryState> {
  const newStates = new Map(states)
  const current = newStates.get(id) || DEFAULT_MAM_STATE

  // Update the appropriate completion marker based on direction
  const isHistoryComplete = direction === 'backward'
    ? complete
    : current.isHistoryComplete

  // Forward: complete === reached live. Fetch-latest: the window IS the live
  // edge by definition (SM/carbons own everything newer), regardless of
  // `complete` (which only says whether OLDER history is exhausted) — without
  // this, an entity synced via fetch-latest is re-seeded on every SM resume.
  const isCaughtUpToLive = direction === 'forward'
    ? complete
    : isFetchLatest
      ? true
      : current.isCaughtUpToLive

  // Track gap position for incomplete forward catch-ups.
  // Set when forward catch-up ends without complete=true, cleared when caught up.
  //
  // `preserveGapMarker` leaves the existing marker untouched (neither set nor
  // cleared). Used by bounded "force repair" queries (forceCatchUpAllRooms),
  // which start from a fixed window — not the contiguous edge — so their
  // completion says nothing about whether older history is contiguous. Letting
  // such a query clear the marker would hide a real gap older than the window;
  // letting it set one would plant a spurious marker inside the window.
  const forwardGapTimestamp = preserveGapMarker
    ? current.forwardGapTimestamp
    : direction === 'forward'
      ? (complete ? undefined : newestFetchedTimestamp)
      : current.forwardGapTimestamp

  newStates.set(id, {
    isLoading: false,
    error: null,
    hasQueried: true,
    isHistoryComplete,
    isCaughtUpToLive,
    // Only update oldestFetchedId for backward queries
    oldestFetchedId: direction === 'backward' && oldestFetchedId
      ? oldestFetchedId
      : current.oldestFetchedId,
    forwardGapTimestamp,
  })
  return newStates
}

