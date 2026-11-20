import { describe, expect, test, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, act, waitFor } from '@testing-library/react'
import { MemoryRouter, useLocation } from 'react-router'
import { useEffect, type ReactNode } from 'react'

// Mock the SDK hooks
// Activation goes through the hydrating store actions (activateConversation/activateRoom)
const mockActivateConversation = vi.fn()
const mockAddConversation = vi.fn()
const mockActivateRoom = vi.fn()
const mockJoinRoom = vi.fn()
const mockJoinResult = vi.fn()
const mockHasConversation = vi.fn()
const mockOpenRoomMessageLink = vi.fn()
const mockDomainHostsRooms = vi.fn()
const mockAddRoom = vi.fn()
// Drafts the stores hold, by conversation
const chatDrafts = new Map<string, string>()
const roomDrafts = new Map<string, string>()
const contactList = [
  { jid: 'alice@example.org', name: 'Alice', subscription: 'both' },
  { jid: 'bob@example.org', name: 'Bob', subscription: 'none' },
]
vi.mock('./useRoomMessageLink', () => ({ useRoomMessageLink: () => mockOpenRoomMessageLink }))
const shortcutState = { jid: 'testuser@example.org/phone' as string | null, rosterAccount: 'testuser@example.org', loaded: true, bookmarks: true }
// Status the chat view sees; 'online' lets queued links replay.
const connectionState = { status: 'online' }

const { RoomJoinError } = vi.hoisted(() => {
  // Mirrors the SDK's own condition-to-reason resolution. Kept local because
  // these suites mock the SDK barrel wholesale rather than importing it.
  const REASONS: Record<string, string> = {
    conflict: 'nickname-taken',
    'registration-required': 'members-only',
    forbidden: 'banned',
    'service-unavailable': 'room-full',
    'not-acceptable': 'registered-nickname-required',
    'item-not-found': 'room-not-found',
    timeout: 'timed-out',
  }

  class RoomJoinError extends Error {
    readonly reason: string
    constructor(
      public roomJid: string,
      public condition: string,
      public errorType?: string,
      public text?: string,
      options?: { passwordSent?: boolean },
    ) {
      super(text || `Room join failed: ${condition}`)
      this.name = 'RoomJoinError'
      this.reason =
        condition === 'not-authorized'
          ? options?.passwordSent ? 'wrong-password' : 'password-required'
          : REASONS[condition] ?? 'unknown'
    }
  }
  return { RoomJoinError }
})

vi.mock('@fluux/sdk', async importOriginal => ({
  ...await importOriginal<typeof import('@fluux/sdk')>(),
  connectionStore: { getState: () => ({ jid: shortcutState.jid }) },
  rosterStore: { getState: () => ({ accountJid: shortcutState.rosterAccount, isLoaded: shortcutState.loaded }) },
  // Rooms arrive with the bookmarks.
  roomStore: {
    getState: () => ({
      rooms: shortcutState.bookmarks ? new Map([['team@example.org', {}]]) : new Map(),
      bookmarksLoaded: shortcutState.bookmarks,
      addRoom: mockAddRoom,
      getDraft: (id: string) => roomDrafts.get(id) ?? '',
      setDraft: (id: string, text: string) => { roomDrafts.set(id, text) },
      clearDraft: (id: string) => { roomDrafts.delete(id) },
    }),
  },
  // Vanilla stores (for imperative .getState() access)
  chatStore: {
    getState: () => ({
      conversations: new Map([['alice@example.org', {}]]),
      hasConversation: mockHasConversation,
      getDraft: (id: string) => chatDrafts.get(id) ?? '',
      setDraft: (id: string, text: string) => { chatDrafts.set(id, text) },
      clearDraft: (id: string) => { chatDrafts.delete(id) },
    }),
  },
  useChat: () => ({
    addConversation: mockAddConversation,
  }),
  useRoom: () => ({
    joinRoom: mockJoinRoom,
    joinResult: mockJoinResult,
    getRoomInfo: () => Promise.resolve(null),
    isNonAnonymousRoomAcknowledged: () => false,
    domainHostsRooms: mockDomainHostsRooms,
  }),
  useRoster: () => ({
    contacts: contactList,
  }),
  RoomJoinError,
}))

// Mock React store hooks (from @fluux/sdk/react)
vi.mock('@fluux/sdk/react', () => ({
  useChatStore: (selector: (state: unknown) => unknown) => {
    const state = {
      activateConversation: mockActivateConversation,
      hasConversation: mockHasConversation,
    }
    return selector(state)
  },
  useRoomStore: (selector: (state: unknown) => unknown) => {
    const state = {
      activateRoom: mockActivateRoom,
      bookmarksLoaded: shortcutState.bookmarks,
    }
    return selector(state)
  },
  useConnectionStore: (selector: (state: { jid: string | null; status: string }) => string) => {
    return selector({ jid: shortcutState.jid, status: connectionState.status })
  },
  useRosterStore: (selector: (state: { accountJid: string; isLoaded: boolean }) => unknown) => {
    return selector({ accountJid: shortcutState.rosterAccount, isLoaded: shortcutState.loaded })
  },
  useContactTime: () => null, useLastActivity: vi.fn(),
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

// Mock the dismissal helper (useNavigateToTarget calls it on navigation)
vi.mock('@/utils/dismissNotification', () => ({ dismissNotification: vi.fn() }))

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

describe('useDeepLink', () => {
  let useDeepLink: typeof import('./useDeepLink').useDeepLink

  beforeEach(() => {
    vi.clearAllMocks()
    shortcutState.jid = 'testuser@example.org/phone'
    shortcutState.rosterAccount = 'testuser@example.org'
    shortcutState.loaded = true
    shortcutState.bookmarks = true
    mockHasConversation.mockReturnValue(false)
    mockDomainHostsRooms.mockResolvedValue(null)
    chatDrafts.clear()
    roomDrafts.clear()
    connectionState.status = 'online'
    mockGetCurrent.mockResolvedValue([])
    mockJoinRoom.mockResolvedValue(undefined)
    mockJoinResult.mockResolvedValue(undefined)
    currentLocation.current = { pathname: '/', search: '' }
  })

  afterEach(() => {
    vi.resetModules()
  })

  describe('in non-Tauri environment', () => {
    beforeEach(async () => {
      // Ensure __TAURI_INTERNALS__ is not present
      delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__
      vi.resetModules()
      const module = await import('./useDeepLink')
      useDeepLink = module.useDeepLink
    })

    test('routes in-chat room message links on web without joining or a system handler', async () => {
      const { routeDeepLink } = await import('@/utils/deepLinkRouter')
      renderHook(() => useDeepLink(), { wrapper: createWrapper('/messages') })
      await act(async () => routeDeepLink('xmpp:team@example.org?join;msg=1731490000123456'))
      expect(mockOpenRoomMessageLink).toHaveBeenCalledWith({ roomJid: 'team@example.org', stanzaId: '1731490000123456' })
      expect(mockJoinRoom).not.toHaveBeenCalled()
      expect(mockOnOpenUrl).not.toHaveBeenCalled()
    })

    test('does not turn a malformed message target into an automatic join', async () => {
      const { routeDeepLink } = await import('@/utils/deepLinkRouter')
      renderHook(() => useDeepLink(), { wrapper: createWrapper('/messages') })
      await act(async () => routeDeepLink('xmpp:team@example.org?join;msg='))
      expect(mockOpenRoomMessageLink).not.toHaveBeenCalled()
      expect(mockJoinRoom).not.toHaveBeenCalled()
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

    test.each([
      ['testuser@example.org', 'chat', 'alice@example.org', '/messages/alice%40example.org'],
      ['testuser@example.org', 'groupchat', 'team@example.org', '/rooms/team%40example.org'],
      ['old@example.org', 'chat', 'alice@example.org', '/messages'],
      ['testuser@example.org', 'chat', 'removed@example.org', '/messages'],
      ['testuser@example.org', 'groupchat', 'removed@example.org', '/messages'],
    ])('routes shortcut %s %s %s without creating or joining', async (account, kind, id, path) => {
      mockGetCurrent.mockResolvedValue([`net.processone.fluux://shortcut?account=${account}&kind=${kind}&id=${id}`])
      renderHook(() => useDeepLink(), { wrapper: createWrapper('/contacts') })
      await waitFor(() => expect(currentLocation.current.pathname).toBe(path))
      expect(mockAddConversation).not.toHaveBeenCalled()
      expect(mockJoinRoom).not.toHaveBeenCalled()
      if (path === '/messages') {
        expect(mockActivateConversation).not.toHaveBeenCalled()
        expect(mockActivateRoom).not.toHaveBeenCalled()
      }
    })

    test('revalidates the live account for a warm shortcut event', async () => {
      const { rerender } = renderHook(() => useDeepLink(), { wrapper: createWrapper('/contacts') })
      await waitFor(() => expect(mockOnOpenUrl).toHaveBeenCalled())
      shortcutState.jid = 'other@example.org/phone'
      rerender()
      await act(async () => mockOnOpenUrl.mock.calls[0][0](['net.processone.fluux://shortcut?account=testuser@example.org&kind=chat&id=alice@example.org']))
      // The stores still hold the previous account's roster: the link waits for the live one.
      expect(currentLocation.current.pathname).toBe('/contacts')

      shortcutState.rosterAccount = 'other@example.org'
      rerender()
      await waitFor(() => expect(currentLocation.current.pathname).toBe('/messages'))
      expect(mockActivateConversation).not.toHaveBeenCalled()
      expect(mockJoinRoom).not.toHaveBeenCalled()
    })

    test('opens a suggestion tapped at launch once the account roster loads after the session is online', async () => {
      // Source: FLM-379. Tapping the Siri suggestion "Envoyer un message à Babette"
      // on a closed app showed the conversation list: the startup reconnect was
      // online before the account's roster loaded, so the shortcut was refused.
      const { routeDeepLink, setStartupLoginHandler } = await import('@/utils/deepLinkRouter')
      connectionState.status = 'connecting'
      shortcutState.rosterAccount = 'testuser@example.org'
      shortcutState.loaded = false
      // A chat does not wait for the bookmarks, which load after the roster.
      shortcutState.bookmarks = false
      setStartupLoginHandler(() => {})
      const { rerender } = renderHook(() => useDeepLink(), { wrapper: createWrapper('/messages/bob%40example.org') })
      await waitFor(() => expect(mockOnOpenUrl).toHaveBeenCalled())
      routeDeepLink('net.processone.fluux://shortcut?account=testuser@example.org&kind=chat&id=alice@example.org')

      setStartupLoginHandler(null)
      connectionState.status = 'online'
      rerender()
      await act(async () => {})
      expect(currentLocation.current.pathname).toBe('/messages/bob%40example.org')

      shortcutState.loaded = true
      rerender()
      await waitFor(() => expect(currentLocation.current.pathname).toBe('/messages/alice%40example.org'))
      expect(mockActivateConversation).toHaveBeenCalledWith('alice@example.org')
    })

    test('opens a room suggestion tapped at launch once the account bookmarks load after its roster', async () => {
      // Source: the room counterpart of FLM-379. Tapping a room's Siri suggestion
      // on a closed app showed the conversation list: the link was checked once
      // the roster had loaded, before the bookmarks brought the room.
      const { routeDeepLink, setStartupLoginHandler } = await import('@/utils/deepLinkRouter')
      connectionState.status = 'connecting'
      shortcutState.loaded = false
      shortcutState.bookmarks = false
      setStartupLoginHandler(() => {})
      const { rerender } = renderHook(() => useDeepLink(), { wrapper: createWrapper('/messages/bob%40example.org') })
      await waitFor(() => expect(mockOnOpenUrl).toHaveBeenCalled())
      routeDeepLink('net.processone.fluux://shortcut?account=testuser@example.org&kind=groupchat&id=team@example.org')

      setStartupLoginHandler(null)
      connectionState.status = 'online'
      shortcutState.loaded = true
      rerender()
      await act(async () => {})
      expect(currentLocation.current.pathname).toBe('/messages/bob%40example.org')

      shortcutState.bookmarks = true
      rerender()
      await waitFor(() => expect(currentLocation.current.pathname).toBe('/rooms/team%40example.org'))
      expect(mockActivateRoom).toHaveBeenCalledWith('team@example.org')
      expect(mockJoinRoom).not.toHaveBeenCalled()
    })

    test('keeps a launch message id until the connected view handles it', async () => {
      mockGetCurrent.mockResolvedValue(['xmpp:team@example.org?join;msg=1731490000123456'])
      connectionState.status = 'connecting'
      const { rerender } = renderHook(() => useDeepLink(), { wrapper: createWrapper('/messages') })
      await waitFor(() => expect(mockGetCurrent).toHaveBeenCalled())
      await act(async () => {})
      expect(mockOpenRoomMessageLink).not.toHaveBeenCalled()
      connectionState.status = 'online'
      rerender()
      await waitFor(() => expect(mockOpenRoomMessageLink).toHaveBeenCalledWith({ roomJid: 'team@example.org', stanzaId: '1731490000123456' }))
      expect(mockJoinRoom).not.toHaveBeenCalled()
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

    test('stops routing links to the chat view once it unmounts (the app-wide listener stays)', async () => {
      let urlCallback: ((urls: string[]) => void) | undefined
      mockOnOpenUrl.mockImplementation((cb) => {
        urlCallback = cb
        return Promise.resolve(mockUnlisten)
      })
      const { unmount } = renderHook(() => useDeepLink(), {
        wrapper: createWrapper('/messages'),
      })
      await waitFor(() => expect(urlCallback).toBeDefined())

      unmount()
      await act(async () => urlCallback!(['xmpp:alice@example.org?message']))

      // The router keeps its one listener for the whole app; the unmounted
      // view is simply no longer a destination.
      expect(mockUnlisten).not.toHaveBeenCalled()
      expect(mockActivateConversation).not.toHaveBeenCalled()
      expect(currentLocation.current.pathname).toBe('/messages')
    })

    test('replays a link queued before the app was online once it is online', async () => {
      // Source: the reopen fix (FLM-14) shows the chat view while the startup
      // reconnect is still pending; a room link received then must wait.
      const { routeDeepLink, setStartupLoginHandler } = await import('@/utils/deepLinkRouter')
      connectionState.status = 'connecting'
      setStartupLoginHandler(() => {})
      const { rerender } = renderHook(() => useDeepLink(), { wrapper: createWrapper('/messages') })
      await waitFor(() => expect(mockOnOpenUrl).toHaveBeenCalled())

      routeDeepLink('xmpp:team@example.org?join')
      await act(async () => {})
      expect(mockJoinRoom).not.toHaveBeenCalled()

      setStartupLoginHandler(null)
      connectionState.status = 'online'
      rerender()
      await waitFor(() => expect(mockJoinRoom).toHaveBeenCalledTimes(1))
      expect(currentLocation.current.pathname).toBe('/rooms/team%40example.org')
    })

    test('handles initial URIs on cold start', async () => {
      mockGetCurrent.mockResolvedValue(['xmpp:alice@example.org?message'])

      renderHook(() => useDeepLink(), {
        wrapper: createWrapper('/messages'),
      })

      await waitFor(() => {
        // Should navigate to messages URL
        expect(currentLocation.current.pathname).toBe('/messages/alice%40example.org')
        expect(mockActivateConversation).toHaveBeenCalledWith('alice@example.org')
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

      expect(currentLocation.current.pathname).toBe('/messages/bob%40example.org')
      expect(mockActivateConversation).toHaveBeenCalledWith('bob@example.org')
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
      expect(mockActivateConversation).toHaveBeenCalledWith('alice@example.org')
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
      expect(currentLocation.current.pathname).toBe('/rooms/room%40conference.example.org')
      expect(mockActivateRoom).toHaveBeenCalledWith('room@conference.example.org')
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
      expect(currentLocation.current.pathname).toBe('/rooms/room%40conference.example.org')
    })

    test('toasts and still navigates when the join fails', async () => {
      const { useToastStore } = await import('@/stores/toastStore')
      useToastStore.setState({ toasts: [] })
      mockJoinRoom.mockResolvedValue(undefined)
      mockJoinResult.mockRejectedValue(new RoomJoinError('room@conference.example.org', 'forbidden'))

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

      // An error toast was surfaced...
      await waitFor(() => {
        expect(useToastStore.getState().toasts.some((t) => t.type === 'error')).toBe(true)
      })
      // ...and navigation still happened (navigate regardless of join outcome).
      await waitFor(() => {
        expect(currentLocation.current.pathname).toBe('/rooms/room%40conference.example.org')
      })
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

      expect(mockActivateConversation).not.toHaveBeenCalled()
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
      expect(mockActivateConversation).toHaveBeenCalledTimes(2)
      expect(mockActivateConversation).toHaveBeenNthCalledWith(1, 'alice@example.org')
      expect(mockActivateConversation).toHaveBeenNthCalledWith(2, 'bob@example.org')
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

      expect(mockActivateConversation).toHaveBeenCalledWith('alice@example.org')
    })

    describe('link actions', () => {
      // Modules reset between tests, so read the store the hook itself uses.
      const modal = async () => (await import('@/stores/modalStore')).useModalStore.getState()
      const openLink = async (uri: string) => {
        let urlCallback: ((urls: string[]) => void) | undefined
        mockOnOpenUrl.mockImplementation((cb) => { urlCallback = cb; return Promise.resolve(mockUnlisten) })
        renderHook(() => useDeepLink(), { wrapper: createWrapper('/messages') })
        await waitFor(() => { expect(urlCallback).toBeDefined() })
        await act(async () => { urlCallback!([uri]) })
      }

      test('subscribe for someone who is not a contact opens Add contact with the address and sends nothing', async () => {
        await openLink('xmpp:carol@example.org?subscribe')
        expect((await modal()).addContact).toBe(true)
        expect((await modal()).addContactJid).toBe('carol@example.org')
        expect(mockActivateConversation).toHaveBeenCalledWith(null)
        expect(currentLocation.current.pathname).toBe('/contacts')
        expect(mockJoinRoom).not.toHaveBeenCalled()
      })

      test('subscribe for a contact that is not subscribed to yet still opens Add contact', async () => {
        await openLink('xmpp:bob@example.org?subscribe')
        expect((await modal()).addContactJid).toBe('bob@example.org')
      })

      test('subscribe for a contact whose presence you receive opens their chat', async () => {
        await openLink('xmpp:alice@example.org?subscribe')
        expect((await modal()).addContact).toBe(false)
        expect(mockActivateConversation).toHaveBeenCalledWith('alice@example.org')
      })

      test('subscribe to your own address does nothing', async () => {
        await openLink('xmpp:testuser@example.org?subscribe')
        expect((await modal()).addContact).toBe(false)
        expect(mockActivateConversation).not.toHaveBeenCalled()
      })

      test('subscribe waits for the app to be online', async () => {
        connectionState.status = 'connecting'
        await openLink('xmpp:carol@example.org?subscribe')
        expect((await modal()).addContact).toBe(false)
      })

      test('message to a room that is not joined opens it without joining and keeps the text as its draft', async () => {
        mockDomainHostsRooms.mockResolvedValue(true)
        await openLink('xmpp:new@groups.example.com?message;body=Hello%20there')
        expect(mockJoinRoom).not.toHaveBeenCalled()
        expect(mockAddRoom).toHaveBeenCalledWith(expect.objectContaining({ jid: 'new@groups.example.com', joined: false }))
        expect(mockActivateRoom).toHaveBeenCalledWith('new@groups.example.com')
        expect(roomDrafts.get('new@groups.example.com')).toBe('Hello there')
      })

      test('message to a bookmarked room opens it without joining', async () => {
        await openLink('xmpp:team@example.org?message')
        expect(mockJoinRoom).not.toHaveBeenCalled()
        expect(mockActivateRoom).toHaveBeenCalledWith('team@example.org')
        expect(mockDomainHostsRooms).not.toHaveBeenCalled()
      })

      test('an address on a server that answers as a plain server opens a chat even when named like a room', async () => {
        mockDomainHostsRooms.mockResolvedValue(false)
        await openLink('xmpp:dave@chat.example.com?message')
        expect(mockDomainHostsRooms).toHaveBeenCalledWith('chat.example.com')
        expect(mockJoinRoom).not.toHaveBeenCalled()
        expect(mockActivateConversation).toHaveBeenCalledWith('dave@chat.example.com')
      })

      test('an address on a room service opens the room even without a room-like name', async () => {
        mockDomainHostsRooms.mockResolvedValue(true)
        await openLink('xmpp:team@lounge.example.com?message')
        expect(mockActivateRoom).toHaveBeenCalledWith('team@lounge.example.com')
        expect(mockActivateConversation).not.toHaveBeenCalled()
      })

      test('without an answer from the server the name guess decides', async () => {
        await openLink('xmpp:dave@conference.example.com?message')
        expect(mockActivateRoom).toHaveBeenCalledWith('dave@conference.example.com')
      })

      test('known contacts are not asked about', async () => {
        await openLink('xmpp:alice@example.org?message')
        expect(mockDomainHostsRooms).not.toHaveBeenCalled()
      })

      test('message body fills an empty composer draft', async () => {
        await openLink('xmpp:alice@example.org?message;body=Hi')
        expect(chatDrafts.get('alice@example.org')).toBe('Hi')
      })

      test('message body goes below an existing draft, once for the same link', async () => {
        chatDrafts.set('alice@example.org', 'See you at 6')
        await openLink('xmpp:alice@example.org?message;body=Hi')
        expect(chatDrafts.get('alice@example.org')).toBe('See you at 6\n\nHi')
        const { routeDeepLink } = await import('@/utils/deepLinkRouter')
        await act(async () => routeDeepLink('xmpp:alice@example.org?message;body=Hi'))
        expect(chatDrafts.get('alice@example.org')).toBe('See you at 6\n\nHi')
      })

      test('message body drops control and direction-override characters and is bounded', async () => {
        await openLink(`xmpp:alice@example.org?message;body=a%00b%E2%80%AEc${'x'.repeat(5000)}`)
        const draft = chatDrafts.get('alice@example.org')!
        expect(draft.startsWith('abc')).toBe(true)
        expect(Array.from(draft).length).toBeLessThanOrEqual(4001)
      })
    })
  })
})
