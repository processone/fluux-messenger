import { useEffect, useRef, useCallback } from 'react'
import type { UnlistenFn } from '@tauri-apps/api/event'
import { useXMPP, useSystemState, usePresence, consoleStore } from '@fluux/sdk'
import { useConnectionStore } from '@fluux/sdk/react'
import { isTauri } from '../utils/tauri'
import { startWakeGracePeriod } from '../utils/renderLoopDetector'

// ── Constants ──────────────────────────────────────────────────────────────────

/** Minimum time between activity events sent to SDK (ms). */
const ACTIVITY_THROTTLE_MS = 5000

/** Heartbeat interval for time-gap sleep detection (ms). */
const HEARTBEAT_INTERVAL_MS = 10_000

/** Minimum time gap to consider as system sleep (ms). */
const SLEEP_THRESHOLD_MS = 30_000

/** Minimum time the page must be hidden before signaling SDK (ms). */
const MIN_HIDDEN_TIME_MS = 60_000

/** Debounce window to prevent duplicate wake handling (ms). */
const WAKE_DEBOUNCE_MS = 2000

// ── Hook ───────────────────────────────────────────────────────────────────────

/**
 * Unified platform state detection hook.
 *
 * Detects all platform events (wake, sleep, idle, activity, visibility) and
 * signals the SDK through two clean interfaces:
 * - `client.notifySystemState()` — for connection + presence orchestration
 * - `useSystemState()` — for presence-only signals (idle, active)
 *
 * Replaces the former useAutoAway + useWakeDetector + useSleepDetector hooks
 * and the wakeCoordinator utility.
 */
export function usePlatformState() {
  const status = useConnectionStore((s) => s.status)
  const { client } = useXMPP()
  const { notifyIdle, notifyActive, autoAwayConfig } = useSystemState()
  const { connect: presenceConnect, disconnect: presenceDisconnect } = usePresence()

  // ── Refs ──────────────────────────────────────────────────────────────────

  const lastActivityRef = useRef(Date.now())
  const lastActivityEventRef = useRef(0)
  const lastWakeTimeRef = useRef(0)
  const hiddenAtRef = useRef<number | null>(null)
  const lastHeartbeatRef = useRef(Date.now())
  const sleepStartRef = useRef<number | null>(null)

  // ── Helpers ───────────────────────────────────────────────────────────────

  const logEvent = useCallback((message: string) => {
    consoleStore.getState().addEvent(message, 'presence')
  }, [])

  /**
   * Check if a wake event should be processed (debounce).
   * Returns true and updates lastWakeTime if the event should be handled.
   */
  const shouldHandleWake = useCallback((source: string): boolean => {
    const now = Date.now()
    if (now - lastWakeTimeRef.current < WAKE_DEBOUNCE_MS) {
      return false
    }
    lastWakeTimeRef.current = now
    startWakeGracePeriod()
    logEvent(`[${source}] Wake event accepted`)
    return true
  }, [logEvent])

  /**
   * Dispatch CSS resize workaround for WebKit layout corruption after wake.
   */
  const dispatchResizeWorkaround = useCallback(() => {
    requestAnimationFrame(() => {
      window.dispatchEvent(new Event('resize'))
    })
  }, [])

  /**
   * Handle user activity — signals SDK, throttled to avoid flooding.
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
    if (isTauri()) {
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

    if (isTauri()) {
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

  // ── Effect 1: Activity tracking + idle checking ───────────────────────────

  useEffect(() => {
    if (status !== 'online') return

    // DOM activity listeners
    const events = ['mousemove', 'keydown', 'mousedown', 'touchstart', 'scroll']
    events.forEach(event =>
      document.addEventListener(event, handleActivity, { passive: true })
    )

    // Visibility change — switching to tab indicates activity
    const handleVisibilityForActivity = () => {
      if (document.visibilityState === 'visible') {
        // Skip if a wake event is being handled (debounce window active)
        if (Date.now() - lastWakeTimeRef.current < WAKE_DEBOUNCE_MS) return
        void handleActivity()
      }
    }
    document.addEventListener('visibilitychange', handleVisibilityForActivity)

    // Periodic idle check
    const interval = setInterval(checkIdle, autoAwayConfig.checkIntervalMs)
    checkIdle() // Initial check

    return () => {
      events.forEach(event =>
        document.removeEventListener(event, handleActivity)
      )
      document.removeEventListener('visibilitychange', handleVisibilityForActivity)
      clearInterval(interval)
    }
  }, [status, handleActivity, checkIdle, autoAwayConfig.checkIntervalMs])

  // ── Effect 2: Tauri OS wake/sleep events ──────────────────────────────────
  // No status dependency — listeners stay registered to catch wake even during
  // reconnection. client.notifySystemState() checks connection state internally.

  useEffect(() => {
    if (!isTauri()) return

    let cancelled = false
    let unlistenWake: UnlistenFn | undefined
    let unlistenWakeDeferred: UnlistenFn | undefined
    let unlistenSleep: UnlistenFn | undefined

    import('@tauri-apps/api/event').then(({ listen }) => {
      // Immediate wake notification
      listen('system-did-wake', () => {
        if (cancelled) return
        if (!shouldHandleWake('system-did-wake')) return
        const sleepDuration = sleepStartRef.current ? Date.now() - sleepStartRef.current : undefined
        sleepStartRef.current = null
        logEvent(`System woke from sleep (OS notification${sleepDuration ? `, ~${Math.round(sleepDuration / 1000)}s` : ''})`)
        client.notifySystemState('awake', sleepDuration).catch(() => {})
        lastActivityRef.current = Date.now()
        dispatchResizeWorkaround()
      }).then(fn => {
        if (cancelled) { fn() } else { unlistenWake = fn }
      })

      // Deferred wake notification (app was in background during wake)
      listen<number>('system-did-wake-deferred', (event) => {
        if (cancelled) return
        if (!shouldHandleWake('system-did-wake-deferred')) return
        const sleepDuration = sleepStartRef.current ? Date.now() - sleepStartRef.current : undefined
        sleepStartRef.current = null
        const delaySecs = event.payload || 0
        logEvent(`System woke from sleep (deferred ${delaySecs}s - app was in background${sleepDuration ? `, ~${Math.round(sleepDuration / 1000)}s sleep` : ''})`)
        client.notifySystemState('awake', sleepDuration).catch(() => {})
        lastActivityRef.current = Date.now()
        dispatchResizeWorkaround()
      }).then(fn => {
        if (cancelled) { fn() } else { unlistenWakeDeferred = fn }
      })

      // Sleep notification
      listen('system-will-sleep', () => {
        if (cancelled) return
        sleepStartRef.current = Date.now()
        logEvent('System going to sleep')
        client.notifySystemState('sleeping').catch(() => {})
      }).then(fn => {
        if (cancelled) { fn() } else { unlistenSleep = fn }
      })
    })

    return () => {
      cancelled = true
      unlistenWake?.()
      unlistenWakeDeferred?.()
      unlistenSleep?.()
    }
  }, [client, shouldHandleWake, logEvent, dispatchResizeWorkaround])

  // ── Effect 3: Time-gap wake detection (JS heartbeat) ──────────────────────

  useEffect(() => {
    if (status !== 'online' && status !== 'reconnecting') return

    const checkForWake = async () => {
      const now = Date.now()
      const gap = now - lastHeartbeatRef.current
      lastHeartbeatRef.current = now

      if (gap < SLEEP_THRESHOLD_MS) return
      if (!shouldHandleWake('time-gap')) return

      const gapSeconds = Math.round(gap / 1000)
      console.log(`[PlatformState] Detected wake from sleep (${gapSeconds}s gap)`)

      try {
        await client.notifySystemState('awake', gap)
        dispatchResizeWorkaround()
      } catch (err) {
        console.error('[PlatformState] Error handling wake:', err)
      }
    }

    const interval = setInterval(checkForWake, HEARTBEAT_INTERVAL_MS)

    return () => {
      clearInterval(interval)
    }
  }, [status, client, shouldHandleWake, dispatchResizeWorkaround])

  // ── Effect 4: Page visibility change ──────────────────────────────────────

  useEffect(() => {
    if (status !== 'online' && status !== 'reconnecting') return

    const handleVisibilityChange = async () => {
      if (document.hidden) {
        hiddenAtRef.current = Date.now()
        try {
          await client.notifySystemState('hidden')
        } catch {
          // Ignore — socket may already be dead
        }
        return
      }

      // Page became visible
      const now = Date.now()
      const hiddenDuration = hiddenAtRef.current ? now - hiddenAtRef.current : 0
      hiddenAtRef.current = null

      // Skip if not hidden long enough (brief tab switches)
      // But always notify when reconnecting (timers may have been suspended)
      if (hiddenDuration < MIN_HIDDEN_TIME_MS && status !== 'reconnecting') {
        return
      }

      if (!shouldHandleWake('visibility')) return

      console.log(`[PlatformState] Page visible after ${Math.round(hiddenDuration / 1000)}s`)
      try {
        await client.notifySystemState('visible')
        dispatchResizeWorkaround()
      } catch (err) {
        console.error('[PlatformState] Error handling visibility change:', err)
      }
    }

    document.addEventListener('visibilitychange', handleVisibilityChange)

    return () => {
      document.removeEventListener('visibilitychange', handleVisibilityChange)
    }
  }, [status, client, shouldHandleWake, dispatchResizeWorkaround])

  // ── Effect 5: Tauri native events (keepalive + proxy watchdog) ────────────

  useEffect(() => {
    if (!isTauri() || status !== 'online') return

    let unlistenKeepalive: UnlistenFn | undefined
    let unlistenProxyClosed: UnlistenFn | undefined
    let cleanedUp = false

    void import('@tauri-apps/api/event').then(({ listen }) => {
      // Keepalive: verify connection health every 30s (Rust-driven, immune to JS throttling)
      void listen('xmpp-keepalive', () => {
        if (!shouldHandleWake('keepalive')) return
        client.notifySystemState('awake')
          .catch((err) => {
            console.debug('[PlatformState] Error on keepalive notification:', err)
          })
      }).then((fn) => {
        if (cleanedUp) { fn() } else { unlistenKeepalive = fn }
      })

      // Proxy watchdog detected dead connection
      void listen('proxy-connection-closed', () => {
        console.log('[PlatformState] Proxy connection closed by watchdog, triggering reconnect')
        if (!shouldHandleWake('proxy-closed')) return
        client.notifySystemState('awake')
          .catch((err) => {
            console.debug('[PlatformState] Error on proxy-closed notification:', err)
          })
      }).then((fn) => {
        if (cleanedUp) { fn() } else { unlistenProxyClosed = fn }
      })
    })

    return () => {
      cleanedUp = true
      unlistenKeepalive?.()
      unlistenProxyClosed?.()
    }
  }, [status, client, shouldHandleWake])

  // ── Effect 6: Presence machine sync with connection status ────────────────

  useEffect(() => {
    if (status === 'online') {
      // Transition presence machine to connected state
      presenceConnect()

      // Check if user is active after connection established
      if (isTauri()) {
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
