/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach, beforeAll, afterAll } from 'vitest'
import { renderHook, act } from '@testing-library/react'

// Type for the listen callback
type ListenCallback = (event: { payload: unknown }) => void

// Mock Tauri APIs - vi.hoisted ensures mocks are available before vi.mock
const {
  mockListen,
  mockSleepDetected,
  mockAddEvent,
  getMockState,
  setMockState,
} = vi.hoisted(() => {
  const mockListen = vi.fn()
  const mockSleepDetected = vi.fn()
  const mockAddEvent = vi.fn()

  let mockState = {
    status: 'online' as 'online' | 'offline' | 'connecting' | 'error' | 'reconnecting',
    presenceShow: 'online' as 'online' | 'away' | 'dnd' | 'offline',
    isAutoAway: false,
  }

  return {
    mockListen,
    mockSleepDetected,
    mockAddEvent,
    getMockState: () => mockState,
    setMockState: (state: Partial<typeof mockState>) => {
      mockState = { ...mockState, ...state }
    },
  }
})

// Mock Tauri event API
vi.mock('@tauri-apps/api/event', () => ({
  listen: mockListen,
}))

// Mock SDK hooks
vi.mock('@fluux/sdk/react', () => ({
  useConnectionStore: (selector: (state: { status: string }) => string) =>
    selector({ status: getMockState().status }),
}))

vi.mock('@fluux/sdk', () => ({
  usePresence: () => ({
    presenceStatus: getMockState().presenceShow,
    isAutoAway: getMockState().isAutoAway,
    sleepDetected: mockSleepDetected,
  }),
  // Vanilla store (for imperative .getState() access)
  consoleStore: {
    getState: () => ({
      addEvent: mockAddEvent,
    }),
  },
}))

// Set Tauri marker on window before tests run
beforeAll(() => {
  // @ts-expect-error - Adding property to window for Tauri detection
  window.__TAURI_INTERNALS__ = {}
})

afterAll(() => {
  // @ts-expect-error - Cleaning up after tests
  delete window.__TAURI_INTERNALS__
})

describe('useSleepDetector', () => {
  let unlistenFn: ReturnType<typeof vi.fn>
  let useSleepDetector: () => void

  beforeAll(async () => {
    // Reset modules to ensure fresh import with __TAURI_INTERNALS__ set
    vi.resetModules()

    // Re-apply mocks after resetModules
    vi.doMock('@tauri-apps/api/event', () => ({
      listen: mockListen,
    }))

    vi.doMock('@fluux/sdk/react', () => ({
      useConnectionStore: (selector: (state: { status: string }) => string) =>
        selector({ status: getMockState().status }),
    }))

    vi.doMock('@fluux/sdk', () => ({
      usePresence: () => ({
        presenceStatus: getMockState().presenceShow,
        isAutoAway: getMockState().isAutoAway,
        sleepDetected: mockSleepDetected,
      }),
      // Vanilla store (for imperative .getState() access)
      consoleStore: {
        getState: () => ({
          addEvent: mockAddEvent,
        }),
      },
    }))

    // Import the hook after Tauri marker is set and mocks are applied
    const module = await import('./useSleepDetector')
    useSleepDetector = module.useSleepDetector
  })

  beforeEach(() => {
    vi.clearAllMocks()

    // Create a new unlisten function for each test
    unlistenFn = vi.fn()

    // Set up mockListen to return a Promise with unlisten function
    mockListen.mockImplementation(async (_event: string, _callback: ListenCallback) => {
      return unlistenFn
    })

    // Reset state to defaults
    setMockState({
      status: 'online',
      presenceShow: 'online',
      isAutoAway: false,
    })
  })

  describe('listener setup', () => {
    it('should set up system-will-sleep listener when online', async () => {
      // Ensure we start with clean state and online status
      setMockState({ status: 'online', presenceShow: 'online', isAutoAway: false })

      renderHook(() => useSleepDetector())

      // Allow microtask queue to flush (for async setupListener)
      await act(async () => {
        await new Promise(resolve => setTimeout(resolve, 50))
      })

      expect(mockListen).toHaveBeenCalledWith('system-will-sleep', expect.any(Function))
    })

    it('should NOT set up listener when disconnected', async () => {
      // Clear any previous calls first
      mockListen.mockClear()
      setMockState({ status: 'offline', presenceShow: 'online', isAutoAway: false })

      renderHook(() => useSleepDetector())

      await act(async () => {
        await new Promise(resolve => setTimeout(resolve, 50))
      })

      expect(mockListen).not.toHaveBeenCalled()
    })

    it('should NOT set up listener when in DND mode', async () => {
      mockListen.mockClear()
      setMockState({ status: 'online', presenceShow: 'dnd', isAutoAway: false })

      renderHook(() => useSleepDetector())

      await act(async () => {
        await new Promise(resolve => setTimeout(resolve, 50))
      })

      expect(mockListen).not.toHaveBeenCalled()
    })

    it('should NOT set up listener when already auto-away', async () => {
      mockListen.mockClear()
      setMockState({ status: 'online', presenceShow: 'online', isAutoAway: true })

      renderHook(() => useSleepDetector())

      await act(async () => {
        await new Promise(resolve => setTimeout(resolve, 50))
      })

      expect(mockListen).not.toHaveBeenCalled()
    })
  })

  describe('sleep event handling', () => {
    it('should call sleepDetected when system-will-sleep event fires', async () => {
      let capturedCallback: ListenCallback | null = null

      mockListen.mockImplementation(async (_event: string, callback: ListenCallback) => {
        capturedCallback = callback
        return unlistenFn
      })

      renderHook(() => useSleepDetector())

      // Wait for listener to be set up
      await act(async () => {
        await new Promise(resolve => setTimeout(resolve, 10))
      })

      expect(capturedCallback).not.toBeNull()

      // Simulate sleep event
      await act(async () => {
        capturedCallback!({ payload: {} })
      })

      expect(mockSleepDetected).toHaveBeenCalled()
    })

    it('should log event when sleep detected', async () => {
      let capturedCallback: ListenCallback | null = null

      mockListen.mockImplementation(async (_event: string, callback: ListenCallback) => {
        capturedCallback = callback
        return unlistenFn
      })

      renderHook(() => useSleepDetector())

      await act(async () => {
        await new Promise(resolve => setTimeout(resolve, 10))
      })

      // Simulate sleep event
      await act(async () => {
        capturedCallback!({ payload: {} })
      })

      expect(mockAddEvent).toHaveBeenCalledWith(
        'System going to sleep, presence machine notified',
        'presence'
      )
    })
  })

  describe('cleanup', () => {
    it('should unsubscribe from listener on unmount', async () => {
      const { unmount } = renderHook(() => useSleepDetector())

      await act(async () => {
        await new Promise(resolve => setTimeout(resolve, 10))
      })

      expect(mockListen).toHaveBeenCalled()

      unmount()

      expect(unlistenFn).toHaveBeenCalled()
    })
  })
})
