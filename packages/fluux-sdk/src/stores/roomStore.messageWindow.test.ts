import { describe, it, expect, beforeEach } from 'vitest'
import { roomStore } from './roomStore'
import { createRoom, createRoomMessage } from '../hooks/renderStability.helpers'

/**
 * The room's resident message window lives in two maps — the `rooms` compat
 * entry and `roomRuntime` — and one writer keeps them in step.
 *
 * These pin the two properties a reader depends on and a hand-written mirror
 * pair kept losing: the maps agree, and a write that changes nothing hands back
 * the same reference.
 */
describe('room message window', () => {
  beforeEach(() => {
    roomStore.setState({
      rooms: new Map(), roomEntities: new Map(), roomMeta: new Map(), roomRuntime: new Map(),
      activeRoomJid: null, mamQueryStates: new Map(), activeAnimation: null, drafts: new Map(),
      firstNewMessageMarkers: new Map(),
    })
  })

  it('lands an appended message in BOTH maps, with the same array', () => {
    roomStore.getState().addRoom(createRoom('a@x', { joined: true }))
    roomStore.getState().addMessage('a@x', createRoomMessage('a@x', 'nick', 'hello', { id: 'm1' }))

    const state = roomStore.getState()
    const viaCompat = state.rooms.get('a@x')!.messages
    const viaRuntime = state.roomRuntime.get('a@x')!.messages

    expect(viaCompat.map((m) => m.id)).toEqual(['m1'])
    // Same reference, not merely equal contents: a reader that falls back from
    // one map to the other must not be able to observe two different windows.
    expect(viaRuntime).toBe(viaCompat)
  })

  it('keeps the two maps in step across several appends', () => {
    roomStore.getState().addRoom(createRoom('a@x', { joined: true }))
    for (const id of ['m1', 'm2', 'm3']) {
      roomStore.getState().addMessage('a@x', createRoomMessage('a@x', 'nick', id, { id }))
    }

    const state = roomStore.getState()
    expect(state.rooms.get('a@x')!.messages).toBe(state.roomRuntime.get('a@x')!.messages)
    expect(state.rooms.get('a@x')!.messages.map((m) => m.id)).toEqual(['m1', 'm2', 'm3'])
  })

  it('leaves roomRuntime referentially identical when a deactivation evicts an already-empty window', () => {
    roomStore.getState().addRoom(createRoom('a@x', { joined: true }))
    roomStore.getState().setActiveRoom('a@x')

    // No messages were ever appended, so deactivating has no window to drop.
    const before = roomStore.getState().roomRuntime
    roomStore.getState().setActiveRoom(null)

    // A fresh map here would re-render every runtime subscriber for nothing.
    expect(roomStore.getState().roomRuntime).toBe(before)
  })

  it('does not resurrect a room that is gone from the compat map', () => {
    roomStore.getState().addRoom(createRoom('a@x', { joined: true }))
    roomStore.getState().removeRoom('a@x')

    roomStore.getState().addMessage('a@x', createRoomMessage('a@x', 'nick', 'hello', { id: 'm1' }))

    expect(roomStore.getState().rooms.has('a@x')).toBe(false)
  })
})
