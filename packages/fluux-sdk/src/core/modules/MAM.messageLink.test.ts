import 'fake-indexeddb/auto'
import { IDBFactory } from 'fake-indexeddb'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { xml, type Element } from '@xmpp/client'
import { MAM } from './MAM'
import { applyRoomMessagePreviewUpdate } from '../../stores/shared/correctionHandoff'
import type { ModuleDependencies } from './BaseModule'
import { createMockPresenceReader } from '../test-utils'
import { createDefaultStoreBindings } from '../defaultStoreBindings'
import { roomStore } from '../../stores/roomStore'
import { setStorageScopeJid } from '../../utils/storageScope'
import * as cache from '../../utils/messageCache'
import * as searchIndex from '../../utils/searchIndex'
import type { Room, RoomMessage } from '../types'

const ROOM = 'team@conference.example.org'
const ACCOUNT = 'alice@example.org'
const MAM_NS = 'urn:xmpp:mam:2'
const RSM_NS = 'http://jabber.org/protocol/rsm'
const room: Room = { jid: ROOM, name: 'Team', nickname: 'Alice', joined: true, isBookmarked: true,
  supportsMAM: true, occupants: new Map(), unreadCount: 0, mentionsCount: 0, typingUsers: new Set() }
const rows: (RoomMessage & { stanzaId: string })[] = Array.from({ length: 80 }, (_, index) => ({
  type: 'groupchat', roomJid: ROOM, id: `team-update-${index}`, originId: undefined, stanzaId: String(1731490000123456 + index),
  from: `${ROOM}/Bob`, nick: 'Bob', occupantId: 'bob', body: `Team update ${index + 1}`,
  timestamp: new Date(Date.UTC(2026, 4, 1, 10, index)), isOutgoing: false,
}))

beforeEach(() => {
  roomStore.getState().reset()
  globalThis.indexedDB = new IDBFactory()
  cache._resetDBForTesting()
  searchIndex._resetDBForTesting()
  setStorageScopeJid(ACCOUNT)
  roomStore.getState().addRoom(room)
})
afterEach(() => { roomStore.getState().reset(); setStorageScopeJid(null); vi.restoreAllMocks() })

// XEP-0313/RSM server boundary, shared by id lookup and context pages. The real
// stores/cache own placement and read state; this stand-in owns only IQ replies.
function harness(failure?: 'network' | 'no-fin', sharedLink?: string, modification?: 'correction' | 'retraction', history = rows, targetReference?: string) {
  let collect: ((stanza: Element) => void) | undefined
  const emitSDK = vi.fn()
  const sendIQ = vi.fn(async (iq: Element) => {
    if (failure === 'network') throw new Error('Connection lost')
    if (failure === 'no-fin') return xml('iq', { type: 'result' })
    const query = iq.getChild('query', MAM_NS)!
    const set = query.getChild('set', RSM_NS)!
    const before = set.getChildText('before') ?? undefined
    const after = set.getChildText('after') ?? undefined
    const max = Number(set.getChildText('max'))
    const cursor = before ?? after
    const at = before === '' ? history.length : cursor === undefined ? 0 : history.findIndex(row => row.stanzaId === cursor)
    if (at < 0) throw Object.assign(new Error('item-not-found'), { condition: 'item-not-found' })
    const pageMax = Math.min(max, 25)
    const page = before !== undefined ? history.slice(Math.max(0, at - pageMax), at)
      : after !== undefined ? history.slice(at + 1, at + 1 + pageMax) : history.slice(0, pageMax)
    for (const row of page) collect!(xml('message', { from: ROOM },
      xml('result', { xmlns: MAM_NS, queryid: query.attrs.queryid, id: row.stanzaId },
        xml('forwarded', { xmlns: 'urn:xmpp:forward:0' },
          xml('delay', { xmlns: 'urn:xmpp:delay', stamp: row.timestamp.toISOString() }),
          xml('message', { type: 'groupchat', from: row.from, id: row.id }, xml('body', {}, row.body),
            ...(row.originId ? [xml('origin-id', { xmlns: 'urn:xmpp:sid:0', id: row.originId })] : []),
            ...(sharedLink ? [xml('reference', { xmlns: 'urn:xmpp:reference:0', type: 'data', uri: sharedLink })] : []),
            ...(row === history[70] && modification ? [modification === 'correction'
              ? xml('replace', { xmlns: 'urn:xmpp:message-correct:0', id: targetReference ?? history[40].id })
              : xml('retract', { xmlns: 'urn:xmpp:message-retract:1', id: targetReference ?? history[40].stanzaId })] : []))))))
    const complete = before !== undefined ? page[0] === history[0] : page.at(-1) === history.at(-1)
    return xml('iq', { type: 'result' }, xml('fin', { xmlns: MAM_NS, complete: String(complete) },
      xml('set', { xmlns: RSM_NS }, xml('first', {}, page[0]?.stanzaId ?? ''), xml('last', {}, page.at(-1)?.stanzaId ?? ''))))
  })
  const deps: ModuleDependencies = { stores: createDefaultStoreBindings(), presence: createMockPresenceReader(),
    getCurrentJid: () => ACCOUNT, getXmpp: () => null, sendStanza: vi.fn(), sendIQ, emit: vi.fn(), emitSDK,
    registerMAMCollector: (_id, collector) => { collect = collector; return () => { collect = undefined } },
  }
  return { mam: new MAM(deps), sendIQ, emitSDK }
}

// Intent: docs/URL_SCHEMES.md — locate order, bounded separate
// archive stretch, absent versus failed outcomes and membership privacy.
describe('linked room message lookup', () => {
  it.each(['cache', 'archive'] as const)('resolves a live reference against the %s archive tier before a detached client-id alias', async source => {
    const quote = { ...rows[40], id: rows[60].stanzaId }
    const other = rows[60]
    if (source === 'cache') await cache.saveRoomMessages([other])
    const h = harness()
    const canonical = await h.mam.resolveRoomMessagePreviewTarget(quote, quote.id)
    expect(canonical).toMatchObject({ kind: 'found', message: { stanzaId: other.stanzaId } })
    if (canonical.kind !== 'found') throw new Error('Expected canonical target')
    const result = applyRoomMessagePreviewUpdate(quote, { roomJid: ROOM, targetId: other.stanzaId,
      actorJid: other.from, actorOccupantId: other.occupantId }, ACCOUNT, canonical.message)
    expect(result).toBe(quote)
    expect(result.isRetracted).not.toBe(true)
  })

  it.each(['correction', 'retraction'] as const)('does not apply an archived %s to a quote whose client id collides with another archive id', async modification => {
    const history = rows.map((row, index) => index === 40 ? { ...row, id: rows[60].stanzaId } : row)
    const h = harness(undefined, undefined, modification, history, history[60].stanzaId)
    expect(await h.mam.readRoomMessagePreview(ROOM, history[40].stanzaId)).toMatchObject({
      kind: 'found', message: { stanzaId: history[40].stanzaId, body: history[40].body },
    })
    expect(h.emitSDK).not.toHaveBeenCalled()
  })

  it('preserves an observed origin-id target ahead of the quote client-id fallback', async () => {
    const reference = 'later-room-update'
    const history = rows.map((row, index) => index === 40 ? { ...row, id: reference }
      : index === 60 ? { ...row, originId: reference } : row)
    const h = harness(undefined, undefined, 'retraction', history, reference)
    expect(await h.mam.readRoomMessagePreview(ROOM, history[40].stanzaId)).toMatchObject({
      kind: 'found', message: { stanzaId: history[40].stanzaId, body: history[40].body },
    })
  })

  it.each(['lookup', 'scan'])('stops after the in-flight %s page when the reader is disposed', async stage => {
    const h = harness()
    const send = h.sendIQ.getMockImplementation()!
    let entered!: () => void
    let release!: () => void
    const started = new Promise<void>(resolve => { entered = resolve })
    const held = new Promise<void>(resolve => { release = resolve })
    h.sendIQ.mockImplementation(async iq => {
      const set = iq.getChild('query', MAM_NS)!.getChild('set', RSM_NS)!
      if (stage === 'lookup' && h.sendIQ.mock.calls.length === 1 || stage === 'scan' && set.getChildText('after') === rows[40].stanzaId) { entered(); await held }
      return send(iq)
    })
    const controller = new AbortController()
    const reading = h.mam.readRoomMessagePreview(ROOM, rows[40].stanzaId, controller.signal)
    const cancelled = expect(reading).rejects.toMatchObject({ name: 'AbortError' })
    await started
    const requests = h.sendIQ.mock.calls.length
    controller.abort()
    release()
    await cancelled
    expect(h.sendIQ).toHaveBeenCalledTimes(requests)
    expect(h.emitSDK).not.toHaveBeenCalled()
  })

  it('checks cancellation between entry decryptions and starts no later page', async () => {
    const h = harness()
    const controller = new AbortController()
    type Decrypt = { decryptArchiveEntryIfNeeded: (message: Element, peer: string, kind: 'chat' | 'room', timestamp?: Date, archiveId?: string) => Promise<boolean> }
    const surface = h.mam as unknown as Decrypt
    const original = surface.decryptArchiveEntryIfNeeded.bind(h.mam)
    const decrypt = vi.spyOn(surface, 'decryptArchiveEntryIfNeeded').mockImplementation(async (...args) => {
      const result = await original(...args)
      if (args[4] === rows[41].stanzaId) controller.abort()
      return result
    })
    await expect(h.mam.readRoomMessagePreview(ROOM, rows[40].stanzaId, controller.signal)).rejects.toMatchObject({ name: 'AbortError' })
    expect(decrypt.mock.calls.map(call => call[4])).toEqual([rows[40].stanzaId, rows[41].stanzaId])
    expect(h.sendIQ.mock.calls.filter(([iq]) => Number(iq.getChild('query', MAM_NS)!.getChild('set', RSM_NS)!.getChildText('max')) === 100)).toHaveLength(1)
  })

  // Approved chat-preview piece: resolve through the reader's access without
  // changing timeline placement, read state, coverage or arrival signals.
  it('retains a data reference when reading archived room history', async () => {
    const uri = `xmpp:${ROOM}?join;msg=${rows[10].stanzaId}`
    const result = await harness(undefined, uri).mam.readRoomMessagePreview(ROOM, rows[40].stanzaId)
    expect(result).toMatchObject({ kind: 'found', message: { references: [{ type: 'data', uri }] } })
  })

  it('reads an archived quote without saving a context stretch or publishing messages', async () => {
    roomStore.getState().addRoom(room, [rows.at(-1)!])
    const before = roomStore.getState()
    const h = harness()
    expect(await h.mam.readRoomMessagePreview(ROOM, rows[40].stanzaId)).toMatchObject({ kind: 'found', message: { body: rows[40].body, stanzaId: rows[40].stanzaId } })
    expect(roomStore.getState()).toBe(before)
    expect(await cache.getRoomMessages(ROOM)).toEqual([])
    expect(h.emitSDK).not.toHaveBeenCalled()
    // Subsequent archive pages reconstruct modifications without storing context.
    expect(h.sendIQ.mock.calls.some(([iq]) => iq.getChild('query', MAM_NS)!.getChild('set', RSM_NS)!.getChildText('after') === rows[40].stanzaId)).toBe(true)
  })

  it.each(['correction', 'retraction'] as const)('applies a separately archived %s beyond the first page without publishing arrivals', async modification => {
    const before = roomStore.getState()
    const h = harness(undefined, undefined, modification)
    const result = await h.mam.readRoomMessagePreview(ROOM, rows[40].stanzaId)
    if (modification === 'correction') expect(result).toMatchObject({ kind: 'found', message: { body: rows[70].body, isEdited: true } })
    else expect(result).toEqual({ kind: 'absent' })
    expect(h.emitSDK).not.toHaveBeenCalled()
    expect(roomStore.getState()).toBe(before)
    expect(await cache.getRoomMessages(ROOM)).toEqual([])
  })

  it.each(['resident', 'cache'] as const)('reads a %s quote and hides it after membership is lost', async source => {
    if (source === 'resident') roomStore.getState().addRoom(room, [rows[40]])
    else await cache.saveRoomMessages([rows[40]])
    const h = harness()
    expect(await h.mam.readRoomMessagePreview(ROOM, rows[40].stanzaId)).toMatchObject({ kind: 'found', message: rows[40] })
    roomStore.getState().addRoom({ ...room, joined: false })
    expect(await h.mam.readRoomMessagePreview(ROOM, rows[40].stanzaId)).toEqual({ kind: 'unknown' })
    expect(h.sendIQ).not.toHaveBeenCalled()
  })

  it('does not confuse a deleted quote with a failed archive request', async () => {
    await cache.saveRoomMessages([{ ...rows[40], isRetracted: true, body: '' }])
    expect(await harness().mam.readRoomMessagePreview(ROOM, rows[40].stanzaId)).toEqual({ kind: 'absent' })
    expect(await harness('network').mam.readRoomMessagePreview(ROOM, rows[41].stanzaId)).toEqual({ kind: 'unknown' })
  })

  it('checks membership before even reading a cached message', async () => {
    await cache.saveRoomMessages([rows[40]])
    roomStore.getState().addRoom({ ...room, joined: false })
    const h = harness()
    expect(await h.mam.locateRoomMessage(ROOM, rows[40].stanzaId!)).toEqual({ kind: 'unknown' })
    expect(h.sendIQ).not.toHaveBeenCalled()
  })

  it.each(['resident', 'cache'] as const)('resolves %s history without querying the archive', async source => {
    if (source === 'resident') roomStore.getState().addRoom(room, [rows[40]])
    else await cache.saveRoomMessages([rows[40]])
    const h = harness()
    expect(await h.mam.locateRoomMessage(ROOM, rows[40].stanzaId!)).toMatchObject({ kind: 'found', message: rows[40], source })
    expect(h.sendIQ).not.toHaveBeenCalled()
    expect(h.emitSDK).not.toHaveBeenCalled()
  })

  it('stores the target plus 25 either side without live arrival, read or coverage changes', async () => {
    await cache.saveRoomMessages([rows.at(-1)!])
    roomStore.getState().addRoom(room, [rows.at(-1)!])
    const before = roomStore.getState()
    const h = harness()
    expect(await h.mam.locateRoomMessage(ROOM, rows[40].stanzaId!)).toMatchObject({ kind: 'found', message: { stanzaId: rows[40].stanzaId }, source: 'archive' })
    const stored = await cache.getRoomMessages(ROOM)
    expect(stored.map(row => row.stanzaId)).toEqual([...rows.slice(15, 66), rows.at(-1)!].map(row => row.stanzaId))
    const after = roomStore.getState()
    expect(after.messages).toBe(before.messages)
    expect(after.roomMeta).toBe(before.roomMeta)
    expect(after.roomCoverage).toBe(before.roomCoverage)
    expect(after.lastArrivedMessage).toBe(before.lastArrivedMessage)
    expect(after.roomGaps.get(ROOM)).toEqual([{ start: +rows[65].timestamp, end: +rows[79].timestamp,
      startId: rows[65].stanzaId, endId: rows[79].stanzaId }])
    expect(h.emitSDK).not.toHaveBeenCalledWith('room:message', expect.anything())
    expect(h.sendIQ.mock.calls.map(([iq]) => Number(iq.getChild('query', MAM_NS)!.getChild('set', RSM_NS)!.getChildText('max')))).toEqual([1, 1, 25, 25])
  })

  // The archive-link caller owns this argument handoff; decryption itself is
  // covered by MAM.e2ee.test.ts. A room kind must not displace the delay Date
  // or the room-assigned archive id when the shared helper contract changes.
  it('passes room kind, delay Date and archive id to context decryption', async () => {
    const h = harness()
    const decrypt = vi.spyOn(h.mam as unknown as {
      decryptArchiveEntryIfNeeded: (message: Element, peer: string, kind: 'chat' | 'room', timestamp?: Date, archiveId?: string) => Promise<boolean>
    }, 'decryptArchiveEntryIfNeeded')
    const target = rows[40]
    expect(await h.mam.locateRoomMessage(ROOM, target.stanzaId)).toMatchObject({ kind: 'found', source: 'archive' })
    const context = decrypt.mock.calls.find(([message]) => message.attrs.id === target.id)
    expect(context).toBeDefined()
    expect(context?.slice(1)).toEqual([ROOM, 'room', target.timestamp, target.stanzaId])
    expect(context?.[3]).toBeInstanceOf(Date)
  })

  it('does not write old room context into an account switched during gap publication', async () => {
    await cache.saveRoomMessages([rows.at(-1)!])
    const h = harness()
    const unsubscribe = roomStore.subscribe(state => {
      if (!state.roomGaps.get(ROOM)?.length) return
      unsubscribe()
      roomStore.getState().reset()
      setStorageScopeJid('carol@example.org')
    })
    try {
      expect(await h.mam.locateRoomMessage(ROOM, rows[40].stanzaId)).toEqual({ kind: 'unknown' })
      expect(await cache.getRoomMessages(ROOM)).toEqual([])
    } finally { unsubscribe() }
  })

  it('reports a purged id as absent, but a failed query as unknown', async () => {
    expect(await harness().mam.locateRoomMessage(ROOM, 'purged-id')).toEqual({ kind: 'absent' })
    expect(await harness('network').mam.locateRoomMessage(ROOM, rows[40].stanzaId!)).toEqual({ kind: 'unknown' })
    expect(await harness('no-fin').mam.locateRoomMessage(ROOM, rows[40].stanzaId!)).toEqual({ kind: 'unknown' })
  })

  it('bridges old room context with each returned backward cursor instead of repeating a page', async () => {
    const h = harness()
    await h.mam.catchUpToTimestamp(ROOM, true, rows[10].timestamp.toISOString())
    const cursors = h.sendIQ.mock.calls.map(([iq]) => iq.getChild('query', MAM_NS)!.getChild('set', RSM_NS)!.getChildText('before'))
    expect(cursors).toEqual(['', rows[55].stanzaId, rows[30].stanzaId])
  })

  it('does not navigate to a retracted cached entry', async () => {
    await cache.saveRoomMessages([{ ...rows[40], isRetracted: true, body: '' }])
    const h = harness()
    expect(await h.mam.locateRoomMessage(ROOM, rows[40].stanzaId!)).toEqual({ kind: 'absent' })
    expect(h.sendIQ).not.toHaveBeenCalled()
  })
})
