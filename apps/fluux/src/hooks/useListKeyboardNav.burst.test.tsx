import { expect, it, vi } from 'vitest'
import { useRef } from 'react'
import { createRoot } from 'react-dom/client'
import { flushSync } from 'react-dom'
import { useShallow } from 'zustand/react/shallow'
import { chatStore, roomStore } from '@fluux/sdk/stores'
import { useChatStore, useRoomStore } from '@fluux/sdk/react'
import { useListKeyboardNav } from './useListKeyboardNav'

vi.unmock('@fluux/sdk/stores')
vi.unmock('@fluux/sdk/react')

it.each(['none', 'manual', 'external'] as const)('survives 800 separately delivered real-store activity reorders with %s selection', async selection => {
  const initial = chatStore.getState()
  chatStore.setState(chatStore.getInitialState(), true)
  for (let i = 0; i < 50; i++) {
    chatStore.getState().addConversation({ id: `chat-${i}@invalid`, name: `Chat ${i}`, type: 'chat', unreadCount: 0 })
  }
  let renders = 0
  let selected = -2
  let nav!: ReturnType<typeof useListKeyboardNav>
  const errors: string[] = []
  const consoleError = vi.spyOn(console, 'error').mockImplementation((...args) => errors.push(args.join(' ')))
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  function List() {
    renders++
    const ids = useChatStore(useShallow(state => state.conversationSidebarIds()))
    const listRef = useRef<HTMLDivElement>(null)
    nav = useListKeyboardNav({ items: ids, getItemId: id => id, listRef, onSelect: () => {},
      activeItemId: selection === 'external' ? 'chat-25@invalid' : null })
    selected = nav.selectedIndex
    return <div ref={listRef}>{ids.join(',')}</div>
  }
  try {
    flushSync(() => root.render(<List />))
    if (selection === 'manual') flushSync(() => nav.setSelectedIndex(chatStore.getState().conversationSidebarIds().indexOf('chat-25@invalid')))
    // Separate tasks outside act preserve the external-store/passive-effect scheduling.
    await new Promise<void>(resolve => {
      for (let i = 0; i < 800; i++) setTimeout(() => {
        try {
          chatStore.getState().addMessage({ type: 'chat', id: `message-${i}`, stanzaId: undefined, originId: undefined, conversationId: `chat-${i % 50}@invalid`,
            from: `chat-${i % 50}@invalid`, body: 'fixture', timestamp: new Date(2_000_000_000_000 + i), isOutgoing: false })
        } catch (error) { errors.push(String(error)) }
        if (i === 799) setTimeout(resolve, 300)
      }, 0)
    })
    expect(errors.filter(error => !/not wrapped in act/.test(error))).toEqual([])
    expect(selected).toBe(selection === 'none' ? -1 : chatStore.getState().conversationSidebarIds().indexOf('chat-25@invalid'))
    expect(renders).toBeGreaterThan(50)
    expect(renders).toBeLessThanOrEqual(selection === 'none' ? 801 : 803)
    expect(chatStore.getState().conversationSidebarIds()[0]).toBe('chat-49@invalid')
  } finally {
    flushSync(() => root.unmount())
    container.remove()
    consoleError.mockRestore()
    chatStore.setState(initial, true)
  }
})

it('survives 800 separately delivered real room activity reorders with a stable active identity', async () => {
  const initial = roomStore.getState()
  roomStore.setState(roomStore.getInitialState(), true)
  for (let i = 0; i < 50; i++) roomStore.getState().addRoom({ jid: `room-${i}@conference.invalid`, name: `Room ${i}`,
    nickname: 'Fixture', joined: true, isBookmarked: true, occupants: new Map(), unreadCount: 0, mentionsCount: 0, typingUsers: new Set() })
  const errors: string[] = []
  const consoleError = vi.spyOn(console, 'error').mockImplementation((...args) => errors.push(args.join(' ')))
  let renders = 0
  let selectedId: string | undefined
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  function List() {
    renders++
    const ids = useRoomStore(useShallow(state => state.allRooms().map(room => room.jid)))
    const listRef = useRef<HTMLDivElement>(null)
    const nav = useListKeyboardNav({ items: ids, getItemId: id => id, listRef, onSelect: () => {}, activeItemId: 'room-25@conference.invalid' })
    selectedId = ids[nav.selectedIndex]
    return <div ref={listRef}>{ids.join(',')}</div>
  }
  try {
    flushSync(() => root.render(<List />))
    await new Promise<void>(resolve => {
      for (let i = 0; i < 800; i++) setTimeout(() => {
        const roomJid = `room-${i % 50}@conference.invalid`
        try {
          roomStore.getState().addMessage(roomJid, { type: 'groupchat', id: `room-message-${i}`, roomJid, stanzaId: undefined, originId: undefined, occupantId: undefined,
            from: `${roomJid}/Other`, nick: 'Other', body: 'fixture', timestamp: new Date(2_000_000_000_000 + i), isOutgoing: false })
        } catch (error) { errors.push(String(error)) }
        if (i === 799) setTimeout(resolve, 300)
      }, 0)
    })
    expect(errors.filter(error => !/not wrapped in act/.test(error))).toEqual([])
    expect(selectedId).toBe('room-25@conference.invalid')
    expect(roomStore.getState().allRooms()[0].jid).toBe('room-49@conference.invalid')
    expect(renders).toBeGreaterThan(50)
    expect(renders).toBeLessThanOrEqual(803)
  } finally {
    flushSync(() => root.unmount())
    container.remove()
    consoleError.mockRestore()
    roomStore.setState(initial, true)
  }
})
