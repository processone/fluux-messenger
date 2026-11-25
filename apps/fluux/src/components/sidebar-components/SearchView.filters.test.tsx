import { beforeEach, describe, it, expect, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { SearchView } from './SearchView'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, string>) => (options ? `${key}${JSON.stringify(options)}` : key),
    i18n: { language: search.language },
  }),
}))
vi.mock('@/hooks', async () => import('@/hooks/useListKeyboardNav'))
vi.mock('@/hooks/useNavigateToTarget', () => ({ useNavigateToTarget: () => ({ navigateToConversation: vi.fn(), navigateToRoom: vi.fn() }) }))
vi.mock('@/utils/renderLoopDetector', () => ({ detectRenderLoop: () => {}, notifyUserInput: () => {} }))
vi.mock('./types', () => ({ useSidebarZone: () => ({ current: null }) }))
vi.mock('@/stores/settingsStore', () => ({
  useSettingsStore: (selector: (s: { timeFormat: string }) => unknown) => selector({ timeFormat: '24h' }),
}))
vi.mock('@fluux/sdk/react', () => ({ useRoomStore: () => undefined, useRosterStore: () => undefined }))

const search = vi.hoisted(() => ({ language: 'en', query: '', scope: null as string | null, calls: [] as string[], picked: [] as string[], none: [] as never[], filtersBuilding: false,
  rooms: new Map<string, { jid: string; name: string; nickname: string; occupants: Map<string, { nick: string; occupantId: string }> }>() }))
vi.mock('@fluux/sdk', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@fluux/sdk')>()
  const { useState } = await import('react')
  return {
    ...actual,
    roomStore: { getState: () => ({ ...actual.roomStore.getState(), rooms: search.rooms }) },
    useSearch: () => {
      const [query, setQuery] = useState(search.query)
      const [pickedFilters, setPickedFilters] = useState<string[]>([])
      return {
        pickedFilters, setPickedFilters: (next: string[]) => { search.picked = next; setPickedFilters(next) }, filtersIncomplete: false, filtersUnavailable: null, retryFilters: vi.fn(),
        query, results: search.none, isSearching: false, error: null, previewResult: null, setPreviewResult: vi.fn(),
        isSearchingMAM: false, mamSearched: false, mamResults: search.none, hasMoreMAMResults: false, mamError: null, searchScope: search.scope,
        searchMAM: vi.fn(), loadMoreMAMResults: vi.fn(), setSearchScope: vi.fn(), resultContext: new Map(),
        searchFilter: 'all', setSearchFilter: vi.fn(), inPrefixSuggestions: search.none, isInPrefixActive: false,
        selectInPrefixSuggestion: vi.fn(), filtersBuilding: search.filtersBuilding, clearSearch: () => setQuery(''),
        search: (next: string) => { search.calls.push(next); setQuery(next) },
      }
    },
  }
})

const input = () => screen.getByRole('combobox')

describe('SearchView filters', () => {
  beforeEach(() => {
    search.language = 'en'
    search.query = ''
    search.scope = null
    search.calls = []
    search.picked = []
    search.rooms = new Map()
    search.filtersBuilding = false
  })

  it('shows a chip per operator, and removing one keeps the rest of the query', () => {
    search.query = 'report after:2024-03-05 before:nope'
    render(<SearchView />)
    expect(screen.getByText('search.chip.after{"date":"Mar 5, 2024"}')).toBeTruthy()
    // A value Fluux does not read stays visible, flagged, so it can be fixed
    expect(screen.getByText('before:nope')).toBeTruthy()
    expect(screen.getAllByText('search.chip.invalid{"filter":"before:nope"}').length).toBeGreaterThan(0)

    fireEvent.click(screen.getByRole('button', { name: 'search.chip.remove{"label":"search.chip.after{\\"date\\":\\"Mar 5, 2024\\"}"}' }))
    expect(search.calls.at(-1)).toBe('report before:nope')
  })

  it('completes an operator, then its value, from the keyboard', () => {
    render(<SearchView />)
    fireEvent.change(input(), { target: { value: 'report before:' } })
    expect(input().getAttribute('aria-expanded')).toBe('true')
    expect(screen.getAllByRole('option', { name: /before:/ })).toHaveLength(4)

    const tab = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true })
    input().dispatchEvent(tab)
    expect(tab.defaultPrevented).toBe(false)
    expect(screen.getAllByRole('option')).toHaveLength(4)

    fireEvent.keyDown(input(), { key: 'ArrowDown' })
    fireEvent.keyDown(input(), { key: 'ArrowDown' })
    expect(input().getAttribute('aria-activedescendant')).toBe('search-suggestion-1')
    fireEvent.keyDown(input(), { key: 'Enter' })
    expect(search.calls.at(-1)).toMatch(/^report before:\d{4}-\d{2}-\d{2} $/)
    expect(input().getAttribute('aria-expanded')).toBe('false')
  })

  it('closes the suggestions on Escape without clearing the query', () => {
    render(<SearchView />)
    fireEvent.change(input(), { target: { value: 'on:' } })
    expect(screen.getAllByRole('option')).toHaveLength(4)
    fireEvent.keyDown(input(), { key: 'Escape' })
    expect(screen.queryAllByRole('option')).toHaveLength(0)
    expect((input() as HTMLInputElement).value).toBe('on:')
  })

  it('shows only Filters on empty search and keeps panel choices out of the query', async () => {
    render(<SearchView />)
    expect(screen.queryByRole('button', { name: 'after:' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'search.panel.title' }))
    fireEvent.click(screen.getByRole('checkbox', { name: 'search.panel.image' }))
    expect(screen.queryByText('search.chip.image')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'search.panel.apply' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect((input() as HTMLInputElement).value).toBe('')
    expect(screen.getByText('search.chip.image')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'search.chip.remove{"label":"search.chip.image"}' }))
    expect(screen.queryByText('search.chip.image')).toBeNull()
  })

  it('names senders and content in the chips', () => {
    search.query = 'from:alice is:mine has:image'
    render(<SearchView />)
    expect(screen.getByText('search.chip.from{"name":"alice"}')).toBeTruthy()
    expect(screen.getByText('search.chip.mine')).toBeTruthy()
    expect(screen.getByText('search.chip.image')).toBeTruthy()
  })

  it('says when the filters wait for the index, and when dates alone leave nothing to search', () => {
    search.query = 'has:image'
    search.filtersBuilding = true
    const { unmount } = render(<SearchView />)
    expect(screen.getByRole('status').textContent).toContain('search.filtersBuilding')
    expect(screen.queryByText('search.panel.localEmpty')).toBeNull()
    unmount()

    search.query = 'after:2024-03-01'
    search.filtersBuilding = false
    render(<SearchView />)
    expect(screen.getByText('search.needsWords')).toBeTruthy()
    expect(screen.queryByText('search.searchServer')).toBeNull()
  })

  it('discards draft choices on Escape without clearing the query', async () => {
    search.query = 'report'
    render(<SearchView />)
    fireEvent.click(screen.getByRole('button', { name: 'search.panel.title' }))
    fireEvent.click(screen.getByRole('checkbox', { name: 'search.panel.image' }))
    fireEvent.keyDown(document, { key: 'Escape' })
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect((input() as HTMLInputElement).value).toBe('report')
    expect(screen.queryByText('search.chip.image')).toBeNull()
    expect(document.activeElement).toBe(input())
  })
  it('picks a room person by stable identity without exposing the encoded identity in the text field', () => {
    search.query = 'notes from:'
    search.rooms = new Map([['team@conference.example.test', {
      jid: 'team@conference.example.test', name: 'Team', nickname: 'Me',
      occupants: new Map([['Bob', { nick: 'Bob', occupantId: 'bob-id' }]]),
    }]])
    render(<SearchView />)
    fireEvent.click(screen.getByRole('option', { name: 'from:Bob Bob · Team' }))
    expect((input() as HTMLInputElement).value).toBe('notes')
    expect(screen.getByText('search.chip.from{"name":"Bob"}')).toBeTruthy()
    expect(search.picked).toEqual(['from:"room:team%40conference.example.test:bob-id:Bob"'])
    search.rooms = new Map()
    fireEvent.click(screen.getByRole('button', { name: 'search.panel.title' }))
    expect(screen.getByRole('option', { name: 'Bob' })).toBeTruthy()
  })

  it('keeps a localized typed date unchanged when opening the panel', () => {
    search.language = 'fr'
    search.query = 'notes on:05/03/2024'
    render(<SearchView />)
    fireEvent.click(screen.getByRole('button', { name: 'search.panel.title' }))
    expect((screen.getByLabelText('search.panel.start') as HTMLInputElement).value).toBe('2024-03-05')
    expect((screen.getByLabelText('search.panel.end') as HTMLInputElement).value).toBe('2024-03-05')
  })

  it.each(['after:2024-03-01', 'before:2024-04-01'])('keeps an untouched open date %s while editing content', async filter => {
    search.query = `notes ${filter} from:alice from:bob is:mine`
    render(<SearchView />)
    fireEvent.click(screen.getByRole('button', { name: 'search.panel.title' }))
    expect(screen.queryByRole('alert')).toBeNull()
    fireEvent.click(screen.getByRole('checkbox', { name: 'search.panel.image' }))
    fireEvent.click(screen.getByRole('button', { name: 'search.panel.apply' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(search.picked).toEqual(['from:alice', 'from:bob', 'is:mine', 'has:image', filter])
    expect((input() as HTMLInputElement).value).toBe('notes')
  })

  it('allows an edited custom date range with its last day left open', async () => {
    render(<SearchView />)
    fireEvent.click(screen.getByRole('button', { name: 'search.panel.title' }))
    fireEvent.change(screen.getByLabelText('search.panel.date'), { target: { value: 'custom' } })
    fireEvent.change(screen.getByLabelText('search.panel.start'), { target: { value: '2024-03-05' } })
    fireEvent.click(screen.getByRole('button', { name: 'search.panel.apply' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(search.picked).toEqual(['after:2024-03-04'])
  })

  it.each([null, 'team@conference.example.test'])('explains the unavailable filter-only archive action in scope %s', scope => {
    search.scope = scope
    if (scope) search.rooms = new Map([[scope, { jid: scope, name: 'Team', nickname: 'Me', occupants: new Map() }]])
    search.query = 'has:image'
    render(<SearchView />)
    expect(screen.queryByRole('button', { name: 'search.searchServer' })).toBeNull()
    expect(screen.getByText('search.errors.serverNeedsWords')).toBeTruthy()
  })

  it('keeps filter-only archive search available within a direct chat', () => {
    search.scope = 'alice@example.test'
    search.query = 'has:image'
    render(<SearchView />)
    expect(screen.getByRole('button', { name: 'search.searchServer' })).toBeTruthy()
    expect(screen.queryByText('search.errors.serverNeedsWords')).toBeNull()
  })

})
