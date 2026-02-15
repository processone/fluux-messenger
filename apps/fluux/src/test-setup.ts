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
  getRenderStats: vi.fn(() => ({})),
}))

// Mock react-virtuoso for tests (it requires DOM APIs not available in jsdom)
// Use vi.hoisted() to ensure React is available when the mock factory runs
const { mockVirtuoso } = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const React = require('react')
  return {
    // Use forwardRef to properly accept refs passed from VirtualizedMessageList
    mockVirtuoso: React.forwardRef(({ data, itemContent, components }: {
      data: unknown[]
      itemContent: (index: number, item: unknown) => React.ReactNode
      components?: { Footer?: React.ComponentType }
    }, _ref: React.Ref<unknown>) => {
      const Footer = components?.Footer
      return React.createElement(
        'div',
        { 'data-testid': 'virtuoso-list' },
        data.map((item: unknown, index: number) =>
          React.createElement('div', { key: index }, itemContent(index, item))
        ),
        Footer && React.createElement(Footer)
      )
    }),
  }
})

vi.mock('react-virtuoso', () => ({
  Virtuoso: mockVirtuoso,
}))

// Initialize i18n for tests (silences useTranslation warnings)
i18n.use(initReactI18next).init({
  lng: 'en',
  fallbackLng: 'en',
  resources: {
    en: {
      translation: {
        // Typing indicator translations (needed for ChatView/RoomView tests)
        chat: {
          typing: {
            one: '{{name}} is typing...',
            two: '{{name1}} and {{name2}} are typing...',
            three: '{{name1}}, {{name2}}, and {{name3}} are typing...',
            many: '{{name1}}, {{name2}}, and {{count}} others are typing...',
          },
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
        markAsRead: vi.fn(),
        clearFirstNewMessageId: vi.fn(),
        isArchived: () => false,
      }),
      subscribe: vi.fn(() => vi.fn()),
    },
    roomStore: {
      getState: () => ({
        rooms: new Map(),
        activeRoomJid: null,
        setActiveRoom: vi.fn(),
        markAsRead: vi.fn(),
        clearFirstNewMessageId: vi.fn(),
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
        setWindowVisible: vi.fn(),
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
      activeRoomJid: null,
      setActiveRoom: vi.fn(),
      addRoom: vi.fn(),
      markAsRead: vi.fn(),
      clearFirstNewMessageId: vi.fn(),
      roomsWithUnreadCount: () => 0,
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
    }
    return selector ? selector(state) : state
  }),
  useBlockingStore: vi.fn((selector) => {
    const state = {
      blockedJids: [],
    }
    return selector ? selector(state) : state
  }),
}))

