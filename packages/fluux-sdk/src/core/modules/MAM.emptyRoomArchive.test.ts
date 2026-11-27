import { beforeEach, describe, expect, it, vi } from 'vitest'
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
import type { Room, RoomMessage, RoomHistoryQueryOptions } from '../types'
import type { SDKEventSource } from '../types/eventSource'

const ROOM = 'lounge@conference.example.com'
const MAM_NS = 'urn:xmpp:mam:2'

type Page = { entries: Element[]; complete: boolean }

function joinedRoom(): Room {
  return { jid: ROOM, name: 'Lounge', nickname: 'alice', joined: true, isBookmarked: false,
    occupants: new Map(), unreadCount: 0, mentionsCount: 0, typingUsers: new Set() }
}

beforeEach(() => {
  vi.restoreAllMocks()
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

  it.each(['remove', 'leave', 'membership-loss', 'session-membership-reset', 'room-replacement'] as const)(
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
      else if (boundary === 'room-replacement') roomStore.getState().addRoom({ ...joinedRoom(), joined: false })
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

  it.each([
    { name: 'failed bounded', options: { end: '2026-11-26T12:00:00Z' }, fails: true },
    { name: 'failed forward', options: { after: 'previous-archive-id' }, fails: true },
    { name: 'completed bounded', options: { end: '2026-11-26T12:00:00Z' }, fails: false },
    { name: 'completed forward', options: { after: 'previous-archive-id' }, fails: false },
  ])('keeps membership authorization during an overlapping $name query', async ({ options, fails }) => {
    const { events } = await query([{ entries: [], complete: true }], {}, async () => {
      const overlapping = query([{ entries: [], complete: true }], options, async () => {
        if (fails) throw new Error('Room archive temporarily unavailable')
      })
      if (fails) {
        await expect(overlapping).rejects.toThrow('Room archive temporarily unavailable')
        expect(roomStore.getState().getRoomMAMQueryState(ROOM).error).toBe('Room archive temporarily unavailable')
      } else {
        await overlapping
        expect(roomStore.getState().getRoomMAMQueryState(ROOM).hasQueried).toBe(true)
      }
    })
    expect(events).toHaveLength(1)
    expect(events[0].emptyRoomArchive).toBe(true)
    expect(roomStore.getState().getRoomMAMQueryState(ROOM).emptyArchiveProof).toBeDefined()
  })

  // Intent: the empty-room private read must not depend on an unrelated
  // history query succeeding or another live row arriving to create coverage.
  it.each([
    { name: 'bounded', options: { end: '2026-11-26T12:00:00Z' } },
    { name: 'forward', options: { after: 'previous-archive-id' } },
  ])('anchors the first durable row before an overlapping $name query fails', async ({ options }) => {
    const otherRoom = 'workshop@conference.example.com'
    roomStore.getState().addRoom({ ...joinedRoom(), jid: otherRoom, name: 'Workshop' })
    roomStore.getState().setActiveRoom(otherRoom)
    let finish!: () => void
    let started!: () => void
    const held = new Promise<void>(resolve => { finish = resolve })
    const loading = new Promise<void>(resolve => { started = resolve })
    let overlapping!: ReturnType<typeof query>
    await query([{ entries: [], complete: true }], {}, async () => {
      overlapping = query([{ entries: [], complete: true }], options, async () => {
        started()
        await held
        throw new Error('Room archive temporarily unavailable')
      })
      await loading
    })
    expect(roomStore.getState().getRoomMAMQueryState(ROOM).emptyArchiveProof).toBeDefined()
    expect(roomStore.getState().getRoomMAMQueryState(ROOM).isLoading).toBe(true)
    const row: RoomMessage = {
      type: 'groupchat', roomJid: ROOM, from: `${ROOM}/bob`, nick: 'bob',
      originId: undefined, occupantId: undefined,
      id: 'first-live-message', stanzaId: 'first-live-archive-id', body: 'See you in the lounge',
      timestamp: new Date('2026-11-26T12:00:01Z'), isOutgoing: false,
    }
    const save = vi.spyOn(messageCache, 'saveMessageWithResult')
    await roomStore.getState().addMessage(ROOM, row)
    expect(save).toHaveBeenCalledOnce()
    // The store registered its anchor continuation before this await; cache
    // visibility alone would not prove that the loading query outlived it.
    await save.mock.results[0].value
    expect(await messageCache.getMessageByStanzaId('room', ROOM, row.stanzaId!)).not.toBeNull()
    roomStore.getState().applyRemoteDisplayed(ROOM, row.stanzaId!)
    await vi.waitFor(() => expect(roomStore.getState().roomMeta.get(ROOM)?.readPointer?.identity.messageId).toBe(row.id))
    expect(roomStore.getState().getRoomMAMQueryState(ROOM).isLoading).toBe(true)
    expect(roomStore.getState().rooms.get(ROOM)?.unreadCount).toBe(1)
    finish()
    await expect(overlapping).rejects.toThrow('Room archive temporarily unavailable')
    await vi.waitFor(() => expect(roomStore.getState().rooms.get(ROOM)?.unreadCount).toBe(0))
    expect(roomStore.getState().getRoomCoverage(ROOM)).toEqual({
      bottomId: row.stanzaId, countBottomId: row.stanzaId, topId: row.stanzaId,
    })
    expect(roomStore.getState().activeRoomJid).toBe(otherRoom)
  })

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
