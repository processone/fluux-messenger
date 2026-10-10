/** @vitest-environment happy-dom */
import { act, renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useXMPPContext } from '../provider'
import { chatStore } from '../stores/chatStore'
import { getMessageIngressVersion } from '../stores/shared/messageIngress'
import * as messageCache from '../utils/messageCache'
import { roomStore } from '../stores/roomStore'
import { useChatActive } from './useChatActive'
import { useRoomActive } from './useRoomActive'
import { createConversation, createMessage, createRoom, createRoomMessage, useRenderCount, wrapper } from './renderStability.helpers'

const ACTIVE = 'active@example.com'
const BACKGROUND = 'background@example.com'

beforeEach(() => {
  chatStore.getState().reset()
  roomStore.getState().reset()
  for (const id of [ACTIVE, BACKGROUND]) {
    chatStore.getState().addConversation(createConversation(id))
    roomStore.getState().addRoom(createRoom(id, { joined: true }))
  }
  chatStore.getState().setActiveConversation(ACTIVE)
  roomStore.getState().setActiveRoom(ACTIVE)
})

for (const kind of ['chat', 'room'] as const) {
  describe(`${kind} SDK ingress snapshot`, () => {
    const useActive = kind === 'chat' ? useChatActive : useRoomActive
    const mount = () => renderHook(() => ({
      ...useActive(), client: useXMPPContext().client, renders: useRenderCount(),
    }), { wrapper })
    const select = (id: string) => kind === 'chat'
      ? chatStore.getState().setActiveConversation(id)
      : roomStore.getState().setActiveRoom(id)

    it('advances on message events, including history, before the active snapshot renders', () => {
      const { result } = mount()
      expect(result.current.activeMessageIngressVersion).toBe(0)
      const emit = (id: string, messageId: string) => {
        if (kind === 'chat') result.current.client['emitSDK']('chat:message', {
          message: createMessage(id, 'History', { id: messageId }), isLiveArrival: false,
        })
        else result.current.client['emitSDK']('room:message', {
          roomJid: id, message: createRoomMessage(id, 'Peer', 'History', { id: messageId }), isLiveArrival: false,
        })
      }
      act(() => emit(ACTIVE, 'one'))
      const first = result.current.activeMessageIngressVersion
      expect(first).toBeGreaterThan(0)
      expect(result.current.activeMessages.map(message => message.id)).toContain('one')
      act(() => emit(ACTIVE, 'two'))
      expect(result.current.activeMessageIngressVersion).toBeGreaterThan(first)
      const activeVersion = result.current.activeMessageIngressVersion
      const activeRenders = result.current.renders
      act(() => emit(BACKGROUND, 'background'))
      expect(result.current.activeMessageIngressVersion).toBe(activeVersion)
      expect(result.current.renders).toBe(activeRenders)
      act(() => select(BACKGROUND))
      expect(result.current.activeMessageIngressVersion).toBeGreaterThan(activeVersion)
      act(() => select(ACTIVE))
      expect(result.current.activeMessageIngressVersion).toBe(activeVersion)
    })

    it('keeps progress stationary for local messages, read state, typing and message updates', () => {
      const { result, rerender } = mount()
      const version = result.current.activeMessageIngressVersion
      act(() => {
        if (kind === 'chat') {
          chatStore.getState().addMessage(createMessage(ACTIVE, 'Local', { id: 'local' }))
          chatStore.getState().markAsRead(ACTIVE)
          chatStore.getState().setTyping(ACTIVE, 'peer@example.com', true)
          chatStore.getState().updateMessage(ACTIVE, 'local', { body: 'Changed' })
        } else {
          roomStore.getState().addMessage(ACTIVE, createRoomMessage(ACTIVE, 'Peer', 'Local', { id: 'local' }))
          roomStore.getState().markAsRead(ACTIVE)
          roomStore.getState().setTyping(ACTIVE, 'Peer', true)
          roomStore.getState().updateMessage(ACTIVE, 'local', { body: 'Changed' })
        }
      })
      rerender()
      expect(result.current.activeMessageIngressVersion).toBe(version)
      expect(result.current.activeMessages[0].body).toBe('Changed')
    })

    it('isolates chat and room tokens even for the same conversation id', () => {
      const { result, rerender } = mount()
      act(() => {
        if (kind === 'chat') result.current.client['emitSDK']('room:message', {
          roomJid: ACTIVE, message: createRoomMessage(ACTIVE, 'Peer', 'Other kind'), isLiveArrival: true,
        })
        else result.current.client['emitSDK']('chat:message', {
          message: createMessage(ACTIVE, 'Other kind'), isLiveArrival: true,
        })
      })
      rerender()
      expect(result.current.activeMessageIngressVersion).toBe(0)
    })
  })
}

it('advances the room ingress snapshot for whispers', () => {
  const { result } = renderHook(() => ({ ...useRoomActive(), client: useXMPPContext().client }), { wrapper })
  act(() => result.current.client['emitSDK']('room:whisper', {
    roomJid: ACTIVE, message: createRoomMessage(ACTIVE, 'Peer', 'Whisper', { id: 'whisper' }),
  }))
  expect(result.current.activeMessageIngressVersion).toBeGreaterThan(0)
  expect(result.current.activeMessages.map(message => message.id)).toContain('whisper')
})

it.each(['delete', 'reset', 'account switch'] as const)('forgets tokens on %s without reusing a version', operation => {
  const { result, rerender } = renderHook(() => ({
    chat: useChatActive(), room: useRoomActive(), client: useXMPPContext().client,
  }), { wrapper })
  const emit = () => {
    result.current.client['emitSDK']('chat:message', { message: createMessage(ACTIVE, 'Chat', { id: 'chat' }), isLiveArrival: true })
    result.current.client['emitSDK']('room:message', { roomJid: ACTIVE, message: createRoomMessage(ACTIVE, 'Peer', 'Room', { id: 'room' }), isLiveArrival: true })
  }
  act(emit)
  const chatVersion = result.current.chat.activeMessageIngressVersion
  const roomVersion = result.current.room.activeMessageIngressVersion
  act(() => {
    if (operation === 'delete') {
      chatStore.getState().deleteConversation(ACTIVE)
      roomStore.getState().removeRoom(ACTIVE)
    } else if (operation === 'reset') {
      chatStore.getState().reset()
      roomStore.getState().reset()
    } else {
      chatStore.getState().switchAccount('another@example.com')
      roomStore.getState().switchAccount('another@example.com')
    }
    chatStore.getState().addConversation(createConversation(ACTIVE))
    roomStore.getState().addRoom(createRoom(ACTIVE, { joined: true }))
    chatStore.getState().setActiveConversation(ACTIVE)
    roomStore.getState().setActiveRoom(ACTIVE)
  })
  rerender()
  expect(result.current.chat.activeMessageIngressVersion).toBe(0)
  expect(result.current.room.activeMessageIngressVersion).toBe(0)
  act(emit)
  expect(result.current.chat.activeMessageIngressVersion).toBeGreaterThan(chatVersion)
  expect(result.current.room.activeMessageIngressVersion).toBeGreaterThan(roomVersion)
})


it('advances only as queued history and whispers reach acceptance', async () => {
  const available = vi.spyOn(messageCache, 'isMessageCacheAvailable').mockReturnValue(true)
  const releases: Array<() => void> = []
  const reconcile = vi.spyOn(roomStore.getState(), 'reconcileHistoryMessages').mockImplementation(messages =>
    new Promise(resolve => { releases.push(() => resolve(messages)) }))
  const { result, rerender } = renderHook(() => ({ ...useRoomActive(), client: useXMPPContext().client }), { wrapper })
  try {
    act(() => {
      for (const id of ['first', 'second']) result.current.client['emitSDK']('room:message', {
        roomJid: ACTIVE,
        message: { ...createRoomMessage(ACTIVE, 'Peer', 'History', { id, timestamp: new Date(id === 'first' ? 1000 : 2000) }), isDelayed: true },
        isLiveArrival: false,
      })
      result.current.client['emitSDK']('room:whisper', {
        roomJid: ACTIVE, message: createRoomMessage(ACTIVE, 'Peer', 'Whisper', { id: 'queued-whisper', timestamp: new Date(3000) }),
      })
    })
    rerender()
    expect(result.current.activeMessageIngressVersion).toBe(0)
    expect(result.current.activeMessages).toHaveLength(0)
    await act(async () => { releases.shift()!() })
    const first = result.current.activeMessageIngressVersion
    expect(first).toBeGreaterThan(0)
    expect(result.current.activeMessages.map(message => message.id)).toEqual(['first'])
    rerender()
    expect(result.current.activeMessageIngressVersion).toBe(first)
    const snapshots: number[] = []
    const unsubscribe = roomStore.subscribe(state => {
      const ids = state.messages.get(ACTIVE)?.map(message => message.id) ?? []
      if (ids.includes('second')) snapshots.push(getMessageIngressVersion('room', ACTIVE))
    })
    try {
      await act(async () => { releases.shift()!() })
    } finally { unsubscribe() }
    expect(snapshots[0]).toBeGreaterThan(first)
    expect(result.current.activeMessageIngressVersion).toBeGreaterThan(snapshots[0])
    expect(result.current.activeMessages.map(message => message.id)).toEqual(['first', 'second', 'queued-whisper'])
    const settled = result.current.activeMessageIngressVersion
    await act(async () => { await roomStore.getState().waitForMessageArrivals(ACTIVE) })
    rerender()
    expect(result.current.activeMessageIngressVersion).toBe(settled)
  } finally {
    reconcile.mockRestore()
    available.mockRestore()
  }
})
