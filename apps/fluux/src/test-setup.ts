/**
 * Vitest setup file for jsdom environment
 */
import { vi } from 'vitest'
import '@testing-library/jest-dom/vitest'
import i18n from 'i18next'
import { initReactI18next } from 'react-i18next'

// Mock renderLoopDetector for tests (all exports become no-ops)
vi.mock('@/utils/renderLoopDetector', () => ({
  detectRenderLoop: vi.fn(),
  trackSelectorChange: vi.fn(),
  getSelectorHistory: vi.fn(() => []),
  clearSelectorHistory: vi.fn(),
  logRenderSummary: vi.fn(),
  resetRenderLoopDetector: vi.fn(),
  startWakeGracePeriod: vi.fn(),
  startSyncGracePeriod: vi.fn(),
  notifyUserInput: vi.fn(),
  getRenderStats: vi.fn(() => ({})),
}))

// Initialize i18n for tests (silences useTranslation warnings)
void i18n.use(initReactI18next).init({
  lng: 'en',
  fallbackLng: 'en',
  resources: {
    en: {
      translation: {
        // Common translations (needed for aria-label tests)
        common: {
          dismiss: 'Dismiss',
          back: 'Back',
          forward: 'Forward',
          options: 'Options',
        },
        // Sidebar labels reused by the AppBar (search / settings)
        sidebar: {
          search: 'Search',
          settings: 'Settings',
          contacts: 'Contacts',
          addContact: 'Add contact',
          blockedUsers: 'Blocked users',
        },
        newMessage: {
          title: 'New message',
          searchPlaceholder: 'Search a person or enter a JID',
          manageContacts: 'Manage contacts',
        },
        contacts: {
          addContact: 'Add contact',
          requestsHeading: 'Requests',
          contact: 'Contact',
          startConversation: 'Start conversation',
          rename: 'Rename',
          about: 'About',
          groups: 'Groups',
          connectedDevices: 'Connected devices',
          securityDetailsTitle: 'Security details',
          noDetails: 'No additional details',
          encryption: {
            glanceVerified: 'Verified and encrypted',
            glanceEncrypted: 'Encrypted, not verified',
            glanceNotEncrypted: 'Not encrypted',
            glanceDisabled: 'Encryption off',
            glanceLocked: 'Encrypted, locked',
            verified: 'Verified',
            tofu: 'Encrypted (not verified)',
            fingerprintLabel: 'OpenPGP fingerprint',
            verifyButton: 'Verify fingerprint',
            // OMEMO device-row label must interpolate the id so per-device rows
            // are distinguishable (deviceLabel is asserted in SecurityTab.omemo.test).
            // The other omemo.* keys are intentionally left out so the test can
            // assert on their literal key strings (loadError/retry).
            omemo: {
              deviceLabel: 'Device {{id}}',
            },
          },
        },
        conversations: {
          backToConversations: 'Back to conversations',
          messageRequestsHeading: 'Message requests',
        },
        rooms: {
          backToRooms: 'Back to rooms',
          invitationsHeading: 'Invitations',
          createQuickChat: 'Create Quick Chat',
          createRoom: 'Create Room',
          quickChat: 'Quick Chat',
          permanentRoom: 'Permanent Room',
          joinRoom: 'Join room',
          browseRooms: 'Browse Rooms',
          catchUpAll: 'Catch up all rooms',
          markAllRead: 'Mark all as read',
          whisperThread: 'Private with {{nick}}',
          whisperCounterpartGone: "{{nick}} is no longer in the room, so you can't reply",
          nickChanged: '{{oldNick}} is now known as {{newNick}}',
        },
        messages: {
          showArchived: 'Show archived conversations',
          showActive: 'Show active conversations',
          archivedTitle: 'Archived',
        },
        settings: {
          decreaseFontSize: 'Decrease font size',
          increaseFontSize: 'Increase font size',
        },
        // Typing indicator translations (needed for ChatView/RoomView tests)
        chat: {
          typing: {
            one: '{{name}} is typing...',
            two: '{{name1}} and {{name2}} are typing...',
            three: '{{name1}}, {{name2}}, and {{name3}} are typing...',
            many: '{{name1}}, {{name2}}, and {{count}} others are typing...',
          },
          // Jump-to-last-read pill (JumpToLastReadPill component tests)
          newMessagesCount: '{{count}} new message',
          newMessagesCount_other: '{{count}} new messages',
          youWereAway: 'You were away',
          copyLink: 'Copy link',
          copyLinkChoose: 'Copy which link?',
          openInBrowser: 'Open in browser',
          copyMessage: 'Copy text',
        },
        // Empty state primary actions (ChatLayout EmptyState tests)
        emptyState: {
          messages: {
            action: 'Start a conversation',
          },
          rooms: {
            action: 'Create a room',
          },
        },
        // Connection status (App auto-reconnect spinner)
        status: {
          reconnecting: 'Reconnecting...',
        },
        // Admin server overview (ServerOverview component tests)
        admin: {
          overview: {
            title: 'Server overview',
            refresh: 'Refresh',
            updatedAt: 'Updated at {{time}}',
            advanced: 'Advanced',
            advancedHint: 'Run a raw server command',
            empty: 'Server statistics are unavailable.',
            retry: 'Retry',
            units: { d: 'd', h: 'h', m: 'm', s: 's' },
            cards: {
              uptime: 'Uptime',
              version: 'Server version',
              users: 'Users',
              onlineSuffix: '{{n}} online',
              onlineSessions: 'Online sessions',
              onlineRooms: 'Active rooms',
              vhosts: 'Virtual hosts',
            },
          },
        },
        // Reaction notification keys
        reactions: {
          mention: "{{emoji}} {{name}} reacted to '{{preview}}'",
          see: 'See',
        },
        // Easter egg replay mention keys (EasterEggMentions component tests)
        easterEgg: {
          mention: '{{name}} sent you an animation',
          replay: 'Replay',
          sentBy: 'Sent by {{name}}',
        },
      },
    },
  },
  interpolation: {
    escapeValue: false,
  },
})

// Mock localStorage for jsdom
const localStorageMock = (() => {
  let store: Record<string, string> = {}
  return {
    getItem: vi.fn((key: string) => store[key] ?? null),
    setItem: vi.fn((key: string, value: string) => {
      store[key] = value
    }),
    removeItem: vi.fn((key: string) => {
      delete store[key]
    }),
    clear: vi.fn(() => {
      store = {}
    }),
    get length() {
      return Object.keys(store).length
    },
    key: vi.fn((index: number) => Object.keys(store)[index] ?? null),
  }
})()

// jsdom-only mocks. A handful of tests opt into the `node` environment
// (e.g. openpgp.js crypto round-trips that fail under jsdom's realm
// boundary) — for those, `window` is undefined and we skip the DOM
// shims entirely.
if (typeof window === 'undefined') {
  // Node-environment tests still touch zustand stores that read from
  // localStorage; provide a minimal in-memory shim on globalThis so
  // they don't crash on `localStorage.getItem` etc.
  ;(globalThis as { localStorage?: Storage }).localStorage = localStorageMock as unknown as Storage
} else {
  Object.defineProperty(window, 'localStorage', {
    value: localStorageMock,
  })

  // Mock ResizeObserver for jsdom (not available in jsdom by default)
  class ResizeObserverMock {
    observe = vi.fn()
    unobserve = vi.fn()
    disconnect = vi.fn()
  }
  globalThis.ResizeObserver = ResizeObserverMock as unknown as typeof ResizeObserver

  // Mock IntersectionObserver for jsdom (used by useViewportObserver)
  class IntersectionObserverMock {
    observe = vi.fn()
    unobserve = vi.fn()
    disconnect = vi.fn()
    constructor(_callback: IntersectionObserverCallback, _options?: IntersectionObserverInit) {}
  }
  globalThis.IntersectionObserver = IntersectionObserverMock as unknown as typeof IntersectionObserver

  // Mock matchMedia for jsdom (not available by default)
  // Returns desktop (non-mobile) by default - tests can override in specific files
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: vi.fn().mockImplementation((query: string) => ({
      matches: false, // Default to desktop/non-mobile
      media: query,
      onchange: null,
      addListener: vi.fn(), // Deprecated
      removeListener: vi.fn(), // Deprecated
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  })
}

// Provide default vanilla store mocks for @fluux/sdk
// Tests that need specific store behavior should override these in their own vi.mock('@fluux/sdk')
vi.mock('@fluux/sdk', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@fluux/sdk')>()
  return {
    ...actual,
    // Vanilla stores with empty getState - tests can override specific stores as needed
    chatStore: {
      getState: () => ({
        conversations: new Map(),
        messages: new Map(),
        activeConversationId: null,
        setActiveConversation: vi.fn(),
        activateConversation: vi.fn().mockResolvedValue(undefined),
        markAsRead: vi.fn(),
        markReadToNewest: vi.fn(),
        clearFirstNewMessageId: vi.fn(),
        isArchived: () => false,
        applyRemoteDisplayed: vi.fn(),
      }),
      subscribe: vi.fn(() => vi.fn()),
    },
    roomStore: {
      getState: () => ({
        rooms: new Map(),
        roomRuntime: new Map(),
        activeRoomJid: null,
        setActiveRoom: vi.fn(),
        activateRoom: vi.fn().mockResolvedValue(undefined),
        markAsRead: vi.fn(),
        markReadToNewest: vi.fn(),
        markAllRoomsRead: vi.fn(),
        clearFirstNewMessageId: vi.fn(),
        getRoom: () => undefined,
        getDraft: () => '',
        setDraft: vi.fn(),
        clearDraft: vi.fn(),
      }),
      subscribe: vi.fn(() => vi.fn()),
    },
    rosterStore: {
      getState: () => ({
        contacts: new Map(),
        getContact: () => undefined,
      }),
      subscribe: vi.fn(() => vi.fn()),
    },
    connectionStore: {
      getState: () => ({
        status: 'disconnected',
        jid: null,
        windowVisible: true,
        webPushEnabled: true,
        webPushServices: [],
        setWindowVisible: vi.fn(),
        setWebPushEnabled: vi.fn(),
      }),
      subscribe: vi.fn(() => vi.fn()),
    },
    consoleStore: {
      getState: () => ({
        entries: [],
        isOpen: false,
        addEvent: vi.fn(),
      }),
      subscribe: vi.fn(() => vi.fn()),
    },
    eventsStore: {
      getState: () => ({
        subscriptionRequests: [],
        strangerMessages: [],
        mucInvitations: [],
        systemNotifications: [],
      }),
      subscribe: vi.fn(() => vi.fn()),
    },
    adminStore: {
      getState: () => ({
        mucServiceJid: null,
      }),
      subscribe: vi.fn(() => vi.fn()),
    },
    blockingStore: {
      getState: () => ({
        blockedJids: [],
        isBlocked: () => false,
      }),
      subscribe: vi.fn(() => vi.fn()),
    },
    ignoreStore: {
      getState: () => ({
        ignoredUsers: {},
        addIgnored: vi.fn(),
        removeIgnored: vi.fn(),
        isIgnored: () => false,
        getIgnoredForRoom: () => [],
        rehydrate: vi.fn(),
      }),
      subscribe: vi.fn(() => vi.fn()),
    },
    useBlocking: vi.fn(() => ({
      blockedJids: [],
      fetchBlocklist: vi.fn(),
      blockJid: vi.fn(),
      unblockJid: vi.fn(),
      unblockAll: vi.fn(),
      isBlocked: () => false,
    })),
    useEvents: vi.fn(() => ({
      subscriptionRequests: [],
      strangerMessages: [],
      strangerConversations: {},
      mucInvitations: [],
      systemNotifications: [],
      pendingCount: 0,
      acceptSubscription: vi.fn(),
      rejectSubscription: vi.fn(),
      acceptStranger: vi.fn(),
      ignoreStranger: vi.fn(),
      acceptInvitation: vi.fn(),
      declineInvitation: vi.fn(),
      dismissNotification: vi.fn(),
    })),
    searchStore: {
      getState: () => ({
        query: '',
        isSearching: false,
        results: [],
        error: null,
        search: vi.fn(),
        clearSearch: vi.fn(),
      }),
      subscribe: vi.fn(() => vi.fn()),
      setState: vi.fn(),
    },
    useSearch: vi.fn(() => ({
      query: '',
      isSearching: false,
      results: [],
      error: null,
      search: vi.fn(),
      clearSearch: vi.fn(),
    })),
    useXMPP: vi.fn(() => ({
      client: {
        profile: {
          fetchVCard: vi.fn().mockResolvedValue(null),
        },
      },
      sendRawXml: vi.fn(),
      onStanza: vi.fn(() => vi.fn()),
      on: vi.fn(() => vi.fn()),
      setPresence: vi.fn(),
      xml: vi.fn(),
      isConnected: () => false,
      getJid: () => null,
    })),
    useRoster: vi.fn(() => ({
      contacts: [],
      sortedContacts: [],
      onlineContacts: [],
      addContact: vi.fn(),
      removeContact: vi.fn(),
      acceptSubscription: vi.fn(),
      rejectSubscription: vi.fn(),
    })),
  }
})

// Provide default vanilla store mocks for @fluux/sdk/stores
vi.mock('@fluux/sdk/stores', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@fluux/sdk/stores')>()
  return {
    ...actual,
    ignoreStore: {
      getState: () => ({
        ignoredUsers: {},
        addIgnored: vi.fn(),
        removeIgnored: vi.fn(),
        isIgnored: () => false,
        getIgnoredForRoom: () => [],
        rehydrate: vi.fn(),
      }),
      subscribe: vi.fn(() => vi.fn()),
    },
  }
})

// Provide default React hook mocks for @fluux/sdk/react
// These hooks return the same data as the vanilla stores but are React-bound
vi.mock('@fluux/sdk/react', () => ({
  // React hook wrappers - return mock functions by default
  // Tests that need specific behavior should override in their own vi.mock
  useChatStore: vi.fn((selector) => {
    const state = {
      conversations: new Map(),
      messages: new Map(),
      activeConversationId: null,
      setActiveConversation: vi.fn(),
      activateConversation: vi.fn().mockResolvedValue(undefined),
      addConversation: vi.fn(),
      markAsRead: vi.fn(),
      clearFirstNewMessageId: vi.fn(),
      isArchived: () => false,
      getMAMQueryState: () => ({ isLoading: false, hasMoreHistory: false }),
    }
    return selector ? selector(state) : state
  }),
  useRoomStore: vi.fn((selector) => {
    const state = {
      rooms: new Map(),
      roomEntities: new Map(),
      roomMeta: new Map(),
      roomRuntime: new Map(),
      drafts: new Map(),
      activeRoomJid: null,
      setActiveRoom: vi.fn(),
      activateRoom: vi.fn().mockResolvedValue(undefined),
      addRoom: vi.fn(),
      markAsRead: vi.fn(),
      clearFirstNewMessageId: vi.fn(),
      setDraft: vi.fn(),
      getDraft: () => '',
      clearDraft: vi.fn(),
      roomsWithUnreadCount: () => 0,
      roomTabIndicator: () => 'none',
      getMAMQueryState: () => ({ isLoading: false, hasMoreHistory: false }),
    }
    return selector ? selector(state) : state
  }),
  useRosterStore: vi.fn((selector) => {
    const state = {
      contacts: new Map(),
      getContact: () => undefined,
      setContacts: vi.fn(),
    }
    return selector ? selector(state) : state
  }),
  useConnectionStore: vi.fn((selector) => {
    const state = {
      status: 'disconnected',
      jid: null,
      windowVisible: true,
      setWindowVisible: vi.fn(),
      setServerInfo: vi.fn(),
      setHttpUploadService: vi.fn(),
      setOwnNickname: vi.fn(),
      updateOwnResource: vi.fn(),
    }
    return selector ? selector(state) : state
  }),
  useConsoleStore: vi.fn((selector) => {
    const state = {
      entries: [],
      isOpen: false,
      addEvent: vi.fn(),
      setOpen: vi.fn(),
    }
    return selector ? selector(state) : state
  }),
  useEventsStore: vi.fn((selector) => {
    const state = {
      subscriptionRequests: [],
      strangerMessages: [],
      mucInvitations: [],
      systemNotifications: [],
    }
    return selector ? selector(state) : state
  }),
  useAdminStore: vi.fn((selector) => {
    const state = {
      mucServiceJid: null,
      setActiveCategory: vi.fn(),
      onlineJids: new Set<string>(),
      lastActivity: new Map(),
      lastActivitySupported: true,
      usersTruncated: false,
    }
    return selector ? selector(state) : state
  }),
  useAdmin: vi.fn(() => ({
    requestLastActivity: vi.fn(),
    fetchAllUsers: vi.fn(),
    usersTruncated: false,
  })),
  useBlockingStore: vi.fn((selector) => {
    const state = {
      blockedJids: [],
    }
    return selector ? selector(state) : state
  }),
  useIgnoreStore: vi.fn((selector) => {
    const state = {
      ignoredUsers: {},
      addIgnored: vi.fn(),
      removeIgnored: vi.fn(),
      isIgnored: () => false,
      getIgnoredForRoom: () => [],
    }
    return selector ? selector(state) : state
  }),
  useSearchStore: vi.fn((selector) => {
    const state = {
      query: '',
      isSearching: false,
      results: [],
      error: null,
      previewResult: null,
      search: vi.fn(),
      clearSearch: vi.fn(),
      setPreviewResult: vi.fn(),
    }
    return selector ? selector(state) : state
  }),
  useContactTime: vi.fn(() => null),
  useLastActivity: vi.fn(),
}))
