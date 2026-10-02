import type { ConversationMetadata, Message } from '../../core/types'

function timeOf(timestamp: Date | string | undefined): number | undefined {
  if (timestamp === undefined) return undefined
  const ms = (timestamp instanceof Date ? timestamp : new Date(timestamp)).getTime()
  return Number.isNaN(ms) ? undefined : ms
}

/**
 * The moment a conversation's archive starts, for `meta.archivedAt`.
 *
 * Never earlier than the newest known message: message timestamps come from the
 * sender or the server, so a lagging local clock would otherwise let a message
 * the user saw before archiving count as newer than the archive.
 */
export function archiveMoment(meta: Pick<ConversationMetadata, 'lastMessage'> | undefined, now: number = Date.now()): Date {
  return new Date(Math.max(now, timeOf(meta?.lastMessage?.timestamp) ?? now))
}

/**
 * Whether any of `messages` is evidence of activity since the conversation was
 * archived: an incoming message timestamped after `archivedAt`. Our own
 * messages and history from before the archive never qualify, and without an
 * archive moment there is nothing to compare against.
 */
export function revivesArchivedConversation(
  meta: Pick<ConversationMetadata, 'archivedAt'> | undefined,
  messages: readonly Pick<Message, 'isOutgoing' | 'timestamp'>[],
): boolean {
  const since = timeOf(meta?.archivedAt)
  if (since === undefined) return false
  return messages.some((message) => {
    if (message.isOutgoing) return false
    const at = timeOf(message.timestamp)
    return at !== undefined && at > since
  })
}
