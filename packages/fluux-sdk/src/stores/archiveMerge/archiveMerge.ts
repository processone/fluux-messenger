import { messagePageExtent, syncGapAfterArchiveMerge, type GapInterval } from '../shared/mamGap'
import { syncCoverageAfterArchiveMerge } from '../shared/mamCoverage'
import * as mamState from '../shared/mamState'
import { walkExtentBottomId } from '../../utils/mamCatchUpUtils'
import type { PageInfo, MergeArchiveExtras, HistoryQueryDirection } from '../../core/types/pagination'
import type { Message } from '../../core/types/chat'
import type { RoomMessage } from '../../core/types/room'
import type { HistoryQueryState } from '../../core/types/pagination'
import type { CoverageTransition } from '../shared/mamCoverage'
import type { CoverageRecord } from '../../core/types/pagination'

export type ArchiveMergeKind = 'chat' | 'room'

export type GapMap = Map<string, GapInterval>
export type CoverageMap = Map<string, CoverageRecord>
export type MamStateMap = Map<string, HistoryQueryState>

/** Everything a merged page says about where history now begins and ends. */
export interface MergeFacts {
  gaps: GapMap
  coverage: CoverageMap
  /** MAM query states, already updated for this page's completion and cursors. */
  mamStates: MamStateMap
  direction: HistoryQueryDirection
  complete: boolean
  isFetchLatest: boolean
  preserveGapMarker: boolean
  page: PageInfo
  extras: MergeArchiveExtras | undefined
  /** The merged slice, and the page as the archive returned it. */
  merged: Array<Message | RoomMessage>
  fetched: Array<Message | RoomMessage>
  newMessagesCount: number
  patchedCount: number
  /** The newest PROVEN in-memory boundary, undefined when nothing is resident. */
  residentNewestTs: number | undefined
  newestHeldBelowId: string | undefined
  /** The entity's preview timestamp, the last resort when nothing is resident. */
  fallbackHeldTs: number | undefined
  /** Whether this merge must wait for a durable write; see {@link DurableTransitions}. */
  gatedOnDurableWrite: boolean
}

/** What a merge computed, against what it computed it from. */
export interface DurableTransitions {
  gaps: { current: GapMap; next: GapMap }
  coverage: { current: CoverageMap; next: CoverageMap; transition: CoverageTransition }
  /**
   * Whether this merge must wait for a durable write: it has rows to store, or an earlier page of
   * the same entity is still in flight — its cursor must not leap one that never landed.
   */
  gatedOnDurableWrite: boolean
}

/** The transitions a merge may apply now, and the deferred ones it still owes. */
export interface MergePlan extends DurableCommitPlan {
  /** MAM query states with the coverage-bottom proof this page settles. */
  mamStates: MamStateMap
  /** Whether the coverage record moved at all, deferred or not. */
  coverageChanged: boolean
  /** Whether a created record's bottom came from the walk's own extent rather than a cursor. */
  coverageBootstrappedFromWalkExtent: boolean
}

/** The transitions a merge may apply now, and the deferred ones it still owes. */
export interface DurableCommitPlan {
  /**
   * Whether anything waits on the durable write. A merge with nothing to store and nothing
   * deferred must not chain a no-op write either: that alone marks the entity's save chain busy,
   * and the next merge would defer against it.
   */
  deferred: boolean
  /** The gap map to return from the merge's own write. */
  gapsAfterMerge: GapMap
  /** The coverage map to return from the merge's own write. */
  coverageAfterMerge: CoverageMap
  /**
   * Commits whatever was deferred, once `durableWrite` reports the rows are stored. A write that
   * failed commits nothing: the cursor would then point past data that was never stored.
   */
  commitWhenDurable(durableWrite: Promise<boolean>): void
}

export interface ArchiveMergePorts {
  /**
   * Whether the entity, the cache and the account are still the ones the merge read. A deferred
   * commit that lands after a teardown must not resurrect its cursors.
   */
  captureEntity(entityId: string): () => boolean
  /**
   * Applies a deferred transition inside the store's own write. `guards` carry the exact values
   * the merge computed from: a later merge may have moved them on, and only reference equality
   * proves it did not — every transition creates a new object.
   */
  applyDeferred(
    entityId: string,
    change: { gaps?: GapInterval | undefined; coverage?: CoverageRecord },
    guards: { gap: GapInterval | undefined; coverage: CoverageRecord | undefined },
    transition: CoverageTransition,
  ): void
  /**
   * Called where a transition actually enters the state — never at merge time on the deferred
   * path, which would arm the flush for a write still carrying the old record and leave the real
   * one throttled (#1138). What that means is the store's own: a chat rides its persisted blob
   * and only records the transition, while a room writes both maps itself.
   */
  noteApplied(
    entityId: string,
    applied: { gaps?: GapMap; coverage?: CoverageMap; transition: CoverageTransition },
  ): void
}

/**
 * The crash-window protocol both archive merges follow.
 *
 * Gap and coverage transitions are persisted synchronously while the rows they describe are
 * written to IndexedDB fire-and-forget. Persisting a transition whose cursors name this page
 * before that write commits lets a crash — or a write that silently failed — skip the page
 * forever: the resume cursor would point past data that was never stored. So a transition waits
 * for the write when there is one, and applies at once when there is nothing to lose.
 */
export function createArchiveMerge(kind: ArchiveMergeKind, ports: ArchiveMergePorts) {
  return {
    kind,

    /**
     * What a merged page changes about the history either side of it: where a gap now starts or
     * ends, whether the contiguous bottom is proven, and how far coverage reaches — then what of
     * that may be written now and what waits for the rows to be stored.
     */
    planMerge(entityId: string, facts: MergeFacts): MergePlan {
      const newGaps = syncGapAfterArchiveMerge({
        gaps: facts.gaps,
        id: entityId,
        direction: facts.direction,
        complete: facts.complete,
        forwardGapTimestamp: facts.mamStates.get(entityId)?.forwardGapTimestamp,
        merged: facts.merged,
        fetched: facts.fetched,
        newMessagesCount: facts.newMessagesCount,
        patchedCount: facts.patchedCount,
        isFetchLatest: facts.isFetchLatest,
        // ONLY a proven boundary (the resident extent) anchors a seam — never the preview
        // timestamp, which may be an unarchived row above the true archive newest and would plant
        // a spurious one. With nothing resident there is no proven boundary, and the unproven
        // flag below says so instead.
        newestHeldBelowTs: facts.residentNewestTs,
        newestHeldBelowId: facts.newestHeldBelowId,
        lastFetchedArchiveId: facts.page.last,
        preserveGapMarker: facts.preserveGapMarker,
      })

      // Coverage-bottom proof. A merge proves the contiguous bottom when a resident boundary
      // exists, or a recorded gap now carries a proven upper edge — clear any stale flag.
      // Otherwise a disjoint fetch-latest landing above held-below history with no seam formed
      // leaves the bottom unproven, so the catch-up seeder will not trust cache-oldest as
      // contiguous with the live edge.
      let mamStates = facts.mamStates
      const coverageProven = facts.residentNewestTs !== undefined || newGaps.get(entityId)?.endId !== undefined
      if (coverageProven) {
        mamStates = mamState.setCoverageBottomUnproven(mamStates, entityId, false)
      } else if (facts.direction === 'backward' && facts.isFetchLatest && !newGaps.has(entityId)) {
        const structurallyDisjoint = facts.newMessagesCount === facts.fetched.length && facts.patchedCount === 0
        const pageOldestTs = messagePageExtent(facts.fetched).oldestTs
        const previewBelow = facts.fallbackHeldTs !== undefined && pageOldestTs !== undefined
          && pageOldestTs > facts.fallbackHeldTs
        if (structurallyDisjoint && previewBelow) {
          mamStates = mamState.setCoverageBottomUnproven(mamStates, entityId, true)
        }
      }

      // Counting needs a persisted message anchor; RSM cursors also name signals.
      const walkOldestId = facts.extras?.walkOldestId ?? walkExtentBottomId(facts.fetched)
      const { coverage: newCoverage, transition } = syncCoverageAfterArchiveMerge({
        coverage: facts.coverage,
        id: entityId,
        direction: facts.direction,
        isFetchLatest: facts.isFetchLatest,
        preserveGapMarker: facts.preserveGapMarker,
        rsmFirst: facts.page.first,
        fetchLatestTopId: facts.extras?.fetchLatestTopId,
        initialBefore: facts.extras?.initialBefore,
        sawCoverageTop: facts.extras?.sawCoverageTop ?? false,
        walkCarriedModifications: facts.extras?.walkCarriedModifications ?? false,
        complete: facts.complete,
        initialAfter: facts.extras?.initialAfter,
        walkOldestId,
      })

      const durable = this.planDurableCommit(entityId, {
        gaps: { current: facts.gaps, next: newGaps },
        coverage: { current: facts.coverage, next: newCoverage, transition },
        gatedOnDurableWrite: facts.gatedOnDurableWrite,
      })

      return {
        ...durable,
        mamStates,
        coverageChanged: newCoverage !== facts.coverage,
        coverageBootstrappedFromWalkExtent:
          transition === 'created' &&
          facts.extras?.initialAfter === undefined &&
          walkOldestId !== undefined &&
          newCoverage.get(entityId)?.bottomId === walkOldestId,
      }
    },

    planDurableCommit(entityId: string, transitions: DurableTransitions): DurableCommitPlan {
      const { gaps, coverage, gatedOnDurableWrite } = transitions
      const deferGap = gaps.next !== gaps.current && gatedOnDurableWrite
      const deferCoverage = coverage.next !== coverage.current && gatedOnDurableWrite
      const gapsAfterMerge = deferGap ? gaps.current : gaps.next
      const coverageAfterMerge = deferCoverage ? coverage.current : coverage.next
      if (gapsAfterMerge !== gaps.current || coverageAfterMerge !== coverage.current) {
        ports.noteApplied(entityId, {
          ...(gapsAfterMerge !== gaps.current ? { gaps: gapsAfterMerge } : {}),
          ...(coverageAfterMerge !== coverage.current ? { coverage: coverageAfterMerge } : {}),
          transition: coverage.transition,
        })
      }

      const guards = { gap: gaps.current.get(entityId), coverage: coverage.current.get(entityId) }
      const isCurrent = ports.captureEntity(entityId)

      return {
        deferred: deferGap || deferCoverage,
        gapsAfterMerge,
        coverageAfterMerge,
        commitWhenDurable(durableWrite: Promise<boolean>): void {
          if (!deferGap && !deferCoverage) return
          void durableWrite.then((committed) => {
            if (!committed || !isCurrent()) return
            const nextCoverage = coverage.next.get(entityId)
            ports.applyDeferred(
              entityId,
              {
                ...(deferGap ? { gaps: gaps.next.get(entityId) } : {}),
                // A record that vanished cannot be committed; there is nothing to write.
                ...(deferCoverage && nextCoverage ? { coverage: nextCoverage } : {}),
              },
              guards,
              coverage.transition,
            )
          })
        },
      }
    },
  }
}

export type ArchiveMerge = ReturnType<typeof createArchiveMerge>
