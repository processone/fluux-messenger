import type { Message } from '../core/types/chat'

/**
 * The seam between the message cache and the search index.
 *
 * The cache rekeys a chat row when it gains or loses an archive identity, and the
 * search index keys its documents by that same key. The index imports the cache,
 * so the cache reaches the index through this observer instead of an import.
 */
export type ChatIdentityObserver = (previous: Message[], current: Message, scopeJid: string | null) => Promise<void>

let observer: ChatIdentityObserver | undefined

export function setChatIdentityObserver(next: ChatIdentityObserver): void {
  observer = next
}

export async function notifyChatIdentityChange(
  previous: Message[],
  current: Message,
  scopeJid: string | null,
): Promise<void> {
  await observer?.(previous, current, scopeJid)
}
