import { useLayoutEffect, type RefObject } from 'react'
import { getFloatingViewport, limitFloatingHeight } from './floatingViewport'

export function useFloatingLayerBounds(ref: RefObject<HTMLElement | null>, active = true, padding = 8) {
  useLayoutEffect(() => {
    const element = ref.current
    if (!active || !element) return
    const translate = element.style.translate
    let restoreHeight = () => {}
    const place = () => {
      restoreHeight()
      element.style.translate = translate
      const viewport = getFloatingViewport()
      if (!viewport.top) return
      restoreHeight = limitFloatingHeight(element, viewport, padding)
      const box = element.getBoundingClientRect()
      const y = Math.max(viewport.top + padding, Math.min(box.top, viewport.height - box.height - padding))
      element.style.translate = `0 ${y - box.top}px`
    }
    place()
    const observer = new ResizeObserver(place)
    observer.observe(element)
    if (element.parentElement) observer.observe(element.parentElement)
    window.addEventListener('resize', place)
    return () => {
      observer.disconnect()
      window.removeEventListener('resize', place)
      restoreHeight()
      element.style.translate = translate
    }
  }, [ref, active, padding])
}
