import { useCallback, useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react'
import { platform } from '@/platform'

const EDGE_WIDTH = 28
const SWIPE_DISTANCE = 80
const SETTLE_MS = 220
const ENTER_MS = 320
// Longest wait for the navigation to hide a pane that has slid out.
const GONE_MS = 1000
const EASING = 'cubic-bezier(0.2, 0.8, 0.2, 1)'

export interface IosPaneEntry {
  /** The pane is on screen in the single-pane layout. */
  shown: boolean
  /** Whether showing the pane slides it in over the list. */
  animated: boolean
}

export interface IosPaneNavigation {
  /** The list is laid out underneath the pane while the pane moves. */
  preview: boolean
  /** Slides the pane out, then runs `navigate`. */
  back: (navigate: () => void) => void
}

type Slide = { kind: 'enter' | 'settle' | 'exit' | 'gone'; stop: () => void }

function isIosSinglePane(): boolean {
  return platform().shell === 'mobile' && platform().os === 'ios' && window.innerWidth < 768
}

function prefersReducedMotion(): boolean {
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches
}

/** Transitions `pane` to `transform` and calls `done` once; returns a function that cancels `done`. */
function slide(pane: HTMLElement, transform: string, ms: number, done: () => void): () => void {
  let finished = false
  const finish = () => {
    if (finished) return
    stop()
    done()
  }
  const onTransitionEnd = (event: TransitionEvent) => {
    if (event.target === pane && event.propertyName === 'transform') finish()
  }
  // A cancelled transition or an unchanged endpoint may emit no transitionend.
  const timer = setTimeout(finish, ms + 50)
  const stop = () => {
    finished = true
    clearTimeout(timer)
    pane.removeEventListener('transitionend', onTransitionEnd)
  }
  pane.addEventListener('transitionend', onTransitionEnd)
  pane.style.transition = `transform ${ms}ms ${EASING}`
  pane.style.transform = transform
  return stop
}

/**
 * Moves a pane of the iOS single-pane layout like a navigation stack: it slides in over the list
 * when shown, follows an edge swipe back, and slides out before a back navigation commits.
 */
export function useIosPaneNavigation(
  paneRef: RefObject<HTMLElement | null>,
  enabled: boolean,
  onBack: () => void,
  navigationKey?: string | null,
  entry?: IosPaneEntry,
): IosPaneNavigation {
  const onBackRef = useRef(onBack)
  onBackRef.current = onBack
  const [preview, setPreview] = useState(false)
  const slideRef = useRef<Slide | null>(null)

  const clear = useCallback(() => {
    slideRef.current?.stop()
    slideRef.current = null
    const pane = paneRef.current
    if (pane) Object.assign(pane.style, { transform: '', transition: '', willChange: '' })
    setPreview(false)
  }, [paneRef])

  const exit = useCallback((pane: HTMLElement, navigate: () => void) => {
    slideRef.current?.stop()
    setPreview(true)
    pane.style.willChange = 'transform'
    const stop = slide(pane, `translate3d(${pane.getBoundingClientRect().width}px, 0, 0)`, SETTLE_MS, () => {
      // The pane stays off-screen until the navigation hides it: router updates commit in a
      // later frame, and restoring the transform first would flash the pane back for that frame.
      const timer = setTimeout(clear, GONE_MS)
      slideRef.current = { kind: 'gone', stop: () => clearTimeout(timer) }
      navigate()
    })
    slideRef.current = { kind: 'exit', stop }
  }, [clear])

  const back = useCallback((navigate: () => void) => {
    if (slideRef.current?.kind === 'exit' || slideRef.current?.kind === 'gone') return
    const pane = paneRef.current
    if (!pane || !isIosSinglePane() || prefersReducedMotion()) {
      if (slideRef.current) clear()
      navigate()
      return
    }
    exit(pane, navigate)
  }, [paneRef, clear, exit])

  const shown = entry?.shown ?? false
  const enterAnimatedRef = useRef(false)
  enterAnimatedRef.current = entry?.animated ?? false
  const wasShownRef = useRef(shown)
  useLayoutEffect(() => {
    const wasShown = wasShownRef.current
    wasShownRef.current = shown
    if (!shown && slideRef.current?.kind === 'gone') clear()
    const pane = paneRef.current
    if (!shown || wasShown || !enterAnimatedRef.current || !pane || !isIosSinglePane() || prefersReducedMotion()) return
    slideRef.current?.stop()
    Object.assign(pane.style, { transition: 'none', transform: 'translate3d(100%, 0, 0)', willChange: 'transform' })
    setPreview(true)
    // Start from a painted off-screen frame: the commit that mounts a conversation is long, and a
    // transition started inside it would be over before its first frame is drawn.
    let frame = requestAnimationFrame(() => {
      frame = requestAnimationFrame(() => {
        slideRef.current = { kind: 'enter', stop: slide(pane, 'translate3d(0, 0, 0)', ENTER_MS, clear) }
      })
    })
    slideRef.current = { kind: 'enter', stop: () => cancelAnimationFrame(frame) }
    return () => {
      if (slideRef.current?.kind === 'enter') clear()
    }
  }, [shown, paneRef, clear])

  useEffect(() => {
    if (!enabled || platform().shell !== 'mobile' || platform().os !== 'ios') return
    const pane = paneRef.current
    if (!pane) return

    let start: { identifier: number; x: number; y: number } | null = null
    let dragging = false
    let reducedMotion = false
    const settle = (commit: boolean) => {
      start = null
      if (!dragging) return
      dragging = false
      if (reducedMotion) {
        clear()
        if (commit) onBackRef.current()
        return
      }
      if (commit) {
        exit(pane, () => onBackRef.current())
        return
      }
      slideRef.current = { kind: 'settle', stop: slide(pane, 'translate3d(0, 0, 0)', SETTLE_MS, clear) }
    }
    const onTouchStart = (event: TouchEvent) => {
      if (slideRef.current) return
      if (dragging) { settle(false); return }
      start = null
      if (window.innerWidth >= 768 || event.touches.length !== 1 || document.querySelector('[role="dialog"]')) return
      const touch = event.touches[0]
      const edge = touch.clientX - pane.getBoundingClientRect().left
      if (edge < 0 || edge > EDGE_WIDTH) return
      reducedMotion = prefersReducedMotion()
      start = { identifier: touch.identifier, x: touch.clientX, y: touch.clientY }
    }
    const onTouchMove = (event: TouchEvent) => {
      if (!start || slideRef.current) return
      if (event.touches.length !== 1 || document.querySelector('[role="dialog"]')) { settle(false); start = null; return }
      const touch = event.touches[0]
      if (touch.identifier !== start.identifier) { settle(false); start = null; return }
      const dx = touch.clientX - start.x
      const dy = Math.abs(touch.clientY - start.y)
      if (!dragging) {
        if ((dy > 10 && dy > Math.abs(dx)) || dx < -10) { start = null; return }
        if (dx < 10 || dx <= dy * 1.5) return
        dragging = true
        if (!reducedMotion) {
          setPreview(true)
          pane.style.transition = 'none'
          pane.style.willChange = 'transform'
        }
      }
      if (event.cancelable) event.preventDefault()
      if (!reducedMotion) pane.style.transform = `translate3d(${Math.min(Math.max(0, dx), pane.getBoundingClientRect().width)}px, 0, 0)`
    }
    const onTouchEnd = (event: TouchEvent) => {
      if (!start || slideRef.current) return
      const touch = Array.from(event.changedTouches).find(item => item.identifier === start?.identifier)
      const commit = !!touch && touch.clientX - start.x >= SWIPE_DISTANCE && !document.querySelector('[role="dialog"]')
      settle(commit)
    }
    const onTouchCancel = () => { settle(false) }
    const onResize = () => {
      start = null
      dragging = false
      clear()
    }

    pane.addEventListener('touchstart', onTouchStart, { passive: true })
    pane.addEventListener('touchmove', onTouchMove, { passive: false })
    pane.addEventListener('touchend', onTouchEnd)
    pane.addEventListener('touchcancel', onTouchCancel)
    window.addEventListener('resize', onResize)
    return () => {
      // An entry animation outlives a key change: a conversation's id lands while it slides in.
      if (dragging || (slideRef.current && slideRef.current.kind !== 'enter')) clear()
      pane.removeEventListener('touchstart', onTouchStart)
      pane.removeEventListener('touchmove', onTouchMove)
      pane.removeEventListener('touchend', onTouchEnd)
      pane.removeEventListener('touchcancel', onTouchCancel)
      window.removeEventListener('resize', onResize)
    }
  }, [paneRef, enabled, navigationKey, clear, exit])

  return { preview, back }
}
