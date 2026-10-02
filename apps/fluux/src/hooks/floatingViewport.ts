export interface FloatingViewport {
  width: number
  /** Bottom viewport coordinate in CSS pixels, including any reserved top strip. */
  height: number
  /** First usable y coordinate in CSS pixels; omitted means zero. */
  top?: number
}

export function getFloatingViewport(): FloatingViewport {
  const style = getComputedStyle(document.documentElement)
  const height = style.getPropertyValue('--fluux-window-titlebar-height').trim()
  const top = (parseFloat(height) || 0) * (height.endsWith('rem') ? parseFloat(style.fontSize) : 1)
  return { width: window.innerWidth, height: window.innerHeight, top }
}

export function limitFloatingHeight(element: HTMLElement, viewport: FloatingViewport, padding = 8): () => void {
  if (!viewport.top) return () => {}
  const { maxHeight, overflowY } = element.style
  const limit = parseFloat(getComputedStyle(element).maxHeight)
  element.style.maxHeight = `${Math.min(Number.isFinite(limit) ? limit : Infinity, Math.max(0, viewport.height - viewport.top - padding * 2))}px`
  element.style.overflowY = 'auto'
  return () => {
    element.style.maxHeight = maxHeight
    element.style.overflowY = overflowY
  }
}
