import { useLayoutEffect, type RefObject } from 'react'

/** Fixed overlays use the layout viewport on iOS, even when the keyboard covers it. */
export function useModalViewport(rootRef: RefObject<HTMLDivElement | null>, panelRef: RefObject<HTMLDivElement | null>) {
  useLayoutEffect(() => {
    const viewport = window.visualViewport
    const root = rootRef.current
    const panel = panelRef.current
    if (!viewport || !root || !panel) return
    const originalMaxHeight = panel.style.maxHeight
    const restore = () => {
      for (const property of ['top', 'left', 'width', 'height', 'bottom', 'right']) root.style.removeProperty(property)
      delete root.dataset.keyboard
      panel.style.maxHeight = originalMaxHeight
    }
    const update = () => {
      // Pinch zoom must retain its layout so the user can pan around it.
      if (viewport.scale !== 1) return
      restore()
      if (viewport.height >= window.innerHeight - 1) return
      Object.assign(root.style, {
        top: `${viewport.offsetTop}px`, left: `${viewport.offsetLeft}px`,
        width: `${viewport.width}px`, height: `${viewport.height}px`, bottom: 'auto', right: 'auto',
      })
      root.dataset.keyboard = 'true'
      const style = getComputedStyle(root)
      const padding = (parseFloat(style.paddingTop) || 16) + (parseFloat(style.paddingBottom) || 16)
      const callerLimit = parseFloat(getComputedStyle(panel).maxHeight)
      panel.style.maxHeight = `${Math.max(0, Math.min(Number.isFinite(callerLimit) ? callerLimit : Infinity, viewport.height - padding))}px`
      const active = document.activeElement
      if (active instanceof HTMLElement && panel.contains(active)) {
        const field = active.getBoundingClientRect()
        const bounds = panel.getBoundingClientRect()
        if (field.bottom > bounds.bottom) panel.scrollTop += field.bottom - bounds.bottom
        else if (field.top < bounds.top) panel.scrollTop -= bounds.top - field.top
      }
    }
    update()
    viewport.addEventListener('resize', update)
    viewport.addEventListener('scroll', update)
    window.addEventListener('resize', update)
    return () => {
      viewport.removeEventListener('resize', update)
      viewport.removeEventListener('scroll', update)
      window.removeEventListener('resize', update)
      restore()
    }
  }, [rootRef, panelRef])
}
