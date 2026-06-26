import { useEffect } from 'react'

/**
 * Restore webview *input* focus when the OS hands window focus back but
 * the webview child doesn't take keyboard focus on its own.
 *
 * Two platform cases, same remedy:
 *
 * - Linux (GNOME): hiding to tray and restoring with the `always_on_top`
 *   pulse trick raises the window visually but does NOT give the WebKitGTK
 *   webview input focus. Buttons and links stay unresponsive until the
 *   user interacts with the window chrome. Rust emits `tray-restore-focus`
 *   after raising the window.
 *
 * - Windows (WebView2): alt-tabbing or clicking the taskbar icon focuses
 *   the top-level window, but WebView2 does not move keyboard focus into
 *   the webview child. Keyboard shortcuts (F12, Ctrl+K, …) and typing are
 *   dead until the user clicks inside the window. Rust emits
 *   `window-focus-restore` on `WindowEvent::Focused(true)`. (#654)
 *
 * In both cases we call `getCurrentWebview().setFocus()`, which maps to
 * `gtk_widget_grab_focus` (Linux) / `controller.MoveFocus` (Windows) and
 * hands input focus to the webview content — without the window-level
 * `present_with_time` that triggers GNOME's focus-stealing toast.
 *
 * No-op in non-Tauri environments (web browsers) and on macOS, where
 * WKWebView restores webview focus on window focus automatically.
 */
export function useTauriFocusRestore(): void {
  useEffect(() => {
    const platform = navigator.platform.toLowerCase()
    const isLinux = platform.includes('linux')
    const isWindows = platform.includes('win')
    if (!isLinux && !isWindows) return

    const unlisteners: Array<() => void> = []

    const setup = async () => {
      try {
        const { listen } = await import('@tauri-apps/api/event')
        const { getCurrentWebview } = await import('@tauri-apps/api/webview')

        const restoreFocus = async () => {
          try {
            // Hand input focus to the webview content (gtk_widget_grab_focus
            // on Linux, controller.MoveFocus on Windows). MoveFocus does not
            // re-raise the top-level window, so it cannot loop the Windows
            // Focused(true) event that triggered us.
            await getCurrentWebview().setFocus()
          } catch {
            // Fallback: at least try JS-level focus.
            window.focus()
          }
        }

        // The window event differs per platform but the remedy is identical.
        const eventName = isWindows ? 'window-focus-restore' : 'tray-restore-focus'
        unlisteners.push(await listen(eventName, restoreFocus))
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
