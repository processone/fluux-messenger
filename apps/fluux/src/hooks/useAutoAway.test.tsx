/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'

// Mock Tauri APIs
vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(),
}))

vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn(() => Promise.resolve(() => {})),
}))

vi.mock('@/utils/wakeCoordinator', () => ({
  tryAcquireWakeLock: vi.fn(() => true),
  releaseWakeLock: vi.fn(),
  isWakeHandlingActive: vi.fn(() => false),
}))

// Mock functions - use vi.hoisted to ensure they're available before vi.mock
const {
  mockNotifyIdle,
  mockNotifyActive,
  mockNotifyWake,
  mockNotifySleep,
  mockNotifySystemState,
  mockSetAutoAwayConfig,
} = vi.hoisted(() => {
  const mockNotifyIdle = vi.fn()
  const mockNotifyActive = vi.fn()
  const mockNotifyWake = vi.fn()
  const mockNotifySleep = vi.fn()
  const mockNotifySystemState = vi.fn()
  const mockSetAutoAwayConfig = vi.fn()

  return {
    mockNotifyIdle,
    mockNotifyActive,
    mockNotifyWake,
    mockNotifySleep,
    mockNotifySystemState,
    mockSetAutoAwayConfig,
  }
})

// Mock presence functions - use vi.hoisted to ensure they're available before vi.mock
const { mockPresenceConnect, mockPresenceDisconnect } = vi.hoisted(() => ({
  mockPresenceConnect: vi.fn(),
  mockPresenceDisconnect: vi.fn(),
}))

vi.mock('@fluux/sdk/react', () => ({
  useConnectionStore: (selector: (state: { status: string }) => string) => selector({ status: 'online' }),
}))

vi.mock('@fluux/sdk', () => ({
  useSystemState: () => ({
    notifyIdle: mockNotifyIdle,
    notifyActive: mockNotifyActive,
    notifyWake: mockNotifyWake,
    notifySleep: mockNotifySleep,
    notifySystemState: mockNotifySystemState,
    setAutoAwayConfig: mockSetAutoAwayConfig,
    autoAwayConfig: {
      enabled: true,
      idleThresholdMs: 5 * 60 * 1000, // 5 minutes
      checkIntervalMs: 30 * 1000, // 30 seconds
    },
  }),
  usePresence: () => ({
    connect: mockPresenceConnect,
    disconnect: mockPresenceDisconnect,
  }),
  // Vanilla store (for imperative .getState() access)
  consoleStore: {
    getState: () => ({
      addEvent: vi.fn(),
    }),
  },
}))

// Import after mocks are set up
import { useAutoAway } from './useAutoAway'

describe('useAutoAway', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  describe('activity detection', () => {
    it('should notify SDK when activity detected', async () => {
      renderHook(() => useAutoAway())

      // Simulate user activity (mousemove)
      await act(async () => {
        document.dispatchEvent(new MouseEvent('mousemove'))
        // Allow async operations to complete
        await Promise.resolve()
      })

      // Should have sent activity event to SDK via useSystemState
      // SDK's presence machine handles the state transition
      expect(mockNotifyActive).toHaveBeenCalled()
    })

    it('should respond to all tracked activity events', async () => {
      renderHook(() => useAutoAway())

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

        // Should send activity event to SDK for each event type
        expect(mockNotifyActive).toHaveBeenCalled()
      }
    })

    it('should throttle activity events to avoid flooding the SDK', async () => {
      renderHook(() => useAutoAway())

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
          vi.advanceTimersByTime(100) // 100ms between events
          document.dispatchEvent(new MouseEvent('mousemove'))
          await Promise.resolve()
        })
      }
      // None of these should have triggered notifyActive (within 5s window)
      expect(mockNotifyActive).not.toHaveBeenCalled()

      // After throttle window expires, next event should trigger
      vi.clearAllMocks()
      await act(async () => {
        vi.advanceTimersByTime(5000) // Advance past throttle window
        document.dispatchEvent(new MouseEvent('mousemove'))
        await Promise.resolve()
      })
      expect(mockNotifyActive).toHaveBeenCalledTimes(1)
    })
  })

  describe('idle detection', () => {
    it('should check idle time periodically and notify SDK when threshold reached', async () => {
      renderHook(() => useAutoAway())

      // Advance time beyond idle threshold (5 minutes = 300000ms)
      // The hook checks every 30 seconds
      await act(async () => {
        vi.advanceTimersByTime(300000) // 5 minutes
        await Promise.resolve()
      })

      // Should have called notifyIdle with a Date
      expect(mockNotifyIdle).toHaveBeenCalled()
      expect(mockNotifyIdle.mock.calls[0][0]).toBeInstanceOf(Date)
    })
  })

  describe('cleanup', () => {
    it('should remove event listeners on unmount', () => {
      const addEventListenerSpy = vi.spyOn(document, 'addEventListener')
      const removeEventListenerSpy = vi.spyOn(document, 'removeEventListener')

      const { unmount } = renderHook(() => useAutoAway())

      // Should have added listeners
      expect(addEventListenerSpy).toHaveBeenCalledWith('mousemove', expect.any(Function), { passive: true })

      unmount()

      // Should have removed listeners
      expect(removeEventListenerSpy).toHaveBeenCalledWith('mousemove', expect.any(Function))
    })
  })
})
