/**
 * Regression guard for the "frozen avatar in a memoized search row" class.
 *
 * SearchResultItem is React.memo'd and the avatar is NOT part of its `result`
 * prop. It must therefore resolve the avatar REACTIVELY (per-key store
 * subscription) — a render-time roomStore.getState() / rosterStore.getState()
 * read freezes the row on the letter-avatar fallback when the vCard / room-avatar
 * fetch resolves AFTER the row first rendered. Same class as the reply-quote
 * freeze (useReferencedMessage) and the reply-scroll / poll-close freezes (#471).
 *
 * Both the @fluux/sdk stores (the old getState() read path) and the
 * @fluux/sdk/react hooks (the reactive fix) are backed by the SAME mutable store,
 * so mutating it after mount fails the assertion on the non-reactive path and
 * passes on the reactive one.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, act } from '@testing-library/react'
import { SearchView } from './SearchView'
import type { SearchResult } from '@fluux/sdk'

type RoomSlice = { rooms: Map<string, { avatar?: string }> }
type RosterSlice = { contacts: Map<string, { avatar?: string }> }

// Minimal hand-rolled reactive stores (zustand-vanilla-shaped: getState /
// getInitialState / subscribe / setState). vi.hoisted guarantees they are
// initialized before the mock factories below run.
const { mockRoomStore, mockRosterStore } = vi.hoisted(() => {
  function makeStore<S>(initial: S) {
    let state = initial
    const listeners = new Set<() => void>()
    return {
      getState: () => state,
      getInitialState: () => initial,
      setState: (partial: Partial<S>) => {
        state = { ...state, ...partial }
        listeners.forEach((l) => l())
      },
      subscribe: (listener: () => void) => {
        listeners.add(listener)
        return () => {
          listeners.delete(listener)
        }
      },
    }
  }
  return {
    mockRoomStore: makeStore<RoomSlice>({ rooms: new Map() }),
    mockRosterStore: makeStore<RosterSlice>({ contacts: new Map() }),
  }
})

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'en' } }),
}))

vi.mock('@/hooks', () => ({
  useListKeyboardNav: () => ({
    selectedIndex: -1,
    isKeyboardNav: false,
    getItemProps: () => ({ 'data-selected': false, onMouseEnter: vi.fn(), onMouseMove: vi.fn() }),
    getItemAttribute: (index: number) => ({ 'data-search-result-id': String(index) }),
    getContainerProps: () => ({}),
  }),
}))

vi.mock('@/hooks/useNavigateToTarget', () => ({
  useNavigateToTarget: () => ({ navigateToConversation: vi.fn(), navigateToRoom: vi.fn() }),
}))

// Expose the avatarUrl the row passes to <Avatar> so the contact case is observable.
vi.mock('../Avatar', () => ({
  Avatar: ({ name, avatarUrl }: { name: string; avatarUrl?: string }) => (
    <div data-testid="avatar" data-avatar-url={avatarUrl ?? ''}>
      {name}
    </div>
  ),
}))

vi.mock('../ui/TextInput', () => ({ TextInput: () => <input data-testid="search" /> }))
vi.mock('@/utils/dateFormat', () => ({ formatConversationTime: () => '12:00' }))
vi.mock('@/utils/renderLoopDetector', () => ({ detectRenderLoop: () => {} }))
vi.mock('./types', () => ({ useSidebarZone: () => ({ current: null }) }))
vi.mock('@/stores/settingsStore', () => ({
  useSettingsStore: (selector: (s: { timeFormat: string }) => unknown) => selector({ timeFormat: '24h' }),
}))

// Reactive hooks backed by the shared stores — what the fix subscribes to.
// useSyncExternalStore is exactly what zustand's useStore wraps; using it here
// keeps the mock's reactivity identical to the real hook without zustand's
// store-api typing friction.
vi.mock('@fluux/sdk/react', async () => {
  const { useSyncExternalStore } = await import('react')
  return {
    useRoomStore: (selector: (s: RoomSlice) => unknown) =>
      useSyncExternalStore(mockRoomStore.subscribe, () => selector(mockRoomStore.getState())),
    useRosterStore: (selector: (s: RosterSlice) => unknown) =>
      useSyncExternalStore(mockRosterStore.subscribe, () => selector(mockRosterStore.getState())),
  }
})

let mockSearch: ReturnType<typeof baseSearch>
vi.mock('@fluux/sdk', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@fluux/sdk')>()
  return {
    ...actual,
    useSearch: () => mockSearch,
    // Same store the reactive hooks read — the old getState() read path.
    chatStore: { getState: () => ({ conversationEntities: new Map() }) },
    roomStore: mockRoomStore,
    rosterStore: mockRosterStore,
    getLocalPart: (jid: string) => jid.split('@')[0],
  }
})

const makeResult = (indexId: string, conversationId: string, isRoom: boolean): SearchResult =>
  ({
    indexId,
    conversationId,
    conversationName: conversationId.split('@')[0],
    messageId: `m-${indexId}`,
    isRoom,
    timestamp: 1700000000000,
    source: 'local',
    matchSnippet: { text: 'hello world', matchStart: 0, matchEnd: 5 },
  }) as unknown as SearchResult

function baseSearch(results: SearchResult[]) {
  return {
    query: 'hello', results, isSearching: false, error: null,
    search: vi.fn(), clearSearch: vi.fn(), previewResult: null, setPreviewResult: vi.fn(),
    isSearchingMAM: false, mamResults: [] as SearchResult[], hasMoreMAMResults: false, mamError: null,
    searchScope: null, searchMAM: vi.fn(), loadMoreMAMResults: vi.fn(), setSearchScope: vi.fn(),
    resultContext: new Map(), searchFilter: 'all', setSearchFilter: vi.fn(),
    inPrefixSuggestions: [], isInPrefixActive: false, selectInPrefixSuggestion: vi.fn(),
  }
}

describe('SearchView avatar reactivity (frozen-derived-value regression guard)', () => {
  beforeEach(() => {
    mockRoomStore.setState({ rooms: new Map() })
    mockRosterStore.setState({ contacts: new Map() })
  })

  it('shows the room avatar when it loads AFTER the row first rendered', () => {
    mockSearch = baseSearch([makeResult('1', 'team@conf.example.com', true)])
    const { container } = render(<SearchView />)

    // Before the avatar resolves: letter-avatar fallback, no <img>.
    expect(container.querySelector('img')).toBeNull()

    // Room avatar resolves (PEP / vCard fetch) after first render.
    act(() => {
      mockRoomStore.setState({
        rooms: new Map([['team@conf.example.com', { avatar: 'https://example.com/room.png' }]]),
      })
    })

    const img = container.querySelector('img')
    expect(img).not.toBeNull()
    expect(img?.getAttribute('src')).toBe('https://example.com/room.png')
  })

  it('shows the contact avatar when it loads AFTER the row first rendered', () => {
    mockSearch = baseSearch([makeResult('1', 'alice@example.com', false)])
    const { container } = render(<SearchView />)

    const avatar = () => container.querySelector('[data-testid="avatar"]')
    // Before the vCard resolves: fallback letter avatar, no image url.
    expect(avatar()?.getAttribute('data-avatar-url')).toBe('')

    act(() => {
      mockRosterStore.setState({
        contacts: new Map([['alice@example.com', { avatar: 'https://example.com/alice.png' }]]),
      })
    })

    expect(avatar()?.getAttribute('data-avatar-url')).toBe('https://example.com/alice.png')
  })
})
