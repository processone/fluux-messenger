import { describe, it, expect, beforeEach } from 'vitest'
import { roomStore } from './roomStore'
import { createRoom, createRoomMessage } from '../hooks/renderStability.helpers'

/**
 * roomSidebarJids() is the subscription target for the sidebar room list.
 *
 * It returns the sidebar-ordered room JIDs (section-encoded as "<section> <jid>"),
 * NOT the room objects. Subscribing to JIDs (via useShallow) means the list
 * component only re-renders when membership / order / section changes — not on
 * every message, unread, or last-message-preview update. Each row subscribes to
 * its own room.
 */
const SEP = ' '

function resetRoomStore() {
  roomStore.setState({
    rooms: new Map(),
    roomEntities: new Map(),
    roomMeta: new Map(),
    roomRuntime: new Map(),
    activeRoomJid: null,
    mamQueryStates: new Map(),
    activeAnimation: null,
    drafts: new Map(),
  })
}

describe('roomStore.roomSidebarJids', () => {
  beforeEach(resetRoomStore)

  it('returns joined room JIDs encoded with their section', () => {
    roomStore.getState().addRoom(createRoom('team@conf.example.com', { joined: true }))

    expect(roomStore.getState().roomSidebarJids()).toEqual([`joined${SEP}team@conf.example.com`])
  })

  it('does NOT change when a joined room receives a message (no reorder)', () => {
    roomStore.getState().addRoom(createRoom('team@conf.example.com', { joined: true }))
    const before = roomStore.getState().roomSidebarJids()

    roomStore.getState().addMessage(
      'team@conf.example.com',
      createRoomMessage('team@conf.example.com', 'bob', 'hello there'),
    )
    const after = roomStore.getState().roomSidebarJids()

    // Same JIDs in the same order → useShallow bails → RoomsList does not re-render.
    expect(after).toEqual([`joined${SEP}team@conf.example.com`])
    expect(after).toEqual(before)
  })

  it('changes when a new room is added (membership change)', () => {
    roomStore.getState().addRoom(createRoom('team@conf.example.com', { joined: true }))
    const before = roomStore.getState().roomSidebarJids()

    roomStore.getState().addRoom(createRoom('design@conf.example.com', { joined: true }))

    expect(roomStore.getState().roomSidebarJids()).not.toEqual(before)
    expect(roomStore.getState().roomSidebarJids()).toHaveLength(2)
  })

  it('separates sections: bookmarked-not-joined sorted by name, after joined', () => {
    roomStore.getState().addRoom(createRoom('zeta@conf.example.com', { joined: true }))
    roomStore.getState().addRoom(createRoom('beta@conf.example.com', { joined: false, isBookmarked: true, name: 'Beta' }))
    roomStore.getState().addRoom(createRoom('alpha@conf.example.com', { joined: false, isBookmarked: true, name: 'Alpha' }))

    const jids = roomStore.getState().roomSidebarJids()
    // joined first, then bookmarked-not-joined alphabetically by name (Alpha, Beta)
    expect(jids).toEqual([
      `joined${SEP}zeta@conf.example.com`,
      `bookmarked${SEP}alpha@conf.example.com`,
      `bookmarked${SEP}beta@conf.example.com`,
    ])
  })
})
