// Protocol-level behaviour of the OMEMO adapter that a standards-compliant peer or a
// concurrent host depends on: SCE content namespaces, multi-device PEP discovery,
// blind-trust-before-verification on the SEND side, failure classification (only a real
// session break may trigger repair) and SCE affix scoping. Each case drives two or more
// real plugin instances over the shared in-memory PEP network, with the host's actual
// payload shape (a `<body>` that carries no xmlns of its own).
import { describe, it, expect } from 'vitest'
import { xml } from '@xmpp/client'
import { serializePayloadEnvelope, parsePayloadEnvelope } from '@fluux/sdk'
import type { ConversationHandle, EncryptedPayload } from '@fluux/sdk'
import { OmemoAccount } from '@fluux/omemo'
import { OmemoPlugin } from './OmemoPlugin'
import { createMockPluginContext, type MockNetwork } from './testing/MockPluginContext'
import { PluginStorageOmemoStore } from './store'
import { fetchBundle, fetchDeviceList, publishDeviceList } from './pep'
import { buildEnvelope } from './sce'
import { parseXml } from './stanzaData'
import { setVerified } from './verifiedDevices'
import { bundlesNode } from './namespaces'
import { buildEncrypted } from './encryptedElement'
import { elementToData } from './stanzaData'

async function ready(jid: string, net?: MockNetwork) {
  const c = createMockPluginContext(jid, net)
  const p = new OmemoPlugin()
  await p.init(c.ctx)
  const id = await p.ensureIdentity()
  return { p, c, deviceId: Number(id.devices![0].deviceId) }
}

/** The host's real payload shape: a body with no xmlns, inheriting jabber:client from <payload>. */
const bodyPayload = (text: string): Uint8Array =>
  new TextEncoder().encode(serializePayloadEnvelope([xml('body', {}, text)]))

const textOf = (plaintext?: Uint8Array): string => new TextDecoder().decode(plaintext)

async function send(from: Awaited<ReturnType<typeof ready>>, peer: string, text: string) {
  const handle = await from.p.openConversation({ kind: 'direct', peer })
  return from.p.encrypt(handle, bodyPayload(text))
}

const claim = (p: OmemoPlugin, e: EncryptedPayload): EncryptedPayload => p.tryClaimInbound(e.stanzaElement)!

describe('SCE content namespace', () => {
  it('keeps a body that inherited jabber:client in jabber:client inside the envelope', () => {
    const [body] = parsePayloadEnvelope(serializePayloadEnvelope([xml('body', {}, 'hi')]))!
    const env = buildEnvelope([body], {}, (n) => new Uint8Array(n).fill(1))
    const reparsed = parseXml(env.toString())
    expect(reparsed.getChild('content')!.getChild('body')!.getNS()).toBe('jabber:client')
  })

  it('delivers the host body to the peer in jabber:client end to end', async () => {
    const alice = await ready('alice@x')
    const bob = await ready('bob@x', alice.c.net)
    const enc = await send(alice, 'bob@x', 'hello')
    const handle = await bob.p.openConversation({ kind: 'direct', peer: 'alice@x' })
    const res = await bob.p.decrypt(handle, claim(bob.p, enc), {})
    const [body] = parsePayloadEnvelope(textOf(res.plaintext))!
    expect(body.name).toBe('body')
    expect(body.getNS()).toBe('jabber:client')
  })
})

describe('multi-device PEP discovery', () => {
  it('publishes each device bundle as an item of the shared bundles node and fetches the right one', async () => {
    const alice = await ready('alice@x')
    const bob1 = await ready('bob@x', alice.c.net)
    const bob2 = await ready('bob@x', alice.c.net)

    expect(await fetchDeviceList(alice.c.ctx.xmpp, 'bob@x')).toEqual([bob1.deviceId, bob2.deviceId])
    const items = alice.c.net.nodes.get(`bob@x ${bundlesNode()}`)!
    expect(items.map((i) => i.id).sort()).toEqual([String(bob1.deviceId), String(bob2.deviceId)].sort())
    expect((await fetchBundle(alice.c.ctx.xmpp, 'bob@x', bob1.deviceId))!.ik).not.toEqual(
      (await fetchBundle(alice.c.ctx.xmpp, 'bob@x', bob2.deviceId))!.ik,
    )

    // One message reaches both of the peer's devices.
    const enc = await send(alice, 'bob@x', 'to both')
    for (const bob of [bob1, bob2]) {
      const handle = await bob.p.openConversation({ kind: 'direct', peer: 'alice@x' })
      const res = await bob.p.decrypt(handle, claim(bob.p, enc), {})
      expect(textOf(res.plaintext)).toContain('to both')
    }
  })

  it('exchanges messages in both directions', async () => {
    const alice = await ready('alice@x')
    const bob = await ready('bob@x', alice.c.net)
    const aHandle = await alice.p.openConversation({ kind: 'direct', peer: 'bob@x' })
    const bHandle = await bob.p.openConversation({ kind: 'direct', peer: 'alice@x' })
    const m1 = await send(alice, 'bob@x', 'ping')
    expect(textOf((await bob.p.decrypt(bHandle, claim(bob.p, m1), {})).plaintext)).toContain('ping')
    const m2 = await send(bob, 'alice@x', 'pong')
    expect(textOf((await alice.p.decrypt(aHandle, claim(alice.p, m2), {})).plaintext)).toContain('pong')
  })

  it('still encrypts to the reachable device when another device bundle is malformed', async () => {
    const alice = await ready('alice@x')
    const bob = await ready('bob@x', alice.c.net)
    const ghost = 4242
    await publishDeviceList(bob.c.ctx.xmpp, [bob.deviceId, ghost])
    // A bundle item whose XML is structurally wrong (missing every child).
    const node = `bob@x ${bundlesNode()}`
    alice.c.net.nodes.set(node, [
      ...alice.c.net.nodes.get(node)!,
      { id: String(ghost), payload: { name: 'bundle', attrs: { xmlns: 'urn:xmpp:omemo:2' }, children: [] } },
    ])

    const enc = await send(alice, 'bob@x', 'still delivered')
    const handle = await bob.p.openConversation({ kind: 'direct', peer: 'alice@x' })
    expect(textOf((await bob.p.decrypt(handle, claim(bob.p, enc), {})).plaintext)).toContain('still delivered')
  })
})

describe('blind trust before verification on send', () => {
  it('stops encrypting to a newly advertised device once another device is verified', async () => {
    const alice = await ready('alice@x')
    const bob1 = await ready('bob@x', alice.c.net)
    // Alice verifies Bob's first device.
    const bundle1 = (await fetchBundle(alice.c.ctx.xmpp, 'bob@x', bob1.deviceId))!
    const store = new PluginStorageOmemoStore(alice.c.ctx.storage)
    await store.saveTrust('bob@x', bob1.deviceId, { state: 'trusted', identityKey: bundle1.ik })
    const { fingerprint } = await import('@fluux/omemo')
    const hex = [...fingerprint(bundle1.ik)].map((b) => b.toString(16).padStart(2, '0')).join('')
    await setVerified(alice.c.ctx.storage, 'bob@x', bob1.deviceId, hex)

    // Bob adds a second device afterwards.
    const bob2 = await ready('bob@x', alice.c.net)
    expect(await alice.p.getDeviceTrust('bob@x', String(bob2.deviceId))).toBe('untrusted')
    expect(await alice.p.getPeerTrust('bob@x')).toBe('untrusted')

    const enc = await send(alice, 'bob@x', 'only the verified device')
    const keys = (enc.stanzaElement.children as Array<{ name: string; children: unknown[] }>)[0]
    const rids = JSON.stringify(keys)
    expect(rids).toContain(`"rid":"${bob1.deviceId}"`)
    expect(rids).not.toContain(`"rid":"${bob2.deviceId}"`)
  })

  it('still blind-trusts new devices while nothing is verified', async () => {
    const alice = await ready('alice@x')
    await ready('bob@x', alice.c.net)
    const bob2 = await ready('bob@x', alice.c.net)
    const enc = await send(alice, 'bob@x', 'both')
    expect(JSON.stringify(enc.stanzaElement)).toContain(`"rid":"${bob2.deviceId}"`)
  })
})

describe('failure classification', () => {
  it('reports a redelivered message as a silent control message, not a broken session', async () => {
    const alice = await ready('alice@x')
    const bob = await ready('bob@x', alice.c.net)
    const handle = await bob.p.openConversation({ kind: 'direct', peer: 'alice@x' })
    const enc = await send(alice, 'bob@x', 'once')
    expect((await bob.p.decrypt(handle, claim(bob.p, enc), {})).status).toBe('ok')
    const again = await bob.p.decrypt(handle, claim(bob.p, enc), {})
    expect(again.status).toBe('control-message')
    expect(again.plaintext).toBeUndefined()
    // The session still works afterwards.
    const next = await send(alice, 'bob@x', 'twice')
    expect(textOf((await bob.p.decrypt(handle, claim(bob.p, next), {})).plaintext)).toContain('twice')
  })

  it('rejects a stanza with no readable <header> as malformed without touching the session', async () => {
    const bob = await ready('bob@x')
    const handle = await bob.p.openConversation({ kind: 'direct', peer: 'alice@x' })
    await expect(
      bob.p.decrypt(handle, { protocolId: 'omemo:2', stanzaElement: { name: 'encrypted', attrs: { xmlns: 'urn:xmpp:omemo:2' }, children: [] } }, {}),
    ).rejects.toMatchObject({ kind: 'permanent', code: 'malformed-data' })
  })

  it('reports a message whose session was lost as a broken session', async () => {
    const alice = await ready('alice@x')
    const bob = await ready('bob@x', alice.c.net)
    const handle = await bob.p.openConversation({ kind: 'direct', peer: 'alice@x' })
    await bob.p.decrypt(handle, claim(bob.p, await send(alice, 'bob@x', 'establish')), {})
    // Alice has not heard back, so her next message is still a key exchange, but the
    // prekey it names was consumed. Bob also loses his session.
    const followUp = await send(alice, 'bob@x', 'after loss')
    await bob.c.ctx.storage.delete(`session/alice@x/${alice.deviceId}`)
    const res = await bob.p.decrypt(handle, claim(bob.p, followUp), {})
    expect(res.status).toBe('broken-session')
  })
})

describe('SCE affix scoping', () => {
  async function craft(
    sender: Awaited<ReturnType<typeof ready>>,
    recipient: { jid: string; deviceIds: number[] }[],
    affixes: { from: string; to: string },
  ) {
    const acc = await OmemoAccount.create(new PluginStorageOmemoStore(sender.c.ctx.storage), (n) =>
      crypto.getRandomValues(new Uint8Array(n)),
    )
    for (const r of recipient) {
      for (const id of r.deviceIds) await acc.processBundle(r.jid, id, (await fetchBundle(sender.c.ctx.xmpp, r.jid, id))!)
    }
    const [body] = parsePayloadEnvelope(serializePayloadEnvelope([xml('body', {}, 'redirected')]))!
    const env = buildEnvelope([body], { ...affixes, timeIso: new Date().toISOString() }, (n) =>
      crypto.getRandomValues(new Uint8Array(n)),
    )
    const msg = await acc.encrypt(recipient, new TextEncoder().encode(env.toString()))
    return { protocolId: 'omemo:2', stanzaElement: elementToData(buildEncrypted(msg)) } satisfies EncryptedPayload
  }

  it('rejects an authenticated message whose <to> names a different conversation', async () => {
    const alice = await ready('alice@x')
    const bob = await ready('bob@x', alice.c.net)
    const handle = await bob.p.openConversation({ kind: 'direct', peer: 'alice@x' })
    // Alice really sends to Bob but the envelope claims it was addressed to carol.
    const enc = await craft(alice, [{ jid: 'bob@x', deviceIds: [bob.deviceId] }], { from: 'alice@x', to: 'carol@x' })
    await expect(bob.p.decrypt(handle, enc, {})).rejects.toMatchObject({ code: 'malformed-data' })
  })

  it('rejects an authenticated message whose <from> is not the session partner', async () => {
    const alice = await ready('alice@x')
    const bob = await ready('bob@x', alice.c.net)
    const handle = await bob.p.openConversation({ kind: 'direct', peer: 'alice@x' })
    const enc = await craft(alice, [{ jid: 'bob@x', deviceIds: [bob.deviceId] }], { from: 'mallory@x', to: 'bob@x' })
    await expect(bob.p.decrypt(handle, enc, {})).rejects.toMatchObject({ code: 'malformed-data' })
  })

  it('accepts matching affixes and matching resources-bearing JIDs', async () => {
    const alice = await ready('alice@x')
    const bob = await ready('bob@x', alice.c.net)
    const handle = await bob.p.openConversation({ kind: 'direct', peer: 'alice@x' })
    const enc = await craft(alice, [{ jid: 'bob@x', deviceIds: [bob.deviceId] }], { from: 'alice@x/phone', to: 'bob@x' })
    expect((await bob.p.decrypt(handle, enc, {})).status).toBe('ok')
  })
})

describe('verified inbound security', () => {
  it('reports a verified device as verified, not tofu', async () => {
    const alice = await ready('alice@x')
    const bob = await ready('bob@x', alice.c.net)
    const handle = await bob.p.openConversation({ kind: 'direct', peer: 'alice@x' })
    const aliceBundle = (await fetchBundle(bob.c.ctx.xmpp, 'alice@x', alice.deviceId))!
    const { fingerprint } = await import('@fluux/omemo')
    const hex = [...fingerprint(aliceBundle.ik)].map((b) => b.toString(16).padStart(2, '0')).join('')
    await setVerified(bob.c.ctx.storage, 'alice@x', alice.deviceId, hex)

    const enc = await send(alice, 'bob@x', 'from a verified device')
    const res = await bob.p.decrypt(handle, claim(bob.p, enc), {})
    expect(res.securityContext.trust).toBe('verified')
    expect(await bob.p.getDeviceTrust('alice@x', String(alice.deviceId))).toBe('verified')
  })
})

describe('own-account initialisation', () => {
  it('creates one identity when several calls race on first use', async () => {
    const c = createMockPluginContext('alice@x')
    const p = new OmemoPlugin()
    await p.init(c.ctx)
    const ids = await Promise.all([p.ensureIdentity(), p.ensureIdentity(), p.getOwnFingerprint()])
    expect(new Set([ids[0].fingerprint, ids[1].fingerprint, ids[2]]).size).toBe(1)
    expect(await fetchDeviceList(c.ctx.xmpp, 'alice@x')).toHaveLength(1)
  })

  it('republishes the bundle without the prekey a peer consumed', async () => {
    const alice = await ready('alice@x')
    const bob = await ready('bob@x', alice.c.net)
    const before = (await fetchBundle(alice.c.ctx.xmpp, 'bob@x', bob.deviceId))!
    const enc = await send(alice, 'bob@x', 'uses a prekey')
    const handle = await bob.p.openConversation({ kind: 'direct', peer: 'alice@x' })
    await bob.p.decrypt(handle, claim(bob.p, enc), {})
    const after = (await fetchBundle(alice.c.ctx.xmpp, 'bob@x', bob.deviceId))!
    const gone = before.preKeys.filter((p) => !after.preKeys.some((q) => q.id === p.id))
    expect(gone).toHaveLength(1)
    expect(after.preKeys).toHaveLength(before.preKeys.length)
  })
})

describe('session repair', () => {
  it('rebuilds a session with a fresh key exchange the peer accepts, via a spec-shaped key transport', async () => {
    const alice = await ready('alice@x')
    const bob = await ready('bob@x', alice.c.net)
    const bHandle: ConversationHandle = await bob.p.openConversation({ kind: 'direct', peer: 'alice@x' })
    const aHandle = await alice.p.openConversation({ kind: 'direct', peer: 'bob@x' })
    await bob.p.decrypt(bHandle, claim(bob.p, await send(alice, 'bob@x', 'one')), {})
    await alice.p.decrypt(aHandle, claim(alice.p, await send(bob, 'alice@x', 'two')), {})

    const sent: unknown[] = []
    alice.c.ctx.xmpp.sendStanza = async (s) => {
      sent.push(s)
    }
    await alice.p.repairSession(aHandle, 'bob@x')
    const stanza = sent[0] as { children: Array<{ name: string; children: Array<{ name: string }> }> }
    const encrypted = stanza.children[0]
    expect(encrypted.children.map((c) => c.name)).toEqual(['header']) // key transport: no <payload>

    const repaired = await bob.p.decrypt(bHandle, claim(bob.p, { protocolId: 'omemo:2', stanzaElement: encrypted as never }), {})
    expect(repaired.status).toBe('control-message')

    // The replacement session carries content in both directions.
    expect(textOf((await bob.p.decrypt(bHandle, claim(bob.p, await send(alice, 'bob@x', 'three')), {})).plaintext)).toContain('three')
    expect(textOf((await alice.p.decrypt(aHandle, claim(alice.p, await send(bob, 'alice@x', 'four')), {})).plaintext)).toContain('four')
  })
})

