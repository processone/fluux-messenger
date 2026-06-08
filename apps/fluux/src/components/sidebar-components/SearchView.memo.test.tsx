import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render } from '@testing-library/react'
import { SearchView } from './SearchView'
import type { SearchResult } from '@fluux/sdk'

// Each non-room result row renders exactly one Avatar — count them to detect over-rendering.
const avatarRenders = { count: 0 }

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'en' } }),
}))

// Stable hover handlers — mirrors the real useListKeyboardNav (cached per item id).
const stableEnter = vi.fn()
const stableMove = vi.fn()
vi.mock('@/hooks', () => ({
  useListKeyboardNav: () => ({
    selectedIndex: -1,
    isKeyboardNav: false,
    getItemProps: () => ({ 'data-selected': false, onMouseEnter: stableEnter, onMouseMove: stableMove }),
    getItemAttribute: (index: number) => ({ 'data-search-result-id': String(index) }),
    getContainerProps: () => ({}),
  }),
}))

vi.mock('@/hooks/useNavigateToTarget', () => ({
  useNavigateToTarget: () => ({ navigateToConversation: vi.fn(), navigateToRoom: vi.fn() }),
}))

vi.mock('../Avatar', () => ({
  Avatar: ({ name }: { name: string }) => {
    avatarRenders.count++
    return <div data-testid="avatar">{name}</div>
  },
}))

vi.mock('../ui/TextInput', () => ({ TextInput: () => <input data-testid="search" /> }))
vi.mock('@/utils/dateFormat', () => ({ formatConversationTime: () => '12:00' }))
vi.mock('@/utils/renderLoopDetector', () => ({ detectRenderLoop: () => {} }))
vi.mock('./types', () => ({ useSidebarZone: () => ({ current: null }) }))
vi.mock('@/stores/settingsStore', () => ({
  useSettingsStore: (selector: (s: { timeFormat: string }) => unknown) => selector({ timeFormat: '24h' }),
}))

let mockSearch: ReturnType<typeof baseSearch>
vi.mock('@fluux/sdk', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@fluux/sdk')>()
  const emptyStore = {
    getState: () => ({
      rooms: { get: () => undefined },
      contacts: { get: () => undefined },
      conversationEntities: { get: () => undefined },
    }),
  }
  return {
    ...actual,
    useSearch: () => mockSearch,
    chatStore: emptyStore,
    roomStore: emptyStore,
    rosterStore: emptyStore,
    getLocalPart: (jid: string) => jid.split('@')[0],
  }
})

const makeResult = (indexId: string, conversationId: string): SearchResult => ({
  indexId,
  conversationId,
  conversationName: conversationId.split('@')[0],
  messageId: `m-${indexId}`,
  isRoom: false,
  timestamp: 1700000000000,
  source: 'local',
  matchSnippet: { text: 'hello world', matchStart: 0, matchEnd: 5 },
}) as unknown as SearchResult

function baseSearch(results: SearchResult[], previewResult: SearchResult | null) {
  return {
    query: 'hello', results, isSearching: false, error: null,
    search: vi.fn(), clearSearch: vi.fn(), previewResult, setPreviewResult: vi.fn(),
    isSearchingMAM: false, mamResults: [] as SearchResult[], hasMoreMAMResults: false, mamError: null,
    searchScope: null, searchMAM: vi.fn(), loadMoreMAMResults: vi.fn(), setSearchScope: vi.fn(),
    resultContext: new Map(), searchFilter: 'all', setSearchFilter: vi.fn(),
    inPrefixSuggestions: [], isInPrefixActive: false, selectInPrefixSuggestion: vi.fn(),
  }
}

describe('SearchView result-row memoization', () => {
  beforeEach(() => { avatarRenders.count = 0 })

  it('re-renders only the affected result row when the preview selection changes', () => {
    const r1 = makeResult('1', 'alice@example.com')
    const r2 = makeResult('2', 'bob@example.com')
    const r3 = makeResult('3', 'carol@example.com')
    mockSearch = baseSearch([r1, r2, r3], null)

    const { rerender } = render(<SearchView />)
    expect(avatarRenders.count).toBeGreaterThan(0)
    const perRowCost = avatarRenders.count / 3 // avatars per row at mount (3 results)
    const afterMount = avatarRenders.count

    // Select r2 for preview: SAME results array/refs, only previewResult changes (isActive
    // flips for r2 only). The non-memoized row re-rendered all three; the memo must bail
    // on r1 and r3.
    mockSearch = baseSearch([r1, r2, r3], r2)
    rerender(<SearchView />)

    const delta = avatarRenders.count - afterMount
    expect(delta).toBeGreaterThan(0)
    expect(delta).toBeLessThanOrEqual(perRowCost)
  })
})
