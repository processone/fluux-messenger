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
    expect(messageId).toBe('msg-preview')
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
