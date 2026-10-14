/**
 * An entity whose archive-backed unread count committed zero: its history is caught up to the
 * live edge and the read pointer covers every counted message, however the pointer got there
 * (this client, or a XEP-0490 marker from another one). Announced on every such commit, whether
 * or not the badge changed, so a consumer that missed the transition still converges.
 */
export interface SettledReadEvent {
  kind: 'chat' | 'room'
  conversationId: string
}
const listeners = new Set<(event: SettledReadEvent) => void>()

/** Observe entities whose unread count settled at zero. */
export function subscribeSettledReads(listener: (event: SettledReadEvent) => void): () => void {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}
export function emitSettledRead(event: SettledReadEvent): void {
  for (const listener of listeners) listener(event)
}
