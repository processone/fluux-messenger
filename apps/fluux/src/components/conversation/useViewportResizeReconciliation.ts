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
  ) => void
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
        const distance = distanceFromBottom(liveScroller)
        const wasNear = distance <= shrunk + AT_BOTTOM_THRESHOLD
        if (wasNear && distance > BOTTOM_PIN_TOLERANCE) {
          active.reconcileLiveEdge('container-shrink', wasNear)
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
