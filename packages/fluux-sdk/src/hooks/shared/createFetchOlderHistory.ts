/**
 * Shared utility for creating fetchOlderHistory callbacks.
 *
 * This factory function generates the fetchOlderHistory callback used by both
 * useChat and useRoom hooks, reducing code duplication while allowing for
 * store-specific customization.
 */

import type { MAMQueryState } from '../../core/types'
import { connectionStore } from '../../stores/connectionStore'
import { isItemNotFoundError } from './mamCursor'

/**
 * Dependencies required to create the fetchOlderHistory callback.
 */
export interface FetchOlderHistoryDeps {
  /**
   * Get the active conversation/room ID from the store.
   */
  getActiveId: () => string | null

  /**
   * Validate that the target exists and is valid for fetching.
   * Returns true if valid, false otherwise.
   */
  isValidTarget: (id: string) => boolean

  /**
   * Get the MAM query state for the target.
   */
  getMAMState: (id: string) => MAMQueryState

  /**
   * Set the MAM loading state for the target.
   */
  setMAMLoading: (id: string, isLoading: boolean) => void

  /**
   * Load older messages from IndexedDB cache.
   * Returns the loaded messages array.
   */
  loadFromCache: (id: string, limit: number) => Promise<unknown[]>

  /**
   * Get the server archive ID (XEP-0359 stanza-id) of the oldest in-memory
   * message that has one. Used as the MAM `before` pagination cursor.
   *
   * Returns undefined when no in-memory message carries a server-assigned
   * archive ID. Callers MUST NOT substitute a client-generated id: a client id
   * is not a valid archive entry and the server rejects it with
   * `item-not-found`, dead-ending "load older history".
   */
  getOldestMessageId: (id: string) => string | undefined

  /**
   * Query the MAM archive for older messages.
   * Called when cache is exhausted and MAM is not complete.
   */
  queryMAM: (id: string, beforeId: string) => Promise<void>

  /**
   * Optional: clear a stale local stanzaId after the server proves it is not an
   * archive cursor. This repairs old caches where a sender/origin id was stored
   * in the stanzaId slot, preventing every future retry from choosing the same
   * bad cursor again.
   */
  clearInvalidArchiveCursor?: (id: string, cursor: string) => void | Promise<void>

  /**
   * Optional: timestamp of the oldest in-memory message. Used for the
   * id-independent recovery query when no valid archive cursor is available or
   * the server rejects the cursor with `item-not-found`.
   */
  getOldestTimestamp?: (id: string) => Date | undefined

  /**
   * Optional: query MAM for messages archived before a timestamp (XEP-0313
   * `end` filter). This recovery path does not depend on an opaque archive id,
   * so it works even when the oldest in-memory message has no stanzaId or the
   * cursor is stale. Only the 1:1 chat archive supports the `end` filter.
   */
  queryMAMByEndTime?: (id: string, endIso: string) => Promise<void>

  /**
   * Error message prefix for logging.
   */
  errorLogPrefix: string
}

/**
 * Creates a fetchOlderHistory callback with the given dependencies.
 *
 * The returned function implements the cache-first-then-MAM pattern:
 * 1. Check if MAM query is already loading or complete
 * 2. Set loading state
 * 3. Try to load older messages from IndexedDB cache
 * 4. If cache is empty/exhausted, fall back to MAM query
 * 5. Always clear loading state in finally block
 *
 * @param deps - Store-specific dependencies
 * @returns The fetchOlderHistory callback function
 */
export function createFetchOlderHistory(
  deps: FetchOlderHistoryDeps
): (targetId?: string) => Promise<void> {
  const {
    getActiveId,
    isValidTarget,
    getMAMState,
    setMAMLoading,
    loadFromCache,
    getOldestMessageId,
    queryMAM,
    clearInvalidArchiveCursor,
    getOldestTimestamp,
    queryMAMByEndTime,
    errorLogPrefix,
  } = deps

  /**
   * Recover by fetching the page of messages archived before the oldest
   * in-memory message's timestamp. Id-independent, so it works when no valid
   * archive cursor is available. No-op when the dependency or timestamp is
   * missing (e.g. room MAM, which has no `end` filter).
   */
  const recoverByTimestamp = async (id: string): Promise<boolean> => {
    const oldestTimestamp = getOldestTimestamp?.(id)
    if (!queryMAMByEndTime || !oldestTimestamp) return false
    await queryMAMByEndTime(id, oldestTimestamp.toISOString())
    return true
  }

  return async (targetId?: string): Promise<void> => {
    // Guard: Don't attempt MAM query if not connected
    // This prevents errors when socket is dead (e.g., after sleep)
    const connectionStatus = connectionStore.getState().status
    if (connectionStatus !== 'online') return

    const id = targetId ?? getActiveId()
    if (!id) return

    // Validate target exists and is ready for fetching
    if (!isValidTarget(id)) return

    // Check MAM state - don't fetch if already loading
    const mamState = getMAMState(id)
    if (mamState.isLoading) return

    // Show loading indicator for both cache and MAM paths
    setMAMLoading(id, true)

    try {
      // First try to load older messages from IndexedDB cache
      const cachedMessages = await loadFromCache(id, 50)

      // If we got messages from cache, we're done
      if (cachedMessages.length > 0) {
        return
      }

      // Cache exhausted - fall back to MAM if not complete
      if (mamState.isHistoryComplete) return

      // Use the oldest in-memory message's archive id (XEP-0359 stanza-id) as
      // the pagination cursor. This is more reliable than mamState.oldestFetchedId
      // because:
      // 1. The initial MAM query may have used 'start' filter to only fetch NEW messages
      // 2. We need to paginate from the actual oldest message we have, not what MAM returned
      // getOldestMessageId never returns a client-generated id — that would be
      // rejected by the server with item-not-found.
      const beforeId = getOldestMessageId(id)
      const isChat = errorLogPrefix.includes('chat')

      // No valid archive cursor available.
      if (!beforeId) {
        // Chat: recover via a timestamp window if possible; otherwise there is
        // nothing safe to send (a client id would be rejected), so skip.
        if (isChat) {
          await recoverByTimestamp(id)
          return
        }
        // Room MAM: empty string means "get latest", valid for the first query.
        await queryMAM(id, '')
        return
      }

      try {
        await queryMAM(id, beforeId)
      } catch (error) {
        // A stale or non-archive cursor makes the server return item-not-found.
        // First scrub that cursor from the loaded cache so future attempts do
        // not keep selecting the same poisoned stanzaId, then recover with an
        // id-independent timestamp window (1:1) or the next available cursor.
        if (isItemNotFoundError(error)) {
          await clearInvalidArchiveCursor?.(id, beforeId)
          if (await recoverByTimestamp(id)) return

          const replacementBeforeId = getOldestMessageId(id)
          if (replacementBeforeId && replacementBeforeId !== beforeId) {
            await queryMAM(id, replacementBeforeId)
            return
          }

          if (!isChat) {
            await queryMAM(id, '')
            return
          }
        }
        throw error
      }
    } catch (error) {
      console.error(`${errorLogPrefix}:`, error)
    } finally {
      // Always clear loading state
      setMAMLoading(id, false)
    }
  }
}
