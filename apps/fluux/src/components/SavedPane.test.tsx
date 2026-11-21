import { describe, it, expect, vi, beforeEach } from 'vitest'
import { useStore } from 'zustand'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { savedStore, type SavedMessage } from '@fluux/sdk'

const open = vi.fn().mockResolvedValue(undefined)
const latestCopy = vi.fn()
const readChat = vi.fn()
vi.mock('@fluux/sdk', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@fluux/sdk')>()),
  connectionStore: { getState: () => ({ jid: 'romeo@montague.example/phone' }) },
  chatStore: { getState: () => ({ conversationEntities: new Map() }) },
  useSavedMessages: () => {
    const entries = useStore(savedStore, (s) => s.entries)
    const saved = Object.values(entries).sort((a, b) => b.savedAt - a.savedAt)
    const lockedCount = useStore(savedStore, (s) => Object.keys(s.lockedIds).length)
    return { saved, lockedCount, remove: (id: string) => savedStore.getState().remove(id) }
  },
  useContactIdentities: () => new Map(),
  findLatestCopy: (...args: unknown[]) => latestCopy(...args),
}))
vi.mock('@fluux/sdk/cache', () => ({
  getMessages: (...args: unknown[]) => readChat(...args),
  getRoomMessages: vi.fn().mockResolvedValue([]),
}))
vi.mock('@fluux/sdk/react', () => ({
  useChatStore: (selector: (s: unknown) => unknown) => selector({ messages: new Map() }),
  useRoomStore: (selector: (s: unknown) => unknown) => selector({ messages: new Map(), rooms: new Map() }),
  useRosterStore: (selector: (s: unknown) => unknown) => selector({ contacts: new Map() }),
  useSavedStore: (selector: (s: ReturnType<typeof savedStore.getState>) => unknown) => useStore(savedStore, selector),
  useConnectionStore: (selector: (s: unknown) => unknown) => selector({ jid: 'romeo@montague.example/phone', ownAvatar: null, ownNickname: null }),
}))
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (k: string) => k, i18n: { language: 'en' } }),
}))
vi.mock('@/hooks/useSavedOpener', () => ({ useSavedOpener: () => ({ open, problems: {} }) }))
vi.mock('@/hooks', () => ({
  useMode: () => ({ resolvedMode: 'dark' }),
  useWindowDrag: () => ({ dragRegionProps: {} }),
}))
// The read-only list is the search preview's own and is tested there: stand in for it here.
vi.mock('./SearchContextView', () => ({
  chatSearchContextRowId: (m: { id: string }) => m.id,
  mergeContextMessages: (before: unknown[], after: unknown[]) => [...before, ...after],
  useScrollToContextTarget: vi.fn(),
  SearchContextMessageList: (props: { messages: { id: string; body: string }[]; highlightedMessage: { id: string }; onHighlightedClick: () => void }) => (
    <div data-testid="context-list" data-highlighted={props.highlightedMessage.id}>
      {props.messages.map((m) => <p key={m.id}>{m.body}</p>)}
      <button type="button" onClick={props.onHighlightedClick}>highlighted</button>
    </div>
  ),
}))

import { SavedPane } from './SavedPane'
import { useSavedScopeStore, useSavedSelectionStore } from '@/stores/savedScopeStore'

const entry = (id: string, extra: Partial<SavedMessage> = {}): SavedMessage => ({
  id, conversationJid: 'juliet@capulet.example', type: 'chat', from: 'juliet@capulet.example/balcony',
  text: `text ${id}`, savedAt: 1000, sentAt: 500, messageId: `m-${id}`, stanzaId: `s-${id}`, ...extra,
})
const cached = (id: string, body: string, timestamp: number) => ({
  id, from: 'juliet@capulet.example/balcony', body, timestamp: new Date(timestamp), conversationId: 'juliet@capulet.example', type: 'chat',
})

describe('SavedPane', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    savedStore.getState().reset()
    useSavedScopeStore.getState().setScope(null)
    useSavedSelectionStore.getState().select(null)
    latestCopy.mockResolvedValue(undefined)
    readChat.mockResolvedValue([])
  })

  it('explains how to save a message, and no longer asks to select one, when nothing is saved', () => {
    render(<SavedPane />)
    expect(screen.getByTestId('saved-zero-pane')).toBeInTheDocument()
    expect(screen.getByText('saved.emptyHint')).toBeInTheDocument()
    expect(screen.getByText('saved.factPrivate')).toBeInTheDocument()
    expect(screen.queryByTestId('saved-preview')).toBeNull()
  })

  it('keeps the unlock explanation while sealed entries wait for the key', () => {
    savedStore.setState({ lockedIds: { x: true } })
    render(<SavedPane />)
    expect(screen.getByTestId('saved-locked-pane')).toHaveTextContent('saved.lockedHint')
    expect(screen.queryByTestId('saved-zero-pane')).toBeNull()
  })

  it('opens the newest saved message among its neighbours from the cache, with Go to message', async () => {
    savedStore.setState({ entries: { a: entry('a', { savedAt: 1000 }), b: entry('b', { savedAt: 3000, messageId: 'm-b' }) } })
    latestCopy.mockResolvedValue(cached('m-b', 'the saved one', 500))
    readChat.mockImplementation(async (_jid: string, options: { before?: Date }) =>
      options.before ? [cached('m-0', 'what came before', 400)] : [cached('m-b', 'the saved one', 500)])
    render(<SavedPane />)
    const list = await screen.findByTestId('context-list')
    expect(list).toHaveAttribute('data-highlighted', 'm-b')
    expect(screen.getByText('what came before')).toBeInTheDocument()
    fireEvent.click(screen.getByText('search.goToMessage'))
    expect(open).toHaveBeenCalledWith(expect.objectContaining({ id: 'b' }))
    open.mockClear()
    fireEvent.click(screen.getByText('highlighted'))
    expect(open).toHaveBeenCalledWith(expect.objectContaining({ id: 'b' }))
  })

  it('shows the selected entry instead of the newest', async () => {
    savedStore.setState({ entries: { a: entry('a', { savedAt: 1000 }), b: entry('b', { savedAt: 3000 }) } })
    useSavedSelectionStore.getState().select('a')
    latestCopy.mockImplementation(async (e: SavedMessage) => cached(e.messageId ?? '', `copy ${e.id}`, 500))
    readChat.mockImplementation(async (_jid: string, options: { before?: Date }) => options.before ? [] : [cached('m-a', 'copy a', 500)])
    render(<SavedPane />)
    expect(await screen.findByTestId('context-list')).toHaveAttribute('data-highlighted', 'm-a')
  })

  it('shows the saved copy alone, joining and reading nothing, when the history is not on this device', async () => {
    savedStore.setState({ entries: { a: entry('a', { text: 'the saved text' }) } })
    render(<SavedPane />)
    expect(await screen.findByTestId('saved-copy-only')).toHaveTextContent('the saved text')
    expect(screen.getByTestId('saved-copy-only')).toHaveTextContent('saved.copyOnly')
    expect(open).not.toHaveBeenCalled()
  })

  it('removes the shown entry and moves on to the next one', async () => {
    savedStore.setState({ entries: { a: entry('a', { savedAt: 1000, text: 'older' }), b: entry('b', { savedAt: 3000, text: 'newer' }) } })
    render(<SavedPane />)
    await screen.findByTestId('saved-copy-only')
    fireEvent.click(screen.getByText('saved.remove'))
    await waitFor(() => expect(screen.getByTestId('saved-copy-only')).toHaveTextContent('older'))
  })
})
