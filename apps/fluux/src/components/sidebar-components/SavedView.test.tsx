import { describe, it, expect, vi, beforeEach } from 'vitest'
import { useStore } from 'zustand'
import { render, screen, fireEvent, within, waitFor, act } from '@testing-library/react'
import { savedStore, type SavedMessage } from '@fluux/sdk'

type SavedState = ReturnType<typeof savedStore.getState>

const open = vi.fn().mockResolvedValue(undefined)
const latestCopy = vi.fn().mockResolvedValue(undefined)
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
  findLatestCopy: (...args: unknown[]) => latestCopy(...args),
}))
vi.mock('@fluux/sdk/react', () => ({
  useChatStore: (selector: (s: unknown) => unknown) => selector({ messages: new Map() }),
  useRoomStore: (selector: (s: unknown) => unknown) => selector({ messages: new Map(), rooms: new Map() }),
  useRosterStore: (selector: (s: unknown) => unknown) => selector({ contacts: new Map() }),
  useSavedStore: (selector: (s: SavedState) => unknown) => useStore(savedStore, selector),
}))
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (k: string) => k, i18n: { language: 'en' } }),
}))

import { SavedView } from './SavedView'
import { useSavedScopeStore } from '@/stores/savedScopeStore'

const entry = (id: string, extra: Partial<SavedMessage> = {}): SavedMessage => ({
  id, conversationJid: 'juliet@capulet.example', type: 'chat', from: 'juliet@capulet.example/balcony',
  text: `text ${id}`, savedAt: 1000, sentAt: 500, messageId: `m-${id}`, stanzaId: `s-${id}`, ...extra,
})

describe('SavedView', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    savedStore.getState().reset()
    useSavedScopeStore.getState().setScope(null)
  })

  it('shows the empty state when nothing is saved', () => {
    render(<SavedView problems={{}} onOpen={open} />)
    expect(screen.getByText('saved.empty')).toBeInTheDocument()
    expect(screen.getByText('saved.emptyHint')).toBeInTheDocument()
    expect(screen.queryByTestId('saved-list')).toBeNull()
  })

  it('lists entries newest saved first with encrypted and deleted text', () => {
    savedStore.setState({ entries: {
      a: entry('a', { savedAt: 1000 }),
      b: entry('b', { savedAt: 3000, text: '', encrypted: true }),
      c: entry('c', { savedAt: 2000, text: '', deleted: true }),
    } })
    render(<SavedView problems={{}} onOpen={open} />)
    const rows = screen.getAllByTestId('saved-row')
    expect(rows.map((r) => r.getAttribute('data-saved-id'))).toEqual(['b', 'c', 'a'])
    expect(within(rows[0]).getByTestId('saved-text')).toHaveTextContent('saved.encrypted')
    expect(within(rows[1]).getByTestId('saved-text')).toHaveTextContent('saved.deleted')
    expect(within(rows[2]).getByTestId('saved-text')).toHaveTextContent('text a')
  })

  it('removes an entry from its row', () => {
    savedStore.setState({ entries: { a: entry('a') } })
    render(<SavedView problems={{}} onOpen={open} />)
    fireEvent.click(screen.getByLabelText('saved.remove'))
    expect(savedStore.getState().entries.a).toBeUndefined()
    expect(open).not.toHaveBeenCalled()
  })

  it('opens an entry from its row, but not from the keyboard on its Remove button', () => {
    savedStore.setState({ entries: { a: entry('a') } })
    render(<SavedView problems={{}} onOpen={open} />)
    fireEvent.keyDown(screen.getByLabelText('saved.remove'), { key: 'Enter' })
    expect(open).not.toHaveBeenCalled()
    fireEvent.keyDown(screen.getByTestId('saved-row'), { key: 'Enter' })
    expect(open).toHaveBeenCalledWith(expect.objectContaining({ id: 'a' }))
  })

  it('shows a failed open on its row and offers Try again only for a failed lookup', () => {
    savedStore.setState({ entries: { a: entry('a'), b: entry('b') } })
    render(<SavedView problems={{ a: 'absent', b: 'failed' }} onOpen={open} />)
    const rows = screen.getAllByTestId('saved-row')
    const byId = (id: string) => rows.find((r) => r.getAttribute('data-saved-id') === id)!
    expect(within(byId('a')).getByText('chat.linkedMessageUnavailable')).toBeInTheDocument()
    expect(within(byId('a')).queryByText('saved.tryAgain')).toBeNull()
    fireEvent.click(within(byId('b')).getByText('saved.tryAgain'))
    expect(open).toHaveBeenCalledWith(expect.objectContaining({ id: 'b' }))
  })

  it('shows the latest cached copy, a deletion that arrived meanwhile, and a text-less message as an attachment', async () => {
    savedStore.setState({ entries: {
      a: entry('a', { savedAt: 3000 }),
      b: entry('b', { savedAt: 2000 }),
      c: entry('c', { savedAt: 1000, text: '' }),
    } })
    latestCopy.mockImplementation(async (e: SavedMessage) => (e.id === 'a' ? { body: 'edited a' } : e.id === 'b' ? { isRetracted: true } : undefined))
    render(<SavedView problems={{}} onOpen={open} />)
    await waitFor(() => expect(screen.getAllByTestId('saved-text').map((n) => n.textContent)).toEqual(['edited a', 'saved.deleted', 'chat.attachment']))
  })

  it('reads the stored copy again when one was durably edited while it was not resident', async () => {
    savedStore.setState({ entries: { a: entry('a') } })
    latestCopy.mockResolvedValue(undefined)
    render(<SavedView problems={{}} onOpen={open} />)
    await waitFor(() => expect(screen.getByTestId('saved-text').textContent).toBe('text a'))
    latestCopy.mockResolvedValue({ body: 'edited later' })
    act(() => { savedStore.setState((state) => ({ copyVersion: state.copyVersion + 1 })) })
    await waitFor(() => expect(screen.getByTestId('saved-text').textContent).toBe('edited later'))
  })

  it('shows the text of an encrypted entry that was sealed with it, and the placeholder when there is none', () => {
    savedStore.setState({ entries: {
      a: entry('a', { text: 'the decrypted words', encrypted: true }),
      b: entry('b', { text: '', encrypted: true, savedAt: 500 }),
    } })
    render(<SavedView problems={{}} onOpen={open} />)
    const rows = screen.getAllByTestId('saved-row')
    expect(within(rows[0]).getByTestId('saved-text')).toHaveTextContent('the decrypted words')
    expect(within(rows[1]).getByTestId('saved-text')).toHaveTextContent('saved.encrypted')
  })

  it('shows a locked state, not an empty list, while sealed entries wait for the key', () => {
    savedStore.setState({ lockedIds: { s1: true, s2: true } })
    render(<SavedView problems={{}} onOpen={open} />)
    expect(screen.getByText('saved.locked')).toBeInTheDocument()
    expect(screen.getByText('saved.lockedHint')).toBeInTheDocument()
    expect(screen.queryByText('saved.empty')).toBeNull()
  })

  it('marks an entry nothing proves the account key wrote', () => {
    savedStore.setState({ entries: { a: entry('a', { unverified: true }), b: entry('b', { savedAt: 10 }) } })
    render(<SavedView problems={{}} onOpen={open} />)
    const rows = screen.getAllByTestId('saved-row')
    expect(within(rows[0]).getByTestId('saved-unverified')).toBeInTheDocument()
    expect(within(rows[1]).queryByTestId('saved-unverified')).toBeNull()
  })

  describe('narrowed to one conversation', () => {
    const room = (id: string) => entry(id, { conversationJid: 'team@conference.example', type: 'groupchat', from: 'team@conference.example/Alice' })

    it('lists only that conversation with its chip, the private note and no conversation line, and clears back to all', () => {
      savedStore.setState({ entries: { a: room('a'), b: entry('b'), c: room('c') } })
      useSavedScopeStore.getState().setScope('team@conference.example')
      render(<SavedView problems={{}} onOpen={open} />)
      const rows = screen.getAllByTestId('saved-row')
      expect(rows.map((r) => r.getAttribute('data-saved-id')).sort()).toEqual(['a', 'c'])
      expect(screen.getByTestId('saved-scope')).toHaveTextContent('saved.scopeLabel')
      expect(screen.getByTestId('saved-private-note')).toHaveTextContent('saved.onlyYou')
      expect(screen.queryByTestId('saved-conversation')).toBeNull()

      fireEvent.click(screen.getByLabelText('saved.clearScope'))
      expect(screen.getAllByTestId('saved-row')).toHaveLength(3)
      expect(screen.queryByTestId('saved-scope')).toBeNull()
      expect(screen.queryByTestId('saved-private-note')).toBeNull()
      expect(screen.getAllByTestId('saved-conversation')).toHaveLength(2)
    })

    it('opens a row of the narrowed list', () => {
      savedStore.setState({ entries: { a: room('a'), b: entry('b') } })
      useSavedScopeStore.getState().setScope('team@conference.example')
      render(<SavedView problems={{}} onOpen={open} />)
      fireEvent.click(screen.getByTestId('saved-row'))
      expect(open).toHaveBeenCalledWith(expect.objectContaining({ id: 'a' }))
    })

    it('falls back to the full list once the conversation has nothing saved', async () => {
      savedStore.setState({ entries: { b: entry('b') } })
      useSavedScopeStore.getState().setScope('team@conference.example')
      render(<SavedView problems={{}} onOpen={open} />)
      expect(screen.getAllByTestId('saved-row')).toHaveLength(1)
      expect(screen.queryByTestId('saved-scope')).toBeNull()
      await waitFor(() => expect(useSavedScopeStore.getState().conversationJid).toBeNull())
    })
  })
})
