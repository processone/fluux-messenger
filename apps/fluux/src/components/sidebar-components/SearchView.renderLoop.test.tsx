import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, fireEvent } from '@testing-library/react'
import { SearchView } from './SearchView'
import type { SearchResult } from '@fluux/sdk'

// The search box is a controlled input: every keystroke re-renders SearchView for the
// query, then again for the debounced search cycle (isSearching true → results). At
// ~3 renders/keystroke (×2 under StrictMode) normal typing speed crosses the detector's
// 30-renders-per-second warning threshold with no loop present. Typing must therefore
// arm the interaction grace, exactly as the message composer does.
const notifyUserInput = vi.fn()
vi.mock('@/utils/renderLoopDetector', () => ({
  detectRenderLoop: () => {},
  notifyUserInput: () => notifyUserInput(),
}))

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'en' } }),
}))

vi.mock('@/hooks', () => ({
  useListKeyboardNav: () => ({
    selectedIndex: -1,
    isKeyboardNav: false,
    getItemProps: () => ({}),
    getItemAttribute: () => ({}),
    getContainerProps: () => ({}),
  }),
}))

vi.mock('@/hooks/useNavigateToTarget', () => ({
  useNavigateToTarget: () => ({ navigateToConversation: vi.fn(), navigateToRoom: vi.fn() }),
}))

vi.mock('@/utils/dateFormat', () => ({ formatConversationTime: () => '12:00' }))
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

function baseSearch() {
  return {
    query: '', results: [] as SearchResult[], isSearching: false, error: null,
    search: vi.fn(), clearSearch: vi.fn(), previewResult: null, setPreviewResult: vi.fn(),
    isSearchingMAM: false, mamResults: [] as SearchResult[], hasMoreMAMResults: false, mamError: null,
    searchScope: null, searchMAM: vi.fn(), loadMoreMAMResults: vi.fn(), setSearchScope: vi.fn(),
    resultContext: new Map(), searchFilter: 'all', setSearchFilter: vi.fn(),
    inPrefixSuggestions: [], isInPrefixActive: false, selectInPrefixSuggestion: vi.fn(),
  }
}

describe('SearchView render-loop interaction grace', () => {
  beforeEach(() => {
    notifyUserInput.mockClear()
    mockSearch = baseSearch()
  })

  it('arms the interaction grace on each keystroke in the search box', () => {
    const { container } = render(<SearchView />)
    const input = container.querySelector('input[type="text"]')
    expect(input).not.toBeNull()

    fireEvent.change(input!, { target: { value: 'd' } })
    expect(notifyUserInput).toHaveBeenCalledTimes(1)

    fireEvent.change(input!, { target: { value: 'de' } })
    expect(notifyUserInput).toHaveBeenCalledTimes(2)

    // The keystroke must still reach the store — the grace is additive, not a replacement.
    expect(mockSearch.search).toHaveBeenCalledTimes(2)
  })
})
