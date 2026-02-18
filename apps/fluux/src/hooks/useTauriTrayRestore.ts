import { useEffect } from 'react'

/**
 * Restore webview input focus after a Linux tray show/hide cycle.
 *
 * On Linux (GNOME), hiding the window to tray and restoring it with
 * the `always_on_top` pulse trick raises the window visually but does
 * NOT give the WebKit webview input focus. Buttons and links stay
 * unresponsive until the user interacts with the window chrome (e.g.
 * maximizes).
 *
 * The Rust tray handler emits `tray-restore-focus` after raising the
 * window. We call `getCurrentWebview().setFocus()` (maps to
 * `gtk_widget_grab_focus` on the WebKitGTK widget) to hand input
 * focus to the webview content without triggering GNOME's
 * focus-stealing prevention toast.
 *
 * No-op in non-Tauri environments (web browsers).
 */
export function useTauriTrayRestore(): void {
  useEffect(() => {
    const platform = navigator.platform.toLowerCase()
    if (!platform.includes('linux')) return

    let unlisten: (() => void) | null = null

    const setup = async () => {
      try {
        const { listen } = await import('@tauri-apps/api/event')
        const { getCurrentWebview } = await import('@tauri-apps/api/webview')

        unlisten = await listen('tray-restore-focus', async () => {
          try {
            // Focus the WebKit widget (gtk_widget_grab_focus) — gives
            // the webview keyboard/pointer input focus without calling
            // the window-level present_with_time that triggers the
            // GNOME toast.
            await getCurrentWebview().setFocus()
          } catch {
            // Fallback: at least try JS-level focus
            window.focus()
          }
        })
      } catch {
        // Not in Tauri environment, ignore
      }
    }

    void setup()

    return () => {
      unlisten?.()
    }
  }, [])
}
