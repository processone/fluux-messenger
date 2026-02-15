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

vi.mock('@/utils/renderLoopDetector', () => ({
  startWakeGracePeriod: vi.fn(),
}))

// Mock functions - use vi.hoisted to ensure they're available before vi.mock
const {
  mockNotifyIdle,
  mockNotifyActive,
  mockNotifySystemState,
  mockPresenceConnect,
  mockPresenceDisconnect,
  mockClientNotifySystemState,
} = vi.hoisted(() => ({
  mockNotifyIdle: vi.fn(),
  mockNotifyActive: vi.fn(),
  mockNotifySystemState: vi.fn(),
  mockPresenceConnect: vi.fn(),
  mockPresenceDisconnect: vi.fn(),
  mockClientNotifySystemState: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('@fluux/sdk/react', () => ({
  useConnectionStore: (selector: (state: { status: string }) => string) => selector({ status: 'online' }),
}))

vi.mock('@fluux/sdk', () => ({
  useXMPP: () => ({
    client: {
      notifySystemState: mockClientNotifySystemState,
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
import { usePlatformState } from './usePlatformState'

describe('usePlatformState', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
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
})
