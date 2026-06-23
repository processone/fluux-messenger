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
import { createRenderCostProbe, type RenderCostProbe } from '@/utils/renderCostProbe'

// Timestamp (performance.now) of the last page visibility transition. When a
// render's measurement window contains one, the render→commit gap is wall-clock
// idle (tab hidden, or the laptop slept mid-render) rather than render work —
// producing absurd "render cost" values (e.g. ~18min for 50 rows after an OS
// sleep). We discard those, mirroring stallSentinel's document.hidden guard.
let lastVisibilityChangeAt = Number.NEGATIVE_INFINITY
let visibilityTrackingStarted = false
function ensureVisibilityTracking(): void {
  if (visibilityTrackingStarted || typeof document === 'undefined') return
  visibilityTrackingStarted = true
  document.addEventListener('visibilitychange', () => {
    lastVisibilityChangeAt = performance.now()
  })
}

export function useRenderCostProbe(label: string, getContext: () => string): void {
  ensureVisibilityTracking()

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

      // A visibility transition at/after renderStart means this window spanned a
      // hidden/sleep period — the measured cost is idle wall clock, not render work.
      const spannedHidden = lastVisibilityChangeAt >= renderStart || document.hidden

      if (probeRef.current?.record(totalMs, painted, spannedHidden)) {
        console.warn(
          `[RenderCostProbe] ${label} render cost ~${Math.round(totalMs)}ms ` +
          `(react=${Math.round(reactMs)}ms, layoutPaint=${Math.round(layoutPaintMs)}ms, ${getContext()})`
        )
      }
    })
  })
}
