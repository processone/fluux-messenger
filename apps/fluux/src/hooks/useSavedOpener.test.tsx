import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { roomStore, type SavedMessage } from '@fluux/sdk'

const locateChat = vi.fn()
const fetchContextAround = vi.fn()
const findLatestCopy = vi.fn()
const navigateToConversation = vi.fn()
const navigateToRoom = vi.fn()
const openRoomLink = vi.fn()
const addToast = vi.fn()
const account = { jid: 'romeo@montague.example/phone' }

vi.mock('@fluux/sdk', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@fluux/sdk')>()),
  connectionStore: { getState: () => ({ jid: account.jid }), subscribe: () => () => {} },
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
  const room = (joined: boolean) => ({ jid: ROOM, name: 'team', nickname: 'romeo', joined, isBookmarked: false, occupants: new Map(), unreadCount: 0, mentionsCount: 0, typingUsers: new Set<string>() })
  beforeEach(() => {
    vi.clearAllMocks()
    account.jid = 'romeo@montague.example/phone'
    findLatestCopy.mockResolvedValue(undefined)
    roomStore.getState().reset()
    roomStore.getState().addRoom(room(true))
  })

  it('passes the author to the one-to-one lookup', async () => {
    locateChat.mockResolvedValue({ kind: 'found', message: { id: 'real' } })
    const { result } = renderHook(() => useSavedOpener())
    await act(() => result.current.open(chatEntry()))
    expect(locateChat).toHaveBeenCalledWith('juliet@capulet.example', expect.objectContaining({ from: 'juliet@capulet.example' }))
  })

  it('joins an unknown room before asking its archive, then looks the message up', async () => {
    roomStore.getState().reset()
    fetchContextAround.mockResolvedValue({ messages: [], complete: true })
    const { result } = renderHook(() => useSavedOpener())
    let done: Promise<void> | undefined
    act(() => { done = result.current.open(roomEntry()) })
    await act(async () => { await Promise.resolve() })
    expect(navigateToRoom).toHaveBeenCalledWith(ROOM)
    expect(fetchContextAround).not.toHaveBeenCalled()
    await act(async () => { roomStore.getState().updateRoom(ROOM, { joined: true }); await done })
    expect(fetchContextAround).toHaveBeenCalledWith(ROOM, new Date(500).toISOString(), 50)
    expect(result.current.problems).toEqual({ r: 'absent' })
  })

  it('does not navigate for a lookup that finished after a newer open', async () => {
    let release: (value: unknown) => void = () => {}
    locateChat.mockReturnValueOnce(new Promise((resolve) => { release = resolve })).mockResolvedValueOnce({ kind: 'found', message: { id: 'second' } })
    const { result } = renderHook(() => useSavedOpener())
    let first: Promise<void> | undefined
    act(() => { first = result.current.open(chatEntry({ id: 'a' })) })
    await act(() => result.current.open(chatEntry({ id: 'b', messageId: 'm2' })))
    await act(async () => { release({ kind: 'found', message: { id: 'first' } }); await first })
    expect(navigateToConversation).toHaveBeenCalledTimes(1)
    expect(navigateToConversation).toHaveBeenCalledWith('juliet@capulet.example', 'second')
  })

  it('does not navigate when the account changed during the lookup', async () => {
    let release: (value: unknown) => void = () => {}
    locateChat.mockReturnValueOnce(new Promise((resolve) => { release = resolve }))
    const { result } = renderHook(() => useSavedOpener())
    let pending: Promise<void> | undefined
    act(() => { pending = result.current.open(chatEntry()) })
    account.jid = 'other@montague.example/phone'
    await act(async () => { release({ kind: 'found', message: { id: 'late' } }); await pending })
    expect(navigateToConversation).not.toHaveBeenCalled()
  })

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
    expect(openRoomLink).toHaveBeenCalledWith({ roomJid: ROOM, stanzaId: 'rs1' }, expect.any(Function), expect.any(Function))
  })

  it('opens a room entry without an archive id from the cached copy, even when it was evicted from memory', async () => {
    findLatestCopy.mockResolvedValue({ id: 'rm1', stanzaId: 'cached-sid', roomJid: ROOM })
    const { result } = renderHook(() => useSavedOpener())
    await act(() => result.current.open(roomEntry()))
    expect(openRoomLink).toHaveBeenCalledWith({ roomJid: ROOM, stanzaId: 'cached-sid' }, expect.any(Function), expect.any(Function))
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

  it('registers a room the list no longer holds before opening its cached copy that has no archive id', async () => {
    roomStore.getState().reset()
    findLatestCopy.mockResolvedValue({ id: 'rm1', roomJid: ROOM, nick: 'Alice' })
    const { result } = renderHook(() => useSavedOpener())
    await act(() => result.current.open(roomEntry()))
    expect(roomStore.getState().rooms.get(ROOM)).toBeDefined()
    expect(navigateToRoom).toHaveBeenCalledWith(ROOM, expect.anything())
  })

  it('tells the room link a newer open took over, so its late success never navigates', async () => {
    locateChat.mockResolvedValue({ kind: 'found', message: { id: 'real' } })
    const { result } = renderHook(() => useSavedOpener())
    await act(() => result.current.open(roomEntry({ stanzaId: 'rs1', stanzaIdBy: ROOM })))
    const owns = openRoomLink.mock.calls[0][2] as () => boolean
    expect(owns()).toBe(true)
    await act(() => result.current.open(chatEntry()))
    expect(owns()).toBe(false)
  })
})
