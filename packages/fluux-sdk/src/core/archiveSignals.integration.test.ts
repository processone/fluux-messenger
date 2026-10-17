import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import 'fake-indexeddb/auto'
import { IDBFactory } from 'fake-indexeddb'
import { xml, type Client, type Element } from '@xmpp/client'
import { MAM } from './modules/MAM'
import type { ModuleDependencies } from './modules/BaseModule'
import { createPresenceReader } from './presenceReader'
import { createDefaultStoreBindings } from './defaultStoreBindings'
import { createStoreBindings } from '../bindings/storeBindings'
import { setupBackgroundSyncSideEffects } from './backgroundSync'
import { setupMdsSideEffects } from './mdsSideEffects'
import { setupChatSideEffects } from './chatSideEffects'
import { DeferredDecryptEngine } from './e2ee/deferredDecrypt'
import { E2EEManager, InMemoryStorageBackend, type XMPPPrimitives } from './e2ee'
import { DummyPlaintextPlugin } from './e2ee/DummyPlaintextPlugin'
import { E2EEPluginError } from './e2ee/errors'
import { createMockClient, localStorageMock, simulateFreshSession } from './sideEffects.testHelpers'
import { roomStore } from '../stores/roomStore'
import { chatStore } from '../stores/chatStore'
import { connectionStore } from '../stores/connectionStore'
import { rosterStore } from '../stores/rosterStore'
import { consoleStore } from '../stores/consoleStore'
import { eventsStore } from '../stores/eventsStore'
import { adminStore } from '../stores/adminStore'
import { blockingStore } from '../stores/blockingStore'
import { ignoreStore } from '../stores/ignoreStore'
import * as cache from '../utils/messageCache'
import { _resetStorageScopeForTesting, setStorageScopeJid } from '../utils/storageScope'
import { makeReadPointer } from '../stores/shared/readPointer'
import { subscribeDiagnostics, resetDiagnosticsForTesting, type UnreadRecountDiagnostic } from '../diagnostics/channel'
import type { DisplayedMarkerFetchResult } from './modules/Mds'
import { _resetUnreadLogForTesting } from '../stores/shared/unreadLog'
import { setLogSink } from './logger'
import type { Message } from './types'

Object.defineProperty(globalThis, 'localStorage', { value: localStorageMock, writable: true })
const OWN = 'self@example.test', PEER = 'peer@example.test'
const BASE = Date.parse('2026-10-15T12:00:00Z')
function row(id: string, n: number, outgoing = false): Message {
  return { type: 'chat', id, stanzaId: `s-${id}`, originId: undefined, timestamp: new Date(BASE + n * 1000), body: 'synthetic',
    isOutgoing: outgoing, from: outgoing ? OWN : PEER, conversationId: PEER }
}
function deferred<T>() {
  let resolve!: (v: T) => void
  const promise = new Promise<T>(r => { resolve = r })
  return { promise, resolve }
}
async function settle(ms = 1000) {
  for (let i = 0; i < Math.ceil(ms / 100); i++) {
    await vi.advanceTimersByTimeAsync(100)
    await new Promise<void>(r => setImmediate(r))
  }
}

describe('durable archive signals across fresh sessions', () => {
  let host: ReturnType<typeof createMockClient>, mam: MAM
  let cleanup: Array<() => void>, archive: Message[], logs: string[], verdicts: UnreadRecountDiagnostic[], transitions: unknown[]
  let queries: number, ownResource: string, pageSize: number
  let seed: ReturnType<typeof deferred<DisplayedMarkerFetchResult>>
  let manager: E2EEManager | null, engine: DeferredDecryptEngine, encryptedRows: Set<string>
  let decryptMode: 'locked' | 'verified' | 'untrusted' | 'bad-payload'
  let decryptedKind: 'reaction' | 'body' | 'retract' | 'correction', decryptAttempts: number
  const envelope = '<payload xmlns="jabber:client"><reactions xmlns="urn:xmpp:reactions:0" id="own"><reaction>👍</reaction></reactions></payload>'
  async function readyManager() {
    const record = (message: string) => { logs.push(message) }
    manager = new E2EEManager({ logger: { info: record, debug: record, warn: record, error: record }, storage: new InMemoryStorageBackend(), account: { jid: OWN }, xmpp: {
      sendStanza: async () => {}, queryDisco: async () => ({ features: [], identities: [] }),
      publishPEP: async () => {}, retractPEP: async () => {}, deletePEP: async () => {},
      queryPEP: async () => [], subscribePEP: () => ({ unsubscribe() {} }),
    } as XMPPPrimitives })
    const plugin = new DummyPlaintextPlugin()
    vi.spyOn(plugin, 'decrypt').mockImplementation(async () => {
      decryptAttempts++
      if (decryptMode === 'locked') throw new E2EEPluginError('transient', 'key-locked', 'synthetic key locked')
      const plaintext = decryptedKind === 'body' ? '<payload xmlns="jabber:client"><body>synthetic recovered</body></payload>'
        : decryptedKind === 'retract' ? '<payload xmlns="jabber:client"><retract xmlns="urn:xmpp:message-retract:1" id="read"/></payload>'
          : decryptedKind === 'correction' ? '<payload xmlns="jabber:client"><replace xmlns="urn:xmpp:message-correct:0" id="read"/><body>corrected</body></payload>' : envelope
      return { plaintext: new TextEncoder().encode(decryptMode === 'bad-payload'
        ? plaintext.replace('urn:xmpp:reactions:0', 'urn:synthetic:wrong:namespace') : plaintext),
      senderDevice: { jid: PEER, deviceId: 'fixture' },
      securityContext: { protocolId: 'dummy-plaintext', trust: decryptMode === 'untrusted' ? 'untrusted' : 'verified' } }
    })
    await manager.register(plugin)
  }
  const count = () => chatStore.getState().conversationMeta.get(PEER)!.unreadCount
  const pointer = () => chatStore.getState().conversationMeta.get(PEER)!.readPointer?.identity.messageId
  const last = () => chatStore.getState().conversationMeta.get(PEER)!.lastMessage
  async function seedState(pointerRow: Message, cached: Message[] = [pointerRow], unread = 0, preview = cached.at(-1)!) {
    archive = cached
    await cache.saveMessages(cached)
    chatStore.getState().addConversation({ id: PEER, name: 'Synthetic peer', type: 'chat', unreadCount: unread,
      lastMessage: preview, readPointer: makeReadPointer(pointerRow, 'chat') })
    chatStore.setState({ conversationCoverage: new Map([[PEER, { bottomId: cached[0].stanzaId!, countBottomId: cached[0].stanzaId! }]]) })
  }
  async function fresh() {
    connectionStore.getState().setServerInfo({ identities: [], domain: 'example.test', features: ['urn:xmpp:mam:2'] })
    simulateFreshSession(host)
    await settle(13000)
  }
  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] })
    vi.setSystemTime(new Date('2026-10-16T08:00:00Z'))
    globalThis.indexedDB = new IDBFactory()
    cache._resetDBForTesting(); _resetStorageScopeForTesting(); localStorageMock.clear()
    connectionStore.getState().reset(); chatStore.getState().reset(); roomStore.getState().reset(); rosterStore.getState().reset()
    setStorageScopeJid(OWN)
    connectionStore.setState({ jid: `${OWN}/mobile`, status: 'disconnected', windowVisible: true })
    rosterStore.getState().setContacts([{ jid: PEER, name: 'Synthetic peer', subscription: 'both', groups: [], presence: 'offline' }])
    cleanup = []; archive = []; logs = []; verdicts = []; transitions = []; queries = 0; ownResource = '/desktop'; pageSize = Infinity
    manager = null; encryptedRows = new Set(); decryptMode = 'locked'
    decryptedKind = 'reaction'; decryptAttempts = 0
    _resetUnreadLogForTesting(); resetDiagnosticsForTesting(); setLogSink((_level, line) => logs.push(line))
    cleanup.push(subscribeDiagnostics(event => { if (event.kind === 'unread-recount') verdicts.push(event) }))
    cleanup.push(chatStore.subscribe((s, p) => {
      const a = s.conversationMeta.get(PEER), b = p.conversationMeta.get(PEER)
      if (a?.unreadCount !== b?.unreadCount) transitions.push({ count: a?.unreadCount, pointer: a?.readPointer?.identity.messageId,
        last: a?.lastMessage?.id, own: a?.lastMessage?.isOutgoing })
    }))
    host = createMockClient(); seed = deferred()
    Object.assign(host.internal, { mds: { fetchAllDisplayedResult: vi.fn(() => seed.promise),
      publishDisplayed: vi.fn().mockResolvedValue(undefined), retractDisplayed: vi.fn().mockResolvedValue(undefined) } })
    cleanup.push(createStoreBindings(host, () => ({ connection: connectionStore.getState(), chat: chatStore.getState(),
      room: roomStore.getState(), roster: rosterStore.getState(), console: consoleStore.getState(), events: eventsStore.getState(),
      admin: adminStore.getState(), blocking: blockingStore.getState(), ignore: ignoreStore.getState() })))
    const collectors = new Map<string, (s: Element) => void>()
    const transport = {} as Client
    const stores = createDefaultStoreBindings()
    engine = new DeferredDecryptEngine({ getManager: () => manager, getStores: () => stores, getOwnBareJid: () => OWN,
      cache: { getMessagesWithEncryptedPayload: cache.getMessagesWithEncryptedPayload,
        updateMessage: cache.updateMessage, deleteMessage: cache.deleteMessage }, updateSearchIndex: async () => {} })
    host.retryPendingDecrypts.mockImplementation(() => engine.retryPending())
    const deps: ModuleDependencies = {
      stores, presence: createPresenceReader(), getXmpp: () => transport, getE2EEManager: () => manager,
      getCurrentJid: () => connectionStore.getState().jid, emit: host._emit, emitSDK: host._emitSDK,
      sendStanza: vi.fn().mockResolvedValue(undefined),
      registerMAMCollector: (id, handler) => { collectors.set(id, handler); return () => { collectors.delete(id) } },
      sendIQ: async iq => {
        queries++
        const query = iq.getChild('query', 'urn:xmpp:mam:2')!, set = query.getChild('set', 'http://jabber.org/protocol/rsm')!
        const after = set.getChildText('after')
        const before = set.getChildText('before')
        const selected = after ? archive.slice(archive.findIndex(r => r.stanzaId === after) + 1)
          : before ? archive.slice(0, archive.findIndex(r => r.stanzaId === before)) : archive
        const page = after ? selected.slice(0, pageSize) : selected.slice(-pageSize)
        const complete = page.length === selected.length
        for (const r of page) collectors.get(query.attrs.queryid)?.(xml('message', {},
          xml('result', { xmlns: 'urn:xmpp:mam:2', queryid: query.attrs.queryid, id: r.stanzaId! },
            xml('forwarded', { xmlns: 'urn:xmpp:forward:0' },
              xml('delay', { xmlns: 'urn:xmpp:delay', stamp: r.timestamp.toISOString() }),
              xml('message', { from: r.isOutgoing ? OWN + ownResource : `${PEER}/other`, to: r.isOutgoing ? PEER : OWN,
                type: 'chat', id: r.id }, ...(encryptedRows.has(r.id)
                  ? [xml('plain', { xmlns: 'urn:fluux:e2ee-dummy:0' }, 'c3ludGhldGlj'),
                    xml('encryption', { xmlns: 'urn:xmpp:eme:0', namespace: 'urn:fluux:e2ee-dummy:0', name: 'Fixture' })]
                  : [xml('body', {}, r.body)]))))))
        return xml('iq', { type: 'result' }, xml('fin', { xmlns: 'urn:xmpp:mam:2', complete: String(complete) },
          xml('set', { xmlns: 'http://jabber.org/protocol/rsm' },
            ...(page.length ? [xml('first', {}, page[0].stanzaId!), xml('last', {}, page.at(-1)!.stanzaId!)] : []))))
      },
    }
    mam = new MAM(deps)
    host.internal.mam.catchUpAllConversations.mockImplementation(mam.catchUpAllConversations.bind(mam))
    host.internal.mam.catchUpConversationHistory.mockImplementation(mam.catchUpConversationHistory.bind(mam))
    cleanup.push(setupMdsSideEffects(host)); cleanup.push(setupBackgroundSyncSideEffects(host))
  })
  afterEach(async () => {
    cleanup.reverse().forEach(fn => fn())
    setLogSink(null); chatStore.getState().reset(); roomStore.getState().reset()
    await settle(200); cache._resetDBForTesting(); vi.restoreAllMocks(); vi.useRealTimers()
  })

  async function reactionCatchup(active = false, ownReaction = false) {
    const read = row('read', 0), own = row('own', 2, true), reaction = row('reaction', 3, ownReaction)
    await seedState(own, [read, own]); archive = [read, own, reaction]; encryptedRows.add('reaction')
    seed.resolve({ status: 'authoritative', markers: [] })
    if (active) {
      chatStore.getState().setActiveConversation(PEER); cleanup.push(setupChatSideEffects(host))
      await chatStore.getState().recomputeUnreadForConversation(PEER, { allowActive: true })
    }
    await fresh()
  }
  it('remembers a deferred reaction across two fresh sessions without another unread flash', async () => {
    await reactionCatchup(); expect(count()).toBe(1)
    decryptMode = 'verified'; await readyManager(); expect(await engine.retryPending()).toBe(1); await settle(1000)
    expect(count()).toBe(0); expect(decryptAttempts).toBe(1)
    expect((await cache.getMessages(PEER)).map(m => m.id)).toEqual(['read', 'own'])
    expect((await cache.getMessages(PEER)).find(m => m.id === 'own')?.reactions).toEqual({ '👍': [PEER] })
    connectionStore.getState().setStatus('disconnected'); chatStore.getState().resetMAMStates(); manager = null
    cache._resetDBForTesting()
    await fresh(); expect(count()).toBe(0)
    await readyManager(); expect(await engine.retryPending()).toBe(0); await settle(1000)
    expect(count()).toBe(0); expect(queries).toBe(2); expect(decryptAttempts).toBe(1)
    expect(pointer()).toBe('own')
    expect(last()?.id).toBe('own')
    expect(transitions).toEqual([expect.objectContaining({ count: 0 }), expect.objectContaining({ count: 1 }), expect.objectContaining({ count: 0 })])
  })
  it('does not decrypt a processed reaction again with a ready plugin', async () => {
    decryptMode = 'verified'; await readyManager(); await reactionCatchup()
    expect(count()).toBe(0); expect(decryptAttempts).toBe(1)
    connectionStore.getState().setStatus('disconnected'); chatStore.getState().resetMAMStates()
    await fresh(); expect(count()).toBe(0); expect(decryptAttempts).toBe(1); expect(queries).toBe(2)
    expect(transitions).toEqual([expect.objectContaining({ count: 0 })])
    expect(pointer()).toBe('own')
  })

  it('recovers after the durable commit succeeds but resident application is interrupted', async () => {
    await reactionCatchup()
    decryptMode = 'verified'
    await readyManager()
    const interrupted = vi.spyOn(chatStore.getState(), 'updateReactions').mockImplementationOnce(() => {
      throw new Error('fixture interruption after durable commit')
    })
    await expect(engine.retryPending()).rejects.toThrow('fixture interruption')
    interrupted.mockRestore()
    cache._resetDBForTesting()
    manager = null
    connectionStore.getState().setStatus('disconnected')
    chatStore.getState().resetMAMStates()
    await fresh()
    expect(count()).toBe(0)
    expect(decryptAttempts).toBe(1)
    expect((await cache.getMessages(PEER)).find(message => message.id === 'own')?.reactions).toEqual({ '👍': [PEER] })
    expect((await cache.getMessages(PEER)).some(message => message.id === 'reaction')).toBe(false)
    expect(pointer()).toBe('own')
  })

  it('remembers deferred processing under the own archive id rather than a foreign stanza id', async () => {
    await reactionCatchup()
    await cache.updateMessage(PEER, 'reaction', { stanzaId: 'foreign-archive-id' }, PEER)
    decryptMode = 'verified'
    await readyManager()
    expect(await engine.retryPending()).toBe(1)
    await settle(1000)
    expect(await cache.getArchiveSignal(PEER, 's-reaction', PEER)).toBeDefined()
    expect(await cache.getArchiveSignal(PEER, 'foreign-archive-id', PEER)).toBeUndefined()
    expect((await cache.getMessages(PEER)).some(message => message.id === 'reaction')).toBe(false)
    manager = null
    connectionStore.getState().setStatus('disconnected')
    chatStore.getState().resetMAMStates()
    await fresh()
    expect(count()).toBe(0)
    expect(decryptAttempts).toBe(1)
  })

  async function expectSignalEffect(kind: 'retract' | 'correction') {
    const messages = await chatStore.getState().loadMessagesFromCache(PEER)
    expect(messages.map(message => message.id)).toEqual(['read', 'own'])
    const target = messages.find(message => message.id === 'read')!
    if (kind === 'retract') expect(target).toMatchObject({ isRetracted: true, body: '' })
    else expect(target).toMatchObject({ isEdited: true, body: 'corrected' })
    expect(await cache.getMessagesWithEncryptedPayload()).toEqual([])
    expect(await cache.getArchiveSignal(PEER, 's-reaction', PEER)).toMatchObject({
      effect: { type: kind === 'retract' ? 'retract' : 'update' },
    })
  }

  async function restartSignalSession(pluginReady: boolean) {
    connectionStore.getState().setStatus('disconnected')
    chatStore.getState().resetMAMStates()
    chatStore.setState({ messages: new Map(), windowAtLiveEdge: new Map() })
    cache._resetDBForTesting()
    manager = null
    if (pluginReady) await readyManager()
    await fresh()
  }

  it.each((['retract', 'correction'] as const).flatMap(kind => (['all', 'peer'] as const).map(mode => ({ kind, mode }))))('remembers a deferred encrypted $kind across two fresh sessions on $mode retry without another unread flash', async ({ kind, mode }) => {
    decryptedKind = kind
    await reactionCatchup()
    expect(count()).toBe(1)
    decryptMode = 'verified'
    await readyManager()
    expect(await (mode === 'all' ? engine.retryPending() : engine.retryForPeer(PEER))).toBe(mode === 'all' ? 1 : undefined)
    await settle(1000)
    expect(count()).toBe(0)
    expect(decryptAttempts).toBe(1)
    await expectSignalEffect(kind)

    await restartSignalSession(false)
    expect(count()).toBe(0)
    expect(decryptAttempts).toBe(1)
    await expectSignalEffect(kind)
    await readyManager()
    expect(await (mode === 'all' ? engine.retryPending() : engine.retryForPeer(PEER))).toBe(mode === 'all' ? 0 : undefined)
    await settle(1000)
    expect(count()).toBe(0)
    expect(decryptAttempts).toBe(1)
    expect(queries).toBe(2)
    expect(pointer()).toBe('own')
    expect(last()?.id).toBe('own')
    expect(transitions).toEqual([expect.objectContaining({ count: 0 }), expect.objectContaining({ count: 1 }), expect.objectContaining({ count: 0 })])
  })

  it.each(['retract', 'correction'] as const)('does not decrypt a processed encrypted %s again with a ready plugin', async kind => {
    decryptedKind = kind
    decryptMode = 'verified'
    await readyManager()
    await reactionCatchup()
    expect(count()).toBe(0)
    expect(decryptAttempts).toBe(1)
    await expectSignalEffect(kind)

    await restartSignalSession(true)
    expect(count()).toBe(0)
    expect(decryptAttempts).toBe(1)
    await expectSignalEffect(kind)
    expect(await engine.retryPending()).toBe(0)
    expect(queries).toBe(2)
    expect(pointer()).toBe('own')
    expect(last()?.id).toBe('own')
    expect(transitions).toEqual([expect.objectContaining({ count: 0 })])
  })

  it('does not mistake a memoized signal-only page for complete history', async () => {
    decryptMode = 'verified'
    await readyManager()
    await reactionCatchup()
    archive.push(row('incoming', 4))
    const gap = { start: BASE + 2000, startId: 's-own' }
    chatStore.setState({ conversationGaps: new Map([[PEER, [gap]]]) })
    pageSize = 1
    const partial = await mam.queryArchive({ with: PEER, after: 's-own', max: 1, maxAutoPages: 1 })
    expect(partial.messages).toEqual([])
    expect(partial.complete).toBe(false)
    expect(partial.page.last).toBe('s-reaction')
    expect(chatStore.getState().conversationGaps.get(PEER)).toEqual([gap])
    expect(decryptAttempts).toBe(1)
    const full = await mam.queryArchive({ with: PEER, after: 's-own', max: 1, maxAutoPages: 2 })
    expect(full.messages.map(message => message.id)).toEqual(['incoming'])
    expect(full.complete).toBe(true)
    expect(pointer()).toBe('own')
    expect(decryptAttempts).toBe(1)
  })

  it('does not remember an unverifiable signal as authenticated', async () => {
    await readyManager()
    await reactionCatchup()
    decryptMode = 'untrusted'
    expect(await engine.retryPending()).toBe(0)
    expect(await cache.getArchiveSignal(PEER, 's-reaction', PEER)).toBeUndefined()
    expect(count()).toBe(1)
    decryptMode = 'verified'
    expect(await engine.retryPending()).toBe(1)
    expect(await cache.getArchiveSignal(PEER, 's-reaction', PEER)).toBeDefined()
  })
})
