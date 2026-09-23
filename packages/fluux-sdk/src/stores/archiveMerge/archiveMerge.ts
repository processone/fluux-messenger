import { messagePageExtent, newestMessageStanzaId, syncGapAfterArchiveMerge, type GapInterval } from '../shared/mamGap'
import { recoverCoverageForCounting, syncCoverageAfterArchiveMerge } from '../shared/mamCoverage'
import * as mamState from '../shared/mamState'
import { newArchiveMergeTally, reportArchiveMergeWhenDurable } from '../shared/archiveMergeDiagnostics'
import { walkExtentBottomId } from '../../utils/mamCatchUpUtils'
import { getStorageScopeJid } from '../../utils/storageScope'
import * as searchIndex from '../../utils/searchIndex'
import { isNoLocalStore } from '../../core/types/message-internal'
import type { ArchiveSaveChain } from '../shared/archiveSaveChain'
import type { PageInfo, HistoryQueryDirection, ArchiveMergeOptions } from '../../core/types/pagination'
import type { Message } from '../../core/types/chat'
import type { RoomMessage } from '../../core/types/room'
import type { HistoryQueryState } from '../../core/types/pagination'
import type { CoverageTransition } from '../shared/mamCoverage'
import type { CoverageRecord } from '../../core/types/pagination'

export type { ArchiveMergeOptions }

export type ArchiveMergeKind = 'chat' | 'room'

export type GapMap = Map<string, GapInterval>
export type CoverageMap = Map<string, CoverageRecord>
export type MamStateMap = Map<string, HistoryQueryState>

/** What a merged page contributed, read from the store's own write. */
export interface MergePageFacts<M> {
  gaps: GapMap
  coverage: CoverageMap
  /** MAM query states as the merge found them; this page's completion is applied here. */
  mamStates: MamStateMap
  /**
   * The entity's resident messages BEFORE this merge. The only proven in-memory boundary there
   * is: an empty array (a background entity, a fresh session) proves nothing, which several of
   * the decisions below turn on.
   */
  existing: M[]
  /** The merged slice this page produced. */
  merged: M[]
  /** Rows the merge added, and resident rows it patched (an archive-id backfill). */
  newMessages: M[]
  patched: M[]
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
  /**
   * Whether this page extended contiguous history past the read pointer, which is what can give
   * an entity back a badge after a catch-up. A page that bootstrapped the coverage record does
   * not qualify: it defined where counting starts rather than adding to it.
   */
  extendsHistoryPastFloor: boolean
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

/** The read tracker, as an archive merge uses it. */
export interface MergeReadTracker<M> {
  noteUnreadInputsChanged(entityId: string): void
  dropUnreadMessage(entityId: string, source: string | RoomMessage): boolean
  resumeDeferredRecounts(entityId: string): void
  captureUnreadInputs(entityId: string): () => boolean
  scheduleRecount(entityId: string): void
  applyRemoteDisplayed(entityId: string, stanzaId: string, messages: M[]): void
}

export interface ArchiveMergePorts<M extends Message | RoomMessage> {
  /**
   * Whether the entity and the cache are still the ones the merge read. A deferred commit that
   * lands after a teardown must not resurrect its cursors. The account scope is checked
   * separately, by the merge itself.
   */
  captureEntity(entityId: string): () => boolean
  /**
   * Applies a coverage or gap transition inside the store's own write. `guards` carry the exact
   * values the merge computed from: a later merge may have moved them on, and only reference
   * equality proves it did not — every transition creates a new object.
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
  /**
   * XEP-0424: applies retractions recorded earlier onto this page before it merges, so a
   * tombstone rides the same write as the row it hides. Returns the page unchanged when nothing
   * matches, and consumes nothing for an entity whose page this store would not store.
   */
  replayRetractions(entityId: string, page: M[]): M[]
  /** The entity preview's timestamp: the seam-formation fallback when nothing is resident. */
  lastHeldTimestamp(entityId: string): number | undefined
  /** Writes this page's rows to the message cache. Resolves false when the write failed. */
  saveRows(rows: M[]): Promise<boolean>
  /** This store's per-entity archive-save chain. */
  saves: Pick<ArchiveSaveChain, 'chain' | 'has'>
  readTracker: MergeReadTracker<M>
  /** How the read tracker's transient overlay names `message`. */
  unreadKey(message: M): string | RoomMessage
  /** A remote read marker that no loaded slice could order yet (XEP-0490). */
  pendingRemoteMarker(entityId: string): string | undefined
  /** Re-derives the entity's unread count from the archive. */
  recountUnread(entityId: string): void
  coverageOf(entityId: string): CoverageRecord | undefined
}

/** One archive page, from the retraction replay that precedes it to the recount that follows. */
export interface ArchiveMergeRun<M> {
  /** The page to merge: the archive's, with recorded retractions already applied. */
  readonly messages: M[]
  /**
   * Stores what this page contributes and plans what it changes about the history either side of
   * it. Called from inside the store's own write, whose return the plan then feeds.
   */
  storePage(facts: MergePageFacts<M>): MergePlan
  /**
   * Everything the merge owes once the store's write has returned: the durable-outcome report,
   * the unread bookkeeping the stored rows settle, the deferred read marker, and the recount.
   *
   * `merged` is captured from inside the write because a non-active entity keeps no resident
   * array: it is the only view of the merged slice left by the time this runs.
   */
  settled(outcome: { merged: M[]; recount: boolean }): void
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
export function createArchiveMerge<M extends Message | RoomMessage>(
  kind: ArchiveMergeKind,
  ports: ArchiveMergePorts<M>,
) {
  function planDurableCommit(entityId: string, transitions: DurableTransitions): DurableCommitPlan {
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
  }

  return {
    kind,

    /**
     * The crash-window decision on its own: what a set of transitions may apply now, and what
     * waits for the rows they name to be stored. Used by every merge through {@link begin}.
     */
    planDurableCommit,

    /**
     * Opens a merge run for one archive page.
     *
     * Everything the page was fetched with is captured here, so neither the plan nor the
     * follow-up has to be handed it again — and neither store can describe the same page with
     * different facts.
     */
    begin(
      entityId: string,
      archivePage: M[],
      page: PageInfo,
      complete: boolean,
      direction: HistoryQueryDirection,
      options: ArchiveMergeOptions = {},
    ): ArchiveMergeRun<M> {
      const { isFetchLatest = false, preserveGapMarker = false, extras } = options
      ports.readTracker.noteUnreadInputsChanged(entityId)

      const scopeAtMerge = getStorageScopeJid()
      const entityUnchanged = ports.captureEntity(entityId)
      const stillCurrent = () => entityUnchanged() && getStorageScopeJid() === scopeAtMerge

      const fetched = ports.replayRetractions(entityId, archivePage)
      const fallbackHeldTs = ports.lastHeldTimestamp(entityId)
      // Diagnostics only. Filled as the merge goes, and left uncounted by one that bailed.
      const diagnostics = newArchiveMergeTally()

      let ownArchiveWrite: Promise<boolean> | undefined
      let commitGate: Promise<boolean> | undefined
      let durableRows: M[] = []
      let coverageChanged = false

      return {
        messages: fetched,

        storePage(facts: MergePageFacts<M>): MergePlan {
          // Rows carrying no-local-store are the archive's business for this session only.
          const persistableNew = facts.newMessages.filter((msg) => !isNoLocalStore(msg))
          const persistablePatched = facts.patched.filter((msg) => !isNoLocalStore(msg))
          // Patched rows are stored by this merge too, so they stop being the overlay's business.
          durableRows = [...persistableNew, ...persistablePatched]

          diagnostics.returned = fetched.length
          diagnostics.newMessages = facts.newMessages.length
          diagnostics.persistableNew = persistableNew.length
          diagnostics.patched = facts.patched.length
          diagnostics.persistablePatched = persistablePatched.length
          diagnostics.counted = true

          // A merge with nothing persistable still waits when earlier pages of this entity are in
          // flight (or failed): its cursor must not leap them.
          const gatedOnDurableWrite = durableRows.length > 0 || ports.saves.has(entityId)

          // The query's own outcome: completion, the cursor an older page resumes from, and the
          // timestamp that marks where a forward catch-up stopped short. Applied before anything
          // reads it below.
          let mamStates = mamState.setMAMQueryCompleted(
            facts.mamStates,
            entityId,
            complete,
            direction,
            page.first,
            mamState.computeNewestFetchedTimestamp(fetched, direction),
            preserveGapMarker,
            isFetchLatest,
            mamState.isDisjointFromResidentWindow(facts.existing, extras?.initialBefore, isFetchLatest),
          )

          // The newest PROVEN in-memory boundary. Undefined when nothing is resident.
          const residentNewestTs = messagePageExtent(facts.existing).newestTs

          const newGaps = syncGapAfterArchiveMerge({
            gaps: facts.gaps,
            id: entityId,
            direction,
            complete,
            forwardGapTimestamp: mamStates.get(entityId)?.forwardGapTimestamp,
            merged: facts.merged,
            fetched,
            newMessagesCount: facts.newMessages.length,
            patchedCount: facts.patched.length,
            isFetchLatest,
            // ONLY a proven boundary (the resident extent) anchors a seam — never the preview
            // timestamp, which may be an unarchived row above the true archive newest and would
            // plant a spurious one. With nothing resident there is no proven boundary, and the
            // unproven flag below says so instead.
            newestHeldBelowTs: residentNewestTs,
            newestHeldBelowId: newestMessageStanzaId(facts.existing),
            lastFetchedArchiveId: page.last,
            preserveGapMarker,
          })

          // Coverage-bottom proof. A merge proves the contiguous bottom when a resident boundary
          // exists, or a recorded gap now carries a proven upper edge — clear any stale flag.
          // Otherwise a disjoint fetch-latest landing above held-below history with no seam formed
          // leaves the bottom unproven, so the catch-up seeder will not trust cache-oldest as
          // contiguous with the live edge.
          const coverageProven = residentNewestTs !== undefined || newGaps.get(entityId)?.endId !== undefined
          if (coverageProven) {
            mamStates = mamState.setCoverageBottomUnproven(mamStates, entityId, false)
          } else if (direction === 'backward' && isFetchLatest && !newGaps.has(entityId)) {
            const structurallyDisjoint = facts.newMessages.length === fetched.length && facts.patched.length === 0
            const pageOldestTs = messagePageExtent(fetched).oldestTs
            const previewBelow = fallbackHeldTs !== undefined && pageOldestTs !== undefined
              && pageOldestTs > fallbackHeldTs
            if (structurallyDisjoint && previewBelow) {
              mamStates = mamState.setCoverageBottomUnproven(mamStates, entityId, true)
            }
          }

          // Counting needs a persisted message anchor; RSM cursors also name signals.
          const walkOldestId = extras?.walkOldestId ?? walkExtentBottomId(fetched)
          const { coverage: newCoverage, transition } = syncCoverageAfterArchiveMerge({
            coverage: facts.coverage,
            id: entityId,
            direction,
            isFetchLatest,
            preserveGapMarker,
            rsmFirst: page.first,
            fetchLatestTopId: extras?.fetchLatestTopId,
            initialBefore: extras?.initialBefore,
            sawCoverageTop: extras?.sawCoverageTop ?? false,
            walkCarriedModifications: extras?.walkCarriedModifications ?? false,
            complete,
            initialAfter: extras?.initialAfter,
            walkOldestId,
          })

          const durable = planDurableCommit(entityId, {
            gaps: { current: facts.gaps, next: newGaps },
            coverage: { current: facts.coverage, next: newCoverage, transition },
            gatedOnDurableWrite,
          })

          coverageChanged = newCoverage !== facts.coverage
          const coverageBootstrappedFromWalkExtent =
            transition === 'created' &&
            extras?.initialAfter === undefined &&
            walkOldestId !== undefined &&
            newCoverage.get(entityId)?.bottomId === walkOldestId

          if (durableRows.length > 0) {
            ownArchiveWrite = ports.saveRows(durableRows)
            commitGate = ports.saves.chain(entityId, ownArchiveWrite)
            durable.commitWhenDurable(commitGate)
            if (persistableNew.length > 0) {
              searchIndex.indexMessages(persistableNew).catch((e) => console.warn('[searchIndex] indexMessages failed:', e))
            }
          } else if (durable.deferred) {
            // Nothing of our own to store, but earlier in-flight pages still gate this merge's
            // transitions: chain a no-op so they apply — or are dropped — under the same rules.
            commitGate = ports.saves.chain(entityId, Promise.resolve(true))
            durable.commitWhenDurable(commitGate)
          }

          return {
            ...durable,
            mamStates,
            coverageChanged,
            coverageBootstrappedFromWalkExtent,
            extendsHistoryPastFloor:
              direction === 'forward' && facts.newMessages.length > 0 && !coverageBootstrappedFromWalkExtent,
          }
        },

        settled({ merged, recount }): void {
          reportArchiveMergeWhenDurable(kind, entityId, direction, complete, diagnostics, ownArchiveWrite, commitGate)

          if (commitGate) {
            void commitGate.then((committed) => {
              if (!committed || !stillCurrent()) return
              // Stored rows are countable from the archive now, so they leave the overlay.
              for (const message of durableRows) {
                ports.readTracker.dropUnreadMessage(entityId, ports.unreadKey(message))
              }
              ports.readTracker.resumeDeferredRecounts(entityId)
            })
          }

          // XEP-0490: a pending marker was not orderable in an earlier slice. Retry against the
          // merged messages; the tracker clears it only when the comparison resolves.
          const pending = ports.pendingRemoteMarker(entityId)
          if (pending) ports.readTracker.applyRemoteDisplayed(entityId, pending, merged)

          if (recount) ports.recountUnread(entityId)

          if (!coverageChanged && !(direction === 'forward' && complete)) return
          let gate = commitGate
          if (!gate && ports.saves.has(entityId)) gate = ports.saves.chain(entityId, Promise.resolve(true))

          const resume = async () => {
            if (!stillCurrent()) return
            if (direction === 'forward' && complete && !preserveGapMarker && !extras?.walkCarriedModifications) {
              const record = ports.coverageOf(entityId)
              const inputsUnchanged = ports.readTracker.captureUnreadInputs(entityId)
              const repaired = await recoverCoverageForCounting(
                entityId,
                record,
                [extras?.initialAfter, extras?.walkOldestId ?? walkExtentBottomId(fetched)],
                kind === 'room',
              )
              if (!stillCurrent() || !inputsUnchanged()) return
              if (repaired && ports.coverageOf(entityId) === record) {
                ports.applyDeferred(entityId, { coverage: repaired }, { gap: undefined, coverage: record },
                  record ? 'replaced' : 'created')
                coverageChanged = true
              }
            }
            ports.readTracker.resumeDeferredRecounts(entityId)
            if (coverageChanged) ports.readTracker.scheduleRecount(entityId)
          }

          if (gate) void gate.then((committed) => { if (committed) return resume() })
          else void resume()
        },
      }
    },
  }
}

export type ArchiveMerge<M extends Message | RoomMessage> = ReturnType<typeof createArchiveMerge<M>>
