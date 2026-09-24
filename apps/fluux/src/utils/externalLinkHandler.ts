/**
 * External link handler for native Tauri shells.
 * Intercepts clicks on external <a> tags and opens them in the system's
 * default browser. In web mode, links open normally.
 */

import { platform } from '@/platform'
import { openInBrowser } from './openInBrowser'

function isExternalUrl(href: string): boolean {
  try {
    const url = new URL(href, window.location.origin)
    return url.origin !== window.location.origin
  } catch {
    return false
  }
}

function externalLink(target: EventTarget | null): { anchor: Element; href: string } | null {
  const element = target instanceof Element ? target : target instanceof Node ? target.parentElement : null
  const anchor = element?.closest('a')
  if (!anchor) return null

  const interactive = element?.closest('button, [role="button"]')
  if (interactive && anchor.contains(interactive)) return null

  const href = anchor.getAttribute('href')
  if (!href || (!href.startsWith('http://') && !href.startsWith('https://'))) return null
  if (!isExternalUrl(href)) return null
  return { anchor, href }
}

/**
 * Set up a global click handler that intercepts external link clicks
 * and opens them in the system's default browser.
 * Returns a cleanup function, or undefined in web mode.
 */
export function setupExternalLinkHandler(): (() => void) | undefined {
  if (!platform().interceptsInAppNavigation) return undefined

  let touchStart: { anchor: Element; href: string; identifier: number; x: number; y: number; at: number } | null = null
  let handledTap: { anchor: Element; until: number } | null = null

  const handler = (event: MouseEvent) => {
    const link = externalLink(event.target)
    if (!link) return

    event.preventDefault()
    event.stopPropagation()

    if (handledTap?.anchor === link.anchor && Date.now() < handledTap.until) {
      handledTap = null
      return
    }
    void openInBrowser(link.href)
  }

  const onTouchStart = (event: TouchEvent) => {
    touchStart = null
    if (event.touches.length !== 1) return
    const link = externalLink(event.target)
    if (!link) return
    const touch = event.touches[0]
    touchStart = { ...link, identifier: touch.identifier, x: touch.clientX, y: touch.clientY, at: Date.now() }
  }

  const onTouchMove = (event: TouchEvent) => {
    if (!touchStart || event.touches.length !== 1) {
      touchStart = null
      return
    }
    const touch = event.touches[0]
    if (touch.identifier !== touchStart.identifier ||
      Math.hypot(touch.clientX - touchStart.x, touch.clientY - touchStart.y) > 12) {
      touchStart = null
    }
  }

  const onTouchEnd = (event: TouchEvent) => {
    const started = touchStart
    touchStart = null
    if (!started || Date.now() - started.at >= 500) return
    const touch = Array.from(event.changedTouches).find((item) => item.identifier === started.identifier)
    if (!touch || Math.hypot(touch.clientX - started.x, touch.clientY - started.y) > 12) return

    // The iOS link path must not depend on WebKit producing a synthetic click.
    event.preventDefault()
    handledTap = { anchor: started.anchor, until: Date.now() + 750 }
    void openInBrowser(started.href)
  }
  const onTouchCancel = () => { touchStart = null }

  document.addEventListener('click', handler, true)
  const ios = platform().shell === 'mobile' && platform().os === 'ios'
  if (ios) {
    document.addEventListener('touchstart', onTouchStart, { capture: true, passive: true })
    document.addEventListener('touchmove', onTouchMove, { capture: true, passive: true })
    document.addEventListener('touchend', onTouchEnd, { capture: true, passive: false })
    document.addEventListener('touchcancel', onTouchCancel, true)
  }

  return () => {
    document.removeEventListener('click', handler, true)
    if (ios) {
      document.removeEventListener('touchstart', onTouchStart, true)
      document.removeEventListener('touchmove', onTouchMove, true)
      document.removeEventListener('touchend', onTouchEnd, true)
      document.removeEventListener('touchcancel', onTouchCancel, true)
    }
  }
}
