/**
 * The rows an idle conversation's short resident tail has pushed out, kept ONLY so a repeated live
 * delivery of one of them is still recognised as a duplicate.
 *
 * Capping the idle window at a short tail bounds the work done per arrival, but the window was
 * also what made a second delivery of an old message (an echo, a carbon, a replay after a
 * reconnect) a no-op instead of another unread. Rows leave the display tail into this ledger
 * instead of being forgotten, looked up by identity key so each arrival costs a few map reads, and
 * the ledger is itself bounded to the resident window size. The caller applies its own
 * `sameMessage` rule to what {@link candidates} returns.
 *
 * The ledger starts over whenever the owner's resident array is empty (a fresh idle window).
 */
export interface IdleEvictedLedger<T> {
  remember(id: string, evicted: readonly T[]): void
  candidates(id: string, incoming: T): T[]
  forget(id: string): void
}

interface Entry<T> {
  queue: T[]
  byKey: Map<string, T[]>
}

export function createIdleEvictedLedger<T>(
  getKeys: (message: T) => string[],
  capacity: () => number
): IdleEvictedLedger<T> {
  const entries = new Map<string, Entry<T>>()

  const index = (queue: readonly T[]): Map<string, T[]> => {
    const byKey = new Map<string, T[]>()
    for (const message of queue) {
      for (const key of getKeys(message)) {
        const list = byKey.get(key)
        if (list) list.push(message)
        else byKey.set(key, [message])
      }
    }
    return byKey
  }

  return {
    remember(id, evicted) {
      if (evicted.length === 0) return
      const entry = entries.get(id) ?? { queue: [], byKey: new Map<string, T[]>() }
      entries.set(id, entry)
      entry.queue.push(...evicted)
      // Trim in batches (up to twice the capacity) so the index is rebuilt rarely.
      if (entry.queue.length > 2 * capacity()) {
        entry.queue = entry.queue.slice(-capacity())
        entry.byKey = index(entry.queue)
        return
      }
      for (const message of evicted) {
        for (const key of getKeys(message)) {
          const list = entry.byKey.get(key)
          if (list) list.push(message)
          else entry.byKey.set(key, [message])
        }
      }
    },
    candidates(id, incoming) {
      const entry = entries.get(id)
      if (!entry) return []
      const found = new Set<T>()
      for (const key of getKeys(incoming)) for (const message of entry.byKey.get(key) ?? []) found.add(message)
      return [...found]
    },
    forget(id) {
      entries.delete(id)
    },
  }
}
