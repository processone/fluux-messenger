export interface PendingEntityWriteToken {
  readonly value: symbol
}

export function createPendingEntityWrites() {
  const writes = new Map<string, Set<symbol>>()

  const begin = (entityId: string): PendingEntityWriteToken => {
    const value = Symbol(entityId)
    const pending = writes.get(entityId) ?? new Set<symbol>()
    pending.add(value)
    writes.set(entityId, pending)
    return { value }
  }

  const finish = (entityId: string, token: PendingEntityWriteToken): boolean => {
    const pending = writes.get(entityId)
    if (!pending?.delete(token.value)) return false
    if (pending.size === 0) writes.delete(entityId)
    return true
  }

  const has = (entityId: string): boolean => writes.has(entityId)
  const cancel = (entityId: string): void => { writes.delete(entityId) }
  const clear = (): void => { writes.clear() }

  return { begin, finish, has, cancel, clear }
}
