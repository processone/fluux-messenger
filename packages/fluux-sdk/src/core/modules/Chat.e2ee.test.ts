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
  E2EEManager,
  InMemoryStorageBackend,
  type XMPPPrimitives,
} from '../e2ee'
import { DummyPlaintextPlugin } from '../e2ee/DummyPlaintextPlugin'

function stubXmppPrimitives(sendStanza: (el: Element) => Promise<void>): XMPPPrimitives {
  return {
    sendStanza: async (data) => {
      // Not used by the dummy plugin, but we keep a working impl for safety.
      void data
      void sendStanza
    },
    queryDisco: async () => ({ features: [], identities: [] }),
    publishPEP: async () => {},
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
        trust: 'trusted',
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
})
