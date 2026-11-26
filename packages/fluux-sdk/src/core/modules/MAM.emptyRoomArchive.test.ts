import { beforeEach, describe, expect, it } from 'vitest'
import 'fake-indexeddb/auto'
import { IDBFactory } from 'fake-indexeddb'
import { xml, type Element } from '@xmpp/client'
import { MAM } from './MAM'
import { createMockStores, createMockStoreRefs } from '../test-utils'
import { createStoreBindings } from '../../bindings/storeBindings'
import { roomStore, _resetRoomReadStateForTesting } from '../../stores/roomStore'
import * as messageCache from '../../utils/messageCache'
import { _resetStorageScopeForTesting } from '../../utils/storageScope'
import { createPresenceReader } from '../presenceReader'
import type { ModuleDependencies } from './BaseModule'
import type { SDKEvents } from '../types/sdk-events'
import type { Room, RoomHistoryQueryOptions } from '../types'
import type { SDKEventSource } from '../types/eventSource'

const ROOM = 'lounge@conference.example.com'
const MAM_NS = 'urn:xmpp:mam:2'

type Page = { entries: Element[]; complete: boolean }

function joinedRoom(): Room {
  return { jid: ROOM, name: 'Lounge', nickname: 'alice', joined: true, isBookmarked: false,
    occupants: new Map(), unreadCount: 0, mentionsCount: 0, typingUsers: new Set() }
}

beforeEach(() => {
  _resetStorageScopeForTesting()
  globalThis.indexedDB = new IDBFactory()
  messageCache._resetDBForTesting()
  roomStore.getState().reset()
  _resetRoomReadStateForTesting()
  roomStore.getState().addRoom(joinedRoom())
})

async function query(pages: Page[], options: Partial<RoomHistoryQueryOptions> = {}, beforeReply?: () => Promise<void>) {
  const handlers = new Map<keyof SDKEvents, (payload: never) => void>()
  const source: SDKEventSource = {
    subscribe(event, handler) {
      handlers.set(event, handler as (payload: never) => void)
      return () => { handlers.delete(event) }
    },
  }
  const refs = createMockStoreRefs()
  const unbind = createStoreBindings(source, () => ({ ...refs, room: roomStore.getState() }))
  const stores = createMockStores()
  stores.room.getRoomMAMQueryState.mockImplementation(jid => roomStore.getState().getRoomMAMQueryState(jid))
  const collectors = new Map<string, (packet: Element) => void>()
  const events: SDKEvents['room:history-messages'][] = []
  let requests = 0
  const deps: ModuleDependencies = {
    stores, presence: createPresenceReader(),
    getCurrentJid: () => 'alice@example.com', getXmpp: () => null,
    getE2EEManager: () => null, sendStanza: async () => {}, emit: () => {},
    emitSDK(event, payload) {
      if (event === 'room:history-messages') events.push(payload as SDKEvents['room:history-messages'])
      handlers.get(event)?.(payload as never)
    },
    registerMAMCollector(id, collector) {
      collectors.set(id, collector)
      return () => { collectors.delete(id) }
    },
    async sendIQ(iq) {
      const page = pages[requests++]
      if (!page) throw new Error('Unexpected room archive request')
      if (requests === 1) await beforeReply?.()
      const id = iq.getChild('query', MAM_NS)!.attrs.queryid
      for (const entry of page.entries) {
        collectors.get(id)!(xml('message', { from: ROOM },
          xml('result', { xmlns: MAM_NS, queryid: id, id: 'room-marker-archive-id' },
            xml('forwarded', { xmlns: 'urn:xmpp:forward:0' },
              xml('delay', { xmlns: 'urn:xmpp:delay', stamp: '2026-11-26T12:00:00Z' }), entry))))
      }
      return xml('iq', { type: 'result' }, xml('fin', { xmlns: MAM_NS, complete: String(page.complete) },
        xml('set', { xmlns: 'http://jabber.org/protocol/rsm' },
          ...(page.entries.length ? [xml('first', {}, 'room-marker-archive-id'), xml('last', {}, 'room-marker-archive-id')] : []))))
    },
  }
  try {
    await new MAM(deps).queryRoomArchive({ roomJid: ROOM, before: '', ...options })
    return { events, requests }
  } finally {
    unbind()
  }
}

// Intent: empty-room coverage must describe the whole unbounded raw query,
// not a display-filtered page or an empty final page of a nonempty walk.
describe('room archive emptiness evidence', () => {
  it('certifies a completed positive-sized empty fetch-latest', async () => {
    const { events, requests } = await query([{ entries: [], complete: true }])
    expect(requests).toBe(1)
    expect(events).toHaveLength(1)
    expect(events[0].emptyRoomArchive).toBe(true)
    expect(roomStore.getState().getRoomMAMQueryState(ROOM).emptyArchiveProof).toBeDefined()
  })

  it.each(['remove', 'leave', 'membership-loss', 'session-membership-reset'] as const)(
    'does not reinstall empty proof from a reply held across %s and rejoin', async boundary => {
      let start!: () => void
      let finish!: () => void
      const started = new Promise<void>(resolve => { start = resolve })
      const held = new Promise<void>(resolve => { finish = resolve })
      const running = query([{ entries: [], complete: true }], {}, async () => {
        start()
        await held
      })
      await started
      if (boundary === 'remove') roomStore.getState().removeRoom(ROOM)
      else if (boundary === 'leave') roomStore.getState().setRoomJoined(ROOM, false)
      else if (boundary === 'membership-loss') roomStore.getState().updateRoom(ROOM, { joined: false })
      else roomStore.getState().markAllRoomsNotJoined()
      if (boundary === 'remove') roomStore.getState().addRoom(joinedRoom())
      else roomStore.getState().setRoomJoined(ROOM, true)
      finish()
      const { events, requests } = await running
      expect(requests).toBe(1)
      expect(events).toHaveLength(1)
      expect(events[0].complete).toBe(true)
      expect(events[0].emptyRoomArchive).toBe(false)
      expect(roomStore.getState().getRoomMAMQueryState(ROOM).hasQueried).toBe(true)
      expect(roomStore.getState().getRoomMAMQueryState(ROOM).emptyArchiveProof).toBeUndefined()
      await query([{ entries: [], complete: true }])
      expect(roomStore.getState().getRoomMAMQueryState(ROOM).emptyArchiveProof).toBeDefined()
    },
  )

  it('does not certify a query issued before membership even if the room joins before its reply', async () => {
    roomStore.getState().setRoomJoined(ROOM, false)
    const { events } = await query([{ entries: [], complete: true }], {}, async () => {
      roomStore.getState().setRoomJoined(ROOM, true)
    })
    expect(events[0].emptyRoomArchive).toBe(false)
    expect(roomStore.getState().getRoomMAMQueryState(ROOM).emptyArchiveProof).toBeUndefined()
  })

  it('does not certify a walk with a standalone marker before an empty final page', async () => {
    const marker = xml('message', { xmlns: 'jabber:client', type: 'groupchat', from: `${ROOM}/bob`, id: 'marker' },
      xml('displayed', { xmlns: 'urn:xmpp:chat-markers:0', id: 'previous-message' }))
    const { events, requests } = await query([
      { entries: [marker], complete: false }, { entries: [], complete: true },
    ])
    expect(requests).toBe(2)
    expect(events).toHaveLength(1)
    expect(events[0].messages).toEqual([])
    expect(events[0].emptyRoomArchive).toBe(false)
  })

  it.each([
    { name: 'zero-sized', options: { max: 0 } },
    { name: 'bounded', options: { end: '2026-11-26T12:00:00Z' } },
    { name: 'context', options: { preserveGapMarker: true } },
    { name: 'older-page', options: { before: 'previous-archive-id' } },
  ])('does not certify an empty $name query', async ({ options }) => {
    const { events } = await query([{ entries: [], complete: true }], options)
    expect(events).toHaveLength(1)
    expect(events[0].emptyRoomArchive).toBe(false)
  })
})
