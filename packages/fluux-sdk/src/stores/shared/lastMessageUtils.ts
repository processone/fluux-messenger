/**
 * Shared utilities for lastMessage timestamp comparison.
 *
 * These functions help determine when to update the lastMessage preview
 * for conversations and rooms, used by both chatStore and roomStore.
 */

/**
 * Generic interface for messages with an optional timestamp.
 * Both Message and RoomMessage satisfy this interface.
 */
export interface MessageWithTimestamp {
  timestamp?: Date
}

/**
 * Determines if a new message should replace an existing lastMessage.
 *
 * The new message should only replace the existing one if it has a newer timestamp.
 * This prevents older messages (e.g., from MAM pagination) from overwriting
 * more recent previews.
 *
 * @param existing - The current lastMessage (may be undefined)
 * @param newMessage - The candidate message to potentially use as lastMessage
 * @returns true if newMessage is newer and should replace existing
 *
 * @example
 * ```typescript
 * // In chatStore.updateLastMessagePreview
 * if (!shouldUpdateLastMessage(meta.lastMessage, newMessage)) {
 *   return state // Keep existing, new message is older
 * }
 *
 * // In roomStore.updateLastMessagePreview
 * if (!shouldUpdateLastMessage(room.lastMessage, newMessage)) {
 *   return state
 * }
 * ```
 */
export function shouldUpdateLastMessage<T extends MessageWithTimestamp>(
  existing: T | undefined,
  newMessage: T
): boolean {
  const existingTime = existing?.timestamp?.getTime() ?? 0
  const newTime = newMessage.timestamp?.getTime() ?? 0
  return newTime > existingTime
}
