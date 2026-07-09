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
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { DeferredDecryptEngine } from './deferredDecrypt'
import {
  E2EEManager,
  InMemoryStorageBackend,
  type XMPPPrimitives,
} from '.'
import { DummyPlaintextPlugin } from './DummyPlaintextPlugin'
import { createMockStores, type MockStoreBindings } from '../test-utils'
import type { StoreBindings } from '../types'
import type { Message } from '../types/chat'

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
  let cache: ReturnType<typeof makeCache>
  let engine: DeferredDecryptEngine

  beforeEach(async () => {
    manager = await makeManagerWithDummyPlugin('me@example.com')
    stores = createMockStores()
    cache = makeCache()
    engine = new DeferredDecryptEngine({
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
    expect(messageId).toBe('msg-1')
    expect(updates).toMatchObject({ body: 'hello', encryptedPayload: undefined })
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
    expect(messageId).toBe('msg-peer')
    expect(updates).toMatchObject({ body: 'hello', encryptedPayload: undefined })
  })

  it('is a no-op when no E2EE manager is available', async () => {
    engine = new DeferredDecryptEngine({
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
