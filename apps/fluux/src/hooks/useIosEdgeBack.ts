import { useEffect, useRef, type RefObject } from 'react'
import { platform } from '@/platform'

const EDGE_WIDTH = 28
const SWIPE_DISTANCE = 80

/** Return through the visible pane's back action after a deliberate iOS edge swipe. */
export function useIosEdgeBack(
  paneRef: RefObject<HTMLElement | null>,
  enabled: boolean,
  onBack: () => void,
): void {
  const onBackRef = useRef(onBack)
  onBackRef.current = onBack

  useEffect(() => {
    if (!enabled || platform().shell !== 'mobile' || platform().os !== 'ios') return
    const pane = paneRef.current
    if (!pane) return

    let start: { identifier: number; x: number; y: number } | null = null

    const onTouchStart = (event: TouchEvent) => {
      start = null
      if (event.touches.length !== 1 || document.querySelector('[role="dialog"]')) return
      const touch = event.touches[0]
      if (touch.clientX - pane.getBoundingClientRect().left > EDGE_WIDTH) return
      start = { identifier: touch.identifier, x: touch.clientX, y: touch.clientY }
    }

    const onTouchMove = (event: TouchEvent) => {
      if (!start || event.touches.length !== 1) {
        start = null
        return
      }
      const touch = event.touches[0]
      if (touch.identifier !== start.identifier) {
        start = null
        return
      }
      const dx = touch.clientX - start.x
      const dy = Math.abs(touch.clientY - start.y)
      if (dy > 30 && dy > dx) start = null
    }

    const onTouchEnd = (event: TouchEvent) => {
      const gesture = start
      start = null
      if (!gesture || document.querySelector('[role="dialog"]')) return
      const touch = Array.from(event.changedTouches).find((item) => item.identifier === gesture.identifier)
      if (!touch) return
      const dx = touch.clientX - gesture.x
      const dy = Math.abs(touch.clientY - gesture.y)
      if (dx >= SWIPE_DISTANCE && dx > dy * 1.5) onBackRef.current()
    }
    const onTouchCancel = () => { start = null }

    pane.addEventListener('touchstart', onTouchStart, { passive: true })
    pane.addEventListener('touchmove', onTouchMove, { passive: true })
    pane.addEventListener('touchend', onTouchEnd)
    pane.addEventListener('touchcancel', onTouchCancel)
    return () => {
      pane.removeEventListener('touchstart', onTouchStart)
      pane.removeEventListener('touchmove', onTouchMove)
      pane.removeEventListener('touchend', onTouchEnd)
      pane.removeEventListener('touchcancel', onTouchCancel)
    }
  }, [paneRef, enabled])
}
