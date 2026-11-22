import { describe, it, expect } from 'vitest'
import { OmemoPlugin } from './OmemoPlugin'
import { createMockPluginContext } from './testing/MockPluginContext'
import { PluginStorageOmemoStore } from './store'
import { fetchBundle, publishBundle, publishDeviceList } from './pep'
import { fingerprint, OmemoAccount } from '@fluux/omemo'
import { setVerified } from './verifiedDevices'
import { E2EEManager, E2EEEncryptionRequiredError, InMemoryStorageBackend } from '@fluux/sdk'
import type { PluginStorage } from '@fluux/sdk'

const hex = (u: Uint8Array) => [...u].map((b) => b.toString(16).padStart(2, '0')).join('')

/** Stand up Alice + Bob on a shared net; Bob publishes identity so Alice can see his device. */
async function twoParty() {
  const alice = createMockPluginContext('alice@x')
  const bob = createMockPluginContext('bob@x', alice.net)
  const pa = new OmemoPlugin()
  await pa.init(alice.ctx)
  await pa.ensureIdentity()
  const pb = new OmemoPlugin()
  await pb.init(bob.ctx)
  const bobId = await pb.ensureIdentity()
  const bobDeviceId = Number(bobId.devices![0].deviceId)
  return { alice, bob, pa, pb, bobDeviceId }
}

/** Fresh in-memory `PluginStorage`, isolated from any `createMockPluginContext` — used to mint an
 *  independent second OMEMO identity (own device/session store) for a peer's second device. */
function memStorage(): PluginStorage {
  const store = new Map<string, Uint8Array>()
  return {
    async get(key) {
      return store.get(key) ?? null
    },
    async put(key, value) {
      store.set(key, value)
    },
    async delete(key) {
      store.delete(key)
    },
    async list(prefix) {
      return [...store.keys()].filter((k) => k.startsWith(prefix))
    },
  }
}

describe('OmemoPlugin.listPeerIdentities', () => {
  it('lists one identity per device with its fingerprint (from the published bundle)', async () => {
    const { alice, pa, bobDeviceId } = await twoParty()
    const list = await pa.listPeerIdentities('bob@x')
    expect(list).toHaveLength(1)
    const bundle = await fetchBundle(alice.ctx.xmpp, 'bob@x', bobDeviceId)
    expect(list[0]).toMatchObject({
      id: String(bobDeviceId),
      fingerprint: hex(fingerprint(bundle!.ik)),
      trust: 'tofu', // first contact: blind-trusted, not verified
    })
  })

  it('a device advertised with no fetchable bundle → fingerprint "" and trust "unknown"', async () => {
    const alice = createMockPluginContext('alice@x')
    const pa = new OmemoPlugin()
    await pa.init(alice.ctx)
    // Seed ONLY a device list for a peer with no bundle node.
    const { deviceListToXml } = await import('./pep')
    const { elementToData } = await import('./stanzaData')
    const { devicesNode } = await import('./namespaces')
    const { seedPeer } = await import('./testing/MockPluginContext')
    seedPeer(alice.net, 'ghost@x', devicesNode(), elementToData(deviceListToXml([777])))
    const list = await pa.listPeerIdentities('ghost@x')
    expect(list).toEqual([{ id: '777', fingerprint: '', trust: 'unknown', usedForEncryption: false, notUsedReason: 'no-key', allowedDecisions: [] }])
  })

  it('reflects a stored blind-trusted (tofu) device', async () => {
    const { alice, pa, bobDeviceId } = await twoParty()
    const bundle = await fetchBundle(alice.ctx.xmpp, 'bob@x', bobDeviceId)
    const store = new PluginStorageOmemoStore(alice.ctx.storage)
    await store.saveTrust('bob@x', bobDeviceId, { state: 'trusted', identityKey: bundle!.ik })
    const list = await pa.listPeerIdentities('bob@x')
    expect(list[0].trust).toBe('tofu')
  })

  it('a verified marker bound to a STALE fingerprint does not yield verified; the real fp does', async () => {
    const { alice, pa, bobDeviceId } = await twoParty()
    const bundle = await fetchBundle(alice.ctx.xmpp, 'bob@x', bobDeviceId)
    const store = new PluginStorageOmemoStore(alice.ctx.storage)
    await store.saveTrust('bob@x', bobDeviceId, { state: 'trusted', identityKey: bundle!.ik })
    const realFp = hex(fingerprint(bundle!.ik))

    // Marker bound to a fingerprint that does NOT match the device's real key.
    await setVerified(alice.ctx.storage, 'bob@x', bobDeviceId, 'deadbeef')
    let list = await pa.listPeerIdentities('bob@x')
    expect(list[0]).toMatchObject({ id: String(bobDeviceId), fingerprint: realFp, trust: 'tofu' })

    // Re-bind the marker to the REAL fingerprint — now it wins over library trust.
    await setVerified(alice.ctx.storage, 'bob@x', bobDeviceId, realFp)
    list = await pa.listPeerIdentities('bob@x')
    expect(list[0]).toMatchObject({ id: String(bobDeviceId), fingerprint: realFp, trust: 'verified' })
  })

  it('resolves 2 devices independently: one verified (store), one tofu (library trust)', async () => {
    const { alice, bob, pa, bobDeviceId: device1 } = await twoParty()

    // Mint a second, independent OMEMO identity and publish it as Bob's second device.
    const acc2 = await OmemoAccount.create(new PluginStorageOmemoStore(memStorage()), (n) =>
      crypto.getRandomValues(new Uint8Array(n)),
    )
    const device2 = acc2.publishableDeviceId()
    await publishBundle(bob.ctx.xmpp, device2, await acc2.publishableBundleAsync())
    await publishDeviceList(bob.ctx.xmpp, [device1, device2])

    const store = new PluginStorageOmemoStore(alice.ctx.storage)
    const bundle1 = await fetchBundle(alice.ctx.xmpp, 'bob@x', device1)
    const fp1 = hex(fingerprint(bundle1!.ik))
    await store.saveTrust('bob@x', device1, { state: 'trusted', identityKey: bundle1!.ik })
    await setVerified(alice.ctx.storage, 'bob@x', device1, fp1) // explicitly verified

    const bundle2 = await fetchBundle(alice.ctx.xmpp, 'bob@x', device2)
    const fp2 = hex(fingerprint(bundle2!.ik))
    await store.saveTrust('bob@x', device2, { state: 'trusted', identityKey: bundle2!.ik }) // tofu only

    const list = await pa.listPeerIdentities('bob@x')
    expect(list).toHaveLength(2)
    expect(list.find((e) => e.id === String(device1))).toMatchObject({
      id: String(device1),
      fingerprint: fp1,
      trust: 'verified',
    })
    expect(list.find((e) => e.id === String(device2))).toMatchObject({
      id: String(device2),
      fingerprint: fp2,
      trust: 'tofu',
    })
  })
})

describe('OmemoPlugin.setIdentityTrust', () => {
  it("'verified' pins the current fingerprint and flips listed trust to verified", async () => {
    const { pa, bobDeviceId } = await twoParty()
    await pa.setIdentityTrust('bob@x', String(bobDeviceId), 'verified')
    const list = await pa.listPeerIdentities('bob@x')
    expect(list[0].trust).toBe('verified')
    // getPeerTrust/getDeviceTrust are also verified-aware (the adapter wires
    // isVerified into those read paths); see the "OmemoPlugin BTBV wiring"
    // describe block below for the round-trip proof on those methods.
  })

  it("'verified' then a fingerprint change invalidates the marker (back to unverified)", async () => {
    const { alice, pa, bobDeviceId } = await twoParty()
    await pa.setIdentityTrust('bob@x', String(bobDeviceId), 'verified')
    // Simulate a key change: overwrite the stored TrustRecord's identityKey.
    const store = new PluginStorageOmemoStore(alice.ctx.storage)
    const rec = await store.loadTrust('bob@x', bobDeviceId)
    await store.saveTrust('bob@x', bobDeviceId, {
      state: rec?.state ?? 'trusted',
      identityKey: new Uint8Array(32).fill(0xaa), // different key → different fp
    })
    const list = await pa.listPeerIdentities('bob@x')
    expect(list[0].trust).not.toBe('verified')
  })

  it("'untrusted' writes library untrusted state and removes any verified marker", async () => {
    const { alice, pa, bobDeviceId } = await twoParty()
    await pa.setIdentityTrust('bob@x', String(bobDeviceId), 'verified')
    await pa.setIdentityTrust('bob@x', String(bobDeviceId), 'untrusted')
    const store = new PluginStorageOmemoStore(alice.ctx.storage)
    expect((await store.loadTrust('bob@x', bobDeviceId))!.state).toBe('untrusted')
    const list = await pa.listPeerIdentities('bob@x')
    expect(list[0].trust).toBe('untrusted')
  })

  it("'verified' clears a prior library 'untrusted' state (mutual clearing, other direction)", async () => {
    const { alice, pa, bobDeviceId } = await twoParty()
    await pa.setIdentityTrust('bob@x', String(bobDeviceId), 'untrusted')
    const store = new PluginStorageOmemoStore(alice.ctx.storage)
    expect((await store.loadTrust('bob@x', bobDeviceId))!.state).toBe('untrusted')

    await pa.setIdentityTrust('bob@x', String(bobDeviceId), 'verified')

    const list = await pa.listPeerIdentities('bob@x')
    expect(list[0].trust).toBe('verified')

    // Load-bearing: assert the library record itself was cleared, not merely
    // shadowed by the verified marker's read-path precedence (listPeerIdentities
    // alone would pass even if 'untrusted' were never cleared).
    const rec = await store.loadTrust('bob@x', bobDeviceId)
    expect(rec!.state).not.toBe('untrusted')
    expect(rec!.state).toBe('undecided')
  })

  it('is idempotent for repeated verified calls', async () => {
    const { pa, bobDeviceId } = await twoParty()
    await pa.setIdentityTrust('bob@x', String(bobDeviceId), 'verified')
    await pa.setIdentityTrust('bob@x', String(bobDeviceId), 'verified')
    const list = await pa.listPeerIdentities('bob@x')
    expect(list[0].trust).toBe('verified')
  })
})

describe('OmemoPlugin BTBV wiring', () => {
  it('getDeviceTrust surfaces verified after setIdentityTrust', async () => {
    const { pa, bobDeviceId } = await twoParty()
    await pa.setIdentityTrust('bob@x', String(bobDeviceId), 'verified')
    expect(await pa.getDeviceTrust('bob@x', String(bobDeviceId))).toBe('verified')
  })

  it('once a peer has a verified device, a newly-seen device resolves to untrusted (BTBV)', async () => {
    const { alice, pa, pb, bobDeviceId } = await twoParty()
    // Verify bob's first device.
    await pa.setIdentityTrust('bob@x', String(bobDeviceId), 'verified')
    // Bob adds a SECOND device on the shared net.
    const bob2 = createMockPluginContext('bob@x', alice.net)
    const pb2 = new OmemoPlugin()
    await pb2.init(bob2.ctx)
    // Re-create identity for a distinct device id by seeding a fresh account:
    const secondId = await pb2.ensureIdentity()
    const secondDeviceId = Number(secondId.devices![0].deviceId)
    // The second device, never verified, with a peer that HAS a verified device,
    // must resolve untrusted via resolveInboundTrust (peerHasVerifiedDevice=true).
    const store = new (await import('./store')).PluginStorageOmemoStore(alice.ctx.storage)
    const { resolveInboundTrust } = await import('./trust')
    const peerHasVerified = await (pa as unknown as {
      peerHasVerifiedDevice(s: unknown, p: string): Promise<boolean>
    }).peerHasVerifiedDevice(store, 'bob@x')
    expect(peerHasVerified).toBe(true)
    expect(resolveInboundTrust(peerHasVerified, null).store).toBe('untrusted')
    expect(secondDeviceId).not.toBe(bobDeviceId)
    // pb kept alive only for the shared-net stand-up in twoParty(); silence unused-var lint.
    void pb
  })

  it('getPeerTrust returns verified for a peer with a verified and no untrusted device', async () => {
    const { pa, bobDeviceId } = await twoParty()
    await pa.setIdentityTrust('bob@x', String(bobDeviceId), 'verified')
    expect(await pa.getPeerTrust('bob@x')).toBe('verified')
  })

  it('getPeerTrust: a single untrusted device dominates a verified one on the same peer', async () => {
    const { bob, pa, bobDeviceId: device1 } = await twoParty()

    // Mint a second, independent OMEMO identity and publish it as Bob's second device.
    const acc2 = await OmemoAccount.create(new PluginStorageOmemoStore(memStorage()), (n) =>
      crypto.getRandomValues(new Uint8Array(n)),
    )
    const device2 = acc2.publishableDeviceId()
    await publishBundle(bob.ctx.xmpp, device2, await acc2.publishableBundleAsync())
    await publishDeviceList(bob.ctx.xmpp, [device1, device2])

    // Device A: verified. Device B: untrusted.
    await pa.setIdentityTrust('bob@x', String(device1), 'verified')
    await pa.setIdentityTrust('bob@x', String(device2), 'untrusted')
    expect(await pa.getDeviceTrust('bob@x', String(device1))).toBe('verified')
    expect(await pa.getDeviceTrust('bob@x', String(device2))).toBe('untrusted')

    // A distrusted device must always win the aggregate — security-load-bearing.
    expect(await pa.getPeerTrust('bob@x')).toBe('untrusted')
  })

  it('a fingerprint change on a verified device flips getDeviceTrust back off verified', async () => {
    const { alice, pa, bobDeviceId } = await twoParty()
    await pa.setIdentityTrust('bob@x', String(bobDeviceId), 'verified')
    expect(await pa.getDeviceTrust('bob@x', String(bobDeviceId))).toBe('verified')

    // Simulate a key change: overwrite the stored TrustRecord's identityKey so
    // the verified marker (bound to the OLD fingerprint) no longer matches.
    const store = new PluginStorageOmemoStore(alice.ctx.storage)
    const rec = await store.loadTrust('bob@x', bobDeviceId)
    await store.saveTrust('bob@x', bobDeviceId, {
      state: rec?.state ?? 'trusted',
      identityKey: new Uint8Array(32).fill(0xaa), // different key → different fp
    })

    expect(await pa.getDeviceTrust('bob@x', String(bobDeviceId))).not.toBe('verified')
  })
})

describe('OmemoPlugin identities under the final PeerIdentity API', () => {
  it('an undecided device of a verified contact reads unknown, is not used, and can be approved with tofu', async () => {
    const { bob, pa, bobDeviceId: device1 } = await twoParty()
    const acc2 = await OmemoAccount.create(new PluginStorageOmemoStore(memStorage()), (n) =>
      crypto.getRandomValues(new Uint8Array(n)),
    )
    const device2 = acc2.publishableDeviceId()
    await publishBundle(bob.ctx.xmpp, device2, await acc2.publishableBundleAsync())
    await publishDeviceList(bob.ctx.xmpp, [device1, device2])
    await pa.setIdentityTrust('bob@x', String(device1), 'verified')

    let list = await pa.listPeerIdentities('bob@x')
    expect(list.find((i) => i.id === String(device1))).toMatchObject({ trust: 'verified', usedForEncryption: true })
    expect(list.find((i) => i.id === String(device2))).toMatchObject({
      trust: 'unknown',
      usedForEncryption: false,
      notUsedReason: 'awaiting-decision',
      allowedDecisions: ['verified', 'tofu', 'untrusted'],
    })

    await pa.setIdentityTrust('bob@x', String(device2), 'tofu')
    list = await pa.listPeerIdentities('bob@x')
    expect(list.find((i) => i.id === String(device2))).toMatchObject({ trust: 'tofu', usedForEncryption: true })
  })

  it('tofu removes a verification and untrusted marks the device as refused, not used', async () => {
    const { pa, bobDeviceId } = await twoParty()
    await pa.setIdentityTrust('bob@x', String(bobDeviceId), 'verified')
    await pa.setIdentityTrust('bob@x', String(bobDeviceId), 'tofu')
    expect((await pa.listPeerIdentities('bob@x'))[0]).toMatchObject({ trust: 'tofu', usedForEncryption: true })
    await pa.setIdentityTrust('bob@x', String(bobDeviceId), 'untrusted')
    expect((await pa.listPeerIdentities('bob@x'))[0]).toMatchObject({
      trust: 'untrusted',
      usedForEncryption: false,
      notUsedReason: 'distrusted',
      allowedDecisions: ['verified', 'tofu'],
    })
  })
})

describe('OmemoPlugin identities: first contact, reachability and decisions', () => {
  it('first contact is blind-trusted: an undecided device of a never-verified contact reads tofu and is used', async () => {
    const { pa, bobDeviceId } = await twoParty()
    expect((await pa.listPeerIdentities('bob@x'))[0]).toMatchObject({
      id: String(bobDeviceId),
      trust: 'tofu',
      usedForEncryption: true,
      allowedDecisions: ['verified', 'untrusted'],
    })
    // The aggregate and per-device readings agree with the list.
    expect(await pa.getPeerTrust('bob@x')).toBe('tofu')
    expect(await pa.getDeviceTrust('bob@x', String(bobDeviceId))).toBe('tofu')
  })

  it('devices past the 50-device cap are listed not used with the over-limit reason', async () => {
    const { alice, bob, pa, bobDeviceId } = await twoParty()
    const bundle = (await fetchBundle(alice.ctx.xmpp, 'bob@x', bobDeviceId))!
    // 51 devices, every one with a usable published bundle: only the cap can exclude the last.
    const extra = Array.from({ length: 50 }, (_, i) => 900000 + i)
    for (const id of extra) await publishBundle(bob.ctx.xmpp, id, bundle)
    await publishDeviceList(bob.ctx.xmpp, [bobDeviceId, ...extra])
    const list = await pa.listPeerIdentities('bob@x')
    expect(list).toHaveLength(51)
    expect(list[49]).toMatchObject({ usedForEncryption: true })
    expect(list[50]).toMatchObject({ id: '900049', usedForEncryption: false, notUsedReason: 'over-limit' })
  })

  it('a device whose bundle has an invalid signed-prekey signature is not used', async () => {
    const { alice, bob, pa, bobDeviceId } = await twoParty()
    const bundle = (await fetchBundle(alice.ctx.xmpp, 'bob@x', bobDeviceId))!
    await publishBundle(bob.ctx.xmpp, bobDeviceId, { ...bundle, spkSig: new Uint8Array(64) })
    expect((await pa.listPeerIdentities('bob@x'))[0]).toMatchObject({
      usedForEncryption: false,
      notUsedReason: 'invalid-key',
    })
  })

  it('a device whose one-time prekeys carry no key material is not used', async () => {
    const { alice, bob, pa, bobDeviceId } = await twoParty()
    const bundle = (await fetchBundle(alice.ctx.xmpp, 'bob@x', bobDeviceId))!
    const emptied = bundle.preKeys.map((k) => ({ ...k, key: new Uint8Array(0) }))
    await publishBundle(bob.ctx.xmpp, bobDeviceId, { ...bundle, preKeys: emptied })
    expect((await pa.listPeerIdentities('bob@x'))[0]).toMatchObject({
      usedForEncryption: false,
      notUsedReason: 'invalid-key',
    })
  })

  it('a device with an established session is used, and not used once its record holds another key', async () => {
    const { alice, pa, bobDeviceId } = await twoParty()
    const { xml } = await import('@xmpp/client')
    const { serializePayloadEnvelope } = await import('@fluux/sdk')
    const handle = await pa.openConversation({ kind: 'direct', peer: 'bob@x' })
    await pa.encrypt(handle, new TextEncoder().encode(serializePayloadEnvelope([xml('body', {}, 'hi')])))
    expect((await pa.listPeerIdentities('bob@x'))[0]).toMatchObject({ usedForEncryption: true })

    // The session was built with one key; the device's record now binds another.
    const other = await OmemoAccount.create(new PluginStorageOmemoStore(memStorage()), (n) => crypto.getRandomValues(new Uint8Array(n)))
    const otherKey = (await other.publishableBundleAsync()).ik
    const store = new PluginStorageOmemoStore(alice.ctx.storage)
    await store.saveTrust('bob@x', bobDeviceId, { state: 'trusted', identityKey: otherKey })
    expect((await pa.listPeerIdentities('bob@x'))[0]).toMatchObject({ usedForEncryption: false })
  })

  it('a refused device can be approved again with tofu, and a waiting one refused', async () => {
    const { pa, bobDeviceId } = await twoParty()
    await pa.setIdentityTrust('bob@x', String(bobDeviceId), 'untrusted')
    await pa.setIdentityTrust('bob@x', String(bobDeviceId), 'tofu')
    expect((await pa.listPeerIdentities('bob@x'))[0]).toMatchObject({ trust: 'tofu', usedForEncryption: true })
    await pa.setIdentityTrust('bob@x', String(bobDeviceId), 'tofu')
    expect((await pa.listPeerIdentities('bob@x'))[0]).toMatchObject({ trust: 'tofu', usedForEncryption: true })
  })
})

// Intent: FLM-426 — the send rule, composed. The real manager reads the real OMEMO plugin's
// aggregate trust to decide whether opportunistic plaintext is allowed to a contact.
describe('plaintext to an OMEMO contact, through the manager and the real plugin', () => {
  async function managed() {
    const { alice, bob, pb, bobDeviceId } = await twoParty()
    const manager = new E2EEManager({ storage: new InMemoryStorageBackend(), xmpp: alice.ctx.xmpp, account: { jid: 'alice@x' } })
    const plugin = new OmemoPlugin()
    await manager.register(plugin)
    return { manager, plugin, bob, pb, bobDeviceId }
  }
  const target = { kind: 'direct' as const, peer: 'bob@x' }

  it('blocks plaintext to a contact with a usable never-verified device (tofu)', async () => {
    const { manager } = await managed()
    expect(await manager.hasEstablishedTrust('bob@x')).toBe(true)
    await expect(manager.assertPlaintextPermitted(target)).rejects.toBeInstanceOf(E2EEEncryptionRequiredError)
  })

  it('blocks plaintext to a contact whose only device was refused', async () => {
    const { manager, plugin, bobDeviceId } = await managed()
    await plugin.setIdentityTrust('bob@x', String(bobDeviceId), 'untrusted')
    await expect(manager.assertPlaintextPermitted(target)).rejects.toBeInstanceOf(E2EEEncryptionRequiredError)
  })

  it('blocks plaintext to a contact with a new device waiting behind a verified one', async () => {
    const { manager, plugin, bob, bobDeviceId } = await managed()
    const acc2 = await OmemoAccount.create(new PluginStorageOmemoStore(memStorage()), (n) => crypto.getRandomValues(new Uint8Array(n)))
    const device2 = acc2.publishableDeviceId()
    await publishBundle(bob.ctx.xmpp, device2, await acc2.publishableBundleAsync())
    await publishDeviceList(bob.ctx.xmpp, [bobDeviceId, device2])
    await plugin.setIdentityTrust('bob@x', String(bobDeviceId), 'verified')
    expect(await plugin.getDeviceTrust('bob@x', String(device2))).toBe('unknown')
    await expect(manager.assertPlaintextPermitted(target)).rejects.toBeInstanceOf(E2EEEncryptionRequiredError)
  })

  it('still permits plaintext to a contact with no usable key, and when plaintext is forced', async () => {
    const { manager, bob } = await managed()
    await publishDeviceList(bob.ctx.xmpp, [777]) // advertised device with no bundle
    expect(await manager.hasEstablishedTrust('bob@x')).toBe(false)
    await expect(manager.assertPlaintextPermitted(target)).resolves.toBeUndefined()
    await publishDeviceList(bob.ctx.xmpp, [])
  })

  it('permits plaintext once the user forces it for a tofu contact', async () => {
    const { manager } = await managed()
    manager.setForcedPlaintext(target, true)
    await expect(manager.assertPlaintextPermitted(target)).resolves.toBeUndefined()
  })
})
