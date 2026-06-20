/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'

// Hoisted mocks/state so vi.mock factories can reference them
const {
  mockNotifyIdle,
  mockNotifyActive,
  mockNotifySystemState,
  mockPresenceConnect,
  mockPresenceDisconnect,
  mockClientNotifySystemState,
  mockClientNudgeReconnect,
  mockClientVerifyConnectionHealth,
  mockClientHandleKeepaliveTick,
  mockGetReconnectIntent,
  mockConnectionStatus,
  tauriListeners,
  mockListen,
  tauriIpc,
  tauriEventPluginInternals,
} = vi.hoisted(() => {
  // Tauri event bus emulation.
  //
  // The hook subscribes via `await import('@tauri-apps/api/event')` inside an
  // effect. Vitest's `vi.mock('@tauri-apps/api/event')` factory does NOT
  // intercept that dynamic import in this file (it resolves the real module),
  // but the real `listen()` is built on `@tauri-apps/api/core`'s `invoke` +
  // `transformCallback`. We mock *core* with a faithful IPC stub that routes
  // `plugin:event|listen` into `tauriListeners`, so a real `listen()` call
  // still ends up captured here regardless of which `event` module the hook
  // got. `tauriListeners.get(name)!({ payload })` then drives the handler.
  const listeners = new Map<string, (event?: { payload?: unknown }) => unknown>()
  let nextCallbackId = 1
  const callbacks = new Map<number, (raw: unknown) => void>()
  const ipc = {
    transformCallback(cb: (raw: unknown) => void): number {
      const id = nextCallbackId++
      callbacks.set(id, cb)
      return id
    },
    invoke(cmd: string, args?: Record<string, unknown>): Promise<unknown> {
      if (cmd === 'plugin:event|listen') {
        const event = String(args?.event)
        const handlerId = args?.handler as number
        const cb = callbacks.get(handlerId)
        // The real backend invokes the transformed callback with the full
        // event object; `listen()` forwards it straight to the user handler,
        // so our captured handler accepts `{ payload }`.
        listeners.set(event, (e?: { payload?: unknown }) => {
          cb?.({ event, id: handlerId, payload: e?.payload })
        })
        return Promise.resolve(handlerId)
      }
      if (cmd === 'plugin:event|unlisten') {
        // We only ever register one handler per event name in these tests.
        return Promise.resolve()
      }
      // Other commands (e.g. get_idle_time) — default to a benign value.
      return Promise.resolve(0)
    },
    unregisterCallback(id: number): void {
      callbacks.delete(id)
    },
  }
  // The real `@tauri-apps/api/event` `_unlisten()` (run on effect cleanup)
  // calls `window.__TAURI_EVENT_PLUGIN_INTERNALS__.unregisterListener`.
  const eventPluginInternals = {
    unregisterListener(_event: string, _eventId: number): void {
      // No-op: tests re-register per render; `tauriListeners` is cleared in
      // the global beforeEach.
    },
  }
  return {
    mockNotifyIdle: vi.fn(),
    mockNotifyActive: vi.fn(),
    mockNotifySystemState: vi.fn(),
    mockPresenceConnect: vi.fn(),
    mockPresenceDisconnect: vi.fn(),
    mockClientNotifySystemState: vi.fn().mockResolvedValue(undefined),
    mockClientNudgeReconnect: vi.fn(),
    mockClientVerifyConnectionHealth: vi.fn().mockResolvedValue(undefined),
    mockClientHandleKeepaliveTick: vi.fn(),
    mockGetReconnectIntent: vi.fn(() => 'active' as 'active' | 'logged-out'),
    mockConnectionStatus: { current: 'online' },
    tauriListeners: listeners,
    tauriIpc: ipc,
    tauriEventPluginInternals: eventPluginInternals,
    mockListen: vi.fn((event: string, handler: (event?: { payload?: unknown }) => unknown) => {
      listeners.set(event, handler)
      return Promise.resolve(() => {
        if (listeners.get(event) === handler) {
          listeners.delete(event)
        }
      })
    }),
  }
})

/** Install the functional Tauri IPC stub so `isTauri()` is true and the real
 *  `listen()` routes through `tauriListeners`. Mirrors what a real Tauri
 *  webview injects on `window`. */
function installTauriIpc() {
  ;(window as any).__TAURI_INTERNALS__ = tauriIpc
  ;(window as any).__TAURI_EVENT_PLUGIN_INTERNALS__ = tauriEventPluginInternals
}

// Mock Tauri APIs. core is mocked with the functional IPC stub so the real
// event module (reached by the hook's dynamic import) still works.
vi.mock('@tauri-apps/api/core', () => ({
  invoke: (cmd: string, args?: Record<string, unknown>) => tauriIpc.invoke(cmd, args),
  transformCallback: (cb: (raw: unknown) => void) => tauriIpc.transformCallback(cb),
}))

vi.mock('@tauri-apps/api/event', () => ({
  listen: mockListen,
}))

vi.mock('@/utils/renderLoopDetector', () => ({
  startWakeGracePeriod: vi.fn(),
  startSyncGracePeriod: vi.fn(),
}))

vi.mock('@fluux/sdk/react', () => ({
  useConnectionStore: (selector: (state: { status: string }) => string) =>
    selector({ status: mockConnectionStatus.current }),
  useContactTime: () => null, useLastActivity: vi.fn(),
}))

vi.mock('@fluux/sdk', () => ({
  useXMPP: () => ({
    client: {
      notifySystemState: mockClientNotifySystemState,
      nudgeReconnect: mockClientNudgeReconnect,
      verifyConnectionHealth: mockClientVerifyConnectionHealth,
      handleKeepaliveTick: mockClientHandleKeepaliveTick,
    },
  }),
  useSystemState: () => ({
    notifyIdle: mockNotifyIdle,
    notifyActive: mockNotifyActive,
    notifySystemState: mockNotifySystemState,
    autoAwayConfig: {
      enabled: true,
      idleThresholdMs: 5 * 60 * 1000,
      checkIntervalMs: 30 * 1000,
    },
  }),
  usePresence: () => ({
    connect: mockPresenceConnect,
    disconnect: mockPresenceDisconnect,
  }),
  consoleStore: {
    getState: () => ({
      addEvent: vi.fn(),
    }),
  },
}))

vi.mock('@/utils/reconnectIntent', () => ({
  getReconnectIntent: () => mockGetReconnectIntent(),
}))

// Import after mocks are set up
import {
  usePlatformState,
  shouldHandleProxyClosedStatus,
  shouldHandleDisplayWake,
  shouldReloadWebviewOnWake,
  shouldReloadOnVisibilityWake,
  readReloadMarker,
  writeReloadMarker,
  clearReloadMarker,
  isWithinReloadCooldown,
  RELOAD_MARKER_STORAGE_KEY,
  parseKeepalivePayload,
  shouldRunKeepaliveReconnect,
  isKeepaliveWakeTick,
} from './usePlatformState'

describe('usePlatformState', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.useFakeTimers()
    mockConnectionStatus.current = 'online'
    tauriListeners.clear()
    // Default to web mode (isTauri() === false): the activity/idle tests rely
    // on it. Tauri-mode describe blocks call installTauriIpc() to flip it on.
    delete (window as any).__TAURI_INTERNALS__
    // The event-plugin internals stay installed for the whole file so the real
    // `_unlisten()` (run async on effect cleanup) never reads an undefined
    // global and rejects.
    ;(window as any).__TAURI_EVENT_PLUGIN_INTERNALS__ = tauriEventPluginInternals
  })

  afterEach(() => {
    vi.useRealTimers()
    // Point __TAURI_INTERNALS__ at the functional IPC stub so any pending async
    // effect cleanup (real `@tauri-apps/api/event` `_unlisten()` → core.invoke,
    // which runs during testing-library's unmount AFTER this hook) finds a
    // working `invoke` instead of throwing on an undefined global.
    ;(window as any).__TAURI_INTERNALS__ = tauriIpc
  })

  describe('activity detection', () => {
    it('should notify SDK when activity detected', async () => {
      renderHook(() => usePlatformState())

      await act(async () => {
        document.dispatchEvent(new MouseEvent('mousemove'))
        await Promise.resolve()
      })

      expect(mockNotifyActive).toHaveBeenCalled()
    })

    it('should respond to all tracked activity events', async () => {
      renderHook(() => usePlatformState())

      const events = ['mousemove', 'keydown', 'mousedown', 'touchstart', 'scroll']

      for (const eventType of events) {
        vi.clearAllMocks()

        // Advance time beyond throttle window (5s) between events
        await act(async () => {
          vi.advanceTimersByTime(6000)
        })

        await act(async () => {
          document.dispatchEvent(new Event(eventType))
          await Promise.resolve()
        })

        expect(mockNotifyActive).toHaveBeenCalled()
      }
    })

    it('should throttle activity events to avoid flooding the SDK', async () => {
      renderHook(() => usePlatformState())

      // Flush any pending timers from mount effects (connection sync calls notifyActive after 100ms)
      await act(async () => {
        vi.advanceTimersByTime(200)
        await Promise.resolve()
      })
      vi.clearAllMocks()

      // First event should trigger notifyActive
      await act(async () => {
        document.dispatchEvent(new MouseEvent('mousemove'))
        await Promise.resolve()
      })
      expect(mockNotifyActive).toHaveBeenCalledTimes(1)

      // Rapid subsequent events within throttle window should NOT trigger
      vi.clearAllMocks()
      for (let i = 0; i < 10; i++) {
        await act(async () => {
          vi.advanceTimersByTime(100)
          document.dispatchEvent(new MouseEvent('mousemove'))
          await Promise.resolve()
        })
      }
      expect(mockNotifyActive).not.toHaveBeenCalled()

      // After throttle window expires, next event should trigger
      vi.clearAllMocks()
      await act(async () => {
        vi.advanceTimersByTime(5000)
        document.dispatchEvent(new MouseEvent('mousemove'))
        await Promise.resolve()
      })
      expect(mockNotifyActive).toHaveBeenCalledTimes(1)
    })
  })

  describe('idle detection', () => {
    it('should check idle time periodically and notify SDK when threshold reached', async () => {
      renderHook(() => usePlatformState())

      // Advance time beyond idle threshold (5 minutes = 300000ms)
      await act(async () => {
        vi.advanceTimersByTime(300000)
        await Promise.resolve()
      })

      expect(mockNotifyIdle).toHaveBeenCalled()
      expect(mockNotifyIdle.mock.calls[0][0]).toBeInstanceOf(Date)
    })
  })

  describe('presence sync', () => {
    it('should call presenceConnect when status is online', () => {
      renderHook(() => usePlatformState())

      // The hook is rendered with status='online' from the mock
      expect(mockPresenceConnect).toHaveBeenCalled()
    })
  })

  describe('cleanup', () => {
    it('should remove event listeners on unmount', () => {
      const addEventListenerSpy = vi.spyOn(document, 'addEventListener')
      const removeEventListenerSpy = vi.spyOn(document, 'removeEventListener')

      const { unmount } = renderHook(() => usePlatformState())

      expect(addEventListenerSpy).toHaveBeenCalledWith('mousemove', expect.any(Function), { passive: true })

      unmount()

      expect(removeEventListenerSpy).toHaveBeenCalledWith('mousemove', expect.any(Function))
    })
  })

  describe('window focus reconnect trigger', () => {
    it('should trigger reconnect when window gains focus while reconnecting', async () => {
      mockConnectionStatus.current = 'reconnecting'
      renderHook(() => usePlatformState())

      await act(async () => {
        window.dispatchEvent(new Event('focus'))
        await Promise.resolve()
      })

      expect(mockClientNotifySystemState).toHaveBeenCalledWith('visible')
    })

    it('should NOT trigger reconnect on focus when status is online', async () => {
      mockConnectionStatus.current = 'online'
      renderHook(() => usePlatformState())

      // Clear any calls from mount (presence sync calls notifyActive → setTimeout → notifyActive)
      await act(async () => {
        vi.advanceTimersByTime(200)
        await Promise.resolve()
      })
      vi.clearAllMocks()

      await act(async () => {
        window.dispatchEvent(new Event('focus'))
        await Promise.resolve()
      })

      // Should not call notifySystemState('visible') from the focus handler
      expect(mockClientNotifySystemState).not.toHaveBeenCalledWith('visible')
    })

    it('should register focus listener during reconnecting status', () => {
      // When status is 'reconnecting' (retry loop in progress, including the
      // attempting substate which now also maps to 'reconnecting'), the
      // effect must stay active so window focus can nudge a stalled retry.
      const addSpy = vi.spyOn(window, 'addEventListener')
      mockConnectionStatus.current = 'reconnecting'
      renderHook(() => usePlatformState())

      expect(addSpy).toHaveBeenCalledWith('focus', expect.any(Function))
      addSpy.mockRestore()
    })

    it('should NOT register focus listener during connecting status', () => {
      // 'connecting' is reserved for the initial connection attempt (machine
      // state 'connecting'), not reconnects. No wake-nudge needed there.
      const addSpy = vi.spyOn(window, 'addEventListener')
      mockConnectionStatus.current = 'connecting'
      renderHook(() => usePlatformState())

      const focusCalls = addSpy.mock.calls.filter(
        ([event]) => (event as string) === 'focus'
      )
      expect(focusCalls).toHaveLength(0)
      addSpy.mockRestore()
    })

    it('should NOT register focus listener when disconnected', () => {
      const addSpy = vi.spyOn(window, 'addEventListener')
      mockConnectionStatus.current = 'disconnected'
      renderHook(() => usePlatformState())

      const focusCalls = addSpy.mock.calls.filter(
        ([event]) => (event as string) === 'focus'
      )
      expect(focusCalls).toHaveLength(0)
      addSpy.mockRestore()
    })

    it('suppresses the focus nudge when the last keepalive tick was displayActive=false', async () => {
      installTauriIpc()
      mockConnectionStatus.current = 'reconnecting'
      renderHook(() => usePlatformState())

      // A display-off tick lands first, recording displayActive=false.
      for (let i = 0; i < 30 && !tauriListeners.has('xmpp-keepalive'); i++) {
        await act(async () => {
          await vi.advanceTimersByTimeAsync(0)
          await Promise.resolve()
        })
      }
      const ka = tauriListeners.get('xmpp-keepalive')
      await act(async () => {
        ka?.({ payload: { displayActive: false, sleptMs: 30_000 } })
        await Promise.resolve()
      })
      vi.clearAllMocks()

      await act(async () => {
        window.dispatchEvent(new Event('focus'))
        await Promise.resolve()
      })

      expect(mockClientNotifySystemState).not.toHaveBeenCalledWith('visible')
    })

    it('still nudges on focus before any tick has arrived (cold-start fail-open)', async () => {
      mockConnectionStatus.current = 'reconnecting'
      renderHook(() => usePlatformState())

      await act(async () => {
        window.dispatchEvent(new Event('focus'))
        await Promise.resolve()
      })

      expect(mockClientNotifySystemState).toHaveBeenCalledWith('visible')
    })
  })

  describe('heartbeat during reconnecting status', () => {
    it('should NOT re-fire notifySystemState("awake") while already reconnecting', async () => {
      // Regression: previously, during a reconnect attempt the heartbeat
      // would observe macOS JS throttling as a >180s time gap and re-enter
      // handleAwake(), cascading into overlapping cleanupClient +
      // attemptReconnect sequences and freezing the webview. The state
      // machine owns the retry loop — the heartbeat must not re-kick it.
      const startTime = Date.now()
      mockConnectionStatus.current = 'reconnecting'
      renderHook(() => usePlatformState())

      await act(async () => {
        vi.advanceTimersByTime(10_000)
        await Promise.resolve()
      })
      vi.clearAllMocks()

      // Simulate a 200s JS-throttling gap (exceeds SLEEP_THRESHOLD_MS = 180s).
      vi.setSystemTime(new Date(startTime + 10_000 + 200_000))
      await act(async () => {
        vi.advanceTimersByTime(10_000)
        await Promise.resolve()
      })

      // Must NOT have re-entered handleAwake via a heartbeat-driven wake.
      expect(mockClientNotifySystemState).not.toHaveBeenCalledWith('awake', expect.any(Number))
    })

    it('should NOT run heartbeat when status is disconnected', async () => {
      const startTime = Date.now()
      mockConnectionStatus.current = 'disconnected'
      renderHook(() => usePlatformState())

      // Let the first tick pass, then simulate a gap
      await act(async () => {
        vi.advanceTimersByTime(10_000)
        await Promise.resolve()
      })
      vi.clearAllMocks()

      // Simulate sleep gap (200s exceeds SLEEP_THRESHOLD_MS)
      vi.setSystemTime(new Date(startTime + 10_000 + 200_000))
      await act(async () => {
        vi.advanceTimersByTime(10_000)
        await Promise.resolve()
      })

      // Should not call notifySystemState('awake') since heartbeat is inactive
      expect(mockClientNotifySystemState).not.toHaveBeenCalledWith('awake', expect.any(Number))
    })
  })

  describe('proxy-close status guard', () => {
    it('should handle proxy close when online', () => {
      expect(shouldHandleProxyClosedStatus('online')).toBe(true)
    })

    it('should ignore proxy close for non-connected states', () => {
      expect(shouldHandleProxyClosedStatus('connecting')).toBe(false)
      expect(shouldHandleProxyClosedStatus('reconnecting')).toBe(false)
      expect(shouldHandleProxyClosedStatus('disconnected')).toBe(false)
      expect(shouldHandleProxyClosedStatus('error')).toBe(false)
    })
  })

  describe('post-reload cooldown', () => {
    beforeEach(() => {
      localStorage.removeItem(RELOAD_MARKER_STORAGE_KEY)
    })

    describe('readReloadMarker / writeReloadMarker / clearReloadMarker', () => {
      it('returns 0 when no marker has been written', () => {
        expect(readReloadMarker()).toBe(0)
      })

      it('round-trips a written timestamp', () => {
        writeReloadMarker(1_700_000_000_000)
        expect(readReloadMarker()).toBe(1_700_000_000_000)
      })

      it('returns 0 when the stored value is not a finite number', () => {
        localStorage.setItem(RELOAD_MARKER_STORAGE_KEY, 'garbage')
        expect(readReloadMarker()).toBe(0)
      })

      it('clearReloadMarker removes the stored value', () => {
        writeReloadMarker(1_700_000_000_000)
        clearReloadMarker()
        expect(readReloadMarker()).toBe(0)
      })
    })

    describe('isWithinReloadCooldown', () => {
      const COOLDOWN = 60_000

      it('returns false when no marker has been set', () => {
        expect(isWithinReloadCooldown(0, 1_000_000, COOLDOWN)).toBe(false)
      })

      it('returns true for a marker set moments ago', () => {
        expect(isWithinReloadCooldown(1_000_000, 1_000_050, COOLDOWN)).toBe(true)
      })

      it('returns true for a marker near but within the cooldown boundary', () => {
        expect(isWithinReloadCooldown(1_000_000, 1_059_999, COOLDOWN)).toBe(true)
      })

      it('returns false once the cooldown has elapsed', () => {
        expect(isWithinReloadCooldown(1_000_000, 1_060_000, COOLDOWN)).toBe(false)
        expect(isWithinReloadCooldown(1_000_000, 2_000_000, COOLDOWN)).toBe(false)
      })

      it('returns false when the clock has moved backward since the marker was set', () => {
        // NTP adjustment edge case — don't gate on a negative elapsed window.
        expect(isWithinReloadCooldown(1_000_000, 999_000, COOLDOWN)).toBe(false)
      })
    })

    it('suppresses window-focus wakes while within the post-reload cooldown', async () => {
      // Simulate the state the new React instance sees right after
      // window.location.reload() was called by a previous instance:
      // a recent marker in localStorage. The window-focus handler is a
      // clean test vehicle because it calls shouldHandleWake with no
      // time-gap guard in front of it, so we can observe the cooldown
      // decision directly.
      writeReloadMarker(Date.now() - 1_000)
      mockConnectionStatus.current = 'reconnecting'
      renderHook(() => usePlatformState())

      await act(async () => {
        window.dispatchEvent(new Event('focus'))
        await Promise.resolve()
      })

      expect(mockClientNotifySystemState).not.toHaveBeenCalledWith('visible')
    })

    it('handles wake signals normally once the cooldown has elapsed', async () => {
      writeReloadMarker(Date.now() - 120_000) // 2 min ago, well past the 60s cooldown
      mockConnectionStatus.current = 'reconnecting'
      renderHook(() => usePlatformState())

      await act(async () => {
        window.dispatchEvent(new Event('focus'))
        await Promise.resolve()
      })

      expect(mockClientNotifySystemState).toHaveBeenCalledWith('visible')
    })
  })

  // Wait for an effect to register a Tauri listener (the hook subscribes via
  // an async dynamic import — flush micro + faked-macro tasks until present).
  const waitForListener = async (name: string) => {
    for (let i = 0; i < 30 && !tauriListeners.has(name); i++) {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0)
        await Promise.resolve()
      })
    }
  }

  describe('Effect 2 OS-wake demotion (reload-only)', () => {
    beforeEach(() => {
      installTauriIpc()
      clearReloadMarker()
    })

    it('does NOT call notifySystemState("awake") on system-did-wake (reconnect is keepalive-driven)', async () => {
      mockConnectionStatus.current = 'online'
      renderHook(() => usePlatformState())
      await waitForListener('system-did-wake')

      const wake = tauriListeners.get('system-did-wake')
      expect(wake).toBeDefined()
      await act(async () => {
        wake!({ payload: { displayActive: true } })
        await Promise.resolve()
      })

      // No 'awake' notify at all — not even with an undefined duration
      // (expect.anything() would miss the undefined-arg case, so assert on the
      // first arg directly).
      const awakeCalls = mockClientNotifySystemState.mock.calls.filter(
        (args) => args[0] === 'awake'
      )
      expect(awakeCalls).toHaveLength(0)
    })

    it('does NOT call notifySystemState("awake") on system-did-wake-deferred', async () => {
      mockConnectionStatus.current = 'online'
      renderHook(() => usePlatformState())
      await waitForListener('system-did-wake-deferred')

      const deferred = tauriListeners.get('system-did-wake-deferred')
      expect(deferred).toBeDefined()
      await act(async () => {
        deferred!({ payload: 9000 })
        await Promise.resolve()
      })

      // No 'awake' notify at all — not even with an undefined duration
      // (expect.anything() would miss the undefined-arg case, so assert on the
      // first arg directly).
      const awakeCalls = mockClientNotifySystemState.mock.calls.filter(
        (args) => args[0] === 'awake'
      )
      expect(awakeCalls).toHaveLength(0)
    })
  })

  describe('Effect 5 keepalive gate', () => {
    const fireKeepalive = async (payload: unknown) => {
      // The hook registers the listener via `await import(...).then(...)`, whose
      // resolution interleaves microtasks and the (faked) timer/macrotask queue.
      // Poll until the listener is registered, flushing both each iteration.
      for (let i = 0; i < 30 && !tauriListeners.has('xmpp-keepalive'); i++) {
        await act(async () => {
          await vi.advanceTimersByTimeAsync(0)
          await Promise.resolve()
        })
      }
      const handler = tauriListeners.get('xmpp-keepalive')
      expect(handler).toBeDefined()
      await act(async () => {
        handler!({ payload })
        await Promise.resolve()
      })
    }

    beforeEach(() => {
      installTauriIpc()
      mockGetReconnectIntent.mockReturnValue('active')
    })

    it('forwards displayActive + sleptMs to handleKeepaliveTick on a steady-state tick', async () => {
      mockConnectionStatus.current = 'online'
      renderHook(() => usePlatformState())
      await fireKeepalive({ displayActive: true, sleptMs: 30_000 })
      expect(mockClientHandleKeepaliveTick).toHaveBeenCalledWith(true, 30_000)
    })

    it('does not call handleKeepaliveTick when displayActive is false', async () => {
      mockConnectionStatus.current = 'online'
      renderHook(() => usePlatformState())
      await fireKeepalive({ displayActive: false, sleptMs: 30_000 })
      expect(mockClientHandleKeepaliveTick).not.toHaveBeenCalled()
    })

    it('does not call handleKeepaliveTick when intent is logged-out', async () => {
      mockGetReconnectIntent.mockReturnValue('logged-out')
      mockConnectionStatus.current = 'online'
      renderHook(() => usePlatformState())
      await fireKeepalive({ displayActive: true, sleptMs: 30_000 })
      expect(mockClientHandleKeepaliveTick).not.toHaveBeenCalled()
    })

    it('treats a legacy () payload as display-active (fail-open)', async () => {
      mockConnectionStatus.current = 'online'
      renderHook(() => usePlatformState())
      await fireKeepalive(undefined)
      expect(mockClientHandleKeepaliveTick).toHaveBeenCalledWith(undefined, undefined)
    })

    it('routes a wake-tick through the post-reload cooldown (suppressed within cooldown)', async () => {
      writeReloadMarker(Date.now() - 1_000)
      mockConnectionStatus.current = 'reconnecting'
      renderHook(() => usePlatformState())
      await fireKeepalive({ displayActive: true, sleptMs: 600_000 })
      expect(mockClientHandleKeepaliveTick).not.toHaveBeenCalled()
    })

    it('runs a wake-tick once the cooldown has elapsed', async () => {
      clearReloadMarker()
      mockConnectionStatus.current = 'reconnecting'
      renderHook(() => usePlatformState())
      await fireKeepalive({ displayActive: true, sleptMs: 600_000 })
      expect(mockClientHandleKeepaliveTick).toHaveBeenCalledWith(true, 600_000)
    })
  })

  describe('shouldHandleDisplayWake', () => {
    it('returns true when no payload is attached (Linux/Windows or older build)', () => {
      expect(shouldHandleDisplayWake(undefined)).toBe(true)
    })

    it('returns true when the display is active on macOS (user-driven wake)', () => {
      expect(shouldHandleDisplayWake({ displayActive: true })).toBe(true)
    })

    it('returns false when the display is asleep on macOS (DarkWake / PowerNap)', () => {
      expect(shouldHandleDisplayWake({ displayActive: false })).toBe(false)
    })

    it('returns true when displayActive is missing but payload exists (fail-open)', () => {
      expect(shouldHandleDisplayWake({})).toBe(true)
    })
  })

  describe('parseKeepalivePayload', () => {
    // The Rust keepalive thread emits { displayActive, sleptMs } (serde
    // camelCase). An older binary emits the legacy () payload (undefined).
    // Parsing must never throw and must default a missing displayActive to
    // undefined so the downstream gate fails open (treats it as active).

    it('parses a well-formed payload', () => {
      expect(parseKeepalivePayload({ displayActive: true, sleptMs: 30_000 })).toEqual({
        displayActive: true,
        sleptMs: 30_000,
      })
      expect(parseKeepalivePayload({ displayActive: false, sleptMs: 600_000 })).toEqual({
        displayActive: false,
        sleptMs: 600_000,
      })
    })

    it('returns undefined fields for a legacy () / undefined payload (no throw)', () => {
      expect(parseKeepalivePayload(undefined)).toEqual({
        displayActive: undefined,
        sleptMs: undefined,
      })
      expect(parseKeepalivePayload(null)).toEqual({
        displayActive: undefined,
        sleptMs: undefined,
      })
    })

    it('ignores fields of the wrong type without throwing', () => {
      expect(parseKeepalivePayload({ displayActive: 'yes', sleptMs: 'soon' })).toEqual({
        displayActive: undefined,
        sleptMs: undefined,
      })
    })

    it('does not throw on a non-object primitive', () => {
      expect(parseKeepalivePayload(42)).toEqual({
        displayActive: undefined,
        sleptMs: undefined,
      })
      expect(parseKeepalivePayload('xmpp-keepalive')).toEqual({
        displayActive: undefined,
        sleptMs: undefined,
      })
    })
  })

  describe('shouldRunKeepaliveReconnect', () => {
    // Two gates, in this order:
    //  1. payload.displayActive === false  -> never reconnect (DarkWake).
    //  2. intent !== 'active'              -> never reconnect (logout race).
    // A missing displayActive (legacy build) fails open to true.

    it('returns false when the display is asleep, regardless of intent', () => {
      expect(shouldRunKeepaliveReconnect({ displayActive: false }, 'active')).toBe(false)
      expect(shouldRunKeepaliveReconnect({ displayActive: false }, 'logged-out')).toBe(false)
    })

    it('returns false when the display is on but the user logged out', () => {
      expect(shouldRunKeepaliveReconnect({ displayActive: true }, 'logged-out')).toBe(false)
    })

    it('returns true when the display is on and the intent is active', () => {
      expect(shouldRunKeepaliveReconnect({ displayActive: true }, 'active')).toBe(true)
    })

    it('fails open: undefined displayActive (legacy build) + active intent -> true', () => {
      expect(shouldRunKeepaliveReconnect({ displayActive: undefined }, 'active')).toBe(true)
      expect(shouldRunKeepaliveReconnect({}, 'active')).toBe(true)
    })

    it('still blocks an undefined-display tick when the user logged out', () => {
      expect(shouldRunKeepaliveReconnect({ displayActive: undefined }, 'logged-out')).toBe(false)
    })
  })

  describe('isKeepaliveWakeTick', () => {
    // A steady-state tick reports sleptMs ~= 30s (the interval). A tick that
    // arrives after a sleep gap reports a much larger sleptMs and must be
    // routed through the wake debounce/cooldown rather than the plain probe.
    // Threshold is SLEEP_THRESHOLD_MS (180s), shared with the wake reload gate.

    const THRESHOLD = 180_000 // SLEEP_THRESHOLD_MS

    it('returns true at and above the sleep threshold (real wake gap)', () => {
      expect(isKeepaliveWakeTick(THRESHOLD)).toBe(true)
      expect(isKeepaliveWakeTick(600_000)).toBe(true)
      expect(isKeepaliveWakeTick(2.5 * 60 * 60 * 1000)).toBe(true)
    })

    it('returns false for a steady-state ~30s tick', () => {
      expect(isKeepaliveWakeTick(30_000)).toBe(false)
      expect(isKeepaliveWakeTick(0)).toBe(false)
      expect(isKeepaliveWakeTick(THRESHOLD - 1)).toBe(false)
    })

    it('treats undefined sleptMs (legacy build) as a non-wake tick', () => {
      expect(isKeepaliveWakeTick(undefined)).toBe(false)
    })
  })

  describe('shouldReloadWebviewOnWake', () => {
    // Gates the Tauri webview reload on wake-from-sleep. The 3-minute
    // threshold comes from SLEEP_THRESHOLD_MS — the project-wide
    // "real sleep vs timer throttling" line.

    it('returns true for a 3+ minute wake in Tauri', () => {
      expect(shouldReloadWebviewOnWake(180_000, true)).toBe(true)
      expect(shouldReloadWebviewOnWake(5 * 60 * 1000, true)).toBe(true)
      expect(shouldReloadWebviewOnWake(60 * 60 * 1000, true)).toBe(true)
    })

    it('returns false for a sub-threshold wake in Tauri (brief hide / timer throttling)', () => {
      expect(shouldReloadWebviewOnWake(0, true)).toBe(false)
      expect(shouldReloadWebviewOnWake(30_000, true)).toBe(false)
      expect(shouldReloadWebviewOnWake(179_999, true)).toBe(false)
    })

    it('returns false on web even for a long wake (web browsers do not have the WRY rendering-context bug)', () => {
      expect(shouldReloadWebviewOnWake(180_000, false)).toBe(false)
      expect(shouldReloadWebviewOnWake(60 * 60 * 1000, false)).toBe(false)
    })

    it('returns false for unknown duration (cannot tell if it was real sleep)', () => {
      expect(shouldReloadWebviewOnWake(undefined, true)).toBe(false)
      expect(shouldReloadWebviewOnWake(undefined, false)).toBe(false)
    })
  })

  describe('shouldReloadOnVisibilityWake', () => {
    // The visibility handler cannot distinguish "machine slept" from
    // "app was hidden while machine stayed awake." The heartbeat gap
    // disambiguates: a small gap means JS was running (machine awake),
    // a large gap means JS was frozen by the OS (real sleep).

    const THRESHOLD = 180_000 // SLEEP_THRESHOLD_MS

    it('returns true when both hidden duration AND heartbeat gap exceed threshold (real sleep)', () => {
      expect(shouldReloadOnVisibilityWake(THRESHOLD, THRESHOLD, true)).toBe(true)
      expect(shouldReloadOnVisibilityWake(5 * 60_000, 5 * 60_000, true)).toBe(true)
      expect(shouldReloadOnVisibilityWake(60 * 60_000, 60 * 60_000, true)).toBe(true)
    })

    it('returns false when hidden long but heartbeat was recent (app just hidden, machine awake)', () => {
      // This is the bug scenario: user switched to another app for 7+ minutes,
      // machine stayed awake, heartbeat kept firing every ~10s.
      expect(shouldReloadOnVisibilityWake(7 * 60_000, 10_000, true)).toBe(false)
      expect(shouldReloadOnVisibilityWake(THRESHOLD, 30_000, true)).toBe(false)
      expect(shouldReloadOnVisibilityWake(10 * 60_000, THRESHOLD - 1, true)).toBe(false)
    })

    it('returns false when hidden duration is below threshold', () => {
      expect(shouldReloadOnVisibilityWake(THRESHOLD - 1, THRESHOLD, true)).toBe(false)
      expect(shouldReloadOnVisibilityWake(60_000, 60_000, true)).toBe(false)
      expect(shouldReloadOnVisibilityWake(0, 0, true)).toBe(false)
    })

    it('returns false on web even with real sleep (no WKWebView rendering bug)', () => {
      expect(shouldReloadOnVisibilityWake(THRESHOLD, THRESHOLD, false)).toBe(false)
      expect(shouldReloadOnVisibilityWake(60 * 60_000, 60 * 60_000, false)).toBe(false)
    })
  })
})
