/**
 * useRenderCostProbe — attribute a slow render to a component subtree.
 *
 * Brackets one commit of the calling component and its descendants and splits
 * the cost into React work vs browser layout/paint (see `renderCostProbe.ts`).
 * Logs a single rate-limited `console.warn` per cooldown when the total exceeds
 * the threshold; the Tauri console forwarder ships it to fluux.log.
 *
 * Timing model (all `performance.now()`):
 * - `renderStart` is read in the render body, before the subtree's children
 *   render (this hook is called near the top of the component).
 * - the `useLayoutEffect` fires after commit (DOM mutated, pre-paint):
 *   `react = layoutEffect − renderStart`.
 * - the `requestAnimationFrame` fires just before the next paint:
 *   `layoutPaint = rAF − layoutEffect`.
 *
 * Diagnostic only: never changes behaviour.
 */
import { useLayoutEffect, useRef } from 'react'
import { createRenderCostProbe, spansIdleWindow, type RenderCostProbe } from '@/utils/renderCostProbe'

// Timestamp (performance.now) of the last backgrounding transition — page
// visibility OR window focus. When a render's measurement window contains one
// (or the app is backgrounded at sample time), the render→commit gap is
// wall-clock idle (tab hidden, app switched away, or the laptop slept mid-render)
// rather than render work — producing absurd "render cost" values (e.g. ~18min
// for 50 rows after an OS sleep, or ~10s after an app switch). We discard those,
// mirroring stallSentinel's document.hidden guard.
//
// focus/blur matters because switching apps on desktop (Tauri/WebKit) blurs the
// window WITHOUT hiding the page: no visibilitychange fires and document.hidden
// stays false, yet the OS throttles/App-Naps the unfocused window. Tracking only
// visibilitychange would miss this — the common cause of bogus warnings.
let lastBackgroundBoundaryAt = Number.NEGATIVE_INFINITY
let backgroundTrackingStarted = false
function ensureBackgroundTracking(): void {
  if (backgroundTrackingStarted || typeof document === 'undefined') return
  backgroundTrackingStarted = true
  const mark = () => {
    lastBackgroundBoundaryAt = performance.now()
  }
  document.addEventListener('visibilitychange', mark)
  window.addEventListener('focus', mark)
  window.addEventListener('blur', mark)
}

export function useRenderCostProbe(label: string, getContext: () => string): void {
  ensureBackgroundTracking()

  // Read at render-body call time — before this component's children render.
  const renderStart = performance.now()

  // One probe instance per mounted component (rate-limit state lives here).
  const probeRef = useRef<RenderCostProbe | null>(null)
  if (probeRef.current === null) probeRef.current = createRenderCostProbe()

  useLayoutEffect(() => {
    const commitDone = performance.now()
    const reactMs = commitDone - renderStart

    requestAnimationFrame(() => {
      const painted = performance.now()
      const layoutPaintMs = painted - commitDone
      const totalMs = reactMs + layoutPaintMs

      // A backgrounding transition at/after renderStart — or being hidden/unfocused
      // at sample time — means this window spanned a hidden/blurred/sleep period:
      // the measured cost is idle wall clock, not render work.
      const spannedHidden = spansIdleWindow(renderStart, {
        lastBoundaryAt: lastBackgroundBoundaryAt,
        isHidden: document.hidden,
        hasFocus: typeof document.hasFocus === 'function' ? document.hasFocus() : true,
      })

      if (probeRef.current?.record(totalMs, painted, spannedHidden)) {
        console.warn(
          `[RenderCostProbe] ${label} render cost ~${Math.round(totalMs)}ms ` +
          `(react=${Math.round(reactMs)}ms, layoutPaint=${Math.round(layoutPaintMs)}ms, ${getContext()})`
        )
      }
    })
  })
}
