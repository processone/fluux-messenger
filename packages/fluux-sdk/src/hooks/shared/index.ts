/**
 * Shared hook utilities.
 *
 * These utilities provide common patterns used by multiple hooks
 * to reduce code duplication.
 */

export { createFetchOlderHistory, type FetchOlderHistoryDeps } from './createFetchOlderHistory'
export { createContinueCatchUp, type ContinueCatchUpDeps } from './createContinueCatchUp'
export { pickOldestArchiveId, isItemNotFoundError } from './mamCursor'
