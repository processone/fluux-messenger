import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook } from '@testing-library/react'
import { useKeyboardShortcuts } from './useKeyboardShortcuts'
import { useModalStore } from '../stores/modalStore'
import { useAdvancedModeStore } from '../stores/advancedModeStore'

// Mock settingsStore
const mockSettingsState = {
  themeMode: 'system' as 'light' | 'dark' | 'system',
  setThemeMode: vi.fn((mode: string) => { mockSettingsState.themeMode = mode as 'light' | 'dark' | 'system' }),
}

vi.mock('../stores/settingsStore', () => ({
  useSettingsStore: Object.assign(
    () => mockSettingsState,
    { getState: () => mockSettingsState }
  ),
}))

// Shared mock state that tests can modify
const mockState = {
  conversations: [] as Array<{ id: string; unreadCount: number }>,
  activeConversationId: null as string | null,
  joinedRooms: [] as Array<{ jid: string; mentionsCount: number; unreadCount: number }>,
  activeRoomJid: null as string | null,
  archivedConversations: new Set<string>(),
  setActiveConversation: vi.fn(),
  setActiveRoom: vi.fn(),
  chatLoadMessagesFromCache: vi.fn((_id?: string, _opts?: { limit?: number }) => Promise.resolve([])),
  roomLoadMessagesFromCache: vi.fn((_jid?: string, _opts?: { limit?: number }) => Promise.resolve([])),
}

// Mock SDK - vanilla stores only
vi.mock('@fluux/sdk', () => ({
  // Vanilla stores (for imperative .getState() access)
  chatStore: {
    getState: () => ({
      conversations: new Map(mockState.conversations.map(c => [c.id, c])),
      activeConversationId: mockState.activeConversationId,
      archivedConversations: mockState.archivedConversations,
      setActiveConversation: mockState.setActiveConversation,
      loadMessagesFromCache: mockState.chatLoadMessagesFromCache,
      // Mirrors the real store action: hydrate from cache, then set active
      activateConversation: async (id: string | null) => {
        if (id) await mockState.chatLoadMessagesFromCache(id, { limit: 100 })
        mockState.setActiveConversation(id)
      },
    }),
  },
  roomStore: {
    getState: () => ({
      joinedRooms: () => mockState.joinedRooms,
      // The Alt+Up/Down navigation path reads `allRooms()` and filters by
      // `joined`. Test fixtures populate `mockState.joinedRooms` and don't
      // model unjoined rooms, so injecting `joined: true` here matches the
      // semantic the fixture represents.
      allRooms: () => mockState.joinedRooms.map(r => ({ ...r, joined: true })),
      activeRoomJid: mockState.activeRoomJid,
      setActiveRoom: mockState.setActiveRoom,
      loadMessagesFromCache: mockState.roomLoadMessagesFromCache,
      // Mirrors the real store action: hydrate from cache, then set active
      activateRoom: async (roomJid: string | null) => {
        if (roomJid) await mockState.roomLoadMessagesFromCache(roomJid, { limit: 100 })
        mockState.setActiveRoom(roomJid)
      },
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
  useConnectionStore: (selector: (s: { status: string }) => unknown) =>
    selector({ status: 'online' }),
  useContactTime: () => null, useLastActivity: vi.fn(),
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
    mockState.chatLoadMessagesFromCache = vi.fn(() => Promise.resolve([]))
    mockState.roomLoadMessagesFromCache = vi.fn(() => Promise.resolve([]))
    mockState.archivedConversations = new Set()
    mockSettingsState.themeMode = 'system'
    mockSettingsState.setThemeMode = vi.fn((mode: string) => { mockSettingsState.themeMode = mode as 'light' | 'dark' | 'system' })
    // Modals live in the real modalStore now — reset them so tests start clean.
    useModalStore.setState({ commandPalette: false, shortcutHelp: false, presenceMenu: false, quickChat: false, addContact: false, joinRoom: false })
    // Advanced mode defaults to off; individual tests that need it on must set it.
    useAdvancedModeStore.setState({ advancedMode: false })
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
    navigateToMessages: vi.fn(),
    navigateToRooms: vi.fn(),
  })

  // Activation is async: the cache hydration (loadMessagesFromCache) resolves
  // before the store setter runs. Flush pending microtasks so assertions see it.
  const flushActivation = () => new Promise<void>((resolve) => setTimeout(resolve, 0))

  describe('Next Unread (Cmd+U)', () => {
    it('should navigate to conversation with unread messages', async () => {
      mockState.conversations = [
        { id: 'user1@example.com', unreadCount: 0 },
        { id: 'user2@example.com', unreadCount: 3 },
      ]
      mockState.activeConversationId = 'user1@example.com'

      const options = createDefaultOptions()
      const { result } = renderHook(() =>
        useKeyboardShortcuts(options)
      )

      const nextUnreadShortcut = result.current.find(
        s => s.key === 'u' && s.modifiers?.includes('meta')
      )
      expect(nextUnreadShortcut).toBeDefined()
      nextUnreadShortcut!.action()
      await flushActivation()

      expect(mockState.setActiveConversation).toHaveBeenCalledWith('user2@example.com')
      expect(mockState.setActiveRoom).toHaveBeenCalledWith(null)
      expect(options.navigateToMessages).toHaveBeenCalledWith('user2@example.com')
    })

    it('should navigate to room with mentions', async () => {
      mockState.conversations = [] // No unread conversations
      mockState.joinedRooms = [
        { jid: 'room1@conference.example.com', mentionsCount: 0, unreadCount: 0 },
        { jid: 'room2@conference.example.com', mentionsCount: 2, unreadCount: 5 },
      ]
      mockState.activeRoomJid = 'room1@conference.example.com'

      const options = createDefaultOptions()
      const { result } = renderHook(() =>
        useKeyboardShortcuts(options)
      )

      const nextUnreadShortcut = result.current.find(
        s => s.key === 'u' && s.modifiers?.includes('meta')
      )
      nextUnreadShortcut!.action()
      await flushActivation()

      expect(mockState.setActiveRoom).toHaveBeenCalledWith('room2@conference.example.com')
      expect(mockState.setActiveConversation).toHaveBeenCalledWith(null)
      expect(options.navigateToRooms).toHaveBeenCalledWith('room2@conference.example.com')
    })

    it('should navigate to room with unreadCount when notifyAll is enabled (regression test)', async () => {
      mockState.conversations = [] // No unread conversations
      mockState.joinedRooms = [
        { jid: 'room1@conference.example.com', mentionsCount: 0, unreadCount: 0 },
        { jid: 'room2@conference.example.com', mentionsCount: 0, unreadCount: 10 }, // notifyAll room
      ]
      mockState.activeRoomJid = 'room1@conference.example.com'

      const options = createDefaultOptions()
      const { result } = renderHook(() =>
        useKeyboardShortcuts(options)
      )

      const nextUnreadShortcut = result.current.find(
        s => s.key === 'u' && s.modifiers?.includes('meta')
      )
      nextUnreadShortcut!.action()
      await flushActivation()

      // Should navigate to room2 because it has unreadCount > 0
      expect(mockState.setActiveRoom).toHaveBeenCalledWith('room2@conference.example.com')
      expect(mockState.setActiveConversation).toHaveBeenCalledWith(null)
      expect(options.navigateToRooms).toHaveBeenCalledWith('room2@conference.example.com')
    })

    it('should prioritize conversations over rooms', async () => {
      mockState.conversations = [
        { id: 'user1@example.com', unreadCount: 5 },
      ]
      mockState.joinedRooms = [
        { jid: 'room1@conference.example.com', mentionsCount: 3, unreadCount: 10 },
      ]
      mockState.activeConversationId = null
      mockState.activeRoomJid = null

      const options = createDefaultOptions()
      const { result } = renderHook(() =>
        useKeyboardShortcuts(options)
      )

      const nextUnreadShortcut = result.current.find(
        s => s.key === 'u' && s.modifiers?.includes('meta')
      )
      nextUnreadShortcut!.action()
      await flushActivation()

      // Should navigate to conversation first, not room
      expect(mockState.setActiveConversation).toHaveBeenCalledWith('user1@example.com')
      expect(mockState.setActiveRoom).toHaveBeenCalledWith(null)
      expect(options.navigateToMessages).toHaveBeenCalledWith('user1@example.com')
      expect(options.navigateToRooms).not.toHaveBeenCalled()
    })

    it('should skip current conversation when finding next unread', async () => {
      mockState.conversations = [
        { id: 'user1@example.com', unreadCount: 5 },
        { id: 'user2@example.com', unreadCount: 3 },
      ]
      mockState.activeConversationId = 'user1@example.com' // Current has unread but should skip

      const options = createDefaultOptions()
      const { result } = renderHook(() =>
        useKeyboardShortcuts(options)
      )

      const nextUnreadShortcut = result.current.find(
        s => s.key === 'u' && s.modifiers?.includes('meta')
      )
      nextUnreadShortcut!.action()
      await flushActivation()

      // Should navigate to user2, not stay on user1
      expect(mockState.setActiveConversation).toHaveBeenCalledWith('user2@example.com')
      expect(options.navigateToMessages).toHaveBeenCalledWith('user2@example.com')
    })

    it('should skip current room when finding next unread', async () => {
      mockState.conversations = []
      mockState.joinedRooms = [
        { jid: 'room1@conference.example.com', mentionsCount: 5, unreadCount: 10 },
        { jid: 'room2@conference.example.com', mentionsCount: 2, unreadCount: 5 },
      ]
      mockState.activeRoomJid = 'room1@conference.example.com' // Current has unread but should skip

      const options = createDefaultOptions()
      const { result } = renderHook(() =>
        useKeyboardShortcuts(options)
      )

      const nextUnreadShortcut = result.current.find(
        s => s.key === 'u' && s.modifiers?.includes('meta')
      )
      nextUnreadShortcut!.action()
      await flushActivation()

      // Should navigate to room2, not stay on room1
      expect(mockState.setActiveRoom).toHaveBeenCalledWith('room2@conference.example.com')
      expect(options.navigateToRooms).toHaveBeenCalledWith('room2@conference.example.com')
    })

    it('should do nothing when no unread items exist', () => {
      mockState.conversations = [
        { id: 'user1@example.com', unreadCount: 0 },
      ]
      mockState.joinedRooms = [
        { jid: 'room1@conference.example.com', mentionsCount: 0, unreadCount: 0 },
      ]

      const options = createDefaultOptions()
      const { result } = renderHook(() =>
        useKeyboardShortcuts(options)
      )

      const nextUnreadShortcut = result.current.find(
        s => s.key === 'u' && s.modifiers?.includes('meta')
      )
      nextUnreadShortcut!.action()

      // Should not navigate anywhere
      expect(mockState.setActiveConversation).not.toHaveBeenCalled()
      expect(mockState.setActiveRoom).not.toHaveBeenCalledWith(expect.any(String))
      expect(options.navigateToMessages).not.toHaveBeenCalled()
      expect(options.navigateToRooms).not.toHaveBeenCalled()
    })
  })

  describe('Escape Hierarchy', () => {
    // Modals are driven via the modalStore now (handleEscape reads it directly);
    // escapeHierarchy carries only the non-modal escape targets. Tests open modals
    // with useModalStore.setState and assert on the store.
    const createEscapeHierarchy = (overrides = {}) => ({
      isConsoleOpen: false,
      onCloseConsole: vi.fn(),
      isContactProfileOpen: false,
      onCloseContactProfile: vi.fn(),
      ...overrides,
    })

    it('should close Command Palette first (highest priority)', () => {
      useModalStore.setState({ commandPalette: true, shortcutHelp: true })
      const escapeHierarchy = createEscapeHierarchy({ isConsoleOpen: true })

      const { result } = renderHook(() =>
        useKeyboardShortcuts({ ...createDefaultOptions(), escapeHierarchy })
      )

      result.current.find(s => s.key === 'Escape')!.action()

      expect(useModalStore.getState().commandPalette).toBe(false)
      expect(useModalStore.getState().shortcutHelp).toBe(true)
      expect(escapeHierarchy.onCloseConsole).not.toHaveBeenCalled()
    })

    it('should close Shortcut Help when Command Palette is closed', () => {
      useModalStore.setState({ shortcutHelp: true, quickChat: true })

      const { result } = renderHook(() =>
        useKeyboardShortcuts({ ...createDefaultOptions(), escapeHierarchy: createEscapeHierarchy() })
      )

      result.current.find(s => s.key === 'Escape')!.action()

      expect(useModalStore.getState().shortcutHelp).toBe(false)
      expect(useModalStore.getState().quickChat).toBe(true)
    })

    it('should close Quick Chat when higher priority items are closed', () => {
      useModalStore.setState({ quickChat: true })
      const escapeHierarchy = createEscapeHierarchy({ isConsoleOpen: true })

      const { result } = renderHook(() =>
        useKeyboardShortcuts({ ...createDefaultOptions(), escapeHierarchy })
      )

      result.current.find(s => s.key === 'Escape')!.action()

      expect(useModalStore.getState().quickChat).toBe(false)
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
      useModalStore.setState({ commandPalette: true, shortcutHelp: true, quickChat: true })
      const escapeHierarchy = createEscapeHierarchy({ isConsoleOpen: true, isContactProfileOpen: true })

      const { result } = renderHook(() =>
        useKeyboardShortcuts({ ...createDefaultOptions(), escapeHierarchy })
      )

      result.current.find(s => s.key === 'Escape')!.action()

      // Only Command Palette should be closed (highest priority).
      expect(useModalStore.getState().commandPalette).toBe(false)
      expect(useModalStore.getState().shortcutHelp).toBe(true)
      expect(useModalStore.getState().quickChat).toBe(true)
      expect(escapeHierarchy.onCloseConsole).not.toHaveBeenCalled()
      expect(escapeHierarchy.onCloseContactProfile).not.toHaveBeenCalled()
    })

    it('should follow correct priority order through multiple escapes', () => {
      // handleEscape reads the modalStore fresh each press and close() mutates it,
      // so no rerender is needed between presses.
      useModalStore.setState({ commandPalette: true, shortcutHelp: true, quickChat: true })
      const escapeHierarchy = createEscapeHierarchy({ isConsoleOpen: true })

      const { result } = renderHook(() =>
        useKeyboardShortcuts({ ...createDefaultOptions(), escapeHierarchy })
      )
      const escape = () => result.current.find(s => s.key === 'Escape')!.action()

      escape() // Command Palette
      expect(useModalStore.getState().commandPalette).toBe(false)

      escape() // Shortcut Help
      expect(useModalStore.getState().shortcutHelp).toBe(false)

      escape() // Quick Chat
      expect(useModalStore.getState().quickChat).toBe(false)

      escape() // Console (non-modal, lower priority)
      expect(escapeHierarchy.onCloseConsole).toHaveBeenCalledTimes(1)
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
      expect(escapeShortcut!.description).toBe('shortcuts.closeModalPanelBlur')
    })
  })

  describe('Alt+Arrow Navigation (Previous/Next Item)', () => {
    it('should navigate to previous conversation with Alt+Up', async () => {
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
      await flushActivation()

      expect(mockState.setActiveConversation).toHaveBeenCalledWith('user1@example.com')
      expect(mockState.setActiveRoom).toHaveBeenCalledWith(null)
    })

    it('should navigate to next conversation with Alt+Down', async () => {
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
      await flushActivation()

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

    it('should select first item when Alt+Down pressed with no selection', async () => {
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
      await flushActivation()

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

  // Regression: switching with Cmd+Opt+Arrow used the raw store setters, which
  // skip the IndexedDB cache hydration every other activation path performs.
  // The newly active room/conversation rendered empty (only live messages are
  // kept in memory) until a manual scroll triggered a history load.
  describe('Cache hydration on keyboard activation', () => {
    it('loads cached room history before activating the room (Alt+Down in rooms view)', async () => {
      mockState.joinedRooms = [
        { jid: 'room1@conference.example.com', mentionsCount: 0, unreadCount: 0 },
        { jid: 'room2@conference.example.com', mentionsCount: 0, unreadCount: 0 },
      ]
      mockState.activeRoomJid = 'room1@conference.example.com'

      const options = { ...createDefaultOptions(), sidebarView: 'rooms' as const }
      const { result } = renderHook(() => useKeyboardShortcuts(options))

      const nextShortcut = result.current.find(
        s => s.key === 'ArrowDown' && s.modifiers?.includes('alt')
      )
      nextShortcut!.action()
      await flushActivation()

      expect(mockState.roomLoadMessagesFromCache).toHaveBeenCalledWith(
        'room2@conference.example.com', { limit: 100 }
      )
      expect(mockState.setActiveRoom).toHaveBeenCalledWith('room2@conference.example.com')
      // Hydration must complete BEFORE activation so the conversation-switch
      // scroll effect sees the full message list and the unread marker is
      // computed with historical context.
      expect(mockState.roomLoadMessagesFromCache.mock.invocationCallOrder[0])
        .toBeLessThan(mockState.setActiveRoom.mock.invocationCallOrder[0])
    })

    it('loads cached conversation history before activating it (Alt+Up in messages view)', async () => {
      mockState.conversations = [
        { id: 'user1@example.com', unreadCount: 0 },
        { id: 'user2@example.com', unreadCount: 0 },
      ]
      mockState.activeConversationId = 'user2@example.com'

      const { result } = renderHook(() => useKeyboardShortcuts(createDefaultOptions()))

      const prevShortcut = result.current.find(
        s => s.key === 'ArrowUp' && s.modifiers?.includes('alt')
      )
      prevShortcut!.action()
      await flushActivation()

      expect(mockState.chatLoadMessagesFromCache).toHaveBeenCalledWith(
        'user1@example.com', { limit: 100 }
      )
      expect(mockState.setActiveConversation).toHaveBeenCalledWith('user1@example.com')
      expect(mockState.chatLoadMessagesFromCache.mock.invocationCallOrder[0])
        .toBeLessThan(mockState.setActiveConversation.mock.invocationCallOrder[0])
    })

    it('loads cached history before activating via Cmd+U (next unread)', async () => {
      mockState.conversations = [
        { id: 'user1@example.com', unreadCount: 0 },
        { id: 'user2@example.com', unreadCount: 3 },
      ]
      mockState.activeConversationId = 'user1@example.com'

      const { result } = renderHook(() => useKeyboardShortcuts(createDefaultOptions()))

      const nextUnreadShortcut = result.current.find(
        s => s.key === 'u' && s.modifiers?.includes('meta')
      )
      nextUnreadShortcut!.action()
      await flushActivation()

      expect(mockState.chatLoadMessagesFromCache).toHaveBeenCalledWith(
        'user2@example.com', { limit: 100 }
      )
      expect(mockState.chatLoadMessagesFromCache.mock.invocationCallOrder[0])
        .toBeLessThan(mockState.setActiveConversation.mock.invocationCallOrder[0])
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
      expect(cmdKShortcut!.description).toBe('shortcuts.goTo')
      expect(cmdKShortcut!.category).toBe('general')

      cmdKShortcut!.action()
      expect(options.onOpenCommandPalette).toHaveBeenCalledTimes(1)
    })

    it('should delegate Cmd-K to onOpenCommandPalette (the store toggle) even when open', () => {
      // Cmd-K no longer branches on open-state: it always calls onOpenCommandPalette,
      // which ChatLayout wires to the store toggle (open if closed, close if open).
      const options = createDefaultOptions()
      useModalStore.setState({ commandPalette: true })

      const { result } = renderHook(() => useKeyboardShortcuts(options))

      result.current.find(s => s.key === 'k' && s.modifiers?.includes('meta'))!.action()

      expect(options.onOpenCommandPalette).toHaveBeenCalledTimes(1)
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

  describe('Find on Page (Cmd+F)', () => {
    it('should include Cmd+F shortcut for find in conversation', () => {
      const options = createDefaultOptions()
      const { result } = renderHook(() => useKeyboardShortcuts(options))

      const cmdF = result.current.find(
        s => s.key === 'f' && s.modifiers?.includes('meta')
      )
      expect(cmdF).toBeDefined()
      expect(cmdF!.description).toBe('shortcuts.findInConversation')
    })

    it('should call onFindOnPage when Cmd+F is triggered', () => {
      const onFindOnPage = vi.fn()
      const options = { ...createDefaultOptions(), onFindOnPage }
      const { result } = renderHook(() => useKeyboardShortcuts(options))

      const cmdF = result.current.find(
        s => s.key === 'f' && s.modifiers?.includes('meta')
      )
      cmdF!.action()
      expect(onFindOnPage).toHaveBeenCalled()
    })
  })

  describe('Find Next/Previous (Cmd+G / Cmd+Shift+G)', () => {
    it('should include Cmd+G shortcut for next match', () => {
      const options = createDefaultOptions()
      const { result } = renderHook(() => useKeyboardShortcuts(options))

      const cmdG = result.current.find(
        s => s.key === 'g' && s.modifiers?.includes('meta') && !s.modifiers?.includes('shift')
      )
      expect(cmdG).toBeDefined()
      expect(cmdG!.description).toBe('shortcuts.nextMatch')
    })

    it('should call onFindNext when Cmd+G is triggered', () => {
      const onFindNext = vi.fn()
      const options = { ...createDefaultOptions(), onFindNext }
      const { result } = renderHook(() => useKeyboardShortcuts(options))

      const cmdG = result.current.find(
        s => s.key === 'g' && s.modifiers?.includes('meta') && !s.modifiers?.includes('shift')
      )
      cmdG!.action()
      expect(onFindNext).toHaveBeenCalled()
    })

    it('should include Cmd+Shift+G shortcut for previous match', () => {
      const options = createDefaultOptions()
      const { result } = renderHook(() => useKeyboardShortcuts(options))

      const cmdShiftG = result.current.find(
        s => s.key === 'g' && s.modifiers?.includes('meta') && s.modifiers?.includes('shift')
      )
      expect(cmdShiftG).toBeDefined()
      expect(cmdShiftG!.description).toBe('shortcuts.previousMatch')
    })

    it('should call onFindPrev when Cmd+Shift+G is triggered', () => {
      const onFindPrev = vi.fn()
      const options = { ...createDefaultOptions(), onFindPrev }
      const { result } = renderHook(() => useKeyboardShortcuts(options))

      const cmdShiftG = result.current.find(
        s => s.key === 'g' && s.modifiers?.includes('meta') && s.modifiers?.includes('shift')
      )
      cmdShiftG!.action()
      expect(onFindPrev).toHaveBeenCalled()
    })
  })

  describe('Search View (Cmd+Shift+F / Alt+3)', () => {
    it('should include Cmd+Shift+F shortcut for search view', () => {
      const options = createDefaultOptions()
      const { result } = renderHook(() => useKeyboardShortcuts(options))

      const cmdShiftF = result.current.find(
        s => s.key === 'f' && s.modifiers?.includes('meta') && s.modifiers?.includes('shift')
      )
      expect(cmdShiftF).toBeDefined()
      expect(cmdShiftF!.description).toBe('shortcuts.searchView')
    })

    it('should switch to search sidebar view via Cmd+Shift+F', () => {
      const options = createDefaultOptions()
      const { result } = renderHook(() => useKeyboardShortcuts(options))

      const cmdShiftF = result.current.find(
        s => s.key === 'f' && s.modifiers?.includes('meta') && s.modifiers?.includes('shift')
      )
      cmdShiftF!.action()
      expect(options.onSidebarViewChange).toHaveBeenCalledWith('search')
    })

    it('should include Alt+3 shortcut for search view', () => {
      const options = createDefaultOptions()
      const { result } = renderHook(() => useKeyboardShortcuts(options))

      const alt3 = result.current.find(
        s => s.key === '3' && s.modifiers?.includes('alt')
      )
      expect(alt3).toBeDefined()
      expect(alt3!.description).toBe('shortcuts.searchView')
    })

    it('should switch to search sidebar view via Alt+3', () => {
      const options = createDefaultOptions()
      const { result } = renderHook(() => useKeyboardShortcuts(options))

      const alt3 = result.current.find(
        s => s.key === '3' && s.modifiers?.includes('alt')
      )
      alt3!.action()
      expect(options.onSidebarViewChange).toHaveBeenCalledWith('search')
    })

    it('should no longer bind Alt+6 to any shortcut', () => {
      const options = createDefaultOptions()
      const { result } = renderHook(() => useKeyboardShortcuts(options))

      const alt6 = result.current.find(
        s => s.key === '6' && s.modifiers?.includes('alt')
      )
      expect(alt6).toBeUndefined()
    })
  })

  describe('Contacts View (Alt+9)', () => {
    it('should include Alt+9 shortcut for the contacts (directory) view', () => {
      const options = createDefaultOptions()
      const { result } = renderHook(() => useKeyboardShortcuts(options))

      const alt9 = result.current.find(
        s => s.key === '9' && s.modifiers?.includes('alt')
      )
      expect(alt9).toBeDefined()
      expect(alt9!.description).toBe('shortcuts.connectionsView')
    })

    it('should switch to the directory sidebar view via Alt+9', () => {
      const options = createDefaultOptions()
      const { result } = renderHook(() => useKeyboardShortcuts(options))

      const alt9 = result.current.find(
        s => s.key === '9' && s.modifiers?.includes('alt')
      )
      alt9!.action()
      expect(options.onSidebarViewChange).toHaveBeenCalledWith('contacts')
    })
  })

  describe('Toggle Light/Dark Mode (Cmd+Shift+L)', () => {
    it('should include the shortcut in returned definitions', () => {
      const { result } = renderHook(() => useKeyboardShortcuts(createDefaultOptions()))

      const shortcut = result.current.find(
        s => s.key === 'l' && s.modifiers?.includes('meta') && s.modifiers?.includes('shift')
      )
      expect(shortcut).toBeDefined()
      expect(shortcut!.description).toBe('shortcuts.toggleLightDarkMode')
      expect(shortcut!.category).toBe('general')
    })

    it('should toggle from light to dark', () => {
      mockSettingsState.themeMode = 'light'

      const { result } = renderHook(() => useKeyboardShortcuts(createDefaultOptions()))

      const shortcut = result.current.find(
        s => s.key === 'l' && s.modifiers?.includes('meta') && s.modifiers?.includes('shift')
      )
      shortcut!.action()

      expect(mockSettingsState.setThemeMode).toHaveBeenCalledWith('dark')
    })

    it('should toggle from dark to light', () => {
      mockSettingsState.themeMode = 'dark'

      const { result } = renderHook(() => useKeyboardShortcuts(createDefaultOptions()))

      const shortcut = result.current.find(
        s => s.key === 'l' && s.modifiers?.includes('meta') && s.modifiers?.includes('shift')
      )
      shortcut!.action()

      expect(mockSettingsState.setThemeMode).toHaveBeenCalledWith('light')
    })

    it('should toggle from system to opposite of effective mode', () => {
      mockSettingsState.themeMode = 'system'

      // Mock matchMedia to report light system preference
      const originalMatchMedia = window.matchMedia
      window.matchMedia = vi.fn().mockReturnValue({ matches: true }) as unknown as typeof window.matchMedia

      const { result } = renderHook(() => useKeyboardShortcuts(createDefaultOptions()))

      const shortcut = result.current.find(
        s => s.key === 'l' && s.modifiers?.includes('meta') && s.modifiers?.includes('shift')
      )
      shortcut!.action()

      // System is light, so should toggle to dark
      expect(mockSettingsState.setThemeMode).toHaveBeenCalledWith('dark')

      window.matchMedia = originalMatchMedia
    })
  })

  describe('F12 console toggle — gated on advanced mode', () => {
    it('should NOT call onToggleConsole when advanced mode is off', () => {
      useAdvancedModeStore.setState({ advancedMode: false })
      const options = createDefaultOptions()
      const { result } = renderHook(() => useKeyboardShortcuts(options))

      const f12 = result.current.find(s => s.key === 'F12')
      expect(f12).toBeDefined()
      f12!.action()

      expect(options.onToggleConsole).not.toHaveBeenCalled()
    })

    it('should call onToggleConsole when advanced mode is on', () => {
      useAdvancedModeStore.setState({ advancedMode: true })
      const options = createDefaultOptions()
      const { result } = renderHook(() => useKeyboardShortcuts(options))

      const f12 = result.current.find(s => s.key === 'F12')
      expect(f12).toBeDefined()
      f12!.action()

      expect(options.onToggleConsole).toHaveBeenCalledOnce()
    })
  })
})
