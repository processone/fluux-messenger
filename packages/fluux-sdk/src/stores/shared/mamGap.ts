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
 * Detection is driven ONLY by reliable structural signals — never by timestamp
 * discontinuities (a quiet period and a real gap are indistinguishable by
 * timestamp, and ejabberd archive ids are non-sequential):
 * 1. a forward catch-up that ended `complete=false` (the server said there is
 *    more, and we stopped at the page cap);
 * 2. a `before:''` fetch-latest page that landed entirely above held history
 *    with no dedupe overlap — the page provably does not connect to what we
 *    hold, so the boundary between them is a seam (recorded at formation).
 * Recorded gaps close progressively from both directions: forward catch-up
 * resumes from the boundary; backward scroll-up pagination shrinks/clears the
 * gap when its pages reach into or across it.
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
  /** Archive id of the newest downloaded message below the gap — the per-device
   *  COVERAGE marker; id-exact resume cursor for the heal. Optional: legacy
   *  persisted gaps simply lack it and fall back to `start` (timestamp). */
  startId?: string
  /** Archive id of the oldest message held above the gap (mirrors `end`).
   *  Optional for the same legacy-tolerance reason as `startId`. */
  endId?: string
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
  startId?: string,
  endId?: string,
): Map<string, GapInterval> {
  const existing = gaps.get(jid)

  if (start === undefined) {
    if (!existing) return gaps
    const next = new Map(gaps)
    next.delete(jid)
    return next
  }

  if (
    existing &&
    existing.start === start &&
    existing.end === end &&
    existing.startId === startId &&
    existing.endId === endId
  ) return gaps

  const next = new Map(gaps)
  next.set(jid, {
    start,
    ...(end !== undefined ? { end } : {}),
    ...(startId ? { startId } : {}),
    ...(endId ? { endId } : {}),
  })
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

/** stanzaId of the oldest-timestamp message in a page (undefined when absent). */
export function oldestMessageStanzaId(
  messages: Array<{ timestamp?: Date; stanzaId?: string }>,
): string | undefined {
  let oldest: { ts: number; id?: string } | undefined
  for (const m of messages) {
    const ts = m.timestamp?.getTime()
    if (ts === undefined) continue
    if (!oldest || ts < oldest.ts) oldest = { ts, id: m.stanzaId }
  }
  return oldest?.id
}

/** stanzaId of the newest-timestamp message in a page that HAS a stanzaId
 *  (undefined when none do). Skips id-less newer messages — e.g. an own-sent
 *  pre-echo that hasn't been reflected with an archive id yet — so the
 *  id-exact resume cursor falls back to the newest message that carries one,
 *  rather than silently degrading to undefined. */
export function newestMessageStanzaId(
  messages: Array<{ timestamp?: Date; stanzaId?: string }>,
): string | undefined {
  let best: { ts: number; id: string } | undefined
  for (const m of messages) {
    if (!m.stanzaId) continue
    const ts = m.timestamp?.getTime()
    if (ts === undefined) continue
    if (!best || ts > best.ts) best = { ts, id: m.stanzaId }
  }
  return best?.id
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
 * @param newestHeldBelowId - Archive id of that newest-held-below message, when
 *   known — stamped as the seam's `startId` (id-exact resume cursor).
 * @returns The seam to record, or undefined when the page is connected/ambiguous
 */
export function detectFetchLatestSeam(
  fetched: Array<{ timestamp?: Date; stanzaId?: string }>,
  newMessagesCount: number,
  patchedCount: number,
  newestHeldBelowTs: number | undefined,
  newestHeldBelowId?: string,
): GapInterval | undefined {
  if (fetched.length === 0) return undefined
  if (newMessagesCount < fetched.length || patchedCount > 0) return undefined
  if (newestHeldBelowTs === undefined) return undefined
  const { oldestTs } = messagePageExtent(fetched)
  if (oldestTs === undefined) return undefined
  if (oldestTs <= newestHeldBelowTs) return undefined
  const endId = oldestMessageStanzaId(fetched)
  return {
    start: newestHeldBelowTs,
    end: oldestTs,
    ...(newestHeldBelowId ? { startId: newestHeldBelowId } : {}),
    ...(endId ? { endId } : {}),
  }
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
 * @param pageOldestId - stanzaId of the page's oldest-timestamp message, when
 *   known — stamped as the shrunk gap's `endId` (mirrors `end`).
 * @returns The new gap (`undefined` = clear); returns `gap` by reference when unchanged.
 */
export function closeGapWithBackwardPage(
  gap: GapInterval,
  page: PageExtent,
  complete: boolean,
  pageOldestId?: string,
): GapInterval | undefined {
  if (page.oldestTs === undefined || page.newestTs === undefined) return gap
  if (page.newestTs <= gap.start) return gap
  if (complete) return undefined
  if (page.oldestTs <= gap.start) return undefined
  if (gap.end === undefined || page.oldestTs < gap.end) {
    return {
      start: gap.start,
      end: page.oldestTs,
      ...(gap.startId ? { startId: gap.startId } : {}),
      ...(pageOldestId ? { endId: pageOldestId } : {}),
    }
  }
  return gap
}

/** Everything the gap transition needs from an archive merge, both directions. */
export interface ArchiveMergeGapInput {
  /** Current persisted gap map (`roomGaps` / `conversationGaps`). */
  gaps: Map<string, GapInterval>
  /** Room JID / conversation id. */
  id: string
  direction: 'backward' | 'forward'
  /** Server's `<fin complete=…>` for this merge. */
  complete: boolean
  /** `forwardGapTimestamp` AFTER `setMAMQueryCompleted` for this merge (forward only). */
  forwardGapTimestamp: number | undefined
  /** Merged timeline (for `computeGapEnd` on the forward path). */
  merged: Array<{ timestamp?: Date }>
  /** The incoming page, as handed to the merge. */
  fetched: Array<{ timestamp?: Date; stanzaId?: string }>
  /** How many of `fetched` survived dedupe. */
  newMessagesCount: number
  /** Archive-id backfills onto held messages. */
  patchedCount: number
  /** The query was a `before:''` fetch-latest. */
  isFetchLatest: boolean
  /** Newest message held BEFORE this merge (resident newest ?? persisted preview ts). */
  newestHeldBelowTs: number | undefined
  /** Archive id of the newest message held BEFORE this merge (mirrors
   *  `newestHeldBelowTs`) — stamped as a formed backward seam's `startId`. */
  newestHeldBelowId?: string
  /** Archive id of the last fetched message for an incomplete forward
   *  catch-up (the merge's `rsm.last`) — stamped as the forward gap's `startId`. */
  lastFetchedArchiveId?: string
  /** Bounded force-repair: leave the marker untouched (neither set nor cleared). */
  preserveGapMarker: boolean
}

/**
 * The single gap transition for BOTH stores and BOTH merge directions.
 *
 * Forward: mirror the (complete=false-driven) `forwardGapTimestamp` into the
 * persisted map — unchanged behavior, extracted from the near-twin blocks in
 * `mergeRoomMAMMessages` / `mergeMAMMessages`.
 *
 * Backward: an existing gap is reconciled against the page (closure takes
 * priority — a fetch-latest while a gap is already recorded must not re-plant
 * a shallower seam over a deeper one); otherwise a disjoint fetch-latest page
 * plants a new seam at formation.
 *
 * Copy-on-write: returns the same map reference when nothing changes, so
 * callers can skip persistence and re-renders.
 */
export function syncGapAfterArchiveMerge(input: ArchiveMergeGapInput): Map<string, GapInterval> {
  const {
    gaps, id, direction, complete, forwardGapTimestamp, merged, fetched,
    newMessagesCount, patchedCount, isFetchLatest, newestHeldBelowTs, newestHeldBelowId,
    lastFetchedArchiveId, preserveGapMarker,
  } = input

  if (preserveGapMarker) return gaps

  if (direction === 'forward') {
    const existing = gaps.get(id)
    // A signal-only (empty) incomplete forward page proves nothing about the
    // hole — it must never erase a recorded gap. The session-scoped marker
    // (forwardGapTimestamp) normally carries the gap through this mirror, but
    // on a fresh session mamQueryStates are empty while the gap map is
    // persisted: preserve the recorded interval verbatim and only advance the
    // id-exact coverage cursor (rsm.last IS set for signal-only pages).
    if (existing && !complete && fetched.length === 0 && forwardGapTimestamp === undefined) {
      return syncGap(gaps, id, existing.start, existing.end, lastFetchedArchiveId ?? existing.startId, existing.endId)
    }
    const gapEnd = forwardGapTimestamp !== undefined ? computeGapEnd(merged, forwardGapTimestamp) : undefined
    // startId: prefer this merge's rsm.last; an incomplete forward merge
    // without one (no new page fetched) carries the existing cursor forward.
    const startId = lastFetchedArchiveId ?? existing?.startId
    // endId: only survives when the end edge hasn't moved — once `end`
    // shifts, the id for the new edge is unknown until a later merge stamps it.
    const endId = existing && existing.end === gapEnd ? existing.endId : undefined
    return syncGap(gaps, id, forwardGapTimestamp, gapEnd, startId, endId)
  }

  const existing = gaps.get(id)
  const next = existing
    ? closeGapWithBackwardPage(existing, messagePageExtent(fetched), complete, oldestMessageStanzaId(fetched))
    : isFetchLatest
      ? detectFetchLatestSeam(fetched, newMessagesCount, patchedCount, newestHeldBelowTs, newestHeldBelowId)
      : undefined
  return syncGap(gaps, id, next?.start, next?.end, next?.startId, next?.endId)
}
