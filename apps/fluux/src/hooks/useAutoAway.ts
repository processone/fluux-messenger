import { useEffect, useRef, useCallback } from 'react'
import type { UnlistenFn } from '@tauri-apps/api/event'
import { useSystemState, usePresence, consoleStore } from '@fluux/sdk'
import { useConnectionStore } from '@fluux/sdk/react'
import { isWakeHandlingActive } from '@/utils/wakeCoordinator'

const isTauri = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window

/**
 * Minimum time between activity events sent to SDK (ms).
 */
const ACTIVITY_THROTTLE_MS = 5000

/**
 * Hook for platform-specific idle and wake detection.
 *
 * This hook handles platform detection and signals the SDK via useSystemState:
 * - Tauri: Uses OS-level idle time detection and system wake events
 * - Browser: Uses DOM activity events and Page Visibility API
 *
 * The SDK's presence machine handles all state transitions - this hook
 * just provides the platform-specific detection layer.
 *
 * ## Architecture
 *
 * ```
 * ┌─────────────────────────────────────────┐
 * │            useAutoAway (App)            │
 * │  - Platform detection only              │
 * │  - Tauri idle time, wake events         │
 * │  - Browser DOM events, visibility       │
 * └────────────────┬────────────────────────┘
 *                  │ notifyIdle/notifyActive/notifyWake
 *                  ▼
 * ┌─────────────────────────────────────────┐
 * │          useSystemState (SDK)           │
 * │  - Maps signals to presence events      │
 * │  - Handles connection verification      │
 * └────────────────┬────────────────────────┘
 *                  │ IDLE_DETECTED/ACTIVITY_DETECTED/etc.
 *                  ▼
 * ┌─────────────────────────────────────────┐
 * │       Presence Machine (SDK)            │
 * │  - State transitions                    │
 * │  - Auto-away logic                      │
 * └─────────────────────────────────────────┘
 * ```
 */
export function useAutoAway() {
  // Use focused selector to only subscribe to status, not all 12+ connection values
  // This prevents render loops when ownResources or other values change
  const status = useConnectionStore((s) => s.status)
  const {
    notifyIdle,
    notifyActive,
    notifyWake,
    notifySleep,
    autoAwayConfig,
  } = useSystemState()

  // Get connect/disconnect from usePresence to sync presence machine with connection status
  const { connect: presenceConnect, disconnect: presenceDisconnect } = usePresence()

  const lastActivityRef = useRef(Date.now())
  const lastActivityEventRef = useRef(0)

  // Helper to log events to the XMPP console
  const logEvent = useCallback((message: string) => {
    consoleStore.getState().addEvent(message, 'presence')
  }, [])

  /**
   * Handle activity detection - signal to SDK, throttled.
   */
  const handleActivity = useCallback(async () => {
    lastActivityRef.current = Date.now()

    // Throttle activity events
    const now = Date.now()
    if (now - lastActivityEventRef.current < ACTIVITY_THROTTLE_MS) {
      return
    }
    lastActivityEventRef.current = now

    // In Tauri, verify with OS idle time before signaling
    if (isTauri) {
      try {
        const { invoke } = await import('@tauri-apps/api/core')
        const idleSeconds = await invoke<number>('get_idle_time')
        if (idleSeconds >= 60) {
          // System says user is idle, ignore DOM event
          return
        }
      } catch {
        // Fall through and trust DOM event
      }
    }

    notifyActive()
  }, [notifyActive])

  /**
   * Check if user is idle and notify SDK.
   */
  const checkIdle = useCallback(async () => {
    if (!autoAwayConfig.enabled) return
    if (status !== 'online') return

    let idleMs: number
    let idleSource: string

    if (isTauri) {
      try {
        const { invoke } = await import('@tauri-apps/api/core')
        const idleSeconds = await invoke<number>('get_idle_time')
        idleMs = idleSeconds * 1000
        idleSource = 'OS'
      } catch (err) {
        idleMs = Date.now() - lastActivityRef.current
        idleSource = 'DOM (Tauri fallback)'
        logEvent(`[checkIdle] Tauri get_idle_time failed: ${err}, falling back to DOM`)
      }
    } else {
      idleMs = Date.now() - lastActivityRef.current
      idleSource = 'DOM'
    }

    // Debug log when approaching threshold
    const idleSeconds = Math.round(idleMs / 1000)
    const thresholdSeconds = autoAwayConfig.idleThresholdMs / 1000
    if (idleSeconds >= thresholdSeconds - 60) {
      logEvent(`[checkIdle] Idle time: ${idleSeconds}s / ${thresholdSeconds}s threshold (source: ${idleSource})`)
    }

    if (idleMs >= autoAwayConfig.idleThresholdMs) {
      logEvent(`Idle threshold reached (${idleSeconds}s), signaling SDK`)
      const idleSince = new Date(Date.now() - idleMs)
      notifyIdle(idleSince)
    }
  }, [status, notifyIdle, logEvent, autoAwayConfig])

  /**
   * Activity tracking and idle checking.
   */
  useEffect(() => {
    if (status !== 'online') return

    // Browser activity tracking
    const events = ['mousemove', 'keydown', 'mousedown', 'touchstart', 'scroll']
    events.forEach(event =>
      document.addEventListener(event, handleActivity, { passive: true })
    )

    // Visibility change - switching to tab indicates activity
    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible') {
        if (isWakeHandlingActive()) return
        void handleActivity()
      }
    }
    document.addEventListener('visibilitychange', handleVisibilityChange)

    // Periodic idle check
    const interval = setInterval(checkIdle, autoAwayConfig.checkIntervalMs)
    checkIdle() // Initial check

    return () => {
      events.forEach(event =>
        document.removeEventListener(event, handleActivity)
      )
      document.removeEventListener('visibilitychange', handleVisibilityChange)
      clearInterval(interval)
    }
  }, [status, handleActivity, checkIdle, autoAwayConfig.checkIntervalMs])

  /**
   * Wake detection: OS notification in Tauri only.
   * Time-gap based wake detection is handled by useWakeDetector hook.
   *
   * We listen for two events:
   * 1. system-did-wake: Immediate wake notification (works when app is in foreground)
   * 2. system-did-wake-deferred: Deferred wake notification when app becomes active
   *    (handles the case where app was in background during wake)
   */
  useEffect(() => {
    if (!isTauri || status !== 'online') return

    let cancelled = false
    let unlistenImmediate: UnlistenFn | undefined
    let unlistenDeferred: UnlistenFn | undefined

    import('@tauri-apps/api/event').then(({ listen }) => {
      // Immediate wake notification (when app is in foreground)
      listen('system-did-wake', () => {
        if (cancelled) return
        logEvent('System woke from sleep (OS notification)')
        notifyWake()
        lastActivityRef.current = Date.now()
      }).then(fn => {
        if (cancelled) {
          fn()
        } else {
          unlistenImmediate = fn
        }
      })

      // Deferred wake notification (when app was in background during wake)
      // The payload is the number of seconds the wake was delayed
      listen<number>('system-did-wake-deferred', (event) => {
        if (cancelled) return
        const delaySecs = event.payload || 0
        logEvent(`System woke from sleep (deferred ${delaySecs}s - app was in background)`)
        notifyWake()
        lastActivityRef.current = Date.now()
      }).then(fn => {
        if (cancelled) {
          fn()
        } else {
          unlistenDeferred = fn
        }
      })
    })

    return () => {
      cancelled = true
      if (unlistenImmediate) unlistenImmediate()
      if (unlistenDeferred) unlistenDeferred()
    }
  }, [status, notifyWake, logEvent])

  /**
   * Sleep detection: Tauri only (browser doesn't have reliable sleep detection).
   */
  useEffect(() => {
    if (!isTauri || status !== 'online') return

    let cancelled = false
    let unlisten: UnlistenFn | undefined

    import('@tauri-apps/api/event').then(({ listen }) => {
      listen('system-will-sleep', () => {
        if (cancelled) return
        logEvent('System going to sleep')
        notifySleep()
      }).then(fn => {
        if (cancelled) {
          fn()
        } else {
          unlisten = fn
        }
      })
    })

    return () => {
      cancelled = true
      if (unlisten) unlisten()
    }
  }, [status, notifySleep, logEvent])

  /**
   * Sync presence machine with connection status.
   * This ensures the presence machine transitions to connected/disconnected
   * when the XMPP connection status changes.
   */
  useEffect(() => {
    if (status === 'online') {
      // Transition presence machine to connected state
      presenceConnect()

      // When connection is established, check if user is active and notify machine.
      // This handles reconnection after sleep/network issues.
      if (isTauri) {
        import('@tauri-apps/api/core').then(({ invoke }) => {
          invoke<number>('get_idle_time').then((idleSeconds) => {
            if (idleSeconds < 60) {
              logEvent(`Connection restored, user active (${idleSeconds}s idle)`)
              notifyActive()
            } else {
              logEvent(`Connection restored, user idle (${idleSeconds}s)`)
            }
          }).catch(() => {
            logEvent('Connection restored, triggering activity (idle check failed)')
            notifyActive()
          })
        })
      } else {
        // Web browser: assume user is active on reconnect
        logEvent('Connection restored (web), notifying activity')
        setTimeout(() => notifyActive(), 100)
      }
    } else if (status === 'disconnected' || status === 'error') {
      presenceDisconnect()
    }
  }, [status, presenceConnect, presenceDisconnect, notifyActive, logEvent])
}
