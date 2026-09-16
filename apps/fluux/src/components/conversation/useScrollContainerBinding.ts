/**
 * useScrollContainerBinding - callback refs for the scroller and content wrapper
 *
 * Owns everything that must be wired to those two DOM nodes: the genuine-user-input listeners on
 * the scroller, and the content ResizeObserver for NON-virtualized layout changes.
 *
 * It owns no positioning generation. Reconciliation ports submit layout changes to the caller's
 * position owner; this binding never writes pixels.
 *
 * Two constraints shape the implementation:
 *
 * 1. ATTACH ORDER: React attaches refs child-first within a commit. When the list mounts WITH
 *    messages already present, the content-wrapper ref runs before the scroller ref is set.
 *    Observer setup is therefore late-bound: both setters call `trySetupContentObserver()`, and
 *    whichever attaches last completes the setup.
 *
 * 2. IDENTITY STABILITY: both setters are created once (lazy ref), NOT re-created per render. An
 *    unstable callback ref makes React detach (null) + reattach it on EVERY render, tearing down
 *    and recreating the observer each time — a forced-reflow amplifier in busy rooms. Per-render
 *    values are read through `ports`, never closed over.
 */

import { useRef } from 'react'
import type { MessageVirtualizer } from './messageVirtualizer'
import type { UserScrollInput } from './positioningController'
import type { ViewportGeometry } from './viewportSession'
import { createResizeLoopMonitor, resizeLoopSignal } from './resizeLoopMonitor'
import {
  createSlowCorrectionMonitor,
  slowCorrectionSignal,
} from './slowCorrectionMonitor'
import { signalAnomaly } from '@/utils/anomalySignal'

export interface ScrollContainerBindingPorts {
  /** Publish the attached scroller: the caller's own ref plus any external one it mirrors. */
  setScroller: (el: HTMLDivElement | null) => void
  getScroller: () => HTMLDivElement | null
  getVirtualizer: () => MessageVirtualizer | undefined
  isStaticMode: () => boolean
  isAtBottom: () => boolean
  getActiveConversationId: () => string
  /** Conversation shown in the slow-correction warning; the passive latest-value one. */
  getLoggedConversationId: () => string
  isDirectionalHistoryPending: (conversationId: string) => boolean
  isMediaLoadBatchActive: () => boolean
  reconcileLiveEdge: (trigger: string, rearmEligibleFromGeometry: boolean) => void
  reconcileMessageTargetAfterResize: () => boolean
  reconcileContentLayout?: () => boolean
  recordUserInput: (conversationId: string, at: number) => void
  observeUserInput: (conversationId: string, input: UserScrollInput) => void
  observeUserInputEnd: (conversationId: string, geometry: ViewportGeometry) => void
  log: (action: string, data?: Record<string, unknown>) => void
}

export interface ScrollContainerBinding {
  setScrollContainerRef: (el: HTMLDivElement | null) => void
  setContentRef: (el: HTMLDivElement | null) => void
  /** Unmount: stop observing and drop any coalesced correction frame. */
  teardownContentObserver: () => void
  /** Unmount: release the genuine-user-input listeners from the attached scroller. */
  detachUserInputListeners: () => void
  resetPendingInput: () => void
}

export function readUserScrollInput(scroller: HTMLElement, deltaY = 0): UserScrollInput {
  return {
    geometry: { top: scroller.scrollTop, height: scroller.scrollHeight, client: scroller.clientHeight },
    deltaY,
  }
}

export function useScrollContainerBinding(
  ports: ScrollContainerBindingPorts,
): ScrollContainerBinding {
  const portsRef = useRef(ports)
  portsRef.current = ports

  const contentRef = useRef<HTMLDivElement | null>(null)
  const contentObserverRef = useRef<ResizeObserver | null>(null)
  const correctionRafRef = useRef<number | null>(null)
  // Diagnostic-only monitor for a runaway observer fire rate.
  const resizeMonitorRef = useRef<ReturnType<typeof createResizeLoopMonitor> | null>(null)
  // Diagnostic-only monitor for SLOW corrections (reflow cost, not fire rate).
  const slowCorrectionMonitorRef =
    useRef<ReturnType<typeof createSlowCorrectionMonitor> | null>(null)
  const userInputCleanupRef = useRef<(() => void) | null>(null)

  const resetPendingInputRef = useRef<(() => void) | null>(null)

  const bindingRef = useRef<ScrollContainerBinding | null>(null)

  if (bindingRef.current === null) {
    const teardownContentObserver = () => {
      if (contentObserverRef.current) {
        contentObserverRef.current.disconnect()
        contentObserverRef.current = null
      }
      if (correctionRafRef.current !== null) {
        cancelAnimationFrame(correctionRafRef.current)
        correctionRafRef.current = null
      }
    }

    const detachUserInputListeners = () => {
      userInputCleanupRef.current?.()
      userInputCleanupRef.current = null
      resetPendingInputRef.current = null
    }

    const trySetupContentObserver = () => {
      const scroller = portsRef.current.getScroller()
      const element = contentRef.current
      if (!scroller || !element || contentObserverRef.current) return

      // Conversation entry owns initial bottom placement through the controller's live-edge
      // executor. In particular, its non-virtualized switch path retains the historical immediate
      // plus deferred repair, so this observer must not issue a second pair of mount-time writes.

      // Set up content ResizeObserver
      let lastHeight = scroller.scrollHeight

      // The actual measure + scroll-correction. Run at most once per frame via
      // the rAF-coalescing in the observer callback below.
      const runCorrection = () => {
        correctionRafRef.current = null
        const currentScroller = portsRef.current.getScroller()
        if (!currentScroller) return

        // Time the whole correction (including the skip paths — the
        // scrollHeight read below is the reflow that costs, whatever branch
        // follows). The frequency monitor in the observer callback cannot see
        // this failure mode: slow corrections fire only a few times a second.
        const correctionStart = performance.now()
        try {
          runCorrectionBody(currentScroller)
        } finally {
          const correctionEnd = performance.now()
          if (!slowCorrectionMonitorRef.current) {
            slowCorrectionMonitorRef.current = createSlowCorrectionMonitor()
          }
          const slow = slowCorrectionMonitorRef.current.record(
            correctionEnd - correctionStart,
            correctionEnd,
          )
          if (slow) {
            // Context reads are warn-path only (rate-limited): querySelectorAll
            // over the backlog is not free.
            const rows = currentScroller.querySelectorAll('.message-row').length
            console.warn(
              `[SlowScrollCorrection] scroll correction took ${Math.round(correctionEnd - correctionStart)}ms ` +
              `(rows=${rows}, scrollHeight=${currentScroller.scrollHeight}, ` +
              `conversation=${portsRef.current.getLoggedConversationId()}) — ` +
              `reflow cost scales with the rendered backlog.`
            )
            if (__FLUUX_ANOMALY__) {
              signalAnomaly(
                slowCorrectionSignal(slow, Math.round(correctionEnd - correctionStart), rows),
              )
            }
          }
        }
      }

      const runCorrectionBody = (currentScroller: HTMLDivElement) => {
        const newHeight = currentScroller.scrollHeight

        // When virtualized, the content wrapper IS the @tanstack spacer, whose height
        // churns on every row measurement; a stick-to-bottom correction here feeds back
        // into the virtualizer and loops. Stick-to-bottom is handled by the new-message /
        // typing / reactions effects + the virtualizer instead.
        if (portsRef.current.getVirtualizer()) {
          lastHeight = newHeight
          return
        }

        const currentScrollTop = currentScroller.scrollTop

        // Skip during prepend that's actively in progress (not yet restored)
        if (
          portsRef.current.isDirectionalHistoryPending(
            portsRef.current.getActiveConversationId(),
          )
        ) {
          portsRef.current.log('RESIZE SKIP (prepend in progress)', {
            newHeight,
            lastHeight,
            currentScrollTop,
          })
          lastHeight = newHeight
          return
        }

        if (newHeight !== lastHeight && portsRef.current.reconcileContentLayout?.()) {
          lastHeight = newHeight
          return
        }

        if (
          newHeight !== lastHeight && !portsRef.current.isStaticMode() &&
          portsRef.current.reconcileMessageTargetAfterResize()
        ) {
          lastHeight = newHeight
          return
        }

        // Skip during media load batch - let the debounced handler manage it
        if (portsRef.current.isMediaLoadBatchActive()) {
          portsRef.current.log('RESIZE SKIP (media load batch in progress)', {
            newHeight,
            lastHeight,
            currentScrollTop,
          })
          lastHeight = newHeight
          return
        }

        const staticMode = portsRef.current.isStaticMode()
        const atBottom = portsRef.current.isAtBottom()

        // Content grew and we were at bottom -> stay at bottom. Re-open the current live-edge
        // generation so the controller remains the only owner even on the non-virtualized path.
        if (newHeight > lastHeight && atBottom && !staticMode) {
          portsRef.current.log('RESIZE SCROLL TO BOTTOM', {
            newHeight,
            lastHeight,
            isAtBottom: atBottom,
            scrollTopBefore: currentScrollTop,
          })
          portsRef.current.reconcileLiveEdge('content-growth', atBottom)
        } else if (newHeight !== lastHeight) {
          portsRef.current.log('RESIZE NO SCROLL', {
            newHeight,
            lastHeight,
            isAtBottom: atBottom,
            currentScrollTop,
          })
        }

        lastHeight = newHeight
      }

      const observer = new ResizeObserver(() => {
        // When virtualized, skip entirely: the wrapper is the @tanstack spacer whose
        // height churns on every row measurement, and correcting scroll here loops back
        // into the virtualizer (re-measure → spacer change → RO → scroll → re-render).
        if (portsRef.current.getVirtualizer()) return
        // Diagnostic only: surface a runaway fire rate. WebKitGTK can oscillate
        // a <video controls> height continuously, firing this hundreds of times
        // a second — a pure main-thread loop the React render-loop detector
        // can't see. Log-rate-limited; never disconnects.
        if (!resizeMonitorRef.current) resizeMonitorRef.current = createResizeLoopMonitor()
        const warning = resizeMonitorRef.current.record(performance.now())
        if (warning) {
          console.warn(warning.message)
          if (__FLUUX_ANOMALY__) signalAnomaly(resizeLoopSignal(warning))
        }

        // Coalesce the measure + correction into a single rAF no matter how many
        // times the observer fires this frame. This breaks the read-scrollHeight
        // -> write-scrollTop -> reflow -> re-fire feedback and caps the expensive
        // work to once per frame.
        if (correctionRafRef.current === null) {
          correctionRafRef.current = requestAnimationFrame(runCorrection)
        }
      })

      observer.observe(element)
      contentObserverRef.current = observer
    }

    bindingRef.current = {
      setScrollContainerRef: (el: HTMLDivElement | null) => {
        portsRef.current.setScroller(el)
        // Native user-input listeners: mark a GENUINE user scroll so the viewport session's save
        // gate opens. wheel covers mouse/trackpad, touchstart covers
        // mobile, keydown covers PageUp/Down/arrows/Space when the list is focused. These are
        // distinct from media/measurement-driven scroll events, which must NOT open the gate.
        detachUserInputListeners()
        if (el) {
          let wheelEndRaf: number | null = null
          let wheelPending = false
          let touchPending = false
          let touchPoint: { id: number; y: number } | null = null
          let scrollbar: { id: number; y: number } | null = null
          const pressedKeys = new Set<string>()
          const resetPendingInput = () => {
            wheelPending = false
            touchPending = false
            touchPoint = null
            scrollbar = null
            pressedKeys.clear()
            if (wheelEndRaf !== null) cancelAnimationFrame(wheelEndRaf)
            wheelEndRaf = null
          }
          resetPendingInputRef.current = resetPendingInput
          const endUserInput = () => {
            if (wheelPending || touchPending || scrollbar || pressedKeys.size) return
            const active = portsRef.current
            active.observeUserInputEnd(active.getActiveConversationId(), readUserScrollInput(el).geometry)
          }
          const observeInput = (deltaY = 0, source?: 'gesture' | 'keyboard') => {
            const active = portsRef.current
            active.recordUserInput(active.getActiveConversationId(), Date.now())
            active.observeUserInput(active.getActiveConversationId(), { ...readUserScrollInput(el, deltaY), source })
          }
          const onWheel = (event: WheelEvent) => {
            wheelPending = true
            observeInput(event.deltaY)
            if (wheelEndRaf !== null) cancelAnimationFrame(wheelEndRaf)
            wheelEndRaf = requestAnimationFrame(() => {
              wheelEndRaf = null
              wheelPending = false
              endUserInput()
            })
          }
          const onTouchStart = (event: TouchEvent) => {
            touchPending = true
            const touch = event.touches[0]
            if (touch && !touchPoint) touchPoint = { id: touch.identifier, y: touch.clientY }
            observeInput()
          }
          const onTouchMove = (event: TouchEvent) => {
            if (!touchPoint) return
            const touch = Array.from(event.touches).find(touch => touch.identifier === touchPoint!.id)
            if (!touch) return
            const deltaY = touchPoint.y - touch.clientY
            touchPoint.y = touch.clientY
            if (deltaY !== 0) observeInput(deltaY, 'gesture')
          }
          const onTouchEnd = (event: TouchEvent) => {
            if (!touchPending) return
            if (event.touches.length > 0) {
              if (!touchPoint || !Array.from(event.touches).some(touch => touch.identifier === touchPoint!.id)) {
                const touch = event.touches[0]
                touchPoint = { id: touch.identifier, y: touch.clientY }
              }
              return
            }
            touchPending = false
            touchPoint = null
            endUserInput()
          }
          const onPointerMove = (event: PointerEvent) => {
            if (!scrollbar || scrollbar.id !== event.pointerId) return
            const deltaY = event.clientY - scrollbar.y
            scrollbar.y = event.clientY
            if (deltaY !== 0) observeInput(deltaY, 'gesture')
          }
          const onPointerEnd = (event: PointerEvent) => {
            if (!scrollbar || scrollbar.id !== event.pointerId) return
            scrollbar = null
            endUserInput()
          }
          const onKeyDown = (event: KeyboardEvent) => {
            const target = event.target
            if (
              event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey ||
              !(target instanceof HTMLElement) || !el.contains(target) ||
              target.closest('input, textarea, select, [contenteditable]:not([contenteditable="false"]), [role="textbox"]')
            ) return
            const upward = ['ArrowUp', 'PageUp', 'Home'].includes(event.key)
            const downward = ['ArrowDown', 'PageDown', 'End'].includes(event.key)
            const space = event.key === ' ' && !target.closest('button, a[href], [role="button"]')
            if (!upward && !downward && !space) return
            const upwardIntent = upward || (space && event.shiftKey)
            if (upwardIntent !== (event.eventPhase === Event.CAPTURING_PHASE)) return
            pressedKeys.add(event.code || event.key)
            observeInput(upwardIntent ? -1 : 1, 'keyboard')
          }
          const onBlur = () => {
            const pending = wheelPending || touchPending || scrollbar !== null || pressedKeys.size > 0
            resetPendingInput()
            if (pending) endUserInput()
          }
          const onKeyUp = (event: KeyboardEvent) => {
            if (pressedKeys.delete(event.code || event.key)) endUserInput()
          }
          const onPointerDown = (event: PointerEvent) => {
            if (event.button !== 0 || event.target !== el || el.scrollHeight <= el.clientHeight) return
            const rect = el.getBoundingClientRect()
            const top = rect.top + el.clientTop
            if (event.clientY < top || event.clientY >= top + el.clientHeight) return
            const style = getComputedStyle(el)
            const left = rect.left + el.clientLeft
            const right = left + el.clientWidth
            const borderLeft = parseFloat(style.borderLeftWidth) || 0
            const borderRight = parseFloat(style.borderRightWidth) || 0
            if (
              (event.clientX >= rect.left + borderLeft && event.clientX < left) ||
              (event.clientX >= right && event.clientX < rect.right - borderRight)
            ) {
              scrollbar = { id: event.pointerId, y: event.clientY }
              observeInput()
            }
          }
          el.addEventListener('pointerdown', onPointerDown, { passive: true })
          el.addEventListener('wheel', onWheel, { passive: true })
          el.addEventListener('touchstart', onTouchStart, { passive: true })
          el.addEventListener('touchmove', onTouchMove, { passive: true })
          window.addEventListener('pointermove', onPointerMove, { passive: true })
          window.addEventListener('keydown', onKeyDown, true)
          window.addEventListener('keydown', onKeyDown)
          window.addEventListener('blur', onBlur)
          window.addEventListener('pointerup', onPointerEnd)
          window.addEventListener('pointercancel', onPointerEnd)
          window.addEventListener('touchend', onTouchEnd)
          window.addEventListener('touchcancel', onTouchEnd)
          window.addEventListener('keyup', onKeyUp)
          userInputCleanupRef.current = () => {
            el.removeEventListener('pointerdown', onPointerDown)
            el.removeEventListener('wheel', onWheel)
            el.removeEventListener('touchstart', onTouchStart)
            el.removeEventListener('touchmove', onTouchMove)
            window.removeEventListener('pointermove', onPointerMove)
            window.removeEventListener('keydown', onKeyDown, true)
            window.removeEventListener('keydown', onKeyDown)
            window.removeEventListener('blur', onBlur)
            window.removeEventListener('pointerup', onPointerEnd)
            window.removeEventListener('pointercancel', onPointerEnd)
            window.removeEventListener('touchend', onTouchEnd)
            window.removeEventListener('touchcancel', onTouchEnd)
            window.removeEventListener('keyup', onKeyUp)
            resetPendingInput()
          }
          trySetupContentObserver()
        }
      },
      setContentRef: (element: HTMLDivElement | null) => {
        if (element === contentRef.current) return
        teardownContentObserver()
        contentRef.current = element
        if (element) trySetupContentObserver()
      },
      teardownContentObserver,
      detachUserInputListeners,
      resetPendingInput: () => resetPendingInputRef.current?.(),
    }
  }

  return bindingRef.current
}
