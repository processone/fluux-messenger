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
 * Create a new MAM states map with query completed state.
 *
 * @param states - Current MAM states map
 * @param id - Conversation/room ID
 * @param complete - Whether the server indicated the query is complete
 * @param direction - Query direction: 'backward' for older history, 'forward' for catching up
 * @param oldestFetchedId - ID of oldest fetched message for pagination
 * @param newestFetchedTimestamp - Epoch ms of the newest fetched message (for gap marker positioning)
 */
export function setMAMQueryCompleted(
  states: Map<string, MAMQueryState>,
  id: string,
  complete: boolean,
  direction: MAMQueryDirection,
  oldestFetchedId?: string,
  newestFetchedTimestamp?: number
): Map<string, MAMQueryState> {
  const newStates = new Map(states)
  const current = newStates.get(id) || DEFAULT_MAM_STATE

  // Update the appropriate completion marker based on direction
  const isHistoryComplete = direction === 'backward'
    ? complete
    : current.isHistoryComplete

  const isCaughtUpToLive = direction === 'forward'
    ? complete
    : current.isCaughtUpToLive

  // Track gap position for incomplete forward catch-ups.
  // Set when forward catch-up ends without complete=true, cleared when caught up.
  const forwardGapTimestamp = direction === 'forward'
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
    // Clear needsCatchUp after successful query
    needsCatchUp: false,
    forwardGapTimestamp,
  })
  return newStates
}

/**
 * Mark all conversations/rooms as needing a catch-up MAM query.
 * Called on reconnect to ensure open conversations fetch new messages.
 */
export function markAllNeedsCatchUp(
  states: Map<string, MAMQueryState>
): Map<string, MAMQueryState> {
  const newStates = new Map(states)
  for (const [id, state] of newStates) {
    newStates.set(id, { ...state, needsCatchUp: true })
  }
  return newStates
}

/**
 * Clear the needsCatchUp flag for a specific conversation/room.
 * Called after catch-up query completes or when manually cleared.
 */
export function clearNeedsCatchUp(
  states: Map<string, MAMQueryState>,
  id: string
): Map<string, MAMQueryState> {
  const current = states.get(id)
  if (!current || !current.needsCatchUp) return states

  const newStates = new Map(states)
  newStates.set(id, { ...current, needsCatchUp: false })
  return newStates
}

