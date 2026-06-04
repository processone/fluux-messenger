/**
 * Integration tests for the E2EE wiring in the Chat module.
 *
 * These exercise the full encrypt-on-send / decrypt-on-receive path with the
 * real @xmpp/client builder (no mocking) plus the {@link DummyPlaintextPlugin},
 * so we cover stanza construction, claim routing, and async decrypt-reprocess.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { xml } from '@xmpp/client'
import type { Element } from '@xmpp/client'
import { Chat } from './Chat'
import type { MAM } from './MAM'
import type { ModuleDependencies } from './BaseModule'
import {
  E2EEEncryptionRequiredError,
  E2EEPluginError,
  E2EEManager,
  InMemoryStorageBackend,
  type XMPPPrimitives,
} from '../e2ee'
import { DummyPlaintextPlugin } from '../e2ee/DummyPlaintextPlugin'
import type {
  BareJID,
  ConversationHandle,
  ConversationTarget,
  DecryptResult,
  E2EEPlugin,
  E2EEProtocolDescriptor,
  EncryptedPayload,
  IdentityInfo,
  PeerSupport,
  PluginContext,
  TrustState,
  VerificationFlow,
  VerificationMethod,
  XMLElementData,
} from '../e2ee/types'

const OX_NS = 'urn:xmpp:openpgp:0'

/**
 * Minimal plugin that claims <openpgp xmlns='urn:xmpp:openpgp:0'> elements
 * and decrypts them to a fixed plaintext. Used to exercise the re-entry path
 * after successful OpenPGP decryption without pulling in real crypto.
 */
class FakeOpenPGPPlugin implements E2EEPlugin {
  readonly descriptor: E2EEProtocolDescriptor = {
    id: 'openpgp',
    displayName: 'OpenPGP (fake)',
    securityLevel: 30,
    features: {
      forwardSecrecy: false,
      postCompromiseSecurity: false,
      multiDevice: true,
      groupChat: false,
      asynchronous: true,
      deniability: false,
    },
  }

  async init(_ctx: PluginContext): Promise<void> {}
  async shutdown(): Promise<void> {}
  async ensureIdentity(): Promise<IdentityInfo> { return { fingerprint: 'fake:fp' } }
  async probePeer(_peer: BareJID): Promise<PeerSupport> { return { supported: true, ttl: 60 } }
  async openConversation(_target: ConversationTarget): Promise<ConversationHandle> {
    return { protocolId: this.descriptor.id, state: {} }
  }
  async closeConversation(_handle: ConversationHandle): Promise<void> {}
  async encrypt(_handle: ConversationHandle, plaintext: Uint8Array): Promise<EncryptedPayload> {
    return {
      protocolId: this.descriptor.id,
      stanzaElement: { name: 'openpgp', attrs: { xmlns: OX_NS }, children: [Buffer.from(plaintext).toString('base64')] },
      fallbackBody: '[OpenPGP-encrypted message]',
    }
  }
  async decrypt(_handle: ConversationHandle, payload: EncryptedPayload): Promise<DecryptResult> {
    const encoded = payload.stanzaElement.children[0] as string
    return {
      plaintext: Buffer.from(encoded, 'base64'),
      senderDevice: { jid: 'peer@example.com', deviceId: 'fake:fp' },
      securityContext: { protocolId: this.descriptor.id, trust: 'verified' },
    }
  }
  tryClaimInbound(child: XMLElementData): EncryptedPayload | null {
    if (child.name !== 'openpgp') return null
    if (child.attrs?.xmlns !== OX_NS) return null
    return { protocolId: this.descriptor.id, stanzaElement: child }
  }
  getVerificationMethods(): VerificationMethod[] { return [] }
  async startVerification(_peer: BareJID, _method: VerificationMethod): Promise<VerificationFlow> {
    throw new Error('not supported')
  }
  async getPeerTrust(_peer: BareJID): Promise<TrustState> { return 'verified' }
  async getDeviceTrust(_peer: BareJID, _deviceId: string): Promise<TrustState> { return 'verified' }
}

function stubXmppPrimitives(sendStanza: (el: Element) => Promise<void>): XMPPPrimitives {
  return {
    sendStanza: async (data) => {
      // Not used by the dummy plugin, but we keep a working impl for safety.
      void data
      void sendStanza
    },
    queryDisco: async () => ({ features: [], identities: [] }),
    publishPEP: async () => {},
    retractPEP: async () => {},
    deletePEP: async () => {},
    queryPEP: async () => [],
    subscribePEP: () => ({ unsubscribe: () => {} }),
  }
}

function stubMAM(): MAM {
  // Chat only calls .markDequeued / event collectors defensively in the paths we
  // exercise here. An empty object cast is enough for the happy path.
  return {} as unknown as MAM
}

/** Build a minimal ModuleDependencies wired to capture sendStanza calls. */
function makeDeps(options: {
  jid: string
  manager: E2EEManager
  captureStanza: (el: Element) => void
}): { deps: ModuleDependencies; emitted: unknown[]; sdkEmitted: unknown[] } {
  const emitted: unknown[] = []
  const sdkEmitted: unknown[] = []
  const deps: ModuleDependencies = {
    stores: null,
    sendStanza: async (stanza) => {
      options.captureStanza(stanza)
    },
    sendIQ: async () => xml('iq', {}) as Element,
    getCurrentJid: () => options.jid,
    emit: (event, ...args) => {
      emitted.push({ event, args })
    },
    emitSDK: (event, payload) => {
      sdkEmitted.push({ event, payload })
    },
    getXmpp: () => null,
    getE2EEManager: () => options.manager,
  }
  return { deps, emitted, sdkEmitted }
}

async function makeManagerWithDummyPlugin(selfJid: string): Promise<E2EEManager> {
  const manager = new E2EEManager({
    storage: new InMemoryStorageBackend(),
    xmpp: stubXmppPrimitives(async () => {}),
    account: { jid: selfJid },
  })
  await manager.register(new DummyPlaintextPlugin())
  return manager
}

describe('Chat E2EE wiring', () => {
  let captured: Element[]
  let manager: E2EEManager
  let chat: Chat
  let sdkEmitted: unknown[]

  beforeEach(async () => {
    captured = []
    manager = await makeManagerWithDummyPlugin('me@example.com')
    const built = makeDeps({
      jid: 'me@example.com',
      manager,
      captureStanza: (el) => captured.push(el),
    })
    sdkEmitted = built.sdkEmitted
    chat = new Chat(built.deps, stubMAM())
  })

  describe('outbound encryption', () => {
    it('replaces <body> with fallback and appends the plugin element, EME, and store hint', async () => {
      await chat.sendMessage('bob@example.com', 'Hello, Bob!')

      expect(captured).toHaveLength(1)
      const sent = captured[0]

      // Body is now the plugin-supplied fallback, not the plaintext.
      const body = sent.getChild('body')
      expect(body?.text()).not.toContain('Hello, Bob!')
      expect(body?.text()).toBe('[dummy-plaintext payload]')

      // Encrypted element from the dummy plugin.
      const enc = sent.getChild('plain', 'urn:fluux:e2ee-dummy:0')
      expect(enc).toBeDefined()
      expect(enc?.text().length).toBeGreaterThan(0)

      // XEP-0380 EME.
      const eme = sent.getChild('encryption', 'urn:xmpp:eme:0')
      expect(eme?.attrs.namespace).toBe('urn:fluux:e2ee-dummy:0')

      // XEP-0334 store hint.
      const store = sent.getChild('store', 'urn:xmpp:hints')
      expect(store).toBeDefined()
    })

    it('sends plaintext when no plugin is registered', async () => {
      // Fresh manager with no plugins.
      const emptyManager = new E2EEManager({
        storage: new InMemoryStorageBackend(),
        xmpp: stubXmppPrimitives(async () => {}),
        account: { jid: 'me@example.com' },
      })
      const { deps } = makeDeps({
        jid: 'me@example.com',
        manager: emptyManager,
        captureStanza: (el) => captured.push(el),
      })
      const plainChat = new Chat(deps, stubMAM())

      await plainChat.sendMessage('bob@example.com', 'Hello plaintext')

      const sent = captured[0]
      expect(sent.getChild('body')?.text()).toBe('Hello plaintext')
      expect(sent.getChild('plain', 'urn:fluux:e2ee-dummy:0')).toBeUndefined()
      expect(sent.getChild('encryption', 'urn:xmpp:eme:0')).toBeUndefined()
    })

    it('sends plaintext for groupchat messages (MUC encryption is a later phase)', async () => {
      await chat.sendMessage('room@muc.example.com', 'hi room', 'groupchat')

      const sent = captured[0]
      expect(sent.getChild('body')?.text()).toBe('hi room')
      expect(sent.getChild('plain', 'urn:fluux:e2ee-dummy:0')).toBeUndefined()
    })

    it('removes <fallback for="jabber:x:oob"> from outer stanza when E2EE is active', async () => {
      // Regression: <fallback for="jabber:x:oob"> in the unencrypted stanza root
      // reveals to the XMPP server that an attachment was sent and its URL length.
      // It must be stripped after the OOB element is moved inside the encrypted payload.
      await chat.sendMessage('bob@example.com', 'Check this file', 'chat', undefined, undefined, {
        url: 'https://upload.example.com/file.bin',
        name: 'photo.jpg',
        mediaType: 'image/jpeg',
        encryption: {
          cipher: 'aes-256-gcm',
          key: new Uint8Array(32).fill(1),
          iv: new Uint8Array(12).fill(2),
        },
      })

      expect(captured).toHaveLength(1)
      const sent = captured[0]

      // OOB fallback must not leak attachment presence to the server
      const oobFallback = sent.getChildren('fallback', 'urn:xmpp:fallback:0').find(
        (el) => el.attrs?.for === 'jabber:x:oob',
      )
      expect(oobFallback).toBeUndefined()

      // The OOB element must also be absent from the outer stanza (encrypted inside payload)
      expect(sent.getChild('x', 'jabber:x:oob')).toBeUndefined()
    })

    it('preserves <fallback for="urn:xmpp:reply:0"> when OOB fallback is removed', async () => {
      // Removing the OOB fallback must be surgical — unrelated fallbacks (e.g. reply
      // quote for legacy clients) must not be collateral damage.
      await chat.sendMessage(
        'bob@example.com',
        'Nice photo!',
        'chat',
        { id: 'orig-msg-id', to: 'bob@example.com', fallback: { author: 'Bob', body: 'seen this?' } },
        undefined,
        {
          url: 'https://upload.example.com/reply.bin',
          name: 'reply.jpg',
          mediaType: 'image/jpeg',
          encryption: {
            cipher: 'aes-256-gcm',
            key: new Uint8Array(32).fill(3),
            iv: new Uint8Array(12).fill(4),
          },
        },
      )

      const sent = captured[0]

      // OOB fallback stripped — attachment presence hidden
      const oobFallback = sent.getChildren('fallback', 'urn:xmpp:fallback:0').find(
        (el) => el.attrs?.for === 'jabber:x:oob',
      )
      expect(oobFallback).toBeUndefined()

      // Reply fallback preserved — legacy clients still need it for reply display
      const replyFallback = sent.getChildren('fallback', 'urn:xmpp:fallback:0').find(
        (el) => el.attrs?.for === 'urn:xmpp:reply:0',
      )
      expect(replyFallback).toBeDefined()
    })

    it('preserves <fallback for="jabber:x:oob"> when no E2EE plugin is registered', async () => {
      // Without E2EE the OOB fallback is the legitimate interop mechanism for
      // legacy clients. It must stay untouched.
      const emptyManager = new E2EEManager({
        storage: new InMemoryStorageBackend(),
        xmpp: stubXmppPrimitives(async () => {}),
        account: { jid: 'me@example.com' },
      })
      const { deps } = makeDeps({
        jid: 'me@example.com',
        manager: emptyManager,
        captureStanza: (el) => captured.push(el),
      })
      const plainChat = new Chat(deps, stubMAM())

      await plainChat.sendMessage('bob@example.com', 'Check this', 'chat', undefined, undefined, {
        url: 'https://upload.example.com/plain.jpg',
        name: 'plain.jpg',
        mediaType: 'image/jpeg',
      })

      const sent = captured[0]

      // Fallback present — interop for non-OOB clients
      const oobFallback = sent.getChildren('fallback', 'urn:xmpp:fallback:0').find(
        (el) => el.attrs?.for === 'jabber:x:oob',
      )
      expect(oobFallback).toBeDefined()

      // OOB element also present on the outer stanza
      expect(sent.getChild('x', 'jabber:x:oob')).toBeDefined()
    })

    it('strict policy throws E2EEEncryptionRequiredError instead of silent plaintext', async () => {
      // Empty manager — no plugin will claim the recipient, so
      // encryptOutbound returns null. Strict policy must surface that.
      const strictManager = new E2EEManager({
        storage: new InMemoryStorageBackend(),
        xmpp: stubXmppPrimitives(async () => {}),
        account: { jid: 'me@example.com' },
      })
      strictManager.setSendPolicy('strict')
      const { deps } = makeDeps({
        jid: 'me@example.com',
        manager: strictManager,
        captureStanza: (el) => captured.push(el),
      })
      const strictChat = new Chat(deps, stubMAM())

      await expect(
        strictChat.sendMessage('bob@example.com', 'secret'),
      ).rejects.toBeInstanceOf(E2EEEncryptionRequiredError)

      // Critically: nothing was sent to the wire.
      expect(captured).toHaveLength(0)
    })

    it('blocks the send (no plaintext) when a selected plugin throws pin-mismatch', async () => {
      // A plugin is registered (dummy), so encryptOutbound reaches encrypt().
      // Simulate the OpenPGP pin-mismatch failure: encryption was expected for
      // this peer, so the message must NOT fall back to cleartext.
      vi.spyOn(manager, 'encryptOutbound').mockRejectedValue(
        new E2EEPluginError('permanent', 'pin-mismatch', 'fingerprint changed'),
      )

      await expect(chat.sendMessage('bob@example.com', 'secret')).rejects.toBeInstanceOf(
        E2EEPluginError,
      )
      expect(captured).toHaveLength(0)
    })

    it('blocks the send when a selected plugin throws key-locked (transient)', async () => {
      // Transient failure (e.g. key requires passphrase): same no-plaintext guarantee applies.
      vi.spyOn(manager, 'encryptOutbound').mockRejectedValue(
        new E2EEPluginError('transient', 'key-locked', 'key is locked'),
      )

      await expect(chat.sendMessage('bob@example.com', 'secret')).rejects.toBeInstanceOf(
        E2EEPluginError,
      )
      expect(captured).toHaveLength(0)
    })

    it('throws when E2EE fails and attachment carries an aesgcm key (permissive mode)', async () => {
      // Permissive mode + no plugin registered → encryptOutbound returns null.
      // The attachment has an AES-GCM key embedded in its aesgcm:// URL, so
      // sending plaintext would expose that key to the server. The guard must
      // abort even though the policy is permissive.
      const emptyManager = new E2EEManager({
        storage: new InMemoryStorageBackend(),
        xmpp: stubXmppPrimitives(async () => {}),
        account: { jid: 'me@example.com' },
      })
      const { deps } = makeDeps({
        jid: 'me@example.com',
        manager: emptyManager,
        captureStanza: (el) => captured.push(el),
      })
      const guardedChat = new Chat(deps, stubMAM())

      await expect(
        guardedChat.sendMessage('bob@example.com', 'secret photo', 'chat', undefined, undefined, {
          url: 'https://upload.example.com/photo.bin',
          name: 'photo.jpg',
          mediaType: 'image/jpeg',
          encryption: {
            cipher: 'aes-256-gcm',
            key: new Uint8Array(32).fill(1),
            iv: new Uint8Array(12).fill(2),
          },
        }),
      ).rejects.toBeInstanceOf(E2EEEncryptionRequiredError)

      expect(captured).toHaveLength(0)
    })

    it('sends normally when attachment has no encryption metadata and E2EE is absent', async () => {
      // Plain attachment without encryption: aesgcm guard must not fire.
      const emptyManager = new E2EEManager({
        storage: new InMemoryStorageBackend(),
        xmpp: stubXmppPrimitives(async () => {}),
        account: { jid: 'me@example.com' },
      })
      const { deps } = makeDeps({
        jid: 'me@example.com',
        manager: emptyManager,
        captureStanza: (el) => captured.push(el),
      })
      const plainChat = new Chat(deps, stubMAM())

      await plainChat.sendMessage('bob@example.com', 'here is the file', 'chat', undefined, undefined, {
        url: 'https://upload.example.com/plain.jpg',
        name: 'plain.jpg',
        mediaType: 'image/jpeg',
      })

      expect(captured).toHaveLength(1)
      expect(captured[0].getChild('x', 'jabber:x:oob')).toBeDefined()
    })
  })

  describe('inbound decryption', () => {
    it('decrypts an incoming encrypted message and emits the plaintext', async () => {
      // First, produce a real encrypted stanza by sending one.
      await chat.sendMessage('bob@example.com', 'Hello back')
      const outgoing = captured[0]

      // Now fabricate the inbound stanza as if it came from Bob.
      const inbound = xml(
        'message',
        { from: 'bob@example.com/resource', to: 'me@example.com', type: 'chat', id: 'm-1' },
        ...outgoing.children.filter((c) => {
          if (typeof c === 'string') return true
          // Keep everything except chatstate active (not relevant) so this looks
          // like a natural received message.
          return c.name !== 'active'
        }),
      )

      // Capture the emitted message.
      const emittedMessages: Array<{ body: string }> = []
      const { deps } = makeDeps({
        jid: 'me@example.com',
        manager,
        captureStanza: () => {},
      })
      deps.emit = (event, ...args) => {
        if (event === 'message') emittedMessages.push(args[0] as { body: string })
      }
      const rxChat = new Chat(deps, stubMAM())

      const handled = rxChat.handle(inbound)
      expect(handled).toBe(true)

      // handleMessageInternal fires the async decrypt; give the microtask queue
      // a tick to drain.
      await new Promise((r) => setTimeout(r, 0))

      expect(emittedMessages).toHaveLength(1)
      expect(emittedMessages[0].body).toBe('Hello back')
    })

    it('falls through to plaintext processing when no plugin claims the element', async () => {
      const inbound = xml(
        'message',
        { from: 'bob@example.com/r', to: 'me@example.com', type: 'chat', id: 'm-2' },
        xml('body', {}, 'plain body'),
      )

      const emittedMessages: Array<{ body: string }> = []
      const { deps } = makeDeps({
        jid: 'me@example.com',
        manager,
        captureStanza: () => {},
      })
      deps.emit = (event, ...args) => {
        if (event === 'message') emittedMessages.push(args[0] as { body: string })
      }
      const rxChat = new Chat(deps, stubMAM())

      rxChat.handle(inbound)
      await new Promise((r) => setTimeout(r, 0))

      expect(emittedMessages).toHaveLength(1)
      expect(emittedMessages[0].body).toBe('plain body')
    })

    it('does not re-enter the decrypt path on the synthetic second pass', async () => {
      const spy = vi.spyOn(manager, 'decryptInbound')
      await chat.sendMessage('bob@example.com', 'round trip test')
      const outgoing = captured[0]

      const inbound = xml(
        'message',
        { from: 'bob@example.com/r', to: 'me@example.com', type: 'chat', id: 'm-3' },
        ...outgoing.children.filter((c) => typeof c === 'string' || c.name !== 'active'),
      )

      chat.handle(inbound)
      await new Promise((r) => setTimeout(r, 0))

      // Manager.decryptInbound should be called exactly once — not on the
      // re-dispatched synthetic pass.
      expect(spy).toHaveBeenCalledTimes(1)
    })

    it('does NOT set isSelfOutgoing for a received encrypted message (regression guard)', async () => {
      // The isSelfOutgoing flag must be tightly scoped — flipping it on a
      // received message would invert the reflection check on Bob's
      // incoming traffic and tell the plugin to verify signatures with
      // OUR own key (which Bob didn't sign with). Both would be silent
      // security holes. This guards against accidentally flipping the
      // flag for normal inbound stanzas.
      const spy = vi.spyOn(manager, 'decryptInbound')

      // Produce a real encrypted stanza by sending one, then re-cast it
      // as an inbound message from Bob.
      await chat.sendMessage('bob@example.com', 'hello back')
      const outgoing = captured[0]
      captured.length = 0

      const inbound = xml(
        'message',
        { from: 'bob@example.com/r', to: 'me@example.com', type: 'chat', id: 'm-inbound' },
        ...outgoing.children.filter((c) => typeof c === 'string' || c.name !== 'active'),
      )

      const rxChat = chat
      rxChat.handle(inbound)
      await new Promise((r) => setTimeout(r, 0))

      expect(spy).toHaveBeenCalledTimes(1)
      const [, senderTarget, context] = spy.mock.calls[0]
      expect(senderTarget).toEqual({ kind: 'direct', peer: 'bob@example.com' })
      // Critical: undefined OR explicitly false — never true.
      expect(context?.isSelfOutgoing).not.toBe(true)
    })

    it('does NOT set isSelfOutgoing for a received <received> carbon (Bob → us via our other device)', async () => {
      // A `<received>` carbon is a copy of an INCOMING message from a
      // peer, delivered to a sibling device. The original sender is the
      // peer (not us) — so the inverted reflection check would be wrong
      // and the signature verification key must be the peer's, not ours.
      const spy = vi.spyOn(manager, 'decryptInbound')

      await chat.sendMessage('bob@example.com', 'pretend Bob sent this')
      const outgoing = captured[0]
      captured.length = 0

      // Wrap the encrypted payload as if Bob's send arrived as a
      // `<received>` carbon on our device-B.
      const inner = xml(
        'message',
        {
          from: 'bob@example.com/laptop',
          to: 'me@example.com',
          type: 'chat',
          id: 'm-recv-carbon',
        },
        ...outgoing.children.filter((c) => typeof c === 'string' || c.name !== 'active'),
      )
      const carbon = xml(
        'message',
        { from: 'me@example.com', to: 'me@example.com/device-B', type: 'chat' },
        xml(
          'received',
          { xmlns: 'urn:xmpp:carbons:2' },
          xml('forwarded', { xmlns: 'urn:xmpp:forward:0' }, inner),
        ),
      )

      chat.handle(carbon)
      await new Promise((r) => setTimeout(r, 0))

      expect(spy).toHaveBeenCalledTimes(1)
      const [, senderTarget, context] = spy.mock.calls[0]
      // Conversation peer is Bob (the sender), not us.
      expect(senderTarget).toEqual({ kind: 'direct', peer: 'bob@example.com' })
      // Critical: <received> carbons are inbound — must NOT flip the flag.
      expect(context?.isSelfOutgoing).not.toBe(true)
    })

    it('decrypts a sent carbon (XEP-0280) — own outgoing encrypted message replayed on another device', async () => {
      // Multi-device bug: when our other device sends an encrypted message,
      // the server fans out a `<sent xmlns='urn:xmpp:carbons:2'>` carbon to
      // every other resource of our account. The carbon's inner stanza is
      // OUR message (from=us, to=peer) with the ciphertext as encoded by the
      // sending device. The receiving device must decrypt it and surface the
      // plaintext in the conversation with the peer.
      //
      // Without proper handling, two things go wrong:
      //   1. The plugin is asked to open a conversation with our own JID (a
      //      reflection-like context) and signature verification looks up
      //      the wrong key.
      //   2. The plugin's XEP-0373 reflection defence rejects the envelope
      //      because the signcrypt `<to/>` names the conversation peer, not
      //      us — so the legitimate carbon is treated as a reflected attack.
      //
      // The SDK contract: for sent carbons, decryptInbound is called with
      //   - senderTarget.peer === the recipient (bareTo), so the plugin
      //     opens conversation with the right counterparty, and
      //   - context.isSelfOutgoing === true, so the plugin can branch its
      //     verification / addressees logic.
      const spy = vi.spyOn(manager, 'decryptInbound')

      // Produce a real encrypted stanza by sending one from the sender device.
      await chat.sendMessage('bob@example.com', 'hello from device-A')
      const outgoing = captured[0]
      captured.length = 0

      // Fabricate the carbon as it would arrive on device-B: outer message
      // addressed to us, wrapping a `<sent>` carbon with the original.
      const inner = xml(
        'message',
        {
          from: 'me@example.com/device-A',
          to: 'bob@example.com',
          type: 'chat',
          id: 'm-carbon-sent',
        },
        ...outgoing.children.filter((c) => typeof c === 'string' || c.name !== 'active'),
      )
      const carbon = xml(
        'message',
        { from: 'me@example.com', to: 'me@example.com/device-B', type: 'chat' },
        xml(
          'sent',
          { xmlns: 'urn:xmpp:carbons:2' },
          xml('forwarded', { xmlns: 'urn:xmpp:forward:0' }, inner),
        ),
      )

      // Receive the carbon on device-B (uses the same manager, but a fresh
      // Chat instance bound to a fresh event sink so we observe only this
      // delivery).
      const sdkEvents: Array<{ event: string; payload: unknown }> = []
      const { deps } = makeDeps({
        jid: 'me@example.com',
        manager,
        captureStanza: () => {},
      })
      deps.emitSDK = (event, payload) => {
        sdkEvents.push({ event, payload })
      }
      const rxChat = new Chat(deps, stubMAM())

      const handled = rxChat.handle(carbon)
      expect(handled).toBe(true)
      await new Promise((r) => setTimeout(r, 0))

      // The plugin must be invoked with the conversation peer (the recipient)
      // and the isSelfOutgoing flag — without these, the OpenPGP plugin's
      // reflection check rejects the legitimate carbon.
      expect(spy).toHaveBeenCalledTimes(1)
      const [, senderTarget, context] = spy.mock.calls[0]
      expect(senderTarget).toEqual({ kind: 'direct', peer: 'bob@example.com' })
      expect(context?.isSelfOutgoing).toBe(true)

      // The decrypted carbon must surface as an outgoing message in the
      // conversation with bob (the recipient), not with us.
      const chatMessageEvents = sdkEvents.filter((e) => e.event === 'chat:message')
      expect(chatMessageEvents).toHaveLength(1)
      const msg = (chatMessageEvents[0].payload as { message: { conversationId: string; isOutgoing: boolean; body: string } }).message
      expect(msg.conversationId).toBe('bob@example.com')
      expect(msg.isOutgoing).toBe(true)
      expect(msg.body).toBe('hello from device-A')
    })
  })

  describe('securityContext threading', () => {
    it('sets securityContext on outbound encrypted messages', async () => {
      await chat.sendMessage('bob@example.com', 'Hello, Bob!')

      const chatMessageEvent = sdkEmitted.find(
        (e) => (e as { event: string }).event === 'chat:message',
      ) as { payload: { message: { securityContext?: { protocolId: string; trust: string } } } } | undefined

      expect(chatMessageEvent).toBeDefined()
      expect(chatMessageEvent!.payload.message.securityContext).toEqual({
        protocolId: 'dummy-plaintext',
        trust: 'verified',
      })
    })

    it('does not set securityContext on outbound plaintext messages', async () => {
      const emptyManager = new E2EEManager({
        storage: new InMemoryStorageBackend(),
        xmpp: stubXmppPrimitives(async () => {}),
        account: { jid: 'me@example.com' },
      })
      const built = makeDeps({
        jid: 'me@example.com',
        manager: emptyManager,
        captureStanza: () => {},
      })
      const plainChat = new Chat(built.deps, stubMAM())
      await plainChat.sendMessage('bob@example.com', 'Hi')

      const chatMessageEvent = built.sdkEmitted.find(
        (e) => (e as { event: string }).event === 'chat:message',
      ) as { payload: { message: { securityContext?: unknown } } } | undefined
      expect(chatMessageEvent).toBeDefined()
      expect(chatMessageEvent!.payload.message.securityContext).toBeUndefined()
    })

    it('sets securityContext on inbound decrypted messages', async () => {
      // Produce a real encrypted stanza.
      await chat.sendMessage('bob@example.com', 'Encrypted hello')
      const outgoing = captured[0]

      const inbound = xml(
        'message',
        { from: 'bob@example.com/r', to: 'me@example.com', type: 'chat', id: 'm-sc' },
        ...outgoing.children.filter((c) => typeof c === 'string' || c.name !== 'active'),
      )

      const rxBuilt = makeDeps({
        jid: 'me@example.com',
        manager,
        captureStanza: () => {},
      })
      // Need a conversation so processChatMessage emits (stranger path would bail).
      // In this test setup deps.stores is null, so hasConversation/hasContact aren't
      // hit — the message goes straight through.
      const rxChat = new Chat(rxBuilt.deps, stubMAM())

      rxChat.handle(inbound)
      await new Promise((r) => setTimeout(r, 0))

      const chatMessageEvent = rxBuilt.sdkEmitted.find(
        (e) => (e as { event: string }).event === 'chat:message',
      ) as { payload: { message: { body: string; securityContext?: { protocolId: string; trust: string } } } } | undefined

      expect(chatMessageEvent).toBeDefined()
      expect(chatMessageEvent!.payload.message.body).toBe('Encrypted hello')
      expect(chatMessageEvent!.payload.message.securityContext).toEqual({
        protocolId: 'dummy-plaintext',
        trust: 'untrusted',
        notes: ['dummy plugin — plaintext transport'],
      })
    })

    it('does not set securityContext on inbound plaintext messages', async () => {
      const inbound = xml(
        'message',
        { from: 'bob@example.com/r', to: 'me@example.com', type: 'chat', id: 'm-pt' },
        xml('body', {}, 'plain body'),
      )

      const rxBuilt = makeDeps({
        jid: 'me@example.com',
        manager,
        captureStanza: () => {},
      })
      const rxChat = new Chat(rxBuilt.deps, stubMAM())

      rxChat.handle(inbound)
      await new Promise((r) => setTimeout(r, 0))

      const chatMessageEvent = rxBuilt.sdkEmitted.find(
        (e) => (e as { event: string }).event === 'chat:message',
      ) as { payload: { message: { securityContext?: unknown } } } | undefined
      expect(chatMessageEvent).toBeDefined()
      expect(chatMessageEvent!.payload.message.securityContext).toBeUndefined()
    })
  })

  describe('decrypt failure fallback', () => {
    /**
     * Build an inbound stanza carrying an encrypted element the dummy plugin
     * would claim. We craft it by hand (instead of round-tripping through
     * sendMessage) so the test doesn't depend on a successful encrypt.
     */
    function buildEncryptedInbound(options: {
      from: string
      to: string
      id: string
      fallbackBody?: string | null
    }): Element {
      const children: Array<string | Element> = [
        xml('plain', { xmlns: 'urn:fluux:e2ee-dummy:0' }, 'aGVsbG8='),
      ]
      if (options.fallbackBody !== null) {
        children.unshift(
          xml('body', {}, options.fallbackBody ?? '[OpenPGP-encrypted message]'),
        )
      }
      return xml(
        'message',
        { from: options.from, to: options.to, type: 'chat', id: options.id },
        ...children,
      )
    }

    function emittedChatMessage(
      sdkEmittedList: unknown[],
    ):
      | {
          body: string
          securityContext?: { protocolId: string; trust: string; notes?: string[] }
        }
      | undefined {
      const evt = sdkEmittedList.find(
        (e) => (e as { event: string }).event === 'chat:message',
      ) as
        | { payload: { message: { body: string; securityContext?: { protocolId: string; trust: string; notes?: string[] } } } }
        | undefined
      return evt?.payload.message
    }

    it('emits the fallback body with a "Could not decrypt" note when the plugin throws', async () => {
      const decryptSpy = vi
        .spyOn(manager, 'decryptInbound')
        .mockRejectedValue(new Error('bad block'))

      const rxBuilt = makeDeps({
        jid: 'me@example.com',
        manager,
        captureStanza: () => {},
      })
      const rxChat = new Chat(rxBuilt.deps, stubMAM())

      const inbound = buildEncryptedInbound({
        from: 'bob@example.com/r',
        to: 'me@example.com',
        id: 'm-fail-throw',
        fallbackBody: '[OpenPGP-encrypted message]',
      })
      rxChat.handle(inbound)
      await new Promise((r) => setTimeout(r, 0))

      expect(decryptSpy).toHaveBeenCalledTimes(1)
      const message = emittedChatMessage(rxBuilt.sdkEmitted)
      expect(message).toBeDefined()
      // Body is the sender-provided fallback, not silently dropped.
      expect(message!.body).toBe('[OpenPGP-encrypted message]')
      expect(message!.securityContext).toBeDefined()
      expect(message!.securityContext!.protocolId).toBe('dummy-plaintext')
      expect(message!.securityContext!.trust).toBe('untrusted')
      expect(message!.securityContext!.notes).toContain('Could not decrypt')
    })

    it('emits the fallback body with a "Could not decrypt" note when the manager returns null', async () => {
      vi.spyOn(manager, 'decryptInbound').mockResolvedValue(null)

      const rxBuilt = makeDeps({
        jid: 'me@example.com',
        manager,
        captureStanza: () => {},
      })
      const rxChat = new Chat(rxBuilt.deps, stubMAM())

      const inbound = buildEncryptedInbound({
        from: 'bob@example.com/r',
        to: 'me@example.com',
        id: 'm-fail-null',
        fallbackBody: '[OpenPGP-encrypted message]',
      })
      rxChat.handle(inbound)
      await new Promise((r) => setTimeout(r, 0))

      const message = emittedChatMessage(rxBuilt.sdkEmitted)
      expect(message).toBeDefined()
      expect(message!.body).toBe('[OpenPGP-encrypted message]')
      expect(message!.securityContext?.notes).toContain('Could not decrypt')
    })

    it('synthesizes a placeholder body when the sender omitted the fallback', async () => {
      vi.spyOn(manager, 'decryptInbound').mockRejectedValue(new Error('bad'))

      const rxBuilt = makeDeps({
        jid: 'me@example.com',
        manager,
        captureStanza: () => {},
      })
      const rxChat = new Chat(rxBuilt.deps, stubMAM())

      const inbound = buildEncryptedInbound({
        from: 'bob@example.com/r',
        to: 'me@example.com',
        id: 'm-fail-no-body',
        // Explicit null → skip the fallback <body>, simulating a
        // non-spec-compliant sender.
        fallbackBody: null,
      })
      rxChat.handle(inbound)
      await new Promise((r) => setTimeout(r, 0))

      const message = emittedChatMessage(rxBuilt.sdkEmitted)
      expect(message).toBeDefined()
      expect(message!.body).toContain('could not decrypt')
      expect(message!.securityContext?.trust).toBe('untrusted')
    })

    it('strips the encrypted element on failure so re-entry does not loop', async () => {
      const spy = vi
        .spyOn(manager, 'decryptInbound')
        .mockRejectedValue(new Error('boom'))

      const rxBuilt = makeDeps({
        jid: 'me@example.com',
        manager,
        captureStanza: () => {},
      })
      const rxChat = new Chat(rxBuilt.deps, stubMAM())

      const inbound = buildEncryptedInbound({
        from: 'bob@example.com/r',
        to: 'me@example.com',
        id: 'm-loop-guard',
      })
      rxChat.handle(inbound)
      await new Promise((r) => setTimeout(r, 0))

      // Failure path must not re-claim the (now-stripped) encrypted element
      // during the synthetic re-enter. One call only.
      expect(spy).toHaveBeenCalledTimes(1)
    })
  })

  describe('plugin context plumbing', () => {
    it('forwards the inbound messageId to plugin.decrypt via decryptInbound', async () => {
      // Race-window upgrade hinges on this: the plugin needs the messageId
      // at decrypt time so the eventual security-context update can target
      // the right rendered message. We assert the SDK-managed plumbing
      // hands it through end-to-end.
      const spy = vi.spyOn(manager, 'decryptInbound')

      await chat.sendMessage('bob@example.com', 'plumbing check')
      const outgoing = captured[0]
      const inbound = xml(
        'message',
        { from: 'bob@example.com/r', to: 'me@example.com', type: 'chat', id: 'm-pid' },
        ...outgoing.children.filter((c) => typeof c === 'string' || c.name !== 'active'),
      )
      const rxBuilt = makeDeps({
        jid: 'me@example.com',
        manager,
        captureStanza: () => {},
      })
      const rxChat = new Chat(rxBuilt.deps, stubMAM())

      rxChat.handle(inbound)
      await new Promise((r) => setTimeout(r, 0))

      // Third arg to decryptInbound is the InboundDecryptContext.
      const lastCall = spy.mock.calls[spy.mock.calls.length - 1]
      expect(lastCall[2]).toEqual({ messageId: 'm-pid' })
    })

    it('emits message:security-updated when the manager reports an upgrade', async () => {
      // Simulate the plugin reporting an upgrade after a sender key
      // arrived: dispatch via the manager's listener mechanism and assert
      // the SDK event is emitted with the right shape.
      const rxBuilt = makeDeps({
        jid: 'me@example.com',
        manager,
        captureStanza: () => {},
      })
      // Wire a listener on manager → emit SDK event the same way
      // XMPPClient.ensureE2EEManager does in production. We mirror that
      // wire here so the Chat-level test stays self-contained.
      manager.onSecurityContextUpdated(({ peer, messageId, securityContext }) => {
        rxBuilt.deps.emitSDK('message:security-updated', {
          conversationId: peer,
          messageId,
          securityContext,
        })
      })

      // The dummy plugin doesn't expose its captured ctx — we register a
      // tiny side plugin solely so the test can reach its
      // reportSecurityContextUpdate (the production channel a real
      // plugin would use to report a successful re-verify).
      const captureCtx = await capturePluginCtx(manager)
      captureCtx.reportSecurityContextUpdate({
        peer: 'bob@example.com',
        messageId: 'm-up',
        securityContext: { protocolId: 'capture', trust: 'tofu' },
      })

      const evt = rxBuilt.sdkEmitted.find(
        (e) => (e as { event: string }).event === 'message:security-updated',
      ) as
        | {
            payload: {
              conversationId: string
              messageId: string
              securityContext: { protocolId: string; trust: string }
            }
          }
        | undefined
      expect(evt).toBeDefined()
      expect(evt!.payload).toEqual({
        conversationId: 'bob@example.com',
        messageId: 'm-up',
        securityContext: { protocolId: 'capture', trust: 'tofu' },
      })
    })
  })

  describe('deferred decrypt — EME without plugin', () => {
    /**
     * Helper: build deps with no E2EE manager at all (getE2EEManager returns null).
     */
    function makeDepsNoManager(jid: string) {
      const emitted: unknown[] = []
      const sdkEmitted: unknown[] = []
      const deps: ModuleDependencies = {
        stores: null,
        sendStanza: async () => {},
        sendIQ: async () => xml('iq', {}) as Element,
        getCurrentJid: () => jid,
        emit: (event, ...args) => {
          emitted.push({ event, args })
        },
        emitSDK: (event, payload) => {
          sdkEmitted.push({ event, payload })
        },
        getXmpp: () => null,
        getE2EEManager: () => null,
      }
      return { deps, emitted, sdkEmitted }
    }

    it('sets encryptedPayload when EME hint is present but no plugin claims', async () => {
      const built = makeDepsNoManager('me@example.com')
      const noManagerChat = new Chat(built.deps, stubMAM())

      const inbound = xml(
        'message',
        { from: 'bob@example.com/r', to: 'me@example.com', type: 'chat', id: 'm-deferred-1' },
        xml('body', {}, '[OpenPGP-encrypted message]'),
        xml('openpgp', { xmlns: 'urn:xmpp:openpgp:0' }, 'base64ciphertext'),
        xml('encryption', { xmlns: 'urn:xmpp:eme:0', namespace: 'urn:xmpp:openpgp:0', name: 'OpenPGP' }),
      )

      noManagerChat.handle(inbound)
      await new Promise((r) => setTimeout(r, 0))

      const chatMessageEvent = built.sdkEmitted.find(
        (e) => (e as { event: string }).event === 'chat:message',
      ) as { payload: { message: { body: string; encryptedPayload?: string } } } | undefined

      expect(chatMessageEvent).toBeDefined()
      expect(chatMessageEvent!.payload.message.encryptedPayload).toBeDefined()
      expect(chatMessageEvent!.payload.message.encryptedPayload).toContain('urn:xmpp:openpgp:0')
      expect(chatMessageEvent!.payload.message.body).toBe('[OpenPGP-encrypted message]')
    })

    it('does not set encryptedPayload on a plain message without EME', async () => {
      const built = makeDepsNoManager('me@example.com')
      const noManagerChat = new Chat(built.deps, stubMAM())

      const inbound = xml(
        'message',
        { from: 'bob@example.com/r', to: 'me@example.com', type: 'chat', id: 'm-deferred-2' },
        xml('body', {}, 'Hello'),
      )

      noManagerChat.handle(inbound)
      await new Promise((r) => setTimeout(r, 0))

      const chatMessageEvent = built.sdkEmitted.find(
        (e) => (e as { event: string }).event === 'chat:message',
      ) as { payload: { message: { body: string; encryptedPayload?: string } } } | undefined

      expect(chatMessageEvent).toBeDefined()
      expect(chatMessageEvent!.payload.message.encryptedPayload).toBeUndefined()
      expect(chatMessageEvent!.payload.message.body).toBe('Hello')
    })
  })

  describe('unsupported encryption — OMEMO with OpenPGP plugin registered', () => {
    it('emits fallback body + unsupportedEncryption tag and no encryptedPayload when a plugin is registered but cannot claim OMEMO', async () => {
      // manager has DummyPlaintextPlugin registered (hasPlugins() === true)
      // but that plugin only claims its own namespace — it won't touch OMEMO.
      const rxBuilt = makeDeps({
        jid: 'me@example.com',
        manager,
        captureStanza: () => {},
      })
      const rxChat = new Chat(rxBuilt.deps, stubMAM())

      const inbound = xml(
        'message',
        { from: 'peer@example.com/r', to: 'me@example.com/x', id: 'omemo-1', type: 'chat' },
        xml('encrypted', { xmlns: 'eu.siacs.conversations.axolotl' }, 'cipher'),
        xml('encryption', { xmlns: 'urn:xmpp:eme:0', namespace: 'eu.siacs.conversations.axolotl', name: 'OMEMO' }),
        xml('body', {}, 'I sent you an OMEMO encrypted message.'),
      )

      rxChat.handle(inbound)
      await new Promise((r) => setTimeout(r, 0))

      const chatMessageEvent = rxBuilt.sdkEmitted.find(
        (e) => (e as { event: string }).event === 'chat:message',
      ) as
        | {
            payload: {
              message: {
                body: string
                encryptedPayload?: string
                unsupportedEncryption?: { namespace: string; name: string }
              }
            }
          }
        | undefined

      expect(chatMessageEvent).toBeDefined()
      expect(chatMessageEvent!.payload.message.body).toBe('I sent you an OMEMO encrypted message.')
      expect(chatMessageEvent!.payload.message.encryptedPayload).toBeUndefined()
      expect(chatMessageEvent!.payload.message.unsupportedEncryption).toEqual({
        namespace: 'eu.siacs.conversations.axolotl',
        name: 'OMEMO',
      })
    })

    it('emits room:message with unsupportedEncryption tag and fallback body for a groupchat OMEMO stanza', async () => {
      // Live room message path: processRoomMessage must mirror processChatMessage
      // and carry the unsupportedEncryption tag through to the RoomMessage.
      const roomJid = 'team@conference.example.com'
      const rxBuilt = makeDeps({
        jid: 'me@example.com',
        manager,
        captureStanza: () => {},
      })
      // processRoomMessage bails early if stores.room.getRoom returns undefined.
      // Provide a minimal stub so the path continues.
      rxBuilt.deps.stores = {
        room: {
          getRoom: () => ({
            jid: roomJid,
            name: 'team',
            nickname: 'me',
            joined: true,
            occupants: new Map(),
            messages: [],
            unreadCount: 0,
            mentionsCount: 0,
            typingUsers: new Set(),
            isBookmarked: false,
          }),
        },
      } as unknown as import('../types').StoreBindings

      const rxChat = new Chat(rxBuilt.deps, stubMAM())

      const inbound = xml(
        'message',
        { from: `${roomJid}/peer`, to: 'me@example.com', id: 'room-omemo-1', type: 'groupchat' },
        xml('encrypted', { xmlns: 'eu.siacs.conversations.axolotl' }, 'cipher'),
        xml('encryption', { xmlns: 'urn:xmpp:eme:0', namespace: 'eu.siacs.conversations.axolotl', name: 'OMEMO' }),
        xml('body', {}, 'I sent you an OMEMO encrypted message.'),
      )

      rxChat.handle(inbound)
      await new Promise((r) => setTimeout(r, 0))

      const roomMessageEvent = rxBuilt.sdkEmitted.find(
        (e) => (e as { event: string }).event === 'room:message',
      ) as
        | {
            payload: {
              roomJid: string
              message: {
                body: string
                encryptedPayload?: string
                unsupportedEncryption?: { namespace: string; name: string }
              }
            }
          }
        | undefined

      expect(roomMessageEvent).toBeDefined()
      expect(roomMessageEvent!.payload.roomJid).toBe(roomJid)
      expect(roomMessageEvent!.payload.message.body).toBe('I sent you an OMEMO encrypted message.')
      expect(roomMessageEvent!.payload.message.encryptedPayload).toBeUndefined()
      expect(roomMessageEvent!.payload.message.unsupportedEncryption).toEqual({
        namespace: 'eu.siacs.conversations.axolotl',
        name: 'OMEMO',
      })
    })
  })

  // -------------------------------------------------------------------
  // Regression: a successfully-decrypted OpenPGP message must NOT be
  // tagged with unsupportedEncryption on the re-entry pass that follows
  // async decryption. The EME hint remains in the stanza after the
  // <openpgp> element is stripped; the old recordUnclaimedEME logic
  // treated "any plugin registered + unclaimed" as "unsupported", which
  // fired on re-entry even though the plugin HAD just decrypted the
  // message.
  // -------------------------------------------------------------------
  describe('re-entry after successful OpenPGP decryption', () => {
    it('does NOT tag the message as unsupportedEncryption after successful decrypt', async () => {
      const openpgpManager = new E2EEManager({
        storage: new InMemoryStorageBackend(),
        xmpp: stubXmppPrimitives(async () => {}),
        account: { jid: 'me@example.com' },
      })
      await openpgpManager.register(new FakeOpenPGPPlugin())

      const built = makeDeps({
        jid: 'me@example.com',
        manager: openpgpManager,
        captureStanza: () => {},
      })
      const rxChat = new Chat(built.deps, stubMAM())

      const plaintext = 'Hello from OpenPGP'
      const encoded = Buffer.from(plaintext).toString('base64')
      const inbound = xml(
        'message',
        { from: 'peer@example.com/r', to: 'me@example.com', type: 'chat', id: 'ox-1' },
        xml('openpgp', { xmlns: OX_NS }, encoded),
        xml('encryption', { xmlns: 'urn:xmpp:eme:0', namespace: OX_NS, name: 'OpenPGP' }),
        xml('body', {}, '[OpenPGP-encrypted message]'),
      )

      rxChat.handle(inbound)
      await new Promise((r) => setTimeout(r, 0))

      const chatEvent = built.sdkEmitted.find(
        (e) => (e as { event: string }).event === 'chat:message',
      ) as { payload: { message: { body: string; unsupportedEncryption?: unknown; encryptedPayload?: string } } } | undefined

      expect(chatEvent).toBeDefined()
      expect(chatEvent!.payload.message.body).toBe(plaintext)
      expect(chatEvent!.payload.message.unsupportedEncryption).toBeUndefined()
      expect(chatEvent!.payload.message.encryptedPayload).toBeUndefined()
    })
  })

  // -------------------------------------------------------------------
  // Regression: every chat-like outbound primitive must route through the
  // E2EE wrap. A leak in any of these paths (resend a failed encrypted
  // message, edit it, react to it) would publish the original plaintext
  // to the server even though the user opted into E2EE.
  // -------------------------------------------------------------------
  describe('outbound encryption — resendMessage', () => {
    it('replaces <body> with fallback and appends the encrypted element on resend', async () => {
      await chat.resendMessage('bob@example.com', 'second try', 'msg-retry-1')

      expect(captured).toHaveLength(1)
      const sent = captured[0]
      const body = sent.getChild('body')
      // The plaintext retry body must NOT reach the wire.
      expect(body?.text()).not.toContain('second try')
      expect(body?.text()).toBe('[dummy-plaintext payload]')
      expect(sent.getChild('plain', 'urn:fluux:e2ee-dummy:0')).toBeDefined()
      expect(sent.getChild('encryption', 'urn:xmpp:eme:0')).toBeDefined()
      expect(sent.getChild('store', 'urn:xmpp:hints')).toBeDefined()
    })

    it('strict mode throws E2EEEncryptionRequiredError instead of resending plaintext', async () => {
      const strictManager = new E2EEManager({
        storage: new InMemoryStorageBackend(),
        xmpp: stubXmppPrimitives(async () => {}),
        account: { jid: 'me@example.com' },
      })
      strictManager.setSendPolicy('strict')
      const { deps } = makeDeps({
        jid: 'me@example.com',
        manager: strictManager,
        captureStanza: (el) => captured.push(el),
      })
      const strictChat = new Chat(deps, stubMAM())

      await expect(
        strictChat.resendMessage('bob@example.com', 'leaky retry', 'msg-retry-2'),
      ).rejects.toBeInstanceOf(E2EEEncryptionRequiredError)
      expect(captured).toHaveLength(0)
    })

    it('blocks the resend (no plaintext) when a selected plugin throws mid-encrypt', async () => {
      // resendMessage shares applyE2EEToOutboundChat with sendMessage: a
      // selected plugin failing mid-encrypt must block the retry, never fall
      // back to resending the body in cleartext.
      vi.spyOn(manager, 'encryptOutbound').mockRejectedValue(
        new E2EEPluginError('permanent', 'pin-mismatch', 'fingerprint changed'),
      )

      await expect(
        chat.resendMessage('bob@example.com', 'leaky retry', 'msg-retry-fail'),
      ).rejects.toBeInstanceOf(E2EEPluginError)
      expect(captured).toHaveLength(0)
    })

    it('throws when retrying a message whose attachment carries an aesgcm key', async () => {
      const emptyManager = new E2EEManager({
        storage: new InMemoryStorageBackend(),
        xmpp: stubXmppPrimitives(async () => {}),
        account: { jid: 'me@example.com' },
      })
      const { deps } = makeDeps({
        jid: 'me@example.com',
        manager: emptyManager,
        captureStanza: (el) => captured.push(el),
      })
      const guardedChat = new Chat(deps, stubMAM())

      await expect(
        guardedChat.resendMessage('bob@example.com', 'retry photo', 'msg-retry-3', {
          url: 'https://upload.example.com/retry.bin',
          name: 'retry.jpg',
          mediaType: 'image/jpeg',
          encryption: {
            cipher: 'aes-256-gcm',
            key: new Uint8Array(32).fill(5),
            iv: new Uint8Array(12).fill(6),
          },
        }),
      ).rejects.toBeInstanceOf(E2EEEncryptionRequiredError)

      expect(captured).toHaveLength(0)
    })
  })

  describe('outbound encryption — sendCorrection', () => {
    it('encrypts the corrected body for 1:1 chats', async () => {
      await chat.sendCorrection('bob@example.com', 'orig-id', 'fixed text')

      expect(captured).toHaveLength(1)
      const sent = captured[0]
      const body = sent.getChild('body')
      expect(body?.text()).not.toContain('fixed text')
      expect(body?.text()).not.toContain('[Corrected]')
      expect(body?.text()).toBe('[dummy-plaintext payload]')
      expect(sent.getChild('plain', 'urn:fluux:e2ee-dummy:0')).toBeDefined()
      expect(sent.getChild('encryption', 'urn:xmpp:eme:0')).toBeDefined()
      expect(sent.getChild('replace', 'urn:xmpp:message-correct:0')).toBeDefined()

      // The <fallback for="NS_CORRECTION"> with body indices must be removed:
      // its start/end positions referenced the plaintext body, not the E2EE
      // fallback string, so keeping it causes recipients to truncate the
      // displayed fallback (e.g. "[OpenPGP-encrypted message]" → "rypted message]").
      const fallbacks = sent.children.filter(
        (c): c is Element =>
          typeof c !== 'string' && c.name === 'fallback' && c.attrs?.xmlns === 'urn:xmpp:fallback:0',
      )
      expect(fallbacks).toHaveLength(0)
    })

    it('strict mode throws when correcting to an E2EE-unreachable peer', async () => {
      const strictManager = new E2EEManager({
        storage: new InMemoryStorageBackend(),
        xmpp: stubXmppPrimitives(async () => {}),
        account: { jid: 'me@example.com' },
      })
      strictManager.setSendPolicy('strict')
      const { deps } = makeDeps({
        jid: 'me@example.com',
        manager: strictManager,
        captureStanza: (el) => captured.push(el),
      })
      const strictChat = new Chat(deps, stubMAM())

      await expect(
        strictChat.sendCorrection('bob@example.com', 'orig-id', 'leaky edit'),
      ).rejects.toBeInstanceOf(E2EEEncryptionRequiredError)
      expect(captured).toHaveLength(0)
    })

    it('blocks the correction (no plaintext) when a selected plugin throws mid-encrypt', async () => {
      // sendCorrection shares applyE2EEToOutboundChat: a selected plugin
      // failing mid-encrypt must block the edit, never push the corrected
      // body to the server in cleartext.
      vi.spyOn(manager, 'encryptOutbound').mockRejectedValue(
        new E2EEPluginError('permanent', 'pin-mismatch', 'fingerprint changed'),
      )

      await expect(
        chat.sendCorrection('bob@example.com', 'orig-id', 'leaky edit'),
      ).rejects.toBeInstanceOf(E2EEPluginError)
      expect(captured).toHaveLength(0)
    })

    it('throws when correcting a message whose attachment carries an aesgcm key', async () => {
      const emptyManager = new E2EEManager({
        storage: new InMemoryStorageBackend(),
        xmpp: stubXmppPrimitives(async () => {}),
        account: { jid: 'me@example.com' },
      })
      const { deps } = makeDeps({
        jid: 'me@example.com',
        manager: emptyManager,
        captureStanza: (el) => captured.push(el),
      })
      const guardedChat = new Chat(deps, stubMAM())

      await expect(
        guardedChat.sendCorrection('bob@example.com', 'orig-id', 'updated caption', 'chat', {
          url: 'https://upload.example.com/edit.bin',
          name: 'edit.jpg',
          mediaType: 'image/jpeg',
          encryption: {
            cipher: 'aes-256-gcm',
            key: new Uint8Array(32).fill(7),
            iv: new Uint8Array(12).fill(8),
          },
        }),
      ).rejects.toBeInstanceOf(E2EEEncryptionRequiredError)

      expect(captured).toHaveLength(0)
    })

    it('strips both correction and OOB fallback when encrypting a correction with attachment', async () => {
      await chat.sendCorrection('bob@example.com', 'orig-id', 'new caption', 'chat', {
        url: 'https://upload.example.com/photo.bin',
        name: 'photo.jpg',
        mediaType: 'image/jpeg',
        encryption: {
          cipher: 'aes-256-gcm',
          key: new Uint8Array(32).fill(9),
          iv: new Uint8Array(12).fill(10),
        },
      })

      expect(captured).toHaveLength(1)
      const sent = captured[0]

      expect(sent.getChild('replace', 'urn:xmpp:message-correct:0')).toBeDefined()
      expect(sent.getChild('plain', 'urn:fluux:e2ee-dummy:0')).toBeDefined()

      const fallbacks = sent.children.filter(
        (c): c is Element =>
          typeof c !== 'string' && c.name === 'fallback' && c.attrs?.xmlns === 'urn:xmpp:fallback:0',
      )
      expect(fallbacks).toHaveLength(0)
    })

    it('groupchat correction sends plaintext (MUC E2EE not supported in this phase)', async () => {
      await chat.sendCorrection('room@conf.example.com', 'orig-id', 'fixed text', 'groupchat')

      expect(captured).toHaveLength(1)
      const sent = captured[0]
      const body = sent.getChild('body')
      expect(body?.text()).toBe('[Corrected] fixed text')
      expect(sent.getChild('plain', 'urn:fluux:e2ee-dummy:0')).toBeUndefined()
    })
  })

  describe('outbound encryption — sendReaction', () => {
    /**
     * Build a deps object with a `chat.getMessage` stub that hands out a
     * fixed "original" message — the reactions reply-fallback would quote
     * its `body` in cleartext if it ran. We use this fixture to prove the
     * suppression actually fires when E2EE is reachable.
     */
    function makeDepsWithOriginal(options: {
      manager: E2EEManager
      originalBody: string
    }): {
      deps: ModuleDependencies
      capturedStanzas: Element[]
      sdkEmitted: unknown[]
    } {
      const capturedStanzas: Element[] = []
      const built = makeDeps({
        jid: 'me@example.com',
        manager: options.manager,
        captureStanza: (el) => capturedStanzas.push(el),
      })
      // Cast through unknown — we only stub the methods sendReaction
      // touches (chat.getMessage). The full StoreBindings surface is
      // huge and irrelevant to this test.
      built.deps.stores = {
        chat: {
          getMessage: () => ({
            id: 'orig-id',
            from: 'bob@example.com',
            body: options.originalBody,
          } as unknown as import('../types').Message),
        },
      } as unknown as import('../types').StoreBindings
      return { deps: built.deps, capturedStanzas, sdkEmitted: built.sdkEmitted }
    }

    it('moves the <reactions> element inside the encrypted payload when the peer can be encrypted to', async () => {
      const built = makeDepsWithOriginal({
        manager,
        originalBody: 'super secret original message',
      })
      const reactingChat = new Chat(built.deps, stubMAM())

      await reactingChat.sendReaction('bob@example.com', 'orig-id', ['👍'])

      expect(built.capturedStanzas).toHaveLength(1)
      const sent = built.capturedStanzas[0]

      // No cleartext reaction, no body, no legacy reply machinery on the wire.
      expect(sent.getChild('reactions', 'urn:xmpp:reactions:0')).toBeUndefined()
      expect(sent.getChild('body')).toBeUndefined()
      expect(sent.getChild('reply', 'urn:xmpp:reply:0')).toBeUndefined()

      // Encrypted payload + EME + store hint instead.
      expect(sent.getChild('plain', 'urn:fluux:e2ee-dummy:0')).toBeDefined()
      expect(sent.getChild('encryption', 'urn:xmpp:eme:0')?.attrs.namespace).toBe(
        'urn:fluux:e2ee-dummy:0',
      )
      expect(sent.getChild('store', 'urn:xmpp:hints')).toBeDefined()
    })

    it('round-trips an encrypted reaction back to a chat:reactions event', async () => {
      // Send encrypted, then replay the captured stanza as if Bob sent it.
      await chat.sendReaction('bob@example.com', 'orig-id', ['👍'])
      const outgoing = captured[0]
      expect(outgoing.getChild('reactions', 'urn:xmpp:reactions:0')).toBeUndefined()

      const inbound = xml(
        'message',
        { from: 'bob@example.com/r', to: 'me@example.com', type: 'chat', id: 'm-react-rt' },
        ...outgoing.children.filter((c) => typeof c === 'string' || c.name !== 'active'),
      )

      const rxBuilt = makeDeps({ jid: 'me@example.com', manager, captureStanza: () => {} })
      const rxChat = new Chat(rxBuilt.deps, stubMAM())
      rxChat.handle(inbound)
      await new Promise((r) => setTimeout(r, 0))

      const evt = rxBuilt.sdkEmitted.find(
        (e) => (e as { event: string }).event === 'chat:reactions',
      ) as { payload: { conversationId: string; messageId: string; emojis: string[] } } | undefined
      expect(evt).toBeDefined()
      expect(evt!.payload.conversationId).toBe('bob@example.com')
      expect(evt!.payload.messageId).toBe('orig-id')
      expect(evt!.payload.emojis).toEqual(['👍'])
    })

    it('strict mode throws when reacting to an E2EE-unreachable peer with a quoted original', async () => {
      const strictManager = new E2EEManager({
        storage: new InMemoryStorageBackend(),
        xmpp: stubXmppPrimitives(async () => {}),
        account: { jid: 'me@example.com' },
      })
      strictManager.setSendPolicy('strict')
      const built = makeDepsWithOriginal({
        manager: strictManager,
        originalBody: 'must stay encrypted',
      })
      const strictChat = new Chat(built.deps, stubMAM())

      await expect(
        strictChat.sendReaction('bob@example.com', 'orig-id', ['🔥']),
      ).rejects.toBeInstanceOf(E2EEEncryptionRequiredError)
      expect(built.capturedStanzas).toHaveLength(0)
    })

    it('keeps the legacy reply-quote fallback when no E2EE manager is wired', async () => {
      // Regression guard: removing the leak for E2EE peers must not
      // change behavior for accounts that never opted into E2EE, where
      // the cleartext fallback is the actual interop story for legacy
      // clients that don't speak <reactions/>.
      const emptyManager = new E2EEManager({
        storage: new InMemoryStorageBackend(),
        xmpp: stubXmppPrimitives(async () => {}),
        account: { jid: 'me@example.com' },
      })
      const built = makeDepsWithOriginal({
        manager: emptyManager,
        originalBody: 'legacy chat — already plaintext anyway',
      })
      const plainChat = new Chat(built.deps, stubMAM())

      await plainChat.sendReaction('bob@example.com', 'orig-id', ['🎉'])

      const sent = built.capturedStanzas[0]
      const body = sent.getChild('body')
      expect(body?.text()).toContain('legacy chat — already plaintext anyway')
      expect(sent.getChild('reply', 'urn:xmpp:reply:0')).toBeDefined()
    })
  })

  describe('outbound encryption — sendRetraction', () => {
    it('encrypts the retract element and hides the retraction notice for E2EE peers', async () => {
      await chat.sendRetraction('bob@example.com', 'orig-id')

      expect(captured).toHaveLength(1)
      const sent = captured[0]

      // The retract element and its target id are inside the encrypted payload.
      expect(sent.getChild('retract', 'urn:xmpp:message-retract:1')).toBeUndefined()
      // The retraction-revealing English body is replaced by the generic fallback.
      expect(sent.getChild('body')?.text()).toBe('[dummy-plaintext payload]')
      // The now-stale <fallback for=NS_RETRACT> is gone.
      const retractFallback = sent
        .getChildren('fallback', 'urn:xmpp:fallback:0')
        .find((el) => el.attrs?.for === 'urn:xmpp:message-retract:1')
      expect(retractFallback).toBeUndefined()
      // Encrypted payload + EME present.
      expect(sent.getChild('plain', 'urn:fluux:e2ee-dummy:0')).toBeDefined()
      expect(sent.getChild('encryption', 'urn:xmpp:eme:0')).toBeDefined()
    })

    it('round-trips an encrypted retraction back to a chat:message-updated event', async () => {
      await chat.sendRetraction('bob@example.com', 'orig-id')
      const outgoing = captured[0]

      const inbound = xml(
        'message',
        { from: 'bob@example.com/r', to: 'me@example.com', type: 'chat', id: 'm-retract-rt' },
        ...outgoing.children.filter((c) => typeof c === 'string' || c.name !== 'active'),
      )

      const rxBuilt = makeDeps({ jid: 'me@example.com', manager, captureStanza: () => {} })
      // handleIncomingRetraction needs the original message to confirm the sender.
      rxBuilt.deps.stores = {
        chat: {
          getMessage: () => ({
            id: 'orig-id',
            from: 'bob@example.com',
            body: 'will be retracted',
          } as unknown as import('../types').Message),
        },
      } as unknown as import('../types').StoreBindings
      const rxChat = new Chat(rxBuilt.deps, stubMAM())
      rxChat.handle(inbound)
      await new Promise((r) => setTimeout(r, 0))

      const evt = rxBuilt.sdkEmitted.find(
        (e) => (e as { event: string }).event === 'chat:message-updated',
      ) as { payload: { messageId: string; updates: { isRetracted?: boolean } } } | undefined
      expect(evt).toBeDefined()
      expect(evt!.payload.messageId).toBe('orig-id')
      expect(evt!.payload.updates.isRetracted).toBe(true)
    })

    it('strict mode throws instead of retracting in plaintext to an unreachable peer', async () => {
      const strictManager = new E2EEManager({
        storage: new InMemoryStorageBackend(),
        xmpp: stubXmppPrimitives(async () => {}),
        account: { jid: 'me@example.com' },
      })
      strictManager.setSendPolicy('strict')
      const { deps } = makeDeps({
        jid: 'me@example.com',
        manager: strictManager,
        captureStanza: (el) => captured.push(el),
      })
      const strictChat = new Chat(deps, stubMAM())

      await expect(
        strictChat.sendRetraction('bob@example.com', 'orig-id'),
      ).rejects.toBeInstanceOf(E2EEEncryptionRequiredError)
      expect(captured).toHaveLength(0)
    })

    it('keeps the cleartext retraction notice when no E2EE plugin is registered', async () => {
      const emptyManager = new E2EEManager({
        storage: new InMemoryStorageBackend(),
        xmpp: stubXmppPrimitives(async () => {}),
        account: { jid: 'me@example.com' },
      })
      const { deps } = makeDeps({
        jid: 'me@example.com',
        manager: emptyManager,
        captureStanza: (el) => captured.push(el),
      })
      const plainChat = new Chat(deps, stubMAM())

      await plainChat.sendRetraction('bob@example.com', 'orig-id')

      const sent = captured[0]
      expect(sent.getChild('retract', 'urn:xmpp:message-retract:1')).toBeDefined()
      expect(sent.getChild('body')?.text()).toContain('attempted to retract')
      expect(sent.getChild('plain', 'urn:fluux:e2ee-dummy:0')).toBeUndefined()
    })
  })

  describe('outbound encryption — sendLinkPreview', () => {
    const preview = {
      url: 'https://secret.example.com/article',
      title: 'Confidential Title',
      description: 'A description the server must not see',
      image: 'https://secret.example.com/preview.jpg',
      siteName: 'Secret Site',
    }

    it('moves the OGP fastening inside the encrypted payload and keeps no-store', async () => {
      await chat.sendLinkPreview('bob@example.com', 'orig-id', preview)

      expect(captured).toHaveLength(1)
      const sent = captured[0]

      // The apply-to fastening (carrying url/title/description/image) is encrypted.
      expect(sent.getChild('apply-to', 'urn:xmpp:fasten:0')).toBeUndefined()
      expect(sent.toString()).not.toContain('Confidential Title')
      expect(sent.toString()).not.toContain('secret.example.com')
      // Encrypted payload + EME, and the no-store hint preserved (not <store>).
      expect(sent.getChild('plain', 'urn:fluux:e2ee-dummy:0')).toBeDefined()
      expect(sent.getChild('encryption', 'urn:xmpp:eme:0')).toBeDefined()
      expect(sent.getChild('no-store', 'urn:xmpp:hints')).toBeDefined()
      expect(sent.getChild('store', 'urn:xmpp:hints')).toBeUndefined()
    })

    it('round-trips an encrypted link preview back to a chat:message-updated event', async () => {
      await chat.sendLinkPreview('bob@example.com', 'orig-id', preview)
      const outgoing = captured[0]

      const inbound = xml(
        'message',
        { from: 'bob@example.com/r', to: 'me@example.com', type: 'chat', id: 'm-ogp-rt' },
        ...outgoing.children.filter((c) => typeof c === 'string' || c.name !== 'active'),
      )

      const rxBuilt = makeDeps({ jid: 'me@example.com', manager, captureStanza: () => {} })
      const rxChat = new Chat(rxBuilt.deps, stubMAM())
      rxChat.handle(inbound)
      await new Promise((r) => setTimeout(r, 0))

      const evt = rxBuilt.sdkEmitted.find(
        (e) => (e as { event: string }).event === 'chat:message-updated',
      ) as { payload: { messageId: string; updates: { linkPreview?: { title?: string } } } } | undefined
      expect(evt).toBeDefined()
      expect(evt!.payload.messageId).toBe('orig-id')
      expect(evt!.payload.updates.linkPreview?.title).toBe('Confidential Title')
    })

    it('sends the preview in cleartext (no-store) when no E2EE plugin is registered', async () => {
      const emptyManager = new E2EEManager({
        storage: new InMemoryStorageBackend(),
        xmpp: stubXmppPrimitives(async () => {}),
        account: { jid: 'me@example.com' },
      })
      const { deps } = makeDeps({
        jid: 'me@example.com',
        manager: emptyManager,
        captureStanza: (el) => captured.push(el),
      })
      const plainChat = new Chat(deps, stubMAM())

      await plainChat.sendLinkPreview('bob@example.com', 'orig-id', preview)

      const sent = captured[0]
      expect(sent.getChild('apply-to', 'urn:xmpp:fasten:0')).toBeDefined()
      expect(sent.getChild('no-store', 'urn:xmpp:hints')).toBeDefined()
      expect(sent.getChild('plain', 'urn:fluux:e2ee-dummy:0')).toBeUndefined()
    })
  })

  describe('outbound encryption — sendEasterEgg', () => {
    it('moves the easter-egg element inside the encrypted payload and keeps no-store', async () => {
      await chat.sendEasterEgg('bob@example.com', 'chat', 'confetti')

      expect(captured).toHaveLength(1)
      const sent = captured[0]

      expect(sent.getChild('easter-egg', 'urn:fluux:easter-egg:0')).toBeUndefined()
      expect(sent.toString()).not.toContain('confetti')
      expect(sent.getChild('plain', 'urn:fluux:e2ee-dummy:0')).toBeDefined()
      expect(sent.getChild('encryption', 'urn:xmpp:eme:0')).toBeDefined()
      expect(sent.getChild('no-store', 'urn:xmpp:hints')).toBeDefined()
      expect(sent.getChild('store', 'urn:xmpp:hints')).toBeUndefined()
    })

    it('round-trips an encrypted easter egg back to a chat:animation event', async () => {
      await chat.sendEasterEgg('bob@example.com', 'chat', 'confetti')
      const outgoing = captured[0]

      const inbound = xml(
        'message',
        { from: 'bob@example.com/r', to: 'me@example.com', type: 'chat', id: 'm-egg-rt' },
        ...outgoing.children.filter((c) => typeof c === 'string' || c.name !== 'active'),
      )

      const rxBuilt = makeDeps({ jid: 'me@example.com', manager, captureStanza: () => {} })
      const rxChat = new Chat(rxBuilt.deps, stubMAM())
      rxChat.handle(inbound)
      await new Promise((r) => setTimeout(r, 0))

      const evt = rxBuilt.sdkEmitted.find(
        (e) => (e as { event: string }).event === 'chat:animation',
      ) as { payload: { conversationId: string; animation: string } } | undefined
      expect(evt).toBeDefined()
      expect(evt!.payload.conversationId).toBe('bob@example.com')
      expect(evt!.payload.animation).toBe('confetti')
    })

    it('sends the easter egg in cleartext (no-store) when no E2EE plugin is registered', async () => {
      const emptyManager = new E2EEManager({
        storage: new InMemoryStorageBackend(),
        xmpp: stubXmppPrimitives(async () => {}),
        account: { jid: 'me@example.com' },
      })
      const { deps } = makeDeps({
        jid: 'me@example.com',
        manager: emptyManager,
        captureStanza: (el) => captured.push(el),
      })
      const plainChat = new Chat(deps, stubMAM())

      await plainChat.sendEasterEgg('bob@example.com', 'chat', 'confetti')

      const sent = captured[0]
      expect(sent.getChild('easter-egg', 'urn:fluux:easter-egg:0')).toBeDefined()
      expect(sent.getChild('no-store', 'urn:xmpp:hints')).toBeDefined()
      expect(sent.getChild('plain', 'urn:fluux:e2ee-dummy:0')).toBeUndefined()
    })
  })
})

/**
 * Register a throwaway plugin solely to capture the {@link PluginContext}
 * the manager builds. The `reportSecurityContextUpdate` method on the
 * captured ctx is the production-side channel a real plugin uses to report
 * a re-verification result.
 */
async function capturePluginCtx(
  manager: import('../e2ee').E2EEManager,
): Promise<import('../e2ee').PluginContext> {
  let captured: import('../e2ee').PluginContext | null = null
  const probe: import('../e2ee').E2EEPlugin = {
    descriptor: {
      id: 'capture',
      displayName: 'Capture probe',
      securityLevel: 1,
      features: {
        forwardSecrecy: false,
        postCompromiseSecurity: false,
        multiDevice: false,
        groupChat: false,
        asynchronous: false,
        deniability: false,
      },
    },
    init: async (ctx) => {
      captured = ctx
    },
    shutdown: async () => {},
    ensureIdentity: async () => ({ fingerprint: 'capture' }),
    probePeer: async () => ({ supported: false, ttl: 0 }),
    openConversation: async () => ({ protocolId: 'capture', state: {} }),
    closeConversation: async () => {},
    encrypt: async () => ({ protocolId: 'capture', stanzaElement: { name: 'x', attrs: {}, children: [] } }),
    decrypt: async () => ({
      plaintext: new Uint8Array(),
      senderDevice: { jid: '', deviceId: '' },
      securityContext: { protocolId: 'capture', trust: 'untrusted' },
    }),
    getVerificationMethods: () => [],
    startVerification: async () => {
      throw new Error('unused')
    },
    getPeerTrust: async () => 'unknown',
    getDeviceTrust: async () => 'unknown',
    tryClaimInbound: () => null,
  }
  await manager.register(probe)
  if (!captured) throw new Error('capturePluginCtx: ctx was not captured')
  return captured
}
