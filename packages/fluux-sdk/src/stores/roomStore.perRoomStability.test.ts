import { describe, it, expect, beforeEach } from 'vitest'
import { roomStore } from './roomStore'
import { createRoom, createRoomMessage } from '../hooks/renderStability.helpers'

// Diagnostic: which per-room reads stay referentially stable for an UNRELATED room
// (B) after a message arrives in another room (A)? Whatever is stable is what a
// per-row sidebar component must subscribe to so only the changed row re-renders.
describe('per-room ref stability after unrelated message', () => {
  beforeEach(() => {
    roomStore.setState({
      rooms: new Map(), roomEntities: new Map(), roomMeta: new Map(), roomRuntime: new Map(),
      activeRoomJid: null, mamQueryStates: new Map(), activeAnimation: null, drafts: new Map(),
    })
  })

  it('entity / meta / combined refs for room B after a message to room A', () => {
    roomStore.getState().addRoom(createRoom('a@x', { joined: true }))
    roomStore.getState().addRoom(createRoom('b@x', { joined: true }))

    const beforeRoom = roomStore.getState().getRoom('b@x')
    const beforeEntity = roomStore.getState().roomEntities.get('b@x')
    const beforeMeta = roomStore.getState().roomMeta.get('b@x')

    roomStore.getState().addMessage('a@x', createRoomMessage('a@x', 'bob', 'hi'))

    expect(roomStore.getState().roomEntities.get('b@x')).toBe(beforeEntity)
    expect(roomStore.getState().roomMeta.get('b@x')).toBe(beforeMeta)
    expect(roomStore.getState().getRoom('b@x')).toBe(beforeRoom)
  })
})
