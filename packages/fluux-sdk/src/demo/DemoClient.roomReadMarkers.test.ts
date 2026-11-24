import 'fake-indexeddb/auto'
import { afterEach, describe, expect, it } from 'vitest'
import { DemoClient } from './DemoClient'
import { roomStore } from '../stores/roomStore'
import { connectionStore } from '../stores/connectionStore'
import { setStorageScopeJid } from '../utils/storageScope'
import type { Room, RoomMessage } from '../core/types/room'

// Source: the approved demo.html?perf=1 render check. This test owns the
// demo-only transport seam, not the real-server protocol claim.
const roomJid = 'team@conference.fluux.chat'
let client: DemoClient | undefined
afterEach(() => { client?.destroy(); roomStore.getState().reset(); connectionStore.getState().reset(); setStorageScopeJid(null) })

describe('demo room displayed markers', () => {
  it('feeds the real validator and row index without replacing messages or enabling consent', async () => {
    setStorageScopeJid('you@fluux.chat')
    client = new DemoClient()
    client.populateDemo({ self: { jid: 'you@fluux.chat', nick: 'You', domain: 'fluux.chat' }, contacts: [], presences: [],
      conversations: [], messages: new Map(), rooms: [] })
    const room: Room = { jid: roomJid, name: 'Team', nickname: 'You', joined: true, isBookmarked: false,
      unreadCount: 0, mentionsCount: 0, typingUsers: new Set(), occupants: new Map([
        ['You', { nick: 'You', jid: 'you@fluux.chat', occupantId: 'you-id', role: 'moderator', affiliation: 'owner' }],
        ['Emma', { nick: 'Emma', jid: 'emma@fluux.chat', occupantId: 'emma-id', role: 'participant', affiliation: 'member' }],
      ]) }
    roomStore.getState().addRoom(room)
    roomStore.getState().setActiveRoom(roomJid)
    const rows: RoomMessage[] = [0, 1].map(index => ({ type: 'groupchat', roomJid, from: `${roomJid}/Emma`, nick: 'Emma',
      occupantId: 'emma-id', id: `demo-reading-${index}`, stanzaId: `sid-demo-reading-${index}`, originId: undefined,
      body: 'Team reading proof', timestamp: new Date(1000 + index), isOutgoing: false }))
    for (const row of rows) roomStore.getState().addMessage(roomJid, row)
    await roomStore.getState().waitForMessageArrivals(roomJid)
    const messages = roomStore.getState().messages.get(roomJid)
    await client.simulateRoomDisplayed(roomJid, 'emma-id', rows[0].stanzaId!)
    expect(client.roomReadMarkers.readers(roomJid, rows[0])).toMatchObject([{ nick: 'Emma', occupantId: 'emma-id' }])
    await client.simulateRoomDisplayed(roomJid, 'emma-id', rows[1].stanzaId!)
    expect(client.roomReadMarkers.readers(roomJid, rows[0])).toHaveLength(0)
    expect(client.roomReadMarkers.readers(roomJid, rows[1])).toHaveLength(1)
    expect(roomStore.getState().messages.get(roomJid)).toBe(messages)
    expect(client.roomReadMarkers.getConsent()).toEqual({ enabled: false, rooms: [] })
  })
})
