import type { Message } from '../core/types/chat'
import type { RoomMessage } from '../core/types/room'

/** A committed content change is a wake-up signal, never evidence of a new arrival. */
interface MessageCacheUpdate {
  kind: 'chat' | 'room'
  conversationId: string
  account: string | null
  target: Message | RoomMessage
}
const listeners = new Set<(event: MessageCacheUpdate) => void>()

export function subscribeMessageCacheUpdates(listener: (event: MessageCacheUpdate) => void): () => void {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

export function emitMessageCacheUpdate(event: MessageCacheUpdate): void {
  for (const listener of listeners) listener(event)
}
