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
 * Set/clear the `coverageBottomUnproven` flag for one entity.
 *
 * Copy-on-write: returns the SAME map reference when the effective value is
 * unchanged (treating undefined as false), so callers skip re-renders. Set
 * `true` when a disjoint fetch-latest landed with no proven boundary; set
 * `false` when a merge proves a boundary. Leave the flag alone by simply not
 * calling this — true only because `setMAMQueryCompleted` below (called on
 * every merge, always before this) explicitly carries the field forward
 * unchanged rather than rebuilding it from scratch.
 */
export function setCoverageBottomUnproven(
  states: Map<string, MAMQueryState>,
  id: string,
  value: boolean
): Map<string, MAMQueryState> {
  const current = states.get(id) || DEFAULT_MAM_STATE
  if (!!current.coverageBottomUnproven === value) return states
  const newStates = new Map(states)
  newStates.set(id, { ...current, coverageBottomUnproven: value })
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
 * True when a backward page resumed from a cursor that is NOT in the resident
 * window — i.e. the page is disjoint from, and below, what the user can
 * currently scroll through.
 *
 * The read-pointer stitch (catch-up Phase B) seeds its walk from the persisted
 * coverage bottom / gap edge / true cache bottom, which on an active entity sits
 * far below the resident window (the activation slice is only the latest N).
 * When that walk reaches the archive start the server reports `complete: true`,
 * but that describes the ARCHIVE bottom — not the user's visible timeline. Only
 * a page that resumed from the resident window's own bottom (ordinary
 * scroll-back) proves the visible timeline reached the beginning.
 *
 * Conservative by construction: returns true only on positive proof of
 * disjointness. A fetch-latest (`before:''`) swallows the live edge and is never
 * disjoint; an absent cursor or an empty resident array carries no proof, so
 * both preserve the previous behavior.
 */
export function isDisjointFromResidentWindow(
  existing: Array<{ stanzaId?: string }>,
  initialBefore: string | undefined,
  isFetchLatest: boolean
): boolean {
  if (isFetchLatest) return false
  if (!initialBefore) return false
  if (existing.length === 0) return false
  return !existing.some((m) => m.stanzaId === initialBefore)
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
 * @param disjointFromResidentWindow - The backward page resumed from a cursor below the
 *   resident window (see {@link isDisjointFromResidentWindow}); its `complete` describes
 *   the archive bottom, not the user's visible timeline.
 */
export function setMAMQueryCompleted(
  states: Map<string, MAMQueryState>,
  id: string,
  complete: boolean,
  direction: MAMQueryDirection,
  oldestFetchedId?: string,
  newestFetchedTimestamp?: number,
  preserveGapMarker = false,
  isFetchLatest = false,
  disjointFromResidentWindow = false
): Map<string, MAMQueryState> {
  const newStates = new Map(states)
  const current = newStates.get(id) || DEFAULT_MAM_STATE

  // Update the appropriate completion marker based on direction.
  // A backward page that resumed BELOW the resident window (Phase B's
  // read-pointer stitch) proves only that the ARCHIVE has nothing older than
  // its own cursor — the user's timeline still starts at the resident top, and
  // marking it complete would strand every older message (including history
  // already sitting in the local cache) behind a "beginning of conversation"
  // marker with load-more disabled.
  const isHistoryComplete = direction === 'backward' && !disjointFromResidentWindow
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
  //
  // Incomplete forward with NO fetched timestamp (a signal-only page:
  // reactions/receipts only, zero displayable messages) PRESERVES the current
  // marker — such a page proves nothing about the hole, and clearing the
  // marker here would let the persisted-gap mirror (syncGapAfterArchiveMerge)
  // delete the recorded GapInterval: a permanent silent hole. Coverage still
  // advances id-exactly via the gap's startId (rsm.last IS set for
  // signal-only pages; see mamGap.ts).
  const forwardGapTimestamp = preserveGapMarker
    ? current.forwardGapTimestamp
    : direction === 'forward'
      ? (complete ? undefined : (newestFetchedTimestamp ?? current.forwardGapTimestamp))
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
    // Not owned by this setter — preserved as-is. Set/cleared only by
    // setCoverageBottomUnproven (called separately by the coverage-proof
    // block in chatStore/roomStore). Every merge calls this setter, so
    // omitting the field here would silently wipe it on any merge that
    // doesn't re-affirm it (e.g. a later forward Phase-A page, an ordinary
    // backward scroll, or an all-deduped merge).
    coverageBottomUnproven: current.coverageBottomUnproven,
  })
  return newStates
}

