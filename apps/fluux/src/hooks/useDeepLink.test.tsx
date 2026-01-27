import { describe, expect, test, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, act, waitFor } from '@testing-library/react'
import { MemoryRouter, useLocation } from 'react-router-dom'
import type { ReactNode } from 'react'

// Mock the SDK hooks
const mockSetActiveConversation = vi.fn()
const mockAddConversation = vi.fn()
const mockSetActiveRoom = vi.fn()
const mockJoinRoom = vi.fn()
const mockHasConversation = vi.fn()

vi.mock('@fluux/sdk', () => ({
  // Vanilla stores (for imperative .getState() access)
  chatStore: {
    getState: () => ({
      hasConversation: mockHasConversation,
    }),
  },
  useChat: () => ({
    setActiveConversation: mockSetActiveConversation,
    addConversation: mockAddConversation,
  }),
  useRoom: () => ({
    setActiveRoom: mockSetActiveRoom,
    joinRoom: mockJoinRoom,
  }),
  useRoster: () => ({
    contacts: [
      { jid: 'alice@example.org', name: 'Alice' },
      { jid: 'bob@example.org', name: 'Bob' },
    ],
  }),
  // URI utilities moved from app to SDK
  parseXmppUri: (uri: string) => {
    if (!uri || !uri.startsWith('xmpp:')) return null
    const withoutScheme = uri.slice(5)
    const queryIndex = withoutScheme.indexOf('?')
    const jid = queryIndex >= 0 ? withoutScheme.slice(0, queryIndex) : withoutScheme
    const queryString = queryIndex >= 0 ? withoutScheme.slice(queryIndex + 1) : ''
    // XMPP URIs use semicolons as separators: ?action;param=value;param2=value2
    const params: Record<string, string> = {}
    let action: string | undefined
    if (queryString) {
      const parts = queryString.split(';')
      action = parts[0] || undefined
      for (let i = 1; i < parts.length; i++) {
        const [key, value] = parts[i].split('=')
        if (key) params[key] = value || ''
      }
    }
    return { jid: decodeURIComponent(jid), action, params }
  },
  isMucJid: (jid: string) => {
    if (!jid) return false
    const domain = jid.split('@')[1]?.toLowerCase() || ''
    return domain.includes('conference') || domain.includes('muc') || domain.includes('room')
  },
  getBareJid: (fullJid: string) => {
    if (!fullJid) return ''
    const slashIndex = fullJid.indexOf('/')
    return slashIndex >= 0 ? fullJid.substring(0, slashIndex) : fullJid
  },
  getLocalPart: (jid: string) => {
    if (!jid) return ''
    const bareJid = jid.indexOf('/') >= 0 ? jid.substring(0, jid.indexOf('/')) : jid
    const atIndex = bareJid.indexOf('@')
    return atIndex >= 0 ? bareJid.substring(0, atIndex) : bareJid
  },
}))

// Mock React store hooks (from @fluux/sdk/react)
vi.mock('@fluux/sdk/react', () => ({
  useChatStore: (selector: (state: unknown) => unknown) => {
    const state = {
      setActiveConversation: mockSetActiveConversation,
      hasConversation: mockHasConversation,
    }
    return selector(state)
  },
  useRoomStore: (selector: (state: unknown) => unknown) => {
    const state = {
      setActiveRoom: mockSetActiveRoom,
    }
    return selector(state)
  },
  useConnectionStore: (selector: (state: { jid: string }) => string) => {
    return selector({ jid: 'testuser@example.org' })
  },
}))

// Mock the deep-link plugin
const mockOnOpenUrl = vi.fn()
const mockGetCurrent = vi.fn()
const mockUnlisten = vi.fn()

vi.mock('@tauri-apps/plugin-deep-link', () => ({
  onOpenUrl: (callback: (urls: string[]) => void) => {
    mockOnOpenUrl(callback)
    return Promise.resolve(mockUnlisten)
  },
  getCurrent: () => mockGetCurrent(),
}))

// Mock the notification plugin to prevent errors from clearAllNotifications
vi.mock('@tauri-apps/plugin-notification', () => ({
  removeAllActive: vi.fn().mockResolvedValue(undefined),
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

describe('useDeepLink', () => {
  let useDeepLink: typeof import('./useDeepLink').useDeepLink

  // Suppress expected console.warn from clearAllNotifications in test environment
  const originalWarn = console.warn

  beforeEach(() => {
    vi.clearAllMocks()
    mockHasConversation.mockReturnValue(false)
    mockGetCurrent.mockResolvedValue([])
    mockJoinRoom.mockResolvedValue(undefined)
    currentLocation = { pathname: '/', search: '' }
    // Suppress "[Navigation] Failed to clear notifications" warnings in tests
    console.warn = vi.fn()
  })

  afterEach(() => {
    vi.resetModules()
    console.warn = originalWarn
  })

  describe('in non-Tauri environment', () => {
    beforeEach(async () => {
      // Ensure __TAURI_INTERNALS__ is not present
      delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__
      vi.resetModules()
      const module = await import('./useDeepLink')
      useDeepLink = module.useDeepLink
    })

    test('does not set up deep link listener', () => {
      renderHook(() => useDeepLink(), {
        wrapper: createWrapper('/messages'),
      })

      expect(mockOnOpenUrl).not.toHaveBeenCalled()
      expect(mockGetCurrent).not.toHaveBeenCalled()
    })
  })

  describe('in Tauri environment', () => {
    beforeEach(async () => {
      // Simulate Tauri environment
      ;(window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {}
      vi.resetModules()
      const module = await import('./useDeepLink')
      useDeepLink = module.useDeepLink
    })

    afterEach(() => {
      delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__
    })

    test('sets up deep link listener on mount', async () => {
      renderHook(() => useDeepLink(), {
        wrapper: createWrapper('/messages'),
      })

      await waitFor(() => {
        expect(mockOnOpenUrl).toHaveBeenCalled()
        expect(mockGetCurrent).toHaveBeenCalled()
      })
    })

    test('cleans up listener on unmount', async () => {
      const { unmount } = renderHook(() => useDeepLink(), {
        wrapper: createWrapper('/messages'),
      })

      await waitFor(() => {
        expect(mockOnOpenUrl).toHaveBeenCalled()
      })

      unmount()

      expect(mockUnlisten).toHaveBeenCalled()
    })

    test('handles initial URIs on cold start', async () => {
      mockGetCurrent.mockResolvedValue(['xmpp:alice@example.org?message'])

      renderHook(() => useDeepLink(), {
        wrapper: createWrapper('/messages'),
      })

      await waitFor(() => {
        // Should navigate to messages URL
        expect(currentLocation.pathname).toBe('/messages/alice%40example.org')
        expect(mockSetActiveConversation).toHaveBeenCalledWith('alice@example.org')
      })
    })

    test('opens 1:1 conversation for chat URI', async () => {
      let urlCallback: ((urls: string[]) => void) | undefined
      mockOnOpenUrl.mockImplementation((cb) => {
        urlCallback = cb
        return Promise.resolve(mockUnlisten)
      })

      renderHook(() => useDeepLink(), {
        wrapper: createWrapper('/messages'),
      })

      await waitFor(() => {
        expect(urlCallback).toBeDefined()
      })

      await act(async () => {
        urlCallback!(['xmpp:bob@example.org'])
      })

      expect(currentLocation.pathname).toBe('/messages/bob%40example.org')
      expect(mockSetActiveConversation).toHaveBeenCalledWith('bob@example.org')
    })

    test('creates new conversation if it does not exist', async () => {
      mockHasConversation.mockReturnValue(false)

      let urlCallback: ((urls: string[]) => void) | undefined
      mockOnOpenUrl.mockImplementation((cb) => {
        urlCallback = cb
        return Promise.resolve(mockUnlisten)
      })

      renderHook(() => useDeepLink(), {
        wrapper: createWrapper('/messages'),
      })

      await waitFor(() => {
        expect(urlCallback).toBeDefined()
      })

      await act(async () => {
        urlCallback!(['xmpp:alice@example.org'])
      })

      expect(mockAddConversation).toHaveBeenCalledWith({
        id: 'alice@example.org',
        name: 'Alice', // From roster
        type: 'chat',
        unreadCount: 0,
      })
    })

    test('uses JID local part as name for unknown contacts', async () => {
      mockHasConversation.mockReturnValue(false)

      let urlCallback: ((urls: string[]) => void) | undefined
      mockOnOpenUrl.mockImplementation((cb) => {
        urlCallback = cb
        return Promise.resolve(mockUnlisten)
      })

      renderHook(() => useDeepLink(), {
        wrapper: createWrapper('/messages'),
      })

      await waitFor(() => {
        expect(urlCallback).toBeDefined()
      })

      await act(async () => {
        urlCallback!(['xmpp:stranger@foreign.org'])
      })

      expect(mockAddConversation).toHaveBeenCalledWith({
        id: 'stranger@foreign.org',
        name: 'stranger', // Local part of JID
        type: 'chat',
        unreadCount: 0,
      })
    })

    test('does not create conversation if it already exists', async () => {
      mockHasConversation.mockReturnValue(true)

      let urlCallback: ((urls: string[]) => void) | undefined
      mockOnOpenUrl.mockImplementation((cb) => {
        urlCallback = cb
        return Promise.resolve(mockUnlisten)
      })

      renderHook(() => useDeepLink(), {
        wrapper: createWrapper('/messages'),
      })

      await waitFor(() => {
        expect(urlCallback).toBeDefined()
      })

      await act(async () => {
        urlCallback!(['xmpp:alice@example.org'])
      })

      expect(mockAddConversation).not.toHaveBeenCalled()
      expect(mockSetActiveConversation).toHaveBeenCalledWith('alice@example.org')
    })

    test('joins MUC room for join action', async () => {
      let urlCallback: ((urls: string[]) => void) | undefined
      mockOnOpenUrl.mockImplementation((cb) => {
        urlCallback = cb
        return Promise.resolve(mockUnlisten)
      })

      renderHook(() => useDeepLink(), {
        wrapper: createWrapper('/messages'),
      })

      await waitFor(() => {
        expect(urlCallback).toBeDefined()
      })

      await act(async () => {
        urlCallback!(['xmpp:room@conference.example.org?join'])
      })

      expect(mockJoinRoom).toHaveBeenCalledWith(
        'room@conference.example.org',
        'testuser', // Default nick from own JID
        undefined
      )
      // Should navigate to rooms URL
      expect(currentLocation.pathname).toBe('/rooms/room%40conference.example.org')
      expect(mockSetActiveRoom).toHaveBeenCalledWith('room@conference.example.org')
    })

    test('joins MUC room with custom nickname', async () => {
      let urlCallback: ((urls: string[]) => void) | undefined
      mockOnOpenUrl.mockImplementation((cb) => {
        urlCallback = cb
        return Promise.resolve(mockUnlisten)
      })

      renderHook(() => useDeepLink(), {
        wrapper: createWrapper('/messages'),
      })

      await waitFor(() => {
        expect(urlCallback).toBeDefined()
      })

      await act(async () => {
        urlCallback!(['xmpp:room@conference.example.org?join;nick=mynick'])
      })

      expect(mockJoinRoom).toHaveBeenCalledWith(
        'room@conference.example.org',
        'mynick',
        undefined
      )
    })

    test('joins MUC room with password', async () => {
      let urlCallback: ((urls: string[]) => void) | undefined
      mockOnOpenUrl.mockImplementation((cb) => {
        urlCallback = cb
        return Promise.resolve(mockUnlisten)
      })

      renderHook(() => useDeepLink(), {
        wrapper: createWrapper('/messages'),
      })

      await waitFor(() => {
        expect(urlCallback).toBeDefined()
      })

      await act(async () => {
        urlCallback!(['xmpp:room@conference.example.org?join;password=secret'])
      })

      expect(mockJoinRoom).toHaveBeenCalledWith(
        'room@conference.example.org',
        'testuser',
        { password: 'secret' }
      )
    })

    test('detects MUC by JID pattern even without join action', async () => {
      let urlCallback: ((urls: string[]) => void) | undefined
      mockOnOpenUrl.mockImplementation((cb) => {
        urlCallback = cb
        return Promise.resolve(mockUnlisten)
      })

      renderHook(() => useDeepLink(), {
        wrapper: createWrapper('/messages'),
      })

      await waitFor(() => {
        expect(urlCallback).toBeDefined()
      })

      // No ?join action, but domain starts with conference.
      await act(async () => {
        urlCallback!(['xmpp:room@conference.example.org'])
      })

      expect(mockJoinRoom).toHaveBeenCalled()
      // Should navigate to rooms URL
      expect(currentLocation.pathname).toBe('/rooms/room%40conference.example.org')
    })

    test('ignores invalid XMPP URIs', async () => {
      let urlCallback: ((urls: string[]) => void) | undefined
      mockOnOpenUrl.mockImplementation((cb) => {
        urlCallback = cb
        return Promise.resolve(mockUnlisten)
      })

      renderHook(() => useDeepLink(), {
        wrapper: createWrapper('/messages'),
      })

      await waitFor(() => {
        expect(urlCallback).toBeDefined()
      })

      await act(async () => {
        urlCallback!(['http://example.com', 'invalid'])
      })

      expect(mockSetActiveConversation).not.toHaveBeenCalled()
      expect(mockJoinRoom).not.toHaveBeenCalled()
    })

    test('handles multiple URIs in sequence', async () => {
      let urlCallback: ((urls: string[]) => void) | undefined
      mockOnOpenUrl.mockImplementation((cb) => {
        urlCallback = cb
        return Promise.resolve(mockUnlisten)
      })

      renderHook(() => useDeepLink(), {
        wrapper: createWrapper('/messages'),
      })

      await waitFor(() => {
        expect(urlCallback).toBeDefined()
      })

      await act(async () => {
        urlCallback!(['xmpp:alice@example.org', 'xmpp:bob@example.org'])
      })

      // Both should be processed
      expect(mockSetActiveConversation).toHaveBeenCalledTimes(2)
      expect(mockSetActiveConversation).toHaveBeenNthCalledWith(1, 'alice@example.org')
      expect(mockSetActiveConversation).toHaveBeenNthCalledWith(2, 'bob@example.org')
    })

    test('strips resource from JID', async () => {
      let urlCallback: ((urls: string[]) => void) | undefined
      mockOnOpenUrl.mockImplementation((cb) => {
        urlCallback = cb
        return Promise.resolve(mockUnlisten)
      })

      renderHook(() => useDeepLink(), {
        wrapper: createWrapper('/messages'),
      })

      await waitFor(() => {
        expect(urlCallback).toBeDefined()
      })

      await act(async () => {
        urlCallback!(['xmpp:alice@example.org/resource'])
      })

      expect(mockSetActiveConversation).toHaveBeenCalledWith('alice@example.org')
    })
  })
})
