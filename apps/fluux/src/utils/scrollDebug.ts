/**
 * Shared read of the scroll-debug flag — the SAME flag as useMessageListScroll's `[Scroll]` trace
 * and scrollStateManager: runtime toggle `__fluuxScrollDebug(true)`, or persist with
 * `localStorage.setItem('fluux:scroll-debug', '1')`. Lets the height-estimator path log inline with
 * the scroll trace so estimate accuracy and cache behavior show up alongside the scroll decisions.
 */
export function isScrollDebugEnabled(): boolean {
  if (typeof window === 'undefined') return false
  try {
    if ((window as Window & { __fluuxScrollDebugOn?: boolean }).__fluuxScrollDebugOn) return true
    return window.localStorage?.getItem('fluux:scroll-debug') === '1'
  } catch {
    return false
  }
}

/**
 * Console log gated on the scroll-debug flag, tagged `[Estimate]` so the estimator/sampler/cache
 * lines are filterable within the shared scroll trace. No-op (and zero arg cost at call sites that
 * pre-check {@link isScrollDebugEnabled}) when the flag is off.
 */
export function estimateDebugLog(...args: unknown[]): void {
  if (!isScrollDebugEnabled()) return
  console.log('[Estimate]', ...args)
}
