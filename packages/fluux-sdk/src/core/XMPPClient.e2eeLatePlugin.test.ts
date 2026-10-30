/**
 * FLM-163: encrypted messages that arrive just before the E2EE plugin
 * registers.
 *
 * With no plugin to claim them, the messages are stored with the sender's
 * fallback text and their encrypted copy. The plugin registering starts a
 * deferred-decrypt pass. When the plugin decrypts them but cannot check the
 * signature yet (the sender's key is not cached, as on a new device), the
 * pass used to read the result as "still pending" and keep the fallback text,
 * in the store, the message cache and the conversation preview. It now stores
 * the decrypted text, untrusted, as the live path does when the plugin is
 * already there.
 *
 * Such a message keeps its encrypted copy for the signature check, and the
 * app shows "could not decrypt" while that copy is set. When the plugin later
 * reports the check done, the client decrypts the sender's messages again so
 * they lose the copy (FLM-163: the maintainer chose to include this in the
 * fix).
 */
import 'fake-indexeddb/auto'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { localStorageMock } from './sideEffects.testHelpers'

Object.defineProperty(globalThis, 'localStorage', { value: localStorageMock, writable: true })

const transport = vi.hoisted(() => ({ current: null as unknown }))
vi.mock('@xmpp/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@xmpp/client')>()
  return { ...actual, client: vi.fn(() => transport.current) }
})
vi.mock('@xmpp/debug', () => ({ default: vi.fn() }))

import { xml, type Element } from '@xmpp/client'
import { XMPPClient } from './XMPPClient'
import { createMockXmppClient, type MockXmppClient } from './test-utils'
import { DummyPlaintextPlugin } from './e2ee/DummyPlaintextPlugin'
import type { ConversationHandle, DecryptResult, EncryptedPayload, InboundDecryptContext, PluginContext } from './e2ee/types'
import { chatStore } from '../stores/chatStore'
import { rosterStore } from '../stores/rosterStore'
import * as messageCache from '../utils/messageCache'
import type { Contact } from './types/roster'

const ALICE = 'alice@example.test'
const BOB = 'bob@example.test'
// What the test plugin puts in <body> for clients that cannot decrypt.
const FALLBACK = '[dummy-plaintext payload]'
const TEXTS = ['first while you signed in', 'second while you signed in', 'third while you signed in']

/** A message in Fluux's encrypted wire shape (Chat.applyE2EEToOutboundChat). */
function encrypted(id: string, text: string): Element {
  return xml('message', { type: 'chat', from: `${BOB}/phone`, to: `${ALICE}/web`, id },
    xml('body', {}, FALLBACK),
    xml('plain', { xmlns: 'urn:fluux:e2ee-dummy:0' }, Buffer.from(text).toString('base64')),
    xml('encryption', { xmlns: 'urn:xmpp:eme:0', namespace: 'urn:fluux:e2ee-dummy:0' }),
    xml('store', { xmlns: 'urn:xmpp:hints' }))
}

/**
 * Decrypts like the test plugin, and checks the signature the way the OpenPGP
 * plugin does: "untrusted" while the sender's key is not cached, then, once
 * the key arrives, a report of each finished check and "tofu" from then on.
 */
class KeyArrivesLaterPlugin extends DummyPlaintextPlugin {
  private context: PluginContext | null = null
  private keyCached = false

  override async init(ctx: PluginContext): Promise<void> {
    this.context = ctx
    await super.init(ctx)
  }

  override async decrypt(handle: ConversationHandle, payload: EncryptedPayload, context?: InboundDecryptContext): Promise<DecryptResult> {
    const result = await super.decrypt(handle, payload, context)
    if (!this.keyCached) return result
    return { ...result, securityContext: { protocolId: this.descriptor.id, trust: 'tofu' } }
  }

  /** The sender's key arrived and the held checks passed. */
  finishChecks(peer: string, messageIds: string[]): void {
    this.keyCached = true
    for (const messageId of messageIds) {
      this.context!.reportSecurityContextUpdate({ peer, messageId, securityContext: { protocolId: this.descriptor.id, trust: 'tofu' } })
    }
  }
}

describe('encrypted messages stored just before the E2EE plugin registers', () => {
  let client: XMPPClient
  let socket: MockXmppClient

  beforeEach(async () => {
    messageCache._resetDBForTesting()
    chatStore.getState().reset()
    rosterStore.getState().reset()
    client = new XMPPClient({ debug: false })
    socket = createMockXmppClient()
    transport.current = socket
    const connecting = client.connect({
      jid: ALICE, password: 'fixture-only', server: 'wss://example.test/ws', resource: 'web', skipDiscovery: true,
    })
    socket._emit('online')
    await connecting
    // Bob is a contact: a message from a stranger is held as a request.
    rosterStore.getState().setContacts([{ jid: BOB, name: 'Bob', presence: 'online', subscription: 'both' } as Contact])
    expect(client.e2ee).not.toBeNull()
  })

  afterEach(() => {
    client.destroy()
    chatStore.getState().reset()
    rosterStore.getState().reset()
    messageCache._resetDBForTesting()
  })

  it('stores their decrypted text in the store, the message cache and the preview when the signature is not checked yet', async () => {
    TEXTS.forEach((text, i) => socket._emit('stanza', encrypted(`late-${i}`, text)))
    const ids = TEXTS.map((_, i) => `late-${i}`)
    const cachedRows = async () => (await messageCache.getMessages(BOB)).filter((m) => ids.includes(m.id))
    // Before the plugin: stored, and cached, with the fallback text and the encrypted copy.
    await vi.waitFor(async () => {
      const rows = await cachedRows()
      expect(rows.map((m) => [m.body, !!m.encryptedPayload])).toEqual(TEXTS.map(() => [FALLBACK, true]))
    })

    // The test plugin decrypts, but reports the signature as unchecked
    // ("untrusted"), the way the OpenPGP plugin does while the sender's key
    // is not cached.
    await client.e2ee!.register(new DummyPlaintextPlugin())

    await vi.waitFor(async () => {
      expect((await cachedRows()).map((m) => m.body)).toEqual(TEXTS)
    })
    const messages = chatStore.getState().messages.get(BOB) ?? []
    expect(messages.map((m) => m.body)).toEqual(TEXTS)
    expect(chatStore.getState().conversationMeta.get(BOB)?.lastMessage?.body).toBe(TEXTS[2])
    expect(chatStore.getState().conversations.get(BOB)?.lastMessage?.body).toBe(TEXTS[2])
    // No more trust than the decrypt gave, and the encrypted copy stays for
    // the signature check once the sender's key arrives.
    for (const message of [...messages, ...await cachedRows()]) {
      expect(message.securityContext?.trust).toBe('untrusted')
      expect(message.encryptedPayload).toBeDefined()
    }
  })

  it('drops their encrypted copy once the plugin reports the signature check done', async () => {
    TEXTS.forEach((text, i) => socket._emit('stanza', encrypted(`late-${i}`, text)))
    const ids = TEXTS.map((_, i) => `late-${i}`)
    const cachedRows = async () => (await messageCache.getMessages(BOB)).filter((m) => ids.includes(m.id))
    await vi.waitFor(async () => expect(await cachedRows()).toHaveLength(TEXTS.length))
    const plugin = new KeyArrivesLaterPlugin()
    await client.e2ee!.register(plugin)
    await vi.waitFor(async () => {
      expect((await cachedRows()).map((m) => [m.body, m.securityContext?.trust, !!m.encryptedPayload]))
        .toEqual(TEXTS.map((text) => [text, 'untrusted', true]))
    })

    plugin.finishChecks(BOB, ids)

    await vi.waitFor(async () => {
      expect((await cachedRows()).map((m) => [m.body, m.securityContext?.trust, !!m.encryptedPayload]))
        .toEqual(TEXTS.map((text) => [text, 'tofu', false]))
    })
    const messages = chatStore.getState().messages.get(BOB) ?? []
    expect(messages.map((m) => [m.body, m.securityContext?.trust, !!m.encryptedPayload]))
      .toEqual(TEXTS.map((text) => [text, 'tofu', false]))
    // The app shows "could not decrypt" for a preview that keeps the copy.
    for (const preview of [chatStore.getState().conversationMeta.get(BOB)?.lastMessage, chatStore.getState().conversations.get(BOB)?.lastMessage]) {
      expect(preview?.body).toBe(TEXTS[2])
      expect(preview?.encryptedPayload).toBeUndefined()
    }
  })
})
