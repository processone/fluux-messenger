/**
 * Persisted history-gap metadata for rooms and 1:1 conversations.
 *
 * A `GapInterval` records a *known* hole in archived history: messages are held
 * below `start` and (when `end` is set) above `end`, with a gap in between. An
 * entity can hold several holes at once — each long absence that catch-up
 * bridges with a fetch-latest leaves one — so every entity owns a {@link GapList}.
 * Gaps are persisted so each "Load missing messages" marker survives a reload:
 * nothing re-detects a hole once the session that formed it is gone.
 *
 * Detection is driven ONLY by reliable structural signals — never by timestamp
 * discontinuities (a quiet period and a real gap are indistinguishable by
 * timestamp, and ejabberd archive ids are non-sequential):
 * 1. a forward walk from the top of held history that ended `complete=false`
 *    (the server said there is more, and we stopped at the page cap);
 * 2. a `before:''` fetch-latest page that landed entirely above held history
 *    with no dedupe overlap — the page provably does not connect to what we
 *    hold, so the boundary between them is a seam (recorded at formation).
 * Recorded gaps close progressively from both directions. A forward walk is
 * contiguous from its origin, so it heals every gap at or above that origin up
 * to its newest fetched message (all of them when it reaches live); backward
 * pagination shrinks/clears a gap when its pages reach into or across it.
 *
 * @module Stores/Shared/MamGap
 */

import type { GapInterval } from '../../core/types/pagination'

export type { GapInterval }

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
 * The recorded holes of one entity, ordered by `start` and pairwise disjoint.
 * At most the newest one is open (`end` undefined). A map never stores an empty
 * list: an entity without holes has no entry.
 */
export type GapList = readonly GapInterval[]

/** Recorded holes per room JID / conversation id. */
export type GapMap = Map<string, GapList>

const EMPTY_GAP_LIST: GapList = Object.freeze([])

function buildGap(start: number, end?: number, startId?: string, endId?: string): GapInterval {
  return {
    start,
    ...(end !== undefined ? { end } : {}),
    ...(startId ? { startId } : {}),
    ...(endId ? { endId } : {}),
  }
}

function isValidGap(gap: unknown): gap is GapInterval {
  if (!gap || typeof gap !== 'object') return false
  const { start, end } = gap as GapInterval
  if (typeof start !== 'number' || !Number.isFinite(start)) return false
  if (end === undefined) return true
  return typeof end === 'number' && Number.isFinite(end) && end > start
}

/**
 * Order a gap list by `start` and union overlapping intervals.
 *
 * A union is the conservative merge: the marker spans both holes and healing
 * re-fetches whatever was already held inside, which dedupe absorbs. Invalid
 * entries (non-finite bounds, `end <= start`) are dropped.
 */
export function normalizeGapList(list: readonly GapInterval[]): GapList {
  const sorted = list.filter(isValidGap).slice().sort((a, b) => a.start - b.start)
  const out: GapInterval[] = []
  for (const gap of sorted) {
    const prev = out[out.length - 1]
    if (prev && gap.start < (prev.end ?? Infinity)) {
      const prevOpen = prev.end === undefined
      const gapOpen = gap.end === undefined
      const end = prevOpen || gapOpen ? undefined : Math.max(prev.end!, gap.end!)
      const endId = end === undefined ? undefined : end === gap.end ? gap.endId : prev.endId
      out[out.length - 1] = buildGap(prev.start, end, prev.startId, endId)
    } else {
      out.push(buildGap(gap.start, gap.end, gap.startId, gap.endId))
    }
  }
  return out
}

function sameGap(a: GapInterval, b: GapInterval): boolean {
  return a.start === b.start && a.end === b.end && a.startId === b.startId && a.endId === b.endId
}

function sameGapList(a: GapList, b: GapList): boolean {
  return a.length === b.length && a.every((gap, i) => sameGap(gap, b[i]))
}

/** The recorded holes of `id`, oldest first (a shared empty list when none). */
export function getGapList(gaps: ReadonlyMap<string, GapList>, id: string): GapList {
  return gaps.get(id) ?? EMPTY_GAP_LIST
}

/**
 * Pure transition for a gap map: replace `id`'s list (normalized), removing the
 * entry when the list is empty.
 *
 * Copy-on-write: returns the SAME map reference when nothing changes, so callers
 * can skip persistence and re-renders.
 */
export function setGapList(gaps: GapMap, id: string, list: readonly GapInterval[]): GapMap {
  const next = normalizeGapList(list)
  const existing = gaps.get(id)
  if (next.length === 0) {
    if (!existing) return gaps
    const out = new Map(gaps)
    out.delete(id)
    return out
  }
  if (existing && sameGapList(existing, next)) return gaps
  const out = new Map(gaps)
  out.set(id, next)
  return out
}

/** The open gap (extends to the live edge), when one is recorded. */
export function findOpenGap(list: GapList): GapInterval | undefined {
  const newest = list[list.length - 1]
  return newest && newest.end === undefined ? newest : undefined
}

/** The newest recorded gap: the one closest to the live edge. */
export function findNewestGap(list: GapList): GapInterval | undefined {
  return list[list.length - 1]
}

/**
 * Read one persisted entry. Accepts both the list shape and the single-interval
 * shape written before an entity could hold several gaps.
 */
export function gapListFromPersisted(value: unknown): GapList {
  const items = Array.isArray(value) ? value : [value]
  return normalizeGapList(items.filter(isValidGap))
}

/** Rebuild a gap map from persisted `[id, value]` entries, skipping malformed ones. */
export function gapMapFromPersisted(entries: unknown): GapMap {
  const out: GapMap = new Map()
  if (!Array.isArray(entries)) return out
  for (const entry of entries) {
    if (!Array.isArray(entry) || typeof entry[0] !== 'string') continue
    const list = gapListFromPersisted(entry[1])
    if (list.length > 0) out.set(entry[0], list)
  }
  return out
}

/** Serialize the gap map for localStorage (`[id, GapInterval[]][]`). */
export function serializeGaps(gaps: ReadonlyMap<string, GapList>): string {
  return JSON.stringify(Array.from(gaps.entries()))
}

/** Parse the gap map from localStorage; returns an empty map on any error. */
export function deserializeGaps(json: string): GapMap {
  try {
    return gapMapFromPersisted(JSON.parse(json))
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
 * @param newestHeldBelowTs - Newest message held BEFORE this merge — a PROVEN
 *   resident boundary only (resident newest, or undefined when the resident
 *   array is empty). Never the persisted preview timestamp: an unarchived
 *   preview must not plant a seam.
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
  gaps: GapMap
  /** Room JID / conversation id. */
  id: string
  direction: 'backward' | 'forward'
  /** Server's `<fin complete=…>` for this merge. */
  complete: boolean
  /** Epoch ms the forward walk started from: the timestamp of its resume
   *  cursor. Undefined for bounded walks (an `end` filter, a context window),
   *  whose pages are no evidence about the gaps. */
  walkOriginTs?: number
  /** The forward walk may close gaps but never open one: it did not start at
   *  the top of held history (the fixed-window repair). */
  healGapsOnly?: boolean
  /** Merged timeline (for `computeGapEnd` when a forward walk opens a gap). */
  merged: Array<{ timestamp?: Date }>
  /** The incoming page, as handed to the merge. */
  fetched: Array<{ timestamp?: Date; stanzaId?: string }>
  /** How many of `fetched` survived dedupe. */
  newMessagesCount: number
  /** Archive-id backfills onto held messages. */
  patchedCount: number
  /** The query was a `before:''` fetch-latest. */
  isFetchLatest: boolean
  /** Newest message held BEFORE this merge — a proven resident boundary only
   *  (resident newest, or undefined when empty); never the preview ts. */
  newestHeldBelowTs: number | undefined
  /** Archive id of the newest message held BEFORE this merge (mirrors
   *  `newestHeldBelowTs`) — stamped as a formed backward seam's `startId`. */
  newestHeldBelowId?: string
  /** Archive id of the last entry of a forward page (the merge's `page.last`) —
   *  stamped as the healed or opened gap's `startId`. */
  lastFetchedArchiveId?: string
  /** Bounded windowed query: leave every gap untouched. */
  preserveGapMarker: boolean
}

/** What one forward page proves, for {@link healGapsWithForwardPage}. */
export interface ForwardPageEvidence {
  /** Epoch ms the walk started from; the walk is contiguous from here. */
  originTs: number
  /** Newest fetched message, or undefined for a signal-only page. */
  newestTs: number | undefined
  /** `page.last`: the archive id the walk resumes after. */
  lastId: string | undefined
  /** The walk reached the live edge. */
  complete: boolean
  /** May open a gap when no recorded gap lies at or above the origin. */
  allowCreate: boolean
  /** Merged timeline, for the upper bound of an opened gap. */
  merged: Array<{ timestamp?: Date }>
}

/**
 * Apply one forward page to a gap list.
 *
 * A forward walk is contiguous from `originTs`, so only gaps whose `start` is at
 * or above it can be affected; older gaps stay exactly as they are.
 * - `complete`: the walk reached live, so it crossed every gap at or above the
 *   origin → all removed.
 * - a gap the walk reached (`newestTs > start`) moves its `start` up to the
 *   page's newest message, or is removed once the walk reached its `end`;
 * - a signal-only page carries no position. It only advances the resume
 *   cursor of a gap the walk started exactly at, so a run of signal pages
 *   cannot pin the gap's resume point forever;
 * - an incomplete walk with no gap at or above its origin started at the top
 *   of held history, so the rest of the archive is a new open gap (when
 *   `allowCreate`).
 */
export function healGapsWithForwardPage(list: GapList, page: ForwardPageEvidence): GapList {
  const { originTs, newestTs, lastId, complete, allowCreate, merged } = page
  if (complete) return list.filter((gap) => gap.start < originTs)

  const out: GapInterval[] = []
  let walked = false
  let firstTarget = true
  for (const gap of list) {
    if (gap.start < originTs) {
      out.push(gap)
      continue
    }
    walked = true
    if (newestTs === undefined) {
      const advance = firstTarget && gap.start === originTs && lastId
      out.push(advance ? buildGap(gap.start, gap.end, lastId, gap.endId) : gap)
    } else if (newestTs <= gap.start) {
      out.push(gap)
    } else if (gap.end === undefined || newestTs < gap.end) {
      out.push(buildGap(newestTs, gap.end, lastId ?? gap.startId, gap.endId))
    }
    firstTarget = false
  }

  if (!walked && allowCreate && newestTs !== undefined && newestTs >= originTs) {
    out.push(buildGap(newestTs, computeGapEnd(merged, newestTs), lastId))
  }
  return out
}

/** Reconcile every recorded gap against a merged BACKWARD page
 *  (see {@link closeGapWithBackwardPage}). */
export function reconcileGapsWithBackwardPage(
  list: GapList,
  page: PageExtent,
  complete: boolean,
  pageOldestId?: string,
): GapList {
  const out: GapInterval[] = []
  for (const gap of list) {
    const next = closeGapWithBackwardPage(gap, page, complete, pageOldestId)
    if (next) out.push(next)
  }
  return out
}

/**
 * The single gap transition for BOTH stores and BOTH merge directions.
 *
 * Forward: {@link healGapsWithForwardPage}, keyed on the walk's origin.
 * Backward: every recorded gap is reconciled against the page. A fetch-latest
 * that leaves all of them unchanged and lands disjoint above the resident
 * boundary records a new seam; closure takes priority, so a fetch-latest that
 * bounds an open gap does not also plant a shallower seam inside it.
 *
 * Copy-on-write: returns the same map reference when nothing changes, so
 * callers can skip persistence and re-renders.
 */
export function syncGapAfterArchiveMerge(input: ArchiveMergeGapInput): GapMap {
  const {
    gaps, id, direction, complete, walkOriginTs, healGapsOnly = false, merged, fetched,
    newMessagesCount, patchedCount, isFetchLatest, newestHeldBelowTs, newestHeldBelowId,
    lastFetchedArchiveId, preserveGapMarker,
  } = input

  if (preserveGapMarker) return gaps
  const list = getGapList(gaps, id)

  if (direction === 'forward') {
    if (walkOriginTs === undefined) return gaps
    return setGapList(gaps, id, healGapsWithForwardPage(list, {
      originTs: walkOriginTs,
      newestTs: messagePageExtent(fetched).newestTs,
      lastId: lastFetchedArchiveId,
      complete,
      allowCreate: !healGapsOnly,
      merged,
    }))
  }

  const reconciled = reconcileGapsWithBackwardPage(
    list, messagePageExtent(fetched), complete, oldestMessageStanzaId(fetched),
  )
  if (isFetchLatest && sameGapList(reconciled, list)) {
    const seam = detectFetchLatestSeam(fetched, newMessagesCount, patchedCount, newestHeldBelowTs, newestHeldBelowId)
    if (seam) return setGapList(gaps, id, [...list, seam])
  }
  return setGapList(gaps, id, reconciled)
}
