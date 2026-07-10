import { isTauri } from './tauri'

/**
 * Open a URL in the user's default browser.
 *
 * On the Tauri desktop app this hands off to the OS via the shell plugin so the
 * link opens in the real browser (not a new WebView window). On web/PWA it falls
 * back to `window.open` with `noopener,noreferrer`.
 */
export async function openInBrowser(url: string): Promise<void> {
  if (isTauri()) {
    const { open } = await import('@tauri-apps/plugin-shell')
    await open(url)
  } else {
    window.open(url, '_blank', 'noopener,noreferrer')
  }
}
