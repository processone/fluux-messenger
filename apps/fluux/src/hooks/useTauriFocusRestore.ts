import { useEffect } from 'react'

/**
 * Restore WebKitGTK input focus after an explicit Linux tray restore.
 *
 * The GNOME `always_on_top` pulse raises the window visually without giving
 * the webview input focus. Rust emits `tray-restore-focus` after raising it;
 * `getCurrentWebview().setFocus()` calls `gtk_widget_grab_focus` without the
 * window-level `present_with_time` that triggers GNOME's focus-stealing toast.
 *
 * Windows focus notifications can originate in WebView2 itself. Requesting
 * webview focus in response can sustain a focus loop (#1418).
 */
export function useTauriFocusRestore(): void {
  useEffect(() => {
    const platform = navigator.platform.toLowerCase()
    const isLinux = platform.includes('linux')
    if (!isLinux) return

    const unlisteners: Array<() => void> = []

    const setup = async () => {
      try {
        const { listen } = await import('@tauri-apps/api/event')
        const { getCurrentWebview } = await import('@tauri-apps/api/webview')

        const restoreFocus = async () => {
          try {
            await getCurrentWebview().setFocus()
          } catch (error) {
            // A missing Tauri capability makes this native focus call reject.
            // Keep the fallback, but surface the failure so packaged-build
            // regressions are diagnosable instead of silently looking fixed.
            console.warn('[FocusRestore] Failed to focus native webview:', error)
            window.focus()
          }
        }

        unlisteners.push(await listen('tray-restore-focus', restoreFocus))
      } catch {
        // Not in Tauri environment, ignore.
      }
    }

    void setup()

    return () => {
      for (const unlisten of unlisteners) unlisten()
    }
  }, [])
}
