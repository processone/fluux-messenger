import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook } from '@testing-library/react'
import { useNotificationBadge } from './useNotificationBadge'

// Shared state that mocks can access
const mockState = {
  conversations: new Map<string, unknown>(),
  activeConversationId: null as string | null,
  roomsWithUnreadCount: 0,
  pendingCount: 0,
}

// Mock the notification debug utility
vi.mock('@/utils/notificationDebug', () => ({
  notificationDebug: {
    dockBadge: vi.fn(),
    focusChange: vi.fn(),
    unreadUpdate: vi.fn(),
  },
}))

// Mock Tauri window API
const mockSetBadgeCount = vi.fn()
vi.mock('@tauri-apps/api/window', () => ({
  getCurrentWindow: () => ({
    setBadgeCount: mockSetBadgeCount,
  }),
}))

// Mock the SDK - use inline functions that read from mockState
vi.mock('@fluux/sdk', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@fluux/sdk')>()
  return {
    ...actual,
    useEvents: () => ({
      pendingCount: mockState.pendingCount,
    }),
    // Vanilla stores (for imperative .getState() access)
    chatStore: {
      getState: () => ({
        conversations: mockState.conversations,
        activeConversationId: mockState.activeConversationId,
      }),
      subscribe: vi.fn(() => () => {}),
    },
    roomStore: {
      getState: () => ({}),
      subscribe: vi.fn(() => () => {}),
    },
  }
})

// Mock React store hooks (from @fluux/sdk/react)
vi.mock('@fluux/sdk/react', () => ({
  useChatStore: Object.assign(
    (selector: (s: unknown) => unknown) => {
      const state = {
        conversations: mockState.conversations,
        activeConversationId: mockState.activeConversationId,
      }
      return selector(state)
    },
    {
      getState: () => ({
        conversations: mockState.conversations,
        activeConversationId: mockState.activeConversationId,
      }),
      subscribe: vi.fn(() => () => {}),
    }
  ),
  useRoomStore: Object.assign(
    (selector: (s: unknown) => unknown) => {
      const state = {
        roomsWithUnreadCount: () => mockState.roomsWithUnreadCount,
      }
      return selector(state)
    },
    {
      getState: () => ({}),
      subscribe: vi.fn(() => () => {}),
    }
  ),
}))

// Helper to create a conversation and add to mock data
function setMockConversations(conversations: Array<{
  id: string
  unreadCount: number
  lastMessage?: { id: string; body: string; timestamp: Date; isOutgoing: boolean }
}>) {
  mockState.conversations = new Map(conversations.map(c => [c.id, c]))
}

describe('useNotificationBadge', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockSetBadgeCount.mockClear()

    // Reset all mock state
    mockState.conversations = new Map()
    mockState.activeConversationId = null
    mockState.roomsWithUnreadCount = 0
    mockState.pendingCount = 0

    // Mock Tauri detection
    // @ts-expect-error - mocking Tauri internals
    window.__TAURI_INTERNALS__ = {}
  })

  afterEach(() => {
    // @ts-expect-error - cleaning up Tauri mock
    delete window.__TAURI_INTERNALS__
  })

  describe('store-driven unread tracking', () => {
    it('should show badge when store has unread messages', async () => {
      // When a message arrives while window is blurred, the store sets unreadCount > 0
      setMockConversations([{
        id: 'user@example.com',
        unreadCount: 1,
      }])

      renderHook(() => useNotificationBadge())

      await vi.waitFor(() => {
        expect(mockSetBadgeCount).toHaveBeenCalledWith(1)
      })
    })

    it('should clear badge when store unread count goes to zero', async () => {
      // When window refocuses, useWindowVisibility calls markAsRead → unreadCount = 0
      setMockConversations([{
        id: 'user@example.com',
        unreadCount: 0,
      }])

      renderHook(() => useNotificationBadge())

      await vi.waitFor(() => {
        expect(mockSetBadgeCount).toHaveBeenCalledWith(undefined)
      })
    })
  })

  describe('badge calculation', () => {
    it('should include conversations unread count', async () => {
      setMockConversations([
        { id: 'a', unreadCount: 1 },
        { id: 'b', unreadCount: 2 },
      ])

      renderHook(() => useNotificationBadge())

      await vi.waitFor(() => {
        expect(mockSetBadgeCount).toHaveBeenCalledWith(2) // 2 conversations with unread
      })
    })

    it('should include events pending count', async () => {
      mockState.pendingCount = 3

      renderHook(() => useNotificationBadge())

      await vi.waitFor(() => {
        expect(mockSetBadgeCount).toHaveBeenCalledWith(3)
      })
    })

    it('should include rooms with unread count', async () => {
      mockState.roomsWithUnreadCount = 2

      renderHook(() => useNotificationBadge())

      await vi.waitFor(() => {
        expect(mockSetBadgeCount).toHaveBeenCalledWith(2)
      })
    })

    it('should sum all badge sources', async () => {
      setMockConversations([
        { id: 'a', unreadCount: 1 },
      ])
      mockState.pendingCount = 2
      mockState.roomsWithUnreadCount = 3

      renderHook(() => useNotificationBadge())

      await vi.waitFor(() => {
        expect(mockSetBadgeCount).toHaveBeenCalledWith(6) // 1 + 2 + 3
      })
    })

    it('should clear badge when all counts are zero', async () => {
      setMockConversations([])
      mockState.pendingCount = 0
      mockState.roomsWithUnreadCount = 0

      renderHook(() => useNotificationBadge())

      await vi.waitFor(() => {
        expect(mockSetBadgeCount).toHaveBeenCalledWith(undefined)
      })
    })
  })
})
