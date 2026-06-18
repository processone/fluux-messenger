/**
 * Per-id notification coalescer (pure, no timers).
 *
 * Used by useDesktopNotifications to collapse a reconnect "catch-up" burst into
 * one notification per conversation. The owning hook controls timing (open the
 * window on reconnect, flush after a fixed delay); this buffer only decides what
 * to keep. While open, the latest payload per id wins; while closed, callers
 * dispatch immediately.
 */
export interface CoalescedEntry<T> {
  id: string
  payload: T
}

export interface NotificationCoalescer<T> {
  /** Whether the coalescing window is currently open. */
  isOpen(): boolean
  /** Open the window; subsequent add() calls buffer instead of returning false. */
  open(): void
  /** Buffer the latest payload for id. Returns true if buffered, false if window closed. */
  add(id: string, payload: T): boolean
  /** Return one entry per id (latest payload, insertion order), clear, and close. */
  flush(): CoalescedEntry<T>[]
  /** Clear the buffer and close without returning entries. */
  drop(): void
}

export function createNotificationCoalescer<T>(): NotificationCoalescer<T> {
  let open = false
  const buffer = new Map<string, T>()

  return {
    isOpen: () => open,
    open: () => {
      open = true
    },
    add: (id, payload) => {
      if (!open) return false
      buffer.set(id, payload)
      return true
    },
    flush: () => {
      const entries = Array.from(buffer, ([id, payload]) => ({ id, payload }))
      buffer.clear()
      open = false
      return entries
    },
    drop: () => {
      buffer.clear()
      open = false
    },
  }
}
