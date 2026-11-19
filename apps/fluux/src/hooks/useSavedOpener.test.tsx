import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import type { SavedMessage } from '@fluux/sdk'

const locateChat = vi.fn()
const fetchContextAround = vi.fn()
const findLatestCopy = vi.fn()
const navigateToConversation = vi.fn()
const navigateToRoom = vi.fn()
const openRoomLink = vi.fn()
const addToast = vi.fn()

vi.mock('@fluux/sdk', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@fluux/sdk')>()),
  connectionStore: { getState: () => ({ jid: 'romeo@montague.example/phone' }) },
  findLatestCopy: (...args: unknown[]) => findLatestCopy(...args),
  useXMPPContext: () => ({ client: { messages: { locateChatMessage: locateChat, fetchContextAround } } }),
}))
vi.mock('./useNavigateToTarget', () => ({ useNavigateToTarget: () => ({ navigateToConversation, navigateToRoom }) }))
vi.mock('./useRoomMessageLink', () => ({ useRoomMessageLink: () => openRoomLink }))
vi.mock('@/stores/toastStore', () => ({ useToastStore: (selector: (s: unknown) => unknown) => selector({ addToast }) }))
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (k: string) => k }) }))

import { useSavedOpener } from './useSavedOpener'

const ROOM = 'team@conference.example'
const chatEntry = (extra: Partial<SavedMessage> = {}): SavedMessage => ({
  id: 'a', conversationJid: 'juliet@capulet.example', type: 'chat', from: 'juliet@capulet.example', text: 't', savedAt: 1,
  sentAt: 500, messageId: 'm1', stanzaId: 's1', stanzaIdBy: 'romeo@montague.example', ...extra,
})
const roomEntry = (extra: Partial<SavedMessage> = {}): SavedMessage => ({
  id: 'r', conversationJid: ROOM, type: 'groupchat', from: `${ROOM}/Alice`, text: 't', savedAt: 1, sentAt: 500, messageId: 'rm1', occupantId: 'occ', ...extra,
})

describe('useSavedOpener', () => {
  beforeEach(() => { vi.clearAllMocks(); findLatestCopy.mockResolvedValue(undefined) })

  it('opens a found one-to-one message in its conversation', async () => {
    locateChat.mockResolvedValue({ kind: 'found', message: { id: 'real' } })
    const { result } = renderHook(() => useSavedOpener())
    await act(() => result.current.open(chatEntry()))
    expect(navigateToConversation).toHaveBeenCalledWith('juliet@capulet.example', 'real')
  })

  it('keeps an absent or failed lookup on the entry and clears it on the next try', async () => {
    locateChat.mockResolvedValueOnce({ kind: 'absent' }).mockRejectedValueOnce(new Error('boom')).mockResolvedValueOnce({ kind: 'found', message: { id: 'x' } })
    const { result } = renderHook(() => useSavedOpener())
    await act(() => result.current.open(chatEntry()))
    expect(result.current.problems).toEqual({ a: 'absent' })
    await act(() => result.current.open(chatEntry()))
    expect(result.current.problems).toEqual({ a: 'failed' })
    await act(() => result.current.open(chatEntry()))
    expect(result.current.problems).toEqual({})
  })

  it('opens a room entry with an archive id through the room link', async () => {
    const { result } = renderHook(() => useSavedOpener())
    await act(() => result.current.open(roomEntry({ stanzaId: 'rs1', stanzaIdBy: ROOM })))
    expect(openRoomLink).toHaveBeenCalledWith({ roomJid: ROOM, stanzaId: 'rs1' }, expect.any(Function))
  })

  it('opens a room entry without an archive id from the cached copy, even when it was evicted from memory', async () => {
    findLatestCopy.mockResolvedValue({ id: 'rm1', stanzaId: 'cached-sid', roomJid: ROOM })
    const { result } = renderHook(() => useSavedOpener())
    await act(() => result.current.open(roomEntry()))
    expect(openRoomLink).toHaveBeenCalledWith({ roomJid: ROOM, stanzaId: 'cached-sid' }, expect.any(Function))
  })

  it('looks a room entry without an archive id up by its time when no copy is cached, and says unknown on an incomplete answer', async () => {
    fetchContextAround.mockResolvedValue({ messages: [], complete: false })
    const { result } = renderHook(() => useSavedOpener())
    await act(() => result.current.open(roomEntry()))
    expect(fetchContextAround).toHaveBeenCalledWith(ROOM, new Date(500).toISOString(), 50)
    expect(result.current.problems).toEqual({ r: 'failed' })
    fetchContextAround.mockResolvedValue({ messages: [], complete: true })
    await act(() => result.current.open(roomEntry()))
    expect(result.current.problems).toEqual({ r: 'absent' })
  })
})
