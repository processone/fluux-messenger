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
 * The `[Estimate]` trace is on its OWN flag — it logs per-row, per-measure (hundreds of lines per
 * scroll), which buries the `[Scroll]`/`[ScrollStateManager]` decision trace. So `__fluuxScrollDebug`
 * (or `fluux:scroll-debug`) gives a clean decision trace; enable this separately only when actually
 * auditing estimate accuracy: `__fluuxEstimateDebug(true)`, or `localStorage 'fluux:estimate-debug'`.
 */
export function isEstimateDebugEnabled(): boolean {
  if (typeof window === 'undefined') return false
  try {
    if ((window as Window & { __fluuxEstimateDebugOn?: boolean }).__fluuxEstimateDebugOn) return true
    return window.localStorage?.getItem('fluux:estimate-debug') === '1'
  } catch {
    return false
  }
}

/**
 * Console log tagged `[Estimate]`, gated on the SEPARATE estimate-debug flag (see
 * {@link isEstimateDebugEnabled}) so it doesn't flood the scroll-decision trace. No-op (and zero arg
 * cost at call sites that pre-check the flag) when off.
 */
export function estimateDebugLog(...args: unknown[]): void {
  if (!isEstimateDebugEnabled()) return
  console.log('[Estimate]', ...args)
}

/**
 * Console log gated on the same scroll-debug flag, tagged `[Nav]`. Logs SCREEN-level navigation
 * transitions (ChatLayout mounting/unmounting ChatView/RoomView/SettingsView, active conversation
 * /room id changes). The in-conversation `[Scroll]` and `[ScrollStateManager]` traces only see a
 * `conversationId` prop change or a mount/unmount in isolation — they cannot tell whether the cause
 * was a DM↔DM switch, a trip through Settings (full unmount + remount), or a DM↔Room swap. This tag
 * makes that boundary visible so a wrong scroll-restore can be correlated to the navigation that
 * triggered it. Read the trace top-to-bottom: `[Nav]` → `[ScrollStateManager]` → `[Scroll]`.
 */
export function navDebugLog(action: string, data?: Record<string, unknown>): void {
  if (!isScrollDebugEnabled()) return
  console.log(`[Nav] ${action}`, data ?? '')
}
