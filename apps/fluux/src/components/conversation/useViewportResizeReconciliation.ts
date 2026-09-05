/**
 * Owns viewport/scroller resize observation and frame coalescing for the live message list.
 *
 * This hook only emits semantic live-edge reconciliation requests. It never writes pixels and
 * owns no positioning generation; the positioning controller and its browser adapters remain the
 * sole live-list position authority.
 */

import { useEffect, useRef } from 'react'
import { AT_BOTTOM_THRESHOLD } from '@/utils/scrollStateManager'
import { signalAnomaly } from '@/utils/anomalySignal'
import { hasAnomalyObservationHandler, observeAnomaly } from '@/utils/anomalyObservation'
import { BOTTOM_PIN_TOLERANCE } from './liveEdgeBrowserAdapter'
import { createResizeLoopMonitor, resizeLoopSignal } from './resizeLoopMonitor'

export type ViewportResizeReconciliationTrigger =
  | 'viewport-resize'
  | 'container-shrink'
  | 'container-growth'
  | 'width-change'

export interface ViewportResizeReconciliationPorts {
  getScroller: () => HTMLDivElement | null
  isAtBottom: () => boolean
  reconcileLiveEdge: (
    trigger: ViewportResizeReconciliationTrigger,
    rearmEligibleFromGeometry: boolean,
  ) => boolean
}

export interface UseViewportResizeReconciliationInput {
  ports: ViewportResizeReconciliationPorts
  conversationId: string
  staticMode: boolean
}

const distanceFromBottom = (scroller: HTMLElement) =>
  scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight

export function useViewportResizeReconciliation({
  ports,
  conversationId,
  staticMode,
}: UseViewportResizeReconciliationInput): void {
  const portsRef = useRef(ports)
  portsRef.current = ports

  // The on-screen keyboard can resize the layout or visual viewport without changing content
  // height. Re-open live-edge reconciliation only while the reader is following the bottom.
  useEffect(() => {
    if (staticMode) return
    const onViewportResize = () => {
      const active = portsRef.current
      const atBottom = active.isAtBottom()
      if (atBottom) active.reconcileLiveEdge('viewport-resize', atBottom)
    }
    window.addEventListener('resize', onViewportResize)
    const visualViewport = window.visualViewport
    visualViewport?.addEventListener('resize', onViewportResize)
    return () => {
      window.removeEventListener('resize', onViewportResize)
      visualViewport?.removeEventListener('resize', onViewportResize)
    }
  }, [staticMode])

  // Composer height and conversation-column width changes arrive through ResizeObserver. Coalesce
  // every burst into one frame so reconciliation never runs inside the observer delivery cycle.
  useEffect(() => {
    const scroller = portsRef.current.getScroller()
    if (!scroller) return

    let lastHeight: number | null = null
    let pendingHeight: number | null = null
    let lastWidth: number | null = null
    let pendingWidth: number | null = null
    let scheduled = false
    let rafId: number | null = null
    let monitor: ReturnType<typeof createResizeLoopMonitor> | null = null

    const runCorrection = () => {
      scheduled = false
      rafId = null
      const newHeight = pendingHeight
      const newWidth = pendingWidth
      pendingHeight = null
      pendingWidth = null
      if (newHeight === null) return

      if (lastHeight === null) {
        lastHeight = newHeight
        lastWidth = newWidth
        return
      }

      const active = portsRef.current
      const liveScroller = active.getScroller()
      const shrunk = lastHeight - newHeight
      if (shrunk > 0 && liveScroller) {
        const scrollHeight = liveScroller.scrollHeight
        const distance = scrollHeight - liveScroller.scrollTop - liveScroller.clientHeight
        const wasNear = distance <= shrunk + AT_BOTTOM_THRESHOLD
        const shouldRepin = wasNear && distance > BOTTOM_PIN_TOLERANCE
        const repin = shouldRepin
          ? active.reconcileLiveEdge('container-shrink', wasNear)
            ? 'ran'
            : 'refused'
          : null
        // Reported as the measurement it already is, never as a verdict: one frame short
        // of the bottom after a shrink is ordinary, and only a clock can tell that from a
        // shortfall nothing came back for. Unlike a pin settling short, this direction has
        // no run to report itself — in the failing case none starts — so the fact has to
        // cross here. Reuses `distance` and `shrunk`, adding no layout read.
        if (hasAnomalyObservationHandler()) {
          observeAnomaly({
            kind: 'scrollport-shrank',
            conversationId,
            shrunkPx: shrunk,
            distFromBottom: distance,
            scrollHeight,
            repin,
            tolerancePx: BOTTOM_PIN_TOLERANCE,
          })
        }
      } else if (
        newWidth !== null &&
        lastWidth !== null &&
        newWidth !== lastWidth &&
        liveScroller &&
        active.isAtBottom()
      ) {
        active.reconcileLiveEdge('width-change', true)
      } else if (shrunk < 0 && liveScroller) {
        // The container GREW (the composer shrank back). Extra scroller height can only bring a
        // follower closer to the bottom: the browser clamps scrollTop as the growth uncovers the
        // tail. So a view left short of the bottom across this growth is content that grew
        // underneath in the same commit and that nothing absorbed — not a position the reader chose.
        //
        // Post-resize geometry cannot tell a follower from a reader who scrolled up: the clamp fires
        // a scroll event whose handler reads a DOM already carrying that growth, so both the
        // measured distance and the at-bottom latch report "scrolled away". Re-open the EXISTING
        // follow only (`rearmEligibleFromGeometry: false`); a reader who left the live edge has no
        // live-edge owner to re-open and is untouched.
        if (distanceFromBottom(liveScroller) > BOTTOM_PIN_TOLERANCE) {
          active.reconcileLiveEdge('container-growth', false)
        }
      }

      lastHeight = newHeight
      lastWidth = newWidth
    }

    const observer = new ResizeObserver((entries) => {
      if (!monitor) monitor = createResizeLoopMonitor()
      const warning = monitor.record(performance.now())
      if (warning) {
        console.warn(warning.message)
        if (__FLUUX_ANOMALY__) signalAnomaly(resizeLoopSignal(warning))
      }

      pendingHeight = entries[0].contentRect.height
      pendingWidth = entries[0].contentRect.width
      if (!scheduled) {
        scheduled = true
        rafId = requestAnimationFrame(runCorrection)
      }
    })

    observer.observe(scroller)
    return () => {
      observer.disconnect()
      if (rafId !== null) cancelAnimationFrame(rafId)
    }
  }, [conversationId])
}
