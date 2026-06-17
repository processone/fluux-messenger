/**
 * External link handler for Tauri desktop app.
 * Intercepts clicks on external <a> tags and opens them in the system's
 * default browser. In web mode, links open normally.
 */

import { isTauri } from './tauri'

function isExternalUrl(href: string): boolean {
  try {
    const url = new URL(href, window.location.origin)
    return url.origin !== window.location.origin
  } catch {
    return false
  }
}

async function openInSystemBrowser(url: string): Promise<void> {
  const { open } = await import('@tauri-apps/plugin-shell')
  await open(url)
}

/**
 * Set up a global click handler that intercepts external link clicks
 * and opens them in the system's default browser.
 * Returns a cleanup function, or undefined in web mode.
 */
export function setupExternalLinkHandler(): (() => void) | undefined {
  if (!isTauri()) return undefined

  const handler = (event: MouseEvent) => {
    const target = event.target as Element | null
    const anchor = target?.closest?.('a')
    if (!anchor) return

    // A click on an interactive control nested inside the link (e.g. the
    // "Show image" button in a deferred link-preview card) belongs to that
    // control, not the link — let it handle the click instead of navigating.
    // This handler runs in the capture phase, so the nested control's own
    // preventDefault/stopPropagation cannot stop it; this guard is what does.
    const interactive = target?.closest?.('button, [role="button"]')
    if (interactive && anchor.contains(interactive)) return

    const href = anchor.getAttribute('href')
    if (!href) return

    if (!href.startsWith('http://') && !href.startsWith('https://')) return
    if (!isExternalUrl(href)) return

    event.preventDefault()
    event.stopPropagation()

    void openInSystemBrowser(href)
  }

  document.addEventListener('click', handler, true)

  return () => {
    document.removeEventListener('click', handler, true)
  }
}
