import { beforeEach, describe, it, expect, vi } from 'vitest'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { SearchView } from './SearchView'
import { chatStore } from '@fluux/sdk'

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
    chatStore.setState({ conversationEntities: new Map() })
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
    expect(screen.getByRole('button', { name: 'search.panel.from Bob' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'search.panel.from Bob' }))
    expect(screen.getByRole('option', { name: 'Bob' })).toBeTruthy()
  })

  describe('approved type-to-filter sender picker', () => {
    const seedSenders = () => {
      chatStore.setState({ conversationEntities: new Map([
        ['jo@example.test', { id: 'jo@example.test', name: 'Jo Lévy', type: 'chat' }],
      ]) })
      search.rooms = new Map([
        ['team@conference.example.test', { jid: 'team@conference.example.test', name: 'Équipe produit', nickname: 'Me', occupants: new Map([
          ['Camille', { nick: 'Camille', occupantId: 'camille-team' }],
        ]) }],
        ['help@conference.example.test', { jid: 'help@conference.example.test', name: 'Aide', nickname: 'Me', occupants: new Map([
          ['Camille', { nick: 'Camille', occupantId: 'camille-help' }],
        ]) }],
      ])
    }
    const openPicker = () => {
      fireEvent.click(screen.getByRole('button', { name: 'search.panel.title' }))
      const dialog = within(screen.getByRole('dialog'))
      fireEvent.click(dialog.getByRole('button', { name: /^search.panel.from / }))
      return dialog
    }

    it('filters names, room labels and addresses without searching, then applies the exact chosen room identity', async () => {
      seedSenders()
      search.query = 'notes'
      render(<SearchView />)
      const query = input()
      const dialog = openPicker()
      const picker = dialog.getByRole('combobox', { name: 'search.panel.from' })
      const callsBeforeTyping = [...search.calls]
      for (const [text, names] of [
        ['  EQUIPE  ', ['Camille · Équipe produit']],
        ['léVY', ['Jo Lévy · jo@example.test']],
        ['JO@EXAMPLE.TEST', ['Jo Lévy · jo@example.test']],
        ['cam', ['Camille · Équipe produit', 'Camille · Aide']],
      ] as const) {
        fireEvent.change(picker, { target: { value: text } })
        expect(within(dialog.getByRole('listbox')).getAllByRole('option').map(row => row.textContent)).toEqual(['search.panel.anyone', 'search.panel.me', ...names])
      }
      expect(search.calls).toEqual(callsBeforeTyping)
      expect(search.picked).toEqual([])
      expect(query).toHaveValue('notes')
      fireEvent.click(dialog.getByRole('option', { name: 'Camille · Aide' }))
      expect(dialog.queryByRole('listbox')).toBeNull()
      expect(dialog.getByRole('button', { name: 'search.panel.from Camille · Aide' })).toHaveFocus()
      expect(search.picked).toEqual([])
      fireEvent.click(dialog.getByRole('button', { name: 'search.panel.apply' }))
      await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
      expect(search.picked).toEqual(['from:"room:help%40conference.example.test:camille-help:Camille"'])
      expect(query).toHaveValue('notes')
    })

    it.each(['team@conference.example.test', 'jo@example.test'])('keeps matches within conversation scope %s', scope => {
      seedSenders()
      search.scope = scope
      render(<SearchView />)
      const dialog = openPicker()
      expect(within(dialog.getByRole('listbox')).getAllByRole('option').map(row => row.textContent)).toEqual([
        'search.panel.anyone', 'search.panel.me', scope.startsWith('team') ? 'Camille' : 'Jo Lévy · jo@example.test',
      ])
    })

    it('announces no matches, keeps the draft through composition and closes only the picker on Escape', async () => {
      search.query = 'notes from:departed@example.test'
      render(<SearchView />)
      const query = input()
      const dialog = openPicker()
      const picker = dialog.getByRole('combobox', { name: 'search.panel.from' })
      fireEvent.change(picker, { target: { value: 'nobody-matches' } })
      expect(dialog.getByRole('status')).toHaveTextContent('search.panel.noSenders')
      expect(within(dialog.getByRole('listbox')).getAllByRole('option')).toHaveLength(2)
      fireEvent.keyDown(picker, { key: 'Enter' })
      expect(dialog.getByRole('combobox', { name: 'search.panel.from' })).toBe(picker)
      fireEvent.keyDown(picker, { key: 'ArrowDown' })
      expect(picker).toHaveFocus()
      fireEvent.keyDown(picker, { key: 'Enter', isComposing: true })
      fireEvent.keyDown(picker, { key: 'Escape', isComposing: true })
      expect(dialog.getByRole('combobox', { name: 'search.panel.from' })).toBe(picker)
      fireEvent.keyDown(picker, { key: 'Escape' })
      expect(dialog.queryByRole('combobox', { name: 'search.panel.from' })).toBeNull()
      expect(dialog.getByRole('button', { name: 'search.panel.from departed@example.test' })).toHaveFocus()
      fireEvent.click(dialog.getByRole('button', { name: 'search.panel.apply' }))
      await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
      expect(search.picked).toEqual(['from:departed@example.test'])
      expect(query).toHaveValue('notes')
    })

    it('preserves an untouched multi-sender set after opening and filtering the picker', async () => {
      search.query = 'notes from:alice from:bob is:mine has:link'
      render(<SearchView />)
      const dialog = openPicker()
      fireEvent.change(dialog.getByRole('combobox', { name: 'search.panel.from' }), { target: { value: 'alice' } })
      fireEvent.blur(dialog.getByRole('combobox', { name: 'search.panel.from' }), { relatedTarget: dialog.getByLabelText('search.panel.date') })
      expect(dialog.getByRole('listbox')).toBeInTheDocument()
      fireEvent.click(dialog.getByRole('button', { name: 'search.panel.apply' }))
      await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
      expect(search.picked).toEqual(['from:alice', 'from:bob', 'is:mine', 'has:link'])
    })

    it.each([
      ['is:mine', 'search.panel.me'],
      ['from:ME', 'search.panel.me'],
      ['from:alice', 'alice'],
    ])('preserves the original token %s when the same sender is chosen again', async (filter, name) => {
      search.query = `notes ${filter} has:link`
      render(<SearchView />)
      const dialog = openPicker()
      fireEvent.click(dialog.getByRole('option', { name }))
      fireEvent.click(dialog.getByRole('button', { name: 'search.panel.apply' }))
      await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
      expect(search.picked).toEqual([filter, 'has:link'])
      expect(input()).toHaveValue('notes')
    })

    it('selects a highlighted shortcut with Enter without submitting and resets only when asked', async () => {
      search.query = 'notes from:alice has:link'
      render(<SearchView />)
      const dialog = openPicker()
      const picker = dialog.getByRole('combobox', { name: 'search.panel.from' })
      fireEvent.keyDown(picker, { key: 'ArrowDown' })
      fireEvent.keyDown(picker, { key: 'ArrowDown' })
      fireEvent.keyDown(picker, { key: 'Enter' })
      expect(dialog.getByRole('button', { name: 'search.panel.from search.panel.me' })).toHaveFocus()
      expect(search.picked).toEqual([])
      fireEvent.click(dialog.getByRole('button', { name: 'search.panel.clear' }))
      fireEvent.click(dialog.getByRole('button', { name: 'search.panel.apply' }))
      await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
      expect(search.picked).toEqual([])
      expect(input()).toHaveValue('notes')
    })
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
