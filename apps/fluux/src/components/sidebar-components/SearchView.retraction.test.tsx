/**
 * Retracted neighbours in a search result's context lines.
 *
 * A known retraction is excluded when search results are projected, but it CAN
 * still appear as context: `fetchResultContexts` reads the surrounding messages
 * straight from the cache, which deliberately preserves `body` through a
 * retraction so the bubble can be replaced in place. Rendering that body would
 * resurface text the sender deleted, so the line must show the localized
 * "message deleted" notice instead — and, like the sidebar, in italic.
 */
import { describe, it, expect, vi } from 'vitest'
import { render } from '@testing-library/react'
import { SearchView } from './SearchView'
import type { SearchResult, SearchResultContext } from '@fluux/sdk'

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

vi.mock('../Avatar', () => ({ Avatar: () => <div data-testid="avatar" /> }))
vi.mock('../ui/TextInput', () => ({ TextInput: () => <input data-testid="search" /> }))
vi.mock('@/utils/dateFormat', () => ({ formatConversationTime: () => '12:00' }))
vi.mock('@/utils/renderLoopDetector', () => ({ detectRenderLoop: () => {} }))
vi.mock('./types', () => ({ useSidebarZone: () => ({ current: null }) }))
vi.mock('@/stores/settingsStore', () => ({
  useSettingsStore: (selector: (s: { timeFormat: string }) => unknown) => selector({ timeFormat: '24h' }),
}))

const { emptyStore } = vi.hoisted(() => ({
  emptyStore: { getState: () => ({ rooms: new Map(), contacts: new Map() }), subscribe: () => () => {} },
}))

vi.mock('@fluux/sdk/react', () => ({
  useRoomStore: () => undefined,
  useRosterStore: () => undefined,
}))

let mockSearch: ReturnType<typeof baseSearch>
vi.mock('@fluux/sdk', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@fluux/sdk')>()
  return {
    ...actual,
    useSearch: () => mockSearch,
    chatStore: { getState: () => ({ conversationEntities: new Map() }) },
    roomStore: emptyStore,
    rosterStore: emptyStore,
    getLocalPart: (jid: string) => jid.split('@')[0],
  }
})

const RESULT: SearchResult = {
  indexId: '1',
  conversationId: 'alice@example.com',
  conversationName: 'alice',
  messageId: 'm-1',
  isRoom: false,
  from: 'alice@example.com',
  timestamp: 1700000000000,
  source: 'local',
  body: 'hello world',
  matchSnippet: { text: 'hello world', matchStart: 0, matchEnd: 5 },
} as unknown as SearchResult

function baseSearch(resultContext: Map<string, SearchResultContext>) {
  return {
    query: 'hello', results: [RESULT], isSearching: false, error: null,
    search: vi.fn(), clearSearch: vi.fn(), previewResult: null, setPreviewResult: vi.fn(),
    isSearchingMAM: false, mamResults: [] as SearchResult[], hasMoreMAMResults: false, mamError: null,
    searchScope: null, searchMAM: vi.fn(), loadMoreMAMResults: vi.fn(), setSearchScope: vi.fn(),
    resultContext, searchFilter: 'all', setSearchFilter: vi.fn(),
    inPrefixSuggestions: [], isInPrefixActive: false, selectInPrefixSuggestion: vi.fn(),
  }
}

const contextWith = (before: Partial<SearchResultContext['before'][number]>[]) =>
  new Map<string, SearchResultContext>([
    ['1', { before: before as SearchResultContext['before'], after: [] }],
  ])

describe('SearchView context lines and retraction', () => {
  it('shows the deleted notice instead of the body a retracted neighbour kept', () => {
    mockSearch = baseSearch(
      contextWith([{ body: 'the secret', from: 'bob@example.com', timestamp: 1, isRetracted: true }]),
    )
    const { container } = render(<SearchView />)

    expect(container.textContent).toContain('chat.messageDeleted')
    expect(container.textContent).not.toContain('the secret')
  })

  it('italicises the notice, matching the sidebar', () => {
    mockSearch = baseSearch(
      contextWith([{ body: 'the secret', from: 'bob@example.com', timestamp: 1, isRetracted: true }]),
    )
    const { container } = render(<SearchView />)

    const notice = [...container.querySelectorAll('span.italic')].find(
      (el) => el.textContent === 'chat.messageDeleted',
    )
    expect(notice).toBeTruthy()
  })

  it('still renders a bodiless retraction rather than dropping the line', () => {
    mockSearch = baseSearch(contextWith([{ body: '', from: 'bob@example.com', timestamp: 1, isRetracted: true }]))
    const { container } = render(<SearchView />)

    expect(container.textContent).toContain('chat.messageDeleted')
  })

  it('leaves an ordinary context line unchanged', () => {
    mockSearch = baseSearch(contextWith([{ body: 'good morning', from: 'bob@example.com', timestamp: 1 }]))
    const { container } = render(<SearchView />)

    expect(container.textContent).toContain('good morning')
    expect(container.textContent).not.toContain('chat.messageDeleted')
  })

  it('still drops a context line that has no body and is not retracted', () => {
    mockSearch = baseSearch(contextWith([{ body: '', from: 'bob@example.com', timestamp: 1 }]))
    const { container } = render(<SearchView />)

    expect(container.textContent).not.toContain('bob')
  })
})
