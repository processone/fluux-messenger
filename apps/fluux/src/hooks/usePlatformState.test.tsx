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
  mockConnectionStatus,
  tauriListeners,
  mockListen,
} = vi.hoisted(() => {
  const listeners = new Map<string, (event?: { payload?: unknown }) => unknown>()
  return {
    mockNotifyIdle: vi.fn(),
    mockNotifyActive: vi.fn(),
    mockNotifySystemState: vi.fn(),
    mockPresenceConnect: vi.fn(),
    mockPresenceDisconnect: vi.fn(),
    mockClientNotifySystemState: vi.fn().mockResolvedValue(undefined),
    mockClientNudgeReconnect: vi.fn(),
    mockClientVerifyConnectionHealth: vi.fn().mockResolvedValue(undefined),
    mockConnectionStatus: { current: 'online' },
    tauriListeners: listeners,
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

// Mock Tauri APIs
vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(),
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

// Import after mocks are set up
import { usePlatformState, shouldHandleProxyClosedStatus, handleXmppKeepalive } from './usePlatformState'

describe('usePlatformState', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.useFakeTimers()
    mockConnectionStatus.current = 'online'
    tauriListeners.clear()
  })

  afterEach(() => {
    vi.useRealTimers()
    delete (window as any).__TAURI_INTERNALS__
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

  describe('handleXmppKeepalive', () => {
    // The Rust side emits `xmpp-keepalive` every 30s on a native thread
    // (immune to macOS JS timer throttling). It is the one reliable clock
    // we have while the webview is backgrounded, so the handler must route
    // it to nudgeReconnect() whenever the state machine is stuck in
    // reconnecting — otherwise the JS setTimeout backoff can sit frozen
    // for many minutes and the app looks "stuck on reconnect".
    //
    // Tested as a pure function (extracted from the listener) to avoid
    // the Tauri event plumbing in unit tests. The listener → function
    // wiring is a one-liner that's manually verified in Tauri dev mode.

    let client: {
      nudgeReconnect: ReturnType<typeof vi.fn<() => void>>
      verifyConnectionHealth: ReturnType<typeof vi.fn<() => Promise<unknown>>>
    }

    beforeEach(() => {
      client = {
        nudgeReconnect: vi.fn<() => void>(),
        verifyConnectionHealth: vi.fn<() => Promise<unknown>>().mockResolvedValue(undefined),
      }
    })

    it('calls nudgeReconnect (not verifyConnectionHealth) when status is reconnecting', () => {
      handleXmppKeepalive('reconnecting', client)
      expect(client.nudgeReconnect).toHaveBeenCalledTimes(1)
      expect(client.verifyConnectionHealth).not.toHaveBeenCalled()
    })

    it('calls verifyConnectionHealth (not nudgeReconnect) when status is online', () => {
      handleXmppKeepalive('online', client)
      expect(client.verifyConnectionHealth).toHaveBeenCalledTimes(1)
      expect(client.nudgeReconnect).not.toHaveBeenCalled()
    })

    it('is a no-op when status is disconnected', () => {
      handleXmppKeepalive('disconnected', client)
      expect(client.nudgeReconnect).not.toHaveBeenCalled()
      expect(client.verifyConnectionHealth).not.toHaveBeenCalled()
    })

    it('is a no-op when status is connecting (initial connect is not our retry loop)', () => {
      handleXmppKeepalive('connecting', client)
      expect(client.nudgeReconnect).not.toHaveBeenCalled()
      expect(client.verifyConnectionHealth).not.toHaveBeenCalled()
    })

    it('is a no-op when status is error (terminal state)', () => {
      handleXmppKeepalive('error', client)
      expect(client.nudgeReconnect).not.toHaveBeenCalled()
      expect(client.verifyConnectionHealth).not.toHaveBeenCalled()
    })

    it('nudges every time it is called (no dedup, safe to tick repeatedly)', () => {
      // Regression guard for the backgrounded-reconnect scenario: when the
      // machine's own setTimeout is frozen, only the 30s native tick is
      // advancing. Each tick must keep nudging — otherwise the loop stays
      // stuck. State-machine-side guards (TRIGGER_RECONNECT ignored in
      // reconnecting.attempting) prevent churn when an attempt is in flight.
      handleXmppKeepalive('reconnecting', client)
      handleXmppKeepalive('reconnecting', client)
      handleXmppKeepalive('reconnecting', client)
      expect(client.nudgeReconnect).toHaveBeenCalledTimes(3)
    })

    it('swallows verifyConnectionHealth rejections without throwing', async () => {
      const failingClient = {
        nudgeReconnect: vi.fn<() => void>(),
        verifyConnectionHealth: vi.fn<() => Promise<unknown>>().mockRejectedValue(new Error('unreachable')),
      }
      // Must not throw synchronously.
      expect(() => handleXmppKeepalive('online', failingClient)).not.toThrow()
      // Let the microtask queue drain so the .catch runs. If the rejection
      // weren't caught, Node would report an unhandled rejection.
      await Promise.resolve()
      await Promise.resolve()
      expect(failingClient.verifyConnectionHealth).toHaveBeenCalledTimes(1)
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
})
