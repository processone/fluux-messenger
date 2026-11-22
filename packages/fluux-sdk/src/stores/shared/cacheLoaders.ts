import * as messageCache from '../../utils/messageCache'
import { refreshCachedCorrections, type Row } from './correctionHandoff'
import { findMessageRowIndex, type MessageRowRef } from '../../utils/messageIdentity'
import { withMessageCacheOperation } from './messageUpdateHandoff'
import { readAroundBounded, withoutRowsPastSlice } from './aroundTail'
import { getResidentWindowSize } from './residentWindow'
import * as timeline from './messageTimeline'

type Kind = 'chat' | 'room'

/**
 * How one store plugs into the shared cache loaders: where its resident window lives and how
 * it writes one. Everything the loaders decide (ordering of reads, supersession checks, what
 * counts as reaching the live edge) lives in {@link createCacheLoaders}; everything that
 * differs between a conversation and a room (the shape of the state, how the live-edge claim
 * is recorded, the room's occupant flush) is a member here.
 */
export interface CacheLoaderAdapter<M extends Row, S> {
  kind: Kind
  /** Capture the current account and entity so a later check can tell the read was superseded. */
  captureRead(entityId: string): () => boolean
  /** The cache cannot be read at all, so every load resolves to nothing. */
  cacheUnavailable?: () => boolean
  /** The entity is unknown to the store, so a load has nothing to merge into. */
  unknown?: (state: S, entityId: string) => boolean
  residentOf(state: S, entityId: string): M[]
  timelineConfig(): timeline.TimelineConfig<M>
  /** Reconcile a slice read around an anchor against the resident window. */
  reconcileAround(resident: M[], cached: M[]): M[]
  /** Reconcile a slice paged in before or after the resident window. */
  reconcilePage(resident: M[], cached: M[]): M[]
  /** Merge a latest slice; the commit of the merged rows. Null when nothing changed. */
  mergeLatest(state: S, entityId: string, cached: M[]): Partial<S> | null
  mergeAround(state: S, entityId: string, slice: M[], anchor: MessageRowRef, contextBefore: number, tailTruncated: boolean): Partial<S> | null
  /** Commit merged rows; `edge` false parks the window, true reaches the live edge, undefined leaves it. */
  commit(state: S, entityId: string, merged: M[], edge?: boolean): Partial<S> | null
  /** Record that the window reached the live edge on top of an optional merge (`update`). */
  reachLiveEdge(state: S, entityId: string, update: Partial<S> | null): Partial<S> | null
  /** The window was moved away from the live edge, so a latest slice must not be spliced onto it. */
  parked(state: S, entityId: string): boolean
  /** Runs once cached rows are about to become resident (the room flushes pending occupants). */
  beforePublish?: (entityId: string) => void
  /** A newer batch made only of hidden rows moves the read on instead of ending it. */
  isHidden?: (message: M) => boolean
  /** Log text for a failed read, by operation. */
  failure(operation: 'latest' | 'around' | 'older' | 'newer', error: unknown): void
}

export interface CacheLoaders<M> {
  loadMessagesFromCache(entityId: string, options?: { limit?: number; before?: Date; after?: Date; peek?: boolean; oldest?: boolean }): Promise<M[]>
  loadMessagesAroundFromCache(entityId: string, anchorRow: MessageRowRef, options?: { before?: number; after?: number }, signal?: AbortSignal): Promise<M[]>
  loadOlderMessagesFromCache(entityId: string, limit?: number): Promise<M[]>
  loadNewerMessagesFromCache(entityId: string, limit?: number): Promise<M[]>
  recenterToLatest(entityId: string): Promise<boolean>
}

/** The five cache loaders both timeline stores expose, implemented once. */
export function createCacheLoaders<M extends Row, S extends { messages: Map<string, M[]> }>(
  adapter: CacheLoaderAdapter<M, S>,
  set: (update: (state: S) => Partial<S> | S) => void,
  get: () => S,
): CacheLoaders<M> {
  const { kind } = adapter
  const unavailable = () => adapter.cacheUnavailable?.() ?? false
  const unknown = (entityId: string) => adapter.unknown?.(get(), entityId) ?? false

  function readLatest(entityId: string, limit: number): Promise<messageCache.CacheRead<M[]>> {
    const isCurrent = adapter.captureRead(entityId)
    return withMessageCacheOperation(kind, entityId, async () => {
      if (!isCurrent()) return { status: 'ok', value: [] }
      const read = await messageCache.readMessages(kind, entityId, { limit, latest: true })
      if (read.status === 'unavailable') return read as messageCache.CacheRead<M[]>
      return { status: 'ok', value: await refreshCachedCorrections(read.value as M[], isCurrent) }
    }) as Promise<messageCache.CacheRead<M[]>>
  }

  async function loadMessagesFromCache(
    entityId: string,
    options: { limit?: number; before?: Date; after?: Date; peek?: boolean; oldest?: boolean } = {},
  ): Promise<M[]> {
    const isCurrent = adapter.captureRead(entityId)
    return withMessageCacheOperation(kind, entityId, async () => {
      if (!isCurrent() || unavailable()) return []
      try {
        const cached = await messageCache.getMessages(kind, entityId, {
          limit: options.limit ?? 100,
          before: options.before,
          after: options.after,
          // Without `before` the latest rows are wanted, so an old slice never shows and then
          // jumps to recent ones. `oldest` opts out: ascending oldest-N, the true cache bottom.
          latest: !options.before && !options.oldest,
        }).then(messages => refreshCachedCorrections(messages as M[], isCurrent))
        if (!isCurrent()) return []
        // `peek` is a pure read, used to compute a catch-up cursor for a non-active entity
        // without pulling its history into RAM; `oldest` is always one too, since the cache
        // bottom must never become the resident window and tear the UI off the live edge.
        if (!options.peek && !options.oldest && cached.length > 0) {
          adapter.beforePublish?.(entityId)
          // A `before`-anchored load does not establish the live edge.
          const recenter = !options.before
          set((state) => {
            // A parked window keeps its place; the latest slice waits in the cache for
            // jump-to-latest (see recenterToLatest).
            if (recenter && adapter.parked(state, entityId)) return state
            const update = adapter.mergeLatest(state, entityId, cached)
            if (!recenter) return update ?? state
            return adapter.reachLiveEdge(state, entityId, update) ?? state
          })
        }
        return cached
      } catch (error) {
        adapter.failure('latest', error)
        return []
      }
    })
  }

  async function loadMessagesAroundFromCache(
    entityId: string,
    anchorRow: MessageRowRef,
    options: { before?: number; after?: number } = {},
    signal?: AbortSignal,
  ): Promise<M[]> {
    const isCurrent = adapter.captureRead(entityId)
    const canPublish = () => !signal?.aborted && isCurrent()
    return withMessageCacheOperation(kind, entityId, async () => {
      if (!canPublish() || unavailable()) return []
      try {
        const bound = getResidentWindowSize()
        const contextBefore = options.before ?? messageCache.AROUND_CONTEXT_BEFORE
        const { slice, tailTruncated } = await readAroundBounded(options, bound, anchorRow,
          (after) => messageCache.getMessagesAround(kind, entityId, anchorRow, { ...options, ...(after === undefined ? {} : { after }) })
            .then(messages => refreshCachedCorrections(messages as M[], canPublish)),
          (candidate) => {
            const resident = withoutRowsPastSlice(adapter.residentOf(get(), entityId), candidate, true)
            return timeline.aroundSlice(
              adapter.reconcileAround(resident, candidate), candidate,
              (messages) => findMessageRowIndex(messages as never, anchorRow), contextBefore, adapter.timelineConfig(),
            ).newestEvicted
          })
        if (!canPublish()) return []
        if (slice.length > 0) {
          adapter.beforePublish?.(entityId)
          set((state) => !canPublish() ? state : adapter.mergeAround(state, entityId, slice, anchorRow, contextBefore, tailTruncated) ?? state)
        }
        return slice
      } catch (error) {
        adapter.failure('around', error)
        return []
      }
    })
  }

  async function loadOlderMessagesFromCache(entityId: string, limit = 50): Promise<M[]> {
    const isCurrent = adapter.captureRead(entityId)
    return withMessageCacheOperation(kind, entityId, async () => {
      if (!isCurrent() || unavailable()) return []
      try {
        const resident = adapter.residentOf(get(), entityId)
        if (unknown(entityId) || resident.length === 0) return []
        const older = await messageCache.getMessages(kind, entityId, {
          limit,
          before: resident[0].timestamp,
        }).then(messages => refreshCachedCorrections(messages as M[], isCurrent))
        if (!isCurrent()) return []
        if (older.length > 0) {
          adapter.beforePublish?.(entityId)
          set((state) => {
            // Dedupe against the resident rows (a slice can overlap at the `before:` boundary),
            // sort, keep-oldest trim: load-older slides the window so scroll-back past the
            // bound works. When keep-oldest evicts the newest resident row the window has slid
            // off the live edge, which gates live appends.
            const { merged, newestEvicted } = timeline.loadOlderSlice(
              adapter.reconcilePage(adapter.residentOf(state, entityId), older), older, adapter.timelineConfig(),
            )
            return adapter.commit(state, entityId, merged, newestEvicted ? false : undefined) ?? state
          })
        }
        return older
      } catch (error) {
        adapter.failure('older', error)
        return []
      }
    })
  }

  async function loadNewerMessagesFromCache(entityId: string, limit = 50): Promise<M[]> {
    const isCurrent = adapter.captureRead(entityId)
    return withMessageCacheOperation(kind, entityId, async () => {
      if (!isCurrent() || unavailable()) return []
      try {
        while (isCurrent()) {
          const resident = adapter.residentOf(get(), entityId)
          if (unknown(entityId) || resident.length === 0) return []
          const afterDate = resident[resident.length - 1].timestamp
          const read = await messageCache.readMessages(kind, entityId, { after: afterDate, limit })
          // An unreadable cache says nothing about newer rows: the window stays parked
          // rather than claiming the tail.
          if (read.status === 'unavailable' || !isCurrent()) return []
          const newer = await refreshCachedCorrections(read.value as M[], isCurrent)
          if (!isCurrent()) return []

          // Fewer rows than asked means nothing newer remains in the cache, so the window has
          // reached the tail whether the batch was empty or partial.
          const reachedTail = newer.length < limit

          if (newer.length > 0) {
            adapter.beforePublish?.(entityId)
            // Dedupe (overlap at the `after:` boundary), sort, keep-newest trim: load-newer
            // slides the window back down toward the live edge.
            set((state) => {
              const { merged } = timeline.loadNewerSlice(
                adapter.reconcilePage(adapter.residentOf(state, entityId), newer), newer, adapter.timelineConfig(),
              )
              return adapter.commit(state, entityId, merged, reachedTail ? true : undefined) ?? state
            })
          } else if (reachedTail) {
            set((state) => adapter.reachLiveEdge(state, entityId, null) ?? state)
          }

          const { isHidden } = adapter
          if (reachedTail || !isHidden || newer.some(message => !isHidden(message))) return newer
          const next = get().messages.get(entityId)?.at(-1)?.timestamp.getTime()
          if (next === undefined || next <= afterDate.getTime()) return newer
        }
        return []
      } catch (error) {
        adapter.failure('newer', error)
        return []
      }
    })
  }

  async function recenterToLatest(entityId: string): Promise<boolean> {
    // Jump-to-latest is the one latest-slice load that replaces a parked window, which
    // loadMessagesFromCache leaves in place, so it merges the peeked slice itself. A full
    // window's worth keeps the merge contiguous: keep-newest drops the parked rows.
    const read = await readLatest(entityId, getResidentWindowSize())
    const latest = read.status === 'ok' ? read.value : []
    if (latest.length > 0) adapter.beforePublish?.(entityId)
    // The live-edge claim is made even when the newest window was already fully resident, and
    // when the cache is unreadable: the caller then fetches the latest page from the archive,
    // which a parked window would refuse.
    set((state) => {
      const update = latest.length > 0 ? adapter.mergeLatest(state, entityId, latest) : null
      return adapter.reachLiveEdge(state, entityId, update) ?? state
    })
    return read.status === 'ok'
  }

  return {
    loadMessagesFromCache, loadMessagesAroundFromCache, loadOlderMessagesFromCache,
    loadNewerMessagesFromCache, recenterToLatest,
  }
}
