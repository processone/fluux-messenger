import 'fake-indexeddb/auto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { parse } from 'ltx'
import type { Element } from '@xmpp/client'
import { MAM } from './MAM'
import { setupRoomSideEffects } from '../roomSideEffects'
import { setupBackgroundSyncSideEffects } from '../backgroundSync'
import { createMockClient, simulateFreshSession } from '../sideEffects.testHelpers'
import { roomStore } from '../../stores/roomStore'
import { connectionStore } from '../../stores/connectionStore'
import { MAM_ROOM_CATCHUP_DELAY_MS } from '../../utils/mamCatchUpUtils'
import { RoomReadMarkers, clearRoomReadMarkersLocalData, ROOM_READ_MARKERS_STORAGE_KEY, ROOM_MARKER_OCCUPANT_LIMIT } from './RoomReadMarkers'
import fixture from './fixtures/roomReadReplay.json'
import otherRoom from './fixtures/roomReadMarkers.json'
import { createMockPresenceReader, createMockRoom, createMockStores } from '../test-utils'
import type { ModuleDependencies } from './BaseModule'
import type { RoomMessage } from '../types'
import { parseMessageContent } from './messagingUtils'
import { makeReadPointer } from '../../stores/shared/readPointer'
import { setStorageScopeJid } from '../../utils/storageScope'
import { isNonAnonymousRoom, isPrivateRoom } from '../roomCapabilities'
import { getResource } from '../jid'
import { MAM_BACKGROUND_CONCURRENCY, MAM_CATCHUP_BACKWARD_MAX } from '../../utils/mamCatchUpUtils'

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
function harness(block?: 'discovery' | 'archive', self = false) {
  setStorageScopeJid(self ? 'alice@localhost' : 'bob@localhost')
  const owner = parse(self ? fixture.marker : fixture.newest).getChild('occupant-id', ACTOR_NS)!.attrs.id
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
      body: parsed.processedBody, timestamp: parsed.timestamp, isOutgoing: message.getChild('occupant-id', ACTOR_NS)!.attrs.id === owner }]
  })
  const targetId = parse(fixture.marker).getChild('displayed', 'urn:xmpp:chat-markers:0')!.attrs.id
  const target = rows.find(row => row.stanzaId === targetId)!
  const newest = rows.find(row => row.stanzaId === parse(fixture.newest).getChild('stanza-id', SID_NS)!.attrs.id)!
  const actor = parse(fixture.marker).getChild('occupant-id', ACTOR_NS)!.attrs.id
  const features = parse(fixture.disco).getChild('query', 'http://jabber.org/protocol/disco#info')!
    .getChildren('feature').map(feature => feature.attrs.var)
  const room = createMockRoom(fixture.room, { isPrivate: isPrivateRoom(features), isNonAnonymous: isNonAnonymousRoom(features), nickname: self ? PEER_NICK : OWN_NICK, joined: true, isJoining: false,
    occupants: new Map([
      [OWN_NICK, { nick: OWN_NICK, occupantId: newest.occupantId!, role: 'participant', affiliation: 'member' }],
      [PEER_NICK, { nick: PEER_NICK, occupantId: actor, role: 'moderator', affiliation: 'owner' }],
    ]) })
  room.readPointer = makeReadPointer(newest, 'room')
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
    getCurrentJid: () => self ? 'alice@localhost/browser' : 'bob@localhost/browser', getXmpp: () => connection,
    sendStanza: vi.fn<ModuleDependencies['sendStanza']>(async (_stanza, beforeWrite) => { beforeWrite?.() }), emit: vi.fn(), emitSDK: vi.fn(),
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
afterEach(() => { setStorageScopeJid(null); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers(); roomStore.getState().reset(); connectionStore.getState().reset() })

describe('room read positions after cached reconnect', () => {
  it.each(['cached preview', 'refresh preview', 'by ID', 'locate', 'cached catch-up', 'partial clear'] as const)('does not restore a self watermark from pre-clear %s work', async path => {
    setStorageScopeJid('alice@localhost')
    const h = harness('archive', true)
    for (const row of h.rows) row.isOutgoing = false
    const storage = localStorage
    if (path === 'partial clear') {
      const other = `${ROOM_READ_MARKERS_STORAGE_KEY}:${JSON.stringify(['other@localhost', 'consent'])}`
      storage.setItem(other, JSON.stringify({ enabled: true, rooms: [fixture.room] }))
      vi.stubGlobal('localStorage', new Proxy(storage, { get: (target, key) => key === 'setItem'
        ? (name: string, value: string) => { if (name === other) throw new DOMException('Quota exhausted', 'QuotaExceededError'); target.setItem(name, value) }
        : Reflect.get(target, key, target) }))
    } else expect(await h.markers.setRoomEnabled(fixture.room, true)).toBe(true)
    if (path === 'refresh preview') h.stores.room.loadPreviewFromCache.mockResolvedValue(null)
    if (path === 'locate') h.stores.room.getMessageByArchiveId.mockResolvedValue(null)
    const replayed = h.nextReplay()
    const pending = path === 'by ID' ? h.mam.fetchRoomMessageById(fixture.room, h.newest.stanzaId!)
      : path === 'locate' ? h.mam.locateRoomMessage(fixture.room, h.newest.stanzaId!)
      : path === 'cached catch-up' ? h.mam.catchUpRoomHistory(fixture.room, h.rows)
      : h.mam.fetchPreviewForRoom(fixture.room)
    await h.waiting
    try { expect(await clearRoomReadMarkersLocalData('alice@localhost')).toBe(path !== 'partial clear') } finally { vi.stubGlobal('localStorage', storage); h.release() }
    await pending
    await replayed
    const watermark = `${ROOM_READ_MARKERS_STORAGE_KEY}:${JSON.stringify(['alice@localhost', 'watermarks'])}`
    expect(localStorage.getItem(watermark)).toBeNull()
    expect(h.deps.sendStanza).not.toHaveBeenCalled()
    h.markers.cancelPending()
  })

  it('keeps peer display when an old page completes after local erasure', async () => {
    const h = harness('archive')
    const replayed = h.nextReplay()
    await h.mam.fetchPreviewForRoom(fixture.room)
    await h.waiting
    try { expect(await clearRoomReadMarkersLocalData('bob@localhost')).toBe(true) } finally { h.release() }
    await replayed
    expect(h.markers.readers(fixture.room, h.target)).toMatchObject([{ nick: PEER_NICK }])
    expect(h.deps.sendStanza).not.toHaveBeenCalled()
    h.markers.cancelPending()
  })

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

  it.each(['success', 'failure'] as const)('bounds multi-room recovery and releases slots after %s', async outcome => {
    const h = harness()
    // Scheduling-only eligibility stand-ins; protocol qualification is covered
    // by the real room fixture above. Request counts are measured, not seeded.
    vi.spyOn(h.markers, 'mayQualify').mockReturnValue(true)
    vi.spyOn(h.markers, 'ensureEligible').mockResolvedValue(true)
    const rooms = Array.from({ length: MAM_BACKGROUND_CONCURRENCY + 1 }, (_, i) => `${i}-${fixture.room}`)
    let release!: () => void
    let atCapacity!: () => void
    let allFinished!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    const capacity = new Promise<void>(resolve => { atCapacity = resolve })
    const finished = new Promise<void>(resolve => { allFinished = resolve })
    let started = 0, active = 0, peak = 0, completed = 0
    h.sendIQ.mockImplementation(async iq => {
      const ordinal = ++started
      active++; peak = Math.max(peak, active)
      if (started === MAM_BACKGROUND_CONCURRENCY) atCapacity()
      try {
        await gate
        if (outcome === 'failure' && ordinal === 1) throw new Error('Archive request failed')
        const response = parse(fixture.afterFin)
        response.attrs.from = iq.attrs.to
        return response
      } finally {
        active--
        if (++completed === rooms.length) allFinished()
      }
    })
    try {
      await Promise.all(rooms.map(room => h.mam.fetchPreviewForRoom(room)))
      await capacity
      expect(started).toBe(MAM_BACKGROUND_CONCURRENCY)
    } finally { release() }
    await finished
    expect(started).toBe(rooms.length)
    expect(peak).toBe(MAM_BACKGROUND_CONCURRENCY)
    h.markers.cancelPending()
  })
  it.each(['after', 'before'] as const)('inherits the room operation through a held purged %s cursor fallback', async direction => {
    const h = harness(undefined, true)
    const origin = vi.spyOn(h.markers, 'captureReplayBoundary')
    let release!: () => void
    let reached!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    const entered = new Promise<void>(resolve => { reached = resolve })
    const respond = h.sendIQ.getMockImplementation()!
    let first = true
    h.sendIQ.mockImplementation(async iq => {
      if (iq.getChild('query', MAM_NS) && first) {
        first = false; reached(); await gate
        throw Object.assign(new Error('item-not-found'), { condition: 'item-not-found' })
      }
      return respond(iq)
    })
    h.stores.room.getRoomCoverage.mockReturnValue({ bottomId: h.target.id })
    const replayed = h.nextReplay()
    const pending = h.mam.queryRoomArchive({ roomJid: fixture.room, [direction]: h.target.id })
    await entered
    expect(await clearRoomReadMarkersLocalData('alice@localhost')).toBe(true)
    release()
    const result = await pending
    await replayed
    expect(result.messages.some(row => row.stanzaId === h.target.stanzaId)).toBe(true)
    expect(origin).toHaveBeenCalledTimes(1)
    expect(localStorage.getItem(`${ROOM_READ_MARKERS_STORAGE_KEY}:${JSON.stringify(['alice@localhost', 'watermarks'])}`)).toBeNull()
  })

  it('inherits the room operation through held hydration and its catch-up query', async () => {
    const h = harness(undefined, true)
    const origin = vi.spyOn(h.markers, 'captureReplayBoundary')
    h.stores.connection.getStatus.mockReturnValue('online')
    let release!: () => void
    let reached!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    const entered = new Promise<void>(resolve => { reached = resolve })
    h.stores.room.loadMessagesFromCache.mockImplementationOnce(async () => { reached(); await gate; return [h.target] })
    const replayed = h.nextReplay()
    const pending = h.mam.catchUpRoom(fixture.room)
    await entered
    expect(await clearRoomReadMarkersLocalData('alice@localhost')).toBe(true)
    release()
    await pending
    await replayed
    expect(h.archiveRequests().some(iq => iq.getChild('query', MAM_NS)!.getChild('set', RSM_NS)!.getChildText('after') === h.target.stanzaId)).toBe(true)
    expect(origin).toHaveBeenCalledTimes(1)
    expect(localStorage.getItem(`${ROOM_READ_MARKERS_STORAGE_KEY}:${JSON.stringify(['alice@localhost', 'watermarks'])}`)).toBeNull()
  })

  it('inherits the force catch-up operation into rooms still waiting in its queue', async () => {
    const h = harness(undefined, true)
    const origin = vi.spyOn(h.markers, 'captureReplayBoundary')
    h.stores.connection.getStatus.mockReturnValue('online')
    const firstRoom = createMockRoom(otherRoom.room, { joined: true, isJoining: false })
    h.room.supportsMAM = true
    firstRoom.supportsMAM = true
    h.stores.room.joinedRooms.mockReturnValue([firstRoom, h.room])
    h.stores.room.getRoom.mockImplementation(jid => jid === firstRoom.jid ? firstRoom : h.room)
    vi.spyOn(Date, 'now').mockReturnValue(h.newest.timestamp.getTime() + 1_000)
    let release!: () => void
    let reached!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    const entered = new Promise<void>(resolve => { reached = resolve })
    const respond = h.sendIQ.getMockImplementation()!
    h.sendIQ.mockImplementation(async iq => {
      if (iq.getChild('query', MAM_NS) && iq.attrs.to === firstRoom.jid) {
        reached(); await gate
        const fin = parse(fixture.afterFin)
        fin.attrs.from = firstRoom.jid
        return fin
      }
      return respond(iq)
    })
    const replayed = h.nextReplay()
    const pending = h.mam.forceCatchUpAllRooms({ concurrency: 1 })
    await entered
    expect(await clearRoomReadMarkersLocalData('alice@localhost')).toBe(true)
    release()
    await pending
    await replayed
    expect(h.archiveRequests().map(iq => iq.attrs.to)).toEqual([firstRoom.jid, fixture.room])
    expect(origin).toHaveBeenCalledTimes(1)
    expect(localStorage.getItem(`${ROOM_READ_MARKERS_STORAGE_KEY}:${JSON.stringify(['alice@localhost', 'watermarks'])}`)).toBeNull()
  })

  it.each([['activation', false], ['activation', true], ['activation-latest', false], ['activation-latest', true], ['activation-around', false], ['activation-around', true], ['join', false], ['join', true], ['fresh-session', false], ['fresh-session', true]] as const)('carries the production %s cache-read origin into own watermark intake (cleared: %s)', async (path, cleared) => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    const h = harness(undefined, true)
    roomStore.getState().reset()
    connectionStore.getState().reset()
    h.room.supportsMAM = true
    roomStore.getState().addRoom(h.room)
    const client = createMockClient()
    if (path.startsWith('activation')) client.isConnected.mockReturnValue(false)
    Object.assign(client.internal.mam, {
      captureRoomReplay: h.mam.captureRoomReplay.bind(h.mam),
      catchUpRoomHistory: h.mam.catchUpRoomHistory.bind(h.mam),
    })
    let release!: () => void
    let reached!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    const entered = new Promise<void>(resolve => { reached = resolve })
    const load = roomStore.getState().loadMessagesFromCache
    const around = roomStore.getState().loadMessagesAroundFromCache
    roomStore.setState({
      loadMessagesFromCache: async () => {
        if (path !== 'activation-around') { reached(); await gate }
        return [h.target]
      },
      loadMessagesAroundFromCache: async () => { reached(); await gate; return [h.target] },
    })
    if (path === 'join') roomStore.getState().setActiveRoom(fixture.room)
    connectionStore.getState().setServerInfo({ identities: [], domain: 'localhost', features: [MAM_NS] })
    const cleanup = path === 'fresh-session' ? setupBackgroundSyncSideEffects(client) : setupRoomSideEffects(client)
    const replayed = h.nextReplay()
    try {
      simulateFreshSession(client)
      client._emitSDK('room:joined', { roomJid: fixture.room, joined: true })
      const activation = path === 'activation-latest' || path === 'activation-around'
        ? roomStore.getState().activateRoom(fixture.room) : undefined
      if (path === 'activation') roomStore.getState().setActiveRoom(fixture.room)
      if (path === 'fresh-session') await vi.advanceTimersByTimeAsync(MAM_ROOM_CATCHUP_DELAY_MS)
      await entered
      if (cleared) expect(await clearRoomReadMarkersLocalData('alice@localhost')).toBe(true)
      client.isConnected.mockReturnValue(true)
      release()
      await activation
      await replayed
      const saved = JSON.parse(localStorage.getItem(`${ROOM_READ_MARKERS_STORAGE_KEY}:${JSON.stringify(['alice@localhost', 'watermarks'])}`) ?? 'null')
      if (cleared) expect(saved).toBeNull()
      else expect(saved?.sent?.[fixture.room]?.archiveId).toBe(h.target.stanzaId)
      expect(h.deps.sendStanza).not.toHaveBeenCalled()
    } finally { release(); cleanup(); roomStore.setState({ loadMessagesFromCache: load, loadMessagesAroundFromCache: around }); h.markers.cancelPending() }
  })


})
