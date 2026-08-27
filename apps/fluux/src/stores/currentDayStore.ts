import { create } from 'zustand'

/**
 * Store holding the current LOCAL calendar day.
 *
 * Relative labels ("Today", "Yesterday") are computed by the pure formatters in
 * `@/utils/dateFormat` at render time. Nothing re-evaluates them afterwards, so a
 * window left open across midnight keeps showing yesterday's answer: what said
 * "Today" still says "Today" the next morning.
 *
 * This store is the single re-render trigger for that transition. It holds only the
 * `yyyy-MM-dd` of the local day; components that render a relative label subscribe to
 * it through `useDayChange()`. The value changes at most once per day, so subscribing
 * costs nothing in steady state — there is no interval and no per-render clock read.
 *
 * The formatters stay pure: the day lives here, not in `dateFormat.ts`.
 */

/** The local calendar day as `yyyy-MM-dd`. Local, never UTC. */
export function localDayKey(now: Date = new Date()): string {
  const year = now.getFullYear()
  const month = String(now.getMonth() + 1).padStart(2, '0')
  const day = String(now.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

/**
 * Milliseconds from `now` until the next local midnight.
 *
 * Computed fresh from the current wall clock rather than by adding 24h, so a timer
 * armed with it cannot drift and stays correct across DST transitions and timezone
 * changes: `new Date(y, m, d + 1)` is normalised by the runtime to real local
 * midnight, which is 23h or 25h away on a DST boundary.
 */
export function msUntilNextLocalMidnight(now: Date = new Date()): number {
  const nextMidnight = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 0, 0, 0, 0)
  return Math.max(1, nextMidnight.getTime() - now.getTime())
}

interface CurrentDayState {
  /** Local calendar day as `yyyy-MM-dd`. */
  dayKey: string
  /** Re-read the wall clock; updates state only when the local day actually changed. */
  refresh: () => void
}

export const useCurrentDayStore = create<CurrentDayState>((set, get) => ({
  dayKey: localDayKey(),

  refresh: () => {
    const next = localDayKey()
    if (next !== get().dayKey) {
      set({ dayKey: next })
    }
  },
}))

/**
 * Re-read the local day outside React. A no-op when the day has not changed, so it is
 * safe to call from a hot event handler.
 */
export function refreshCurrentDay(): void {
  useCurrentDayStore.getState().refresh()
}
