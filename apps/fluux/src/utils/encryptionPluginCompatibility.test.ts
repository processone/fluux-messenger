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
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  E2EEManager,
  E2EEEncryptionRequiredError,
  InMemoryStorageBackend,
  createPluginStorage,
  parsePayloadEnvelope,
  serializePayloadEnvelope,
  type ConversationTarget,
  type DecryptResult,
  type E2EEPlugin,
} from '@fluux/sdk'
import { xml } from '@fluux/sdk/xmpp'
import { WebOpenPGPPlugin } from '@fluux/openpgp-plugin/web'
import { clearSessionPassphrase, setSessionPassphrase } from '@fluux/openpgp-plugin'
import { normalizeFingerprint } from '@fluux/openpgp-plugin/fingerprintCompare'
import { OmemoPlugin } from '../../../../packages/omemo-plugin/src/OmemoPlugin'
import { PluginStorageOmemoStore } from '../../../../packages/omemo-plugin/src/store'
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

// Opt-in transcript of actual host readings for local proof, never key bytes.
function record(event: string, reading: unknown) {
  if (process.env.FLUUX_E2EE_CONTRACT_PROOF) console.info(JSON.stringify({ event, reading }))
}

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
  const host = new E2EEManager({
    account: { jid }, storage,
    xmpp: {
      ...ctx.xmpp,
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
  return { host, storage }
}

async function identity(host: E2EEManager, protocolId: string, peer = bobJid) {
  const group = (await host.listPeerIdentities(peer)).find((g) => g.protocolId === protocolId)
  expect(group, `host exposes ${protocolId} peer identities`).toBeDefined()
  expect(group!.identities).toHaveLength(1)
  const result = group!.identities[0]
  record('peer-identity', {
    protocolId, peer, trust: result.trust, usedForEncryption: result.usedForEncryption,
    allowedDecisions: result.allowedDecisions, notUsedReason: result.notUsedReason,
  })
  return result
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
  record('decrypted-message', { protocolId, status: result!.status ?? 'ok', body: receivedBody })
}

async function send(host: E2EEManager, target: ConversationTarget, text: string) {
  const encrypted = await host.encryptOutbound(target, body(text))
  expect(encrypted).not.toBeNull()
  // A valid ciphertext alone is insufficient: no cleartext copy may escape.
  expect(JSON.stringify(encrypted!.payload)).not.toContain(text)
  return encrypted!.payload.stanzaElement
}

describe.each(protocols)('$name SDK host compatibility', ({ create }) => {
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
    record('refused-send', { protocolId: id, encryptedPayload: sent, plaintextPermitted: false })

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
    const before = await Promise.all(senderDevices.map((device) => sessions.loadSession(aliceJid, Number(device.deviceId))))
    for (const session of before) expect(session).not.toBeNull()
    const replay = await bob.host.decryptArchiveBatch([first, second], toAlice, [
      { messageId: 'archive-first', fromArchive: true },
      { messageId: 'archive-second', fromArchive: true },
    ])
    expect(replay).toHaveLength(2)
    expectBody(replay[0], 'First archived private message', id)
    expectBody(replay[1], 'Second archived private message', id)
    const after = await Promise.all(senderDevices.map((device) => sessions.loadSession(aliceJid, Number(device.deviceId))))
    expect(after).toEqual(before)
    record('archive-session-state', { protocolId: id, sessionsCompared: before.length, unchanged: true })
    // Neither message key was consumed by archive reads: live delivery still works.
    expectBody(await bob.host.decryptInbound(first, toAlice), 'First archived private message', id)
    expectBody(await bob.host.decryptInbound(second, toAlice), 'Second archived private message', id)

    const next = await send(alice.host, toBob, 'Live private message after replay')
    expectBody(await bob.host.decryptInbound(next, toAlice), 'Live private message after replay', id)
    const nextReply = await send(bob.host, toAlice, 'Live private reply after replay')
    expectBody(await alice.host.decryptInbound(nextReply, toBob), 'Live private reply after replay', id)
  }, 30_000)
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
  record('host-restarted', { protocols: plugins.map((plugin) => plugin.descriptor.id) })
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
