/**
 * Persisted contiguous-with-live coverage (Codex r3 #3/#4).
 *
 * A `CoverageRecord` is POSITIVE, DURABLE data: the archive id of the oldest
 * entry proven contiguous with the live edge for this device. Unlike a
 * `GapInterval` (which describes a hole and vanishes when the hole closes) or
 * `coverageBottomUnproven` (session-scoped), the record survives fresh
 * sessions and gap closure, so:
 * - Phase B (read-pointer stitch) seeds its backward walk from it and never
 *   from a disjoint cache island (e.g. a fetchContext window);
 * - a signal-only fetch-latest walk resumes BELOW prior coverage instead of
 *   re-walking the same newest pages every session (`topId` marks re-entry
 *   into covered territory; the walk jumps to `bottomId`).
 *
 * Advancing `bottomId` past a page that carries persistable messages must be
 * gated on the durable IndexedDB commit of that page (same invariant as gap
 * transitions): the record must never point past data that was never stored.
 *
 * @module Stores/Shared/MamCoverage
 */

export interface CoverageRecord {
  /** Archive id of the OLDEST entry proven contiguous with the live edge. */
  bottomId: string
  /** Archive id of the NEWEST entry seen by the fetch-latest walk that
   *  established this record (page-1 rsm.last). */
  topId?: string
}

/** Extra merge inputs carried on the mam-messages emit (both entity kinds). */
export interface MergeArchiveExtras {
  /** The `before` cursor the query was started with ('' = fetch-latest). */
  initialBefore?: string
  /** rsm.last of the FIRST page of a backward walk (newest covered entry). */
  fetchLatestTopId?: string
  /** The walk contained the existing coverage record's top entry — the only
   *  accepted proof of contiguity with the record (Codex r4 #3). */
  sawCoverageTop?: boolean
  /** The walk carried corrections/retractions/reactions/fastenings, whose
   *  cache effects are fire-and-forget — certification is blocked (r4 #2). */
  walkCarriedModifications?: boolean
}

/** Serialize the coverage map for localStorage (`[id, CoverageRecord][]`). */
export function serializeCoverage(map: Map<string, CoverageRecord>): string {
  return JSON.stringify(Array.from(map.entries()))
}

/** Parse the coverage map from localStorage; empty map on any error. */
export function deserializeCoverage(json: string): Map<string, CoverageRecord> {
  try {
    const entries = JSON.parse(json) as [string, CoverageRecord][]
    return new Map(entries.filter(([, r]) => typeof r?.bottomId === 'string'))
  } catch {
    return new Map()
  }
}

/** Everything the coverage transition needs from an archive merge. */
export interface ArchiveMergeCoverageInput {
  /** Current persisted coverage map (`conversationCoverage` / `roomCoverage`). */
  coverage: Map<string, CoverageRecord>
  /** Conversation id / room JID. */
  id: string
  direction: 'backward' | 'forward'
  /** The query was a `before:''` fetch-latest. */
  isFetchLatest: boolean
  /** Bounded windowed query — proves nothing about live contiguity. */
  preserveGapMarker: boolean
  /** rsm.first of the merge's LAST page (deepest entry seen, signals included). */
  rsmFirst?: string
  fetchLatestTopId?: string
  initialBefore?: string
  /** The walk contained the existing record's top entry (id-exact sighting).
   *  Dedupe against arbitrary resident data is NOT accepted: overlapping a
   *  fetchContext island proves nothing about the record's region (r4 #3). */
  sawCoverageTop: boolean
  /** The walk carried modifications (see MergeArchiveExtras) — blocks any
   *  certification: their cache effects are not durably confirmed (r4 #2). */
  walkCarriedModifications: boolean
}

/**
 * Pure coverage transition, called from both stores' archive merges.
 *
 * - a walk that carried modifications never certifies anything (r4 #2);
 * - fetch-latest that SAW the existing record's top entry → the deeper
 *   existing bottom stands; only the walk top refreshes (r4 #3);
 * - fetch-latest otherwise (disjoint or first-ever, INCLUDING a signal-only
 *   give-up with zero displayable messages) → replace with the walk extent;
 * - plain backward page → extend the bottom ONLY when the query resumed
 *   id-exactly from it (initialBefore === bottomId);
 * - forward merges and preserveGapMarker (bounded windowed) queries prove
 *   nothing about the live-contiguous bottom → no-op.
 *
 * Copy-on-write: returns the SAME map reference when nothing changes.
 */
export function syncCoverageAfterArchiveMerge(input: ArchiveMergeCoverageInput): Map<string, CoverageRecord> {
  const {
    coverage, id, direction, isFetchLatest, preserveGapMarker,
    rsmFirst, fetchLatestTopId, initialBefore, sawCoverageTop, walkCarriedModifications,
  } = input
  if (preserveGapMarker) return coverage
  if (direction !== 'backward') return coverage
  if (walkCarriedModifications) return coverage
  const existing = coverage.get(id)

  if (isFetchLatest) {
    if (!rsmFirst) return coverage
    if (sawCoverageTop && existing) {
      if (fetchLatestTopId && fetchLatestTopId !== existing.topId) {
        const next = new Map(coverage)
        next.set(id, { ...existing, topId: fetchLatestTopId })
        return next
      }
      return coverage
    }
    if (existing && existing.bottomId === rsmFirst && existing.topId === fetchLatestTopId) return coverage
    const next = new Map(coverage)
    next.set(id, { bottomId: rsmFirst, ...(fetchLatestTopId ? { topId: fetchLatestTopId } : {}) })
    return next
  }

  if (existing && rsmFirst && initialBefore === existing.bottomId && rsmFirst !== existing.bottomId) {
    const next = new Map(coverage)
    next.set(id, { ...existing, bottomId: rsmFirst })
    return next
  }
  return coverage
}
