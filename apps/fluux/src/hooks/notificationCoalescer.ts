/**
 * Per-id notification coalescer (pure, owns NO timers).
 *
 * A generic latest-wins-per-key buffer for batching desktop notifications:
 * while the window is open, the latest value per id wins; while closed, add()
 * returns false so callers can dispatch immediately. Timer and flush-vs-drop
 * teardown stay at the call site (useDesktopNotifications).
 *
 * App-owned rather than imported from the SDK: it is a generic, non-XMPP
 * helper, so it is deliberately not part of the SDK product API. (The SDK keeps
 * its own internal copy for MDS side effects.)
 */

export interface CoalescedEntry<T> {
  key: string
  value: T
}

export interface NotificationCoalescer<T> {
  /** Whether the coalescing window is currently open. */
  isOpen(): boolean
  /** Open the window; subsequent add() calls buffer instead of returning false. */
  open(): void
  /** Buffer the latest value for id. Returns true if buffered, false if window closed. */
  add(key: string, value: T): boolean
  /** Return one entry per id (latest value, insertion order), clear, and close. */
  flush(): CoalescedEntry<T>[]
  /** Clear the buffer and close without returning entries. */
  drop(): void
  /** Drop any buffered value for id. Returns true if an entry was removed. */
  delete(key: string): boolean
  /** Number of distinct ids currently buffered. */
  size(): number
}

export function createNotificationCoalescer<T>(): NotificationCoalescer<T> {
  let open = false
  const buffer = new Map<string, T>()

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
    delete: (key) => buffer.delete(key),
    size: () => buffer.size,
  }
}
