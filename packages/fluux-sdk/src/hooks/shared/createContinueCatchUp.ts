/**
 * Shared utility for creating continueCatchUp callbacks.
 *
 * This factory generates the "Load missing messages" callback used by both
 * useChatActive and useRoomActive (the forward twin of
 * {@link ./createFetchOlderHistory!createFetchOlderHistory}), reducing code
 * duplication while allowing for store-specific customization.
 *
 * Cursor policy is {@link selectCatchUpQuery} — the single shared FIRST-query
 * policy for chat + room catch-up:
 * - recorded gap with a seam startId → id-exact `after:` resume (immune to
 *   same-millisecond timestamp collisions; a purged anchor degrades via the
 *   item-not-found handling inside queryArchive/queryRoomArchive);
 * - gap with only a timestamp → `start: gapTs` (exact — the boundary message
 *   re-fetches and dedupes);
 * - no gap → the newest cached message: id-exact `after:` when it carries an
 *   archive id, timestamp `start:` otherwise;
 * - no local edge at all → nothing to continue from (the initial catch-up
 *   path owns fetch-latest), so no query runs.
 *
 * Every query paginates oldest-first to completion under the manual cap
 * (MAM_ROOM_FORWARD_MAX_PAGES_MANUAL) — a deliberate user action should fill
 * the hole fully instead of silently stopping mid-gap.
 */

import { connectionStore } from '../../stores/connectionStore'
import type { MAMQueryState } from '../../core/types'
import {
  selectCatchUpQuery,
  MAM_CACHE_LOAD_LIMIT,
  MAM_CATCHUP_FORWARD_MAX,
  MAM_ROOM_FORWARD_MAX_PAGES_MANUAL,
} from '../../utils/mamCatchUpUtils'

/**
 * Dependencies required to create the continueCatchUp callback.
 */
export interface ContinueCatchUpDeps {
  /**
   * Get the active conversation/room ID from the store.
   */
  getActiveId: () => string | null

  /**
   * Get the MAM query state for the target.
   */
  getMAMState: (id: string) => MAMQueryState

  /**
   * Set the MAM loading state for the target.
   */
  setMAMLoading: (id: string, isLoading: boolean) => void

  /**
   * Load the latest cached messages into the store (resident window refresh
   * before computing the cursor).
   */
  loadFromCache: (id: string, limit: number) => Promise<unknown>

  /**
   * Read the target's resident messages after the cache load — the cursor
   * candidates for {@link selectCatchUpQuery}.
   */
  getMessages: (id: string) => Array<{ timestamp?: Date; stanzaId?: string }>

  /**
   * Read the recorded (persisted) forward gap for the target, when one exists.
   * `start` is the epoch ms of the hole boundary; `startId` the archive id of
   * the last downloaded message below it (preferred, id-exact resume).
   */
  getGap: (id: string) => { start?: number; startId?: string } | undefined

  /**
   * Run the forward MAM query. Receives the full query options (cursor +
   * max + manual pagination cap); the adapter only adds the addressing field
   * (`with:` / `roomJid:`).
   */
  queryMAM: (
    id: string,
    options: { after?: string; start?: string; max: number; maxAutoPages: number },
  ) => Promise<void>
}

/**
 * Creates a continueCatchUp callback with the given dependencies.
 *
 * The returned function implements the guard → load → cursor → query pattern:
 * 1. Bail when there is no active target or the connection is not online
 * 2. Bail when a MAM query is already loading
 * 3. Set the loading state
 * 4. Refresh the resident window from cache, then pick the forward cursor
 *    from the recorded gap / newest cached message (see module doc)
 * 5. Always clear the loading state in a finally block
 *
 * @param deps - Store-specific dependencies
 * @returns The continueCatchUp callback function
 */
export function createContinueCatchUp(deps: ContinueCatchUpDeps): () => Promise<void> {
  const { getActiveId, getMAMState, setMAMLoading, loadFromCache, getMessages, getGap, queryMAM } = deps

  return async (): Promise<void> => {
    const id = getActiveId()
    if (!id) return

    // Guard: don't attempt a MAM query when the socket is not online.
    if (connectionStore.getState().status !== 'online') return

    if (getMAMState(id).isLoading) return

    setMAMLoading(id, true)

    try {
      await loadFromCache(id, MAM_CACHE_LOAD_LIMIT)
      const gap = getGap(id)
      const q = selectCatchUpQuery(getMessages(id), {
        forwardGapTimestamp: gap?.start,
        forwardGapStartId: gap?.startId,
      })
      // `before` (no local edge to resume from) is not a continue action —
      // the initial catch-up path owns fetch-latest — so only forward cursors
      // trigger a query here.
      if (q.after || q.start) {
        await queryMAM(id, {
          ...(q.after ? { after: q.after } : { start: q.start }),
          max: MAM_CATCHUP_FORWARD_MAX,
          maxAutoPages: MAM_ROOM_FORWARD_MAX_PAGES_MANUAL,
        })
      }
    } catch {
      // Swallow — the gap marker stays so the user can retry.
    } finally {
      // Always clear the loading flag, even when no cursor was found and no
      // query ran (otherwise the "load missing messages" button spins forever).
      // On the success path the query's own finally already emitted
      // isLoading:false; this idempotent backstop covers the no-query and error
      // paths.
      setMAMLoading(id, false)
    }
  }
}
