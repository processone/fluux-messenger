/**
 * External link handler for Tauri desktop app.
 * Intercepts clicks on external <a> tags and opens them in a Tauri webview popup
 * instead of the system browser. In web mode, links open normally.
 */

import { isTauri } from './tauri'

let counter = 0

function generateWindowLabel(): string {
  return `external-link-${Date.now()}-${counter++}`
}

function isExternalUrl(href: string): boolean {
  try {
    const url = new URL(href, window.location.origin)
    return url.origin !== window.location.origin
  } catch {
    return false
  }
}

async function openInWebviewPopup(url: string): Promise<void> {
  const { WebviewWindow } = await import('@tauri-apps/api/webviewWindow')

  let title = url
  try {
    title = new URL(url).hostname
  } catch {
    // Use raw URL as title if parsing fails
  }

  new WebviewWindow(generateWindowLabel(), {
    url,
    title,
    width: 1024,
    height: 768,
    minWidth: 400,
    minHeight: 300,
    center: true,
    resizable: true,
    focus: true,
  })
}

/**
 * Set up a global click handler that intercepts external link clicks
 * and opens them in Tauri webview popup windows.
 * Returns a cleanup function, or undefined in web mode.
 */
export function setupExternalLinkHandler(): (() => void) | undefined {
  if (!isTauri()) return undefined

  const handler = (event: MouseEvent) => {
    const anchor = (event.target as Element)?.closest?.('a')
    if (!anchor) return

    const href = anchor.getAttribute('href')
    if (!href) return

    if (!href.startsWith('http://') && !href.startsWith('https://')) return
    if (!isExternalUrl(href)) return

    event.preventDefault()
    event.stopPropagation()

    void openInWebviewPopup(href)
  }

  document.addEventListener('click', handler, true)

  return () => {
    document.removeEventListener('click', handler, true)
  }
}
