/**
 * Per-key latest-wins coalescing buffer (pure, owns NO timers).
 *
 * The caller controls timing (open the window, flush/drop on its own clock or
 * teardown). While open, the latest value per key wins; while closed, add()
 * returns false so callers can dispatch immediately.
 *
 * Promoted from apps/fluux notificationCoalescer so SDK side effects (e.g. the
 * MDS read-position publisher) can buffer per-conversation publishes. Timer and
 * flush-vs-drop teardown policy deliberately stay at each call site — they
 * diverge per consumer and must remain explicit.
 */
export interface CoalescedEntry<K, V> {
  key: K
  value: V
}

export interface KeyedCoalescer<K, V> {
  /** Whether the coalescing window is currently open. */
  isOpen(): boolean
  /** Open the window; subsequent add() calls buffer instead of returning false. */
  open(): void
  /** Buffer the latest value for key. Returns true if buffered, false if window closed. */
  add(key: K, value: V): boolean
  /** Return one entry per key (latest value, insertion order), clear, and close. */
  flush(): CoalescedEntry<K, V>[]
  /** Clear the buffer and close without returning entries. */
  drop(): void
  /** Number of distinct keys currently buffered. */
  size(): number
}

export function createKeyedCoalescer<K = string, V = unknown>(): KeyedCoalescer<K, V> {
  let open = false
  const buffer = new Map<K, V>()

  return {
    isOpen: () => open,
    open: () => {
      open = true
    },
    add: (key, value) => {
      if (!open) return false
      buffer.set(key, value)
      return true
    },
    flush: () => {
      const entries = Array.from(buffer, ([key, value]) => ({ key, value }))
      buffer.clear()
      open = false
      return entries
    },
    drop: () => {
      buffer.clear()
      open = false
    },
    size: () => buffer.size,
  }
}
