import type { StoredRoomMessage } from '../types/message-internal'
/**
 * DeferredDecryptEngine unit tests.
 *
 * The engine repairs messages that were stored with an `encryptedPayload`
 * because decryption failed at receive time (no plugin, key locked). It reads
 * and writes conversation state EXCLUSIVELY through the injected StoreBindings —
 * never the global Zustand stores. That is the property these tests pin: driven
 * by mock bindings (which the global stores know nothing about), a pending
 * payload is decrypted and written back through those same bindings. A version
 * that reached into the module-global chatStore/roomStore would find nothing to
 * decrypt here and fail.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { xml } from '@xmpp/client'
import 'fake-indexeddb/auto'
import { IDBFactory } from 'fake-indexeddb'
import { DeferredDecryptEngine, type DeferredDecryptCache } from './deferredDecrypt'
import {
  E2EEManager,
  InMemoryStorageBackend,
  type XMPPPrimitives,
} from '.'
import { DummyPlaintextPlugin } from './DummyPlaintextPlugin'
import { E2EEPluginError } from './errors'
import { serialize as serializePayloadEnvelope } from './payloadEnvelope'
import { COULD_NOT_DECRYPT_BODY, MESSAGE_REJECTED_BODY } from './stanzaDecrypt'
import { createMockStores, type MockStoreBindings } from '../test-utils'
import type { StoreBindings, MessageSecurityContext } from '../types'
import type { Message } from '../types/chat'
import * as messageCache from '../../utils/messageCache'
import * as searchIndex from '../../utils/searchIndex'
import { _resetStorageScopeForTesting, setStorageScopeJid } from '../../utils/storageScope'
import { chatStore } from '../../stores/chatStore'
import { forwardedCopyQuoteRange } from '../../utils/forwardedCopyQuote'
import { _resetForTesting } from '../../stores/shared/throttledStorage'
import { _clearAllTransientForTesting } from '../../stores/shared/transientUnread'

function stubXmppPrimitives(): XMPPPrimitives {
  return {
    sendStanza: async () => {},
    queryDisco: async () => ({ features: [], identities: [] }),
    publishPEP: async () => {},
    retractPEP: async () => {},
    deletePEP: async () => {},
    queryPEP: async () => [],
    subscribePEP: () => ({ unsubscribe: () => {} }),
  }
}

async function makeManagerWithDummyPlugin(selfJid: string): Promise<E2EEManager> {
  const manager = new E2EEManager({
    storage: new InMemoryStorageBackend(),
    xmpp: stubXmppPrimitives(),
    account: { jid: selfJid },
  })
  await manager.register(new DummyPlaintextPlugin())
  return manager
}

// base64("hello") wrapped in the DummyPlaintextPlugin's element.
const DUMMY_PAYLOAD_XML = `<plain xmlns="urn:fluux:e2ee-dummy:0">aGVsbG8=</plain>`

const makeCache = () => ({
  getMessagesWithEncryptedPayload: vi.fn().mockResolvedValue([]),
  updateMessage: vi.fn().mockResolvedValue(undefined),
  deleteMessage: vi.fn().mockResolvedValue(undefined),
})

describe('DeferredDecryptEngine', () => {
  let manager: E2EEManager
  let stores: MockStoreBindings
  // The PORT, not the mock factory's shape: tests bind either the vi.fn stubs or the
  // real messageCache functions here, and only the port covers both.
  let cache: DeferredDecryptCache
  let engine: DeferredDecryptEngine

  beforeEach(async () => {
    globalThis.indexedDB = new IDBFactory()
    _resetStorageScopeForTesting()
    messageCache._resetDBForTesting()
    searchIndex._resetDBForTesting()
    setStorageScopeJid('deferred-decrypt@example.com')
    manager = await makeManagerWithDummyPlugin('me@example.com')
    stores = createMockStores()
    cache = makeCache()
    engine = new DeferredDecryptEngine({
      updateSearchIndex: vi.fn().mockResolvedValue(undefined),
      getManager: () => manager,
      getStores: () => stores as unknown as StoreBindings,
      getOwnBareJid: () => 'me@example.com',
      cache,
    })
  })

  // Approved room-link sharing: after a key becomes available, the reader must
  // retain the protected resource reference, not only the recovered body.
  it('retains a data reference recovered from a pending encrypted envelope', async () => {
    const uri = 'xmpp:team@conference.example.org?join;msg=1731490000123456'
    const envelope = serializePayloadEnvelope([
      xml('body', {}, 'See the room update'),
      xml('reference', { xmlns: 'urn:xmpp:reference:0', type: 'data', uri }),
    ])
    const pending: Message = {
      type: 'chat', id: 'shared-room-link', stanzaId: undefined, originId: undefined,
      conversationId: 'bob@example.com', from: 'bob@example.com',
      body: '[dummy-plaintext payload]', timestamp: new Date(), isOutgoing: false,
      encryptedPayload: xml('plain', { xmlns: 'urn:fluux:e2ee-dummy:0' }, Buffer.from(envelope).toString('base64')).toString(),
    }
    stores.chat.getAllStoredMessages.mockReturnValue([{ id: 'bob@example.com', messages: [pending] }])
    await engine.retryPending()
    expect(stores.chat.updateMessage).toHaveBeenCalledWith('bob@example.com', pending,
      expect.objectContaining({ body: 'See the room update', references: [{ type: 'data', uri }] }))
  })

  // Review: a copy received before the key was available is recovered with the body, even without an outer body.
  it.each([['with a body', true], ['without an outer body', false]])('recovers a forwarded copy %s from a pending encrypted envelope', async (_name, withBody) => {
    const copy = xml('forwarded', { xmlns: 'urn:xmpp:forward:0' }, xml('message', { from: 'team@conference.example.org/Bob' }, xml('body', {}, 'Ship it')))
    const envelope = serializePayloadEnvelope([...(withBody ? [xml('body', {}, 'Look')] : []), copy])
    const pending: Message = {
      type: 'chat', id: 'fwd-pending', stanzaId: undefined, originId: undefined,
      conversationId: 'bob@example.com', from: 'bob@example.com',
      body: '[dummy-plaintext payload]', timestamp: new Date(), isOutgoing: false,
      encryptedPayload: xml('plain', { xmlns: 'urn:fluux:e2ee-dummy:0' }, Buffer.from(envelope).toString('base64')).toString(),
    }
    stores.chat.getAllStoredMessages.mockReturnValue([{ id: 'bob@example.com', messages: [pending] }])
    await engine.retryPending()
    expect(stores.chat.updateMessage).toHaveBeenCalledWith('bob@example.com', pending,
      expect.objectContaining({ body: withBody ? 'Look' : '', forwarded: expect.objectContaining({ author: 'Bob', text: 'Ship it' }) }))
  })

  // Review: a failed signature check must not leave a previously unverified (or outer) copy on display.
  it('clears a retained forwarded copy when the deferred signature check fails', async () => {
    const pending: Message = {
      type: 'chat', id: 'fwd-rejected', stanzaId: undefined, originId: undefined,
      conversationId: 'bob@example.com', from: 'bob@example.com',
      body: 'Look', timestamp: new Date(), isOutgoing: false,
      forwarded: { author: 'Mallory', text: 'Forged' },
      encryptedPayload: DUMMY_PAYLOAD_XML,
    }
    vi.spyOn(manager, 'decryptArchive').mockRejectedValue(new E2EEPluginError('permanent', 'signature-failed', 'bad signature'))
    stores.chat.getAllStoredMessages.mockReturnValue([{ id: 'bob@example.com', messages: [pending] }])
    await engine.retryPending()
    const updates = stores.chat.updateMessage.mock.calls[0][2]
    expect(updates).toEqual(expect.objectContaining({ body: MESSAGE_REJECTED_BODY, encryptedPayload: undefined }))
    expect(updates).toHaveProperty('forwarded', undefined)
  })

  // Review: a comment-only correction carries no copy, so recovering it keeps the original's copy.
  it.each([['comment-only', false], ['with its own copy', true]])('recovers a %s edit of a forwarded message', async (_name, withCopy) => {
    const copy = xml('forwarded', { xmlns: 'urn:xmpp:forward:0' }, xml('message', { from: 'bob@example.com' }, xml('body', {}, 'New copy')))
    const envelope = serializePayloadEnvelope([xml('body', {}, 'Edited comment'), ...(withCopy ? [copy] : [])])
    const pending: Message = {
      type: 'chat', id: 'fwd-edit', stanzaId: undefined, originId: undefined,
      conversationId: 'bob@example.com', from: 'bob@example.com',
      body: 'Old comment', timestamp: new Date(), isOutgoing: false, isEdited: true,
      forwarded: { author: 'Bob', text: 'Original copy' },
      encryptedPayload: xml('plain', { xmlns: 'urn:fluux:e2ee-dummy:0' }, Buffer.from(envelope).toString('base64')).toString(),
    }
    stores.chat.getAllStoredMessages.mockReturnValue([{ id: 'bob@example.com', messages: [pending] }])
    await engine.retryPending()
    const updates = stores.chat.updateMessage.mock.calls[0][2]
    expect(updates.body).toBe('Edited comment')
    if (withCopy) expect(updates.forwarded).toMatchObject({ text: 'New copy' })
    else expect(updates).not.toHaveProperty('forwarded')
  })

  // Rework: the marker travels in the payload, and a recovered edit never keeps a marker for text it replaced.
  it('recovers a marked forward from a pending envelope with the marker bound to the recovered body', async () => {
    const quote = '> Bob wrote:\n> Ship it\n'
    const body = `Look\n${quote}xmpp:team@conference.example.org?join;msg=1`
    const copy = xml('forwarded', { xmlns: 'urn:xmpp:forward:0' }, xml('message', { from: 'team@conference.example.org/Bob' }, xml('body', {}, 'Ship it')))
    const marker = xml('fallback', { xmlns: 'urn:xmpp:fallback:0', for: 'urn:xmpp:forward:0' },
      xml('body', { start: '5', end: String(Array.from(body).length) }))
    const envelope = serializePayloadEnvelope([xml('body', {}, body), copy, marker])
    const pending: Message = {
      type: 'chat', id: 'fwd-marked', stanzaId: undefined, originId: undefined, conversationId: 'bob@example.com', from: 'bob@example.com',
      body: '[dummy-plaintext payload]', timestamp: new Date(), isOutgoing: false,
      encryptedPayload: xml('plain', { xmlns: 'urn:fluux:e2ee-dummy:0' }, Buffer.from(envelope).toString('base64')).toString(),
    }
    stores.chat.getAllStoredMessages.mockReturnValue([{ id: 'bob@example.com', messages: [pending] }])
    await engine.retryPending()
    const updates = stores.chat.updateMessage.mock.calls[0][2]
    expect(forwardedCopyQuoteRange({ body: updates.body ?? '', forwarded: updates.forwarded })).toEqual({ begin: 5, end: body.length })
    expect(updates.body?.slice(5)).toContain('> Bob wrote:')
  })

  it('recovers a comment-only edit of a marked forward without hiding any of the new comment', async () => {
    const quote = '> Bob wrote:\n> Ship it\nxmpp:r@c?join;msg=1'
    const envelope = serializePayloadEnvelope([xml('body', {}, 'A much longer edited comment')])
    const pending: Message = {
      type: 'chat', id: 'fwd-marked-edit', stanzaId: undefined, originId: undefined, conversationId: 'bob@example.com', from: 'bob@example.com',
      body: 'Old comment', timestamp: new Date(), isOutgoing: false, isEdited: true,
      forwarded: { author: 'Bob', text: 'Ship it', fallback: { begin: 12, end: 12 + quote.length, text: quote } },
      encryptedPayload: xml('plain', { xmlns: 'urn:fluux:e2ee-dummy:0' }, Buffer.from(envelope).toString('base64')).toString(),
    }
    stores.chat.getAllStoredMessages.mockReturnValue([{ id: 'bob@example.com', messages: [pending] }])
    await engine.retryPending()
    const updates = stores.chat.updateMessage.mock.calls[0][2]
    expect(updates.body).toBe('A much longer edited comment')
    expect(updates).not.toHaveProperty('forwarded')
    expect(forwardedCopyQuoteRange({ body: updates.body ?? '', forwarded: pending.forwarded })).toBeUndefined()
  })

  it('decrypts a pending chat payload and writes back through the injected bindings', async () => {
    // Verified so the outcome is committed (untrusted defers verification).
    vi.spyOn(manager, 'decryptArchive').mockResolvedValue({
      plaintext: new TextEncoder().encode('hello'),
      senderDevice: { jid: 'me@example.com', deviceId: 'test' },
      securityContext: { protocolId: 'dummy-plaintext', trust: 'verified' },
    })

    const pending: Message = {
      type: 'chat',
      id: 'msg-1',
      stanzaId: undefined, originId: undefined,
      conversationId: 'bob@example.com',
      from: 'me@example.com',
      body: '[dummy-plaintext payload]',
      timestamp: new Date(),
      isOutgoing: true,
      encryptedPayload: DUMMY_PAYLOAD_XML,
    }
    // The engine must read the pending set from the injected bindings, not any
    // global store — this conversation exists ONLY in the mock.
    stores.chat.getAllStoredMessages.mockReturnValue([
      { id: 'bob@example.com', messages: [pending] },
    ])

    const count = await engine.retryPending()

    expect(count).toBe(1)
    expect(stores.chat.updateMessage).toHaveBeenCalledTimes(1)
    const [conversationId, messageId, updates] = stores.chat.updateMessage.mock.calls[0]
    expect(conversationId).toBe('bob@example.com')
    expect(messageId).toBe(pending)
    expect(updates).toMatchObject({ body: 'hello', encryptedPayload: undefined })
  })

  it('retains the held identity when decrypting a chat twin', async () => {
    vi.spyOn(manager, 'decryptArchive').mockResolvedValue({
      plaintext: new TextEncoder().encode('hello'),
      senderDevice: { jid: 'bob@example.com', deviceId: 'test' },
      securityContext: { protocolId: 'dummy-plaintext', trust: 'verified' },
    })
    const twin = (stanzaId: string, extra: Partial<Message> = {}): Message => ({
      type: 'chat', id: 'reused', stanzaId, originId: undefined, conversationId: 'bob@example.com',
      from: 'bob@example.com', body: 'plain', timestamp: new Date(), isOutgoing: false, ...extra,
    })
    const pending = twin('archive-two', { body: '[dummy-plaintext payload]', encryptedPayload: DUMMY_PAYLOAD_XML })
    stores.chat.getAllStoredMessages.mockReturnValue([{ id: 'bob@example.com', messages: [twin('archive-one'), pending] }])
    stores.chat.getConversationMessages.mockReturnValue([twin('archive-one'), pending])

    await engine.retryPending()
    await engine.retryForPeer('bob@example.com')

    expect(stores.chat.updateMessage.mock.calls.map(([, messageId]) => messageId)).toEqual([pending, pending])
  })

  it('scans peer messages through the injected bindings on a peer-key change', async () => {
    vi.spyOn(manager, 'decryptArchive').mockResolvedValue({
      plaintext: new TextEncoder().encode('hello'),
      senderDevice: { jid: 'bob@example.com', deviceId: 'test' },
      securityContext: { protocolId: 'dummy-plaintext', trust: 'verified' },
    })

    const pending: Message = {
      type: 'chat',
      id: 'msg-peer',
      stanzaId: undefined, originId: undefined,
      conversationId: 'bob@example.com',
      from: 'bob@example.com',
      body: '[dummy-plaintext payload]',
      timestamp: new Date(),
      isOutgoing: false,
      encryptedPayload: DUMMY_PAYLOAD_XML,
    }
    stores.chat.getConversationMessages.mockReturnValue([pending])

    await engine.retryForPeer('bob@example.com')

    expect(stores.chat.getConversationMessages).toHaveBeenCalledWith('bob@example.com')
    expect(stores.chat.updateMessage).toHaveBeenCalledTimes(1)
    const [, messageId, updates] = stores.chat.updateMessage.mock.calls[0]
    expect(messageId).toBe(pending)
    expect(updates).toMatchObject({ body: 'hello', encryptedPayload: undefined })
  })

  it('heals an orphaned encrypted sidebar preview from its own stashed payload', async () => {
    // The stuck-preview class: the conversation is NOT loaded (empty
    // getAllStoredMessages) and its message is not pending in the durable cache
    // (already decrypted there, or evicted) — so neither the in-memory nor the
    // durable pass reaches it. The only carrier of the ciphertext is the
    // persisted preview itself, which still holds `encryptedPayload`. Without a
    // preview-level heal the sidebar stays on "[OpenPGP-encrypted message]"
    // until the conversation is opened.
    vi.spyOn(manager, 'decryptArchive').mockResolvedValue({
      plaintext: new TextEncoder().encode('hello'),
      senderDevice: { jid: 'bob@example.com', deviceId: 'test' },
      securityContext: { protocolId: 'dummy-plaintext', trust: 'verified' },
    })

    const preview: Message = {
      type: 'chat',
      id: 'msg-preview',
      stanzaId: undefined, originId: undefined,
      conversationId: 'bob@example.com',
      from: 'bob@example.com',
      body: '[OpenPGP-encrypted message]',
      timestamp: new Date(),
      isOutgoing: false,
      encryptedPayload: DUMMY_PAYLOAD_XML,
    }
    // No loaded messages, nothing pending in the durable cache — the preview is
    // the sole carrier of the ciphertext.
    stores.chat.getAllStoredMessages.mockReturnValue([])
    stores.chat.getEncryptedPreviews.mockReturnValue([
      { conversationId: 'bob@example.com', lastMessage: preview },
    ])

    const count = await engine.retryPending()

    expect(count).toBe(1)
    expect(stores.chat.refreshLastMessageContent).toHaveBeenCalledTimes(1)
    const [conversationId, messageId, updates] =
      stores.chat.refreshLastMessageContent.mock.calls[0]
    expect(conversationId).toBe('bob@example.com')
    expect(messageId).toBe(preview)
    expect(updates).toMatchObject({ body: 'hello', encryptedPayload: undefined })
  })

  it('does not re-decrypt a preview already handled by the message-store pass', async () => {
    // When the conversation IS loaded, the in-memory pass decrypts the message
    // and heals its preview via updateMessage. The preview-level pass must not
    // double-process it: once the store pass clears `encryptedPayload`,
    // getEncryptedPreviews no longer returns it.
    vi.spyOn(manager, 'decryptArchive').mockResolvedValue({
      plaintext: new TextEncoder().encode('hello'),
      senderDevice: { jid: 'bob@example.com', deviceId: 'test' },
      securityContext: { protocolId: 'dummy-plaintext', trust: 'verified' },
    })

    const pending: Message = {
      type: 'chat',
      id: 'msg-loaded',
      stanzaId: undefined, originId: undefined,
      conversationId: 'bob@example.com',
      from: 'bob@example.com',
      body: '[OpenPGP-encrypted message]',
      timestamp: new Date(),
      isOutgoing: false,
      encryptedPayload: DUMMY_PAYLOAD_XML,
    }
    stores.chat.getAllStoredMessages.mockReturnValue([
      { id: 'bob@example.com', messages: [pending] },
    ])
    // The store pass cleared the stash, so the preview enumeration returns nothing.
    stores.chat.getEncryptedPreviews.mockReturnValue([])

    await engine.retryPending()

    expect(stores.chat.updateMessage).toHaveBeenCalledTimes(1)
    expect(stores.chat.refreshLastMessageContent).not.toHaveBeenCalled()
  })

  // FLM-163: the pass stores an unverified decrypt's text and keeps the
  // encrypted copy for the signature check, so every later pass decrypts it
  // again. It must not write the message again, nor undo the trust the plugin
  // reported after checking the signature.
  it.each([
    ['untrusted, as first stored', { protocolId: 'dummy-plaintext', trust: 'untrusted', notes: ['dummy plugin — plaintext transport'] }],
    ['tofu, after the plugin checked the signature', { protocolId: 'dummy-plaintext', trust: 'tofu' }],
  ] as Array<[string, MessageSecurityContext]>)('leaves an unverified message alone once its text is stored, %s', async (_, securityContext) => {
    const stored = (conversationId: string): Message => ({
      type: 'chat', id: `shown-${conversationId}`, stanzaId: undefined, originId: undefined,
      conversationId, from: conversationId, body: 'hello', timestamp: new Date(), isOutgoing: false,
      securityContext,
      encryptedPayload: DUMMY_PAYLOAD_XML,
    })
    const loaded = stored('bob@example.com')
    const durable = stored('carol@example.com')
    const preview = stored('dave@example.com')
    stores.chat.getAllStoredMessages.mockReturnValue([{ id: loaded.conversationId!, messages: [loaded] }])
    vi.mocked(cache.getMessagesWithEncryptedPayload).mockResolvedValue([{ ...durable, cacheKey: messageCache.chatCacheKey(durable) }])
    stores.chat.getEncryptedPreviews.mockReturnValue([{ conversationId: preview.conversationId!, lastMessage: preview }])
    const decrypt = vi.spyOn(manager, 'decryptArchive')

    const count = await engine.retryPending()

    // The test plugin decrypts each to 'hello', untrusted.
    expect(decrypt).toHaveBeenCalledTimes(3)
    expect(count).toBe(0)
    expect(stores.chat.updateMessage).not.toHaveBeenCalled()
    expect(cache.updateMessage).not.toHaveBeenCalled()
    expect(stores.chat.refreshLastMessageContent).not.toHaveBeenCalled()
  })

  // FLM-163: a recovered signal changes another message and removes its
  // placeholder with the encrypted copy. An unverified one would act before the
  // signature check, so it waits for the sender's key.
  it.each([
    ['reaction', xml('reactions', { xmlns: 'urn:xmpp:reactions:0', id: 'signal-target' }, xml('reaction', {}, '👍'))],
    ['retraction', xml('retract', { xmlns: 'urn:xmpp:message-retract:1', id: 'signal-target' })],
    ['correction', [xml('body', {}, 'fixed'), xml('replace', { xmlns: 'urn:xmpp:message-correct:0', id: 'signal-target' })]],
  ] as const)('keeps an unverified %s pending until its signature is checked', async (_, signal) => {
    vi.spyOn(manager, 'decryptArchive').mockResolvedValue({
      plaintext: new TextEncoder().encode(serializePayloadEnvelope([signal].flat())),
      senderDevice: { jid: 'bob@example.com', deviceId: 'test' },
      securityContext: { protocolId: 'dummy-plaintext', trust: 'untrusted', notes: ['peer key not cached'] },
    })
    const target: Message = {
      type: 'chat', id: 'signal-target', stanzaId: undefined, originId: undefined, conversationId: 'bob@example.com',
      from: 'bob@example.com', body: 'original', timestamp: new Date(1_700_000_000_000), isOutgoing: false,
    }
    const placeholder: Message = {
      ...target, id: 'signal', body: COULD_NOT_DECRYPT_BODY, timestamp: new Date(1_700_000_001_000),
      encryptedPayload: DUMMY_PAYLOAD_XML,
    }
    stores.chat.getAllStoredMessages.mockReturnValue([{ id: 'bob@example.com', messages: [target, placeholder] }])
    stores.chat.getConversationMessages.mockReturnValue([target, placeholder])

    expect(await engine.retryPending()).toBe(0)

    expect(stores.chat.updateReactions).not.toHaveBeenCalled()
    expect(stores.chat.recordPendingRetraction).not.toHaveBeenCalled()
    expect(stores.chat.updateMessage).not.toHaveBeenCalled()
    expect(stores.chat.removeMessage).not.toHaveBeenCalled()
    expect(cache.deleteMessage).not.toHaveBeenCalled()
  })

  it('repairs each archive-distinct durable row that reuses a client id', async () => {
    vi.spyOn(manager, 'decryptArchive').mockResolvedValue({
      plaintext: new TextEncoder().encode('hello'),
      senderDevice: { jid: 'bob@example.com', deviceId: 'test' },
      securityContext: { protocolId: 'dummy-plaintext', trust: 'verified' },
    })

    const conversationId = 'bob@example.com'
    const first: Message = {
      type: 'chat',
      id: 'reused-client-id',
      originId: undefined,
      stanzaId: 'z',
      conversationId,
      from: conversationId,
      body: '[encrypted first]',
      timestamp: new Date(1_700_000_000_000),
      isOutgoing: false,
      encryptedPayload: DUMMY_PAYLOAD_XML,
    }
    const second: Message = {
      ...first,
      stanzaId: 'a', // Sorts before z, so a bare id lookup must not select it for both writes.
      body: '[encrypted second]',
      timestamp: new Date(1_700_000_001_000),
    }
    await messageCache.saveMessages('chat', [first, second])

    cache = {
      getMessagesWithEncryptedPayload: messageCache.getMessagesWithEncryptedPayload,
      updateMessage: messageCache.updateMessage,
      deleteMessage: messageCache.deleteMessage,
    }
    engine = new DeferredDecryptEngine({
      updateSearchIndex: vi.fn().mockResolvedValue(undefined),
      getManager: () => manager,
      getStores: () => stores as unknown as StoreBindings,
      getOwnBareJid: () => 'me@example.com',
      cache,
    })
    stores.chat.getAllStoredMessages.mockReturnValue([])
    stores.chat.getEncryptedPreviews.mockReturnValue([])

    const repairedCount = await engine.retryPending()
    const repaired = await messageCache.getMessages('chat', conversationId, { limit: 10 })
    expect({
      repairedCount,
      rows: repaired.map((message) => ({
        stanzaId: message.stanzaId,
        body: message.body,
        encryptedPayload: message.encryptedPayload,
      })),
    }).toEqual({
      repairedCount: 2,
      rows: [
        { stanzaId: 'z', body: 'hello', encryptedPayload: undefined },
        { stanzaId: 'a', body: 'hello', encryptedPayload: undefined },
      ],
    })
  })

  describe.each(['origin', 'stanza'] as const)('held chat identity with %s twins', identity => {
    const conversationId = 'bob@example.com'

    beforeEach(() => {
      _resetForTesting()
      _clearAllTransientForTesting()
      localStorage.clear()
      chatStore.setState({
        conversationEntities: new Map(), conversationMeta: new Map(), conversations: new Map(),
        messages: new Map(), activeConversationId: conversationId, windowAtLiveEdge: new Map(),
        pendingRetractions: new Map(), conversationCoverage: new Map(), conversationGaps: new Map(),
        mamQueryStates: new Map(),
      })
      stores.chat.getMessage.mockImplementation((...args) => chatStore.getState().getMessage(...args))
      stores.chat.updateMessage.mockImplementation((...args) => chatStore.getState().updateMessage(...args))
      stores.chat.removeMessage.mockImplementation((...args) => chatStore.getState().removeMessage(...args))
      stores.chat.refreshLastMessageContent.mockImplementation((...args) => chatStore.getState().refreshLastMessageContent(...args))
      stores.chat.getAllStoredMessages.mockImplementation(() => Array.from(chatStore.getState().messages, ([id, messages]) => ({ id, messages })))
      stores.chat.getConversationMessages.mockImplementation(id => chatStore.getState().messages.get(id) ?? [])
    })

    afterEach(() => {
      _resetForTesting()
      messageCache._resetDBForTesting()
    })

    async function seedTwins(fields: Partial<Message> = {}, resident = true) {
      const first: Message = {
        type: 'chat', id: 'X', conversationId, from: conversationId,
        originId: identity === 'origin' ? 'o1' : undefined,
        stanzaId: identity === 'stanza' ? 's1' : undefined,
        body: 'first twin', timestamp: new Date(1_700_000_000_000), isOutgoing: false,
      }
      const pending: Message = {
        ...first, originId: identity === 'origin' ? 'X' : undefined,
        stanzaId: identity === 'stanza' ? 'X' : undefined,
        body: COULD_NOT_DECRYPT_BODY, timestamp: new Date(1_700_000_001_000),
        encryptedPayload: DUMMY_PAYLOAD_XML, ...fields,
      }
      await messageCache.saveMessages('chat', [first, pending])
      chatStore.setState({ messages: new Map([[conversationId, resident ? [first, pending] : [first]]]) })
      chatStore.getState().addConversation({ id: conversationId, type: 'chat', name: 'Bob', unreadCount: 0, lastMessage: pending })
      return { first, pending }
    }

    function decryptsTo(plaintext = 'recovered second') {
      vi.spyOn(manager, 'decryptArchive').mockResolvedValue({
        plaintext: new TextEncoder().encode(plaintext),
        senderDevice: { jid: conversationId, deviceId: 'test' },
        securityContext: { protocolId: 'dummy-plaintext', trust: 'verified' },
      })
    }

    // Review: the copy must survive, or be cleared, on the durable and orphaned-preview recovery paths, not only on resident rows.
    describe('forwarded copy on durable and preview recovery', () => {
      const copy = xml('forwarded', { xmlns: 'urn:xmpp:forward:0' }, xml('message', { from: 'team@conference.example.org/Bob' }, xml('body', {}, 'Ship it')))
      const sealed = (children: ReturnType<typeof xml>[]) =>
        xml('plain', { xmlns: 'urn:fluux:e2ee-dummy:0' }, Buffer.from(serializePayloadEnvelope(children)).toString('base64')).toString()
      const durable = () => {
        vi.mocked(cache.getMessagesWithEncryptedPayload).mockImplementation(messageCache.getMessagesWithEncryptedPayload)
        vi.mocked(cache.updateMessage).mockImplementation(messageCache.updateMessage)
      }
      const rejects = () => vi.spyOn(manager, 'decryptArchive').mockRejectedValue(new E2EEPluginError('permanent', 'signature-failed', 'bad signature'))

      it('recovers a copy into a conversation that is not resident, with or without an outer body', async () => {
        const { pending } = await seedTwins({ body: '[encrypted]', encryptedPayload: sealed([copy]) }, false)
        durable()
        await engine.retryPending()
        expect(await messageCache.getMessage('chat', conversationId, pending.id, pending)).toMatchObject({
          body: '', forwarded: { author: 'Bob', text: 'Ship it' },
        })
      })

      it('clears a previously unverified copy from the durable row when the signature check fails', async () => {
        const { pending } = await seedTwins({ body: '[encrypted]', forwarded: { author: 'Mallory', text: 'Forged' } }, false)
        durable()
        rejects()
        await engine.retryPending()
        const row = await messageCache.getMessage('chat', conversationId, pending.id, pending)
        expect(row).toMatchObject({ body: MESSAGE_REJECTED_BODY, encryptedPayload: undefined })
        expect(row?.forwarded).toBeUndefined()
      })

      // Review: a terminal malformed-data failure is a different outcome from a rejected signature and must clear a retained copy too.
      const malformed = () => vi.spyOn(manager, 'decryptArchive').mockRejectedValue(new E2EEPluginError('permanent', 'malformed-data', 'not a valid envelope'))

      it('clears a retained copy from the durable row on a terminal malformed-data failure', async () => {
        const { pending } = await seedTwins({ body: 'Look', forwarded: { author: 'Mallory', text: 'Forged' } }, false)
        durable()
        malformed()
        await engine.retryPending()
        const row = await messageCache.getMessage('chat', conversationId, pending.id, pending)
        expect(row).toMatchObject({ body: COULD_NOT_DECRYPT_BODY, encryptedPayload: undefined, contentAvailability: { state: 'failed' } })
        expect(row?.forwarded).toBeUndefined()
      })

      it('clears a retained copy from a sidebar preview on a terminal malformed-data failure', async () => {
        const lastMessage: Message = {
          type: 'chat', id: 'orphan', stanzaId: undefined, originId: undefined, conversationId, from: conversationId, body: 'Look',
          forwarded: { author: 'Mallory', text: 'Forged' }, timestamp: new Date(1_700_000_002_000), isOutgoing: false, encryptedPayload: DUMMY_PAYLOAD_XML,
        }
        chatStore.getState().addConversation({ id: conversationId, type: 'chat', name: 'Bob', unreadCount: 0, lastMessage })
        stores.chat.getEncryptedPreviews.mockImplementation(() => {
          const last = chatStore.getState().conversationMeta.get(conversationId)?.lastMessage
          return last?.encryptedPayload ? [{ conversationId, lastMessage: last }] : []
        })
        malformed()
        await engine.retryPending()
        const preview = chatStore.getState().conversationMeta.get(conversationId)?.lastMessage
        expect(preview).toMatchObject({ encryptedPayload: undefined, contentAvailability: { state: 'failed' } })
        expect(preview?.forwarded).toBeUndefined()
      })

      it('recovers a copy into a sidebar preview that no stored row carries', async () => {
        const lastMessage: Message = {
          type: 'chat', id: 'orphan', stanzaId: undefined, originId: undefined, conversationId, from: conversationId, body: COULD_NOT_DECRYPT_BODY,
          timestamp: new Date(1_700_000_002_000), isOutgoing: false, encryptedPayload: sealed([copy]),
        }
        chatStore.getState().addConversation({ id: conversationId, type: 'chat', name: 'Bob', unreadCount: 0, lastMessage })
        stores.chat.getEncryptedPreviews.mockImplementation(() => {
          const last = chatStore.getState().conversationMeta.get(conversationId)?.lastMessage
          return last?.encryptedPayload ? [{ conversationId, lastMessage: last }] : []
        })
        await engine.retryPending()
        expect(chatStore.getState().conversationMeta.get(conversationId)?.lastMessage).toMatchObject({ forwarded: { author: 'Bob', text: 'Ship it' } })
      })

      it('clears a copy from a sidebar preview when the signature check fails', async () => {
        const lastMessage: Message = {
          type: 'chat', id: 'orphan', stanzaId: undefined, originId: undefined, conversationId, from: conversationId, body: 'Look', forwarded: { author: 'Mallory', text: 'Forged' },
          timestamp: new Date(1_700_000_002_000), isOutgoing: false, encryptedPayload: DUMMY_PAYLOAD_XML,
        }
        chatStore.getState().addConversation({ id: conversationId, type: 'chat', name: 'Bob', unreadCount: 0, lastMessage })
        stores.chat.getEncryptedPreviews.mockImplementation(() => {
          const last = chatStore.getState().conversationMeta.get(conversationId)?.lastMessage
          return last?.encryptedPayload ? [{ conversationId, lastMessage: last }] : []
        })
        rejects()
        await engine.retryPending()
        const preview = chatStore.getState().conversationMeta.get(conversationId)?.lastMessage
        expect(preview).toMatchObject({ body: MESSAGE_REJECTED_BODY, encryptedPayload: undefined })
        expect(preview?.forwarded).toBeUndefined()
      })
    })

    it.each(['unlock', 'peer', 'rejected body'])('indexes content recovered after a twin is evicted during %s', async mode => {
      const { first, pending } = await seedTwins({ body: '[encrypted second]' })
      await searchIndex.indexMessages([first, pending])
      const updateSearchMessage = searchIndex.updateMessage
      // Store persistence outlives the retry; wait for the real index write.
      const indexed = new Promise<void>((resolve, reject) => {
        vi.spyOn(searchIndex, 'updateMessage').mockImplementationOnce((...args) => {
          const update = updateSearchMessage(...args)
          void update.then(resolve, reject)
          return update
        })
      })
      vi.mocked(cache.getMessagesWithEncryptedPayload).mockImplementation(messageCache.getMessagesWithEncryptedPayload)
      vi.spyOn(manager, 'decryptArchive').mockImplementation(async () => {
        await Promise.resolve()
        chatStore.setState({ messages: new Map([[conversationId, [first]]]) })
        chatStore.getState().addConversation({ id: conversationId, type: 'chat', name: 'Bob', unreadCount: 0, lastMessage: first })
        if (mode === 'rejected body') throw new E2EEPluginError('permanent', 'signature-failed', 'bad signature')
        return {
          plaintext: new TextEncoder().encode('recovered second'),
          senderDevice: { jid: conversationId, deviceId: 'test' },
          securityContext: { protocolId: 'dummy-plaintext', trust: 'verified' as const },
        }
      })
      if (mode === 'peer') await engine.retryForPeer(conversationId)
      else await engine.retryPending()
      const body = mode === 'rejected body' ? MESSAGE_REJECTED_BODY : 'recovered second'
      await indexed
      vi.mocked(searchIndex.updateMessage).mockRestore()
      expect(await searchIndex.search(mode === 'rejected body' ? 'rejected' : 'recovered')).toMatchObject([{
        messageId: pending.id, stanzaId: pending.stanzaId, originId: pending.originId, body,
      }])
      expect(await messageCache.getMessage('chat', conversationId, pending.id, pending)).toMatchObject({ body, encryptedPayload: undefined })
      expect(chatStore.getState().messages.get(conversationId)).toEqual([first])
      expect(chatStore.getState().conversationMeta.get(conversationId)?.lastMessage).toEqual(first)
      expect(await searchIndex.search('first')).toMatchObject([{ body: first.body }])
    })

    it.each(['resident signal', 'preview signal', 'retraction signal', 'rejected signal'])('removes only the placeholder for a %s', async mode => {
      const { first, pending } = await seedTwins({}, mode !== 'preview signal')
      stores.chat.getEncryptedPreviews.mockImplementation(() => {
        const lastMessage = chatStore.getState().conversationMeta.get(conversationId)?.lastMessage
        return lastMessage?.encryptedPayload ? [{ conversationId, lastMessage }] : []
      })
      if (mode === 'rejected signal') {
        vi.spyOn(manager, 'decryptArchive').mockRejectedValue(new E2EEPluginError('permanent', 'signature-failed', 'bad signature'))
      } else {
        decryptsTo(serializePayloadEnvelope([
          mode === 'retraction signal'
            ? xml('retract', { xmlns: 'urn:xmpp:message-retract:1', id: 'signal-target' })
            : xml('reactions', { xmlns: 'urn:xmpp:reactions:0', id: 'signal-target' }, xml('reaction', {}, '👍')),
        ]))
      }

      await engine.retryPending()

      expect(chatStore.getState().messages.get(conversationId)).toEqual([first])
      expect(chatStore.getState().getMessage(conversationId, pending)).toBeUndefined()
      expect(chatStore.getState().getMessage(conversationId, 'X')).toEqual(first)
      expect(chatStore.getState().conversationMeta.get(conversationId)?.lastMessage).toEqual(first)
      await vi.waitFor(async () => {
        expect(await messageCache.getMessages('chat', conversationId, {})).toMatchObject([first])
      })
    })

    it.each(['unlock', 'peer', 'unsupported unlock', 'unsupported peer', 'rejected body', 'peer trust'])('updates only the held twin on %s', async mode => {
      const unsupported = mode.startsWith('unsupported')
      const { first, pending } = await seedTwins({
        body: '[encrypted second]',
        ...(unsupported && { encryptedPayload: '<encrypted xmlns="eu.siacs.conversations.axolotl"><header sid="1"/><payload>ciphertext</payload></encrypted>' }),
        ...(mode === 'peer trust' && { encryptedPayload: undefined, securityContext: {
          protocolId: 'dummy-plaintext', trust: 'untrusted', notes: ['peer key not cached'],
        } }),
      })
      if (mode === 'rejected body') {
        vi.spyOn(manager, 'decryptArchive').mockRejectedValue(new E2EEPluginError('permanent', 'signature-failed', 'bad signature'))
      } else {
        decryptsTo()
      }
      if (mode.includes('peer')) await engine.retryForPeer(conversationId)
      else await engine.retryPending()

      const expected = unsupported
        ? { encryptedPayload: undefined, unsupportedEncryption: { namespace: 'eu.siacs.conversations.axolotl' } }
        : mode === 'peer trust'
          ? { securityContext: { trust: 'tofu' } }
          : { encryptedPayload: undefined, body: mode === 'rejected body' ? MESSAGE_REJECTED_BODY : 'recovered second' }
      expect(chatStore.getState().getMessage(conversationId, first)).toEqual(first)
      expect(chatStore.getState().getMessage(conversationId, pending)).toMatchObject(expected)
      expect(chatStore.getState().conversationMeta.get(conversationId)?.lastMessage).toMatchObject(expected)
      await vi.waitFor(async () => {
        const rows = await messageCache.getMessages('chat', conversationId, {})
        expect(rows).toHaveLength(2)
        expect(rows[0]).toMatchObject(first)
        expect(rows[1]).toMatchObject(expected)
      })
    })

    it.each([false, true])('refreshes a durable twin only when it owns the preview: %s', async ownsPreview => {
      const { first, pending } = await seedTwins({}, false)
      chatStore.getState().addConversation({ id: conversationId, type: 'chat', name: 'Bob', unreadCount: 0,
        lastMessage: ownsPreview ? pending : { ...first, encryptedPayload: DUMMY_PAYLOAD_XML } })
      vi.mocked(cache.getMessagesWithEncryptedPayload).mockImplementation(messageCache.getMessagesWithEncryptedPayload)
      vi.mocked(cache.updateMessage).mockImplementation(messageCache.updateMessage)
      decryptsTo()

      await engine.retryPending()

      expect(chatStore.getState().conversationMeta.get(conversationId)?.lastMessage).toMatchObject(ownsPreview
        ? { ...pending, body: 'recovered second', encryptedPayload: undefined }
        : { ...first, encryptedPayload: DUMMY_PAYLOAD_XML })
      const rows = await messageCache.getMessages('chat', conversationId, {})
      expect(rows).toHaveLength(2)
      expect(rows[0]).toMatchObject(first)
      expect(rows[1]).toMatchObject({ body: 'recovered second', encryptedPayload: undefined })
    })
  })

  it('repairs another room row with the same client ID while a promoted correction recovers', async () => {
    vi.spyOn(manager, 'decryptArchive').mockResolvedValue({
      plaintext: new TextEncoder().encode('hello'),
      senderDevice: { jid: 'bob@example.com', deviceId: 'test' },
      securityContext: { protocolId: 'dummy-plaintext', trust: 'verified' },
    })
    const first: StoredRoomMessage = { type: 'groupchat', roomJid: 'room@example.com', from: 'room@example.com/Bob',
      nick: 'Bob', occupantId: 'bob', id: 'reused', originId: undefined, stanzaId: 'archive-one', body: 'encrypted',
      timestamp: new Date(), isOutgoing: false, isEdited: true, encryptedPayload: DUMMY_PAYLOAD_XML,
      correctionRevision: { ids: ['id:correction'], supersedes: [] } }
    const second: StoredRoomMessage = { ...first, stanzaId: 'archive-two' }
    stores.room.getAllRoomMessages.mockReturnValue([{ jid: first.roomJid, messages: [first, second] }])
    const apply = vi.fn()
    engine.recoverCorrection(first, () => true, apply)
    await vi.waitFor(() => expect(stores.room.updateMessage).toHaveBeenCalledTimes(1))
    expect(apply).toHaveBeenCalledWith(expect.objectContaining({ body: 'hello', encryptedPayload: undefined }))
    expect(manager.decryptArchive).toHaveBeenCalledTimes(2)
  })

  it('treats a decrypt that never settles as pending and releases the retry guard', async () => {
    engine = new DeferredDecryptEngine({
      updateSearchIndex: vi.fn().mockResolvedValue(undefined),
      getManager: () => manager,
      getStores: () => stores as unknown as StoreBindings,
      getOwnBareJid: () => 'me@example.com',
      cache,
      decryptTimeoutMs: 20,
    })
    const decrypted = {
      plaintext: new TextEncoder().encode('hello'),
      senderDevice: { jid: 'bob@example.com', deviceId: 'test' },
      securityContext: { protocolId: 'dummy-plaintext', trust: 'verified' as const },
    }
    let settleHung: (value: typeof decrypted) => void = () => {}
    const decryptArchive = vi.spyOn(manager, 'decryptArchive')
      .mockImplementationOnce(() => new Promise((resolve) => { settleHung = resolve }))
      .mockResolvedValue(decrypted)
    const pending: Message = {
      type: 'chat', id: 'msg-hung', stanzaId: undefined, originId: undefined,
      conversationId: 'bob@example.com', from: 'bob@example.com', body: '[dummy-plaintext payload]',
      timestamp: new Date(), isOutgoing: false, encryptedPayload: DUMMY_PAYLOAD_XML,
    }
    stores.chat.getAllStoredMessages.mockReturnValue([{ id: 'bob@example.com', messages: [pending] }])

    expect(await engine.retryPending()).toBe(0)
    expect(stores.chat.updateMessage).not.toHaveBeenCalled()

    // The late result of the abandoned call commits nothing.
    settleHung(decrypted)
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(stores.chat.updateMessage).not.toHaveBeenCalled()

    // The guard is free and the stash is still retryable.
    expect(await engine.retryPending()).toBe(1)
    expect(decryptArchive).toHaveBeenCalledTimes(2)
    expect(stores.chat.updateMessage).toHaveBeenCalledTimes(1)
    expect(stores.chat.updateMessage.mock.calls[0][2]).toMatchObject({ body: 'hello', encryptedPayload: undefined })
  })

  it('tags stored unsupported-protocol payloads before any declared plugin registers', async () => {
    manager = new E2EEManager({
      storage: new InMemoryStorageBackend(),
      xmpp: stubXmppPrimitives(),
      account: { jid: 'me@example.com' },
      expectedPlugins: ['openpgp'],
    })
    const stored = (id: string, encryptedPayload: string): Message => ({
      type: 'chat',
      id,
      stanzaId: undefined, originId: undefined,
      conversationId: 'bob@example.com',
      from: 'bob@example.com',
      body: 'fallback',
      timestamp: new Date(),
      isOutgoing: false,
      encryptedPayload,
    })
    const omemo = stored('omemo-1', '<encrypted xmlns="eu.siacs.conversations.axolotl"><header sid="1"/><payload>ciphertext</payload></encrypted>')
    const openpgp = stored('pgp-1', '<openpgp xmlns="urn:xmpp:openpgp:0">ciphertext</openpgp>')
    stores.chat.getAllStoredMessages.mockReturnValue([
      { id: 'bob@example.com', messages: [omemo, openpgp] },
    ])

    await engine.retryPending()

    expect(stores.chat.updateMessage).toHaveBeenCalledTimes(1)
    const [, target, updates] = stores.chat.updateMessage.mock.calls[0]
    expect(target).toBe(omemo)
    expect(updates).toMatchObject({
      encryptedPayload: undefined,
      unsupportedEncryption: { namespace: 'eu.siacs.conversations.axolotl', name: 'OMEMO' },
    })
  })

  it('is a no-op when no E2EE manager is available', async () => {
    engine = new DeferredDecryptEngine({
      updateSearchIndex: vi.fn().mockResolvedValue(undefined),
      getManager: () => null,
      getStores: () => stores as unknown as StoreBindings,
      getOwnBareJid: () => 'me@example.com',
      cache,
    })
    stores.chat.getAllStoredMessages.mockReturnValue([
      {
        id: 'bob@example.com',
        messages: [
          {
            type: 'chat',
            id: 'msg-1',
            conversationId: 'bob@example.com',
            from: 'bob@example.com',
            body: 'x',
            timestamp: new Date(),
            isOutgoing: false,
            encryptedPayload: DUMMY_PAYLOAD_XML,
          } as Message,
        ],
      },
    ])

    const count = await engine.retryPending()

    expect(count).toBe(0)
    expect(stores.chat.updateMessage).not.toHaveBeenCalled()
  })
})
