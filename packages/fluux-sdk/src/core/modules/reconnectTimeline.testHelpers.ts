/**
 * Timeline test helper for race condition tests.
 *
 * Allows writing time-sensitive tests as a sequence of actions at absolute
 * timestamps. The helper sorts entries, advances vitest fake timers between
 * steps, and flushes microtasks after each action.
 *
 * @example
 * ```ts
 * await timeline()
 *   .at(0, () => client._emit('disconnect', { clean: false }))
 *   .at(1000, () => expect(getState()).toEqual({ reconnecting: 'attempting' }))
 *   .at(31000, () => staleClient._emit('online'))
 *   .at(31000, () => expect(getState()).not.toEqual({ connected: 'healthy' }))
 *   .run()
 * ```
 */
import { vi } from 'vitest'

interface TimelineEntry {
  time: number
  action: () => void | Promise<void>
  label?: string
}

export function timeline() {
  const entries: TimelineEntry[] = []
  let currentTime = 0

  const builder = {
    /** Schedule an action at an absolute timestamp (ms from start). */
    at(time: number, action: () => void | Promise<void>, label?: string) {
      entries.push({ time, action, label })
      return builder
    },

    /** Execute the timeline: advance fake timers between steps, flush microtasks. */
    async run() {
      // Sort by time, preserving insertion order for same-time entries
      entries.sort((a, b) => a.time - b.time)

      for (const entry of entries) {
        const delta = entry.time - currentTime
        if (delta > 0) {
          await vi.advanceTimersByTimeAsync(delta)
          currentTime = entry.time
        }
        // Flush microtasks before running the action
        await vi.advanceTimersByTimeAsync(0)
        await entry.action()
      }
    },
  }

  return builder
}
