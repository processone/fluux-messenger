import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { MemoryRouter, useLocation } from 'react-router-dom'
import { useEffect, type ReactNode } from 'react'
import { useNavigateToTarget } from './useNavigateToTarget'

// Shared mock state that tests can modify
const mockState = {
  activateConversation: vi.fn(),
  activateRoom: vi.fn(),
  setChatTargetMessageId: vi.fn(),
  setRoomTargetMessageId: vi.fn(),
}

// Mock SDK (no React hooks needed here)
vi.mock('@fluux/sdk', () => ({}))

// Mock React store hooks (from @fluux/sdk/react)
vi.mock('@fluux/sdk/react', () => ({
  useChatStore: (selector: (s: unknown) => unknown) => {
    const state = {
      activateConversation: mockState.activateConversation,
      setTargetMessageId: mockState.setChatTargetMessageId,
    }
    return selector(state)
  },
  useRoomStore: (selector: (s: unknown) => unknown) => {
    const state = {
      activateRoom: mockState.activateRoom,
      setTargetMessageId: mockState.setRoomTargetMessageId,
    }
    return selector(state)
  },
  useConnectionStore: (selector: (s: { status: string }) => unknown) =>
    selector({ status: 'online' }),
  useContactTime: () => null, useLastActivity: vi.fn(),
}))

// Mock Tauri notification plugin (avoid import errors)
vi.mock('@tauri-apps/plugin-notification', () => ({
  removeAllActive: vi.fn(),
}))

// Track location changes
const currentLocation = { current: { pathname: '/', search: '' } }

function LocationTracker() {
  const location = useLocation()
  useEffect(() => {
    currentLocation.current = { pathname: location.pathname, search: location.search }
  })
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
    currentLocation.current = { pathname: '/', search: '' }
    mockState.activateConversation = vi.fn()
    mockState.activateRoom = vi.fn()
    mockState.setChatTargetMessageId = vi.fn()
    mockState.setRoomTargetMessageId = vi.fn()
  })

  describe('navigateToConversation', () => {
    it('should navigate to messages URL with encoded JID', () => {
      const { result } = renderHook(() => useNavigateToTarget(), {
        wrapper: createWrapper('/messages'),
      })

      act(() => {
        result.current.navigateToConversation('alice@example.com')
      })

      expect(currentLocation.current.pathname).toBe('/messages/alice%40example.com')
      expect(mockState.activateConversation).toHaveBeenCalledWith('alice@example.com')
    })

    it('should navigate from any view to messages', () => {
      const { result } = renderHook(() => useNavigateToTarget(), {
        wrapper: createWrapper('/rooms'),
      })

      act(() => {
        result.current.navigateToConversation('bob@example.com')
      })

      expect(currentLocation.current.pathname).toBe('/messages/bob%40example.com')
      expect(mockState.activateConversation).toHaveBeenCalledWith('bob@example.com')
    })

    it('should handle JIDs with special characters', () => {
      const { result } = renderHook(() => useNavigateToTarget(), {
        wrapper: createWrapper('/messages'),
      })

      act(() => {
        result.current.navigateToConversation('user+tag@example.com/resource')
      })

      // URL should be properly encoded
      expect(currentLocation.current.pathname).toContain('/messages/')
      expect(mockState.activateConversation).toHaveBeenCalledWith('user+tag@example.com/resource')
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

      expect(currentLocation.current.pathname).toBe('/rooms/general%40conference.example.com')
      expect(mockState.activateRoom).toHaveBeenCalledWith('general@conference.example.com')
    })

    it('should navigate from any view to rooms', () => {
      const { result } = renderHook(() => useNavigateToTarget(), {
        wrapper: createWrapper('/messages'),
      })

      act(() => {
        result.current.navigateToRoom('dev@conference.example.com')
      })

      expect(currentLocation.current.pathname).toBe('/rooms/dev%40conference.example.com')
      expect(mockState.activateRoom).toHaveBeenCalledWith('dev@conference.example.com')
    })

    it('should set targetMessageId in room store when messageId is provided', () => {
      const { result } = renderHook(() => useNavigateToTarget(), {
        wrapper: createWrapper('/rooms'),
      })

      act(() => {
        result.current.navigateToRoom('general@conference.example.com', 'msg-456')
      })

      expect(mockState.setRoomTargetMessageId).toHaveBeenCalledWith('msg-456')
      expect(mockState.activateRoom).toHaveBeenCalledWith('general@conference.example.com')
    })

    it('should not set targetMessageId when messageId is omitted', () => {
      const { result } = renderHook(() => useNavigateToTarget(), {
        wrapper: createWrapper('/rooms'),
      })

      act(() => {
        result.current.navigateToRoom('general@conference.example.com')
      })

      expect(mockState.setRoomTargetMessageId).not.toHaveBeenCalled()
    })
  })

  describe('navigateToContact', () => {
    it('should navigate to contacts URL with encoded JID', () => {
      const { result } = renderHook(() => useNavigateToTarget(), {
        wrapper: createWrapper('/events'),
      })

      act(() => {
        result.current.navigateToContact('alice@example.com')
      })

      expect(currentLocation.current.pathname).toBe('/contacts/alice%40example.com')
    })

    it('should clear active conversation and room', () => {
      const { result } = renderHook(() => useNavigateToTarget(), {
        wrapper: createWrapper('/messages'),
      })

      act(() => {
        result.current.navigateToContact('bob@example.com')
      })

      expect(mockState.activateConversation).toHaveBeenCalledWith(null)
      expect(mockState.activateRoom).toHaveBeenCalledWith(null)
      expect(currentLocation.current.pathname).toBe('/contacts/bob%40example.com')
    })
  })

  describe('navigateToConversation with messageId', () => {
    it('should set targetMessageId in chat store when messageId is provided', () => {
      const { result } = renderHook(() => useNavigateToTarget(), {
        wrapper: createWrapper('/messages'),
      })

      act(() => {
        result.current.navigateToConversation('alice@example.com', 'msg-123')
      })

      expect(mockState.setChatTargetMessageId).toHaveBeenCalledWith('msg-123')
      expect(mockState.activateConversation).toHaveBeenCalledWith('alice@example.com')
      expect(currentLocation.current.pathname).toBe('/messages/alice%40example.com')
    })

    it('should not set targetMessageId when messageId is omitted', () => {
      const { result } = renderHook(() => useNavigateToTarget(), {
        wrapper: createWrapper('/messages'),
      })

      act(() => {
        result.current.navigateToConversation('alice@example.com')
      })

      expect(mockState.setChatTargetMessageId).not.toHaveBeenCalled()
    })
  })

})
