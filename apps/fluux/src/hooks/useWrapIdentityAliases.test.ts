import 'fake-indexeddb/auto'
import { describe, it, expect, beforeEach } from 'vitest'
import { renderHook } from '@testing-library/react'
import { act } from 'react'
import { chatStore, roomStore } from '@fluux/sdk/stores'
import { saveMessage, saveRoomMessage, clearAllMessages } from '@fluux/sdk/cache'
import type { Message, RoomMessage } from '@fluux/sdk'
import { useWrapIdentityAliases } from './useWrapIdentityAliases'
import { useWrappedCodeBlocksStore } from '@/stores/wrappedCodeBlocksStore'
import { messageWrapIdentity } from '@/components/conversation/messageRowIdentity'

// Source: captain's choices on review FLM-404 — R3 keep a choice through in-place enrichment, R6/R10
// twins stay separate: a choice that cannot be proven to be the same occurrence is dropped. Driven through the real activation and cache lifecycle
// of both stores: switching evicts the resident list, the cache is enriched, and returning
// hydrates a fresh list.
const at = new Date('2026-01-01T12:00:00Z')
const body = '```\nx\n```'
const dm = (o: Partial<Message> = {}): Message =>
  ({ id: 'm1', type: 'chat', conversationId: 'bob@x.org', from: 'bob@x.org', body, timestamp: at, isOutgoing: false, ...o }) as Message
const roomMsg = (o: Partial<RoomMessage> = {}): RoomMessage =>
  ({ id: 'r1', type: 'groupchat', roomJid: 'room@conf.x.org', from: 'room@conf.x.org/bob', nick: 'bob', body, timestamp: at, isOutgoing: false, ...o }) as RoomMessage
const wrapped = (m: Message | RoomMessage) => useWrappedCodeBlocksStore.getState().isWrapped(messageWrapIdentity(m)!, 0)
const toggle = (m: Message | RoomMessage) => act(() => useWrappedCodeBlocksStore.getState().toggle(messageWrapIdentity(m)!, 0))

describe('useWrapIdentityAliases', () => {
  beforeEach(async () => {
    await clearAllMessages()
    useWrappedCodeBlocksStore.getState().clear()
    chatStore.setState({ messages: new Map(), activeConversationId: null })
    roomStore.setState({ messages: new Map(), activeRoomJid: null })
  })

  it('chat: an enrichment applied in place to the resident list keeps the choice, twin stays apart', () => {
    renderHook(() => useWrapIdentityAliases())
    const original = dm()
    const twin = dm({ stanzaId: 'B' })
    act(() => { chatStore.setState({ messages: new Map([['bob@x.org', [dm({ id: 'm0' }), original, dm({ id: 'm2' })]]]) }) })
    toggle(original)
    act(() => { chatStore.setState({ messages: new Map([['bob@x.org', [dm({ id: 'm0' }), dm({ stanzaId: 'A', originId: 'o1' }), dm({ id: 'm2' })]]]) }) })
    expect(wrapped(dm({ stanzaId: 'A', originId: 'o1' }))).toBe(true)
    expect(wrapped(twin)).toBe(false)
  })

  it('room: an in-place enrichment keeps the choice', () => {
    renderHook(() => useWrapIdentityAliases())
    const original = roomMsg()
    act(() => { roomStore.setState({ messages: new Map([['room@conf.x.org', [original]]]) }) })
    toggle(original)
    act(() => { roomStore.setState({ messages: new Map([['room@conf.x.org', [roomMsg({ stanzaId: 'A' })]]]) }) })
    expect(wrapped(roomMsg({ stanzaId: 'A' }))).toBe(true)
  })

  it('chat: wrap → switch chat → cache enriched → return drops the choice instead of guessing', async () => {
    renderHook(() => useWrapIdentityAliases())
    const original = dm()
    await saveMessage(original)
    await act(async () => { await chatStore.getState().activateConversation('bob@x.org') })
    toggle(original)
    await act(async () => { await chatStore.getState().activateConversation('carol@x.org') })
    expect(chatStore.getState().messages.get('bob@x.org')).toBeUndefined()
    await saveMessage(dm({ stanzaId: 'A', originId: 'o1' }))
    await act(async () => { await chatStore.getState().activateConversation('bob@x.org') })
    const returned = (chatStore.getState().messages.get('bob@x.org') ?? []).find((m) => m.stanzaId === 'A')
    expect(returned).toBeDefined()
    expect(wrapped(returned!)).toBe(false)
  })

  it('room: wrap → switch room → cache enriched → return drops the choice instead of guessing', async () => {
    renderHook(() => useWrapIdentityAliases())
    const original = roomMsg()
    for (const jid of ['room@conf.x.org', 'other@conf.x.org']) {
      act(() => roomStore.getState().addRoom({ jid, name: jid, nickname: 'me', joined: true, isBookmarked: false, occupants: new Map(), messages: [], unreadCount: 0, mentionsCount: 0, typingUsers: new Set() } as never))
    }
    await saveRoomMessage(original)
    await act(async () => { await roomStore.getState().activateRoom('room@conf.x.org') })
    toggle(original)
    await act(async () => { await roomStore.getState().activateRoom('other@conf.x.org') })
    await saveRoomMessage(roomMsg({ stanzaId: 'A', originId: 'o1' }))
    await act(async () => { await roomStore.getState().activateRoom('room@conf.x.org') })
    const returned = (roomStore.getState().messages.get('room@conf.x.org') ?? []).find((m) => m.stanzaId === 'A')
    expect(returned).toBeDefined()
    expect(wrapped(returned!)).toBe(false)
  })

  it('equal-length replacement [A, X] to [B, Y] does not give A\'s choice to its twin B', () => {
    renderHook(() => useWrapIdentityAliases())
    const original = dm()
    act(() => { chatStore.setState({ messages: new Map([['bob@x.org', [original, dm({ id: 'x' })]]]) }) })
    toggle(original)
    act(() => { chatStore.setState({ messages: new Map([['bob@x.org', [dm({ stanzaId: 'B' }), dm({ id: 'y' })]]]) }) })
    expect(wrapped(dm({ stanzaId: 'B' }))).toBe(false)
  })

  it('room: equal-length replacement does not give the choice to a twin', () => {
    renderHook(() => useWrapIdentityAliases())
    const original = roomMsg()
    act(() => { roomStore.setState({ messages: new Map([['room@conf.x.org', [original, roomMsg({ id: 'x' })]]]) }) })
    toggle(original)
    act(() => { roomStore.setState({ messages: new Map([['room@conf.x.org', [roomMsg({ stanzaId: 'B' }), roomMsg({ id: 'y' })]]]) }) })
    expect(wrapped(roomMsg({ stanzaId: 'B' }))).toBe(false)
  })

  it('a remembered twin that later gains an origin id, returning alone, does not inherit the choice (R10)', () => {
    renderHook(() => useWrapIdentityAliases())
    const original = dm()
    const twin = dm({ stanzaId: 'B' })
    act(() => { chatStore.setState({ messages: new Map([['bob@x.org', [original, twin]]]) }) })
    toggle(original)
    act(() => { chatStore.setState({ messages: new Map() }) })
    act(() => { chatStore.setState({ messages: new Map([['bob@x.org', [dm({ stanzaId: 'B', originId: 'oB' })]]]) }) })
    expect(wrapped(dm({ stanzaId: 'B', originId: 'oB' }))).toBe(false)
    expect(wrapped(original)).toBe(true)
  })

  it('stops following the stores once unmounted', () => {
    const { unmount } = renderHook(() => useWrapIdentityAliases())
    const original = dm()
    act(() => { chatStore.setState({ messages: new Map([['bob@x.org', [original]]]) }) })
    toggle(original)
    unmount()
    act(() => { chatStore.setState({ messages: new Map([['bob@x.org', [dm({ stanzaId: 'A' })]]]) }) })
    expect(wrapped(dm({ stanzaId: 'A' }))).toBe(false)
  })
})
