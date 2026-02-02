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
  let index = 0

  const processNext = async (): Promise<void> => {
    while (index < items.length) {
      if (activeCount >= concurrency) {
        // Wait a bit before checking again
        await new Promise((resolve) => setTimeout(resolve, 50))
        continue
      }

      const item = items[index++]
      activeCount++

      // Don't await - let it run in parallel
      // Catch errors to prevent unhandled rejections (errors are silently ignored)
      operation(item)
        .catch(() => {
          // Errors are intentionally swallowed here
          // Individual operations should handle their own error logging
        })
        .finally(() => {
          activeCount--
        })
    }
  }

  // Start the processing
  await processNext()

  // Wait for all in-flight requests to complete
  while (activeCount > 0) {
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
}
