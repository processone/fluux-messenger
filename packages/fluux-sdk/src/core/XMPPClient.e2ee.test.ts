/**
 * XMPPClient E2EE integration tests — retryPendingDecrypts().
 *
 * Regression guard for: self-outgoing messages stored with encryptedPayload
 * (sent carbons or MAM self-replays received before the key was unlocked)
 * were permanently undecryptable because retryDecryptSingle did not pass
 * isSelfOutgoing: true when senderJid === ownBareJid. Without that flag the
 * OpenPGP plugin's signcrypt reflection check compared the envelope's <to/>
 * addressee against our own JID, but the envelope names the conversation
 * peer — so it threw 'envelope-reflection' and the message stayed broken.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { localStorageMock } from './sideEffects.testHelpers'

// chatStore uses persist middleware — needs localStorage before any store import
Object.defineProperty(globalThis, 'localStorage', {
  value: localStorageMock,
  writable: true,
})

// Prevent IndexedDB operations triggered by chatStore.addMessage / updateMessage
vi.mock('../utils/messageCache', () => ({
  saveMessage: vi.fn().mockResolvedValue(undefined),
  saveMessages: vi.fn().mockResolvedValue(undefined),
  getMessages: vi.fn().mockResolvedValue([]),
  getMessage: vi.fn().mockResolvedValue(null),
  getMessageByStanzaId: vi.fn().mockResolvedValue(null),
  updateMessage: vi.fn().mockResolvedValue(undefined),
  deleteMessage: vi.fn().mockResolvedValue(undefined),
  deleteConversationMessages: vi.fn().mockResolvedValue(undefined),
  clearAllMessages: vi.fn().mockResolvedValue(undefined),
  isMessageCacheAvailable: vi.fn().mockReturnValue(false),
  getOldestMessageTimestamp: vi.fn().mockResolvedValue(null),
  getMessageCount: vi.fn().mockResolvedValue(0),
  saveRoomMessage: vi.fn().mockResolvedValue(undefined),
  saveRoomMessages: vi.fn().mockResolvedValue(undefined),
  getRoomMessages: vi.fn().mockResolvedValue([]),
  getRoomMessage: vi.fn().mockResolvedValue(null),
  getRoomMessageByStanzaId: vi.fn().mockResolvedValue(null),
  updateRoomMessage: vi.fn().mockResolvedValue(undefined),
  deleteRoomMessage: vi.fn().mockResolvedValue(undefined),
  deleteRoomMessages: vi.fn().mockResolvedValue(undefined),
  getRoomMessageCount: vi.fn().mockResolvedValue(0),
}))

import { XMPPClient } from './XMPPClient'
import { chatStore } from '../stores/chatStore'
import {
  E2EEManager,
  InMemoryStorageBackend,
  type XMPPPrimitives,
} from './e2ee'
import { DummyPlaintextPlugin } from './e2ee/DummyPlaintextPlugin'
import { _resetStorageScopeForTesting } from '../utils/storageScope'

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

// DummyPlaintextPlugin serialises the payload as:
//   <plain xmlns='urn:fluux:e2ee-dummy:0'>base64(plaintext)</plain>
// This is the encryptedPayload string that retryPendingDecrypts() will parse.
const DUMMY_PAYLOAD_XML = `<plain xmlns="urn:fluux:e2ee-dummy:0">aGVsbG8=</plain>`  // base64("hello")

describe('XMPPClient.retryPendingDecrypts()', () => {
  let xmppClient: XMPPClient
  let manager: E2EEManager

  beforeEach(async () => {
    _resetStorageScopeForTesting()
    chatStore.getState().reset()
    manager = await makeManagerWithDummyPlugin('me@example.com')
    xmppClient = new XMPPClient({ debug: false })
    // e2ee is a public field, normally set in handleConnectionSuccess
    xmppClient.e2ee = manager
    // currentJid is protected; cast to inject without a full connection
    ;(xmppClient as unknown as { currentJid: string }).currentJid = 'me@example.com/web'
  })

  afterEach(() => {
    vi.clearAllMocks()
    chatStore.getState().reset()
  })

  describe('unsupported-encryption self-heal', () => {
    it('clears encryptedPayload and sets unsupportedEncryption for stored OMEMO messages when no OMEMO plugin is registered', async () => {
      // DummyPlaintextPlugin claims "urn:fluux:e2ee-dummy:0" — it does NOT
      // claim OMEMO ("eu.siacs.conversations.axolotl"). So hasPlugins() is
      // true but the OMEMO payload goes unclaimed → unsupported branch.
      const OMEMO_PAYLOAD_XML = '<encrypted xmlns="eu.siacs.conversations.axolotl">cipher</encrypted>'
      const FALLBACK_BODY = 'OMEMO fallback'

      chatStore.getState().addConversation({
        id: 'alice@example.com',
        name: 'Alice',
        type: 'chat',
        lastMessage: undefined,
        unreadCount: 0,
      })
      chatStore.getState().addMessage({
        type: 'chat',
        id: 'msg-omemo-unsupported',
        conversationId: 'alice@example.com',
        from: 'alice@example.com',
        body: FALLBACK_BODY,
        timestamp: new Date(),
        isOutgoing: false,
        encryptedPayload: OMEMO_PAYLOAD_XML,
      })

      await xmppClient.retryPendingDecrypts()

      const messages = chatStore.getState().messages.get('alice@example.com') ?? []
      const msg = messages.find((m) => m.id === 'msg-omemo-unsupported')

      expect(msg?.encryptedPayload).toBeUndefined()
      expect(msg?.unsupportedEncryption).toEqual({
        namespace: 'eu.siacs.conversations.axolotl',
        name: 'OMEMO',
      })
      expect(msg?.body).toBe(FALLBACK_BODY)
    })
  })

  describe('isSelfOutgoing flag propagation', () => {
    it('passes isSelfOutgoing=true to the plugin when the sender equals our own bare JID', async () => {
      // A message where from === own bare JID represents a sent carbon or MAM
      // self-replay: our other device sent it and the server copied it to us.
      chatStore.getState().addConversation({
        id: 'bob@example.com',
        name: 'Bob',
        type: 'chat',
        lastMessage: undefined,
        unreadCount: 0,
      })
      chatStore.getState().addMessage({
        type: 'chat',
        id: 'msg-self-outgoing',
        conversationId: 'bob@example.com',
        from: 'me@example.com',      // own bare JID → self-outgoing
        body: '[dummy-plaintext payload]',
        timestamp: new Date(),
        isOutgoing: true,
        encryptedPayload: DUMMY_PAYLOAD_XML,
      })

      const decryptSpy = vi.spyOn(manager, 'decryptArchive')
      await xmppClient.retryPendingDecrypts()

      // decryptArchive must have been called exactly once.
      expect(decryptSpy).toHaveBeenCalledTimes(1)

      // The plugin must receive isSelfOutgoing=true so it inverts its
      // reflection check (signcrypt <to/> names the peer, not us).
      const [, , context] = decryptSpy.mock.calls[0]
      expect(context?.isSelfOutgoing).toBe(true)
    })

    it('does not set isSelfOutgoing when the sender is the conversation peer', async () => {
      chatStore.getState().addConversation({
        id: 'bob@example.com',
        name: 'Bob',
        type: 'chat',
        lastMessage: undefined,
        unreadCount: 0,
      })
      chatStore.getState().addMessage({
        type: 'chat',
        id: 'msg-inbound',
        conversationId: 'bob@example.com',
        from: 'bob@example.com',      // peer JID → normal inbound
        body: '[dummy-plaintext payload]',
        timestamp: new Date(),
        isOutgoing: false,
        encryptedPayload: DUMMY_PAYLOAD_XML,
      })

      const decryptSpy = vi.spyOn(manager, 'decryptArchive')
      await xmppClient.retryPendingDecrypts()

      expect(decryptSpy).toHaveBeenCalledTimes(1)
      const [, , context] = decryptSpy.mock.calls[0]
      expect(context?.isSelfOutgoing).not.toBe(true)
    })

    it('updates the message body and clears encryptedPayload on successful retry', async () => {
      // The DummyPlaintextPlugin always returns trust:'untrusted', which
      // triggers needsDeferredVerification and prevents count from being
      // incremented. To test the end-to-end store update, mock decryptArchive
      // to return trust:'verified' so the message is committed to the store.
      vi.spyOn(manager, 'decryptArchive').mockResolvedValue({
        plaintext: new TextEncoder().encode('hello'),
        senderDevice: { jid: 'me@example.com', deviceId: 'test' },
        securityContext: { protocolId: 'dummy-plaintext', trust: 'verified' },
      })

      chatStore.getState().addConversation({
        id: 'bob@example.com',
        name: 'Bob',
        type: 'chat',
        lastMessage: undefined,
        unreadCount: 0,
      })
      chatStore.getState().addMessage({
        type: 'chat',
        id: 'msg-body-check',
        conversationId: 'bob@example.com',
        from: 'me@example.com',
        body: '[dummy-plaintext payload]',
        timestamp: new Date(),
        isOutgoing: true,
        encryptedPayload: DUMMY_PAYLOAD_XML,
      })

      const count = await xmppClient.retryPendingDecrypts()

      expect(count).toBe(1)
      // After retry, the message in the store must have the plaintext body
      // and no encryptedPayload stash.
      const messages = chatStore.getState().messages.get('bob@example.com') ?? []
      const msg = messages.find((m) => m.id === 'msg-body-check')
      expect(msg?.body).toBe('hello')
      expect(msg?.encryptedPayload).toBeUndefined()
    })
  })
})
