import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { MemoryRouter, useLocation } from 'react-router-dom'
import type { ReactNode } from 'react'
import { useViewNavigation } from './useViewNavigation'

// Use vi.hoisted() so mock functions are available when vi.mock factory runs
const {
  mockSetActiveConversation,
  mockSetActiveRoom,
  mockMarkChatAsRead,
  mockMarkRoomAsRead,
  mockClearChatFirstNewMessageId,
  mockClearRoomFirstNewMessageId,
  getMockState,
  setMockState,
  mockChatStoreState,
  mockRoomStoreState,
} = vi.hoisted(() => {
  const state = {
    activeConversationId: null as string | null,
    activeRoomJid: null as string | null,
    conversations: new Map<string, { id: string }>(),
    isArchived: (() => false) as (id: string) => boolean,
    joinedRooms: [] as { jid: string }[],
    isSmallScreen: false,
  }
  const mocks = {
    mockSetActiveConversation: vi.fn(),
    mockSetActiveRoom: vi.fn(),
    mockMarkChatAsRead: vi.fn(),
    mockMarkRoomAsRead: vi.fn(),
    mockClearChatFirstNewMessageId: vi.fn(),
    mockClearRoomFirstNewMessageId: vi.fn(),
    getMockState: () => state,
    setMockState: (updates: Partial<typeof state>) => Object.assign(state, updates),
    // State getter functions - must be in hoisted block to be available in vi.mock factories
    mockChatStoreState: () => ({
      activeConversationId: state.activeConversationId,
      setActiveConversation: mocks.mockSetActiveConversation,
      markAsRead: mocks.mockMarkChatAsRead,
      clearFirstNewMessageId: mocks.mockClearChatFirstNewMessageId,
      conversations: state.conversations,
      isArchived: state.isArchived,
    }),
    mockRoomStoreState: () => ({
      activeRoomJid: state.activeRoomJid,
      setActiveRoom: mocks.mockSetActiveRoom,
      markAsRead: mocks.mockMarkRoomAsRead,
      clearFirstNewMessageId: mocks.mockClearRoomFirstNewMessageId,
      joinedRooms: () => state.joinedRooms,
    }),
  }
  return mocks
})

// Mock isSmallScreen function
vi.mock('./useIsMobileWeb', () => ({
  isSmallScreen: () => getMockState().isSmallScreen,
}))

// Mock SDK hooks and stores
vi.mock('@fluux/sdk', () => ({
  useChat: () => ({
    setActiveConversation: mockSetActiveConversation,
  }),
  useRoom: () => ({
    setActiveRoom: mockSetActiveRoom,
  }),
  // Vanilla stores (for imperative .getState() access)
  chatStore: { getState: mockChatStoreState },
  roomStore: { getState: mockRoomStoreState },
}))

// Mock React store hooks (from @fluux/sdk/react)
vi.mock('@fluux/sdk/react', () => ({
  useChatStore: Object.assign(
     
    (selector: (state: ReturnType<typeof mockChatStoreState>) => unknown) => selector(mockChatStoreState()),
    { getState: mockChatStoreState }
  ),
  useRoomStore: Object.assign(
     
    (selector: (state: ReturnType<typeof mockRoomStoreState>) => unknown) => selector(mockRoomStoreState()),
    { getState: mockRoomStoreState }
  ),
}))

// Track location changes
let currentLocation: { pathname: string } = { pathname: '/' }

function LocationTracker() {
  const location = useLocation()
  currentLocation = { pathname: location.pathname }
  return null
}

// Helper to decode URI component for pathname assertions
function getDecodedPath() {
  return decodeURIComponent(currentLocation.pathname)
}

// Router wrapper for testing
function createWrapper(initialPath = '/messages') {
  return function Wrapper({ children }: { children: ReactNode }) {
    return (
      <MemoryRouter initialEntries={[initialPath]}>
        <LocationTracker />
        {children}
      </MemoryRouter>
    )
  }
}

describe('useViewNavigation', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    currentLocation = { pathname: '/' }
    // Reset mock state using setter
    setMockState({
      activeConversationId: null,
      activeRoomJid: null,
      conversations: new Map(),
      isArchived: () => false,
      joinedRooms: [],
      isSmallScreen: false, // Default to desktop/large screen mode
    })
  })

  describe('initial state', () => {
    it('should return initial state with null per-tab memory', () => {
      const { result } = renderHook(() => useViewNavigation(null), {
        wrapper: createWrapper('/messages'),
      })

      expect(result.current.perTabMemory).toEqual({
        lastMessagesConversation: null,
        lastRoomsRoom: null,
        lastDirectoryContact: null,
      })
    })

    it('should derive sidebarView from URL', () => {
      const { result } = renderHook(() => useViewNavigation(null), {
        wrapper: createWrapper('/rooms'),
      })

      expect(result.current.sidebarView).toBe('rooms')
    })
  })

  describe('navigateToView', () => {
    it('should navigate to messages view', () => {
      const { result } = renderHook(() => useViewNavigation(null), {
        wrapper: createWrapper('/rooms'),
      })

      act(() => {
        result.current.navigateToView('messages')
      })

      expect(currentLocation.pathname).toBe('/messages')
      expect(mockSetActiveRoom).toHaveBeenCalledWith(null)
    })

    it('should navigate to rooms view', () => {
      const { result } = renderHook(() => useViewNavigation(null), {
        wrapper: createWrapper('/messages'),
      })

      act(() => {
        result.current.navigateToView('rooms')
      })

      expect(currentLocation.pathname).toBe('/rooms')
      expect(mockSetActiveConversation).toHaveBeenCalledWith(null)
    })

    it('should navigate to directory view', () => {
      const { result } = renderHook(() => useViewNavigation(null), {
        wrapper: createWrapper('/messages'),
      })

      act(() => {
        result.current.navigateToView('directory')
      })

      expect(currentLocation.pathname).toBe('/contacts')
      expect(mockSetActiveConversation).toHaveBeenCalledWith(null)
      expect(mockSetActiveRoom).toHaveBeenCalledWith(null)
    })

    it('should navigate to archive view', () => {
      const { result } = renderHook(() => useViewNavigation(null), {
        wrapper: createWrapper('/messages'),
      })

      act(() => {
        result.current.navigateToView('archive')
      })

      expect(currentLocation.pathname).toBe('/archive')
    })

    it('should navigate to events view', () => {
      const { result } = renderHook(() => useViewNavigation(null), {
        wrapper: createWrapper('/messages'),
      })

      act(() => {
        result.current.navigateToView('events')
      })

      expect(currentLocation.pathname).toBe('/events')
    })

    it('should navigate to admin view', () => {
      const { result } = renderHook(() => useViewNavigation(null), {
        wrapper: createWrapper('/messages'),
      })

      act(() => {
        result.current.navigateToView('admin')
      })

      expect(currentLocation.pathname).toBe('/admin')
      expect(mockSetActiveConversation).toHaveBeenCalledWith(null)
      expect(mockSetActiveRoom).toHaveBeenCalledWith(null)
    })
  })

  describe('settings view navigation', () => {
    it('should navigate to settings view', () => {
      const { result } = renderHook(() => useViewNavigation(null), {
        wrapper: createWrapper('/messages'),
      })

      act(() => {
        result.current.navigateToView('settings')
      })

      expect(currentLocation.pathname).toBe('/settings/profile')
      expect(mockSetActiveConversation).toHaveBeenCalledWith(null)
      expect(mockSetActiveRoom).toHaveBeenCalledWith(null)
    })
  })

  describe('auto-select first item', () => {
    it('should auto-select first non-archived conversation when navigating to messages with no previous selection', () => {
      // Set up conversations in store
      setMockState({
        conversations: new Map([
          ['user1@example.com', { id: 'user1@example.com' }],
          ['user2@example.com', { id: 'user2@example.com' }],
        ]),
      })

      const { result } = renderHook(() => useViewNavigation(null), {
        wrapper: createWrapper('/rooms'),
      })

      act(() => {
        result.current.navigateToView('messages')
      })

      // Should navigate to URL with first conversation (URL-encoded)
      expect(getDecodedPath()).toBe('/messages/user1@example.com')
      // Should also set store state
      expect(mockSetActiveConversation).toHaveBeenCalledWith('user1@example.com')
    })

    it('should skip archived conversations when auto-selecting', () => {
      setMockState({
        conversations: new Map([
          ['archived@example.com', { id: 'archived@example.com' }],
          ['active@example.com', { id: 'active@example.com' }],
        ]),
        isArchived: (id: string) => id === 'archived@example.com',
      })

      const { result } = renderHook(() => useViewNavigation(null), {
        wrapper: createWrapper('/rooms'),
      })

      act(() => {
        result.current.navigateToView('messages')
      })

      // Should skip archived and select the active one
      expect(getDecodedPath()).toBe('/messages/active@example.com')
      expect(mockSetActiveConversation).toHaveBeenCalledWith('active@example.com')
    })

    it('should auto-select first joined room when navigating to rooms with no previous selection', () => {
      setMockState({
        joinedRooms: [
          { jid: 'room1@conference.example.com' },
          { jid: 'room2@conference.example.com' },
        ],
      })

      const { result } = renderHook(() => useViewNavigation(null), {
        wrapper: createWrapper('/messages'),
      })

      act(() => {
        result.current.navigateToView('rooms')
      })

      // Should navigate to URL with first room
      expect(getDecodedPath()).toBe('/rooms/room1@conference.example.com')
      // Should also set store state
      expect(mockSetActiveRoom).toHaveBeenCalledWith('room1@conference.example.com')
    })

    it('should auto-select first archived conversation when navigating to archive', () => {
      setMockState({
        conversations: new Map([
          ['active@example.com', { id: 'active@example.com' }],
          ['archived@example.com', { id: 'archived@example.com' }],
        ]),
        isArchived: (id: string) => id === 'archived@example.com',
      })

      const { result } = renderHook(() => useViewNavigation(null), {
        wrapper: createWrapper('/messages'),
      })

      act(() => {
        result.current.navigateToView('archive')
      })

      // Should select the archived conversation
      expect(getDecodedPath()).toBe('/archive/archived@example.com')
      expect(mockSetActiveConversation).toHaveBeenCalledWith('archived@example.com')
    })

    it('should navigate without selection when no conversations exist', () => {
      setMockState({ conversations: new Map() })

      const { result } = renderHook(() => useViewNavigation(null), {
        wrapper: createWrapper('/rooms'),
      })

      act(() => {
        result.current.navigateToView('messages')
      })

      // Should navigate to messages without a specific conversation
      expect(currentLocation.pathname).toBe('/messages')
      // setActiveConversation should not be called with a value (only called with null for clearing)
      expect(mockSetActiveConversation).not.toHaveBeenCalledWith(expect.stringContaining('@'))
    })

    it('should navigate without selection when no rooms exist', () => {
      setMockState({ joinedRooms: [] })

      const { result } = renderHook(() => useViewNavigation(null), {
        wrapper: createWrapper('/messages'),
      })

      act(() => {
        result.current.navigateToView('rooms')
      })

      expect(currentLocation.pathname).toBe('/rooms')
      // setActiveRoom should not be called with a value
      expect(mockSetActiveRoom).not.toHaveBeenCalledWith(expect.stringContaining('@'))
    })
  })

  describe('per-tab memory', () => {
    it('should save conversation id when leaving messages tab', () => {
      setMockState({ activeConversationId: 'user@example.com' })

      const { result } = renderHook(() => useViewNavigation(null), {
        wrapper: createWrapper('/messages/user@example.com'),
      })

      // Navigate away from messages - this should save the conversation and mark as read
      act(() => {
        result.current.navigateToView('rooms')
      })

      // The per-tab memory should have saved the conversation and marked as read
      expect(mockMarkChatAsRead).toHaveBeenCalledWith('user@example.com')
    })

    it('should save room jid when leaving rooms tab', () => {
      setMockState({ activeRoomJid: 'room@conference.example.com' })

      const { result } = renderHook(() => useViewNavigation(null), {
        wrapper: createWrapper('/rooms/room@conference.example.com'),
      })

      // Navigate away from rooms
      act(() => {
        result.current.navigateToView('messages')
      })

      // Should have marked the room as read
      expect(mockMarkRoomAsRead).toHaveBeenCalledWith('room@conference.example.com')
    })

    it('should restore per-tab memory when returning to messages', () => {
      // Set up with existing conversations
      setMockState({
        conversations: new Map([
          ['user1@example.com', { id: 'user1@example.com' }],
          ['user2@example.com', { id: 'user2@example.com' }],
        ]),
        activeConversationId: 'user2@example.com',
      })

      const { result } = renderHook(() => useViewNavigation(null), {
        wrapper: createWrapper('/messages/user2@example.com'),
      })

      // Navigate away (saves user2 to per-tab memory)
      act(() => {
        result.current.navigateToView('rooms')
      })

      // Reset active conversation to simulate store state
      setMockState({ activeConversationId: null })

      // Navigate back to messages
      act(() => {
        result.current.navigateToView('messages')
      })

      // Should restore user2, not auto-select user1
      expect(getDecodedPath()).toBe('/messages/user2@example.com')
    })

    it('should restore per-tab memory when returning to rooms', () => {
      setMockState({
        joinedRooms: [
          { jid: 'room1@conference.example.com' },
          { jid: 'room2@conference.example.com' },
        ],
        activeRoomJid: 'room2@conference.example.com',
      })

      const { result } = renderHook(() => useViewNavigation(null), {
        wrapper: createWrapper('/rooms/room2@conference.example.com'),
      })

      // Navigate away (saves room2 to per-tab memory)
      act(() => {
        result.current.navigateToView('messages')
      })

      // Reset active room
      setMockState({ activeRoomJid: null })

      // Navigate back to rooms
      act(() => {
        result.current.navigateToView('rooms')
      })

      // Should restore room2, not auto-select room1
      expect(getDecodedPath()).toBe('/rooms/room2@conference.example.com')
    })
  })

  describe('mark as read on leave', () => {
    it('should mark conversation as read when leaving messages tab', () => {
      setMockState({ activeConversationId: 'user@example.com' })

      const { result } = renderHook(() => useViewNavigation(null), {
        wrapper: createWrapper('/messages/user@example.com'),
      })

      act(() => {
        result.current.navigateToView('rooms')
      })

      expect(mockMarkChatAsRead).toHaveBeenCalledWith('user@example.com')
    })

    it('should mark room as read when leaving rooms tab', () => {
      setMockState({ activeRoomJid: 'room@conference.example.com' })

      const { result } = renderHook(() => useViewNavigation(null), {
        wrapper: createWrapper('/rooms/room@conference.example.com'),
      })

      act(() => {
        result.current.navigateToView('messages')
      })

      expect(mockMarkRoomAsRead).toHaveBeenCalledWith('room@conference.example.com')
    })

    it('should not mark as read when no active conversation', () => {
      setMockState({ activeConversationId: null })

      const { result } = renderHook(() => useViewNavigation(null), {
        wrapper: createWrapper('/messages'),
      })

      act(() => {
        result.current.navigateToView('rooms')
      })

      expect(mockMarkChatAsRead).not.toHaveBeenCalled()
    })

    it('should not mark as read when no active room', () => {
      setMockState({ activeRoomJid: null })

      const { result } = renderHook(() => useViewNavigation(null), {
        wrapper: createWrapper('/rooms'),
      })

      act(() => {
        result.current.navigateToView('messages')
      })

      expect(mockMarkRoomAsRead).not.toHaveBeenCalled()
    })

    it('should clear new message marker when leaving messages tab', () => {
      setMockState({ activeConversationId: 'user@example.com' })

      const { result } = renderHook(() => useViewNavigation(null), {
        wrapper: createWrapper('/messages/user@example.com'),
      })

      act(() => {
        result.current.navigateToView('rooms')
      })

      expect(mockClearChatFirstNewMessageId).toHaveBeenCalledWith('user@example.com')
    })

    it('should clear new message marker when leaving rooms tab', () => {
      setMockState({ activeRoomJid: 'room@conference.example.com' })

      const { result } = renderHook(() => useViewNavigation(null), {
        wrapper: createWrapper('/rooms/room@conference.example.com'),
      })

      act(() => {
        result.current.navigateToView('messages')
      })

      expect(mockClearRoomFirstNewMessageId).toHaveBeenCalledWith('room@conference.example.com')
    })

    it('should not clear new message marker when no active conversation', () => {
      setMockState({ activeConversationId: null })

      const { result } = renderHook(() => useViewNavigation(null), {
        wrapper: createWrapper('/messages'),
      })

      act(() => {
        result.current.navigateToView('rooms')
      })

      expect(mockClearChatFirstNewMessageId).not.toHaveBeenCalled()
    })

    it('should not clear new message marker when no active room', () => {
      setMockState({ activeRoomJid: null })

      const { result } = renderHook(() => useViewNavigation(null), {
        wrapper: createWrapper('/rooms'),
      })

      act(() => {
        result.current.navigateToView('messages')
      })

      expect(mockClearRoomFirstNewMessageId).not.toHaveBeenCalled()
    })
  })

  describe('clear conflicting state', () => {
    it('should clear activeRoom when navigating to messages', () => {
      const { result } = renderHook(() => useViewNavigation(null), {
        wrapper: createWrapper('/rooms'),
      })

      act(() => {
        result.current.navigateToView('messages')
      })

      expect(mockSetActiveRoom).toHaveBeenCalledWith(null)
    })

    it('should clear activeConversation when navigating to rooms', () => {
      const { result } = renderHook(() => useViewNavigation(null), {
        wrapper: createWrapper('/messages'),
      })

      act(() => {
        result.current.navigateToView('rooms')
      })

      expect(mockSetActiveConversation).toHaveBeenCalledWith(null)
    })

    it('should clear both when navigating to admin', () => {
      const { result } = renderHook(() => useViewNavigation(null), {
        wrapper: createWrapper('/messages'),
      })

      act(() => {
        result.current.navigateToView('admin')
      })

      expect(mockSetActiveConversation).toHaveBeenCalledWith(null)
      expect(mockSetActiveRoom).toHaveBeenCalledWith(null)
    })

    it('should clear both when navigating to settings', () => {
      const { result } = renderHook(() => useViewNavigation(null), {
        wrapper: createWrapper('/messages'),
      })

      act(() => {
        result.current.navigateToView('settings')
      })

      expect(mockSetActiveConversation).toHaveBeenCalledWith(null)
      expect(mockSetActiveRoom).toHaveBeenCalledWith(null)
    })

    it('should clear both when navigating to directory', () => {
      const { result } = renderHook(() => useViewNavigation(null), {
        wrapper: createWrapper('/messages'),
      })

      act(() => {
        result.current.navigateToView('directory')
      })

      expect(mockSetActiveConversation).toHaveBeenCalledWith(null)
      expect(mockSetActiveRoom).toHaveBeenCalledWith(null)
    })
  })

  describe('small screen behavior', () => {
    beforeEach(() => {
      setMockState({ isSmallScreen: true })
    })

    it('should skip auto-selection when navigating to messages on small screen', () => {
      setMockState({
        conversations: new Map([
          ['user1@example.com', { id: 'user1@example.com' }],
          ['user2@example.com', { id: 'user2@example.com' }],
        ]),
      })

      const { result } = renderHook(() => useViewNavigation(null), {
        wrapper: createWrapper('/rooms'),
      })

      act(() => {
        result.current.navigateToView('messages')
      })

      // Should navigate to /messages without auto-selecting a conversation
      expect(currentLocation.pathname).toBe('/messages')
      // setActiveConversation should NOT be called with a JID
      expect(mockSetActiveConversation).not.toHaveBeenCalledWith('user1@example.com')
    })

    it('should skip auto-selection when navigating to rooms on small screen', () => {
      setMockState({
        joinedRooms: [
          { jid: 'room1@conference.example.com' },
          { jid: 'room2@conference.example.com' },
        ],
      })

      const { result } = renderHook(() => useViewNavigation(null), {
        wrapper: createWrapper('/messages'),
      })

      act(() => {
        result.current.navigateToView('rooms')
      })

      // Should navigate to /rooms without auto-selecting a room
      expect(currentLocation.pathname).toBe('/rooms')
      // setActiveRoom should NOT be called with a JID
      expect(mockSetActiveRoom).not.toHaveBeenCalledWith('room1@conference.example.com')
    })

    it('should skip auto-selection when navigating to archive on small screen', () => {
      setMockState({
        conversations: new Map([
          ['active@example.com', { id: 'active@example.com' }],
          ['archived@example.com', { id: 'archived@example.com' }],
        ]),
        isArchived: (id: string) => id === 'archived@example.com',
      })

      const { result } = renderHook(() => useViewNavigation(null), {
        wrapper: createWrapper('/messages'),
      })

      act(() => {
        result.current.navigateToView('archive')
      })

      // Should navigate to /archive without auto-selecting
      expect(currentLocation.pathname).toBe('/archive')
      // setActiveConversation should NOT be called with archived JID
      expect(mockSetActiveConversation).not.toHaveBeenCalledWith('archived@example.com')
    })

    it('should skip auto-restoring last contact when navigating to directory on small screen', () => {
      const mockContact = { jid: 'contact@example.com', name: 'Test Contact' }

      // Start with a selected contact on directory
      setMockState({
        activeConversationId: null,
        activeRoomJid: null,
      })

      const { result } = renderHook(
        ({ contact }) => useViewNavigation(contact),
        {
          wrapper: createWrapper('/contacts/contact@example.com'),
          initialProps: { contact: mockContact as any },
        }
      )

      // Navigate away (saves contact to per-tab memory)
      act(() => {
        result.current.navigateToView('messages')
      })

      // Now navigate back to directory
      act(() => {
        result.current.navigateToView('directory')
      })

      // On mobile, should navigate to /contacts without auto-restoring the contact
      expect(currentLocation.pathname).toBe('/contacts')
    })

    it('should still use per-tab memory on small screen if previously selected', () => {
      setMockState({
        conversations: new Map([
          ['user1@example.com', { id: 'user1@example.com' }],
          ['user2@example.com', { id: 'user2@example.com' }],
        ]),
        activeConversationId: 'user2@example.com',
      })

      const { result } = renderHook(() => useViewNavigation(null), {
        wrapper: createWrapper('/messages/user2@example.com'),
      })

      // Navigate away (saves user2 to per-tab memory)
      act(() => {
        result.current.navigateToView('rooms')
      })

      setMockState({ activeConversationId: null })

      // Navigate back to messages
      act(() => {
        result.current.navigateToView('messages')
      })

      // On mobile, per-tab memory should still be used (user manually selected before)
      expect(getDecodedPath()).toBe('/messages/user2@example.com')
    })
  })

})
