import 'fake-indexeddb/auto'
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { renderHook } from '@testing-library/react'
import { act } from 'react'
import { chatStore, roomStore } from '@fluux/sdk/stores'
import { saveMessage, saveRoomMessage, clearAllMessages } from '@fluux/sdk/cache'
import type { Message, RoomMessage } from '@fluux/sdk'
import { useWrapIdentityAliases, reconcileWrapChoices } from './useWrapIdentityAliases'
import { useWrappedCodeBlocksStore } from '@/stores/wrappedCodeBlocksStore'
import { messageWrapIdentity } from '@/components/conversation/messageRowIdentity'

// Source: captain's choice on review FLM-404 R3 — wrap, switch chat, enrichment, return keeps the
// choice; look-alike twins stay apart (R6). Driven through the real activation and cache lifecycle
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

  it('chat: wrap → switch chat → cache enriched → return keeps the choice on the original only', async () => {
    renderHook(() => useWrapIdentityAliases())
    const original = dm()
    const twin = dm({ stanzaId: 'B' })
    await saveMessage(original)
    await act(async () => { await chatStore.getState().activateConversation('bob@x.org') })
    expect(chatStore.getState().messages.get('bob@x.org')).toHaveLength(1)
    toggle(original)
    expect(wrapped(original)).toBe(true)

    // Switching evicts the resident list; nothing is on screen while the archive supplies ids.
    await act(async () => { await chatStore.getState().activateConversation('carol@x.org') })
    expect(chatStore.getState().messages.get('bob@x.org')).toBeUndefined()
    await saveMessage(dm({ stanzaId: 'A', originId: 'o1' }))

    await act(async () => { await chatStore.getState().activateConversation('bob@x.org') })
    const resident = chatStore.getState().messages.get('bob@x.org') ?? []
    const returned = resident.find((m) => m.stanzaId === 'A')
    expect(returned).toBeDefined()
    expect(wrapped(returned!)).toBe(true)
    expect(wrapped(twin)).toBe(false)
  })

  it('room: wrap → switch room → cache enriched → return keeps the choice', async () => {
    renderHook(() => useWrapIdentityAliases())
    const original = roomMsg()
    for (const jid of ['room@conf.x.org', 'other@conf.x.org']) {
      act(() => roomStore.getState().addRoom({ jid, name: jid, nickname: 'me', joined: true, isBookmarked: false, occupants: new Map(), messages: [], unreadCount: 0, mentionsCount: 0, typingUsers: new Set() } as never))
    }
    await saveRoomMessage(original)
    await act(async () => { await roomStore.getState().activateRoom('room@conf.x.org') })
    expect(roomStore.getState().messages.get('room@conf.x.org')).toHaveLength(1)
    toggle(original)

    await act(async () => { await roomStore.getState().activateRoom('other@conf.x.org') })
    expect(roomStore.getState().messages.get('room@conf.x.org') ?? []).toHaveLength(0)
    await saveRoomMessage(roomMsg({ stanzaId: 'A', originId: 'o1' }))

    await act(async () => { await roomStore.getState().activateRoom('room@conf.x.org') })
    const returned = (roomStore.getState().messages.get('room@conf.x.org') ?? []).find((m) => m.stanzaId === 'A')
    expect(returned).toBeDefined()
    expect(wrapped(returned!)).toBe(true)
  })

  it('keeps twins apart across eviction when the twin was seen beside the original', () => {
    renderHook(() => useWrapIdentityAliases())
    const original = dm()
    const twin = dm({ stanzaId: 'B' })
    act(() => { chatStore.setState({ messages: new Map([['bob@x.org', [original, twin]]]) }) })
    toggle(original)
    act(() => { chatStore.setState({ messages: new Map() }) })
    act(() => { chatStore.setState({ messages: new Map([['bob@x.org', [twin, dm({ stanzaId: 'A' })]]]) }) })
    expect(wrapped(dm({ stanzaId: 'A' }))).toBe(true)
    expect(wrapped(twin)).toBe(false)
  })

  it('does no list walk for a conversation with nothing wrapped', () => {
    const touched = vi.fn()
    const messages = new Proxy([dm(), dm({ id: 'm2' })], { get: (t, k, r) => { if (k === Symbol.iterator) touched(); return Reflect.get(t, k, r) } })
    reconcileWrapChoices('bob@x.org', messages)
    expect(touched).not.toHaveBeenCalled()
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
