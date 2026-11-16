/**
 * Handle in-app XMPP links on every platform and external web links in native
 * shells. XMPP navigation never goes through an operating-system handler.
 */

import { platform } from '@/platform'
import { openInBrowser } from './openInBrowser'
import { routeDeepLink } from './deepLinkRouter'

function openLink(href: string): void {
  if (href.startsWith('xmpp:')) routeDeepLink(href)
  else void openInBrowser(href)
}

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
  if (!href) return null
  if (href.startsWith('xmpp:')) return { anchor, href }
  if (!platform().interceptsInAppNavigation || (!href.startsWith('http://') && !href.startsWith('https://'))) return null
  if (!isExternalUrl(href)) return null
  return { anchor, href }
}

/**
 * Install one shared click handler: XMPP links navigate in Fluux; native web
 * links open in the system browser. Ordinary web-browser links keep their default.
 * Returns the listener cleanup.
 */
export function setupExternalLinkHandler(): (() => void) | undefined {
  let touchStart: { anchor: Element; href: string; identifier: number; x: number; y: number; at: number } | null = null
  let suppressedClick: { anchor: Element; until: number } | null = null

  const handler = (event: MouseEvent) => {
    const link = externalLink(event.target)
    if (!link) return

    event.preventDefault()
    event.stopPropagation()

    if (suppressedClick?.anchor === link.anchor && Date.now() < suppressedClick.until) {
      suppressedClick = null
      return
    }
    openLink(link.href)
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
    if (!started) return
    const touch = Array.from(event.changedTouches).find((item) => item.identifier === started.identifier)
    if (!touch || Math.hypot(touch.clientX - started.x, touch.clientY - started.y) > 12) return

    // A long press may also produce a click; the message sheet owns that gesture.
    const now = Date.now()
    suppressedClick = { anchor: started.anchor, until: now + 750 }
    if (now - started.at >= 500) return

    // The iOS link path must not depend on WebKit producing a synthetic click.
    event.preventDefault()
    openLink(started.href)
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
