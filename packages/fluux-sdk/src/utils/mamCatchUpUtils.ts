/**
 * Shared MAM catch-up utilities.
 *
 * Extracted from chatSideEffects, roomSideEffects, MAM, and backgroundSync
 * to provide a single source of truth for catch-up logic, constants, and
 * error classification.
 *
 * @module Utils/MAMCatchUp
 */

// ============================================================================
// Constants
// ============================================================================

/** Max messages per forward catch-up query (used in side effects and background sync). */
export const MAM_CATCHUP_FORWARD_MAX = 100

/** Max messages for backward queries when no cached messages exist. */
export const MAM_CATCHUP_BACKWARD_MAX = 50

/** Max concurrent MAM queries during background sync. */
export const MAM_BACKGROUND_CONCURRENCY = 2

/** Number of messages to load from IndexedDB cache before a MAM query. */
export const MAM_CACHE_LOAD_LIMIT = 100

/** Delay (ms) before room catch-up starts, to let rooms finish joining. */
export const MAM_ROOM_CATCHUP_DELAY_MS = 10_000

/** Max auto-pagination pages for forward room MAM catch-up.
 *  Room traffic is typically higher than 1:1, so we allow many more pages
 *  (50 × 100 = 5 000 stanzas) to close the gap after long offline periods.
 *  The loop still breaks early on `complete=true`. */
export const MAM_ROOM_FORWARD_MAX_PAGES = 50

// ============================================================================
// Functions
// ============================================================================

/**
 * Find the newest message in an array (regardless of delay status).
 *
 * Walks the array backwards (most recent first) and returns the first
 * entry that has a `timestamp`. Including delayed messages ensures the
 * catch-up always uses a forward query, which merges correctly via full
 * sort. Previously skipping delayed messages caused backward queries
 * whose prepend-based merge put newer messages at the wrong position.
 */
export function findNewestMessage(messages: Array<{ timestamp?: Date }>): { timestamp: Date } | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].timestamp) return messages[i] as { timestamp: Date }
  }
  return undefined
}

/**
 * Build a MAM `start` filter value from the newest cached message.
 *
 * Adds 1 ms to avoid re-fetching the cursor message itself. This
 * pattern is used in every catch-up site (chat side effects, room side
 * effects, MAM background catch-up).
 */
export function buildCatchUpStartTime(newestTimestamp: Date): string {
  return new Date(newestTimestamp.getTime() + 1).toISOString()
}

/**
 * Classify whether an error is a transient connection error.
 *
 * Connection errors are expected during reconnection cycles and should
 * be logged at info level rather than error level.
 */
export function isConnectionError(error: unknown): boolean {
  if (!(error instanceof Error)) return false
  const msg = error.message
  return (
    msg.includes('disconnected') ||
    msg.includes('Not connected') ||
    msg.includes('Socket not available')
  )
}
