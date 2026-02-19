import { useEffect } from 'react'
import { useXMPPContext } from '@fluux/sdk'

/**
 * Set up Tauri app close handlers for graceful XMPP disconnect.
 *
 * On desktop platforms, Rust emits `graceful-shutdown` before app exit
 * (e.g. Cmd+Q, tray Quit). We disconnect XMPP, stop the proxy, then exit.
 *
 * No-op in non-Tauri environments (web browsers).
 */
export function useTauriCloseHandler(): void {
  const { client } = useXMPPContext()

  useEffect(() => {
    let unlistenShutdown: (() => void) | null = null
    let isClosing = false

    const setup = async () => {
      try {
        const { listen } = await import('@tauri-apps/api/event')
        const { invoke } = await import('@tauri-apps/api/core')

        const disconnectBestEffort = async () => {
          try {
            await Promise.race([
              client.disconnect(),
              new Promise<void>((resolve) => {
                setTimeout(resolve, 2000)
              }),
            ])
          } catch (err) {
            console.warn('[Fluux] Disconnect during close failed:', err)
          }
        }

        const platform = navigator.platform.toLowerCase()
        const isDesktopPlatform =
          platform.includes('mac') || platform.includes('win') || platform.includes('linux')
        if (!isDesktopPlatform) return

        unlistenShutdown = await listen('graceful-shutdown', async () => {
          if (isClosing) return
          isClosing = true

          await disconnectBestEffort()
          await invoke('stop_xmpp_proxy').catch(() => {})
          await invoke('exit_app').catch(() => {})
        })
      } catch {
        // Not in Tauri environment, ignore
      }
    }

    void setup()

    return () => {
      unlistenShutdown?.()
    }
  }, [client])
}
