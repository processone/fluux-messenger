type ConversationKind = 'chat' | 'room'

const versions: Record<ConversationKind, Map<string, number>> = {
  chat: new Map(),
  room: new Map(),
}
let sequence = 0

// SDK message-event bindings advance these tokens at store acceptance, including
// queued room arrivals after reconciliation. Cache hydration, read pointers and
// viewport work cannot manufacture ingress progress. Existing store subscriptions deliver the
// snapshot to active hooks without adding a separate render per arrival.
export function recordMessageIngress(kind: ConversationKind, id: string): void {
  versions[kind].set(id, ++sequence)
}

export function getMessageIngressVersion(kind: ConversationKind, id: string | null): number {
  return id ? versions[kind].get(id) ?? 0 : 0
}

export function clearMessageIngressVersions(kind: ConversationKind, id?: string): void {
  if (id === undefined) versions[kind].clear()
  else versions[kind].delete(id)
}
