import 'fake-indexeddb/auto'
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import { xml, type Element } from '@xmpp/client'
import { RoomReadMarkers, clearRoomReadMarkersLocalData, ROOM_MARKER_ORDER_PAGE_LIMIT, ROOM_MARKER_DISCOVERY_RETRY_DELAYS, ROOM_READ_MARKERS_STORAGE_KEY } from './RoomReadMarkers'
import { MAM } from './MAM'
import * as idbConnection from '../../utils/idbConnection'
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
    await markers.setRoomEnabled(roomJid, true)
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
    expect(JSON.parse(localStorage.getItem(consentKey)!)).toEqual({ version: 2, rooms: expected ? [roomJid] : [] })
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
    await markers.setRoomEnabled(roomJid, true)
    await markers.viewed(roomJid, rows[1])
    send.mockClear()
    const watermarkKey = `${ROOM_READ_MARKERS_STORAGE_KEY}:${JSON.stringify([jid, 'watermarks'])}`
    const saved = localStorage.getItem(watermarkKey)
    expect(saved).not.toBeNull()
    localStorage.removeItem(migrationKey)
    localStorage.setItem(consentKey, JSON.stringify({ enabled: true, rooms: [roomJid] }))
    await markers.reload()
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
      await markers.setRoomEnabled(roomJid, true)
      await otherTab.setRoomEnabled(otherRoom, true)
      await markers.setRoomEnabled(roomJid, false)
      expect(markers.getConsent().rooms).toEqual([otherRoom])
      expect(otherTab.getConsent().rooms).toEqual([otherRoom])
      localStorage.setItem(consentKey, JSON.stringify({ enabled: true, rooms: [roomJid, otherRoom] }))
      expect(markers.isEnabledFor(roomJid)).toBe(false)
      await markers.reload()
      expect(markers.isEnabledFor(roomJid)).toBe(false)
      expect(otherTab.isEnabledFor(roomJid)).toBe(false)
      await markers.setRoomEnabled(roomJid, true)
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
    await markers.setRoomEnabled(roomJid, true)
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
      await markers.setRoomEnabled(roomJid, true)
      iq.mockResolvedValue(disco(features.filter(feature => feature !== missing)))
      await markers.viewed(roomJid, rows[1])
      expect(send).not.toHaveBeenCalled()
    })

  it.each(['muc_public', 'muc_open', 'muc_semianonymous'])('rejects contradictory %s', async flag => {
    await markers.setRoomEnabled(roomJid, true)
    iq.mockResolvedValue(disco([...features, flag]))
    await markers.viewed(roomJid, rows[1])
    expect(send).not.toHaveBeenCalled()
  })

  it('rejects failed discovery and ambiguous or unrelated room-count forms', async () => {
    await markers.setRoomEnabled(roomJid, true)
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
    await markers.setRoomEnabled(roomJid, true)
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
      await markers.setRoomEnabled(roomJid, true)
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

  it('does not send from own, encrypted, private, unconfirmed or beyond-pointer rows', async () => {
    await markers.setRoomEnabled(roomJid, true)
    for (const row of [message('own', 1000, { isOutgoing: true }), message('encrypted', 1000, { encryptedPayload: '<encrypted/>' }),
      message('private', 1000, { isPrivate: true }), message('local', 1000, { stanzaId: undefined }), message('ahead', 3000)]) {
      await markers.viewed(roomJid, row)
    }
    expect(send).not.toHaveBeenCalled()
  })

  it('persists account-scoped consent and forward-only watermark, including in-flight dedupe', async () => {
    await markers.setRoomEnabled(roomJid, true)
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
    await markers.setRoomEnabled(roomJid, true)
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
    await markers.setRoomEnabled(roomJid, true)
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
    await markers.setRoomEnabled(roomJid, true)
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
    await markers.setRoomEnabled(roomJid, true)
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
    await markers.setRoomEnabled(roomJid, true)
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
    await markers.setRoomEnabled(roomJid, true)
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
    await markers.setRoomEnabled(roomJid, true)
    await markers.viewed(roomJid, rows[0])
    markers = new RoomReadMarkers(dependencies, () => focused)
    dependencies.lookUpRoomArchiveAnchor = vi.fn(async () => ({ kind: 'absent' as const }))
    await markers.viewed(roomJid, rows[1])
    expect(dependencies.lookUpRoomArchiveAnchor).toHaveBeenCalledWith(roomJid, rows[0].stanzaId)
    expect(send).toHaveBeenCalledTimes(2)
    expect(send.mock.calls[1][0].getChild('displayed', 'urn:xmpp:chat-markers:0')?.attrs.id).toBe(rows[1].stanzaId)
  })

  it('continues a capped archive walk from its last proven cursor on the next view', async () => {
    await markers.setRoomEnabled(roomJid, true)
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
    await markers.setRoomEnabled(roomJid, true)
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
    await markers.setRoomEnabled(roomJid, true)
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
    await markers.setRoomEnabled(roomJid, true)
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
      expect(markers.isEnabledFor(roomJid)).toBe(false)
      expect(send).not.toHaveBeenCalled()
    } finally { otherTab.cancelPending() }
  })

  it('stops local publication immediately while opt-out waits behind another tab’s transaction', async () => {
    await markers.setRoomEnabled(roomJid, true)
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
      await markers.setRoomEnabled(roomJid, true)
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
    await markers.setRoomEnabled(roomJid, true)
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
    await markers.setRoomEnabled(roomJid, true)
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
    const open = idbConnection.openIndexedDB
    let opened!: () => void
    let release!: () => void
    const ready = new Promise<void>(resolve => { opened = resolve })
    const held = new Promise<void>(resolve => { release = resolve })
    vi.spyOn(idbConnection, 'openIndexedDB').mockImplementationOnce(async (...args) => {
      const db = await open(...args)
      opened()
      await held
      return db
    })
    const optIn = markers.setRoomEnabled(roomJid, true)
    await ready
    try { expect(await clearOtherRuntime(jid, allAccounts)).toBe(true) } finally { release() }
    const saved = await optIn
    for (const kind of ['consent', 'migration', 'watermarks']) {
      expect(localStorage.getItem(`${ROOM_READ_MARKERS_STORAGE_KEY}:${JSON.stringify([jid, kind])}`)).toBeNull()
    }
    expect(saved).toBe(false)
    expect(markers.isEnabledFor(roomJid)).toBe(false)
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
    await markers.setRoomEnabled(roomJid, true)
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
    await markers.setRoomEnabled(roomJid, true)
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
    await markers.setRoomEnabled(roomJid, true)
    const otherTab = new RoomReadMarkers(dependencies, () => focused)
    otherTab.recordArchiveOrder(roomJid, rows.map(row => row.stanzaId!))
    await otherTab.viewed(roomJid, rows[1])
    const connection = {} as ReturnType<ModuleDependencies['getXmpp']>
    dependencies.getXmpp = () => connection
    await markers.viewed(roomJid, rows[0])
    expect(send).toHaveBeenCalledTimes(1)
  })


  it('reuses a completed walk for different candidates and resumes at its cursor when fresh order evidence arrives', async () => {
    await markers.setRoomEnabled(roomJid, true)
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

  it.each(['normal', 'early timer', 'backward wall clock'] as const)('retains badges and retries discovery with %s without another presence', async clock => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    await markers.receive(roomJid, marker('archive-a'))
    const display = markers.readers(roomJid, rows[0])
    await markers.setRoomEnabled(roomJid, true)
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
    send.mockImplementation(async () => { published() })
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
    await markers.setRoomEnabled(roomJid, true)
    iq.mockRejectedValueOnce(new Error('Discovery unavailable'))
    await markers.viewed(roomJid, rows[1])
    await clearRoomReadMarkersLocalData(jid)
    await markers.setRoomEnabled(roomJid, true)
    await markers.viewed(roomJid, rows[1])
    expect(send).toHaveBeenCalledTimes(1)
    expect(vi.getTimerCount()).toBe(0)
  })

})
