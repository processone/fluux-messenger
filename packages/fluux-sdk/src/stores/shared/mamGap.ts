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
