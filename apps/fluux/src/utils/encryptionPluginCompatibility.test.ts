// @vitest-environment node
// The adapter's global ambient declarations are not an importable module.
// eslint-disable-next-line @typescript-eslint/triple-slash-reference
/// <reference path="../../../../packages/omemo-plugin/src/xmpp.d.ts" />
/**
 * Shared host compatibility for the real OpenPGP and OMEMO adapters.
 * Intent: the encryption plugin API must work for both protocols, including
 * identity decisions, isolated persistence and archive/live dispatch.
 * Lives in the app suite so the branch and batch gates both run it. Only the
 * XMPP transport is simulated; neither the SDK host nor crypto is mocked.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import 'fake-indexeddb/auto'
import { IDBFactory } from 'fake-indexeddb'
import {
  E2EEEncryptionRequiredError,
  InMemoryStorageBackend,
  createPluginStorage,
  parsePayloadEnvelope,
  serializePayloadEnvelope,
  type ConversationTarget,
  type DecryptResult,
  type E2EEPlugin,
  type Message,
  type XMLElementData,
} from '@fluux/sdk'
import { xml } from '@fluux/sdk/xmpp'
import { WebOpenPGPPlugin } from '@fluux/openpgp-plugin/web'
import { clearSessionPassphrase, setSessionPassphrase } from '@fluux/openpgp-plugin'
import { normalizeFingerprint } from '@fluux/openpgp-plugin/fingerprintCompare'
// MAM's internal stanza entry point and the manager must share one class
// declaration, rather than mixing source-private fields with built declarations.
import { E2EEManager } from '../../../../packages/fluux-sdk/src/core/e2ee/E2EEManager'
import { decryptStanzaInPlace } from '../../../../packages/fluux-sdk/src/core/e2ee/stanzaDecrypt'
import { DeferredDecryptEngine } from '../../../../packages/fluux-sdk/src/core/e2ee/deferredDecrypt'
import { createDefaultStoreBindings } from '../../../../packages/fluux-sdk/src/core/defaultStoreBindings'
import { Chat } from '../../../../packages/fluux-sdk/src/core/modules/Chat'
import { MAM } from '../../../../packages/fluux-sdk/src/core/modules/MAM'
import type { ModuleDependencies } from '../../../../packages/fluux-sdk/src/core/modules/BaseModule'
import { createPresenceReader } from '../../../../packages/fluux-sdk/src/core/presenceReader'
import * as cache from '../../../../packages/fluux-sdk/src/utils/messageCache'
import { _resetStorageScopeForTesting, setStorageScopeJid } from '../../../../packages/fluux-sdk/src/utils/storageScope'
import { dataToElement } from '../../../../packages/omemo-plugin/src/stanzaData'
import { OmemoPlugin } from '../../../../packages/omemo-plugin/src/OmemoPlugin'
import { PluginStorageOmemoStore } from '../../../../packages/omemo-plugin/src/store'
import { NS_DEVICES } from '../../../../packages/omemo-plugin/src/namespaces'
import {
  createMockPluginContext,
  newMockNetwork,
  type MockNetwork,
} from '../../../../packages/omemo-plugin/src/testing/MockPluginContext'

const protocols = [
  { name: 'OpenPGP', create: (): E2EEPlugin => new WebOpenPGPPlugin() },
  { name: 'OMEMO', create: (): E2EEPlugin => new OmemoPlugin() },
]
const aliceJid = 'alice@example.test'
const bobJid = 'bob@example.test'
const toBob: ConversationTarget = { kind: 'direct', peer: bobJid }
const toAlice: ConversationTarget = { kind: 'direct', peer: aliceJid }
const hosts: E2EEManager[] = []

beforeEach(() => {
  // Disposable generated keys only; never use a person's passphrase or keychain.
  setSessionPassphrase('compatibility-test-only')
})
afterEach(async () => {
  for (const host of hosts.splice(0)) await host.shutdown()
  clearSessionPassphrase()
})

async function ready(
  jid: string,
  net: MockNetwork,
  plugins: E2EEPlugin[],
  storage = new InMemoryStorageBackend(),
) {
  const { ctx } = createMockPluginContext(jid, net)
  const queryPEP = vi.fn(ctx.xmpp.queryPEP)
  const host = new E2EEManager({
    account: { jid }, storage,
    xmpp: {
      ...ctx.xmpp, queryPEP,
      // This fixture implements PEP; advertise it as an XMPP server would.
      queryDisco: async () => ({
        features: [{ var: 'http://jabber.org/protocol/pubsub' }],
        identities: [{ category: 'pubsub', type: 'pep' }],
      }),
    },
  })
  hosts.push(host)
  for (const plugin of plugins) {
    await host.register(plugin)
    await plugin.ensureIdentity()
  }
  return { host, storage, queryPEP }
}

async function identity(host: E2EEManager, protocolId: string, peer = bobJid) {
  const group = (await host.listPeerIdentities(peer)).find((g) => g.protocolId === protocolId)
  expect(group, `host exposes ${protocolId} peer identities`).toBeDefined()
  expect(group!.identities).toHaveLength(1)
  return group!.identities[0]
}

function body(text: string) {
  return new TextEncoder().encode(serializePayloadEnvelope([xml('body', {}, text)]))
}

function expectBody(result: DecryptResult | null, text: string, protocolId: string) {
  expect(result).not.toBeNull()
  expect(result!.status ?? 'ok').toBe('ok')
  expect(result!.securityContext.protocolId).toBe(protocolId)
  expect(result!.plaintext).toBeDefined()
  const envelope = parsePayloadEnvelope(new TextDecoder().decode(result!.plaintext!))
  expect(envelope).not.toBeNull()
  const receivedBody = envelope!.find((element) => element.name === 'body')?.children
  expect(receivedBody).toEqual([text])
}

async function send(host: E2EEManager, target: ConversationTarget, text: string) {
  const encrypted = await host.encryptOutbound(target, body(text))
  expect(encrypted).not.toBeNull()
  // A valid ciphertext alone is insufficient: no cleartext copy may escape.
  expect(JSON.stringify(encrypted!.payload)).not.toContain(text)
  return encrypted!.payload.stanzaElement
}

describe.each(protocols)('$name SDK host compatibility', ({ name, create }) => {
  it('keeps listed identity trust, send eligibility and plaintext protection consistent', async () => {
    const net = newMockNetwork()
    const plugin = create()
    const id = plugin.descriptor.id
    const alice = await ready(aliceJid, net, [plugin])
    const bobPlugin = create()
    const bob = await ready(bobJid, net, [bobPlugin])
    const first = await identity(alice.host, id)
    expect(first.id).not.toBe('')
    const ownFingerprint = await bob.host.getOwnFingerprint(id)
    expect(ownFingerprint).toBeTruthy()
    expect(normalizeFingerprint(first.fingerprint)).toBe(normalizeFingerprint(ownFingerprint!))
    expect(first.allowedDecisions).toEqual(expect.arrayContaining(['verified', 'untrusted']))

    await alice.host.setIdentityTrust(id, bobJid, first.id, 'verified')
    expect(await identity(alice.host, id)).toMatchObject({
      id: first.id, fingerprint: first.fingerprint, trust: 'verified', usedForEncryption: true,
    })
    expect(await alice.host.getConversationSecurity(toBob)).toMatchObject({
      kind: 'encrypted', protocolId: id, trust: 'verified', used: 1, verified: 1,
    })
    const ciphertext = await send(alice.host, toBob, 'Verified private message')
    expectBody(await bob.host.decryptInbound(ciphertext, toAlice), 'Verified private message', id)

    await alice.host.setIdentityTrust(id, bobJid, first.id, 'untrusted')
    expect(await identity(alice.host, id)).toMatchObject({
      id: first.id, fingerprint: first.fingerprint, trust: 'untrusted', usedForEncryption: false,
    })
    expect((await alice.host.getConversationSecurity(toBob)).kind).not.toBe('encrypted')
    // The host may select no strategy or the adapter may reject encryption;
    // neither outcome authorizes falling back to plaintext.
    let sent = null
    try {
      sent = await alice.host.encryptOutbound(toBob, body('Blocked private message'))
    } catch (error) {
      expect(error).toBeInstanceOf(Error)
    }
    expect(sent).toBeNull()
    await expect(alice.host.assertPlaintextPermitted(toBob)).rejects.toBeInstanceOf(E2EEEncryptionRequiredError)

    await alice.host.setIdentityTrust(id, bobJid, first.id, 'verified')
    const restored = await send(alice.host, toBob, 'Reauthorized private message')
    expectBody(await bob.host.decryptInbound(restored, toAlice), 'Reauthorized private message', id)
  }, 30_000)

  it('replays an archive page without consuming live sessions, then continues both directions', async () => {
    const net = newMockNetwork()
    const plugin = create()
    const id = plugin.descriptor.id
    const alice = await ready(aliceJid, net, [plugin])
    const bob = await ready(bobJid, net, [create()])
    const initial = await send(alice.host, toBob, 'Live private message before replay')
    expectBody(await bob.host.decryptInbound(initial, toAlice), 'Live private message before replay', id)
    const reply = await send(bob.host, toAlice, 'Private reply before replay')
    expectBody(await alice.host.decryptInbound(reply, toBob), 'Private reply before replay', id)
    // A page retrieved while catching up, not yet consumed by live decryption.
    // Archive mode promises frozen session reads, not retention of used keys.
    const first = await send(alice.host, toBob, 'First archived private message')
    const second = await send(alice.host, toBob, 'Second archived private message')

    // Read the real OMEMO store through its owning codec, not hard-coded keys.
    const sessions = new PluginStorageOmemoStore(createPluginStorage(bob.storage, `e2ee/${id}`))
    const senderDevices = (await plugin.ensureIdentity()).devices ?? []
    if (plugin instanceof OmemoPlugin) expect(senderDevices).toHaveLength(1)
    const readSessions = () => Promise.all(senderDevices.map((device) => sessions.loadSession(aliceJid, Number(device.deviceId))))
    const before = await readSessions()
    for (const session of before) expect(session).not.toBeNull()
    // MAM uses the single-message entry point; batch is a separate API contract.
    expectBody(await bob.host.decryptArchive(first, toAlice, { fromArchive: true }), 'First archived private message', id)
    expectBody(await bob.host.decryptArchive(second, toAlice, { fromArchive: true }), 'Second archived private message', id)
    expect(await readSessions()).toEqual(before)
    const replay = await bob.host.decryptArchiveBatch([first, second], toAlice, [
      { messageId: 'archive-first', fromArchive: true },
      { messageId: 'archive-second', fromArchive: true },
    ])
    expect(replay).toHaveLength(2)
    expectBody(replay[0], 'First archived private message', id)
    expectBody(replay[1], 'Second archived private message', id)
    expect(await readSessions()).toEqual(before)
    // Neither message key was consumed by archive reads: live delivery still works.
    expectBody(await bob.host.decryptInbound(first, toAlice), 'First archived private message', id)
    expectBody(await bob.host.decryptInbound(second, toAlice), 'Second archived private message', id)

    const next = await send(alice.host, toBob, 'Live private message after replay')
    expectBody(await bob.host.decryptInbound(next, toAlice), 'Live private message after replay', id)
    const nextReply = await send(bob.host, toAlice, 'Live private reply after replay')
    expectBody(await alice.host.decryptInbound(nextReply, toBob), 'Live private reply after replay', id)
  }, 30_000)

  describe('already-delivered archive overlap', () => {
    let receiver: E2EEManager
    let earlierChain: XMLElementData
    let currentChain: XMLElementData
    let protocolId: string
    let sender: E2EEManager
    let readSessions: () => Promise<(Uint8Array | null)[]>

    // Real delivered traffic across a DH turn, shared by both archive entry points.
    beforeEach(async () => {
      const net = newMockNetwork()
      const plugin = create()
      protocolId = plugin.descriptor.id
      const alice = await ready(aliceJid, net, [plugin])
      const bob = await ready(bobJid, net, [create()])
      receiver = bob.host
      sender = alice.host
      const sessions = new PluginStorageOmemoStore(createPluginStorage(bob.storage, `e2ee/${protocolId}`))
      const devices = (await plugin.ensureIdentity()).devices ?? []
      if (plugin instanceof OmemoPlugin) expect(devices).toHaveLength(1)
      readSessions = () => Promise.all(devices.map((device) => sessions.loadSession(aliceJid, Number(device.deviceId))))
      earlierChain = await send(alice.host, toBob, 'earlier chain private message')
      expectBody(await receiver.decryptInbound(earlierChain, toAlice), 'earlier chain private message', protocolId)
      const reply = await send(bob.host, toAlice, 'private reply advancing the ratchet')
      expectBody(await alice.host.decryptInbound(reply, toBob), 'private reply advancing the ratchet', protocolId)
      currentChain = await send(alice.host, toBob, 'current chain private message')
      expectBody(await receiver.decryptInbound(currentChain, toAlice), 'current chain private message', protocolId)
    })

    for (const path of ['single', 'batch'] as const) {
      async function replay(ciphertext: XMLElementData) {
        if (path === 'single') return receiver.decryptArchive(ciphertext, toAlice, { fromArchive: true })
        const results = await receiver.decryptArchiveBatch([ciphertext], toAlice, [{ fromArchive: true }])
        expect(results).toHaveLength(1)
        return results[0]
      }

      function expectHarmlessReplay(result: DecryptResult | null, text: string) {
        if (name === 'OMEMO') {
          expect(result).toMatchObject({ status: 'control-message', securityContext: { protocolId } })
          expect(result!.plaintext).toBeUndefined()
        } else expectBody(result, text, protocolId)
      }

      it(`${path}: treats a consumed current-chain message as a harmless replay`, async () => {
        expectHarmlessReplay(await replay(currentChain), 'current chain private message')
      })

      it(`${path}: preserves sessions and live continuation after consumed earlier-chain replay`, async () => {
        const before = await readSessions()
        await replay(earlierChain)
        expect(await readSessions()).toEqual(before)
        const next = await send(sender, toBob, 'live after consumed replay')
        expectBody(await receiver.decryptInbound(next, toAlice), 'live after consumed replay', protocolId)
        const reply = await send(receiver, toAlice, 'reply after consumed replay')
        expectBody(await sender.decryptInbound(reply, toBob), 'reply after consumed replay', protocolId)
      })

      it(`${path}: treats a consumed earlier-chain message as a harmless replay`, async () => {
        expectHarmlessReplay(await replay(earlierChain), 'earlier chain private message')
      })
    }

    if (name === 'OMEMO') {
      it('MAM: consumes an earlier-chain replay without a permanent failure or fallback body', async () => {
        const stanza = xml('message', { from: aliceJid, to: bobJid, type: 'chat' },
          dataToElement(earlierChain), xml('body', {}, '[This message is OMEMO-encrypted.]'))
        const before = await readSessions()
        const result = await decryptStanzaInPlace(stanza, receiver, aliceJid, 'archive')
        expect(result.attempted).toBe(true)
        expect(result.encryptedPayloadXml).toBeUndefined()
        expect(result.securityContext?.failureReason).toBeUndefined()
        expect(stanza.children).toEqual([])
        expect(await readSessions()).toEqual(before)
      })
    }
  })
})

it('isolates both protocols on one host and restores independent decisions after restart', async () => {
  const net = newMockNetwork()
  const plugins = protocols.map(({ create }) => create())
  const alice = await ready(aliceJid, net, plugins)
  await ready(bobJid, net, protocols.map(({ create }) => create()))
  const [openpgp, omemo] = plugins.map((plugin) => plugin.descriptor.id)
  const pgpIdentity = await identity(alice.host, openpgp)
  const omemoIdentity = await identity(alice.host, omemo)
  const fingerprints = await Promise.all(plugins.map((plugin) => alice.host.getOwnFingerprint(plugin.descriptor.id)))
  await alice.host.setIdentityTrust(openpgp, bobJid, pgpIdentity.id, 'verified')
  await alice.host.setIdentityTrust(omemo, bobJid, omemoIdentity.id, 'untrusted')
  expect(await identity(alice.host, openpgp)).toMatchObject({ trust: 'verified', usedForEncryption: true })
  expect(await identity(alice.host, omemo)).toMatchObject({ trust: 'untrusted', usedForEncryption: false })

  await alice.host.shutdown()
  hosts.splice(hosts.indexOf(alice.host), 1)
  const restored = await ready(aliceJid, net, protocols.map(({ create }) => create()), alice.storage)
  expect(await Promise.all(plugins.map((plugin) => restored.host.getOwnFingerprint(plugin.descriptor.id)))).toEqual(fingerprints)
  expect(await identity(restored.host, openpgp)).toMatchObject({
    id: pgpIdentity.id, fingerprint: pgpIdentity.fingerprint, trust: 'verified', usedForEncryption: true,
  })
  expect(await identity(restored.host, omemo)).toMatchObject({
    id: omemoIdentity.id, fingerprint: omemoIdentity.fingerprint, trust: 'untrusted', usedForEncryption: false,
  })
  await restored.host.setIdentityTrust(omemo, bobJid, omemoIdentity.id, 'verified')
  await restored.host.setIdentityTrust(openpgp, bobJid, pgpIdentity.id, 'untrusted')
  expect(await identity(restored.host, openpgp)).toMatchObject({ trust: 'untrusted', usedForEncryption: false })
  expect(await identity(restored.host, omemo)).toMatchObject({ trust: 'verified', usedForEncryption: true })
}, 30_000)

// FLM-655: a decision about an authenticated OMEMO sender needs no message key;
// OpenPGP still needs its ciphertext when the signature has not been verified.
describe('stored messages awaiting trust', () => {
  beforeEach(() => {
    vi.stubGlobal('indexedDB', new IDBFactory())
    cache._resetDBForTesting()
    setStorageScopeJid(bobJid)
  })

  afterEach(() => {
    cache._resetDBForTesting()
    _resetStorageScopeForTesting()
    vi.unstubAllGlobals()
  })

  async function deliver(receiver: E2EEManager, ciphertext: XMLElementData, id: string) {
    const stanza = xml('message', { id, from: `${aliceJid}/test`, to: bobJid, type: 'chat' },
      dataToElement(ciphertext), xml('body', {}, '[Encrypted message]'))
    // Chat emits the parsed message; the fixture writes it to the real SDK cache
    // without a resident conversation, so the durable retry pass owns the row.
    return new Promise<Message>((resolve) => {
      const deps: ModuleDependencies = {
        stores: null, presence: createPresenceReader(), sendStanza: async () => {},
        sendIQ: async () => xml('iq', {}), getCurrentJid: () => bobJid, getXmpp: () => null,
        getE2EEManager: () => receiver, emit: () => {}, emitSDK: (event, payload) => {
          if (event === 'chat:message') resolve((payload as { message: Message }).message)
        },
      }
      new Chat(deps, new MAM(deps)).handle(stanza)
    })
  }

  function retryEngine(manager: E2EEManager) {
    const stores = createDefaultStoreBindings()
    return new DeferredDecryptEngine({
      getManager: () => manager, getStores: () => stores, getOwnBareJid: () => bobJid,
      cache, updateSearchIndex: async () => {},
    })
  }

  async function omemoPeers() {
    const net = newMockNetwork()
    const siblingPlugin = new OmemoPlugin()
    const sibling = await ready(aliceJid, net, [siblingPlugin])
    const bob = await ready(bobJid, net, [new OmemoPlugin()])
    const protocolId = siblingPlugin.descriptor.id
    const verifiedSibling = await identity(bob.host, protocolId, aliceJid)
    await bob.host.setIdentityTrust(protocolId, aliceJid, verifiedSibling.id, 'verified')
    const senderPlugin = new OmemoPlugin()
    const sender = await ready(aliceJid, net, [senderPlugin])
    const device = (await senderPlugin.ensureIdentity()).devices![0]
    expect(device.deviceId).not.toBe(verifiedSibling.id)
    const storeFor = (storage: InMemoryStorageBackend) =>
      new PluginStorageOmemoStore(createPluginStorage(storage, `e2ee/${protocolId}`))
    return { net, bob, sender, device, protocolId, store: storeFor(bob.storage), siblingStore: storeFor(sibling.storage) }
  }

  it('keeps authenticated OMEMO text out of the queue across a ratchet turn but recovers unopened ciphertext', async () => {
    const { bob, sender, device, store, protocolId } = await omemoPeers()
    const earlierText = 'Private text before the sending chain changed'
    const currentText = 'Private text after the sending chain changed'
    const earlier = await deliver(bob.host, await send(sender.host, toBob, earlierText), 'earlier')
    await cache.saveMessage('chat', earlier)
    // Bob cannot send to the waiting device. Approve it to turn the ratchet,
    // then refuse it before the next inbound message so that text is untrusted too.
    await bob.host.setIdentityTrust(protocolId, aliceJid, device.deviceId, 'tofu')
    const reply = await send(bob.host, toAlice, 'Private reply advancing the ratchet')
    expectBody(await sender.host.decryptInbound(reply, toBob), 'Private reply advancing the ratchet', protocolId)
    await bob.host.setIdentityTrust(protocolId, aliceJid, device.deviceId, 'untrusted')
    const current = await deliver(bob.host, await send(sender.host, toBob, currentText), 'current')
    await cache.saveMessage('chat', current)
    const session = () => store.loadSession(aliceJid, Number(device.deviceId))
    const before = await session()
    expect(before).not.toBeNull()
    const archive = vi.spyOn(bob.host, 'decryptArchive')
    const engine = retryEngine(bob.host)
    expect(await cache.getMessagesWithEncryptedPayload()).toEqual([])
    expect(await engine.retryPending()).toBe(0)
    expect(archive).not.toHaveBeenCalled()
    expect(await session()).toEqual(before)
    for (const [id, text] of [['earlier', earlierText], ['current', currentText]]) {
      const row = (await cache.getMessages('chat', aliceJid)).find(m => m.id === id)
      expect(row).toMatchObject({ body: text, contentAvailability: { state: 'ready' }, securityContext: {
        protocolId, trust: 'untrusted', authenticatedDevice: { deviceId: device.deviceId },
      } })
      expect(row?.encryptedPayload).toBeUndefined()
    }

    const waitingText = 'Private text not yet delivered live'
    const unopened = await send(sender.host, toBob, waitingText)
    await cache.saveMessage('chat', {
      ...current, id: 'waiting', body: '[Encrypted message]', securityContext: undefined,
      contentAvailability: { state: 'waiting' }, encryptedPayload: dataToElement(unopened).toString(),
    })
    expect(await engine.retryPending()).toBe(1)
    expect(archive).toHaveBeenCalledTimes(1)
    expect((await cache.getMessages('chat', aliceJid)).find(m => m.id === 'waiting')).toMatchObject({
      body: waitingText, contentAvailability: { state: 'ready' }, securityContext: {
        trust: 'untrusted', authenticatedDevice: { jid: aliceJid, deviceId: device.deviceId },
      },
    })
    expect(await cache.getMessagesWithEncryptedPayload()).toEqual([])
    expect(await session()).toEqual(before)
  })

  it('reads saved OMEMO trust offline without trusting a sibling or replacement key', async () => {
    const { net, bob, sender, device, protocolId, store, siblingStore } = await omemoPeers()
    const text = 'Private text from a device awaiting a decision'
    const received = await deliver(bob.host, await send(sender.host, toBob, text), 'decision')
    await cache.saveMessage('chat', received)
    const [stored] = await cache.getMessages('chat', aliceJid)
    const context = stored.securityContext!
    const fingerprint = await sender.host.getOwnFingerprint(protocolId)
    expect(fingerprint).toBeTruthy()
    expect(context.authenticatedDevice).toEqual({ jid: aliceJid, deviceId: device.deviceId, fingerprint })
    expect(stored.encryptedPayload).toBeUndefined()
    const archive = vi.spyOn(bob.host, 'decryptArchive')
    const trust = () => bob.host.getMessageTrust(context)
    net.nodes.delete(`${aliceJid} ${NS_DEVICES}`)
    bob.queryPEP.mockClear().mockRejectedValue(new Error('offline'))
    expect(await trust()).toBe('untrusted') // A sibling device is already verified.
    for (const decision of ['verified', 'untrusted', 'tofu', 'verified'] as const) {
      await bob.host.setIdentityTrust(protocolId, aliceJid, device.deviceId, decision)
      expect(await trust()).toBe(decision)
    }
    expect(await bob.host.getMessageTrust({ protocolId, trust: 'untrusted' })).toBe('untrusted')
    const replacement = (await siblingStore.loadIdentity())!.edPub
    await store.saveTrust(aliceJid, Number(device.deviceId), { state: 'undecided', identityKey: replacement })
    expect(await trust()).toBe('untrusted') // The old verification marker still exists.
    await bob.host.setIdentityTrust(protocolId, aliceJid, device.deviceId, 'verified')
    expect(await trust()).toBe('untrusted')
    expect(bob.queryPEP).not.toHaveBeenCalled()
    expect(await cache.getMessagesWithEncryptedPayload()).toEqual([])
    expect(await cache.getMessages('chat', aliceJid)).toEqual([stored])
    expect(stored.body).toBe(text)
    expect(archive).not.toHaveBeenCalled()
  })

  it('keeps an OpenPGP message queued until its original signature can be verified', async () => {
    const net = newMockNetwork()
    const alice = await ready(aliceJid, net, [new WebOpenPGPPlugin()])
    const receiver = new WebOpenPGPPlugin()
    const bob = await ready(bobJid, net, [receiver])
    const text = 'Private text from a sender whose key is not cached yet'
    const message = await deliver(bob.host, await send(alice.host, toBob, text), 'openpgp')
    expect(message).toMatchObject({ body: text, contentAvailability: { state: 'verification' }, securityContext: { trust: 'untrusted' } })
    expect(message.encryptedPayload).toBeDefined()
    await cache.saveMessage('chat', message)
    expect(await cache.getMessagesWithEncryptedPayload()).toHaveLength(1)
    expect((await receiver.probePeer(aliceJid)).supported).toBe(true)
    expect(await retryEngine(bob.host).retryPending()).toBe(1)
    expect(await cache.getMessages('chat', aliceJid)).toMatchObject([
      { body: text, contentAvailability: { state: 'ready' }, securityContext: { protocolId: 'openpgp', trust: 'tofu' } },
    ])
    expect(await cache.getMessagesWithEncryptedPayload()).toEqual([])
  })
})
