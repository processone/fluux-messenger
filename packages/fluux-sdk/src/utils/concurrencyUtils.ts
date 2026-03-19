/**
 * Shared utilities for concurrent operations with rate limiting.
 *
 * These utilities help manage parallel execution of async operations
 * while respecting concurrency limits to avoid overwhelming servers.
 */

/**
 * Executes an async operation for each item with a concurrency limit.
 *
 * Unlike Promise.all, this limits how many operations run simultaneously,
 * preventing server overload during batch operations.
 *
 * @param items - Array of items to process
 * @param operation - Async function to call for each item
 * @param concurrency - Maximum parallel operations (default: 3)
 *
 * @example
 * ```typescript
 * // Refresh previews for multiple conversations
 * await executeWithConcurrency(
 *   conversationIds,
 *   (id) => fetchPreviewForConversation(id),
 *   3
 * )
 *
 * // Process rooms with default concurrency
 * await executeWithConcurrency(
 *   roomJids,
 *   (jid) => fetchPreviewForRoom(jid)
 * )
 * ```
 */
export async function executeWithConcurrency<T>(
  items: T[],
  operation: (item: T) => Promise<void>,
  concurrency: number = 3
): Promise<void> {
  if (items.length === 0) return

  let activeCount = 0
  const waitQueue: Array<() => void> = []

  function acquire(): Promise<void> {
    if (activeCount < concurrency) {
      activeCount++
      return Promise.resolve()
    }
    return new Promise<void>((resolve) => {
      waitQueue.push(() => {
        activeCount++
        resolve()
      })
    })
  }

  function release(): void {
    activeCount--
    const next = waitQueue.shift()
    if (next) next()
  }

  const promises = items.map(async (item) => {
    await acquire()
    try {
      await operation(item)
    } catch {
      // Errors are intentionally swallowed here
      // Individual operations should handle their own error logging
    } finally {
      release()
    }
  })

  await Promise.allSettled(promises)
}
