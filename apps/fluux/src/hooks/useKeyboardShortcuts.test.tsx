import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook } from '@testing-library/react'
import { useKeyboardShortcuts } from './useKeyboardShortcuts'

// Shared mock state that tests can modify
const mockState = {
  conversations: [] as Array<{ id: string; unreadCount: number }>,
  activeConversationId: null as string | null,
  joinedRooms: [] as Array<{ jid: string; mentionsCount: number; unreadCount: number }>,
  activeRoomJid: null as string | null,
  archivedConversations: new Set<string>(),
  setActiveConversation: vi.fn(),
  setActiveRoom: vi.fn(),
}

// Mock SDK - vanilla stores only
vi.mock('@fluux/sdk', () => ({
  // Vanilla stores (for imperative .getState() access)
  chatStore: {
    getState: () => ({
      conversations: new Map(mockState.conversations.map(c => [c.id, c])),
      activeConversationId: mockState.activeConversationId,
      archivedConversations: mockState.archivedConversations,
    }),
  },
  roomStore: {
    getState: () => ({
      joinedRooms: () => mockState.joinedRooms,
      activeRoomJid: mockState.activeRoomJid,
    }),
  },
}))

// Mock React store hooks (from @fluux/sdk/react)
vi.mock('@fluux/sdk/react', () => ({
  useChatStore: Object.assign(
    (selector: (s: unknown) => unknown) => {
      const state = {
        setActiveConversation: mockState.setActiveConversation,
        conversations: new Map(mockState.conversations.map(c => [c.id, c])),
        activeConversationId: mockState.activeConversationId,
        archivedConversations: mockState.archivedConversations,
      }
      return selector(state)
    },
    {
      getState: () => ({
        conversations: new Map(mockState.conversations.map(c => [c.id, c])),
        activeConversationId: mockState.activeConversationId,
        archivedConversations: mockState.archivedConversations,
      }),
    }
  ),
  useRoomStore: Object.assign(
    (selector: (s: unknown) => unknown) => {
      const state = {
        setActiveRoom: mockState.setActiveRoom,
        joinedRooms: () => mockState.joinedRooms,
        activeRoomJid: mockState.activeRoomJid,
      }
      return selector(state)
    },
    {
      getState: () => ({
        joinedRooms: () => mockState.joinedRooms,
        activeRoomJid: mockState.activeRoomJid,
      }),
    }
  ),
}))

describe('useKeyboardShortcuts', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    // Reset mock state before each test
    mockState.conversations = []
    mockState.activeConversationId = null
    mockState.setActiveConversation = vi.fn()
    mockState.joinedRooms = []
    mockState.activeRoomJid = null
    mockState.setActiveRoom = vi.fn()
    mockState.archivedConversations = new Set()
  })

  const createDefaultOptions = () => ({
    onToggleShortcutHelp: vi.fn(),
    onToggleConsole: vi.fn(),
    onOpenSettings: vi.fn(),
    onCreateQuickChat: vi.fn(),
    onOpenCommandPalette: vi.fn(),
    onOpenPresenceMenu: vi.fn(),
    sidebarView: 'messages' as const,
    onSidebarViewChange: vi.fn(),
  })

  describe('Next Unread (Alt+U)', () => {
    it('should navigate to conversation with unread messages', () => {
      mockState.conversations = [
        { id: 'user1@example.com', unreadCount: 0 },
        { id: 'user2@example.com', unreadCount: 3 },
      ]
      mockState.activeConversationId = 'user1@example.com'

      const { result } = renderHook(() =>
        useKeyboardShortcuts(createDefaultOptions())
      )

      const nextUnreadShortcut = result.current.find(
        s => s.key === 'u' && s.modifiers?.includes('alt')
      )
      expect(nextUnreadShortcut).toBeDefined()
      nextUnreadShortcut!.action()

      expect(mockState.setActiveConversation).toHaveBeenCalledWith('user2@example.com')
      expect(mockState.setActiveRoom).toHaveBeenCalledWith(null)
    })

    it('should navigate to room with mentions', () => {
      mockState.conversations = [] // No unread conversations
      mockState.joinedRooms = [
        { jid: 'room1@conference.example.com', mentionsCount: 0, unreadCount: 0 },
        { jid: 'room2@conference.example.com', mentionsCount: 2, unreadCount: 5 },
      ]
      mockState.activeRoomJid = 'room1@conference.example.com'

      const { result } = renderHook(() =>
        useKeyboardShortcuts(createDefaultOptions())
      )

      const nextUnreadShortcut = result.current.find(
        s => s.key === 'u' && s.modifiers?.includes('alt')
      )
      nextUnreadShortcut!.action()

      expect(mockState.setActiveRoom).toHaveBeenCalledWith('room2@conference.example.com')
      expect(mockState.setActiveConversation).toHaveBeenCalledWith(null)
    })

    it('should navigate to room with unreadCount when notifyAll is enabled (regression test)', () => {
      mockState.conversations = [] // No unread conversations
      mockState.joinedRooms = [
        { jid: 'room1@conference.example.com', mentionsCount: 0, unreadCount: 0 },
        { jid: 'room2@conference.example.com', mentionsCount: 0, unreadCount: 10 }, // notifyAll room
      ]
      mockState.activeRoomJid = 'room1@conference.example.com'

      const { result } = renderHook(() =>
        useKeyboardShortcuts(createDefaultOptions())
      )

      const nextUnreadShortcut = result.current.find(
        s => s.key === 'u' && s.modifiers?.includes('alt')
      )
      nextUnreadShortcut!.action()

      // Should navigate to room2 because it has unreadCount > 0
      expect(mockState.setActiveRoom).toHaveBeenCalledWith('room2@conference.example.com')
      expect(mockState.setActiveConversation).toHaveBeenCalledWith(null)
    })

    it('should prioritize conversations over rooms', () => {
      mockState.conversations = [
        { id: 'user1@example.com', unreadCount: 5 },
      ]
      mockState.joinedRooms = [
        { jid: 'room1@conference.example.com', mentionsCount: 3, unreadCount: 10 },
      ]
      mockState.activeConversationId = null
      mockState.activeRoomJid = null

      const { result } = renderHook(() =>
        useKeyboardShortcuts(createDefaultOptions())
      )

      const nextUnreadShortcut = result.current.find(
        s => s.key === 'u' && s.modifiers?.includes('alt')
      )
      nextUnreadShortcut!.action()

      // Should navigate to conversation first, not room
      expect(mockState.setActiveConversation).toHaveBeenCalledWith('user1@example.com')
      expect(mockState.setActiveRoom).toHaveBeenCalledWith(null)
    })

    it('should skip current conversation when finding next unread', () => {
      mockState.conversations = [
        { id: 'user1@example.com', unreadCount: 5 },
        { id: 'user2@example.com', unreadCount: 3 },
      ]
      mockState.activeConversationId = 'user1@example.com' // Current has unread but should skip

      const { result } = renderHook(() =>
        useKeyboardShortcuts(createDefaultOptions())
      )

      const nextUnreadShortcut = result.current.find(
        s => s.key === 'u' && s.modifiers?.includes('alt')
      )
      nextUnreadShortcut!.action()

      // Should navigate to user2, not stay on user1
      expect(mockState.setActiveConversation).toHaveBeenCalledWith('user2@example.com')
    })

    it('should skip current room when finding next unread', () => {
      mockState.conversations = []
      mockState.joinedRooms = [
        { jid: 'room1@conference.example.com', mentionsCount: 5, unreadCount: 10 },
        { jid: 'room2@conference.example.com', mentionsCount: 2, unreadCount: 5 },
      ]
      mockState.activeRoomJid = 'room1@conference.example.com' // Current has unread but should skip

      const { result } = renderHook(() =>
        useKeyboardShortcuts(createDefaultOptions())
      )

      const nextUnreadShortcut = result.current.find(
        s => s.key === 'u' && s.modifiers?.includes('alt')
      )
      nextUnreadShortcut!.action()

      // Should navigate to room2, not stay on room1
      expect(mockState.setActiveRoom).toHaveBeenCalledWith('room2@conference.example.com')
    })

    it('should do nothing when no unread items exist', () => {
      mockState.conversations = [
        { id: 'user1@example.com', unreadCount: 0 },
      ]
      mockState.joinedRooms = [
        { jid: 'room1@conference.example.com', mentionsCount: 0, unreadCount: 0 },
      ]

      const { result } = renderHook(() =>
        useKeyboardShortcuts(createDefaultOptions())
      )

      const nextUnreadShortcut = result.current.find(
        s => s.key === 'u' && s.modifiers?.includes('alt')
      )
      nextUnreadShortcut!.action()

      // Should not navigate anywhere
      expect(mockState.setActiveConversation).not.toHaveBeenCalled()
      expect(mockState.setActiveRoom).not.toHaveBeenCalledWith(expect.any(String))
    })
  })

  describe('Escape Hierarchy', () => {
    const createEscapeHierarchy = (overrides = {}) => ({
      isCommandPaletteOpen: false,
      onCloseCommandPalette: vi.fn(),
      isShortcutHelpOpen: false,
      onCloseShortcutHelp: vi.fn(),
      isPresenceMenuOpen: false,
      onClosePresenceMenu: vi.fn(),
      isQuickChatOpen: false,
      onCloseQuickChat: vi.fn(),
      isConsoleOpen: false,
      onCloseConsole: vi.fn(),
      isContactProfileOpen: false,
      onCloseContactProfile: vi.fn(),
      ...overrides,
    })

    it('should close Command Palette first (highest priority)', () => {
      const escapeHierarchy = createEscapeHierarchy({
        isCommandPaletteOpen: true,
        isShortcutHelpOpen: true,
        isConsoleOpen: true,
      })

      const { result } = renderHook(() =>
        useKeyboardShortcuts({
          ...createDefaultOptions(),
          escapeHierarchy,
        })
      )

      const escapeShortcut = result.current.find(s => s.key === 'Escape')
      expect(escapeShortcut).toBeDefined()
      escapeShortcut!.action()

      expect(escapeHierarchy.onCloseCommandPalette).toHaveBeenCalledTimes(1)
      expect(escapeHierarchy.onCloseShortcutHelp).not.toHaveBeenCalled()
      expect(escapeHierarchy.onCloseConsole).not.toHaveBeenCalled()
    })

    it('should close Shortcut Help when Command Palette is closed', () => {
      const escapeHierarchy = createEscapeHierarchy({
        isCommandPaletteOpen: false,
        isShortcutHelpOpen: true,
        isQuickChatOpen: true,
      })

      const { result } = renderHook(() =>
        useKeyboardShortcuts({
          ...createDefaultOptions(),
          escapeHierarchy,
        })
      )

      const escapeShortcut = result.current.find(s => s.key === 'Escape')
      escapeShortcut!.action()

      expect(escapeHierarchy.onCloseShortcutHelp).toHaveBeenCalledTimes(1)
      expect(escapeHierarchy.onCloseQuickChat).not.toHaveBeenCalled()
    })

    it('should close Quick Chat when higher priority items are closed', () => {
      const escapeHierarchy = createEscapeHierarchy({
        isQuickChatOpen: true,
        isConsoleOpen: true,
      })

      const { result } = renderHook(() =>
        useKeyboardShortcuts({
          ...createDefaultOptions(),
          escapeHierarchy,
        })
      )

      const escapeShortcut = result.current.find(s => s.key === 'Escape')
      escapeShortcut!.action()

      expect(escapeHierarchy.onCloseQuickChat).toHaveBeenCalledTimes(1)
      expect(escapeHierarchy.onCloseConsole).not.toHaveBeenCalled()
    })

    it('should close Console when modals are closed', () => {
      const escapeHierarchy = createEscapeHierarchy({
        isConsoleOpen: true,
        isContactProfileOpen: true,
      })

      const { result } = renderHook(() =>
        useKeyboardShortcuts({
          ...createDefaultOptions(),
          escapeHierarchy,
        })
      )

      const escapeShortcut = result.current.find(s => s.key === 'Escape')
      escapeShortcut!.action()

      expect(escapeHierarchy.onCloseConsole).toHaveBeenCalledTimes(1)
      expect(escapeHierarchy.onCloseContactProfile).not.toHaveBeenCalled()
    })

    it('should close Contact Profile when it is the only panel open', () => {
      const escapeHierarchy = createEscapeHierarchy({
        isContactProfileOpen: true,
      })

      const { result } = renderHook(() =>
        useKeyboardShortcuts({
          ...createDefaultOptions(),
          escapeHierarchy,
        })
      )

      const escapeShortcut = result.current.find(s => s.key === 'Escape')
      escapeShortcut!.action()

      expect(escapeHierarchy.onCloseContactProfile).toHaveBeenCalledTimes(1)
    })

    it('should blur focused input when all panels/modals are closed', () => {
      const escapeHierarchy = createEscapeHierarchy()

      const input = document.createElement('input')
      document.body.appendChild(input)
      input.focus()

      expect(document.activeElement).toBe(input)

      const { result } = renderHook(() =>
        useKeyboardShortcuts({
          ...createDefaultOptions(),
          escapeHierarchy,
        })
      )

      const escapeShortcut = result.current.find(s => s.key === 'Escape')
      escapeShortcut!.action()

      expect(document.activeElement).not.toBe(input)

      document.body.removeChild(input)
    })

    it('should blur focused textarea when all panels/modals are closed', () => {
      const escapeHierarchy = createEscapeHierarchy()

      const textarea = document.createElement('textarea')
      document.body.appendChild(textarea)
      textarea.focus()

      expect(document.activeElement).toBe(textarea)

      const { result } = renderHook(() =>
        useKeyboardShortcuts({
          ...createDefaultOptions(),
          escapeHierarchy,
        })
      )

      const escapeShortcut = result.current.find(s => s.key === 'Escape')
      escapeShortcut!.action()

      expect(document.activeElement).not.toBe(textarea)

      document.body.removeChild(textarea)
    })

    it('should do nothing when nothing is open and no input is focused', () => {
      const escapeHierarchy = createEscapeHierarchy()

      const { result } = renderHook(() =>
        useKeyboardShortcuts({
          ...createDefaultOptions(),
          escapeHierarchy,
        })
      )

      const escapeShortcut = result.current.find(s => s.key === 'Escape')

      expect(() => escapeShortcut!.action()).not.toThrow()
    })

    it('should handle escape without escapeHierarchy option', () => {
      const { result } = renderHook(() =>
        useKeyboardShortcuts(createDefaultOptions())
      )

      const escapeShortcut = result.current.find(s => s.key === 'Escape')

      expect(() => escapeShortcut!.action()).not.toThrow()
    })

    it('should close only one item per escape press', () => {
      const escapeHierarchy = createEscapeHierarchy({
        isCommandPaletteOpen: true,
        isShortcutHelpOpen: true,
        isQuickChatOpen: true,
        isConsoleOpen: true,
        isContactProfileOpen: true,
      })

      const { result } = renderHook(() =>
        useKeyboardShortcuts({
          ...createDefaultOptions(),
          escapeHierarchy,
        })
      )

      const escapeShortcut = result.current.find(s => s.key === 'Escape')
      escapeShortcut!.action()

      // Only Command Palette should be closed (highest priority)
      expect(escapeHierarchy.onCloseCommandPalette).toHaveBeenCalledTimes(1)
      expect(escapeHierarchy.onCloseShortcutHelp).not.toHaveBeenCalled()
      expect(escapeHierarchy.onCloseQuickChat).not.toHaveBeenCalled()
      expect(escapeHierarchy.onCloseConsole).not.toHaveBeenCalled()
      expect(escapeHierarchy.onCloseContactProfile).not.toHaveBeenCalled()
    })

    it('should follow correct priority order through multiple escapes', () => {
      const closeHandlers = {
        onCloseCommandPalette: vi.fn(),
        onCloseShortcutHelp: vi.fn(),
        onClosePresenceMenu: vi.fn(),
        onCloseQuickChat: vi.fn(),
        onCloseConsole: vi.fn(),
        onCloseContactProfile: vi.fn(),
      }

      let state = {
        isCommandPaletteOpen: true,
        isShortcutHelpOpen: true,
        isPresenceMenuOpen: false,
        isQuickChatOpen: true,
        isConsoleOpen: true,
        isContactProfileOpen: false,
        ...closeHandlers,
      }

      const { result, rerender } = renderHook(
        (props) => useKeyboardShortcuts(props),
        {
          initialProps: {
            ...createDefaultOptions(),
            escapeHierarchy: state,
          },
        }
      )

      // First escape: close Command Palette
      let escapeShortcut = result.current.find(s => s.key === 'Escape')
      escapeShortcut!.action()
      expect(closeHandlers.onCloseCommandPalette).toHaveBeenCalledTimes(1)

      // Update state and rerender
      state = { ...state, isCommandPaletteOpen: false }
      rerender({ ...createDefaultOptions(), escapeHierarchy: state })

      // Second escape: close Shortcut Help
      escapeShortcut = result.current.find(s => s.key === 'Escape')
      escapeShortcut!.action()
      expect(closeHandlers.onCloseShortcutHelp).toHaveBeenCalledTimes(1)

      // Update state and rerender
      state = { ...state, isShortcutHelpOpen: false }
      rerender({ ...createDefaultOptions(), escapeHierarchy: state })

      // Third escape: close Quick Chat
      escapeShortcut = result.current.find(s => s.key === 'Escape')
      escapeShortcut!.action()
      expect(closeHandlers.onCloseQuickChat).toHaveBeenCalledTimes(1)

      // Update state and rerender
      state = { ...state, isQuickChatOpen: false }
      rerender({ ...createDefaultOptions(), escapeHierarchy: state })

      // Fourth escape: close Console
      escapeShortcut = result.current.find(s => s.key === 'Escape')
      escapeShortcut!.action()
      expect(closeHandlers.onCloseConsole).toHaveBeenCalledTimes(1)
    })
  })

  describe('Escape shortcut definition', () => {
    it('should include Escape in the returned shortcuts', () => {
      const { result } = renderHook(() =>
        useKeyboardShortcuts(createDefaultOptions())
      )

      const escapeShortcut = result.current.find(s => s.key === 'Escape')
      expect(escapeShortcut).toBeDefined()
      expect(escapeShortcut!.modifiers).toEqual([])
      expect(escapeShortcut!.category).toBe('general')
      expect(escapeShortcut!.description).toBe('Close modal/panel/blur input')
    })
  })

  describe('Alt+Arrow Navigation (Previous/Next Item)', () => {
    it('should navigate to previous conversation with Alt+Up', () => {
      mockState.conversations = [
        { id: 'user1@example.com', unreadCount: 0 },
        { id: 'user2@example.com', unreadCount: 0 },
        { id: 'user3@example.com', unreadCount: 0 },
      ]
      mockState.activeConversationId = 'user2@example.com'

      const { result } = renderHook(() =>
        useKeyboardShortcuts(createDefaultOptions())
      )

      const prevShortcut = result.current.find(
        s => s.key === 'ArrowUp' && s.modifiers?.includes('alt')
      )
      expect(prevShortcut).toBeDefined()
      prevShortcut!.action()

      expect(mockState.setActiveConversation).toHaveBeenCalledWith('user1@example.com')
      expect(mockState.setActiveRoom).toHaveBeenCalledWith(null)
    })

    it('should navigate to next conversation with Alt+Down', () => {
      mockState.conversations = [
        { id: 'user1@example.com', unreadCount: 0 },
        { id: 'user2@example.com', unreadCount: 0 },
        { id: 'user3@example.com', unreadCount: 0 },
      ]
      mockState.activeConversationId = 'user2@example.com'

      const { result } = renderHook(() =>
        useKeyboardShortcuts(createDefaultOptions())
      )

      const nextShortcut = result.current.find(
        s => s.key === 'ArrowDown' && s.modifiers?.includes('alt')
      )
      expect(nextShortcut).toBeDefined()
      nextShortcut!.action()

      expect(mockState.setActiveConversation).toHaveBeenCalledWith('user3@example.com')
      expect(mockState.setActiveRoom).toHaveBeenCalledWith(null)
    })

    it('should stop at first item when pressing Alt+Up (no wrap)', () => {
      mockState.conversations = [
        { id: 'user1@example.com', unreadCount: 0 },
        { id: 'user2@example.com', unreadCount: 0 },
      ]
      mockState.activeConversationId = 'user1@example.com' // Already at first

      const { result } = renderHook(() =>
        useKeyboardShortcuts(createDefaultOptions())
      )

      const prevShortcut = result.current.find(
        s => s.key === 'ArrowUp' && s.modifiers?.includes('alt')
      )
      prevShortcut!.action()

      // Should NOT navigate (stay at first, no wrap to last)
      expect(mockState.setActiveConversation).not.toHaveBeenCalled()
      expect(mockState.setActiveRoom).not.toHaveBeenCalled()
    })

    it('should stop at last item when pressing Alt+Down (no wrap)', () => {
      mockState.conversations = [
        { id: 'user1@example.com', unreadCount: 0 },
        { id: 'user2@example.com', unreadCount: 0 },
      ]
      mockState.activeConversationId = 'user2@example.com' // Already at last

      const { result } = renderHook(() =>
        useKeyboardShortcuts(createDefaultOptions())
      )

      const nextShortcut = result.current.find(
        s => s.key === 'ArrowDown' && s.modifiers?.includes('alt')
      )
      nextShortcut!.action()

      // Should NOT navigate (stay at last, no wrap to first)
      expect(mockState.setActiveConversation).not.toHaveBeenCalled()
      expect(mockState.setActiveRoom).not.toHaveBeenCalled()
    })

    it('should select first item when Alt+Down pressed with no selection', () => {
      mockState.conversations = [
        { id: 'user1@example.com', unreadCount: 0 },
        { id: 'user2@example.com', unreadCount: 0 },
      ]
      mockState.activeConversationId = null // No selection

      const { result } = renderHook(() =>
        useKeyboardShortcuts(createDefaultOptions())
      )

      const nextShortcut = result.current.find(
        s => s.key === 'ArrowDown' && s.modifiers?.includes('alt')
      )
      nextShortcut!.action()

      expect(mockState.setActiveConversation).toHaveBeenCalledWith('user1@example.com')
    })

    it('should stop at first room when pressing Alt+Up in rooms view (no wrap)', () => {
      mockState.joinedRooms = [
        { jid: 'room1@conference.example.com', mentionsCount: 0, unreadCount: 0 },
        { jid: 'room2@conference.example.com', mentionsCount: 0, unreadCount: 0 },
      ]
      mockState.activeRoomJid = 'room1@conference.example.com' // Already at first

      const options = { ...createDefaultOptions(), sidebarView: 'rooms' as const }
      const { result } = renderHook(() => useKeyboardShortcuts(options))

      const prevShortcut = result.current.find(
        s => s.key === 'ArrowUp' && s.modifiers?.includes('alt')
      )
      prevShortcut!.action()

      // Should NOT navigate (stay at first, no wrap to last)
      expect(mockState.setActiveRoom).not.toHaveBeenCalled()
      expect(mockState.setActiveConversation).not.toHaveBeenCalled()
    })

    it('should stop at last room when pressing Alt+Down in rooms view (no wrap)', () => {
      mockState.joinedRooms = [
        { jid: 'room1@conference.example.com', mentionsCount: 0, unreadCount: 0 },
        { jid: 'room2@conference.example.com', mentionsCount: 0, unreadCount: 0 },
      ]
      mockState.activeRoomJid = 'room2@conference.example.com' // Already at last

      const options = { ...createDefaultOptions(), sidebarView: 'rooms' as const }
      const { result } = renderHook(() => useKeyboardShortcuts(options))

      const nextShortcut = result.current.find(
        s => s.key === 'ArrowDown' && s.modifiers?.includes('alt')
      )
      nextShortcut!.action()

      // Should NOT navigate (stay at last, no wrap to first)
      expect(mockState.setActiveRoom).not.toHaveBeenCalled()
      expect(mockState.setActiveConversation).not.toHaveBeenCalled()
    })
  })

  describe('Command Palette (Cmd-K)', () => {
    it('should call onOpenCommandPalette when Cmd-K is pressed', () => {
      const options = createDefaultOptions()

      const { result } = renderHook(() => useKeyboardShortcuts(options))

      const cmdKShortcut = result.current.find(
        s => s.key === 'k' && s.modifiers?.includes('meta')
      )
      expect(cmdKShortcut).toBeDefined()
      expect(cmdKShortcut!.description).toBe('Go to...')
      expect(cmdKShortcut!.category).toBe('general')

      cmdKShortcut!.action()
      expect(options.onOpenCommandPalette).toHaveBeenCalledTimes(1)
    })

    it('should close command palette when Cmd-K pressed while open (toggle)', () => {
      const options = createDefaultOptions()
      const escapeHierarchy = {
        isCommandPaletteOpen: true,
        onCloseCommandPalette: vi.fn(),
        isShortcutHelpOpen: false,
        onCloseShortcutHelp: vi.fn(),
        isPresenceMenuOpen: false,
        onClosePresenceMenu: vi.fn(),
        isQuickChatOpen: false,
        onCloseQuickChat: vi.fn(),
        isConsoleOpen: false,
        onCloseConsole: vi.fn(),
        isContactProfileOpen: false,
        onCloseContactProfile: vi.fn(),
      }

      const { result } = renderHook(() =>
        useKeyboardShortcuts({ ...options, escapeHierarchy })
      )

      const cmdKShortcut = result.current.find(
        s => s.key === 'k' && s.modifiers?.includes('meta')
      )
      expect(cmdKShortcut).toBeDefined()

      cmdKShortcut!.action()
      // Should close, not open
      expect(escapeHierarchy.onCloseCommandPalette).toHaveBeenCalledTimes(1)
      expect(options.onOpenCommandPalette).not.toHaveBeenCalled()
    })

    it('should trigger Cmd-K even when focused in an input field', async () => {
      const options = createDefaultOptions()

      renderHook(() => useKeyboardShortcuts(options))

      // Create and focus a textarea (simulating message composer)
      const textarea = document.createElement('textarea')
      document.body.appendChild(textarea)
      textarea.focus()

      // Dispatch Cmd-K event while textarea is focused
      const event = new KeyboardEvent('keydown', {
        key: 'k',
        metaKey: true,
        bubbles: true,
      })
      window.dispatchEvent(event)

      // Command palette should still open
      expect(options.onOpenCommandPalette).toHaveBeenCalledTimes(1)

      // Cleanup
      document.body.removeChild(textarea)
    })
  })
})
