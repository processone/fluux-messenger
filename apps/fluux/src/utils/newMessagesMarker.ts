/**
 * Utility for finding the first "new" message in a conversation or room.
 * Used to display the "New messages" marker (red line) between old and new messages.
 */

/**
 * Minimal message interface for marker detection.
 * Works with both Message (1:1 chats) and RoomMessage types.
 */
export interface MarkerMessage {
  id: string
  timestamp: Date
  isOutgoing: boolean
  isDelayed?: boolean
}

/**
 * Find the ID of the first "new" message that should have a marker before it.
 *
 * A message is considered "new" if:
 * 1. Its timestamp is after readAt
 * 2. It's an incoming message (not outgoing)
 * 3. It's not a delayed/historical message
 *
 * @param messages - Array of messages to search through
 * @param readAt - Timestamp when the conversation/room was last read
 * @returns The ID of the first new message, or null if none found
 */
export function findFirstNewMessageId(
  messages: MarkerMessage[],
  readAt: Date | undefined
): string | null {
  if (!readAt) {
    return null
  }

  const firstNewMessage = messages.find(
    (msg) => msg.timestamp > readAt && !msg.isOutgoing && !msg.isDelayed
  )

  return firstNewMessage?.id ?? null
}
