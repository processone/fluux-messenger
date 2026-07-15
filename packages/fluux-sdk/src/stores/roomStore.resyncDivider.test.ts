import { describe, it, expect, beforeEach } from 'vitest'
import { roomStore } from './roomStore'
import type { Room, RoomMessage } from '../core/types'

const JID = 'room@conference.example.com'

function msg(id: string, opts: { outgoing?: boolean; delayed?: boolean } = {}): RoomMessage {
  return {
    id,
    roomJid: JID,
    nick: opts.outgoing ? 'me' : 'bob',
    from: `${JID}/${opts.outgoing ? 'me' : 'bob'}`,
    body: id,
    timestamp: new Date(2024, 0, 1, 12, Number(id.replace(/\D/g, '')) || 0),
    isOutgoing: !!opts.outgoing,
    isDelayed: !!opts.delayed,
    type: 'groupchat' as const,
  }
}

function seed(opts: { lastSeen: string | undefined; marker: string | undefined; messages: RoomMessage[] }) {
  const rooms = new Map()
  rooms.set(JID, {
    jid: JID,
    messages: opts.messages,
    unreadCount: 0,
    mentionsCount: 0,
    lastReadAt: new Date(2024, 0, 1, 12, 0),
    lastSeenMessageId: opts.lastSeen,
  } as Room)
  const roomMeta = new Map()
  roomMeta.set(JID, {
    unreadCount: 0,
    mentionsCount: 0,
    typingUsers: new Set<string>(),
    lastReadAt: new Date(2024, 0, 1, 12, 0),
    lastSeenMessageId: opts.lastSeen,
  })
  const roomRuntime = new Map()
  roomRuntime.set(JID, { occupants: new Map(), messages: opts.messages })
  const markers = new Map<string, string>()
  if (opts.marker) markers.set(JID, opts.marker)
  roomStore.setState({ rooms, roomMeta, roomRuntime, firstNewMessageMarkers: markers })
}

describe('roomStore.resyncDividerToReadPointer', () => {
  beforeEach(() => {
    roomStore.setState({ rooms: new Map(), roomMeta: new Map(), roomRuntime: new Map(), firstNewMessageMarkers: new Map() })
  })

  it('advances an existing divider to the first unread after the pointer', () => {
    seed({ lastSeen: 'm2', marker: 'm1', messages: [msg('m0'), msg('m1'), msg('m2'), msg('m3'), msg('m4')] })
    roomStore.getState().resyncDividerToReadPointer(JID)
    expect(roomStore.getState().firstNewMessageMarkers.get(JID)).toBe('m3')
  })

  it('no-ops when there is no existing divider', () => {
    seed({ lastSeen: 'm2', marker: undefined, messages: [msg('m1'), msg('m2'), msg('m3')] })
    roomStore.getState().resyncDividerToReadPointer(JID)
    expect(roomStore.getState().firstNewMessageMarkers.has(JID)).toBe(false)
  })

  it('clears the divider when the pointer is at the newest message', () => {
    seed({ lastSeen: 'm3', marker: 'm1', messages: [msg('m1'), msg('m2'), msg('m3')] })
    roomStore.getState().resyncDividerToReadPointer(JID)
    expect(roomStore.getState().firstNewMessageMarkers.has(JID)).toBe(false)
  })
})
