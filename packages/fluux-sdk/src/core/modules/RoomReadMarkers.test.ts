import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import { xml, type Element } from '@xmpp/client'
import { RoomReadMarkers, clearRoomReadMarkersLocalData } from './RoomReadMarkers'
import { MAM } from './MAM'
import { parse } from 'ltx'
import { parseMessageContent } from './messagingUtils'
import fixture from './fixtures/roomReadMarkers.json'
import { createMockRoom, createMockStores, createMockPresenceReader } from '../test-utils'
import type { ModuleDependencies } from './BaseModule'
import type { RoomMessage } from '../types'
import { makeReadPointer } from '../../stores/shared/readPointer'
import { setStorageScopeJid } from '../../utils/storageScope'
import { emitLocalRead } from '../../stores/localReadEvents'

// Source: approved room-only read-marker contract (issue #1453). These exercise
// the protocol boundary, not private implementation state or string searches.
const jid = 'alice@localhost'
const roomJid = fixture.room
const features: string[] = parse(fixture.disco).getChildren('feature').map((feature: Element) => feature.attrs.var)
const fixtureCount = Number(parse(fixture.disco).getChild('x', 'jabber:x:data')!.getChildren('field').find((field: Element) => field.attrs.var === 'muc#roominfo_occupants')!.getChildText('value'))
const disco = (flags = features, count = fixtureCount) => xml('iq', { type: 'result', from: roomJid },
  xml('query', { xmlns: 'http://jabber.org/protocol/disco#info' },
    ...flags.map(value => xml('feature', { var: value })),
    xml('x', { xmlns: 'jabber:x:data', type: 'result' },
      xml('field', { var: 'FORM_TYPE', type: 'hidden' }, xml('value', {}, 'http://jabber.org/protocol/muc#roominfo')),
      xml('field', { var: 'muc#roominfo_occupants' }, xml('value', {}, String(count))))))
const message = (id: string, time: number, extra: Partial<RoomMessage> = {}): RoomMessage => ({
  type: 'groupchat', roomJid, from: `${roomJid}/Bob`, nick: 'Bob', occupantId: 'bob-id',
  id: `client-${id}`, stanzaId: id, originId: undefined, body: 'Room reading proof',
  timestamp: new Date(time), isOutgoing: false, ...extra,
})
const marker = (id: string, occupantId = 'bob-id', nick = 'Bob') => xml('message', { type: 'groupchat', from: `${roomJid}/${nick}` },
  xml('displayed', { xmlns: 'urn:xmpp:chat-markers:0', id }), xml('occupant-id', { xmlns: 'urn:xmpp:occupant-id:0', id: occupantId }))

describe('RoomReadMarkers', () => {
  let stores: ReturnType<typeof createMockStores>
  let room: ReturnType<typeof createMockRoom>
  let markers: RoomReadMarkers
  let dependencies: ModuleDependencies
  let send: Mock<ModuleDependencies['sendStanza']>
  let iq: Mock<ModuleDependencies['sendIQ']>
  let account: string
  let focused: boolean
  let rows: RoomMessage[]
  beforeEach(() => {
    localStorage.clear()
    setStorageScopeJid(jid)
    account = jid
    focused = true
    rows = [message('archive-a', 1000), message('archive-b', 2000)]
    room = createMockRoom(roomJid, { nickname: 'Alice', joined: true, isJoining: false,
      occupants: new Map([
        ['Alice', { nick: 'Alice', occupantId: 'alice-id', role: 'participant', affiliation: 'member' }],
        ['Bob', { nick: 'Bob', occupantId: 'bob-id', role: 'participant', affiliation: 'member' }],
      ]), readPointer: makeReadPointer(rows[1], 'room') })
    room.isPrivate = true; room.supportsReactions = true
    room.readPointer = makeReadPointer(rows[1], 'room')
    stores = createMockStores()
    stores.room.getRoom = vi.fn((id: string) => id === roomJid ? room : undefined)
    stores.room.getAllRoomMessages = vi.fn(() => [{ jid: roomJid, messages: rows }])
    stores.room.getMessageByArchiveId = vi.fn(async (_room: string, id: string) => rows.find(row => row.stanzaId === id) ?? null)
    send = vi.fn<ModuleDependencies['sendStanza']>(async () => {})
    iq = vi.fn<ModuleDependencies['sendIQ']>(async () => disco())
    const connection = {} as ReturnType<ModuleDependencies['getXmpp']>
    dependencies = { stores, presence: createMockPresenceReader(), sendStanza: send, sendIQ: iq,
      getCurrentJid: () => `${account}/browser`, getXmpp: () => connection, emit: vi.fn(), emitSDK: vi.fn(),
    }
    markers = new RoomReadMarkers(dependencies, () => focused)
    markers.recordArchiveOrder(roomJid, rows.map(row => row.stanzaId!))
  })

  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); setStorageScopeJid(null) })

  it('starts with both consent gates off; enabling one room does not enable another', async () => {
    expect(markers.getConsent()).toEqual({ enabled: false, rooms: [] })
    markers.setRoomEnabled(roomJid, true)
    await markers.viewed(roomJid, rows[1])
    expect(send).not.toHaveBeenCalled()
    markers.setEnabled(true)
    expect(markers.isEnabledFor('another@conference.localhost')).toBe(false)
    await markers.viewed(roomJid, rows[1])
    expect(send).toHaveBeenCalledTimes(1)
    const stanza = send.mock.calls[0][0]
    expect(stanza.attrs).toMatchObject({ to: roomJid, type: 'groupchat' })
    expect(stanza.getChild('body')).toBeUndefined()
    expect(stanza.getChild('displayed', 'urn:xmpp:chat-markers:0')?.attrs.id).toBe(rows[1].stanzaId)
    expect(stanza.getChild('store', 'urn:xmpp:hints')).toBeDefined()
  })

  it.each(['muc_membersonly', 'muc_hidden', 'muc_nonanonymous', 'urn:xmpp:occupant-id:0', 'urn:xmpp:sid:0'])(
    'fails closed without %s even when broad private/reaction flags say yes', async missing => {
      markers.setEnabled(true); markers.setRoomEnabled(roomJid, true)
      iq.mockResolvedValue(disco(features.filter(feature => feature !== missing)))
      await markers.viewed(roomJid, rows[1])
      expect(send).not.toHaveBeenCalled()
    })

  it.each(['muc_public', 'muc_open', 'muc_semianonymous'])('rejects contradictory %s', async flag => {
    markers.setEnabled(true); markers.setRoomEnabled(roomJid, true)
    iq.mockResolvedValue(disco([...features, flag]))
    await markers.viewed(roomJid, rows[1])
    expect(send).not.toHaveBeenCalled()
  })

  it('rejects failed discovery and ambiguous or unrelated room-count forms', async () => {
    markers.setEnabled(true); markers.setRoomEnabled(roomJid, true)
    iq.mockRejectedValueOnce(new Error('Discovery unavailable'))
    await markers.viewed(roomJid, rows[1])
    expect(send).not.toHaveBeenCalled()
    const unrelated = disco()
    unrelated.getChild('query', 'http://jabber.org/protocol/disco#info')!.getChild('x', 'jabber:x:data')!
      .getChildren('field').find(field => field.attrs.var === 'FORM_TYPE')!.getChild('value')!.children = ['urn:example:other-form']
    const duplicate = disco()
    duplicate.getChild('query', 'http://jabber.org/protocol/disco#info')!.getChild('x', 'jabber:x:data')!
      .getChildren('field').find(field => field.attrs.var === 'muc#roominfo_occupants')!.children.push(xml('value', {}, '20'))
    for (const invalid of [unrelated, duplicate]) {
      markers.observe(xml('presence', { from: `${roomJid}/Bob` }))
      iq.mockResolvedValueOnce(invalid)
      await markers.viewed(roomJid, rows[1])
      expect(send).not.toHaveBeenCalled()
    }
  })

  it('accepts 19 occupants and rejects 20 or an unreliable count', async () => {
    markers.setEnabled(true); markers.setRoomEnabled(roomJid, true)
    for (let i = 2; i < 19; i++) room.occupants.set(`Member ${i}`, { nick: `Member ${i}`, occupantId: `member-${i}`, role: 'participant', affiliation: 'member' })
    iq.mockResolvedValue(disco(features, 19))
    await markers.viewed(roomJid, rows[0])
    expect(send).toHaveBeenCalledTimes(1)
    room.occupants.set('Member 19', { nick: 'Member 19', occupantId: 'member-19', role: 'participant', affiliation: 'member' })
    markers.observe(xml('presence', { from: `${roomJid}/Member 19` }))
    iq.mockResolvedValue(disco(features, 20))
    await markers.viewed(roomJid, rows[1])
    expect(send).toHaveBeenCalledTimes(1)
    room.occupants.delete('Member 19')
    markers.observe(xml('presence', { from: `${roomJid}/Member 19`, type: 'unavailable' }))
    iq.mockResolvedValue(disco(features, 18))
    await markers.viewed(roomJid, rows[1])
    expect(send).toHaveBeenCalledTimes(1)
  })

  it('rechecks focus, opt-out, occupancy and account after queued discovery', async () => {
    for (const invalidate of [() => { focused = false }, () => markers.setEnabled(false), () => { room.joined = false }, () => { account = 'bob@localhost' }, () => markers.cancelPending()]) {
      focused = true; room.joined = true; account = jid
      markers.observe(xml('presence', { from: `${roomJid}/Bob` }))
      markers.setEnabled(true); markers.setRoomEnabled(roomJid, true)
      let answer!: (value: ReturnType<typeof disco>) => void
      let started!: () => void
      const ready = new Promise<void>(resolve => { started = resolve })
      iq.mockImplementationOnce(() => new Promise(resolve => { answer = resolve; started() }))
      const pending = markers.viewed(roomJid, rows[1])
      await ready
      invalidate(); answer(disco())
      await pending
      expect(send).not.toHaveBeenCalled()
    }
  })

  it('does not send from own, encrypted, private, unconfirmed or beyond-pointer rows', async () => {
    markers.setEnabled(true); markers.setRoomEnabled(roomJid, true)
    for (const row of [message('own', 1000, { isOutgoing: true }), message('encrypted', 1000, { encryptedPayload: '<encrypted/>' }),
      message('private', 1000, { isPrivate: true }), message('local', 1000, { stanzaId: undefined }), message('ahead', 3000)]) {
      await markers.viewed(roomJid, row)
    }
    expect(send).not.toHaveBeenCalled()
  })

  it('persists account-scoped consent and forward-only watermark, including in-flight dedupe', async () => {
    markers.setEnabled(true); markers.setRoomEnabled(roomJid, true)
    await Promise.all([markers.viewed(roomJid, rows[1]), markers.viewed(roomJid, rows[1])])
    await markers.viewed(roomJid, rows[0])
    expect(send).toHaveBeenCalledTimes(1)
    markers.reload()
    await markers.viewed(roomJid, rows[1])
    expect(send).toHaveBeenCalledTimes(1)
    account = 'bob@localhost'
    expect(markers.getConsent()).toEqual({ enabled: false, rooms: [] })
  })

  it('shows valid incoming markers with consent off, forward only, without message/read side effects', async () => {
    await markers.receive(roomJid, marker('archive-b'))
    expect(markers.readers(roomJid, rows[1])).toMatchObject([{ occupantId: 'bob-id', nick: 'Bob' }])
    await markers.receive(roomJid, marker('archive-a'))
    await markers.receive(roomJid, marker('archive-b'))
    expect(markers.readers(roomJid, rows[0])).toHaveLength(0)
    expect(markers.readers(roomJid, rows[1])).toHaveLength(1)
    expect(send).not.toHaveBeenCalled()
    expect(stores.room.addMessage).not.toHaveBeenCalled()
    expect(stores.room.markAsRead).not.toHaveBeenCalled()
  })

  it('shares the live/archive resolver and resolves targets present in the same page', async () => {
    stores.room.getMessageByArchiveId = vi.fn(async () => null)
    stores.room.getAllRoomMessages = vi.fn(() => [])
    await markers.receive(roomJid, marker('archive-b'), rows)
    expect(markers.readers(roomJid, rows[1])).toHaveLength(1)
    await markers.receive(roomJid, marker('missing'), rows)
    expect(markers.readers(roomJid, rows[1])).toHaveLength(1)
  })

  it('rejects spoofed identity, foreign targets and ambiguous archive IDs', async () => {
    await markers.receive(roomJid, marker('archive-b', 'alice-id'))
    await markers.receive(roomJid, marker('archive-b', 'unknown-id'))
    await markers.receive(roomJid, marker('archive-b'), [rows[1], { ...rows[1], id: 'other-row', occupantId: 'other-author' }])
    rows[1] = { ...rows[1], roomJid: 'other@conference.localhost' }
    await markers.receive(roomJid, marker('archive-b'))
    expect(markers.readers(roomJid, message('archive-b', 2000))).toHaveLength(0)
  })

  it('ignores timestamps and nick/client-ID ordering in favor of the room archive page', async () => {
    rows[0] = { ...rows[0], timestamp: new Date(9000), id: 'z-client', nick: 'Zed' }
    rows[1] = { ...rows[1], timestamp: new Date(1000), id: 'a-client', nick: 'Aaron' }
    await markers.receive(roomJid, marker('archive-a'))
    await markers.receive(roomJid, marker('archive-b'))
    expect(markers.readers(roomJid, rows[0])).toHaveLength(0)
    expect(markers.readers(roomJid, rows[1])).toHaveLength(1)
  })

  it('drops pending publication on a room configuration update, including when discovery later succeeds', async () => {
    markers.setEnabled(true); markers.setRoomEnabled(roomJid, true)
    let answer!: (reply: ReturnType<typeof disco>) => void
    let started!: () => void
    const ready = new Promise<void>(resolve => { started = resolve })
    iq.mockImplementationOnce(() => new Promise(resolve => { answer = resolve; started() }))
    const pending = markers.viewed(roomJid, rows[1])
    await ready
    markers.observe(xml('message', { from: roomJid, type: 'groupchat' },
      xml('x', { xmlns: 'http://jabber.org/protocol/muc#user' }, xml('status', { code: '104' }))))
    answer(disco())
    await pending
    expect(send).not.toHaveBeenCalled()
  })

  it('clears account consent and watermark with local data and sends nothing from reload or private sync', async () => {
    markers.setEnabled(true); markers.setRoomEnabled(roomJid, true)
    await markers.viewed(roomJid, rows[1])
    send.mockClear()
    markers.reload()
    markers.observe(xml('message', { from: jid, type: 'headline' },
      xml('displayed', { xmlns: 'urn:xmpp:mds:displayed:0' })))
    expect(send).not.toHaveBeenCalled()
    clearRoomReadMarkersLocalData(jid)
    expect(markers.getConsent()).toEqual({ enabled: false, rooms: [] })
    await markers.viewed(roomJid, rows[1])
    expect(send).not.toHaveBeenCalled()
  })

  it('resolves a target outside the resident window without inserting or relocating a row', async () => {
    stores.room.getAllRoomMessages = vi.fn(() => [])
    await markers.receive(roomJid, marker('archive-b'))
    expect(markers.readers(roomJid, rows[1])).toMatchObject([{ occupantId: 'bob-id' }])
    expect(markers.readers(roomJid, rows[0])).toHaveLength(0)
    expect(stores.room.addMessage).not.toHaveBeenCalled()
  })

  it('does not substitute timestamps for an unknown server order', async () => {
    markers = new RoomReadMarkers(dependencies, () => focused)
    await markers.receive(roomJid, marker('archive-a'))
    await markers.receive(roomJid, marker('archive-b'))
    expect(markers.readers(roomJid, rows[0])).toHaveLength(1)
    expect(markers.readers(roomJid, rows[1])).toHaveLength(0)
  })

  it('requires an independent viewed row despite local-read, hydration and private-sync signals', async () => {
    markers.setEnabled(true); markers.setRoomEnabled(roomJid, true)
    const viewed = vi.spyOn(markers, 'viewed')
    emitLocalRead({ account: jid, kind: 'room', conversationId: roomJid, pointer: makeReadPointer(rows[1], 'room') })
    emitLocalRead({ account: jid, kind: 'chat', conversationId: 'bob@localhost', pointer: makeReadPointer({ id: 'chat-proof', stanzaId: 'chat-archive', from: 'bob@localhost', timestamp: rows[1].timestamp }, 'chat') })
    markers.reload()
    expect(markers.observe(xml('message', { from: jid, type: 'headline' },
      xml('displayed', { xmlns: 'urn:xmpp:mds:displayed:0' })))).toBe(false)
    expect(viewed).not.toHaveBeenCalled()
    expect(send).not.toHaveBeenCalled()
    await markers.viewed(roomJid, rows[0])
    expect(send).toHaveBeenCalledTimes(1)
    expect(send.mock.calls[0][0].getChild('displayed', 'urn:xmpp:chat-markers:0')!.attrs.id).toBe(rows[0].stanzaId)
  })

  it('uses an own replay as durable forward evidence across restart, never as a send trigger', async () => {
    markers.setEnabled(true); markers.setRoomEnabled(roomJid, true)
    await markers.viewed(roomJid, rows[0])
    rows.splice(1, 0, message('archive-between', 1500))
    const collectors = new Map<string, (stanza: Element) => void>()
    dependencies.registerMAMCollector = (id, collector) => { collectors.set(id, collector); return () => { collectors.delete(id) } }
    iq.mockImplementation(async (request: Element) => {
      if (request.getChild('query', 'http://jabber.org/protocol/disco#info')) return disco()
      const query = request.getChild('query', 'urn:xmpp:mam:2')!
      const after = query.getChild('set', 'http://jabber.org/protocol/rsm')!.getChildText('after')
      const page = rows.slice(rows.findIndex(row => row.stanzaId === after) + 1)
      for (const row of page) collectors.get(query.attrs.queryid)!(xml('message', { from: roomJid },
        xml('result', { xmlns: 'urn:xmpp:mam:2', id: row.stanzaId!, queryid: query.attrs.queryid },
          xml('forwarded', { xmlns: 'urn:xmpp:forward:0' }, xml('message', { type: 'groupchat', from: row.from })))))
      return xml('iq', { type: 'result', from: roomJid }, xml('fin', { xmlns: 'urn:xmpp:mam:2', complete: 'true' },
        xml('set', { xmlns: 'http://jabber.org/protocol/rsm' }, xml('last', {}, page.at(-1)?.stanzaId ?? ''))))
    })
    // A genuinely new service has no in-memory order graph from the old session.
    markers = new RoomReadMarkers(dependencies, () => focused)
    await markers.receive(roomJid, marker('archive-b', 'alice-id', 'Alice'), [], true)
    expect(send).toHaveBeenCalledTimes(1)
    markers = new RoomReadMarkers(dependencies, () => focused)
    await markers.viewed(roomJid, rows[1])
    expect(send).toHaveBeenCalledTimes(1)
  })

  it('does not revive an older opt-in or lose the send watermark after storage refuses an opt-out', async () => {
    markers.setEnabled(true); markers.setRoomEnabled(roomJid, true)
    await markers.viewed(roomJid, rows[1])
    // happy-dom binds and caches storage methods inside its proxy. Intercept
    // this boundary directly, retaining its real data and removal behavior.
    const storage = localStorage
    const fail = vi.fn(() => { throw new DOMException('Storage full', 'QuotaExceededError') })
    vi.stubGlobal('localStorage', new Proxy(storage, { get: (target, key) => key === 'setItem' ? fail : Reflect.get(target, key, target) }))
    expect(markers.setEnabled(false)).toBe(false)
    expect(fail).toHaveBeenCalled()
    expect(markers.getConsent()).toEqual({ enabled: false, rooms: [] })
    vi.unstubAllGlobals()
    markers = new RoomReadMarkers(dependencies, () => focused)
    expect(markers.getConsent()).toEqual({ enabled: false, rooms: [] })
    await markers.viewed(roomJid, rows[1])
    expect(send).toHaveBeenCalledTimes(1)
    markers.setEnabled(true); markers.setRoomEnabled(roomJid, true)
    markers.recordArchiveOrder(roomJid, rows.map(row => row.stanzaId!))
    await markers.viewed(roomJid, rows[0])
    expect(send).toHaveBeenCalledTimes(1)
  })

  it('resolves the actual captured server marker and verified room-assigned target', async () => {
    const packet = parse(fixture.message)
    const reflected = parse(fixture.marker)
    const parsed = parseMessageContent({ messageEl: packet, body: packet.getChildText('body')!, expectedStanzaIdBy: roomJid })
    const actor = reflected.getChild('occupant-id', 'urn:xmpp:occupant-id:0')!.attrs.id
    const author = packet.getChild('occupant-id', 'urn:xmpp:occupant-id:0')!.attrs.id
    // The captured stanza was delivered to Bob, who sees Alice as a peer.
    account = 'bob@localhost'
    setStorageScopeJid(account)
    room.nickname = 'Bob'
    room.occupants.set('Alice', { ...room.occupants.get('Alice')!, occupantId: actor })
    room.occupants.set('Bob', { ...room.occupants.get('Bob')!, occupantId: author })
    rows = [{ ...message(parsed.stanzaId!, parsed.timestamp.getTime()), id: packet.attrs.id,
      from: packet.attrs.from, nick: 'Bob', occupantId: author, body: parsed.processedBody, isOutgoing: true }]
    await markers.receive(roomJid, reflected)
    expect(markers.readers(roomJid, rows[0])).toMatchObject([{ occupantId: actor, nick: 'Alice' }])
    expect(send).not.toHaveBeenCalled()
  })

  it('flushes pending immutable roster updates before rebuilding badges', async () => {
    await markers.receive(roomJid, marker('archive-b'))
    const changed = { ...room, occupants: new Map(room.occupants) }
    const bob = changed.occupants.get('Bob')!
    changed.occupants.delete('Bob'); changed.occupants.set('Robert', { ...bob, nick: 'Robert' })
    dependencies.flushRoomOccupants = () => { room = changed }
    markers.roomChanged(roomJid)
    expect(markers.readers(roomJid, rows[1])).toMatchObject([{ occupantId: 'bob-id', nick: 'Robert' }])
  })

  it('accepts a delayed server replay under the actor’s former nick without inheriting a reused nick', async () => {
    await markers.receive(roomJid, marker('archive-a'))
    const bob = room.occupants.get('Bob')!
    room.occupants.delete('Bob'); room.occupants.set('Robert', { ...bob, nick: 'Robert' })
    room.occupants.set('Bob', { ...bob, occupantId: 'new-owner' })
    // The server now reports the extra occupant, so discovery remains reliable.
    iq.mockResolvedValue(disco(features, room.occupants.size))
    markers.observe(xml('presence', { from: `${roomJid}/Robert` }))
    await Promise.resolve()
    const traced = vi.spyOn(markers, 'receive')
    const replay = marker('archive-b')
    replay.children.push(xml('delay', { xmlns: 'urn:xmpp:delay', from: roomJid, stamp: '2026-05-01T10:00:00Z' }))
    expect(markers.observe(replay)).toBe(true)
    await traced.mock.results[0].value
    expect(markers.readers(roomJid, rows[1])).toMatchObject([{ occupantId: 'bob-id', nick: 'Robert' }])
  })

  it('runs the real MAM ingress before body filtering, resolving page targets without adding marker rows', async () => {
    const collectors = new Map<string, (stanza: Element) => void>()
    dependencies.registerMAMCollector = (id, collector) => { collectors.set(id, collector); return () => { collectors.delete(id) } }
    dependencies.getRoomReadMarkers = () => markers
    iq.mockImplementation(async (request: Element) => {
      if (request.getChild('query', 'http://jabber.org/protocol/disco#info')) return disco()
      const query = request.getChild('query', 'urn:xmpp:mam:2')!
      const deliver = (id: string, inner: Element) => collectors.get(query.attrs.queryid)!(
        xml('message', { from: roomJid }, xml('result', { xmlns: 'urn:xmpp:mam:2', id, queryid: query.attrs.queryid },
          xml('forwarded', { xmlns: 'urn:xmpp:forward:0' },
            xml('delay', { xmlns: 'urn:xmpp:delay', stamp: '2026-05-01T10:00:00Z' }), inner))))
      deliver('archive-b', xml('message', { type: 'groupchat', from: `${roomJid}/Bob`, id: rows[1].id },
        xml('body', {}, rows[1].body), xml('stanza-id', { xmlns: 'urn:xmpp:sid:0', by: roomJid, id: 'archive-b' }),
        xml('occupant-id', { xmlns: 'urn:xmpp:occupant-id:0', id: 'bob-id' })))
      deliver('marker-archive-id', marker('archive-b'))
      return xml('iq', { type: 'result', from: roomJid }, xml('fin', { xmlns: 'urn:xmpp:mam:2', complete: 'true' },
        xml('set', { xmlns: 'http://jabber.org/protocol/rsm' }, xml('first', {}, 'archive-b'), xml('last', {}, 'marker-archive-id'))))
    })
    const pointer = room.readPointer
    const archive = await new MAM(dependencies).queryRoomArchive({ roomJid, before: '' })
    expect(archive.messages).toHaveLength(1)
    expect(archive.messages[0].body).toBe(rows[1].body)
    expect(markers.readers(roomJid, archive.messages[0])).toMatchObject([{ occupantId: 'bob-id', nick: 'Bob' }])
    expect(room.readPointer).toBe(pointer)
    expect(stores.room.addMessage).not.toHaveBeenCalled()
    expect(stores.room.markAsRead).not.toHaveBeenCalled()
    expect(send).not.toHaveBeenCalled()
  })

  it('keeps identity across a nick change and hides departed/self occupants without nick inheritance', async () => {
    await markers.receive(roomJid, marker('archive-b'))
    const bob = room.occupants.get('Bob')!
    room.occupants.delete('Bob'); room.occupants.set('Robert', { ...bob, nick: 'Robert' })
    markers.roomChanged(roomJid)
    expect(markers.readers(roomJid, rows[1])).toMatchObject([{ occupantId: 'bob-id', nick: 'Robert' }])
    room.occupants.delete('Robert')
    room.occupants.set('Bob', { ...bob, occupantId: 'new-owner' })
    markers.roomChanged(roomJid)
    expect(markers.readers(roomJid, rows[1])).toHaveLength(0)
    await markers.receive(roomJid, marker('archive-b', 'alice-id', 'Alice'))
    expect(markers.readers(roomJid, rows[1])).toHaveLength(0)
  })

  it('reuses negative discovery and coalesces concurrent markers within the same roster epoch', async () => {
    iq.mockResolvedValue(disco([...features, 'muc_public']))
    await Promise.all([markers.receive(roomJid, marker('archive-a')), markers.receive(roomJid, marker('archive-b'))])
    await markers.receive(roomJid, marker('archive-b'))
    expect(iq).toHaveBeenCalledTimes(1)
    expect(markers.readers(roomJid, rows[1])).toHaveLength(0)
    markers.observe(xml('presence', { from: `${roomJid}/Bob` }))
    iq.mockResolvedValue(disco())
    await markers.receive(roomJid, marker('archive-b'))
    expect(iq).toHaveBeenCalledTimes(2)
    expect(markers.readers(roomJid, rows[1])).toHaveLength(1)
  })

  it('retains the last proven display during roster revalidation but cannot send from that stale proof', async () => {
    await markers.receive(roomJid, marker('archive-a'))
    const held = markers.readers(roomJid, rows[0])
    let answer!: (value: Element) => void
    iq.mockImplementationOnce(() => new Promise(resolve => { answer = resolve }))
    markers.observe(xml('presence', { from: `${roomJid}/Bob` }))
    markers.roomChanged(roomJid)
    expect(markers.eligible(roomJid)).toBe(false)
    expect(markers.showsBadges(roomJid)).toBe(true)
    expect(markers.readers(roomJid, rows[0])).toBe(held)
    const resolved = markers.receive(roomJid, marker('archive-b'))
    answer(disco())
    await resolved
    expect(markers.readers(roomJid, rows[0])).toHaveLength(0)
    expect(markers.readers(roomJid, rows[1])).toHaveLength(1)
    expect(send).not.toHaveBeenCalled()
  })

  it('waits for the room arrival queue before resolving a delayed burst target', async () => {
    const target = rows[1]
    rows = []
    let arrived!: (value: boolean) => void
    let started!: () => void
    const waiting = new Promise<void>(resolve => { started = resolve })
    const arrivals = new Promise<boolean>(resolve => { arrived = resolve })
    stores.room.waitForMessageArrivals = vi.fn<(roomJid: string) => Promise<boolean> | undefined>(() => { started(); return arrivals })
    const pending = markers.receive(roomJid, marker(target.stanzaId!), [], true)
    await Promise.race([waiting, pending])
    expect(stores.room.waitForMessageArrivals).toHaveBeenCalledWith(roomJid)
    expect(stores.room.getMessageByArchiveId).not.toHaveBeenCalled()
    rows = [target]
    arrived(true)
    await pending
    expect(stores.room.waitForMessageArrivals).toHaveBeenCalledWith(roomJid)
    expect(markers.readers(roomJid, target)).toHaveLength(1)
  })

  it('remembers an unsuccessful archive-order pair instead of walking it again on each view', async () => {
    markers.setEnabled(true); markers.setRoomEnabled(roomJid, true)
    await markers.viewed(roomJid, rows[1])
    markers = new RoomReadMarkers(dependencies, () => focused)
    dependencies.registerMAMCollector = () => () => {}
    iq.mockImplementation(async request => request.getChild('query', 'http://jabber.org/protocol/disco#info') ? disco()
      : xml('iq', { type: 'result', from: roomJid }, xml('fin', { xmlns: 'urn:xmpp:mam:2', complete: 'true' })))
    await markers.viewed(roomJid, rows[0])
    const queries = iq.mock.calls.length
    await markers.viewed(roomJid, rows[0])
    expect(iq).toHaveBeenCalledTimes(queries)
    expect(send).toHaveBeenCalledTimes(1)
  })

  it('resumes sharing when the existing archive lookup positively identifies a purged send anchor', async () => {
    markers.setEnabled(true); markers.setRoomEnabled(roomJid, true)
    await markers.viewed(roomJid, rows[0])
    markers = new RoomReadMarkers(dependencies, () => focused)
    dependencies.lookUpRoomArchiveAnchor = vi.fn(async () => ({ kind: 'absent' as const }))
    await markers.viewed(roomJid, rows[1])
    expect(dependencies.lookUpRoomArchiveAnchor).toHaveBeenCalledWith(roomJid, rows[0].stanzaId)
    expect(send).toHaveBeenCalledTimes(2)
    expect(send.mock.calls[1][0].getChild('displayed', 'urn:xmpp:chat-markers:0')?.attrs.id).toBe(rows[1].stanzaId)
  })

  it('continues a capped archive walk from its last proven cursor on the next view', async () => {
    markers.setEnabled(true); markers.setRoomEnabled(roomJid, true)
    await markers.viewed(roomJid, rows[0])
    markers = new RoomReadMarkers(dependencies, () => focused)
    const collectors = new Map<string, (stanza: Element) => void>()
    dependencies.registerMAMCollector = (id, collector) => { collectors.set(id, collector); return () => { collectors.delete(id) } }
    let page = 0
    const cursors: string[] = []
    iq.mockImplementation(async request => {
      if (request.getChild('query', 'http://jabber.org/protocol/disco#info')) return disco()
      const query = request.getChild('query', 'urn:xmpp:mam:2')!
      cursors.push(query.getChild('set', 'http://jabber.org/protocol/rsm')!.getChildText('after')!)
      const id = ++page > 20 ? rows[1].stanzaId! : `intermediate-${page}`
      collectors.get(query.attrs.queryid)!(xml('message', { from: roomJid }, xml('result', { xmlns: 'urn:xmpp:mam:2', queryid: query.attrs.queryid, id },
        xml('forwarded', { xmlns: 'urn:xmpp:forward:0' }, xml('message', { type: 'groupchat', from: `${roomJid}/Bob` })))))
      return xml('iq', { type: 'result', from: roomJid }, xml('fin', { xmlns: 'urn:xmpp:mam:2', complete: page > 20 ? 'true' : 'false' },
        xml('set', { xmlns: 'http://jabber.org/protocol/rsm' }, xml('last', {}, id))))
    })
    await markers.viewed(roomJid, rows[1])
    expect(send).toHaveBeenCalledTimes(1)
    expect(page).toBe(20)
    await markers.viewed(roomJid, rows[1])
    expect(cursors.at(-1)).toBe('intermediate-20')
    expect(send).toHaveBeenCalledTimes(2)
  })

  it('allows a fresh connection to replace a stalled send from an old session without order evidence', async () => {
    markers.setEnabled(true); markers.setRoomEnabled(roomJid, true)
    let answer!: (value: Element) => void
    let started!: () => void
    const ready = new Promise<void>(resolve => { started = resolve })
    iq.mockImplementationOnce(() => new Promise(resolve => { answer = resolve; started() }))
    const old = markers.viewed(roomJid, rows[1])
    await ready
    const connection = {} as ReturnType<ModuleDependencies['getXmpp']>
    dependencies.getXmpp = () => connection
    await markers.viewed(roomJid, rows[0])
    answer(disco())
    await old
    expect(send).toHaveBeenCalledTimes(1)
    expect(send.mock.calls[0][0].getChild('displayed', 'urn:xmpp:chat-markers:0')?.attrs.id).toBe(rows[0].stanzaId)
  })

  it('honors a different tab’s durable opt-out before its storage event arrives and notifies subscribed controls', async () => {
    markers.setEnabled(true); markers.setRoomEnabled(roomJid, true)
    const notify = vi.fn()
    const unsubscribe = markers.subscribe(notify)
    const otherTab = new RoomReadMarkers(dependencies, () => focused)
    otherTab.setEnabled(false)
    await markers.viewed(roomJid, rows[1])
    expect(send).not.toHaveBeenCalled()
    expect(markers.getConsent().enabled).toBe(false)
    const key = Array.from({ length: localStorage.length }, (_, i) => localStorage.key(i)).find(key => key?.includes('consent'))!
    window.dispatchEvent(new StorageEvent('storage', { key }))
    expect(notify).toHaveBeenCalledTimes(1)
    unsubscribe()
  })


  it('keeps this client opted out when storage refuses both the write and removal of an older consent', async () => {
    markers.setEnabled(true); markers.setRoomEnabled(roomJid, true)
    const storage = localStorage
    const refuse = () => { throw new DOMException('Storage unavailable', 'SecurityError') }
    vi.stubGlobal('localStorage', new Proxy(storage, { get: (target, key) =>
      key === 'setItem' || key === 'removeItem' ? refuse : Reflect.get(target, key, target) }))
    expect(markers.setEnabled(false)).toBe(false)
    markers.reload()
    expect(markers.getConsent()).toEqual({ enabled: false, rooms: [] })
    await markers.viewed(roomJid, rows[1])
    expect(send).not.toHaveBeenCalled()
  })


  it('refreshes a cached send watermark on connection takeover before the other tab’s storage event', async () => {
    markers.setEnabled(true); markers.setRoomEnabled(roomJid, true)
    const otherTab = new RoomReadMarkers(dependencies, () => focused)
    otherTab.recordArchiveOrder(roomJid, rows.map(row => row.stanzaId!))
    await otherTab.viewed(roomJid, rows[1])
    const connection = {} as ReturnType<ModuleDependencies['getXmpp']>
    dependencies.getXmpp = () => connection
    await markers.viewed(roomJid, rows[0])
    expect(send).toHaveBeenCalledTimes(1)
  })

})
