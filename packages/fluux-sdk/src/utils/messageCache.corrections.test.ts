import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import 'fake-indexeddb/auto'
import { IDBFactory, IDBIndex, IDBObjectStore } from 'fake-indexeddb'
import { openDB } from 'idb'
import { client as createClient, xml, type Element } from '@xmpp/client'
import { MAM } from '../core/modules/MAM'
import { Chat } from '../core/modules/Chat'
import { Connection } from '../core/modules/Connection'
import { createMockRoom, createMockStores, createMockXmppClient } from '../core/test-utils'
import { createStoreBindings, type StoreRefs } from '../bindings/storeBindings'
import type { ModuleDependencies } from '../core/modules/BaseModule'
import { createPresenceReader } from '../core/presenceReader'
import type { SDKEventSource } from '../core/types/eventSource'
import type { SDKEvents } from '../core/types/sdk-events'
import { captureContentSource, resolveCorrectionUpdates, type StoredMessage, type StoredRoomMessage } from '../core/types/message-internal'
import { chatStore } from '../stores/chatStore'
import { connectionStore } from '../stores/connectionStore'
import { createFetchOlderHistory } from '../hooks/shared/createFetchOlderHistory'
import { roomStore } from '../stores/roomStore'
import { ignoreStore } from '../stores/ignoreStore'
import { DeferredDecryptEngine } from '../core/e2ee/deferredDecrypt'
import { E2EEManager, InMemoryStorageBackend } from '../core/e2ee'
import { DummyPlaintextPlugin } from '../core/e2ee/DummyPlaintextPlugin'
import { dataToElement } from '../core/e2ee/stanzaAdapter'
import { serialize as serializePayload } from '../core/e2ee/payloadEnvelope'
import * as cache from './messageCache'
import { _resetStorageScopeForTesting, setStorageScopeJid } from './storageScope'
import * as retractionStorage from '../stores/shared/retractionStorage'
import { _clearRetractedIdentitiesForTesting } from './retractedIdentities'
import * as searchIndex from './searchIndex'

vi.mock('@xmpp/client', async importOriginal => ({
  ...await importOriginal<typeof import('@xmpp/client')>(),
  client: vi.fn(),
}))

const PEER = 'peer@example.test'
const SELF = 'me@example.test'
const ROOM = 'room@conference.example.test'
const T0 = '2026-09-01T10:00:00.000Z'
const T1 = '2026-09-01T10:01:00.000Z'
const T2 = '2026-09-01T10:02:00.000Z'
const FAST = '2026-09-01T10:05:00.000Z'
type Kind = 'chat' | 'room'
type Row = StoredMessage | StoredRoomMessage
type Edit = { encrypted?: boolean; oobUrl?: string; to?: string; id: string; body: string; at?: string; authoredAt?: string; from?: string; occupantId?: string; locked?: boolean; stanzaIdBy?: string; omitStanzaId?: boolean; archiveId?: string; targetId?: string; omitOriginId?: boolean; stanzaId?: string; extraStanzaIds?: Array<{ id: string; by: string }> }
const writes: Promise<unknown>[] = []
let unbind: () => void

function original(kind: Kind, own = false): Row {
  const common = { id: 'original', stanzaId: 'archive-original', body: 'original text', timestamp: new Date(T0), isOutgoing: own }
  return kind === 'chat'
    ? { ...common, type: 'chat', conversationId: PEER, from: own ? SELF : PEER }
    : { ...common, type: 'groupchat', roomJid: ROOM, from: `${ROOM}/Peer`, nick: 'Peer', occupantId: 'peer-occupant' }
}

function seed(kind: Kind, rows: Row[]) {
  if (kind === 'chat') chatStore.setState({ messages: new Map([[PEER, rows as StoredMessage[]]]) })
  else roomStore.setState({ messages: new Map([[ROOM, rows as StoredRoomMessage[]]]) })
}

function resident(kind: Kind): Row | undefined {
  return (kind === 'chat' ? chatStore.getState().getMessage(PEER, 'original') : roomStore.getState().getMessage(ROOM, 'original')) as Row | undefined
}

async function drain() {
  let cursor = 0
  while (cursor < writes.length) {
    const batch = writes.slice(cursor)
    cursor = writes.length
    await Promise.all(batch)
  }
}

async function save(kind: Kind, ...messages: Row[]) {
  if (kind === 'chat') await cache.saveMessages(messages as StoredMessage[])
  else await cache.saveRoomMessages(messages as StoredRoomMessage[])
}

async function reload(kind: Kind): Promise<Row> {
  await drain()
  seed(kind, [])
  cache._resetDBForTesting()
  const messages = kind === 'chat' ? await cache.getMessages(PEER) : await cache.getRoomMessages(ROOM, {})
  expect(messages).toHaveLength(1)
  seed(kind, messages)
  return messages[0] as Row
}

function harness(kind: Kind, own = false, originalFields: Partial<Row> = {}) {
  const listeners = new Map<keyof SDKEvents, (payload: never) => void>()
  const source: SDKEventSource = {
    subscribe(event, handler) {
      listeners.set(event, handler as (payload: never) => void)
      return () => { listeners.delete(event) }
    },
  }
  const historyRows: Row[][] = []
  const events: Array<{ event: keyof SDKEvents; payload: unknown }> = []
  const emitSDK: ModuleDependencies['emitSDK'] = (event, payload) => {
    events.push({ event, payload })
    if (event === 'chat:history-messages' || event === 'room:history-messages') historyRows.push(structuredClone((payload as { messages: Row[] }).messages))
    listeners.get(event)?.(payload as never)
  }
  unbind?.()
  unbind = createStoreBindings(source, () => ({
    chat: chatStore.getState(), room: roomStore.getState(), ignore: ignoreStore.getState(), console: { addEvent() {} },
  }) as unknown as StoreRefs)
  const stores = createMockStores()
  stores.chat.resolveCorrectionReferences.mockImplementation((...args) => chatStore.getState().resolveCorrectionReferences(...args))
  stores.room.resolveCorrectionReferences.mockImplementation((...args) => roomStore.getState().resolveCorrectionReferences(...args))
  stores.chat.reconcileHistoryMessages.mockImplementation(messages => chatStore.getState().reconcileHistoryMessages(messages))
  stores.room.reconcileHistoryMessages.mockImplementation(messages => roomStore.getState().reconcileHistoryMessages(messages))
  stores.chat.refreshLastMessageContent.mockImplementation((...args) => chatStore.getState().refreshLastMessageContent(...args))
  stores.chat.getEncryptedPreviews.mockImplementation(() => Array.from(chatStore.getState().conversationMeta).flatMap(([conversationId, meta]) =>
    meta.lastMessage?.encryptedPayload ? [{ conversationId, lastMessage: meta.lastMessage }] : []))
  stores.chat.getMessage.mockImplementation((id, ref) => chatStore.getState().getMessage(id, ref))
  stores.room.getMessage.mockImplementation((id, ref) => roomStore.getState().getMessage(id, ref))
  stores.room.getRoom.mockImplementation(id => roomStore.getState().rooms.get(id))
  stores.chat.updateMessage.mockImplementation((...args) => chatStore.getState().updateMessage(...args))
  stores.room.updateMessage.mockImplementation((...args) => roomStore.getState().updateMessage(...args))
  stores.chat.getAllStoredMessages.mockImplementation(() => Array.from(chatStore.getState().messages, ([id, messages]) => ({ id, messages })))
  stores.room.getAllRoomMessages.mockImplementation(() => Array.from(roomStore.getState().messages, ([jid, messages]) => ({ jid, messages })))
  const collectors = new Map<string, (stanza: Element) => void>()
  let page: Edit[] = []
  let includeOriginal = false
  let signals: Element[] = []
  let signalsFirst = false
  let searchComplete: boolean | undefined
  let remainingPages: Array<{ edits: Edit[]; original?: boolean; signals?: Element[] }> = []
  const sent: Element[] = []
  const base = { ...original(kind, own), ...originalFields }
  const archiveBy = kind === 'room' ? ROOM : SELF
  const stanza = (entry: Edit) => {
    const message = xml('message', { id: entry.id, from: entry.from ?? base.from, to: entry.to ?? SELF, type: base.type },
      xml('body', {}, entry.encrypted ? 'encrypted fallback' : entry.body),
      ...(entry.encrypted ? [xml('plain', { xmlns: 'urn:fluux:e2ee-dummy:0' }, Buffer.from(entry.body).toString('base64'))] : []),
      ...(entry.oobUrl ? [xml('x', { xmlns: 'jabber:x:oob' }, xml('url', {}, entry.oobUrl))] : []),
      xml('replace', { xmlns: 'urn:xmpp:message-correct:0', id: entry.targetId ?? base.id }),
      ...(entry.omitOriginId ? [] : [xml('origin-id', { xmlns: 'urn:xmpp:sid:0', id: entry.id })]),
      ...(entry.omitStanzaId ? [] : [xml('stanza-id', { xmlns: 'urn:xmpp:sid:0', by: entry.stanzaIdBy ?? archiveBy, id: entry.stanzaId ?? `sid-${entry.id}` })]),
      ...(entry.extraStanzaIds ?? []).map(attrs => xml('stanza-id', { xmlns: 'urn:xmpp:sid:0', ...attrs })),
      ...(kind === 'room' ? [xml('occupant-id', { xmlns: 'urn:xmpp:occupant-id:0', id: entry.occupantId ?? 'peer-occupant' })] : []),
      ...(entry.at ? [xml('delay', { xmlns: 'urn:xmpp:delay', stamp: entry.at })] : []))
    if (entry.authoredAt) Object.assign(message, { __authoredAt: new Date(entry.authoredAt) })
    if (entry.locked) Object.assign(message, { __encryptedPayload: xml('message', { from: entry.from ?? base.from },
      xml('body', {}, entry.body), xml('plain', { xmlns: 'urn:fluux:e2ee-dummy:0' }, 'cmVjb3ZlcmVk')).toString() })
    return message
  }
  const deps: ModuleDependencies = {
    stores, presence: createPresenceReader(), getCurrentJid: () => SELF, getXmpp: () => null,
    sendStanza: async s => { sent.push(s) }, emit: () => {}, emitSDK,
    registerMAMCollector: (id, collector) => { collectors.set(id, collector); return () => { collectors.delete(id) } },
    sendIQ: async iq => {
      const nextPage = remainingPages.shift()
      if (nextPage) { page = nextPage.edits; includeOriginal = !!nextPage.original; signals = nextPage.signals ?? [] }
      const queryId = iq.getChild('query', 'urn:xmpp:mam:2')?.attrs.queryid
      const collector = queryId && collectors.get(queryId)
      if (!collector) throw new Error('MAM collector missing')
      const entries = page.map(entry => ({ message: stanza(entry), at: entry.at, id: entry.archiveId ?? entry.stanzaId ?? `sid-${entry.id}` }))
      if (includeOriginal) entries.unshift({ message: xml('message', { id: base.id, from: base.from, to: SELF, type: base.type },
        xml('body', {}, base.body), xml('stanza-id', { xmlns: 'urn:xmpp:sid:0', by: archiveBy, id: base.stanzaId! }),
        ...(kind === 'room' ? [xml('occupant-id', { xmlns: 'urn:xmpp:occupant-id:0', id: 'peer-occupant' })] : [])), at: T0, id: base.stanzaId! })
      const signalEntries = signals.map((message, i) => ({ message, at: T2, id: `signal-${i}` }))
      if (signalsFirst) entries.unshift(...signalEntries)
      else entries.push(...signalEntries)
      for (const entry of entries) collector(xml('message', {}, xml('result', { xmlns: 'urn:xmpp:mam:2', queryid: queryId, id: entry.id },
        xml('forwarded', { xmlns: 'urn:xmpp:forward:0' },
          ...(entry.at ? [xml('delay', { xmlns: 'urn:xmpp:delay', stamp: entry.at })] : []), entry.message))))
      return xml('iq', { type: 'result' }, xml('fin', { xmlns: 'urn:xmpp:mam:2', complete: searchComplete === false || remainingPages.length ? 'false' : 'true' },
        xml('set', { xmlns: 'http://jabber.org/protocol/rsm' }, xml('first', {}, entries[0]?.id ?? ''), xml('last', {}, entries.at(-1)?.id ?? ''))))
    },
  }
  const mam = new MAM(deps)
  const chat = new Chat(deps, mam)
  return {
    stores, sent, historyRows, events, deps, chat, mam, stanza,
    async archivePages(pages: Array<{ edits: Edit[]; original?: boolean; signals?: Element[] }>, forward: boolean) {
      remainingPages = [...pages]
      const options = forward ? { start: T0, maxAutoPages: pages.length } : {}
      const result = kind === 'chat' ? await mam.queryArchive({ with: PEER, ...options }) : await mam.queryRoomArchive({ roomJid: ROOM, ...options })
      await drain()
      return result.messages as Row[]
    },
    async context(edits: Edit[]) {
      page = edits; includeOriginal = true
      const result = await mam.fetchContext(kind === 'chat' ? PEER : ROOM, kind === 'room', T0, 2)
      await drain()
      return result.messages as Row[]
    },
    async archive(edits: Edit[], withOriginal = false, extraSignals: Element[] = []) {
      page = edits; includeOriginal = withOriginal; signals = extraSignals
      const result = kind === 'chat' ? await mam.queryArchive({ with: PEER }) : await mam.queryRoomArchive({ roomJid: ROOM })
      await drain()
      return result.messages as Row[]
    },
    async search(edits: Edit[], withOriginal = true, extraSignals: Element[] = [], prependSignals = false, query = 'text') {
      page = edits; includeOriginal = withOriginal; signals = extraSignals; signalsFirst = prependSignals
      const result = kind === 'chat' ? await mam.searchArchive({ query, with: PEER }) : await mam.searchRoomArchive({ query, roomJid: ROOM })
      await drain()
      return result.messages as Row[]
    },
    async searchResult(query: string, options: { global?: boolean; before?: string; complete?: boolean; signals?: Element[]; withOriginal?: boolean; paging?: boolean } = {}) {
      page = []; includeOriginal = options.withOriginal ?? true; signals = options.signals ?? []; searchComplete = options.complete
      const result = options.paging
        ? await mam.searchConversationByPaging({ query, with: PEER, maxPages: 1 })
        : kind === 'chat'
          ? await mam.searchArchive({ query, ...(options.global ? {} : { with: PEER }), before: options.before })
          : await mam.searchRoomArchive({ query, roomJid: ROOM, before: options.before })
      await drain()
      return result
    },
    receive(edit: Edit) { chat.handle(stanza(edit)) },
    async live(edit: Edit) { chat.handle(stanza(edit)); await drain() },
    async carbon(edit: Edit & { at: string }) {
      chat.handle(xml('message', {}, xml('received', { xmlns: 'urn:xmpp:carbons:2' }, xml('forwarded', { xmlns: 'urn:xmpp:forward:0' },
        xml('delay', { xmlns: 'urn:xmpp:delay', stamp: edit.at }), stanza({ ...edit, at: undefined })))))
      await drain()
    },
    async outgoing(body: string, attachment?: Row['attachment']) { await chat.sendCorrection(kind === 'chat' ? PEER : ROOM, base.id, body, attachment); await drain(); return sent.at(-1)!.attrs.id },
    emitSDK,
  }
}

beforeEach(() => {
  cache._resetDBForTesting(); searchIndex._resetDBForTesting(); _resetStorageScopeForTesting(); _clearRetractedIdentitiesForTesting()
  globalThis.indexedDB = new IDBFactory()
  chatStore.getState().reset(); roomStore.getState().reset()
  chatStore.getState().addConversation({ id: PEER, name: 'Peer', type: 'chat', unreadCount: 0 })
  roomStore.getState().addRoom(createMockRoom(ROOM, { nickname: 'Peer', joined: true }))
  writes.length = 0
  const track = <A extends unknown[], R>(implementation: (...args: A) => Promise<R>, settle = false) => (...args: A) => {
    const promise = implementation(...args)
    writes.push(settle ? promise.catch(() => {}) : promise)
    return promise
  }
  const updateSearch = searchIndex.updateMessage
  const indexMessage = searchIndex.indexMessage
  const indexMessages = searchIndex.indexMessages
  const retractions = { ...retractionStorage }
  vi.spyOn(searchIndex, 'updateMessage').mockImplementation(track(updateSearch, true))
  vi.spyOn(searchIndex, 'indexMessage').mockImplementation(track(indexMessage, true))
  vi.spyOn(searchIndex, 'indexMessages').mockImplementation(track(indexMessages, true))
  vi.spyOn(retractionStorage, 'retractUnresidentChatTarget').mockImplementation(track(retractions.retractUnresidentChatTarget))
  vi.spyOn(retractionStorage, 'retractUnresidentRoomTarget').mockImplementation(track(retractions.retractUnresidentRoomTarget))
  vi.spyOn(retractionStorage, 'retractChatMessageInStorage').mockImplementation(track(retractions.retractChatMessageInStorage))
  vi.spyOn(retractionStorage, 'retractRoomMessageInStorage').mockImplementation(track(retractions.retractRoomMessageInStorage))
  const implementations = { ...cache }
  vi.spyOn(cache, 'saveMessages').mockImplementation(track(implementations.saveMessages))
  vi.spyOn(cache, 'saveRoomMessages').mockImplementation(track(implementations.saveRoomMessages))
  vi.spyOn(cache, 'updateMessage').mockImplementation(track(implementations.updateMessage))
  vi.spyOn(cache, 'updateRoomMessage').mockImplementation(track(implementations.updateRoomMessage))
  vi.spyOn(cache, 'applyChatCorrection').mockImplementation(track(implementations.applyChatCorrection))
  vi.spyOn(cache, 'applyRoomCorrection').mockImplementation(track(implementations.applyRoomCorrection))
})
afterEach(async () => {
  try { await drain() } finally {
    await searchIndex.closeSearchIndex(); unbind?.(); vi.useRealTimers(); vi.restoreAllMocks(); cache._resetDBForTesting()
  }
})

function permutations<T>(items: T[]): T[][] {
  return items.length ? items.flatMap((item, index) => permutations(items.filter((_, i) => i !== index)).map(rest => [item, ...rest])) : [[]]
}

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>(done => { resolve = done })
  return { promise, resolve }
}

async function blockedDecrypt(body = 'stale recovered text') {
  const manager = new E2EEManager({ storage: new InMemoryStorageBackend(), account: { jid: SELF }, xmpp: {
    sendStanza: async () => {}, queryDisco: async () => ({ features: [], identities: [] }),
    publishPEP: async () => {}, retractPEP: async () => {}, deletePEP: async () => {}, queryPEP: async () => [], subscribePEP: () => ({ unsubscribe() {} }),
  } })
  await manager.register(new DummyPlaintextPlugin())
  const started = deferred()
  const release = deferred()
  vi.spyOn(manager, 'decryptArchive').mockImplementation(async () => {
    started.resolve()
    await release.promise
    return { plaintext: new TextEncoder().encode(body), senderDevice: { jid: PEER, deviceId: 'test' }, securityContext: { protocolId: 'dummy-plaintext', trust: 'verified' as const }, authoredAt: new Date(FAST) }
  })
  return { manager, started, release }
}


describe.each<Kind>(['chat', 'room'])('%s live correction archive ownership', kind => {
  it.each([false, true].flatMap(cachedOnly => [false, true].map(omitOriginId => ({ cachedOnly, omitOriginId }))))('retains current live text after foreign-ID replay, cache-only: $cachedOnly, omitted origin: $omitOriginId', async ({ cachedOnly, omitOriginId }) => {
    const h = harness(kind)
    const base = original(kind)
    await save(kind, base); seedPreview(kind, base)
    seed(kind, cachedOnly ? [] : [base])
    const first: Edit = { id: 'c1', body: 'first superseded caption', stanzaId: 'foreign-c1', stanzaIdBy: 'foreign.example.test', omitOriginId }
    const second: Edit = { id: 'c2', body: 'current live caption', stanzaId: 'foreign-c2', stanzaIdBy: 'foreign.example.test', omitOriginId }
    await h.live(first); await h.live(second)
    const current = await reload(kind)
    expect(current.body).toBe(second.body)
    if (cachedOnly) seed(kind, [])
    const oldArchive = { ...first, at: T1, archiveId: 'archive-c1' }
    expect((await h.search([oldArchive], true, [], false, second.body))[0].body).toBe(second.body)
    await h.archive([oldArchive], !cachedOnly)
    expect(preview(kind)?.body).toBe(second.body)
    expect(await reload(kind)).toMatchObject({ body: second.body, timestamp: base.timestamp, stanzaId: base.stanzaId })
    expect(await searchIndex.search('superseded')).toHaveLength(0)
    expect(await searchIndex.search('current')).toHaveLength(1)
    if (kind === 'chat') await h.carbon({ ...first, at: T1 })
    else await h.live({ ...first, at: T1 })
    expect((await reload(kind)).body).toBe(second.body)
    await h.archive([{ ...second, at: T2, archiveId: 'archive-c2' }])
    const enriched = await reload(kind)
    expect(enriched.body).toBe(second.body)
    expect(enriched.correctionRevision?.ids).toContain('stanza:archive-c2')
    expect(enriched.correctionRevision?.ids).not.toContain('stanza:foreign-c2')
    expect(enriched.correctionStanzaIds).toEqual(expect.arrayContaining(['foreign-c1', 'foreign-c2', 'archive-c1', 'archive-c2']))
    await h.live({ id: 'c3', body: 'new live progress', stanzaId: 'foreign-c3', stanzaIdBy: 'foreign.example.test' })
    await h.archive([oldArchive], true)
    expect((await reload(kind)).body).toBe('new live progress')
    expect(preview(kind)?.body).toBe('new live progress')
    expect(await searchIndex.search('progress')).toHaveLength(1)
  })
})


describe.each<Kind>(['chat', 'room'])('%s intrinsic archive correction references', kind => {
  it.each([false, true].flatMap(forward => [false, true].flatMap(split => [false, true].map(reverseBody => ({ forward, split, reverseBody })))))(
    'orders an archive-result target, forward: $forward, split: $split, reverse body: $reverseBody', async ({ forward, split, reverseBody }) => {
      const h = harness(kind)
      const base = original(kind)
      await save(kind, base); seedPreview(kind, base)
      expect(resident(kind)).toBeUndefined()
      const first: Edit = { id: 'c1', body: reverseBody ? 'zulu' : 'alpha', at: T1, stanzaId: 'foreign-c1', stanzaIdBy: 'foreign.example.test', archiveId: 'archive-c1' }
      const second: Edit = { id: 'c2', body: reverseBody ? 'alpha' : 'zulu', at: T1, targetId: 'archive-c1', stanzaId: 'foreign-c2', stanzaIdBy: 'foreign.example.test', archiveId: 'archive-c2', ...(kind === 'room' && { from: `${ROOM}/Renamed` }) }
      const pages = split ? (forward ? [first, second] : [second, first]).map(edit => ({ edits: [edit] })) : [{ edits: [first, second] }]
      await h.archivePages(pages, forward)
      expect(preview(kind)?.body).toBe(second.body)
      if (kind === 'room') expect(roomStore.getState().rooms.get(ROOM)?.lastMessage).toEqual(preview(kind))
      const held = await reload(kind)
      expect(held).toMatchObject({ body: second.body, id: base.id, stanzaId: base.stanzaId, timestamp: base.timestamp })
      expect(held.correctionRevision?.ids).toContain('stanza:archive-c2')
      expect(held.correctionRevision?.ids).not.toContain('stanza:foreign-c2')
      expect(held.correctionRevision?.supersedes).toContain('stanza:archive-c1')
      expect(held.correctionStanzaIds).toEqual(expect.arrayContaining(['foreign-c1', 'archive-c1', 'foreign-c2', 'archive-c2']))
      expect(await searchIndex.search(first.body)).toHaveLength(0)
      expect(await searchIndex.search(second.body)).toHaveLength(1)
      expect((await h.search([first], true, [], false, second.body))[0].body).toBe(second.body)
      await h.archive([first], true)
      expect((await reload(kind)).body).toBe(second.body)
      searchIndex._resetDBForTesting()
      expect(await searchIndex.search(second.body)).toHaveLength(1)
      await h.archive([{ id: 'c3', body: 'latest progress', at: T2, targetId: 'archive-c2' }])
      await h.archive([first, second], true)
      expect((await reload(kind)).body).toBe('latest progress')
      expect(preview(kind)?.body).toBe('latest progress')
      expect(await searchIndex.search(second.body)).toHaveLength(0)
      expect(await searchIndex.search('progress')).toHaveLength(1)
    })
})


describe.each<Kind>(['chat', 'room'])('%s account switch after modification resolution', kind => {
  it.each(['backward', 'forward', 'search'].flatMap(method => [false, true].flatMap(roundTrip => ['correction', 'retraction', 'original'].map(payload => ({ method, roundTrip, payload })))))(
    'abandons $payload before effects, method: $method, round trip: $roundTrip', async ({ method, roundTrip, payload }) => {
      const base = original(kind)
      const other = { ...base, body: 'second account content' }
      setStorageScopeJid('second@example.test')
      await save(kind, other); await searchIndex.indexMessage(other)
      setStorageScopeJid(SELF)
      await save(kind, base); await searchIndex.indexMessage(base)
      const h = harness(kind)
      seed(kind, [])
      const replacement = roundTrip ? base : other
      let eventsAtSwitch: number | undefined
      const switchAccount = () => {
        setStorageScopeJid('second@example.test')
        chatStore.getState().switchAccount('second@example.test'); roomStore.getState().switchAccount('second@example.test')
        if (roundTrip) {
          setStorageScopeJid(SELF)
          chatStore.getState().switchAccount(SELF); roomStore.getState().switchAccount(SELF)
        }
        chatStore.getState().addConversation({ id: PEER, name: 'Peer', type: 'chat', unreadCount: 0 })
        roomStore.getState().addRoom(createMockRoom(ROOM, { nickname: 'Peer', joined: true }))
        seed(kind, [replacement]); seedPreview(kind, replacement)
        eventsAtSwitch = h.events.length
      }
      const scheduleSwitch = () => queueMicrotask(() => queueMicrotask(switchAccount))
      if (payload === 'correction') {
        if (kind === 'chat') h.stores.chat.resolveCorrectionReferences.mockImplementationOnce(async (...args) => {
          const resolved = await chatStore.getState().resolveCorrectionReferences(...args)
          scheduleSwitch()
          return resolved
        })
        else h.stores.room.resolveCorrectionReferences.mockImplementationOnce(async (...args) => {
          const resolved = await roomStore.getState().resolveCorrectionReferences(...args)
          scheduleSwitch()
          return resolved
        })
      } else h.deps.getE2EEManager = () => { scheduleSwitch(); return null }
      const edits: Edit[] = payload === 'correction' ? [{ id: 'c1', body: 'first account private correction', at: T1 }] : []
      const signals = payload === 'retraction' ? [xml('message', { from: base.from, type: base.type },
        xml('retract', { xmlns: 'urn:xmpp:message-retract:1', id: base.stanzaId! }),
        ...(kind === 'room' ? [xml('occupant-id', { xmlns: 'urn:xmpp:occupant-id:0', id: 'peer-occupant' })] : []))] : []
      const work = method === 'search' ? h.search(edits, payload === 'original', signals)
        : h.archivePages([{ edits, original: payload === 'original', signals }], method === 'forward')
      await expect(work).rejects.toMatchObject({ name: 'AbortError' })
      await drain()
      expect(eventsAtSwitch).toBeDefined()
      expect(resident(kind)).toMatchObject(replacement)
      expect(resident(kind)?.isRetracted).not.toBe(true)
      expect(preview(kind)).toMatchObject(replacement)
      expect(preview(kind)?.isRetracted).not.toBe(true)
      if (kind === 'room') expect(roomStore.getState().rooms.get(ROOM)?.lastMessage).toEqual(preview(kind))
      expect(h.events.slice(eventsAtSwitch)).toEqual([])
      expect(h.stores.chat.reconcileHistoryMessages).not.toHaveBeenCalled()
      expect(h.stores.room.reconcileHistoryMessages).not.toHaveBeenCalled()
      for (const [scope, expected] of [[SELF, base], ['second@example.test', other]] as const) {
        setStorageScopeJid(scope)
        cache._resetDBForTesting(); searchIndex._resetDBForTesting()
        const rows = kind === 'chat' ? await cache.getMessages(PEER) : await cache.getRoomMessages(ROOM, {})
        expect(rows).toHaveLength(1)
        expect(rows[0]).toMatchObject(expected)
        expect(rows[0].isRetracted).not.toBe(true)
        expect(await searchIndex.search('private')).toHaveLength(0)
        expect(await searchIndex.search(scope === SELF ? 'original' : 'second')).toHaveLength(1)
      }
    })
})


async function abortCorrectionWrite(kind: Kind, mutate: () => void) {
  const put = IDBObjectStore.prototype.put
  const storeName = kind === 'chat' ? 'messages-canonical' : 'room-messages-canonical'
  let aborted = false
  const fault = vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(function (this: IDBObjectStore, ...args) {
    const request = put.apply(this, args)
    if (this.name === storeName && !aborted) {
      request.addEventListener('success', () => { aborted = true; this.transaction.abort() })
    }
    return request
  })
  const offset = writes.length
  try {
    mutate()
    const pending = writes.slice(offset)
    for (let i = offset; i < writes.length; i++) writes[i] = writes[i].catch(() => {})
    const results = await Promise.allSettled(pending)
    await drain()
    expect(aborted).toBe(true)
    expect(results).toEqual(expect.arrayContaining([expect.objectContaining({ status: 'rejected', reason: expect.objectContaining({ name: 'AbortError' }) })]))
  } finally { fault.mockRestore() }
}


describe.each<Kind>(['chat', 'room'])('%s correction persistence retry', kind => {
  const read = () => kind === 'chat' ? cache.getMessages(PEER) : cache.getRoomMessages(ROOM, {})
  const retryModes = kind === 'chat' ? ['mam', 'live', 'carbon'] : ['mam', 'live']

  it.each(retryModes.flatMap(mode => ['text', 'empty caption', 'ciphertext'].map(content => ({ mode, content }))))(
    'repairs an aborted write through $mode with $content', async ({ mode, content }) => {
      const h = harness(kind)
      const base = original(kind)
      await save(kind, base); seed(kind, [base]); seedPreview(kind, base); await searchIndex.indexMessage(base)
      const edit: Edit = { id: 'c1', body: content === 'empty caption' ? 'https://files.example.test/image.png' : 'replacement caption',
        ...(content === 'empty caption' && { oobUrl: 'https://files.example.test/image.png' }), ...(content === 'ciphertext' && { locked: true }) }
      await abortCorrectionWrite(kind, () => h.receive(edit))
      const current = structuredClone(resident(kind)!)
      expect(current.isEdited).toBe(true)
      expect(current.body).toBe(content === 'empty caption' ? '' : edit.body)
      expect((await read())[0].body).toBe(base.body)
      expect(await searchIndex.search('original')).toHaveLength(1)
      const replay = { ...edit, ...(mode !== 'live' && { at: T1 }) }
      if (mode === 'mam') await h.archivePages([{ edits: [replay] }], true)
      else if (mode === 'carbon') await h.carbon({ ...replay, at: T1 })
      else await h.live(replay)
      expect(resident(kind)?.body).toBe(current.body)
      expect(preview(kind)?.body).toBe(current.body)
      if (kind === 'room') expect(roomStore.getState().rooms.get(ROOM)?.lastMessage).toEqual(preview(kind))
      const repaired = (await read())[0] as Row
      expect(repaired).toMatchObject({ body: current.body, isEdited: true, timestamp: base.timestamp, stanzaId: base.stanzaId })
      expect(repaired.encryptedPayload).toBe(current.encryptedPayload)
      expect(repaired.correctionRevision?.supersedes).toEqual([])
      expect(repaired.liveCorrection).toBeUndefined()
      const writer = kind === 'chat' ? vi.mocked(cache.applyChatCorrection) : vi.mocked(cache.applyRoomCorrection)
      expect(writer.mock.calls.at(-1)?.[2].liveCorrection).not.toBe(true)
      expect(await searchIndex.search('original')).toHaveLength(0)
      expect(await searchIndex.search('replacement')).toHaveLength(content === 'empty caption' ? 0 : 1)
      expect((await reload(kind)).body).toBe(current.body)
      searchIndex._resetDBForTesting()
      expect(await searchIndex.search('original')).toHaveLength(0)
    })

  it.each(retryModes.flatMap(mode => [false, true].map(cacheHasC1 => ({ mode, cacheHasC1 }))))(
    'keeps C2 resident while resolving older $mode replay against cache C1: $cacheHasC1', async ({ mode, cacheHasC1 }) => {
      const h = harness(kind)
      const base = original(kind)
      await save(kind, base); seed(kind, [base]); seedPreview(kind, base); await searchIndex.indexMessage(base)
      const c1: Edit = { id: 'c1', body: 'first caption' }
      if (cacheHasC1) await h.live(c1)
      else await abortCorrectionWrite(kind, () => h.receive(c1))
      await abortCorrectionWrite(kind, () => h.receive({ id: 'c2', body: 'second caption' }))
      const current = structuredClone(resident(kind)!)
      expect(current.body).toBe('second caption')
      expect((await read())[0].body).toBe(cacheHasC1 ? c1.body : base.body)
      if (mode === 'mam') await h.archivePages([{ edits: [{ ...c1, at: T1 }] }], true)
      else if (mode === 'carbon') await h.carbon({ ...c1, at: T1 })
      else await h.live(c1)
      expect(resident(kind)?.body).toBe(current.body)
      expect(preview(kind)?.body).toBe(current.body)
      const repaired = (await read())[0] as Row
      expect(repaired.body).toBe(c1.body)
      expect(repaired.correctionRevision?.ids).toContain('stanza:sid-c1')
      expect(repaired.correctionRevision?.supersedes).not.toContain('stanza:sid-c2')
      expect(await searchIndex.search('first')).toHaveLength(1)
      expect(await searchIndex.search('original')).toHaveLength(0)
      await h.archivePages([{ edits: [{ id: 'c2', body: current.body, at: T2 }] }], true)
      expect((await reload(kind)).body).toBe(current.body)
      expect(await searchIndex.search('first')).toHaveLength(0)
      expect(await searchIndex.search('second')).toHaveLength(1)
    })

  it('does not grant a known live replay authority over a newer durable revision', async () => {
    const h = harness(kind)
    const base = original(kind)
    await save(kind, base); seed(kind, [base]); seedPreview(kind, base)
    const c1: Edit = { id: 'c1', body: 'first caption' }
    await abortCorrectionWrite(kind, () => h.receive(c1))
    const durable: Row = { ...base, body: 'newer durable caption', isEdited: true,
      correctionRevision: { ids: ['stanza:sid-c2'], supersedes: [], archiveTimestamp: Date.parse(T2) } }
    await save(kind, durable)
    await h.live(c1)
    expect((await read())[0].body).toBe(durable.body)
    expect(await searchIndex.search('newer')).toHaveLength(1)
    expect(await searchIndex.search('first')).toHaveLength(0)
  })
})


describe.each<Kind>(['chat', 'room'])('%s queried retraction handoff', kind => {
  it.each([false, true].flatMap(forward => ['canonical', 'new alias', 'existing alias', 'cross-page alias', 'foreign author'].map(target => ({ forward, target }))))('tombstones queried duplicates, forward: $forward, target: $target', async ({ forward, target }) => {
    const h = harness(kind)
    const base = original(kind)
    await save(kind, base); seed(kind, [base]); seedPreview(kind, base)
    await searchIndex.indexMessage(base)
    if (target === 'existing alias') await h.live({ id: 'c0', body: 'existing caption' })
    const correction: Edit = { id: 'c1', body: 'corrected caption', at: T1 }
    const targetId = target === 'canonical' ? base.stanzaId! : target === 'existing alias' ? 'sid-c0' : 'sid-c1'
    const foreign = target === 'foreign author'
    const signal = xml('message', { from: foreign && kind === 'chat' ? 'foreign@example.test' : base.from, type: base.type, id: 'retract' },
      xml('retract', { xmlns: 'urn:xmpp:message-retract:1', id: targetId }),
      ...(kind === 'room' ? [xml('occupant-id', { xmlns: 'urn:xmpp:occupant-id:0', id: foreign ? 'foreign-occupant' : 'peer-occupant' })] : []))
    const pages = target === 'cross-page alias'
      ? forward ? [{ edits: [correction], original: true }, { edits: [], signals: [signal] }]
        : [{ edits: [], signals: [signal] }, { edits: [correction], original: true }]
      : [{ edits: [correction], original: true, signals: [signal] }]
    for (let replay = 0; replay < 2; replay++) {
      await h.archivePages(pages, forward)
      expect(resident(kind)?.isRetracted === true).toBe(!foreign)
      expect(preview(kind)?.isRetracted === true).toBe(!foreign)
      if (kind === 'room') expect(roomStore.getState().rooms.get(ROOM)?.lastMessage).toEqual(preview(kind))
      const durable = (kind === 'chat' ? await cache.getMessages(PEER) : await cache.getRoomMessages(ROOM, {}))[0]
      expect(durable.isRetracted === true).toBe(!foreign)
      expect(await searchIndex.search('caption')).toHaveLength(foreign ? 1 : 0)
      expect(await searchIndex.search('original')).toHaveLength(0)
    }
    await h.archive([correction], true)
    expect((await reload(kind)).isRetracted === true).toBe(!foreign)
    expect(preview(kind)?.isRetracted === true).toBe(!foreign)
    expect(await searchIndex.search('caption')).toHaveLength(foreign ? 1 : 0)
  })

  it('abandons a queried retraction after an account generation change', async () => {
    setStorageScopeJid(SELF)
    const h = harness(kind)
    const base = original(kind)
    await save(kind, base); seed(kind, [base]); seedPreview(kind, base)
    await searchIndex.indexMessage(base)
    const send = h.deps.sendIQ
    h.deps.sendIQ = async (...args) => {
      const result = await send(...args)
      setStorageScopeJid('other@example.test'); setStorageScopeJid(SELF)
      return result
    }
    const signal = xml('message', { from: base.from, type: base.type },
      xml('retract', { xmlns: 'urn:xmpp:message-retract:1', id: 'sid-c1' }),
      ...(kind === 'room' ? [xml('occupant-id', { xmlns: 'urn:xmpp:occupant-id:0', id: 'peer-occupant' })] : []))
    await expect(h.archive([{ id: 'c1', body: 'corrected caption', at: T1 }], true, [signal])).rejects.toThrow()
    expect(resident(kind)).toMatchObject(base)
    expect(preview(kind)).toMatchObject(base)
    expect((await reload(kind)).isRetracted).not.toBe(true)
    expect(await searchIndex.search('original')).toHaveLength(1)
  })
})

describe.each<Kind>(['chat', 'room'])('%s preview recovery source ownership', kind => {
  it.each([false, true].flatMap(edited => (kind === 'chat' ? [false, true] : [false]).flatMap(cachedOnly => ['recovered original caption', ''].map(body => ({ edited, cachedOnly, body })))))('keeps a newer preview after interrupted persistence, edited source: $edited, cache-only: $cachedOnly, body: "$body"', async ({ edited, cachedOnly, body }) => {
    const h = harness(kind)
    const url = 'https://files.example.test/photo.png'
    const source: Row = { ...original(kind), body: 'encrypted fallback caption',
      encryptedPayload: xml('message', {}, xml('body', {}, 'encrypted fallback caption'), xml('plain', { xmlns: 'urn:fluux:e2ee-dummy:0' }, 'cGVuZGluZw=='),
        ...(body === '' ? [xml('x', { xmlns: 'jabber:x:oob' }, xml('url', {}, url))] : [])).toString(),
      ...(edited && { isEdited: true, correctionRevision: { ids: ['stanza:sid-c1'], supersedes: [], archiveTimestamp: Date.parse(T1) }, correctionStanzaIds: ['sid-c1'] }),
    }
    await save(kind, source); seed(kind, [source]); seedPreview(kind, source)
    if (kind === 'chat') vi.mocked(cache.applyChatCorrection).mockResolvedValueOnce(null)
    else vi.mocked(cache.applyRoomCorrection).mockResolvedValueOnce(null)
    await h.live({ id: 'c2', body: 'newest unsaved caption', at: T2, authoredAt: T2 })
    const before = structuredClone(preview(kind)!)
    expect(before.body).toBe('newest unsaved caption')
    seed(kind, [])
    if (!cachedOnly || kind === 'room') {
      if (kind === 'chat') await chatStore.getState().loadMessagesFromCache(PEER)
      else await roomStore.getState().loadMessagesFromCache(ROOM)
      expect(resident(kind)).toMatchObject(source)
    }
    expect(preview(kind)).toEqual(before)
    const decrypt = await blockedDecrypt(body === '' ? url : body)
    const engine = new DeferredDecryptEngine({ getManager: () => decrypt.manager, getStores: () => h.stores, getOwnBareJid: () => SELF, cache, updateSearchIndex: searchIndex.updateMessage })
    const retry = engine.retryPending()
    await decrypt.started.promise; decrypt.release.resolve()
    expect(await retry).toBe(1); await drain()
    if (!cachedOnly || kind === 'room') expect(resident(kind)?.body).toBe(body)
    expect(preview(kind)).toEqual(before)
    if (kind === 'room') expect(roomStore.getState().rooms.get(ROOM)?.lastMessage).toEqual(before)
    const durable = await reload(kind)
    expect(durable.body).toBe(body)
    expect(durable.encryptedPayload).toBeUndefined()
    expect(durable.contentRecovery).toBeUndefined()
    expect(durable.correctionRevision?.ids).toEqual(source.correctionRevision?.ids)
    expect(await searchIndex.search('fallback')).toHaveLength(0)
    expect(await searchIndex.search('recovered')).toHaveLength(body ? 1 : 0)
    expect(preview(kind)).toEqual(before)
  })
})

describe.each<Kind>(['chat', 'room'])('%s same-page correction alias retractions', kind => {
  it.each([false, true].flatMap(signalsFirst => [false, true].flatMap(chained => [false, true].map(foreign => ({ signalsFirst, chained, foreign })))))('resolves retractions after aliases, first: $signalsFirst, chained: $chained, foreign: $foreign', async ({ signalsFirst, chained, foreign }) => {
    const h = harness(kind)
    const base = original(kind)
    const corrections: Edit[] = [{ id: 'c1', body: 'corrected caption', at: T1 }]
    if (chained) corrections.push({ id: 'c2', body: 'chained caption', targetId: 'sid-c1', at: T2 })
    const targetId = chained ? 'sid-c2' : 'sid-c1'
    const actor = foreign && kind === 'chat' ? 'foreign@example.test' : base.from
    const signal = xml('message', { from: actor, type: base.type, id: 'retraction' },
      xml('retract', { xmlns: 'urn:xmpp:message-retract:1', id: targetId }),
      ...(kind === 'room' ? [xml('occupant-id', { xmlns: 'urn:xmpp:occupant-id:0', id: foreign ? 'foreign-occupant' : 'peer-occupant' })] : []))
    const matches = await h.search(corrections, true, [signal], signalsFirst, 'caption')
    expect(matches).toHaveLength(foreign ? 1 : 0)
    expect(kind === 'chat' ? await cache.getMessages(PEER) : await cache.getRoomMessages(ROOM, {})).toHaveLength(0)
    const [row] = await h.archive(corrections, true, [signal])
    expect(row.id).toBe(base.id)
    expect(row.stanzaId).toBe(base.stanzaId)
    expect(row.isRetracted === true).toBe(!foreign)
    expect(row.correctionStanzaIds).toContain(targetId)
    await save(kind, row); seedPreview(kind, row); seed(kind, [row])
    await searchIndex.indexMessage(row)
    await h.archive([{ id: 'c1', body: 'corrected caption', at: T1 }], true)
    const durable = await reload(kind)
    expect(durable.isRetracted === true).toBe(!foreign)
    expect(preview(kind)?.isRetracted === true).toBe(!foreign)
    expect(await searchIndex.search('caption')).toHaveLength(foreign ? 1 : 0)
  })
})

describe.each<Kind>(['chat', 'room'])('%s corrections in historical windows', kind => {
  it.each(['unrelated newer', 'same original', 'newer revision', 'conflicting archive', 'foreign author'] as const)('preserves preview ownership for $0', async mode => {
    const h = harness(kind)
    const base = original(kind)
    await save(kind, base); seed(kind, [base])
    let sidebar: Row = base
    if (mode === 'unrelated newer') sidebar = { ...base, id: 'newer-original', stanzaId: 'newer-archive', body: 'unrelated newest preview', timestamp: new Date(FAST) }
    if (mode === 'conflicting archive') sidebar = { ...base, stanzaId: 'different-archive', body: 'separate original preview', timestamp: new Date(FAST) }
    if (mode === 'foreign author') sidebar = { ...base, from: kind === 'chat' ? 'foreign@example.test' : `${ROOM}/Other`, ...(kind === 'room' && { occupantId: 'other-occupant' }), body: 'different author preview', timestamp: new Date(FAST) }
    if (mode === 'newer revision') sidebar = { ...base, body: 'newest revision preview', isEdited: true, correctionRevision: { ids: ['stanza:sid-c2'], supersedes: [], archiveTimestamp: Date.parse(T2) } }
    seedPreview(kind, sidebar)
    const before = structuredClone(preview(kind))
    await h.archive([{ id: 'c1', body: 'historical corrected caption', at: T1 }], true)
    if (mode === 'same original') expect(preview(kind)?.body).toBe('historical corrected caption')
    else expect(preview(kind)).toMatchObject({ id: before!.id, stanzaId: before!.stanzaId, body: before!.body, timestamp: before!.timestamp })
    if (kind === 'room') expect(roomStore.getState().rooms.get(ROOM)?.lastMessage).toEqual(preview(kind))
    if (mode === 'same original') {
      await h.archive([{ id: 'c0', body: 'stale caption', at: T0 }], true)
      expect(preview(kind)?.body).toBe('historical corrected caption')
    }
  })
})

describe.each<Kind>(['chat', 'room'])('%s intrinsic legacy correction evidence', kind => {
  it.each(['cache-only', 'resident', 'page'].flatMap(mode => [['alpha', 'zulu'], ['zulu', 'alpha']].map(([older, current]) => ({ mode, older, current }))))('preserves $current against $older through $mode replay', async ({ mode, older, current }) => {
    const h = harness(kind)
    const edit: Edit = { id: 'c1', body: older, at: T1, stanzaId: 'foreign-c1', stanzaIdBy: 'foreign.example.test', archiveId: 'archive-c1' }
    const [oldPage] = await h.search([edit], true, [], false, older)
    const legacy: Row = { ...original(kind), body: current, originalBody: 'original text', isEdited: true, correctionTimestamp: Date.parse(FAST), correctionTimestampSource: 'authored', correctionStanzaIds: ['foreign-c1', 'foreign-c2'] }
    await save(kind, legacy); seedPreview(kind, legacy)
    seed(kind, mode === 'resident' ? [legacy] : [])
    await searchIndex.backfillFromMessageCache()
    const rows = await h.archive([edit], mode === 'page')
    if (mode === 'page') expect(rows[0].body).toBe(current)
    if (mode === 'resident') expect(resident(kind)?.body).toBe(current)
    expect(preview(kind)?.body).toBe(current)
    expect(await reload(kind)).toMatchObject({ body: current, correctionTimestamp: Date.parse(FAST), stanzaId: legacy.stanzaId, timestamp: legacy.timestamp })
    await save(kind, oldPage)
    await searchIndex.indexMessages([oldPage])
    await searchIndex.closeSearchIndex(); cache._resetDBForTesting()
    const held = await reload(kind)
    expect(held.body).toBe(current)
    expect(held.correctionRevision).toBeUndefined()
    expect(await searchIndex.search(current)).toHaveLength(1)
    expect(await searchIndex.search(older)).toHaveLength(0)
    await h.archive([{ id: 'c3', body: 'progressing revision', at: T2, stanzaId: 'foreign-c3', stanzaIdBy: 'foreign.example.test', archiveId: 'archive-c3' }], true)
    const next = await reload(kind)
    expect(next.body).toBe('progressing revision')
    expect(next.correctionRevision?.ids).toContain('stanza:archive-c3')
    expect(next.correctionRevision?.ids).not.toContain('stanza:foreign-c3')
    expect(next.correctionStanzaIds).toEqual(expect.arrayContaining(['foreign-c1', 'foreign-c2', 'foreign-c3']))
    await h.archive([edit], true)
    expect((await reload(kind)).body).toBe(next.body)
    expect(await searchIndex.search('progressing')).toHaveLength(1)
    expect(await searchIndex.search(older)).toHaveLength(0)
  })
})

describe.each(['chat-cache', 'chat-resident', 'room-resident'] as const)('%s recovered correction search', mode => {
  const kind: Kind = mode === 'room-resident' ? 'room' : 'chat'
  const attachmentUrl = 'https://files.example.test/photo.png'
  async function prepare(body: string) {
    const h = harness(kind)
    const source: Row = {
      ...original(kind), body: 'encrypted fallback caption', isEdited: true,
      encryptedPayload: xml('message', {}, xml('body', {}, 'encrypted fallback caption'), xml('plain', { xmlns: 'urn:fluux:e2ee-dummy:0' }, 'cGVuZGluZw=='),
        ...(body === '' ? [xml('x', { xmlns: 'jabber:x:oob' }, xml('url', {}, attachmentUrl))] : [])).toString(),
      correctionRevision: { ids: ['stanza:sid-c1'], supersedes: [], archiveTimestamp: Date.parse(T1) },
    }
    await save(kind, source); seedPreview(kind, source)
    seed(kind, mode === 'chat-cache' ? [] : [source])
    await searchIndex.backfillFromMessageCache()
    expect(await searchIndex.search('fallback')).toHaveLength(1)
    const decrypt = await blockedDecrypt(body === '' ? attachmentUrl : body)
    const engine = new DeferredDecryptEngine({ getManager: () => decrypt.manager, getStores: () => h.stores, getOwnBareJid: () => SELF, cache, updateSearchIndex: searchIndex.updateMessage })
    return { h, source, decrypt, engine }
  }

  it.each(['recovered searchable caption', '', '👍'])('indexes accepted body "%s" after completed backfill and reopen', async body => {
    const { source, decrypt, engine } = await prepare(body)
    const retry = engine.retryPending()
    await decrypt.started.promise; decrypt.release.resolve()
    expect(await retry).toBe(1); await drain()
    if (mode !== 'chat-cache') expect(resident(kind)?.body).toBe(body)
    expect(preview(kind)?.body).toBe(body)
    const row = await reload(kind)
    expect(row).toMatchObject({ body, encryptedPayload: undefined, correctionTimestamp: Date.parse(FAST), correctionRevision: source.correctionRevision })
    if (body === '') expect(row.attachment?.url).toBe(attachmentUrl)
    expect(await searchIndex.search('fallback')).toHaveLength(0)
    expect(await searchIndex.search('recovered')).toHaveLength(body === 'recovered searchable caption' ? 1 : 0)
    await searchIndex.closeSearchIndex(); cache._resetDBForTesting()
    await searchIndex.backfillFromMessageCache()
    expect(await searchIndex.search('fallback')).toHaveLength(0)
    expect((await reload(kind)).body).toBe(body)
  })

  it.each(['newer correction', 'retraction', 'account round trip'] as const)('keeps search aligned across a concurrent %s', async change => {
    const { h, source, decrypt, engine } = await prepare('stale recovered text')
    const retry = engine.retryPending()
    await decrypt.started.promise
    if (change === 'newer correction') await h.archive([{ id: 'c2', body: 'newest searchable revision', at: T2 }])
    else if (change === 'retraction') {
      if (kind === 'chat') await retractionStorage.retractChatMessageInStorage(PEER, source as StoredMessage, { isRetracted: true, body: '' })
      else await retractionStorage.retractRoomMessageInStorage(ROOM, source as StoredRoomMessage, { isRetracted: true, body: '' })
    } else { setStorageScopeJid('other@example.test'); setStorageScopeJid(null) }
    decrypt.release.resolve(); await retry; await drain()
    expect(await searchIndex.search('stale')).toHaveLength(0)
    const row = await reload(kind)
    if (change === 'newer correction') {
      expect(row.body).toBe('newest searchable revision')
      expect(preview(kind)?.body).toBe(row.body)
      expect(await searchIndex.search('newest')).toHaveLength(1)
    } else if (change === 'retraction') {
      expect(row.isRetracted).toBe(true)
      expect(await searchIndex.search('fallback')).toHaveLength(0)
    } else {
      expect(row.body).toBe(source.body)
      expect(preview(kind)?.body).toBe(source.body)
      expect(await searchIndex.search('fallback')).toHaveLength(1)
    }
  })

  it('indexes the durable winner when a newer correction arrives after recovery writes', async () => {
    const { h, decrypt, engine } = await prepare('stale recovered text')
    const written = deferred(), releaseWrite = deferred()
    if (kind === 'chat') {
      const update = vi.mocked(cache.updateMessage).getMockImplementation()!
      vi.mocked(cache.updateMessage).mockImplementationOnce(async (...args) => {
        await update(...args); written.resolve(); await releaseWrite.promise
      })
    } else {
      const update = vi.mocked(cache.updateRoomMessage).getMockImplementation()!
      vi.mocked(cache.updateRoomMessage).mockImplementationOnce(async (...args) => {
        await update(...args); written.resolve(); await releaseWrite.promise
      })
    }
    const retry = engine.retryPending()
    await decrypt.started.promise; decrypt.release.resolve(); await written.promise
    await h.archive([{ id: 'c2', body: 'newest searchable revision', at: T2 }])
    releaseWrite.resolve(); await retry; await drain()
    expect((await reload(kind)).body).toBe('newest searchable revision')
    expect(preview(kind)?.body).toBe('newest searchable revision')
    expect(await searchIndex.search('newest')).toHaveLength(1)
    expect(await searchIndex.search('stale')).toHaveLength(0)
    expect(await searchIndex.search('fallback')).toHaveLength(0)
  })

  it('keeps recovery usable after local indexing fails and permits a search retry', async () => {
    const { decrypt, engine } = await prepare('recovered searchable caption')
    vi.mocked(searchIndex.updateMessage).mockRejectedValueOnce(new Error('transient search failure'))
    const retry = engine.retryPending()
    await decrypt.started.promise; decrypt.release.resolve()
    expect(await retry).toBe(1); await drain()
    const row = await reload(kind)
    expect(row.body).toBe('recovered searchable caption')
    expect(preview(kind)?.body).toBe(row.body)
    expect(await searchIndex.search('fallback')).toHaveLength(1)
    await searchIndex.updateMessage(row)
    expect(await searchIndex.search('fallback')).toHaveLength(0)
    expect(await searchIndex.search('recovered')).toHaveLength(1)
  })

  if (mode !== 'chat-cache') it('keeps nonpersistent recovered captions out of cache and search', async () => {
    const h = harness(kind)
    const source: Row = { ...original(kind), body: 'encrypted fallback caption', isEdited: true, noLocalStore: true,
      encryptedPayload: '<message><body>encrypted fallback caption</body><plain xmlns="urn:fluux:e2ee-dummy:0">cGVuZGluZw==</plain></message>' }
    seed(kind, [source]); seedPreview(kind, source)
    const decrypt = await blockedDecrypt('recovered private caption')
    const engine = new DeferredDecryptEngine({ getManager: () => decrypt.manager, getStores: () => h.stores, getOwnBareJid: () => SELF, cache, updateSearchIndex: searchIndex.updateMessage })
    const retry = engine.retryPending()
    await decrypt.started.promise; decrypt.release.resolve()
    expect(await retry).toBe(1); await drain()
    expect(resident(kind)?.body).toBe('recovered private caption')
    expect(preview(kind)?.body).toBe('recovered private caption')
    expect(kind === 'chat' ? await cache.getMessages(PEER) : await cache.getRoomMessages(ROOM, {})).toHaveLength(0)
    expect(await searchIndex.search('private')).toHaveLength(0)
    expect(await searchIndex.search('fallback')).toHaveLength(0)
  })
})

describe.each<Kind>(['chat', 'room'])('%s durable corrections', kind => {
  it('lets later archive evidence replace a provisional winner in every full-row merge order', async () => {
    const h = harness(kind)
    await save(kind, original(kind)); seed(kind, [original(kind)])
    await h.archive([{ id: 'c0', body: 'archived baseline', at: T0 }])
    await h.live({ id: 'c2', body: 'latest text' })
    const undated = await reload(kind)
    await h.archive([{ id: 'c1', body: 'provisional text', at: T1 }])
    const provisional = await reload(kind)
    expect(provisional.body).toBe('provisional text')
    expect(provisional.correctionRevision?.supersedes).not.toContain('stanza:sid-c2')
    await h.archive([{ id: 'c2', body: 'latest text', at: T2 }])
    const dated = await reload(kind)
    expect(dated.body).toBe('latest text')
    for (const order of permutations([undated, provisional, dated])) {
      await cache.clearAllMessages(); seed(kind, [])
      await save(kind, ...order)
      expect(await reload(kind)).toMatchObject({ body: 'latest text', timestamp: new Date(T0), correctionRevision: { archiveTimestamp: Date.parse(T2) } })
    }
  })

  it.each([['alpha', 'zulu'], ['zulu', 'alpha']])('preserves equal-date archive order through replay and full-row merges: %s then %s', async (first, second) => {
    const h = harness(kind)
    const [older] = await h.archive([{ id: 'c1', body: first, at: T1 }], true)
    const [newer] = await h.archive([{ id: 'c1', body: first, at: T1 }, { id: 'c2', body: second, at: T1 }], true)
    expect(newer.body).toBe(second)
    expect((await reload(kind)).body).toBe(second)
    expect((await h.archive([{ id: 'c1', body: first, at: T1 }], true))[0].body).toBe(second)
    for (const order of permutations([older, newer])) {
      await cache.clearAllMessages(); seed(kind, [])
      await save(kind, ...order)
      expect((await reload(kind)).body).toBe(second)
    }
  })

  it.each([false, true])('retains equal-date correction order across query pages; forward: %s', async forward => {
    const h = harness(kind)
    const older = { edits: [{ id: 'c1', body: 'older text', at: T1 }], original: true }
    const newer = { edits: [{ id: 'c2', body: 'later text', at: T1 }] }
    const result = await h.archivePages(forward ? [older, newer] : [newer, older], forward)
    expect(result[0].body).toBe('later text')
    expect((await reload(kind)).body).toBe('later text')
    await h.archive([{ id: 'c1', body: 'older text', at: T1 }], true)
    expect((await reload(kind)).body).toBe('later text')
  })

  it.each([false, true])('preserves a legacy edit against known aliases with the original in-page: %s', async inPage => {
    const legacy = { ...original(kind), body: 'legacy current', originalBody: 'original text', isEdited: true, correctionTimestamp: Date.parse(FAST), correctionStanzaIds: ['sid-c1', 'sid-c2'] }
    const old = { ...original(kind), body: 'known older', isEdited: true, correctionStanzaIds: ['sid-c1'], correctionRevision: { ids: ['stanza:sid-c1'], supersedes: [], archiveTimestamp: Date.parse(T1) } }
    await save(kind, legacy); seed(kind, [legacy])
    const h = harness(kind)
    const rows = await h.archive([{ id: 'c1', body: 'known older', at: T1 }], inPage)
    if (inPage) expect(rows[0].body).toBe('legacy current')
    expect((await reload(kind)).body).toBe('legacy current')
    for (const order of permutations([legacy, old])) {
      await cache.clearAllMessages(); seed(kind, [])
      await save(kind, ...order)
      expect(await reload(kind)).toMatchObject({ body: 'legacy current', correctionTimestamp: Date.parse(FAST) })
    }
    await h.archive([{ id: 'c3', body: 'new revision', at: T2 }], true)
    expect((await reload(kind)).body).toBe('new revision')
  })

  it('distinguishes known undated legacy replays from new undated edits', async () => {
    const legacy = { ...original(kind), isEdited: true, body: 'legacy current', correctionStanzaIds: ['sid-c1', 'sid-c2'] }
    await save(kind, legacy); seed(kind, [legacy])
    const h = harness(kind)
    await h.live({ id: 'c1', body: 'known older' })
    expect((await reload(kind)).body).toBe('legacy current')
    await h.live({ id: 'c3', body: 'new undated edit' })
    expect((await reload(kind)).body).toBe('new undated edit')
  })

  it('returns and emits the newer cached correction outside a bounded context query', async () => {
    const h = harness(kind)
    await h.archive([{ id: 'c2', body: 'current outside window', at: '2026-09-01T12:00:00.000Z' }], true)
    seed(kind, [])
    const rows = await h.context([{ id: 'c1', body: 'old inside window', at: T1 }])
    expect(rows).toHaveLength(1)
    expect(rows[0].body).toBe('current outside window')
    expect(h.historyRows.at(-1)?.[0].body).toBe('current outside window')
    expect(await reload(kind)).toMatchObject({ body: 'current outside window', timestamp: new Date(T0), correctionStanzaIds: ['sid-c1', 'sid-c2'] })
  })

  it.each([false, true])('rejects stale resident decryption after a correction; source already edited: %s', async edited => {
    const h = harness(kind)
    const source = {
      ...original(kind), encryptedPayload: '<plain xmlns="urn:fluux:e2ee-dummy:0">c3RhbGU=</plain>',
      ...(edited && { isEdited: true, correctionRevision: { ids: ['stanza:sid-c1'], supersedes: [], archiveTimestamp: Date.parse(T1) } }),
    }
    await save(kind, source); seed(kind, [source])
    if (source.type === 'chat') chatStore.getState().updateLastMessagePreview(PEER, source)
    const blocked = await blockedDecrypt()
    const engine = new DeferredDecryptEngine({ getManager: () => blocked.manager, getStores: () => h.stores, getOwnBareJid: () => SELF, cache, updateSearchIndex: searchIndex.updateMessage })
    const retry = engine.retryPending()
    await blocked.started.promise
    let current: Row
    try {
      await h.archive([{ id: 'c2', body: 'current locked correction', at: T2, locked: true }])
      current = resident(kind)!
    } finally {
      blocked.release.resolve()
      await retry; await drain()
    }
    expect(resident(kind)).toMatchObject({ body: current!.body, encryptedPayload: current!.encryptedPayload })
    if (kind === 'chat') expect(chatStore.getState().conversations.get(PEER)?.lastMessage).toMatchObject({ body: current!.body, encryptedPayload: current!.encryptedPayload })
    else expect(roomStore.getState().roomMeta.get(ROOM)?.lastMessage).toMatchObject({ body: current!.body, encryptedPayload: current!.encryptedPayload })
    const row = await reload(kind)
    expect(row).toMatchObject({ body: 'current locked correction', encryptedPayload: current!.encryptedPayload })
    expect(row.contentRecovery).toBeUndefined()
  })

  it.each([['alpha', 'zulu'], ['zulu', 'alpha']])('preserves recency and full-row alias unions: %s to %s', async (first, second) => {
    const h = harness(kind)
    const [older] = await h.archive([{ id: 'c1', body: first, at: T1 }], true)
    const [newer] = await h.archive([{ id: 'c2', body: second, at: T2 }], true)
    await save(kind, older, newer, older, original(kind))
    const row = await reload(kind)
    expect(row).toMatchObject({ body: second, originalBody: 'original text', stanzaId: 'archive-original', timestamp: new Date(T0), correctionStanzaIds: ['sid-c1', 'sid-c2'] })
  })

  it.each([false, true])('persists catch-up when original is resident: %s', async inPage => {
    await save(kind, original(kind)); seed(kind, inPage ? [original(kind)] : [])
    const h = harness(kind)
    await h.archive([{ id: 'c2', body: 'newest', at: T2 }, { id: 'c1', body: 'older', at: T1 }], inPage)
    if (inPage) expect(resident(kind)?.body).toBe('newest')
    else expect(resident(kind)).toBeUndefined()
    expect(await reload(kind)).toMatchObject({ body: 'newest', originalBody: 'original text', correctionStanzaIds: ['sid-c1', 'sid-c2'] })
  })

  it.each(['live', 'outgoing'] as const)('keeps two successive undated %s edits ahead of the first archive echo', async mode => {
    const own = mode === 'outgoing'
    const h = harness(kind, own)
    await save(kind, original(kind, own)); seed(kind, [original(kind, own)])
    await h.archive([{ id: 'c0', body: 'dated', at: T0 }])
    if (mode === 'live') await h.live({ id: 'c0', body: 'dated' })
    vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date(FAST))
    const firstId = mode === 'outgoing' ? await h.outgoing('first') : 'c1'
    if (mode === 'live') await h.live({ id: firstId, body: 'first' })
    const secondId = mode === 'outgoing' ? await h.outgoing('second') : 'c2'
    if (mode === 'live') await h.live({ id: secondId, body: 'second' })
    const second = await reload(kind)
    expect(second.body).toBe('second')
    expect(second.correctionRevision?.archiveTimestamp).toBeUndefined()
    await h.archive([{ id: firstId, body: 'first', at: T1 }])
    expect((await reload(kind)).body).toBe('second')
    await h.archive([{ id: secondId, body: 'second', at: T2 }])
    expect((await reload(kind)).correctionRevision?.archiveTimestamp).toBe(Date.parse(T2))
    await save(kind, second)
    expect((await reload(kind)).body).toBe('second')
  })

  it('uses carbon envelope chronology and retains a superseded correction alias', async () => {
    const h = harness(kind)
    await save(kind, original(kind)); seed(kind, [original(kind)])
    await h.carbon({ id: 'c2', body: 'newest', at: T2, authoredAt: T1 })
    await h.carbon({ id: 'c1', body: 'older', at: T1, authoredAt: FAST })
    expect(await reload(kind)).toMatchObject({ body: 'newest', correctionTimestamp: Date.parse(T1), correctionStanzaIds: ['sid-c1', 'sid-c2'], correctionRevision: { archiveTimestamp: Date.parse(T2) } })
  })

  it('uses archive chronology across signed device clocks and retains authored dates', async () => {
    const h = harness(kind)
    await h.archive([{ id: 'desktop', body: 'desktop', at: T1, authoredAt: FAST }], true)
    await h.archive([{ id: 'phone', body: 'phone', at: T2, authoredAt: T2 }])
    await reload(kind)
    await h.live({ id: 'desktop', body: 'desktop', at: T1, authoredAt: FAST })
    expect(await reload(kind)).toMatchObject({ body: 'phone', correctionTimestamp: Date.parse(T2), correctionTimestampSource: 'authored', correctionRevision: { archiveTimestamp: Date.parse(T2) } })
  })

  it('retains the signed content date when a full-row archive echo has only a delay', async () => {
    const h = harness(kind)
    const [signed] = await h.archive([{ id: 'c1', body: 'edited', at: T1, authoredAt: FAST }], true)
    const [echo] = await h.archive([{ id: 'c1', body: 'edited', at: T1 }], true)
    await save(kind, signed, echo, signed)
    expect(await reload(kind)).toMatchObject({
      body: 'edited', correctionTimestamp: Date.parse(FAST), correctionTimestampSource: 'authored',
      correctionRevision: { archiveTimestamp: Date.parse(T1) },
    })
  })

  it('lets a distinct archived correction replace an undated edit despite a fast clock', async () => {
    const h = harness(kind)
    await save(kind, original(kind)); seed(kind, [original(kind)])
    await h.live({ id: 'desktop', body: 'desktop', authoredAt: FAST })
    await h.archive([{ id: 'desktop', body: 'desktop', at: T1, authoredAt: FAST }])
    await h.archive([{ id: 'phone', body: 'phone', at: T2, authoredAt: T1 }])
    expect(await reload(kind)).toMatchObject({ body: 'phone', correctionTimestamp: Date.parse(T1), correctionRevision: { archiveTimestamp: Date.parse(T2) } })
  })

  it.each(['stale', 'id-only'] as const)('unions aliases through %s partial updates and resolves them outside RAM', async mode => {
    const h = harness(kind)
    await h.archive([{ id: 'c2', body: 'newest', at: T2 }], true)
    const updates = mode === 'id-only' ? { correctionStanzaIds: ['sid-c1'] } : {
      isEdited: true, body: 'stale', correctionStanzaIds: ['sid-c1'],
      correctionRevision: { ids: ['id:c1'], supersedes: [], archiveTimestamp: Date.parse(T1) },
    }
    if (kind === 'chat') await cache.updateMessage(PEER, 'original', updates, PEER)
    else await cache.updateRoomMessage(ROOM, 'original', updates, `${ROOM}/Peer`)
    const row = await reload(kind)
    expect(row).toMatchObject({ body: 'newest', correctionStanzaIds: ['sid-c1', 'sid-c2'] })
    seed(kind, [])
    const resolution = kind === 'chat' ? await cache.findChatRetractionTargets(PEER, 'sid-c1') : await cache.findRoomRetractionTargets(ROOM, 'sid-c1')
    expect(resolution?.candidates).toHaveLength(1)
    expect(kind === 'chat' ? await cache.findChatRetractionTargets('other@example.test', 'sid-c1') : await cache.findRoomRetractionTargets('other@conference.example.test', 'sid-c1')).toBeUndefined()
    if (kind === 'chat') h.emitSDK('chat:retraction-pending', { conversationId: PEER, targetId: 'sid-c1', actorJid: PEER })
    else h.emitSDK('room:retraction-pending', { roomJid: ROOM, targetId: 'sid-c1', actorJid: `${ROOM}/Peer`, actorOccupantId: 'peer-occupant' })
    await vi.waitFor(async () => {
      const rows = kind === 'chat' ? await cache.getMessages(PEER) : await cache.getRoomMessages(ROOM, {})
      expect(rows[0].isRetracted).toBe(true)
      expect(rows[0].body).not.toBe('newest')
    })
  })

  it.each([false, true])('rejects corrections from another author with resident target: %s', async inMemory => {
    await save(kind, original(kind)); seed(kind, inMemory ? [original(kind)] : [])
    await harness(kind).archive([{ id: 'forged', body: 'forged', at: T2, from: kind === 'chat' ? 'other@example.test' : `${ROOM}/Peer`, occupantId: 'other-occupant' }])
    expect((await reload(kind)).body).toBe('original text')
  })

  it('does not restore a retracted body through catch-up', async () => {
    await save(kind, { ...original(kind), isRetracted: true, body: '', retractedAt: new Date(T1) })
    await harness(kind).archive([{ id: 'new', body: 'must remain hidden', at: T2 }], true)
    const row = await reload(kind)
    expect(row.isRetracted).toBe(true)
    expect(row.body).not.toBe('must remain hidden')
  })

  it('carries signed time through deferred decryption without changing archive order', async () => {
    const h = harness(kind)
    await h.archive([{ id: 'locked', body: 'locked', at: T2, locked: true }], true)
    const manager = new E2EEManager({ storage: new InMemoryStorageBackend(), account: { jid: SELF }, xmpp: {
      sendStanza: async () => {}, queryDisco: async () => ({ features: [], identities: [] }),
      publishPEP: async () => {}, retractPEP: async () => {}, deletePEP: async () => {}, queryPEP: async () => [], subscribePEP: () => ({ unsubscribe() {} }),
    } })
    await manager.register(new DummyPlaintextPlugin())
    vi.spyOn(manager, 'decryptArchive').mockResolvedValue({ plaintext: new TextEncoder().encode('recovered'), senderDevice: { jid: PEER, deviceId: 'test' }, securityContext: { protocolId: 'dummy-plaintext', trust: 'verified' }, authoredAt: new Date(FAST) })
    if (kind === 'chat') seed(kind, [])
    else await reload(kind)
    const engine = new DeferredDecryptEngine({ getManager: () => manager, getStores: () => h.stores, getOwnBareJid: () => SELF, cache, updateSearchIndex: searchIndex.updateMessage })
    expect(await engine.retryPending()).toBe(1)
    const row = await reload(kind)
    expect(row).toMatchObject({ body: 'recovered', correctionTimestamp: Date.parse(FAST), correctionTimestampSource: 'authored', correctionRevision: { archiveTimestamp: Date.parse(T2) } })
    expect(row.encryptedPayload).toBeUndefined()
    await h.archive([{ id: 'locked', body: 'locked', at: T2, locked: true }], true)
    expect((await reload(kind)).body).toBe('recovered')
    await h.archive([{ id: 'later', body: 'later device', at: '2026-09-01T10:03:00.000Z', authoredAt: T2 }])
    expect((await reload(kind)).body).toBe('later device')
  })
})

describe.each(['cache', 'preview'] as const)('%s deferred recovery race', mode => {
  it.each([false, true])('retains an intervening correction and its preview; source already edited: %s', async edited => {
    const h = harness('chat')
    const source: StoredMessage = {
      ...original('chat') as StoredMessage, encryptedPayload: '<plain xmlns="urn:fluux:e2ee-dummy:0">c3RhbGU=</plain>',
      ...(edited && { isEdited: true, correctionRevision: { ids: ['stanza:sid-c1'], supersedes: [], archiveTimestamp: Date.parse(T1) } }),
    }
    if (mode === 'cache') await save('chat', source)
    seed('chat', [])
    chatStore.getState().updateLastMessagePreview(PEER, source)
    const blocked = await blockedDecrypt()
    const engine = new DeferredDecryptEngine({ getManager: () => blocked.manager, getStores: () => h.stores, getOwnBareJid: () => SELF, cache, updateSearchIndex: searchIndex.updateMessage })
    const retry = engine.retryPending()
    await blocked.started.promise
    let current: Row
    try {
      if (mode === 'preview') await save('chat', source)
      seed('chat', [source])
      await h.archive([{ id: 'c2', body: 'current locked correction', at: T2, locked: true }])
      current = resident('chat')!
    } finally {
      blocked.release.resolve()
      await retry; await drain()
    }
    expect(chatStore.getState().conversations.get(PEER)?.lastMessage).toMatchObject({ body: 'current locked correction', encryptedPayload: current!.encryptedPayload })
    expect(await reload('chat')).toMatchObject({ body: 'current locked correction', encryptedPayload: current!.encryptedPayload })
  })
})

describe.each<Kind>(['chat', 'room'])('%s history reconciliation boundaries', kind => {
  const entity = kind === 'chat' ? PEER : ROOM
  const newer = (): Row => ({
    ...original(kind), body: 'confidential latest', isEdited: true,
    correctionStanzaIds: ['sid-c2'],
    correctionRevision: { ids: ['stanza:sid-c2'], supersedes: [], archiveTimestamp: Date.parse(T2) },
  })
  const read = () => kind === 'chat' ? cache.getMessages(PEER) : cache.getRoomMessages(ROOM, {})
  const retract = async (h: ReturnType<typeof harness>, targetId: string, foreign: boolean) => {
    if (kind === 'chat') h.emitSDK('chat:retraction-pending', { conversationId: PEER, targetId, actorJid: foreign ? 'foreign@example.test' : PEER })
    else h.emitSDK('room:retraction-pending', { roomJid: ROOM, targetId, actorJid: `${ROOM}/Peer`, actorOccupantId: foreign ? 'foreign-occupant' : 'peer-occupant' })
    await drain()
  }

  it.each([false, true])('adopts a newly learned correction alias only for its author; foreign: %s', async foreign => {
    const h = harness(kind)
    await save(kind, original(kind))
    await searchIndex.indexMessage(original(kind))
    await retract(h, 'result-c1', foreign)
    expect((await read())[0].isRetracted).not.toBe(true)
    await h.archive([{ id: 'c1', body: 'corrected secret', at: T1, omitStanzaId: true, archiveId: 'result-c1' }])
    expect(resident(kind)).toBeUndefined()
    expect((await read())[0]).toMatchObject(foreign
      ? { body: 'corrected secret', correctionStanzaIds: ['result-c1'] }
      : { body: '', isRetracted: true, correctionStanzaIds: ['result-c1'] })
    expect(await searchIndex.search('original')).toEqual([])
    expect(await searchIndex.search('secret')).toHaveLength(foreign ? 1 : 0)
    expect((await reload(kind)).body).toBe(foreign ? 'corrected secret' : '')
  })

  it.each(['missing', 'foreign', 'trusted'] as const)('retains reference aliases with a %s inner stanza ID', async inner => {
    const h = harness(kind)
    await save(kind, original(kind))
    const edit = { id: 'c1', body: 'corrected secret', at: T1, archiveId: 'result-c1',
      omitStanzaId: inner === 'missing', ...(inner === 'foreign' ? { stanzaIdBy: 'untrusted@example.test' } : {}) }
    await h.archive([edit])
    const alias = inner === 'missing' ? 'result-c1' : 'sid-c1'
    const revisionId = inner === 'trusted' ? 'sid-c1' : 'result-c1'
    expect((await read())[0]).toMatchObject({ correctionStanzaIds: [...new Set([alias, revisionId])].sort(), correctionRevision: { ids: expect.arrayContaining([`stanza:${revisionId}`]) } })
    const resolution = kind === 'chat' ? await cache.findChatRetractionTargets(PEER, alias) : await cache.findRoomRetractionTargets(ROOM, alias)
    expect(resolution?.candidates).toHaveLength(1)
    await retract(h, alias, false)
    expect((await read())[0]).toMatchObject({ body: '', isRetracted: true })
    expect(await searchIndex.search('secret')).toEqual([])
  })

  it('keeps result-only correction aliases on fulltext search rows', async () => {
    const h = harness(kind)
    const [row] = await h.search([{ id: 'c1', body: 'corrected secret', at: T1, omitStanzaId: true, archiveId: 'result-c1' }], true, [], false, 'secret')
    expect(row.correctionStanzaIds).toEqual(['result-c1'])
    await save(kind, row)
    await retract(h, 'result-c1', false)
    expect((await reload(kind)).isRetracted).toBe(true)
  })

  it.each([false, true])('preserves the fetched replacement reaction set with a resident row: %s', async inMemory => {
    const h = harness(kind)
    const row = { ...newer(), reactions: { '👍': [kind === 'chat' ? 'bob@example.test' : 'Bob'] } }
    await save(kind, row); seed(kind, inMemory ? [row] : [])
    const reaction = xml('message', { from: kind === 'chat' ? 'bob@example.test' : `${ROOM}/Bob` },
      xml('reactions', { xmlns: 'urn:xmpp:reactions:0', id: 'original' }))
    const rows = await h.archive([{ id: 'c1', body: 'older text', at: T1 }], true, [reaction])
    expect(rows[0]).toMatchObject({ body: row.body, timestamp: new Date(T0) })
    expect(rows[0].reactions).toBeUndefined()
    expect(h.historyRows.at(-1)?.[0].reactions).toBeUndefined()
    expect((await reload(kind)).body).toBe(row.body)
  })

  it('preserves unrelated fetched fields when selecting a cached correction', async () => {
    await save(kind, { ...newer(), noStyling: false, pollClosed: { pollMessageId: 'cached-poll', title: 'Cached poll', results: [] }, pollClosedAt: new Date(T2) })
    const page = { ...original(kind), noStyling: true, reactions: {} }
    const rows = kind === 'chat'
      ? await chatStore.getState().reconcileHistoryMessages([page as StoredMessage])
      : await roomStore.getState().reconcileHistoryMessages([page as StoredRoomMessage])
    expect(rows[0]).toMatchObject({ body: 'confidential latest', noStyling: true, reactions: {}, timestamp: page.timestamp, id: page.id })
    expect(rows[0].pollClosed).toBeUndefined()
    expect(rows[0].pollClosedAt).toBeUndefined()
  })

  it('delivers network history and corrections when local search resolution fails', async () => {
    const h = harness(kind)
    activate(kind)
    await save(kind, original(kind)); seed(kind, [original(kind)]); seedPreview(kind, original(kind))
    const fault = vi.spyOn(cache, 'resolveMessagesForIndex').mockRejectedValue(new Error('search cache unavailable'))
    const rows = await h.archive([{ id: 'c2', body: 'current network edit', at: T2 }], true)
    expect(rows[0].body).toBe('current network edit')
    expect(resident(kind)?.body).toBe('current network edit')
    expect(preview(kind)?.body).toBe('current network edit')
    expect(h.events.some(({ event }) => event.endsWith('history-error'))).toBe(false)
    expect(await searchIndex.search('current')).toEqual([])
    fault.mockRestore()
    await searchIndex.backfillFromMessageCache()
    expect(await searchIndex.search('current')).toHaveLength(1)
    expect((await reload(kind)).body).toBe('current network edit')
  })

  it.each([['open', false], ['open', true], ['read', false], ['read', true]] as const)('keeps network history when cache %s fails; resident: %s', async (failure, inMemory) => {
    const h = harness(kind)
    const held = newer()
    await save(kind, held); seed(kind, inMemory ? [held] : [])
    cache._resetDBForTesting()
    const open = indexedDB.open.bind(indexedDB)
    const fault = failure === 'open'
      ? vi.spyOn(indexedDB, 'open').mockImplementation((name, version) => {
          if (name.startsWith('fluux-message-cache')) throw new Error('cache unavailable')
          return open(name, version)
        })
      : vi.spyOn(IDBIndex.prototype, 'getAll').mockImplementation(() => { throw new Error('cache read failed') })
    const rows = await h.archive([], true)
    expect(rows[0].body).toBe(inMemory ? held.body : original(kind).body)
    expect(h.historyRows.at(-1)?.[0].body).toBe(inMemory ? held.body : original(kind).body)
    expect(h.events.some(({ event }) => event.endsWith('history-error'))).toBe(false)
    fault.mockRestore()
    cache._resetDBForTesting()
    expect((await reload(kind)).body).toBe(held.body)
  })

  it.each(['read', 'failed-read'] as const)('cancels history when the account switches during a cache %s', async phase => {
    const h = harness(kind)
    const other = { ...original(kind), body: 'unchanged account' }
    setStorageScopeJid('other@example.test')
    await save(kind, other); await searchIndex.indexMessage(other)
    setStorageScopeJid(SELF)
    await save(kind, newer()); await searchIndex.indexMessage(newer())
    let eventsAtSwitch = 0
    let switched = false
    const getAll = IDBIndex.prototype.getAll
    const changeAccount = () => {
      switched = true
      setStorageScopeJid('other@example.test')
      chatStore.getState().switchAccount('other@example.test')
      roomStore.getState().switchAccount('other@example.test')
      seed(kind, [other])
      if (kind === 'chat') chatStore.getState().setMAMLoading(entity, true)
      else roomStore.getState().setRoomMAMLoading(entity, true)
      eventsAtSwitch = h.events.length
    }
    const fault = vi.spyOn(IDBIndex.prototype, 'getAll').mockImplementationOnce(function (this: IDBIndex, ...args) {
      if (phase === 'failed-read') { changeAccount(); throw new Error('read failed after switch') }
      const request = getAll.apply(this, args)
      request.addEventListener('success', changeAccount)
      return request
    })
    await expect(h.archive([], true)).rejects.toMatchObject({ name: 'AbortError' })
    fault.mockRestore()
    expect(switched).toBe(true)
    expect(h.events).toHaveLength(eventsAtSwitch)
    expect(resident(kind)?.body).toBe(other.body)
    const states = kind === 'chat' ? chatStore.getState().mamQueryStates : roomStore.getState().mamQueryStates
    expect(states.get(entity)?.isLoading).toBe(true)
    expect((await read())[0].body).toBe(other.body)
    expect(await searchIndex.search('confidential')).toEqual([])
    setStorageScopeJid(SELF)
    expect((await read())[0].body).toBe(newer().body)
    expect(await searchIndex.search('confidential')).toHaveLength(1)
  })

  it.each(['archive', 'forward', 'context', 'search'] as const)('cancels %s results after reconciliation even if the account switches back', async method => {
    const h = harness(kind)
    setStorageScopeJid(SELF)
    await save(kind, newer()); await searchIndex.indexMessage(newer())
    const started = deferred(), release = deferred()
    if (kind === 'chat') h.stores.chat.reconcileHistoryMessages.mockImplementationOnce(async messages => {
      const rows = await chatStore.getState().reconcileHistoryMessages(messages)
      started.resolve(); await release.promise
      return rows
    })
    else h.stores.room.reconcileHistoryMessages.mockImplementationOnce(async messages => {
      const rows = await roomStore.getState().reconcileHistoryMessages(messages)
      started.resolve(); await release.promise
      return rows
    })
    const work = method === 'forward' ? h.archivePages([{ edits: [], original: true }], true)
      : method === 'context' ? h.context([]) : method === 'search' ? h.search([]) : h.archive([], true)
    const result = work.then(value => ({ value }), error => ({ error }))
    await started.promise
    const eventCount = h.events.length
    setStorageScopeJid('other@example.test')
    setStorageScopeJid(SELF)
    release.resolve()
    expect(await result).toMatchObject({ error: { name: 'AbortError' } })
    expect(h.events).toHaveLength(eventCount)
    expect((await read())[0].body).toBe(newer().body)
    setStorageScopeJid('other@example.test')
    expect(await read()).toEqual([])
    expect(await searchIndex.search('confidential')).toEqual([])
  })

  it('does not emit stale loading or errors when an IQ rejects after an account switch', async () => {
    const h = harness(kind)
    const started = deferred(), release = deferred()
    h.deps.sendIQ = async () => { started.resolve(); await release.promise; throw new Error('old connection failed') }
    const result = h.archive([], true).then(value => ({ value }), error => ({ error }))
    await started.promise
    const count = h.events.length
    setStorageScopeJid('other@example.test')
    release.resolve()
    expect(await result).toMatchObject({ error: { name: 'AbortError' } })
    expect(h.events).toHaveLength(count)
    expect(await read()).toEqual([])
    expect(await searchIndex.search('original')).toEqual([])
  })
  it('cancels a completed reconciliation when the connection ends', async () => {
    const h = harness(kind)
    await save(kind, newer())
    const started = deferred(), release = deferred()
    if (kind === 'chat') h.stores.chat.reconcileHistoryMessages.mockImplementationOnce(async messages => {
      const rows = await chatStore.getState().reconcileHistoryMessages(messages)
      started.resolve(); await release.promise
      return rows
    })
    else h.stores.room.reconcileHistoryMessages.mockImplementationOnce(async messages => {
      const rows = await roomStore.getState().reconcileHistoryMessages(messages)
      started.resolve(); await release.promise
      return rows
    })
    const result = h.archive([], true).then(value => ({ value }), error => ({ error }))
    await started.promise
    const count = h.events.length
    h.deps.getCurrentJid = () => null
    release.resolve()
    expect(await result).toMatchObject({ error: { name: 'AbortError' } })
    expect(h.events).toHaveLength(count)
    expect((await read())[0].body).toBe(newer().body)
  })

})


it('cancels the final room reconciliation after an already-emitted forward page', async () => {
  const h = harness('room')
  setStorageScopeJid(SELF)
  const started = deferred(), release = deferred()
  h.stores.room.reconcileHistoryMessages
    .mockImplementationOnce(messages => roomStore.getState().reconcileHistoryMessages(messages))
    .mockImplementationOnce(async messages => {
      const rows = await roomStore.getState().reconcileHistoryMessages(messages)
      await drain()
      started.resolve(); await release.promise
      return rows
    })
  const result = h.archivePages([{ edits: [{ id: 'c1', body: 'confidential room', at: T1 }], original: true }], true)
    .then(value => ({ value }), error => ({ error }))
  await started.promise
  expect(h.historyRows).toHaveLength(1)
  const count = h.events.length
  setStorageScopeJid('other@example.test')
  chatStore.getState().switchAccount('other@example.test')
  roomStore.getState().switchAccount('other@example.test')
  release.resolve()
  expect(await result).toMatchObject({ error: { name: 'AbortError' } })
  expect(h.events).toHaveLength(count)
  expect(roomStore.getState().messages.size).toBe(0)
  expect(await cache.getRoomMessages(ROOM, {})).toEqual([])
  expect(await searchIndex.search('confidential')).toEqual([])
  setStorageScopeJid(SELF)
  expect((await cache.getRoomMessages(ROOM, {}))[0].body).toBe('confidential room')
  expect(await searchIndex.search('confidential')).toHaveLength(1)
})


function preview(kind: Kind): Row | undefined {
  return (kind === 'chat' ? chatStore.getState().conversationMeta.get(PEER)?.lastMessage : roomStore.getState().roomMeta.get(ROOM)?.lastMessage) as Row | undefined
}

function seedPreview(kind: Kind, message: Row) {
  if (kind === 'chat') chatStore.getState().updateLastMessagePreview(PEER, message as StoredMessage)
  else roomStore.getState().updateLastMessagePreview(ROOM, message as StoredRoomMessage)
}

function activate(kind: Kind) {
  if (kind === 'chat') chatStore.setState({ activeConversationId: PEER })
  else roomStore.setState({ activeRoomJid: ROOM })
}

describe.each<Kind>(['chat', 'room'])('%s cached correction hydration', kind => {
  type LoadMode = 'latest' | 'around' | 'older' | 'newer'
  function load(mode: LoadMode) {
    const store = kind === 'chat' ? chatStore.getState() : roomStore.getState()
    const target = kind === 'chat' ? PEER : ROOM
    if (mode === 'around') return store.loadMessagesAroundFromCache(target, { id: 'original' })
    if (mode === 'older') return store.loadOlderMessagesFromCache(target)
    if (mode === 'newer') return store.loadNewerMessagesFromCache(target)
    return store.loadMessagesFromCache(target)
  }

  function blockRead(mode: LoadMode) {
    const started = deferred()
    const release = deferred()
    const block = <A extends unknown[], T>(read: (...args: A) => Promise<T>) => async (...args: A) => {
      const result = await read(...args)
      started.resolve()
      await release.promise
      return result
    }
    if (kind === 'chat') {
      if (mode === 'around') vi.spyOn(cache, 'getMessagesAround').mockImplementationOnce(block(cache.getMessagesAround))
      else vi.spyOn(cache, 'getMessages').mockImplementationOnce(block(cache.getMessages))
    } else {
      if (mode === 'around') vi.spyOn(cache, 'getRoomMessagesAround').mockImplementationOnce(block(cache.getRoomMessagesAround))
      else vi.spyOn(cache, 'getRoomMessages').mockImplementationOnce(block(cache.getRoomMessages))
    }
    return { started, release }
  }

  it.each(['latest', 'around', 'older', 'newer'] as const)('installs a sole completed cache-only correction after a stale %s read', async mode => {
    setStorageScopeJid(SELF)
    const h = harness(kind)
    const base = original(kind)
    await save(kind, base)
    seedPreview(kind, base)
    if (mode === 'older' || mode === 'newer') {
      const anchor = { ...base, id: 'anchor', stanzaId: 'archive-anchor', body: 'anchor content', timestamp: new Date(base.timestamp.getTime() + (mode === 'older' ? 1000 : -1000)) }
      seed(kind, [anchor])
    }
    const splitRead = () => {
      const started = deferred(), release = deferred()
      const read = async () => {
        const before = { before: new Date(base.timestamp.getTime() + 1), limit: 51 }
        const after = { after: base.timestamp }
        const older = kind === 'chat' ? await cache.getMessages(PEER, before) : await cache.getRoomMessages(ROOM, before)
        started.resolve()
        await release.promise
        const newer = kind === 'chat' ? await cache.getMessages(PEER, after) : await cache.getRoomMessages(ROOM, after)
        return [...older, ...newer]
      }
      if (kind === 'chat') vi.spyOn(cache, 'getMessagesAround').mockImplementationOnce(async () => await read() as StoredMessage[])
      else vi.spyOn(cache, 'getRoomMessagesAround').mockImplementationOnce(async () => await read() as StoredRoomMessage[])
      return { started, release }
    }
    const read = mode === 'around' ? splitRead() : blockRead(mode)
    const loading = load(mode)
    await read.started.promise
    await h.live({ id: 'c1', body: 'sole completed correction', authoredAt: FAST })
    expect(resident(kind)).toBeUndefined()
    expect((kind === 'chat' ? await cache.getMessages(PEER) : await cache.getRoomMessages(ROOM, {}))[0].body).toBe('sole completed correction')
    read.release.resolve()
    const loaded = await loading
    const expected = {
      id: base.id, stanzaId: base.stanzaId, timestamp: base.timestamp,
      body: 'sole completed correction', isEdited: true,
      correctionTimestamp: Date.parse(FAST), correctionStanzaIds: ['sid-c1'],
    }
    expect(loaded.find(row => row.id === base.id)).toMatchObject(expected)
    expect(resident(kind)).toMatchObject(expected)
    if (mode === 'older') expect(preview(kind)?.body).toBe('anchor content')
    else expect(preview(kind)).toMatchObject(expected)
    if (kind === 'room') expect(roomStore.getState().rooms.get(ROOM)?.lastMessage).toEqual(preview(kind))
    expect(await searchIndex.search('sole')).toHaveLength(1)
    expect(await searchIndex.search('original')).toEqual([])
    expect(await reload(kind)).toMatchObject(expected)
  })

  it.each(['latest', 'around'] as const)('reconciles a cached edit with a resident original on %s loading', async mode => {
    const h = harness(kind)
    const base = original(kind)
    await save(kind, base)
    await h.archive([{ id: 'c2', body: 'cached current edit', at: T2 }])
    seed(kind, [base])
    seedPreview(kind, base)

    if (kind === 'chat') {
      if (mode === 'latest') await chatStore.getState().loadMessagesFromCache(PEER)
      else await chatStore.getState().loadMessagesAroundFromCache(PEER, { id: base.id })
    } else {
      if (mode === 'latest') await roomStore.getState().loadMessagesFromCache(ROOM)
      else await roomStore.getState().loadMessagesAroundFromCache(ROOM, { id: base.id, occupantId: 'peer-occupant' })
    }

    expect(resident(kind)).toMatchObject({
      id: base.id, stanzaId: base.stanzaId, timestamp: base.timestamp,
      body: 'cached current edit', isEdited: true,
      correctionStanzaIds: ['sid-c2'],
      correctionRevision: { archiveTimestamp: Date.parse(T2) },
    })
    expect(preview(kind)?.body).toBe('cached current edit')
    if (kind === 'room') expect(roomStore.getState().rooms.get(ROOM)?.lastMessage).toEqual(preview(kind))
    expect(await searchIndex.search('cached')).toHaveLength(1)
    expect((await reload(kind)).body).toBe('cached current edit')
  })

  it.each(['latest', 'around'] as const)('preserves a newer resident edit and reactions during %s hydration', async mode => {
    const h = harness(kind)
    const base = original(kind)
    await save(kind, base)
    await h.archive([{ id: 'c1', body: 'older cached edit', at: T1 }])
    seed(kind, [base])
    const read = blockRead(mode)
    const loading = load(mode)
    await read.started.promise
    await h.archive([{ id: 'c2', body: 'newer resident edit', at: T2 }])
    const current = { ...resident(kind)!, reactions: { '👍': ['someone'] } }
    seed(kind, [current]); seedPreview(kind, current)
    read.release.resolve()
    await loading
    expect(resident(kind)).toMatchObject({ body: current.body, reactions: current.reactions, correctionRevision: current.correctionRevision })
    expect(preview(kind)?.body).toBe(current.body)
    const settled = resident(kind)
    await load(mode)
    const hydrated = resident(kind)
    await load(mode)
    expect(resident(kind)).toBe(hydrated)
    expect(resident(kind)?.reactions).toBe(settled?.reactions)
  })

  it('repairs a stale preview when the current edit is already resident', async () => {
    const h = harness(kind)
    const base = original(kind)
    await save(kind, base)
    await h.archive([{ id: 'c2', body: 'current edit', at: T2 }])
    const current = (kind === 'chat' ? await cache.getMessages(PEER) : await cache.getRoomMessages(ROOM, {}))[0]
    seed(kind, [current]); seedPreview(kind, base)
    await load('latest')
    expect(resident(kind)?.body).toBe('current edit')
    expect(preview(kind)?.body).toBe('current edit')
    if (kind === 'room') expect(roomStore.getState().rooms.get(ROOM)?.lastMessage).toEqual(preview(kind))
  })

  it.each(['older', 'newer'] as const)('reconciles an original that becomes resident during %s pagination', async mode => {
    const h = harness(kind)
    const base = original(kind)
    await save(kind, base)
    await h.archive([{ id: 'c2', body: 'cached current edit', at: T2 }])
    const anchor = { ...base, id: 'anchor', stanzaId: 'archive-anchor', body: 'another message', timestamp: new Date(base.timestamp.getTime() + (mode === 'older' ? 1000 : -1000)) }
    seed(kind, [anchor]); seedPreview(kind, anchor)
    const read = blockRead(mode)
    const loading = load(mode)
    await read.started.promise
    seed(kind, mode === 'older' ? [base, anchor] : [anchor, base])
    if (mode === 'newer') seedPreview(kind, base)
    read.release.resolve()
    await loading
    expect(resident(kind)).toMatchObject({ id: base.id, stanzaId: base.stanzaId, timestamp: base.timestamp, body: 'cached current edit' })
    expect(preview(kind)?.body).toBe(mode === 'older' ? anchor.body : 'cached current edit')
    if (kind === 'room') expect(roomStore.getState().rooms.get(ROOM)?.lastMessage).toEqual(preview(kind))
  })

  it.each(['account round trip', 'store reset'] as const)('discards durable hydration reconciliation after a %s', async change => {
    setStorageScopeJid(SELF)
    const base = original(kind)
    await save(kind, base)
    const started = deferred(), release = deferred()
    const block = <A extends unknown[], T>(read: (...args: A) => Promise<T>) => async (...args: A) => {
      const result = await read(...args)
      started.resolve()
      await release.promise
      return result
    }
    if (kind === 'chat') vi.spyOn(cache, 'reconcileChatHistoryMessages').mockImplementationOnce(block(cache.reconcileChatHistoryMessages))
    else vi.spyOn(cache, 'reconcileRoomHistoryMessages').mockImplementationOnce(block(cache.reconcileRoomHistoryMessages))
    const loading = load('around')
    await started.promise
    if (change === 'account round trip') {
      setStorageScopeJid('other@example.test'); setStorageScopeJid(SELF)
    } else if (kind === 'chat') {
      chatStore.getState().reset()
      chatStore.getState().addConversation({ id: PEER, name: 'Peer', type: 'chat', unreadCount: 0 })
    } else {
      roomStore.getState().reset()
      roomStore.getState().addRoom(createMockRoom(ROOM, { nickname: 'Peer', joined: true }))
    }
    const replacement = { ...base, body: 'replacement state' }
    seed(kind, [replacement]); seedPreview(kind, replacement)
    release.resolve()
    expect(await loading).toEqual([])
    expect(resident(kind)).toBe(replacement)
    expect(preview(kind)?.body).toBe(replacement.body)
  })

  describe.each(['latest', 'around', 'older', 'newer'] as const)('%s pending read', mode => {
    it.each(['account round trip', 'store reset'] as const)('discards a completed read after a %s', async change => {
      setStorageScopeJid(SELF)
      const base = original(kind)
      await save(kind, base)
      const anchor = { ...base, id: 'anchor', stanzaId: 'archive-anchor', timestamp: new Date(base.timestamp.getTime() + (mode === 'older' ? 1000 : -1000)) }
      seed(kind, [anchor])
      const read = blockRead(mode)
      const loading = load(mode)
      await read.started.promise
      if (change === 'account round trip') {
        setStorageScopeJid('other@example.test'); setStorageScopeJid(SELF)
      } else if (kind === 'chat') {
        chatStore.getState().reset()
        chatStore.getState().addConversation({ id: PEER, name: 'Peer', type: 'chat', unreadCount: 0 })
      } else {
        roomStore.getState().reset()
        roomStore.getState().addRoom(createMockRoom(ROOM, { nickname: 'Peer', joined: true }))
      }
      const replacement = { ...base, body: 'replacement state' }
      seed(kind, [replacement]); seedPreview(kind, replacement)
      read.release.resolve()
      expect(await loading).toEqual([])
      expect(resident(kind)).toBe(replacement)
      expect(preview(kind)?.body).toBe(replacement.body)
    })
  })
})

describe.each<Kind>(['chat', 'room'])('%s resident correction handoffs', kind => {
  it('keeps legacy revision identity through an empty-window load and a second known replay', async () => {
    const h = harness(kind)
    activate(kind)
    const legacy: Row = { ...original(kind), body: 'legacy current c3', isEdited: true, correctionStanzaIds: ['sid-c1', 'sid-c2', 'sid-c3'] }
    await save(kind, legacy); seed(kind, [])
    const [returned] = await h.archive([{ id: 'c1', body: 'older c1', at: T1 }], true)
    expect(returned.body).toBe(legacy.body)
    expect(returned.correctionRevision).toBeUndefined()
    expect(resident(kind)?.correctionRevision).toBeUndefined()
    await h.archive([{ id: 'c2', body: 'older c2', at: T2 }])
    expect(resident(kind)).toMatchObject({ body: legacy.body, timestamp: legacy.timestamp })
    expect(resident(kind)?.correctionRevision).toBeUndefined()
    expect(preview(kind)?.body).toBe(legacy.body)
    expect(preview(kind)?.correctionRevision).toBeUndefined()
    const loaded = await reload(kind)
    expect(loaded.body).toBe(legacy.body)
    expect(loaded.correctionRevision).toBeUndefined()
    expect(await searchIndex.search('older')).toEqual([])
  })

  it.each(['new', 'older', 'metadata'] as const)('replays a pending retraction when a %s update learns its alias', async mode => {
    const h = harness(kind)
    activate(kind)
    await save(kind, original(kind)); seed(kind, [original(kind)])
    if (mode !== 'new') await h.archive([{ id: 'c2', body: 'newest secret', at: T2 }])
    seedPreview(kind, resident(kind)!)
    await searchIndex.indexMessage(resident(kind)!)
    if (kind === 'chat') h.emitSDK('chat:retraction-pending', { conversationId: PEER, targetId: 'sid-c1', actorJid: PEER })
    else h.emitSDK('room:retraction-pending', { roomJid: ROOM, targetId: 'sid-c1', actorJid: `${ROOM}/Peer`, actorOccupantId: 'peer-occupant' })
    await drain()
    expect(resident(kind)?.isRetracted).not.toBe(true)
    if (mode === 'metadata') {
      if (kind === 'chat') h.emitSDK('chat:message-updated', { conversationId: PEER, messageId: 'original', updates: { correctionStanzaIds: ['sid-c1'] }, correctionActor: { actorJid: PEER } })
      else h.emitSDK('room:message-updated', { roomJid: ROOM, messageId: 'original', updates: { correctionStanzaIds: ['sid-c1'] }, correctionActor: { actorJid: `${ROOM}/Peer`, actorOccupantId: 'peer-occupant' } })
      await drain()
    } else await h.archive([{ id: 'c1', body: 'corrected secret', at: T1 }])
    expect(resident(kind)?.isRetracted).toBe(true)
    expect(preview(kind)?.isRetracted).toBe(true)
    expect((await reload(kind))).toMatchObject({ isRetracted: true, body: '' })
    expect(await searchIndex.search('secret')).toEqual([])
    expect(await searchIndex.search('original')).toEqual([])
  })

  it.each(['author', 'occupant'] as const)('rejects a foreign %s pending retraction after learning a correction alias', async foreign => {
    const h = harness(kind)
    activate(kind)
    await save(kind, original(kind)); seed(kind, [original(kind)])
    seedPreview(kind, original(kind))
    if (kind === 'chat') h.emitSDK('chat:retraction-pending', { conversationId: PEER, targetId: 'sid-c1', actorJid: 'foreign@example.test' })
    else h.emitSDK('room:retraction-pending', { roomJid: ROOM, targetId: 'sid-c1', actorJid: foreign === 'author' ? `${ROOM}/Foreign` : `${ROOM}/Peer`, ...(foreign === 'occupant' ? { actorOccupantId: 'foreign-occupant' } : {}) })
    await drain()
    await h.archive([{ id: 'c1', body: 'corrected secret', at: T1 }])
    expect(resident(kind)?.isRetracted).not.toBe(true)
    expect(preview(kind)?.isRetracted).not.toBe(true)
    expect(preview(kind)?.body).toBe('corrected secret')
    expect(await reload(kind)).toMatchObject({ body: 'corrected secret' })
    expect(await searchIndex.search('secret')).toHaveLength(1)
  })

  it('selects outgoing predecessors after asynchronous sending completes', async () => {
    const h = harness(kind, true)
    activate(kind)
    await save(kind, original(kind, true)); seed(kind, [original(kind, true)])
    await h.archive([{ id: 'c0', body: 'baseline', at: T0 }])
    const started = deferred(), release = deferred()
    if (kind === 'chat') {
      const manager = new E2EEManager({ storage: new InMemoryStorageBackend(), account: { jid: SELF }, xmpp: {
        sendStanza: async () => {}, queryDisco: async () => ({ features: [], identities: [] }),
        publishPEP: async () => {}, retractPEP: async () => {}, deletePEP: async () => {}, queryPEP: async () => [], subscribePEP: () => ({ unsubscribe() {} }),
      } })
      await manager.register(new DummyPlaintextPlugin())
      const encrypt = manager.encryptOutbound.bind(manager)
      vi.spyOn(manager, 'encryptOutbound').mockImplementation(async (...args) => { started.resolve(); await release.promise; return encrypt(...args) })
      h.deps.getE2EEManager = () => manager
    } else {
      const send = h.deps.sendStanza
      h.deps.sendStanza = async stanza => { started.resolve(); await release.promise; return send(stanza) }
    }
    const outgoing = h.outgoing('successfully sent c2')
    await started.promise
    try {
      await h.archive([{ id: 'c1', body: 'other device c1', at: T1, authoredAt: FAST }])
      expect(resident(kind)?.body).toBe('other device c1')
    } finally { release.resolve() }
    const id = await outgoing
    expect(resident(kind)).toMatchObject({ body: 'successfully sent c2', id: 'original', stanzaId: 'archive-original', timestamp: new Date(T0), correctionRevision: { afterArchiveTimestamp: Date.parse(T1), ids: expect.arrayContaining([`id:${id}`]), supersedes: expect.arrayContaining(['stanza:sid-c1']) } })
    expect(resident(kind)?.correctionTimestamp).toBeUndefined()
    if (kind === 'chat') expect(h.sent.at(-1)?.getChild('plain', 'urn:fluux:e2ee-dummy:0')).toBeDefined()
    await h.archive([{ id: 'c1', body: 'other device c1', at: T1, authoredAt: FAST }], true)
    expect(preview(kind)?.body).toBe('successfully sent c2')
    expect(await reload(kind)).toMatchObject({ body: 'successfully sent c2', timestamp: new Date(T0), stanzaId: 'archive-original' })
    expect(await searchIndex.search('successfully')).toHaveLength(1)
    expect(await searchIndex.search('other')).toEqual([])
  })
})

describe('live cache-only chat corrections', () => {
  it('updates the canonical original and preview before stale archive replay', async () => {
    const h = harness('chat')
    activate('chat')
    const base = original('chat') as StoredMessage
    await save('chat', base); seedPreview('chat', base); await searchIndex.indexMessage(base)
    const before = (await cache.findChatMessageCopies(PEER, base))[0]
    expect(resident('chat')).toBeUndefined()
    await h.live({ id: 'c2', body: 'live newest secret', at: T2 })
    expect(resident('chat')).toBeUndefined()
    expect(h.events.filter(({ event }) => event === 'chat:message')).toHaveLength(0)
    const copies = await cache.findChatMessageCopies(PEER, base)
    expect(copies).toHaveLength(1)
    expect(copies[0].cacheKey).toBe(before.cacheKey)
    expect(copies[0].message).toMatchObject({ id: base.id, stanzaId: base.stanzaId, timestamp: base.timestamp, body: 'live newest secret', correctionStanzaIds: ['sid-c2'], correctionRevision: { ids: expect.arrayContaining(['stanza:sid-c2', 'origin:c2']) } })
    expect(preview('chat')?.body).toBe('live newest secret')
    expect(await searchIndex.search('original')).toEqual([])
    expect(await searchIndex.search('secret')).toHaveLength(1)
    await h.archive([{ id: 'c1', body: 'stale c1', at: T1 }], true)
    expect(resident('chat')?.body).toBe('live newest secret')
    expect(preview('chat')?.body).toBe('live newest secret')
    expect(await reload('chat')).toMatchObject({ id: base.id, stanzaId: base.stanzaId, timestamp: base.timestamp, body: 'live newest secret', correctionStanzaIds: ['sid-c1', 'sid-c2'] })
    expect(await searchIndex.search('stale')).toEqual([])
  })

  it('retains the existing message fallback for a truly unknown target', async () => {
    const h = harness('chat')
    activate('chat')
    h.stores.roster.hasContact.mockReturnValue(true)
    h.stores.chat.hasConversation.mockReturnValue(true)
    await h.live({ id: 'c1', body: 'unknown original correction', at: T1 })
    expect(h.events.filter(({ event }) => event === 'chat:message')).toHaveLength(1)
    expect(resident('chat')).toMatchObject({ id: 'original', body: 'unknown original correction', isEdited: true })
    expect(await reload('chat')).toMatchObject({ id: 'original', body: 'unknown original correction', timestamp: new Date(T1) })
  })

  it('rejects an authoritative cached reference owned by another author', async () => {
    const h = harness('chat')
    activate('chat')
    const foreign = original('chat', true)
    await save('chat', foreign)
    await h.live({ id: 'c1', body: 'forged correction', at: T1, targetId: foreign.stanzaId })
    expect(h.events.filter(({ event }) => event === 'chat:message')).toHaveLength(0)
    expect(resident('chat')).toBeUndefined()
    expect(await cache.getMessages(PEER)).toMatchObject([{ body: 'original text', from: foreign.from }])
    expect(await searchIndex.search('forged')).toEqual([])
  })

  it('keeps an unknown sender target distinct from another author reusing its client ID', async () => {
    const h = harness('chat')
    activate('chat')
    h.stores.roster.hasContact.mockReturnValue(true)
    h.stores.chat.hasConversation.mockReturnValue(true)
    const foreign = original('chat', true)
    await save('chat', foreign)
    await h.live({ id: 'c1', body: 'unknown sender correction', at: T1 })
    expect(h.events.filter(({ event }) => event === 'chat:message')).toHaveLength(1)
    expect(resident('chat')).toMatchObject({ id: foreign.id, from: PEER, body: 'unknown sender correction' })
    cache._resetDBForTesting()
    const messages = await cache.getMessages(PEER)
    expect(messages).toHaveLength(2)
    expect(messages.find(message => message.from === SELF)).toMatchObject(foreign)
    expect(messages.find(message => message.from === PEER)).toMatchObject({ id: foreign.id, stanzaId: 'sid-c1', timestamp: new Date(T1), body: 'unknown sender correction' })
    expect(await searchIndex.search('unknown')).toHaveLength(1)
  })

  it.each([false, true])('keeps a deferred live correction in its account; target cached: %s', async cached => {
    const h = harness('chat')
    activate('chat')
    setStorageScopeJid(SELF)
    if (cached) { await save('chat', original('chat')); seedPreview('chat', original('chat')) }
    const apply = vi.mocked(cache.applyChatCorrection).getMockImplementation()!
    const started = deferred(), release = deferred()
    vi.mocked(cache.applyChatCorrection).mockImplementationOnce((...args) => {
      const pending = (async () => {
        const result = await apply(...args)
        started.resolve(); await release.promise
        return result
      })()
      writes.push(pending)
      return pending
    })
    const work = h.live({ id: 'c2', body: 'account secret', at: T2 })
    await started.promise
    setStorageScopeJid('other@example.test')
    chatStore.getState().switchAccount('other@example.test')
    release.resolve(); await work; await drain()
    expect(chatStore.getState().messages.size).toBe(0)
    expect(await cache.getMessages(PEER)).toEqual([])
    expect(await searchIndex.search('secret')).toEqual([])
    expect(h.events.filter(({ event }) => event === 'chat:message')).toHaveLength(0)
    setStorageScopeJid(SELF)
    expect(await searchIndex.search('secret')).toHaveLength(cached ? 1 : 0)
  })
})

function deferCorrectionCompletion(kind: Kind) {
  const started = deferred(), release = deferred()
  const wrap = <A extends unknown[], R>(apply: (...args: A) => Promise<R>) => (...args: A) => {
    const work = (async () => {
      const result = await apply(...args)
      started.resolve()
      await release.promise
      return result
    })()
    writes.push(work)
    return work
  }
  if (kind === 'chat') vi.mocked(cache.applyChatCorrection).mockImplementationOnce(wrap(vi.mocked(cache.applyChatCorrection).getMockImplementation()!))
  else vi.mocked(cache.applyRoomCorrection).mockImplementationOnce(wrap(vi.mocked(cache.applyRoomCorrection).getMockImplementation()!))
  return { started, release }
}

function loadWindow(kind: Kind) {
  return kind === 'chat' ? chatStore.getState().loadMessagesFromCache(PEER) : roomStore.getState().loadMessagesFromCache(ROOM)
}

function indexedBase(kind: Kind, edited: boolean): Row {
  return { ...original(kind), ...(edited && { isEdited: true, body: 'baseline correction', correctionRevision: { ids: ['stanza:sid-c0'], supersedes: [], archiveTimestamp: Date.parse(T0) } }) }
}

describe.each<Kind>(['chat', 'room'])('%s correction completion ownership', kind => {
  it.each([
    ['live', false, false], ['live', false, true], ['live', true, false], ['live', true, true],
    ['mam', false, false], ['mam', false, true], ['mam', true, false], ['mam', true, true],
  ] as const)('reconciles activation: %s, edited base %s, intervening edit %s', async (source, edited, intervening) => {
    const h = harness(kind)
    activate(kind)
    const base = indexedBase(kind, edited)
    await save(kind, base); seedPreview(kind, base); await searchIndex.indexMessage(base)
    const readStarted = deferred(), install = deferred()
    if (kind === 'chat') {
      const get = cache.getMessages
      vi.spyOn(cache, 'getMessages').mockImplementationOnce(async (...args) => {
        const rows = await get(...args); readStarted.resolve(); await install.promise; return rows
      })
    } else {
      const get = cache.getRoomMessages
      vi.spyOn(cache, 'getRoomMessages').mockImplementationOnce(async (...args) => {
        const rows = await get(...args); readStarted.resolve(); await install.promise; return rows
      })
    }
    const loading = loadWindow(kind)
    await readStarted.promise
    const completion = deferCorrectionCompletion(kind)
    const c2 = { id: 'c2', body: 'second correction', at: T1 }
    const work = source === 'live' ? h.live(c2) : h.archive([c2])
    await completion.started.promise
    try {
      install.resolve(); await loading
      expect(resident(kind)?.body).toBe(c2.body)
      seed(kind, [base]); seedPreview(kind, base)
      if (intervening) {
        const offset = writes.length
        h.receive({ id: 'c3', body: 'third correction', at: T2 })
        await Promise.all(writes.slice(offset))
        expect(resident(kind)?.body).toBe('third correction')
      }
    } finally { install.resolve(); completion.release.resolve() }
    await work; await drain()
    const expected = intervening ? 'third correction' : 'second correction'
    expect(resident(kind)).toMatchObject({ body: expected, id: base.id, stanzaId: base.stanzaId, timestamp: base.timestamp })
    expect(preview(kind)?.body).toBe(expected)
    expect(await reload(kind)).toMatchObject({ body: expected, id: base.id, stanzaId: base.stanzaId, timestamp: base.timestamp })
    expect(await searchIndex.search(intervening ? 'second' : 'third')).toEqual([])
    expect(await searchIndex.search(intervening ? 'third' : 'second')).toHaveLength(1)
  })

  it.each(['other-author', 'other-archive'] as const)('does not change an unrelated %s resident or preview sharing the client ID', async collision => {
    const h = harness(kind)
    activate(kind)
    const base = original(kind)
    await save(kind, base); await searchIndex.indexMessage(base)
    const completion = deferCorrectionCompletion(kind)
    const work = h.live({ id: 'c2', body: 'corrected cached secret' })
    await completion.started.promise
    const other: Row = {
      ...base, stanzaId: 'different-archive', originId: 'different-origin', body: 'unrelated visible text',
      timestamp: new Date(T2), reactions: { '👍': ['someone'] },
      ...(collision === 'other-author' ? kind === 'chat' ? { from: SELF, isOutgoing: true } : { occupantId: 'other-occupant' } : {}),
    }
    const persistOther = kind === 'chat' || collision === 'other-author'
    try {
      seed(kind, [other]); seedPreview(kind, other)
      if (persistOther) await save(kind, other)
    }
    finally { completion.release.resolve() }
    await work; await drain()
    expect(resident(kind)).toEqual(other)
    expect(preview(kind)).toEqual(other)
    const rows = kind === 'chat' ? await cache.getMessages(PEER) : await cache.getRoomMessages(ROOM, {})
    expect(rows).toHaveLength(persistOther ? 2 : 1)
    expect(rows.find(row => row.stanzaId === base.stanzaId)?.body).toBe('corrected cached secret')
    if (persistOther) expect(rows.find(row => row.stanzaId === other.stanzaId)).toMatchObject(other)
    expect(await searchIndex.search('secret')).toHaveLength(1)
  })

  it('preserves preview identity, timestamps and unrelated fields when its correction is applied', async () => {
    const h = harness(kind)
    const base = original(kind)
    await save(kind, base)
    const shown = { ...base, timestamp: new Date(T1), reactions: { '👍': ['someone'] }, linkPreview: { url: 'https://example.test', title: 'Preview' } }
    seedPreview(kind, shown)
    await h.live({ id: 'c2', body: 'new correction' })
    expect(preview(kind)).toMatchObject({ ...shown, body: 'new correction' })
    expect(await reload(kind)).toMatchObject({ body: 'new correction', timestamp: base.timestamp })
  })

  it.each(['account', 'session'] as const)('does not complete into a replacement %s', async change => {
    const h = harness(kind)
    setStorageScopeJid(SELF)
    await save(kind, original(kind))
    const completion = deferCorrectionCompletion(kind)
    const work = h.live({ id: 'c2', body: 'initiating account secret' })
    await completion.started.promise
    try {
      if (change === 'account') setStorageScopeJid('other@example.test')
      if (kind === 'chat') {
        chatStore.getState().reset()
        chatStore.getState().addConversation({ id: PEER, name: 'Peer', type: 'chat', unreadCount: 0 })
      } else {
        roomStore.getState().reset()
        roomStore.getState().addRoom(createMockRoom(ROOM, { nickname: 'Peer', joined: true }))
      }
      const other = { ...original(kind), body: 'replacement state' }
      seed(kind, [other]); seedPreview(kind, other)
    } finally { completion.release.resolve() }
    await work; await drain()
    expect(resident(kind)?.body).toBe('replacement state')
    expect(preview(kind)?.body).toBe('replacement state')
    if (change === 'account') {
      expect(await searchIndex.search('secret')).toEqual([])
      expect(kind === 'chat' ? await cache.getMessages(PEER) : await cache.getRoomMessages(ROOM, {})).toEqual([])
    }
    setStorageScopeJid(SELF)
    expect(await searchIndex.search('secret')).toHaveLength(kind === 'chat' && change === 'session' ? 0 : 1)
  })

  it('keeps recovered current ciphertext content when an older completion arrives', async () => {
    const h = harness(kind)
    activate(kind)
    const base = { ...indexedBase(kind, true), encryptedPayload: 'baseline ciphertext' }
    await save(kind, base); seedPreview(kind, base)
    const completion = deferCorrectionCompletion(kind)
    const work = h.live({ id: 'c2', body: 'older pending correction', at: T1 })
    await completion.started.promise
    try {
      seed(kind, [base])
      const offset = writes.length
      h.receive({ id: 'c3', body: 'recovered newer content', at: T2, authoredAt: FAST })
      await Promise.all(writes.slice(offset))
    } finally { completion.release.resolve() }
    await work; await drain()
    expect(resident(kind)).toMatchObject({ body: 'recovered newer content', correctionTimestamp: Date.parse(FAST), correctionTimestampSource: 'authored' })
    expect(preview(kind)?.body).toBe('recovered newer content')
    expect(await reload(kind)).toMatchObject({ body: 'recovered newer content', correctionTimestamp: Date.parse(FAST) })
    expect(await searchIndex.search('older')).toEqual([])
  })
})

describe('live room correction cache handoff', () => {
  it('uses room authority and stable occupant identity outside RAM', async () => {
    const h = harness('room')
    activate('room')
    const base = indexedBase('room', true) as StoredRoomMessage
    await save('room', base); seedPreview('room', base)
    const before = (await cache.findRoomMessageCopies(ROOM, base))[0]
    await h.live({ id: 'c2', body: 'live room correction', at: T1, from: `${ROOM}/NewNick` })
    expect(h.events.filter(({ event }) => event === 'room:message')).toEqual([])
    const after = (await cache.findRoomMessageCopies(ROOM, base))[0]
    expect(after.cacheKey).toBe(before.cacheKey)
    expect(after.message).toMatchObject({ body: 'live room correction', id: base.id, stanzaId: base.stanzaId, timestamp: base.timestamp, occupantId: base.occupantId,
      correctionStanzaIds: ['sid-c2'], correctionRevision: { ids: expect.arrayContaining(['stanza:sid-c2', 'origin:c2']), supersedes: ['stanza:sid-c0'], afterArchiveTimestamp: Date.parse(T0) } })
    expect(preview('room')?.body).toBe('live room correction')
    await h.archive([{ id: 'c0', body: 'baseline correction', at: T0 }], true)
    expect(await reload('room')).toMatchObject({ body: 'live room correction', timestamp: base.timestamp, occupantId: base.occupantId })
    expect(await searchIndex.search('live')).toHaveLength(1)
  })

  it.each(['unknown', 'weak-foreign', 'authoritative-foreign'] as const)('preserves scoped missing-target behavior: %s', async target => {
    const h = harness('room')
    activate('room')
    const foreign = { ...original('room'), occupantId: 'different-occupant' } as StoredRoomMessage
    if (target !== 'unknown') await save('room', foreign)
    await h.live({ id: 'c2', body: 'new occupant correction', targetId: target === 'authoritative-foreign' ? foreign.stanzaId : foreign.id })
    const rows = await cache.getRoomMessages(ROOM, {})
    if (target === 'authoritative-foreign') {
      expect(h.events.filter(({ event }) => event === 'room:message')).toEqual([])
      expect(rows).toMatchObject([foreign])
      expect(await searchIndex.search('occupant')).toEqual([])
    } else {
      expect(h.events.filter(({ event }) => event === 'room:message')).toHaveLength(1)
      expect(rows.find(row => row.occupantId === 'peer-occupant')?.body).toBe('new occupant correction')
      if (target === 'weak-foreign') expect(rows.find(row => row.occupantId === foreign.occupantId)).toMatchObject(foreign)
    }
  })
})

it('routes a chat correction past a resident foreign client-ID collision to its cached author', async () => {
  const h = harness('chat')
  activate('chat')
  const base = indexedBase('chat', true)
  const foreign = { ...original('chat', true), stanzaId: 'outgoing-archive', timestamp: new Date(T2) }
  await save('chat', base, foreign); seed('chat', [foreign]); seedPreview('chat', foreign)
  await h.live({ id: 'c2', body: 'cached peer correction', at: T1 })
  expect(resident('chat')).toEqual(foreign)
  expect(preview('chat')).toEqual(foreign)
  expect(h.events.filter(({ event }) => event === 'chat:message')).toEqual([])
  const rows = await cache.getMessages(PEER)
  expect(rows).toHaveLength(2)
  expect(rows.find(row => row.from === PEER)).toMatchObject({ body: 'cached peer correction', stanzaId: base.stanzaId, timestamp: base.timestamp })
  expect(await searchIndex.search('cached')).toHaveLength(1)
})

describe('equal-date room author ordering', () => {
  it.each([[false, false], [true, false], [false, true], [true, true]] as const)('follows a stable occupant across nick changes and target aliases, original in page %s, return to original %s', async (inPage, returnToOriginal) => {
    const h = harness('room')
    activate('room')
    await save('room', original('room'))
    const edits = [
      { id: 'c1', body: 'old nick edit', at: T1, from: `${ROOM}/OldNick` },
      { id: 'c2', body: 'new nick edit', at: T1, from: `${ROOM}/NewNick`, targetId: 'sid-c1' },
    ]
    if (returnToOriginal) edits.push({ id: 'c3', body: 'third nick edit', at: T1, from: `${ROOM}/ThirdNick`, targetId: 'original' })
    await h.archive(edits, inPage)
    const expected = returnToOriginal ? 'third nick edit' : 'new nick edit'
    expect(await reload('room')).toMatchObject({ body: expected, correctionRevision: { ids: expect.arrayContaining([returnToOriginal ? 'stanza:sid-c3' : 'stanza:sid-c2']), supersedes: expect.arrayContaining(returnToOriginal ? ['stanza:sid-c1', 'stanza:sid-c2'] : ['stanza:sid-c1']) } })
    await h.archive([edits[0]], true)
    expect(resident('room')?.body).toBe(expected)
    expect(await reload('room')).toMatchObject({ body: expected })
  })

  it('keeps reused nicknames with different occupant IDs in separate order groups', async () => {
    const h = harness('room')
    await save('room', original('room'))
    await h.archive([
      { id: 'c1', body: 'foreign nick edit', at: T1, occupantId: 'foreign-occupant' },
      { id: 'c2', body: 'authorized nick edit', at: T1 },
    ], true)
    const row = await reload('room')
    expect(row.body).toBe('authorized nick edit')
    expect(row.correctionRevision?.supersedes).not.toContain('stanza:sid-c1')
    expect(row.correctionStanzaIds).not.toContain('sid-c1')
  })
})

describe.each<Kind>(['chat', 'room'])('%s delayed durable search completion', kind => {
  it('serializes overlapping durable replacements through their index insertion', async () => {
    setStorageScopeJid(SELF)
    const base = original(kind)
    await save(kind, base)
    await searchIndex.indexMessage(base)
    const apply = async (id: string, body: string) => {
      const updates = { body, isEdited: true, liveCorrection: true, correctionRevision: { ids: [`stanza:${id}`], supersedes: [] } }
      return kind === 'chat'
        ? await cache.applyChatCorrection(PEER, base.id, updates, { actorJid: base.from })
        : await cache.applyRoomCorrection(ROOM, base.id, updates, { actorJid: base.from, actorOccupantId: 'peer-occupant' })
    }
    const first = await apply('c1', 'first searchable revision')
    const firstInsert = deferred(), secondInsert = deferred()
    const releaseFirst = deferred(), releaseSecond = deferred()
    const checkRetractions = cache.areRetractedInCache
    vi.spyOn(cache, 'areRetractedInCache').mockImplementation(async (messages, scope) => {
      if (messages[0]?.body === 'first searchable revision') {
        firstInsert.resolve()
        await releaseFirst.promise
      } else if (messages[0]?.body === 'second searchable revision') {
        secondInsert.resolve()
        await releaseSecond.promise
      }
      return checkRetractions(messages, scope)
    })
    const firstUpdate = searchIndex.updateMessage(first!)
    await firstInsert.promise
    const second = await apply('c2', 'second searchable revision')
    const secondUpdate = searchIndex.updateMessage(second!)
    try {
      await Promise.race([secondInsert.promise, new Promise(resolve => setTimeout(resolve, 50))])
      releaseFirst.resolve()
      await firstUpdate
    } finally {
      releaseFirst.resolve()
      releaseSecond.resolve()
      await Promise.all([firstUpdate, secondUpdate])
    }
    expect(await searchIndex.search('second')).toHaveLength(1)
    expect(await searchIndex.search('first')).toEqual([])
    expect((await reload(kind)).body).toBe('second searchable revision')
  })

  it('indexes the current cache revision when another cache-only edit completed first', async () => {
    const h = harness(kind)
    await save(kind, indexedBase(kind, true))
    const completion = deferCorrectionCompletion(kind)
    const work = h.live({ id: 'c2', body: 'second archived content', at: T1 })
    await completion.started.promise
    try {
      const offset = writes.length
      h.receive({ id: 'c3', body: 'third archived content', at: T2 })
      await Promise.all(writes.slice(offset))
    } finally { completion.release.resolve() }
    await work; await drain()
    expect(await reload(kind)).toMatchObject({ body: 'third archived content' })
    expect(await searchIndex.search('second')).toEqual([])
    expect(await searchIndex.search('third')).toHaveLength(1)
  })
})

describe.each<Kind>(['chat', 'room'])('%s correction identity and older activation snapshots', kind => {
  it('keeps distinct archive revisions when the sender reuses its client ID without an origin ID', async () => {
    const h = harness(kind)
    activate(kind)
    await save(kind, original(kind)); seed(kind, [original(kind)])
    const c1 = { id: 'reused', stanzaId: 's1', omitOriginId: true, body: 'first revision', at: T1, authoredAt: FAST }
    const c2 = { ...c1, stanzaId: 's2', body: 'second revision', at: T2, authoredAt: T1 }
    await h.live(c1)
    const older = structuredClone(resident(kind)!)
    await h.live(c2)
    expect(resident(kind)).toMatchObject({ body: c2.body, correctionTimestamp: Date.parse(T1), correctionRevision: { ids: expect.arrayContaining(['stanza:s2']), archiveTimestamp: Date.parse(T2) } })
    expect(resident(kind)?.correctionRevision?.ids).not.toContain('stanza:s1')
    await save(kind, resident(kind)!, older)
    await h.archive([c1], true)
    expect(await reload(kind)).toMatchObject({ body: c2.body, correctionTimestamp: Date.parse(T1), correctionRevision: { archiveTimestamp: Date.parse(T2) }, correctionStanzaIds: ['s1', 's2'] })
    expect(await searchIndex.search('second')).toHaveLength(1)
    expect(await searchIndex.search('first')).toEqual([])
  })

  it('enriches a live revision and keeps same-date replay distinct despite client-ID reuse', async () => {
    const h = harness(kind)
    activate(kind)
    await save(kind, original(kind)); seed(kind, [original(kind)])
    await h.live({ id: 'reused', body: 'first revision', omitOriginId: true, omitStanzaId: true })
    const c1 = { id: 'reused', body: 'first revision', omitOriginId: true, stanzaId: 's1', at: T1 }
    await h.archive([c1])
    expect(resident(kind)?.correctionRevision?.ids).toEqual(expect.arrayContaining(['id:reused', 'stanza:s1']))
    const c2 = { ...c1, body: 'second revision', stanzaId: 's2' }
    const c3 = { ...c1, body: 'third revision', stanzaId: 's3' }
    await h.archive([c1, c2, c3])
    await h.archive([c2])
    expect(await reload(kind)).toMatchObject({ body: 'third revision', correctionRevision: { ids: expect.arrayContaining(['stanza:s3']), archiveTimestamp: Date.parse(T1) }, correctionStanzaIds: ['s1', 's2', 's3'] })
  })

  it.each([false, true])('accepts a completion over a proven older activation snapshot; intervening newer edit %s', async intervening => {
    const h = harness(kind)
    activate(kind)
    const base = indexedBase(kind, true)
    await save(kind, base); seedPreview(kind, base)
    const read = deferred(), install = deferred()
    if (kind === 'chat') {
      const get = cache.getMessagesAround
      vi.spyOn(cache, 'getMessagesAround').mockImplementationOnce(async (...args) => { const rows = await get(...args); read.resolve(); await install.promise; return rows })
    } else {
      const get = cache.getRoomMessagesAround
      vi.spyOn(cache, 'getRoomMessagesAround').mockImplementationOnce(async (...args) => { const rows = await get(...args); read.resolve(); await install.promise; return rows })
    }
    const loading = kind === 'chat' ? chatStore.getState().loadMessagesAroundFromCache(PEER, { id: base.id })
      : roomStore.getState().loadMessagesAroundFromCache(ROOM, { id: base.id, occupantId: (base as StoredRoomMessage).occupantId })
    await read.promise
    await h.live({ id: 'c1', body: 'first completed edit', at: T1 })
    expect(resident(kind)).toBeUndefined()
    const completion = deferCorrectionCompletion(kind)
    const work = h.live({ id: 'c2', body: 'second completed edit', at: T1 })
    await completion.started.promise
    try {
      install.resolve(); await loading
      expect(resident(kind)?.body).toBe('second completed edit')
      seed(kind, [base]); seedPreview(kind, base)
      if (intervening) {
        const offset = writes.length
        h.receive({ id: 'c3', body: 'third completed edit', at: T2 })
        await Promise.all(writes.slice(offset))
      }
    } finally { install.resolve(); completion.release.resolve() }
    await work; await drain()
    const expected = intervening ? 'third completed edit' : 'second completed edit'
    expect(resident(kind)?.body).toBe(expected)
    expect(preview(kind)?.body).toBe(expected)
    expect(await reload(kind)).toMatchObject({ body: expected, timestamp: base.timestamp, stanzaId: base.stanzaId })
    expect(await searchIndex.search(intervening ? 'third' : 'second')).toHaveLength(1)
    expect(await searchIndex.search(intervening ? 'second' : 'third')).toEqual([])
  })

  it('preserves decryption and archive enrichment of the same revision during completion', async () => {
    const h = harness(kind)
    activate(kind)
    const base = indexedBase(kind, true)
    await save(kind, base); seedPreview(kind, base)
    const completion = deferCorrectionCompletion(kind)
    const edit = { id: 'c2', body: 'locked correction', locked: true, omitOriginId: true, at: T2 }
    const work = h.live({ ...edit, omitStanzaId: true })
    await completion.started.promise
    const blocked = await blockedDecrypt()
    try {
      await loadWindow(kind)
      const engine = new DeferredDecryptEngine({ getManager: () => blocked.manager, getStores: () => h.stores, getOwnBareJid: () => SELF, cache, updateSearchIndex: searchIndex.updateMessage })
      const retry = engine.retryPending()
      await blocked.started.promise
      blocked.release.resolve(); await retry
      const offset = writes.length
      h.receive({ ...edit, at: T2 })
      await Promise.all(writes.slice(offset))
    } finally { blocked.release.resolve(); completion.release.resolve() }
    await work; await drain()
    expect(resident(kind)).toMatchObject({ body: 'stale recovered text', encryptedPayload: undefined, correctionTimestamp: Date.parse(FAST), correctionRevision: { ids: expect.arrayContaining(['stanza:sid-c2']), archiveTimestamp: Date.parse(T2) } })
    expect(preview(kind)?.body).toBe('stale recovered text')
    expect(await reload(kind)).toMatchObject({ body: 'stale recovered text', encryptedPayload: undefined, correctionTimestamp: Date.parse(FAST), correctionRevision: { archiveTimestamp: Date.parse(T2) } })
    expect(await searchIndex.search('recovered')).toHaveLength(1)
  })

  it.each([false, true])('groups known cached target aliases within archive order; separate pages %s', async pages => {
    const h = harness(kind)
    activate(kind)
    const base = { ...original(kind), originId: 'origin-original' }
    await save(kind, base); seedPreview(kind, base)
    const edits = [
      { id: 'c1', body: 'first alias edit', at: T1, targetId: base.id, ...(kind === 'room' && { from: `${ROOM}/OldNick` }) },
      { id: 'c2', body: 'second alias edit', at: T1, targetId: base.originId, ...(kind === 'room' && { from: `${ROOM}/NewNick` }) },
    ]
    const reads = vi.spyOn(IDBIndex.prototype, 'getAll')
    if (pages) await h.archivePages(edits.map(edit => ({ edits: [edit] })), true)
    else await h.archive(edits)
    expect(reads.mock.contexts.filter(index => index instanceof IDBIndex && (index.name === 'conversationId' || index.name === 'roomJid'))).toEqual([])
    expect(await reload(kind)).toMatchObject({ body: 'second alias edit', originId: base.originId, correctionRevision: { supersedes: expect.arrayContaining(['stanza:sid-c1']) } })
    await h.archive([edits[0]])
    expect(await reload(kind)).toMatchObject({ body: 'second alias edit' })
  })

  it('does not infer equal-date order between separate archive queries', async () => {
    const h = harness(kind)
    await save(kind, { ...original(kind), originId: 'origin-original' })
    await h.archive([{ id: 'c1', body: 'first query edit', at: T1 }])
    await h.archive([{ id: 'c2', body: 'second query edit', at: T1, targetId: 'origin-original' }])
    const row = await reload(kind)
    expect(row.body).toBe('first query edit')
    expect(row.correctionRevision?.supersedes).not.toContain('stanza:sid-c2')
  })
})

describe('room correction preview projections', () => {
  it.each([false, true])('keeps both previews current when reopening; resident %s', async inMemory => {
    const h = harness('room')
    activate('room')
    const base = original('room')
    await save('room', base); seedPreview('room', base)
    if (inMemory) seed('room', [base])
    await h.live({ id: 'c2', body: 'current room edit', at: T2 })
    expect(roomStore.getState().rooms.get(ROOM)?.lastMessage?.body).toBe('current room edit')
    expect(preview('room')?.body).toBe('current room edit')
    seed('room', [])
    await roomStore.getState().loadMessagesFromCache(ROOM)
    expect(roomStore.getState().rooms.get(ROOM)?.lastMessage).toEqual(preview('room'))
    expect(preview('room')?.body).toBe('current room edit')
    await h.archive([{ id: 'c1', body: 'old edit', at: T1 }])
    expect(roomStore.getState().rooms.get(ROOM)?.lastMessage).toEqual(preview('room'))
    expect((preview('room') as StoredRoomMessage)?.correctionStanzaIds).toContain('sid-c1')
  })

  it.each([false, true])('keeps pending retractions in both projections; resident %s', async inMemory => {
    const h = harness('room')
    const base = original('room')
    await save('room', base); seedPreview('room', base)
    if (inMemory) seed('room', [base])
    await h.live({ id: 'c2', body: 'current room correction', at: T2 })
    h.emitSDK('room:retraction-pending', { roomJid: ROOM, targetId: 'sid-c1', actorJid: base.from, actorOccupantId: 'peer-occupant' })
    await drain()
    await h.live({ id: 'c1', body: 'retracted corrected content', at: T1 })
    expect(roomStore.getState().rooms.get(ROOM)?.lastMessage?.isRetracted).toBe(true)
    expect(preview('room')?.isRetracted).toBe(true)
    seed('room', []); await roomStore.getState().loadMessagesFromCache(ROOM)
    expect(preview('room')?.isRetracted).toBe(true)
    expect(await searchIndex.search('retracted')).toEqual([])
  })
})

describe.each<Kind>(['chat', 'room'])('%s cached correction reference isolation', kind => {
  it('keeps archive-distinct targets with a reused weak ID in separate order groups', async () => {
    const h = harness(kind)
    const first = { ...original(kind), originId: 'origin-first' }
    const second = { ...original(kind), id: kind === 'chat' ? first.id : 'second', stanzaId: 'archive-second', originId: 'origin-second', body: 'second original' }
    await save(kind, first, second)
    await h.archive([
      { id: 'c1', targetId: first.stanzaId, body: 'first target edit', at: T1 },
      { id: 'c2', targetId: second.stanzaId, body: 'second target edit', at: T1 },
    ])
    await drain()
    const rows = kind === 'chat' ? await cache.getMessages(PEER) : await cache.getRoomMessages(ROOM, {})
    expect(rows).toHaveLength(2)
    expect(rows.find(row => row.stanzaId === first.stanzaId)?.body).toBe('first target edit')
    const other = rows.find(row => row.stanzaId === second.stanzaId) as Row
    expect(other.body).toBe('second target edit')
    expect(other.correctionRevision?.supersedes).not.toContain('stanza:sid-c1')
  })

  it.each([false, true])('retains forward-page order across a concurrent context fetch enriching the original; resident %s', async inMemory => {
    const h = harness(kind)
    activate(kind)
    const base = { ...original(kind), stanzaId: undefined, originId: 'origin-original' }
    await save(kind, base); seedPreview(kind, base)
    if (inMemory) seed(kind, [base])
    let lookups = 0
    const resolve = kind === 'chat' ? h.stores.chat.resolveCorrectionReferences : h.stores.room.resolveCorrectionReferences
    const implementation = resolve.getMockImplementation()!
    resolve.mockImplementation(async (...args) => {
      if (++lookups === 2) {
        await h.context([])
        const rows = kind === 'chat' ? await cache.getMessages(PEER) : await cache.getRoomMessages(ROOM, {})
        expect(rows[0]).toMatchObject({ id: base.id, stanzaId: 'archive-original', originId: base.originId, timestamp: base.timestamp })
        if (!inMemory) seed(kind, [])
      }
      return implementation(...args)
    })
    const edits = [
      { id: 'c1', targetId: base.originId, body: 'first page edit', at: T1, ...(kind === 'room' && { from: `${ROOM}/OldNick` }) },
      { id: 'c2', targetId: base.originId, body: 'second page edit', at: T1, ...(kind === 'room' && { from: `${ROOM}/NewNick` }) },
    ]
    await h.archivePages(edits.map(edit => ({ edits: [edit] })), true)
    expect(lookups).toBe(2)
    expect(preview(kind)?.body).toBe('second page edit')
    if (kind === 'room') expect(roomStore.getState().rooms.get(ROOM)?.lastMessage?.body).toBe('second page edit')
    expect(await reload(kind)).toMatchObject({ id: base.id, stanzaId: 'archive-original', originId: base.originId, timestamp: base.timestamp,
      body: 'second page edit', correctionRevision: { supersedes: expect.arrayContaining(['stanza:sid-c1']) } })
    await h.archive([edits[0]])
    expect((await reload(kind)).body).toBe('second page edit')
    expect(preview(kind)?.body).toBe('second page edit')
  })

  it('keeps overlapping references on strongly distinct originals in separate forward-page groups', async () => {
    const h = harness(kind)
    const first = { ...original(kind), originId: 'origin-first' }
    const second = { ...original(kind), id: 'second', stanzaId: 'archive-second', originId: first.id, body: 'second original' }
    await save(kind, first, second)
    await h.archivePages([
      { edits: [{ id: 'c1', targetId: first.stanzaId, body: 'first target edit', at: T1 }] },
      { edits: [{ id: 'c2', targetId: second.stanzaId, body: 'second target edit', at: T1 }] },
      { edits: [{ id: 'c3', targetId: first.stanzaId, body: 'latest first target', at: T1 }] },
    ], true)
    const rows = kind === 'chat' ? await cache.getMessages(PEER) : await cache.getRoomMessages(ROOM, {})
    expect(rows).toHaveLength(2)
    const one = rows.find(row => row.stanzaId === first.stanzaId) as Row
    const two = rows.find(row => row.stanzaId === second.stanzaId) as Row
    expect(one).toMatchObject({ body: 'latest first target', timestamp: first.timestamp })
    expect(one.correctionRevision?.supersedes).toContain('stanza:sid-c1')
    expect(one.correctionRevision?.supersedes).not.toContain('stanza:sid-c2')
    expect(two).toMatchObject({ body: 'second target edit', timestamp: second.timestamp })
    expect(two.correctionRevision?.supersedes).not.toContain('stanza:sid-c1')
  })

  it('rejects foreign authors before adopting cached target aliases', async () => {
    const h = harness(kind)
    const base = { ...original(kind), originId: 'origin-original' }
    await save(kind, base)
    await h.archive([
      { id: 'foreign', body: 'foreign correction', at: T1, targetId: base.originId,
        ...(kind === 'chat' ? { from: 'foreign@example.test' } : { occupantId: 'foreign-occupant' }) },
      { id: 'valid', body: 'valid correction', at: T1, targetId: base.id },
    ])
    const row = await reload(kind)
    expect(row.body).toBe('valid correction')
    expect(row.correctionRevision?.supersedes).not.toContain('stanza:sid-foreign')
    expect(row.correctionStanzaIds).not.toContain('sid-foreign')
  })

  it('cancels a lookup after its initiating account changes', async () => {
    const h = harness(kind)
    setStorageScopeJid(SELF)
    await save(kind, { ...original(kind), originId: 'origin-original' })
    const get = cache.getCorrectionReferences
    const started = deferred(), release = deferred()
    vi.spyOn(cache, 'getCorrectionReferences').mockImplementationOnce(async (...args) => {
      const refs = await get(...args); started.resolve(); await release.promise; return refs
    })
    const result = h.archive([{ id: 'c1', body: 'account secret', at: T1, targetId: 'origin-original' }]).then(value => ({ value }), error => ({ error }))
    await started.promise
    const count = h.events.length
    setStorageScopeJid('other@example.test'); release.resolve()
    expect(await result).toMatchObject({ error: { name: 'AbortError' } })
    expect(h.events).toHaveLength(count)
    expect(await searchIndex.search('secret')).toEqual([])
  })
})


describe.each<Kind>(['chat', 'room'])('%s grouped correction predecessor evidence', kind => {
  it.each([[false, false], [false, true], [true, false], [true, true]])('accepts a reused client ID with a distinct archive; resident %s, archived arrival %s', async (inMemory, archived) => {
    const h = harness(kind)
    activate(kind)
    const base = original(kind)
    await save(kind, base); seedPreview(kind, base)
    if (inMemory) seed(kind, [base])
    const c1 = { id: 'reused', stanzaId: 's1', omitOriginId: true, body: 'first predecessor' }
    const c2 = { id: 'other', stanzaId: 's2', omitOriginId: true, body: 'second predecessor' }
    const c3 = { ...c1, stanzaId: 's3', body: 'third current edit', authoredAt: FAST }
    await h.live(c1); await h.live(c2)
    if (archived) await h.archive([{ ...c2, at: T1 }, { ...c3, at: T2 }])
    else await h.live(c3)
    if (inMemory) expect(resident(kind)?.body).toBe(c3.body)
    expect(preview(kind)?.body).toBe(c3.body)
    await reload(kind)
    await h.archive([{ ...c1, at: T1 }, { ...c2, at: T1 }])
    expect(resident(kind)).toMatchObject({ body: c3.body, correctionTimestamp: Date.parse(FAST), correctionRevision: { ids: expect.arrayContaining(['stanza:s3']) } })
    expect(preview(kind)?.body).toBe(c3.body)
    expect(await reload(kind)).toMatchObject({ body: c3.body, id: base.id, stanzaId: base.stanzaId, timestamp: base.timestamp, correctionStanzaIds: ['s1', 's2', 's3'] })
    expect(await searchIndex.search('third')).toHaveLength(1)
    expect(await searchIndex.search('second')).toEqual([])
  })

  it.each([false, true])('rejects equal-date C2 replay after C3 reuses C1 identity; contiguous pages %s', async pages => {
    const h = harness(kind)
    activate(kind)
    const base = original(kind)
    await save(kind, base); seed(kind, [base]); seedPreview(kind, base)
    const c1 = { id: 'reused', stanzaId: 's1', omitOriginId: true, body: 'first equal edit', at: T1 }
    const c2 = { ...c1, id: 'other', stanzaId: 's2', body: 'second equal edit' }
    const c3 = { ...c1, stanzaId: 's3', body: 'third equal edit' }
    if (pages) await h.archivePages([c1, c2, c3].map(edit => ({ edits: [edit] })), true)
    else await h.archive([c1, c2, c3])
    const current = structuredClone(resident(kind)!)
    await h.archive([c2])
    expect(resident(kind)?.body).toBe(c3.body)
    expect(resident(kind)?.correctionRevision?.ids).not.toContain('stanza:s2')
    const legacy = { ...current, correctionRevision: { ...current.correctionRevision!, predecessors: undefined } }
    const old = { ...base, body: c2.body, isEdited: true, correctionRevision: { ids: ['id:other', 'stanza:s2'], supersedes: ['id:reused', 'stanza:s1'], archiveTimestamp: Date.parse(T1) } }
    for (const rows of [[legacy, old], [old, legacy]]) {
      await save(kind, ...rows)
      expect(await reload(kind)).toMatchObject({ body: c3.body, correctionRevision: { ids: expect.arrayContaining(['stanza:s3']) } })
    }
    expect(preview(kind)?.body).toBe(c3.body)
    expect(await searchIndex.search('third')).toHaveLength(1)
    expect(await searchIndex.search('second')).toEqual([])
  })

  it.each([false, true])('preserves older flat predecessor metadata without weak-ID false matches; resident %s', async inMemory => {
    const h = harness(kind)
    activate(kind)
    const current = { ...original(kind), body: 'third legacy edit', isEdited: true,
      correctionRevision: { ids: ['id:reused', 'stanza:s3'], supersedes: ['id:reused', 'stanza:s1', 'id:other', 'stanza:s2'], archiveTimestamp: Date.parse(T1) } }
    await save(kind, current); seedPreview(kind, current)
    if (inMemory) seed(kind, [current])
    await h.archive([{ id: 'other', stanzaId: 's2', omitOriginId: true, body: 'second legacy edit', at: T1 }])
    expect(preview(kind)?.body).toBe(current.body)
    expect(await reload(kind)).toMatchObject({ body: current.body, correctionRevision: { ids: ['id:reused', 'stanza:s3'] } })
    expect(await searchIndex.search('second')).toEqual([])
  })

  it('enriches a weak-only predecessor before a later revision reuses that client ID', async () => {
    const h = harness(kind)
    activate(kind)
    await save(kind, original(kind)); seedPreview(kind, original(kind))
    const c1 = { id: 'reused', omitStanzaId: true, omitOriginId: true, body: 'first weak edit' }
    await h.live(c1)
    await h.live({ id: 'other', body: 'second weak edit' })
    const echo = { ...c1, omitStanzaId: false, stanzaId: 's1', at: T1 }
    await h.archive([echo])
    const second = await reload(kind)
    expect(second.body).toBe('second weak edit')
    expect(second.correctionRevision?.predecessors).toContainEqual(expect.arrayContaining(['id:reused', 'stanza:s1']))
    await h.live({ ...c1, omitStanzaId: false, stanzaId: 's3', body: 'third weak edit' })
    await h.archive([echo])
    expect(await reload(kind)).toMatchObject({ body: 'third weak edit', correctionRevision: { ids: expect.arrayContaining(['stanza:s3']) } })
    expect(preview(kind)?.body).toBe('third weak edit')
  })
})

describe.each<Kind>(['chat', 'room'])('%s durable live predecessor selection', kind => {
  it.each([false, true])('records the durable predecessor after installing an older activation snapshot; outgoing %s', async outgoing => {
    const h = harness(kind, outgoing)
    activate(kind)
    const base = { ...indexedBase(kind, true), ...(kind === 'chat' && outgoing && { from: SELF, isOutgoing: true }) }
    await save(kind, base); seedPreview(kind, base)
    await h.live({ id: 'c0', body: base.body, ...(kind === 'chat' && outgoing && { to: PEER }) })
    const observed = (kind === 'chat' ? await cache.getMessages(PEER) : await cache.getRoomMessages(ROOM, {}))[0] as Row
    Object.assign(base, observed)
    const read = deferred(), install = deferred()
    if (kind === 'chat') {
      const get = cache.getMessages
      vi.spyOn(cache, 'getMessages').mockImplementationOnce(async (...args) => { const rows = await get(...args); read.resolve(); await install.promise; return rows })
    } else {
      const get = cache.getRoomMessages
      vi.spyOn(cache, 'getRoomMessages').mockImplementationOnce(async (...args) => { const rows = await get(...args); read.resolve(); await install.promise; return rows })
    }
    const loading = loadWindow(kind)
    await read.promise
    const c1 = { id: 'c1', body: 'durable first edit', ...(kind === 'chat' && outgoing && { to: PEER }) }
    try { await h.live(c1) } finally { install.resolve() }
    await loading
    expect(resident(kind)?.body).toBe(c1.body)
    seed(kind, [base]); seedPreview(kind, base)
    if (outgoing) await h.outgoing('current second edit')
    else await h.live({ id: 'c2', body: 'current second edit' })
    expect(resident(kind)?.correctionRevision?.supersedes).toContain('stanza:sid-c1')
    expect((preview(kind) as Row | undefined)?.correctionRevision?.supersedes).toContain('stanza:sid-c1')
    expect(resident(kind)?.liveCorrection).toBeUndefined()
    await h.archive([{ ...c1, at: T1 }])
    expect(resident(kind)?.body).toBe('current second edit')
    expect(preview(kind)?.body).toBe('current second edit')
    const reloaded = await reload(kind)
    expect(reloaded).toMatchObject({ body: 'current second edit', id: base.id, stanzaId: base.stanzaId, timestamp: base.timestamp })
    expect(reloaded.liveCorrection).toBeUndefined()
    expect(reloaded.correctionHandoff).toBeUndefined()
    expect(await searchIndex.search('second')).toHaveLength(1)
    expect(await searchIndex.search('first')).toEqual([])
  })

  it('does not apply a resident live completion after an account A to B to A transition', async () => {
    const h = harness(kind)
    setStorageScopeJid(SELF)
    activate(kind)
    const base = indexedBase(kind, true)
    await save(kind, base); seed(kind, [base]); seedPreview(kind, base)
    const completion = deferCorrectionCompletion(kind)
    const work = h.live({ id: 'c2', body: 'completed edit' })
    await completion.started.promise
    try {
      setStorageScopeJid('other@example.test'); setStorageScopeJid(SELF)
      const replacement = { ...base, body: 'replacement account state', timestamp: new Date(T2) }
      seed(kind, [replacement]); seedPreview(kind, replacement)
    } finally { completion.release.resolve() }
    await work; await drain()
    expect(resident(kind)?.body).toBe('replacement account state')
    expect(preview(kind)?.body).toBe('replacement account state')
  })
})


describe('deferred recovery storage generation', () => {
  it.each(['resident chat', 'resident room', 'peer', 'durable decrypt', 'durable write'] as const)('discards %s recovery across an account round trip', async phase => {
    setStorageScopeJid(SELF)
    const kind = phase === 'resident room' ? 'room' : 'chat'
    const h = harness(kind)
    const base: Row = {
      ...original(kind), body: 'locked current correction', isEdited: true,
      encryptedPayload: '<message><body>locked current correction</body><plain xmlns="urn:fluux:e2ee-dummy:0">c3RhbGU=</plain></message>',
      correctionRevision: { ids: ['stanza:c1'], supersedes: [], archiveTimestamp: Date.parse(T1) },
    }
    await save(kind, base)
    seedPreview(kind, base)
    if (!phase.startsWith('durable')) seed(kind, [base])
    h.stores.chat.getConversationMessages.mockImplementation(() => chatStore.getState().messages.get(PEER) ?? [])
    const blocked = await blockedDecrypt()
    const writeStarted = deferred(), releaseWrite = deferred()
    const update = cache.updateMessage
    const port = phase === 'durable write' ? {
      ...cache,
      updateMessage: async (...args: Parameters<typeof cache.updateMessage>) => {
        await update(...args)
        writeStarted.resolve()
        await releaseWrite.promise
      },
    } : cache
    const engine = new DeferredDecryptEngine({ getManager: () => blocked.manager, getStores: () => h.stores, getOwnBareJid: () => SELF, cache: port, updateSearchIndex: searchIndex.updateMessage })
    const retry = phase === 'peer' ? engine.retryForPeer(PEER) : engine.retryPending()
    await blocked.started.promise
    if (phase === 'durable write') {
      blocked.release.resolve()
      await writeStarted.promise
    }
    setStorageScopeJid('other@example.test')
    setStorageScopeJid(SELF)
    const replacement = structuredClone(base)
    seed(kind, [replacement]); seedPreview(kind, replacement)
    blocked.release.resolve(); releaseWrite.resolve()
    await retry; await drain()
    expect(resident(kind)).toEqual(replacement)
    expect(preview(kind)).toEqual(replacement)
    if (kind === 'room') expect(roomStore.getState().rooms.get(ROOM)?.lastMessage).toEqual(replacement)
    expect(await searchIndex.search('stale')).toEqual([])
    const durable = (kind === 'chat' ? await cache.getMessages(PEER) : await cache.getRoomMessages(ROOM, {}))[0]
    expect(durable.body).toBe(phase === 'durable write' ? 'stale recovered text' : base.body)
  })
})


describe.each<Kind>(['chat', 'room'])('%s atomic correction indexing', kind => {
  it.each(['direct', 'batch'] as const)('keeps corrected tokens when %s history indexing overlaps replacement', async mode => {
    const h = harness(kind)
    const base = original(kind)
    await save(kind, base)
    await searchIndex.indexMessage(base)
    const started = deferred(), release = deferred()
    const check = cache.areRetractedInCache
    vi.spyOn(cache, 'areRetractedInCache').mockImplementation(async (messages, scope) => {
      if (messages.length === 1 && messages[0].body === 'corrected searchable text') {
        started.resolve(); await release.promise
      }
      return check(messages, scope)
    })
    const correction = h.live({ id: 'c1', body: 'corrected searchable text' })
    await started.promise
    try {
      if (mode === 'direct') await searchIndex.indexMessage(base)
      else {
        const history = Array.from({ length: 51 }, (_, index) => ({ ...base, id: `history-${index}`, stanzaId: `archive-${index}`, body: `filler message ${index}` }))
        await searchIndex.indexMessages([...history, base])
        expect(await searchIndex.search('filler', { limit: 100 })).toHaveLength(51)
      }
    } finally { release.resolve() }
    await correction; await drain()
    expect(await searchIndex.search('corrected')).toHaveLength(1)
    expect(await searchIndex.search('original')).toEqual([])
    expect((await reload(kind)).body).toBe('corrected searchable text')
  })

  it.each(['👍', '!!!', 'a'].flatMap(body => ['direct', 'batch'].map(mode => ({ body, mode }))))('protects a tokenless correction $body against $mode history insertion', async ({ body, mode }) => {
    const h = harness(kind)
    const base = original(kind)
    await save(kind, base); await searchIndex.indexMessage(base)
    const history = Array.from({ length: 51 }, (_, index) => ({ ...base, id: `history-${index}`, stanzaId: `archive-${index}`, body: `filler message ${index}` }))
    const started = deferred(), release = deferred()
    const check = cache.areRetractedInCache
    vi.spyOn(cache, 'areRetractedInCache').mockImplementation(async (messages, scope) => {
      const result = await check(messages, scope)
      if (messages.length > 50) { started.resolve(); await release.promise }
      return result
    })
    const pendingHistory = searchIndex.indexMessages([...history, base])
    writes.splice(writes.indexOf(pendingHistory), 1)
    await started.promise
    try {
      await searchIndex.indexMessage(base)
      await h.live({ id: 'c1', body })
      expect(await searchIndex.search('original')).toEqual([])
      if (mode === 'direct') {
        await searchIndex.indexMessage(base)
        expect(await searchIndex.search('original')).toEqual([])
      }
    } finally { release.resolve(); await pendingHistory }
    expect(await searchIndex.search('original')).toEqual([])
    expect(await searchIndex.search('text')).toEqual([])
    expect(await searchIndex.search('filler', { limit: 100 })).toHaveLength(51)
    expect((await reload(kind)).body).toBe(body)
    await searchIndex.closeSearchIndex()
    await searchIndex.indexMessage(base)
    expect(await searchIndex.search('original')).toEqual([])
    await h.live({ id: 'c2', body: 'searchable successor' })
    expect(await searchIndex.search('successor')).toHaveLength(1)
  })

  it('rolls back failed token replacement and releases the target queue', async () => {
    const base = original(kind)
    await save(kind, base); await searchIndex.indexMessage(base)
    const edited = { ...base, body: 'replacement text', isEdited: true }
    const put = IDBObjectStore.prototype.put
    const fail = vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(function (this: IDBObjectStore, ...args) {
      if (this.name === 'search-tokens' && args[0].token === 'replacement') throw new Error('token write failed')
      return put.apply(this, args)
    })
    const failed = searchIndex.updateMessage(edited)
    await expect(failed).rejects.toThrow('token write failed')
    writes[writes.indexOf(failed)] = failed.catch(() => {})
    fail.mockRestore()
    expect(await searchIndex.search('original')).toHaveLength(1)
    expect(await searchIndex.search('replacement')).toEqual([])
    await searchIndex.updateMessage(edited)
    expect(await searchIndex.search('replacement')).toHaveLength(1)
    expect(await searchIndex.search('original')).toEqual([])
  })
})

describe.each<Kind>(['chat', 'room'])('%s empty-caption indexing', kind => {
  const attachment = { url: 'https://files.example.test/photo.png', mediaType: 'image/png', name: 'photo.png', size: 42 }

  async function documents() {
    const db = await openDB('fluux-search-index')
    try {
      const tx = db.transaction(['search-docs', 'search-tokens'], 'readonly')
      const docs = await tx.objectStore('search-docs').getAll()
      const tokens = await tx.objectStore('search-tokens').getAll()
      await tx.done
      return { docs, tokens }
    } finally { db.close() }
  }

  it('keeps a removed caption absent after outgoing SDK correction and a pending 52-row history batch', async () => {
    const h = harness(kind, true)
    const base = { ...original(kind, true), attachment }
    activate(kind)
    await save(kind, base); seed(kind, [base]); seedPreview(kind, base)
    await searchIndex.indexMessage(base)
    const history = Array.from({ length: 51 }, (_, index) => ({ ...base, id: `history-${index}`, stanzaId: `archive-${index}`, body: `filler message ${index}` }))
    const started = deferred(), release = deferred()
    const check = cache.areRetractedInCache
    vi.spyOn(cache, 'areRetractedInCache').mockImplementation(async (messages, scope) => {
      const result = await check(messages, scope)
      if (messages.length > 50) { started.resolve(); await release.promise }
      return result
    })
    const pendingHistory = searchIndex.indexMessages([...history, base])
    writes.splice(writes.indexOf(pendingHistory), 1)
    await started.promise
    try {
      await h.outgoing('', attachment)
      expect(resident(kind)).toMatchObject({ id: base.id, timestamp: base.timestamp, body: '', attachment, isEdited: true })
      expect(preview(kind)).toMatchObject({ body: '', attachment })
      expect(await reload(kind)).toMatchObject({ id: base.id, timestamp: base.timestamp, body: '', attachment })
      expect(await searchIndex.search('original')).toEqual([])
    } finally { release.resolve(); await pendingHistory }
    expect(await searchIndex.search('original')).toEqual([])
    expect(await searchIndex.search('filler', { limit: 100 })).toHaveLength(51)
    await searchIndex.indexMessage(base)
    expect(await searchIndex.search('original')).toEqual([])
    const persisted = await documents()
    expect(persisted.docs.find(doc => doc.messageId === base.id)).toMatchObject({ body: '', tokens: [] })
    expect(persisted.tokens.map(entry => entry.token)).not.toContain('original')
  })

  it.each(['single', 'batch', 'backfill', 'rebuild'])('retains an already-current empty edit through reopening and %s indexing', async mode => {
    const h = harness(kind, true)
    const base = { ...original(kind, true), attachment }
    await save(kind, base); seed(kind, [base])
    await h.outgoing('', attachment)
    const current = await reload(kind)
    expect(current).toMatchObject({ body: '', isEdited: true, attachment })
    await searchIndex.clearSearchIndex(); await searchIndex.closeSearchIndex()
    if (mode === 'single') await searchIndex.indexMessage(current)
    else if (mode === 'batch') await searchIndex.indexMessages([current])
    else if (mode === 'backfill') await searchIndex.backfillFromMessageCache()
    else await searchIndex.rebuildSearchIndex()
    await searchIndex.closeSearchIndex()
    await searchIndex.indexMessage(base)
    const history = Array.from({ length: 51 }, (_, index) => ({ ...base, id: `history-${index}`, stanzaId: `archive-${index}`, body: `filler message ${index}` }))
    await searchIndex.indexMessages([...history, base])
    expect(await searchIndex.search('original')).toEqual([])
    const persisted = await documents()
    expect(persisted.docs.find(doc => doc.messageId === base.id)).toMatchObject({ body: '', tokens: [] })
    expect(persisted.tokens.map(entry => entry.token)).not.toContain('original')
  })

  it.each(['noLocalStore', 'isRetracted'] as const)('excludes an empty edit carrying %s from replacement, single and batch indexing', async flag => {
    const base = original(kind)
    await searchIndex.indexMessage(base)
    const excluded = { ...base, body: '', isEdited: true, [flag]: true }
    await searchIndex.updateMessage(excluded)
    await searchIndex.indexMessage(excluded)
    await searchIndex.indexMessages([excluded], { fromCache: true })
    expect(await searchIndex.search('original')).toEqual([])
    expect(await documents()).toEqual({ docs: [], tokens: [] })
  })

  it('rolls back an empty-document write failure and permits a clean retry', async () => {
    const base = original(kind)
    await searchIndex.indexMessage(base)
    const current = { ...base, body: '', isEdited: true }
    const put = IDBObjectStore.prototype.put
    const fail = vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(function (this: IDBObjectStore, ...args) {
      if (this.name === 'search-docs' && args[0].body === '') throw new Error('document write failed')
      return put.apply(this, args)
    })
    const failed = searchIndex.updateMessage(current)
    try { await expect(failed).rejects.toThrow('document write failed') }
    finally { writes[writes.indexOf(failed)] = failed.catch(() => {}); fail.mockRestore() }
    expect(await searchIndex.search('original')).toHaveLength(1)
    await searchIndex.updateMessage(current)
    await searchIndex.indexMessage(base)
    expect(await searchIndex.search('original')).toEqual([])
    expect((await documents()).tokens).toEqual([])
  })
})

describe.each<Kind>(['chat', 'room'])('%s archive identity isolation', kind => {
  it.each([false, true])('keeps read-only search separate from a conflicting cached original; retracted: %s', async retracted => {
    const held = { ...original(kind), stanzaId: 'archive-A', body: 'private edited text', isEdited: true,
      correctionStanzaIds: ['edit-A'], correctionRevision: { ids: ['stanza:edit-A'], supersedes: [], archiveTimestamp: Date.parse(T2) },
      ...(retracted && { isRetracted: true, retractedAt: new Date(T2) }) }
    await save(kind, held)
    const before = await reload(kind)
    seed(kind, [])
    const h = harness(kind, false, { stanzaId: 'archive-B', body: 'separate original text' })
    const rows = await h.search([])
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ id: held.id, stanzaId: 'archive-B', body: 'separate original text', from: held.from, timestamp: held.timestamp })
    expect(rows[0].isEdited).toBeFalsy()
    expect(rows[0].isRetracted).toBeFalsy()
    expect(rows[0].correctionRevision).toBeUndefined()
    expect(rows[0].correctionStanzaIds).toBeUndefined()
    expect(h.historyRows).toEqual([])
    expect(await reload(kind)).toEqual(before)
  })

  it('enriches the identity of the same original during read-only search', async () => {
    const held = { ...original(kind), stanzaId: undefined, body: 'current edited text', isEdited: true,
      correctionRevision: { ids: ['stanza:edit-A'], supersedes: [], archiveTimestamp: Date.parse(T2) } }
    await save(kind, held)
    const h = harness(kind)
    const rows = await h.search([])
    expect(rows[0]).toMatchObject({ id: held.id, stanzaId: 'archive-original', body: held.body, correctionRevision: held.correctionRevision })
    expect((await reload(kind)).stanzaId).toBeUndefined()
  })

  it.each(['foreign', 'matching-and-foreign', 'absent', 'conflicting'] as const)('uses the queried archive identity for a %s inner stanza ID', async mode => {
    const h = harness(kind)
    await save(kind, original(kind)); seed(kind, [original(kind)]); seedPreview(kind, original(kind))
    await h.live({ id: 'c1', body: 'older text', stanzaId: 'R1' })
    await h.live({ id: 'c2', body: 'current text', stanzaId: 'R2' })
    const replay: Edit = { id: 'c1', body: 'older text', at: T1, archiveId: 'R1', stanzaId: 'F1', stanzaIdBy: 'foreign.example.test' }
    if (mode === 'absent') replay.omitStanzaId = true
    if (mode === 'matching-and-foreign' || mode === 'conflicting') replay.extraStanzaIds = [{ id: mode === 'conflicting' ? 'R3' : 'R1', by: kind === 'chat' ? SELF : ROOM }]
    if (mode === 'conflicting') await h.archive([{ id: 'c2', body: 'current text', stanzaId: 'R2', at: T0 }])
    await h.archive([replay])
    const expectedBody = mode === 'conflicting' ? 'older text' : 'current text'
    expect(resident(kind)?.body).toBe(expectedBody)
    expect(preview(kind)?.body).toBe(expectedBody)
    const stored = await reload(kind)
    expect(stored.body).toBe(expectedBody)
    expect(stored.correctionRevision?.ids).toContain(mode === 'conflicting' ? 'stanza:R3' : 'stanza:R2')
    expect(stored.correctionRevision?.ids).not.toContain('stanza:F1')
    if (mode === 'foreign') expect(stored.correctionStanzaIds).toEqual(expect.arrayContaining(['R1', 'R2', 'F1']))
    expect(await searchIndex.search(mode === 'conflicting' ? 'current' : 'older')).toEqual([])
  })
})

describe.each<Kind>(['chat', 'room'])('%s independent equal-time revision ingestion', kind => {
  it.each(['alpha', 'zulu'])('retains current %s through independent MAM pages, persistence and search', async body => {
    const h = harness(kind)
    const oldBody = body === 'alpha' ? 'zulu' : 'alpha'
    activate(kind)
    await save(kind, original(kind)); seed(kind, [original(kind)]); seedPreview(kind, original(kind))
    await h.archive([{ id: 'c2', body, at: T1, authoredAt: T0 }])
    const current = await reload(kind)
    const stale = { ...current, body: oldBody, correctionTimestamp: Date.parse(FAST),
      correctionRevision: { ids: ['stanza:sid-c1'], supersedes: [], archiveTimestamp: Date.parse(T1) } }
    for (const memory of [true, false]) {
      seed(kind, memory ? [current] : [])
      const rows = await h.archive([{ id: 'c1', body: oldBody, at: T1, authoredAt: FAST }], true)
      expect(rows[0]).toMatchObject({ body, timestamp: new Date(T0), correctionTimestamp: Date.parse(T0), correctionRevision: { ids: expect.arrayContaining(['stanza:sid-c2']) } })
      expect(h.historyRows.at(-1)?.[0].body).toBe(body)
      expect(resident(kind)?.body).toBe(body)
      expect(preview(kind)?.body).toBe(body)
      if (kind === 'room') expect(roomStore.getState().rooms.get(ROOM)?.lastMessage?.body).toBe(body)
      await searchIndex.indexMessage(stale)
      await searchIndex.indexMessages([stale])
      await searchIndex.updateMessage(stale)
      expect(await searchIndex.search(oldBody)).toEqual([])
      expect(await searchIndex.search(body)).toHaveLength(1)
      await save(kind, stale)
      expect(await reload(kind)).toMatchObject({ body, correctionTimestamp: Date.parse(T0), correctionRevision: { ids: expect.arrayContaining(['stanza:sid-c2']) } })
    }
    await h.archive([{ id: 'c1', body: oldBody, at: T1 }])
    expect((await reload(kind)).body).toBe(body)
  })

  it('keeps current ciphertext over plaintext from an unrelated equal-time revision', async () => {
    const held = { ...original(kind), body: 'locked current', isEdited: true, encryptedPayload: '<current/>',
      correctionTimestamp: Date.parse(T0), correctionTimestampSource: 'authored' as const,
      correctionRevision: { ids: ['stanza:c2'], supersedes: [], archiveTimestamp: Date.parse(T1) } }
    const stale = { ...held, body: 'obsolete plaintext', encryptedPayload: undefined,
      correctionTimestamp: Date.parse(FAST), correctionRevision: { ids: ['stanza:c1'], supersedes: [], archiveTimestamp: Date.parse(T1) } }
    await save(kind, held)
    const reconciled = kind === 'chat'
      ? await cache.reconcileChatHistoryMessages([stale as StoredMessage], () => [])
      : await cache.reconcileRoomHistoryMessages([stale as StoredRoomMessage], () => [])
    expect(reconciled[0]).toMatchObject({ body: held.body, encryptedPayload: held.encryptedPayload, correctionTimestamp: held.correctionTimestamp })
    await searchIndex.indexMessage(stale)
    expect(await searchIndex.search('obsolete')).toEqual([])
    await save(kind, stale)
    expect(await reload(kind)).toMatchObject({ body: held.body, encryptedPayload: held.encryptedPayload, correctionTimestamp: held.correctionTimestamp })
    const recovered = { ...held, body: 'recovered current', encryptedPayload: undefined }
    await save(kind, recovered)
    expect(await reload(kind)).toMatchObject({ body: recovered.body, correctionTimestamp: held.correctionTimestamp })
  })
})

describe.each<Kind>(['chat', 'room'])('%s search insertion after identity enrichment', kind => {
  const attachment = { url: 'https://files.example.test/photo.png', mediaType: 'image/png' }

  it.each(['current searchable revision', '', '👍'].flatMap(body => ['single', 'batch', 'backfill', 'rebuild'].map(mode => ({ body, mode }))))('keeps current body "$body" after stale $mode insertion and reopening', async ({ body, mode }) => {
    const h = harness(kind, true)
    const base = { ...original(kind, true), stanzaId: undefined, originId: 'origin-original', attachment }
    activate(kind)
    await save(kind, base); seed(kind, [base]); seedPreview(kind, base)
    await searchIndex.indexMessage(base)
    const history = Array.from({ length: 51 }, (_, index) => ({ ...base, id: `history-${index}`, stanzaId: `archive-${index}`, originId: `origin-${index}`, body: `filler message ${index}` }))
    const started = deferred(), release = deferred()
    let pending: Promise<void> | undefined
    if (mode === 'backfill' || mode === 'rebuild') {
      await save(kind, ...history)
      const method = kind === 'chat' ? 'iterateAllMessages' : 'iterateAllRoomMessages'
      const iterate = cache[method]
      vi.spyOn(cache, method).mockImplementation(async (size: number, onBatch: Parameters<typeof cache.iterateAllMessages>[1] | Parameters<typeof cache.iterateAllRoomMessages>[1]) => {
        await iterate(size, async batch => {
          const rows = [...batch.filter(row => row.id !== base.id), ...batch.filter(row => row.id === base.id)]
          await onBatch(rows.slice(0, 50) as never)
          started.resolve(); await release.promise
          await onBatch(rows.slice(50) as never)
        })
      })
      pending = mode === 'backfill' ? searchIndex.backfillFromMessageCache() : searchIndex.rebuildSearchIndex().then(() => {})
      await started.promise
    }
    try {
      await h.context([])
      await h.outgoing(body, attachment)
      const rows = kind === 'chat' ? await cache.getMessages(PEER) : await cache.getRoomMessages(ROOM, {})
      expect(rows.find(row => row.id === base.id)).toMatchObject({ body, stanzaId: 'archive-original', originId: base.originId, timestamp: base.timestamp, attachment })
      expect(await searchIndex.search('original')).toEqual([])
      await searchIndex.closeSearchIndex(); cache._resetDBForTesting()
      if (mode === 'single') await searchIndex.indexMessage(base)
      else if (mode === 'batch') await searchIndex.indexMessages([...history, base])
    } finally { release.resolve(); await pending }
    expect(await searchIndex.search('original')).toEqual([])
    expect(await searchIndex.search('current')).toHaveLength(body ? (body === '👍' ? 0 : 1) : 0)
    await searchIndex.closeSearchIndex(); cache._resetDBForTesting()
    await searchIndex.indexMessage(base)
    expect(await searchIndex.search('original')).toEqual([])
    const db = await openDB('fluux-search-index')
    try {
      const docs = await db.getAll('search-docs')
      expect(docs.filter(doc => doc.messageId === base.id)).toMatchObject([{ body, stanzaId: 'archive-original' }])
    } finally { db.close() }
  })

  it('serializes a stale resolved snapshot with a correction using its enriched key', async () => {
    const base = { ...original(kind), stanzaId: undefined, originId: 'origin-original' }
    await save(kind, base); await searchIndex.indexMessage(base)
    const read = cache.resolveMessagesForIndex
    const started = deferred(), release = deferred()
    vi.spyOn(cache, 'resolveMessagesForIndex').mockImplementationOnce(async (...args) => {
      const snapshot = await read(...args)
      started.resolve(); await release.promise
      return snapshot
    })
    const stale = searchIndex.indexMessage(base)
    await started.promise
    const enriched = { ...base, stanzaId: 'archive-original' }
    await save(kind, enriched)
    const updates = { body: '', isEdited: true, correctionRevision: { ids: ['stanza:c1'], supersedes: [], archiveTimestamp: Date.parse(T1) } }
    const current = kind === 'chat'
      ? await cache.applyChatCorrection(PEER, base.id, updates, { actorJid: base.from })
      : await cache.applyRoomCorrection(ROOM, base.id, updates, { actorJid: base.from, actorOccupantId: 'peer-occupant' })
    expect(current).toBeTruthy()
    const correction = searchIndex.updateMessage(current!)
    try { await Promise.race([correction, new Promise(resolve => setTimeout(resolve, 50))]) }
    finally { release.resolve() }
    await Promise.all([stale, correction])
    expect(await searchIndex.search('original')).toEqual([])
    const db = await openDB('fluux-search-index')
    try { expect(await db.getAll('search-docs')).toMatchObject([{ body: '', stanzaId: enriched.stanzaId, tokens: [] }]) }
    finally { db.close() }
  })

  it('retains recovered content when an encrypted snapshot arrives after enrichment', async () => {
    const encrypted = { ...original(kind), stanzaId: undefined, originId: 'origin-original', body: 'locked placeholder', encryptedPayload: '<message/>' }
    const recovered = { ...encrypted, stanzaId: 'archive-original', body: 'recovered plaintext', encryptedPayload: undefined }
    await save(kind, recovered)
    await searchIndex.indexMessage(recovered)
    await searchIndex.indexMessage(encrypted)
    expect(await searchIndex.search('locked')).toEqual([])
    expect(await searchIndex.search('recovered')).toMatchObject([{ body: recovered.body, stanzaId: recovered.stanzaId }])
  })

  it('skips stale insertion on a failed cache lookup and recovers on retry', async () => {
    const base = { ...original(kind), stanzaId: undefined, originId: 'origin-original' }
    await save(kind, { ...base, stanzaId: 'archive-original', body: '', isEdited: true })
    const failure = vi.spyOn(cache, 'resolveMessagesForIndex').mockRejectedValueOnce(new Error('lookup unavailable'))
    await expect(searchIndex.indexMessage(base)).rejects.toThrow('lookup unavailable')
    expect(await searchIndex.search('original')).toEqual([])
    failure.mockRestore()
    await searchIndex.indexMessage(base)
    const db = await openDB('fluux-search-index')
    try { expect(await db.getAll('search-docs')).toMatchObject([{ body: '', stanzaId: 'archive-original', tokens: [] }]) }
    finally { db.close() }
  })

  it('cancels a backfill snapshot after an account round trip', async () => {
    setStorageScopeJid(SELF)
    await save(kind, { ...original(kind), body: 'account secret' })
    const method = kind === 'chat' ? 'iterateAllMessages' : 'iterateAllRoomMessages'
    const iterate = cache[method]
    const started = deferred(), release = deferred()
    vi.spyOn(cache, method).mockImplementationOnce(async (size: number, onBatch: Parameters<typeof cache.iterateAllMessages>[1] | Parameters<typeof cache.iterateAllRoomMessages>[1]) => {
      await iterate(size, async batch => { started.resolve(); await release.promise; await onBatch(batch as never) })
    })
    const result = searchIndex.backfillFromMessageCache().then(() => null, error => error)
    await started.promise
    setStorageScopeJid('other@example.test'); setStorageScopeJid(SELF)
    release.resolve()
    expect(await result).toMatchObject({ name: 'AbortError' })
    expect(await searchIndex.search('secret')).toEqual([])
    await searchIndex.backfillFromMessageCache()
    expect(await searchIndex.search('secret')).toHaveLength(1)
    setStorageScopeJid('other@example.test')
    expect(await searchIndex.search('secret')).toEqual([])
  })

  it.each(['archive', 'origin', 'author', 'occupant'] as const)('does not adopt a cached revision with conflicting %s evidence', async conflict => {
    const current = { ...original(kind), originId: 'origin-current', body: 'private cached revision', isEdited: true }
    const incoming: Row = { ...original(kind), body: 'different original', stanzaId: undefined, originId: current.originId }
    if (conflict === 'archive') incoming.stanzaId = 'other-archive'
    if (conflict === 'origin') incoming.originId = 'other-origin'
    if (conflict === 'author') incoming.from = kind === 'chat' ? SELF : `${ROOM}/Other`
    if (kind === 'room' && (conflict === 'occupant' || conflict === 'author')) (incoming as StoredRoomMessage).occupantId = 'other-occupant'
    if (kind === 'chat' && conflict === 'occupant') incoming.from = SELF
    await save(kind, current)
    await searchIndex.indexMessage(incoming)
    expect(await searchIndex.search('private')).toEqual([])
    expect(await searchIndex.search('different')).toMatchObject([{ body: incoming.body, from: incoming.from }])
  })
})

it('resolves an absorbed chat client ID to its current canonical cached edit', async () => {
  const base = { ...original('chat'), id: 'z-original', stanzaId: undefined, originId: 'origin-original' }
  await save('chat', base); await searchIndex.indexMessage(base)
  await save('chat', { ...base, id: 'a-canonical', stanzaId: 'archive-original' })
  const corrected = await cache.applyChatCorrection(PEER, base.id, {
    body: '', isEdited: true, correctionRevision: { ids: ['stanza:c1'], supersedes: [], archiveTimestamp: Date.parse(T1) },
  }, { actorJid: base.from })
  expect(corrected?.id).toBe('a-canonical')
  await searchIndex.indexMessage(base)
  expect(await searchIndex.search('original')).toEqual([])
  const db = await openDB('fluux-search-index')
  try { expect(await db.getAll('search-docs')).toMatchObject([{ indexId: 'chat:a-canonical', body: '', tokens: [] }]) }
  finally { db.close() }
})

it('does not resolve an ambiguous chat client ID to another cached original', async () => {
  const first = { ...original('chat'), body: 'first private edit', isEdited: true }
  const second = { ...first, stanzaId: 'other-archive', body: 'second private edit' }
  await save('chat', first, second)
  await searchIndex.indexMessage({ ...first, stanzaId: undefined, isEdited: false, body: 'ambiguous original' })
  expect(await searchIndex.search('private')).toEqual([])
})

describe.each<Kind>(['chat', 'room'])('%s legacy encrypted correction preservation', kind => {
  it.each([false, true])('retains ciphertext across cache reopen and history reconciliation; edit saved first %s', async editFirst => {
    const h = harness(kind)
    const base = original(kind)
    const legacy: Row = {
      ...base, body: 'locked legacy correction', isEdited: true, originalBody: base.body,
      encryptedPayload: '<message><body>locked legacy correction</body><plain xmlns="urn:fluux:e2ee-dummy:0">bGVnYWN5</plain></message>',
      correctionStanzaIds: ['sid-legacy'], correctionTimestamp: Date.parse(FAST), correctionTimestampSource: 'authored',
    }
    await save(kind, ...(editFirst ? [legacy, base] : [base, legacy]))
    expect(await reload(kind)).toMatchObject(legacy)
    seed(kind, [])
    const reconcile = async (rows: Row[]) => kind === 'chat'
      ? cache.reconcileChatHistoryMessages(rows as StoredMessage[], () => [])
      : cache.reconcileRoomHistoryMessages(rows as StoredRoomMessage[], () => [])
    expect((await reconcile([base]))[0]).toMatchObject(legacy)
    await cache.clearAllMessages()
    await save(kind, base)
    expect((await reconcile([legacy]))[0]).toMatchObject(legacy)
    await save(kind, legacy)
    if (kind === 'room') seed(kind, [legacy])
    const decrypt = await blockedDecrypt()
    const engine = new DeferredDecryptEngine({ getManager: () => decrypt.manager, getStores: () => h.stores, getOwnBareJid: () => SELF, cache, updateSearchIndex: searchIndex.updateMessage })
    const retry = engine.retryPending()
    await decrypt.started.promise; decrypt.release.resolve()
    expect(await retry).toBe(1)
    await drain()
    const recovered = await reload(kind)
    expect(recovered).toMatchObject({ body: 'stale recovered text', isEdited: true, correctionTimestamp: Date.parse(FAST), correctionTimestampSource: 'authored', correctionStanzaIds: ['sid-legacy'] })
    expect(recovered.encryptedPayload).toBeUndefined()
    expect(recovered.correctionRevision).toBeUndefined()
    await save(kind, base)
    expect((await reload(kind)).body).toBe(recovered.body)
    await h.archive([{ id: 'c2', body: 'newer known correction', at: T2, authoredAt: T1 }])
    expect(await reload(kind)).toMatchObject({ body: 'newer known correction', correctionTimestamp: Date.parse(T1), correctionRevision: { archiveTimestamp: Date.parse(T2) }, correctionStanzaIds: ['sid-c2', 'sid-legacy'] })
  })

  it('keeps a legacy edited tombstone when the original and ciphertext return', async () => {
    const base = original(kind)
    const legacy = { ...base, body: 'legacy ciphertext placeholder', isEdited: true, encryptedPayload: 'legacy ciphertext', correctionStanzaIds: ['sid-legacy'] }
    await save(kind, { ...legacy, isRetracted: true, retractedAt: new Date(T1), body: '' })
    await save(kind, base, legacy)
    const row = await reload(kind)
    expect(row).toMatchObject({ isRetracted: true, retractedAt: new Date(T1), body: '', correctionStanzaIds: ['sid-legacy'] })
    expect(row.encryptedPayload).toBeUndefined()
  })
})

describe.each<Kind>(['chat', 'room'])('%s correction handoff after recovered source', kind => {
  it('updates a ciphertext preview after durable recovery completes across an account round trip', async () => {
    setStorageScopeJid(SELF)
    const h = harness(kind)
    const c1: Row = {
      ...original(kind), body: 'locked first correction', isEdited: true,
      encryptedPayload: '<message><body>locked first correction</body><plain xmlns="urn:fluux:e2ee-dummy:0">Zmlyc3Q=</plain></message>',
      correctionRevision: { ids: ['id:c1', 'stanza:sid-c1'], supersedes: [] },
    }
    await save(kind, c1); seedPreview(kind, c1)
    if (kind === 'room') seed(kind, [c1])
    const decrypt = await blockedDecrypt()
    const written = deferred(), release = deferred()
    const block = <A extends unknown[], R>(update: (...args: A) => Promise<R>) => (...args: A) => {
      const pending = (async () => {
        const result = await update(...args)
        written.resolve(); await release.promise
        return result
      })()
      writes.push(pending)
      return pending
    }
    const port = { ...cache, updateMessage: block(cache.updateMessage) }
    if (kind === 'room') vi.spyOn(cache, 'updateRoomMessage').mockImplementationOnce(block(cache.updateRoomMessage))
    const engine = new DeferredDecryptEngine({ getManager: () => decrypt.manager, getStores: () => h.stores, getOwnBareJid: () => SELF, cache: port, updateSearchIndex: searchIndex.updateMessage })
    const retry = engine.retryPending()
    await decrypt.started.promise; decrypt.release.resolve()
    await written.promise
    setStorageScopeJid('other@example.test'); setStorageScopeJid(SELF)
    if (kind === 'chat') {
      chatStore.getState().switchAccount(SELF)
      chatStore.getState().addConversation({ id: PEER, name: 'Peer', type: 'chat', unreadCount: 0 })
    } else {
      roomStore.getState().reset()
      roomStore.getState().addRoom(createMockRoom(ROOM, { nickname: 'Peer', joined: true }))
    }
    setStorageScopeJid(SELF)
    seed(kind, []); seedPreview(kind, structuredClone(c1))
    release.resolve(); await retry; await drain()
    expect(preview(kind)?.body).toBe(c1.body)
    const durable = (kind === 'chat' ? await cache.getMessages(PEER) : await cache.getRoomMessages(ROOM, {}))[0] as Row
    expect(durable.body).toBe('stale recovered text')
    expect(durable.encryptedPayload).toBeUndefined()
    expect(durable.correctionRevision?.archiveTimestamp).toBeUndefined()
    await h.archive([{ id: 'c1', body: durable.body, at: T1 }])
    await h.archive([{ id: 'c2', body: 'current second correction', at: T2, authoredAt: T1 }])
    expect(resident(kind)).toBeUndefined()
    expect(preview(kind)).toMatchObject({ id: c1.id, stanzaId: c1.stanzaId, timestamp: c1.timestamp, body: 'current second correction', correctionTimestamp: Date.parse(T1) })
    if (kind === 'room') expect(roomStore.getState().rooms.get(ROOM)?.lastMessage).toEqual(preview(kind))
    expect((await reload(kind)).body).toBe('current second correction')
    expect(await searchIndex.search('second')).toHaveLength(1)
  })

  it.each(['strong identity', 'owner', 'account', 'newer edit', 'different ciphertext'] as const)('rejects a handoff with a mismatched %s', mismatch => {
    const held: Row = { ...original(kind), isEdited: true, body: 'held correction', encryptedPayload: 'ciphertext', correctionRevision: { ids: ['id:c1', 'stanza:sid-c1'], supersedes: [] } }
    const source = captureContentSource({ ...held, encryptedPayload: undefined }, SELF)
    if (mismatch === 'strong identity') source.revisionIds = ['id:c1', 'stanza:other-c1']
    if (mismatch === 'owner') source.from = 'other@example.test'
    if (mismatch === 'account') source.accountScope = 'other@example.test'
    if (mismatch === 'newer edit') held.correctionRevision = { ids: ['stanza:sid-c3'], supersedes: [], archiveTimestamp: Date.parse(FAST) }
    if (mismatch === 'different ciphertext') source.encryptedPayload = 'unrelated ciphertext'
    const updates = resolveCorrectionUpdates(held, { body: 'incoming correction', isEdited: true, correctionRevision: { ids: ['stanza:sid-c2'], supersedes: [], archiveTimestamp: Date.parse(T2) }, correctionHandoff: source }, SELF)
    expect({ ...held, ...updates }.body).toBe('held correction')
    const recovery = resolveCorrectionUpdates(held, { body: 'unrelated recovery', contentRecovery: source }, SELF)
    expect({ ...held, ...recovery }.body).toBe('held correction')
  })
})


describe('live encrypted receive session ownership', () => {
  const cases = (['live', 'received', 'sent'] as const).flatMap(shape =>
    (['resident', 'cache-only', 'missing'] as const).flatMap(location =>
      (['same', 'account', 'roundtrip', 'logout', 'reset', 'session', 'manager', 'jid'] as const).map(change => ({ shape, location, change }))))

  it.each(cases)('keeps $shape correction for $location in its initiating $change session', async ({ shape, location, change }) => {
    const own = shape === 'sent'
    setStorageScopeJid(SELF)
    const h = harness('chat', own)
    let jid: string | null = SELF
    let connection: ReturnType<ModuleDependencies['getXmpp']> = {} as NonNullable<ReturnType<ModuleDependencies['getXmpp']>>
    const plugin = new DummyPlaintextPlugin()
    const manager = new E2EEManager({ storage: new InMemoryStorageBackend(), account: { jid: SELF }, xmpp: {
      sendStanza: async () => {}, queryDisco: async () => ({ features: [], identities: [] }),
      publishPEP: async () => {}, retractPEP: async () => {}, deletePEP: async () => {}, queryPEP: async () => [], subscribePEP: () => ({ unsubscribe() {} }),
    } })
    await manager.register(plugin)
    let currentManager: E2EEManager | null = manager
    h.deps.getCurrentJid = () => jid
    h.deps.getXmpp = () => connection
    h.deps.getE2EEManager = () => currentManager
    const base = original('chat', own)
    if (location !== 'missing') {
      await save('chat', base); seedPreview('chat', base)
      if (location === 'resident') seed('chat', [base])
    }
    const started = deferred(), release = deferred()
    const decrypt = plugin.decrypt.bind(plugin)
    vi.spyOn(plugin, 'decrypt').mockImplementation(async (...args) => {
      started.resolve(); await release.promise
      return { ...await decrypt(...args), securityContext: { protocolId: 'dummy-plaintext', trust: 'verified' as const }, authoredAt: new Date(FAST) }
    })
    const { payload } = (await manager.encryptOutbound({ kind: 'direct', peer: PEER }, new TextEncoder().encode('private decrypted correction')))!
    const stanza = xml('message', { id: 'c1', from: base.from, to: own ? PEER : SELF, type: 'chat' },
      xml('body', {}, payload.fallbackBody!), dataToElement(payload.stanzaElement),
      xml('replace', { xmlns: 'urn:xmpp:message-correct:0', id: base.id }),
      xml('stanza-id', { xmlns: 'urn:xmpp:sid:0', by: SELF, id: 'sid-c1' }))
    const input = shape === 'live' ? stanza : xml('message', { from: SELF },
      xml(shape, { xmlns: 'urn:xmpp:carbons:2' }, xml('forwarded', { xmlns: 'urn:xmpp:forward:0' },
        xml('delay', { xmlns: 'urn:xmpp:delay', stamp: T1 }), stanza)))
    const task = vi.spyOn(h.chat as unknown as { decryptAndReprocess: (...args: unknown[]) => Promise<void> }, 'decryptAndReprocess')
    h.chat.handle(input)
    await started.promise
    if (change === 'account' || change === 'roundtrip' || change === 'logout') {
      jid = change === 'logout' ? null : 'other@example.test'
      setStorageScopeJid(jid); chatStore.getState().switchAccount(jid)
      if (change === 'roundtrip') { jid = SELF; setStorageScopeJid(jid); chatStore.getState().switchAccount(jid) }
      chatStore.getState().addConversation({ id: PEER, name: 'Peer', type: 'chat', unreadCount: 0 })
    } else if (change === 'reset') {
      connection = null; currentManager = null; chatStore.getState().reset()
      chatStore.getState().addConversation({ id: PEER, name: 'Peer', type: 'chat', unreadCount: 0 })
    } else if (change === 'session') {
      connection = {} as NonNullable<ReturnType<ModuleDependencies['getXmpp']>>
      currentManager = (await blockedDecrypt()).manager
    } else if (change === 'manager') currentManager = null
    else if (change === 'jid') jid = `${SELF}/replacement`
    const replacement = { ...base, from: own ? (jid ?? SELF) : PEER, body: 'current session content' }
    if (change !== 'same' && location !== 'missing') {
      await save('chat', replacement); seedPreview('chat', replacement)
      seed('chat', location === 'resident' ? [replacement] : [])
    }
    const durableBefore = await cache.getMessages(PEER)
    const before = structuredClone(chatStore.getState().messages)
    const beforePreview = structuredClone(preview('chat'))
    const beforeEvents = h.events.length
    release.resolve()
    await expect(task.mock.results[0].value).resolves.toBeUndefined()
    await drain()
    if (change === 'same') {
      const rows = await cache.getMessages(PEER)
      expect(rows).toHaveLength(1)
      expect(rows[0].body).toBe('private decrypted correction')
      expect(await searchIndex.search('private')).toHaveLength(1)
      if (location !== 'missing') {
        expect(preview('chat')?.body).toBe('private decrypted correction')
        expect((rows[0] as StoredMessage).correctionTimestamp).toBe(Date.parse(FAST))
        expect((rows[0] as StoredMessage).correctionRevision?.archiveTimestamp).toBe(shape === 'live' ? undefined : Date.parse(T1))
      }
    } else {
      expect(chatStore.getState().messages).toEqual(before)
      expect(preview('chat')).toEqual(beforePreview)
      expect(await cache.getMessages(PEER)).toEqual(durableBefore)
      expect(await searchIndex.search('private')).toEqual([])
      expect(h.events.slice(beforeEvents)).toEqual([])
      cache._resetDBForTesting(); searchIndex._resetDBForTesting()
      expect(await searchIndex.search('private')).toEqual([])
      expect(await cache.getMessages(PEER)).toEqual(durableBefore)
    }
  })

  it.each([false, true].flatMap(cachedOnly => [false, true].map(roundtrip => ({ cachedOnly, roundtrip }))))(
    'guards supported groupchat plugin routing, cache-only: $cachedOnly, account roundtrip: $roundtrip', async ({ cachedOnly, roundtrip }) => {
      setStorageScopeJid(SELF)
      const h = harness('room')
      const blocked = await blockedDecrypt()
      h.deps.getE2EEManager = () => blocked.manager
      const started = deferred(), release = deferred()
      const decrypt = blocked.manager.decryptInbound.bind(blocked.manager)
      vi.spyOn(blocked.manager, 'decryptInbound').mockImplementation(async (...args) => {
        started.resolve(); await release.promise
        return decrypt(...args)
      })
      const base = original('room')
      await save('room', base); seedPreview('room', base)
      seed('room', cachedOnly ? [] : [base])
      const stanza = xml('message', { id: 'c1', from: base.from, type: 'groupchat' },
        xml('body', {}, 'encrypted fallback'),
        xml('plain', { xmlns: 'urn:fluux:e2ee-dummy:0' }, Buffer.from('private room correction').toString('base64')),
        xml('replace', { xmlns: 'urn:xmpp:message-correct:0', id: base.id }),
        xml('occupant-id', { xmlns: 'urn:xmpp:occupant-id:0', id: 'peer-occupant' }))
      const task = vi.spyOn(h.chat as unknown as { decryptAndReprocess: (...args: unknown[]) => Promise<void> }, 'decryptAndReprocess')
      h.chat.handle(stanza); await started.promise
      if (roundtrip) {
        setStorageScopeJid('other@example.test'); roomStore.getState().switchAccount('other@example.test')
        setStorageScopeJid(SELF); roomStore.getState().switchAccount(SELF)
        roomStore.getState().addRoom(createMockRoom(ROOM, { nickname: 'Peer', joined: true }))
        seed('room', cachedOnly ? [] : [base]); seedPreview('room', base)
      }
      const before = structuredClone(roomStore.getState().messages)
      const eventCount = h.events.length
      release.resolve(); await task.mock.results[0].value; await drain()
      if (roundtrip) expect(roomStore.getState().messages).toEqual(before)
      expect(preview('room')?.body).toBe(roundtrip ? base.body : 'private room correction')
      expect(roomStore.getState().rooms.get(ROOM)?.lastMessage).toEqual(preview('room'))
      expect((await reload('room')).body).toBe(roundtrip ? base.body : 'private room correction')
      expect(await searchIndex.search('private')).toHaveLength(roundtrip ? 0 : 1)
      if (roundtrip) expect(h.events.slice(eventCount)).toEqual([])
    })

  it.each(['live', 'received', 'sent'] as const)('cancels a decrypted %s retraction across an account generation', async shape => {
    setStorageScopeJid(SELF)
    const own = shape === 'sent'
    const h = harness('chat', own)
    const blocked = await blockedDecrypt()
    h.deps.getE2EEManager = () => blocked.manager
    const started = deferred(), release = deferred()
    const decrypt = blocked.manager.decryptInbound.bind(blocked.manager)
    vi.spyOn(blocked.manager, 'decryptInbound').mockImplementation(async (...args) => {
      started.resolve(); await release.promise
      return decrypt(...args)
    })
    const payload = serializePayload([xml('retract', { xmlns: 'urn:xmpp:message-retract:1', id: 'original' })])
    const stanza = xml('message', { id: 'retraction', from: own ? SELF : PEER, to: own ? PEER : SELF, type: 'chat' },
      xml('plain', { xmlns: 'urn:fluux:e2ee-dummy:0' }, Buffer.from(payload).toString('base64')))
    const input = shape === 'live' ? stanza : xml('message', {}, xml(shape, { xmlns: 'urn:xmpp:carbons:2' },
      xml('forwarded', { xmlns: 'urn:xmpp:forward:0' }, stanza)))
    const task = vi.spyOn(h.chat as unknown as { decryptAndReprocess: (...args: unknown[]) => Promise<void> }, 'decryptAndReprocess')
    h.chat.handle(input); await started.promise
    setStorageScopeJid('other@example.test'); chatStore.getState().switchAccount('other@example.test')
    setStorageScopeJid(SELF); chatStore.getState().switchAccount(SELF)
    chatStore.getState().addConversation({ id: PEER, name: 'Peer', type: 'chat', unreadCount: 0 })
    const base = original('chat', own)
    await save('chat', base); seed('chat', [base]); seedPreview('chat', base); await searchIndex.indexMessage(base)
    const eventCount = h.events.length
    release.resolve(); await task.mock.results[0].value; await drain()
    expect(resident('chat')).toEqual(base)
    expect(preview('chat')).toEqual(base)
    const durable = await reload('chat')
    expect(durable).toMatchObject(base)
    expect(durable.isRetracted).toBeFalsy()
    expect(await searchIndex.search('original')).toHaveLength(1)
    expect(h.events.slice(eventCount)).toEqual([])
  })
})

describe.each(['chat', 'global', 'room'] as const)('%s reconciled fulltext matches', mode => {
  const kind = mode === 'room' ? 'room' : 'chat'
  it.each([
    { query: 'apple', body: 'pear', matches: false },
    { query: 'apple', body: 'green APPLE', matches: true },
    { query: 'apple red', body: 'red pear', matches: false },
    { query: 'apple red', body: 'red and green apple', matches: true },
    { query: '"red apple"', body: 'apple red', matches: false },
    { query: '"red apple"', body: 'fresh red apple pie', matches: true },
    { query: 'apple', body: '', matches: false },
    { query: 'apple', body: 'apple', matches: false, retracted: true },
  ])('rechecks cached "$body" for $query', async ({ query, body, matches, retracted }) => {
    const base = { ...original(kind), body: 'red apple' }
    const h = harness(kind, false, base)
    const current = { ...base, body, isEdited: true, correctionRevision: { ids: ['stanza:c1'], supersedes: [], archiveTimestamp: Date.parse(T1) },
      ...(retracted && { isRetracted: true, retractedAt: new Date(T2) }) }
    await save(kind, current)
    const result = await h.searchResult(query, { global: mode === 'global', complete: false })
    expect(result.messages).toHaveLength(matches ? 1 : 0)
    if (matches) expect(result.messages[0].body).toBe(body)
    expect(result.complete).toBe(false)
    expect(result.page).toMatchObject({ first: base.stanzaId, last: base.stanzaId })
    const send = vi.spyOn(h.deps, 'sendIQ')
    const next = xml('message', { id: 'next', from: base.from, to: SELF, type: base.type }, xml('body', {}, 'red apple next page'))
    const nextResult = await h.searchResult(query, { global: mode === 'global', before: result.page.first, withOriginal: false, signals: [next] })
    expect(send.mock.calls[0][0].getChild('query')?.getChild('set')?.getChildText('before')).toBe(base.stanzaId)
    expect(nextResult.complete).toBe(true)
    expect(nextResult.messages.map(row => row.body)).toEqual(['red apple next page'])
  })

  it('rechecks a correction resolved within the server page', async () => {
    const h = harness(kind, false, { body: 'apple' })
    const result = await h.search([{ id: 'c1', body: 'pear', at: T1 }], true, [], false, 'apple')
    expect(result).toEqual([])
  })

  it('preserves unchanged server matches on a mixed reconciled page', async () => {
    const base = { ...original(kind), body: 'apple' }
    const h = harness(kind, false, base)
    await save(kind, { ...base, body: 'pear', isEdited: true, correctionRevision: { ids: ['stanza:c1'], supersedes: [], archiveTimestamp: Date.parse(T1) } })
    const unchanged = xml('message', { id: 'server-match', from: base.from, to: SELF, type: base.type }, xml('body', {}, 'server linguistic match'))
    const matching = xml('message', { id: 'matching', from: base.from, to: SELF, type: base.type }, xml('body', {}, 'apple original'),
      xml('stanza-id', { xmlns: 'urn:xmpp:sid:0', by: kind === 'room' ? ROOM : SELF, id: 'signal-1' }))
    await save(kind, { ...base, id: 'matching', stanzaId: 'signal-1', body: 'apple updated', isEdited: true,
      correctionRevision: { ids: ['stanza:c2'], supersedes: [], archiveTimestamp: Date.parse(T2) } })
    const result = await h.searchResult('apple', { global: mode === 'global', complete: false, signals: [unchanged, matching] })
    expect(result.messages.map(row => row.body)).toEqual(['server linguistic match', 'apple updated'])
    expect(result.page).toMatchObject({ first: base.stanzaId, last: 'signal-1' })
    expect(result.complete).toBe(false)
  })

  if (mode === 'chat') it('retains client matching and raw cursors in the paging search sibling', async () => {
    const base = { ...original(kind), body: 'apple' }
    const h = harness(kind, false, base)
    await save(kind, { ...base, body: 'pear', isEdited: true, correctionRevision: { ids: ['stanza:c1'], supersedes: [], archiveTimestamp: Date.parse(T1) } })
    const result = await h.searchResult('apple', { paging: true })
    expect(result.messages).toEqual([])
    expect(result.page).toMatchObject({ first: base.stanzaId, last: base.stanzaId })
  })
})


describe('encrypted receive through transport recovery', () => {
  it.each((['live', 'received', 'sent'] as const).flatMap(shape =>
    (['message', 'resident correction', 'cached correction', 'missing correction'] as const).flatMap(content =>
      (content === 'missing correction' ? ['disconnected', 'resumed', 'logout', 'replaced session', 'lookup resumption'] as const
        : ['disconnected', 'resumed', 'logout', 'replaced session'] as const).map(completion => ({ shape, content, completion })))))(
    'retains $shape $content completed while $completion', async ({ shape, content, completion }) => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] })
      setStorageScopeJid(SELF)
      const own = shape === 'sent'
      const h = harness('chat', own)
      const manager = (await blockedDecrypt()).manager
      let currentManager: E2EEManager | null = manager
      h.deps.getE2EEManager = () => currentManager
      const connection = new Connection(h.deps)
      h.deps.getXmpp = () => connection.getClient()
      connection.setStanzaHandler(stanza => { h.chat.handle(stanza) })
      connection.setDisconnectHandler(() => { currentManager = null })
      const sessions: boolean[] = []
      connection.setConnectionSuccessHandler(async resumed => { sessions.push(resumed) })
      const oldTransport = createMockXmppClient()
      vi.mocked(createClient).mockReturnValue(oldTransport as unknown as ReturnType<typeof createClient>)
      const connectOptions = { jid: SELF, password: 'test-password', server: 'wss://example.test/ws', skipDiscovery: true }
      const connected = connection.connect(connectOptions)
      oldTransport._emit('online')
      await connected
      Object.assign(oldTransport.streamManagement, { id: 'sm-owned-session', enabled: true, inbound: 12 })
      oldTransport._emit('nonza', xml('enabled', { xmlns: 'urn:xmpp:sm:3', id: 'sm-owned-session', resume: 'true' }))
      const base = original('chat', own)
      const correction = content !== 'message'
      const known = content === 'resident correction' || content === 'cached correction'
      if (known) {
        await save('chat', base); seedPreview('chat', base)
        if (content === 'resident correction') seed('chat', [base])
      }
      const started = deferred(), release = deferred()
      const decrypt = manager.decryptInbound.bind(manager)
      vi.spyOn(manager, 'decryptInbound').mockImplementation(async (...args) => {
        started.resolve(); await release.promise
        return decrypt(...args)
      })
      const incoming = () => xml('message', { id: 'incoming', from: own ? SELF : PEER, to: own ? PEER : SELF, type: 'chat' },
        xml('body', {}, 'encrypted fallback'),
        xml('plain', { xmlns: 'urn:fluux:e2ee-dummy:0' }, Buffer.from('recovered received content').toString('base64')),
        xml('stanza-id', { xmlns: 'urn:xmpp:sid:0', by: SELF, id: 'incoming-archive' }),
        ...(correction ? [xml('replace', { xmlns: 'urn:xmpp:message-correct:0', id: base.id })] : []))
      const envelope = () => {
        const stanza = incoming()
        return shape === 'live' ? stanza : xml('message', { from: SELF },
          xml(shape, { xmlns: 'urn:xmpp:carbons:2' }, xml('forwarded', { xmlns: 'urn:xmpp:forward:0' }, stanza)))
      }
      const task = vi.spyOn(h.chat as unknown as { decryptAndReprocess: (...args: unknown[]) => Promise<void> }, 'decryptAndReprocess')
      oldTransport.streamManagement.inbound++
      oldTransport._emit('stanza', envelope())
      await started.promise
      const lookupReleased = deferred()
      if (completion === 'lookup resumption') {
        const lookupStarted = deferred()
        const apply = vi.mocked(cache.applyChatCorrection).getMockImplementation()!
        vi.mocked(cache.applyChatCorrection).mockImplementationOnce((...args) => {
          const pending = (async () => {
            const result = await apply(...args)
            lookupStarted.resolve(); await lookupReleased.promise
            return result
          })()
          writes.push(pending)
          return pending
        })
        release.resolve(); await task.mock.results[0].value; await lookupStarted.promise
      }
      connection.handleDeadSocket()
      expect(connection.getClient()).toBeNull()
      expect(connection.getStreamManagementState()).toMatchObject({ id: 'sm-owned-session', inbound: 13 })
      const replacement = createMockXmppClient()
      const resume = async () => {
        vi.mocked(createClient).mockReturnValue(replacement as unknown as ReturnType<typeof createClient>)
        await vi.advanceTimersByTimeAsync(1000)
        expect(connection.getClient()).toBe(replacement)
        expect(replacement.streamManagement.inbound).toBe(13)
        replacement._emit('nonza', xml('resumed', { xmlns: 'urn:xmpp:sm:3', previd: 'sm-owned-session', h: '0' }))
        await vi.advanceTimersByTimeAsync(0)
        expect(sessions).toEqual([false, true])
        expect(currentManager).toBe(manager)
      }
      try {
        if (completion === 'resumed' || completion === 'lookup resumption') await resume()
        else if (completion === 'logout' || completion === 'replaced session') {
          await connection.disconnect()
          expect(currentManager).toBeNull()
          if (completion === 'replaced session') {
            currentManager = (await blockedDecrypt()).manager
            vi.mocked(createClient).mockReturnValue(replacement as unknown as ReturnType<typeof createClient>)
            const next = connection.connect(connectOptions)
            replacement._emit('online'); await next
            expect(currentManager).not.toBe(manager)
          }
        }
        lookupReleased.resolve(); release.resolve(); await task.mock.results[0].value; await drain()
        const cancelled = completion === 'logout' || completion === 'replaced session'
        let rows = await cache.getMessages(PEER)
        expect(rows).toHaveLength(known || !cancelled ? 1 : 0)
        expect(rows[0]?.body).toBe(cancelled ? (known ? base.body : undefined) : 'recovered received content')
        if (known) expect(preview('chat')?.body).toBe(cancelled ? base.body : 'recovered received content')
        expect(await searchIndex.search('recovered')).toHaveLength(cancelled ? 0 : 1)
        if (cancelled) return
        if (completion === 'disconnected') await resume()
        const eventCount = h.events.filter(({ event }) => event === (correction ? 'chat:message-updated' : 'chat:message')).length
        expect(eventCount).toBe(1)
        replacement._emit('stanza', envelope()); await task.mock.results.at(-1)!.value; await drain()
        cache._resetDBForTesting(); searchIndex._resetDBForTesting(); seed('chat', [])
        rows = await cache.getMessages(PEER)
        expect(rows).toHaveLength(1)
        expect(rows[0].body).toBe('recovered received content')
        expect(await searchIndex.search('recovered')).toHaveLength(1)
        if (known) expect(rows[0]).toMatchObject({ id: base.id, stanzaId: base.stanzaId, timestamp: base.timestamp })
      } finally { release.resolve(); lookupReleased.resolve(); await connection.disconnect(); connection.getConnectionActor().stop() }
    })
})

describe('deferred decrypt queued across account cancellation', () => {
  it.each((['chat resident', 'chat cache', 'chat preview', 'room resident'] as const).flatMap(path =>
    (['changed', 'same', 'unavailable manager', 'locked key'] as const).map(mode => ({ path, mode }))))(
    'drains a $path retry after $mode', async ({ path, mode }) => {
      const kind = path === 'room resident' ? 'room' : 'chat'
      setStorageScopeJid(SELF)
      const h = harness(kind)
      const blocked = await blockedDecrypt('old account plaintext')
      let manager: E2EEManager | null = blocked.manager
      let jid = SELF
      const engine = new DeferredDecryptEngine({ getManager: () => manager, getStores: () => h.stores, getOwnBareJid: () => jid, cache, updateSearchIndex: searchIndex.updateMessage })
      const locked = { ...original(kind), body: 'locked correction', isEdited: true,
        correctionRevision: { ids: ['stanza:locked-edit'], supersedes: [], archiveTimestamp: Date.parse(T1) },
        encryptedPayload: '<message><body>locked correction</body><plain xmlns="urn:fluux:e2ee-dummy:0">cGF5bG9hZA==</plain></message>' }
      const install = async () => {
        if (path !== 'chat preview') await save(kind, locked)
        seed(kind, path.endsWith('resident') ? [locked] : [])
        seedPreview(kind, locked)
      }
      await install()
      const work = engine.retryPending()
      await blocked.started.promise
      let decryptCurrent = vi.mocked(blocked.manager.decryptArchive)
      if (mode !== 'same') {
        jid = 'next@example.test'; setStorageScopeJid(jid)
        chatStore.getState().switchAccount(jid); roomStore.getState().switchAccount(jid)
        chatStore.getState().addConversation({ id: PEER, name: 'Peer', type: 'chat', unreadCount: 0 })
        roomStore.getState().addRoom(createMockRoom(ROOM, { nickname: 'Peer', joined: true }))
        manager = (await blockedDecrypt()).manager
        decryptCurrent = vi.mocked(manager.decryptArchive)
        decryptCurrent.mockResolvedValue({ plaintext: new TextEncoder().encode('current account recovery'), senderDevice: { jid: PEER, deviceId: 'test' }, securityContext: { protocolId: 'dummy-plaintext', trust: 'verified' } })
        if (mode === 'unavailable manager') manager = null
        if (mode === 'locked key') decryptCurrent.mockResolvedValue(null)
        await install()
      }
      expect(await engine.retryPending()).toBe(0)
      expect(await engine.retryPending()).toBe(0)
      blocked.release.resolve(); await work; await drain()
      const recovered = mode === 'changed' || mode === 'same'
      const expectedBody = mode === 'same' ? 'old account plaintext' : recovered ? 'current account recovery' : locked.body
      expect(preview(kind)?.body).toBe(expectedBody)
      if (kind === 'room') expect(roomStore.getState().rooms.get(ROOM)?.lastMessage).toEqual(preview(kind))
      if (path !== 'chat preview') expect((await reload(kind)).body).toBe(expectedBody)
      if (mode !== 'same') expect(await searchIndex.search('old')).toEqual([])
      if (mode === 'changed') expect(decryptCurrent).toHaveBeenCalledTimes(1)
      if (mode === 'unavailable manager') expect(decryptCurrent).not.toHaveBeenCalled()
      if (mode === 'locked key') expect(decryptCurrent).toHaveBeenCalledTimes(1)
      if (mode === 'same') expect(await engine.retryPending()).toBe(0)
    })
})

describe.each(['chat', 'global', 'room'] as const)('%s tokenless reconciled search', mode => {
  const kind = mode === 'room' ? 'room' : 'chat'
  it.each(['x', '👍', '!!!', '"x"', '"👍"'])('filters changed results for %s without changing the server page', async query => {
    const phrase = query.startsWith('"')
    const term = query.replaceAll('"', '')
    const base = { ...original(kind), body: term }
    const h = harness(kind, false, base)
    await save(kind, { ...base, body: 'pear', isEdited: true, correctionRevision: { ids: ['stanza:edit'], supersedes: [], archiveTimestamp: Date.parse(T1) } })
    const empty = await h.searchResult(query, { global: mode === 'global', complete: false })
    expect(empty.messages).toEqual([])
    expect(empty.complete).toBe(false)
    expect(empty.page).toMatchObject({ first: base.stanzaId, last: base.stanzaId })
    const unchanged = xml('message', { id: 'unchanged', from: base.from, to: SELF, type: base.type }, xml('body', {}, term))
    const modified = xml('message', { id: 'modified', from: base.from, to: SELF, type: base.type }, xml('body', {}, term),
      xml('stanza-id', { xmlns: 'urn:xmpp:sid:0', by: kind === 'room' ? ROOM : SELF, id: 'signal-1' }))
    await save(kind, { ...base, id: 'modified', stanzaId: 'signal-1', body: `new ${term}`, isEdited: true,
      correctionRevision: { ids: ['stanza:other-edit'], supersedes: [], archiveTimestamp: Date.parse(T1) } })
    const mixed = await h.searchResult(query, { global: mode === 'global', complete: false, signals: [unchanged, modified] })
    expect(mixed.messages.map(row => row.body)).toEqual(phrase ? [term, `new ${term}`] : [term])
    expect(mixed.page).toMatchObject({ first: base.stanzaId, last: 'signal-1' })
    expect(mixed.complete).toBe(false)
    expect(await h.search([{ id: 'c2', body: 'pear', at: T2 }], true, [], false, query)).toEqual([])
  })
})

describe('receive order survives deferred correction completion', () => {
  it.each((['live', 'received', 'sent'] as const).flatMap(shape =>
    (['resident', 'cache', 'preview', 'missing'] as const).flatMap(path =>
      [false, true].flatMap(resume => [false, true].flatMap(encryptedNewer => [
        'original', 'replay', 'original first', 'newer forwarded', 'newer outer', 'replay forwarded', 'replay outer', 'mixed duplicate first', 'mixed original first',
      ].map(scenario => ({ shape, path, resume, encryptedNewer, scenario })))))))(
    'retains C2 for $shape $path resume=$resume encryptedNewer=$encryptedNewer $scenario', async ({ shape, path, resume, encryptedNewer, scenario }) => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] })
      setStorageScopeJid(SELF)
      const own = shape === 'sent'
      const h = harness('chat', own)
      const manager = (await blockedDecrypt()).manager
      h.deps.getE2EEManager = () => manager
      const connection = new Connection(h.deps)
      h.deps.getXmpp = () => connection.getClient()
      connection.setStanzaHandler(stanza => { h.chat.handle(stanza) })
      connection.setConnectionSuccessHandler(async () => {})
      const transport = createMockXmppClient()
      vi.mocked(createClient).mockReturnValue(transport as unknown as ReturnType<typeof createClient>)
      const connected = connection.connect({ jid: SELF, password: 'test-password', server: 'wss://example.test/ws', skipDiscovery: true })
      transport._emit('online'); await connected
      Object.assign(transport.streamManagement, { id: 'ordered-stream', enabled: true, inbound: 1 })
      transport._emit('nonza', xml('enabled', { xmlns: 'urn:xmpp:sm:3', id: 'ordered-stream', resume: 'true' }))
      const base = original('chat', own)
      if (path === 'resident' || path === 'cache') await save('chat', base)
      if (path === 'resident') seed('chat', [base])
      if (path !== 'missing') seedPreview('chat', base)
      const started = deferred(), release = deferred()
      const decrypt = manager.decryptInbound.bind(manager)
      vi.spyOn(manager, 'decryptInbound').mockImplementationOnce(async (...args) => {
        started.resolve(); await release.promise; return decrypt(...args)
      })
      const stanza = (id: string, body: string, encrypted: boolean, delayed = '') => {
        const message = xml('message', { id, from: own ? SELF : PEER, to: own ? PEER : SELF, type: 'chat' },
          xml('body', {}, encrypted ? 'encrypted fallback' : body),
          ...(encrypted ? [xml('plain', { xmlns: 'urn:fluux:e2ee-dummy:0' }, Buffer.from(body).toString('base64'))] : []),
          xml('stanza-id', { xmlns: 'urn:xmpp:sid:0', by: SELF, id: `archive-${id}` }),
          xml('replace', { xmlns: 'urn:xmpp:message-correct:0', id: base.id }))
        const delay = xml('delay', { xmlns: 'urn:xmpp:delay', stamp: id === 'c1' ? T1 : T2 })
        if (shape === 'live') { if (delayed) message.children.push(delay); return message }
        return xml('message', { from: SELF }, ...(delayed === 'outer' ? [delay] : []),
          xml(shape, { xmlns: 'urn:xmpp:carbons:2' }, xml('forwarded', { xmlns: 'urn:xmpp:forward:0' },
            ...(delayed === 'forwarded' ? [delay] : []), message)))
      }
      const tasks = vi.spyOn(h.chat as unknown as { decryptAndReprocess: (...args: unknown[]) => Promise<void> }, 'decryptAndReprocess')
      transport._emit('stanza', stanza('c1', 'older private correction', true))
      await started.promise
      try {
        if (resume) {
          connection.handleDeadSocket()
          const replacement = createMockXmppClient()
          vi.mocked(createClient).mockReturnValue(replacement as unknown as ReturnType<typeof createClient>)
          await vi.advanceTimersByTimeAsync(1000)
          replacement._emit('nonza', xml('resumed', { xmlns: 'urn:xmpp:sm:3', previd: 'ordered-stream', h: '0' }))
          await vi.advanceTimersByTimeAsync(0)
        }
        h.chat.handle(stanza('c2', 'newer current correction', encryptedNewer,
          scenario === 'newer forwarded' || scenario === 'mixed duplicate first' ? 'forwarded' :
            scenario === 'newer outer' || scenario === 'mixed original first' ? 'outer' : ''))
        if (encryptedNewer) await tasks.mock.results[1].value
        await drain()
        expect((await cache.getMessages(PEER))[0].body).toBe('newer current correction')
        if (scenario.startsWith('replay') || scenario.includes('first')) {
          const duplicateRelease = deferred(), duplicateStarted = deferred()
          const originalFirst = scenario.includes('original first')
          if (originalFirst) vi.mocked(manager.decryptInbound).mockImplementationOnce(async (...args) => {
            duplicateStarted.resolve(); await duplicateRelease.promise; return decrypt(...args)
          })
          h.chat.handle(stanza('c1', 'older private correction', true,
            scenario === 'replay forwarded' || scenario === 'mixed original first' ? 'forwarded' :
              scenario === 'replay outer' || scenario === 'mixed duplicate first' ? 'outer' : ''))
          if (originalFirst) {
            await duplicateStarted.promise
            release.resolve(); await tasks.mock.results[0].value; await drain()
            duplicateRelease.resolve()
          }
          await tasks.mock.results.at(-1)!.value; await drain()
          expect((await cache.getMessages(PEER))[0].body).toBe('newer current correction')
        }
        release.resolve(); await tasks.mock.results[0].value; await drain()
        const current = await reload('chat')
        expect(current.body).toBe('newer current correction')
        expect(current.correctionRevision?.ids).toContain('stanza:archive-c2')
        expect(current.correctionRevision?.supersedes).toContain('stanza:archive-c1')
        expect([current.stanzaId, ...(current.correctionStanzaIds ?? [])]).toEqual(expect.arrayContaining(['archive-c1', 'archive-c2']))
        expect(preview('chat')?.body).toBe('newer current correction')
        expect(await searchIndex.search('older')).toEqual([])
        expect(await searchIndex.search('newer')).toHaveLength(1)
        if (path === 'resident' || path === 'cache') expect(current).toMatchObject({ id: base.id, stanzaId: base.stanzaId, timestamp: base.timestamp })
        const emitted = h.events.filter(e => e.event === 'chat:message-updated').map(e => (e.payload as SDKEvents['chat:message-updated']).updates as StoredMessage)
        expect(emitted.filter(u => u.correctionRevision?.ids.includes('stanza:archive-c1')).every(u => !u.correctionRevision?.supersedes.includes('stanza:archive-c2'))).toBe(true)
        h.chat.handle(xml('message', { from: own ? SELF : PEER, to: own ? PEER : SELF, type: 'chat' },
          xml('retract', { xmlns: 'urn:xmpp:message-retract:1', id: 'archive-c1' })))
        await drain()
        expect((await reload('chat')).isRetracted).toBe(true)
        expect(await searchIndex.search('newer')).toEqual([])
      } finally { release.resolve(); await connection.disconnect(); connection.getConnectionActor().stop() }
    })
})

describe.each(['chat', 'room'] as const)('%s context loading ownership', kind => {
  const state = () => kind === 'chat' ? chatStore.getState().getMAMQueryState(PEER) : roomStore.getState().getRoomMAMQueryState(ROOM)
  it('allows later pagination after context cancellation through SM resumption', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] })
    setStorageScopeJid(SELF)
    const h = harness(kind)
    const connection = new Connection(h.deps)
    h.deps.getXmpp = () => connection.getClient()
    connection.setConnectionSuccessHandler(async () => {})
    const transport = createMockXmppClient()
    vi.mocked(createClient).mockReturnValue(transport as unknown as ReturnType<typeof createClient>)
    const connected = connection.connect({ jid: SELF, password: 'test-password', server: 'wss://example.test/ws', skipDiscovery: true })
    transport._emit('online'); await connected
    Object.assign(transport.streamManagement, { id: 'context-stream', enabled: true, inbound: 1 })
    transport._emit('nonza', xml('enabled', { xmlns: 'urn:xmpp:sm:3', id: 'context-stream', resume: 'true' }))
    const started = deferred(), release = deferred()
    const send = h.deps.sendIQ
    h.deps.sendIQ = async iq => { started.resolve(); await release.promise; return send(iq) }
    const work = h.chat.fetchContextAround(kind === 'chat' ? PEER : ROOM, T0, 2).catch(error => error)
    const previousStatus = connectionStore.getState().status
    try {
      await started.promise
      connection.handleDeadSocket()
      const replacement = createMockXmppClient()
      vi.mocked(createClient).mockReturnValue(replacement as unknown as ReturnType<typeof createClient>)
      await vi.advanceTimersByTimeAsync(1000)
      replacement._emit('nonza', xml('resumed', { xmlns: 'urn:xmpp:sm:3', previd: 'context-stream', h: '0' }))
      await vi.advanceTimersByTimeAsync(0)
      release.resolve()
      expect(await work).toMatchObject({ name: 'AbortError' })
      expect(state().isLoading).toBe(false)
      h.deps.sendIQ = send
      const query = vi.fn(async () => { await h.archive([], true) })
      const fetchOlder = createFetchOlderHistory({
        getActiveId: () => kind === 'chat' ? PEER : ROOM, isValidTarget: () => true, getMAMState: state,
        setMAMLoading: kind === 'chat' ? chatStore.getState().setMAMLoading : roomStore.getState().setRoomMAMLoading,
        loadFromCache: async () => [], getOldestMessageId: () => 'archive-original', queryMAM: query, errorLogPrefix: 'Context test',
      })
      connectionStore.setState({ status: 'online' })
      await fetchOlder()
      expect(query).toHaveBeenCalledTimes(1)
      expect(state()).toMatchObject({ isLoading: false, hasQueried: true, error: null })
    } finally {
      release.resolve(); await connection.disconnect(); connection.getConnectionActor().stop()
      connectionStore.setState({ status: previousStatus })
    }
  })
  it.each(['transport', 'account', 'roundtrip'] as const)('releases only current-account loading after %s cancellation', async mode => {
    setStorageScopeJid(SELF)
    const h = harness(kind)
    let jid = SELF
    let transport = createMockXmppClient()
    h.deps.getCurrentJid = () => jid
    h.deps.getXmpp = () => transport as unknown as ReturnType<typeof createClient>
    const started = deferred(), release = deferred()
    const send = h.deps.sendIQ
    h.deps.sendIQ = async iq => { started.resolve(); await release.promise; return send(iq) }
    const work = h.chat.fetchContextAround(kind === 'chat' ? PEER : ROOM, T0, 2).catch(error => error)
    await started.promise
    expect(state().isLoading).toBe(true)
    if (mode === 'transport') transport = createMockXmppClient()
    else {
      jid = 'next@example.test'; setStorageScopeJid(jid)
      if (mode === 'roundtrip') { jid = SELF; setStorageScopeJid(jid) }
      if (kind === 'chat') chatStore.getState().setMAMLoading(PEER, true)
      else roomStore.getState().setRoomMAMLoading(ROOM, true)
    }
    release.resolve()
    expect(await work).toMatchObject({ name: 'AbortError' })
    expect(state().isLoading).toBe(mode !== 'transport')
    expect(h.events.filter(e => e.event === `${kind}:history-error`)).toEqual([])
    h.deps.sendIQ = send
    await h.archive([], true)
    expect(state().isLoading).toBe(false)
    expect(state().hasQueried).toBe(true)
  })
  it.each([false, true].flatMap(newerFirst => ['success', 'error', 'transport'].map(outcome => ({ newerFirst, outcome }))))(
    'preserves the newer slot when older $outcome settles newerFirst=$newerFirst', async ({ newerFirst, outcome }) => {
      setStorageScopeJid(SELF)
      const h = harness(kind)
      let transport = createMockXmppClient()
      h.deps.getXmpp = () => transport as unknown as ReturnType<typeof createClient>
      const send = h.deps.sendIQ
      const releases = [deferred(), deferred()], starts = [deferred(), deferred()]
      let calls = 0
      h.deps.sendIQ = async iq => {
        const index = calls++
        starts[index].resolve(); await releases[index].promise
        if (index === 0 && outcome === 'error') throw new Error('old query failed')
        return send(iq)
      }
      const request = () => h.chat.fetchContextAround(kind === 'chat' ? PEER : ROOM, T0, 2).catch(error => error)
      const first = request(); await starts[0].promise
      if (outcome === 'transport') transport = createMockXmppClient()
      const second = request(); await starts[1].promise
      expect(state().isLoading).toBe(true)
      if (newerFirst) {
        releases[1].resolve(); await second
        expect(state().isLoading).toBe(false)
        releases[0].resolve(); await first
      } else {
        releases[0].resolve(); await first
        expect(state().isLoading).toBe(true)
        releases[1].resolve(); await second
      }
      expect(state().isLoading).toBe(false)
      expect(state().error).toBeNull()
      h.deps.sendIQ = send
      await h.archive([], true)
      expect(state().hasQueried).toBe(true)
    })
})


it('keeps a local outgoing correction ahead of an earlier encrypted sent carbon', async () => {
  setStorageScopeJid(SELF)
  const h = harness('chat', true)
  const base = original('chat', true)
  await save('chat', base); seed('chat', [base]); seedPreview('chat', base)
  const manager = (await blockedDecrypt()).manager
  h.deps.getE2EEManager = () => manager
  const started = deferred(), release = deferred()
  const decrypt = manager.decryptInbound.bind(manager)
  vi.spyOn(manager, 'decryptInbound').mockImplementationOnce(async (...args) => {
    started.resolve(); await release.promise; return decrypt(...args)
  })
  const task = vi.spyOn(h.chat as unknown as { decryptAndReprocess: (...args: unknown[]) => Promise<void> }, 'decryptAndReprocess')
  h.chat.handle(xml('message', { from: SELF }, xml('sent', { xmlns: 'urn:xmpp:carbons:2' },
    xml('forwarded', { xmlns: 'urn:xmpp:forward:0' }, xml('message', { id: 'c1', from: SELF, to: PEER, type: 'chat' },
      xml('body', {}, 'encrypted fallback'), xml('plain', { xmlns: 'urn:fluux:e2ee-dummy:0' }, Buffer.from('older private correction').toString('base64')),
      xml('replace', { xmlns: 'urn:xmpp:message-correct:0', id: base.id }))))))
  await started.promise
  await h.outgoing('newer local correction')
  release.resolve(); await task.mock.results[0].value; await drain()
  expect((await reload('chat')).body).toBe('newer local correction')
  expect(preview('chat')?.body).toBe('newer local correction')
  expect(await searchIndex.search('older')).toEqual([])
  expect(await searchIndex.search('newer')).toHaveLength(1)
})


it.each(['success', 'send error', 'account change'] as const)('orders outgoing edits after encryption: %s', async outcome => {
  setStorageScopeJid(SELF)
  const h = harness('chat', true)
  const base = original('chat', true)
  await save('chat', base); seed('chat', [base]); seedPreview('chat', base)
  const manager = (await blockedDecrypt()).manager
  h.deps.getE2EEManager = () => manager
  const started = deferred(), release = deferred()
  const encrypt = manager.encryptOutbound.bind(manager)
  vi.spyOn(manager, 'encryptOutbound').mockImplementationOnce(async (...args) => {
    started.resolve(); await release.promise; return encrypt(...args)
  })
  const outgoing = h.outgoing('later successful local edit').catch(error => error)
  await started.promise
  h.chat.handle(xml('message', { from: SELF }, xml('sent', { xmlns: 'urn:xmpp:carbons:2' },
    xml('forwarded', { xmlns: 'urn:xmpp:forward:0' }, xml('message', { id: 'other-device', from: SELF, to: PEER, type: 'chat' },
      xml('body', {}, 'intervening carbon edit'), xml('origin-id', { xmlns: 'urn:xmpp:sid:0', id: 'other-device' }),
      xml('replace', { xmlns: 'urn:xmpp:message-correct:0', id: base.id }))))))
  await drain()
  expect((await cache.getMessages(PEER))[0].body).toBe('intervening carbon edit')
  if (outcome === 'send error') h.deps.sendStanza = async () => { throw new Error('send failed') }
  if (outcome === 'account change') setStorageScopeJid('other@example.test')
  release.resolve()
  const result = await outgoing
  if (outcome === 'account change') setStorageScopeJid(SELF)
  expect(result instanceof Error).toBe(outcome !== 'success')
  const current = await reload('chat')
  expect(current.body).toBe(outcome === 'success' ? 'later successful local edit' : 'intervening carbon edit')
  expect(preview('chat')?.body).toBe(current.body)
  expect(current.timestamp).toEqual(base.timestamp)
  if (outcome === 'success') {
    expect(current.correctionRevision?.supersedes).toContain('origin:other-device')
    expect(await searchIndex.search('intervening')).toEqual([])
    expect(await searchIndex.search('successful')).toHaveLength(1)
  }
})

describe.each<Kind>(['chat', 'room'])('%s asynchronous correction request failure', kind => {
  it('observes the transaction rejection and repairs the failed write on replay', async () => {
    setStorageScopeJid(SELF)
    const h = harness(kind)
    const base = original(kind)
    await save(kind, base); seed(kind, [base]); seedPreview(kind, base); await searchIndex.indexMessage(base)
    const unhandled: unknown[] = []
    const onUnhandled = (error: unknown) => { unhandled.push(error) }
    process.on('unhandledRejection', onUnhandled)
    const put = IDBObjectStore.prototype.put
    let requestError: DOMException | null = null
    let failed = false
    const fault = vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(function (this: IDBObjectStore, ...args) {
      if (this.name === (kind === 'chat' ? 'messages-canonical' : 'room-messages-canonical') && !failed) {
        failed = true
        const request = this.add(...args)
        request.addEventListener('error', () => { requestError = request.error })
        return request
      }
      return put.apply(this, args)
    })
    const offset = writes.length
    try {
      h.receive({ id: 'c1', body: 'repaired content' })
      const pending = writes.slice(offset)
      for (let i = offset; i < writes.length; i++) writes[i] = writes[i].catch(() => {})
      const results = await Promise.allSettled(pending)
      await new Promise(resolve => setTimeout(resolve, 0)); await drain()
      expect(requestError).toMatchObject({ name: 'ConstraintError' })
      expect(results.filter(result => result.status === 'rejected')).toHaveLength(1)
      expect(unhandled).toEqual([])
      const read = () => kind === 'chat' ? cache.getMessages(PEER) : cache.getRoomMessages(ROOM, {})
      expect((await read())[0].body).toBe(base.body)
      expect(await searchIndex.search('original')).toHaveLength(1)
      fault.mockRestore()
      await h.archivePages([{ edits: [{ id: 'c1', body: 'repaired content', at: T1 }] }], true)
      expect((await reload(kind)).body).toBe('repaired content')
      expect(preview(kind)?.body).toBe('repaired content')
      expect(await searchIndex.search('repaired')).toHaveLength(1)
      expect(await searchIndex.search('original')).toEqual([])
    } finally { fault.mockRestore(); process.removeListener('unhandledRejection', onUnhandled) }
  })
})

describe.each(['live', 'received', 'sent'] as const)('%s pending correction identity', shape => {
  it.each([false, true].flatMap(resident => [false, true].map(enrich => ({ resident, enrich })) ))(
    'retains alias enrichment without collapsing conflicting archives resident=$resident enrich=$enrich', async ({ resident: inMemory, enrich }) => {
      setStorageScopeJid(SELF)
      const own = shape === 'sent'
      const h = harness('chat', own)
      const base = original('chat', own)
      await save('chat', base); if (inMemory) seed('chat', [base]); seedPreview('chat', base)
      const manager = (await blockedDecrypt()).manager
      h.deps.getE2EEManager = () => manager
      const started = deferred(), release = deferred()
      const decrypt = manager.decryptInbound.bind(manager)
      vi.spyOn(manager, 'decryptInbound').mockImplementationOnce(async (...args) => {
        started.resolve(); await release.promise; return decrypt(...args)
      })
      const tasks = vi.spyOn(h.chat as unknown as { decryptAndReprocess: (...args: unknown[]) => Promise<void> }, 'decryptAndReprocess')
      const stanza = (id: string, body: string, archive: string | undefined, encrypted: boolean) => {
        const message = xml('message', { id, from: own ? SELF : PEER, to: own ? PEER : SELF, type: 'chat' },
          xml('body', {}, encrypted ? 'encrypted fallback' : body),
          ...(encrypted ? [xml('plain', { xmlns: 'urn:fluux:e2ee-dummy:0' }, Buffer.from(body).toString('base64'))] : []),
          ...(archive ? [xml('stanza-id', { xmlns: 'urn:xmpp:sid:0', by: SELF, id: archive })] : []),
          xml('replace', { xmlns: 'urn:xmpp:message-correct:0', id: base.id }))
        return shape === 'live' ? message : xml('message', { from: SELF }, xml(shape, { xmlns: 'urn:xmpp:carbons:2' },
          xml('forwarded', { xmlns: 'urn:xmpp:forward:0' }, message)))
      }
      h.chat.handle(stanza('shared', 'older encrypted revision', enrich ? undefined : 's1', true))
      await started.promise
      try {
        h.chat.handle(stanza('middle', 'middle revision', 's2', false)); await drain()
        h.chat.handle(stanza('shared', 'older encrypted revision', 's1', true))
        await tasks.mock.results[1].value; await drain()
        expect((await cache.getMessages(PEER))[0].body).toBe('middle revision')
        h.chat.handle(stanza('shared', 'latest distinct revision', 's3', false)); await drain()
        expect((await cache.getMessages(PEER))[0].body).toBe('latest distinct revision')
        release.resolve(); await tasks.mock.results[0].value; await drain()
        const current = await reload('chat')
        expect(current).toMatchObject({ id: base.id, stanzaId: base.stanzaId, timestamp: base.timestamp, body: 'latest distinct revision' })
        expect(current.correctionRevision?.ids).toEqual(expect.arrayContaining(['id:shared', 'stanza:s3']))
        expect(current.correctionRevision?.ids).not.toContain('stanza:s1')
        expect(current.correctionRevision?.supersedes).toEqual(expect.arrayContaining(['stanza:s1', 'stanza:s2']))
        expect(preview('chat')?.body).toBe(current.body)
        expect(await searchIndex.search('older')).toEqual([])
        expect(await searchIndex.search('latest')).toHaveLength(1)
        await h.archivePages([{ edits: [{ id: 'shared', body: 'older encrypted revision', stanzaId: 's1', omitOriginId: true, at: T1 }] }], true)
        expect((await reload('chat')).body).toBe('latest distinct revision')
        h.chat.handle(xml('message', { from: own ? SELF : PEER, to: own ? PEER : SELF, type: 'chat' },
          xml('retract', { xmlns: 'urn:xmpp:message-retract:1', id: 's1' })))
        await drain()
        expect((await reload('chat')).isRetracted).toBe(true)
      } finally { release.resolve(); await tasks.mock.results[0].value }
    })
})

it('keeps pending weak correction identities scoped to the sender and conversation', async () => {
  setStorageScopeJid(SELF)
  const h = harness('chat')
  const base = original('chat')
  const otherPeer = 'other-peer@example.test'
  const other = { ...base, conversationId: otherPeer, from: otherPeer }
  chatStore.getState().addConversation({ id: otherPeer, name: 'Other', type: 'chat', unreadCount: 0 })
  await save('chat', base, other); seed('chat', [base]); seedPreview('chat', base)
  const manager = (await blockedDecrypt()).manager
  h.deps.getE2EEManager = () => manager
  const started = deferred(), release = deferred()
  const decrypt = manager.decryptInbound.bind(manager)
  vi.spyOn(manager, 'decryptInbound').mockImplementationOnce(async (...args) => {
    started.resolve(); await release.promise; return decrypt(...args)
  })
  const tasks = vi.spyOn(h.chat as unknown as { decryptAndReprocess: (...args: unknown[]) => Promise<void> }, 'decryptAndReprocess')
  h.chat.handle(xml('message', { id: 'shared', from: otherPeer, to: SELF, type: 'chat' },
    xml('body', {}, 'encrypted fallback'), xml('plain', { xmlns: 'urn:fluux:e2ee-dummy:0' }, Buffer.from('other sender content').toString('base64')),
    xml('replace', { xmlns: 'urn:xmpp:message-correct:0', id: base.id })))
  await started.promise
  try {
    await h.live({ id: 'middle', body: 'middle revision', omitOriginId: true, omitStanzaId: true })
    await h.live({ id: 'shared', body: 'latest peer revision', omitOriginId: true, omitStanzaId: true })
    release.resolve(); await tasks.mock.results[0].value; await drain()
    expect((await reload('chat')).body).toBe('latest peer revision')
    expect((await cache.getMessages(otherPeer))[0].body).toBe('other sender content')
    expect(preview('chat')?.body).toBe('latest peer revision')
  } finally { release.resolve(); await tasks.mock.results[0].value }
})

describe('pending live corrections across bounded MAM pages', () => {
  it.each((['live', 'received', 'sent', 'room'] as const).flatMap(shape =>
    (['resident', 'cache', 'preview'] as const).flatMap(path => [false, true].flatMap(encrypted =>
      [false, true].map(replay => ({ shape, path, encrypted, replay }))))))(
    'preserves MAM C2 against earlier $shape C1 path=$path encrypted=$encrypted replay=$replay', async ({ shape, path, encrypted, replay }) => {
      setStorageScopeJid(SELF)
      const kind = shape === 'room' ? 'room' : 'chat'
      const own = shape === 'sent'
      const h = harness(kind, own)
      const base = original(kind, own)
      await save(kind, base)
      if (path === 'resident') seed(kind, [base])
      if (path !== 'cache') seedPreview(kind, base)
      const manager = (await blockedDecrypt()).manager
      vi.mocked(manager.decryptArchive).mockRestore()
      h.deps.getE2EEManager = () => manager
      const started = deferred(), release = deferred()
      const decrypt = manager.decryptInbound.bind(manager)
      vi.spyOn(manager, 'decryptInbound').mockImplementationOnce(async (...args) => {
        started.resolve(); await release.promise; return decrypt(...args)
      })
      const tasks = vi.spyOn(h.chat as unknown as { decryptAndReprocess: (...args: unknown[]) => Promise<void> }, 'decryptAndReprocess')
      const c1 = () => {
        const message = h.stanza({ id: 'c1', body: 'earlier private correction', encrypted: true, to: own ? PEER : SELF })
        return shape === 'received' || shape === 'sent' ? xml('message', { from: SELF },
          xml(shape, { xmlns: 'urn:xmpp:carbons:2' }, xml('forwarded', { xmlns: 'urn:xmpp:forward:0' }, message))) : message
      }
      h.chat.handle(c1()); await started.promise
      try {
        await h.archivePages([{ edits: [{ id: 'c2', body: 'newer archive correction', encrypted, at: T2, to: own ? PEER : SELF }] }], true)
        expect((kind === 'chat' ? await cache.getMessages(PEER) : await cache.getRoomMessages(ROOM, {}))[0].body).toBe('newer archive correction')
        if (replay) { h.chat.handle(c1()); await tasks.mock.results.at(-1)!.value; await drain() }
        release.resolve(); await tasks.mock.results[0].value; await drain()
        await h.archivePages([{ edits: [{ id: 'c1', body: 'earlier private correction', at: T1, to: own ? PEER : SELF }] }], true)
        const current = await reload(kind)
        expect(current).toMatchObject({ id: base.id, stanzaId: base.stanzaId, timestamp: base.timestamp, body: 'newer archive correction' })
        expect(current.correctionRevision?.ids).toContain('stanza:sid-c2')
        expect(current.correctionRevision?.supersedes).toContain('stanza:sid-c1')
        if (path !== 'cache') expect(preview(kind)?.body).toBe(current.body)
        expect(await searchIndex.search('earlier')).toEqual([])
        expect(await searchIndex.search('newer')).toHaveLength(1)
        await h.live({ id: 'c2', body: 'newer archive correction', to: own ? PEER : SELF })
        await h.live({ id: 'c3', body: 'latest live correction', encrypted, to: own ? PEER : SELF })
        if (encrypted) await tasks.mock.results.at(-1)!.value
        await drain()
        expect((await reload(kind)).body).toBe('latest live correction')
        await h.archivePages([{ edits: [{ id: 'c1', body: 'earlier private correction', at: T1, to: own ? PEER : SELF }] }], true)
        expect((await reload(kind)).body).toBe('latest live correction')
      } finally { release.resolve(); await tasks.mock.results[0].value }
    })
})

describe.each<Kind>(['chat', 'room'])('%s cache-only failed predecessor write', kind => {
  it.each(['live', 'archive'].flatMap(mode => [false, true].flatMap(preview => ['abort', 'request'].map(failure => ({ mode, preview, failure })) )))(
    'retains canonical C2 when failed C1 returns through $mode preview=$preview failure=$failure', async ({ mode, preview: withPreview, failure }) => {
      setStorageScopeJid(SELF)
      const h = harness(kind)
      const base = original(kind)
      await save(kind, base); seed(kind, [])
      if (withPreview) seedPreview(kind, base)
      await searchIndex.indexMessage(base)
      const c1: Edit = { id: 'c1', body: 'first lost write' }
      if (failure === 'abort') await abortCorrectionWrite(kind, () => h.receive(c1))
      else {
        const put = IDBObjectStore.prototype.put
        let failed = false
        const fault = vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(function (this: IDBObjectStore, ...args) {
          if (!failed && this.name === (kind === 'chat' ? 'messages-canonical' : 'room-messages-canonical')) {
            failed = true; return this.add(...args)
          }
          return put.apply(this, args)
        })
        const offset = writes.length
        try {
          h.receive(c1)
          const pending = writes.slice(offset)
          for (let i = offset; i < writes.length; i++) writes[i] = writes[i].catch(() => {})
          expect(await Promise.allSettled(pending)).toEqual(expect.arrayContaining([
            expect.objectContaining({ status: 'rejected', reason: expect.objectContaining({ name: 'ConstraintError' }) }),
          ]))
          await drain()
        } finally { fault.mockRestore() }
      }
      const read = () => kind === 'chat' ? cache.getMessages(PEER) : cache.getRoomMessages(ROOM, {})
      expect(await read()).toMatchObject([{ id: base.id, stanzaId: base.stanzaId, body: base.body }])
      expect(await read()).toHaveLength(1)
      expect(await searchIndex.search('first')).toEqual([])
      await h.live({ id: 'c2', body: 'second current revision' })
      expect(await read()).toHaveLength(1)
      expect((await read())[0]).toMatchObject({ id: base.id, stanzaId: base.stanzaId, timestamp: base.timestamp, body: 'second current revision' })
      if (mode === 'live') await h.live(c1)
      else await h.archivePages([{ edits: [{ ...c1, at: T1 }] }], true)
      expect((await reload(kind)).body).toBe('second current revision')
      if (withPreview) expect(preview(kind)?.body).toBe('second current revision')
      expect(await searchIndex.search('first')).toEqual([])
      expect(await searchIndex.search('original')).toEqual([])
      expect(await searchIndex.search('second')).toHaveLength(1)
    })
})

describe.each(['single', 'batch'] as const)('%s room preview hydration ownership', mode => {
  it.each(['same', 'account', 'roundtrip', 'reset', 'recreate'] as const)('guards read and commit through %s', async change => {
    setStorageScopeJid(SELF)
    await save('room', original('room'))
    const started = deferred(), release = deferred()
    const read = cache.getRoomMessages
    vi.spyOn(cache, 'getRoomMessages').mockImplementationOnce(async (...args) => {
      const rows = await read(...args); started.resolve(); await release.promise; return rows
    })
    const work = mode === 'single' ? roomStore.getState().loadPreviewFromCache(ROOM) : roomStore.getState().hydratePreviewsFromCache()
    await started.promise
    if (change === 'account' || change === 'roundtrip') {
      setStorageScopeJid('other@example.test')
      if (change === 'roundtrip') setStorageScopeJid(SELF)
    }
    if (change === 'reset') roomStore.getState().reset()
    if (change === 'recreate') roomStore.getState().removeRoom(ROOM)
    if (change !== 'same') roomStore.getState().addRoom(createMockRoom(ROOM, { joined: true, nickname: 'Peer' }))
    const listener = vi.fn()
    const unsubscribe = roomStore.subscribe(listener)
    try {
      release.resolve()
      const result = await work
      if (mode === 'single') expect(result).toEqual(change === 'same' ? expect.objectContaining({ body: 'original text' }) : null)
      expect(roomStore.getState().rooms.get(ROOM)?.lastMessage?.body).toBe(change === 'same' ? 'original text' : undefined)
      expect(roomStore.getState().roomMeta.get(ROOM)?.lastMessage?.body).toBe(change === 'same' ? 'original text' : undefined)
      expect(listener).toHaveBeenCalledTimes(change === 'same' ? 1 : 0)
    } finally { release.resolve(); unsubscribe() }
  })
})

it.each<Kind>(['chat', 'room'])('retains failed %s predecessor evidence without a missing-target continuation', async kind => {
  setStorageScopeJid(SELF)
  const h = harness(kind)
  const base = original(kind)
  await save(kind, base); seedPreview(kind, base)
  h.deps.emitSDK = (event, payload) => h.emitSDK(event,
    event === 'chat:message-updated' || event === 'room:message-updated' ? { ...payload, onCorrectionMissing: undefined } : payload)
  const c1 = { id: 'c1', body: 'earlier failed correction' }
  await abortCorrectionWrite(kind, () => h.receive(c1))
  await h.live({ id: 'c2', body: 'newer durable correction' })
  const read = () => kind === 'chat' ? cache.getMessages(PEER) : cache.getRoomMessages(ROOM, {})
  expect(await read()).toHaveLength(1)
  expect((await read())[0].body).toBe('newer durable correction')
  await h.archivePages([{ edits: [{ ...c1, at: T1 }] }], true)
  expect((await reload(kind)).body).toBe('newer durable correction')
})

it('commits only surviving room previews after a batched read overlaps recreation', async () => {
  setStorageScopeJid(SELF)
  const otherRoom = 'other-room@conference.example.test'
  roomStore.getState().addRoom(createMockRoom(otherRoom, { joined: true }))
  const other = { ...original('room'), roomJid: otherRoom, from: `${otherRoom}/Peer`, body: 'surviving room content' } as StoredRoomMessage
  await save('room', original('room'), other)
  const started = deferred(), release = deferred()
  const read = cache.getRoomMessages
  vi.spyOn(cache, 'getRoomMessages').mockImplementation(async (...args) => {
    const rows = await read(...args)
    if (args[0] === otherRoom) { started.resolve(); await release.promise }
    return rows
  })
  const work = roomStore.getState().hydratePreviewsFromCache()
  await started.promise
  roomStore.getState().removeRoom(ROOM)
  roomStore.getState().addRoom(createMockRoom(ROOM, { joined: true }))
  const listener = vi.fn(), unsubscribe = roomStore.subscribe(listener)
  try {
    release.resolve(); await work
    expect(roomStore.getState().rooms.get(ROOM)?.lastMessage).toBeUndefined()
    expect(roomStore.getState().roomMeta.get(ROOM)?.lastMessage).toBeUndefined()
    expect(roomStore.getState().rooms.get(otherRoom)?.lastMessage?.body).toBe('surviving room content')
    expect(roomStore.getState().roomMeta.get(otherRoom)?.lastMessage?.body).toBe('surviving room content')
    expect(listener).toHaveBeenCalledTimes(1)
  } finally { release.resolve(); unsubscribe() }
})


describe.each<Kind>(['chat', 'room'])('%s corrections without IndexedDB', kind => {
  it.each([false, true])('retains received correction, resident original=%s', async hasOriginal => {
    setStorageScopeJid(SELF)
    const h = harness(kind)
    if (hasOriginal) seed(kind, [original(kind)])
    Object.defineProperty(globalThis, 'indexedDB', { value: undefined, configurable: true, writable: true })
    h.receive({ id: 'no-cache-correction', body: 'visible correction without cache' })
    for (let i = 0; i < writes.length; i++) writes[i] = writes[i].catch(() => {})
    await drain()
    const rows = (kind === 'chat' ? chatStore.getState().messages.get(PEER) : roomStore.getState().messages.get(ROOM)) ?? []
    expect(rows).toHaveLength(1)
    expect(rows[0].body).toBe('visible correction without cache')
    expect(h.events.filter(e => e.event === `${kind}:message`)).toHaveLength(hasOriginal ? 0 : 1)
  })
})

describe('overlapping corrections require archive evidence', () => {
  it.each((['live', 'received', 'sent', 'room'] as const).flatMap(shape =>
    (['resident', 'cache', 'preview'] as const).flatMap(path =>
      (['older-page', 'newer-page', 'pending-archive'] as const).map(direction => ({ shape, path, direction })))))(
    '$shape $path $direction retains incomparable content until archive evidence', async ({ shape, path, direction }) => {
      setStorageScopeJid(SELF)
      const kind = shape === 'room' ? 'room' : 'chat', own = shape === 'sent'
      const h = harness(kind, own), base = original(kind, own)
      await save(kind, base)
      if (path === 'resident') seed(kind, [base])
      if (path !== 'cache') seedPreview(kind, base)
      const manager = (await blockedDecrypt()).manager
      vi.mocked(manager.decryptArchive).mockRestore()
      h.deps.getE2EEManager = () => manager
      const started = deferred(), release = deferred()
      const method = direction === 'pending-archive' ? 'decryptArchive' : 'decryptInbound'
      const decrypt = manager[method].bind(manager)
      vi.spyOn(manager, method).mockImplementationOnce(async (...args) => {
        started.resolve(); await release.promise; return decrypt(...args)
      })
      const first = { id: 'opaque-first', body: 'earlier signed content', to: own ? PEER : SELF }
      const second = { id: 'opaque-second', body: 'later signed content', to: own ? PEER : SELF }
      const deliver = (entry: Edit) => {
        const message = h.stanza(entry)
        h.chat.handle(shape === 'sent' || shape === 'received' ? xml('message', { from: SELF },
          xml(shape, { xmlns: 'urn:xmpp:carbons:2' }, xml('forwarded', { xmlns: 'urn:xmpp:forward:0' }, message))) : message)
      }
      const tasks = vi.spyOn(h.chat as unknown as { decryptAndReprocess: (...args: unknown[]) => Promise<void> }, 'decryptAndReprocess')
      let work: Promise<unknown>
      if (direction === 'pending-archive') work = h.archive([{ ...first, encrypted: true, at: T1 }])
      else { deliver({ ...(direction === 'older-page' ? second : first), encrypted: true }); work = tasks.mock.results[0].value }
      await started.promise
      try {
        if (direction === 'pending-archive') { deliver(second); await drain() }
        else await h.archive([{ ...(direction === 'older-page' ? first : second), at: T1 }])
        release.resolve(); await work; await drain()
        const held = await reload(kind)
        const other = held.correctionRevision?.ids.includes('stanza:sid-opaque-first') ? 'second' : 'first'
        expect(held.correctionRevision?.supersedes).not.toContain(`stanza:sid-opaque-${other}`)
        expect(held.correctionAlternatives).toEqual([expect.objectContaining({ body: other === 'first' ? first.body : second.body })])
        if (direction === 'pending-archive') expect(held.body).toBe(second.body)
        await h.archivePages([{ edits: [{ ...first, at: T1 }, { ...second, at: T1 }] }], true)
        const resolved = await reload(kind)
        expect(resolved).toMatchObject({ id: base.id, stanzaId: base.stanzaId, timestamp: base.timestamp, body: second.body })
        expect(resolved.correctionRevision?.supersedes).toContain('stanza:sid-opaque-first')
        expect(resolved.correctionAlternatives).toBeUndefined()
        if (path !== 'cache') expect(preview(kind)?.body).toBe(second.body)
        expect(await searchIndex.search('earlier')).toEqual([])
        expect(await searchIndex.search('later')).toHaveLength(1)
        await h.archive([{ ...first, at: T1 }])
        expect((await reload(kind)).body).toBe(second.body)
      } finally { release.resolve(); await work }
    })
})

describe('buffered MAM completion ownership', () => {
  it.each((['chat-preview', 'room-preview', 'room-message'] as const).flatMap(path =>
    (['same', 'account', 'roundtrip', 'manager', 'transport'] as const).map(change => ({ path, change })) ))(
    '$path retains ownership through $change', async ({ path, change }) => {
      setStorageScopeJid(SELF)
      const kind = path === 'chat-preview' ? 'chat' : 'room'
      const h = harness(kind)
      const manager = (await blockedDecrypt()).manager
      vi.mocked(manager.decryptArchive).mockRestore()
      h.deps.getE2EEManager = () => manager
      h.stores.chat.getAllConversations.mockImplementation(() => Array.from(chatStore.getState().conversations.keys(), id => ({ id, messages: [] })))
      h.stores.chat.updateLastMessagePreview.mockImplementation((...args) => chatStore.getState().updateLastMessagePreview(...args))
      h.stores.room.updateLastMessagePreview.mockImplementation((...args) => roomStore.getState().updateLastMessagePreview(...args))
      const started = deferred(), release = deferred()
      const decrypt = manager.decryptArchive.bind(manager)
      if (path !== 'room-preview') vi.spyOn(manager, 'decryptArchive').mockImplementationOnce(async (...args) => {
        started.resolve(); await release.promise; return decrypt(...args)
      })
      let collector!: (stanza: Element) => void
      h.deps.registerMAMCollector = (_id, fn) => { collector = fn; return () => {} }
      h.deps.sendIQ = async iq => {
        const qid = iq.getChild('query', 'urn:xmpp:mam:2')!.attrs.queryid
        const message = h.stanza({ id: 'private-preview', body: 'private buffered content', encrypted: path !== 'room-preview' })
        const replace = message.getChild('replace', 'urn:xmpp:message-correct:0')
        message.children = message.children.filter(child => child !== replace)
        collector(xml('message', {}, xml('result', { xmlns: 'urn:xmpp:mam:2', queryid: qid, id: 'private-preview' },
          xml('forwarded', { xmlns: 'urn:xmpp:forward:0' }, xml('delay', { xmlns: 'urn:xmpp:delay', stamp: T1 }), message))))
        if (path === 'room-preview') { started.resolve(); await release.promise }
        return xml('iq', { type: 'result' })
      }
      const work = path === 'chat-preview' ? h.mam.refreshConversationPreviews()
        : path === 'room-preview' ? h.mam.fetchPreviewForRoom(ROOM) : h.mam.fetchRoomMessageById(ROOM, 'private-preview')
      await started.promise
      try {
        if (change === 'account' || change === 'roundtrip') {
          setStorageScopeJid('other@example.test')
          if (change === 'roundtrip') setStorageScopeJid(SELF)
        }
        if (change === 'manager') h.deps.getE2EEManager = () => null
        if (change === 'transport') h.deps.getXmpp = () => createMockXmppClient() as unknown as ReturnType<ModuleDependencies['getXmpp']>
        release.resolve(); const result = await work; await drain()
        if (path === 'room-message') expect(result).toEqual(change === 'same' ? expect.objectContaining({ body: 'private buffered content' }) : null)
        else expect(preview(kind)?.body).toBe(change === 'same' ? 'private buffered content' : undefined)
        if (change !== 'same') {
          expect(h.events.filter(e => e.event === 'room:message')).toEqual([])
          expect(await searchIndex.search('private')).toEqual([])
        }
      } finally { release.resolve(); await work }
    })
})


it.each(['account', 'roundtrip', 'manager', 'transport', 'same'] as const)('guards deferred poll verification after %s', async change => {
  setStorageScopeJid(SELF)
  const h = harness('room')
  const release = deferred()
  const poll = { ...original('room'), poll: { title: 'Lunch?', options: [{ emoji: '1', label: 'Pizza' }], settings: { allowMultiple: false, hideResultsBeforeVote: false } } } as StoredRoomMessage
  vi.spyOn(h.mam, 'fetchRoomMessageById').mockImplementation(async () => { await release.promise; return poll })
  h.chat.handle(xml('message', { from: `${ROOM}/Peer`, type: 'groupchat', id: 'close-poll' },
    xml('body', {}, 'Poll closed'), xml('occupant-id', { xmlns: 'urn:xmpp:occupant-id:0', id: 'peer-occupant' }),
    xml('poll-closed', { xmlns: 'urn:fluux:poll:0', 'message-id': 'original' }, xml('title', {}, 'Lunch?'), xml('tally', { emoji: '1', label: 'Pizza', count: '1' }))))
  await drain()
  h.events.length = 0
  if (change === 'account' || change === 'roundtrip') { setStorageScopeJid('other@example.test'); if (change === 'roundtrip') setStorageScopeJid(SELF) }
  if (change === 'transport') h.deps.getXmpp = () => createMockXmppClient() as unknown as ReturnType<ModuleDependencies['getXmpp']>
  if (change === 'manager') h.deps.getE2EEManager = () => ({}) as E2EEManager
  release.resolve()
  await Promise.resolve(); await Promise.resolve(); await drain()
  expect(h.events.filter(event => event.event === 'room:message-updated')).toHaveLength(change === 'same' ? 1 : 0)
})

it.each(['chat', 'archived', 'room'] as const)('does not start queued %s preview queries under a replacement account', async kind => {
  setStorageScopeJid(SELF)
  const h = harness(kind === 'room' ? 'room' : 'chat')
  const rooms = [createMockRoom(ROOM, { joined: true, supportsMAM: true }), createMockRoom('other@conference.example.test', { joined: true, supportsMAM: true })]
  h.stores.room.joinedRooms.mockReturnValue(rooms.map(room => ({ ...room, supportsMAM: true })))
  const conversations = Array.from(chatStore.getState().conversations.keys(), id => ({ id, messages: [] }))
  h.stores.chat.getAllConversations.mockReturnValue([...conversations, { ...conversations[0], id: 'other@example.test' }])
  h.stores.chat.getArchivedConversations.mockReturnValue([...conversations, { ...conversations[0], id: 'other@example.test' }])
  const started = deferred(), release = deferred()
  const send = vi.fn(async () => { started.resolve(); await release.promise; return xml('iq', { type: 'result' }) })
  h.deps.sendIQ = send
  const work = kind === 'room' ? h.mam.refreshRoomPreviews({ concurrency: 1 }) : kind === 'archived'
    ? h.mam.refreshArchivedConversationPreviews({ concurrency: 1 }) : h.mam.refreshConversationPreviews({ concurrency: 1 })
  await started.promise; setStorageScopeJid('other-account@example.test'); release.resolve(); await work
  expect(send).toHaveBeenCalledTimes(1)
})


it.each(['account', 'roundtrip', 'manager', 'transport', 'same'] as const)('guards room preview query after a %s cache read', async change => {
  setStorageScopeJid(SELF)
  const h = harness('room'), started = deferred(), release = deferred()
  h.stores.room.loadPreviewFromCache.mockImplementation(async () => { started.resolve(); await release.promise; return null })
  const send = vi.fn(async () => xml('iq', { type: 'result' }))
  h.deps.sendIQ = send
  const work = h.mam.fetchPreviewForRoom(ROOM)
  await started.promise
  if (change === 'account' || change === 'roundtrip') { setStorageScopeJid('other@example.test'); if (change === 'roundtrip') setStorageScopeJid(SELF) }
  if (change === 'transport') h.deps.getXmpp = () => createMockXmppClient() as unknown as ReturnType<ModuleDependencies['getXmpp']>
  if (change === 'manager') h.deps.getE2EEManager = () => ({}) as E2EEManager
  release.resolve(); await work
  expect(send).toHaveBeenCalledTimes(change === 'same' ? 1 : 0)
})

it.each<Kind>(['chat', 'room'])('keeps subsequent %s live progress ahead of an unresolved archive candidate', async kind => {
  setStorageScopeJid(SELF)
  const h = harness(kind), base = original(kind)
  await save(kind, base); seedPreview(kind, base)
  const manager = (await blockedDecrypt()).manager
  vi.mocked(manager.decryptArchive).mockRestore()
  h.deps.getE2EEManager = () => manager
  const started = deferred(), release = deferred(), decrypt = manager.decryptArchive.bind(manager)
  vi.spyOn(manager, 'decryptArchive').mockImplementationOnce(async (...args) => {
    started.resolve(); await release.promise; return decrypt(...args)
  })
  const first = { id: 'c1', body: 'unresolved archive text', at: T1 }
  const work = h.archive([{ ...first, encrypted: true }])
  await started.promise
  try {
    await h.live({ id: 'c2', body: 'second live text' })
    release.resolve(); await work
    await h.live({ id: 'c3', body: 'third live progress' })
    expect((await reload(kind)).body).toBe('third live progress')
    await h.archive([first])
    expect((await reload(kind)).body).toBe('third live progress')
    await h.archive([{ id: 'c3', body: 'third live progress', at: T2 }])
    const resolved = await reload(kind)
    expect(resolved.body).toBe('third live progress')
    expect(resolved.correctionAlternatives).toBeUndefined()
    expect(preview(kind)?.body).toBe('third live progress')
    expect(await searchIndex.search('unresolved')).toEqual([])
    expect(await searchIndex.search('progress')).toHaveLength(1)
  } finally { release.resolve(); await work }
})


describe.each<Kind>(['chat', 'room'])('%s buffered archive before IQ completion', kind => {
  it('retains the current live correction while the earlier archive result is unresolved', async () => {
    setStorageScopeJid(SELF)
    const h = harness(kind), base = original(kind)
    await save(kind, base); seed(kind, [base]); seedPreview(kind, base)
    const started = deferred(), release = deferred()
    const send = h.deps.sendIQ
    h.deps.sendIQ = async (...args) => {
      const response = await send(...args)
      started.resolve(); await release.promise; return response
    }
    const work = h.archive([{ id: 'buffered-c1', body: 'older buffered archive', at: T1 }])
    await started.promise
    try {
      await h.live({ id: 'current-c2', body: 'current live correction' })
      expect((await reload(kind)).body).toBe('current live correction')
      release.resolve(); await work; await drain()
      const current = await reload(kind)
      expect(current.body).toBe('current live correction')
      expect(current.correctionRevision?.supersedes).not.toContain('stanza:sid-buffered-c1')
      expect(current.correctionAlternatives).toEqual([expect.objectContaining({ body: 'older buffered archive' })])
      await h.archive([{ id: 'current-c2', body: 'current live correction', at: T2 }])
      expect((await reload(kind)).body).toBe('current live correction')
    } finally { release.resolve(); await work }
  })
})


describe.each<Kind>(['chat', 'room'])('%s archive copy preserves live receipt order', kind => {
  it.each([false, true])('keeps C2 after live C1 with encrypted=%s while archive C1 is pending', async encrypted => {
    setStorageScopeJid(SELF)
    const h = harness(kind), base = original(kind)
    await save(kind, base); seed(kind, [base]); seedPreview(kind, base)
    const manager = (await blockedDecrypt()).manager
    vi.mocked(manager.decryptArchive).mockRestore()
    h.deps.getE2EEManager = () => manager
    const started = deferred(), release = deferred(), decrypt = manager.decryptArchive.bind(manager)
    vi.spyOn(manager, 'decryptArchive').mockImplementationOnce(async (...args) => {
      started.resolve(); await release.promise; return decrypt(...args)
    })
    const tasks = vi.spyOn(h.chat as unknown as { decryptAndReprocess: (...args: unknown[]) => Promise<void> }, 'decryptAndReprocess')
    const c1 = { id: 'shared-c1', body: 'first live revision' }
    const work = h.archive([{ ...c1, encrypted: true, at: T1 }])
    await started.promise
    try {
      h.receive({ ...c1, encrypted })
      if (encrypted) await tasks.mock.results.at(-1)!.value
      await drain()
      expect((await reload(kind)).body).toBe(c1.body)
      await h.live({ id: 'later-c2', body: 'second live revision' })
      expect((await reload(kind)).body).toBe('second live revision')
      release.resolve(); await work; await drain()
      expect((await reload(kind)).body).toBe('second live revision')
      expect(preview(kind)?.body).toBe('second live revision')
      expect(await searchIndex.search('first')).toEqual([])
      expect(await searchIndex.search('second')).toHaveLength(1)
    } finally { release.resolve(); await work }
  })
})


describe('correction receipts across live and archive copies', () => {
  it.each((['live', 'received', 'sent', 'room'] as const).flatMap(shape =>
    (['resident', 'cache', 'preview'] as const).flatMap(path => [false, true].flatMap(encrypted =>
      (['archive', 'live'] as const).map(first => ({ shape, path, encrypted, first }))))))(
    '$shape $path preserves live order with $first pending and encrypted=$encrypted copy', async ({ shape, path, encrypted, first }) => {
      setStorageScopeJid(SELF)
      const kind = shape === 'room' ? 'room' : 'chat', own = shape === 'sent'
      const h = harness(kind, own), base = original(kind, own)
      await save(kind, base)
      if (path === 'resident') seed(kind, [base])
      if (path !== 'cache') seedPreview(kind, base)
      const manager = (await blockedDecrypt()).manager
      vi.mocked(manager.decryptArchive).mockRestore()
      h.deps.getE2EEManager = () => manager
      const started = deferred(), release = deferred()
      const method = first === 'archive' ? 'decryptArchive' : 'decryptInbound'
      const decrypt = manager[method].bind(manager)
      vi.spyOn(manager, method).mockImplementationOnce(async (...args) => {
        started.resolve(); await release.promise; return decrypt(...args)
      })
      const tasks = vi.spyOn(h.chat as unknown as { decryptAndReprocess: (...args: unknown[]) => Promise<void> }, 'decryptAndReprocess')
      const c1: Edit = { id: 'shared-receipt', body: 'earlier content', to: own ? PEER : SELF }
      const deliver = async (entry: Edit, wait = true) => {
        const message = h.stanza(entry)
        h.chat.handle(shape === 'received' || shape === 'sent' ? xml('message', { from: SELF },
          xml(shape, { xmlns: 'urn:xmpp:carbons:2' }, xml('forwarded', { xmlns: 'urn:xmpp:forward:0' }, message))) : message)
        if (wait && entry.encrypted) await tasks.mock.results.at(-1)!.value
        if (wait) await drain()
      }
      let work: Promise<unknown>
      if (first === 'archive') work = h.archive([{ ...c1, encrypted: true, at: T1 }])
      else { await deliver({ ...c1, encrypted: true }, false); work = tasks.mock.results[0].value }
      await started.promise
      try {
        if (first === 'archive') await deliver({ ...c1, encrypted })
        else await h.archive([{ ...c1, encrypted, at: T1 }])
        await deliver({ id: 'second-receipt', body: 'current content', to: c1.to })
        expect((await reload(kind)).body).toBe('current content')
        await deliver({ ...c1, encrypted })
        expect((await reload(kind)).body).toBe('current content')
        release.resolve(); await work; await drain()
        expect((await reload(kind)).body).toBe('current content')
        await deliver({ id: 'third-receipt', body: 'latest content', to: c1.to })
        await h.archivePages([{ edits: [{ ...c1, at: T1 },
          { id: 'second-receipt', body: 'current content', to: c1.to, at: T1 },
          { id: 'third-receipt', body: 'latest content', to: c1.to, at: T1 }] }], true)
        const current = await reload(kind)
        expect(current).toMatchObject({ id: base.id, stanzaId: base.stanzaId, timestamp: base.timestamp, body: 'latest content' })
        expect(current.correctionRevision?.supersedes).toContain('stanza:sid-shared-receipt')
        expect(current.correctionAlternatives).toBeUndefined()
        if (path !== 'cache') expect(preview(kind)?.body).toBe(current.body)
        expect(await searchIndex.search('earlier')).toEqual([])
        expect(await searchIndex.search('latest')).toHaveLength(1)
      } finally { release.resolve(); await work }
    })
})

it.each<Kind>(['chat', 'room'])('retains a pending %s archive candidate after an outgoing correction', async kind => {
  setStorageScopeJid(SELF)
  const h = harness(kind, true), base = original(kind, true)
  await save(kind, base); seed(kind, [base]); seedPreview(kind, base)
  const manager = (await blockedDecrypt()).manager
  vi.mocked(manager.decryptArchive).mockRestore()
  h.deps.getE2EEManager = () => manager
  const started = deferred(), release = deferred(), decrypt = manager.decryptArchive.bind(manager)
  vi.spyOn(manager, 'decryptArchive').mockImplementationOnce(async (...args) => {
    started.resolve(); await release.promise; return decrypt(...args)
  })
  const work = h.archive([{ id: 'pending-archive', body: 'earlier archive content', at: T1, encrypted: true }])
  await started.promise
  try {
    const id = await h.outgoing('newly sent content')
    release.resolve(); await work
    const held = await reload(kind)
    expect(held).toMatchObject({ id: base.id, stanzaId: base.stanzaId, timestamp: base.timestamp, body: 'newly sent content' })
    expect(held.correctionTimestamp).toBeUndefined()
    expect(held.correctionAlternatives).toEqual([expect.objectContaining({ body: 'earlier archive content' })])
    expect(held.correctionRevision?.supersedes).not.toContain('stanza:sid-pending-archive')
    await h.archive([{ id, body: 'newly sent content', at: T2 }])
    expect((await reload(kind)).correctionAlternatives).toBeUndefined()
    expect(preview(kind)?.body).toBe('newly sent content')
    expect(await searchIndex.search('earlier')).toEqual([])
    expect(await searchIndex.search('newly')).toHaveLength(1)
  } finally { release.resolve(); await work }
})

it.each<Kind>(['chat', 'room'])('retains incomparable %s content through full-row cache hydration', async kind => {
  const base = original(kind)
  const live: Row = { ...base, body: 'current plaintext', isEdited: true, correctionTimestamp: 900,
    correctionTimestampSource: 'authored', correctionRevision: { ids: ['stanza:live'], supersedes: [] } }
  const archive: Row = { ...base, body: 'unresolved plaintext', isEdited: true, correctionTimestamp: 100,
    correctionTimestampSource: 'authored', correctionRevision: { ids: ['stanza:archive'], supersedes: [], archiveTimestamp: 10 } }
  await save(kind, live); await save(kind, archive)
  const held = await reload(kind)
  expect([held.body, ...held.correctionAlternatives!.map(candidate => candidate.body)].sort()).toEqual(['current plaintext', 'unresolved plaintext'])
  expect(held.correctionRevision?.supersedes).toEqual([])
  const h = harness(kind)
  await h.archive([{ id: 'live', stanzaId: 'live', body: 'current plaintext', at: T2 }])
  expect((await reload(kind)).body).toBe('current plaintext')
})

it.each((['live', 'received', 'sent', 'room'] as const).flatMap(shape =>
  [false, true].flatMap(encrypted => [false, true].map(inMemory => ({ shape, encrypted, inMemory })))))(
  '$shape replay first seen in the archive cannot gain fresh authority encrypted=$encrypted resident=$inMemory', async ({ shape, encrypted, inMemory }) => {
    setStorageScopeJid(SELF)
    const kind = shape === 'room' ? 'room' : 'chat', own = shape === 'sent'
    const h = harness(kind, own), base = original(kind, own)
    await save(kind, base); seedPreview(kind, base)
    if (inMemory) seed(kind, [base])
    const manager = (await blockedDecrypt()).manager
    vi.mocked(manager.decryptArchive).mockRestore()
    h.deps.getE2EEManager = () => manager
    const started = deferred(), release = deferred(), decrypt = manager.decryptArchive.bind(manager)
    vi.spyOn(manager, 'decryptArchive').mockImplementationOnce(async (...args) => {
      started.resolve(); await release.promise; return decrypt(...args)
    })
    const tasks = vi.spyOn(h.chat as unknown as { decryptAndReprocess: (...args: unknown[]) => Promise<void> }, 'decryptAndReprocess')
    const c1: Edit = { id: 'archive-replay', body: 'retained earlier content', to: own ? PEER : SELF }
    const c2: Edit = { id: 'live-current', body: 'current live content', to: c1.to }
    const deliver = async (entry: Edit) => {
      const message = h.stanza(entry)
      h.chat.handle(shape === 'received' || shape === 'sent' ? xml('message', { from: SELF },
        xml(shape, { xmlns: 'urn:xmpp:carbons:2' }, xml('forwarded', { xmlns: 'urn:xmpp:forward:0' }, message))) : message)
      if (entry.encrypted) await tasks.mock.results.at(-1)!.value
      await drain()
    }
    const work = h.archive([{ ...c1, encrypted: true, at: T1 }])
    await started.promise
    try {
      await deliver(c2)
      await deliver({ ...c1, encrypted })
      const held = await reload(kind)
      expect(held.body).toBe(c2.body)
      expect(held.correctionAlternatives).toEqual([expect.objectContaining({ body: c1.body })])
      expect(held.correctionAlternatives![0].correctionRevision?.supersedes).not.toContain('stanza:sid-live-current')
      release.resolve(); await work
      expect((await reload(kind)).body).toBe(c2.body)
      await h.archive([{ ...c2, at: T2 }])
      const current = await reload(kind)
      expect(current).toMatchObject({ body: c2.body, id: base.id, stanzaId: base.stanzaId, timestamp: base.timestamp })
      expect(current.correctionAlternatives).toBeUndefined()
      expect(preview(kind)?.body).toBe(c2.body)
      expect(await searchIndex.search('earlier')).toEqual([])
      expect(await searchIndex.search('current')).toHaveLength(1)
    } finally { release.resolve(); await work }
  })


describe.each<Kind>(['chat', 'room'])('%s next live edit after completed history', kind => {
  it('updates the visible message after the previous edit was loaded from a finished archive query', async () => {
    setStorageScopeJid(SELF)
    const h = harness(kind), base = original(kind)
    await save(kind, base); seed(kind, [base]); seedPreview(kind, base)
    await h.archive([{ id: 'known-c1', body: 'previous archived caption', at: T1 }], true)
    expect((await reload(kind)).body).toBe('previous archived caption')
    const collectors = new Map<string, (stanza: Element) => void>()
    h.deps.registerMAMCollector = (id, handler) => { collectors.set(id, handler); return () => { collectors.delete(id) } }
    h.deps.sendIQ = async iq => {
      const query = iq.getChild('query', 'urn:xmpp:mam:2')
      if (!query) throw new Error('Unexpected non-MAM reconciliation request')
      const queryId = query.attrs.queryid, archiveId = 'sid-fresh-c2'
      const collector = collectors.get(queryId)
      if (!collector) throw new Error('MAM reconciliation has no result collector')
      collector(xml('message', { from: kind === 'room' ? ROOM : SELF },
        xml('result', { xmlns: 'urn:xmpp:mam:2', queryid: queryId, id: archiveId },
          xml('forwarded', { xmlns: 'urn:xmpp:forward:0' },
            xml('delay', { xmlns: 'urn:xmpp:delay', stamp: T2 }),
            h.stanza({ id: 'fresh-c2', body: 'fresh live caption' })))))
      return xml('iq', { type: 'result' }, xml('fin', { xmlns: 'urn:xmpp:mam:2', complete: 'true' },
        xml('set', { xmlns: 'http://jabber.org/protocol/rsm' }, xml('first', {}, archiveId), xml('last', {}, archiveId))))
    }
    await h.live({ id: 'fresh-c2', body: 'fresh live caption' })
    await vi.waitFor(async () => expect((await reload(kind)).body).toBe('fresh live caption'), { timeout: 1000, interval: 10 })
    expect(preview(kind)?.body).toBe('fresh live caption')
    expect(await searchIndex.search('previous')).toEqual([])
    expect(await searchIndex.search('fresh')).toHaveLength(1)
  })
})

describe.each<Kind>(['chat', 'room'])('%s correction completion regression', kind => {
  it.each([false, true])('persists promoted content with its revision, cache-only %s', async cachedOnly => {
    setStorageScopeJid(SELF)
    const h = harness(kind), base = original(kind)
    await save(kind, base); seed(kind, cachedOnly ? [] : [base]); seedPreview(kind, base)
    await h.live({ id: 'c1', body: 'earlier caption', authoredAt: FAST })
    await h.archive([{ id: 'c2', body: 'selected caption', at: T2, authoredAt: T0 }])
    if (cachedOnly) seed(kind, [])
    await h.archive([{ id: 'c1', body: 'earlier caption', at: T1, authoredAt: FAST }])
    expect(preview(kind)?.body).toBe('selected caption')
    const row = await reload(kind)
    expect(row).toMatchObject({ id: base.id, stanzaId: base.stanzaId, timestamp: base.timestamp,
      body: 'selected caption', correctionTimestamp: Date.parse(T0), correctionTimestampSource: 'authored' })
    expect(row.correctionRevision?.ids).toContain('id:c2')
    expect(await searchIndex.search('earlier')).toEqual([])
    expect(await searchIndex.search('selected')).toHaveLength(1)
  })

  it('keeps current-session observations after reload and old snapshot hydration', async () => {
    setStorageScopeJid(SELF)
    let h = harness(kind)
    const base = original(kind)
    await save(kind, base); seed(kind, [base]); seedPreview(kind, base)
    await h.live({ id: 'c1', body: 'first session caption' })
    const old = await reload(kind)
    h = harness(kind)
    seed(kind, [old]); seedPreview(kind, old)
    await h.live({ id: 'c1', body: 'first session caption' })
    await save(kind, old)
    await reload(kind)
    await h.live({ id: 'c2', body: 'second session caption' })
    expect((await reload(kind)).body).toBe('second session caption')
    expect(preview(kind)?.body).toBe('second session caption')
    expect(await searchIndex.search('first')).toEqual([])
    expect(await searchIndex.search('second')).toHaveLength(1)
  })

  it.each([false, true])('recovers promoted ciphertext after unlock, cache-only %s', async cachedOnly => {
    setStorageScopeJid(SELF)
    const h = harness(kind), base = original(kind)
    await save(kind, base); seed(kind, cachedOnly ? [] : [base]); seedPreview(kind, base)
    await h.live({ id: 'c1', body: 'earlier caption' })
    await h.archive([{ id: 'c2', body: 'locked caption', locked: true, at: T2 }])
    const manager = (await blockedDecrypt()).manager
    vi.mocked(manager.decryptArchive).mockRestore()
    const decryptVerified = manager.decryptArchive.bind(manager)
    vi.spyOn(manager, 'decryptArchive').mockImplementation(async (...args) => {
      const result = await decryptVerified(...args)
      return result && { ...result, securityContext: { ...result.securityContext!, trust: 'verified' as const } }
    })
    h.deps.getE2EEManager = () => manager
    const engine = new DeferredDecryptEngine({ getManager: () => manager, getStores: () => h.stores, getOwnBareJid: () => SELF, cache, updateSearchIndex: searchIndex.updateMessage })
    h.deps.recoverCorrection = (...args) => engine.recoverCorrection(...args)
    await engine.retryPending()
    if (cachedOnly) seed(kind, [])
    await h.archive([{ id: 'c1', body: 'earlier caption', at: T1 }])
    await vi.waitFor(async () => expect((await reload(kind)).body).toBe('recovered'))
    expect(preview(kind)?.body).toBe('recovered')
    expect(await searchIndex.search('earlier')).toEqual([])
    expect(await searchIndex.search('recovered')).toHaveLength(1)
  })
})


describe.each<Kind>(['chat', 'room'])('%s correction reconciliation lifetime', kind => {
  it.each(['same', 'retract', 'account', 'roundtrip', 'manager', 'transport', 'failure'] as const)('bounds the query and guards %s completion', async change => {
    setStorageScopeJid(SELF)
    const h = harness(kind), base = original(kind)
    await save(kind, base); seed(kind, [base]); seedPreview(kind, base)
    await h.archive([{ id: 'c1', body: 'previous caption', at: T1 }], true)
    const collectors = new Map<string, (stanza: Element) => void>()
    h.deps.registerMAMCollector = (id, collector) => { collectors.set(id, collector); return () => { collectors.delete(id) } }
    const started = deferred(), release = deferred()
    const send = vi.fn(async (iq: Element) => {
      const query = iq.getChild('query', 'urn:xmpp:mam:2')!
      const fields = query.getChild('x', 'jabber:x:data')!.getChildren('field').map(field => field.attrs.var)
      expect(fields).toEqual(kind === 'room' ? ['FORM_TYPE'] : ['FORM_TYPE', 'with'])
      expect(query.getChild('set', 'http://jabber.org/protocol/rsm')?.getChildText('max')).toBe('50')
      expect(query.getChild('set', 'http://jabber.org/protocol/rsm')?.getChild('before')).toBeDefined()
      started.resolve(); await release.promise
      if (change === 'failure') throw new Error('Synthetic archive unavailable')
      collectors.get(query.attrs.queryid)?.(xml('message', {}, xml('result', { xmlns: 'urn:xmpp:mam:2', queryid: query.attrs.queryid, id: 'sid-c2' },
        xml('forwarded', { xmlns: 'urn:xmpp:forward:0' }, xml('delay', { xmlns: 'urn:xmpp:delay', stamp: T2 }), h.stanza({ id: 'c2', body: 'current caption' })))))
      if (change === 'retract') collectors.get(query.attrs.queryid)?.(xml('message', {},
        xml('result', { xmlns: 'urn:xmpp:mam:2', queryid: query.attrs.queryid, id: 'archive-retraction' },
          xml('forwarded', { xmlns: 'urn:xmpp:forward:0' }, xml('delay', { xmlns: 'urn:xmpp:delay', stamp: FAST }),
            xml('message', { from: base.from, to: SELF, type: base.type },
              xml('retract', { xmlns: 'urn:xmpp:message-retract:1', id: 'sid-c2' }),
              ...(kind === 'room' ? [xml('occupant-id', { xmlns: 'urn:xmpp:occupant-id:0', id: 'peer-occupant' })] : []))))))
      return xml('iq', { type: 'result' }, xml('fin', { xmlns: 'urn:xmpp:mam:2', complete: 'true' }))
    })
    h.deps.sendIQ = send
    await h.live({ id: 'c2', body: 'current caption' })
    await started.promise
    await h.live({ id: 'c2', body: 'current caption' })
    if (change === 'account' || change === 'roundtrip') { setStorageScopeJid('other@example.test'); if (change === 'roundtrip') setStorageScopeJid(SELF) }
    if (change === 'manager') h.deps.getE2EEManager = () => ({}) as E2EEManager
    if (change === 'transport') h.deps.getXmpp = () => createMockXmppClient() as unknown as ReturnType<ModuleDependencies['getXmpp']>
    release.resolve()
    await vi.waitFor(() => expect(collectors.size).toBe(0))
    await drain()
    expect(send).toHaveBeenCalledTimes(1)
    if (change === 'retract') {
      expect((await reload(kind)).isRetracted).toBe(true)
      expect(await searchIndex.search('caption')).toEqual([])
    } else expect(preview(kind)?.body).toBe(change === 'same' ? 'current caption' : 'previous caption')
    if (change === 'same') expect((await reload(kind)).body).toBe('current caption')
  })

  it.each(['unlock', 'locked', 'old-completion', 'newer', 'retract', 'account'] as const)('recovers a queued promoted ciphertext with %s before completion', async change => {
    setStorageScopeJid(SELF)
    const h = harness(kind), base = original(kind)
    await save(kind, base); seedPreview(kind, base)
    await h.live({ id: 'c1', body: 'earlier caption' })
    const first = await reload(kind)
    seed(kind, [])
    await h.archive([{ id: 'c2', body: 'locked caption', locked: true, at: T2 }])
    const manager = (await blockedDecrypt()).manager
    vi.mocked(manager.decryptArchive).mockRestore()
    const decryptVerified = manager.decryptArchive.bind(manager)
    vi.spyOn(manager, 'decryptArchive').mockImplementation(async (...args) => {
      const result = await decryptVerified(...args)
      return result && { ...result, securityContext: { ...result.securityContext!, trust: 'verified' as const } }
    })
    h.deps.getE2EEManager = () => manager
    const engine = new DeferredDecryptEngine({ getManager: () => manager, getStores: () => h.stores, getOwnBareJid: () => SELF, cache, updateSearchIndex: searchIndex.updateMessage })
    h.deps.recoverCorrection = (...args) => engine.recoverCorrection(...args)
    const started = deferred(), release = deferred()
    let locked = change === 'locked'
    vi.spyOn(manager, 'decryptArchive').mockImplementation(async (...args) => { started.resolve(); await release.promise; if (locked) throw new Error('Synthetic key locked'); return decryptVerified(...args).then(result => result && { ...result, securityContext: { ...result.securityContext!, trust: 'verified' as const } }) })
    seed(kind, [])
    await h.archive([{ id: 'c1', body: 'earlier caption', at: T1 }])
    await started.promise
    if (change === 'old-completion') engine.recoverCorrection(first, () => true, () => { throw new Error('Unexpected stale recovery') })
    if (change === 'newer') await h.live({ id: 'c3', body: 'newest caption', at: FAST })
    if (change === 'retract') h.chat.handle(xml('message', { from: base.from, to: SELF, type: base.type },
      xml('retract', { xmlns: 'urn:xmpp:message-retract:1', id: 'sid-c2' }),
      ...(kind === 'room' ? [xml('occupant-id', { xmlns: 'urn:xmpp:occupant-id:0', id: 'peer-occupant' })] : [])))
    if (change === 'account') setStorageScopeJid('other@example.test')
    release.resolve()
    await engine.retryPending()
    if (change === 'locked') {
      await vi.waitFor(() => expect(vi.mocked(manager.decryptArchive).mock.settledResults.some(result => result.type === 'rejected')).toBe(true))
      expect((await reload(kind)).body).toBe('locked caption')
      locked = false
      await engine.retryPending()
    }
    await drain()
    if (change === 'account') { expect(preview(kind)?.body).not.toBe('recovered'); return }
    await vi.waitFor(async () => {
      const row = await reload(kind)
      if (change === 'retract') expect(row.isRetracted).toBe(true)
      else expect(row.body).toBe(change === 'newer' ? 'newest caption' : 'recovered')
    })
    if (change !== 'unlock' && change !== 'locked' && change !== 'old-completion') expect(await searchIndex.search('recovered')).toEqual([])
  })
})


it.each<Kind>(['chat', 'room'])('coalesces a third %s live edit into a bounded follow-up query', async kind => {
  setStorageScopeJid(SELF)
  const h = harness(kind), base = original(kind)
  await save(kind, base); seed(kind, [base]); seedPreview(kind, base)
  await h.archive([{ id: 'c1', body: 'previous caption', at: T1 }], true)
  const collectors = new Map<string, (stanza: Element) => void>()
  h.deps.registerMAMCollector = (id, collector) => { collectors.set(id, collector); return () => { collectors.delete(id) } }
  const started = deferred(), release = deferred()
  let requests = 0
  h.deps.sendIQ = async iq => {
    const pass = ++requests
    const queryId = iq.getChild('query', 'urn:xmpp:mam:2')!.attrs.queryid
    if (pass === 1) { started.resolve(); await release.promise }
    const id = pass === 1 ? 'c2' : 'c3', body = pass === 1 ? 'second caption' : 'latest caption'
    collectors.get(queryId)!(xml('message', {}, xml('result', { xmlns: 'urn:xmpp:mam:2', queryid: queryId, id: `sid-${id}` },
      xml('forwarded', { xmlns: 'urn:xmpp:forward:0' }, xml('delay', { xmlns: 'urn:xmpp:delay', stamp: pass === 1 ? T2 : FAST }), h.stanza({ id, body })))))
    return xml('iq', { type: 'result' }, xml('fin', { xmlns: 'urn:xmpp:mam:2', complete: 'true' }))
  }
  await h.live({ id: 'c2', body: 'second caption' })
  await started.promise
  await h.live({ id: 'c3', body: 'latest caption' })
  release.resolve()
  await vi.waitFor(async () => expect((await reload(kind)).body).toBe('latest caption'))
  expect(requests).toBe(2)
  expect(preview(kind)?.body).toBe('latest caption')
  expect(await searchIndex.search('second')).toEqual([])
  expect(await searchIndex.search('latest')).toHaveLength(1)
})

describe.each<Kind>(['chat', 'room'])('%s rapid live edits during reconciliation', kind => {
  it('eventually shows the last edit when new edits arrive during two pending queries', async () => {
    setStorageScopeJid(SELF)
    const h = harness(kind), base = original(kind)
    await save(kind, base); seed(kind, [base]); seedPreview(kind, base)
    await h.archive([{ id: 'previous-c0', body: 'previous archived caption', at: T0 }], true)
    const collectors = new Map<string, (stanza: Element) => void>()
    const requests: ReturnType<typeof deferred>[] = []
    let holdCount = 2, latest = { id: '', body: '', at: T1 }
    h.deps.registerMAMCollector = (id, handler) => { collectors.set(id, handler); return () => { collectors.delete(id) } }
    h.deps.sendIQ = async iq => {
      const query = iq.getChild('query', 'urn:xmpp:mam:2')
      if (!query) throw new Error('Unexpected non-MAM request')
      const queryId = query.attrs.queryid, entry = { ...latest }, archiveId = `sid-${entry.id}`
      const collector = collectors.get(queryId)
      if (!collector) throw new Error('No MAM collector')
      collector(xml('message', { from: kind === 'room' ? ROOM : SELF },
        xml('result', { xmlns: 'urn:xmpp:mam:2', queryid: queryId, id: archiveId },
          xml('forwarded', { xmlns: 'urn:xmpp:forward:0' }, xml('delay', { xmlns: 'urn:xmpp:delay', stamp: entry.at }),
            h.stanza({ id: entry.id, body: entry.body })))))
      const release = deferred(), index = requests.push(release) - 1
      if (index < holdCount) await release.promise
      return xml('iq', { type: 'result' }, xml('fin', { xmlns: 'urn:xmpp:mam:2', complete: 'true' },
        xml('set', { xmlns: 'http://jabber.org/protocol/rsm' }, xml('first', {}, archiveId), xml('last', {}, archiveId))))
    }
    const deliver = async (number: number, body: string) => {
      latest = { id: `burst-c${number}`, body, at: new Date(Date.parse(T1) + number * 1000).toISOString() }
      await h.live({ id: latest.id, body: latest.body })
    }
    try {
      await deliver(1, 'first burst caption')
      await vi.waitFor(async () => expect(requests.length > 0 || (await reload(kind)).body === latest.body).toBe(true))
      if (requests.length === 0) {
        holdCount = 0
        await deliver(2, 'second burst caption'); await deliver(3, 'latest burst caption')
      } else {
        await deliver(2, 'second burst caption'); requests[0].resolve()
        await vi.waitFor(async () => expect(requests.length > 1 || (await reload(kind)).body === latest.body).toBe(true))
        if (requests.length > 1) {
          await deliver(3, 'latest burst caption'); requests[1].resolve()
        } else {
          holdCount = 0; await deliver(3, 'latest burst caption')
        }
        holdCount = 0
      }
      await vi.waitFor(async () => expect((await reload(kind)).body).toBe('latest burst caption'), { timeout: 1500, interval: 10 })
      expect(preview(kind)?.body).toBe('latest burst caption')
      expect(await searchIndex.search('first')).toEqual([])
      expect(await searchIndex.search('second')).toEqual([])
      expect(await searchIndex.search('latest')).toHaveLength(1)
    } finally { holdCount = 0; for (const request of requests) request.resolve(); await drain() }
  })
})

function reconciliationArchive(h: ReturnType<typeof harness>, kind: Kind,
  entries: () => Array<{ id: string; at: string; message: Element }>,
  beforeResponse: (request: number) => Promise<void> = async () => {}) {
  const collectors = new Map<string, (stanza: Element) => void>()
  h.deps.registerMAMCollector = (id, collector) => { collectors.set(id, collector); return () => { collectors.delete(id) } }
  const send = vi.fn(async (iq: Element) => {
    const query = iq.getChild('query', 'urn:xmpp:mam:2')!
    expect(query.attrs.to ?? iq.attrs.to).toBe(kind === 'room' ? ROOM : undefined)
    const fields = query.getChild('x', 'jabber:x:data')!.getChildren('field')
    expect(fields.map(field => field.attrs.var)).toEqual(kind === 'room' ? ['FORM_TYPE'] : ['FORM_TYPE', 'with'])
    if (kind === 'chat') expect(fields[1].getChildText('value')).toBe(PEER)
    const rsm = query.getChild('set', 'http://jabber.org/protocol/rsm')!
    const max = Number(rsm.getChildText('max')), before = rsm.getChild('before'), after = rsm.getChildText('after')
    expect(max).toBeLessThanOrEqual(50)
    const archive = entries()
    const cursor = after || before?.getText()
    const cursorIndex = cursor ? archive.findIndex(entry => entry.id === cursor) : -1
    if (cursor && cursorIndex < 0) throw new Error('Synthetic unknown archive cursor')
    const end = before ? (cursor ? cursorIndex : archive.length) : archive.length
    const start = after ? cursorIndex + 1 : before ? Math.max(0, end - max) : 0
    const page = archive.slice(start, before ? end : start + max)
    await beforeResponse(send.mock.calls.length)
    for (const entry of page) collectors.get(query.attrs.queryid)?.(xml('message', {},
      xml('result', { xmlns: 'urn:xmpp:mam:2', queryid: query.attrs.queryid, id: entry.id },
        xml('forwarded', { xmlns: 'urn:xmpp:forward:0' }, xml('delay', { xmlns: 'urn:xmpp:delay', stamp: entry.at }), entry.message))))
    return xml('iq', { type: 'result' }, xml('fin', { xmlns: 'urn:xmpp:mam:2', complete: String(before ? start === 0 : start + page.length === archive.length) },
      xml('set', { xmlns: 'http://jabber.org/protocol/rsm' }, xml('first', {}, page[0]?.id ?? ''), xml('last', {}, page.at(-1)?.id ?? ''))))
  })
  h.deps.sendIQ = send
  return { send, collectors }
}

function enableReconciliation(h: ReturnType<typeof harness>, kind: Kind) {
  if (kind === 'chat') h.stores.connection.getServerInfo.mockReturnValue({ domain: 'example.test', identities: [], features: ['urn:xmpp:mam:2'] })
  else roomStore.getState().updateRoom(ROOM, { supportsMAM: true })
}

describe.each<Kind>(['chat', 'room'])('%s scoped reconciliation evidence', kind => {
  it.each([[false, false, false], [true, false, false], [false, true, false], [true, false, true]])('finds previous-session revision evidence beyond the newest page (equal dates: %s, first: %s, dated: %s)', async (equal, first, dated) => {
    setStorageScopeJid(SELF)
    let h = harness(kind)
    const base = original(kind)
    await save(kind, base); seed(kind, [base]); seedPreview(kind, base)
    await h.live({ id: 'old-session', body: 'previous caption', authoredAt: FAST })
    if (dated) await h.archive([{ id: 'old-session', body: 'previous caption', authoredAt: FAST, at: T1 }])
    const cached = await reload(kind)
    const oldSession = cached.correctionRevision?.receiveOrder?.session
    h = harness(kind)
    seed(kind, []); seedPreview(kind, cached)
    enableReconciliation(h, kind)
    const entries = () => [
      { id: base.stanzaId!, at: T0, message: xml('message', { id: base.id, from: base.from, to: SELF, type: base.type }, xml('body', {}, base.body)) },
      ...Array.from({ length: dated ? 160 : 0 }, (_, index) => ({ id: `earlier-${index}`, at: T0,
        message: xml('message', { from: base.from }, xml('body', {}, 'unrelated message')) })),
      { id: 'sid-old-session', at: T1, message: h.stanza({ id: 'old-session', body: 'previous caption', authoredAt: FAST }) },
      ...Array.from({ length: 60 }, (_, index) => ({ id: `filler-${index}`, at: T1,
        message: xml('message', { id: `filler-${index}`, from: base.from, to: SELF, type: base.type }, xml('body', {}, 'unrelated message')) })),
      { id: 'sid-new-session', at: equal ? T1 : T2, message: h.stanza({ id: 'new-session', body: 'current caption', authoredAt: T0 }) },
    ].slice(first ? 1 : 0)
    const server = reconciliationArchive(h, kind, entries)
    await h.live({ id: 'new-session', body: 'current caption', authoredAt: T0 })
    await vi.waitFor(async () => expect((await reload(kind)).body).toBe('current caption'))
    const row = await reload(kind)
    expect(row).toMatchObject({ id: base.id, stanzaId: base.stanzaId, timestamp: base.timestamp, correctionTimestamp: Date.parse(T0), correctionTimestampSource: 'authored', originalBody: base.body })
    expect(row.correctionRevision?.receiveOrder?.session).not.toBe(oldSession)
    expect(row.correctionAlternatives ?? []).toEqual([])
    expect(preview(kind)?.body).toBe('current caption')
    expect(await searchIndex.search('previous')).toEqual([])
    expect(await searchIndex.search('current')).toHaveLength(1)
    expect(server.send.mock.calls.length).toBeGreaterThan(1)
    expect(server.send.mock.calls.length).toBeLessThanOrEqual(4)
    expect(server.collectors.size).toBe(0)
  })

  it.each([[false, false], [true, false], [false, true], [true, true]])('resolves newly learned retraction aliases (foreign: %s, cache-only: %s)', async (foreign, cacheOnly) => {
    setStorageScopeJid(SELF)
    const h = harness(kind), base = original(kind)
    await save(kind, base); seed(kind, [base]); seedPreview(kind, base)
    await h.archive([{ id: 'c1', body: 'previous caption', at: T1 }], true)
    if (cacheOnly) seed(kind, [])
    const server = reconciliationArchive(h, kind, () => [
      { id: 'new-archive-alias', at: T2, message: h.stanza({ id: 'c2', body: 'current caption', stanzaId: 'new-archive-alias' }) },
      { id: 'retraction', at: FAST, message: xml('message', { from: foreign && kind === 'chat' ? 'intruder@example.test' : base.from, to: SELF, type: base.type },
        xml('retract', { xmlns: 'urn:xmpp:message-retract:1', id: 'new-archive-alias' }),
        ...(kind === 'room' ? [xml('occupant-id', { xmlns: 'urn:xmpp:occupant-id:0', id: foreign ? 'foreign-occupant' : 'peer-occupant' })] : [])) },
    ])
    await h.live({ id: 'c2', body: 'current caption', omitStanzaId: true })
    await vi.waitFor(async () => {
      const row = await reload(kind)
      if (foreign) { expect(row.isRetracted).toBeFalsy(); expect(row.body).toBe('current caption') }
      else { expect(row.isRetracted).toBe(true); expect(row.body).toBe('') }
    })
    expect((await reload(kind)).correctionAlternatives ?? []).toEqual([])
    expect(preview(kind)?.body).toBe(foreign ? 'current caption' : '')
    expect(await searchIndex.search('caption')).toHaveLength(foreign ? 1 : 0)
    expect(server.send).toHaveBeenCalledTimes(1)
  })
})

describe.each<Kind>(['chat', 'room'])('%s reconciliation request ownership', kind => {
  it('serves three different originals arriving during successive queries', async () => {
    setStorageScopeJid(SELF)
    const h = harness(kind)
    const bases = Array.from({ length: 3 }, (_, i) => ({ ...original(kind), id: `original-${i}`, stanzaId: `archive-original-${i}` }))
    await save(kind, ...bases); seed(kind, bases); seedPreview(kind, bases[2])
    await h.archive(bases.map((base, i) => ({ id: `previous-${i}`, body: `previous caption ${i}`, at: T1, targetId: base.id })))
    const latest: Array<{ id: string; at: string; message: Element }> = []
    const releases = [deferred(), deferred()]
    const server = reconciliationArchive(h, kind, () => [...latest], async request => {
      if (request <= releases.length) await releases[request - 1].promise
    })
    const deliver = async (index: number) => {
      const edit = { id: `current-${index}`, body: `current caption ${index}`, targetId: bases[index].id }
      latest.push({ id: `sid-${edit.id}`, at: T2, message: h.stanza(edit) })
      await h.live(edit)
    }
    try {
      await deliver(0)
      await vi.waitFor(() => expect(server.send).toHaveBeenCalledTimes(1))
      await deliver(1); releases[0].resolve()
      await vi.waitFor(() => expect(server.send).toHaveBeenCalledTimes(2))
      await deliver(2); releases[1].resolve()
      await vi.waitFor(async () => {
        await drain()
        const rows = kind === 'chat' ? await cache.getMessages(PEER) : await cache.getRoomMessages(ROOM, {})
        expect(rows).toHaveLength(3)
        for (let i = 0; i < 3; i++) expect(rows.find(row => row.id === bases[i].id)?.body).toBe(`current caption ${i}`)
      })
      expect(server.send).toHaveBeenCalledTimes(3)
      expect(server.collectors.size).toBe(0)
      expect(preview(kind)?.body).toBe('current caption 2')
      expect(await searchIndex.search('previous')).toEqual([])
      expect(await searchIndex.search('current')).toHaveLength(3)
    } finally { releases.forEach(release => release.resolve()); await drain() }
  })

  it.each(['original-cursor', 'unavailable', 'unsupported', 'budget', 'account', 'roundtrip', 'manager', 'transport'] as const)(
    'bounds missing-revision requests and handles %s', async outcome => {
      setStorageScopeJid(SELF)
      let h = harness(kind)
      const base = original(kind)
      await save(kind, base); seed(kind, [base]); seedPreview(kind, base)
      await h.live({ id: 'c1', body: 'previous caption', omitStanzaId: outcome === 'original-cursor' || outcome === 'budget' })
      const cached = await reload(kind)
      h = harness(kind)
      seed(kind, []); seedPreview(kind, cached)
      if (outcome !== 'unsupported') enableReconciliation(h, kind)
      const fillers = outcome === 'budget' ? 160 : 60
      const started = deferred(), release = deferred()
      const cancelled = ['account', 'roundtrip', 'manager', 'transport'].includes(outcome)
      const server = reconciliationArchive(h, kind, () => [
        { id: base.stanzaId!, at: T0, message: xml('message', { id: base.id, from: base.from, to: SELF, type: base.type }, xml('body', {}, base.body)) },
        ...Array.from({ length: fillers }, (_, index) => ({ id: `filler-${index}`, at: T1, message: xml('message', { from: base.from }, xml('body', {}, 'other')) })),
        { id: 'sid-c1', at: T1, message: h.stanza({ id: 'c1', body: 'previous caption' }) },
        ...Array.from({ length: 60 }, (_, index) => ({ id: `later-${index}`, at: T1, message: xml('message', { from: base.from }, xml('body', {}, 'other')) })),
        { id: 'sid-c2', at: T2, message: h.stanza({ id: 'c2', body: 'current caption' }) },
      ], async request => {
        if (request === 2) {
          if (outcome === 'unavailable') throw new Error('Synthetic archive unavailable')
          if (cancelled) { started.resolve(); await release.promise }
        }
      })
      try {
        await h.live({ id: 'c2', body: 'current caption' })
        if (cancelled) {
          await started.promise
          if (outcome === 'account' || outcome === 'roundtrip') { setStorageScopeJid('other@example.test'); if (outcome === 'roundtrip') setStorageScopeJid(SELF) }
          if (outcome === 'manager') h.deps.getE2EEManager = () => ({}) as E2EEManager
          if (outcome === 'transport') {
            const xmpp = createMockXmppClient() as unknown as ReturnType<ModuleDependencies['getXmpp']>
            h.deps.getXmpp = () => xmpp
          }
          release.resolve()
        }
        await vi.waitFor(() => expect(server.collectors.size).toBe(0))
        await drain()
        if (outcome === 'original-cursor' || outcome === 'budget') {
          expect((await reload(kind)).body).toBe('current caption')
          expect(preview(kind)?.body).toBe('current caption')
          expect(await searchIndex.search('previous')).toEqual([])
          expect(await searchIndex.search('current')).toHaveLength(1)
          if (outcome === 'budget') expect(server.send.mock.calls.length).toBeGreaterThan(3)
        }
        else {
          expect(preview(kind)?.body).toBe('previous caption')
          if (!cancelled) {
            const row = await reload(kind)
            expect(row.body).toBe('previous caption')
            expect(row.correctionAlternatives).toHaveLength(1)
            const calls = server.send.mock.calls.length
            await h.live({ id: 'c2', body: 'current caption' })
            await h.live({ id: 'c2', body: 'current caption' })
            await drain()
            expect(server.send).toHaveBeenCalledTimes(calls)
          }
        }
        expect(server.send.mock.calls.length).toBeLessThanOrEqual(outcome === 'unsupported' ? 0 : outcome === 'budget' ? 6 : 4)
      } finally { release.resolve(); await drain() }
    })
})

it.each<Kind>(['chat', 'room'])('serves fresh %s work queued during a failed batch without retrying the failed generation', async kind => {
  setStorageScopeJid(SELF)
  const h = harness(kind), base = original(kind)
  await save(kind, base); seed(kind, [base]); seedPreview(kind, base)
  await h.archive([{ id: 'previous', body: 'previous caption', at: T0 }], true)
  let latest = { id: 'c1', body: 'second caption' }
  const started = deferred(), release = deferred()
  const server = reconciliationArchive(h, kind, () => [{ id: `sid-${latest.id}`, at: T2, message: h.stanza(latest) }], async request => {
    if (request === 1) { started.resolve(); await release.promise; throw new Error('Synthetic failed first batch') }
  })
  try {
    await h.live(latest); await started.promise
    latest = { id: 'c2', body: 'latest caption' }
    await h.live(latest); release.resolve()
    await vi.waitFor(async () => expect((await reload(kind)).body).toBe('latest caption'))
    expect(server.send).toHaveBeenCalledTimes(2)
    await h.live({ id: 'c1', body: 'second caption' })
    await h.live(latest)
    expect(server.send).toHaveBeenCalledTimes(2)
    expect(server.collectors.size).toBe(0)
    expect((await reload(kind)).body).toBe('latest caption')
    expect(preview(kind)?.body).toBe('latest caption')
    expect(await searchIndex.search('second')).toEqual([])
    expect(await searchIndex.search('latest')).toHaveLength(1)
  } finally { release.resolve(); await drain() }
})

it.each((['chat', 'room'] as const).flatMap(kind => [false, true].map(reloadSession => ({ kind, reloadSession }))))('preserves independent completed archive replay provenance for $kind (reload $reloadSession)', async ({ kind, reloadSession }) => {
  setStorageScopeJid(SELF)
  let h = harness(kind)
  const base = original(kind)
  await save(kind, base); seed(kind, [base]); seedPreview(kind, base)
  await h.archive([{ id: 'completed-c1', body: 'previous caption', at: T1 }], true)
  if (reloadSession) {
    const held = await reload(kind)
    h = harness(kind); seed(kind, [held]); seedPreview(kind, held)
    enableReconciliation(h, kind)
  }
  const sendIQ = h.deps.sendIQ
  h.deps.sendIQ = async () => { throw new Error('Synthetic archive temporarily unavailable') }
  await h.live({ id: 'retained-c2', body: 'retained caption' })
  let row = await reload(kind)
  expect(row.correctionAlternatives).toEqual(expect.arrayContaining([expect.objectContaining({ body: 'retained caption' })]))
  await h.live({ id: 'completed-c1', body: 'previous caption' })
  row = await reload(kind)
  expect(row.correctionAlternatives).toEqual(expect.arrayContaining([expect.objectContaining({ body: 'retained caption' })]))
  expect(row.correctionRevision?.supersedes ?? []).not.toContain('id:retained-c2')
  h.deps.sendIQ = sendIQ
  await h.archive([{ id: 'retained-c2', body: 'retained caption', at: T2 }])
  expect((await reload(kind)).body).toBe('retained caption')
  expect(preview(kind)?.body).toBe('retained caption')
  expect(await searchIndex.search('previous')).toEqual([])
  expect(await searchIndex.search('retained')).toHaveLength(1)
})


it.each((['chat', 'room'] as const).flatMap(kind => [false, true].map(reloadSession => ({ kind, reloadSession }))))('preserves independent completed archive replay provenance for alternative owner $kind (reload $reloadSession)', async ({ kind, reloadSession }) => {
  setStorageScopeJid(SELF)
  let h = harness(kind)
  const base = original(kind)
  await save(kind, base); seed(kind, [base]); seedPreview(kind, base)
  const started = deferred(), release = deferred(), send = h.deps.sendIQ
  h.deps.sendIQ = async (...args) => {
    const response = await send(...args)
    started.resolve(); await release.promise; return response
  }
  const work = h.archive([{ id: 'alternative-c1', body: 'previous caption', at: T1 }])
  await started.promise
  try {
    await h.live({ id: 'current-c2', body: 'current caption' })
    release.resolve(); await work; await drain()
    let row = await reload(kind)
    expect(row.body).toBe('current caption')
    expect(row.correctionAlternatives).toEqual(expect.arrayContaining([expect.objectContaining({ body: 'previous caption' })]))
    if (reloadSession) {
      h = harness(kind); seed(kind, [row]); seedPreview(kind, row)
    }
    const resumedSend = reloadSession ? h.deps.sendIQ : send
    h.deps.sendIQ = async () => { throw new Error('Synthetic archive temporarily unavailable') }
    await h.live({ id: 'alternative-c1', body: 'previous caption' })
    row = await reload(kind)
    expect(row.body).toBe('current caption')
    expect(row.correctionRevision?.supersedes ?? []).not.toContain('id:current-c2')
    expect(preview(kind)?.body).toBe('current caption')
    expect(await searchIndex.search('previous')).toEqual([])
    expect(await searchIndex.search('current')).toHaveLength(1)
    h.deps.sendIQ = resumedSend
    await h.archive([{ id: 'current-c2', body: 'current caption', at: T2 }])
    expect((await reload(kind)).body).toBe('current caption')
    expect(preview(kind)?.body).toBe('current caption')
    expect(await searchIndex.search('previous')).toEqual([])
    expect(await searchIndex.search('current')).toHaveLength(1)
  } finally { release.resolve(); await work }
})

it.each<Kind>(['chat', 'room'])('advances an independent absorbed original reconciliation for %s', async kind => {
  setStorageScopeJid(SELF)
  const base = { ...original(kind), id: 'z-original', stanzaId: undefined, originId: 'origin-original' }
  const h = harness(kind, false, base)
  await save(kind, base)
  await save(kind, { ...base, id: 'a-canonical', stanzaId: 'archive-original' })
  const canonical = await reload(kind)
  expect(canonical.id).toBe('a-canonical')
  seed(kind, []); seedPreview(kind, canonical)
  await h.archive([{ id: 'known-c1', body: 'previous caption', at: T1, targetId: base.id }])
  const previous = await reload(kind)
  expect(previous.body).toBe('previous caption')
  seed(kind, []); seedPreview(kind, previous)
  const server = reconciliationArchive(h, kind, () => [
    { id: 'archive-original', at: T0, message: xml('message', { id: canonical.id, from: base.from, to: SELF, type: base.type }, xml('body', {}, base.body)) },
    { id: 'sid-known-c1', at: T1, message: h.stanza({ id: 'known-c1', body: 'previous caption', targetId: base.id }) },
    { id: 'sid-fresh-c2', at: T2, message: h.stanza({ id: 'fresh-c2', body: 'current caption', targetId: base.id }) },
  ])
  await h.live({ id: 'fresh-c2', body: 'current caption', targetId: base.id, omitStanzaId: true })
  await vi.waitFor(async () => expect((await reload(kind)).body).toBe('current caption'), { timeout: 1500, interval: 10 })
  const current = await reload(kind)
  expect(current).toMatchObject({ id: canonical.id, stanzaId: canonical.stanzaId, originId: canonical.originId, timestamp: canonical.timestamp })
  expect(preview(kind)?.body).toBe('current caption')
  expect(await searchIndex.search('previous')).toEqual([])
  expect(await searchIndex.search('current')).toHaveLength(1)
  expect(server.collectors.size).toBe(0)
})

describe.each<Kind>(['chat', 'room'])('%s independent reconciliation archive evidence', kind => {
  it.each([false, true])('handles a newly learned retraction alias, foreign actor %s', async foreign => {
    setStorageScopeJid(SELF)
    const h = harness(kind), base = original(kind)
    await save(kind, base); seed(kind, [base]); seedPreview(kind, base)
    await h.archive([{ id: 'c1', body: 'previous caption', at: T1 }], true)
    const collectors = new Map<string, (stanza: Element) => void>()
    h.deps.registerMAMCollector = (id, cb) => { collectors.set(id, cb); return () => { collectors.delete(id) } }
    let requests = 0
    h.deps.sendIQ = async iq => {
      requests++
      const qid = iq.getChild('query', 'urn:xmpp:mam:2')!.attrs.queryid, collector = collectors.get(qid)!
      const from = foreign ? (kind === 'room' ? `${ROOM}/Other` : 'other@example.test') : base.from
      const entries = [
        { id: 'new-archive-c2', message: h.stanza({ id: 'c2', body: 'current caption', stanzaId: 'new-archive-c2' }) },
        { id: 'retraction-signal', message: xml('message', { from, to: SELF, type: base.type },
          xml('retract', { xmlns: 'urn:xmpp:message-retract:1', id: 'new-archive-c2' }),
          ...(kind === 'room' ? [xml('occupant-id', { xmlns: 'urn:xmpp:occupant-id:0', id: foreign ? 'other-occupant' : 'peer-occupant' })] : [])) },
      ]
      for (const entry of entries) collector(xml('message', {}, xml('result', { xmlns: 'urn:xmpp:mam:2', queryid: qid, id: entry.id },
        xml('forwarded', { xmlns: 'urn:xmpp:forward:0' }, xml('delay', { xmlns: 'urn:xmpp:delay', stamp: T2 }), entry.message))))
      return xml('iq', { type: 'result' }, xml('fin', { xmlns: 'urn:xmpp:mam:2', complete: 'true' },
        xml('set', { xmlns: 'http://jabber.org/protocol/rsm' }, xml('first', {}, entries[0].id), xml('last', {}, entries[1].id))))
    }
    await h.live({ id: 'c2', body: 'current caption', omitStanzaId: true })
    await vi.waitFor(async () => {
      const row = await reload(kind)
      if (foreign) { expect(row.isRetracted).not.toBe(true); expect(row.body).toBe('current caption') }
      else expect(row.isRetracted).toBe(true)
    }, { timeout: 1500, interval: 10 })
    expect(requests).toBeGreaterThan(0)
    expect(await searchIndex.search('previous')).toEqual([])
    if (foreign) expect(await searchIndex.search('current')).toHaveLength(1)
    else { expect(await searchIndex.search('current')).toEqual([]); expect(preview(kind)?.isRetracted).toBe(true) }
  })

  it.each([0, 160])('resolves an undated predecessor outside the latest archive page after reload with %i prior messages', async priorCount => {
    setStorageScopeJid(SELF)
    let h = harness(kind)
    const base = original(kind)
    await save(kind, base); seed(kind, [base]); seedPreview(kind, base)
    await h.live({ id: 'older-c1', body: 'previous caption', omitStanzaId: true })
    const old = await reload(kind)
    expect(old.correctionRevision?.archiveTimestamp).toBeUndefined()
    h = harness(kind); seed(kind, [old]); seedPreview(kind, old)
    await h.archive([], true)
    const entries: Array<{ id: string; at: string; message: Element }> = [
      { id: base.stanzaId!, at: T0, message: xml('message', { id: base.id, from: base.from, to: SELF, type: base.type }, xml('body', {}, base.body),
        xml('stanza-id', { xmlns: 'urn:xmpp:sid:0', by: kind === 'room' ? ROOM : SELF, id: base.stanzaId! }),
        ...(kind === 'room' ? [xml('occupant-id', { xmlns: 'urn:xmpp:occupant-id:0', id: 'peer-occupant' })] : [])) },
      ...Array.from({ length: priorCount }, (_, i) => ({ id: `prior-noise-${i}`, at: new Date(Date.parse(T0) + 200 * (i + 1)).toISOString(),
        message: xml('message', { id: `prior-noise-${i}`, from: base.from, to: SELF, type: base.type }, xml('body', {}, `prior noise ${i}`)) })),
      { id: 'archive-older-c1', at: T1, message: h.stanza({ id: 'older-c1', body: 'previous caption', omitStanzaId: true }) },
      ...Array.from({ length: 70 }, (_, i) => ({ id: `noise-${i}`, at: new Date(Date.parse(T1) + 1000 * (i + 1)).toISOString(),
        message: xml('message', { id: `noise-${i}`, from: base.from, to: SELF, type: base.type }, xml('body', {}, `noise ${i}`)) })),
      { id: 'archive-fresh-c2', at: FAST, message: h.stanza({ id: 'fresh-c2', body: 'current caption', omitStanzaId: true }) },
    ]
    const collectors = new Map<string, (stanza: Element) => void>()
    h.deps.registerMAMCollector = (id, cb) => { collectors.set(id, cb); return () => { collectors.delete(id) } }
    h.deps.sendIQ = async iq => {
      const query = iq.getChild('query', 'urn:xmpp:mam:2')!, qid = query.attrs.queryid
      const fields = query.getChild('x', 'jabber:x:data')!.getChildren('field')
      for (const field of fields) if (!['FORM_TYPE', 'with', 'start', 'end'].includes(field.attrs.var)) throw new Error(`Unsupported basic MAM field ${field.attrs.var}`)
      const fieldValue = (name: string) => fields.find(field => field.attrs.var === name)?.getChildText('value')
      const start = fieldValue('start'), end = fieldValue('end')
      let candidates = entries.filter(entry => (!start || entry.at >= start) && (!end || entry.at <= end))
      const rsm = query.getChild('set', 'http://jabber.org/protocol/rsm')
      const after = rsm?.getChildText('after'), before = rsm?.getChild('before')
      if (after) { const index = candidates.findIndex(entry => entry.id === after); if (index < 0) throw new Error('Unknown after cursor'); candidates = candidates.slice(index + 1) }
      if (before?.getText()) { const index = candidates.findIndex(entry => entry.id === before.getText()); if (index < 0) throw new Error('Unknown before cursor'); candidates = candidates.slice(0, index) }
      const max = Number(rsm?.getChildText('max') ?? 50)
      const page = before ? candidates.slice(-max) : candidates.slice(0, max)
      for (const entry of page) collectors.get(qid)!(xml('message', {}, xml('result', { xmlns: 'urn:xmpp:mam:2', queryid: qid, id: entry.id },
        xml('forwarded', { xmlns: 'urn:xmpp:forward:0' }, xml('delay', { xmlns: 'urn:xmpp:delay', stamp: entry.at }), entry.message))))
      return xml('iq', { type: 'result' }, xml('fin', { xmlns: 'urn:xmpp:mam:2', complete: page.length === candidates.length ? 'true' : 'false' },
        xml('set', { xmlns: 'http://jabber.org/protocol/rsm' }, xml('first', {}, page[0]?.id ?? ''), xml('last', {}, page.at(-1)?.id ?? ''))))
    }
    await h.live({ id: 'fresh-c2', body: 'current caption', omitStanzaId: true })
    await vi.waitFor(async () => expect((await reload(kind)).body).toBe('current caption'), { timeout: 1500, interval: 10 })
    expect(preview(kind)?.body).toBe('current caption')
    expect(await searchIndex.search('previous')).toEqual([])
    expect(await searchIndex.search('current')).toHaveLength(1)
  })
})

describe.each<Kind>(['chat', 'room'])('%s reconciliation traversal termination', kind => {
  it.each(['complete', 'growth', 'repeated', 'error', 'roundtrip', 'queued'] as const)('preserves finite progress with %s', async outcome => {
    setStorageScopeJid(SELF)
    let h = harness(kind)
    const base = original(kind)
    await save(kind, base); seed(kind, [base]); seedPreview(kind, base)
    await h.live({ id: 'c1', body: 'previous caption', omitStanzaId: true })
    const cached = await reload(kind)
    h = harness(kind); seed(kind, []); seedPreview(kind, cached)
    enableReconciliation(h, kind)
    const filler = (id: string) => ({ id, at: T1, message: xml('message', { id, from: base.from, to: SELF, type: base.type }, xml('body', {}, 'unrelated')) })
    const archive = [
      { id: base.stanzaId!, at: T0, message: xml('message', { id: base.id, from: base.from, to: SELF, type: base.type }, xml('body', {}, base.body)) },
      ...Array.from({ length: 160 }, (_, i) => filler(`before-${i}`)),
      ...(outcome === 'queued' ? [{ id: 'archive-c1', at: T1, message: h.stanza({ id: 'c1', body: 'previous caption', omitStanzaId: true }) }] : []),
      ...Array.from({ length: 70 }, (_, i) => filler(`after-${i}`)),
      { id: 'archive-c2', at: T2, message: h.stanza({ id: 'c2', body: 'current caption', omitStanzaId: true }) },
    ]
    const started = deferred(), release = deferred()
    const server = reconciliationArchive(h, kind, () => [...archive], async request => {
      if (outcome === 'growth') archive.push(...Array.from({ length: 50 }, (_, i) => filler(`growth-${request}-${i}`)))
      if (request === 3) {
        if (outcome === 'error') throw new Error('Synthetic cursor read failed')
        if (outcome === 'roundtrip' || outcome === 'queued') { started.resolve(); await release.promise }
      }
    })
    const send = h.deps.sendIQ
    h.deps.sendIQ = async iq => {
      const response = await send(iq)
      if (outcome === 'repeated' && server.send.mock.calls.length >= 3) {
        response.getChild('fin', 'urn:xmpp:mam:2')!.getChild('set', 'http://jabber.org/protocol/rsm')!.getChild('last')!.children = ['before-49']
      }
      return response
    }
    try {
      await h.live({ id: 'c2', body: 'current caption', omitStanzaId: true })
      if (outcome === 'roundtrip' || outcome === 'queued') {
        await started.promise
        if (outcome === 'roundtrip') { setStorageScopeJid('other@example.test'); setStorageScopeJid(SELF) }
        else {
          archive.push({ id: 'archive-c3', at: FAST, message: h.stanza({ id: 'c3', body: 'latest caption', omitStanzaId: true }) })
          await h.live({ id: 'c3', body: 'latest caption', omitStanzaId: true })
        }
        release.resolve()
      }
      await vi.waitFor(() => {
        expect(server.send.mock.calls.length).toBeGreaterThan(1)
        expect(server.collectors.size).toBe(0)
      })
      await drain()
      const afters = server.send.mock.calls.map(([iq]) => iq.getChild('query', 'urn:xmpp:mam:2')!.getChild('set', 'http://jabber.org/protocol/rsm')!.getChildText('after')).filter(Boolean)
      expect(new Set(afters).size).toBe(afters.length)
      if (outcome === 'queued') {
        expect((await reload(kind)).body).toBe('latest caption')
        expect(preview(kind)?.body).toBe('latest caption')
        expect(await searchIndex.search('latest')).toHaveLength(1)
        expect(await searchIndex.search('previous')).toEqual([])
        expect(server.send.mock.calls.length).toBeLessThanOrEqual(7)
      } else {
        expect(preview(kind)?.body).toBe('previous caption')
        if (outcome !== 'roundtrip') {
          const row = await reload(kind)
          expect(row.body).toBe('previous caption')
          expect(row.correctionAlternatives).toEqual(expect.arrayContaining([expect.objectContaining({ body: 'current caption' })]))
          const calls = server.send.mock.calls.length
          await h.live({ id: 'c2', body: 'current caption', omitStanzaId: true })
          expect(server.send).toHaveBeenCalledTimes(calls)
        }
        expect(server.send.mock.calls.length).toBe(outcome === 'complete' || outcome === 'growth' ? 6 : 3)
      }
    } finally { release.resolve(); await drain() }
  })
})

it.each<Kind>(['chat', 'room'])('cancels %s absorbed alias lookup across an account round trip', async kind => {
  setStorageScopeJid(SELF)
  const base = { ...original(kind), id: 'z-original', stanzaId: undefined, originId: 'origin-original' }
  const h = harness(kind, false, base)
  await save(kind, base); await save(kind, { ...base, id: 'a-canonical', stanzaId: 'archive-original' })
  await h.archive([{ id: 'c1', body: 'previous caption', at: T1 }])
  const previous = await reload(kind)
  seed(kind, []); seedPreview(kind, previous)
  const server = reconciliationArchive(h, kind, () => [{ id: 'archive-c2', at: T2, message: h.stanza({ id: 'c2', body: 'current caption', omitStanzaId: true }) }])
  const started = deferred(), release = deferred()
  const store = kind === 'chat' ? h.stores.chat : h.stores.room
  const lookup = store.resolveCorrectionReferences.getMockImplementation()!
  store.resolveCorrectionReferences.mockImplementation(async (...args) => {
    const references = await lookup(...args)
    started.resolve(); await release.promise
    return references
  })
  try {
    await h.live({ id: 'c2', body: 'current caption', omitStanzaId: true })
    await started.promise
    setStorageScopeJid('other@example.test'); setStorageScopeJid(SELF)
    release.resolve()
    await vi.waitFor(() => expect(server.collectors.size).toBe(0))
    expect(preview(kind)?.body).toBe('previous caption')
    expect(server.send).toHaveBeenCalledTimes(1)
  } finally { release.resolve(); await drain() }
})


it.each((['chat', 'room'] as const).flatMap(kind => [false, true].flatMap(reloadSession =>
  [false, true].map(cachedOnly => ({ kind, reloadSession, cachedOnly })))))(
  'keeps genuine live progress after archived replay for $kind reload=$reloadSession cached=$cachedOnly', async ({ kind, reloadSession, cachedOnly }) => {
    setStorageScopeJid(SELF)
    let h = harness(kind)
    const base = original(kind)
    await save(kind, base); seed(kind, [base]); seedPreview(kind, base)
    await h.archive([{ id: 'known-c1', body: 'earlier caption', at: T1, authoredAt: FAST }], true)
    const snapshot = await reload(kind)
    if (reloadSession) h = harness(kind)
    seed(kind, cachedOnly ? [] : [snapshot]); seedPreview(kind, snapshot)
    h.deps.sendIQ = async () => { throw new Error('Synthetic archive temporarily unavailable') }
    await h.live({ id: 'known-c1', body: 'earlier caption', authoredAt: FAST })
    await save(kind, snapshot)
    if (!cachedOnly) await reload(kind)
    await h.live({ id: 'fresh-c2', body: 'current caption', authoredAt: T0 })
    const current = await reload(kind)
    expect(current).toMatchObject({ id: base.id, stanzaId: base.stanzaId, timestamp: base.timestamp,
      body: 'current caption', correctionTimestamp: Date.parse(T0), correctionTimestampSource: 'authored' })
    expect(current.correctionAlternatives).toBeUndefined()
    expect(preview(kind)?.body).toBe(current.body)
    expect(await searchIndex.search('earlier')).toEqual([])
    expect(await searchIndex.search('current')).toHaveLength(1)
    await h.live({ id: 'known-c1', body: 'earlier caption', authoredAt: FAST })
    expect((await reload(kind)).body).toBe(current.body)
    await h.live({ id: 'fresh-c3', body: 'latest caption', authoredAt: T1 })
    expect((await reload(kind)).body).toBe('latest caption')
    expect(preview(kind)?.body).toBe('latest caption')
    expect(await searchIndex.search('current')).toEqual([])
    expect(await searchIndex.search('latest')).toHaveLength(1)
  })
