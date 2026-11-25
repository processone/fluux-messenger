import 'fake-indexeddb/auto'
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import { xml, type Element } from '@xmpp/client'
import { RoomReadMarkers, clearRoomReadMarkersLocalData, ROOM_MARKER_ORDER_PAGE_LIMIT, ROOM_MARKER_DISCOVERY_RETRY_DELAYS, ROOM_READ_MARKERS_STORAGE_KEY } from './RoomReadMarkers'
import { MAM } from './MAM'
import * as idbConnection from '../../utils/idbConnection'
import { parse } from 'ltx'
import { parseMessageContent } from './messagingUtils'
import fixture from './fixtures/roomReadMarkers.json'
import replayFixture from './fixtures/roomReadReplay.json'
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
const capturedTarget = parse(fixture.marker).getChild('displayed', 'urn:xmpp:chat-markers:0')!.attrs.id
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

// Hold a real test-backend transaction so another runtime can queue behind it.
// The database identity comes from the product's actual open, not a second pin.
async function holdConsentStorage() {
  const name = vi.mocked(indexedDB.open).mock.calls[0]?.[0]
  if (!name) throw new Error('Consent storage must be initialized before holding a transaction')
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(name)
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
  const transaction = db.transaction(db.objectStoreNames[0], 'readwrite')
  const store = transaction.objectStore(db.objectStoreNames[0])
  let released = false
  let started!: () => void
  const ready = new Promise<void>(resolve => { started = resolve })
  const done = new Promise<void>((resolve, reject) => {
    transaction.oncomplete = () => resolve()
    transaction.onabort = () => reject(transaction.error)
  })
  const pump = () => {
    store.get('turn').onsuccess = () => { started(); if (!released) pump() }
  }
  pump()
  await ready
  const waiting: (() => void)[] = []
  const create = IDBDatabase.prototype.transaction
  const spy = vi.spyOn(IDBDatabase.prototype, 'transaction').mockImplementation(function (this: IDBDatabase, stores, mode, options) {
    const next = create.call(this, stores, mode, options)
    if (mode === 'readwrite') waiting.shift()?.()
    return next
  })
  return {
    next: () => new Promise<void>(resolve => { waiting.push(resolve) }),
    release: async () => { released = true; await done; spy.mockRestore(); db.close() },
  }
}

function capturedRoomReading(source: typeof fixture & { archive?: readonly string[] } = fixture) {
  const packet = parse(source.message)
  const reflected = parse(source.marker)
  const forwarded = source.archive?.map(raw => parse(raw).getChild('result', 'urn:xmpp:mam:2')!.getChild('forwarded', 'urn:xmpp:forward:0')!)
    .find(entry => entry.getChild('message')!.attrs.id === packet.attrs.id)
  const parsed = parseMessageContent({ messageEl: packet, body: packet.getChildText('body')!,
    delayEl: forwarded?.getChild('delay', 'urn:xmpp:delay'), expectedStanzaIdBy: source.room })
  const actor = reflected.getChild('occupant-id', 'urn:xmpp:occupant-id:0')!.attrs.id
  const author = packet.getChild('occupant-id', 'urn:xmpp:occupant-id:0')!.attrs.id
  const row: RoomMessage = { type: 'groupchat', roomJid: source.room, id: packet.attrs.id, stanzaId: parsed.stanzaId, originId: parsed.originId,
    from: packet.attrs.from, nick: packet.attrs.from.slice(source.room.length + 1), occupantId: author,
    body: parsed.processedBody, timestamp: parsed.timestamp, isOutgoing: false }
  return { reflected, actor, author, row }
}

function pauseNextConsentOpen(fail = false) {
  const open = idbConnection.openIndexedDB
  let opened!: () => void
  let release!: () => void
  const ready = new Promise<void>(resolve => { opened = resolve })
  const held = new Promise<void>(resolve => { release = resolve })
  vi.spyOn(idbConnection, 'openIndexedDB').mockImplementationOnce(async (...args) => {
    const db = await open(...args)
    opened()
    await held
    if (fail) { db.close(); throw new DOMException('Storage denied', 'SecurityError') }
    return db
  })
  return { ready, release: () => release() }
}

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
    vi.spyOn(indexedDB, 'open')
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
    stores.room.getRoom = vi.fn((id: string) => id === room.jid ? room : undefined)
    stores.room.getAllRoomMessages = vi.fn(() => [{ jid: room.jid, messages: rows }])
    stores.room.getMessageByArchiveId = vi.fn(async (_room: string, id: string) => rows.find(row => row.stanzaId === id) ?? null)
    send = vi.fn<ModuleDependencies['sendStanza']>(async (_stanza, beforeWrite) => { beforeWrite?.() })
    iq = vi.fn<ModuleDependencies['sendIQ']>(async () => disco())
    const connection = {} as ReturnType<ModuleDependencies['getXmpp']>
    dependencies = { stores, presence: createMockPresenceReader(), sendStanza: send, sendIQ: iq,
      getCurrentJid: () => `${account}/browser`, getXmpp: () => connection, emit: vi.fn(), emitSDK: vi.fn(),
    }
    markers = new RoomReadMarkers(dependencies, () => focused)
    markers.recordArchiveOrder(roomJid, rows.map(row => row.stanzaId!))
  })

  function useCapturedSelfReading(source = fixture) {
    const captured = capturedRoomReading(source)
    room.jid = source.room
    room.occupants.set('Alice', { ...room.occupants.get('Alice')!, occupantId: captured.actor })
    room.occupants.set('Bob', { ...room.occupants.get('Bob')!, occupantId: captured.author })
    rows = [captured.row]
    room.readPointer = makeReadPointer(captured.row, 'room')
    markers.recordArchiveOrder(source.room, [captured.row.stanzaId!])
    return captured
  }

  afterEach(() => { markers.cancelPending(); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers(); setStorageScopeJid(null) })

  it.each([
    ['encryption', () => xml('openpgp', { xmlns: 'urn:xmpp:openpgp:0' })],
    ['reaction', () => xml('reactions', { xmlns: 'urn:xmpp:reactions:0', id: capturedTarget }, xml('reaction', {}, '👍'))],
    ['retraction', () => xml('retract', { xmlns: 'urn:xmpp:message-retract:1', id: capturedTarget })],
    ['moderation', () => xml('apply-to', { xmlns: 'urn:xmpp:fasten:0', id: capturedTarget }, xml('moderated', { xmlns: 'urn:xmpp:message-moderate:0' }))],
  ] as const)('does not consume a marker carrying %s content while sharing is off', (_kind, content) => {
    const packet = parse(fixture.marker) as Element
    expect(markers.observe(packet)).toBe(true)
    packet.children.push(content())
    // The payload is opaque here: its ordinary owner must still receive it.
    expect(markers.observe(packet)).toBe(false)
    expect(send).not.toHaveBeenCalled()
  })

  it.each(['presence', 'connection'] as const)('caps growing discovery backoff and resets it after %s changes', async reset => {
    vi.useFakeTimers()
    await markers.receive(roomJid, marker('archive-a'))
    const display = markers.readers(roomJid, rows[0])
    iq.mockRejectedValue(new Error('Room information unavailable'))
    markers.observe(xml('presence', { from: `${roomJid}/Bob` }))
    await vi.advanceTimersByTimeAsync(0)
    const initial = iq.mock.calls.length
    for (const [index, delay] of ROOM_MARKER_DISCOVERY_RETRY_DELAYS.entries()) {
      await vi.advanceTimersByTimeAsync(delay - 1)
      expect(iq).toHaveBeenCalledTimes(initial + index)
      await vi.advanceTimersByTimeAsync(1)
      expect(iq).toHaveBeenCalledTimes(initial + index + 1)
    }
    await vi.advanceTimersByTimeAsync(ROOM_MARKER_DISCOVERY_RETRY_DELAYS.at(-1)!)
    const capped = initial + ROOM_MARKER_DISCOVERY_RETRY_DELAYS.length + 1
    expect(iq).toHaveBeenCalledTimes(capped)
    expect(markers.readers(roomJid, rows[0])).toBe(display)
    expect(send).not.toHaveBeenCalled()
    if (reset === 'presence') {
      markers.observe(xml('presence', { from: `${roomJid}/Bob` }))
      await vi.advanceTimersByTimeAsync(0)
    } else {
      const connection = {} as ReturnType<ModuleDependencies['getXmpp']>
      dependencies.getXmpp = () => connection
      await markers.receive(roomJid, marker('archive-a'))
    }
    expect(iq).toHaveBeenCalledTimes(capped + 1)
    iq.mockResolvedValue(disco())
    await vi.advanceTimersByTimeAsync(ROOM_MARKER_DISCOVERY_RETRY_DELAYS[0] - 1)
    expect(iq).toHaveBeenCalledTimes(capped + 1)
    await vi.advanceTimersByTimeAsync(1)
    expect(markers.eligible(roomJid)).toBe(true)
    expect(iq).toHaveBeenCalledTimes(capped + 2)
  })

  it('starts off and needs only the room choice without enabling another room', async () => {
    expect(markers.getConsent()).toEqual({ enabled: false, rooms: [] })
    expect(await markers.setEnabled(true)).toBe(false)
    await markers.viewed(roomJid, rows[1])
    expect(send).not.toHaveBeenCalled()
    expect(await markers.setRoomEnabled(roomJid, true)).toBe(true)
    expect(markers.isEnabledFor('another@conference.localhost')).toBe(false)
    await markers.viewed(roomJid, rows[1])
    expect(send).toHaveBeenCalledTimes(1)
    const stanza = send.mock.calls[0][0]
    expect(stanza.attrs).toMatchObject({ to: roomJid, type: 'groupchat' })
    expect(stanza.getChild('body')).toBeUndefined()
    expect(stanza.getChild('displayed', 'urn:xmpp:chat-markers:0')?.attrs.id).toBe(rows[1].stanzaId)
    expect(stanza.getChild('store', 'urn:xmpp:hints')).toBeDefined()
  })

  // Source: the approved one-switch plan's keep-off migration and stale-tab safety.
  const consentKey = `${ROOM_READ_MARKERS_STORAGE_KEY}:${JSON.stringify([jid, 'consent'])}`
  const migrationKey = `${ROOM_READ_MARKERS_STORAGE_KEY}:${JSON.stringify([jid, 'migration'])}`
  it.each([
    { enabled: true, selected: true, expected: true },
    { enabled: true, selected: false, expected: false },
    { enabled: false, selected: true, expected: false },
    { enabled: false, selected: false, expected: false },
  ])('migrates legacy effective consent $enabled/$selected to $expected once', async ({ enabled, selected, expected }) => {
    localStorage.setItem(consentKey, JSON.stringify({ enabled, rooms: selected ? [roomJid] : [] }))
    await markers.reload()
    expect(markers.isEnabledFor(roomJid)).toBe(expected)
    expect(JSON.parse(localStorage.getItem(consentKey)!)).toMatchObject({ version: 3, rooms: expected ? [roomJid] : [] })
    expect(JSON.parse(localStorage.getItem(consentKey)!)).not.toHaveProperty('enabled')
    await markers.reload()
    expect(markers.isEnabledFor(roomJid)).toBe(expected)
    expect(markers.isEnabledFor('another@conference.localhost')).toBe(false)
    account = 'bob@localhost'
    expect(markers.isEnabledFor(roomJid)).toBe(false)
    expect(send).not.toHaveBeenCalled()
  })

  it.each([null, '{', '{}', '{"enabled":true}', '{"enabled":true,"rooms":[null]}', '{"enabled":"true","rooms":[]}', '{"version":3,"enabled":true,"rooms":[]}'])(
    'keeps missing or invalid preferences off: %s', async value => {
      if (value !== null) localStorage.setItem(consentKey, value)
      await markers.reload()
      expect(markers.isEnabledFor(roomJid)).toBe(false)
      expect(send).not.toHaveBeenCalled()
    })

  it('preserves sent watermarks through migration without publishing or enabling the old master API', async () => {
    expect(await markers.setRoomEnabled(roomJid, true)).toBe(true)
    await markers.viewed(roomJid, rows[1])
    send.mockClear()
    const watermarkKey = `${ROOM_READ_MARKERS_STORAGE_KEY}:${JSON.stringify([jid, 'watermarks'])}`
    const saved = localStorage.getItem(watermarkKey)
    expect(saved).not.toBeNull()
    localStorage.removeItem(migrationKey)
    localStorage.setItem(consentKey, JSON.stringify({ enabled: true, rooms: [roomJid] }))
    await markers.reload()
    expect(localStorage.getItem(watermarkKey)).toBe(saved)
    expect(markers.isEnabledFor(roomJid)).toBe(true)
    expect(await markers.setEnabled(true)).toBe(false)
    await markers.viewed(roomJid, rows[0])
    await markers.viewed(roomJid, rows[1])
    expect(localStorage.getItem(watermarkKey)).toBe(saved)
    expect(send).not.toHaveBeenCalled()
  })

  it('merges a second tab’s latest room choices and rejects stale legacy opt-ins after revocation', async () => {
    const otherTab = new RoomReadMarkers(dependencies, () => focused)
    const otherRoom = 'another@conference.localhost'
    try {
      expect(await markers.setRoomEnabled(roomJid, true)).toBe(true)
      await otherTab.setRoomEnabled(otherRoom, true)
      await markers.setRoomEnabled(roomJid, false)
      expect(markers.getConsent().rooms).toEqual([otherRoom])
      expect(otherTab.getConsent().rooms).toEqual([otherRoom])
      localStorage.setItem(consentKey, JSON.stringify({ enabled: true, rooms: [roomJid, otherRoom] }))
      expect(markers.isEnabledFor(roomJid)).toBe(false)
      await markers.reload()
      expect(markers.isEnabledFor(roomJid)).toBe(false)
      expect(otherTab.isEnabledFor(roomJid)).toBe(false)
      expect(await markers.setRoomEnabled(roomJid, true)).toBe(true)
      expect(markers.isEnabledFor(roomJid)).toBe(true)
      expect(send).not.toHaveBeenCalled()
    } finally { otherTab.cancelPending() }
  })

  it.each(['migration', 'consent'] as const)('keeps opt-ins off after refusal of the %s migration write', async kind => {
    localStorage.setItem(consentKey, JSON.stringify({ enabled: true, rooms: [roomJid] }))
    const refusedKey = kind === 'migration' ? migrationKey : consentKey
    const storage = localStorage
    vi.stubGlobal('localStorage', new Proxy(storage, { get: (target, key) => key === 'setItem'
      ? (key: string, value: string) => {
        if (key === refusedKey) throw new DOMException('Quota exhausted', 'QuotaExceededError')
        target.setItem(key, value)
      } : Reflect.get(target, key, target) }))
    await markers.reload()
    expect(markers.isEnabledFor(roomJid)).toBe(false)
    expect(storage.getItem(consentKey)).toBeNull()
    vi.stubGlobal('localStorage', storage)
    const reloaded = new RoomReadMarkers(dependencies, () => focused)
    try { await reloaded.reload(); expect(reloaded.isEnabledFor(roomJid)).toBe(false) } finally { reloaded.cancelPending() }
    expect(send).not.toHaveBeenCalled()
  })

  it('serializes an interleaved read, other-room revocation and stale write', async () => {
    expect(await markers.setRoomEnabled(roomJid, true)).toBe(true)
    const otherTab = new RoomReadMarkers(dependencies, () => focused)
    const otherRoom = 'another@conference.localhost'
    const storage = localStorage
    let armed = true
    let revoke: Promise<boolean> | undefined
    vi.stubGlobal('localStorage', new Proxy(storage, { get: (target, key) => key === 'getItem'
      ? (key: string) => {
        const value = target.getItem(key)
        if (key === consentKey && armed) {
          armed = false
          revoke = otherTab.setRoomEnabled(roomJid, false)
        }
        return value
      } : Reflect.get(target, key, target) }))
    try {
      await markers.setRoomEnabled(otherRoom, true)
      expect(revoke).toBeDefined()
      await revoke
      expect(markers.getConsent().rooms).toEqual([otherRoom])
      expect(otherTab.isEnabledFor(roomJid)).toBe(false)
    } finally { otherTab.cancelPending() }
  })

  it('serializes migration with a revocation between its legacy read and first write', async () => {
    localStorage.setItem(consentKey, JSON.stringify({ enabled: true, rooms: [roomJid] }))
    const otherTab = new RoomReadMarkers(dependencies, () => focused)
    const storage = localStorage
    let armed = true
    let revoke: Promise<boolean> | undefined
    vi.stubGlobal('localStorage', new Proxy(storage, { get: (target, key) => key === 'setItem'
      ? (key: string, value: string) => {
        if (key === migrationKey && armed) {
          armed = false
          revoke = otherTab.setRoomEnabled(roomJid, false)
        }
        target.setItem(key, value)
      } : Reflect.get(target, key, target) }))
    try {
      await markers.reload()
      expect(revoke).toBeDefined()
      await revoke
      expect(markers.isEnabledFor(roomJid)).toBe(false)
      expect(otherTab.getConsent().rooms).toEqual([])
      expect(send).not.toHaveBeenCalled()
    } finally { otherTab.cancelPending() }
  })

  it.each(['muc_membersonly', 'muc_hidden', 'muc_nonanonymous', 'urn:xmpp:occupant-id:0', 'urn:xmpp:sid:0'])(
    'fails closed without %s even when broad private/reaction flags say yes', async missing => {
      expect(await markers.setRoomEnabled(roomJid, true)).toBe(true)
      iq.mockResolvedValue(disco(features.filter(feature => feature !== missing)))
      await markers.viewed(roomJid, rows[1])
      expect(send).not.toHaveBeenCalled()
    })

  it.each(['muc_public', 'muc_open', 'muc_semianonymous'])('rejects contradictory %s', async flag => {
    expect(await markers.setRoomEnabled(roomJid, true)).toBe(true)
    iq.mockResolvedValue(disco([...features, flag]))
    await markers.viewed(roomJid, rows[1])
    expect(send).not.toHaveBeenCalled()
  })

  it('rejects failed discovery and ambiguous or unrelated room-count forms', async () => {
    expect(await markers.setRoomEnabled(roomJid, true)).toBe(true)
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
    expect(await markers.setRoomEnabled(roomJid, true)).toBe(true)
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
    for (const invalidate of [() => { focused = false }, async () => await markers.setRoomEnabled(roomJid, false), () => { room.joined = false }, () => { account = 'bob@localhost' }, () => markers.cancelPending()]) {
      focused = true; room.joined = true; account = jid
      markers.observe(xml('presence', { from: `${roomJid}/Bob` }))
      expect(await markers.setRoomEnabled(roomJid, true)).toBe(true)
      let answer!: (value: ReturnType<typeof disco>) => void
      let started!: () => void
      const ready = new Promise<void>(resolve => { started = resolve })
      iq.mockImplementationOnce(() => new Promise(resolve => { answer = resolve; started() }))
      const pending = markers.viewed(roomJid, rows[1])
      await ready
      await invalidate(); answer(disco())
      await pending
      expect(send).not.toHaveBeenCalled()
    }
  })

  it.each(['own', 'encrypted', 'private', 'unconfirmed', 'beyond pointer'] as const)('rejects the %s publication candidate using captured room rows', async kind => {
    const captured = useCapturedSelfReading(replayFixture)
    const newest = capturedRoomReading({ ...replayFixture, message: replayFixture.newest }).row
    const candidate = { ...(kind === 'unconfirmed' ? captured.row : newest) }
    if (kind === 'own') { account = 'bob@localhost'; setStorageScopeJid(account); room.nickname = 'Bob'; candidate.isOutgoing = true }
    if (kind === 'encrypted') candidate.encryptedPayload = '<openpgp xmlns="urn:xmpp:openpgp:0"/>'
    if (kind === 'private') candidate.isPrivate = true
    if (kind === 'unconfirmed') candidate.stanzaId = undefined
    rows = kind === 'unconfirmed' ? [candidate, newest] : [captured.row, candidate]
    room.readPointer = makeReadPointer(kind === 'beyond pointer' ? captured.row : kind === 'unconfirmed' ? newest : candidate, 'room')
    markers.recordArchiveOrder(replayFixture.room, [captured.row.stanzaId!, newest.stanzaId!])
    iq.mockImplementation(async () => parse(replayFixture.disco))
    expect(await markers.setRoomEnabled(replayFixture.room, true)).toBe(true)
    expect(await markers.ensureEligible(replayFixture.room)).toBe(true)
    if (candidate.stanzaId) expect(await stores.room.getMessageByArchiveId!(replayFixture.room, candidate.stanzaId)).toBe(candidate)
    await markers.viewed(replayFixture.room, candidate)
    expect(send).not.toHaveBeenCalled()
  })

  it('persists account-scoped consent and forward-only watermark, including in-flight dedupe', async () => {
    expect(await markers.setRoomEnabled(roomJid, true)).toBe(true)
    await Promise.all([markers.viewed(roomJid, rows[1]), markers.viewed(roomJid, rows[1])])
    await markers.viewed(roomJid, rows[0])
    expect(send).toHaveBeenCalledTimes(1)
    await markers.reload()
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
    expect(await markers.setRoomEnabled(roomJid, true)).toBe(true)
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

  it.each([false, true])('clears account data without recreating keys after read, reload or storage refresh (all accounts: %s)', async allAccounts => {
    expect(await markers.setRoomEnabled(roomJid, true)).toBe(true)
    await markers.viewed(roomJid, rows[1])
    send.mockClear()
    await markers.reload()
    markers.observe(xml('message', { from: jid, type: 'headline' },
      xml('displayed', { xmlns: 'urn:xmpp:mds:displayed:0' })))
    expect(send).not.toHaveBeenCalled()
    const unsubscribe = markers.subscribe(() => { markers.getConsent() })
    try {
      await clearRoomReadMarkersLocalData(jid, allAccounts)
      expect(markers.getConsent()).toEqual({ enabled: false, rooms: [] })
      window.dispatchEvent(new StorageEvent('storage', { key: null }))
      await markers.reload()
      await markers.viewed(roomJid, rows[1])
      for (const kind of ['consent', 'migration', 'watermarks']) {
        expect(localStorage.getItem(`${ROOM_READ_MARKERS_STORAGE_KEY}:${JSON.stringify([jid, kind])}`)).toBeNull()
      }
      expect(send).not.toHaveBeenCalled()
    } finally { unsubscribe() }
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
    expect(await markers.setRoomEnabled(roomJid, true)).toBe(true)
    const viewed = vi.spyOn(markers, 'viewed')
    emitLocalRead({ account: jid, kind: 'room', conversationId: roomJid, pointer: makeReadPointer(rows[1], 'room') })
    emitLocalRead({ account: jid, kind: 'chat', conversationId: 'bob@localhost', pointer: makeReadPointer({ id: 'chat-proof', stanzaId: 'chat-archive', from: 'bob@localhost', timestamp: rows[1].timestamp }, 'chat') })
    await markers.reload()
    expect(markers.observe(xml('message', { from: jid, type: 'headline' },
      xml('displayed', { xmlns: 'urn:xmpp:mds:displayed:0' })))).toBe(false)
    expect(viewed).not.toHaveBeenCalled()
    expect(send).not.toHaveBeenCalled()
    await markers.viewed(roomJid, rows[0])
    expect(send).toHaveBeenCalledTimes(1)
    expect(send.mock.calls[0][0].getChild('displayed', 'urn:xmpp:chat-markers:0')!.attrs.id).toBe(rows[0].stanzaId)
  })

  it('uses an own replay as durable forward evidence across restart, never as a send trigger', async () => {
    expect(await markers.setRoomEnabled(roomJid, true)).toBe(true)
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
    expect(await markers.setRoomEnabled(roomJid, true)).toBe(true)
    await markers.viewed(roomJid, rows[1])
    // happy-dom binds and caches storage methods inside its proxy. Intercept
    // this boundary directly, retaining its real data and removal behavior.
    const storage = localStorage
    const fail = vi.fn(() => { throw new DOMException('Storage full', 'QuotaExceededError') })
    vi.stubGlobal('localStorage', new Proxy(storage, { get: (target, key) => key === 'setItem' ? fail : Reflect.get(target, key, target) }))
    expect(await markers.setEnabled(false)).toBe(false)
    expect(fail).toHaveBeenCalled()
    expect(markers.getConsent()).toEqual({ enabled: false, rooms: [] })
    vi.stubGlobal('localStorage', storage)
    markers = new RoomReadMarkers(dependencies, () => focused)
    expect(markers.getConsent()).toEqual({ enabled: false, rooms: [] })
    await markers.viewed(roomJid, rows[1])
    expect(send).toHaveBeenCalledTimes(1)
    expect(await markers.setRoomEnabled(roomJid, true)).toBe(true)
    expect(markers.isEnabledFor(roomJid)).toBe(true)
    markers.recordArchiveOrder(roomJid, rows.map(row => row.stanzaId!))
    await markers.viewed(roomJid, rows[0])
    expect(send).toHaveBeenCalledTimes(1)
  })

  it('resolves the actual captured server marker and verified room-assigned target', async () => {
    const { reflected, actor, author, row } = capturedRoomReading()
    // The captured stanza was delivered to Bob, who sees Alice as a peer.
    account = 'bob@localhost'
    setStorageScopeJid(account)
    room.nickname = 'Bob'
    room.occupants.set('Alice', { ...room.occupants.get('Alice')!, occupantId: actor })
    room.occupants.set('Bob', { ...room.occupants.get('Bob')!, occupantId: author })
    rows = [{ ...row, isOutgoing: true }]
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
    const reactionArchiveId = 'reaction-archive-id'
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
      const mixed = marker('archive-b')
      mixed.children.push(xml('reactions', { xmlns: 'urn:xmpp:reactions:0', id: 'archive-b' }, xml('reaction', {}, '👍')))
      deliver(reactionArchiveId, mixed)
      return xml('iq', { type: 'result', from: roomJid }, xml('fin', { xmlns: 'urn:xmpp:mam:2', complete: 'true' },
        xml('set', { xmlns: 'http://jabber.org/protocol/rsm' }, xml('first', {}, 'archive-b'), xml('last', {}, reactionArchiveId))))
    })
    const pointer = room.readPointer
    const archive = await new MAM(dependencies).queryRoomArchive({ roomJid, before: '' })
    expect(archive.messages).toHaveLength(1)
    expect(archive.messages[0].body).toBe(rows[1].body)
    expect(archive.messages[0].reactions?.['👍']).toContain(rows[1].nick)
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

  it('excludes this account across device nicknames using its verified occupant identity', async () => {
    // Source: the request to ignore our own marker on every device. The room's
    // occupant ID is account-wide; a device nickname must not turn self into a peer.
    room.occupants.set('Alice phone', { ...room.occupants.get('Alice')!, nick: 'Alice phone' })
    iq.mockResolvedValue(disco(features, room.occupants.size))
    await markers.receive(roomJid, marker('archive-b', 'alice-id', 'Alice phone'))
    await markers.receive(roomJid, marker('archive-b'))
    expect(markers.readers(roomJid, rows[1])).toEqual([{ occupantId: 'bob-id', nick: 'Bob', avatar: undefined }])
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
    let started!: () => void
    const ready = new Promise<void>(resolve => { started = resolve })
    iq.mockImplementationOnce(() => new Promise(resolve => { answer = resolve; started() }))
    markers.observe(xml('presence', { from: `${roomJid}/Bob` }))
    markers.roomChanged(roomJid)
    expect(markers.eligible(roomJid)).toBe(false)
    expect(markers.showsBadges(roomJid)).toBe(true)
    expect(markers.readers(roomJid, rows[0])).toBe(held)
    const resolved = markers.receive(roomJid, marker('archive-b'))
    await ready
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
    expect(await markers.setRoomEnabled(roomJid, true)).toBe(true)
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
    expect(await markers.setRoomEnabled(roomJid, true)).toBe(true)
    await markers.viewed(roomJid, rows[0])
    markers = new RoomReadMarkers(dependencies, () => focused)
    dependencies.lookUpRoomArchiveAnchor = vi.fn(async () => ({ kind: 'absent' as const }))
    await markers.viewed(roomJid, rows[1])
    expect(dependencies.lookUpRoomArchiveAnchor).toHaveBeenCalledWith(roomJid, rows[0].stanzaId)
    expect(send).toHaveBeenCalledTimes(2)
    expect(send.mock.calls[1][0].getChild('displayed', 'urn:xmpp:chat-markers:0')?.attrs.id).toBe(rows[1].stanzaId)
  })

  it('continues a capped archive walk from its last proven cursor on the next view', async () => {
    expect(await markers.setRoomEnabled(roomJid, true)).toBe(true)
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
      const id = ++page > ROOM_MARKER_ORDER_PAGE_LIMIT ? rows[1].stanzaId! : `intermediate-${page}`
      collectors.get(query.attrs.queryid)!(xml('message', { from: roomJid }, xml('result', { xmlns: 'urn:xmpp:mam:2', queryid: query.attrs.queryid, id },
        xml('forwarded', { xmlns: 'urn:xmpp:forward:0' }, xml('message', { type: 'groupchat', from: `${roomJid}/Bob` })))))
      return xml('iq', { type: 'result', from: roomJid }, xml('fin', { xmlns: 'urn:xmpp:mam:2', complete: page > ROOM_MARKER_ORDER_PAGE_LIMIT ? 'true' : 'false' },
        xml('set', { xmlns: 'http://jabber.org/protocol/rsm' }, xml('last', {}, id))))
    })
    await markers.viewed(roomJid, rows[1])
    expect(send).toHaveBeenCalledTimes(1)
    expect(page).toBe(ROOM_MARKER_ORDER_PAGE_LIMIT)
    await markers.viewed(roomJid, rows[1])
    expect(cursors.at(-1)).toBe(`intermediate-${ROOM_MARKER_ORDER_PAGE_LIMIT}`)
    expect(send).toHaveBeenCalledTimes(2)
  })

  it('allows a fresh connection to replace a stalled send from an old session without order evidence', async () => {
    expect(await markers.setRoomEnabled(roomJid, true)).toBe(true)
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
    expect(await markers.setRoomEnabled(roomJid, true)).toBe(true)
    const notify = vi.fn()
    const unsubscribe = markers.subscribe(notify)
    const otherTab = new RoomReadMarkers(dependencies, () => focused)
    await otherTab.setRoomEnabled(roomJid, false)
    await markers.viewed(roomJid, rows[1])
    expect(send).not.toHaveBeenCalled()
    expect(markers.getConsent().enabled).toBe(false)
    const key = Array.from({ length: localStorage.length }, (_, i) => localStorage.key(i)).find(key => key?.includes('consent'))!
    window.dispatchEvent(new StorageEvent('storage', { key }))
    expect(notify).toHaveBeenCalledTimes(1)
    unsubscribe()
  })


  it('revokes an in-flight send from another tab before discovery finishes', async () => {
    expect(await markers.setRoomEnabled(roomJid, true)).toBe(true)
    let answer!: (reply: ReturnType<typeof disco>) => void
    let started!: () => void
    const ready = new Promise<void>(resolve => { started = resolve })
    iq.mockImplementationOnce(() => new Promise(resolve => { answer = resolve; started() }))
    const pending = markers.viewed(roomJid, rows[1])
    await ready
    const otherTab = new RoomReadMarkers(dependencies, () => focused)
    try {
      await otherTab.setRoomEnabled(roomJid, false)
      answer(disco())
      await pending
      expect(send).not.toHaveBeenCalled()
      expect(markers.isEnabledFor(roomJid)).toBe(false)
    } finally { otherTab.cancelPending() }
  })

  it('stops local publication immediately while opt-out waits behind another tab’s transaction', async () => {
    expect(await markers.setRoomEnabled(roomJid, true)).toBe(true)
    const held = await holdConsentStorage()
    const queued = held.next()
    const optOut = markers.setRoomEnabled(roomJid, false)
    try {
      await queued
      expect(markers.isEnabledFor(roomJid)).toBe(false)
      await markers.viewed(roomJid, rows[1])
      expect(send).not.toHaveBeenCalled()
    } finally { await held.release(); await optOut }
    expect(markers.isEnabledFor(roomJid)).toBe(false)
  })

  it.each(['connection', 'encryption manager', 'module teardown'] as const)(
    'keeps an initiating account’s queued Off through %s changes', async change => {
      expect(await markers.setRoomEnabled(roomJid, true)).toBe(true)
      const held = await holdConsentStorage()
      const queued = held.next()
      const optOut = markers.setRoomEnabled(roomJid, false)
      try {
        await queued
        if (change === 'connection') {
          dependencies.getXmpp = () => ({}) as ReturnType<ModuleDependencies['getXmpp']>
          dependencies.getCurrentJid = () => `${account}/reconnected`
        } else if (change === 'encryption manager') {
          dependencies.getE2EEManager = () => ({}) as ReturnType<NonNullable<ModuleDependencies['getE2EEManager']>>
        } else markers.cancelPending()
        expect(markers.isEnabledFor(roomJid)).toBe(false)
      } finally { await held.release() }
      const saved = await optOut
      expect(JSON.parse(localStorage.getItem(consentKey)!).rooms).toEqual([])
      expect(saved).toBe(true)
      expect(markers.getConsent().rooms).toEqual([])
      await markers.viewed(roomJid, rows[1])
      expect(send).not.toHaveBeenCalled()
    })

  it('requires a fresh focused observation after conversion instead of holding an old view across it', async () => {
    expect(await markers.setRoomEnabled(roomJid, true)).toBe(true)
    localStorage.removeItem(migrationKey)
    localStorage.setItem(consentKey, JSON.stringify({ enabled: true, rooms: [roomJid] }))
    const held = await holdConsentStorage()
    const queued = held.next()
    const conversion = markers.reload()
    await queued
    focused = false
    const oldView = markers.viewed(roomJid, rows[1])
    focused = true
    const connection = {} as ReturnType<ModuleDependencies['getXmpp']>
    dependencies.getXmpp = () => connection
    try { await held.release(); await conversion; await oldView } finally { focused = true }
    expect(markers.isEnabledFor(roomJid)).toBe(true)
    expect(send).not.toHaveBeenCalled()
    await markers.viewed(roomJid, rows[1])
    expect(send).toHaveBeenCalledTimes(1)
  })

  it.each([false, true])('orders an earlier queued edit in another runtime before clearing (all accounts: %s)', async allAccounts => {
    await markers.setRoomEnabled(roomJid, false)
    // A separately loaded module has the tab-local clear revision of another tab.
    vi.resetModules()
    const { clearRoomReadMarkersLocalData: clearOtherRuntime } = await import('./RoomReadMarkers')
    const held = await holdConsentStorage()
    const editQueued = held.next()
    const optIn = markers.setRoomEnabled(roomJid, true)
    await editQueued
    const clearQueued = held.next()
    const cleared = clearOtherRuntime(jid, allAccounts)
    try {
      expect(await Promise.race([clearQueued.then(() => 'queued'), cleared.then(() => 'finished')])).toBe('queued')
    } finally { await held.release() }
    await optIn
    await cleared
    expect(markers.isEnabledFor(roomJid)).toBe(false)
    for (const kind of ['consent', 'migration', 'watermarks']) {
      expect(localStorage.getItem(`${ROOM_READ_MARKERS_STORAGE_KEY}:${JSON.stringify([jid, kind])}`)).toBeNull()
    }
  })

  it.each([false, true])('finishes a concurrent consent write before clearing in another runtime (all accounts: %s)', async allAccounts => {
    await markers.setRoomEnabled(roomJid, false)
    vi.resetModules()
    const { clearRoomReadMarkersLocalData: clearOtherRuntime } = await import('./RoomReadMarkers')
    const storage = localStorage
    let armed = true
    let cleared: Promise<boolean> | undefined
    vi.stubGlobal('localStorage', new Proxy(storage, { get: (target, key) => key === 'setItem'
      ? (key: string, value: string) => {
        if (key === consentKey && armed) {
          armed = false
          cleared = clearOtherRuntime(jid, allAccounts)
        }
        target.setItem(key, value)
      } : Reflect.get(target, key, target) }))
    expect(await markers.setRoomEnabled(roomJid, true)).toBe(true)
    expect(cleared).toBeDefined()
    expect(await cleared).toBe(true)
    for (const kind of ['consent', 'migration', 'watermarks']) {
      expect(localStorage.getItem(`${ROOM_READ_MARKERS_STORAGE_KEY}:${JSON.stringify([jid, kind])}`)).toBeNull()
    }
    expect(markers.isEnabledFor(roomJid)).toBe(false)
  })

  it.each([false, true])('rejects an earlier edit still opening its database after another runtime clears (all accounts: %s)', async allAccounts => {
    await markers.setRoomEnabled(roomJid, false)
    vi.resetModules()
    const { clearRoomReadMarkersLocalData: clearOtherRuntime } = await import('./RoomReadMarkers')
    const opening = pauseNextConsentOpen()
    const optIn = markers.setRoomEnabled(roomJid, true)
    await opening.ready
    try { expect(await clearOtherRuntime(jid, allAccounts)).toBe(true) } finally { opening.release() }
    const saved = await optIn
    for (const kind of ['consent', 'migration', 'watermarks']) {
      expect(localStorage.getItem(`${ROOM_READ_MARKERS_STORAGE_KEY}:${JSON.stringify([jid, kind])}`)).toBeNull()
    }
    expect(saved).toBe(false)
    expect(markers.isEnabledFor(roomJid)).toBe(false)
  })

  it.each(['room', 'all'] as const)('preserves an unrelated account’s requested %s Off through a scoped clear', async mode => {
    expect(await markers.setRoomEnabled(roomJid, true)).toBe(true)
    vi.resetModules()
    const { clearRoomReadMarkersLocalData: clearOtherRuntime } = await import('./RoomReadMarkers')
    const opening = pauseNextConsentOpen()
    const off = mode === 'room' ? markers.setRoomEnabled(roomJid, false) : markers.setEnabled(false)
    await opening.ready
    try { expect(await clearOtherRuntime('other@localhost')).toBe(true) } finally { opening.release() }
    const saved = await off
    expect(JSON.parse(localStorage.getItem(consentKey)!).rooms).toEqual([])
    expect(saved).toBe(true)
    const fresh = new RoomReadMarkers(dependencies, () => focused)
    try { expect(fresh.isEnabledFor(roomJid)).toBe(false) } finally { fresh.cancelPending() }
  })

  it.each(['room', 'all', 'other room'] as const)('does not let a paused On override a later %s edit', async mode => {
    const kept = 'kept@conference.localhost'
    const other = 'other@conference.localhost'
    expect(await markers.setRoomEnabled(kept, true)).toBe(true)
    expect(await markers.setRoomEnabled(roomJid, false)).toBe(true)
    const opening = pauseNextConsentOpen()
    const delayed = markers.setRoomEnabled(roomJid, true)
    await opening.ready
    const next = new RoomReadMarkers(dependencies, () => focused)
    try {
      const target = mode === 'other room' ? other : roomJid
      if (mode !== 'all') expect(await next.setRoomEnabled(target, true)).toBe(true)
      expect(mode === 'all' ? await next.setEnabled(false) : await next.setRoomEnabled(target, false)).toBe(true)
    } finally { opening.release(); next.cancelPending() }
    const saved = await delayed
    const expected = mode === 'all' ? [] : mode === 'room' ? [kept] : [kept, roomJid]
    expect(markers.getConsent().rooms).toEqual(expected)
    expect(saved).toBe(mode === 'other room')
  })

  it.each(([['ordinary', 0, 'room'], ['ordinary', 0, 'other room'], ['fallback', 0, 'room'], ['fallback', 0, 'other room'], ['ordinary', 2, 'room'], ['ordinary', 2, 'other room'], ['fallback', 2, 'room'], ['fallback', 2, 'other room']] as const).flatMap(entry => ['unversioned', 'converted'].map(start => [...entry, start] as const)))('retains newer Off ordering after a legacy overwrite (%s fence, version %s, %s, %s start)', async (fence, version, target, start) => {
    if (fence === 'fallback') {
      localStorage.setItem(consentKey, JSON.stringify({ enabled: false, rooms: [] }))
      const storage = localStorage
      vi.stubGlobal('localStorage', new Proxy(storage, { get: (base, key) => key === 'setItem'
        ? (name: string, value: string) => { if (name === ROOM_READ_MARKERS_STORAGE_KEY + ':clear-generation') throw new DOMException('Quota exhausted', 'QuotaExceededError'); base.setItem(name, value) }
        : Reflect.get(base, key, base) }))
      try { expect(await clearRoomReadMarkersLocalData(jid)).toBe(false) }
      finally { vi.stubGlobal('localStorage', storage) }
    }
    if (start === 'converted') expect(await markers.setRoomEnabled(replayFixture.room, true)).toBe(true)
    const opening = pauseNextConsentOpen()
    const delayed = markers.setRoomEnabled(roomJid, true)
    await opening.ready
    const next = new RoomReadMarkers(dependencies, () => focused)
    const edited = target === 'room' ? roomJid : replayFixture.room
    try {
      expect(await next.setRoomEnabled(edited, true)).toBe(true)
      expect(await next.setRoomEnabled(edited, false)).toBe(true)
      localStorage.setItem(consentKey, JSON.stringify(version === 2 ? { version: 2, rooms: [roomJid] } : { enabled: false, rooms: [] }))
    } finally { opening.release(); next.cancelPending() }
    expect(await delayed).toBe(target === 'other room')
    await markers.reload()
    expect(markers.isEnabledFor(roomJid)).toBe(target === 'other room')
    if (target === 'other room') expect(markers.isEnabledFor(edited)).toBe(false)
  })

  it.each(['room', 'all'] as const)('keeps a failed %s Off durable when history replacement is refused', async mode => {
    localStorage.setItem(consentKey, JSON.stringify({ enabled: true, rooms: [roomJid] }))
    const opening = pauseNextConsentOpen()
    const delayed = markers.setRoomEnabled(roomJid, true)
    await opening.ready
    const next = new RoomReadMarkers(dependencies, () => focused)
    const storage = localStorage
    try {
      await next.reload()
      expect(next.isEnabledFor(roomJid)).toBe(true)
      vi.stubGlobal('localStorage', new Proxy(storage, { get: (base, key) => key === 'setItem'
        ? (name: string, value: string) => {
          if (name === migrationKey && value.startsWith('{')) throw new DOMException('History write denied', 'SecurityError')
          base.setItem(name, value)
        } : Reflect.get(base, key, base) }))
      expect(mode === 'room' ? await next.setRoomEnabled(roomJid, false) : await next.setEnabled(false)).toBe(false)
    } finally { vi.stubGlobal('localStorage', storage); opening.release(); next.cancelPending() }
    expect(await delayed).toBe(false)
    const fresh = new RoomReadMarkers(dependencies, () => focused)
    try {
      await fresh.reload()
      expect(fresh.isEnabledFor(roomJid)).toBe(false)
      expect(await fresh.setRoomEnabled(roomJid, true)).toBe(true)
    } finally { fresh.cancelPending() }
  })

  it('retries full sealing after history compaction frees quota for an unlisted account', async () => {
    const other = 'other@localhost'
    const next = new RoomReadMarkers({ ...dependencies, getCurrentJid: () => other + '/browser' }, () => focused)
    try { expect(await next.setRoomEnabled(roomJid, true)).toBe(true) } finally { next.cancelPending() }
    const otherConsent = `${ROOM_READ_MARKERS_STORAGE_KEY}:${JSON.stringify([other, 'consent'])}`
    const otherFence = `${ROOM_READ_MARKERS_STORAGE_KEY}:${JSON.stringify([other, 'migration'])}`
    localStorage.removeItem(otherConsent)
    const storage = localStorage
    const usage = () => Array.from({ length: storage.length }, (_, i) => storage.key(i)!).reduce((size, key) => size + key.length + storage.getItem(key)!.length, 0)
    const limit = usage()
    const opening = pauseNextConsentOpen()
    const delayed = markers.setRoomEnabled(roomJid, true)
    await opening.ready
    vi.stubGlobal('localStorage', new Proxy(storage, { get: (base, key) => key === 'setItem'
      ? (name: string, value: string) => {
        const old = base.getItem(name)
        if (usage() + value.length - (old?.length ?? 0) + (old === null ? name.length : 0) > limit) throw new DOMException('Quota exhausted', 'QuotaExceededError')
        base.setItem(name, value)
      } : Reflect.get(base, key, base) }))
    let cleared = false
    try { cleared = await clearRoomReadMarkersLocalData(null, true) }
    finally { vi.stubGlobal('localStorage', storage); opening.release() }
    expect(await delayed).toBe(false)
    expect(cleared).toBe(true)
    expect(storage.getItem(otherFence)).toBeNull()
  })

  it('retains converted independent identity through partial conversion and legacy overwrites', async () => {
    expect(await markers.setRoomEnabled(replayFixture.room, true)).toBe(true)
    const opening = pauseNextConsentOpen()
    const delayed = markers.setRoomEnabled(roomJid, true)
    await opening.ready
    const next = new RoomReadMarkers(dependencies, () => focused)
    const storage = localStorage
    try {
      expect(await next.setRoomEnabled(replayFixture.room, false)).toBe(true)
      localStorage.setItem(consentKey, JSON.stringify({ enabled: false, rooms: [] }))
      vi.stubGlobal('localStorage', new Proxy(storage, { get: (base, key) => key === 'setItem'
        ? (name: string, value: string) => { if (name === ROOM_READ_MARKERS_STORAGE_KEY + ':clear-generation') throw new DOMException('Quota exhausted', 'QuotaExceededError'); base.setItem(name, value) }
        : Reflect.get(base, key, base) }))
      expect(await clearRoomReadMarkersLocalData('other@localhost')).toBe(false)
      localStorage.setItem(consentKey, JSON.stringify({ enabled: true, rooms: [replayFixture.room] }))
    } finally { vi.stubGlobal('localStorage', storage); opening.release(); next.cancelPending() }
    expect(await delayed).toBe(true)
    expect(markers.isEnabledFor(roomJid)).toBe(true)
    expect(markers.isEnabledFor(replayFixture.room)).toBe(false)
  })

  it('retains newer room Off through partial unrelated conversion and legacy overwrites', async () => {
    const opening = pauseNextConsentOpen()
    const delayed = markers.setRoomEnabled(roomJid, true)
    await opening.ready
    const next = new RoomReadMarkers(dependencies, () => focused)
    const storage = localStorage
    try {
      expect(await next.setRoomEnabled(roomJid, true)).toBe(true)
      expect(await next.setRoomEnabled(roomJid, false)).toBe(true)
      localStorage.setItem(consentKey, JSON.stringify({ enabled: false, rooms: [] }))
      vi.stubGlobal('localStorage', new Proxy(storage, { get: (base, key) => key === 'setItem'
        ? (name: string, value: string) => { if (name === ROOM_READ_MARKERS_STORAGE_KEY + ':clear-generation') throw new DOMException('Quota exhausted', 'QuotaExceededError'); base.setItem(name, value) }
        : Reflect.get(base, key, base) }))
      expect(await clearRoomReadMarkersLocalData('other@localhost')).toBe(false)
      localStorage.setItem(consentKey, JSON.stringify({ enabled: false, rooms: [] }))
    } finally { vi.stubGlobal('localStorage', storage); opening.release(); next.cancelPending() }
    expect(await delayed).toBe(false)
    expect(markers.isEnabledFor(roomJid)).toBe(false)
  })

  it.each((['On', 'room Off', 'all Off'] as const).flatMap(mode =>
    [false, true].flatMap(allAccounts => ['cleared', 'fresh choice'].map(after => [mode, allAccounts, after] as const))))('keeps a failed opening from changing later clearing (%s, full: %s, %s)', async (mode, allAccounts, after) => {
    expect(await markers.setRoomEnabled(roomJid, true)).toBe(true)
    const opening = pauseNextConsentOpen(true)
    const pending = mode === 'all Off' ? markers.setEnabled(false) : markers.setRoomEnabled(roomJid, mode === 'On')
    await opening.ready
    const next = new RoomReadMarkers(dependencies, () => focused)
    let expected: Array<string | null> = []
    const keys = ['consent', 'migration', 'watermarks'].map(kind => `${ROOM_READ_MARKERS_STORAGE_KEY}:${JSON.stringify([jid, kind])}`)
    try {
      expect(await clearRoomReadMarkersLocalData(jid, allAccounts)).toBe(true)
      if (after === 'fresh choice') expect(await next.setRoomEnabled(replayFixture.room, true)).toBe(true)
      expected = keys.map(key => localStorage.getItem(key))
    } finally { opening.release(); next.cancelPending() }
    expect(await pending).toBe(false)
    expect(keys.map(key => localStorage.getItem(key))).toEqual(expected)
    const observer = new RoomReadMarkers(dependencies, () => focused)
    try { expect(observer.isEnabledFor(replayFixture.room)).toBe(after === 'fresh choice') }
    finally { observer.cancelPending() }
  })

  it.each(['On', 'room Off', 'all Off'] as const)('keeps a failed opening from deleting an independent edit (%s)', async mode => {
    expect(await markers.setRoomEnabled(roomJid, true)).toBe(true)
    const opening = pauseNextConsentOpen(true)
    const pending = mode === 'all Off' ? markers.setEnabled(false) : markers.setRoomEnabled(roomJid, mode === 'On')
    await opening.ready
    const next = new RoomReadMarkers(dependencies, () => focused)
    let expected: string | null = null
    try {
      expect(await next.setRoomEnabled(replayFixture.room, true)).toBe(true)
      expected = localStorage.getItem(consentKey)
    } finally { opening.release(); next.cancelPending() }
    expect(await pending).toBe(false)
    if (mode === 'On') expect(localStorage.getItem(consentKey)).toBe(expected)
    const observer = new RoomReadMarkers(dependencies, () => focused)
    try { expect(observer.isEnabledFor(replayFixture.room)).toBe(true); expect(observer.isEnabledFor(roomJid)).toBe(mode === 'On') }
    finally { observer.cancelPending() }
  })

  it.each(['On', 'room Off', 'all Off'] as const)('recovers only the requested revocation after a pre-write abort (%s)', async mode => {
    expect(await markers.setRoomEnabled(roomJid, true)).toBe(true)
    const expected = [localStorage.getItem(consentKey), localStorage.getItem(migrationKey)]
    const open = idbConnection.openIndexedDB
    vi.spyOn(idbConnection, 'openIndexedDB').mockImplementationOnce(async (...args) => {
      const db = await open(...args)
      const transaction = db.transaction.bind(db)
      vi.spyOn(db, 'transaction').mockImplementation((...options) => {
        const turn = transaction(...options)
        turn.abort()
        return turn
      })
      return db
    })
    expect(mode === 'all Off' ? await markers.setEnabled(false) : await markers.setRoomEnabled(roomJid, mode === 'On')).toBe(false)
    if (mode === 'On') expect([localStorage.getItem(consentKey), localStorage.getItem(migrationKey)]).toEqual(expected)
    const observer = new RoomReadMarkers(dependencies, () => focused)
    try { expect(observer.isEnabledFor(roomJid)).toBe(mode === 'On') }
    finally { observer.cancelPending() }
  })

  it.each(['On', 'room Off', 'all Off'] as const)('keeps an unowned transaction read failure from deleting newer state (%s)', async mode => {
    expect(await markers.setRoomEnabled(roomJid, true)).toBe(true)
    const opening = pauseNextConsentOpen()
    const pending = mode === 'all Off' ? markers.setEnabled(false) : markers.setRoomEnabled(roomJid, mode === 'On')
    await opening.ready
    const next = new RoomReadMarkers(dependencies, () => focused)
    const storage = localStorage
    let expected: string | null = null
    try {
      expect(await next.setRoomEnabled(replayFixture.room, true)).toBe(true)
      expected = storage.getItem(consentKey)
      let deny = true
      vi.stubGlobal('localStorage', new Proxy(storage, { get: (base, key) => key === 'getItem'
        ? (name: string) => {
          if (deny && name === consentKey) { deny = false; throw new DOMException('Storage unavailable', 'SecurityError') }
          return base.getItem(name)
        } : Reflect.get(base, key, base) }))
      opening.release()
      expect(await pending).toBe(false)
    } finally { vi.stubGlobal('localStorage', storage); opening.release(); next.cancelPending() }
    if (mode === 'On') expect(storage.getItem(consentKey)).toBe(expected)
    const observer = new RoomReadMarkers(dependencies, () => focused)
    try { expect(observer.isEnabledFor(replayFixture.room)).toBe(true); expect(observer.isEnabledFor(roomJid)).toBe(mode === 'On') }
    finally { observer.cancelPending() }
  })

  it.each(['On', 'room Off', 'all Off'] as const)('keeps unchanged opening-failure recovery protective (%s)', async mode => {
    expect(await markers.setRoomEnabled(roomJid, true)).toBe(true)
    const opening = pauseNextConsentOpen(true)
    const pending = mode === 'all Off' ? markers.setEnabled(false) : markers.setRoomEnabled(roomJid, mode === 'On')
    await opening.ready
    opening.release()
    expect(await pending).toBe(false)
    const observer = new RoomReadMarkers(dependencies, () => focused)
    try { await observer.reload(); expect(observer.isEnabledFor(roomJid)).toBe(false) }
    finally { observer.cancelPending() }
  })

  it.each((['room', 'all'] as const).flatMap(mode => ['independent edit', 'unrelated clear'].map(during => [mode, during] as const)))('keeps failed %s Off selective after an %s and blocks the outgoing marker', async (mode, during) => {
    expect(await markers.setRoomEnabled(roomJid, true)).toBe(true)
    await markers.viewed(roomJid, rows[0])
    expect(send).toHaveBeenCalledTimes(1)
    const opening = pauseNextConsentOpen(true)
    const pending = mode === 'all' ? markers.setEnabled(false) : markers.setRoomEnabled(roomJid, false)
    await opening.ready
    const next = new RoomReadMarkers(dependencies, () => focused)
    try {
      expect(await next.setRoomEnabled(replayFixture.room, true)).toBe(true)
      if (during === 'unrelated clear') expect(await clearRoomReadMarkersLocalData('other@localhost')).toBe(true)
    } finally { opening.release(); next.cancelPending() }
    expect(await pending).toBe(false)
    await markers.viewed(roomJid, rows[1])
    expect(send).toHaveBeenCalledTimes(1)
    expect(markers.isEnabledFor(roomJid)).toBe(false)
    const observer = new RoomReadMarkers(dependencies, () => focused)
    try { expect(observer.isEnabledFor(roomJid)).toBe(false); expect(observer.isEnabledFor(replayFixture.room)).toBe(true) }
    finally { observer.cancelPending() }
  })

  it('keeps a failed room Off locally suppressed when independent choices prevent cleanup and all revocation writes are denied', async () => {
    expect(await markers.setRoomEnabled(roomJid, true)).toBe(true)
    await markers.viewed(roomJid, rows[0])
    expect(send).toHaveBeenCalledTimes(1)
    const opening = pauseNextConsentOpen(true)
    const pending = markers.setRoomEnabled(roomJid, false)
    await opening.ready
    const next = new RoomReadMarkers(dependencies, () => focused)
    const storage = localStorage
    try {
      expect(await next.setRoomEnabled(replayFixture.room, true)).toBe(true)
      vi.stubGlobal('localStorage', new Proxy(storage, { get: (base, key) => key === 'setItem'
        ? (name: string, value: string) => { if (name === consentKey || name === migrationKey) throw new DOMException('Storage denied', 'SecurityError'); base.setItem(name, value) }
        : Reflect.get(base, key, base) }))
      opening.release()
      expect(await pending).toBe(false)
      await markers.viewed(roomJid, rows[1])
      expect(send).toHaveBeenCalledTimes(1)
      expect(markers.isEnabledFor(roomJid)).toBe(false)
      expect(markers.isEnabledFor(replayFixture.room)).toBe(true)
      vi.stubGlobal('localStorage', storage)
      expect(await next.setRoomEnabled(roomJid, false)).toBe(true)
      expect(await next.setRoomEnabled(roomJid, true)).toBe(true)
      expect(markers.isEnabledFor(roomJid)).toBe(true)
      await markers.viewed(roomJid, rows[1])
      expect(send).toHaveBeenCalledTimes(2)
    } finally { vi.stubGlobal('localStorage', storage); opening.release(); next.cancelPending() }
  })

  it.each(['room', 'all'] as const)('keeps newer independent choices when %s Off requires a compact fallback', async mode => {
    expect(await markers.setRoomEnabled(roomJid, true)).toBe(true)
    const opening = pauseNextConsentOpen()
    const pending = mode === 'all' ? markers.setEnabled(false) : markers.setRoomEnabled(roomJid, false)
    await opening.ready
    const next = new RoomReadMarkers(dependencies, () => focused)
    const storage = localStorage
    try {
      expect(await next.setRoomEnabled(replayFixture.room, true)).toBe(true)
      vi.stubGlobal('localStorage', new Proxy(storage, { get: (base, key) => key === 'setItem'
        ? (name: string, value: string) => { if (name === migrationKey && value.startsWith('{')) throw new DOMException('Quota exhausted', 'QuotaExceededError'); base.setItem(name, value) }
        : Reflect.get(base, key, base) }))
      opening.release()
      expect(await pending).toBe(false)
    } finally { vi.stubGlobal('localStorage', storage); opening.release(); next.cancelPending() }
    const observer = new RoomReadMarkers(dependencies, () => focused)
    try { expect(observer.isEnabledFor(roomJid)).toBe(false); expect(observer.isEnabledFor(replayFixture.room)).toBe(true) }
    finally { observer.cancelPending() }
  })

  it.each((['room', 'all'] as const).flatMap(mode => [false, true].flatMap(allAccounts =>
    ['legacy', 'converted'].flatMap(start => ['legacy overwrite', 'fresh choice'].map(after => [mode, allAccounts, start, after] as const)))))('does not let delayed %s Off touch a cleared account (full: %s, %s, %s)', async (mode, allAccounts, start, after) => {
    if (start === 'converted') expect(await markers.setRoomEnabled(roomJid, true)).toBe(true)
    else localStorage.setItem(consentKey, JSON.stringify({ enabled: true, rooms: [roomJid] }))
    const opening = pauseNextConsentOpen()
    const pending = mode === 'all' ? markers.setEnabled(false) : markers.setRoomEnabled(roomJid, false)
    await opening.ready
    const next = new RoomReadMarkers(dependencies, () => focused)
    let expected: Array<string | null> = []
    const keys = ['consent', 'migration', 'watermarks'].map(kind => `${ROOM_READ_MARKERS_STORAGE_KEY}:${JSON.stringify([jid, kind])}`)
    try {
      expect(await clearRoomReadMarkersLocalData(jid, allAccounts)).toBe(true)
      if (after === 'legacy overwrite') localStorage.setItem(consentKey, JSON.stringify({ enabled: true, rooms: [roomJid] }))
      else expect(await next.setRoomEnabled(replayFixture.room, true)).toBe(true)
      expected = keys.map(key => localStorage.getItem(key))
    } finally { opening.release(); next.cancelPending() }
    expect(await pending).toBe(true)
    expect(keys.map(key => localStorage.getItem(key))).toEqual(expected)
  })

  it.each([false, true])('keeps both independent Off requests through compact recovery (second opening fails: %s)', async fail => {
    const first = capturedRoomReading(replayFixture)
    const second = capturedRoomReading({ ...replayFixture, message: replayFixture.newest })
    const bRows = [first.row, second.row]
    const b = createMockRoom(replayFixture.room, { nickname: 'Alice', joined: true, isJoining: false, isPrivate: true,
      occupants: new Map([
        ['Alice', { nick: 'Alice', occupantId: first.actor, role: 'participant', affiliation: 'member' }],
        ['Bob', { nick: 'Bob', occupantId: first.author, role: 'participant', affiliation: 'member' }],
      ]) })
    b.readPointer = makeReadPointer(second.row, 'room')
    stores.room.getRoom.mockImplementation(id => id === roomJid ? room : id === b.jid ? b : undefined)
    stores.room.getAllRoomMessages.mockImplementation(() => [{ jid: roomJid, messages: rows }, { jid: b.jid, messages: bRows }])
    stores.room.getMessageByArchiveId.mockImplementation(async (_room, id) => [...rows, ...bRows].find(row => row.stanzaId === id) ?? null)
    iq.mockImplementation(async request => request.attrs.to === b.jid ? parse(replayFixture.disco) : disco())
    markers.recordArchiveOrder(b.jid, bRows.map(row => row.stanzaId!))
    expect(await markers.setRoomEnabled(roomJid, true)).toBe(true)
    expect(await markers.setRoomEnabled(b.jid, true)).toBe(true)
    await markers.viewed(roomJid, rows[0])
    await markers.viewed(b.jid, first.row)
    expect(send).toHaveBeenCalledTimes(2)
    const next = new RoomReadMarkers(dependencies, () => focused)
    next.recordArchiveOrder(b.jid, bRows.map(row => row.stanzaId!))
    const opening = pauseNextConsentOpen(fail)
    const pending = next.setRoomEnabled(b.jid, false)
    await opening.ready
    const storage = localStorage
    try {
      vi.stubGlobal('localStorage', new Proxy(storage, { get: (base, key) => key === 'setItem'
        ? (name: string, value: string) => { if (name === migrationKey && value.startsWith('{')) throw new DOMException('History write denied', 'SecurityError'); base.setItem(name, value) }
        : Reflect.get(base, key, base) }))
      expect(await markers.setRoomEnabled(roomJid, false)).toBe(false)
      await next.viewed(b.jid, second.row)
      expect(send).toHaveBeenCalledTimes(2)
    } finally { vi.stubGlobal('localStorage', storage); opening.release() }
    try {
      expect(await pending).toBe(!fail)
      await markers.viewed(roomJid, rows[1])
      await next.viewed(b.jid, second.row)
      expect(send).toHaveBeenCalledTimes(2)
      expect(markers.isEnabledFor(roomJid)).toBe(false)
      expect(next.isEnabledFor(b.jid)).toBe(false)
      const observer = new RoomReadMarkers(dependencies, () => focused)
      try { expect(observer.isEnabledFor(roomJid)).toBe(false); expect(observer.isEnabledFor(b.jid)).toBe(false) }
      finally { observer.cancelPending() }
    } finally { next.cancelPending() }
  })

  it.each((['normal', 'compact'] as const).flatMap(kind => ['current', 'legacy'].map(start => [kind, start] as const)))('preserves independent consent when the %s fence succeeds but its consent write is refused (%s)', async (kind, start) => {
    expect(await markers.setRoomEnabled(roomJid, true)).toBe(true)
    expect(await markers.setRoomEnabled(replayFixture.room, true)).toBe(true)
    await markers.viewed(roomJid, rows[0])
    expect(send).toHaveBeenCalledTimes(1)
    if (start === 'legacy') {
      localStorage.setItem(consentKey, JSON.stringify({ enabled: true, rooms: [roomJid, replayFixture.room] }))
      localStorage.removeItem(migrationKey)
    }
    const storage = localStorage
    const original = storage.getItem(consentKey)
    try {
      vi.stubGlobal('localStorage', new Proxy(storage, { get: (base, key) => key === 'setItem'
        ? (name: string, value: string) => {
          if (name === consentKey || (name === migrationKey && (kind === 'compact' ? value.startsWith('{') : value.startsWith('~')))) throw new DOMException('Write denied', 'SecurityError')
          base.setItem(name, value)
        } : Reflect.get(base, key, base) }))
      expect(await markers.setRoomEnabled(roomJid, false)).toBe(false)
      expect(storage.getItem(consentKey)).toBe(original)
      const observer = new RoomReadMarkers(dependencies, () => focused)
      observer.recordArchiveOrder(roomJid, rows.map(row => row.stanzaId!))
      try {
        await observer.reload()
        expect(observer.isEnabledFor(replayFixture.room)).toBe(true)
        expect(observer.isEnabledFor(roomJid)).toBe(false)
        await observer.viewed(roomJid, rows[1])
        expect(send).toHaveBeenCalledTimes(1)
      } finally { observer.cancelPending() }
    } finally { vi.stubGlobal('localStorage', storage) }
  })

  it.each(['clear', 'selective recovery'] as const)('retires all-Off suppression after %s and preserves newer consent on the next initiating edit', async kind => {
    expect(await markers.setRoomEnabled(roomJid, true)).toBe(true)
    const opening = pauseNextConsentOpen(kind === 'selective recovery')
    const pending = markers.setEnabled(false)
    await opening.ready
    const next = new RoomReadMarkers(dependencies, () => focused)
    try {
      if (kind === 'clear') expect(await clearRoomReadMarkersLocalData(jid)).toBe(true)
      expect(await next.setRoomEnabled(replayFixture.room, true)).toBe(true)
    } finally { opening.release(); next.cancelPending() }
    expect(await pending).toBe(kind === 'clear')
    expect(markers.getConsent().rooms).toEqual([replayFixture.room])
    expect(markers.isEnabledFor(replayFixture.room)).toBe(true)
    expect(await markers.setRoomEnabled(roomJid, true)).toBe(true)
    expect(markers.getConsent().rooms).toEqual([replayFixture.room, roomJid])
  })

  it('merges stored independent choices rather than local failure suppression on a subsequent edit', async () => {
    expect(await markers.setRoomEnabled(roomJid, true)).toBe(true)
    const backend = globalThis.indexedDB
    vi.stubGlobal('indexedDB', undefined)
    try { expect(await markers.setRoomEnabled(replayFixture.room, true)).toBe(false) }
    finally { vi.stubGlobal('indexedDB', backend) }
    const next = new RoomReadMarkers(dependencies, () => focused)
    try { expect(await next.setRoomEnabled(replayFixture.room, true)).toBe(true) }
    finally { next.cancelPending() }
    expect(await markers.setRoomEnabled(roomJid, true)).toBe(true)
    expect(markers.getConsent().rooms).toEqual([replayFixture.room, roomJid])
  })

  it.each([false, true].flatMap(all => ['absent', 'legacy replacement'].map(input => [all, input] as const)))('invalidates held On when partial clearing removes confirmed preferences (all accounts: %s, %s)', async (allAccounts, input) => {
    expect(await markers.setRoomEnabled(roomJid, true)).toBe(true)
    await markers.viewed(roomJid, rows[0])
    expect(send).toHaveBeenCalledTimes(1)
    expect(await markers.setRoomEnabled(roomJid, false)).toBe(true)
    const opening = pauseNextConsentOpen()
    const pending = markers.setRoomEnabled(roomJid, true)
    await opening.ready
    const storage = localStorage
    try {
      vi.stubGlobal('localStorage', new Proxy(storage, { get: (base, key) => key === 'setItem'
        ? (name: string, value: string) => { if (name === migrationKey || name === ROOM_READ_MARKERS_STORAGE_KEY + ':clear-generation') throw new DOMException('Barrier denied', 'SecurityError'); base.setItem(name, value) }
        : Reflect.get(base, key, base) }))
      expect(await clearRoomReadMarkersLocalData(jid, allAccounts)).toBe(false)
      expect(storage.getItem(consentKey)).toBeNull()
      if (input === 'legacy replacement') storage.setItem(consentKey, JSON.stringify({ enabled: true, rooms: [roomJid] }))
    } finally { vi.stubGlobal('localStorage', storage); opening.release() }
    expect(await pending).toBe(false)
    const fresh = new RoomReadMarkers(dependencies, () => focused)
    try {
      await fresh.viewed(roomJid, rows[1])
      expect(send).toHaveBeenCalledTimes(1)
      expect(fresh.isEnabledFor(roomJid)).toBe(false)
      if (input === 'absent') expect(storage.getItem(consentKey)).toBeNull()
      else await fresh.reload()
    } finally { fresh.cancelPending() }
  })

  it.each([[false, false], [false, true], [true, false], [true, true]])('invalidates held self-marker ownership after a partial clear (all accounts: %s, archived: %s)', async (allAccounts, archived) => {
    const captured = useCapturedSelfReading()
    expect(await markers.setRoomEnabled(roomJid, true)).toBe(true)
    await markers.viewed(roomJid, captured.row)
    expect(send).toHaveBeenCalledTimes(1)
    vi.resetModules()
    const { clearRoomReadMarkersLocalData: clearOtherRuntime } = await import('./RoomReadMarkers')
    let started!: () => void
    let release!: () => void
    const ready = new Promise<void>(resolve => { started = resolve })
    const held = new Promise<void>(resolve => { release = resolve })
    stores.room.getMessageByArchiveId = vi.fn(async () => { started(); await held; return captured.row })
    const receiver = new RoomReadMarkers(dependencies, () => focused)
    receiver.recordArchiveOrder(roomJid, [captured.row.stanzaId!])
    try {
      const incoming = receiver.receive(roomJid, captured.reflected, [], archived)
      await ready
      const storage = localStorage
      try {
        vi.stubGlobal('localStorage', new Proxy(storage, { get: (base, key) => key === 'setItem'
          ? (name: string, value: string) => { if (name === migrationKey || name === ROOM_READ_MARKERS_STORAGE_KEY + ':clear-generation') throw new DOMException('Barrier denied', 'SecurityError'); base.setItem(name, value) }
          : Reflect.get(base, key, base) }))
        expect(await clearOtherRuntime(jid, allAccounts)).toBe(false)
        storage.setItem(consentKey, JSON.stringify({ enabled: true, rooms: [roomJid] }))
      } finally { vi.stubGlobal('localStorage', storage); release() }
      await incoming
      expect(storage.getItem(`${ROOM_READ_MARKERS_STORAGE_KEY}:${JSON.stringify([jid, 'watermarks'])}`)).toBeNull()
      expect(send).toHaveBeenCalledTimes(1)
    } finally { receiver.cancelPending() }
  })

  it('keeps independent saved consent in both clients when the final On lift is refused', async () => {
    expect(await markers.setRoomEnabled(roomJid, true)).toBe(true)
    expect(await markers.setRoomEnabled(replayFixture.room, true)).toBe(true)
    expect(await markers.setRoomEnabled(roomJid, false)).toBe(true)
    const storage = localStorage
    let writes = 0
    vi.stubGlobal('localStorage', new Proxy(storage, { get: (base, key) => key === 'setItem'
      ? (name: string, value: string) => { if (name === migrationKey && ++writes === 2) throw new DOMException('Final lift denied', 'SecurityError'); base.setItem(name, value) }
      : Reflect.get(base, key, base) }))
    const observer = new RoomReadMarkers(dependencies, () => focused)
    try {
      expect(await markers.setRoomEnabled(roomJid, true)).toBe(false)
      expect(markers.isEnabledFor(roomJid)).toBe(false)
      expect(markers.isEnabledFor(replayFixture.room)).toBe(true)
      expect(observer.isEnabledFor(roomJid)).toBe(false)
      expect(observer.isEnabledFor(replayFixture.room)).toBe(true)
      await markers.viewed(roomJid, rows[1])
      expect(send).not.toHaveBeenCalled()
    } finally { observer.cancelPending(); vi.stubGlobal('localStorage', storage) }
    expect(await markers.setRoomEnabled(roomJid, true)).toBe(true)
    expect(markers.isEnabledFor(replayFixture.room)).toBe(true)
    await markers.viewed(roomJid, rows[1])
    expect(send).toHaveBeenCalledTimes(1)
  })

  it('does not use validated legacy input to grant a room from a different replacement', async () => {
    localStorage.setItem(consentKey, JSON.stringify({ enabled: true, rooms: [roomJid] }))
    const storage = localStorage
    vi.stubGlobal('localStorage', new Proxy(storage, { get: (base, key) => key === 'setItem'
      ? (name: string, value: string) => { if (name === consentKey || (name === migrationKey && value.startsWith('!'))) throw new DOMException('Write denied', 'SecurityError'); base.setItem(name, value) }
      : key === 'removeItem' ? (name: string) => { if (name === consentKey) throw new DOMException('Removal denied', 'SecurityError'); base.removeItem(name) } : Reflect.get(base, key, base) }))
    const fresh = new RoomReadMarkers(dependencies, () => focused)
    try {
      expect(await markers.setRoomEnabled(roomJid, false)).toBe(false)
      storage.setItem(consentKey, JSON.stringify({ enabled: true, rooms: [roomJid, replayFixture.room] }))
      expect(fresh.isEnabledFor(replayFixture.room)).toBe(false)
      await fresh.reload()
      expect(fresh.isEnabledFor(replayFixture.room)).toBe(false)
    } finally { fresh.cancelPending(); vi.stubGlobal('localStorage', storage) }
  })

  it.each((['normal', 'compact'] as const).flatMap(kind => [false, true].map(all => [kind, all] as const)))('erases the validated conversion input even when replacement barriers fail (%s, all accounts: %s)', async (kind, allAccounts) => {
    expect(await markers.setRoomEnabled(roomJid, true)).toBe(true)
    expect(await markers.setRoomEnabled(replayFixture.room, true)).toBe(true)
    await markers.viewed(roomJid, rows[0])
    expect(send).toHaveBeenCalledTimes(1)
    const legacy = JSON.stringify({ enabled: true, rooms: [roomJid, replayFixture.room] })
    localStorage.setItem(consentKey, legacy)
    localStorage.removeItem(migrationKey)
    const storage = localStorage
    vi.stubGlobal('localStorage', new Proxy(storage, { get: (base, key) => key === 'setItem'
      ? (name: string, value: string) => { if (name === consentKey || (name === migrationKey && (kind === 'normal' ? value.startsWith('~') : value.startsWith('{')))) throw new DOMException('Preference denied', 'SecurityError'); base.setItem(name, value) }
      : Reflect.get(base, key, base) }))
    try { expect(await markers.setRoomEnabled(replayFixture.room, false)).toBe(false) }
    finally { vi.stubGlobal('localStorage', storage) }
    vi.stubGlobal('localStorage', new Proxy(storage, { get: (base, key) => key === 'setItem'
      ? (name: string, value: string) => { if (name === migrationKey || name === ROOM_READ_MARKERS_STORAGE_KEY + ':clear-generation') throw new DOMException('Barrier denied', 'SecurityError'); base.setItem(name, value) }
      : Reflect.get(base, key, base) }))
    try {
      const proof = JSON.parse(storage.getItem(`${ROOM_READ_MARKERS_STORAGE_KEY}:${JSON.stringify([jid, 'continuity'])}`)!)
      expect(proof.input).toBe(legacy)
      expect(await clearRoomReadMarkersLocalData(jid, allAccounts)).toBe(false)
      const encoded = storage.getItem(migrationKey)!
      const retained = JSON.parse(encoded.startsWith('~') ? encoded.slice(1) : encoded)
      const inputId = Array.isArray(retained) ? retained[5] : retained.input
      expect(inputId).not.toBe(legacy)
      expect(inputId).toBe(proof.inputId)
      storage.setItem(consentKey, legacy)
      const fresh = new RoomReadMarkers(dependencies, () => focused)
      fresh.recordArchiveOrder(roomJid, rows.map(row => row.stanzaId!))
      try { await fresh.viewed(roomJid, rows[1]); expect(send).toHaveBeenCalledTimes(1); expect(fresh.isEnabledFor(roomJid)).toBe(false) }
      finally { fresh.cancelPending() }
    } finally { vi.stubGlobal('localStorage', storage) }
  })

  it.each(['unchanged', 'independent choice', 'clear and fresh choice'] as const)('retains unresolved all-Off after two refused reads (%s)', async kind => {
    expect(await markers.setRoomEnabled(roomJid, true)).toBe(true)
    await markers.viewed(roomJid, rows[0])
    expect(send).toHaveBeenCalledTimes(1)
    const unknown = new RoomReadMarkers(dependencies, () => focused)
    const storage = localStorage
    let refused = 2
    vi.stubGlobal('localStorage', new Proxy(storage, { get: (base, key) => key === 'getItem'
      ? (name: string) => { if (name === consentKey && refused > 0) { refused--; throw new DOMException('Read refused', 'SecurityError') }; return base.getItem(name) }
      : Reflect.get(base, key, base) }))
    try { expect(await unknown.setEnabled(false)).toBe(false) }
    finally { vi.stubGlobal('localStorage', storage) }
    const next = new RoomReadMarkers(dependencies, () => focused)
    try {
      if (kind === 'independent choice') expect(await next.setRoomEnabled(replayFixture.room, true)).toBe(true)
      if (kind === 'clear and fresh choice') { expect(await clearRoomReadMarkersLocalData(jid)).toBe(true); expect(await next.setRoomEnabled(roomJid, true)).toBe(true) }
      unknown.recordArchiveOrder(roomJid, rows.map(row => row.stanzaId!))
      await unknown.viewed(roomJid, rows[1])
      expect(send).toHaveBeenCalledTimes(kind === 'clear and fresh choice' ? 2 : 1)
      if (kind === 'independent choice') expect(unknown.isEnabledFor(replayFixture.room)).toBe(true)
      expect(await unknown.setRoomEnabled(roomJid, true)).toBe(true)
      await unknown.viewed(roomJid, rows[1])
      expect(send).toHaveBeenCalledTimes(2)
    } finally { next.cancelPending(); unknown.cancelPending() }
  })

  it.each(['normal', 'compact'] as const)('preserves another account’s retained legacy proof when scoped conversion is refused (%s)', async kind => {
    expect(await markers.setRoomEnabled(roomJid, true)).toBe(true)
    expect(await markers.setRoomEnabled(replayFixture.room, true)).toBe(true)
    await markers.viewed(roomJid, rows[0])
    expect(send).toHaveBeenCalledTimes(1)
    localStorage.setItem(consentKey, JSON.stringify({ enabled: true, rooms: [roomJid, replayFixture.room] }))
    localStorage.removeItem(migrationKey)
    const storage = localStorage
    const proofKey = `${ROOM_READ_MARKERS_STORAGE_KEY}:${JSON.stringify([jid, 'continuity'])}`
    vi.stubGlobal('localStorage', new Proxy(storage, { get: (base, key) => key === 'setItem'
      ? (name: string, value: string) => { if (name === consentKey || (name === migrationKey && (kind === 'normal' ? value.startsWith('~') : value.startsWith('{')))) throw new DOMException('Conversion denied', 'SecurityError'); base.setItem(name, value) }
      : Reflect.get(base, key, base) }))
    const observer = new RoomReadMarkers(dependencies, () => focused)
    try {
      expect(await markers.setRoomEnabled(roomJid, false)).toBe(false)
      const proof = storage.getItem(proofKey)
      expect(await clearRoomReadMarkersLocalData('other@localhost')).toBe(false)
      await observer.reload()
      expect(observer.isEnabledFor(replayFixture.room)).toBe(true)
      expect(observer.isEnabledFor(roomJid)).toBe(false)
      expect(markers.isEnabledFor(replayFixture.room)).toBe(true)
      expect(storage.getItem(proofKey)).toBe(proof)
      await markers.viewed(roomJid, rows[1])
      expect(send).toHaveBeenCalledTimes(1)
    } finally { observer.cancelPending(); vi.stubGlobal('localStorage', storage) }
  })

  it.each([false, true].flatMap(refused => [false, true].map(erased => [refused, erased] as const)))('keeps unreadable legacy all-Off after another account’s logout (conversion refused: %s, target erased: %s)', async (refusedConversion, erased) => {
    expect(await markers.setRoomEnabled(roomJid, true)).toBe(true)
    await markers.viewed(roomJid, rows[0])
    expect(send).toHaveBeenCalledTimes(1)
    localStorage.setItem(consentKey, JSON.stringify({ enabled: true, rooms: [roomJid] }))
    localStorage.removeItem(migrationKey)
    localStorage.removeItem(`${ROOM_READ_MARKERS_STORAGE_KEY}:${JSON.stringify([jid, 'continuity'])}`)
    const unknown = new RoomReadMarkers(dependencies, () => focused)
    const storage = localStorage
    let remaining = 2
    vi.stubGlobal('localStorage', new Proxy(storage, { get: (base, key) => key === 'getItem'
      ? (name: string) => { if (name === consentKey && remaining > 0) { remaining--; throw new DOMException('Read refused', 'SecurityError') }; return base.getItem(name) }
      : Reflect.get(base, key, base) }))
    try { expect(await unknown.setEnabled(false)).toBe(false) }
    finally { vi.stubGlobal('localStorage', storage) }
    if (refusedConversion) vi.stubGlobal('localStorage', new Proxy(storage, { get: (base, key) => key === 'setItem'
      ? (name: string, value: string) => { if (name === consentKey) throw new DOMException('Conversion refused', 'SecurityError'); base.setItem(name, value) }
      : Reflect.get(base, key, base) }))
    try { expect(await clearRoomReadMarkersLocalData('other@localhost')).toBe(!refusedConversion) }
    finally { vi.stubGlobal('localStorage', storage) }
    const converter = new RoomReadMarkers(dependencies, () => focused)
    try { await converter.reload() } finally { converter.cancelPending() }
    if (erased) { expect(await clearRoomReadMarkersLocalData(jid)).toBe(true); expect(await markers.setRoomEnabled(roomJid, true)).toBe(true) }
    try {
      unknown.recordArchiveOrder(roomJid, rows.map(row => row.stanzaId!))
      await unknown.viewed(roomJid, rows[1])
      expect(send).toHaveBeenCalledTimes(erased ? 2 : 1)
      await unknown.reload()
      await unknown.viewed(roomJid, rows[1])
      expect(send).toHaveBeenCalledTimes(erased ? 2 : 1)
      expect(await unknown.setRoomEnabled(roomJid, true)).toBe(true)
      await unknown.viewed(roomJid, rows[1])
      expect(send).toHaveBeenCalledTimes(2)
    } finally { unknown.cancelPending() }
  })

  it.each((['normal', 'compact'] as const).flatMap(kind => [false, true].map(all => [kind, all] as const)))('keeps protected legacy choices out of the shared guard through failed clearing (%s, all accounts: %s)', async (kind, allAccounts) => {
    expect(await markers.setRoomEnabled(roomJid, true)).toBe(true)
    expect(await markers.setRoomEnabled(replayFixture.room, true)).toBe(true)
    const legacy = JSON.stringify({ enabled: true, rooms: [roomJid, replayFixture.room] })
    localStorage.setItem(consentKey, legacy)
    localStorage.removeItem(migrationKey)
    const storage = localStorage
    const guardKey = ROOM_READ_MARKERS_STORAGE_KEY + ':clear-generation'
    const proofKey = `${ROOM_READ_MARKERS_STORAGE_KEY}:${JSON.stringify([jid, 'continuity'])}`
    vi.stubGlobal('localStorage', new Proxy(storage, { get: (base, key) => key === 'setItem'
      ? (name: string, value: string) => { if (name === consentKey || (name === migrationKey && (kind === 'normal' ? value.startsWith('~') : value.startsWith('{')))) throw new DOMException('Conversion refused', 'SecurityError'); base.setItem(name, value) }
      : Reflect.get(base, key, base) }))
    try {
      expect(await markers.setRoomEnabled(roomJid, false)).toBe(false)
      expect(await clearRoomReadMarkersLocalData('other@localhost')).toBe(false)
    } finally { vi.stubGlobal('localStorage', storage) }
    const fence = storage.getItem(migrationKey)
    vi.stubGlobal('localStorage', new Proxy(storage, { get: (base, key) => key === 'setItem'
      ? (name: string, value: string) => { if (name === migrationKey || name === guardKey) throw new DOMException('Barrier refused', 'SecurityError'); base.setItem(name, value) }
      : Reflect.get(base, key, base) }))
    try {
      expect(await clearRoomReadMarkersLocalData(jid, allAccounts)).toBe(false)
      expect(storage.getItem(consentKey)).toBeNull()
      expect(storage.getItem(proofKey)).toBeNull()
      expect(JSON.parse(storage.getItem(guardKey)!).legacy[jid]).toBeUndefined()
      expect(storage.getItem(migrationKey)).toBe(fence)
      storage.setItem(consentKey, legacy)
      const fresh = new RoomReadMarkers(dependencies, () => focused)
      try { expect(fresh.isEnabledFor(roomJid)).toBe(false); expect(fresh.isEnabledFor(replayFixture.room)).toBe(false) }
      finally { fresh.cancelPending() }
    } finally { vi.stubGlobal('localStorage', storage) }
  })

  it.each(['choice', 'revoked choice', 'migration'] as const)('does not authorize On when only its first %s write survives', async kind => {
    if (kind === 'choice') expect(await markers.setRoomEnabled(roomJid, false)).toBe(true)
    else if (kind === 'revoked choice') {
      expect(await markers.setRoomEnabled(roomJid, true)).toBe(true)
      const storage = localStorage
      vi.stubGlobal('localStorage', new Proxy(storage, { get: (base, key) => key === 'setItem'
        ? (name: string, value: string) => { if (name === consentKey || (name === migrationKey && value.startsWith('!'))) throw new DOMException('Write denied', 'SecurityError'); base.setItem(name, value) }
        : key === 'removeItem' ? (name: string) => { if (name === consentKey) throw new DOMException('Removal denied', 'SecurityError'); base.removeItem(name) } : Reflect.get(base, key, base) }))
      try { expect(await markers.setRoomEnabled(roomJid, false)).toBe(false) } finally { vi.stubGlobal('localStorage', storage) }
    } else localStorage.setItem(consentKey, JSON.stringify({ enabled: true, rooms: [roomJid] }))
    const storage = localStorage
    let first = true
    let refused = false
    vi.stubGlobal('localStorage', new Proxy(storage, { get: (base, key) => key === 'setItem'
      ? (name: string, value: string) => {
        if (name === migrationKey && first) { first = false; base.setItem(name, value); return }
        if (name === consentKey || (kind === 'migration' && name === `${ROOM_READ_MARKERS_STORAGE_KEY}:${JSON.stringify([jid, 'continuity'])}`)) { refused = true; throw new DOMException('Consent write denied', 'SecurityError') }
        if (name === migrationKey && refused) throw new DOMException('Rollback denied', 'SecurityError')
        base.setItem(name, value)
      } : key === 'removeItem' ? (name: string) => { if (name === consentKey) throw new DOMException('Rollback denied', 'SecurityError'); base.removeItem(name) }
      : Reflect.get(base, key, base) }))
    const fresh = new RoomReadMarkers(dependencies, () => focused)
    fresh.recordArchiveOrder(roomJid, rows.map(row => row.stanzaId!))
    try {
      expect(kind !== 'migration' ? await markers.setRoomEnabled(roomJid, true) : await markers.reload()).toBe(false)
      await fresh.reload()
      await fresh.viewed(roomJid, rows[1])
      expect(send).not.toHaveBeenCalled()
      expect(fresh.isEnabledFor(roomJid)).toBe(false)
    } finally { fresh.cancelPending(); vi.stubGlobal('localStorage', storage) }
  })

  it.each([['scoped', false], ['scoped', true], ['full', false], ['full', true]] as const)('removes permission but retains the import barrier when %s clear cannot replace an On fence (sealed: %s)', async (kind, sealed) => {
    if (sealed) expect(await clearRoomReadMarkersLocalData(null, true)).toBe(true)
    expect(await markers.setRoomEnabled(roomJid, true)).toBe(true)
    await markers.viewed(roomJid, rows[0])
    expect(send).toHaveBeenCalledTimes(1)
    const historical = JSON.parse(localStorage.getItem(migrationKey)!)
    delete historical.revoked
    historical.rooms = [roomJid]
    localStorage.setItem(migrationKey, JSON.stringify(historical))
    const barrier = localStorage.getItem(migrationKey)
    const storage = localStorage
    vi.stubGlobal('localStorage', new Proxy(storage, { get: (base, key) => key === 'setItem'
      ? (name: string, value: string) => { if (name === migrationKey || name === ROOM_READ_MARKERS_STORAGE_KEY + ':clear-generation') throw new DOMException('Barrier replacement denied', 'SecurityError'); base.setItem(name, value) }
      : Reflect.get(base, key, base) }))
    const fresh = new RoomReadMarkers(dependencies, () => focused)
    fresh.recordArchiveOrder(roomJid, rows.map(row => row.stanzaId!))
    try {
      expect(await clearRoomReadMarkersLocalData(jid, kind === 'full')).toBe(false)
      expect(storage.getItem(consentKey)).toBeNull()
      expect(storage.getItem(migrationKey)).toBe(barrier)
      await fresh.viewed(roomJid, rows[1])
      expect(send).toHaveBeenCalledTimes(1)
      expect(fresh.isEnabledFor(roomJid)).toBe(false)
    } finally { fresh.cancelPending(); vi.stubGlobal('localStorage', storage) }
  })

  it.each((['room', 'all', 'migration', 'save'] as const).flatMap(mode => ['opening On', 'legacy import'].map(input => [mode, input] as const)))('keeps failed %s cleanup non-authorizing without losing legacy or ordering barriers (%s)', async (mode, input) => {
    const legacy = JSON.stringify({ enabled: true, rooms: [roomJid] })
    localStorage.setItem(consentKey, legacy)
    const opening = input === 'opening On' ? pauseNextConsentOpen() : undefined
    const delayed = opening ? markers.setRoomEnabled(roomJid, true) : undefined
    if (opening) await opening.ready
    const next = new RoomReadMarkers(dependencies, () => focused)
    const storage = localStorage
    try {
      if (mode === 'room' || mode === 'all') { await next.reload(); expect(next.isEnabledFor(roomJid)).toBe(true) }
      let first = mode === 'migration' || mode === 'save'
      vi.stubGlobal('localStorage', new Proxy(storage, { get: (base, key) => key === 'setItem'
        ? (name: string, value: string) => {
          if (name === migrationKey && first) { first = false; base.setItem(name, value); return }
          if (name === migrationKey || name === consentKey) throw new DOMException('Save denied', 'SecurityError')
          base.setItem(name, value)
        } : Reflect.get(base, key, base) }))
      expect(mode === 'room' ? await next.setRoomEnabled(roomJid, false) : mode === 'all' ? await next.setEnabled(false) : mode === 'migration' ? await next.reload() : await next.setRoomEnabled(replayFixture.room, true)).toBe(false)
    } finally { vi.stubGlobal('localStorage', storage); storage.setItem(consentKey, legacy); opening?.release(); next.cancelPending() }
    const completed = await delayed
    if (input === 'opening On') expect(completed).toBe(false)
    const fresh = new RoomReadMarkers(dependencies, () => focused)
    fresh.recordArchiveOrder(roomJid, rows.map(row => row.stanzaId!))
    try {
      await fresh.reload()
      await fresh.viewed(roomJid, rows[1])
      if (input === 'legacy import') expect(send).not.toHaveBeenCalled()
      if (input === 'legacy import') expect(fresh.isEnabledFor(roomJid)).toBe(false)
      expect(storage.getItem(migrationKey)).not.toBeNull()
    } finally { fresh.cancelPending() }
  })

  it.each(['room', 'all'] as const)('keeps a failed legacy-start %s Off stronger than background conversion without discarding an independent choice', async mode => {
    localStorage.setItem(consentKey, JSON.stringify({ enabled: true, rooms: [roomJid] }))
    const opening = pauseNextConsentOpen(true)
    const pending = mode === 'room' ? markers.setRoomEnabled(roomJid, false) : markers.setEnabled(false)
    await opening.ready
    const next = new RoomReadMarkers(dependencies, () => focused)
    try {
      await next.reload()
      expect(next.isEnabledFor(roomJid)).toBe(true)
      expect(await next.setRoomEnabled(replayFixture.room, true)).toBe(true)
    } finally { opening.release(); next.cancelPending() }
    expect(await pending).toBe(false)
    const fresh = new RoomReadMarkers(dependencies, () => focused)
    try { expect(fresh.isEnabledFor(roomJid)).toBe(false); expect(fresh.isEnabledFor(replayFixture.room)).toBe(true) }
    finally { fresh.cancelPending() }
  })

  it('blocks outgoing publication while all-Off captures rooms after an initial read refusal', async () => {
    expect(await markers.setRoomEnabled(roomJid, true)).toBe(true)
    await markers.viewed(roomJid, rows[0])
    expect(send).toHaveBeenCalledTimes(1)
    const unknown = new RoomReadMarkers(dependencies, () => focused)
    const storage = localStorage
    let first = true
    vi.stubGlobal('localStorage', new Proxy(storage, { get: (base, key) => key === 'getItem'
      ? (name: string) => { if (first && name === consentKey) { first = false; throw new DOMException('Read refused', 'SecurityError') }; return base.getItem(name) }
      : Reflect.get(base, key, base) }))
    const opening = pauseNextConsentOpen()
    const pending = unknown.setEnabled(false)
    await opening.ready
    unknown.recordArchiveOrder(roomJid, rows.map(row => row.stanzaId!))
    try {
      await unknown.viewed(roomJid, rows[1])
      expect(send).toHaveBeenCalledTimes(1)
    } finally { opening.release(); vi.stubGlobal('localStorage', storage) }
    try {
      expect(await pending).toBe(true)
      expect(await unknown.setRoomEnabled(roomJid, true)).toBe(true)
      await unknown.viewed(roomJid, rows[1])
      expect(send).toHaveBeenCalledTimes(2)
    } finally { unknown.cancelPending() }
  })

  it.each(['room', 'all'] as const)('records failed %s revocation even when a legacy overwrite already hides the room', async mode => {
    expect(await markers.setRoomEnabled(roomJid, true)).toBe(true)
    const opening = pauseNextConsentOpen()
    const delayed = markers.setRoomEnabled(roomJid, true)
    await opening.ready
    localStorage.setItem(consentKey, JSON.stringify({ enabled: false, rooms: [] }))
    vi.mocked(idbConnection.openIndexedDB).mockRejectedValueOnce(new DOMException('Storage denied', 'SecurityError'))
    try { expect(mode === 'all' ? await markers.setEnabled(false) : await markers.setRoomEnabled(roomJid, false)).toBe(false) }
    finally { opening.release() }
    expect(await delayed).toBe(false)
    const observer = new RoomReadMarkers(dependencies, () => focused)
    try { await observer.reload(); expect(observer.isEnabledFor(roomJid)).toBe(false) }
    finally { observer.cancelPending() }
  })

  it.each(['room', 'all'] as const)('preserves legacy-start %s Off through an unrelated account clear', async mode => {
    localStorage.setItem(consentKey, JSON.stringify({ enabled: true, rooms: [roomJid] }))
    const opening = pauseNextConsentOpen()
    const pending = mode === 'all' ? markers.setEnabled(false) : markers.setRoomEnabled(roomJid, false)
    await opening.ready
    try { expect(await clearRoomReadMarkersLocalData('other@localhost')).toBe(true) }
    finally { opening.release() }
    expect(await pending).toBe(true)
    const observer = new RoomReadMarkers(dependencies, () => focused)
    try { expect(observer.isEnabledFor(roomJid)).toBe(false) } finally { observer.cancelPending() }
  })

  it.each([false, true])('does not reimport a stale legacy opt-in after clearing (all accounts: %s)', async allAccounts => {
    expect(await markers.setRoomEnabled(roomJid, true)).toBe(true)
    expect(await clearRoomReadMarkersLocalData(jid, allAccounts)).toBe(true)
    expect(localStorage.getItem(consentKey)).toBeNull()
    expect(localStorage.getItem(migrationKey)).toBeNull()
    localStorage.setItem(consentKey, JSON.stringify({ enabled: true, rooms: [roomJid] }))
    const fresh = new RoomReadMarkers(dependencies, () => focused)
    try {
      await fresh.reload()
      expect(fresh.isEnabledFor(roomJid)).toBe(false)
      await fresh.viewed(roomJid, rows[1])
      expect(send).not.toHaveBeenCalled()
    } finally { fresh.cancelPending() }
  })

  it('preserves an unaffected account’s effective legacy consent before sealing legacy import', async () => {
    const other = 'other@localhost'
    const key = `${ROOM_READ_MARKERS_STORAGE_KEY}:${JSON.stringify([other, 'consent'])}`
    localStorage.setItem(key, JSON.stringify({ enabled: true, rooms: [roomJid] }))
    expect(await clearRoomReadMarkersLocalData(jid)).toBe(true)
    account = other
    expect(markers.isEnabledFor(roomJid)).toBe(true)
    expect(send).not.toHaveBeenCalled()
  })

  it.each([false, true])('merges saved rooms after a background read recovers (another runtime converts: %s)', async otherConverts => {
    const kept = 'kept@conference.localhost'
    const other = 'other@conference.localhost'
    localStorage.setItem(consentKey, JSON.stringify({ enabled: true, rooms: [kept] }))
    const db = globalThis.indexedDB
    vi.stubGlobal('indexedDB', undefined)
    expect(await markers.reload()).toBe(false)
    vi.stubGlobal('indexedDB', db)
    if (otherConverts) {
      const next = new RoomReadMarkers(dependencies, () => focused)
      try { await next.reload() } finally { next.cancelPending() }
    }
    expect(await markers.setRoomEnabled(other, true)).toBe(true)
    expect(markers.getConsent().rooms).toEqual([kept, other])
  })

  it.each(['consent', 'migration'] as const)('erases its account even when another legacy conversion is refused (%s), without damaging the other choice', async failure => {
    const captured = useCapturedSelfReading()
    expect(await markers.setRoomEnabled(roomJid, true)).toBe(true)
    await markers.viewed(roomJid, captured.row)
    const other = 'other@localhost'
    const otherKey = `${ROOM_READ_MARKERS_STORAGE_KEY}:${JSON.stringify([other, 'consent'])}`
    const otherFence = `${ROOM_READ_MARKERS_STORAGE_KEY}:${JSON.stringify([other, 'migration'])}`
    const saved = JSON.stringify({ enabled: true, rooms: [roomJid] })
    localStorage.setItem(otherKey, saved)
    const storage = localStorage
    vi.stubGlobal('localStorage', new Proxy(storage, { get: (target, key) => key === 'setItem'
      ? (name: string, value: string) => { if (name === (failure === 'consent' ? otherKey : otherFence)) throw new DOMException('Quota exhausted', 'QuotaExceededError'); target.setItem(name, value) }
      : Reflect.get(target, key, target) }))
    expect(await clearRoomReadMarkersLocalData(jid)).toBe(false)
    for (const kind of ['consent', 'watermarks', 'migration']) expect(storage.getItem(`${ROOM_READ_MARKERS_STORAGE_KEY}:${JSON.stringify([jid, kind])}`)).toBeNull()
    if (failure === 'consent') expect(storage.getItem(otherKey)).toBe(saved)
    else expect(JSON.parse(storage.getItem(otherKey)!).rooms).toEqual([roomJid])
    expect(storage.getItem(otherFence)).toBeNull()
    vi.stubGlobal('localStorage', storage)
    account = other
    await markers.reload()
    expect(markers.isEnabledFor(roomJid)).toBe(true)
  })

  it.each([['scoped', false], ['scoped', true], ['full', false], ['full', true]] as const)('retains an import barrier after refused %s replacement (old exception: %s)', async (kind, exception) => {
    const captured = useCapturedSelfReading()
    expect(await clearRoomReadMarkersLocalData(null, true)).toBe(true)
    const prefix = ROOM_READ_MARKERS_STORAGE_KEY + ':'
    const guard = Array.from({ length: localStorage.length }, (_, i) => localStorage.key(i)!)
      .find(key => key.startsWith(prefix) && !key.slice(prefix.length).startsWith('['))!
    localStorage.removeItem(guard)
    const old = JSON.stringify({ enabled: true, rooms: [roomJid] })
    localStorage.setItem(consentKey, old)
    const storage = localStorage
    if (exception) {
      vi.stubGlobal('localStorage', new Proxy(storage, { get: (target, key) => key === 'setItem'
        ? (name: string, value: string) => { if (name === consentKey) throw new DOMException('Quota exhausted', 'QuotaExceededError'); target.setItem(name, value) }
        : Reflect.get(target, key, target) }))
      expect(await clearRoomReadMarkersLocalData('other@localhost')).toBe(false)
      vi.stubGlobal('localStorage', storage)
    }
    const origin = markers.captureReplayBoundary()
    vi.stubGlobal('localStorage', new Proxy(storage, { get: (target, key) => key === 'setItem'
      ? (name: string, value: string) => { if (name === guard || (name === `${ROOM_READ_MARKERS_STORAGE_KEY}:${JSON.stringify([jid, 'migration'])}` && storage.getItem(consentKey) !== null)) throw new DOMException('Quota exhausted', 'QuotaExceededError'); target.setItem(name, value) }
      : Reflect.get(target, key, target) }))
    const fresh = new RoomReadMarkers(dependencies, () => focused)
    try {
      expect(await clearRoomReadMarkersLocalData(jid, kind === 'full')).toBe(false)
      vi.stubGlobal('localStorage', storage)
      for (let stale = 0; stale < 2; stale++) {
        storage.setItem(consentKey, old)
        await fresh.reload()
        expect(fresh.isEnabledFor(roomJid)).toBe(false)
      }
      await fresh.receive(roomJid, captured.reflected, [], true, origin)
      expect(storage.getItem(`${ROOM_READ_MARKERS_STORAGE_KEY}:${JSON.stringify([jid, 'watermarks'])}`)).toBeNull()
      expect(origin()).toBe(false)
      expect(await clearRoomReadMarkersLocalData(jid, kind === 'full')).toBe(true)
      for (const entry of ['consent', 'watermarks', 'migration']) expect(storage.getItem(`${ROOM_READ_MARKERS_STORAGE_KEY}:${JSON.stringify([jid, entry])}`)).toBeNull()
    } finally { fresh.cancelPending(); vi.stubGlobal('localStorage', storage) }
  })

  it.each(['scoped', 'full'] as const)('retains an existing seal when all barrier writes fail during %s clear', async kind => {
    expect(await clearRoomReadMarkersLocalData(null, true)).toBe(true)
    const prefix = ROOM_READ_MARKERS_STORAGE_KEY + ':'
    const guard = Array.from({ length: localStorage.length }, (_, i) => localStorage.key(i)!)
      .find(key => key.startsWith(prefix) && !key.slice(prefix.length).startsWith('['))!
    expect(await markers.setRoomEnabled(roomJid, true)).toBe(true)
    localStorage.removeItem(`${ROOM_READ_MARKERS_STORAGE_KEY}:${JSON.stringify([jid, 'migration'])}`)
    const storage = localStorage
    vi.stubGlobal('localStorage', new Proxy(storage, { get: (target, key) => key === 'setItem'
      ? () => { throw new DOMException('Storage denied', 'SecurityError') }
      : Reflect.get(target, key, target) }))
    expect(await clearRoomReadMarkersLocalData(jid, kind === 'full')).toBe(false)
    vi.stubGlobal('localStorage', storage)
    storage.setItem(consentKey, JSON.stringify({ enabled: true, rooms: [roomJid] }))
    const fresh = new RoomReadMarkers(dependencies, () => focused)
    try { await fresh.reload(); expect(fresh.isEnabledFor(roomJid)).toBe(false) }
    finally { fresh.cancelPending() }
  })

  it.each(['scoped', 'full'] as const)('rejects opening legacy On across a refused %s guard replacement', async kind => {
    expect(await clearRoomReadMarkersLocalData(null, true)).toBe(true)
    const prefix = ROOM_READ_MARKERS_STORAGE_KEY + ':'
    const guard = Array.from({ length: localStorage.length }, (_, i) => localStorage.key(i)!)
      .find(key => key.startsWith(prefix) && !key.slice(prefix.length).startsWith('['))!
    localStorage.removeItem(guard)
    localStorage.setItem(consentKey, JSON.stringify({ enabled: false, rooms: [] }))
    const held = pauseNextConsentOpen()
    const pending = markers.setRoomEnabled(roomJid, true)
    await held.ready
    const storage = localStorage
    vi.stubGlobal('localStorage', new Proxy(storage, { get: (target, key) => key === 'setItem'
      ? (name: string, value: string) => { if (name === guard) throw new DOMException('Quota exhausted', 'QuotaExceededError'); target.setItem(name, value) }
      : Reflect.get(target, key, target) }))
    try {
      expect(await clearRoomReadMarkersLocalData(jid, kind === 'full')).toBe(false)
      expect(await markers.setRoomEnabled(replayFixture.room, true)).toBe(true)
    } finally { held.release() }
    expect(await pending).toBe(false)
    vi.stubGlobal('localStorage', storage)
    const fresh = new RoomReadMarkers(dependencies, () => focused)
    try { await fresh.reload(); expect(fresh.isEnabledFor(roomJid)).toBe(false); expect(fresh.isEnabledFor(replayFixture.room)).toBe(true) }
    finally { fresh.cancelPending() }
  })

  it('retries full sealing after freeing space and rejects an unlisted opening On', async () => {
    const prefix = ROOM_READ_MARKERS_STORAGE_KEY + ':'
    const guard = prefix + 'clear-generation'
    const otherConsent = `${prefix}${JSON.stringify(['other@localhost', 'consent'])}`
    localStorage.setItem(otherConsent, JSON.stringify({ enabled: true, rooms: [replayFixture.room] }))
    const held = pauseNextConsentOpen()
    const pending = markers.setRoomEnabled(roomJid, true)
    await held.ready
    const storage = localStorage
    vi.stubGlobal('localStorage', new Proxy(storage, { get: (target, key) => key === 'setItem'
      ? (name: string, value: string) => {
        if (name === guard && target.getItem(otherConsent) !== null) throw new DOMException('Quota exhausted', 'QuotaExceededError')
        target.setItem(name, value)
      } : Reflect.get(target, key, target) }))
    let cleared = false
    try {
      expect(storage.getItem(consentKey)).toBeNull()
      cleared = await clearRoomReadMarkersLocalData(null, true)
    } finally { vi.stubGlobal('localStorage', storage); held.release() }
    expect(await pending).toBe(false)
    expect(cleared).toBe(true)
    expect(markers.isEnabledFor(roomJid)).toBe(false)
  })

  it.each([['scoped', 'opening On'], ['full', 'opening On'], ['scoped', 'own replay'], ['full', 'own replay']] as const)('keeps the %s fallback epoch after fresh choice and a legacy overwrite for %s', async (kind, work) => {
    const captured = useCapturedSelfReading()
    localStorage.setItem(consentKey, JSON.stringify({ enabled: false, rooms: [] }))
    const origin = markers.captureReplayBoundary()
    const held = pauseNextConsentOpen()
    const pending = markers.setRoomEnabled(roomJid, true)
    await held.ready
    const storage = localStorage
    const guard = ROOM_READ_MARKERS_STORAGE_KEY + ':clear-generation'
    vi.stubGlobal('localStorage', new Proxy(storage, { get: (target, key) => key === 'setItem'
      ? (name: string, value: string) => { if (name === guard) throw new DOMException('Quota exhausted', 'QuotaExceededError'); target.setItem(name, value) }
      : Reflect.get(target, key, target) }))
    let watermark: string | null = null
    try {
      expect(await clearRoomReadMarkersLocalData(jid, kind === 'full')).toBe(false)
      expect(await markers.setRoomEnabled(replayFixture.room, true)).toBe(true)
      expect(await markers.setEnabled(false)).toBe(true)
      expect(await markers.setRoomEnabled(replayFixture.room, true)).toBe(true)
      localStorage.setItem(consentKey, JSON.stringify({ enabled: false, rooms: [] }))
      await markers.receive(roomJid, captured.reflected, [], true, origin)
      watermark = storage.getItem(`${ROOM_READ_MARKERS_STORAGE_KEY}:${JSON.stringify([jid, 'watermarks'])}`)
    } finally { vi.stubGlobal('localStorage', storage); held.release() }
    const result = await pending
    if (work === 'opening On') expect(result).toBe(false)
    else expect(watermark).toBeNull()
  })

  it.each(['scoped', 'full'] as const)('reports total barrier write denial during %s erasure', async kind => {
    const captured = useCapturedSelfReading()
    const old = JSON.stringify({ enabled: true, rooms: [roomJid] })
    localStorage.setItem(consentKey, old)
    await markers.receive(roomJid, captured.reflected)
    const storage = localStorage
    vi.stubGlobal('localStorage', new Proxy(storage, { get: (target, key) => key === 'setItem'
      ? () => { throw new DOMException('Storage denied', 'SecurityError') }
      : Reflect.get(target, key, target) }))
    expect(await clearRoomReadMarkersLocalData(jid, kind === 'full')).toBe(false)
    expect(storage.getItem(consentKey)).toBeNull()
    expect(storage.getItem(`${ROOM_READ_MARKERS_STORAGE_KEY}:${JSON.stringify([jid, 'watermarks'])}`)).toBeNull()
  })

  it.each([0, 2])('keeps the erased account out of legacy import after partial clearing (survivor format: %s)', async format => {
    expect(await markers.setRoomEnabled(roomJid, true)).toBe(true)
    const other = 'other@localhost'
    const otherKey = `${ROOM_READ_MARKERS_STORAGE_KEY}:${JSON.stringify([other, 'consent'])}`
    const old = JSON.stringify(format === 0 ? { enabled: true, rooms: [roomJid] } : { version: 2, rooms: [roomJid] })
    localStorage.setItem(otherKey, old)
    const storage = localStorage
    vi.stubGlobal('localStorage', new Proxy(storage, { get: (target, key) => key === 'setItem'
      ? (name: string, value: string) => { if (name === otherKey) throw new DOMException('Quota exhausted', 'QuotaExceededError'); target.setItem(name, value) }
      : Reflect.get(target, key, target) }))
    expect(await clearRoomReadMarkersLocalData(jid)).toBe(false)
    vi.stubGlobal('localStorage', storage)
    localStorage.setItem(consentKey, JSON.stringify({ enabled: true, rooms: [roomJid] }))
    const fresh = new RoomReadMarkers(dependencies, () => focused)
    try {
      await fresh.reload()
      expect(fresh.isEnabledFor(roomJid)).toBe(false)
      account = other
      await fresh.reload()
      expect(fresh.isEnabledFor(roomJid)).toBe(true)
      expect(await fresh.setRoomEnabled(roomJid, false)).toBe(true)
      localStorage.setItem(otherKey, old)
      await fresh.reload()
      expect(fresh.isEnabledFor(roomJid)).toBe(false)
    } finally { fresh.cancelPending() }
  })

  it.each(['view', 'pointer'] as const)('rechecks the current %s at the held publication boundary', async change => {
    const captured = useCapturedSelfReading(replayFixture)
    const newest = capturedRoomReading({ ...replayFixture, message: replayFixture.newest }).row
    rows = [captured.row, newest]
    room.readPointer = makeReadPointer(newest, 'room')
    markers.recordArchiveOrder(replayFixture.room, rows.map(row => row.stanzaId!))
    iq.mockImplementation(async () => parse(replayFixture.disco))
    expect(await markers.setRoomEnabled(replayFixture.room, true)).toBe(true)
    let visible = true
    const held = await holdConsentStorage()
    const queued = held.next()
    const pending = markers.viewed(replayFixture.room, newest, () => visible)
    await queued
    if (change === 'view') visible = false
    else room.readPointer = makeReadPointer(captured.row, 'room')
    await held.release()
    await pending
    expect(send).not.toHaveBeenCalled()
    expect(localStorage.getItem(`${ROOM_READ_MARKERS_STORAGE_KEY}:${JSON.stringify([jid, 'watermarks'])}`)).toBeNull()
    visible = true
    room.readPointer = makeReadPointer(newest, 'room')
    await markers.viewed(replayFixture.room, newest, () => visible)
    expect(send).toHaveBeenCalledTimes(1)
  })

  it('does not persist an own replay without an authenticated account', async () => {
    const captured = useCapturedSelfReading()
    account = ''
    setStorageScopeJid(null)
    await markers.receive(roomJid, captured.reflected)
    expect(localStorage.length).toBe(0)
    expect(send).not.toHaveBeenCalled()
  })

  it.each([['viewed', false], ['self', false], ['viewed', true], ['self', true]] as const)('merges durable watermarks for %s without storage events (erased map: %s)', async (writer, erased) => {
    const captured = useCapturedSelfReading()
    expect(await markers.setRoomEnabled(roomJid, true)).toBe(true)
    const other = capturedRoomReading(replayFixture)
    const otherRoom = createMockRoom(replayFixture.room, { nickname: 'Alice', joined: true, isJoining: false,
      occupants: new Map([
        ['Alice', { ...room.occupants.get('Alice')!, occupantId: other.actor }],
        ['Bob', { ...room.occupants.get('Bob')!, occupantId: other.author }],
      ]) })
    const otherDeps: ModuleDependencies = { ...dependencies, stores: { ...stores, room: { ...stores.room,
      getRoom: id => id === replayFixture.room ? otherRoom : room,
      getMessageByArchiveId: async () => other.row,
    } }, sendIQ: async () => parse(replayFixture.disco) }
    const peer = new RoomReadMarkers(otherDeps, () => focused)
    const watermark = `${ROOM_READ_MARKERS_STORAGE_KEY}:${JSON.stringify([jid, 'watermarks'])}`
    try {
      if (!erased) markers.getConsent()
      await peer.receive(replayFixture.room, other.reflected)
      const otherSaved = JSON.parse(localStorage.getItem(watermark)!).sent[replayFixture.room]
      expect(otherSaved.archiveId).toBe(other.row.stanzaId)
      if (erased) {
        markers.getConsent()
        vi.resetModules()
        const { clearRoomReadMarkersLocalData: clearOtherRuntime } = await import('./RoomReadMarkers')
        expect(await clearOtherRuntime(jid)).toBe(true)
        expect(await peer.setRoomEnabled(roomJid, true)).toBe(true)
      }
      if (writer === 'viewed') await markers.viewed(roomJid, captured.row)
      else await markers.receive(roomJid, captured.reflected)
      const sent = JSON.parse(localStorage.getItem(watermark)!).sent
      expect(sent[roomJid].archiveId).toBe(capturedTarget)
      if (erased) expect(sent[replayFixture.room]).toBeUndefined()
      else expect(sent[replayFixture.room]).toEqual(otherSaved)
    } finally { peer.cancelPending() }
  })

  it.each(['focus', 'consent', 'clear'] as const)('does not record an unattempted send when %s changes before the storage turn', async change => {
    const captured = useCapturedSelfReading()
    expect(await markers.setRoomEnabled(roomJid, true)).toBe(true)
    const held = await holdConsentStorage()
    const queued = held.next()
    const pending = markers.viewed(roomJid, captured.row)
    await queued
    if (change === 'focus') focused = false
    let revoke: Promise<boolean> | undefined
    if (change === 'consent') revoke = markers.setRoomEnabled(roomJid, false)
    if (change === 'clear') {
      vi.resetModules()
      const { clearRoomReadMarkersLocalData: clearOtherRuntime } = await import('./RoomReadMarkers')
      // Direct fallback lets erasure finish while the earlier storage turn is held.
      const backend = globalThis.indexedDB
      vi.stubGlobal('indexedDB', undefined)
      try { expect(await clearOtherRuntime(jid, true)).toBe(false) } finally { vi.stubGlobal('indexedDB', backend) }
    }
    await held.release()
    await pending
    if (revoke) await revoke
    expect(send).not.toHaveBeenCalled()
    expect(localStorage.getItem(`${ROOM_READ_MARKERS_STORAGE_KEY}:${JSON.stringify([jid, 'watermarks'])}`)).toBeNull()
  })

  it('starts dispatch with its durable write rather than cancelling a saved row at transaction completion', async () => {
    const captured = useCapturedSelfReading()
    expect(await markers.setRoomEnabled(roomJid, true)).toBe(true)
    const storage = localStorage
    const watermark = `${ROOM_READ_MARKERS_STORAGE_KEY}:${JSON.stringify([jid, 'watermarks'])}`
    vi.stubGlobal('localStorage', new Proxy(storage, { get: (target, key) => key === 'setItem'
      ? (name: string, value: string) => { target.setItem(name, value); if (name === watermark) queueMicrotask(() => { focused = false }) }
      : Reflect.get(target, key, target) }))
    await markers.viewed(roomJid, captured.row)
    expect({ sent: send.mock.calls.length, watermark: JSON.parse(storage.getItem(watermark)!).sent[roomJid].archiveId })
      .toEqual({ sent: 1, watermark: capturedTarget })
    focused = true
    await markers.viewed(roomJid, captured.row)
    expect(send).toHaveBeenCalledTimes(1)
  })

  it('orders own watermark writes with clearing through the same storage scope', async () => {
    const captured = useCapturedSelfReading()
    expect(await markers.setRoomEnabled(roomJid, true)).toBe(true)
    const storage = await holdConsentStorage()
    const queued = storage.next().then(() => 'queued')
    const incoming = markers.receive(roomJid, captured.reflected)
    const watermark = `${ROOM_READ_MARKERS_STORAGE_KEY}:${JSON.stringify([jid, 'watermarks'])}`
    try {
      const first = await Promise.race([queued, incoming.then(() => 'completed')])
      expect(localStorage.getItem(watermark)).toBeNull()
      expect(first).toBe('queued')
    } finally { await storage.release() }
    await incoming
    expect(JSON.parse(localStorage.getItem(watermark)!).sent[roomJid].archiveId).toBe(capturedTarget)
    expect(send).not.toHaveBeenCalled()
  })

  it.each([[false, false], [false, true], [true, false], [true, true]])('does not recreate a cleared watermark from a held self-marker (all accounts: %s, archived: %s)', async (allAccounts, archived) => {
    const captured = useCapturedSelfReading()
    expect(await markers.setRoomEnabled(roomJid, true)).toBe(true)
    await markers.viewed(roomJid, captured.row)
    expect(send).toHaveBeenCalledTimes(1)
    send.mockClear()
    vi.resetModules()
    const { clearRoomReadMarkersLocalData: clearOtherRuntime } = await import('./RoomReadMarkers')
    let started!: () => void
    let release!: () => void
    const ready = new Promise<void>(resolve => { started = resolve })
    const held = new Promise<void>(resolve => { release = resolve })
    stores.room.getMessageByArchiveId = vi.fn(async () => { started(); await held; return captured.row })
    const unsubscribe = markers.subscribe(() => { markers.getConsent() })
    const incoming = markers.receive(roomJid, captured.reflected, [], archived)
    await ready
    try {
      expect(await clearOtherRuntime(jid, allAccounts)).toBe(true)
      window.dispatchEvent(new StorageEvent('storage', { key: consentKey, newValue: null }))
    } finally { release() }
    await incoming
    unsubscribe()
    const watermark = `${ROOM_READ_MARKERS_STORAGE_KEY}:${JSON.stringify([jid, 'watermarks'])}`
    expect(localStorage.getItem(watermark)).toBeNull()
    expect(send).not.toHaveBeenCalled()
  })

  it('does not erase legacy choices when background conversion cannot open coordination storage', async () => {
    const saved = JSON.stringify({ enabled: true, rooms: [roomJid] })
    localStorage.setItem(consentKey, saved)
    vi.stubGlobal('indexedDB', undefined)
    expect(await markers.reload()).toBe(false)
    expect(localStorage.getItem(consentKey)).toBe(saved)
    expect(markers.isEnabledFor(roomJid)).toBe(false)
  })

  it.each(['absent', 'rejected'] as const)('keeps current saved consent untouched during a refresh with %s coordination access', async failure => {
    expect(await markers.setRoomEnabled(roomJid, true)).toBe(true)
    const saved = localStorage.getItem(consentKey)
    if (failure === 'absent') vi.stubGlobal('indexedDB', undefined)
    else vi.spyOn(indexedDB, 'open').mockImplementation(() => { throw new DOMException('Storage denied', 'SecurityError') })
    const unsubscribe = markers.subscribe(() => { markers.getConsent() })
    try {
      window.dispatchEvent(new StorageEvent('storage', { key: `${ROOM_READ_MARKERS_STORAGE_KEY}:${JSON.stringify([jid, 'watermarks'])}` }))
      await markers.reload()
      expect(localStorage.getItem(consentKey)).toBe(saved)
      expect(markers.isEnabledFor(roomJid)).toBe(true)
    } finally { unsubscribe() }
  })

  it('saves the room choice without Web Locks', async () => {
    vi.stubGlobal('navigator', {})
    expect(await markers.setRoomEnabled(roomJid, true)).toBe(true)
    expect(markers.isEnabledFor(roomJid)).toBe(true)
    expect(await markers.setRoomEnabled(roomJid, false)).toBe(true)
    expect(markers.isEnabledFor(roomJid)).toBe(false)
  })

  it('keeps this client opted out when storage refuses both the write and removal of an older consent', async () => {
    expect(await markers.setRoomEnabled(roomJid, true)).toBe(true)
    const storage = localStorage
    const refuse = () => { throw new DOMException('Storage unavailable', 'SecurityError') }
    vi.stubGlobal('localStorage', new Proxy(storage, { get: (target, key) =>
      key === 'setItem' || key === 'removeItem' ? refuse : Reflect.get(target, key, target) }))
    expect(await markers.setEnabled(false)).toBe(false)
    await markers.reload()
    expect(markers.getConsent()).toEqual({ enabled: false, rooms: [] })
    await markers.viewed(roomJid, rows[1])
    expect(send).not.toHaveBeenCalled()
  })


  it('refreshes a cached send watermark on connection takeover before the other tab’s storage event', async () => {
    expect(await markers.setRoomEnabled(roomJid, true)).toBe(true)
    const otherTab = new RoomReadMarkers(dependencies, () => focused)
    otherTab.recordArchiveOrder(roomJid, rows.map(row => row.stanzaId!))
    await otherTab.viewed(roomJid, rows[1])
    const connection = {} as ReturnType<ModuleDependencies['getXmpp']>
    dependencies.getXmpp = () => connection
    await markers.viewed(roomJid, rows[0])
    expect(send).toHaveBeenCalledTimes(1)
  })


  it('reuses a completed walk for different candidates and resumes at its cursor when fresh order evidence arrives', async () => {
    expect(await markers.setRoomEnabled(roomJid, true)).toBe(true)
    await markers.viewed(roomJid, rows[1])
    markers = new RoomReadMarkers(dependencies, () => focused)
    const collectors = new Map<string, (stanza: Element) => void>()
    dependencies.registerMAMCollector = (id, collector) => { collectors.set(id, collector); return () => { collectors.delete(id) } }
    const cursors: string[] = []
    const firstTail = 'archive-after-watermark'
    iq.mockImplementation(async request => {
      if (request.getChild('query', 'http://jabber.org/protocol/disco#info')) return disco()
      const query = request.getChild('query', 'urn:xmpp:mam:2')!
      cursors.push(query.getChild('set', 'http://jabber.org/protocol/rsm')!.getChildText('after')!)
      const id = cursors.length === 1 ? firstTail : 'archive-new-tail'
      collectors.get(query.attrs.queryid)!(xml('message', { from: roomJid }, xml('result', { xmlns: 'urn:xmpp:mam:2', queryid: query.attrs.queryid, id },
        xml('forwarded', { xmlns: 'urn:xmpp:forward:0' }, xml('message', { type: 'groupchat', from: `${roomJid}/Bob` })))))
      return xml('iq', { type: 'result', from: roomJid }, xml('fin', { xmlns: 'urn:xmpp:mam:2', complete: 'true' },
        xml('set', { xmlns: 'http://jabber.org/protocol/rsm' }, xml('last', {}, id))))
    })
    await markers.viewed(roomJid, rows[0])
    const older = message('archive-older', 500)
    rows.push(older)
    await markers.viewed(roomJid, older)
    expect(cursors).toEqual([rows[1].stanzaId])
    markers.recordArchiveOrder(roomJid, [rows[0].stanzaId!, older.stanzaId!])
    await markers.viewed(roomJid, older)
    expect(cursors).toEqual([rows[1].stanzaId, firstTail])
    expect(send).toHaveBeenCalledTimes(1)
  })

  it('does not recreate a discovery observation after an unseen durable edit and cover', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    const captured = useCapturedSelfReading(replayFixture)
    expect(await markers.setRoomEnabled(replayFixture.room, true)).toBe(true)
    let visible = true
    iq.mockRejectedValueOnce(new Error('Discovery timeout'))
      .mockImplementation(async () => { visible = false; return parse(replayFixture.disco) })
    await markers.viewed(replayFixture.room, captured.row, () => visible)
    const peer = new RoomReadMarkers(dependencies, () => focused)
    try {
      expect(await peer.setRoomEnabled(fixture.room, true)).toBe(true)
      await vi.advanceTimersToNextTimerAsync()
      visible = false
      // An invalid repeated notification joins pending work without authorizing a fresh view.
      await markers.viewed(replayFixture.room, captured.row, () => visible)
      expect(send).not.toHaveBeenCalled()
      visible = true
      iq.mockImplementation(async () => parse(replayFixture.disco))
      await markers.viewed(replayFixture.room, captured.row, () => visible)
      expect(send).toHaveBeenCalledTimes(1)
    } finally { peer.cancelPending() }
  })

  it('accepts a fresh view after another runtime replaces the queued generation', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    const captured = useCapturedSelfReading(replayFixture)
    expect(await markers.setRoomEnabled(replayFixture.room, true)).toBe(true)
    iq.mockRejectedValueOnce(new Error('Discovery timeout')).mockImplementation(async () => parse(replayFixture.disco))
    await markers.viewed(replayFixture.room, captured.row, () => true)
    localStorage.removeItem(consentKey)
    const peer = new RoomReadMarkers(dependencies, () => focused)
    try {
      expect(await peer.setRoomEnabled(replayFixture.room, true)).toBe(true)
      vi.setSystemTime(Date.now() + ROOM_MARKER_DISCOVERY_RETRY_DELAYS[0])
      await markers.viewed(replayFixture.room, captured.row, () => true)
      expect(send).toHaveBeenCalledTimes(1)
    } finally { peer.cancelPending() }
  })

  it('retries the original discovery generation without recapturing it', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    const captured = useCapturedSelfReading(replayFixture)
    expect(await markers.setRoomEnabled(replayFixture.room, true)).toBe(true)
    const boundary = vi.spyOn(markers, 'captureReplayBoundary')
    iq.mockRejectedValueOnce(new Error('Discovery timeout')).mockImplementation(async () => parse(replayFixture.disco))
    let published!: () => void
    const wire = new Promise<void>(resolve => { published = resolve })
    send.mockImplementation(async (_stanza, beforeWrite) => { beforeWrite?.(); published() })
    await markers.viewed(replayFixture.room, captured.row, () => true)
    await vi.advanceTimersToNextTimerAsync()
    await wire
    expect(send).toHaveBeenCalledTimes(1)
    expect(boundary).toHaveBeenCalledTimes(1)
  })

  it.each(['normal', 'early timer', 'backward wall clock'] as const)('retains badges and retries discovery with %s without another presence', async clock => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    await markers.receive(roomJid, marker('archive-a'))
    const display = markers.readers(roomJid, rows[0])
    expect(await markers.setRoomEnabled(roomJid, true)).toBe(true)
    iq.mockRejectedValueOnce(new Error('Discovery timeout'))
    markers.observe(xml('presence', { from: `${roomJid}/Bob` }))
    await markers.viewed(roomJid, rows[1])
    const beforeRetry = iq.mock.calls.length
    expect(markers.eligible(roomJid)).toBe(false)
    expect(markers.readers(roomJid, rows[0])).toBe(display)
    expect(markers.showsBadges(roomJid)).toBe(true)
    await markers.viewed(roomJid, rows[1])
    expect(iq).toHaveBeenCalledTimes(beforeRetry)
    let published!: () => void
    const wire = new Promise<void>(resolve => { published = resolve })
    send.mockImplementation(async (_stanza, beforeWrite) => { beforeWrite?.(); published() })
    if (clock === 'early timer') vi.spyOn(Date, 'now').mockReturnValue(Date.now() + ROOM_MARKER_DISCOVERY_RETRY_DELAYS[0] - 1)
    if (clock === 'backward wall clock') vi.setSystemTime(Date.now() - ROOM_MARKER_DISCOVERY_RETRY_DELAYS.at(-1)!)
    await vi.advanceTimersToNextTimerAsync()
    expect(iq).toHaveBeenCalledTimes(beforeRetry + 1)
    await wire
    expect(send).toHaveBeenCalledTimes(1)
    expect(markers.eligible(roomJid)).toBe(true)
  })


  it('shares an in-flight order walk across concurrent candidates from the same starting position', async () => {
    markers = new RoomReadMarkers(dependencies, () => focused)
    await markers.receive(roomJid, marker(rows[1].stanzaId!), [], true)
    const older = message('archive-older', 500)
    rows.push(older)
    dependencies.registerMAMCollector = () => () => {}
    let answer!: (value: Element) => void
    let started!: () => void
    const ready = new Promise<void>(resolve => { started = resolve })
    let probes = 0
    const end = () => xml('iq', { type: 'result', from: roomJid }, xml('fin', { xmlns: 'urn:xmpp:mam:2', complete: 'true' }))
    iq.mockImplementation(async request => {
      if (request.getChild('query', 'http://jabber.org/protocol/disco#info')) return disco()
      if (++probes === 1) return new Promise(resolve => { answer = resolve; started() })
      return end()
    })
    const first = markers.receive(roomJid, marker(rows[0].stanzaId!), [], true)
    await ready
    const second = markers.receive(roomJid, marker(older.stanzaId!), [], true)
    // Let this arrival batch reach its asynchronous lookups before answering
    // the held archive request; no timed retry or arbitrary sleep is involved.
    await new Promise<void>(resolve => setImmediate(resolve))
    answer(end())
    await Promise.all([first, second])
    expect(probes).toBe(1)
  })

  it('does not spend a fresh capped walk on every marker in one archived page', async () => {
    markers = new RoomReadMarkers(dependencies, () => focused)
    const newest = rows[1]
    await markers.receive(roomJid, marker(newest.stanzaId!), [], true)
    const older = Array.from({ length: 51 }, (_, index) => message(`older-${index}`, 1000 - index))
    rows = [...older, newest]
    markers.recordArchiveOrder(roomJid, older.map(row => row.stanzaId!))
    const collectors = new Map<string, (stanza: Element) => void>()
    dependencies.registerMAMCollector = (id, collector) => { collectors.set(id, collector); return () => { collectors.delete(id) } }
    let probes = 0
    iq.mockImplementation(async request => {
      if (request.getChild('query', 'http://jabber.org/protocol/disco#info')) return disco()
      const query = request.getChild('query', 'urn:xmpp:mam:2')!
      const id = `following-${++probes}`
      collectors.get(query.attrs.queryid)!(xml('message', { from: roomJid }, xml('result', { xmlns: 'urn:xmpp:mam:2', queryid: query.attrs.queryid, id },
        xml('forwarded', { xmlns: 'urn:xmpp:forward:0' }, xml('message', { type: 'groupchat', from: `${roomJid}/Bob` })))))
      return xml('iq', { type: 'result', from: roomJid }, xml('fin', { xmlns: 'urn:xmpp:mam:2', complete: 'false' },
        xml('set', { xmlns: 'http://jabber.org/protocol/rsm' }, xml('last', {}, id))))
    })
    for (const row of older) await markers.receive(roomJid, marker(row.stanzaId!), [], true)
    expect(probes).toBe(ROOM_MARKER_ORDER_PAGE_LIMIT)
    expect(markers.readers(roomJid, newest)).toHaveLength(1)
    expect(send).not.toHaveBeenCalled()
  })


  it('keeps the shared completed walk reusable after adding a direct forward shortcut', async () => {
    room.occupants.set('Jules', { nick: 'Jules', occupantId: 'jules-id', role: 'participant', affiliation: 'member' })
    iq.mockResolvedValue(disco(features, room.occupants.size))
    const next = message('archive-newest', 3000)
    rows.push(next)
    markers = new RoomReadMarkers(dependencies, () => focused)
    await markers.receive(roomJid, marker(rows[1].stanzaId!))
    await markers.receive(roomJid, marker(rows[1].stanzaId!, 'jules-id', 'Jules'))
    const collectors = new Map<string, (stanza: Element) => void>()
    dependencies.registerMAMCollector = (id, collector) => { collectors.set(id, collector); return () => { collectors.delete(id) } }
    const cursors: string[] = []
    iq.mockImplementation(async request => {
      const query = request.getChild('query', 'urn:xmpp:mam:2')!
      const after = query.getChild('set', 'http://jabber.org/protocol/rsm')!.getChildText('after')!
      cursors.push(after)
      const page = after === rows[1].stanzaId ? ['archive-middle', next.stanzaId!] : []
      for (const id of page) collectors.get(query.attrs.queryid)!(xml('message', { from: roomJid }, xml('result', { xmlns: 'urn:xmpp:mam:2', queryid: query.attrs.queryid, id },
        xml('forwarded', { xmlns: 'urn:xmpp:forward:0' }, xml('message', { type: 'groupchat', from: `${roomJid}/Bob` })))))
      return xml('iq', { type: 'result', from: roomJid }, xml('fin', { xmlns: 'urn:xmpp:mam:2', complete: 'true' },
        xml('set', { xmlns: 'http://jabber.org/protocol/rsm' }, xml('last', {}, page.at(-1) ?? ''))))
    })
    await markers.receive(roomJid, marker(next.stanzaId!))
    await markers.receive(roomJid, marker(rows[0].stanzaId!, 'jules-id', 'Jules'))
    expect(cursors).toEqual([rows[1].stanzaId])
  })


  it('does not reuse an old discovery backoff after local data is cleared and a fresh view opts in', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    expect(await markers.setRoomEnabled(roomJid, true)).toBe(true)
    iq.mockRejectedValueOnce(new Error('Discovery unavailable'))
    await markers.viewed(roomJid, rows[1])
    await clearRoomReadMarkersLocalData(jid)
    expect(await markers.setRoomEnabled(roomJid, true)).toBe(true)
    await markers.viewed(roomJid, rows[1])
    expect(send).toHaveBeenCalledTimes(1)
    expect(vi.getTimerCount()).toBe(0)
  })

})
