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
} from './usePlatformState'

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
