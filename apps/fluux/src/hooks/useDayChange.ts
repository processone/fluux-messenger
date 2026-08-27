import { useEffect } from 'react'
import {
  msUntilNextLocalMidnight,
  refreshCurrentDay,
  useCurrentDayStore,
} from '@/stores/currentDayStore'

/**
 * Subscribe the calling component to local day changes.
 *
 * Call it from any component that renders a relative date label ("Today",
 * "Yesterday") so the label is re-evaluated when the day rolls over instead of
 * staying frozen at whatever it was when the component last rendered.
 *
 * Returns nothing on purpose: the value is not useful to the caller, the
 * subscription is. The selector returns a primitive, so the component re-renders at
 * most once per day and never on unrelated store churn.
 */
export function useDayChange(): void {
  useCurrentDayStore((s) => s.dayKey)
}

/**
 * Arm the app-wide day-boundary watcher. Mount ONCE, near the root.
 *
 * Two triggers move the day forward, and both are needed:
 *
 * - Regaining focus, handled by `useWindowVisibility`, which already listens to
 *   `visibilitychange` and `focus` and calls `refreshCurrentDay()`. This covers the
 *   common report: the window sat minimised or behind another app all night and the
 *   user comes back to it the next morning.
 * - This timer, which covers the case focus cannot: a window left visible AND focused
 *   through midnight — a desktop client parked on a second screen — never fires a
 *   focus event, so its labels would freeze with no way back.
 *
 * It is a single app-wide timeout aimed at the next local midnight, not an interval:
 * it produces no work and no render until the day actually changes. The delay is
 * recomputed from the wall clock on every re-arm, so it cannot drift and follows DST
 * and timezone changes. A small margin past midnight absorbs early wake-ups.
 */
export function useDayBoundaryWatcher(): void {
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined

    const arm = () => {
      timer = setTimeout(() => {
        refreshCurrentDay()
        arm()
      }, msUntilNextLocalMidnight() + 250)
    }

    // A suspended machine can wake with the timer long overdue; reconcile first.
    refreshCurrentDay()
    arm()

    return () => {
      if (timer) clearTimeout(timer)
    }
  }, [])
}
