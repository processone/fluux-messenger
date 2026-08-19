import { describe, it, expect, beforeEach } from 'vitest'
import { roomStore } from './roomStore'
import { createRoom, createRoomMessage } from '../hooks/renderStability.helpers'

/**
 * The room's resident message window lives in `messages`, keyed by room JID,
 * and nowhere else: the room entry carries no timeline.
 *
 * These pin the two properties every reader depends on — the window has one
 * home, and a write that changes nothing hands back the same map reference.
 */
describe('room message window', () => {
  beforeEach(() => {
    roomStore.setState({
      rooms: new Map(), roomEntities: new Map(), roomMeta: new Map(), roomRuntime: new Map(), messages: new Map(), windowAtLiveEdge: new Map(),
      activeRoomJid: null, mamQueryStates: new Map(), activeAnimation: null, drafts: new Map(),
      firstNewMessageMarkers: new Map(),
    })
  })

  it('lands an appended message in the window map', () => {
    roomStore.getState().addRoom(createRoom('a@x', { joined: true }))
    roomStore.getState().addMessage('a@x', createRoomMessage('a@x', 'nick', 'hello', { id: 'm1' }))

    expect(roomStore.getState().messages.get('a@x')!.map((m) => m.id)).toEqual(['m1'])
  })

  it('accumulates across several appends', () => {
    roomStore.getState().addRoom(createRoom('a@x', { joined: true }))
    for (const id of ['m1', 'm2', 'm3']) {
      roomStore.getState().addMessage('a@x', createRoomMessage('a@x', 'nick', id, { id }))
    }

    expect(roomStore.getState().messages.get('a@x')!.map((m) => m.id)).toEqual(['m1', 'm2', 'm3'])
  })

  it('seeds the window from the resident slice handed to addRoom', () => {
    const resident = ['m1', 'm2'].map((id) => createRoomMessage('a@x', 'nick', id, { id }))
    roomStore.getState().addRoom(createRoom('a@x', { joined: true }), resident)

    expect(roomStore.getState().messages.get('a@x')).toBe(resident)
  })

  it('leaves the window map referentially identical when a deactivation evicts an already-empty window', () => {
    roomStore.getState().addRoom(createRoom('a@x', { joined: true }))
    roomStore.getState().setActiveRoom('a@x')

    // No messages were ever appended, so deactivating has no window to drop.
    const before = roomStore.getState().messages
    roomStore.getState().setActiveRoom(null)

    // A fresh map here would re-render every window subscriber for nothing.
    expect(roomStore.getState().messages).toBe(before)
  })

  it('does not resurrect a room that is gone from the compat map', () => {
    roomStore.getState().addRoom(createRoom('a@x', { joined: true }))
    roomStore.getState().removeRoom('a@x')

    roomStore.getState().addMessage('a@x', createRoomMessage('a@x', 'nick', 'hello', { id: 'm1' }))

    expect(roomStore.getState().rooms.has('a@x')).toBe(false)
    expect(roomStore.getState().messages.has('a@x')).toBe(false)
  })
})
