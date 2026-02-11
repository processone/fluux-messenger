import { useEffect } from 'react'
import { useXMPPContext } from '@fluux/sdk'

/**
 * Set up Tauri app close handlers for graceful XMPP disconnect.
 *
 * - macOS: Command-Q triggers graceful-shutdown from RunEvent::ExitRequested
 * - Windows: Tray "Quit" menu item emits graceful-shutdown
 *   Close button (X) hides to tray (handled in Rust), not quit
 * - Linux: Close button triggers onCloseRequested (no system tray)
 *
 * No-op in non-Tauri environments (web browsers).
 */
export function useTauriCloseHandler(): void {
  const { client } = useXMPPContext()

  useEffect(() => {
    let unlistenTauri: (() => void) | null = null
    let unlistenShutdown: (() => void) | null = null
    let isClosing = false

    const setup = async () => {
      try {
        const { getCurrentWindow } = await import('@tauri-apps/api/window')
        const { listen } = await import('@tauri-apps/api/event')
        const { invoke } = await import('@tauri-apps/api/core')
        const currentWindow = getCurrentWindow()

        const isMacOS = navigator.platform.toLowerCase().includes('mac')
        const isWindows = navigator.platform.toLowerCase().includes('win')

        if (isMacOS || isWindows) {
          unlistenShutdown = await listen('graceful-shutdown', async () => {
            if (isClosing) return
            isClosing = true

            await client.disconnect()
            await invoke('exit_app')
          })
        } else {
          // Linux: Handle close button (no system tray)
          unlistenTauri = await currentWindow.onCloseRequested(async (event) => {
            if (isClosing) return
            isClosing = true
            event.preventDefault()

            await client.disconnect()
            await currentWindow.destroy()
          })
        }
      } catch {
        // Not in Tauri environment, ignore
      }
    }

    void setup()

    return () => {
      unlistenTauri?.()
      unlistenShutdown?.()
    }
  }, [client])
}
