import 'fake-indexeddb/auto'
import { IDBFactory } from 'fake-indexeddb'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { xml, type Element } from '@xmpp/client'
import { MAM } from './MAM'
import { Chat } from './Chat'
import { MUC } from './MUC'
import type { ModuleDependencies } from './BaseModule'
import { XMPPClient } from '../XMPPClient'
import { createMockPresenceReader, createMockStores } from '../test-utils'
import { createStoreBindings, type StoreRefs } from '../../bindings/storeBindings'
import { roomStore } from '../../stores/roomStore'
import { ignoreStore } from '../../stores/ignoreStore'
import type { Room, RoomMessage } from '../types'
import * as cache from '../../utils/messageCache'
import * as searchIndex from '../../utils/searchIndex'
import { searchStore } from '../../stores/searchStore'
import { _clearRetractedIdentitiesForTesting } from '../../utils/retractedIdentities'
import { _resetStorageScopeForTesting, setStorageScopeJid } from '../../utils/storageScope'
import { getRoomModerationId, roomStanzaIdAuthority } from '../../utils/roomStanzaId'
import { findMessageRowIndex, messageRowRef } from '../../utils/messageIdentity'
import { reconcileRoomMessageSnapshots, resolveRoomMessageSnapshot } from '../../utils/roomMessageSnapshots'

const ROOM = 'moderation@conference.example.com'
const ACCOUNT = 'me@example.com'
const NS = 'urn:xmpp:mam:2'
const original: RoomMessage = { type: 'groupchat', roomJid: ROOM, id: 'original-client', stanzaId: 'original-archive',
  from: `${ROOM}/Alice`, nick: 'Alice', occupantId: 'alice', body: 'Original body', timestamp: new Date(1000), isOutgoing: false }
const unrelated = { ...original, id: 'unrelated-client', stanzaId: 'foreign-id', from: `${ROOM}/Bob`, nick: 'Bob', occupantId: 'bob', body: 'Unrelated body' }
original.stanzaIdAuthority = roomStanzaIdAuthority(original, ACCOUNT)
unrelated.stanzaIdAuthority = roomStanzaIdAuthority(unrelated, ACCOUNT)
const room: Room = { jid: ROOM, name: 'Room', nickname: 'Me', joined: true, isBookmarked: true, supportsMAM: true,
  occupants: new Map(), unreadCount: 0, mentionsCount: 0, typingUsers: new Set() }
let unbind: () => void

beforeEach(() => {
  roomStore.getState().reset()
  _clearRetractedIdentitiesForTesting()
  globalThis.indexedDB = new IDBFactory()
  cache._resetDBForTesting()
  searchIndex._resetDBForTesting()
  _resetStorageScopeForTesting()
  setStorageScopeJid(ACCOUNT)
  roomStore.setState({ rooms: new Map(), messages: new Map(), pendingRetractions: new Map() })
})
afterEach(() => { unbind?.(); vi.restoreAllMocks() })

function harness(entries: { archiveId: string; message: Element }[]) {
  const events = new XMPPClient({ debug: false })
  events.destroy()
  const emit = vi.spyOn(events, 'emitSDK')
  const stores = createMockStores()
  stores.room.waitForMessageArrivals.mockImplementation(jid => roomStore.getState().waitForMessageArrivals(jid))
  stores.room.getMessage.mockImplementation((...args) => roomStore.getState().getMessage(...args))
  stores.room.getRoom.mockImplementation(jid => roomStore.getState().rooms.get(jid))
  stores.room.updateLastMessagePreview.mockImplementation((jid, message) => roomStore.getState().updateLastMessagePreview(jid, message))
  stores.room.reconcileHistoryMessages.mockImplementation((...args) => roomStore.getState().reconcileHistoryMessages(...args))
  const unbindStores = createStoreBindings(events, () => ({ ...stores, room: roomStore.getState(), ignore: ignoreStore.getState() }) as unknown as StoreRefs)
  unbind = () => { unbindStores(); events.destroy() }
  let collector: ((stanza: Element) => void) | undefined
  const unregistered = vi.fn()
  const sendIQ = vi.fn(async (iq: Element) => {
    const query = iq.getChild('query', NS)
    if (!query) return xml('iq', { type: 'result' })
    const queryId = query.attrs.queryid
    const page = entries.splice(0)
    for (const entry of page) collector!(xml('message', { from: ROOM },
      xml('result', { xmlns: NS, queryid: queryId, id: entry.archiveId },
        xml('forwarded', { xmlns: 'urn:xmpp:forward:0' },
          xml('delay', { xmlns: 'urn:xmpp:delay', stamp: original.timestamp.toISOString() }), entry.message))))
    return xml('iq', { type: 'result' }, xml('fin', { xmlns: NS, complete: 'true' }))
  })
  const deps: ModuleDependencies = { stores, presence: createMockPresenceReader(), getCurrentJid: () => ACCOUNT,
    getXmpp: () => null, sendStanza: vi.fn(), sendIQ, emit: vi.fn(), emitSDK: events.emitSDK.bind(events),
    registerMAMCollector: (_id, handler) => { collector = handler; return () => { collector = undefined; unregistered() } },
  }
  const mam = new MAM(deps)
  return { mam, chat: new Chat(deps, mam), muc: new MUC(deps, mam), emit, emitEvent: deps.emitSDK, sendIQ, unregistered, stores, deps }
}

function signal(from = ROOM, type = 'groupchat', targetId = original.stanzaId!) {
  return xml('message', { from, type },
    xml('apply-to', { xmlns: 'urn:xmpp:fasten:0', id: targetId },
      xml('moderated', { xmlns: 'urn:xmpp:message-moderate:0', by: `${ROOM}/Admin` },
        xml('retract', { xmlns: 'urn:xmpp:message-retract:0' }))),
    xml('retract', { xmlns: 'urn:xmpp:message-retract:1', id: targetId },
      xml('moderated', { xmlns: 'urn:xmpp:message-moderate:1', by: `${ROOM}/Admin` }),
      xml('reason', { xmlns: 'urn:xmpp:message-moderate:1' }, 'Spam')))
}

it.each([
  ['live', true], ['MAM', true], ['live', false], ['MAM', false],
] as const)('confirms the exact room ID through normal %s ingestion and cache reload with legacy occupant ID %s', async (path, hasOccupantId) => {
  const legacy = { ...original, stanzaIdAuthority: undefined, stanzaId: 'foreign-id', occupantId: hasOccupantId ? original.occupantId : undefined }
  await cache.saveRoomMessage(legacy)
  roomStore.getState().addRoom(room, [legacy, unrelated])
  roomStore.setState({ activeRoomJid: ROOM })
  const h = harness([{ archiveId: original.stanzaId!, message: liveOriginal() }])
  if (path === 'live') h.chat.handle(liveOriginal())
  else await h.mam.queryRoomArchive({ roomJid: ROOM, max: 1, before: '' })
  await vi.waitFor(() => expect(roomStore.getState().messages.get(ROOM)?.find(row => row.occupantId === original.occupantId)?.stanzaId).toBe(original.stanzaId))
  const row = roomStore.getState().messages.get(ROOM)!.find(row => row.occupantId === original.occupantId)!
  expect(row).toMatchObject({ stanzaIdAuthority: { stanzaId: original.stanzaId, roomJid: ROOM, accountJid: ACCOUNT, id: original.id, occupantId: original.occupantId } })
  await vi.waitFor(async () => expect(await cache.getRoomMessage(ROOM, original.id, original.from, original.occupantId)).toMatchObject({ stanzaId: original.stanzaId, stanzaIdAuthority: expect.any(Object) }))
  expect(roomStore.getState().messages.get(ROOM)?.find(row => row.occupantId === unrelated.occupantId)).toEqual(unrelated)
  roomStore.getState().reset()
  const reloaded = await cache.getRoomMessages(ROOM, {})
  expect(reloaded.find(row => row.occupantId === original.occupantId)).toMatchObject({ stanzaId: original.stanzaId, stanzaIdAuthority: expect.any(Object) })
  expect(h.sendIQ).toHaveBeenCalledTimes(path === 'live' ? 0 : 1)
})

describe('legacy identity preservation regressions', () => {
  it.each(['live', 'MAM'] as const)('preserves a missing-occupant legacy row after %s reuses its nickname and client ID', async path => {
    const legacy = { ...original, stanzaIdAuthority: undefined, occupantId: undefined, body: 'Keep ambiguous legacy content' }
    await cache.saveRoomMessage(legacy)
    roomStore.getState().addRoom(room, [legacy])
    roomStore.setState({ activeRoomJid: ROOM })
    const h = harness([{ archiveId: original.stanzaId!, message: liveOriginal() }])
    if (path === 'live') h.chat.handle(liveOriginal())
    else await h.mam.queryRoomArchive({ roomJid: ROOM, max: 1, before: '' })
    await roomStore.getState().waitForMessageArrivals(ROOM)
    const resident = roomStore.getState().messages.get(ROOM)!
    expect(resident).toHaveLength(2)
    expect(resident.find(row => !row.occupantId)).toMatchObject({ body: legacy.body, stanzaIdAuthority: undefined })
    expect(getRoomModerationId(resident.find(row => row.occupantId === original.occupantId)!)).toBe(original.stanzaId)
    h.chat.handle(signal())
    await vi.waitFor(async () => {
      const cached = await cache.getRoomMessages(ROOM, {})
      expect(cached).toHaveLength(2)
      expect(cached.find(row => !row.occupantId)).toMatchObject({ body: legacy.body })
      expect(cached.find(row => !row.occupantId)?.isRetracted).not.toBe(true)
      expect(cached.find(row => row.occupantId === original.occupantId)).toMatchObject({ body: '', isRetracted: true, moderationReason: 'Spam' })
    })
    roomStore.setState({ messages: new Map([[ROOM, []]]) })
    await roomStore.getState().loadMessagesFromCache(ROOM)
    const reloaded = roomStore.getState().messages.get(ROOM)!
    expect(reloaded.find(row => !row.occupantId)?.body).toBe(legacy.body)
    expect(getRoomModerationId(reloaded.find(row => !row.occupantId)!)).toBeUndefined()
    expect(reloaded.find(row => row.occupantId === original.occupantId)?.isRetracted).toBe(true)
    expect(h.sendIQ).toHaveBeenCalledTimes(path === 'live' ? 0 : 1)
  })

  it.each([0, 1])('preserves cached legacy content when normal MAM loads a v%s Spam tombstone', async version => {
    const legacy = { ...original, id: 'legacy-client', stanzaIdAuthority: undefined, body: 'Keep tombstone collision' }
    await cache.saveRoomMessage(legacy)
    roomStore.getState().addRoom(room, [legacy])
    const archived = archivedTombstone(version)
    const tombstone = xml('message', archived.attrs, ...archived.children,
      xml('occupant-id', { xmlns: 'urn:xmpp:occupant-id:0', id: original.occupantId! }))
    const h = harness([{ archiveId: original.stanzaId!, message: tombstone }])
    await h.mam.queryRoomArchive({ roomJid: ROOM, max: 1, before: '' })
    await vi.waitFor(async () => {
      const cached = await cache.getRoomMessages(ROOM, {})
      expect(cached).toHaveLength(2)
      expect(cached.find(row => row.id === legacy.id)).toMatchObject({ body: legacy.body })
      expect(cached.find(row => row.id === legacy.id)?.isRetracted).not.toBe(true)
      expect(cached.find(row => row.id === original.id)).toMatchObject({ body: '', isRetracted: true, moderationReason: 'Spam' })
      expect(getRoomModerationId(cached.find(row => row.id === original.id)!)).toBe(original.stanzaId)
    })
    await cache.saveRoomMessage(legacy)
    expect((await cache.getRoomMessages(ROOM, {})).find(row => row.id === legacy.id)?.body).toBe(legacy.body)
    expect(h.sendIQ).toHaveBeenCalledTimes(1)
  })

  it.each(['reload', 'resident', 'batch'] as const)('preserves uncertain content during %s correction reconciliation', async path => {
    const legacy = { ...original, id: 'legacy-client', stanzaIdAuthority: undefined, body: 'Keep correction collision' }
    const spam = { ...original, body: '', isRetracted: true, isModerated: true, moderationReason: 'Spam' }
    roomStore.getState().addRoom(room, path === 'resident' ? [spam] : [])
    let result: RoomMessage[]
    if (path === 'resident') result = await cache.reconcileRoomHistoryMessages([legacy, spam], () => [spam])
    else {
      expect(await cache.saveRoomMessages([legacy, spam])).toBe(true)
      if (path === 'batch') result = await cache.reconcileRoomHistoryMessages([legacy, spam], () => [])
      else {
        await roomStore.getState().loadMessagesFromCache(ROOM)
        result = roomStore.getState().messages.get(ROOM)!
      }
    }
    expect(result).toHaveLength(2)
    expect(result.find(row => row.id === legacy.id)).toMatchObject({ body: legacy.body })
    expect(result.find(row => row.id === legacy.id)?.isRetracted).not.toBe(true)
    expect(result.find(row => row.id === original.id)).toMatchObject({ body: '', isRetracted: true, moderationReason: 'Spam' })
  })

  it.each(['legacy-first', 'confirmed-first'] as const)('preserves indexed legacy ownership during moderation (%s)', async order => {
    const legacy = { ...original, id: 'legacy-client', stanzaIdAuthority: undefined, body: 'Preserved searchable legacy' }
    roomStore.getState().addRoom(room, [legacy])
    const rows = order === 'legacy-first' ? [legacy, original] : [original, legacy]
    await cache.saveRoomMessages(rows)
    await searchIndex.indexMessages(rows)
    expect(await searchIndex.search('searchable')).toHaveLength(1)
    expect(await searchIndex.search('Original')).toHaveLength(1)
    const h = harness([])
    h.chat.handle(signal())
    await vi.waitFor(async () => expect((await cache.getRoomMessages(ROOM, {})).find(row => row.id === original.id)?.isRetracted).toBe(true))
    const spam = (await cache.getRoomMessages(ROOM, {})).find(row => row.id === original.id)!
    await searchIndex.removeMessage(spam)
    expect(await searchIndex.search('searchable')).toEqual([expect.objectContaining({ messageId: legacy.id, body: legacy.body })])
    expect(await searchIndex.search('Original')).toEqual([])
    expect(await cache.areRetractedInCache([legacy, original])).toEqual([false, true])
    await searchIndex.indexMessage(legacy)
    roomStore.setState({ messages: new Map([[ROOM, [spam]]]) })
    searchStore.getState().search('searchable')
    await vi.waitFor(() => expect(searchStore.getState().results).toEqual([expect.objectContaining({ messageId: legacy.id, body: legacy.body })]))
    expect(h.sendIQ).not.toHaveBeenCalled()
  })
})

describe('confirmation boundary regressions', () => {
  it('restores the exact archived row when client and occupant IDs are reused', async () => {
    const second = { ...original, stanzaId: 'second-archive', timestamp: new Date(2000) }
    second.stanzaIdAuthority = roomStanzaIdAuthority(second, ACCOUNT)
    await cache.saveRoomMessages([original, second])
    const anchor = { id: second.id, occupantId: second.occupantId, stanzaId: second.stanzaId }
    const restored = await cache.getRoomMessagesAround(ROOM, anchor, { before: 0, after: 0 })
    expect(restored.map(message => message.stanzaId)).toEqual([second.stanzaId])
    const missing = await cache.getRoomMessagesAround(ROOM, { ...anchor, stanzaId: 'missing' }, { before: 0, after: 0 })
    expect(missing).toEqual([])
  })

  it.each(['live', 'MAM', 'cache'].flatMap(path => [undefined, 'foreign-id'].map(stanzaId => [path, stanzaId] as const)))(
  'keeps an uncorroborated legacy row separate during %s confirmation with prior ID %s', async (path, stanzaId) => {
    const legacy = { ...original, stanzaId, stanzaIdAuthority: undefined, occupantId: undefined, body: 'Keep uncorroborated content' }
    await cache.saveRoomMessage(legacy)
    roomStore.getState().addRoom(room, path === 'cache' ? [] : [legacy])
    roomStore.setState({ activeRoomJid: ROOM })
    const h = harness([{ archiveId: original.stanzaId!, message: liveOriginal() }])
    if (path === 'cache') await cache.saveRoomMessage(original)
    else if (path === 'live') h.chat.handle(liveOriginal())
    else await h.mam.queryRoomArchive({ roomJid: ROOM, max: 1, before: '' })
    await roomStore.getState().waitForMessageArrivals(ROOM)
    await vi.waitFor(async () => {
      const stored = await cache.getRoomMessages(ROOM, {})
      expect(stored).toHaveLength(2)
      const retained = stored.find(message => !message.occupantId)!
      expect(retained).toMatchObject({ body: legacy.body, stanzaId })
      expect(getRoomModerationId(retained)).toBeUndefined()
      expect(getRoomModerationId(stored.find(message => message.occupantId === original.occupantId)!)).toBe(original.stanzaId)
    })
    h.chat.handle(signal())
    await vi.waitFor(async () => {
      const stored = await cache.getRoomMessages(ROOM, {})
      expect(stored.find(message => !message.occupantId)).toMatchObject({ body: legacy.body })
      expect(stored.find(message => !message.occupantId)?.isRetracted).not.toBe(true)
      expect(stored.find(message => message.occupantId === original.occupantId)).toMatchObject({ body: '', isRetracted: true, moderationReason: 'Spam' })
    })
    roomStore.setState({ messages: new Map([[ROOM, []]]) })
    await roomStore.getState().loadMessagesFromCache(ROOM)
    const residents = roomStore.getState().messages.get(ROOM)!
    expect(residents).toHaveLength(2)
    expect(residents.find(message => !message.occupantId)?.body).toBe(legacy.body)
    expect(residents.find(message => message.occupantId === original.occupantId)?.isRetracted).toBe(true)
    expect(h.sendIQ).toHaveBeenCalledTimes(path === 'MAM' ? 1 : 0)
  })

  it.each(['live', 'MAM'].flatMap(path => [undefined, 'foreign-id', original.stanzaId].map(stanzaId => [path, stanzaId] as const)))(
  'retains pending Spam on the surviving %s duplicate with prior ID %s', async (path, stanzaId) => {
    const legacy = { ...original, stanzaId, stanzaIdAuthority: undefined }
    const uncertain = { ...original, id: 'uncertain-client', stanzaIdAuthority: undefined, occupantId: 'uncertain-author', body: 'Keep uncertain companion' }
    await cache.saveRoomMessages([legacy, uncertain])
    roomStore.getState().addRoom(room, [legacy, uncertain])
    roomStore.setState({ activeRoomJid: ROOM })
    const h = harness([{ archiveId: original.stanzaId!, message: liveOriginal() }])
    h.chat.handle(signal())
    expect(roomStore.getState().pendingRetractions.get(ROOM)?.some(record => record.targetId === original.stanzaId)).toBe(true)
    if (path === 'live') h.chat.handle(liveOriginal())
    else await h.mam.queryRoomArchive({ roomJid: ROOM, max: 1, before: '' })
    await roomStore.getState().waitForMessageArrivals(ROOM)
    const residents = roomStore.getState().messages.get(ROOM)!
    const target = residents.find(message => message.id === original.id)!
    expect(target).toMatchObject({ body: '', isRetracted: true, isModerated: true, moderationReason: 'Spam' })
    expect(getRoomModerationId(target)).toBe(original.stanzaId)
    expect(residents.find(message => message.id === uncertain.id)).toMatchObject({ body: uncertain.body })
    expect(residents.find(message => message.id === uncertain.id)?.isRetracted).not.toBe(true)
    expect(roomStore.getState().pendingRetractions.get(ROOM)?.some(record => record.targetId === original.stanzaId) ?? false).toBe(false)
    expect(await resolveRoomMessageSnapshot(original)).toMatchObject({ body: '', isRetracted: true, moderationReason: 'Spam' })
    const snapshots = reconcileRoomMessageSnapshots([legacy, uncertain], residents)
    expect(snapshots[0]).toMatchObject({ body: '', isRetracted: true, moderationReason: 'Spam' })
    expect(snapshots[1]).toMatchObject({ body: uncertain.body })
    await vi.waitFor(async () => {
      const stored = await cache.getRoomMessages(ROOM, {})
      expect(stored.find(message => message.id === original.id)).toMatchObject({ body: '', isRetracted: true, moderationReason: 'Spam' })
      expect(stored.find(message => message.id === uncertain.id)?.body).toBe(uncertain.body)
    })
    expect(h.sendIQ).toHaveBeenCalledTimes(path === 'MAM' ? 1 : 0)
  })

  it('preserves the legacy anchor through cache load-around beside confirmed Spam', async () => {
    const spam = { ...original, body: '', isRetracted: true, isModerated: true, moderationReason: 'Spam' }
    const legacy = { ...original, id: 'legacy-anchor', stanzaIdAuthority: undefined, body: 'Keep anchor content', timestamp: new Date(2000) }
    await cache.saveRoomMessages([spam, legacy])
    roomStore.getState().addRoom(room, [])
    const h = harness([])
    const anchor = { id: legacy.id, occupantId: legacy.occupantId }
    for (const messages of [await cache.getRoomMessagesAround(ROOM, anchor),
      await roomStore.getState().loadMessagesAroundFromCache(ROOM, anchor)]) {
      expect(messages).toHaveLength(2)
      expect(messages.find(message => message.id === legacy.id)).toMatchObject({ body: legacy.body })
      expect(messages.find(message => message.id === legacy.id)?.isRetracted).not.toBe(true)
      expect(messages.find(message => message.id === original.id)).toMatchObject({ body: '', isRetracted: true, moderationReason: 'Spam' })
    }
    expect(roomStore.getState().messages.get(ROOM)?.find(message => message.id === legacy.id)?.body).toBe(legacy.body)
    expect(h.sendIQ).not.toHaveBeenCalled()
  })

  it.each(['live', 'MAM', 'cache'])('retires unverified stanza aliases during %s confirmation without losing other references', async path => {
    const legacy = { ...original, stanzaId: unrelated.stanzaId, stanzaIdAuthority: undefined,
      originId: 'retained-origin', correctionStanzaIds: ['retained-correction'] }
    const spam = { ...unrelated, body: '', isRetracted: true, isModerated: true, moderationReason: 'Spam' }
    await cache.saveRoomMessages([legacy, spam])
    roomStore.getState().addRoom(room, path === 'cache' ? [] : [legacy])
    roomStore.setState({ activeRoomJid: ROOM })
    const h = harness([{ archiveId: original.stanzaId!, message: liveOriginal() }])
    if (path === 'cache') await cache.saveRoomMessage(original)
    else if (path === 'live') h.chat.handle(liveOriginal())
    else await h.mam.queryRoomArchive({ roomJid: ROOM, max: 1, before: '' })
    await roomStore.getState().waitForMessageArrivals(ROOM)
    await vi.waitFor(async () => expect(await cache.getRoomMessage(ROOM, original.id, original.from, original.occupantId))
      .toMatchObject({ stanzaId: original.stanzaId, body: original.body }))
    expect(await cache.getRoomMessageByReference(ROOM, spam.stanzaId!, spam.from))
      .toMatchObject({ id: spam.id, body: '', isRetracted: true, moderationReason: 'Spam' })
    for (const reference of [original.stanzaId!, original.id, 'retained-origin', 'retained-correction']) {
      const resolved = await cache.getRoomMessageByReference(ROOM, reference, original.from)
      expect(resolved).toMatchObject({ id: original.id, stanzaId: original.stanzaId, body: original.body })
      expect(resolved?.isRetracted).not.toBe(true)
    }
    expect(await cache.getRoomMessages(ROOM, {})).toHaveLength(2)
    expect(h.sendIQ).toHaveBeenCalledTimes(path === 'MAM' ? 1 : 0)
  })
})

describe('room ID authority persistence', () => {
  async function confirmed() {
    roomStore.getState().addRoom(room, [])
    const h = harness([])
    h.chat.handle(liveOriginal())
    await roomStore.getState().waitForMessageArrivals(ROOM)
    const row = roomStore.getState().getMessage(ROOM, original.stanzaId!)!
    await vi.waitFor(async () => expect(await cache.getRoomMessage(ROOM, row.id)).not.toBeNull())
    expect(getRoomModerationId(row)).toBe(original.stanzaId)
    return { h, row }
  }

  it.each(['stanzaId', 'id', 'room', 'author', 'account'] as const)('refuses mismatched %s evidence after a cache roundtrip', async conflict => {
    const { h, row } = await confirmed()
    const changed = { ...row,
      ...(conflict === 'stanzaId' ? { stanzaId: 'different-room-id' } : {}),
      ...(conflict === 'id' ? { id: 'other-client-id' } : {}),
      ...(conflict === 'room' ? { roomJid: 'other@conference.example.com' } : {}),
      ...(conflict === 'author' ? { occupantId: 'other-author' } : {}),
    }
    await cache.clearAllMessages()
    if (conflict === 'account') setStorageScopeJid('other@example.com')
    expect(getRoomModerationId(changed)).toBeUndefined()
    await cache.saveRoomMessage(changed)
    const cached = (await cache.getRoomMessages(changed.roomJid, {}))[0]
    expect(cached.body).toBe(row.body)
    expect(getRoomModerationId(cached)).toBeUndefined()
    expect(h.sendIQ).not.toHaveBeenCalled()
  })

  it('retains exact proof when a duplicate omits it, including hydration and renamed authors', async () => {
    const { h, row } = await confirmed()
    await cache.saveRoomMessage({ ...row, stanzaIdAuthority: undefined })
    roomStore.getState().reset()
    roomStore.getState().addRoom(room, [])
    await roomStore.getState().loadMessagesFromCache(ROOM)
    const hydrated = roomStore.getState().getMessage(ROOM, row.stanzaId!)!
    expect(getRoomModerationId(hydrated)).toBe(row.stanzaId)
    expect(getRoomModerationId({ ...hydrated, from: `${ROOM}/Renamed` })).toBe(row.stanzaId)
    expect(getRoomModerationId({ ...hydrated, stanzaId: 'replaced' })).toBeUndefined()
    expect(h.sendIQ).not.toHaveBeenCalled()
  })

  it.each(['replace', 'clear'])('does not revive proof after an ID %s and restoration', async operation => {
    const { h, row } = await confirmed()
    if (operation === 'clear') roomStore.getState().clearMessageStanzaId(ROOM, row.stanzaId!)
    else h.emitEvent('room:message-updated', { roomJid: ROOM, messageId: row.id, updates: { stanzaId: 'replacement-id' } })
    h.emitEvent('room:message-updated', { roomJid: ROOM, messageId: row.id, updates: { stanzaId: row.stanzaId } })
    expect(getRoomModerationId(roomStore.getState().getMessage(ROOM, row.id)!)).toBeUndefined()
    await vi.waitFor(async () => expect((await cache.getRoomMessage(ROOM, row.id))?.stanzaIdAuthority).toBeUndefined())
    expect(h.sendIQ).not.toHaveBeenCalled()
  })

  it.each(['origin', 'client', 'archive'] as const)('keeps confirmation off an unrelated row with a colliding %s identity', async tier => {
    const { h, row } = await confirmed()
    const collision = { ...row, stanzaIdAuthority: undefined, body: 'Separate legacy content',
      id: tier === 'client' ? row.id : 'other-client', stanzaId: tier === 'archive' ? row.stanzaId : 'foreign-id',
      occupantId: tier === 'client' ? 'other-author' : row.occupantId,
      ...(tier === 'origin' ? { originId: 'shared-origin' } : {}),
    }
    if (tier === 'origin') await cache.saveRoomMessage({ ...row, originId: 'shared-origin' })
    await cache.saveRoomMessage(collision)
    const cached = await cache.getRoomMessages(ROOM, {})
    expect(cached).toHaveLength(2)
    expect(getRoomModerationId(cached.find(m => m.body === collision.body)!)).toBeUndefined()
    expect(getRoomModerationId(cached.find(m => m.body === row.body)!)).toBe(row.stanzaId)
    expect(h.sendIQ).not.toHaveBeenCalled()
  })

  it('preserves a legacy foreign-ID collision when the real archive owner arrives', async () => {
    const legacy = { ...original, stanzaIdAuthority: undefined, id: 'legacy-client', occupantId: 'legacy-author', body: 'Legacy visible content' }
    await cache.saveRoomMessage(legacy)
    roomStore.getState().addRoom(room, [legacy])
    const h = harness([])
    h.chat.handle(liveOriginal())
    await roomStore.getState().waitForMessageArrivals(ROOM)
    await vi.waitFor(async () => expect(await cache.getRoomMessages(ROOM, {})).toHaveLength(2))
    const cached = await cache.getRoomMessages(ROOM, {})
    expect(cached.find(row => row.id === legacy.id)).toMatchObject({ body: legacy.body, stanzaId: legacy.stanzaId })
    expect(getRoomModerationId(cached.find(row => row.id === legacy.id)!)).toBeUndefined()
    expect(getRoomModerationId(cached.find(row => row.id === original.id)!)).toBe(original.stanzaId)
    expect((await cache.getRoomMessageByStanzaId(ROOM, original.stanzaId!))?.id).toBe(original.id)
    expect(h.sendIQ).not.toHaveBeenCalled()
  })

  it('keeps conflicting confirmed archive IDs separate despite a reused client ID', async () => {
    const { h, row } = await confirmed()
    h.chat.handle(liveOriginal('next-archive'))
    await roomStore.getState().waitForMessageArrivals(ROOM)
    // Both rows survive and each keeps its own archive id. They share a sender,
    // a client id and a millisecond, so the resident order between them is the
    // cache order key's — archive id, which is total and therefore stable —
    // rather than arrival order.
    expect(roomStore.getState().messages.get(ROOM)?.map(message => getRoomModerationId(message))).toEqual(['next-archive', row.stanzaId])
    await vi.waitFor(async () => expect(await cache.getRoomMessages(ROOM, {})).toHaveLength(2))
    expect(h.sendIQ).not.toHaveBeenCalled()
  })
})

it.each(['resident', 'cached', 'pending'].flatMap(path => ['different', 'missing', 'same'].map(author => [path, author] as const)))('preserves an uncertain ID collision during %s incoming moderation with %s author identity', async (path, author) => {
  const occupantId = author === 'same' ? original.occupantId : author === 'different' ? 'legacy-author' : undefined
  const legacy = { ...original, stanzaIdAuthority: undefined, id: 'legacy-client', occupantId, body: 'Keep uncertain history' }
  await cache.saveRoomMessage(legacy)
  roomStore.getState().addRoom({ ...room, lastMessage: legacy }, path === 'cached' ? [] : [legacy])
  const h = harness([])
  if (path !== 'pending') {
    h.chat.handle(liveOriginal())
    await roomStore.getState().waitForMessageArrivals(ROOM)
    await vi.waitFor(async () => expect(await cache.getRoomMessages(ROOM, {})).toHaveLength(2))
    if (path === 'cached') roomStore.setState({ messages: new Map([[ROOM, []]]) })
  }

  h.chat.handle(signal())
  await vi.waitFor(async () => {
    const cached = await cache.getRoomMessages(ROOM, {})
    expect(cached.find(row => row.id === legacy.id)).toMatchObject({ body: legacy.body })
    expect(cached.find(row => row.id === legacy.id)?.isRetracted).not.toBe(true)
    if (path !== 'pending') expect(cached.find(row => row.id === original.id)?.isRetracted).toBe(true)
  })
  if (path === 'pending') {
    expect(roomStore.getState().roomMeta.get(ROOM)?.lastMessage?.isRetracted).not.toBe(true)
    expect(roomStore.getState().messages.get(ROOM)?.find(row => row.id === legacy.id)?.isRetracted).not.toBe(true)
    h.chat.handle(liveOriginal())
    await roomStore.getState().waitForMessageArrivals(ROOM)
    await vi.waitFor(async () => expect((await cache.getRoomMessages(ROOM, {})).find(row => row.id === original.id)?.isRetracted).toBe(true))
  }
  await cache.saveRoomMessage(legacy)
  const cached = await cache.getRoomMessages(ROOM, {})
  expect(cached.find(row => row.id === legacy.id)).toMatchObject({ body: legacy.body })
  expect(cached.find(row => row.id === legacy.id)?.isRetracted).not.toBe(true)
  const residents = roomStore.getState().messages.get(ROOM) ?? []
  expect(reconcileRoomMessageSnapshots([legacy], residents)[0]).toMatchObject({ id: legacy.id, body: legacy.body })
  expect(await resolveRoomMessageSnapshot(legacy)).toMatchObject({ id: legacy.id, body: legacy.body })
  expect(h.sendIQ).not.toHaveBeenCalled()
})

async function invoke(h: ReturnType<typeof harness>, path: 'search' | 'correction', accepted = true) {
  if (path === 'search') await h.mam.searchRoomArchive({ roomJid: ROOM, query: 'body' })
  else {
    const revision = { ids: ['client:edit'], supersedes: [], archiveTimestamp: 1000 }
    h.mam.correctionCompletion(ROOM, true, revision)({ ...original,
      correctionRevision: revision, correctionAlternatives: [{ body: 'Alternative', correctionRevision: { ...revision, ids: ['client:other'] } }],
    }, () => true)
    await vi.waitFor(() => expect(h.unregistered).toHaveBeenCalledTimes(accepted ? 1 : 2))
  }
}

it.each([0, 1])('uses the room MAM identity instead of a foreign stanza ID for a v%s tombstone', async version => {
  roomStore.getState().addRoom(room, [original, unrelated])
  await cache.saveRoomMessages([original, unrelated])
  const moderated = xml('moderated', { xmlns: `urn:xmpp:message-moderate:${version}`, by: `${ROOM}/Admin` })
  const retracted = xml('retracted', { xmlns: `urn:xmpp:message-retract:${version}`, stamp: '2026-09-11T08:00:00Z' })
  const tombstone = version === 1
    ? xml('retracted', retracted.attrs, moderated, xml('reason', {}, 'Spam'))
    : xml('moderated', moderated.attrs, retracted, xml('reason', {}, 'Spam'))
  const h = harness([{ archiveId: original.stanzaId!, message: xml('message', { from: original.from, type: 'groupchat', id: original.id },
    xml('occupant-id', { xmlns: 'urn:xmpp:occupant-id:0', id: original.occupantId! }), tombstone,
    xml('stanza-id', { xmlns: 'urn:xmpp:sid:0', by: 'foreign-archive.example.com', id: unrelated.stanzaId! })) }])
  const result = await h.mam.queryRoomArchive({ roomJid: ROOM, max: 1, before: '' })
  expect(result.messages[0]).toMatchObject({ stanzaId: original.stanzaId, isModerated: true, moderationReason: 'Spam' })
  expect(roomStore.getState().messages.get(ROOM)?.find(row => row.stanzaId === unrelated.stanzaId)).toEqual(unrelated)
  await vi.waitFor(async () => expect(await cache.getRoomMessageByStanzaId(ROOM, original.stanzaId!))
    .toMatchObject({ body: '', isRetracted: true, isModerated: true, moderationReason: 'Spam' }))
  expect(await cache.getRoomMessageByStanzaId(ROOM, unrelated.stanzaId!)).toMatchObject({ body: unrelated.body })
  expect((await cache.getRoomMessageByStanzaId(ROOM, unrelated.stanzaId!))?.isRetracted).not.toBe(true)
  expect(h.sendIQ).toHaveBeenCalledTimes(1)
})

describe.each(['search', 'correction'] as const)('%s MAM moderation', path => {
  it.each([true, false])('propagates a verified dual-version signal to storage (resident: %s)', async resident => {
    roomStore.getState().addRoom(room, resident ? [original, unrelated] : [unrelated])
    await cache.saveRoomMessages([original, unrelated])
    const h = harness([{ archiveId: 'moderation-event', message: signal() }])
    await invoke(h, path)
    expect(h.emit).toHaveBeenCalledWith('room:message-updated', expect.objectContaining({ roomJid: ROOM, messageId: original.stanzaId,
      updates: expect.objectContaining({ isRetracted: true, isModerated: true, moderationReason: 'Spam', moderatedBy: 'Admin' }) }))
    await vi.waitFor(async () => expect(await cache.getRoomMessageByStanzaId(ROOM, original.stanzaId!))
      .toMatchObject({ body: '', isRetracted: true, isModerated: true, moderationReason: 'Spam' }))
    if (resident) expect(roomStore.getState().messages.get(ROOM)?.find(row => row.id === original.id))
      .toMatchObject({ isRetracted: true, isModerated: true, moderationReason: 'Spam' })
    expect(await cache.getRoomMessageByStanzaId(ROOM, unrelated.stanzaId!)).toMatchObject({ body: unrelated.body })
    expect(h.sendIQ).toHaveBeenCalledTimes(1)
  })

  it.each([
    { from: `${ROOM}/Mallory`, type: 'groupchat' },
    { from: 'other@conference.example.com', type: 'groupchat' },
    { from: ROOM, type: 'chat' },
  ])('rejects an unauthorized moderation sender %j', async ({ from, type }) => {
    roomStore.getState().addRoom(room, [original])
    await cache.saveRoomMessage(original)
    const h = harness([{ archiveId: 'forged-event', message: signal(from, type) }])
    await invoke(h, path, false)
    expect(h.emit.mock.calls.filter(([event]) => event === 'room:message-updated' || event === 'room:retraction-pending')).toEqual([])
    expect(roomStore.getState().messages.get(ROOM)).toEqual([original])
    expect(await cache.getRoomMessageByStanzaId(ROOM, original.stanzaId!)).toMatchObject({ body: original.body })
    expect((await cache.getRoomMessageByStanzaId(ROOM, original.stanzaId!))?.isRetracted).not.toBe(true)
    expect(h.sendIQ).toHaveBeenCalledTimes(path === 'search' ? 1 : 2)
  })
})

it('keeps room archive search from propagating unrelated author mutations', async () => {
  roomStore.getState().addRoom(room, [original])
  await cache.saveRoomMessage(original)
  const h = harness([{ archiveId: 'ordinary-retraction', message: xml('message', { from: original.from, type: 'groupchat' },
    xml('retract', { xmlns: 'urn:xmpp:message-retract:1', id: original.stanzaId! })) }])
  await h.mam.searchRoomArchive({ roomJid: ROOM, query: 'body' })
  expect(h.emit.mock.calls.filter(([event]) => event === 'room:message-updated' || event === 'room:retraction-pending')).toEqual([])
  expect(roomStore.getState().messages.get(ROOM)).toEqual([original])
  expect((await cache.getRoomMessageByStanzaId(ROOM, original.stanzaId!))?.isRetracted).not.toBe(true)
})


it('discards collected moderation when the account changes before MAM completion', async () => {
  roomStore.getState().addRoom(room, [original])
  await cache.saveRoomMessage(original)
  const h = harness([{ archiveId: 'moderation-event', message: signal() }])
  const respond = h.sendIQ.getMockImplementation()!
  let complete!: () => void
  const completion = new Promise<void>(resolve => { complete = resolve })
  h.sendIQ.mockImplementation(async iq => { const response = await respond(iq); await completion; return response })
  const query = h.mam.searchRoomArchive({ roomJid: ROOM, query: 'body' })
  const rejected = expect(query).rejects.toMatchObject({ name: 'AbortError' })
  setStorageScopeJid('other@example.com')
  await cache.saveRoomMessage(original)
  complete()
  await rejected
  expect(h.emit).not.toHaveBeenCalled()
  expect((await cache.getRoomMessageByStanzaId(ROOM, original.stanzaId!))?.isRetracted).not.toBe(true)
  setStorageScopeJid(ACCOUNT)
  expect((await cache.getRoomMessageByStanzaId(ROOM, original.stanzaId!))?.isRetracted).not.toBe(true)
  expect(h.sendIQ).toHaveBeenCalledTimes(1)
})

function archivedOriginal() {
  return xml('message', { from: original.from, type: 'groupchat', id: original.id },
    xml('body', {}, original.body),
    xml('occupant-id', { xmlns: 'urn:xmpp:occupant-id:0', id: original.occupantId! }),
    xml('stanza-id', { xmlns: 'urn:xmpp:sid:0', by: 'foreign.example.com', id: unrelated.stanzaId! }))
}

function archivedTombstone(version = 1, from = original.from, type = 'groupchat') {
  const moderated = xml('moderated', { xmlns: `urn:xmpp:message-moderate:${version}`, by: `${ROOM}/Admin` })
  const retracted = xml('retracted', { xmlns: `urn:xmpp:message-retract:${version}`, stamp: '2026-09-11T08:00:00Z' })
  const payload = version === 1
    ? xml('retracted', retracted.attrs, moderated, xml('reason', {}, 'Spam'))
    : xml('moderated', moderated.attrs, retracted, xml('reason', {}, 'Spam'))
  return xml('message', { from, type, id: original.id }, payload,
    xml('stanza-id', { xmlns: 'urn:xmpp:sid:0', by: 'foreign.example.com', id: unrelated.stanzaId! }))
}

it('uses the ingested room archive identity for an actual removal request', async () => {
  roomStore.getState().addRoom(room, [unrelated])
  await cache.saveRoomMessage(unrelated)
  const h = harness([{ archiveId: original.stanzaId!, message: archivedOriginal() }])
  const result = await h.mam.queryRoomArchive({ roomJid: ROOM, max: 1, before: '' })
  const target = result.messages[0]
  expect(getRoomModerationId(target)).toBe(original.stanzaId)
  await h.muc.moderateMessage(target.roomJid, target.stanzaId!, 'Spam')
  const request = h.sendIQ.mock.calls[1][0]
  expect(request.attrs.to).toBe(ROOM)
  expect(request.getChild('moderate', 'urn:xmpp:message-moderate:1')?.attrs.id).toBe(original.stanzaId)
  expect(roomStore.getState().messages.get(ROOM)?.find(row => row.stanzaId === unrelated.stanzaId)).toEqual(unrelated)
  await vi.waitFor(async () => expect(await cache.getRoomMessageByStanzaId(ROOM, original.stanzaId!))
    .toMatchObject({ isRetracted: true, moderationReason: 'Spam' }))
  expect((await cache.getRoomMessageByStanzaId(ROOM, unrelated.stanzaId!))?.isRetracted).not.toBe(true)
})

it.each([false, true])('accepts only room-owned IDs in live room ingestion (room ID: %s)', roomId => {
  roomStore.getState().addRoom(room, [unrelated])
  const h = harness([])
  const stanza = archivedOriginal()
  if (roomId) stanza.children.push(xml('stanza-id', { xmlns: 'urn:xmpp:sid:0', by: ROOM, id: original.stanzaId! }))
  h.chat.handle(stanza)
  const received = h.emit.mock.calls.find(([event]) => event === 'room:message')?.[1] as { message: RoomMessage }
  expect(received.message.stanzaId).toBe(roomId ? original.stanzaId : undefined)
  expect(getRoomModerationId(received.message)).toBe(roomId ? original.stanzaId : undefined)
  expect(roomStore.getState().messages.get(ROOM)?.find(row => row.stanzaId === unrelated.stanzaId)).toEqual(unrelated)
})

it('preserves direct-chat stanza ID parsing compatibility', () => {
  const h = harness([])
  h.chat.handle(xml('message', { from: 'friend@example.com/device', type: 'chat', id: 'direct' },
    xml('body', {}, 'Direct message'),
    xml('stanza-id', { xmlns: 'urn:xmpp:sid:0', by: 'foreign.example.com', id: 'legacy-id' })))
  expect(h.emit).toHaveBeenCalledWith('chat:message', expect.objectContaining({ message: expect.objectContaining({ stanzaId: 'legacy-id' }) }))
})

const paths = ['query', 'search', 'correction', 'preview', 'byId'] as const
type RoomPath = typeof paths[number]
async function invokeRoom(h: ReturnType<typeof harness>, path: RoomPath, accepted = true) {
  if (path === 'query') return (await h.mam.queryRoomArchive({ roomJid: ROOM, max: 30, before: '' })).messages
  if (path === 'preview') { await h.mam.fetchPreviewForRoom(ROOM); return [] }
  if (path === 'byId') { const message = await h.mam.fetchRoomMessageById(ROOM, original.stanzaId!); return message ? [message] : [] }
  await invoke(h, path, accepted)
  return []
}

describe.each(paths)('%s room MAM consumer', path => {
  it.each(['broadcast', 'v0 tombstone', 'v1 tombstone'])('propagates %s before publishing content', async form => {
    roomStore.getState().addRoom(room, path === 'byId' ? [unrelated] : [original, unrelated])
    await cache.saveRoomMessages([original, unrelated])
    const h = harness([
      { archiveId: original.stanzaId!, message: archivedOriginal() },
      { archiveId: form === 'broadcast' ? 'moderation-event' : original.stanzaId!,
        message: form === 'broadcast' ? signal() : archivedTombstone(form === 'v0 tombstone' ? 0 : 1) },
    ])
    const result = await invokeRoom(h, path)
    expect(h.emit).toHaveBeenCalledWith('room:message-updated', expect.objectContaining({ roomJid: ROOM, messageId: original.stanzaId,
      updates: expect.objectContaining({ isRetracted: true, isModerated: true, moderationReason: 'Spam' }) }))
    await vi.waitFor(async () => expect(await cache.getRoomMessageByStanzaId(ROOM, original.stanzaId!))
      .toMatchObject({ body: '', isRetracted: true, moderationReason: 'Spam' }))
    expect((await cache.getRoomMessageByStanzaId(ROOM, unrelated.stanzaId!))?.isRetracted).not.toBe(true)
    if (path === 'query' || path === 'byId') {
      expect(result.length).toBeGreaterThan(0)
      expect(result.every(row => row.isRetracted && row.moderationReason === 'Spam')).toBe(true)
    }
    if (path === 'preview') {
      expect(h.stores.room.updateLastMessagePreview).toHaveBeenCalledWith(ROOM,
        expect.objectContaining({ stanzaId: original.stanzaId, isRetracted: true, moderationReason: 'Spam' }))
    }
    expect(h.sendIQ).toHaveBeenCalledTimes(1)
  })

  it.each(['broadcast', 'tombstone'])('discards buffered %s after an account switch', async form => {
    roomStore.getState().addRoom(room, path === 'byId' ? [] : [original])
    await cache.saveRoomMessage(original)
    const h = harness([{ archiveId: original.stanzaId!, message: form === 'broadcast' ? signal() : archivedTombstone() }])
    const respond = h.sendIQ.getMockImplementation()!
    let complete!: () => void
    const completion = new Promise<void>(resolve => { complete = resolve })
    h.sendIQ.mockImplementation(async iq => { const response = await respond(iq); await completion; return response })
    const query = invokeRoom(h, path).catch(error => { expect(error).toMatchObject({ name: 'AbortError' }) })
    await vi.waitFor(() => expect(h.sendIQ).toHaveBeenCalledTimes(1))
    const earlyMutations = h.emit.mock.calls.filter(([event]) => event !== 'room:history-loading')
    setStorageScopeJid('other@example.com')
    await cache.saveRoomMessage(original)
    complete()
    await query
    expect(earlyMutations).toEqual([])
    expect(h.emit.mock.calls.filter(([event]) => event !== 'room:history-loading')).toEqual([])
    expect(h.stores.room.updateLastMessagePreview).not.toHaveBeenCalled()
    expect((await cache.getRoomMessageByStanzaId(ROOM, original.stanzaId!))?.isRetracted).not.toBe(true)
    setStorageScopeJid(ACCOUNT)
    expect((await cache.getRoomMessageByStanzaId(ROOM, original.stanzaId!))?.isRetracted).not.toBe(true)
    expect(h.sendIQ).toHaveBeenCalledTimes(1)
  })

  it.each([
    { form: 'broadcast', from: `${ROOM}/Mallory`, type: 'groupchat' },
    { form: 'broadcast', from: 'foreign@conference.example.com', type: 'groupchat' },
    { form: 'tombstone', from: 'foreign@conference.example.com/Alice', type: 'groupchat' },
    { form: 'tombstone', from: original.from, type: 'chat' },
  ])('rejects untrusted moderation %j', async ({ form, from, type }) => {
    roomStore.getState().addRoom(room, path === 'byId' ? [] : [original])
    await cache.saveRoomMessage(original)
    const h = harness([{ archiveId: 'forged-event', message: form === 'broadcast' ? signal(from, type) : archivedTombstone(1, from, type) }])
    await invokeRoom(h, path, false)
    expect(h.emit.mock.calls.filter(([event]) => event === 'room:message-updated' || event === 'room:retraction-pending')).toEqual([])
    expect((await cache.getRoomMessageByStanzaId(ROOM, original.stanzaId!))?.isRetracted).not.toBe(true)
    expect(h.sendIQ).toHaveBeenCalledTimes(path === 'correction' ? 2 : 1)
  })
})

function liveOriginal(stanzaId = original.stanzaId!, overrides: Record<string, string> = {}) {
  return xml('message', { from: original.from, type: 'groupchat', id: original.id, ...overrides },
    xml('body', {}, original.body),
    xml('occupant-id', { xmlns: 'urn:xmpp:occupant-id:0', id: original.occupantId! }),
    xml('stanza-id', { xmlns: 'urn:xmpp:sid:0', by: ROOM, id: stanzaId }),
    xml('delay', { xmlns: 'urn:xmpp:delay', stamp: original.timestamp.toISOString() }))
}

it.each(['Spam', 'Ordinary', 'foreign identity'])('reconciles pending %s received after buffering a preview', async kind => {
  roomStore.getState().addRoom(room, [])
  const entry = liveOriginal(kind === 'foreign identity' ? 'another-archive' : original.stanzaId)
  const h = harness([{ archiveId: entry.getChild('stanza-id', 'urn:xmpp:sid:0')!.attrs.id, message: entry }])
  const respond = h.sendIQ.getMockImplementation()!
  let complete!: () => void
  const completion = new Promise<void>(resolve => { complete = resolve })
  h.sendIQ.mockImplementation(async iq => { const response = await respond(iq); await completion; return response })
  const preview = h.mam.fetchPreviewForRoom(ROOM)
  await vi.waitFor(() => expect(h.sendIQ).toHaveBeenCalledTimes(1))
  const moderation = signal()
  if (kind === 'Ordinary') moderation.getChild('retract', 'urn:xmpp:message-retract:1')!.getChild('reason')!.children = ['Ordinary']
  h.chat.handle(moderation)
  const pending = roomStore.getState().pendingRetractions.get(ROOM)!
  expect(pending).toHaveLength(1)
  complete()
  await preview
  const published = roomStore.getState().rooms.get(ROOM)?.lastMessage
  if (kind === 'foreign identity') expect(published?.isRetracted).not.toBe(true)
  else expect(published).toMatchObject({ isRetracted: true, isModerated: true, moderationReason: kind })
  expect(roomStore.getState().pendingRetractions.get(ROOM)).toEqual(pending)
  expect(h.sendIQ).toHaveBeenCalledTimes(1)
  expect(await cache.getRoomMessageByStanzaId(ROOM, original.stanzaId!)).toBeNull()
})

it.each(['before', 'during'])('observes pending moderation %s awaited history reconciliation without consuming it', async when => {
  roomStore.getState().addRoom(room, [])
  const reconcile = cache.reconcileRoomHistoryMessages
  let complete!: () => void
  const completion = new Promise<void>(resolve => { complete = resolve })
  vi.spyOn(cache, 'reconcileRoomHistoryMessages').mockImplementation(async (...args) => {
    await completion
    return reconcile(...args)
  })
  const h = harness([])
  if (when === 'before') h.chat.handle(signal())
  const result = roomStore.getState().reconcileHistoryMessages([original])
  if (when === 'during') h.chat.handle(signal())
  complete()
  expect((await result)[0]).toMatchObject({ isRetracted: true, moderationReason: 'Spam' })
  expect(roomStore.getState().pendingRetractions.get(ROOM)).toHaveLength(1)
  expect(h.sendIQ).not.toHaveBeenCalled()
})

it.each([false, true])('suppresses a delayed replay before publication after eviction (reactivated: %s)', async active => {
  const stanzaId = `replay-${active}`
  roomStore.getState().addRoom(room, [])
  roomStore.getState().setActiveRoom(ROOM)
  const h = harness([])
  h.chat.handle(liveOriginal(stanzaId))
  await vi.waitFor(async () => expect(await cache.getRoomMessageByStanzaId(ROOM, stanzaId)).toMatchObject({ body: original.body }))
  h.chat.handle(signal(ROOM, 'groupchat', stanzaId))
  await vi.waitFor(async () => expect(await cache.getRoomMessageByStanzaId(ROOM, stanzaId))
    .toMatchObject({ body: '', isRetracted: true, moderationReason: 'Spam' }))
  expect(roomStore.getState().pendingRetractions.get(ROOM)).toBeUndefined()
  roomStore.getState().setActiveRoom(null)
  expect(roomStore.getState().messages.get(ROOM) ?? []).toEqual([])
  if (active) roomStore.getState().setActiveRoom(ROOM)
  const flashes: RoomMessage[] = []
  const unsubscribe = roomStore.subscribe(state => {
    for (const row of [...state.messages.get(ROOM) ?? [], ...[state.rooms.get(ROOM)?.lastMessage].filter(Boolean) as RoomMessage[]]) {
      if (row.stanzaId === stanzaId && (!row.isRetracted || row.moderationReason !== 'Spam')) flashes.push(row)
    }
  })
  h.chat.handle(liveOriginal(stanzaId))
  await vi.waitFor(() => expect(roomStore.getState().messages.get(ROOM)?.some(row => row.stanzaId === stanzaId)).toBe(true))
  unsubscribe()
  expect(flashes).toEqual([])
  expect(roomStore.getState().messages.get(ROOM)?.find(row => row.stanzaId === stanzaId))
    .toMatchObject({ body: '', isRetracted: true, moderationReason: 'Spam' })
  expect(roomStore.getState().rooms.get(ROOM)?.lastMessage).toMatchObject({ isRetracted: true, moderationReason: 'Spam' })
  expect(await cache.getRoomMessageByStanzaId(ROOM, stanzaId)).toMatchObject({ body: '', moderationReason: 'Spam' })
  expect(h.sendIQ).not.toHaveBeenCalled()
})

it.each(['archive', 'client', 'occupant', 'room', 'account'])('does not transfer retained moderation across a different %s identity', async kind => {
  const seed = { ...original, id: `identity-${kind}`, stanzaId: `archive-${kind}` }
  seed.stanzaIdAuthority = roomStanzaIdAuthority(seed, ACCOUNT)
  roomStore.getState().addRoom(room, [seed])
  await cache.saveRoomMessage(seed)
  const h = harness([])
  h.chat.handle(signal(ROOM, 'groupchat', seed.stanzaId))
  await vi.waitFor(async () => expect(await cache.getRoomMessageByStanzaId(ROOM, seed.stanzaId)).toMatchObject({ isRetracted: true }))
  roomStore.setState({ messages: new Map() })
  const stanza = liveOriginal(kind === 'archive' ? 'legitimate-archive' : seed.stanzaId, { id: seed.id })
  if (kind === 'client') stanza.children = stanza.children.filter(child => typeof child === 'string' || child.name !== 'stanza-id')
  if (kind === 'occupant') stanza.getChild('occupant-id', 'urn:xmpp:occupant-id:0')!.attrs.id = 'other-occupant'
  if (kind === 'room') {
    const other = 'other@conference.example.com'
    roomStore.getState().addRoom({ ...room, jid: other }, [])
    stanza.attrs.from = `${other}/Alice`
    stanza.getChild('stanza-id', 'urn:xmpp:sid:0')!.attrs.by = other
  }
  if (kind === 'account') setStorageScopeJid('other@example.com')
  h.chat.handle(stanza)
  const jid = stanza.attrs.from.split('/')[0]
  await vi.waitFor(() => expect(roomStore.getState().messages.get(jid)).toHaveLength(1))
  const row = roomStore.getState().messages.get(jid)?.[0]
  expect(row).toMatchObject({ body: original.body })
  expect(row?.isRetracted).not.toBe(true)
  expect(h.sendIQ).not.toHaveBeenCalled()
})

it.each(['preview', 'byId'] as const)('keeps unrelated transformations out of %s results', async path => {
  roomStore.getState().addRoom(room, [])
  const h = harness([
    { archiveId: original.stanzaId!, message: liveOriginal() },
    { archiveId: 'edit', message: xml('message', { from: original.from, type: 'groupchat', id: 'edit' },
      xml('body', {}, 'Replacement body'), xml('replace', { xmlns: 'urn:xmpp:message-correct:0', id: original.id })) },
    { archiveId: 'reaction', message: xml('message', { from: original.from, type: 'groupchat' },
      xml('reactions', { xmlns: 'urn:xmpp:reactions:0', id: original.stanzaId! }, xml('reaction', {}, '👍'))) },
    { archiveId: 'fastening', message: xml('message', { from: original.from, type: 'groupchat' },
      xml('apply-to', { xmlns: 'urn:xmpp:fasten:0', id: original.stanzaId! },
        xml('meta', { xmlns: 'http://www.w3.org/1999/xhtml', property: 'og:url', content: 'https://example.com' }))) },
    { archiveId: 'retract', message: xml('message', { from: original.from, type: 'groupchat' },
      xml('retract', { xmlns: 'urn:xmpp:message-retract:1', id: original.stanzaId! })) },
  ])
  const messages = await invokeRoom(h, path)
  const result = path === 'preview' ? h.stores.room.updateLastMessagePreview.mock.calls[0]?.[1] : messages[0]
  expect(result?.body).toBe(original.body)
  expect(result?.isRetracted).not.toBe(true)
  expect(result?.reactions).toBeUndefined()
  expect(result?.linkPreview).toBeUndefined()
  expect(h.sendIQ).toHaveBeenCalledTimes(1)
})


describe.each(['preview', 'byId'] as const)('%s retraction-only cache reconciliation', path => {
  it.each(['cache', 'resident'] as const)('preserves response content despite an ordinary correction in %s', async source => {
    const edited = { ...original, body: 'Cached correction', isEdited: true, originalBody: 'Saved original',
      originId: 'cached-origin', correctionTimestamp: 5000,
      correctionRevision: { ids: ['stanza:edited'], supersedes: [], archiveTimestamp: 5000 },
      reactions: { '👍': ['Bob'] } }
    roomStore.getState().addRoom(room, source === 'resident' && path !== 'byId' ? [edited] : [])
    if (source === 'cache') await cache.saveRoomMessage(edited)
    const h = harness([{ archiveId: original.stanzaId!, message: liveOriginal() }])
    if (source === 'resident' && path === 'byId') {
      const respond = h.sendIQ.getMockImplementation()!
      h.sendIQ.mockImplementation(async iq => {
        const response = await respond(iq)
        roomStore.setState({ messages: new Map([[ROOM, [edited]]]) })
        return response
      })
    }
    const messages = await invokeRoom(h, path)
    const result = path === 'preview' ? h.stores.room.updateLastMessagePreview.mock.calls[0]?.[1] : messages[0]
    expect(result).toMatchObject({ body: original.body, id: original.id, stanzaId: original.stanzaId, occupantId: original.occupantId })
    expect(result?.isEdited).toBeUndefined()
    expect(result?.originalBody).toBeUndefined()
    expect(result).not.toHaveProperty('correctionTimestamp')
    expect(result).not.toHaveProperty('correctionRevision')
    expect(result?.originId).toBeUndefined()
    expect(result?.reactions).toBeUndefined()
    expect(h.sendIQ).toHaveBeenCalledTimes(1)
    const history = await roomStore.getState().reconcileHistoryMessages([original])
    expect(history[0]).toMatchObject({ body: edited.body, isEdited: true })
  })

  it.each(['cached Spam', 'pending Spam', 'cached ordinary'] as const)('retains %s with the real store', async kind => {
    roomStore.getState().addRoom(room, [])
    if (kind !== 'pending Spam') {
      await cache.saveRoomMessage({ ...original, body: '', isRetracted: true, retractedAt: new Date(4000),
        ...(kind === 'cached Spam' && { isModerated: true, moderationReason: 'Spam' }) })
      _clearRetractedIdentitiesForTesting()
    }
    const h = harness([{ archiveId: original.stanzaId!, message: liveOriginal() }])
    if (kind === 'pending Spam') h.chat.handle(signal())
    const messages = await invokeRoom(h, path)
    const result = path === 'preview' ? h.stores.room.updateLastMessagePreview.mock.calls[0]?.[1] : messages[0]
    expect(result?.isRetracted).toBe(true)
    if (kind !== 'cached ordinary') expect(result).toMatchObject({ isModerated: true, moderationReason: 'Spam' })
    else expect(result?.isModerated).not.toBe(true)
    if (path === 'byId') await vi.waitFor(async () => {
      const stored = await cache.getRoomMessageByStanzaId(ROOM, original.stanzaId!)
      expect(stored?.isRetracted).toBe(true)
      if (kind === 'cached ordinary') expect(stored?.isModerated).not.toBe(true)
      else expect(stored).toMatchObject({ isModerated: true, moderationReason: 'Spam' })
    })
    expect(h.sendIQ).toHaveBeenCalledTimes(1)
  })
})

it.each([
  { active: false, hydration: 'none' }, { active: true, hydration: 'none' },
  { active: true, hydration: 'latest' }, { active: true, hydration: 'target' },
])('suppresses persisted Spam before delayed replay publication after restart: %j', async ({ active, hydration }) => {
  const stanzaId = `restart-${active}-${hydration}`
  roomStore.getState().addRoom({ ...room, supportsMAM: false }, [])
  const h = harness([])
  h.chat.handle(liveOriginal(stanzaId))
  await vi.waitFor(async () => expect(await cache.getRoomMessageByStanzaId(ROOM, stanzaId)).toMatchObject({ body: original.body }))
  h.chat.handle(signal(ROOM, 'groupchat', stanzaId))
  await vi.waitFor(async () => expect(await cache.getRoomMessageByStanzaId(ROOM, stanzaId))
    .toMatchObject({ body: '', isModerated: true, moderationReason: 'Spam' }))
  expect(roomStore.getState().pendingRetractions.get(ROOM)).toBeUndefined()
  await cache.saveRoomMessage({ ...unrelated, timestamp: new Date('2026-09-11T09:00:00Z') })
  roomStore.getState().reset()
  _clearRetractedIdentitiesForTesting()
  cache._resetDBForTesting()
  searchIndex._resetDBForTesting()
  roomStore.getState().addRoom({ ...room, supportsMAM: false }, [])
  if (active) roomStore.getState().setActiveRoom(ROOM)
  if (hydration !== 'none') {
    const hydrated = await roomStore.getState().loadMessagesFromCache(ROOM, { limit: hydration === 'target' ? 2 : 1 })
    expect(hydrated.some(row => row.stanzaId === stanzaId)).toBe(hydration === 'target')
    roomStore.getState().setActiveRoom(null)
    roomStore.getState().setActiveRoom(ROOM)
  }
  const flashes: RoomMessage[] = []
  const unsubscribe = roomStore.subscribe(state => {
    for (const row of [...state.messages.get(ROOM) ?? [], ...[state.rooms.get(ROOM)?.lastMessage].filter(Boolean) as RoomMessage[]]) {
      if (row.stanzaId === stanzaId && (!row.isRetracted || row.body !== '')) flashes.push(row)
    }
  })
  try {
    h.chat.handle(liveOriginal(stanzaId))
    await vi.waitFor(() => expect(roomStore.getState().messages.get(ROOM)?.find(row => row.stanzaId === stanzaId))
      .toMatchObject({ body: '', isRetracted: true, moderationReason: 'Spam' }))
    expect(flashes).toEqual([])
    expect(roomStore.getState().rooms.get(ROOM)?.lastMessage?.body).not.toBe(original.body)
    expect(await cache.getRoomMessageByStanzaId(ROOM, stanzaId)).toMatchObject({ body: '', moderationReason: 'Spam' })
    expect(h.sendIQ).not.toHaveBeenCalled()
  } finally { unsubscribe() }
})

it('holds delayed replay publication and subsequent arrivals until scoped cache reconciliation finishes', async () => {
  roomStore.getState().addRoom(room, [])
  await cache.saveRoomMessage({ ...original, body: '', isRetracted: true, retractedAt: new Date(4000), isModerated: true, moderationReason: 'Spam' })
  _clearRetractedIdentitiesForTesting()
  const reconcile = cache.reconcileRoomHistoryMessages
  let complete!: () => void
  const completion = new Promise<void>(resolve => { complete = resolve })
  const reads = vi.spyOn(cache, 'reconcileRoomHistoryMessages').mockImplementation(async (...args) => {
    const result = await reconcile(...args)
    await completion
    return result
  })
  const h = harness([])
  const published: string[] = []
  const unsubscribe = roomStore.subscribe(state => {
    for (const row of state.messages.get(ROOM) ?? []) if (!published.includes(row.id)) published.push(row.id)
  })
  try {
    h.chat.handle(liveOriginal())
    const next = liveOriginal('next-archive', { id: 'next-client' })
    next.children = next.children.filter(child => typeof child === 'string' || child.name !== 'delay')
    h.chat.handle(next)
    expect(roomStore.getState().messages.get(ROOM) ?? []).toEqual([])
    complete()
    await vi.waitFor(() => expect(published).toEqual([original.id, 'next-client']))
    expect(roomStore.getState().messages.get(ROOM)?.[0]).toMatchObject({ body: '', moderationReason: 'Spam' })
    expect(reads).toHaveBeenCalledTimes(1)
    const live = liveOriginal('live-archive', { id: 'live-client' })
    live.children = live.children.filter(child => typeof child === 'string' || child.name !== 'delay')
    h.chat.handle(live)
    expect(roomStore.getState().messages.get(ROOM)?.some(row => row.id === 'live-client')).toBe(true)
    expect(reads).toHaveBeenCalledTimes(1)
    expect(h.sendIQ).not.toHaveBeenCalled()
  } finally { complete(); unsubscribe() }
})

it.each(['pending', 'account', 'reset', 'remove'] as const)('guards delayed publication when %s changes during cache lookup', async change => {
  roomStore.getState().addRoom(room, [])
  const reconcile = cache.reconcileRoomHistoryMessages
  let buffered = false
  let complete!: () => void
  const completion = new Promise<void>(resolve => { complete = resolve })
  const reads = vi.spyOn(cache, 'reconcileRoomHistoryMessages').mockImplementation(async (...args) => {
    const result = await reconcile(...args)
    buffered = true
    await completion
    return result
  })
  const h = harness([])
  h.chat.handle(liveOriginal())
  expect(roomStore.getState().messages.get(ROOM) ?? []).toEqual([])
  await vi.waitFor(() => expect(buffered).toBe(true))
  if (change === 'pending') h.chat.handle(signal())
  else if (change === 'account') {
    setStorageScopeJid('other@example.com')
    roomStore.getState().switchAccount('other@example.com')
    roomStore.getState().addRoom(room, [])
  } else if (change === 'reset') {
    roomStore.getState().reset()
    roomStore.getState().addRoom(room, [])
  } else roomStore.getState().removeRoom(ROOM)
  complete()
  await reads.mock.results[0].value
  if (change === 'pending') {
    await vi.waitFor(() => expect(roomStore.getState().messages.get(ROOM)?.[0]).toMatchObject({ body: '', moderationReason: 'Spam' }))
    await vi.waitFor(async () => expect(await cache.getRoomMessageByStanzaId(ROOM, original.stanzaId!)).toMatchObject({ body: '', moderationReason: 'Spam' }))
  } else {
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(roomStore.getState().messages.get(ROOM) ?? []).toEqual([])
    expect(roomStore.getState().rooms.get(ROOM)?.lastMessage).toBeUndefined()
    expect(await cache.getRoomMessageByStanzaId(ROOM, original.stanzaId!)).toBeNull()
  }
  expect(h.sendIQ).not.toHaveBeenCalled()
})


it.each(['ordinary', 'archive', 'client', 'occupant', 'room', 'account'] as const)('scopes persisted replay moderation after restart: %s', async kind => {
  const seed = { ...original, id: `durable-${kind}`, stanzaId: `durable-archive-${kind}` }
  if (kind === 'ordinary') seed.stanzaIdAuthority = roomStanzaIdAuthority(seed, ACCOUNT)
  roomStore.getState().addRoom(room, [])
  await cache.saveRoomMessage({ ...seed, body: '', isRetracted: true, retractedAt: new Date(4000),
    ...(kind !== 'ordinary' && { isModerated: true, moderationReason: 'Spam' }) })
  _clearRetractedIdentitiesForTesting()
  const h = harness([])
  const stanza = liveOriginal(kind === 'archive' ? 'another-archive' : seed.stanzaId, { id: seed.id })
  if (kind === 'client') stanza.children = stanza.children.filter(child => typeof child === 'string' || child.name !== 'stanza-id')
  if (kind === 'occupant') stanza.getChild('occupant-id', 'urn:xmpp:occupant-id:0')!.attrs.id = 'another-occupant'
  if (kind === 'room') {
    const other = 'other@conference.example.com'
    roomStore.getState().addRoom({ ...room, jid: other }, [])
    stanza.attrs.from = `${other}/Alice`
    stanza.getChild('stanza-id', 'urn:xmpp:sid:0')!.attrs.by = other
  }
  if (kind === 'account') setStorageScopeJid('other@example.com')
  h.chat.handle(stanza)
  const jid = stanza.attrs.from.split('/')[0]
  await vi.waitFor(() => expect(roomStore.getState().messages.get(jid)).toHaveLength(1))
  const row = roomStore.getState().messages.get(jid)![0]
  if (kind === 'ordinary') {
    expect(row).toMatchObject({ body: '', isRetracted: true })
    expect(row.isModerated).not.toBe(true)
    expect(roomStore.getState().rooms.get(jid)?.lastMessage?.isRetracted).toBe(true)
  } else {
    expect(row.body).toBe(original.body)
    expect(row.isRetracted).not.toBe(true)
  }
  expect(h.sendIQ).not.toHaveBeenCalled()
})

function roomReaction(emoji: string) {
  return xml('message', { from: `${ROOM}/Bob`, type: 'groupchat', id: `reaction-${emoji}` },
    xml('reactions', { xmlns: 'urn:xmpp:reactions:0', id: original.stanzaId! }, xml('reaction', {}, emoji)))
}

function holdReplayRead(call = 1) {
  const reconcile = cache.reconcileRoomHistoryMessages
  let release!: () => void
  let started!: () => void
  const held = new Promise<void>(resolve => { release = resolve })
  const ready = new Promise<void>(resolve => { started = resolve })
  let reads = 0
  vi.spyOn(cache, 'reconcileRoomHistoryMessages').mockImplementation(async (...args) => {
    if (++reads === call) { started(); await held }
    return reconcile(...args)
  })
  return { ready, release }
}

function archivedPoll() {
  const stanza = liveOriginal()
  stanza.children.push(xml('poll', { xmlns: 'urn:fluux:poll:0' }, xml('title', {}, 'Lunch?'),
    xml('option', { emoji: '1' }, 'Pizza'), xml('option', { emoji: '2' }, 'Sushi')))
  return stanza
}

function whisperStanza(id: string, body: string, nick = 'Alice', occupantId = 'alice', target?: string) {
  return xml('message', { from: `${ROOM}/${nick}`, to: `${ROOM}/Bob`, type: 'chat', id },
    xml('body', {}, body), xml('x', { xmlns: 'http://jabber.org/protocol/muc#user' }),
    xml('no-store', { xmlns: 'urn:xmpp:hints' }),
    xml('occupant-id', { xmlns: 'urn:xmpp:occupant-id:0', id: occupantId }),
    ...(target ? [xml('replace', { xmlns: 'urn:xmpp:message-correct:0', id: target })] : []))
}

describe('queued whisper corrections', () => {
  it.each([false, true])('preserves fallback timestamp and ordering across the arrival wait (wire delay: %s)', async delayed => {
    roomStore.getState().addRoom(room, [])
    const h = harness([])
    const gate = holdReplayRead()
    const receivedAt = new Date('2026-09-11T08:01:00Z')
    const wireTimestamp = new Date('2026-09-11T08:00:30Z')
    const nextReceivedAt = new Date('2026-09-11T08:02:00Z')
    vi.useFakeTimers({ toFake: ['Date'] })
    try {
      h.chat.handle(liveOriginal())
      await gate.ready
      vi.setSystemTime(receivedAt)
      const correction = whisperStanza('orphan', 'Orphaned correction', 'Alice', 'alice', 'missing')
      if (delayed) correction.children.push(xml('delay', { xmlns: 'urn:xmpp:delay', stamp: wireTimestamp.toISOString() }))
      h.chat.handle(correction)
      expect(roomStore.getState().getMessage(ROOM, 'orphan')).toBeUndefined()
      expect(await cache.getRoomMessage(ROOM, 'orphan')).toBeNull()
      expect(h.emit).not.toHaveBeenCalledWith('room:whisper', expect.anything())
      expect(h.deps.emit).not.toHaveBeenCalledWith('message', expect.objectContaining({ id: 'orphan' }))
      vi.setSystemTime(nextReceivedAt)
      const next = liveOriginal('next-archive', { id: 'next' })
      next.children = next.children.filter(child => typeof child === 'string' || child.name !== 'delay')
      h.chat.handle(next)
      vi.setSystemTime(new Date('2026-09-11T08:03:00Z'))
      gate.release()
      await vi.waitFor(() => {
        expect(roomStore.getState().getMessage(ROOM, 'orphan')).toBeDefined()
        expect(roomStore.getState().getMessage(ROOM, 'next')).toBeDefined()
      })
      const expected = { id: 'orphan', body: 'Orphaned correction', timestamp: delayed ? wireTimestamp : receivedAt, isPrivate: true }
      expect.soft(roomStore.getState().getMessage(ROOM, 'orphan')).toMatchObject(expected)
      expect.soft(roomStore.getState().getMessage(ROOM, 'orphan')?.isDelayed).toBe(delayed || undefined)
      expect(roomStore.getState().getMessage(ROOM, 'next')?.timestamp).toEqual(nextReceivedAt)
      expect.soft(roomStore.getState().messages.get(ROOM)?.filter(row => ['orphan', 'next'].includes(row.id)).map(row => row.id)).toEqual(['orphan', 'next'])
      await vi.waitFor(async () => expect((await cache.getRoomMessages(ROOM, {})).filter(row => ['orphan', 'next'].includes(row.id))).toHaveLength(2))
      const persisted = await cache.getRoomMessages(ROOM, {})
      expect.soft(persisted.find(row => row.id === 'orphan')).toMatchObject(expected)
      expect.soft(persisted.find(row => row.id === 'orphan')?.isDelayed).toBe(delayed || undefined)
      expect.soft(persisted.filter(row => ['orphan', 'next'].includes(row.id)).map(row => row.id)).toEqual(['orphan', 'next'])
      expect(h.sendIQ).not.toHaveBeenCalled()
      expect(h.deps.sendStanza).not.toHaveBeenCalled()
    } finally { gate.release(); vi.useRealTimers() }
  })

  it.each([false, true])('preserves fallback receipt-time attribution across nickname changes (outgoing: %s)', async outgoing => {
    roomStore.getState().addRoom({ ...room, occupants: new Map([
      ['Bob', { nick: 'Bob', occupantId: 'bob', affiliation: 'member', role: 'participant' }],
    ]) }, [])
    const h = harness([])
    const gate = holdReplayRead()
    const nick = outgoing ? 'Me' : 'Alice'
    const occupantId = outgoing ? 'me' : 'alice'
    try {
      h.chat.handle(liveOriginal())
      await gate.ready
      h.chat.handle(whisperStanza('orphan', 'Orphaned correction', nick, occupantId, 'missing'))
      roomStore.getState().updateRoom(ROOM, { nickname: outgoing ? 'RenamedMe' : 'Alice', occupants: new Map([
        ['Bob', { nick: 'Bob', occupantId: 'replacement-bob', affiliation: 'member', role: 'participant' }],
      ]) })
      expect(roomStore.getState().getMessage(ROOM, 'orphan')).toBeUndefined()
      expect(h.emit).not.toHaveBeenCalledWith('room:whisper', expect.anything())
      const published = roomStore.getState().waitForMessageArrivals(ROOM)
      gate.release()
      await published
      const expected = {
        id: 'orphan', body: 'Orphaned correction', from: `${ROOM}/${nick}`, nick, occupantId,
        isPrivate: true, isOutgoing: outgoing, whisperWith: outgoing ? 'Bob' : nick,
        whisperWithOccupantId: outgoing ? 'bob' : occupantId,
      }
      expect.soft(roomStore.getState().getMessage(ROOM, 'orphan')).toMatchObject(expected)
      await vi.waitFor(async () => expect(await cache.getRoomMessage(ROOM, 'orphan')).not.toBeNull())
      expect.soft(await cache.getRoomMessage(ROOM, 'orphan')).toMatchObject(expected)
      expect.soft(h.emit).toHaveBeenCalledWith('room:whisper', expect.objectContaining({
        message: expect.objectContaining(expected), incrementUnread: !outgoing, incrementMentions: !outgoing,
      }))
      expect(h.sendIQ).not.toHaveBeenCalled()
      expect(h.deps.sendStanza).not.toHaveBeenCalled()
    } finally { gate.release() }
  })

  it.each([
    { nick: 'Alice', correctedNick: 'Alice', occupantId: 'alice', outgoing: false },
    { nick: 'Alice', correctedNick: 'Renamed', occupantId: 'alice', outgoing: false },
    { nick: 'Me', correctedNick: 'RenamedMe', occupantId: 'me', outgoing: true },
  ])('edits one private original in receive order: %j', async ({ nick, correctedNick, occupantId, outgoing }) => {
    roomStore.getState().addRoom({ ...room, occupants: new Map([
      ['Bob', { nick: 'Bob', occupantId: 'bob', affiliation: 'member', role: 'participant' }],
    ]) }, [])
    const h = harness([])
    const gate = holdReplayRead()
    try {
      h.chat.handle(liveOriginal())
      await gate.ready
      h.chat.handle(whisperStanza('whisper', 'Private original', nick, occupantId))
      h.chat.handle(whisperStanza('edit-1', 'First edit', correctedNick, occupantId, 'whisper'))
      h.chat.handle(whisperStanza('edit-2', 'Final edit', correctedNick, occupantId, 'whisper'))
      expect(roomStore.getState().getMessage(ROOM, 'whisper')).toBeUndefined()
      expect(h.emit.mock.calls.filter(([event]) => event === 'room:whisper').map(([, payload]) => (payload as { message: RoomMessage }).message.id)).toEqual(['whisper'])
      expect(await cache.getRoomMessage(ROOM, 'edit-1')).toBeNull()
      expect(await cache.getRoomMessage(ROOM, 'edit-2')).toBeNull()
      h.chat.handle(signal())
      expect(roomStore.getState().pendingRetractions.get(ROOM)).toHaveLength(1)
      const published = roomStore.getState().waitForMessageArrivals(ROOM)
      gate.release()
      await published
      const expected = {
        id: 'whisper', body: 'Final edit', originalBody: 'Private original', isEdited: true,
        from: `${ROOM}/${nick}`, nick, occupantId, isPrivate: true, isOutgoing: outgoing,
        whisperWith: outgoing ? 'Bob' : nick, whisperWithOccupantId: outgoing ? 'bob' : occupantId,
      }
      expect(roomStore.getState().messages.get(ROOM)?.filter(row => row.isPrivate)).toEqual([expect.objectContaining(expected)])
      expect(roomStore.getState().getMessage(ROOM, original.stanzaId!)).toMatchObject({ isRetracted: true, moderationReason: 'Spam' })
      await vi.waitFor(async () => {
        const messages = await cache.getRoomMessages(ROOM, {})
        expect(messages.filter(row => row.isPrivate)).toEqual([expect.objectContaining(expected)])
      })
      expect(h.sendIQ).not.toHaveBeenCalled()
    } finally { gate.release() }
  })

  it('keeps a queued wrong-author correction from editing the private original', async () => {
    roomStore.getState().addRoom(room, [])
    const h = harness([])
    const gate = holdReplayRead()
    try {
      h.chat.handle(liveOriginal())
      await gate.ready
      h.chat.handle(whisperStanza('whisper', 'Private original'))
      h.chat.handle(whisperStanza('forged-edit', 'Different author', 'Alice', 'mallory', 'whisper'))
      gate.release()
      await vi.waitFor(async () => {
        expect(await cache.getRoomMessage(ROOM, 'forged-edit')).toMatchObject({ body: 'Different author', occupantId: 'mallory', isPrivate: true })
        expect(await cache.getRoomMessage(ROOM, 'whisper')).toMatchObject({ body: 'Private original', occupantId: 'alice', isPrivate: true })
      })
      expect(roomStore.getState().getMessage(ROOM, 'whisper')).toMatchObject({ body: 'Private original', occupantId: 'alice', isPrivate: true })
      expect(roomStore.getState().getMessage(ROOM, 'whisper')?.isEdited).not.toBe(true)
      expect(h.sendIQ).not.toHaveBeenCalled()
    } finally { gate.release() }
  })

  it.each([false, true])('keeps a truly orphaned correction private (replay pending: %s)', async pending => {
    roomStore.getState().addRoom(room, [])
    const h = harness([])
    const gate = holdReplayRead()
    try {
      if (pending) { h.chat.handle(liveOriginal()); await gate.ready }
      h.chat.handle(whisperStanza('orphan', 'Orphaned correction', 'Alice', 'alice', 'missing'))
      if (!pending) expect(roomStore.getState().getMessage(ROOM, 'orphan')).toMatchObject({ body: 'Orphaned correction', isPrivate: true })
      gate.release()
      await vi.waitFor(async () => expect(await cache.getRoomMessage(ROOM, 'orphan')).toMatchObject({
        body: 'Orphaned correction', isPrivate: true, isOutgoing: false, occupantId: 'alice', whisperWith: 'Alice',
      }))
      expect(roomStore.getState().messages.get(ROOM)?.filter(row => row.isPrivate)).toHaveLength(1)
      expect(h.sendIQ).not.toHaveBeenCalled()
    } finally { gate.release() }
  })

  it.each(['account', 'roundtrip', 'reset', 'room'] as const)('cancels queued whisper corrections after %s replacement', async change => {
    roomStore.getState().addRoom(room, [])
    const h = harness([])
    const gate = holdReplayRead()
    try {
      h.chat.handle(liveOriginal())
      await gate.ready
      h.chat.handle(whisperStanza('whisper', 'Private original'))
      h.chat.handle(whisperStanza('edit', 'Cancelled edit', 'Alice', 'alice', 'whisper'))
      const published = roomStore.getState().waitForMessageArrivals(ROOM)
      if (change === 'account' || change === 'roundtrip') {
        setStorageScopeJid('other@example.com')
        if (change === 'roundtrip') setStorageScopeJid(ACCOUNT)
        roomStore.getState().switchAccount(change === 'account' ? 'other@example.com' : ACCOUNT)
      } else if (change === 'room') roomStore.getState().removeRoom(ROOM)
      else roomStore.getState().reset()
      roomStore.getState().addRoom(room, [])
      h.chat.handle(whisperStanza('whisper', 'Replacement'))
      gate.release()
      expect(await published).toBe(false)
      expect(roomStore.getState().getMessage(ROOM, 'whisper')).toMatchObject({ body: 'Replacement', isPrivate: true })
      expect(roomStore.getState().getMessage(ROOM, 'edit')).toBeUndefined()
      await vi.waitFor(async () => expect(await cache.getRoomMessage(ROOM, 'whisper')).toMatchObject({ body: 'Replacement', isPrivate: true }))
      expect(await cache.getRoomMessage(ROOM, 'edit')).toBeNull()
      expect(h.sendIQ).not.toHaveBeenCalled()
    } finally { gate.release() }
  })

  it.each(['account', 'encryption', 'transport'] as const)('keeps an orphaned whisper fallback scoped across %s change during pending arrivals', async change => {
    roomStore.getState().addRoom(room, [])
    const h = harness([])
    const gate = holdReplayRead()
    try {
      h.chat.handle(liveOriginal())
      await gate.ready
      h.chat.handle(whisperStanza('orphan', 'Cancelled fallback', 'Alice', 'alice', 'missing'))
      const published = roomStore.getState().waitForMessageArrivals(ROOM)
      if (change === 'account') h.deps.getCurrentJid = () => 'other@example.com'
      else if (change === 'encryption') h.deps.getE2EEManager = vi.fn().mockReturnValue({})
      else h.deps.getXmpp = vi.fn().mockReturnValue({})
      gate.release()
      await published
      if (change !== 'transport') {
        expect(roomStore.getState().getMessage(ROOM, 'orphan')).toBeUndefined()
        expect(await cache.getRoomMessage(ROOM, 'orphan')).toBeNull()
      } else {
        expect(roomStore.getState().getMessage(ROOM, 'orphan')).toMatchObject({ body: 'Cancelled fallback', isPrivate: true })
        await vi.waitFor(async () => expect(await cache.getRoomMessage(ROOM, 'orphan')).toMatchObject({ body: 'Cancelled fallback', isPrivate: true }))
      }
      expect(h.sendIQ).not.toHaveBeenCalled()
    } finally { gate.release() }
  })

  it.each([false, true])('keeps a prior-session cache-only whisper on the private fallback path (replay pending: %s)', async pending => {
    roomStore.getState().addRoom(room, [])
    const previous = harness([])
    previous.chat.handle(whisperStanza('whisper', 'Private original'))
    previous.chat.handle(whisperStanza('old-edit', 'Previously edited', 'Alice', 'alice', 'whisper'))
    await vi.waitFor(async () => expect(await cache.getRoomMessage(ROOM, 'whisper')).toMatchObject({ body: 'Previously edited', isEdited: true }))
    unbind()
    roomStore.getState().reset()
    roomStore.getState().addRoom(room, [])
    const h = harness([])
    const gate = holdReplayRead()
    try {
      if (pending) { h.chat.handle(liveOriginal()); await gate.ready }
      expect(roomStore.getState().getMessage(ROOM, 'whisper')).toBeUndefined()
      h.chat.handle(whisperStanza('new-edit', 'New-session text', 'Renamed', 'alice', 'whisper'))
      const published = roomStore.getState().waitForMessageArrivals(ROOM)
      gate.release()
      await published
      await vi.waitFor(() => expect(roomStore.getState().getMessage(ROOM, 'new-edit') || h.sendIQ.mock.calls.length).toBeTruthy())
      expect.soft(h.sendIQ).not.toHaveBeenCalled()
      const expected = { body: 'New-session text', isPrivate: true, isOutgoing: false, occupantId: 'alice', whisperWith: 'Renamed' }
      expect(roomStore.getState().getMessage(ROOM, 'new-edit')).toMatchObject(expected)
      expect(roomStore.getState().getMessage(ROOM, 'whisper')).toBeUndefined()
      await vi.waitFor(async () => expect(await cache.getRoomMessage(ROOM, 'new-edit')).toMatchObject(expected))
      expect(await cache.getRoomMessage(ROOM, 'whisper')).toMatchObject({ body: 'Previously edited', isPrivate: true })
      expect(h.sendIQ).not.toHaveBeenCalled()
    } finally { gate.release() }
  })

  it('exposes only an existing arrival boundary and completes it after publication', async () => {
    roomStore.getState().addRoom(room, [])
    const h = harness([])
    expect(roomStore.getState().waitForMessageArrivals(ROOM)).toBeUndefined()
    const gate = holdReplayRead()
    try {
      h.chat.handle(liveOriginal())
      await gate.ready
      const published = roomStore.getState().waitForMessageArrivals(ROOM)
      expect(published).toBeInstanceOf(Promise)
      expect(roomStore.getState().getMessage(ROOM, original.stanzaId!)).toBeUndefined()
      gate.release()
      expect(await published).toBe(true)
      expect(roomStore.getState().getMessage(ROOM, original.stanzaId!)).toMatchObject({ body: original.body })
      expect(roomStore.getState().waitForMessageArrivals(ROOM)).toBeUndefined()
      expect(h.sendIQ).not.toHaveBeenCalled()
    } finally { gate.release() }
  })
})

describe('room replay dependent updates', () => {
  it('applies an immediate Chat reaction after publishing its delayed original', async () => {
    roomStore.getState().addRoom(room, [])
    const h = harness([])
    const gate = holdReplayRead()
    try {
      h.chat.handle(liveOriginal())
      await gate.ready
      h.chat.handle(roomReaction('👍'))
      gate.release()
      await vi.waitFor(() => expect(roomStore.getState().getMessage(ROOM, original.stanzaId!)?.reactions).toEqual({ '👍': ['Bob'] }))
      await vi.waitFor(async () => expect((await cache.getRoomMessageByStanzaId(ROOM, original.stanzaId!))?.reactions).toEqual({ '👍': ['Bob'] }))
      expect(h.sendIQ).not.toHaveBeenCalled()
    } finally { gate.release() }
  })

  it('keeps ordinary updates ahead of later arrivals without recursively requeueing', async () => {
    roomStore.getState().addRoom(room, [])
    const h = harness([])
    const gate = holdReplayRead()
    const closedAt = new Date('2026-09-11T08:01:00Z')
    let stateAtNext: RoomMessage | undefined
    const unsubscribe = roomStore.subscribe(state => {
      if (!stateAtNext && state.messages.get(ROOM)?.some(row => row.id === 'next')) stateAtNext = state.getMessage(ROOM, original.stanzaId!)
    })
    try {
      h.chat.handle(liveOriginal())
      await gate.ready
      h.chat.handle(roomReaction('👍'))
      h.emitEvent('room:message-updated', { roomJid: ROOM, messageId: original.stanzaId!, updates: { pollClosedAt: closedAt } })
      h.chat.handle(liveOriginal('next-archive', { id: 'next' }))
      h.chat.handle(roomReaction('🎉'))
      gate.release()
      await vi.waitFor(() => expect(roomStore.getState().getMessage(ROOM, original.stanzaId!)?.reactions).toEqual({ '🎉': ['Bob'] }))
      expect(stateAtNext).toMatchObject({ reactions: { '👍': ['Bob'] }, pollClosedAt: closedAt })
      expect(roomStore.getState().getMessage(ROOM, original.stanzaId!)?.pollClosedAt).toEqual(closedAt)
      expect(h.sendIQ).not.toHaveBeenCalled()
    } finally { gate.release(); unsubscribe() }
  })

  it('keeps moderation observable before a queued original and its ordinary updates publish', async () => {
    roomStore.getState().addRoom(room, [])
    const h = harness([])
    const gate = holdReplayRead()
    const flashes: RoomMessage[] = []
    const unsubscribe = roomStore.subscribe(state => {
      const row = state.getMessage(ROOM, original.stanzaId!)
      if (row && !row.isRetracted) flashes.push(row)
    })
    try {
      h.chat.handle(liveOriginal())
      await gate.ready
      h.chat.handle(roomReaction('👍'))
      h.emitEvent('room:message-updated', { roomJid: ROOM, messageId: original.stanzaId!, updates: { pollClosedAt: new Date(4000) } })
      h.chat.handle(signal())
      expect(roomStore.getState().pendingRetractions.get(ROOM)).toHaveLength(1)
      expect(roomStore.getState().getMessage(ROOM, original.stanzaId!)).toBeUndefined()
      gate.release()
      await vi.waitFor(() => expect(roomStore.getState().getMessage(ROOM, original.stanzaId!)).toMatchObject({ body: '', isRetracted: true, moderationReason: 'Spam' }))
      expect(flashes).toEqual([])
      expect(h.sendIQ).not.toHaveBeenCalled()
    } finally { gate.release(); unsubscribe() }
  })

  it.each(['account', 'roundtrip', 'reset', 'room'] as const)('cancels queued reactions and ordinary updates after %s replacement', async change => {
    roomStore.getState().addRoom(room, [])
    const h = harness([])
    const gate = holdReplayRead()
    try {
      h.chat.handle(liveOriginal())
      await gate.ready
      h.chat.handle(roomReaction('👍'))
      h.emitEvent('room:message-updated', { roomJid: ROOM, messageId: original.stanzaId!, updates: { pollClosedAt: new Date(4000) } })
      if (change === 'account' || change === 'roundtrip') {
        setStorageScopeJid('other@example.com')
        if (change === 'roundtrip') setStorageScopeJid(ACCOUNT)
        roomStore.getState().switchAccount(change === 'account' ? 'other@example.com' : ACCOUNT)
      } else if (change === 'room') roomStore.getState().removeRoom(ROOM)
      else roomStore.getState().reset()
      roomStore.getState().addRoom(room, [{ ...original, body: 'Replacement room message' }])
      gate.release()
      await vi.mocked(cache.reconcileRoomHistoryMessages).mock.results[0].value.catch(() => {})
      await new Promise(resolve => setTimeout(resolve, 0))
      const replacement = roomStore.getState().getMessage(ROOM, original.stanzaId!)
      expect(replacement?.body).toBe('Replacement room message')
      expect(replacement?.reactions).toBeUndefined()
      expect(replacement?.pollClosedAt).toBeUndefined()
      expect(h.sendIQ).not.toHaveBeenCalled()
    } finally { gate.release() }
  })

  it('keeps ordinary live arrivals and their updates synchronous', () => {
    roomStore.getState().addRoom(room, [])
    const h = harness([])
    const stanza = liveOriginal()
    stanza.children = stanza.children.filter(child => typeof child === 'string' || child.name !== 'delay')
    h.chat.handle(stanza)
    h.chat.handle(roomReaction('👍'))
    h.emitEvent('room:message-updated', { roomJid: ROOM, messageId: original.stanzaId!, updates: { pollClosedAt: new Date(4000) } })
    expect(roomStore.getState().getMessage(ROOM, original.stanzaId!)).toMatchObject({ reactions: { '👍': ['Bob'] }, pollClosedAt: new Date(4000) })
    expect(h.sendIQ).not.toHaveBeenCalled()
  })

  it('makes the message available when the by-ID promise resolves', async () => {
    roomStore.getState().addRoom(room, [])
    const h = harness([{ archiveId: original.stanzaId!, message: archivedPoll() }])
    const result = await h.mam.fetchRoomMessageById(ROOM, original.stanzaId!)
    expect(result?.poll?.title).toBe('Lunch?')
    expect(roomStore.getState().getMessage(ROOM, original.stanzaId!)).toMatchObject({ id: original.id, poll: result!.poll })
    expect(h.sendIQ).toHaveBeenCalledTimes(1)
  })

  it('preserves actual deferred poll-closed verification after fetching the poll', async () => {
    roomStore.getState().addRoom(room, [])
    const h = harness([{ archiveId: original.stanzaId!, message: archivedPoll() }])
    h.chat.handle(xml('message', { from: original.from, type: 'groupchat', id: 'closed-poll' },
      xml('body', {}, 'Poll closed'), xml('occupant-id', { xmlns: 'urn:xmpp:occupant-id:0', id: original.occupantId! }),
      xml('poll-closed', { xmlns: 'urn:fluux:poll:0', 'message-id': original.stanzaId! }, xml('title', {}, 'Lunch?'),
        xml('tally', { emoji: '1', label: 'Pizza', count: '1' }))))
    await vi.waitFor(() => expect(roomStore.getState().getMessage(ROOM, original.stanzaId!)?.pollClosedAt).toBeInstanceOf(Date))
    expect(roomStore.getState().getMessage(ROOM, 'closed-poll')?.pollClosed).toBeDefined()
    await vi.waitFor(async () => expect((await cache.getRoomMessageByStanzaId(ROOM, original.stanzaId!))?.pollClosedAt).toBeInstanceOf(Date))
    expect(h.sendIQ).toHaveBeenCalledTimes(1)
  })

  it.each(['same', 'account', 'reset', 'room'] as const)('holds by-ID completion for publication across %s lifecycle', async change => {
    roomStore.getState().addRoom(room, [])
    const h = harness([{ archiveId: original.stanzaId!, message: archivedPoll() }])
    const gate = holdReplayRead(2)
    let completed = false
    const lookup = h.mam.fetchRoomMessageById(ROOM, original.stanzaId!).then(message => { completed = true; return message })
    try {
      await gate.ready
      await new Promise(resolve => setTimeout(resolve, 0))
      expect(completed).toBe(false)
      if (change === 'account') { setStorageScopeJid('other@example.com'); roomStore.getState().switchAccount('other@example.com') }
      else if (change === 'reset') roomStore.getState().reset()
      else if (change === 'room') roomStore.getState().removeRoom(ROOM)
      if (change !== 'same') roomStore.getState().addRoom(room, [])
      gate.release()
      const result = await lookup
      if (change === 'same') expect(roomStore.getState().getMessage(ROOM, original.stanzaId!)).toMatchObject({ id: result!.id, poll: result!.poll })
      else {
        expect(result).toBeNull()
        expect(roomStore.getState().getMessage(ROOM, original.stanzaId!)).toBeUndefined()
      }
      expect(h.sendIQ).toHaveBeenCalledTimes(1)
    } finally { gate.release(); await lookup }
  })
})


function replayedPollClosure(occupantId = 'alice', nick = 'Alice', withVoters = true) {
  return xml('message', { from: `${ROOM}/${nick}`, type: 'groupchat', id: 'closed-poll' },
    xml('body', {}, 'Poll closed'), xml('occupant-id', { xmlns: 'urn:xmpp:occupant-id:0', id: occupantId }),
    xml('stanza-id', { xmlns: 'urn:xmpp:sid:0', by: ROOM, id: 'closed-poll-archive' }),
    xml('delay', { xmlns: 'urn:xmpp:delay', stamp: '2026-09-11T08:01:00Z' }),
    xml('poll-closed', { xmlns: 'urn:fluux:poll:0', 'message-id': original.stanzaId! }, xml('title', {}, 'Lunch?'),
      xml('tally', { emoji: '1', label: 'Pizza', count: '2', ...(withVoters && { voters: 'alice,carol' }) }),
      xml('tally', { emoji: '2', label: 'Sushi', count: '1', ...(withVoters && { voters: 'dave' }) })))
}

describe('queued poll lookup before MAM', () => {
  it.each([
    { occupantId: 'alice', nick: 'Alice', valid: true, withVoters: true },
    { occupantId: 'alice', nick: 'Renamed', valid: true, withVoters: true },
    { occupantId: 'mallory', nick: 'Alice', valid: false, withVoters: true },
    { occupantId: 'mallory', nick: 'Mallory', valid: false, withVoters: true },
    { occupantId: 'alice', nick: 'Alice', valid: true, withVoters: false },
  ])('verifies queued poll closure locally: %j', async ({ occupantId, nick, valid, withVoters }) => {
    roomStore.getState().addRoom(room, [])
    const h = harness([])
    h.sendIQ.mockRejectedValue(new Error('MAM unavailable'))
    const fetch = vi.spyOn(h.mam, 'fetchRoomMessageById')
    const gate = holdReplayRead()
    const expectedReactions = valid && withVoters ? { '1': ['alice', 'carol'], '2': ['dave'] } : { '2': ['Bob'] }
    try {
      h.chat.handle(archivedPoll())
      await gate.ready
      h.chat.handle(roomReaction('2'))
      h.chat.handle(replayedPollClosure(occupantId, nick, withVoters))
      expect(fetch).toHaveBeenCalledTimes(1)
      expect(h.sendIQ).not.toHaveBeenCalled()
      gate.release()
      const found = await fetch.mock.results[0].value
      expect(found?.poll?.creatorId).toBe('alice')
      expect(found?.reactions).toEqual({ '2': ['Bob'] })
      expect(roomStore.getState().getMessage(ROOM, original.stanzaId!)).toMatchObject({ poll: found!.poll })
      await vi.waitFor(async () => {
        const poll = await cache.getRoomMessageByStanzaId(ROOM, original.stanzaId!)
        const closure = await cache.getRoomMessageByStanzaId(ROOM, 'closed-poll-archive')
        expect(poll).not.toBeNull()
        expect(closure).not.toBeNull()
        expect(poll?.reactions).toEqual(expectedReactions)
        if (valid) {
          expect(poll?.pollClosedAt).toEqual(new Date('2026-09-11T08:01:00Z'))
          expect(closure?.pollClosed?.pollMessageId).toBe(original.stanzaId)
        } else {
          expect(poll?.pollClosedAt).toBeUndefined()
          expect(closure?.pollClosed).toBeUndefined()
        }
      })
      const poll = roomStore.getState().getMessage(ROOM, original.stanzaId!)
      const closure = roomStore.getState().getMessage(ROOM, 'closed-poll-archive')
      expect(!!poll?.pollClosedAt).toBe(valid)
      expect(poll?.reactions).toEqual(expectedReactions)
      expect(!!closure?.pollClosed).toBe(valid)
      expect(h.sendIQ).not.toHaveBeenCalled()
    } finally { gate.release() }
  })

  it.each([true, false])('preserves resident poll reconciliation (voters: %s)', async withVoters => {
    roomStore.getState().addRoom(room, [])
    const h = harness([])
    const stanza = archivedPoll()
    stanza.children = stanza.children.filter(child => typeof child === 'string' || child.name !== 'delay')
    h.chat.handle(stanza)
    h.chat.handle(roomReaction('2'))
    h.chat.handle(replayedPollClosure('alice', 'Alice', withVoters))
    const expected = {
      reactions: withVoters ? { '1': ['alice', 'carol'], '2': ['dave'] } : { '2': ['Bob'] },
      pollClosedAt: new Date('2026-09-11T08:01:00Z'),
    }
    expect(roomStore.getState().getMessage(ROOM, original.stanzaId!)).toMatchObject(expected)
    await vi.waitFor(async () => expect(await cache.getRoomMessageByStanzaId(ROOM, original.stanzaId!)).toMatchObject(expected))
    expect(h.sendIQ).not.toHaveBeenCalled()
  })

  it('preserves the truly missing original fallback when MAM fails', async () => {
    roomStore.getState().addRoom(room, [])
    const h = harness([])
    h.sendIQ.mockRejectedValue(new Error('MAM unavailable'))
    const fetch = vi.spyOn(h.mam, 'fetchRoomMessageById')
    h.chat.handle(replayedPollClosure('mallory', 'Mallory'))
    expect(await fetch.mock.results[0].value).toBeNull()
    await vi.waitFor(async () => expect((await cache.getRoomMessageByStanzaId(ROOM, 'closed-poll-archive'))?.pollClosed).toBeDefined())
    expect(roomStore.getState().getMessage(ROOM, original.stanzaId!)).toBeUndefined()
    expect(h.sendIQ).toHaveBeenCalledTimes(1)
  })

  it.each(['account', 'roundtrip', 'reset', 'room'] as const)('cancels the waiting local verification after %s replacement', async change => {
    roomStore.getState().addRoom(room, [])
    const h = harness([])
    h.sendIQ.mockRejectedValue(new Error('MAM unavailable'))
    const fetch = vi.spyOn(h.mam, 'fetchRoomMessageById')
    const gate = holdReplayRead()
    try {
      h.chat.handle(archivedPoll())
      await gate.ready
      h.chat.handle(replayedPollClosure())
      expect(h.sendIQ).not.toHaveBeenCalled()
      if (change === 'account' || change === 'roundtrip') {
        setStorageScopeJid('other@example.com')
        if (change === 'roundtrip') setStorageScopeJid(ACCOUNT)
        roomStore.getState().switchAccount(change === 'account' ? 'other@example.com' : ACCOUNT)
      } else if (change === 'room') roomStore.getState().removeRoom(ROOM)
      else roomStore.getState().reset()
      roomStore.getState().addRoom(room, [{ ...original, body: 'Replacement' }])
      gate.release()
      expect(await fetch.mock.results[0].value).toBeNull()
      expect(roomStore.getState().getMessage(ROOM, original.stanzaId!)).toMatchObject({ body: 'Replacement' })
      expect(roomStore.getState().getMessage(ROOM, original.stanzaId!)?.pollClosedAt).toBeUndefined()
      expect(roomStore.getState().getMessage(ROOM, original.stanzaId!)?.reactions).toBeUndefined()
      expect(roomStore.getState().getMessage(ROOM, 'closed-poll-archive')).toBeUndefined()
      expect(h.sendIQ).not.toHaveBeenCalled()
    } finally { gate.release() }
  })
})


describe('same-occupant client ID reuse', () => {
  it.each(['live', 'MAM', 'cache'].flatMap(path => ['body', 'timestamp'].map(difference => [path, difference] as const)))(
    'keeps legacy content separate through %s ingestion when %s differs', async (path, difference) => {
      const legacy = { ...original, stanzaId: 'foreign-legacy', stanzaIdAuthority: undefined,
        ...(difference === 'body' ? { body: 'Earlier legitimate content' } : { timestamp: new Date(500) }) }
      await cache.saveRoomMessage(legacy)
      roomStore.getState().addRoom(room, [legacy])
      roomStore.setState({ activeRoomJid: ROOM })
      const h = harness([{ archiveId: original.stanzaId!, message: liveOriginal() }])
      if (path === 'cache') {
        await cache.saveRoomMessage(original)
        await roomStore.getState().loadMessagesFromCache(ROOM)
      } else if (path === 'live') h.chat.handle(liveOriginal())
      else await h.mam.queryRoomArchive({ roomJid: ROOM, max: 1, before: '' })
      await roomStore.getState().waitForMessageArrivals(ROOM)
      const residents = roomStore.getState().messages.get(ROOM)!
      expect(residents).toHaveLength(2)
      expect(residents.find(row => row.stanzaId === legacy.stanzaId)).toMatchObject({ body: legacy.body })
      expect(getRoomModerationId(residents.find(row => row.stanzaId === legacy.stanzaId)!)).toBeUndefined()
      expect(getRoomModerationId(residents.find(row => row.stanzaId === original.stanzaId)!)).toBe(original.stanzaId)
      h.chat.handle(signal())
      await vi.waitFor(async () => {
        const cached = await cache.getRoomMessages(ROOM, {})
        expect(cached).toHaveLength(2)
        expect(cached.find(row => row.stanzaId === legacy.stanzaId)).toMatchObject({ body: legacy.body })
        expect(cached.find(row => row.stanzaId === legacy.stanzaId)?.isRetracted).not.toBe(true)
        expect(cached.find(row => row.stanzaId === original.stanzaId)?.isRetracted).toBe(true)
      })
      expect(await resolveRoomMessageSnapshot(legacy)).toMatchObject({ body: legacy.body, stanzaId: legacy.stanzaId })
      expect((await resolveRoomMessageSnapshot(legacy)).isRetracted).not.toBe(true)
      expect(h.sendIQ).toHaveBeenCalledTimes(path === 'MAM' ? 1 : 0)
    })

  it.each(['live', 'MAM', 'cache'])('restores a validated legacy row reference after %s confirmation and reload', async path => {
    const legacy = { ...original, stanzaId: 'foreign-legacy', stanzaIdAuthority: undefined }
    const saved = messageRowRef(legacy)
    const oldSaved = { id: legacy.id, occupantId: legacy.occupantId, stanzaId: legacy.stanzaId }
    await cache.saveRoomMessage(legacy)
    roomStore.getState().addRoom(room, [legacy])
    roomStore.setState({ activeRoomJid: ROOM })
    const h = harness([{ archiveId: original.stanzaId!, message: liveOriginal() }])
    if (path === 'cache') await cache.saveRoomMessage(original)
    else if (path === 'live') h.chat.handle(liveOriginal())
    else await h.mam.queryRoomArchive({ roomJid: ROOM, max: 1, before: '' })
    await roomStore.getState().waitForMessageArrivals(ROOM)
    await vi.waitFor(async () => {
      const restored = await cache.getRoomMessagesAround(ROOM, saved, { before: 0, after: 0 })
      expect(restored).toHaveLength(1)
      expect(restored[0]).toMatchObject({ stanzaId: original.stanzaId, localRowRef: saved })
      expect(findMessageRowIndex(restored, saved)).toBe(0)
      expect(findMessageRowIndex(restored, oldSaved)).toBe(0)
      expect(await cache.getRoomMessageByRowRef(ROOM, oldSaved)).toMatchObject({ stanzaId: original.stanzaId })
      expect(await cache.getRoomMessagesAround(ROOM, oldSaved, { before: 0, after: 0 })).toHaveLength(1)
      expect(await cache.getRoomMessageByRowRef(ROOM, { ...oldSaved, unconfirmed: false })).toBeNull()
    })
    expect(await cache.getRoomMessageByReference(ROOM, legacy.stanzaId, original.from)).toBeNull()
    expect(await cache.getRoomMessagesAround('another@conference.example.com', saved)).toEqual([])
    expect(findMessageRowIndex([{ ...original, stanzaId: 'surviving-collision' }], saved)).toBe(-1)
  })

  it('sends the selected archive reference without resolving a reused client ID', async () => {
    const second = { ...original, stanzaId: 'second-archive', body: 'Legitimate quote' }
    second.stanzaIdAuthority = roomStanzaIdAuthority(second, ACCOUNT)
    roomStore.getState().addRoom(room, [original, second])
    const h = harness([])
    await h.chat.sendMessage(ROOM, 'My draft', { replyTo: { id: second.id, stanzaId: second.stanzaId,
      to: second.from, fallback: { author: second.nick, body: second.body } } })
    const sent = vi.mocked(h.deps.sendStanza).mock.calls[0][0]
    expect(sent.getChild('reply', 'urn:xmpp:reply:0')?.attrs.id).toBe(second.stanzaId)
    expect(sent.getChildText('body')).toContain(second.body)
    expect(sent.getChildText('body')).not.toContain(original.body)
    expect(h.stores.room.getMessage).not.toHaveBeenCalled()
  })
})

describe('colliding room cache ownership', () => {
  it('persists reactions to the later confirmed row without changing its sibling', async () => {
    const later = { ...original, stanzaId: 'later-archive', body: 'Later body', timestamp: new Date(2000) }
    later.stanzaIdAuthority = roomStanzaIdAuthority(later, ACCOUNT)
    await cache.saveRoomMessages([original, later])
    roomStore.getState().addRoom(room, [original, later])
    await roomStore.getState().updateReactions(ROOM, later.stanzaId!, 'Me', ['👍'])
    await vi.waitFor(async () => {
      const reloaded = await cache.getRoomMessages(ROOM)
      expect(reloaded).toHaveLength(2)
      expect(reloaded.find(message => message.stanzaId === original.stanzaId)?.reactions).toBeUndefined()
      expect(reloaded.find(message => message.stanzaId === later.stanzaId)?.reactions).toEqual({ '👍': ['Me'] })
    })
  })

  it.each(['body', 'timestamp'])('restores distinct cached anchors when only %s and confirmation differ', async difference => {
    const legacy = { ...original, stanzaIdAuthority: undefined,
      ...(difference === 'body' ? { body: 'Uncertain content' } : { timestamp: new Date(500) }) }
    await cache.saveRoomMessages([legacy, original])
    for (const message of [legacy, original]) {
      const ref = messageRowRef(message)
      expect(await cache.getRoomMessageByRowRef(ROOM, ref)).toMatchObject({ body: message.body, timestamp: message.timestamp })
      const window = await cache.getRoomMessagesAround(ROOM, ref)
      expect(findMessageRowIndex(window, ref)).toBeGreaterThanOrEqual(0)
      expect(window[findMessageRowIndex(window, ref)]).toMatchObject({ body: message.body, timestamp: message.timestamp })
    }
    expect(getRoomModerationId((await cache.getRoomMessageByRowRef(ROOM, messageRowRef(legacy)))!)).toBeUndefined()
  })
})
