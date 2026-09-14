import { useEffect } from 'react'

/**
 * Restore WebKitGTK input focus for Linux tray and notification activation.
 *
 * Linux tray restores and native notification activation emit
 * `tray-restore-focus` after raising the window. Raising the top-level window
 * can leave the webview without input focus; `getCurrentWebview().setFocus()`
 * calls `gtk_widget_grab_focus` without the window-level `present_with_time`
 * that triggers GNOME's focus-stealing toast.
 *
 * For the Windows focus-event constraint, see the `WindowEvent::Focused`
 * handler in `src-tauri/src/main.rs`.
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
