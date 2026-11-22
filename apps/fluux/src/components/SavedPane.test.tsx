import { describe, it, expect, vi, beforeEach } from 'vitest'
import { useStore } from 'zustand'
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react'
import { savedStore, type SavedMessage } from '@fluux/sdk'

const open = vi.fn().mockResolvedValue(undefined)
const latestCopy = vi.fn()
const around = vi.fn()
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
  getMessagesAround: (...args: unknown[]) => around(...args),
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
vi.mock('@/hooks', () => ({
  useMode: () => ({ resolvedMode: 'dark' }),
  useWindowDrag: () => ({ dragRegionProps: {} }),
}))
// The read-only list is the search preview's own and is tested there: stand in for it here.
vi.mock('./SearchContextView', () => ({
  chatSearchContextRowId: (m: { id: string }) => m.id,
  useScrollToContextTarget: vi.fn(),
  SearchContextMessageList: (props: { messages: { id: string; body: string }[]; highlightedMessage: { id: string; stanzaId?: string }; onHighlightedClick: () => void; isHistoryComplete?: boolean }) => (
    <div data-testid="context-list" data-highlighted={props.highlightedMessage.id} data-highlighted-stanza={props.highlightedMessage.stanzaId} data-history-complete={String(!!props.isHistoryComplete)}>
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
    around.mockResolvedValue([])
  })

  it('explains how to save a message, and no longer asks to select one, when nothing is saved', () => {
    render(<SavedPane onOpen={open} />)
    expect(screen.getByTestId('saved-zero-pane')).toBeInTheDocument()
    expect(screen.getByText('saved.emptyHint')).toBeInTheDocument()
    expect(screen.getByText('saved.factPrivate')).toBeInTheDocument()
    expect(screen.queryByTestId('saved-preview')).toBeNull()
  })

  it('keeps the unlock explanation while sealed entries wait for the key', () => {
    savedStore.setState({ lockedIds: { x: true } })
    render(<SavedPane onOpen={open} />)
    expect(screen.getByTestId('saved-locked-pane')).toHaveTextContent('saved.lockedHint')
    expect(screen.queryByTestId('saved-zero-pane')).toBeNull()
  })

  it('opens the newest saved message among its neighbours from the cache, anchored on the cached copy, with Go to message', async () => {
    savedStore.setState({ entries: { a: entry('a', { savedAt: 1000 }), b: entry('b', { savedAt: 3000, messageId: 'm-b' }) } })
    const copy = cached('m-b', 'the saved one', 900)
    latestCopy.mockResolvedValue(copy)
    around.mockResolvedValue([cached('m-0', 'what came before', 400), copy])
    render(<SavedPane onOpen={open} />)
    const list = await screen.findByTestId('context-list')
    expect(list).toHaveAttribute('data-highlighted', 'm-b')
    // A cache-only preview cannot prove where the conversation starts, so it claims no start marker.
    expect(list).toHaveAttribute('data-history-complete', 'false')
    expect(screen.getByText('what came before')).toBeInTheDocument()
    // The window is read around the exact cached row (tied timestamps included), not around the saved time.
    expect(around).toHaveBeenCalledWith('chat', 'juliet@capulet.example', expect.objectContaining({ id: 'm-b' }), expect.objectContaining({ before: 50, after: 50 }))
    fireEvent.click(screen.getByText('search.goToMessage'))
    expect(open).toHaveBeenCalledWith(expect.objectContaining({ id: 'b' }))
    open.mockClear()
    fireEvent.click(screen.getByText('highlighted'))
    expect(open).toHaveBeenCalledWith(expect.objectContaining({ id: 'b' }))
  })

  it('shows the selected entry instead of the newest', async () => {
    savedStore.setState({ entries: { a: entry('a', { savedAt: 1000 }), b: entry('b', { savedAt: 3000 }) } })
    useSavedSelectionStore.getState().select('a')
    const copy = cached('m-a', 'copy a', 500)
    latestCopy.mockResolvedValue(copy)
    around.mockResolvedValue([copy])
    render(<SavedPane onOpen={open} />)
    expect(await screen.findByTestId('context-list')).toHaveAttribute('data-highlighted', 'm-a')
  })

  it.each(['chat', 'groupchat'] as const)('highlights the accepted %s row, not an earlier row that shares its client id', async (type) => {
    savedStore.setState({ entries: { a: entry('a', { type, stanzaId: 'second', messageId: 'shared' }) } })
    const first = { ...cached('shared', 'earlier row, other archive id', 400), stanzaId: 'first' }
    const second = { ...cached('shared', 'accepted row', 500), stanzaId: 'second' }
    latestCopy.mockResolvedValue(second)
    around.mockResolvedValue([first, second])
    render(<SavedPane onOpen={open} />)
    expect(await screen.findByTestId('context-list')).toHaveAttribute('data-highlighted-stanza', 'second')
  })

  it('shows the saved copy alone, joining and reading nothing, when the history is not on this device', async () => {
    savedStore.setState({ entries: { a: entry('a', { text: 'the saved text' }) } })
    render(<SavedPane onOpen={open} />)
    expect(await screen.findByTestId('saved-copy-only')).toHaveTextContent('the saved text')
    expect(screen.getByTestId('saved-copy-only')).toHaveTextContent('saved.copyOnly')
    expect(open).not.toHaveBeenCalled()
  })

  it('never highlights another message that reuses the saved message id: with no accepted copy it shows the saved copy', async () => {
    savedStore.setState({ entries: { a: entry('a', { text: 'the saved text' }) } })
    // findLatestCopy rejects the neighbour (another author or archive id); the cache must not be searched by id.
    around.mockResolvedValue([cached('m-a', 'somebody else, same client id', 500)])
    render(<SavedPane onOpen={open} />)
    expect(await screen.findByTestId('saved-copy-only')).toHaveTextContent('the saved text')
    expect(screen.queryByTestId('context-list')).toBeNull()
    expect(screen.queryByText('somebody else, same client id')).toBeNull()
  })

  it.each(['chat', 'groupchat'] as const)('shows a message deleted in another session as deleted, not its older cached %s text', async (type) => {
    savedStore.setState({ entries: { a: entry('a', { type, deleted: true, text: '' }) } })
    const copy = cached('m-a', 'old plaintext still cached', 500)
    latestCopy.mockResolvedValue(copy)
    around.mockResolvedValue([copy])
    render(<SavedPane onOpen={open} />)
    expect(await screen.findByTestId('saved-copy-only')).toHaveTextContent('saved.deleted')
    expect(screen.queryByText('old plaintext still cached')).toBeNull()
    expect(screen.queryByTestId('context-list')).toBeNull()
  })

  it('reads the context again after a durable edit, without going back to loading', async () => {
    savedStore.setState({ entries: { a: entry('a') } })
    const before = cached('m-a', 'first wording', 500)
    latestCopy.mockResolvedValue(before)
    around.mockResolvedValue([before])
    render(<SavedPane onOpen={open} />)
    expect(await screen.findByText('first wording')).toBeInTheDocument()
    const edited = cached('m-a', 'edited wording', 500)
    latestCopy.mockResolvedValue(edited)
    around.mockResolvedValue([edited])
    act(() => { savedStore.setState((state) => ({ copyVersion: state.copyVersion + 1 })) })
    expect(await screen.findByText('edited wording')).toBeInTheDocument()
    expect(screen.queryByText('first wording')).toBeNull()
    expect(screen.queryByText('search.loadingContext')).toBeNull()
  })

  it('removes the shown entry and moves on to the next one', async () => {
    savedStore.setState({ entries: { a: entry('a', { savedAt: 1000, text: 'older' }), b: entry('b', { savedAt: 3000, text: 'newer' }) } })
    render(<SavedPane onOpen={open} />)
    await screen.findByTestId('saved-copy-only')
    fireEvent.click(screen.getByText('saved.remove'))
    await waitFor(() => expect(screen.getByTestId('saved-copy-only')).toHaveTextContent('older'))
  })
})
