/**
 * The sliding-window bound: the maximum number of messages kept RESIDENT in memory per
 * conversation. The rest live durably in IndexedDB (+ MAM on the server) and are paged in/out
 * as the window slides. Production value is 5000.
 *
 * It is read through {@link getResidentWindowSize} (not a bare const) so a DEV/DEMO/TEST caller
 * can shrink it via {@link setResidentWindowSize} — this lets the sliding / load-newer /
 * jump-to-latest paths be exercised in an e2e with a few hundred messages instead of seeding
 * 5000+ (reaching the real cap by scrolling would take ~100 load-older triggers). It is NEVER
 * changed in production; the demo gates the setter behind a `?window=` URL param.
 */
const DEFAULT_RESIDENT_WINDOW_SIZE = 5000

let residentWindowSize = DEFAULT_RESIDENT_WINDOW_SIZE

/** Current sliding-window bound (messages kept resident per conversation). */
export function getResidentWindowSize(): number {
  return residentWindowSize
}

/**
 * DEV/DEMO/TEST ONLY — shrink (or restore) the resident window so the sliding path is testable
 * with a small backlog. Clamped to a sane floor. Pass {@link DEFAULT_RESIDENT_WINDOW_SIZE} to reset.
 */
export function setResidentWindowSize(size: number): void {
  residentWindowSize = Math.max(1, Math.floor(size))
}

/**
 * The most live arrivals a conversation or room keeps resident while it is NOT the active one.
 * Only the active view needs a long window; opening a conversation reloads what the durable cache
 * holds. A window holding memory-only messages (nothing stored locally, so the cache cannot give
 * them back) is exempt and keeps the full bound; see {@link idleResidentWindowFor}. Rows pushed out
 * of the short tail stay recognisable as duplicates through `idleEvictedLedger`.
 */
const IDLE_RESIDENT_WINDOW_SIZE = 200

/** Resident bound for a conversation or room that is not currently active. */
export function getIdleResidentWindowSize(): number {
  return Math.min(IDLE_RESIDENT_WINDOW_SIZE, residentWindowSize)
}

/**
 * The bound for an idle window about to take `incoming`: the short tail, unless the window or the
 * arrival holds a memory-only message, which cannot be reloaded from the cache and so keeps the
 * full window.
 */
export function idleResidentWindowFor<T>(
  resident: readonly T[],
  incoming: T,
  isMemoryOnly: (message: T) => boolean
): number {
  return isMemoryOnly(incoming) || resident.some(isMemoryOnly)
    ? residentWindowSize
    : getIdleResidentWindowSize()
}
