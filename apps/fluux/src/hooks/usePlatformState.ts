import { useEffect, useRef, useCallback } from 'react'
import type { UnlistenFn } from '@tauri-apps/api/event'
import { useXMPP, useSystemState, usePresence, consoleStore } from '@fluux/sdk'
import { useConnectionStore } from '@fluux/sdk/react'
import { isTauri } from '../utils/tauri'
import { startWakeGracePeriod, startSyncGracePeriod } from '../utils/renderLoopDetector'

// ── Constants ──────────────────────────────────────────────────────────────────

/** Minimum time between activity events sent to SDK (ms). */
const ACTIVITY_THROTTLE_MS = 5000

/** Heartbeat interval for time-gap sleep detection (ms). */
const HEARTBEAT_INTERVAL_MS = 10_000

/** Minimum time gap to consider a real sleep/wake cycle (ms).
 *
 * Set to 3 minutes because macOS routinely throttles WebKit JS timers when
 * the app is on another virtual desktop or behind other windows, producing
 * gaps of 60–120s that are NOT real sleep.
 *
 * This same threshold also gates the Tauri webview reload on wake: any
 * confirmed sleep/wake ≥ 3 minutes is long enough for WKWebView to have
 * lost its rendering context (wry#184), so we force-reload the page and
 * let useSessionPersistence auto-reconnect from the stored session.
 * Short hides (lock screen under 3 min, alt-tab for a moment) don't
 * trigger a reload — those keep working through the normal reconnect
 * path. */
const SLEEP_THRESHOLD_MS = 180_000

/** Minimum time the page must be hidden before signaling SDK (ms).
 * Matches SLEEP_THRESHOLD_MS — same "real sleep vs timer throttling"
 * definition. */
const MIN_HIDDEN_TIME_MS = SLEEP_THRESHOLD_MS

/** Debounce window to prevent duplicate wake handling (ms). */
const WAKE_DEBOUNCE_MS = 2000

/** How long after a wake-triggered reload we treat additional wake
 * signals as redundant (ms).
 *
 * When a wake is big enough to require `window.location.reload()`, the
 * fresh webview takes real time to boot — 5-50s observed, dominated by
 * network re-establishment after sleep. During that window the OS
 * replays queued wake signals to the new React instance (the heartbeat
 * tick re-detects the same sleep gap, `system-did-wake` fires once the
 * JS engine resumes listening, visibility changes as the window is
 * reparented). Each of those signals would otherwise be treated as a
 * fresh wake and kick another reconnect or reload cycle.
 *
 * 60s covers the slowest reloads we've observed without being long
 * enough to swallow a genuinely new wake after the system briefly
 * slept again. */
const POST_RELOAD_COOLDOWN_MS = 60_000

/** localStorage key for the timestamp we last initiated
 * window.location.reload() from a wake handler. Read by the post-reload
 * instance on mount to recognize it was spawned by a wake the previous
 * instance already handled. */
export const RELOAD_MARKER_STORAGE_KEY = 'fluux.platformState.reloadInitiatedAt'

export function readReloadMarker(): number {
  try {
    if (typeof localStorage === 'undefined') return 0
    const raw = localStorage.getItem(RELOAD_MARKER_STORAGE_KEY)
    const parsed = raw ? Number(raw) : 0
    return Number.isFinite(parsed) ? parsed : 0
  } catch {
    return 0
  }
}

export function writeReloadMarker(ts: number): void {
  try {
    if (typeof localStorage === 'undefined') return
    localStorage.setItem(RELOAD_MARKER_STORAGE_KEY, String(ts))
  } catch {
    // Persistence is best-effort; if it fails we lose the cooldown
    // but the in-memory debounce still catches ms-level duplicates.
  }
}

export function clearReloadMarker(): void {
  try {
    if (typeof localStorage === 'undefined') return
    localStorage.removeItem(RELOAD_MARKER_STORAGE_KEY)
  } catch {
    // ignore
  }
}

/**
 * Decide whether a wake signal arrived inside the post-reload cooldown
 * and should be treated as a redundant echo of the wake that triggered
 * the reload.
 */
export function isWithinReloadCooldown(
  markerAt: number,
  nowMs: number,
  cooldownMs: number
): boolean {
  if (markerAt <= 0) return false
  const elapsed = nowMs - markerAt
  return elapsed >= 0 && elapsed < cooldownMs
}

/**
 * Proxy-close events should only trigger wake/reconnect while the app was
 * previously connected. Reconnect loops already manage backoff internally.
 */
export function shouldHandleProxyClosedStatus(status: string): boolean {
  return status === 'online'
}

/**
 * Payload for macOS `system-did-wake`. On other platforms the event carries
 * no payload; the field will be undefined and the wake is always handled.
 */
export interface SystemWakePayload {
  /** False on macOS DarkWake/PowerNap (display off); true or undefined otherwise. */
  displayActive?: boolean
}

/**
 * Decide whether to act on a wake event or drop it as a DarkWake.
 *
 * macOS wakes the system periodically so background daemons (Mail, iCloud,
 * Time Machine) can sync — the display stays off and the user isn't
 * present. The Rust side probes `CGDisplayIsAsleep` and sets
 * `displayActive=false` on those. We want to let the existing SM session
 * ride through instead of triggering a full reconnect + MAM catch-up
 * + webview reload that no one will see.
 *
 * When the payload is missing the field entirely (Linux/Windows, or an
 * older build) we default to handling the wake — losing a real wake is
 * much worse than doing unnecessary work on a dark one.
 */
export function shouldHandleDisplayWake(payload: SystemWakePayload | undefined): boolean {
  if (!payload) return true
  if (payload.displayActive === false) return false
  return true
}

/**
 * Decide whether a wake from sleep should reload the Tauri webview.
 *
 * Background: after a confirmed sleep/wake cycle the WRY/WKWebView on
 * macOS can lose its rendering context — the app window shows but the
 * content is blank (wry#184). The only reliable recovery is a full
 * `window.location.reload()`, which rebuilds the rendering pipeline;
 * `useSessionPersistence` then auto-reconnects from the stored session.
 *
 * Gating rules:
 * - Only in Tauri (the web browser path doesn't have this bug).
 * - Only when duration is ≥ SLEEP_THRESHOLD_MS, which is the project-wide
 *   threshold for "real sleep" vs "timer throttling / brief hide".
 * - Unknown duration → no reload (we can't tell if it was real sleep).
 *
 * Extracted as a pure function so it can be unit-tested without touching
 * `window.location.reload()` in jsdom.
 */
export function shouldReloadWebviewOnWake(
  durationMs: number | undefined,
  isTauriMode: boolean
): boolean {
  if (!isTauriMode) return false
  if (durationMs === undefined) return false
  return durationMs >= SLEEP_THRESHOLD_MS
}

/**
 * Decide whether a visibility-triggered wake should reload the webview.
 *
 * Unlike OS wake events (which are authoritative), the visibilitychange
 * API cannot distinguish "machine slept for 10 minutes" from "user was
 * in another app for 10 minutes while the machine stayed awake."
 *
 * We cross-check the JS heartbeat timer (Effect 3): if it was firing
 * normally, the gap between `now` and `lastHeartbeatRef` will be small
 * (≈ HEARTBEAT_INTERVAL_MS). A large gap (≥ SLEEP_THRESHOLD_MS) means
 * the OS froze JS execution — i.e. real sleep — and the rendering
 * context may be lost.
 */
export function shouldReloadOnVisibilityWake(
  hiddenDurationMs: number,
  heartbeatGapMs: number,
  isTauriMode: boolean
): boolean {
  if (!shouldReloadWebviewOnWake(hiddenDurationMs, isTauriMode)) return false
  if (heartbeatGapMs < SLEEP_THRESHOLD_MS) return false
  return true
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
        consoleStore.getState().addEvent('[idle] OS idle detection unavailable, using DOM fallback', 'presence')
      }
    }
    return unsupported
  }, [])

  /**
   * Check if a wake event should be processed.
   *
   * Two gates:
   *  1. Post-reload cooldown (localStorage-backed, survives reload).
   *     After a wake big enough to trigger window.location.reload(),
   *     the new instance ignores all wake signals for
   *     POST_RELOAD_COOLDOWN_MS — they're echoes of the wake the old
   *     instance already handled.
   *  2. Short in-memory debounce. Collapses simultaneous signals from
   *     independent sources (heartbeat + system-did-wake firing within
   *     the same event loop tick).
   */
  const shouldHandleWake = useCallback((source: string): boolean => {
    const now = Date.now()

    if (isWithinReloadCooldown(readReloadMarker(), now, POST_RELOAD_COOLDOWN_MS)) {
      consoleStore.getState().addEvent(
        `[${source}] Wake ignored: post-reload cooldown`,
        'presence'
      )
      return false
    }

    if (now - lastWakeTimeRef.current < WAKE_DEBOUNCE_MS) {
      return false
    }
    lastWakeTimeRef.current = now
    startWakeGracePeriod()
    consoleStore.getState().addEvent(`[${source}] Wake event accepted`, 'presence')
    return true
  }, [])

  /**
   * Decide whether to reload the Tauri webview on a wake event and do it.
   *
   * Returns true if a reload was triggered — caller should bail out of
   * any follow-up work, the page is going away.
   *
   * This is the single place in the hook that calls window.location.reload().
   * Splitting the reload decision from the "what to do instead" path keeps
   * each wake source in control of its own non-reload semantics (Tauri OS
   * wake + heartbeat want to signal 'awake' for state-machine verify;
   * visibility-change wants to signal 'visible' for reconnect nudge).
   */
  const maybeReloadOnLongWake = useCallback(
    (durationMs: number | undefined, source: string): boolean => {
      if (!shouldReloadWebviewOnWake(durationMs, isTauri())) return false
      const secs = Math.round((durationMs ?? 0) / 1000)
      console.log(`[PlatformState] Wake from sleep (${source}, ${secs}s), reloading webview to restore rendering`)
      logEvent(`Wake from sleep (${source}, ${secs}s), reloading webview`)
      // Persist the reload time BEFORE navigating away so the instance
      // that mounts after the reload sees it and ignores residual wake
      // signals (queued system-did-wake, first heartbeat tick, etc.)
      // for the duration of the cooldown window.
      writeReloadMarker(Date.now())
      window.location.reload()
      return true
    },
    [logEvent]
  )

  /**
   * Unified 'awake' wake handler shared by the Tauri native wake events
   * and the JS heartbeat fallback. Kept separate from the visibility
   * handler because visibility uses the lighter 'visible' nudge semantic.
   */
  const handleWakeFromSleep = useCallback(
    (durationMs: number | undefined, source: string): void => {
      const secs = durationMs !== undefined ? Math.round(durationMs / 1000) : undefined
      const message = secs !== undefined
        ? `System woke from sleep (${source}, ~${secs}s)`
        : `System woke from sleep (${source})`
      console.log(`[PlatformState] ${message}`)
      logEvent(message)
      if (maybeReloadOnLongWake(durationMs, source)) return
      client.notifySystemState('awake', durationMs).catch((err) => {
        console.error('[PlatformState] Error handling wake:', err)
      })
      lastActivityRef.current = Date.now()
    },
    [client, logEvent, maybeReloadOnLongWake]
  )

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
    if (statusRef.current !== 'online') return

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
          consoleStore.getState().addEvent(`[checkIdle] Tauri get_idle_time failed: ${err}, falling back to DOM`, 'presence')
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
      consoleStore.getState().addEvent(`[checkIdle] Idle time: ${idleSeconds}s / ${thresholdSeconds}s threshold (source: ${idleSource})`, 'presence')
    }

    if (idleMs >= autoAwayConfig.idleThresholdMs) {
      consoleStore.getState().addEvent(`Idle threshold reached (${idleSeconds}s), signaling SDK`, 'presence')
      const idleSince = new Date(Date.now() - idleMs)
      notifyIdle(idleSince)
    }
  }, [autoAwayConfig.enabled, autoAwayConfig.idleThresholdMs, notifyIdle, markOsIdleUnavailable])

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
    void checkIdle() // Initial check

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

    void import('@tauri-apps/api/event').then(({ listen }) => {
      // Immediate wake notification
      void listen<SystemWakePayload | undefined>('system-did-wake', (event) => {
        if (cancelled) return
        // DarkWake filter: when macOS wakes for background sync and the
        // display is still asleep, there's no user to receive the work.
        // Skip *before* the debounce so that if a real wake arrives
        // moments later, it still gets processed.
        if (!shouldHandleDisplayWake(event.payload)) {
          console.log('[PlatformState] Ignoring system-did-wake (display asleep / DarkWake)')
          logEvent('Ignored wake (display asleep / DarkWake)')
          return
        }
        if (!shouldHandleWake('system-did-wake')) return
        const sleepDuration = sleepStartRef.current ? Date.now() - sleepStartRef.current : undefined
        sleepStartRef.current = null
        handleWakeFromSleep(sleepDuration, 'system-did-wake')
      }).then(fn => {
        if (cancelled) { fn() } else { unlistenWake = fn }
      })

      // Deferred wake notification (app was in background during wake;
      // Tauri delivers the event with a delay measured in seconds).
      void listen<number>('system-did-wake-deferred', (event) => {
        if (cancelled) return
        const delaySecs = event.payload || 0
        if (!shouldHandleWake('system-did-wake-deferred')) return
        const sleepDuration = sleepStartRef.current ? Date.now() - sleepStartRef.current : undefined
        sleepStartRef.current = null
        handleWakeFromSleep(sleepDuration, `system-did-wake-deferred +${delaySecs}s`)
      }).then(fn => {
        if (cancelled) { fn() } else { unlistenWakeDeferred = fn }
      })

      // Sleep notification
      void listen('system-will-sleep', () => {
        if (cancelled) return
        sleepStartRef.current = Date.now()
        console.log('[PlatformState] Tauri system-will-sleep event received')
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
  }, [client, shouldHandleWake, logEvent, handleWakeFromSleep])

  // ── Effect 3: Time-gap wake detection (JS heartbeat) ──────────────────────
  // Also runs during 'reconnecting' status so we still update the heartbeat
  // reference while the machine is retrying. We do NOT re-kick a wake while
  // already reconnecting — the state machine owns that retry loop.

  useEffect(() => {
    if (status !== 'online' && status !== 'reconnecting') return

    const checkForWake = () => {
      const now = Date.now()
      const gap = now - lastHeartbeatRef.current
      lastHeartbeatRef.current = now

      if (gap < SLEEP_THRESHOLD_MS) return
      // Machine is already handling the reconnect with its own backoff +
      // the Rust keepalive nudge. Re-entering handleAwake() here would
      // cause overlapping cleanup + attemptReconnect sequences and a
      // render storm.
      if (statusRef.current === 'reconnecting') return
      if (!shouldHandleWake('time-gap')) return

      handleWakeFromSleep(gap, 'heartbeat')
    }

    const interval = setInterval(checkForWake, HEARTBEAT_INTERVAL_MS)

    return () => {
      clearInterval(interval)
    }
  }, [status, shouldHandleWake, handleWakeFromSleep])

  // ── Effect 4: Page visibility and window focus ──────────────────────────────
  // Runs during 'reconnecting' so window focus can still nudge a stalled
  // reconnect attempt to retry immediately when the user returns to the app.

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
      if (hiddenDuration < MIN_HIDDEN_TIME_MS && statusRef.current !== 'reconnecting') {
        return
      }

      if (!shouldHandleWake('visibility')) return

      const heartbeatGap = now - lastHeartbeatRef.current
      console.log(`[PlatformState] Page visible after ${Math.round(hiddenDuration / 1000)}s`)

      // If the hide was long enough to count as a real sleep on Tauri,
      // reload the webview (same rendering-context hazard as OS sleep).
      // Cross-check the JS heartbeat: if it was firing normally (gap
      // below threshold), the machine was awake and the app was merely
      // hidden — no rendering context loss, no reload needed.
      if (shouldReloadOnVisibilityWake(hiddenDuration, heartbeatGap, isTauri())) {
        const secs = Math.round(hiddenDuration / 1000)
        console.log(`[PlatformState] Wake from sleep (visibility, ${secs}s), reloading webview to restore rendering`)
        logEvent(`Wake from sleep (visibility, ${secs}s), reloading webview`)
        window.location.reload()
        return
      }

      // Sub-threshold, machine was awake, or web mode: just nudge a
      // stalled reconnect via notifySystemState('visible').
      try {
        await client.notifySystemState('visible')
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
  }, [status, client, shouldHandleWake, maybeReloadOnLongWake, logEvent])

  // ── Effect 5: Tauri native events (keepalive + proxy watchdog) ────────────

  useEffect(() => {
    if (!isTauri()) return

    let unlistenKeepalive: UnlistenFn | undefined
    let unlistenProxyClosed: UnlistenFn | undefined
    let cleanedUp = false

    void import('@tauri-apps/api/event').then(({ listen }) => {
      // Rust-driven keepalive tick every 30s. The SDK routes the tick
      // internally (nudge reconnect, health check, or no-op).
      void listen('xmpp-keepalive', () => {
        client.handleKeepaliveTick()
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
        let streamError = ''
        if (typeof payload === 'string') {
          reason = payload
        } else if (payload && typeof payload === 'object') {
          const record = payload as Record<string, unknown>
          if (typeof record.reason === 'string') reason = record.reason
          if (typeof record.conn_id === 'number') connId = String(record.conn_id)
          if (typeof record.connId === 'number') connId = String(record.connId)
          if (typeof record.stream_error === 'string') streamError = record.stream_error
        }
        // A relayed upstream stream-error (e.g. host-unknown) is the actionable
        // cause; show it alongside the transport reason.
        const detail = streamError ? `${reason}, stream-error=${streamError}` : reason
        console.log(
          `[PlatformState] Proxy connection closed (conn=${connId}, reason=${detail}, status=${currentStatus})`
        )
        // Surface the real cause in the in-app console so it lands in exported
        // diagnostics, not just devtools.
        consoleStore.getState().addEvent(`Proxy connection closed (${detail})`, 'connection')
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
      // Background sync (MAM, roster, rooms) causes many legitimate store
      // updates in the first seconds — raise the render loop error threshold
      // so the detector doesn't trigger on normal connection activity.
      startSyncGracePeriod()

      // Transition presence machine to connected state
      presenceConnect()

      // Check if user is active after connection established
      if (isTauri() && !osIdleUnavailableRef.current) {
        void import('@tauri-apps/api/core').then(({ invoke }) => {
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
