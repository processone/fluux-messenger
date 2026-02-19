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

/**
 * Proxy-close events should only trigger wake/reconnect while the app was
 * previously connected. Reconnect loops already manage backoff internally.
 */
export function shouldHandleProxyClosedStatus(status: string): boolean {
  return status === 'online' || status === 'verifying'
}

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
  const statusRef = useRef(status)
  const osIdleUnavailableRef = useRef(false)
  const osIdleUnavailableLoggedRef = useRef(false)

  useEffect(() => {
    statusRef.current = status
  }, [status])

  // ── Helpers ───────────────────────────────────────────────────────────────

  const logEvent = useCallback((message: string) => {
    consoleStore.getState().addEvent(message, 'presence')
  }, [])

  const markOsIdleUnavailable = useCallback((err: unknown): boolean => {
    const message = err instanceof Error ? err.message : String(err)
    const unsupported = message.includes('Linux idle detection unavailable')
      || message.includes('MIT-SCREEN-SAVER')
      || message.includes('XScreenSaver')
    if (unsupported) {
      osIdleUnavailableRef.current = true
      if (!osIdleUnavailableLoggedRef.current) {
        osIdleUnavailableLoggedRef.current = true
        logEvent('[idle] OS idle detection unavailable, using DOM fallback')
      }
    }
    return unsupported
  }, [logEvent])

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
    if (isTauri() && !osIdleUnavailableRef.current) {
      try {
        const { invoke } = await import('@tauri-apps/api/core')
        const idleSeconds = await invoke<number>('get_idle_time')
        if (idleSeconds >= 60) {
          // System says user is idle, ignore DOM event
          return
        }
      } catch (err) {
        markOsIdleUnavailable(err)
        // Fall through and trust DOM event
      }
    }

    notifyActive()
  }, [notifyActive, markOsIdleUnavailable])

  /**
   * Check if user is idle and notify SDK.
   */
  const checkIdle = useCallback(async () => {
    if (!autoAwayConfig.enabled) return
    if (status !== 'online') return

    let idleMs: number
    let idleSource: string

    if (isTauri() && !osIdleUnavailableRef.current) {
      try {
        const { invoke } = await import('@tauri-apps/api/core')
        const idleSeconds = await invoke<number>('get_idle_time')
        idleMs = idleSeconds * 1000
        idleSource = 'OS'
      } catch (err) {
        idleMs = Date.now() - lastActivityRef.current
        const unsupported = markOsIdleUnavailable(err)
        idleSource = unsupported ? 'DOM (Tauri fallback cached)' : 'DOM (Tauri fallback)'
        if (!unsupported) {
          logEvent(`[checkIdle] Tauri get_idle_time failed: ${err}, falling back to DOM`)
        }
      }
    } else if (isTauri()) {
      idleMs = Date.now() - lastActivityRef.current
      idleSource = 'DOM (Tauri fallback cached)'
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
  }, [status, notifyIdle, logEvent, autoAwayConfig, markOsIdleUnavailable])

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
        console.log('[PlatformState] Tauri system-did-wake event received')
        if (!shouldHandleWake('system-did-wake')) return
        const sleepDuration = sleepStartRef.current ? Date.now() - sleepStartRef.current : undefined
        sleepStartRef.current = null
        console.log(`[PlatformState] System woke from sleep (OS notification${sleepDuration ? `, ~${Math.round(sleepDuration / 1000)}s` : ''})`)
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
        const delaySecs = event.payload || 0
        console.log(`[PlatformState] Tauri system-did-wake-deferred event received (delay=${delaySecs}s)`)
        if (!shouldHandleWake('system-did-wake-deferred')) return
        const sleepDuration = sleepStartRef.current ? Date.now() - sleepStartRef.current : undefined
        sleepStartRef.current = null
        console.log(`[PlatformState] System woke from sleep (deferred ${delaySecs}s${sleepDuration ? `, ~${Math.round(sleepDuration / 1000)}s sleep` : ''})`)
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
        console.log('[PlatformState] Tauri system-will-sleep event received')
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
  // Also runs during 'connecting' status: when a reconnect attempt is in
  // progress (reconnecting.attempting → status 'connecting'), macOS may freeze
  // JS. Without 'connecting', the heartbeat would be torn down and couldn't
  // detect sleep gaps that occur mid-reconnect.

  useEffect(() => {
    if (status !== 'online' && status !== 'reconnecting' && status !== 'connecting') return

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

  // ── Effect 4: Page visibility and window focus ──────────────────────────────
  // Also runs during 'connecting' status: when reconnecting.attempting starts,
  // status becomes 'connecting' and macOS may freeze JS. Without 'connecting'
  // here, the focus listener would be torn down and couldn't trigger reconnect
  // when the user returns to the app.

  useEffect(() => {
    if (status !== 'online' && status !== 'reconnecting' && status !== 'connecting') return

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
      if (hiddenDuration < MIN_HIDDEN_TIME_MS && statusRef.current !== 'reconnecting') {
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

    // Window focus: fires when user clicks the app window, Cmd+Tabs to it, or
    // clicks the Dock icon. Unlike visibilitychange, this fires even when the
    // page was never hidden (e.g., app was just behind another window).
    // This is critical for macOS: when the app is reconnecting and JS timers
    // are frozen by the OS, gaining focus unfreezes JS and this handler
    // immediately triggers the stalled reconnect.
    const handleWindowFocus = () => {
      if (statusRef.current !== 'reconnecting') return
      if (!shouldHandleWake('window-focus')) return

      console.log('[PlatformState] Window focused while reconnecting, triggering reconnect')
      client.notifySystemState('visible').catch((err) => {
        console.error('[PlatformState] Error handling window focus:', err)
      })
    }

    document.addEventListener('visibilitychange', handleVisibilityChange)
    window.addEventListener('focus', handleWindowFocus)

    return () => {
      document.removeEventListener('visibilitychange', handleVisibilityChange)
      window.removeEventListener('focus', handleWindowFocus)
    }
  }, [status, client, shouldHandleWake, dispatchResizeWorkaround])

  // ── Effect 5: Tauri native events (keepalive + proxy watchdog) ────────────

  useEffect(() => {
    if (!isTauri()) return

    let unlistenKeepalive: UnlistenFn | undefined
    let unlistenProxyClosed: UnlistenFn | undefined
    let cleanedUp = false

    void import('@tauri-apps/api/event').then(({ listen }) => {
      // Keepalive: lightweight connection health check every 30s (Rust-driven, immune to JS throttling).
      // Uses verifyConnectionHealth() which silently sends SM <r/> without changing status.
      void listen('xmpp-keepalive', () => {
        if (statusRef.current !== 'online') return
        client.verifyConnectionHealth()
          .catch((err) => {
            console.debug('[PlatformState] Keepalive health check error:', err)
          })
      }).then((fn) => {
        if (cleanedUp) { fn() } else { unlistenKeepalive = fn }
      })

      // Proxy watchdog detected dead connection
      void listen('proxy-connection-closed', (event) => {
        const currentStatus = statusRef.current
        if (!shouldHandleProxyClosedStatus(currentStatus)) return
        const payload = event.payload as unknown
        let reason = 'unknown'
        let connId = 'unknown'
        if (typeof payload === 'string') {
          reason = payload
        } else if (payload && typeof payload === 'object') {
          const record = payload as Record<string, unknown>
          if (typeof record.reason === 'string') reason = record.reason
          if (typeof record.conn_id === 'number') connId = String(record.conn_id)
          if (typeof record.connId === 'number') connId = String(record.connId)
        }
        console.log(
          `[PlatformState] Proxy connection closed (conn=${connId}, reason=${reason}, status=${currentStatus})`
        )
      }).then((fn) => {
        if (cleanedUp) { fn() } else { unlistenProxyClosed = fn }
      })
    })

    return () => {
      cleanedUp = true
      unlistenKeepalive?.()
      unlistenProxyClosed?.()
    }
  }, [client])

  // ── Effect 6: Presence machine sync with connection status ────────────────

  useEffect(() => {
    if (status === 'online') {
      // Transition presence machine to connected state
      presenceConnect()

      // Check if user is active after connection established
      if (isTauri() && !osIdleUnavailableRef.current) {
        import('@tauri-apps/api/core').then(({ invoke }) => {
          invoke<number>('get_idle_time').then((idleSeconds) => {
            if (idleSeconds < 60) {
              logEvent(`Connection restored, user active (${idleSeconds}s idle)`)
              notifyActive()
            } else {
              logEvent(`Connection restored, user idle (${idleSeconds}s)`)
            }
          }).catch((err) => {
            const unsupported = markOsIdleUnavailable(err)
            logEvent(
              unsupported
                ? 'Connection restored, OS idle unavailable (DOM fallback), triggering activity'
                : 'Connection restored, triggering activity (idle check failed)'
            )
            notifyActive()
          })
        })
      } else if (isTauri()) {
        logEvent('Connection restored, OS idle unavailable (DOM fallback), triggering activity')
        notifyActive()
      } else {
        // Web browser: assume user is active on reconnect
        logEvent('Connection restored (web), notifying activity')
        setTimeout(() => notifyActive(), 100)
      }
    } else if (status === 'disconnected' || status === 'error') {
      presenceDisconnect()
    }
  }, [status, presenceConnect, presenceDisconnect, notifyActive, logEvent, markOsIdleUnavailable])
}
