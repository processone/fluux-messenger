/**
 * Filter chips and operator suggestions in the search sidebar: each active
 * operator shows as a chip that removes it, and typing an operator name offers
 * it, then its values, from the keyboard.
 */
import { beforeEach, describe, it, expect, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { SearchView } from './SearchView'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, string>) => (options ? `${key}${JSON.stringify(options)}` : key),
    i18n: { language: 'en' },
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

const search = vi.hoisted(() => ({ query: '', calls: [] as string[], none: [] as never[] }))
vi.mock('@fluux/sdk', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@fluux/sdk')>()
  const { useState } = await import('react')
  return {
    ...actual,
    useSearch: () => {
      const [query, setQuery] = useState(search.query)
      return {
        query, results: search.none, isSearching: false, error: null, previewResult: null, setPreviewResult: vi.fn(),
        isSearchingMAM: false, mamResults: search.none, hasMoreMAMResults: false, mamError: null, searchScope: null,
        searchMAM: vi.fn(), loadMoreMAMResults: vi.fn(), setSearchScope: vi.fn(), resultContext: new Map(),
        searchFilter: 'all', setSearchFilter: vi.fn(), inPrefixSuggestions: search.none, isInPrefixActive: false,
        selectInPrefixSuggestion: vi.fn(), clearSearch: () => setQuery(''),
        search: (next: string) => { search.calls.push(next); setQuery(next) },
      }
    },
  }
})

const input = () => screen.getByRole('combobox')

describe('SearchView filters', () => {
  beforeEach(() => {
    search.query = ''
    search.calls = []
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
    fireEvent.change(input(), { target: { value: 'report bef' } })
    expect(input().getAttribute('aria-expanded')).toBe('true')
    expect(screen.getByRole('option', { name: /before:/ })).toBeTruthy()

    fireEvent.keyDown(input(), { key: 'Tab' })
    expect(search.calls.at(-1)).toBe('report before:')
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
    fireEvent.change(input(), { target: { value: 'on' } })
    expect(screen.getAllByRole('option')).toHaveLength(1)
    fireEvent.keyDown(input(), { key: 'Escape' })
    expect(screen.queryAllByRole('option')).toHaveLength(0)
    expect((input() as HTMLInputElement).value).toBe('on')
  })

  it('lists the operators while the field is empty, and a click starts one', () => {
    render(<SearchView />)
    fireEvent.click(screen.getByRole('button', { name: 'after:' }))
    expect(search.calls.at(-1)).toBe('after:')
  })
})
