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
import type { StoreBindings } from '../types'
import type { Message } from '../types/chat'
import * as messageCache from '../../utils/messageCache'
import * as searchIndex from '../../utils/searchIndex'
import { _resetStorageScopeForTesting, setStorageScopeJid } from '../../utils/storageScope'
import { chatStore } from '../../stores/chatStore'
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
    await messageCache.saveMessages([first, second])

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
    const repaired = await messageCache.getMessages(conversationId, { limit: 10 })
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
      await messageCache.saveMessages([first, pending])
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

    it.each(['unlock', 'peer', 'rejected body'])('indexes content recovered after a twin is evicted during %s', async mode => {
      const { first, pending } = await seedTwins({ body: '[encrypted second]' })
      await searchIndex.indexMessages([first, pending])
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
      await vi.waitFor(async () => {
        expect(await searchIndex.search(mode === 'rejected body' ? 'rejected' : 'recovered')).toMatchObject([{
          messageId: pending.id, stanzaId: pending.stanzaId, originId: pending.originId, body,
        }])
      })
      expect(await messageCache.getMessage(conversationId, pending.id, pending)).toMatchObject({ body, encryptedPayload: undefined })
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
        expect(await messageCache.getMessages(conversationId, {})).toMatchObject([first])
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
        const rows = await messageCache.getMessages(conversationId, {})
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
      const rows = await messageCache.getMessages(conversationId, {})
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
