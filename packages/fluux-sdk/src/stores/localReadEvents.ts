import type { ReadPointer } from '../core/types/readState'

/** A read position confirmed by this client's reader, excluding remote MDS updates. */
export interface LocalReadEvent {
  account: string
  kind: 'chat' | 'room'
  conversationId: string
  pointer: ReadPointer
  /** Only the explicitly seen row, when a remote/read position already lies ahead. */
  messageOnly?: boolean
}
const listeners = new Map<(event: LocalReadEvent) => void, LocalReadEvent['kind'] | undefined>()

/** Resident read evidence only needs collecting while a consumer is attached. */
export function hasLocalReadListeners(kind: LocalReadEvent['kind']): boolean {
  for (const wanted of listeners.values()) {
    if (wanted === undefined || wanted === kind) return true
  }
  return false
}
/** Observe confirmed reads, optionally collecting evidence for only one conversation kind. */
export function subscribeLocalReads(listener: (event: LocalReadEvent) => void, kind?: LocalReadEvent['kind']): () => void {
  listeners.set(listener, kind)
  return () => { listeners.delete(listener) }
}
export function emitLocalRead(event: LocalReadEvent): void {
  for (const [listener, wanted] of listeners) {
    if (wanted === undefined || wanted === event.kind) listener(event)
  }
}
