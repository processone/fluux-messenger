import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest'
import 'fake-indexeddb/auto'
import { IDBFactory, IDBObjectStore } from 'fake-indexeddb'
import { xml } from '@xmpp/client'
import { DeferredDecryptEngine, type DeferredDecryptCache } from './deferredDecrypt'
import { E2EEManager, InMemoryStorageBackend } from '.'
import { DummyPlaintextPlugin } from './DummyPlaintextPlugin'
import { E2EEPluginError } from './errors'
import { serialize } from './payloadEnvelope'
import { COULD_NOT_DECRYPT_BODY } from './stanzaDecrypt'
import { createDefaultStoreBindings } from '../defaultStoreBindings'
import type { Message } from '../types'
import type { StoredMessage } from '../types/message-internal'
import * as cache from '../../utils/messageCache'
import { setStorageScopeJid, _resetStorageScopeForTesting } from '../../utils/storageScope'
import { chatStore } from '../../stores/chatStore'
import { connectionStore } from '../../stores/connectionStore'
import { makeReadPointer } from '../../stores/shared/readPointer'
import { _resetForTesting } from '../../stores/shared/throttledStorage'

const OWN = 'self@example.test', PEER = 'peer@example.test'
const own: Message = { type: 'chat', id: 'own', stanzaId: 's-own', originId: undefined, conversationId: PEER, from: OWN,
  body: 'synthetic', timestamp: new Date(1000), isOutgoing: true }
const pending: Message = { ...own, id: 'signal', stanzaId: 's-signal', from: PEER, timestamp: new Date(2000),
  isOutgoing: false, body: COULD_NOT_DECRYPT_BODY,
  encryptedPayload: '<plain xmlns="urn:fluux:e2ee-dummy:0">c3ludGhldGlj</plain>' }

describe('deferred signal recovery after reconnect', () => {
  let manager: E2EEManager
  let engine: DeferredDecryptEngine
  let port: DeferredDecryptCache
  let decrypt: MockInstance<E2EEManager['decryptArchive']>
  beforeEach(async () => {
    _resetForTesting(); _resetStorageScopeForTesting()
    globalThis.indexedDB = new IDBFactory(); cache._resetDBForTesting()
    chatStore.getState().reset(); connectionStore.getState().reset()
    setStorageScopeJid(OWN); connectionStore.setState({ jid: `${OWN}/mobile`, status: 'online', windowVisible: true })
    manager = new E2EEManager({ storage: new InMemoryStorageBackend(), account: { jid: OWN }, xmpp: {
      sendStanza: async () => {}, queryDisco: async () => ({ features: [], identities: [] }),
      publishPEP: async () => {}, retractPEP: async () => {}, deletePEP: async () => {},
      queryPEP: async () => [], subscribePEP: () => ({ unsubscribe() {} }),
    } })
    await manager.register(new DummyPlaintextPlugin())
    decrypt = vi.spyOn(manager, 'decryptArchive').mockResolvedValue({
      plaintext: new TextEncoder().encode(serialize([xml('reactions', { xmlns: 'urn:xmpp:reactions:0', id: 'own' }, xml('reaction', {}, '👍'))])),
      senderDevice: { jid: PEER, deviceId: 'fixture' }, securityContext: { protocolId: 'dummy-plaintext', trust: 'verified' },
    })
    port = { getMessagesWithEncryptedPayload: cache.getMessagesWithEncryptedPayload,
      updateMessage: cache.updateMessage, deleteMessage: cache.deleteMessage, deleteMessageForRecovery: cache.deleteMessageForRecovery }
    const stores = createDefaultStoreBindings()
    engine = new DeferredDecryptEngine({ getManager: () => manager, getStores: () => stores,
      getOwnBareJid: () => connectionStore.getState().jid?.split('/')[0] ?? '', cache: port, updateSearchIndex: async () => {} })
  })
  afterEach(() => { _resetForTesting(); cache._resetDBForTesting(); vi.restoreAllMocks() })
  async function seed(resident: boolean, active = false, archived = false) {
    const signal = archived ? { ...pending, ownArchiveId: 's-signal', ownArchiveBy: OWN } : pending
    await cache.saveMessages([own, signal])
    chatStore.getState().addConversation({ id: PEER, name: 'Synthetic', type: 'chat', unreadCount: 1,
      lastMessage: own, readPointer: makeReadPointer(own, 'chat') })
    chatStore.setState({ activeConversationId: active ? PEER : null,
      messages: new Map(resident ? [[PEER, [own, signal]]] : []),
      conversationCoverage: new Map([[PEER, { bottomId: own.stanzaId!, countBottomId: own.stanzaId! }]]),
      mamQueryStates: new Map([[PEER, { isLoading: false, error: null, hasQueried: true, isHistoryComplete: true, isCaughtUpToLive: true }]]) })
  }
  const count = () => chatStore.getState().conversationMeta.get(PEER)!.unreadCount
  it.each([false, true])('peer key recovery removes an incoming reaction and its unread count, resident=%s', async resident => {
    await seed(resident)
    const pointer = chatStore.getState().conversationMeta.get(PEER)!.readPointer
    await engine.retryForPeer(PEER)
    await vi.waitFor(async () => {
      expect((await cache.getMessages(PEER)).map(m => m.id)).toEqual(['own'])
      expect((await cache.getMessages(PEER))[0].reactions).toEqual({ '👍': [PEER] })
      expect(count()).toBe(0)
    })
    expect(chatStore.getState().conversationMeta.get(PEER)!.readPointer).toBe(pointer)
  })
  it.each(['retraction', 'rejected'] as const)('peer key recovery handles a definitive %s outcome', async outcome => {
    await seed(true)
    if (outcome === 'rejected') decrypt.mockRejectedValue(new E2EEPluginError('permanent', 'signature-failed', 'synthetic rejection'))
    else decrypt.mockResolvedValue({ plaintext: new TextEncoder().encode(serialize([xml('retract', { xmlns: 'urn:xmpp:message-retract:1', id: 'own' })])),
      senderDevice: { jid: PEER, deviceId: 'fixture' }, securityContext: { protocolId: 'dummy-plaintext', trust: 'verified' } })
    await engine.retryForPeer(PEER)
    await vi.waitFor(async () => { expect((await cache.getMessages(PEER)).map(m => m.id)).toEqual(['own']); expect(count()).toBe(0) })
    expect((await cache.getMessages(PEER))[0].isRetracted).not.toBe(true)
  })
  it.each(['resident', 'cache', 'preview'].flatMap(source =>
    [true, false].map(authored => ({ source, authored })),
  ))(
    'recovers retractions from $source signals with evicted targets, authored=$authored', async ({ source, authored }) => {
      await seed(false)
      const target = { ...own, from: authored ? PEER : OWN, isOutgoing: !authored }
      await cache.saveMessage(target)
      if (source === 'resident') chatStore.setState({ messages: new Map([[PEER, [pending]]]) })
      if (source === 'preview') {
        await cache.deleteMessage(PEER, pending.id, pending.from)
        const meta = chatStore.getState().conversationMeta.get(PEER)!
        chatStore.setState({ conversationMeta: new Map([[PEER, { ...meta, lastMessage: pending }]]) })
      }
      decrypt.mockResolvedValue({
        plaintext: new TextEncoder().encode(serialize([xml('retract', { xmlns: 'urn:xmpp:message-retract:1', id: 's-own' })])),
        senderDevice: { jid: PEER, deviceId: 'fixture' },
        securityContext: { protocolId: 'dummy-plaintext', trust: 'verified' },
      })
      await engine.retryForPeer(PEER)
      await vi.waitFor(async () => {
        const messages = await cache.getMessages(PEER)
        expect(messages.map(m => m.id)).toEqual(['own'])
        expect(!!messages[0].isRetracted).toBe(authored)
      })
    },
  )
  it.each(['all', 'peer'] as const)('recounts the active conversation after durable signal removal on %s retry', async mode => {
    await seed(true, true)
    const pointer = chatStore.getState().conversationMeta.get(PEER)!.readPointer
    await (mode === 'all' ? engine.retryPending() : engine.retryForPeer(PEER))
    expect((await cache.getMessages(PEER)).map(m => m.id)).toEqual(['own']); expect(count()).toBe(0)
    expect(chatStore.getState().conversationMeta.get(PEER)!.readPointer).toBe(pointer)
  })
  it('keeps the active count while archive coverage cannot prove a recount', async () => {
    await seed(true, true); chatStore.setState({ conversationCoverage: new Map() })
    await engine.retryPending()
    expect((await cache.getMessages(PEER)).map(m => m.id)).toEqual(['own']); expect(count()).toBe(1)
  })
  it('does not clear the badge before the durable deletion completes', async () => {
    await seed(true, true)
    let release!: () => void
    const gate = new Promise<void>(r => { release = r })
    const deletion = vi.spyOn(port, 'deleteMessageForRecovery').mockImplementation(async (...args) => { await gate; return cache.deleteMessageForRecovery(...args) })
    const repair = engine.retryPending()
    await vi.waitFor(() => expect(deletion).toHaveBeenCalled()); expect(count()).toBe(1)
    release(); await repair; expect(count()).toBe(0)
  })
  it('preserves the unread count when durable deletion fails', async () => {
    await seed(true, true)
    cache._resetDBForTesting()
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const open = vi.spyOn(indexedDB, 'open').mockImplementation(() => { throw new Error('synthetic IndexedDB failure') })
    await engine.retryPending()
    expect(warning).toHaveBeenCalledWith('Failed to delete recovered placeholder:', expect.any(Error))
    expect(count()).toBe(1)
    expect(chatStore.getState().getMessage(PEER, pending)).toBeDefined()
    open.mockRestore(); cache._resetDBForTesting()
    expect((await cache.getMessages(PEER)).some(m => m.id === 'signal')).toBe(true)
  })
  it('does not repair another conversation on a peer key update', async () => {
    await seed(false); await engine.retryForPeer('other@example.test')
    expect(decrypt).not.toHaveBeenCalled(); expect(count()).toBe(1)
  })
  it('does not apply a recovery if the manager changed during decryption', async () => {
    await seed(true)
    const result = await decrypt.getMockImplementation()!({ name: 'plain', attrs: {}, children: [] }, { kind: 'direct', peer: PEER })
    decrypt.mockImplementation(async () => { manager = {} as E2EEManager; return result })
    await engine.retryForPeer(PEER)
    expect(count()).toBe(1); expect((await cache.getMessages(PEER)).some(m => m.id === 'signal')).toBe(true)
  })
  it.each([false, true])('preserves a newer correction arriving during signal decryption, resident=%s', async resident => {
    await seed(resident)
    const edited: StoredMessage = { ...pending, body: 'newer revision', encryptedPayload: undefined, isEdited: true,
      correctionRevision: { ids: ['new-correction'], supersedes: [] } }
    const result = await decrypt.getMockImplementation()!({ name: 'plain', attrs: {}, children: [] }, { kind: 'direct', peer: PEER })
    decrypt.mockImplementation(async () => {
      await cache.saveMessage(edited)
      if (resident) chatStore.setState({ messages: new Map([[PEER, [own, edited]]]) })
      return result
    })
    await engine.retryForPeer(PEER)
    expect((await cache.getMessages(PEER)).find(m => m.id === 'signal')).toMatchObject({ body: 'newer revision', encryptedPayload: undefined })
    expect((await cache.getMessages(PEER))[0].reactions).toBeUndefined()
    expect(count()).toBe(1)
  })

  const archivedRetries = (['all', 'peer'] as const).flatMap(mode => [false, true].map(resident => ({ mode, resident })))
  const retry = (mode: 'all' | 'peer') => mode === 'all' ? engine.retryPending() : engine.retryForPeer(PEER)

  it.each(archivedRetries)('rejects an archive-qualified stale revision on $mode retry, resident=$resident', async ({ mode, resident }) => {
    await seed(resident, true, true)
    const edited: StoredMessage = { ...pending, ownArchiveId: 's-signal', ownArchiveBy: OWN,
      body: 'newer revision', encryptedPayload: undefined, isEdited: true,
      correctionRevision: { ids: ['new-correction'], supersedes: [] } }
    const result = await decrypt.getMockImplementation()!({ name: 'plain', attrs: {}, children: [] }, { kind: 'direct', peer: PEER })
    decrypt.mockImplementation(async () => {
      await cache.saveMessage(edited)
      if (resident) chatStore.setState({ messages: new Map([[PEER, [own, edited]]]) })
      return result
    })
    expect(await retry(mode)).toBe(mode === 'all' ? 0 : undefined)
    cache._resetDBForTesting()
    expect(await cache.getArchiveSignal(PEER, 's-signal', PEER)).toBeUndefined()
    expect((await cache.getMessages(PEER)).find(m => m.id === 'signal')).toMatchObject({ body: 'newer revision' })
    expect((await cache.getMessages(PEER))[0].reactions).toBeUndefined()
    expect(count()).toBe(1)
  })

  it.each(archivedRetries)('does not journal a superseded promoted correction on $mode retry, resident=$resident', async ({ mode, resident }) => {
    await seed(false, true, true)
    const correction: StoredMessage = { ...pending, ownArchiveId: 's-signal', ownArchiveBy: OWN, isEdited: true,
      correctionRevision: { ids: ['stanza:s-correction'], supersedes: [], archiveTimestamp: 2000 } }
    await cache.saveMessage(correction)
    if (resident) chatStore.setState({ messages: new Map([[PEER, [own, correction]]]) })
    decrypt.mockImplementation(async () => {
      const newer: StoredMessage = { ...correction, body: 'newer edit', encryptedPayload: undefined,
        correctionRevision: { ids: ['new-correction'], supersedes: ['stanza:s-correction'] } }
      await cache.saveMessage(newer)
      if (resident) chatStore.setState({ messages: new Map([[PEER, [own, newer]]]) })
      return { plaintext: new TextEncoder().encode(serialize([
        xml('replace', { xmlns: 'urn:xmpp:message-correct:0', id: 'signal' }), xml('body', {}, 'superseded edit'),
      ])), senderDevice: { jid: PEER, deviceId: 'fixture' },
      securityContext: { protocolId: 'dummy-plaintext', trust: 'verified' } }
    })
    expect(await retry(mode)).toBe(mode === 'all' ? 0 : undefined)
    cache._resetDBForTesting()
    expect(await cache.getArchiveSignal(PEER, 's-correction', PEER)).toBeUndefined()
    expect((await cache.getMessages(PEER)).find(m => m.id === 'signal')).toMatchObject({ body: 'newer edit', encryptedPayload: undefined })
    expect(count()).toBe(1)
  })

  it.each(archivedRetries)('rolls back an archive signal when recording completion fails on $mode retry, resident=$resident', async ({ mode, resident }) => {
    await seed(resident, true, true)
    const pointer = chatStore.getState().conversationMeta.get(PEER)!.readPointer
    const put = IDBObjectStore.prototype.put
    const fault = vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(function (this: IDBObjectStore, value, key) {
      if (this.name === 'archive-signals' && value.applied === 1) throw new Error('synthetic failure after target write')
      return put.call(this, value, key)
    })
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(await retry(mode)).toBe(mode === 'all' ? 0 : undefined)
    fault.mockRestore()
    cache._resetDBForTesting()
    expect(await cache.getArchiveSignal(PEER, 's-signal', PEER)).toBeUndefined()
    const messages = await cache.getMessages(PEER)
    expect(messages.find(m => m.id === 'signal')?.encryptedPayload).toBeTruthy()
    expect(messages.find(m => m.id === 'own')?.reactions).toBeUndefined()
    if (resident) expect(chatStore.getState().getMessage(PEER, pending)?.encryptedPayload).toBeTruthy()
    expect(count()).toBe(1)
    expect(chatStore.getState().conversationMeta.get(PEER)!.readPointer).toBe(pointer)
    warning.mockRestore()
    expect(await retry(mode)).toBe(mode === 'all' ? 1 : undefined)
    expect(count()).toBe(0)
    expect(await cache.getArchiveSignal(PEER, 's-signal', PEER)).toBeDefined()
    expect((await cache.getMessages(PEER))[0].reactions).toEqual({ '👍': [PEER] })
  })

  it.each(['all', 'peer'] as const)('preserves a qualified archive signal when IndexedDB cannot open on %s retry', async mode => {
    await seed(true, true, true)
    cache._resetDBForTesting()
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const open = vi.spyOn(indexedDB, 'open').mockImplementation(() => { throw new Error('synthetic IndexedDB failure') })
    expect(await retry(mode)).toBe(mode === 'all' ? 0 : undefined)
    expect(count()).toBe(1)
    expect(chatStore.getState().getMessage(PEER, pending)?.encryptedPayload).toBeTruthy()
    open.mockRestore(); cache._resetDBForTesting()
    expect(await cache.getArchiveSignal(PEER, 's-signal', PEER)).toBeUndefined()
    expect((await cache.getMessages(PEER)).find(m => m.id === 'own')?.reactions).toBeUndefined()
    expect((await cache.getMessages(PEER)).some(m => m.id === 'signal')).toBe(true)
    warning.mockRestore()
  })

})
