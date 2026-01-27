import { useEffect, useCallback } from 'react'
import { consoleStore, usePresence } from '@fluux/sdk'
import { useConnectionStore } from '@fluux/sdk/react'

const isTauri = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window

/**
 * Hook to detect system sleep and notify the presence state machine.
 * On macOS, listens for NSWorkspaceWillSleepNotification via Tauri.
 *
 * Presence is automatically restored when:
 * - System wakes from sleep (handled by useAutoAway's system-did-wake listener)
 * - User activity is detected (handled by useAutoAway's activity listeners)
 */
export function useSleepDetector() {
  // Use focused selector to only subscribe to status
  const status = useConnectionStore((s) => s.status)
  const { presenceStatus: presenceShow, isAutoAway, sleepDetected } = usePresence()

  // Helper to log events to the XMPP console
  const logEvent = useCallback((message: string) => {
    consoleStore.getState().addEvent(message, 'presence')
  }, [])

  useEffect(() => {
    if (!isTauri || status !== 'online') {
      return
    }

    // Don't override if already in DND mode or already auto-away
    if (presenceShow === 'dnd' || isAutoAway) {
      return
    }

    let unlisten: (() => void) | undefined
    let cleanedUp = false

    const setupListener = async () => {
      // Dynamic import to avoid loading Tauri APIs in web mode
      const { listen } = await import('@tauri-apps/api/event')
      const fn = await listen('system-will-sleep', () => {
        // Notify the presence machine that system is going to sleep
        // The machine will save current presence and transition to sleep state
        sleepDetected()
        logEvent('System going to sleep, presence machine notified')
      })
      // If cleanup already ran, unlisten immediately
      if (cleanedUp) {
        fn()
      } else {
        unlisten = fn
      }
    }

    void setupListener()

    return () => {
      cleanedUp = true
      unlisten?.()
    }
  }, [status, presenceShow, isAutoAway, sleepDetected, logEvent])
}
