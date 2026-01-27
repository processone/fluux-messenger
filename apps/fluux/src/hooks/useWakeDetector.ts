import { useEffect, useRef, useCallback } from 'react'
import { useXMPP } from '@fluux/sdk'
import { useConnectionStore } from '@fluux/sdk/react'
import type { UnlistenFn } from '@tauri-apps/api/event'
import { isTauri } from '../utils/keychain'
import { checkTimeGapWake, releaseWakeLock, tryAcquireWakeLock } from '../utils/wakeCoordinator'

/**
 * Heartbeat interval for sleep detection (ms).
 * We check this often to detect wake quickly.
 */
const HEARTBEAT_INTERVAL_MS = 10_000 // 10 seconds

/**
 * Minimum time the page must be hidden before we notify SDK on visibility change.
 * This avoids unnecessary checks for brief tab switches.
 */
const MIN_HIDDEN_TIME_MS = 60_000 // 1 minute

/**
 * Hook to detect wake from sleep and notify the SDK.
 *
 * After system sleep, WebSocket connections often die silently.
 * This hook detects platform-specific wake events and signals the SDK,
 * which handles connection verification and reconnection internally.
 *
 * **Headless Client Pattern**:
 * - This hook (app): Detects platform events (time gaps, visibility, Tauri events)
 * - SDK: Handles protocol response (verify connection, reconnect if dead)
 *
 * Detection mechanisms:
 * 1. Time-gap detection: Runs a heartbeat interval and detects large time gaps
 * 2. Visibility change: Detects when app becomes visible after long hide
 * 3. Tauri events: Listens for Rust-driven keepalive events (immune to JS throttling)
 *
 * Uses shared wakeCoordinator to prevent multiple hooks from handling wake simultaneously.
 */
export function useWakeDetector() {
  // Use focused selector to only subscribe to status, not all 12+ connection values
  const status = useConnectionStore((s) => s.status)
  // Get client from context for methods
  const { client } = useXMPP()
  const notifySystemState = useCallback(
    async (state: 'awake' | 'sleeping' | 'visible' | 'hidden') => {
      await client.notifySystemState(state)
    },
    [client]
  )
  const hiddenAtRef = useRef<number | null>(null)

  // Time-gap based sleep detection - works even when window is focused
  // Uses global heartbeat from wakeCoordinator to prevent duplicate detection
  // when components re-render rapidly
  useEffect(() => {
    if (status !== 'online' && status !== 'reconnecting') return

    const checkForWake = async () => {
      // checkTimeGapWake uses a global heartbeat timestamp and handles
      // the lock acquisition atomically, preventing race conditions
      // when multiple component instances exist due to rapid re-renders
      const gapSeconds = checkTimeGapWake('useWakeDetector:time-gap')

      if (gapSeconds !== null) {
        console.log(`[WakeDetector] Detected wake from sleep (${gapSeconds}s gap)`)

        try {
          // Signal SDK - it handles connection verification and reconnect
          await notifySystemState('awake')
        } catch (err) {
          console.error('[WakeDetector] Error handling wake:', err)
        } finally {
          releaseWakeLock()
        }
      }
      // Note: checkTimeGapWake always updates the global heartbeat,
      // even when no wake is detected or lock not acquired
    }

    const interval = setInterval(checkForWake, HEARTBEAT_INTERVAL_MS)

    return () => {
      clearInterval(interval)
    }
  }, [status, notifySystemState])

  // Handle visibility change - notify SDK when visible after long hide
  useEffect(() => {
    if (status !== 'online' && status !== 'reconnecting') return

    const handleVisibilityChange = async () => {
      if (document.hidden) {
        // Page is now hidden - record the time and notify SDK
        hiddenAtRef.current = Date.now()
        await notifySystemState('hidden')
        return
      }

      // Page is now visible
      const now = Date.now()
      const hiddenDuration = hiddenAtRef.current ? now - hiddenAtRef.current : 0
      hiddenAtRef.current = null

      // Skip SDK notification if not hidden long enough (brief tab switches)
      // But always notify for reconnecting state (timers may have been suspended)
      if (hiddenDuration < MIN_HIDDEN_TIME_MS && status !== 'reconnecting') {
        return
      }

      // Use shared coordinator to prevent concurrent wake handling across hooks
      if (!tryAcquireWakeLock('useWakeDetector:visibility')) return

      try {
        console.log(`[WakeDetector] Page visible after ${Math.round(hiddenDuration / 1000)}s`)
        // Signal SDK - it handles connection verification and reconnect
        await notifySystemState('visible')
      } catch (err) {
        console.error('[WakeDetector] Error handling visibility change:', err)
      } finally {
        releaseWakeLock()
      }
    }

    document.addEventListener('visibilitychange', handleVisibilityChange)

    return () => {
      document.removeEventListener('visibilitychange', handleVisibilityChange)
    }
  }, [status, notifySystemState])

  // Tauri-only: Listen for Rust-driven keepalive events
  // This is immune to WKWebView JS timer throttling that can suspend
  // timers when the app is on another virtual desktop
  useEffect(() => {
    if (!isTauri() || status !== 'online') return

    let unlisten: UnlistenFn | undefined
    let cleanedUp = false

    // Dynamic import to avoid loading Tauri APIs in web mode
    import('@tauri-apps/api/event').then(({ listen }) => {
      listen('xmpp-keepalive', () => {
        // Signal SDK to verify connection
        void notifySystemState('visible')
      }).then((fn) => {
        // If cleanup already ran, unlisten immediately
        if (cleanedUp) {
          fn()
        } else {
          unlisten = fn
        }
      })
    })

    return () => {
      cleanedUp = true
      unlisten?.()
    }
  }, [status, notifySystemState])
}
