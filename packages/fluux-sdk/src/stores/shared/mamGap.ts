/**
 * Persisted room history-gap metadata.
 *
 * A `GapInterval` records a *known* hole in a room's archived history: messages
 * are held below `start` and (when `end` is set) above `end`, with a gap in
 * between. Unlike the ephemeral `forwardGapTimestamp` in `mamQueryStates`, room
 * gaps are persisted to localStorage so the "Load missing messages" marker
 * survives a reload — otherwise the next session's catch-up cursor (which sits
 * *above* the gap after the session-start fix) would never re-detect it, leaving
 * the gap silent again.
 *
 * Detection is driven ONLY by the reliable signal: a forward catch-up that ended
 * `complete=false` (the server said there is more, and we stopped at the page
 * cap). We never infer holes from timestamp discontinuities — a quiet period and
 * a real gap are indistinguishable by timestamp, and ejabberd archive ids are
 * non-sequential.
 *
 * @module Stores/Shared/MamGap
 */

/** A known hole in a room's archived history. */
export interface GapInterval {
  /** Epoch ms of the newest message held *below* the gap (where it starts). */
  start: number
  /** Epoch ms of the oldest message held *above* the gap, or undefined if the
   *  gap extends to the live edge (nothing newer is held yet). */
  end?: number
}

/**
 * Find the upper bound of a gap: the oldest message strictly newer than `start`.
 * Returns undefined when nothing is held above the gap (it extends to live).
 *
 * Robust to unsorted input.
 */
export function computeGapEnd(messages: Array<{ timestamp?: Date }>, start: number): number | undefined {
  let end: number | undefined
  for (const message of messages) {
    const ts = message.timestamp?.getTime()
    if (ts === undefined || ts <= start) continue
    if (end === undefined || ts < end) end = ts
  }
  return end
}

/**
 * Pure transition for the per-room gap map.
 *
 * - `start` defined → record/update the gap interval for `jid`.
 * - `start` undefined → clear the gap for `jid`.
 *
 * Copy-on-write: returns the SAME map reference when nothing changes, so callers
 * can skip persistence and re-renders.
 */
export function syncGap(
  gaps: Map<string, GapInterval>,
  jid: string,
  start: number | undefined,
  end: number | undefined,
): Map<string, GapInterval> {
  const existing = gaps.get(jid)

  if (start === undefined) {
    if (!existing) return gaps
    const next = new Map(gaps)
    next.delete(jid)
    return next
  }

  if (existing && existing.start === start && existing.end === end) return gaps

  const next = new Map(gaps)
  next.set(jid, end === undefined ? { start } : { start, end })
  return next
}

/** Serialize the gap map for localStorage (`[jid, GapInterval][]`). */
export function serializeGaps(gaps: Map<string, GapInterval>): string {
  return JSON.stringify(Array.from(gaps.entries()))
}

/** Parse the gap map from localStorage; returns an empty map on any error. */
export function deserializeGaps(json: string): Map<string, GapInterval> {
  try {
    const entries = JSON.parse(json) as [string, GapInterval][]
    return new Map(entries)
  } catch {
    return new Map()
  }
}

/** Min/max timestamps (epoch ms) of a message page. Robust to unsorted input
 *  and messages without timestamps. */
export interface PageExtent {
  oldestTs?: number
  newestTs?: number
}

/** Compute the timestamp extent of a page of messages. */
export function messagePageExtent(messages: Array<{ timestamp?: Date }>): PageExtent {
  let oldestTs: number | undefined
  let newestTs: number | undefined
  for (const message of messages) {
    const ts = message.timestamp?.getTime()
    if (ts === undefined) continue
    if (oldestTs === undefined || ts < oldestTs) oldestTs = ts
    if (newestTs === undefined || ts > newestTs) newestTs = ts
  }
  return { oldestTs, newestTs }
}

/**
 * Detect a disjoint fetch-latest page: a backward `before:''` page that landed
 * entirely above held history without any connection proof.
 *
 * All checks are STRUCTURAL — direction, dedupe overlap, archive-id backfill,
 * above/below ordering — never a gap-size heuristic:
 * - any dedupe hit (`newMessagesCount < fetched.length`) or archive-id backfill
 *   (`patchedCount > 0`) proves the page connects to held history → no seam;
 * - nothing held below → nothing to disconnect from → no seam;
 * - a page that interleaves with held history is ambiguous → no seam
 *   (conservative: never plant a marker on uncertain evidence).
 *
 * @param fetched - The incoming page, as handed to the merge
 * @param newMessagesCount - How many of `fetched` survived dedupe (merge output)
 * @param patchedCount - Archive-id backfills onto held messages (merge output)
 * @param newestHeldBelowTs - Newest message held BEFORE this merge (resident
 *   newest, or the persisted preview timestamp when the resident array is empty)
 * @returns The seam to record, or undefined when the page is connected/ambiguous
 */
export function detectFetchLatestSeam(
  fetched: Array<{ timestamp?: Date }>,
  newMessagesCount: number,
  patchedCount: number,
  newestHeldBelowTs: number | undefined,
): GapInterval | undefined {
  if (fetched.length === 0) return undefined
  if (newMessagesCount < fetched.length || patchedCount > 0) return undefined
  if (newestHeldBelowTs === undefined) return undefined
  const { oldestTs } = messagePageExtent(fetched)
  if (oldestTs === undefined) return undefined
  if (oldestTs <= newestHeldBelowTs) return undefined
  return { start: newestHeldBelowTs, end: oldestTs }
}

/**
 * Reconcile a recorded gap against a merged BACKWARD page (scroll-up
 * pagination). Backward pages walk contiguously down from their cursor, so a
 * page's extent proves the span it covered:
 *
 * - page entirely below the gap (`newestTs <= start`): older-region pagination,
 *   says nothing about the gap — even `complete` (archive start below the gap)
 *   must not clear it;
 * - `complete` from at/above the gap: everything below the cursor was fetched,
 *   the gap region included → clear;
 * - page reaching held history below (`oldestTs <= start`): regions connected → clear;
 * - page reaching into the gap from above: shrink (`end` moves down to the
 *   page's oldest);
 * - empty page: no positional info → unchanged.
 *
 * @returns The new gap (`undefined` = clear); returns `gap` by reference when unchanged.
 */
export function closeGapWithBackwardPage(
  gap: GapInterval,
  page: PageExtent,
  complete: boolean,
): GapInterval | undefined {
  if (page.oldestTs === undefined || page.newestTs === undefined) return gap
  if (page.newestTs <= gap.start) return gap
  if (complete) return undefined
  if (page.oldestTs <= gap.start) return undefined
  if (gap.end === undefined || page.oldestTs < gap.end) return { start: gap.start, end: page.oldestTs }
  return gap
}
