import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { MemoryRouter, useLocation, useNavigate } from 'react-router-dom'
import { ChatLayout } from './ChatLayout'
import type { Contact, PresenceStatus } from '@fluux/sdk'

// Use vi.hoisted() so mock functions are available when vi.mock factory runs
// (vi.mock is hoisted above imports, so regular variables aren't defined yet)
const {
  mockContact,
  mockSetActiveConversation,
  mockSetActiveRoom,
  mockActivateConversation,
  mockActivateRoom,
  mockMarkChatReadToNewest,
  mockMarkRoomReadToNewest,
  lastKeyboardShortcutsOptions,
  getMockState,
  setMockState,
  subscribeMockState,
  getMockStateVersion,
} = vi.hoisted(() => {
  const state = {
    activeConversationId: null as string | null,
    activeRoomJid: null as string | null,
    // Kept per store: ChatLayout ORs chatStore.activationPending with the
    // roomStore one, so a single shared field could not tell which store drove
    // the pane swap — and the room half would stay unfalsifiable.
    chatActivationPending: false,
    roomActivationPending: false,
    isArchivedResult: false,
    conversations: new Map<string, { id: string }>(),
    rooms: new Map<string, { jid: string; joined: boolean }>(),
    adminCategory: null as string | null,
    adminSession: null as unknown,
    adminIsAdmin: false,
  }

  // Minimal reactivity for the store mocks below (they subscribe through
  // useSyncExternalStore). A store write that happens mid-flow — an effect
  // flipping activationPending, a hydrating activation resolving — must
  // re-render ChatLayout the way the real Zustand stores would. Without it an
  // assertion made after the tap would silently read the pre-tap frame.
  let version = 0
  const listeners = new Set<() => void>()
  const setMockState = (newState: Partial<typeof state>) => {
    Object.assign(state, newState)
    version += 1
    for (const listener of listeners) listener()
  }

  const mockContact: Contact = {
    jid: 'alice@example.com',
    name: 'Alice Smith',
    presence: 'online' as PresenceStatus,
    subscription: 'both',
  }

  const mockSetActiveConversation = vi.fn((id: string | null) => {
    setMockState({ activeConversationId: id })
  })

  const mockSetActiveRoom = vi.fn((jid: string | null) => {
    setMockState({ activeRoomJid: jid })
  })

  // Hydrating activation actions (load message cache, then set active)
  const mockActivateConversation = vi.fn(async (id: string | null) => {
    setMockState({ activeConversationId: id })
  })

  const mockActivateRoom = vi.fn(async (jid: string | null) => {
    setMockState({ activeRoomJid: jid })
  })

  const mockMarkChatReadToNewest = vi.fn()
  const mockMarkRoomReadToNewest = vi.fn()

  // Holds the most recent options object ChatLayout passed to useKeyboardShortcuts
  // (the hook itself is mocked below), so tests can invoke escapeHierarchy.onConversationEscape
  // directly without needing a real window keydown listener.
  const lastKeyboardShortcutsOptions: { current: unknown } = { current: null }

  return {
    mockContact,
    mockSetActiveConversation,
    mockSetActiveRoom,
    mockActivateConversation,
    mockActivateRoom,
    mockMarkChatReadToNewest,
    mockMarkRoomReadToNewest,
    lastKeyboardShortcutsOptions,
    getMockState: () => state,
    setMockState,
    subscribeMockState: (listener: () => void) => {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    getMockStateVersion: () => version,
  }
})

// Wrapper component for tests that need routing
function ChatLayoutWithRouter({ initialRoute = '/messages' }: { initialRoute?: string }) {
  return (
    <MemoryRouter initialEntries={[initialRoute]}>
      <ChatLayout />
    </MemoryRouter>
  )
}

// Probe to observe the router history stack: renders the current path and a
// button that goes back one entry, so tests can assert push vs replace.
function HistoryProbe() {
  const location = useLocation()
  const navigate = useNavigate()
  return (
    <>
      <span data-testid="probe-path">{location.pathname}</span>
      <button type="button" data-testid="probe-back" onClick={() => navigate(-1)}>back</button>
    </>
  )
}

function ChatLayoutWithProbe({ initialRoute = '/messages' }: { initialRoute?: string }) {
  return (
    <MemoryRouter initialEntries={[initialRoute]}>
      <ChatLayout />
      <HistoryProbe />
    </MemoryRouter>
  )
}

// Mock SDK hooks
vi.mock('@fluux/sdk', () => ({
  useChat: () => ({
    activeConversationId: getMockState().activeConversationId,
    setActiveConversation: mockSetActiveConversation,
    addConversation: vi.fn(),
    conversations: [],
  }),
  useRoom: () => ({
    activeRoomJid: getMockState().activeRoomJid,
    setActiveRoom: mockSetActiveRoom,
    rooms: new Map(),
    joinedRooms: [],
    bookmarkedRooms: [],
  }),
  useRoster: () => ({
    contacts: [mockContact],
    removeContact: vi.fn(),
    renameContact: vi.fn(),
    fetchContactNickname: vi.fn(),
  }),
  useRosterActions: () => ({
    removeContact: vi.fn(),
    renameContact: vi.fn(),
    fetchContactNickname: vi.fn(),
    addContact: vi.fn(),
    getContact: vi.fn(),
    restoreContactAvatarFromCache: vi.fn(),
    acceptSubscription: vi.fn(),
    rejectSubscription: vi.fn(),
  }),
  useChatActions: () => ({
    markReadToNewest: mockMarkChatReadToNewest,
  }),
  useRoomActions: () => ({
    markReadToNewest: mockMarkRoomReadToNewest,
    markAllRoomsRead: vi.fn(),
  }),
  useXMPP: () => ({
    client: {
      subscribe: vi.fn(() => vi.fn()),
      isConnected: vi.fn(() => true),
      getJid: vi.fn(() => 'user@example.com'),
      onStanza: vi.fn(() => vi.fn()),
      on: vi.fn(() => vi.fn()),
      sendRawXml: vi.fn(),
      roster: {
        removeContact: vi.fn(),
        renameContact: vi.fn(),
      },
      profile: {
        fetchContactNickname: vi.fn(),
      },
    },
    sendRawXml: vi.fn(),
    onStanza: vi.fn(() => vi.fn()),
    on: vi.fn(() => vi.fn()),
    setPresence: vi.fn(),
    xml: vi.fn(),
    isConnected: () => true,
    getJid: () => 'user@example.com',
  }),
  useXMPPContext: () => ({
    client: {
      roster: {
        removeContact: vi.fn(),
        renameContact: vi.fn(),
      },
      profile: {
        fetchContactNickname: vi.fn(),
      },
      subscribe: vi.fn(() => vi.fn()),
      isConnected: vi.fn(() => true),
      getJid: vi.fn(() => 'user@example.com'),
      onStanza: vi.fn(() => vi.fn()),
      on: vi.fn(() => vi.fn()),
      sendRawXml: vi.fn(),
    },
  }),
  useRosterStore: (selector: (state: { contacts: Map<string, typeof mockContact> }) => unknown) => {
    const contacts = new Map<string, typeof mockContact>()
    contacts.set(mockContact.jid, mockContact)
    return selector({ contacts })
  },
  useConnection: () => ({
    status: 'online',
  }),
  useConsole: () => ({
    toggle: vi.fn(),
    isOpen: false,
  }),
  useAdmin: () => ({
    currentSession: null,
    clearSession: vi.fn(),
    activeCategory: null,
    setActiveCategory: vi.fn(),
    navigateToUserAdmin: vi.fn(),
    isAdmin: false,
  }),
  useEvents: () => ({
    subscriptionRequests: [],
    strangerMessages: [],
    strangerConversations: {},
    mucInvitations: [],
    systemNotifications: [],
    pendingCount: 0,
    acceptStranger: vi.fn().mockResolvedValue(undefined),
    ignoreStranger: vi.fn(),
  }),
  useBlocking: () => ({ blockJid: vi.fn().mockResolvedValue(undefined) }),
  getBareJid: (jid: string) => jid.split('/')[0],
  // Vanilla stores (for imperative .getState() access)
  chatStore: {
    getState: () => ({
      activeConversationId: getMockState().activeConversationId,
      hasConversation: vi.fn(() => false),
      isArchived: vi.fn(() => getMockState().isArchivedResult),
      updateConversationName: vi.fn(),
      markAsRead: vi.fn(),
      clearFirstNewMessageId: vi.fn(),
      setActiveConversation: mockSetActiveConversation,
      activateConversation: mockActivateConversation,
      conversations: getMockState().conversations,
    }),
  },
  roomStore: {
    getState: () => ({
      activeRoomJid: getMockState().activeRoomJid,
      markAsRead: vi.fn(),
      clearFirstNewMessageId: vi.fn(),
      setActiveRoom: mockSetActiveRoom,
      activateRoom: mockActivateRoom,
      rooms: getMockState().rooms,
      allRooms: () => Array.from(getMockState().rooms.values()),
    }),
  },
  connectionStore: {
    getState: () => ({
      status: 'online',
      windowVisible: true,
      setWindowVisible: vi.fn(),
    }),
  },
  consoleStore: {
    getState: () => ({
      toggle: vi.fn(),
      isOpen: false,
      addEvent: vi.fn(),
    }),
  },
  adminStore: {
    getState: () => ({
      setCurrentSession: (v: unknown) => setMockState({ adminSession: v }),
      setTargetJid: vi.fn(),
      setActiveCategory: (v: string | null) => setMockState({ adminCategory: v }),
      vhosts: [],
      setSelectedVhost: vi.fn(),
      setPendingSelectedUserJid: vi.fn(),
    }),
  },
}))

// Mock React store hooks (from @fluux/sdk/react)
vi.mock('@fluux/sdk/react', async () => {
  const { useSyncExternalStore } = await import('react')
  // Subscribe the mock store hooks to setMockState so a store write commits a
  // re-render, like the real Zustand subscriptions do.
  const useMockStoreSubscription = () => useSyncExternalStore(subscribeMockState, getMockStateVersion)
  return {
  useChatStore: Object.assign(
    (selector: (state: {
      activeConversationId: string | null;
      activationPending: boolean;
      setActiveConversation: typeof mockSetActiveConversation;
      activateConversation: typeof mockActivateConversation;
      addConversation: ReturnType<typeof vi.fn>;
      hasConversation: ReturnType<typeof vi.fn>;
      isArchived: ReturnType<typeof vi.fn>;
      updateConversationName: ReturnType<typeof vi.fn>;
      conversations: Map<string, unknown>;
    }) => unknown) => {
      useMockStoreSubscription()
      const state = {
        activeConversationId: getMockState().activeConversationId,
        activationPending: getMockState().chatActivationPending,
        setActiveConversation: mockSetActiveConversation,
        activateConversation: mockActivateConversation,
        addConversation: vi.fn(),
        hasConversation: vi.fn(() => false),
        isArchived: vi.fn(() => getMockState().isArchivedResult),
        updateConversationName: vi.fn(),
        conversations: getMockState().conversations,
      }
      return selector(state)
    },
    {
      getState: () => ({
        activeConversationId: getMockState().activeConversationId,
        hasConversation: vi.fn(() => false),
        isArchived: vi.fn(() => getMockState().isArchivedResult),
        updateConversationName: vi.fn(),
        markAsRead: vi.fn(),
      }),
    }
  ),
  useRoomStore: Object.assign(
    (selector: (state: { activeRoomJid: string | null; activationPending: boolean; setActiveRoom: typeof mockSetActiveRoom; activateRoom: typeof mockActivateRoom; rooms: Map<string, unknown> }) => unknown) => {
      useMockStoreSubscription()
      const state = {
        activeRoomJid: getMockState().activeRoomJid,
        activationPending: getMockState().roomActivationPending,
        setActiveRoom: mockSetActiveRoom,
        activateRoom: mockActivateRoom,
        rooms: getMockState().rooms,
      }
      return selector(state)
    },
    {
      getState: () => ({
        activeRoomJid: getMockState().activeRoomJid,
        markAsRead: vi.fn(),
      }),
    }
  ),
  useRosterStore: (selector: (state: { contacts: Map<string, typeof mockContact> }) => unknown) => {
    const contacts = new Map<string, typeof mockContact>()
    contacts.set(mockContact.jid, mockContact)
    return selector({ contacts })
  },
  useConnectionStore: Object.assign(
    (selector: (state: { status: string; windowVisible: boolean }) => unknown) => {
      return selector({ status: 'online', windowVisible: true })
    },
    {
      getState: () => ({
        status: 'online',
        windowVisible: true,
        setWindowVisible: vi.fn(),
      }),
    }
  ),
  useConsoleStore: Object.assign(
    (selector: (state: { isOpen: boolean }) => unknown) => {
      return selector({ isOpen: false })
    },
    {
      getState: () => ({
        toggle: vi.fn(),
        isOpen: false,
      }),
    }
  ),
  useAdminStore: Object.assign(
    (selector: (state: { currentSession: unknown; activeCategory: string | null; isAdmin: boolean }) => unknown) => {
      return selector({
        currentSession: getMockState().adminSession ?? null,
        activeCategory: getMockState().adminCategory ?? null,
        isAdmin: getMockState().adminIsAdmin ?? false,
      })
    },
    {
      getState: () => ({
        setCurrentSession: vi.fn(),
        setTargetJid: vi.fn(),
        setActiveCategory: vi.fn(),
        vhosts: [],
        setSelectedVhost: vi.fn(),
        setPendingSelectedUserJid: vi.fn(),
      }),
    }
  ),
  useContactTime: () => null, useLastActivity: vi.fn(),
  useSearchStore: (selector: (state: { previewResult: null }) => unknown) => {
    return selector({ previewResult: null })
  },
  }
})

// Mock app hooks
vi.mock('@/hooks/useNotificationBadge', () => ({
  useNotificationBadge: () => {},
}))

vi.mock('@/hooks/useDesktopNotifications', () => ({
  useDesktopNotifications: () => {},
}))

vi.mock('@/hooks/useSoundNotification', () => ({
  useSoundNotification: () => {},
}))

vi.mock('@/hooks/useEventsSoundNotification', () => ({
  useEventsSoundNotification: () => {},
}))

vi.mock('@/hooks/useEventsDesktopNotifications', () => ({
  useEventsDesktopNotifications: () => {},
}))

vi.mock('@/utils/renderLoopDetector', () => ({
  detectRenderLoop: () => {},
  notifyUserInput: () => {},
}))

// Note: useRouteSync is not mocked - we use the real implementation with MemoryRouter
vi.mock('@/hooks', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/hooks')>()
  return {
    ...actual, // Keep useRouteSync and other real implementations
    useWindowVisibility: () => {},
    useFocusZones: () => ({
      focusZone: vi.fn(),
      focusNextZone: vi.fn(),
      focusPreviousZone: vi.fn(),
      getCurrentZone: vi.fn(),
    }),
  }
})

vi.mock('@/hooks/useWebPush', () => ({
  useWebPush: () => {},
}))

vi.mock('@/hooks/useSDKErrorToasts', () => ({
  useSDKErrorToasts: () => {},
}))

vi.mock('@/hooks/useReactionNotifications', () => ({
  useReactionNotifications: () => {},
}))

vi.mock('@/hooks/useDeepLink', () => ({
  useDeepLink: () => {},
}))

vi.mock('@/hooks/useKeyboardShortcuts', () => ({
  // Capture the options ChatLayout passes in (notably escapeHierarchy.onConversationEscape)
  // so tests can invoke the real callback directly — this mock stubs out the hook's own
  // priority-chain/DOM-listener logic, which is covered separately in
  // useKeyboardShortcuts.test.tsx.
  useKeyboardShortcuts: (options: unknown) => {
    lastKeyboardShortcutsOptions.current = options
    return []
  },
}))

vi.mock('@/hooks/useSessionPersistence', () => ({
  saveViewState: vi.fn(),
  getSavedViewState: vi.fn(() => null),
}))

// Mock child components to simplify testing
// Sidebar now uses useRouteSync internally, so we mock with NavLinks for navigation
vi.mock('./Sidebar', () => ({
  Sidebar: ({ onSelectContact, onStartChat }: {
    onSelectContact: (contact: Contact) => void
    onStartChat: (contact: Contact) => void
  }) => {
    // Use NavLink from react-router-dom for navigation
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { NavLink, useLocation } = require('react-router-dom')
    const location = useLocation()
    // Derive sidebarView from URL path for display
    const pathToView: Record<string, string> = {
      '/messages': 'messages',
      '/rooms': 'rooms',
      '/contacts': 'contacts',
      '/admin': 'admin',
    }
    const activeView = pathToView[location.pathname.split('/')[1] ? `/${location.pathname.split('/')[1]}` : '/messages'] || 'messages'
    return (
      <div data-testid="sidebar">
        <span data-testid="active-view">{activeView}</span>
        <NavLink to="/messages" data-testid="messages-tab">Messages</NavLink>
        <NavLink to="/rooms" data-testid="rooms-tab">Rooms</NavLink>
        <NavLink to="/contacts" data-testid="directory-tab">Connections</NavLink>
        <NavLink to="/archive" data-testid="archive-tab">Archive</NavLink>
        {/* Deep links simulate a URL-only change (browser back/forward, edge-swipe popstate):
            the URL moves to a detail route without any click handler updating the store */}
        <NavLink to="/messages/bob@example.com" data-testid="deep-conversation-link">Deep Conversation</NavLink>
        <NavLink to="/rooms/lobby@conference.example.com" data-testid="deep-room-link">Deep Room</NavLink>
        <button type="button" data-testid="select-contact" onClick={() => onSelectContact(mockContact)}>Select Contact</button>
        <button type="button" data-testid="start-chat" onClick={() => onStartChat(mockContact)}>Start Chat</button>
      </div>
    )
  },
}))

vi.mock('./ChatView', () => ({
  ChatView: ({ onBack, onShowProfile }: { onBack: () => void; onShowProfile?: (jid: string) => void }) => (
    <div data-testid="chat-view">
      <span>Conversation: {getMockState().activeConversationId}</span>
      <button type="button" data-testid="chat-back" onClick={onBack}>Back</button>
      <button
        type="button"
        data-testid="chat-show-profile"
        onClick={() => {
          const id = getMockState().activeConversationId
          if (id) onShowProfile?.(id)
        }}
      >
        Show Profile
      </button>
    </div>
  ),
}))

vi.mock('./RoomView', () => ({
  RoomView: ({ onBack }: { onBack: () => void }) => (
    <div data-testid="room-view">
      <span>Room: {getMockState().activeRoomJid}</span>
      <button type="button" data-testid="room-back" onClick={onBack}>Back</button>
    </div>
  ),
}))

vi.mock('./ContactProfileView', () => ({
  ContactProfileView: ({ contact, onClose }: { contact: Contact; onClose: () => void }) => (
    <div data-testid="contact-profile-view">
      <span>Contact: {contact.name}</span>
      <button type="button" data-testid="contact-back" onClick={onClose}>Back</button>
    </div>
  ),
}))

vi.mock('./SettingsView', () => ({
  SettingsView: () => <div data-testid="settings-view">Settings</div>,
}))

vi.mock('./AdminView', () => ({
  AdminView: ({ onBack }: { onBack?: () => void }) => (
    <div data-testid="admin-view">
      Admin
      <button type="button" data-testid="admin-back" onClick={() => onBack?.()}>back</button>
    </div>
  ),
}))

vi.mock('./MemberList', () => ({
  MemberList: () => null,
}))

vi.mock('./XmppConsole', () => ({
  XmppConsole: () => null,
}))

vi.mock('./ShortcutHelp', () => ({
  ShortcutHelp: () => null,
}))

vi.mock('./CommandPalette', () => ({
  CommandPalette: () => null,
}))

vi.mock('./ToastContainer', () => ({
  ToastContainer: () => null,
}))

vi.mock('./CreateRoomModal', () => ({
  CreateRoomModal: ({ onClose }: { onClose: () => void }) => (
    <div data-testid="create-room-modal">
      <button type="button" data-testid="create-room-close" onClick={onClose}>Close</button>
    </div>
  ),
}))

describe('ChatLayout - Tab Memory', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    // Reset mock state
    setMockState({
      activeConversationId: null,
      activeRoomJid: null,
      isArchivedResult: false,
      conversations: new Map(),
      rooms: new Map(),
    })
  })

  describe('history stack (standard back behaviour)', () => {
    it('replaces (no back entry) when auto-selecting the first conversation on connect', async () => {
      // A conversation exists but none is active yet: ChatLayout auto-selects
      // the first one. That is programmatic, not a user navigation, so it must
      // NOT create a back-able entry — otherwise Back lands on an empty list
      // and the back button lights up for a navigation the user never made.
      setMockState({
        activeConversationId: null,
        conversations: new Map([['bob@example.com', { id: 'bob@example.com' }]]),
      })

      render(<ChatLayoutWithProbe initialRoute="/messages" />)

      const path = () => decodeURIComponent(screen.getByTestId('probe-path').textContent ?? '')

      await waitFor(() => {
        expect(path()).toBe('/messages/bob@example.com')
      })

      fireEvent.click(screen.getByTestId('probe-back'))

      // With replace there is nothing behind the auto-selected conversation.
      expect(path()).toBe('/messages/bob@example.com')
    })
  })

  describe('deep-link / programmatic navigation to a specific target', () => {
    // Regression: clicking a reaction toast (or any deep link) that targets a
    // specific conversation/room must not be hijacked by the "auto-select first
    // item" effect. activateConversation/activateRoom are async (they await a
    // cache load before setting the active id), so on the navigation commit the
    // store's active id is still null — the auto-select effect must instead defer
    // to the URL's target (activeJid) and not pick the first item.
    it('does not auto-select the first conversation when the URL targets another one', async () => {
      // Store's first (only) conversation is bob, but the URL points at alice.
      setMockState({
        activeConversationId: null,
        conversations: new Map([['bob@example.com', { id: 'bob@example.com' }]]),
      })

      render(<ChatLayoutWithProbe initialRoute="/messages/alice@example.com" />)

      const path = () => decodeURIComponent(screen.getByTestId('probe-path').textContent ?? '')

      // Give the auto-select effect a chance to (wrongly) fire, then assert the
      // URL still targets alice — auto-select must not override it with bob.
      await waitFor(() => {
        expect(path()).toBe('/messages/alice@example.com')
      })
      expect(mockActivateConversation).not.toHaveBeenCalledWith('bob@example.com')
    })

    it('does not auto-select the first room when the URL targets another one', async () => {
      // Store's first joined room is room1, but the URL points at room2 — the
      // exact reaction-toast case: navigating to a room that isn't the first.
      setMockState({
        activeRoomJid: null,
        rooms: new Map([['room1@conf.example.com', { jid: 'room1@conf.example.com', joined: true }]]),
      })

      render(<ChatLayoutWithProbe initialRoute="/rooms/room2@conf.example.com" />)

      const path = () => decodeURIComponent(screen.getByTestId('probe-path').textContent ?? '')

      await waitFor(() => {
        expect(path()).toBe('/rooms/room2@conf.example.com')
      })
      expect(mockActivateRoom).not.toHaveBeenCalledWith('room1@conf.example.com')
    })
  })

  describe('Messages tab memory', () => {
    // TODO Phase 2.5: Update this test to work with URL-based navigation
    // The test needs to use proper router testing patterns where rerender
    // doesn't reset the MemoryRouter state
    it.skip('should restore conversation when returning to Messages tab', async () => {
      // Start with an active conversation
      setMockState({ activeConversationId: 'bob@example.com' })

      const { rerender } = render(<ChatLayoutWithRouter />)

      // Verify we're showing the chat view
      expect(screen.getByTestId('chat-view')).toBeInTheDocument()
      expect(screen.getByText('Conversation: bob@example.com')).toBeInTheDocument()

      // Switch to Rooms tab - this should save the conversation and clear it
      fireEvent.click(screen.getByTestId('rooms-tab'))

      // Wait for state updates
      await waitFor(() => {
        expect(mockSetActiveConversation).toHaveBeenCalledWith(null)
      })

      // Simulate the state change
      setMockState({ activeConversationId: null })
      rerender(<ChatLayoutWithRouter />)

      // Verify conversation is cleared
      expect(screen.queryByTestId('chat-view')).not.toBeInTheDocument()

      // Switch back to Messages tab - should restore the conversation
      fireEvent.click(screen.getByTestId('messages-tab'))

      await waitFor(() => {
        expect(mockSetActiveConversation).toHaveBeenCalledWith('bob@example.com')
      })
    })

    it('should not restore conversation if none was active', async () => {
      // Start with no conversation
      setMockState({ activeConversationId: null })

      render(<ChatLayoutWithRouter />)

      // Switch to Rooms and back
      fireEvent.click(screen.getByTestId('rooms-tab'))
      fireEvent.click(screen.getByTestId('messages-tab'))

      // setActiveConversation should be called with null (clearing room state)
      // but not with any conversation ID since none was saved
      await waitFor(() => {
        // The last call should be clearing the room, not restoring a conversation
        const calls = mockSetActiveConversation.mock.calls
        const restoreCalls = calls.filter(call => call[0] !== null)
        expect(restoreCalls).toHaveLength(0)
      })
    })
  })

  describe('Rooms tab memory', () => {
    // TODO Phase 2.5: Update to work with URL-based navigation
    it.skip('should restore room when returning to Rooms tab', async () => {
      setMockState({ activeRoomJid: null })

      const { rerender } = render(<ChatLayoutWithRouter />)

      // First, switch to Rooms tab to set sidebarView to 'rooms'
      fireEvent.click(screen.getByTestId('rooms-tab'))

      // Now set the active room (simulating user joining a room)
      setMockState({ activeRoomJid: 'room@conference.example.com' })
      rerender(<ChatLayoutWithRouter />)

      // Verify we're showing the room view
      expect(screen.getByTestId('room-view')).toBeInTheDocument()

      // Switch to Messages tab - should save room and clear it
      fireEvent.click(screen.getByTestId('messages-tab'))

      await waitFor(() => {
        expect(mockSetActiveRoom).toHaveBeenCalledWith(null)
      })

      // Simulate the state change
      setMockState({ activeRoomJid: null })
      rerender(<ChatLayoutWithRouter />)

      // Verify room is cleared
      expect(screen.queryByTestId('room-view')).not.toBeInTheDocument()

      // Switch back to Rooms tab - should restore the room
      fireEvent.click(screen.getByTestId('rooms-tab'))

      await waitFor(() => {
        expect(mockSetActiveRoom).toHaveBeenCalledWith('room@conference.example.com')
      })
    })

    it('should not restore room if none was active', async () => {
      setMockState({ activeRoomJid: null })

      render(<ChatLayoutWithRouter />)

      // Switch to Messages and back to Rooms
      fireEvent.click(screen.getByTestId('messages-tab'))
      fireEvent.click(screen.getByTestId('rooms-tab'))

      await waitFor(() => {
        const restoreCalls = mockSetActiveRoom.mock.calls.filter(call => call[0] !== null)
        expect(restoreCalls).toHaveLength(0)
      })
    })
  })

  describe('Directory/Connections tab memory', () => {
    // TODO Phase 2.5: Update to work with URL-based navigation
    it.skip('should restore contact profile when returning to Directory tab', async () => {
      render(<ChatLayoutWithRouter />)

      // First, navigate to Directory tab
      fireEvent.click(screen.getByTestId('directory-tab'))

      // Select a contact to view their profile
      fireEvent.click(screen.getByTestId('select-contact'))

      // Verify contact profile is shown
      await waitFor(() => {
        expect(screen.getByTestId('contact-profile-view')).toBeInTheDocument()
        expect(screen.getByText('Contact: Alice Smith')).toBeInTheDocument()
      })

      // Switch to Messages tab
      fireEvent.click(screen.getByTestId('messages-tab'))

      // Contact profile should be cleared
      await waitFor(() => {
        expect(screen.queryByTestId('contact-profile-view')).not.toBeInTheDocument()
      })

      // Switch back to Directory tab - should restore the contact profile
      fireEvent.click(screen.getByTestId('directory-tab'))

      await waitFor(() => {
        expect(screen.getByTestId('contact-profile-view')).toBeInTheDocument()
        expect(screen.getByText('Contact: Alice Smith')).toBeInTheDocument()
      })
    })
  })

  describe('Legacy /archive URL (degraded to messages)', () => {
    it('should degrade a legacy /archive URL to the messages view', async () => {
      // /archive is a legacy URL - it now falls through to 'messages' view
      render(<ChatLayoutWithRouter initialRoute="/archive" />)

      await waitFor(() => {
        expect(screen.getByTestId('active-view')).toHaveTextContent('messages')
      })
    })

    it('should allow viewing archived conversations in messages panel after navigating to legacy /archive', async () => {
      // Start with no active content
      setMockState({ activeConversationId: null, activeRoomJid: null })

      const { rerender } = render(<ChatLayoutWithRouter initialRoute="/archive" />)

      // Now set an active conversation (simulating clicking archived conversation)
      setMockState({ activeConversationId: 'archived@example.com' })
      rerender(<ChatLayoutWithRouter initialRoute="/archive" />)

      // Should show the chat view for the archived conversation
      expect(screen.getByTestId('chat-view')).toBeInTheDocument()
    })
  })

  describe('Cross-tab switching', () => {
    // TODO Phase 2.5: Update to work with URL-based navigation
    it.skip('should handle Messages -> Rooms -> Directory -> Messages flow', async () => {
      // Start with conversation in Messages
      setMockState({ activeConversationId: 'bob@example.com', activeRoomJid: null })

      const { rerender } = render(<ChatLayoutWithRouter />)

      expect(screen.getByTestId('chat-view')).toBeInTheDocument()

      // Switch to Rooms - saves conversation, opens room (if we had one remembered)
      fireEvent.click(screen.getByTestId('rooms-tab'))

      await waitFor(() => {
        expect(mockSetActiveConversation).toHaveBeenCalledWith(null)
      })

      setMockState({ activeConversationId: null })
      rerender(<ChatLayoutWithRouter />)

      // Switch to Directory
      fireEvent.click(screen.getByTestId('directory-tab'))

      // Select a contact
      fireEvent.click(screen.getByTestId('select-contact'))

      await waitFor(() => {
        expect(screen.getByTestId('contact-profile-view')).toBeInTheDocument()
      })

      // Switch back to Messages - should restore conversation
      fireEvent.click(screen.getByTestId('messages-tab'))

      await waitFor(() => {
        expect(mockSetActiveConversation).toHaveBeenCalledWith('bob@example.com')
      })
    })

    it('should clear conflicting state when switching tabs', async () => {
      // Start with both conversation and room active (edge case)
      setMockState({
        activeConversationId: 'bob@example.com',
        activeRoomJid: 'room@conference.example.com',
      })

      // Start from /rooms so clicking messages-tab actually navigates
      render(<ChatLayoutWithRouter initialRoute="/rooms" />)

      // Room takes priority in render, so room view shows
      expect(screen.getByTestId('room-view')).toBeInTheDocument()

      // Switch to Messages - should clear room
      fireEvent.click(screen.getByTestId('messages-tab'))

      await waitFor(() => {
        expect(mockSetActiveRoom).toHaveBeenCalledWith(null)
      })

      // The URL (now /messages with no JID) is the source of truth: the stale
      // active conversation is cleared through the URL→store sync
      await waitFor(() => {
        expect(mockActivateConversation).toHaveBeenCalledWith(null)
      })

      // Switch to Rooms - conversation must remain cleared (no conflicting state)
      fireEvent.click(screen.getByTestId('rooms-tab'))

      await waitFor(() => {
        expect(getMockState().activeConversationId).toBeNull()
      })
    })
  })

  describe('Tab state persistence within session', () => {
    // TODO Phase 2.5: Update to work with URL-based navigation
    it.skip('should maintain separate state for each tab', async () => {
      render(<ChatLayoutWithRouter />)

      // Go to Directory and select contact
      fireEvent.click(screen.getByTestId('directory-tab'))
      fireEvent.click(screen.getByTestId('select-contact'))

      await waitFor(() => {
        expect(screen.getByTestId('contact-profile-view')).toBeInTheDocument()
      })

      // Go to Rooms, then Events, then back to Directory
      fireEvent.click(screen.getByTestId('rooms-tab'))
      fireEvent.click(screen.getByTestId('events-tab'))
      fireEvent.click(screen.getByTestId('directory-tab'))

      // Contact should still be remembered
      await waitFor(() => {
        expect(screen.getByTestId('contact-profile-view')).toBeInTheDocument()
        expect(screen.getByText('Contact: Alice Smith')).toBeInTheDocument()
      })
    })
  })

  describe('Start conversation', () => {
    it('should switch to messages view when starting a conversation', async () => {
      // Start on Directory tab
      setMockState({ activeConversationId: null, activeRoomJid: null })

      render(<ChatLayoutWithRouter />)

      // Go to Directory tab first
      fireEvent.click(screen.getByTestId('directory-tab'))

      await waitFor(() => {
        expect(screen.getByTestId('active-view')).toHaveTextContent('contacts')
      })

      // Start a chat with the contact
      fireEvent.click(screen.getByTestId('start-chat'))

      // Should switch to messages view
      await waitFor(() => {
        expect(screen.getByTestId('active-view')).toHaveTextContent('messages')
      })

      // Should activate the conversation (hydrating action)
      expect(mockActivateConversation).toHaveBeenCalledWith('alice@example.com')
    })

    it('should set active conversation after navigating to messages view', async () => {
      // This test verifies the correct order: navigate first, then set conversation
      // Previously, the order was reversed which caused the "restore last content"
      // logic to overwrite the user's selection

      const callOrder: string[] = []

      // Track the order of calls
      mockActivateConversation.mockImplementation(async (id: string | null) => {
        if (id !== null) {
          callOrder.push(`activateConversation:${id}`)
        }
        setMockState({ activeConversationId: id })
      })

      render(<ChatLayoutWithRouter />)

      // Start on Rooms tab (not messages, so we can verify the switch)
      fireEvent.click(screen.getByTestId('rooms-tab'))

      await waitFor(() => {
        expect(screen.getByTestId('active-view')).toHaveTextContent('rooms')
      })

      // Clear any prior calls
      callOrder.length = 0
      vi.clearAllMocks()

      // Start a chat - this should:
      // 1. Navigate to messages (which triggers handleSidebarViewChange)
      // 2. Set the active conversation
      fireEvent.click(screen.getByTestId('start-chat'))

      await waitFor(() => {
        // The conversation should be activated after navigation
        expect(mockActivateConversation).toHaveBeenCalledWith('alice@example.com')
        // And we should be in messages view
        expect(screen.getByTestId('active-view')).toHaveTextContent('messages')
      })
    })

    it('should switch to messages view when starting conversation with archived contact', async () => {
      // Contact has an archived conversation - now opens in messages view (archive toggle handles display)
      setMockState({
        isArchivedResult: true,
        activeConversationId: null,
        activeRoomJid: null,
      })

      render(<ChatLayoutWithRouter />)

      // Go to Directory tab first
      fireEvent.click(screen.getByTestId('directory-tab'))

      await waitFor(() => {
        expect(screen.getByTestId('active-view')).toHaveTextContent('contacts')
      })

      // Start a chat with the contact (who has an archived conversation)
      fireEvent.click(screen.getByTestId('start-chat'))

      // Should switch to messages view (archive rail is gone)
      await waitFor(() => {
        expect(screen.getByTestId('active-view')).toHaveTextContent('messages')
      })

      // Should activate the conversation (hydrating action)
      expect(mockActivateConversation).toHaveBeenCalledWith('alice@example.com')
    })
  })
})

// Import the mock to change its behavior in specific tests
import * as sessionPersistence from '@/hooks/useSessionPersistence'

describe('ChatLayout - Session Storage Restore (Dual-Persistence Bug Prevention)', () => {
  // These tests prevent regression of the bug where activeConversationId
  // was persisted in both chatStore (zustand/localStorage) and ChatLayout
  // (sessionStorage), causing unread badge issues when values got out of sync.

  beforeEach(() => {
    vi.clearAllMocks()
    setMockState({
      activeConversationId: null,
      activeRoomJid: null,
      isArchivedResult: false,
    })
  })

  it('replaces (no back entry) when restoring the saved view on mount', async () => {
    // Restoring the persisted view is programmatic, not a user navigation, so
    // it must not push a duplicate history entry — Back after a reload should
    // not pop to a phantom empty list.
    vi.mocked(sessionPersistence.getSavedViewState).mockReturnValue({
      sidebarView: 'messages',
      activeConversationId: 'carol@example.com',
      activeRoomJid: null,
      selectedContactJid: null,
    })

    render(<ChatLayoutWithProbe initialRoute="/messages" />)

    const path = () => decodeURIComponent(screen.getByTestId('probe-path').textContent ?? '')

    await waitFor(() => {
      expect(path()).toBe('/messages/carol@example.com')
    })

    fireEvent.click(screen.getByTestId('probe-back'))

    expect(path()).toBe('/messages/carol@example.com')
  })

  it('should always set activeConversationId from session storage, even when null', async () => {
    // Scenario: User was in Rooms view (activeConversationId: null)
    // On restore, we MUST call setActiveConversation(null) to override
    // any stale value from chatStore's zustand persistence
    vi.mocked(sessionPersistence.getSavedViewState).mockReturnValue({
      sidebarView: 'rooms',
      activeConversationId: null,
      activeRoomJid: 'room@conference.example.com',
      selectedContactJid: null,
    })

    render(<ChatLayoutWithRouter />)

    await waitFor(() => {
      // Activation MUST be called with null (clears any stale persisted value)
      expect(mockActivateConversation).toHaveBeenCalledWith(null)
    })
  })

  it('should always set activeRoomJid from session storage, even when null', async () => {
    // Scenario: User was in Messages view (activeRoomJid: null)
    // On restore, we MUST call setActiveRoom(null) to clear any stale value
    vi.mocked(sessionPersistence.getSavedViewState).mockReturnValue({
      sidebarView: 'messages',
      activeConversationId: 'alice@example.com',
      activeRoomJid: null,
      selectedContactJid: null,
    })

    render(<ChatLayoutWithRouter />)

    await waitFor(() => {
      // Room activation MUST be called with null (clears any stale persisted value)
      expect(mockActivateRoom).toHaveBeenCalledWith(null)
    })
  })

  it('should restore both conversation and room correctly from session storage', async () => {
    // Scenario: User was viewing a conversation in Messages tab
    vi.mocked(sessionPersistence.getSavedViewState).mockReturnValue({
      sidebarView: 'messages',
      activeConversationId: 'bob@example.com',
      activeRoomJid: null,
      selectedContactJid: null,
    })

    render(<ChatLayoutWithRouter />)

    await waitFor(() => {
      expect(mockActivateConversation).toHaveBeenCalledWith('bob@example.com')
      expect(mockActivateRoom).toHaveBeenCalledWith(null)
    })
  })

  it('should handle session storage with both null correctly (fresh state)', async () => {
    // Scenario: Fresh session, nothing was active
    vi.mocked(sessionPersistence.getSavedViewState).mockReturnValue({
      sidebarView: 'messages',
      activeConversationId: null,
      activeRoomJid: null,
      selectedContactJid: null,
    })

    render(<ChatLayoutWithRouter />)

    await waitFor(() => {
      // Both should be called with null to ensure clean state
      expect(mockActivateConversation).toHaveBeenCalledWith(null)
      expect(mockActivateRoom).toHaveBeenCalledWith(null)
    })
  })
})

describe('ChatLayout - URL→store sync hydration (popstate)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    // clearAllMocks doesn't remove mockReturnValue stubs left by the
    // session-storage describe above — restore the default (no saved state)
    vi.mocked(sessionPersistence.getSavedViewState).mockReturnValue(null)
    setMockState({
      activeConversationId: null,
      activeRoomJid: null,
      isArchivedResult: false,
    })
  })

  it('should activate a conversation from a URL-only change through the hydrating store action', async () => {
    render(<ChatLayoutWithRouter initialRoute="/messages" />)

    fireEvent.click(screen.getByTestId('deep-conversation-link'))

    await waitFor(() => {
      expect(mockActivateConversation).toHaveBeenCalledWith('bob@example.com')
    })
    // The raw setter skips IndexedDB hydration — the view would render empty until
    // a manual scroll triggers a history load (same bug as PR #486)
    expect(mockSetActiveConversation).not.toHaveBeenCalledWith('bob@example.com')
  })

  it('should activate a room from a URL-only change through the hydrating store action', async () => {
    render(<ChatLayoutWithRouter initialRoute="/rooms" />)

    fireEvent.click(screen.getByTestId('deep-room-link'))

    await waitFor(() => {
      expect(mockActivateRoom).toHaveBeenCalledWith('lobby@conference.example.com')
    })
    expect(mockSetActiveRoom).not.toHaveBeenCalledWith('lobby@conference.example.com')
  })

  it('should clear the contact profile when the URL moves back to a non-directory view', async () => {
    // Open the profile from a 1:1 conversation header: sets selectedContactJid
    // and navigates to /contacts/:jid
    setMockState({ activeConversationId: 'alice@example.com' })
    render(<ChatLayoutWithRouter initialRoute="/messages/alice%40example.com" />)
    fireEvent.click(screen.getByTestId('chat-show-profile'))
    await waitFor(() => {
      expect(screen.getByTestId('contact-profile-view')).toBeInTheDocument()
    })

    // Browser back to /messages (no jid) is a URL-only change: no click handler
    // clears selectedContactJid, so the URL→store sync effect must do it
    fireEvent.click(screen.getByTestId('messages-tab'))

    await waitFor(() => {
      expect(screen.queryByTestId('contact-profile-view')).not.toBeInTheDocument()
    })
    expect(screen.getByTestId('active-view')).toHaveTextContent('messages')
  })
})

describe('ChatLayout - EmptyState visual design', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(sessionPersistence.getSavedViewState).mockReturnValue(null)
    setMockState({
      activeConversationId: null,
      activeRoomJid: null,
      isArchivedResult: false,
    })
  })

  it('renders the empty-state with an accent mark and a display-font title', () => {
    render(<ChatLayoutWithRouter initialRoute="/messages" />)
    // title carries the display font utility
    const title = screen.getByRole('heading', { level: 2 })
    expect(title.className).toMatch(/font-display/)
    // the mark uses the accent, not the flat sidebar gray
    const mark = title.parentElement?.querySelector('.rounded-full')
    expect(mark?.className).toMatch(/fluux-brand/)
    expect(mark?.className).not.toMatch(/bg-fluux-sidebar/)
  })
})

describe('ChatLayout - Show profile from conversation header', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    // clearAllMocks doesn't remove mockReturnValue stubs left by the
    // session-storage describe above — restore the default (no saved state)
    vi.mocked(sessionPersistence.getSavedViewState).mockReturnValue(null)
    setMockState({
      activeConversationId: null,
      activeRoomJid: null,
      isArchivedResult: false,
    })
  })

  it('should open the contact profile on first click without bouncing back to the conversation', async () => {
    // Start inside a 1:1 conversation with Alice
    setMockState({ activeConversationId: 'alice@example.com' })
    render(<ChatLayoutWithRouter initialRoute="/messages/alice%40example.com" />)
    expect(screen.getByTestId('chat-view')).toBeInTheDocument()

    fireEvent.click(screen.getByTestId('chat-show-profile'))

    // The URL→store sync effect must not re-activate the conversation we just
    // left: navigate() is transition-deferred in React Router v7, so the effect
    // re-runs while the URL still points at /messages/:jid
    await waitFor(() => {
      expect(screen.getByTestId('contact-profile-view')).toBeInTheDocument()
    })
    expect(screen.queryByTestId('chat-view')).not.toBeInTheDocument()
    expect(mockActivateConversation).not.toHaveBeenCalledWith('alice@example.com')
  })
})

describe('ChatLayout - EmptyState primary actions', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    setMockState({
      activeConversationId: null,
      activeRoomJid: null,
      isArchivedResult: false,
    })
  })

  it('shows a primary action on the messages empty-state', async () => {
    render(<ChatLayoutWithRouter initialRoute="/messages" />)
    expect(screen.getByText('Start a conversation')).toBeInTheDocument()
  })

  it('shows a primary action on the rooms empty-state', () => {
    render(<ChatLayoutWithRouter initialRoute="/rooms" />)
    expect(screen.getByRole('button', { name: /create a room/i })).toBeInTheDocument()
  })

  it('clicking the rooms action opens the create-room modal', async () => {
    render(<ChatLayoutWithRouter initialRoute="/rooms" />)
    fireEvent.click(screen.getByRole('button', { name: /create a room/i }))
    await waitFor(() => {
      expect(screen.getByTestId('create-room-modal')).toBeInTheDocument()
    })
  })
})

describe('ChatLayout - activation gap (no empty-state flash)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    setMockState({
      activeConversationId: null,
      activeRoomJid: null,
      chatActivationPending: false,
      roomActivationPending: false,
      isArchivedResult: false,
    })
  })

  afterEach(() => {
    setMockState({ chatActivationPending: false, roomActivationPending: false })
  })

  // Regression for the empty-screen flash on rail tab switch: while a hydrating
  // activation is in flight (cache load before the active id lands) both active
  // ids are null, so the render cascade would otherwise fall through to the
  // empty-state hero. It must hold a neutral surface instead.
  it('does not flash the empty-state hero while an activation is pending', () => {
    setMockState({ chatActivationPending: true })
    render(<ChatLayoutWithRouter initialRoute="/messages" />)

    expect(screen.queryByText('Start a conversation')).toBeNull()
  })

  it('shows the empty-state hero once no activation is pending', () => {
    setMockState({ chatActivationPending: false })
    render(<ChatLayoutWithRouter initialRoute="/messages" />)

    expect(screen.getByText('Start a conversation')).toBeInTheDocument()
  })
})

// The mobile layout is a single pane: the sidebar column and the main pane swap
// via `hidden md:flex` / `flex`, driven by hasActiveContent. A hydrating
// activation sets the active id only AFTER the IndexedDB read resolves, so the
// swap must be gated on the pending flag too — otherwise a tap on a
// conversation row is dead on screen until the cache answers.
describe('ChatLayout - mobile pane swap during a hydrating activation', () => {
  /** The sidebar column and main pane, as the mobile single-pane swap sees them. */
  const panes = () => ({
    sidebar: screen.getByTestId('sidebar-pane'),
    main: screen.getByRole('main'),
  })

  beforeEach(() => {
    vi.clearAllMocks()
    setMockState({
      activeConversationId: null,
      activeRoomJid: null,
      chatActivationPending: false,
      roomActivationPending: false,
      isArchivedResult: false,
      conversations: new Map(),
      rooms: new Map(),
    })
  })

  afterEach(() => {
    setMockState({ chatActivationPending: false, roomActivationPending: false })
  })

  it('hides the sidebar and shows the hydration surface before the tapped conversation resolves', async () => {
    // Stand in for a slow cache read: flag the hydration window synchronously
    // (as activateConversation does), then hold the active id back until the
    // test releases it. This is the window the tap has to feel responsive in.
    let releaseCacheRead: (() => void) | undefined
    const cacheRead = new Promise<void>((resolve) => {
      releaseCacheRead = resolve
    })
    mockActivateConversation.mockImplementationOnce(async (id: string | null) => {
      setMockState({ chatActivationPending: true })
      await cacheRead
      setMockState({ activeConversationId: id, chatActivationPending: false })
    })

    render(<ChatLayoutWithRouter initialRoute="/messages" />)
    // Sanity: nothing active yet, so mobile is showing the list.
    expect(panes().sidebar).not.toHaveClass('hidden')

    // Tap a conversation row (URL → store sync activates it).
    fireEvent.click(screen.getByTestId('deep-conversation-link'))

    await waitFor(() => {
      expect(mockActivateConversation).toHaveBeenCalledWith('bob@example.com')
    })

    // Mid-flight: the activation has NOT resolved...
    expect(getMockState().activeConversationId).toBeNull()
    expect(screen.queryByTestId('chat-view')).not.toBeInTheDocument()
    // ...yet the pane has already swapped and holds the neutral surface.
    expect(panes().sidebar).toHaveClass('hidden')
    expect(panes().main).not.toHaveClass('hidden')
    expect(screen.getByTestId('view-loading-fallback')).toBeInTheDocument()
    expect(screen.queryByText('Start a conversation')).toBeNull()

    // Cache read resolves: straight from the surface to the conversation, and
    // the pane stays swapped (no frame where the sidebar comes back).
    releaseCacheRead?.()
    expect(await screen.findByTestId('chat-view')).toBeInTheDocument()
    expect(screen.queryByTestId('view-loading-fallback')).not.toBeInTheDocument()
    expect(panes().sidebar).toHaveClass('hidden')
  })

  // Control for the assertions above: at the same point in the flow, with
  // nothing pending, the sidebar keeps the screen. Without this a gate stuck at
  // `true` would pass the test above.
  it('keeps the sidebar when the tapped conversation never enters a pending window', async () => {
    mockActivateConversation.mockImplementationOnce(async () => {
      // No pending flag, no active id: the activation is a no-op.
    })

    render(<ChatLayoutWithRouter initialRoute="/messages" />)
    fireEvent.click(screen.getByTestId('deep-conversation-link'))

    await waitFor(() => {
      expect(mockActivateConversation).toHaveBeenCalledWith('bob@example.com')
    })

    expect(panes().sidebar).not.toHaveClass('hidden')
    expect(panes().main).toHaveClass('hidden')
    expect(screen.queryByTestId('view-loading-fallback')).not.toBeInTheDocument()
    expect(screen.getByText('Start a conversation')).toBeInTheDocument()
  })

  // Parity: ChatLayout ORs both stores' pending flags, so a room tap must swap
  // the pane the same way a conversation tap does.
  it('hides the sidebar while a room activation is pending', () => {
    setMockState({ roomActivationPending: true })
    render(<ChatLayoutWithRouter initialRoute="/rooms" />)

    expect(panes().sidebar).toHaveClass('hidden')
    expect(panes().main).not.toHaveClass('hidden')
    expect(screen.getByTestId('view-loading-fallback')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /create a room/i })).not.toBeInTheDocument()
  })

  // The settings branch sits ABOVE the neutral surface in the render cascade,
  // so counting a pending activation as content there would hand the mobile
  // screen to a category-less SettingsView — the one view that deliberately
  // lets the user pick from the sidebar first. Reachable by tapping Settings
  // while a slow cache read is still in flight.
  it('leaves the settings sidebar visible while an unrelated activation is pending', () => {
    setMockState({ chatActivationPending: true })
    render(<ChatLayoutWithRouter initialRoute="/settings" />)

    expect(panes().sidebar).not.toHaveClass('hidden')
    expect(panes().main).toHaveClass('hidden')
  })
})

describe('ChatLayout - admin back navigation (mobile)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    setMockState({
      activeConversationId: null,
      activeRoomJid: null,
      chatActivationPending: false,
      roomActivationPending: false,
      isArchivedResult: false,
      conversations: new Map(),
      rooms: new Map(),
      adminIsAdmin: true,
      adminCategory: 'stats',
      adminSession: null,
    })
  })

  afterEach(() => {
    setMockState({ adminIsAdmin: false, adminCategory: null, adminSession: null })
  })

  it('renders the admin view when the URL is /admin', async () => {
    render(<ChatLayoutWithRouter initialRoute="/admin" />)
    // AdminView is lazy-loaded behind Suspense.
    expect(await screen.findByTestId('admin-view')).toBeInTheDocument()
  })

  // System/browser back pops the URL off /admin, but the admin store state can
  // still hold a category (nothing clears it on popstate). The admin panel must
  // NOT render over the route we backed into — it is gated on the admin route.
  it('does not render the admin view when the URL left /admin, even with a stale category', async () => {
    render(<ChatLayoutWithRouter initialRoute="/messages" />)
    // The page underneath (messages home) is visible instead. With the bug the
    // stale category renders AdminView's Suspense fallback and this never shows.
    expect(await screen.findByText('Start a conversation')).toBeInTheDocument()
    expect(screen.queryByTestId('admin-view')).not.toBeInTheDocument()
  })

  // In-app header back arrow from the admin overview must leave admin entirely
  // and return to the home screen, not bounce back to the overview.
  it('mobile back from the admin overview navigates home (messages)', async () => {
    render(<ChatLayoutWithProbe initialRoute="/admin" />)
    fireEvent.click(await screen.findByTestId('admin-back'))

    expect(await screen.findByText('Start a conversation')).toBeInTheDocument()
    expect(screen.getByTestId('probe-path').textContent).toBe('/messages')
    expect(screen.queryByTestId('admin-view')).not.toBeInTheDocument()
  })
})

// Spec §3 step 3: Escape with nothing higher-priority open marks the active
// conversation/room read and jumps to the present (lowest Escape priority,
// behind modals/console/contact-profile — see useKeyboardShortcuts.test.tsx
// for the priority-chain unit coverage and the window-level defaultPrevented
// guard, which this file's useKeyboardShortcuts mock intentionally bypasses).
// These tests cover the ChatLayout-level wiring: which store action fires for
// which active view, and the guard that stops a backgrounded conversation (tab
// memory) from being marked read while Settings is what's actually on screen.
describe('ChatLayout - Escape marks the active conversation read (spec §3)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    setMockState({
      activeConversationId: null,
      activeRoomJid: null,
      chatActivationPending: false,
      roomActivationPending: false,
      isArchivedResult: false,
      conversations: new Map(),
      rooms: new Map(),
    })
  })

  // Invokes the real onConversationEscape callback ChatLayout builds and passes
  // to useKeyboardShortcuts (captured by the mock above), the same way the hook's
  // handleEscape would call it as the last step of its priority chain.
  const escape = (): boolean | undefined => {
    const options = lastKeyboardShortcutsOptions.current as {
      escapeHierarchy?: { onConversationEscape?: () => boolean }
    } | null
    return options?.escapeHierarchy?.onConversationEscape?.()
  }

  it('marks the active conversation read on bare Escape when a chat is displayed', async () => {
    setMockState({ activeConversationId: 'alice@example.com' })
    render(<ChatLayoutWithRouter initialRoute="/messages/alice@example.com" />)
    expect(await screen.findByTestId('chat-view')).toBeInTheDocument()

    expect(escape()).toBe(true)

    expect(mockMarkChatReadToNewest).toHaveBeenCalledWith('alice@example.com')
    expect(mockMarkRoomReadToNewest).not.toHaveBeenCalled()
  })

  it('marks the active room read on bare Escape when a room is displayed', async () => {
    setMockState({ activeRoomJid: 'room@conference.example.com' })
    render(<ChatLayoutWithRouter initialRoute="/rooms/room@conference.example.com" />)
    expect(await screen.findByTestId('room-view')).toBeInTheDocument()

    expect(escape()).toBe(true)

    expect(mockMarkRoomReadToNewest).toHaveBeenCalledWith('room@conference.example.com')
    expect(mockMarkChatReadToNewest).not.toHaveBeenCalled()
  })

  it('does nothing when no conversation or room is active', async () => {
    render(<ChatLayoutWithRouter initialRoute="/messages" />)
    expect(await screen.findByText('Start a conversation')).toBeInTheDocument()

    expect(escape()).toBe(false)

    expect(mockMarkChatReadToNewest).not.toHaveBeenCalled()
    expect(mockMarkRoomReadToNewest).not.toHaveBeenCalled()
  })

  // activeConversationId/activeRoomJid persist across other views (tab memory) —
  // Settings taking the main content area must not mark a backgrounded
  // conversation read out from under the user.
  it('does not mark a backgrounded conversation read while Settings is displayed', async () => {
    setMockState({ activeConversationId: 'alice@example.com' })
    render(<ChatLayoutWithRouter initialRoute="/settings" />)
    expect(await screen.findByTestId('settings-view')).toBeInTheDocument()

    expect(escape()).toBe(false)

    expect(mockMarkChatReadToNewest).not.toHaveBeenCalled()
    expect(mockMarkRoomReadToNewest).not.toHaveBeenCalled()
  })
})
