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
  getMessagesWithEncryptedPayload: vi.fn().mockResolvedValue([]),
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
import * as messageCache from '../utils/messageCache'

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

  describe('XEP-0461 reply fallback stripping on retry', () => {
    // Regression guard for the duplicated-quote rendering bug: an encrypted
    // reply's body carries the XEP-0461 compatibility quote ("> Author
    // wrote:\n> …\n") and the OUTER stanza carries the XEP-0428 <fallback>
    // range pointing at it. The stash holds the full original stanza so the
    // retry can re-run fallback stripping; the old bare-element stash lost
    // the <reply>/<fallback> context and clobbered the store body with the
    // raw quote-prefixed plaintext (reply chip + quote rendered twice).
    const REPLY_FALLBACK = '> Bob wrote:\n> original message\n'
    const REPLY_PLAINTEXT = `${REPLY_FALLBACK}actual reply`
    const FULL_STANZA_PAYLOAD =
      `<message from="bob@example.com/web" to="me@example.com" type="chat" id="reply-1">` +
      `<reply xmlns="urn:xmpp:reply:0" id="orig-1" to="me@example.com"/>` +
      `<fallback xmlns="urn:xmpp:fallback:0" for="urn:xmpp:reply:0"><body start="0" end="${REPLY_FALLBACK.length}"/></fallback>` +
      `<body>[encrypted]</body>` +
      `<plain xmlns="urn:fluux:e2ee-dummy:0">${Buffer.from(REPLY_PLAINTEXT).toString('base64')}</plain>` +
      `<encryption xmlns="urn:xmpp:eme:0" namespace="urn:fluux:e2ee-dummy:0"/>` +
      `</message>`

    beforeEach(() => {
      vi.spyOn(manager, 'decryptArchive').mockResolvedValue({
        plaintext: new TextEncoder().encode(REPLY_PLAINTEXT),
        senderDevice: { jid: 'bob@example.com', deviceId: 'test' },
        securityContext: { protocolId: 'dummy-plaintext', trust: 'verified' },
      })
      chatStore.getState().addConversation({
        id: 'bob@example.com',
        name: 'Bob',
        type: 'chat',
        lastMessage: undefined,
        unreadCount: 0,
      })
    })

    it('strips the reply fallback quote from the decrypted body (deferred decrypt)', async () => {
      chatStore.getState().addMessage({
        type: 'chat',
        id: 'msg-reply-deferred',
        conversationId: 'bob@example.com',
        from: 'bob@example.com',
        body: '[Encrypted message: could not decrypt]',
        timestamp: new Date(),
        isOutgoing: false,
        replyTo: { id: 'orig-1', to: 'me@example.com' },
        encryptedPayload: FULL_STANZA_PAYLOAD,
      })

      const count = await xmppClient.retryPendingDecrypts()

      expect(count).toBe(1)
      const messages = chatStore.getState().messages.get('bob@example.com') ?? []
      const msg = messages.find((m) => m.id === 'msg-reply-deferred')
      expect(msg?.body).toBe('actual reply')
      expect(msg?.encryptedPayload).toBeUndefined()
    })

    it('does not reintroduce the quote when re-verifying an already-decrypted reply', async () => {
      // needsDeferredVerification case: the first pass decrypted and stripped
      // the body correctly but could not verify the signature (peer key not
      // cached). The retry must not clobber the body with the raw plaintext.
      chatStore.getState().addMessage({
        type: 'chat',
        id: 'msg-reply-reverify',
        conversationId: 'bob@example.com',
        from: 'bob@example.com',
        body: 'actual reply',
        timestamp: new Date(),
        isOutgoing: false,
        replyTo: { id: 'orig-1', to: 'me@example.com' },
        securityContext: {
          protocolId: 'dummy-plaintext',
          trust: 'untrusted',
          notes: ['Sender key not cached'],
        },
        encryptedPayload: FULL_STANZA_PAYLOAD,
      })

      await xmppClient.retryPendingDecrypts()

      const messages = chatStore.getState().messages.get('bob@example.com') ?? []
      const msg = messages.find((m) => m.id === 'msg-reply-reverify')
      expect(msg?.body).toBe('actual reply')
      expect(msg?.securityContext?.trust).toBe('verified')
      expect(msg?.encryptedPayload).toBeUndefined()
    })

    it('still decrypts legacy bare-element payloads (no outer context available)', async () => {
      // Stashes persisted before the full-stanza format hold only the
      // encrypted child. They must keep decrypting; fallback stripping is
      // impossible without the outer <fallback> range, so the raw body is
      // accepted as-is.
      chatStore.getState().addMessage({
        type: 'chat',
        id: 'msg-reply-legacy',
        conversationId: 'bob@example.com',
        from: 'bob@example.com',
        body: '[Encrypted message: could not decrypt]',
        timestamp: new Date(),
        isOutgoing: false,
        encryptedPayload: `<plain xmlns="urn:fluux:e2ee-dummy:0">${Buffer.from(REPLY_PLAINTEXT).toString('base64')}</plain>`,
      })

      const count = await xmppClient.retryPendingDecrypts()

      expect(count).toBe(1)
      const messages = chatStore.getState().messages.get('bob@example.com') ?? []
      const msg = messages.find((m) => m.id === 'msg-reply-legacy')
      expect(msg?.body).toBe(REPLY_PLAINTEXT)
      expect(msg?.encryptedPayload).toBeUndefined()
    })
  })

  describe('durable-cache deferred decryption', () => {
    // Regression guard for the web fresh-session reload bug: messages that
    // failed to decrypt while the key was locked are persisted to IndexedDB
    // (encryptedPayload stashed) but for conversations the user has NOT opened
    // they are never loaded into the in-memory store. The original
    // retryPendingDecrypts only scanned the in-memory store, so those stayed
    // permanently "could not be decrypted" even after unlock.
    it('decrypts and repairs a message that exists only in the durable cache', async () => {
      vi.spyOn(manager, 'decryptArchive').mockResolvedValue({
        plaintext: new TextEncoder().encode('hello'),
        senderDevice: { jid: 'me@example.com', deviceId: 'test' },
        securityContext: { protocolId: 'dummy-plaintext', trust: 'verified' },
      })

      // In-memory store is empty for this conversation; the message lives ONLY
      // in IndexedDB (mocked), as after a fresh-session reload of an unopened
      // conversation.
      vi.mocked(messageCache.getMessagesWithEncryptedPayload).mockResolvedValue([
        {
          type: 'chat',
          id: 'durable-1',
          conversationId: 'carol@example.com',
          from: 'carol@example.com',
          body: '[dummy-plaintext payload]',
          timestamp: new Date(),
          isOutgoing: false,
          encryptedPayload: DUMMY_PAYLOAD_XML,
        },
      ])

      const count = await xmppClient.retryPendingDecrypts()

      expect(count).toBe(1)
      // Written back to the DURABLE cache with plaintext + cleared stash.
      expect(messageCache.updateMessage).toHaveBeenCalledWith(
        'durable-1',
        expect.objectContaining({ body: 'hello', encryptedPayload: undefined })
      )
    })

    it('does not double-process a message present in both memory and the durable cache', async () => {
      vi.spyOn(manager, 'decryptArchive').mockResolvedValue({
        plaintext: new TextEncoder().encode('hello'),
        senderDevice: { jid: 'me@example.com', deviceId: 'test' },
        securityContext: { protocolId: 'dummy-plaintext', trust: 'verified' },
      })

      chatStore.getState().addConversation({
        id: 'dave@example.com',
        name: 'Dave',
        type: 'chat',
        lastMessage: undefined,
        unreadCount: 0,
      })
      chatStore.getState().addMessage({
        type: 'chat',
        id: 'dup-1',
        conversationId: 'dave@example.com',
        from: 'dave@example.com',
        body: '[dummy-plaintext payload]',
        timestamp: new Date(),
        isOutgoing: false,
        encryptedPayload: DUMMY_PAYLOAD_XML,
      })
      // Same message also surfaced by the durable scan.
      vi.mocked(messageCache.getMessagesWithEncryptedPayload).mockResolvedValue([
        {
          type: 'chat',
          id: 'dup-1',
          conversationId: 'dave@example.com',
          from: 'dave@example.com',
          body: '[dummy-plaintext payload]',
          timestamp: new Date(),
          isOutgoing: false,
          encryptedPayload: DUMMY_PAYLOAD_XML,
        },
      ])

      const decryptSpy = vi.spyOn(manager, 'decryptArchive')
      const count = await xmppClient.retryPendingDecrypts()

      // Decrypted exactly once — the durable pass skips the already-handled id.
      expect(decryptSpy).toHaveBeenCalledTimes(1)
      expect(count).toBe(1)
    })
  })

  describe('deferred-decrypt of bodiless modifications', () => {
    // Regression guard for the production bug (lost encrypted reaction):
    //
    // An encrypted XEP-0444 reaction has NO <body> — the whole <reactions>
    // element rides inside the OpenPGP payload. When such a stanza is replayed
    // from MAM (or received live) while the key is still locked, the decrypt is
    // deferred: stanzaDecrypt injects an "[Encrypted message: could not decrypt]"
    // placeholder body so the bodiless stanza survives parseArchiveMessage's
    // `if (!body) return null` gate, and the encrypted payload is stashed for
    // retry. The stanza is therefore persisted as a placeholder "message".
    //
    // On unlock, retryPendingDecrypts re-decrypts it. The decrypt SUCCEEDS, but
    // the deferred-retry path was body-only: a decrypted payload that surfaces
    // a <reactions> (no <body>) was reported as `pending`, so the reaction was
    // never applied to its target and the placeholder lingered. The user saw no
    // reaction and re-did it by hand.
    it('applies a deferred-decrypted reaction to its target and drops the placeholder', async () => {
      // Decrypt yields a payload envelope carrying <reactions>, not a <body>.
      const reactionEnvelope =
        `<payload xmlns="jabber:client">` +
        `<reactions xmlns="urn:xmpp:reactions:0" id="xcom-msg"><reaction>👍</reaction></reactions>` +
        `</payload>`
      vi.spyOn(manager, 'decryptArchive').mockResolvedValue({
        plaintext: new TextEncoder().encode(reactionEnvelope),
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
      // The message the reaction targets — a normal text message already stored.
      chatStore.getState().addMessage({
        type: 'chat',
        id: 'xcom-msg',
        conversationId: 'bob@example.com',
        from: 'bob@example.com',
        body: 'https://x.com/claudeai/status/2064394146916229443',
        timestamp: new Date(),
        isOutgoing: false,
      })
      // Our own reaction, stashed as a placeholder while the key was locked
      // (self-outgoing MAM replay: from === own bare JID).
      chatStore.getState().addMessage({
        type: 'chat',
        id: 'reaction-ghost',
        conversationId: 'bob@example.com',
        from: 'me@example.com',
        body: '[Encrypted message: could not decrypt]',
        timestamp: new Date(),
        isOutgoing: true,
        encryptedPayload: DUMMY_PAYLOAD_XML,
      })

      await xmppClient.retryPendingDecrypts()

      const messages = chatStore.getState().messages.get('bob@example.com') ?? []
      // The 👍 must land on the target message.
      const target = messages.find((m) => m.id === 'xcom-msg')
      expect(target?.reactions).toEqual({ '👍': ['me@example.com'] })
      // The placeholder must not linger as a ghost "could not decrypt" bubble.
      const ghost = messages.find((m) => m.id === 'reaction-ghost')
      expect(ghost).toBeUndefined()
    })
  })
})
