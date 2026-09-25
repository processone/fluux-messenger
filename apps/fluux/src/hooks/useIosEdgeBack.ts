import { useEffect, useRef, useState, type RefObject } from 'react'
import { platform } from '@/platform'

const EDGE_WIDTH = 28
const SWIPE_DISTANCE = 80
const SETTLE_MS = 220

/** Reveal the list while dragging; commit navigation only after the pane exits. */
export function useIosEdgeBack(
  paneRef: RefObject<HTMLElement | null>,
  enabled: boolean,
  onBack: () => void,
  navigationKey?: string | null,
): boolean {
  const onBackRef = useRef(onBack)
  onBackRef.current = onBack
  const [preview, setPreview] = useState(false)

  useEffect(() => {
    if (!enabled || platform().shell !== 'mobile' || platform().os !== 'ios') return
    const pane = paneRef.current
    if (!pane) return

    let start: { identifier: number; x: number; y: number } | null = null
    let dragging = false
    let settling = false
    let reducedMotion = false
    let timer: ReturnType<typeof setTimeout> | undefined
    let complete: (() => void) | undefined
    const original = { transform: pane.style.transform, transition: pane.style.transition, willChange: pane.style.willChange }
    const reset = () => {
      clearTimeout(timer)
      complete = undefined
      start = null
      dragging = false
      settling = false
      Object.assign(pane.style, original)
      setPreview(false)
    }
    const settle = (commit: boolean) => {
      start = null
      if (!dragging) return
      if (reducedMotion) {
        reset()
        if (commit) onBackRef.current()
        return
      }
      settling = true
      complete = () => {
        reset()
        if (commit) onBackRef.current()
      }
      pane.style.transition = `transform ${SETTLE_MS}ms cubic-bezier(0.2, 0.8, 0.2, 1)`
      pane.style.transform = `translate3d(${commit ? pane.getBoundingClientRect().width : 0}px, 0, 0)`
      // A cancelled transition or an unchanged endpoint may emit no transitionend.
      timer = setTimeout(() => complete?.(), SETTLE_MS + 50)
    }
    const onTransitionEnd = (event: TransitionEvent) => {
      if (event.target === pane && event.propertyName === 'transform') complete?.()
    }
    const onTouchStart = (event: TouchEvent) => {
      if (settling) return
      if (dragging) { settle(false); return }
      start = null
      if (window.innerWidth >= 768 || event.touches.length !== 1 || document.querySelector('[role="dialog"]')) return
      const touch = event.touches[0]
      const edge = touch.clientX - pane.getBoundingClientRect().left
      if (edge < 0 || edge > EDGE_WIDTH) return
      reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches
      start = { identifier: touch.identifier, x: touch.clientX, y: touch.clientY }
    }
    const onTouchMove = (event: TouchEvent) => {
      if (!start || settling) return
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
      if (!start || settling) return
      const touch = Array.from(event.changedTouches).find(item => item.identifier === start?.identifier)
      const commit = !!touch && touch.clientX - start.x >= SWIPE_DISTANCE && !document.querySelector('[role="dialog"]')
      settle(commit)
      start = null
    }
    const onTouchCancel = () => { settle(false); start = null }
    const onResize = () => reset()

    pane.addEventListener('touchstart', onTouchStart, { passive: true })
    pane.addEventListener('touchmove', onTouchMove, { passive: false })
    pane.addEventListener('touchend', onTouchEnd)
    pane.addEventListener('touchcancel', onTouchCancel)
    pane.addEventListener('transitionend', onTransitionEnd)
    window.addEventListener('resize', onResize)
    return () => {
      reset()
      pane.removeEventListener('touchstart', onTouchStart)
      pane.removeEventListener('touchmove', onTouchMove)
      pane.removeEventListener('touchend', onTouchEnd)
      pane.removeEventListener('touchcancel', onTouchCancel)
      pane.removeEventListener('transitionend', onTransitionEnd)
      window.removeEventListener('resize', onResize)
    }
  }, [paneRef, enabled, navigationKey])
  return preview
}
