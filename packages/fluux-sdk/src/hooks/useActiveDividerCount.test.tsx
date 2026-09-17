/**
 * @vitest-environment happy-dom
 */
import { describe, it, expect, beforeEach } from 'vitest'
import 'fake-indexeddb/auto'
import { IDBFactory } from 'fake-indexeddb'
import { renderHook, act } from '@testing-library/react'
import { useRoomActive } from './useRoomActive'
import { useChatActive } from './useChatActive'
import { chatStore, roomStore, connectionStore } from '../stores'
import { makeReadPointer } from '../stores/shared/readPointer'
import * as messageCache from '../utils/messageCache'
import type { Message, RoomMessage } from '../core/types'
import { wrapper, createConversation, createMessage, createRoom, createRoomMessage } from './renderStability.helpers'

const ROOM = 'room@conference.example.com'
const PEER = 'peer@example.com'
const at = (minute: number) => new Date(Date.UTC(2025, 0, 15, 9, minute))

// The "new messages" divider stays where the view opened it while the viewport moves the read pointer
// under it, and the canonical count follows the pointer. The divider's own count must keep
// describing the rows under the line.
describe('active divider count', () => {
  beforeEach(() => {
    roomStore.setState({
      rooms: new Map(), roomEntities: new Map(), roomMeta: new Map(), roomRuntime: new Map(),
      messages: new Map(), windowAtLiveEdge: new Map(), activeRoomJid: null, mamQueryStates: new Map(),
      firstNewMessageMarkers: new Map(),
    })
    chatStore.setState({
      conversations: new Map(), conversationEntities: new Map(), conversationMeta: new Map(),
      messages: new Map(), activeConversationId: null, mamQueryStates: new Map(),
      firstNewMessageMarkers: new Map(),
    })
  })

  it('room: counts every row under the divider after the pointer passed some of them', () => {
    const messages = Array.from({ length: 10 }, (_, i) =>
      createRoomMessage(ROOM, `Placeholder${i % 2}`, `placeholder ${i}`, { id: `m${i}`, timestamp: at(i) }))
    act(() => {
      roomStore.getState().addRoom(createRoom(ROOM, { joined: true }))
      roomStore.getState().setActiveRoom(ROOM)
    })
    act(() => {
      const state = roomStore.getState()
      const meta = state.roomMeta.get(ROOM)!
      roomStore.setState({
        messages: new Map([[ROOM, messages]]),
        windowAtLiveEdge: new Map([[ROOM, true]]),
        firstNewMessageMarkers: new Map([[ROOM, { id: 'm2' }]]),
        roomMeta: new Map([[ROOM, { ...meta, unreadCount: 4, readPointer: makeReadPointer(messages[5], 'room') }]]),
      })
    })

    const { result } = renderHook(() => useRoomActive(), { wrapper })

    expect(result.current.activeRoom?.unreadCount).toBe(4)
    expect(result.current.firstNewMessageCount).toBe(8)
  })

  it('chat: counts every row under the divider after the pointer passed some of them', () => {
    const messages = Array.from({ length: 10 }, (_, i) =>
      createMessage(PEER, `placeholder ${i}`, { id: `m${i}`, timestamp: at(i) }))
    act(() => {
      chatStore.getState().addConversation(createConversation(PEER))
      chatStore.getState().setActiveConversation(PEER)
    })
    act(() => {
      const state = chatStore.getState()
      const meta = state.conversationMeta.get(PEER)!
      chatStore.setState({
        messages: new Map([[PEER, messages]]),
        firstNewMessageMarkers: new Map([[PEER, { id: 'm2' }]]),
        conversationMeta: new Map([[PEER, { ...meta, unreadCount: 4, readPointer: makeReadPointer(messages[5], 'chat') }]]),
      })
    })

    const { result } = renderHook(() => useChatActive(), { wrapper })

    expect(result.current.firstNewMessageCount).toBe(8)
  })
})

// Reading moves the pointer at once and the canonical count only when its archive recount commits,
// which can defer indefinitely. The label is the divider's own count, which neither of them changes.
describe('active divider count while a read awaits its recount', () => {
  const roomMessage = (i: number): RoomMessage => ({
    type: 'groupchat', id: `m${i}`, roomJid: ROOM, from: `${ROOM}/alice`, nick: 'alice',
    body: `placeholder ${i}`, timestamp: at(i + 1), isOutgoing: false,
  })
  const chatMessage = (i: number): Message => ({
    type: 'chat', id: `m${i}`, conversationId: PEER, from: PEER,
    body: `placeholder ${i}`, timestamp: at(i + 1), isOutgoing: false,
  })
  const flush = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)) })

  beforeEach(() => {
    globalThis.indexedDB = new IDBFactory()
    ;(messageCache as unknown as { _resetDBForTesting?: () => void })._resetDBForTesting?.()
    roomStore.getState().reset()
    chatStore.getState().reset()
    connectionStore.getState().setWindowVisible(true)
  })

  it('room: the label holds while the pointer moves, across the recount, and counts a live arrival', async () => {
    const anchor = { ...roomMessage(-1), id: 'anchor', stanzaId: 'anchor-stanza' }
    const messages = Array.from({ length: 10 }, (_, i) => roomMessage(i))
    act(() => {
      roomStore.getState().addRoom(createRoom(ROOM, { joined: true }))
      roomStore.getState().setActiveRoom(ROOM)
    })
    act(() => {
      const meta = roomStore.getState().roomMeta.get(ROOM)!
      roomStore.setState({
        messages: new Map([[ROOM, [anchor, ...messages]]]),
        windowAtLiveEdge: new Map([[ROOM, true]]),
        firstNewMessageMarkers: new Map([[ROOM, { id: 'm2' }]]),
        roomMeta: new Map([[ROOM, { ...meta, unreadCount: 8, readPointer: makeReadPointer(messages[1], 'room') }]]),
      })
    })
    const { result } = renderHook(() => useRoomActive(), { wrapper })
    expect(result.current.firstNewMessageCount).toBe(8)

    act(() => { roomStore.getState().advanceReadPointer(ROOM, { id: 'm5' }) })
    expect(roomStore.getState().roomMeta.get(ROOM)?.readPointer?.identity.messageId).toBe('m5')
    expect(result.current.activeRoom?.unreadCount).toBe(8)
    expect(result.current.firstNewMessageCount).toBe(8)

    // No archive coverage: the recount the advance launched defers.
    await flush()
    act(() => { roomStore.getState().advanceReadPointer(ROOM, { id: 'm7' }) })
    await flush()
    expect(result.current.activeRoom?.unreadCount).toBe(8)
    expect(result.current.firstNewMessageCount).toBe(8)

    act(() => { roomStore.getState().addMessage(ROOM, roomMessage(10)) })
    await flush()
    expect(result.current.activeRoom?.unreadCount).toBe(9)
    expect(result.current.firstNewMessageCount).toBe(9)

    await messageCache.saveRoomMessages([anchor, ...messages, roomMessage(10)])
    act(() => {
      roomStore.setState((state) => ({
        mamQueryStates: new Map(state.mamQueryStates).set(ROOM, {
          isLoading: false, error: null, hasQueried: true, isHistoryComplete: true, isCaughtUpToLive: true,
        }),
        roomCoverage: new Map(state.roomCoverage).set(ROOM, { bottomId: 'anchor-stanza' }),
      }))
    })
    await act(() => roomStore.getState().recomputeUnreadForRoom(ROOM, { allowActive: true }))
    expect(result.current.activeRoom?.unreadCount).toBe(3)
    expect(result.current.firstNewMessageCount).toBe(9)

    act(() => { roomStore.getState().addMessage(ROOM, roomMessage(11)) })
    await flush()
    expect(result.current.activeRoom?.unreadCount).toBe(4)
    expect(result.current.firstNewMessageCount).toBe(10)
  })

  it('chat: the label holds while the pointer moves, across the recount, and counts a live arrival', async () => {
    const anchor = { ...chatMessage(-1), id: 'anchor', stanzaId: 'anchor-stanza' }
    const messages = Array.from({ length: 10 }, (_, i) => chatMessage(i))
    act(() => {
      chatStore.getState().addConversation(createConversation(PEER))
      chatStore.getState().setActiveConversation(PEER)
    })
    act(() => {
      const meta = chatStore.getState().conversationMeta.get(PEER)!
      chatStore.setState({
        messages: new Map([[PEER, [anchor, ...messages]]]),
        firstNewMessageMarkers: new Map([[PEER, { id: 'm2' }]]),
        conversationMeta: new Map([[PEER, { ...meta, unreadCount: 8, readPointer: makeReadPointer(messages[1], 'chat') }]]),
      })
    })
    const { result } = renderHook(() => useChatActive(), { wrapper })
    expect(result.current.firstNewMessageCount).toBe(8)

    act(() => { chatStore.getState().advanceReadPointer(PEER, { id: 'm5' }) })
    expect(chatStore.getState().conversationMeta.get(PEER)?.readPointer?.identity.messageId).toBe('m5')
    expect(result.current.activeConversation?.unreadCount).toBe(8)
    expect(result.current.firstNewMessageCount).toBe(8)

    await flush()
    act(() => { chatStore.getState().advanceReadPointer(PEER, { id: 'm7' }) })
    await flush()
    expect(result.current.activeConversation?.unreadCount).toBe(8)
    expect(result.current.firstNewMessageCount).toBe(8)

    act(() => { chatStore.getState().addMessage(chatMessage(10)) })
    await flush()
    expect(result.current.activeConversation?.unreadCount).toBe(9)
    expect(result.current.firstNewMessageCount).toBe(9)

    await messageCache.saveMessages([anchor, ...messages, chatMessage(10)])
    act(() => {
      chatStore.setState((state) => ({
        mamQueryStates: new Map(state.mamQueryStates).set(PEER, {
          isLoading: false, error: null, hasQueried: true, isHistoryComplete: true, isCaughtUpToLive: true,
        }),
        conversationCoverage: new Map(state.conversationCoverage).set(PEER, { bottomId: 'anchor-stanza' }),
      }))
    })
    await act(() => chatStore.getState().recomputeUnreadForConversation(PEER, { allowActive: true }))
    expect(result.current.activeConversation?.unreadCount).toBe(3)
    expect(result.current.firstNewMessageCount).toBe(9)

    act(() => { chatStore.getState().addMessage(chatMessage(11)) })
    await flush()
    expect(result.current.activeConversation?.unreadCount).toBe(4)
    expect(result.current.firstNewMessageCount).toBe(10)
  })

  it('room: a divider re-placed before any reading re-seeds its count from the new row', () => {
    const messages = Array.from({ length: 10 }, (_, i) => roomMessage(i))
    act(() => {
      roomStore.getState().addRoom(createRoom(ROOM, { joined: true }))
      roomStore.getState().setActiveRoom(ROOM)
    })
    act(() => {
      const meta = roomStore.getState().roomMeta.get(ROOM)!
      roomStore.setState({
        messages: new Map([[ROOM, messages]]),
        firstNewMessageMarkers: new Map([[ROOM, { id: 'm2' }]]),
        roomMeta: new Map([[ROOM, { ...meta, unreadCount: 8, readPointer: makeReadPointer(messages[1], 'room') }]]),
      })
    })
    const { result } = renderHook(() => useRoomActive(), { wrapper })
    expect(result.current.firstNewMessageCount).toBe(8)

    act(() => {
      const meta = roomStore.getState().roomMeta.get(ROOM)!
      roomStore.setState({
        roomMeta: new Map([[ROOM, { ...meta, unreadCount: 6, readPointer: makeReadPointer(messages[3], 'room') }]]),
      })
      roomStore.getState().resyncDividerToReadPointer(ROOM)
    })
    expect(result.current.firstNewMessageRow).toEqual({ id: 'm4' })
    expect(result.current.firstNewMessageCount).toBe(6)
  })

  it('chat: a divider re-placed before any reading re-seeds its count from the new row', () => {
    const messages = Array.from({ length: 10 }, (_, i) => chatMessage(i))
    act(() => {
      chatStore.getState().addConversation(createConversation(PEER))
      chatStore.getState().setActiveConversation(PEER)
    })
    act(() => {
      const meta = chatStore.getState().conversationMeta.get(PEER)!
      chatStore.setState({
        messages: new Map([[PEER, messages]]),
        firstNewMessageMarkers: new Map([[PEER, { id: 'm2' }]]),
        conversationMeta: new Map([[PEER, { ...meta, unreadCount: 8, readPointer: makeReadPointer(messages[1], 'chat') }]]),
      })
    })
    const { result } = renderHook(() => useChatActive(), { wrapper })
    expect(result.current.firstNewMessageCount).toBe(8)

    act(() => {
      const meta = chatStore.getState().conversationMeta.get(PEER)!
      chatStore.setState({
        conversationMeta: new Map([[PEER, { ...meta, unreadCount: 6, readPointer: makeReadPointer(messages[3], 'chat') }]]),
      })
      chatStore.getState().resyncDividerToReadPointer(PEER)
    })
    expect(result.current.firstNewMessageRow).toEqual({ id: 'm4' })
    expect(result.current.firstNewMessageCount).toBe(6)
  })

  const minute = (m: number) => new Date(Date.UTC(2026, 8, 17, 15, m))
  const mergedMinutes = [51, 53, 55, 57, 59, 60]

  it('room: rows a forward archive catch-up merges below the divider add to its count', async () => {
    const cached = Array.from({ length: 11 }, (_, i): RoomMessage => ({
      ...roomMessage(i), id: `c${i}`, stanzaId: `sc${i}`, timestamp: minute(40 + i),
    }))
    const merged = mergedMinutes.map((m, i): RoomMessage => ({
      ...roomMessage(i), id: `n${i}`, stanzaId: `sn${i}`, timestamp: minute(m),
    }))
    act(() => {
      roomStore.getState().addRoom(createRoom(ROOM, { joined: true }))
      roomStore.getState().setActiveRoom(ROOM)
    })
    act(() => {
      const meta = roomStore.getState().roomMeta.get(ROOM)!
      roomStore.setState({
        messages: new Map([[ROOM, cached]]),
        windowAtLiveEdge: new Map([[ROOM, true]]),
        firstNewMessageMarkers: new Map([[ROOM, { id: 'c6' }]]),
        roomMeta: new Map([[ROOM, { ...meta, unreadCount: 5, readPointer: makeReadPointer(cached[5], 'room') }]]),
      })
    })
    const { result } = renderHook(() => useRoomActive(), { wrapper })
    expect(result.current.firstNewMessageCount).toBe(5)

    act(() => { roomStore.getState().mergeRoomMAMMessages(ROOM, merged, { last: 'sn5' }, true, 'forward') })
    await flush()
    expect(result.current.activeMessages.map((m) => m.id)).toEqual([...cached, ...merged].map((m) => m.id))
    expect(result.current.firstNewMessageCount).toBe(11)

    const full = roomStore.getState().messages.get(ROOM)!
    act(() => { roomStore.setState({ messages: new Map([[ROOM, full.slice(0, 8)]]) }) })
    act(() => { roomStore.setState({ messages: new Map([[ROOM, full]]) }) })
    expect(result.current.firstNewMessageCount).toBe(11)
  })

  it('chat: rows a forward archive catch-up merges below the divider add to its count', async () => {
    const cached = Array.from({ length: 11 }, (_, i): Message => ({
      ...chatMessage(i), id: `c${i}`, stanzaId: `sc${i}`, timestamp: minute(40 + i),
    }))
    const merged = mergedMinutes.map((m, i): Message => ({
      ...chatMessage(i), id: `n${i}`, stanzaId: `sn${i}`, timestamp: minute(m),
    }))
    act(() => {
      chatStore.getState().addConversation(createConversation(PEER))
      chatStore.getState().setActiveConversation(PEER)
    })
    act(() => {
      const meta = chatStore.getState().conversationMeta.get(PEER)!
      chatStore.setState({
        messages: new Map([[PEER, cached]]),
        firstNewMessageMarkers: new Map([[PEER, { id: 'c6' }]]),
        conversationMeta: new Map([[PEER, { ...meta, unreadCount: 5, readPointer: makeReadPointer(cached[5], 'chat') }]]),
      })
    })
    const { result } = renderHook(() => useChatActive(), { wrapper })
    expect(result.current.firstNewMessageCount).toBe(5)

    act(() => { chatStore.getState().mergeMAMMessages(PEER, merged, { last: 'sn5' }, true, 'forward') })
    await flush()
    expect(result.current.activeMessages.map((m) => m.id)).toEqual([...cached, ...merged].map((m) => m.id))
    expect(result.current.firstNewMessageCount).toBe(11)

    const full = chatStore.getState().messages.get(PEER)!
    act(() => { chatStore.setState({ messages: new Map([[PEER, full.slice(0, 8)]]) }) })
    act(() => { chatStore.setState({ messages: new Map([[PEER, full]]) }) })
    expect(result.current.firstNewMessageCount).toBe(11)
  })
})
