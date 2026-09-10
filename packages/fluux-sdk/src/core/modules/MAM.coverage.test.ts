import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import 'fake-indexeddb/auto'
import { IDBFactory } from 'fake-indexeddb'
import { xml, type Element } from '@xmpp/client'
import { MAM } from './MAM'
import type { ModuleDependencies } from './BaseModule'
import { createMockStores } from '../test-utils'
import { createPresenceReader } from '../presenceReader'
import type { SDKEventSource } from '../types/eventSource'
import type { SDKEvents } from '../types/sdk-events'
import type { Message, RoomMessage } from '../types'
import { createStoreBindings, type StoreRefs } from '../../bindings/storeBindings'
import { roomStore, _resetRoomReadStateForTesting } from '../../stores/roomStore'
import { chatStore } from '../../stores/chatStore'
import { connectionStore } from '../../stores/connectionStore'
import { ignoreStore } from '../../stores/ignoreStore'
import { makeReadPointer } from '../../stores/shared/readPointer'
import * as coverageTools from '../../stores/shared/mamCoverage'
import type { CoverageRecord } from '../../stores/shared/mamCoverage'
import { _resetStorageScopeForTesting } from '../../utils/storageScope'
import * as cache from '../../utils/messageCache'
import { MAM_BACKWARD_SIGNAL_RETRY_PAGES } from '../../utils/mamCatchUpUtils'

const NS = 'urn:xmpp:mam:2'
const ROOM = 'room@conference.example.test'
const PEER = 'peer@example.test'
const SELF = 'me@example.test'
type Kind = 'room' | 'chat'
type Entry = { id: string; at: number; body?: string; reaction?: boolean }
type Page = { entries: Entry[]; complete?: boolean }
const first: Entry = { id: 'first', at: 2000, body: 'First message' }
const latest: Entry = { id: 'latest', at: 3000, body: 'Latest message' }
const receipt: Entry = { id: 'receipt', at: 1000 }
let unbind: (() => void) | undefined

beforeEach(() => {
  _resetStorageScopeForTesting()
  cache._resetDBForTesting()
  globalThis.indexedDB = new IDBFactory()
  roomStore.getState().reset()
  _resetRoomReadStateForTesting()
  chatStore.getState().reset()
  connectionStore.setState({ windowVisible: true })
})

afterEach(() => {
  unbind?.()
  vi.restoreAllMocks()
})

function harness(kind: Kind) {
  const id = kind === 'room' ? ROOM : PEER
  const row = (entry: Entry): Message | RoomMessage => {
    const common = { id: entry.id, stanzaId: `archive-${entry.id}`, body: entry.body ?? '',
      timestamp: new Date(entry.at), isOutgoing: false }
    return kind === 'room'
      ? { ...common, type: 'groupchat', roomJid: ROOM, from: `${ROOM}/peer`, nick: 'peer' }
      : { ...common, type: 'chat', conversationId: PEER, from: PEER }
  }
  if (kind === 'room') {
    roomStore.getState().addRoom({ jid: ROOM, name: 'Room', nickname: 'me', joined: true,
      isBookmarked: true, occupants: new Map(), unreadCount: 1, mentionsCount: 0, typingUsers: new Set() })
    roomStore.setState(state => ({ activeRoomJid: ROOM,
      roomMeta: new Map(state.roomMeta).set(ROOM, { ...state.roomMeta.get(ROOM)!,
        unreadCount: 1, readPointer: makeReadPointer(row(first), 'room') }) }))
  } else {
    chatStore.getState().addConversation({ id: PEER, name: 'Peer', type: 'chat', unreadCount: 1 })
    chatStore.setState(state => ({ activeConversationId: PEER,
      conversationMeta: new Map(state.conversationMeta).set(PEER, { ...state.conversationMeta.get(PEER)!,
        unreadCount: 1, readPointer: makeReadPointer(row(first), 'chat') }) }))
  }
  const listeners = new Map<keyof SDKEvents, (payload: never) => void>()
  const source: SDKEventSource = {
    subscribe(event, handler) {
      listeners.set(event, handler as (payload: never) => void)
      return () => { listeners.delete(event) }
    },
  }
  unbind = createStoreBindings(source, () => ({ room: roomStore.getState(), chat: chatStore.getState(),
    ignore: ignoreStore.getState(), console: { addEvent() {} } }) as unknown as StoreRefs)
  const stores = createMockStores()
  stores.room.getRoom.mockImplementation(jid => roomStore.getState().getRoom(jid))
  stores.room.getRoomCoverage.mockImplementation(jid => roomStore.getState().getRoomCoverage(jid))
  stores.chat.getConversationCoverage.mockImplementation(jid => chatStore.getState().getConversationCoverage(jid))
  const collectors = new Map<string, (stanza: Element) => void>()
  let pages: Page[] = []
  const sent: Element[] = []
  const deps: ModuleDependencies = {
    stores, presence: createPresenceReader(), getCurrentJid: () => SELF, getXmpp: () => null,
    getE2EEManager: () => null, sendStanza: async () => {}, emit: () => {},
    emitSDK: (event, payload) => listeners.get(event)?.(payload as never),
    registerMAMCollector: (queryId, collector) => {
      collectors.set(queryId, collector)
      return () => { collectors.delete(queryId) }
    },
    sendIQ: async iq => {
      sent.push(iq)
      const page = pages.shift()
      if (!page) throw new Error('Unexpected archive request')
      const queryId = iq.getChild('query', NS)!.attrs.queryid
      for (const entry of page.entries) {
        collectors.get(queryId)!(xml('message', { from: kind === 'room' ? ROOM : SELF },
          xml('result', { xmlns: NS, queryid: queryId, id: `archive-${entry.id}` },
            xml('forwarded', { xmlns: 'urn:xmpp:forward:0' },
              xml('delay', { xmlns: 'urn:xmpp:delay', stamp: new Date(entry.at).toISOString() }),
              xml('message', { xmlns: 'jabber:client', from: row(entry).from, to: SELF,
                type: kind === 'room' ? 'groupchat' : 'chat', id: entry.id },
              ...(entry.body ? [xml('body', {}, entry.body)]
                : entry.reaction ? [xml('reactions', { xmlns: 'urn:xmpp:reactions:0', id: 'archive-latest' }, xml('reaction', {}, '👍'))]
                : [xml('received', { xmlns: 'urn:xmpp:chat-markers:0', id: 'acknowledged-message' })]))))))
      }
      return xml('iq', { type: 'result' }, xml('fin', { xmlns: NS, complete: String(page.complete ?? false) },
        xml('set', { xmlns: 'http://jabber.org/protocol/rsm' },
          ...(page.entries.length ? [xml('first', {}, `archive-${page.entries[0].id}`),
            xml('last', {}, `archive-${page.entries.at(-1)!.id}`)] : []))))
    },
  }
  const mam = new MAM(deps)
  return {
    id, row, sent,
    coverage: () => kind === 'room' ? roomStore.getState().getRoomCoverage(id) : chatStore.getState().getConversationCoverage(id),
    restoreCoverage(record?: CoverageRecord) {
      const coverage = coverageTools.deserializeCoverage(coverageTools.serializeCoverage(new Map(record ? [[id, record]] : [])))
      if (kind === 'room') roomStore.setState({ roomCoverage: coverage })
      else chatStore.setState({ conversationCoverage: coverage })
    },
    restoreUnread(unreadCount: number) {
      if (kind === 'room') roomStore.setState(state => ({ roomMeta: new Map(state.roomMeta)
        .set(id, { ...state.roomMeta.get(id)!, unreadCount }),
        rooms: new Map(state.rooms).set(id, { ...state.rooms.get(id)!, unreadCount }) }))
      else chatStore.setState(state => ({ conversationMeta: new Map(state.conversationMeta)
        .set(id, { ...state.conversationMeta.get(id)!, unreadCount }) }))
    },
    recount: () => kind === 'room' ? roomStore.getState().recomputeUnreadForRoom(id, { allowActive: true })
      : chatStore.getState().recomputeUnreadForConversation(id, { allowActive: true }),
    count: () => kind === 'room' ? roomStore.getState().getRoom(id)?.unreadCount : chatStore.getState().conversationMeta.get(id)?.unreadCount,
    pointer: () => kind === 'room' ? roomStore.getState().roomMeta.get(id)?.readPointer : chatStore.getState().conversationMeta.get(id)?.readPointer,
    read: (entry: Entry) => kind === 'room' ? roomStore.getState().advanceReadPointer(id, { id: entry.id })
      : chatStore.getState().advanceReadPointer(id, { id: entry.id }),
    async query(nextPages: Page[], options: { before?: string; after?: string; start?: string; preserveGapMarker?: boolean } = { before: '' }) {
      pages = [...nextPages]
      return kind === 'room' ? mam.queryRoomArchive({ roomJid: id, ...options }) : mam.queryArchive({ with: id, ...options })
    },
    async cached(entry: Entry) {
      return kind === 'room' ? cache.getRoomMessageByStanzaId(id, `archive-${entry.id}`)
        : cache.getMessageByStanzaId(id, `archive-${entry.id}`)
    },
  }
}

describe.each(['room', 'chat'] as const)('%s coverage through MAM and durable store bindings', kind => {
  it('clears unread when the first archive entry is a receipt without a cache row', async () => {
    const h = harness(kind)
    const result = await h.query([{ entries: [receipt, first, latest] }])
    expect(result.messages.map(message => message.id)).toEqual(['first', 'latest'])
    await vi.waitFor(() => expect(h.coverage()?.bottomId).toBe('archive-receipt'))
    expect(await h.cached(receipt)).toBeNull()
    expect(await h.cached(first)).not.toBeNull()
    h.read(latest)
    await vi.waitFor(() => expect(h.count()).toBe(0))
    expect(h.pointer()).toEqual(makeReadPointer(h.row(latest), kind))
    expect(h.coverage()?.bottomId).toBe('archive-receipt')
    expect(h.sent).toHaveLength(1)
  })

  it.each([
    { name: 'already discarded coverage', record: undefined },
    { name: 'legacy coverage on a receipt', record: { bottomId: 'archive-receipt', topId: 'archive-latest' } },
    { name: 'a signal-only coverage record', record: { bottomId: 'archive-receipt', countBottomId: null } },
  ])('recovers $name on an empty completed catch-up without advancing the pointer', async ({ record }) => {
    const h = harness(kind)
    await h.query([{ entries: [receipt, first, latest] }])
    await vi.waitFor(() => expect(h.coverage()).toBeDefined())
    h.read(latest)
    await vi.waitFor(() => expect(h.count()).toBe(0))
    const pointer = h.pointer()
    h.restoreCoverage(record)
    h.restoreUnread(1)
    cache._resetDBForTesting()
    await h.query([{ entries: [], complete: true }], { after: 'archive-latest' })
    await vi.waitFor(() => expect(h.count()).toBe(0))
    expect(h.pointer()).toBe(pointer)
    expect(h.sent).toHaveLength(2)
    expect(await h.cached(receipt)).toBeNull()
    expect(h.coverage()?.bottomId).toBe('archive-latest')
  })

  it('retains signal-only pagination across reload and anchors counting when the next walk reaches messages', async () => {
    const h = harness(kind)
    const pages = Array.from({ length: MAM_BACKWARD_SIGNAL_RETRY_PAGES }, (_, index) => ({ entries: [
      { id: `receipt-${MAM_BACKWARD_SIGNAL_RETRY_PAGES - index}`, at: 9000 - index * 1000 },
    ] }))
    const empty = await h.query(pages)
    expect(empty.messages).toEqual([])
    const record = h.coverage()!
    expect(record.bottomId).toBe('archive-receipt-1')
    expect(record.topId).toBe(`archive-receipt-${MAM_BACKWARD_SIGNAL_RETRY_PAGES}`)
    expect(h.count()).toBe(1)
    h.restoreCoverage(record)
    cache._resetDBForTesting()
    await h.query([pages[0], { entries: [first, latest] }])
    const lastQuery = h.sent.at(-1)!.getChild('query', NS)!
    expect(lastQuery.getChild('set', 'http://jabber.org/protocol/rsm')!.getChildText('before')).toBe(record.bottomId)
    h.read(latest)
    await vi.waitFor(() => expect(h.count()).toBe(0))
    expect(h.pointer()).toEqual(makeReadPointer(h.row(latest), kind))
    expect(h.sent).toHaveLength(MAM_BACKWARD_SIGNAL_RETRY_PAGES + 2)
  })

  it('waits for the archive write before certifying the materialized anchor and recounting', async () => {
    const h = harness(kind)
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    if (kind === 'room') {
      const save = cache.saveRoomMessages
      vi.spyOn(cache, 'saveRoomMessages').mockImplementationOnce(async messages => { await gate; return save(messages) })
    } else {
      const save = cache.saveMessages
      vi.spyOn(cache, 'saveMessages').mockImplementationOnce(async messages => { await gate; return save(messages) })
    }
    await h.query([{ entries: [receipt, first, latest] }])
    h.read(latest)
    const pointer = h.pointer()
    await h.recount()
    expect(h.count()).toBe(1)
    expect(h.coverage()).toBeUndefined()
    expect(await h.cached(first)).toBeNull()
    release()
    await vi.waitFor(() => expect(h.count()).toBe(0))
    expect(h.coverage()?.bottomId).toBe('archive-receipt')
    expect(h.pointer()).toBe(pointer)
  })

  it('does not certify a page whose cache write failed', async () => {
    const h = harness(kind)
    if (kind === 'room') vi.spyOn(cache, 'saveRoomMessages').mockResolvedValueOnce(false)
    else vi.spyOn(cache, 'saveMessages').mockResolvedValueOnce(false)
    await h.query([{ entries: [receipt, first, latest], complete: true }], { start: new Date(0).toISOString() })
    h.read(latest)
    await h.recount()
    expect(h.count()).toBe(1)
    expect(h.coverage()).toBeUndefined()
    expect(await h.cached(first)).toBeNull()
    expect(h.pointer()).toEqual(makeReadPointer(h.row(latest), kind))
    expect(h.sent).toHaveLength(1)
  })

  it('does not let a stale anchor lookup discard a newly materialized counting anchor', async () => {
    const h = harness(kind)
    await h.query([{ entries: [receipt, first, latest] }])
    await vi.waitFor(() => expect(h.coverage()).toBeDefined())
    h.read(latest)
    await vi.waitFor(() => expect(h.count()).toBe(0))
    h.restoreCoverage({ bottomId: 'archive-receipt' })
    h.restoreUnread(1)
    let release!: () => void
    let started!: () => void
    const pending = new Promise<void>(resolve => { started = resolve })
    const gate = new Promise<void>(resolve => { release = resolve })
    vi.spyOn(cache, 'resolveArchivePosition').mockImplementationOnce(async () => {
      started()
      await gate
      return null
    })
    const recount = h.recount()
    await pending
    h.restoreCoverage({ bottomId: 'archive-receipt', countBottomId: 'archive-first' })
    release()
    await recount
    expect(h.coverage()?.bottomId).toBe('archive-receipt')
    await vi.waitFor(() => expect(h.count()).toBe(0))
  })

  it.each(['modifications', 'bounded repair'] as const)('does not certify a %s walk without a durability proof', async guard => {
    const h = harness(kind)
    await h.query([{ entries: [receipt, first, latest] }])
    await vi.waitFor(() => expect(h.coverage()).toBeDefined())
    h.read(latest)
    await vi.waitFor(() => expect(h.count()).toBe(0))
    h.restoreCoverage({ bottomId: 'archive-receipt', countBottomId: null })
    h.restoreUnread(1)
    const recovery = vi.spyOn(coverageTools, 'recoverCoverageForCounting')
    await h.query([{ entries: guard === 'modifications' ? [{ id: 'reaction', at: 4000, reaction: true }] : [], complete: true }],
      { after: 'archive-latest', preserveGapMarker: guard === 'bounded repair' })
    await Promise.all(recovery.mock.results.map(result => result.value))
    await h.recount()
    expect(h.coverage()?.bottomId).toBe('archive-receipt')
    expect(h.count()).toBe(1)
    expect(h.sent).toHaveLength(2)
  })

  it('does not use an older cached island to repair coverage short of the read pointer', async () => {
    const h = harness(kind)
    await h.query([{ entries: [receipt, first, latest] }])
    await vi.waitFor(() => expect(h.coverage()).toBeDefined())
    h.restoreCoverage({ bottomId: 'archive-receipt' })
    h.restoreUnread(7)
    const pointer = h.pointer()
    await h.query([{ entries: [], complete: true }], { after: 'archive-latest' })
    await vi.waitFor(() => expect(h.coverage()?.bottomId).toBe('archive-latest'))
    await h.recount()
    expect(h.count()).toBe(7)
    expect(h.pointer()).toBe(pointer)
    expect(await h.cached(first)).not.toBeNull()
    h.read(latest)
    await vi.waitFor(() => expect(h.count()).toBe(0))
  })
})
