import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { MemoryRouter, useLocation } from 'react-router-dom'
import type { ReactNode } from 'react'
import { useNavigateToTarget } from './useNavigateToTarget'

// Shared mock state that tests can modify
const mockState = {
  setActiveConversation: vi.fn(),
  setActiveRoom: vi.fn(),
}

// Mock SDK (no React hooks needed here)
vi.mock('@fluux/sdk', () => ({}))

// Mock React store hooks (from @fluux/sdk/react)
vi.mock('@fluux/sdk/react', () => ({
  useChatStore: (selector: (s: unknown) => unknown) => {
    const state = {
      setActiveConversation: mockState.setActiveConversation,
    }
    return selector(state)
  },
  useRoomStore: (selector: (s: unknown) => unknown) => {
    const state = {
      setActiveRoom: mockState.setActiveRoom,
    }
    return selector(state)
  },
  useConnectionStore: (selector: (s: { status: string }) => unknown) =>
    selector({ status: 'online' }),
}))

// Mock Tauri notification plugin (avoid import errors)
vi.mock('@tauri-apps/plugin-notification', () => ({
  removeAllActive: vi.fn(),
}))

// Track location changes
let currentLocation: { pathname: string; search: string } = { pathname: '/', search: '' }

function LocationTracker() {
  const location = useLocation()
  currentLocation = { pathname: location.pathname, search: location.search }
  return null
}

// Router wrapper for testing
function createWrapper(initialPath = '/') {
  return function Wrapper({ children }: { children: ReactNode }) {
    return (
      <MemoryRouter initialEntries={[initialPath]}>
        <LocationTracker />
        {children}
      </MemoryRouter>
    )
  }
}

describe('useNavigateToTarget', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    currentLocation = { pathname: '/', search: '' }
    mockState.setActiveConversation = vi.fn()
    mockState.setActiveRoom = vi.fn()
  })

  describe('navigateToConversation', () => {
    it('should navigate to messages URL with encoded JID', () => {
      const { result } = renderHook(() => useNavigateToTarget(), {
        wrapper: createWrapper('/messages'),
      })

      act(() => {
        result.current.navigateToConversation('alice@example.com')
      })

      expect(currentLocation.pathname).toBe('/messages/alice%40example.com')
      expect(mockState.setActiveConversation).toHaveBeenCalledWith('alice@example.com')
    })

    it('should navigate from any view to messages', () => {
      const { result } = renderHook(() => useNavigateToTarget(), {
        wrapper: createWrapper('/rooms'),
      })

      act(() => {
        result.current.navigateToConversation('bob@example.com')
      })

      expect(currentLocation.pathname).toBe('/messages/bob%40example.com')
      expect(mockState.setActiveConversation).toHaveBeenCalledWith('bob@example.com')
    })

    it('should handle JIDs with special characters', () => {
      const { result } = renderHook(() => useNavigateToTarget(), {
        wrapper: createWrapper('/messages'),
      })

      act(() => {
        result.current.navigateToConversation('user+tag@example.com/resource')
      })

      // URL should be properly encoded
      expect(currentLocation.pathname).toContain('/messages/')
      expect(mockState.setActiveConversation).toHaveBeenCalledWith('user+tag@example.com/resource')
    })
  })

  describe('navigateToRoom', () => {
    it('should navigate to rooms URL with encoded JID', () => {
      const { result } = renderHook(() => useNavigateToTarget(), {
        wrapper: createWrapper('/rooms'),
      })

      act(() => {
        result.current.navigateToRoom('general@conference.example.com')
      })

      expect(currentLocation.pathname).toBe('/rooms/general%40conference.example.com')
      expect(mockState.setActiveRoom).toHaveBeenCalledWith('general@conference.example.com')
    })

    it('should navigate from any view to rooms', () => {
      const { result } = renderHook(() => useNavigateToTarget(), {
        wrapper: createWrapper('/messages'),
      })

      act(() => {
        result.current.navigateToRoom('dev@conference.example.com')
      })

      expect(currentLocation.pathname).toBe('/rooms/dev%40conference.example.com')
      expect(mockState.setActiveRoom).toHaveBeenCalledWith('dev@conference.example.com')
    })
  })

  describe('function stability', () => {
    it('should return stable function references', () => {
      const { result, rerender } = renderHook(() => useNavigateToTarget(), {
        wrapper: createWrapper('/messages'),
      })

      const firstNavigateToConversation = result.current.navigateToConversation
      const firstNavigateToRoom = result.current.navigateToRoom

      rerender()

      // Functions should be referentially stable (memoized)
      expect(result.current.navigateToConversation).toBe(firstNavigateToConversation)
      expect(result.current.navigateToRoom).toBe(firstNavigateToRoom)
    })
  })

})
