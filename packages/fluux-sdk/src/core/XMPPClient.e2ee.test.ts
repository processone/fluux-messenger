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
  updateMessageReactions: vi.fn().mockResolvedValue(false),
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
  E2EEPluginError,
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

    it('refreshes the sidebar preview when the durable-decrypted message is the conversation lastMessage', async () => {
      // Reported bug: the key is unlocked while a conversation is NOT open, so its
      // last message is decrypted via the durable cache only. The bubble shows the
      // cleartext on open, but the sidebar preview stayed "[OpenPGP-encrypted
      // message]" because nothing refreshed the in-memory lastMessage.
      vi.spyOn(manager, 'decryptArchive').mockResolvedValue({
        plaintext: new TextEncoder().encode('hello'),
        senderDevice: { jid: 'carol@example.com', deviceId: 'test' },
        securityContext: { protocolId: 'dummy-plaintext', trust: 'verified' },
      })

      const encryptedPreview = {
        type: 'chat' as const,
        id: 'durable-preview-1',
        conversationId: 'carol@example.com',
        from: 'carol@example.com',
        body: '[OpenPGP-encrypted message]',
        timestamp: new Date('2026-06-13T18:48:00Z'),
        isOutgoing: false,
        encryptedPayload: DUMMY_PAYLOAD_XML,
      }

      // Conversation is in the sidebar (preview = the encrypted message) but its
      // messages are NOT loaded — the ciphertext lives only in the durable cache.
      chatStore.getState().addConversation({
        id: 'carol@example.com',
        name: 'Carol',
        type: 'chat',
        lastMessage: encryptedPreview,
        unreadCount: 1,
      })
      vi.mocked(messageCache.getMessagesWithEncryptedPayload).mockResolvedValue([encryptedPreview])

      await xmppClient.retryPendingDecrypts()

      const conv = chatStore.getState().conversations.get('carol@example.com')
      expect(conv?.lastMessage?.body).toBe('hello')
      expect(conv?.lastMessage?.encryptedPayload).toBeUndefined()
      // The metadata map (what the sidebar subscribes to) is healed too.
      expect(chatStore.getState().conversationMeta.get('carol@example.com')?.lastMessage?.body).toBe('hello')
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

    it('clears the phantom unread badge when a deferred inbound reaction is dropped', async () => {
      // The user-facing bug: an INBOUND encrypted reaction that arrives
      // undecryptable during catch-up is stored as a placeholder and counted as
      // unread (nothing yet knows it is a reaction). When the deferred decrypt
      // later reveals it was a reaction and drops the placeholder, the unread
      // badge it inflated must drop too — otherwise the conversation shows a
      // notification with nothing new to read.
      const reactionEnvelope =
        `<payload xmlns="jabber:client">` +
        `<reactions xmlns="urn:xmpp:reactions:0" id="read-msg"><reaction>👍</reaction></reactions>` +
        `</payload>`
      vi.spyOn(manager, 'decryptArchive').mockResolvedValue({
        plaintext: new TextEncoder().encode(reactionEnvelope),
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
      // A message the user has already read — the reaction targets it.
      chatStore.getState().addMessage({
        type: 'chat',
        id: 'read-msg',
        conversationId: 'bob@example.com',
        from: 'bob@example.com',
        body: 'already read',
        timestamp: new Date('2026-06-10T00:00:00Z'),
        isOutgoing: false,
      })
      // A genuinely-unread incoming message.
      chatStore.getState().addMessage({
        type: 'chat',
        id: 'real-unread',
        conversationId: 'bob@example.com',
        from: 'bob@example.com',
        body: 'genuinely new',
        timestamp: new Date('2026-06-10T00:01:00Z'),
        isOutgoing: false,
      })
      // Bob's reaction, stashed as an inbound placeholder while the key was locked.
      chatStore.getState().addMessage({
        type: 'chat',
        id: 'reaction-ghost',
        conversationId: 'bob@example.com',
        from: 'bob@example.com',
        body: '[Encrypted message: could not decrypt]',
        timestamp: new Date('2026-06-10T00:02:00Z'),
        isOutgoing: false,
        encryptedPayload: DUMMY_PAYLOAD_XML,
      })
      // Model the catch-up state: read pointer at 'read-msg', with the two later
      // incoming messages (the real one + the phantom reaction) counted as unread.
      chatStore.setState((s) => {
        const conversationMeta = new Map(s.conversationMeta)
        conversationMeta.set('bob@example.com', {
          ...conversationMeta.get('bob@example.com')!,
          unreadCount: 2,
          readPointer: { messageId: 'read-msg', timestamp: new Date('2026-06-10T00:00:00Z') },
        })
        const conversations = new Map(s.conversations)
        conversations.set('bob@example.com', {
          ...conversations.get('bob@example.com')!,
          unreadCount: 2,
          readPointer: { messageId: 'read-msg', timestamp: new Date('2026-06-10T00:00:00Z') },
        })
        return { conversationMeta, conversations, activeConversationId: null }
      })

      await xmppClient.retryPendingDecrypts()

      const messages = chatStore.getState().messages.get('bob@example.com') ?? []
      // The reaction landed and the placeholder is gone.
      expect(messages.find((m) => m.id === 'read-msg')?.reactions).toEqual({ '👍': ['bob@example.com'] })
      expect(messages.find((m) => m.id === 'reaction-ghost')).toBeUndefined()
      // The phantom unread is gone — only the genuinely-unread message counts.
      expect(chatStore.getState().conversationMeta.get('bob@example.com')?.unreadCount).toBe(1)
    })

    it('applies a deferred-decrypted retraction to its target and drops the placeholder', async () => {
      // Retractions are the sibling of reactions: sendRetraction keeps an outer
      // fallback body, but the <retract> element itself is bodiless inside the
      // payload, so a deferred decrypt surfaces it with no <body> — the same
      // code path that dropped reactions.
      const retractEnvelope =
        `<payload xmlns="jabber:client">` +
        `<retract xmlns="urn:xmpp:message-retract:1" id="spam-msg"/>` +
        `</payload>`
      vi.spyOn(manager, 'decryptArchive').mockResolvedValue({
        plaintext: new TextEncoder().encode(retractEnvelope),
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
      // The message Bob later retracted — still visible until the retract applies.
      chatStore.getState().addMessage({
        type: 'chat',
        id: 'spam-msg',
        conversationId: 'bob@example.com',
        from: 'bob@example.com',
        body: 'oops wrong chat',
        timestamp: new Date(),
        isOutgoing: false,
      })
      // Bob's retraction, stashed as a placeholder while the key was locked.
      chatStore.getState().addMessage({
        type: 'chat',
        id: 'retract-ghost',
        conversationId: 'bob@example.com',
        from: 'bob@example.com',
        body: '[Encrypted message: could not decrypt]',
        timestamp: new Date(),
        isOutgoing: false,
        encryptedPayload: DUMMY_PAYLOAD_XML,
      })

      await xmppClient.retryPendingDecrypts()

      const messages = chatStore.getState().messages.get('bob@example.com') ?? []
      // The target must now be marked retracted (only its author may retract it).
      const target = messages.find((m) => m.id === 'spam-msg')
      expect(target?.isRetracted).toBe(true)
      // The placeholder must not linger.
      const ghost = messages.find((m) => m.id === 'retract-ghost')
      expect(ghost).toBeUndefined()
    })

    it('drops the placeholder for a deferred reaction whose signature is rejected on retry', async () => {
      // A bodiless reaction stashed while the key was locked. On unlock the
      // signature turns out to be invalid (forged) — we must not surface a
      // ghost "[Message rejected]" bubble for a reaction the user can't see.
      vi.spyOn(manager, 'decryptArchive').mockRejectedValue(
        new E2EEPluginError('permanent', 'signature-failed', 'forged signature'),
      )

      chatStore.getState().addConversation({
        id: 'bob@example.com',
        name: 'Bob',
        type: 'chat',
        lastMessage: undefined,
        unreadCount: 0,
      })
      chatStore.getState().addMessage({
        type: 'chat',
        id: 'reaction-ghost',
        conversationId: 'bob@example.com',
        from: 'bob@example.com',
        body: '[Encrypted message: could not decrypt]',
        timestamp: new Date(),
        isOutgoing: false,
        encryptedPayload: DUMMY_PAYLOAD_XML,
      })

      await xmppClient.retryPendingDecrypts()

      const messages = chatStore.getState().messages.get('bob@example.com') ?? []
      const ghost = messages.find((m) => m.id === 'reaction-ghost')
      expect(ghost).toBeUndefined()
    })

    it('marks a deferred *message* whose signature is rejected on retry as [Message rejected]', async () => {
      // Regression guard: a real message placeholder (fallback body, not the
      // "could not decrypt" marker) must still warn the user, not vanish.
      vi.spyOn(manager, 'decryptArchive').mockRejectedValue(
        new E2EEPluginError('permanent', 'signature-failed', 'forged signature'),
      )

      chatStore.getState().addConversation({
        id: 'bob@example.com',
        name: 'Bob',
        type: 'chat',
        lastMessage: undefined,
        unreadCount: 0,
      })
      chatStore.getState().addMessage({
        type: 'chat',
        id: 'msg-pending',
        conversationId: 'bob@example.com',
        from: 'bob@example.com',
        body: '[encrypted message]',
        timestamp: new Date(),
        isOutgoing: false,
        encryptedPayload: DUMMY_PAYLOAD_XML,
      })

      await xmppClient.retryPendingDecrypts()

      const messages = chatStore.getState().messages.get('bob@example.com') ?? []
      const msg = messages.find((m) => m.id === 'msg-pending')
      expect(msg).toBeDefined()
      expect(msg?.body).toBe('[Message rejected: invalid signature]')
      expect(msg?.encryptedPayload).toBeUndefined()
    })
  })

  describe('deferred-decrypt of an encrypted correction', () => {
    // End-to-end counterpart to the MAM-side fix: a message corrected while
    // the key was locked is stored with the sender's hint body, isEdited=true,
    // and — crucially — the CORRECTION stanza's ciphertext as encryptedPayload
    // (stamped by applyModifications / emitUnresolved*). retryPendingDecrypts
    // must surface the corrected plaintext, not leave it frozen on the hint,
    // while preserving the edit markers it must not own.
    const CORRECTED_TEXT = 'corrected after unlock'
    const CORRECTION_STANZA =
      `<message from="bob@example.com/web" to="me@example.com" type="chat" id="corr-1">` +
      `<replace xmlns="urn:xmpp:message-correct:0" id="orig-1"/>` +
      `<body>[OpenPGP-encrypted message]</body>` +
      `<plain xmlns="urn:fluux:e2ee-dummy:0">${Buffer.from(CORRECTED_TEXT).toString('base64')}</plain>` +
      `<encryption xmlns="urn:xmpp:eme:0" namespace="urn:fluux:e2ee-dummy:0"/>` +
      `</message>`

    it('recovers the corrected text and keeps the edit markers', async () => {
      // Decrypt now succeeds with a verified signature (key unlocked / peer
      // key cached), so the retry is not deferred again for re-verification.
      vi.spyOn(manager, 'decryptArchive').mockResolvedValue({
        plaintext: new TextEncoder().encode(CORRECTED_TEXT),
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
      // The target message as it sits after a deferred correction was applied:
      // edited, hint body, carrying the correction's ciphertext for retry.
      chatStore.getState().addMessage({
        type: 'chat',
        id: 'orig-1',
        conversationId: 'bob@example.com',
        from: 'bob@example.com',
        body: '[OpenPGP-encrypted message]',
        timestamp: new Date(),
        isOutgoing: false,
        isEdited: true,
        originalBody: 'the original text',
        encryptedPayload: CORRECTION_STANZA,
      })

      await xmppClient.retryPendingDecrypts()

      const msg = (chatStore.getState().messages.get('bob@example.com') ?? []).find((m) => m.id === 'orig-1')
      expect(msg?.body).toBe(CORRECTED_TEXT)
      // The retry owns the body, not the edit state: those must survive.
      expect(msg?.isEdited).toBe(true)
      expect(msg?.originalBody).toBe('the original text')
      expect(msg?.encryptedPayload).toBeUndefined()
    })
  })

  describe('concurrent-retry coalescing', () => {
    // Regression guard: on a fresh web session two triggers fire close
    // together — plugin-registration (key still locked) and key-unlocked
    // (passphrase entered). The unlock retry used to hit the re-entrancy
    // guard while the registration pass was still in flight and return 0,
    // silently dropping the work. The user saw "entered passphrase, nothing
    // decrypted" and had to re-enter the passphrase to get a non-colliding
    // retry. A retry requested mid-pass must instead run a second full pass
    // after the first completes.
    const flush = () => new Promise((r) => setTimeout(r, 0))

    it('runs a second pass when a retry is requested while one is in flight', async () => {
      // Sibling durable-cache tests override this mock and afterEach only
      // clearAllMocks() (which keeps mockResolvedValue implementations), so
      // pin the durable pass to empty here for isolation.
      vi.mocked(messageCache.getMessagesWithEncryptedPayload).mockResolvedValue([])

      chatStore.getState().addConversation({
        id: 'alice@example.com',
        name: 'Alice',
        type: 'chat',
        lastMessage: undefined,
        unreadCount: 0,
      })
      // Message stays pending across passes, so it remains eligible and we
      // can count how many full passes touched it.
      chatStore.getState().addMessage({
        type: 'chat',
        id: 'pending-1',
        conversationId: 'alice@example.com',
        from: 'alice@example.com',
        body: '[could not decrypt]',
        timestamp: new Date(),
        isOutgoing: false,
        encryptedPayload: DUMMY_PAYLOAD_XML,
      })

      // Gate the first pass inside its decrypt collaborator so a second
      // retry is requested while pass #1 is still running.
      let releaseGate!: () => void
      const gate = new Promise<void>((resolve) => {
        releaseGate = resolve
      })
      let passes = 0
      // The deferred-decrypt engine owns the per-payload decrypt now; gate it
      // there so a second retry is requested while pass #1 is still parked.
      ;(xmppClient as unknown as { deferredDecrypt: { decryptSingle: () => Promise<unknown> } })
        .deferredDecrypt.decryptSingle =
        vi.fn(async () => {
          passes++
          if (passes === 1) await gate
          return { kind: 'pending' as const }
        })

      const inFlight = xmppClient.retryPendingDecrypts()
      await flush() // let pass #1 park on the gate

      // Second trigger arrives while pass #1 is still running.
      await xmppClient.retryPendingDecrypts()

      releaseGate()
      await inFlight
      await flush() // let the coalesced re-run execute
      await flush()

      expect(passes).toBe(2)
    })
  })

  describe('key-unlocked wiring (ensureE2EEManager)', () => {
    it('decrypts a stashed message when the plugin signals notifyKeyUnlocked()', async () => {
      // End-to-end guard for the centralized restore→retry trigger. Build the
      // manager through the REAL XMPPClient path (ensureE2EEManager, which
      // wires onKeyUnlocked) rather than the hand-attached manager used by the
      // other tests, then have the plugin fire ctx.notifyKeyUnlocked() — the
      // signal a key restore/unlock emits — and assert the stashed message
      // actually decrypts. Covers the links the per-unit tests leave un-joined:
      // manager.onKeyUnlocked → notifyE2EEKeyUnlocked → retryPendingDecrypts.
      const client = new XMPPClient({ debug: false })
      ;(client as unknown as { currentJid: string }).currentJid = 'me@example.com/web'
      ;(client as unknown as { ensureE2EEManager: () => void }).ensureE2EEManager()
      const plugin = new DummyPlaintextPlugin()
      await client.e2ee!.register(plugin)
      const ctx = (plugin as unknown as { ctx: { notifyKeyUnlocked?: () => void } }).ctx

      // DummyPlaintextPlugin decrypts to trust:'untrusted', which re-stashes
      // for deferred verification instead of committing. Mock decryptArchive to
      // return 'verified' so the retry commits the body — the wiring is what
      // this test exercises, not the crypto (covered by stanzaDecrypt tests).
      vi.spyOn(client.e2ee!, 'decryptArchive').mockResolvedValue({
        plaintext: new TextEncoder().encode('hello'),
        senderDevice: { jid: 'carol@example.com', deviceId: 'test' },
        securityContext: { protocolId: 'dummy-plaintext', trust: 'verified' },
      })

      chatStore.getState().addConversation({
        id: 'carol@example.com',
        name: 'Carol',
        type: 'chat',
        lastMessage: undefined,
        unreadCount: 0,
      })
      chatStore.getState().addMessage({
        type: 'chat',
        id: 'msg-stashed-until-unlock',
        conversationId: 'carol@example.com',
        from: 'carol@example.com',
        body: '[Encrypted message: could not decrypt]',
        timestamp: new Date(),
        isOutgoing: false,
        encryptedPayload: DUMMY_PAYLOAD_XML,
      })

      // notifyE2EEKeyUnlocked fires retryPendingDecrypts fire-and-forget (and is
      // double-triggered via the e2ee:key-unlocked event — the coalescing guard
      // dedupes it). Spy to prove the unlock kicked off the retry, then await
      // every pass it started so the decrypt settles before asserting.
      const retrySpy = vi.spyOn(client, 'retryPendingDecrypts')
      ctx.notifyKeyUnlocked?.()
      expect(retrySpy).toHaveBeenCalled() // the wiring fired
      await Promise.all(retrySpy.mock.results.map((r) => Promise.resolve(r.value)))

      const msg = (chatStore.getState().messages.get('carol@example.com') ?? []).find(
        (m) => m.id === 'msg-stashed-until-unlock',
      )
      expect(msg?.body).toBe('hello')
      expect(msg?.encryptedPayload).toBeUndefined()
    })
  })
})
