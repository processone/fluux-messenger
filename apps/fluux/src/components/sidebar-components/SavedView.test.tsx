import { describe, it, expect, vi, beforeEach } from 'vitest'
import { useStore } from 'zustand'
import { render, screen, fireEvent, within, waitFor } from '@testing-library/react'
import { savedStore, type SavedMessage } from '@fluux/sdk'

const locate = vi.fn()
const navigateToConversation = vi.fn()
vi.mock('@fluux/sdk', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@fluux/sdk')>()),
  connectionStore: { getState: () => ({ jid: 'romeo@montague.example/phone' }) },
  chatStore: { getState: () => ({ conversationEntities: new Map() }) },
  roomStore: { getState: () => ({ getMessage: () => undefined }) },
  useSavedMessages: () => {
    const entries = useStore(savedStore, (s) => s.entries)
    const saved = Object.values(entries).sort((a, b) => b.savedAt - a.savedAt)
    return { saved, remove: (id: string) => savedStore.getState().remove(id) }
  },
  useXMPPContext: () => ({ client: { messages: { locateChatMessage: locate } } }),
}))
vi.mock('@fluux/sdk/react', () => ({
  useChatStore: (selector: (s: unknown) => unknown) => selector({ getMessage: () => undefined }),
  useRoomStore: (selector: (s: unknown) => unknown) => selector({ getMessage: () => undefined, rooms: new Map() }),
  useRosterStore: (selector: (s: unknown) => unknown) => selector({ contacts: new Map() }),
}))
vi.mock('@/hooks/useNavigateToTarget', () => ({
  useNavigateToTarget: () => ({ navigateToConversation, navigateToRoom: vi.fn() }),
}))
vi.mock('@/hooks/useRoomMessageLink', () => ({ useRoomMessageLink: () => vi.fn() }))
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (k: string) => k, i18n: { language: 'en' } }),
}))

import { SavedView } from './SavedView'

const entry = (id: string, extra: Partial<SavedMessage> = {}): SavedMessage => ({
  id, conversationJid: 'juliet@capulet.example', type: 'chat', from: 'juliet@capulet.example/balcony',
  text: `text ${id}`, savedAt: 1000, sentAt: 500, messageId: `m-${id}`, stanzaId: `s-${id}`, ...extra,
})

describe('SavedView', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    savedStore.getState().reset()
  })

  it('shows the empty state when nothing is saved', () => {
    render(<SavedView />)
    expect(screen.getByText('saved.empty')).toBeInTheDocument()
    expect(screen.getByText('saved.emptyHint')).toBeInTheDocument()
    expect(screen.queryByTestId('saved-list')).toBeNull()
  })

  it('lists entries newest saved first with encrypted and deleted text', () => {
    savedStore.setState({ entries: {
      a: entry('a', { savedAt: 1000 }),
      b: entry('b', { savedAt: 3000, text: '', encrypted: true }),
      c: entry('c', { savedAt: 2000, text: '' }),
    } })
    render(<SavedView />)
    const rows = screen.getAllByTestId('saved-row')
    expect(rows.map((r) => r.getAttribute('data-saved-id'))).toEqual(['b', 'c', 'a'])
    expect(within(rows[0]).getByTestId('saved-text')).toHaveTextContent('saved.encrypted')
    expect(within(rows[1]).getByTestId('saved-text')).toHaveTextContent('saved.deleted')
    expect(within(rows[2]).getByTestId('saved-text')).toHaveTextContent('text a')
  })

  it('removes an entry from its row', () => {
    savedStore.setState({ entries: { a: entry('a') } })
    render(<SavedView />)
    fireEvent.click(screen.getByLabelText('saved.remove'))
    expect(savedStore.getState().entries.a).toBeUndefined()
    expect(locate).not.toHaveBeenCalled()
  })

  it('opens a found one-to-one message in its conversation', async () => {
    locate.mockResolvedValue({ kind: 'found', message: { id: 'real-id' } })
    savedStore.setState({ entries: { a: entry('a') } })
    render(<SavedView />)
    fireEvent.click(screen.getByTestId('saved-row'))
    await waitFor(() => expect(navigateToConversation).toHaveBeenCalledWith('juliet@capulet.example', 'real-id'))
    expect(locate).toHaveBeenCalledWith('juliet@capulet.example', expect.objectContaining({ stanzaId: 's-a', id: 'm-a' }))
  })

  it('flags an absent message and offers Try again after a failed lookup', async () => {
    locate.mockResolvedValueOnce({ kind: 'absent' })
    savedStore.setState({ entries: { a: entry('a') } })
    render(<SavedView />)
    fireEvent.click(screen.getByTestId('saved-row'))
    expect(await screen.findByText('chat.linkedMessageUnavailable')).toBeInTheDocument()
    expect(screen.queryByText('saved.tryAgain')).toBeNull()

    locate.mockRejectedValueOnce(new Error('boom'))
    fireEvent.click(screen.getByTestId('saved-row'))
    fireEvent.click(await screen.findByText('saved.tryAgain'))
    expect(locate).toHaveBeenCalledTimes(3)
  })
})
