import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { useIsMobileWeb, isMobileWeb, isSmallScreen } from './useIsMobileWeb'

// Helper type for mocked matchMedia
type MockedMatchMedia = ReturnType<typeof vi.fn> & ((query: string) => MediaQueryList)

describe('useIsMobileWeb', () => {
  let matchMediaMock: MockedMatchMedia
  let mediaQueryListeners: ((e: { matches: boolean }) => void)[] = []

  beforeEach(() => {
    mediaQueryListeners = []

    // Mock matchMedia
    matchMediaMock = vi.fn((_query: string) => ({
      matches: global.window.innerWidth < 768,
      media: _query,
      onchange: null,
      addEventListener: vi.fn((event: string, callback: (e: { matches: boolean }) => void) => {
        if (event === 'change') {
          mediaQueryListeners.push(callback)
        }
      }),
      removeEventListener: vi.fn((event: string, callback: (e: { matches: boolean }) => void) => {
        if (event === 'change') {
          const index = mediaQueryListeners.indexOf(callback)
          if (index !== -1) {
            mediaQueryListeners.splice(index, 1)
          }
        }
      }),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })) as MockedMatchMedia

    global.window.matchMedia = matchMediaMock
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  describe('non-Tauri environment (web browser)', () => {
    beforeEach(() => {
      // Ensure no Tauri
       
      delete (global.window as any).__TAURI_INTERNALS__
    })

    it('returns true when viewport is below 768px', () => {
      Object.defineProperty(global.window, 'innerWidth', { value: 500, writable: true })
      matchMediaMock.mockReturnValue({
        matches: true,
        media: '(max-width: 767px)',
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      })

      const { result } = renderHook(() => useIsMobileWeb())
      expect(result.current).toBe(true)
    })

    it('returns false when viewport is 768px or above', () => {
      Object.defineProperty(global.window, 'innerWidth', { value: 1024, writable: true })
      matchMediaMock.mockReturnValue({
        matches: false,
        media: '(max-width: 767px)',
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      })

      const { result } = renderHook(() => useIsMobileWeb())
      expect(result.current).toBe(false)
    })

    it('updates when viewport crosses the breakpoint', () => {
      Object.defineProperty(global.window, 'innerWidth', { value: 1024, writable: true })

      const addEventListener = vi.fn()
      const removeEventListener = vi.fn()

      matchMediaMock.mockReturnValue({
        matches: false,
        media: '(max-width: 767px)',
        addEventListener,
        removeEventListener,
      })

      const { result } = renderHook(() => useIsMobileWeb())
      expect(result.current).toBe(false)

      // Get the listener callback
      expect(addEventListener).toHaveBeenCalled()
      const changeCallback = addEventListener.mock.calls[0][1]

      // Simulate viewport change to mobile
      act(() => {
        changeCallback({ matches: true })
      })
      expect(result.current).toBe(true)

      // Simulate viewport change back to desktop
      act(() => {
        changeCallback({ matches: false })
      })
      expect(result.current).toBe(false)
    })

    it('cleans up event listener on unmount', () => {
      const removeEventListener = vi.fn()
      matchMediaMock.mockReturnValue({
        matches: false,
        media: '(max-width: 767px)',
        addEventListener: vi.fn(),
        removeEventListener,
      })

      const { unmount } = renderHook(() => useIsMobileWeb())
      unmount()

      expect(removeEventListener).toHaveBeenCalledWith('change', expect.any(Function))
    })
  })

  describe('Tauri environment (desktop app)', () => {
    beforeEach(() => {
      // Simulate Tauri environment
       
      (global.window as any).__TAURI_INTERNALS__ = {}
    })

    afterEach(() => {
       
      delete (global.window as any).__TAURI_INTERNALS__
    })

    it('always returns false in Tauri, even on small viewport', () => {
      Object.defineProperty(global.window, 'innerWidth', { value: 500, writable: true })

      const { result } = renderHook(() => useIsMobileWeb())
      expect(result.current).toBe(false)
    })

    it('does not add event listener in Tauri', () => {
      const addEventListener = vi.fn()
      matchMediaMock.mockReturnValue({
        matches: true,
        media: '(max-width: 767px)',
        addEventListener,
        removeEventListener: vi.fn(),
      })

      renderHook(() => useIsMobileWeb())
      expect(addEventListener).not.toHaveBeenCalled()
    })
  })
})

describe('isMobileWeb (non-reactive)', () => {
  beforeEach(() => {
     
    delete (global.window as any).__TAURI_INTERNALS__
  })

  it('returns true when not Tauri and viewport < 768px', () => {
    Object.defineProperty(global.window, 'innerWidth', { value: 500, writable: true })
    expect(isMobileWeb()).toBe(true)
  })

  it('returns false when not Tauri and viewport >= 768px', () => {
    Object.defineProperty(global.window, 'innerWidth', { value: 1024, writable: true })
    expect(isMobileWeb()).toBe(false)
  })

  it('returns false in Tauri regardless of viewport', () => {
     
    (global.window as any).__TAURI_INTERNALS__ = {}
    Object.defineProperty(global.window, 'innerWidth', { value: 500, writable: true })
    expect(isMobileWeb()).toBe(false)
     
    delete (global.window as any).__TAURI_INTERNALS__
  })
})

describe('isSmallScreen (platform-agnostic)', () => {
  it('returns true when viewport < 768px (not Tauri)', () => {
     
    delete (global.window as any).__TAURI_INTERNALS__
    Object.defineProperty(global.window, 'innerWidth', { value: 500, writable: true })
    expect(isSmallScreen()).toBe(true)
  })

  it('returns false when viewport >= 768px (not Tauri)', () => {
     
    delete (global.window as any).__TAURI_INTERNALS__
    Object.defineProperty(global.window, 'innerWidth', { value: 1024, writable: true })
    expect(isSmallScreen()).toBe(false)
  })

  it('returns true in Tauri when viewport < 768px', () => {
     
    (global.window as any).__TAURI_INTERNALS__ = {}
    Object.defineProperty(global.window, 'innerWidth', { value: 500, writable: true })
    expect(isSmallScreen()).toBe(true)
     
    delete (global.window as any).__TAURI_INTERNALS__
  })

  it('returns false in Tauri when viewport >= 768px', () => {
     
    (global.window as any).__TAURI_INTERNALS__ = {}
    Object.defineProperty(global.window, 'innerWidth', { value: 1024, writable: true })
    expect(isSmallScreen()).toBe(false)
     
    delete (global.window as any).__TAURI_INTERNALS__
  })
})
