import { platform } from '@/platform'

/** Keep the native mobile shell inside the area left visible by the keyboard.
 * WKWebView can pan its layout viewport to reveal a focused input even when
 * the document has overflow:hidden. The status-bar inset must move with the
 * visible viewport, rather than scrolling out of view with the document.
 */
export function installMobileViewport(): () => void {
  const viewport = window.visualViewport
  const root = document.getElementById('root')
  if (platform().shell !== 'mobile' || !viewport || !root) return () => {}

  const previous = {
    position: root.style.position,
    top: root.style.top,
    left: root.style.left,
    right: root.style.right,
    height: root.style.height,
  }

  const update = () => {
    // Preserve the full layout while zooming; resizing to the magnified area
    // would reflow content and prevent the user from panning over it.
    if (viewport.scale !== 1) return
    Object.assign(root.style, {
      position: 'fixed',
      top: `${viewport.offsetTop}px`,
      left: '0',
      right: '0',
      height: `${viewport.height}px`,
    })
  }

  viewport.addEventListener('resize', update)
  viewport.addEventListener('scroll', update)
  update()

  return () => {
    viewport.removeEventListener('resize', update)
    viewport.removeEventListener('scroll', update)
    Object.assign(root.style, previous)
  }
}
