import { platform } from '@/platform'

/**
 * Open a URL in the user's default browser.
 *
 * Native shells hand off to the OS browser. iOS uses the opener plugin exposed
 * by its capability set; desktop retains the shell plugin. Web/PWA falls back
 * to `window.open` with `noopener,noreferrer`.
 */
export async function openInBrowser(url: string): Promise<void> {
  if (platform().opensLinksInSystemBrowser) {
    if (platform().shell === 'mobile') {
      const { openUrl } = await import('@tauri-apps/plugin-opener')
      await openUrl(url)
    } else {
      const { open } = await import('@tauri-apps/plugin-shell')
      await open(url)
    }
  } else {
    window.open(url, '_blank', 'noopener,noreferrer')
  }
}
