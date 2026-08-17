/**
 * Coverage transitions for the persisted contiguous-with-live record
 * ({@link CoverageRecord}, Codex r3 #3/#4).
 *
 * @module Stores/Shared/MamCoverage
 */

import { resolveArchivePosition } from '../../utils/messageCache'
import type { CoverageRecord, ExactPosition } from '../../core/types'

/**
 * The coverage shapes are declared in `core/types/pagination.ts` — they ride on
 * SDK events, so `core/types` must be able to name them without depending on a
 * store. Re-exported here, where the transition logic lives.
 */
export type { CoverageRecord, MergeArchiveExtras } from '../../core/types'

/**
 * What a merge did to the record — the persistence layer's durability input.
 *
 * Only ONE of these can leave disk asserting something memory has disproven,
 * and it is the only one that has to escape the persistence throttle:
 *
 * | Transition     | Loss on a hard kill                                        | Durability |
 * |----------------|------------------------------------------------------------|------------|
 * | `none`         | nothing changed                                            | —          |
 * | `created`      | disk holds NO record; next session re-seeds from the local downloaded edge, which is shallower. Asserts nothing. | throttle |
 * | `deepened`     | disk holds the SHALLOWER previous bottom; Phase B re-walks covered ground. | throttle |
 * | `topRefreshed` | disk holds a stale re-entry marker; one extra walked page.  | throttle   |
 * | `replaced`     | **disk keeps the record whose contiguity this walk just DISPROVED, and Phase B seeds its backward walk from it — skipping the disconnected interval.** | **force-flush** |
 *
 * The asymmetry is the whole point: every safe transition errs SHALLOW (costing
 * a re-walk), and only `replaced` can leave disk claiming coverage that does not
 * exist. Removal is equally unsafe, but it needs no signal — the persistence
 * layer sees a key disappear.
 *
 * This classification exists here, and not in the persistence layer, because
 * archive ids are NON-SEQUENTIAL (see `mamGap`): nothing downstream can compare
 * two `bottomId`s and tell a deepening from a replacement. Before #1138 the
 * layer could only be conservative and force-flush every `bottomId` change,
 * which cost one whole-blob serialization per conversation on a first session
 * (~400 on the reference profile) and one per Phase B page.
 */
export type CoverageTransition = 'none' | 'created' | 'deepened' | 'topRefreshed' | 'replaced'

/** {@link syncCoverageAfterArchiveMerge}'s result: the map, and what happened. */
export interface CoverageSyncResult {
  /** Copy-on-write: the SAME reference as the input when nothing changed. */
  coverage: Map<string, CoverageRecord>
  transition: CoverageTransition
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
  /** The server reported the walk exhausted its direction. On a forward
   *  catch-up this means the walk reached the live edge. */
  complete?: boolean
  /** The `after` cursor a forward catch-up resumed from (the local downloaded
   *  edge). Undefined for `start`-filtered or cursorless catch-ups. */
  initialAfter?: string
  /** Bounded windowed query — proves nothing about live contiguity. */
  preserveGapMarker: boolean
  /** page.first of the merge's LAST page (deepest entry seen, signals included). */
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
 * - COMPLETED forward catch-up with a resume cursor → seed the bottom from that
 *   cursor when no record exists yet (bootstrap, see below);
 * - incomplete forward merges and preserveGapMarker (bounded windowed) queries
 *   prove nothing about the live-contiguous bottom → no-op.
 *
 * Copy-on-write: returns the SAME map reference when nothing changes.
 *
 * The returned {@link CoverageTransition} is what the persistence layer keys its
 * durability decision on — see that type for the loss analysis per branch.
 */
export function syncCoverageAfterArchiveMerge(input: ArchiveMergeCoverageInput): CoverageSyncResult {
  const {
    coverage, id, direction, isFetchLatest, preserveGapMarker, complete, initialAfter,
    rsmFirst, fetchLatestTopId, initialBefore, sawCoverageTop, walkCarriedModifications,
  } = input
  const unchanged: CoverageSyncResult = { coverage, transition: 'none' }
  if (preserveGapMarker) return unchanged
  // Applies to BOTH directions: a walk whose corrections/retractions/reactions
  // were written fire-and-forget is not durably confirmed, so it may not certify
  // coverage — the forward bootstrap anchor included (Codex r4 #2).
  if (walkCarriedModifications) return unchanged

  if (direction !== 'backward') {
    // Bootstrap. Without this the record can only be born in the fetch-latest
    // branch below, and `selectCatchUpQuery` only issues a `before:''`
    // fetch-latest when the cache is EMPTY — an entity's first-ever sync. Every
    // entity already cached when this feature shipped would therefore never get
    // a record (the plain-backward branch requires one to exist), leaving Phase
    // B permanently seeded from the raw cache bottom instead of a proven edge.
    //
    // A forward catch-up that resumed at `initialAfter` and came back complete
    // has downloaded everything from that cursor to the live edge — which is
    // precisely "oldest entry proven contiguous with live". The claim is
    // deliberately conservative: it anchors on the cursor we resumed from, never
    // on how deep the cache happens to reach, and it never overwrites an
    // existing record, so a bottom already proven deeper always wins. Erring
    // shallow only costs Phase B a re-walk of covered ground; erring deep would
    // skip real history, and this path cannot do that.
    if (!complete || !initialAfter) return unchanged
    if (coverage.get(id)) return unchanged
    const next = new Map(coverage)
    next.set(id, { bottomId: initialAfter })
    return { coverage: next, transition: 'created' }
  }

  const existing = coverage.get(id)

  if (isFetchLatest) {
    if (!rsmFirst) return unchanged
    if (sawCoverageTop && existing) {
      if (fetchLatestTopId && fetchLatestTopId !== existing.topId) {
        const next = new Map(coverage)
        next.set(id, { ...existing, topId: fetchLatestTopId })
        return { coverage: next, transition: 'topRefreshed' }
      }
      return unchanged
    }
    if (existing && existing.bottomId === rsmFirst && existing.topId === fetchLatestTopId) return unchanged
    const next = new Map(coverage)
    next.set(id, { bottomId: rsmFirst, ...(fetchLatestTopId ? { topId: fetchLatestTopId } : {}) })
    // With a record present and contiguity with it NOT proven, this overwrites
    // an assertion rather than making a first one — the one unsafe transition.
    return { coverage: next, transition: existing ? 'replaced' : 'created' }
  }

  if (existing && rsmFirst && initialBefore === existing.bottomId && rsmFirst !== existing.bottomId) {
    const next = new Map(coverage)
    next.set(id, { ...existing, bottomId: rsmFirst })
    // The query resumed id-EXACTLY from the recorded bottom, so the new bottom
    // extends the same contiguous run: losing it leaves the shallower one,
    // which is still true.
    return { coverage: next, transition: 'deepened' }
  }
  return unchanged
}

/**
 * Count-trustworthy gate: is this entity's archive complete enough to derive
 * an exact unread count from it?
 *
 * This mirrors `mdsSideEffects.ts`'s `archiveIsTrustworthy` — the gate the
 * XEP-0490 publisher uses before speaking a read position — with ONE
 * deliberate difference: `archiveIsTrustworthy` treats "never queried and not
 * loading" as trustworthy, because for the publisher that state only ever
 * describes a conversation/room created fresh during THIS session, which has
 * no archive to misreport.
 *
 * That shortcut does not hold here. A RESTORED entity — reopened from
 * persisted state — carries durable coverage from a previous session, and at
 * cold start `hasQueried` is false (it is session-scoped, not persisted)
 * while the archive may be genuinely stale until this session's catch-up
 * runs. Counting during that window would under-count and overwrite a
 * correct persisted value — the unsafe direction, and at the worst possible
 * time (cold start, before catch-up has had a chance to run). So this gate
 * requires `!isLoading && isCaughtUpToLive` unconditionally: `hasQueried` is
 * accepted (callers pass the same MAM query state used elsewhere) but
 * deliberately never consulted. Do not "restore" a never-queried shortcut
 * here — see this module's test file for the case that catches it.
 */
export function isCaughtUpForCounting(mam: {
  hasQueried: boolean
  isLoading: boolean
  isCaughtUpToLive: boolean
}): boolean {
  return !mam.isLoading && mam.isCaughtUpToLive
}

/**
 * The result of resolving a {@link CoverageRecord}'s `bottomId` to a position
 * in archive order: the position when it is cached, `'missing'` when there is
 * no record at all, or `'unresolvable'` when the record names an archive id
 * that is no longer in the cache (evicted, or the record is stale).
 *
 * `'missing'` is NOT `null`-as-fine: a missing record means the entity has
 * not yet been proven contiguous with the live edge, so the caller must defer
 * counting rather than proceed as if there were nothing to worry about.
 * `'unresolvable'` is the caller's cue to invalidate the stale record and
 * defer too — the two are kept distinct because a future caller may want to
 * react to them differently (e.g. only the latter warrants dropping the
 * record).
 */
export type CoverageBottom = ExactPosition | 'missing' | 'unresolvable'

/**
 * Resolve a coverage record's `bottomId` to its archive position, scoped to
 * `entityId` (conversation id or room JID). See {@link CoverageBottom} for
 * the three outcomes and {@link resolveArchivePosition} (`messageCache.ts`)
 * for how the lookup itself is scoped between chat and room.
 */
export async function resolveCoverageBottom(
  entityId: string,
  record: CoverageRecord | undefined,
  isRoom: boolean
): Promise<CoverageBottom> {
  if (!record) return 'missing'
  const position = await resolveArchivePosition(entityId, record.bottomId, isRoom)
  return position ?? 'unresolvable'
}
