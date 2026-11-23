import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { parse } from 'ltx'
import type { Element } from '@xmpp/client'
import { MAM } from './MAM'
import { RoomReadMarkers, ROOM_MARKER_OCCUPANT_LIMIT } from './RoomReadMarkers'
import fixture from './fixtures/roomReadReplay.json'
import { createMockPresenceReader, createMockRoom, createMockStores } from '../test-utils'
import type { ModuleDependencies } from './BaseModule'
import type { RoomMessage } from '../types'
import { parseMessageContent } from './messagingUtils'
import { makeReadPointer } from '../../stores/shared/readPointer'
import { setStorageScopeJid } from '../../utils/storageScope'
import { isNonAnonymousRoom, isPrivateRoom } from '../roomCapabilities'
import { getResource } from '../jid'
import { MAM_CATCHUP_BACKWARD_MAX } from '../../utils/mamCatchUpUtils'

const MAM_NS = 'urn:xmpp:mam:2'
const RSM_NS = 'http://jabber.org/protocol/rsm'
const FORWARD_NS = 'urn:xmpp:forward:0'
const DELAY_NS = 'urn:xmpp:delay'
const SID_NS = 'urn:xmpp:sid:0'
const ACTOR_NS = 'urn:xmpp:occupant-id:0'
const OWN_NICK = getResource(parse(fixture.newest).attrs.from)!
const PEER_NICK = getResource(parse(fixture.marker).attrs.from)!

// Intent: approved reconnect archive replay. Captured server order is target,
// peer marker, then the newest cached row; forward catch-up misses the marker.
// Only transport and store boundaries are stand-ins. The real resolver owns
// the badge. Focused deterministic coverage runs with the archive checks.
function harness(block?: 'discovery' | 'archive') {
  let release!: () => void
  let entered!: () => void
  const held = new Promise<void>(resolve => { release = resolve })
  const waiting = new Promise<void>(resolve => { entered = resolve })
  const entries = fixture.archive.map(raw => parse(raw).getChild('result', MAM_NS)!)
  const rows: RoomMessage[] = entries.flatMap(entry => {
    const forwarded = entry.getChild('forwarded', FORWARD_NS)!
    const message = forwarded.getChild('message')!
    const body = message.getChildText('body')
    if (!body) return []
    const parsed = parseMessageContent({ messageEl: message, body,
      delayEl: forwarded.getChild('delay', DELAY_NS), expectedStanzaIdBy: fixture.room })
    return [{ type: 'groupchat', roomJid: fixture.room, id: message.attrs.id, originId: parsed.originId, stanzaId: parsed.stanzaId,
      from: message.attrs.from, nick: getResource(message.attrs.from)!, occupantId: message.getChild('occupant-id', ACTOR_NS)!.attrs.id,
      body: parsed.processedBody, timestamp: parsed.timestamp, isOutgoing: true }]
  })
  const targetId = parse(fixture.marker).getChild('displayed', 'urn:xmpp:chat-markers:0')!.attrs.id
  const target = rows.find(row => row.stanzaId === targetId)!
  const newest = rows.find(row => row.stanzaId === parse(fixture.newest).getChild('stanza-id', SID_NS)!.attrs.id)!
  const actor = parse(fixture.marker).getChild('occupant-id', ACTOR_NS)!.attrs.id
  const features = parse(fixture.disco).getChild('query', 'http://jabber.org/protocol/disco#info')!
    .getChildren('feature').map(feature => feature.attrs.var)
  const room = createMockRoom(fixture.room, { isPrivate: isPrivateRoom(features), isNonAnonymous: isNonAnonymousRoom(features), nickname: OWN_NICK, joined: true, isJoining: false,
    occupants: new Map([
      [OWN_NICK, { nick: OWN_NICK, occupantId: newest.occupantId!, role: 'participant', affiliation: 'member' }],
      [PEER_NICK, { nick: PEER_NICK, occupantId: actor, role: 'moderator', affiliation: 'owner' }],
    ]), readPointer: makeReadPointer(newest, 'room') })
  const stores = createMockStores()
  stores.room.getRoom = vi.fn(jid => jid === fixture.room ? room : undefined)
  stores.room.loadPreviewFromCache.mockResolvedValue(newest)
  stores.room.getAllRoomMessages = vi.fn(() => [])
  stores.room.getMessageByArchiveId = vi.fn(async (_jid, id) => rows.find(row => row.stanzaId === id) ?? null)
  const collectors = new Map<string, (stanza: Element) => void>()
  let connection = {} as ReturnType<ModuleDependencies['getXmpp']>
  const sendIQ = vi.fn<ModuleDependencies['sendIQ']>(async iq => {
    if (iq.getChild('query', 'http://jabber.org/protocol/disco#info')) {
      if (block === 'discovery') { entered(); await held }
      return parse(fixture.disco)
    }
    const query = iq.getChild('query', MAM_NS)!
    if (query.getChild('set', RSM_NS)!.getChild('after')) return parse(fixture.afterFin)
    if (block === 'archive') { entered(); await held }
    for (const raw of fixture.archive) {
      const stanza = parse(raw)
      stanza.getChild('result', MAM_NS)!.attrs.queryid = query.attrs.queryid
      collectors.get(query.attrs.queryid)!(stanza)
    }
    return parse(fixture.fin)
  })
  const deps: ModuleDependencies = { stores, presence: createMockPresenceReader(), sendIQ,
    getCurrentJid: () => 'bob@localhost/browser', getXmpp: () => connection,
    sendStanza: vi.fn(), emit: vi.fn(), emitSDK: vi.fn(),
    registerMAMCollector: (id, collector) => { collectors.set(id, collector); return () => { collectors.delete(id) } },
  }
  const markers = new RoomReadMarkers(deps)
  deps.getRoomReadMarkers = () => markers
  const completions: Array<{ resolve: () => void; reject: (error: unknown) => void }> = []
  const receive = markers.receive.bind(markers)
  vi.spyOn(markers, 'receive').mockImplementation(async (...args) => {
    try { await receive(...args); completions.shift()?.resolve() }
    catch (error) { completions.shift()?.reject(error); throw error }
  })
  return { release, waiting, nextReplay: () => new Promise<void>((resolve, reject) => { completions.push({ resolve, reject }) }),
    mam: new MAM(deps), markers, deps, room, rows, target, newest, stores, sendIQ,
    archiveRequests: () => sendIQ.mock.calls.map(([iq]) => iq).filter(iq => iq.getChild('query', MAM_NS)),
    freshSession: () => { connection = {} as typeof connection } }
}

beforeEach(() => { localStorage.clear(); setStorageScopeJid('bob@localhost') })
afterEach(() => { setStorageScopeJid(null); vi.restoreAllMocks() })

describe('room read positions after cached reconnect', () => {
  it('restores the marker before the cached edge once, outside the timeline and coverage', async () => {
    const h = harness()
    const pointer = h.room.readPointer
    const replayed = h.nextReplay()
    await Promise.all([h.mam.fetchPreviewForRoom(fixture.room), h.mam.fetchPreviewForRoom(fixture.room)])
    await replayed
    expect(h.markers.readers(fixture.room, h.target)).toMatchObject([{ nick: PEER_NICK }])
    expect(h.markers.readers(fixture.room, h.newest)).toEqual([])
    await h.mam.fetchPreviewForRoom(fixture.room)
    await h.markers.ensureEligible(fixture.room)
    const requests = h.archiveRequests()
    expect(requests).toHaveLength(1)
    const set = requests[0].getChild('query', MAM_NS)!.getChild('set', RSM_NS)!
    expect(set.getChildText('before')).toBe('')
    expect(set.getChildText('max')).toBe(String(MAM_CATCHUP_BACKWARD_MAX))
    expect(h.deps.emitSDK).not.toHaveBeenCalled()
    expect(h.deps.sendStanza).not.toHaveBeenCalled()
    expect(h.room.readPointer).toBe(pointer)
    expect(h.stores.room.getAllRoomMessages()).toEqual([])
    h.markers.cancelPending()
  })

  it('restores from cached catch-up too, and does not repeat that page for preview', async () => {
    const h = harness()
    const replayed = h.nextReplay()
    await h.mam.catchUpRoomHistory(fixture.room, h.rows)
    await replayed
    expect(h.markers.readers(fixture.room, h.target)).toMatchObject([{ nick: PEER_NICK }])
    await h.mam.fetchPreviewForRoom(fixture.room)
    await h.markers.ensureEligible(fixture.room)
    expect(h.archiveRequests().filter(iq => iq.getChild('query', MAM_NS)!.getChild('set', RSM_NS)!.getChild('before'))).toHaveLength(1)
    h.markers.cancelPending()
  })

  it('allows one new page when the captured session changes', async () => {
    const h = harness()
    const first = h.nextReplay()
    await h.mam.fetchPreviewForRoom(fixture.room)
    await first
    h.freshSession()
    const second = h.nextReplay()
    await h.mam.fetchPreviewForRoom(fixture.room)
    await second
    expect(h.archiveRequests()).toHaveLength(2)
    h.markers.cancelPending()
  })

  it('sends no replay page for an unjoined room, without consuming its later eligibility', async () => {
    const h = harness()
    h.room.joined = false
    await h.mam.fetchPreviewForRoom(fixture.room)
    expect(h.sendIQ).not.toHaveBeenCalled()
    h.room.joined = true
    const replayed = h.nextReplay()
    await h.mam.fetchPreviewForRoom(fixture.room)
    await replayed
    expect(h.archiveRequests()).toHaveLength(1)
    h.markers.cancelPending()
  })

  it.each(['discovery', 'archive'] as const)('does not hold cached preview or forward catch-up behind %s recovery', async phase => {
    const h = harness(phase)
    const replayed = h.nextReplay()
    try {
      const preview = h.mam.fetchPreviewForRoom(fixture.room)
      const history = h.mam.catchUpRoomHistory(fixture.room, h.rows)
      await h.waiting
      await Promise.all([preview, history])
      expect(h.archiveRequests().some(iq => iq.getChild('query', MAM_NS)!.getChild('set', RSM_NS)!.getChildText('after') === h.newest.stanzaId)).toBe(true)
    } finally { h.release() }
    await replayed
    h.markers.cancelPending()
  })

  it.each(['isPrivate', 'isNonAnonymous'] as const)('skips discovery when the join rules out %s', async flag => {
    const h = harness()
    h.room[flag] = false
    await h.mam.fetchPreviewForRoom(fixture.room)
    expect(h.sendIQ).not.toHaveBeenCalled()
    h.markers.cancelPending()
  })

  it('skips discovery at the stored roster-count boundary', async () => {
    const h = harness()
    // A controlled store-boundary reading, not a server-discovery response.
    vi.spyOn(h.room.occupants, 'size', 'get').mockReturnValue(ROOM_MARKER_OCCUPANT_LIMIT)
    await h.mam.fetchPreviewForRoom(fixture.room)
    expect(h.sendIQ).not.toHaveBeenCalled()
    h.markers.cancelPending()
  })

  it('does not offer unvalidated page-only rows as marker targets', async () => {
    const h = harness()
    h.stores.room.getMessageByArchiveId.mockResolvedValue(null)
    const replayed = h.nextReplay()
    await h.mam.fetchPreviewForRoom(fixture.room)
    await replayed
    expect(h.markers.readers(fixture.room, h.target)).toEqual([])
    expect(h.deps.emitSDK).not.toHaveBeenCalled()
    h.markers.cancelPending()
  })

})
