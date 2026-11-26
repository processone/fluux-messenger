import { describe, expect, it } from 'vitest'
import { xml, type Element } from '@xmpp/client'
import { MAM } from './MAM'
import { createMockStores } from '../test-utils'
import { createPresenceReader } from '../presenceReader'
import type { ModuleDependencies } from './BaseModule'
import type { SDKEvents } from '../types/sdk-events'
import type { RoomHistoryQueryOptions } from '../types'

const ROOM = 'lounge@conference.example.com'
const MAM_NS = 'urn:xmpp:mam:2'

type Page = { entries: Element[]; complete: boolean }

async function query(pages: Page[], options: Partial<RoomHistoryQueryOptions> = {}) {
  const collectors = new Map<string, (packet: Element) => void>()
  const events: SDKEvents['room:history-messages'][] = []
  let requests = 0
  const deps: ModuleDependencies = {
    stores: createMockStores(), presence: createPresenceReader(),
    getCurrentJid: () => 'alice@example.com', getXmpp: () => null,
    getE2EEManager: () => null, sendStanza: async () => {}, emit: () => {},
    emitSDK(event, payload) {
      if (event === 'room:history-messages') events.push(payload as SDKEvents['room:history-messages'])
    },
    registerMAMCollector(id, collector) {
      collectors.set(id, collector)
      return () => { collectors.delete(id) }
    },
    async sendIQ(iq) {
      const page = pages[requests++]
      if (!page) throw new Error('Unexpected room archive request')
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
  await new MAM(deps).queryRoomArchive({ roomJid: ROOM, before: '', ...options })
  return { events, requests }
}

// Intent: empty-room coverage must describe the whole unbounded raw query,
// not a display-filtered page or an empty final page of a nonempty walk.
describe('room archive emptiness evidence', () => {
  it('certifies a completed positive-sized empty fetch-latest', async () => {
    const { events, requests } = await query([{ entries: [], complete: true }])
    expect(requests).toBe(1)
    expect(events).toHaveLength(1)
    expect(events[0].emptyRoomArchive).toBe(true)
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
