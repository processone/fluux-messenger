import type { GapInterval } from '../shared/mamGap'
import type { CoverageTransition } from '../shared/mamCoverage'
import type { CoverageRecord } from '../../core/types/pagination'

export type ArchiveMergeKind = 'chat' | 'room'

export type GapMap = Map<string, GapInterval>
export type CoverageMap = Map<string, CoverageRecord>

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
