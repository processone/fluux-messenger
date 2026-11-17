import 'fake-indexeddb/auto'
import { IDBFactory } from 'fake-indexeddb'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { xml } from '@xmpp/client'
import { E2EEManager, InMemoryStorageBackend, type XMPPPrimitives } from '.'
import { DummyPlaintextPlugin } from './DummyPlaintextPlugin'
import { E2EEPluginError } from './errors'
import { decryptStanzaInPlace, readStashedContentAvailability } from './stanzaDecrypt'
import { DeferredDecryptEngine } from './deferredDecrypt'
import { isMessageDecrypting, subscribeDecryptionActivity } from './decryptionActivity'
import { createDefaultStoreBindings } from '../defaultStoreBindings'
import { chatStore } from '../../stores/chatStore'
import * as cache from '../../utils/messageCache'
import { setStorageScopeJid } from '../../utils/storageScope'
import type { Message, RoomMessage, StoreBindings } from '../types'
import type { StoredMessage } from '../types/message-internal'
import { createMockStores } from '../test-utils'
import { serialize as serializePayloadEnvelope } from './payloadEnvelope'

// Conversation preview status: exercise the existing dummy protocol through the
// real claim/decrypt/recovery boundary, holding only its asynchronous completion.
const PEER = 'bob@example.com'
const SELF = 'me@example.com'
const payload = '<plain xmlns="urn:fluux:e2ee-dummy:0">aGVsbG8=</plain>'
const primitives: XMPPPrimitives = {
  sendStanza: async () => {}, queryDisco: async () => ({ features: [], identities: [] }),
  publishPEP: async () => {}, retractPEP: async () => {}, deletePEP: async () => {},
  queryPEP: async () => [], subscribePEP: () => ({ unsubscribe: () => {} }),
}
function pending(): Message {
  return { type: 'chat', id: 'encrypted-preview', stanzaId: undefined, originId: undefined,
    conversationId: PEER, from: PEER, body: '[dummy-plaintext payload]',
    timestamp: new Date('2026-01-01T12:00:00Z'), isOutgoing: false, encryptedPayload: payload }
}

describe('state-aware preview availability', () => {
  let manager: E2EEManager
  let plugin: DummyPlaintextPlugin
  let verifiedDecrypt: DummyPlaintextPlugin['decrypt']
  let engine: DeferredDecryptEngine
  const preview = () => chatStore.getState().conversations.get(PEER)!.lastMessage!
  beforeEach(async () => {
    globalThis.indexedDB = new IDBFactory()
    cache._resetDBForTesting()
    setStorageScopeJid(SELF)
    chatStore.getState().reset()
    manager = new E2EEManager({ storage: new InMemoryStorageBackend(), xmpp: primitives, account: { jid: SELF } })
    plugin = new DummyPlaintextPlugin()
    await manager.register(plugin)
    const decrypt = plugin.decrypt.bind(plugin)
    verifiedDecrypt = async (...args) => {
      const result = await decrypt(...args)
      return { ...result, securityContext: { ...result.securityContext, trust: 'verified' } }
    }
    vi.spyOn(plugin, 'decrypt').mockImplementation(verifiedDecrypt)
    const stores = createDefaultStoreBindings()
    engine = new DeferredDecryptEngine({ getManager: () => manager, getStores: () => stores,
      getOwnBareJid: () => SELF, cache, updateSearchIndex: async () => {} })
    chatStore.getState().addConversation({ id: PEER, type: 'chat', name: 'Bob', unreadCount: 2, lastMessage: pending() })
  })
  afterEach(() => {
    vi.useRealTimers()
    chatStore.getState().reset()
    cache._resetDBForTesting()
    setStorageScopeJid(null)
  })

  it.each(['preview-only', 'resident', 'cached'] as const)('tracks only active work and recovers a %s preview without a new arrival', async (location) => {
    const message = pending()
    if (location === 'resident') chatStore.setState({ messages: new Map([[PEER, [message]]]) })
    if (location === 'cached') await cache.saveMessages([message])
    const original = verifiedDecrypt
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    let started!: () => void
    const ready = new Promise<void>(resolve => { started = resolve })
    vi.spyOn(plugin, 'decrypt').mockImplementation(async (...args) => { started(); await gate; return original(...args) })
    const observed: boolean[] = []
    const unsubscribe = subscribeDecryptionActivity(() => { observed.push(isMessageDecrypting(PEER, preview())) })
    expect(isMessageDecrypting(PEER, preview())).toBe(false)
    const run = engine.retryPending()
    await ready
    expect(isMessageDecrypting(PEER, preview())).toBe(true)
    expect(preview().body).toBe(message.body)
    release()
    await run
    unsubscribe()
    expect(observed).toEqual([true, false])
    expect(preview()).toMatchObject({ id: message.id, timestamp: message.timestamp, body: 'hello', contentAvailability: { state: 'ready' }, encryptedPayload: undefined })
    expect(chatStore.getState().conversations.get(PEER)?.unreadCount).toBe(2)
    expect(isMessageDecrypting(PEER, preview())).toBe(false)
    if (location === 'cached') expect(await cache.getMessage(PEER, message.id, message)).toMatchObject({ body: 'hello', contentAvailability: { state: 'ready' } })
  })

  it('persists settled failure availability with ciphertext and restores it after reopening the cache', async () => {
    const message = pending()
    await cache.saveMessages([message])
    vi.spyOn(plugin, 'decrypt').mockRejectedValue(new E2EEPluginError('permanent', 'no-session-key', 'not encrypted to this key'))
    await engine.retryPending()
    cache._resetDBForTesting()
    const restored = await cache.getMessage(PEER, message.id, message)
    expect(restored).toMatchObject({ encryptedPayload: payload, contentAvailability: { state: 'failed', reason: 'key-unavailable' } })
    expect(restored?.contentAvailability).toEqual(preview().contentAvailability)
    expect(restored && isMessageDecrypting(PEER, restored)).toBe(false)
  })

  it('does not replace a newer last message when an older attempt completes', async () => {
    let release!: () => void
    const original = verifiedDecrypt
    const gate = new Promise<void>(resolve => { release = resolve })
    let started!: () => void
    const ready = new Promise<void>(resolve => { started = resolve })
    vi.spyOn(plugin, 'decrypt').mockImplementation(async (...args) => { started(); await gate; return original(...args) })
    const run = engine.retryPending()
    await ready
    const newer = { ...pending(), id: 'newer', body: 'Newer content', timestamp: new Date('2026-01-01T12:01:00Z'), encryptedPayload: undefined }
    chatStore.getState().updateLastMessagePreview(PEER, newer)
    expect(isMessageDecrypting(PEER, preview())).toBe(false)
    release()
    await run
    expect(preview()).toEqual(newer)
  })

  it('ends activity on timeout and leaves ciphertext waiting, not failed', async () => {
    const stores = createDefaultStoreBindings()
    chatStore.setState({ messages: new Map([[PEER, [pending()]]]) })
    engine = new DeferredDecryptEngine({ getManager: () => manager, getStores: () => stores,
      getOwnBareJid: () => SELF, cache: { ...cache, getMessagesWithEncryptedPayload: async () => [] }, updateSearchIndex: async () => {} })
    vi.useFakeTimers()
    let started!: () => void
    const ready = new Promise<void>(resolve => { started = resolve })
    vi.spyOn(plugin, 'decrypt').mockImplementation(() => { started(); return new Promise(() => {}) })
    const run = engine.retryPending()
    await ready
    expect(isMessageDecrypting(PEER, preview())).toBe(true)
    await vi.advanceTimersByTimeAsync(60_000)
    await run
    expect(isMessageDecrypting(PEER, preview())).toBe(false)
    expect(preview().encryptedPayload).toBe(payload)
    expect(preview().contentAvailability?.state).not.toBe('failed')
  })

  it.each([
    ['key-locked', 'transient', 'waiting', 'key-unavailable'],
    ['signature-not-yet-valid', 'transient', 'waiting', 'unreadable'],
    ['unknown', 'transient', 'failed', 'unreadable'],
    ['no-session-key', 'permanent', 'failed', 'key-unavailable'],
    ['malformed-data', 'permanent', 'failed', 'unreadable'],
    ['signature-failed', 'permanent', 'failed', 'signature-invalid'],
  ] as const)('records %s separately from progress through receive and retry', async (code, kind, state, reason) => {
    vi.spyOn(plugin, 'decrypt').mockRejectedValue(new E2EEPluginError(kind, code, code))
    const stanza = xml('message', { from: PEER }, xml('body', {}, 'Untrusted sender fallback'), xml('plain', { xmlns: 'urn:fluux:e2ee-dummy:0' }, 'aGVsbG8='))
    const received = await decryptStanzaInPlace(stanza, manager, PEER)
    expect(received.contentAvailability?.state).toBe(state)
    expect(readStashedContentAvailability(stanza)?.state).toBe(state)
    expect(received.securityContext?.failureReason).toBe(reason)
    await engine.retryPending()
    expect(preview().contentAvailability?.state).toBe(state)
    if (state === 'failed') expect(preview().contentAvailability).toMatchObject({ reason })
    expect(isMessageDecrypting(PEER, preview())).toBe(false)
    if (code === 'malformed-data' || code === 'signature-failed') expect(preview().encryptedPayload).toBeUndefined()
  })

  // Review fixes: terminal corrections settle once, infrastructure errors are
  // not decrypt failures, and unchanged availability never causes a write.
  it.each(['malformed-data', 'broken-session'] as const)('retires a terminal %s correction after applying it once', async failure => {
    chatStore.getState().refreshLastMessageContent(PEER, pending(), { encryptedPayload: undefined })
    const message: StoredMessage = { ...pending(), id: 'terminal-correction', isEdited: true,
      correctionRevision: { ids: ['id:terminal-correction'], supersedes: [] } }
    if (failure === 'malformed-data') {
      vi.spyOn(plugin, 'decrypt').mockRejectedValue(new E2EEPluginError('permanent', failure, 'Malformed dummy payload'))
    } else {
      vi.spyOn(plugin, 'decrypt').mockResolvedValue({ status: 'broken-session',
        senderDevice: { jid: PEER, deviceId: 'dummy' }, securityContext: { protocolId: plugin.descriptor.id, trust: 'untrusted' } })
    }
    const repair = vi.spyOn(manager, 'repairSession').mockResolvedValue(true)
    const apply = vi.fn()
    const retry = vi.spyOn(engine, 'retryPending')
    engine.recoverCorrection(message, () => true, apply)
    await retry.mock.results[0].value
    await engine.retryPending()
    expect(apply).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ encryptedPayload: undefined,
      contentAvailability: { state: 'failed', reason: 'unreadable' } }))
    expect(plugin.decrypt).toHaveBeenCalledTimes(1)
    expect(repair).toHaveBeenCalledTimes(failure === 'broken-session' ? 1 : 0)
  })

  it('keeps malformed stored XML pending instead of inventing a decrypt failure', async () => {
    chatStore.getState().refreshLastMessageContent(PEER, pending(), { encryptedPayload: '<plain' })
    const before = preview()
    await engine.retryPending()
    expect(plugin.decrypt).not.toHaveBeenCalled()
    expect(preview()).toBe(before)
  })

  it('leaves a correction pending when durable signal storage fails after successful decryption', async () => {
    const envelope = serializePayloadEnvelope([xml('body', {}, 'hello'), xml('replace', { xmlns: 'urn:xmpp:message-correct:0', id: 'original' })])
    const message: StoredMessage = { ...pending(), isEdited: true,
      correctionRevision: { ids: ['stanza:correction-archive'], supersedes: [] },
      encryptedPayload: xml('message', { from: PEER, id: 'correction' },
        xml('plain', { xmlns: 'urn:fluux:e2ee-dummy:0' }, Buffer.from(envelope).toString('base64'))).toString() }
    chatStore.getState().reset()
    chatStore.getState().addConversation({ id: PEER, name: 'Bob', type: 'chat', unreadCount: 2, lastMessage: message })
    const stores = createDefaultStoreBindings()
    const remember = vi.spyOn(stores.chat, 'rememberArchiveSignalForRecovery').mockRejectedValue(new Error('IndexedDB unavailable'))
    engine = new DeferredDecryptEngine({ getManager: () => manager, getStores: () => stores,
      getOwnBareJid: () => SELF, cache, updateSearchIndex: async () => {} })
    const before = preview()
    await engine.retryPending()
    expect(plugin.decrypt).toHaveBeenCalledTimes(1)
    expect(remember).toHaveBeenCalledTimes(1)
    expect(preview()).toBe(before)
    expect(isMessageDecrypting(PEER, preview())).toBe(false)
  })

  describe.each(['waiting', 'failed'] as const)('unchanged %s availability', state => {
    it.each(['correction', 'resident', 'room', 'cached', 'preview-only'] as const)('does not write a retained %s message again', async location => {
      const message: Message = { ...pending(), contentAvailability: state === 'waiting'
        ? { state: 'waiting' } : { state: 'failed', reason: 'key-unavailable' } }
      vi.spyOn(plugin, 'decrypt').mockRejectedValue(state === 'waiting'
        ? new E2EEPluginError('transient', 'key-locked', 'Key locked')
        : new E2EEPluginError('permanent', 'no-session-key', 'Not encrypted to this key'))
      const stores = createMockStores()
      const cached = { ...message, cacheKey: cache.chatCacheKey(message) }
      const port = { getMessagesWithEncryptedPayload: vi.fn().mockResolvedValue(location === 'cached' ? [cached] : []),
        updateMessage: vi.fn().mockResolvedValue(undefined), deleteMessage: vi.fn().mockResolvedValue(undefined) }
      engine = new DeferredDecryptEngine({ getManager: () => manager, getStores: () => stores as unknown as StoreBindings,
        getOwnBareJid: () => SELF, cache: port, updateSearchIndex: async () => {} })
      if (location === 'resident') stores.chat.getAllStoredMessages.mockReturnValue([{ id: PEER, messages: [message] }])
      if (location === 'room') {
        const roomMessage: RoomMessage = { ...message, type: 'groupchat', roomJid: 'room@example.com', from: 'room@example.com/Bob', nick: 'Bob', occupantId: undefined }
        stores.room.getAllRoomMessages.mockReturnValue([{ jid: roomMessage.roomJid, messages: [roomMessage] }])
      }
      if (location === 'preview-only') stores.chat.getEncryptedPreviews.mockReturnValue([{ conversationId: PEER, lastMessage: message }])
      const apply = vi.fn()
      if (location === 'correction') {
        const retry = vi.spyOn(engine, 'retryPending')
        engine.recoverCorrection({ ...message, isEdited: true }, () => true, apply)
        await retry.mock.results[0].value
      } else await engine.retryPending()
      await engine.retryPending()
      expect(plugin.decrypt).toHaveBeenCalledTimes(2)
      expect(apply).not.toHaveBeenCalled()
      expect(stores.chat.updateMessage).not.toHaveBeenCalled()
      expect(stores.room.updateMessage).not.toHaveBeenCalled()
      expect(port.updateMessage).not.toHaveBeenCalled()
      expect(stores.chat.refreshLastMessageContent).not.toHaveBeenCalled()
    })
  })

  it('updates changed failure reasons once and keeps a waiting correction snapshot current', async () => {
    const stores = createMockStores()
    const port = { getMessagesWithEncryptedPayload: async () => [], updateMessage: vi.fn(), deleteMessage: vi.fn() }
    engine = new DeferredDecryptEngine({ getManager: () => manager, getStores: () => stores as unknown as StoreBindings,
      getOwnBareJid: () => SELF, cache: port, updateSearchIndex: async () => {} })
    const apply = vi.fn()
    vi.spyOn(plugin, 'decrypt').mockRejectedValue(new E2EEPluginError('transient', 'key-locked', 'Key locked'))
    const retry = vi.spyOn(engine, 'retryPending')
    engine.recoverCorrection({ ...pending(), isEdited: true }, () => true, apply)
    await retry.mock.results[0].value
    await engine.retryPending()
    expect(apply).toHaveBeenCalledTimes(1)
    vi.spyOn(plugin, 'decrypt').mockRejectedValue(new E2EEPluginError('permanent', 'no-session-key', 'Not encrypted to this key'))
    await engine.retryPending()
    await engine.retryPending()
    expect(apply).toHaveBeenCalledTimes(2)
    expect(apply).toHaveBeenLastCalledWith(expect.objectContaining({ contentAvailability: { state: 'failed', reason: 'key-unavailable' } }))
    vi.spyOn(plugin, 'decrypt').mockRejectedValue(new Error('Unreadable payload'))
    await engine.retryPending()
    await engine.retryPending()
    expect(apply).toHaveBeenCalledTimes(3)
    expect(apply).toHaveBeenLastCalledWith(expect.objectContaining({ contentAvailability: { state: 'failed', reason: 'unreadable' } }))
  })

  it('keeps decrypted-but-unverified content separate from decryption failure', async () => {
    vi.spyOn(plugin, 'decrypt').mockRestore()
    await engine.retryPending()
    expect(preview()).toMatchObject({ body: 'hello', contentAvailability: { state: 'verification' }, encryptedPayload: payload, securityContext: { trust: 'untrusted' } })
    await engine.retryPending()
    expect(preview().contentAvailability?.state).toBe('verification')
  })

  it('isolates active work from account changes', async () => {
    let release!: () => void
    const original = verifiedDecrypt
    const gate = new Promise<void>(resolve => { release = resolve })
    let started!: () => void
    const ready = new Promise<void>(resolve => { started = resolve })
    vi.spyOn(plugin, 'decrypt').mockImplementation(async (...args) => { started(); await gate; return original(...args) })
    const run = engine.retryPending()
    await ready
    expect(isMessageDecrypting(PEER, preview())).toBe(true)
    setStorageScopeJid('other@example.com')
    expect(isMessageDecrypting(PEER, preview())).toBe(false)
    release()
    await run
    expect(preview().body).toBe(pending().body)
  })
})
