import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
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
  getMockState,
  setMockState,
} = vi.hoisted(() => {
  const state = {
    activeConversationId: null as string | null,
    activeRoomJid: null as string | null,
    activationPending: false,
    isArchivedResult: false,
  }

  const mockContact: Contact = {
    jid: 'alice@example.com',
    name: 'Alice Smith',
    presence: 'online' as PresenceStatus,
    subscription: 'both',
  }

  const mockSetActiveConversation = vi.fn((id: string | null) => {
    state.activeConversationId = id
  })

  const mockSetActiveRoom = vi.fn((jid: string | null) => {
    state.activeRoomJid = jid
  })

  // Hydrating activation actions (load message cache, then set active)
  const mockActivateConversation = vi.fn(async (id: string | null) => {
    state.activeConversationId = id
  })

  const mockActivateRoom = vi.fn(async (jid: string | null) => {
    state.activeRoomJid = jid
  })

  return {
    mockContact,
    mockSetActiveConversation,
    mockSetActiveRoom,
    mockActivateConversation,
    mockActivateRoom,
    getMockState: () => state,
    setMockState: (newState: Partial<typeof state>) => Object.assign(state, newState),
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
    }),
  },
  roomStore: {
    getState: () => ({
      activeRoomJid: getMockState().activeRoomJid,
      markAsRead: vi.fn(),
      clearFirstNewMessageId: vi.fn(),
      setActiveRoom: mockSetActiveRoom,
      activateRoom: mockActivateRoom,
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
      setCurrentSession: vi.fn(),
      setTargetJid: vi.fn(),
      setActiveCategory: vi.fn(),
      vhosts: [],
      setSelectedVhost: vi.fn(),
      setPendingSelectedUserJid: vi.fn(),
    }),
  },
}))

// Mock React store hooks (from @fluux/sdk/react)
vi.mock('@fluux/sdk/react', () => ({
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
      const state = {
        activeConversationId: getMockState().activeConversationId,
        activationPending: getMockState().activationPending,
        setActiveConversation: mockSetActiveConversation,
        activateConversation: mockActivateConversation,
        addConversation: vi.fn(),
        hasConversation: vi.fn(() => false),
        isArchived: vi.fn(() => getMockState().isArchivedResult),
        updateConversationName: vi.fn(),
        conversations: new Map(),
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
    (selector: (state: { activeRoomJid: string | null; setActiveRoom: typeof mockSetActiveRoom; activateRoom: typeof mockActivateRoom; rooms: Map<string, unknown> }) => unknown) => {
      const state = {
        activeRoomJid: getMockState().activeRoomJid,
        setActiveRoom: mockSetActiveRoom,
        activateRoom: mockActivateRoom,
        rooms: new Map(),
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
    (selector: (state: { currentSession: null; activeCategory: null }) => unknown) => {
      return selector({ currentSession: null, activeCategory: null })
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
}))

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
  useKeyboardShortcuts: () => [],
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
        <button data-testid="select-contact" onClick={() => onSelectContact(mockContact)}>Select Contact</button>
        <button data-testid="start-chat" onClick={() => onStartChat(mockContact)}>Start Chat</button>
      </div>
    )
  },
}))

vi.mock('./ChatView', () => ({
  ChatView: ({ onBack, onShowProfile }: { onBack: () => void; onShowProfile?: (jid: string) => void }) => (
    <div data-testid="chat-view">
      <span>Conversation: {getMockState().activeConversationId}</span>
      <button data-testid="chat-back" onClick={onBack}>Back</button>
      <button
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
      <button data-testid="room-back" onClick={onBack}>Back</button>
    </div>
  ),
}))

vi.mock('./ContactProfileView', () => ({
  ContactProfileView: ({ contact, onClose }: { contact: Contact; onClose: () => void }) => (
    <div data-testid="contact-profile-view">
      <span>Contact: {contact.name}</span>
      <button data-testid="contact-back" onClick={onClose}>Back</button>
    </div>
  ),
}))

vi.mock('./SettingsView', () => ({
  SettingsView: () => <div data-testid="settings-view">Settings</div>,
}))

vi.mock('./AdminView', () => ({
  AdminView: () => <div data-testid="admin-view">Admin</div>,
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
      <button data-testid="create-room-close" onClick={onClose}>Close</button>
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
      activationPending: false,
      isArchivedResult: false,
    })
  })

  afterEach(() => {
    setMockState({ activationPending: false })
  })

  // Regression for the empty-screen flash on rail tab switch: while a hydrating
  // activation is in flight (cache load before the active id lands) both active
  // ids are null, so the render cascade would otherwise fall through to the
  // empty-state hero. It must hold a neutral surface instead.
  it('does not flash the empty-state hero while an activation is pending', () => {
    setMockState({ activationPending: true })
    render(<ChatLayoutWithRouter initialRoute="/messages" />)

    expect(screen.queryByText('Start a conversation')).toBeNull()
  })

  it('shows the empty-state hero once no activation is pending', () => {
    setMockState({ activationPending: false })
    render(<ChatLayoutWithRouter initialRoute="/messages" />)

    expect(screen.getByText('Start a conversation')).toBeInTheDocument()
  })
})
