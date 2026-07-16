import { describe, it, expect } from 'vitest'
import { OmemoPlugin } from './OmemoPlugin'
import { createMockPluginContext } from './testing/MockPluginContext'
import { PluginStorageOmemoStore } from './store'
import { fetchBundle, publishBundle, publishDeviceList } from './pep'
import { fingerprint, OmemoAccount } from '@fluux/omemo'
import { setVerified } from './verifiedDevices'
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
    expect(list[0]).toEqual({
      id: String(bobDeviceId),
      fingerprint: hex(fingerprint(bundle!.ik)),
      trust: 'unknown', // no trust record yet, not verified
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
    expect(list).toEqual([{ id: '777', fingerprint: '', trust: 'unknown' }])
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
    expect(list[0]).toEqual({ id: String(bobDeviceId), fingerprint: realFp, trust: 'tofu' })

    // Re-bind the marker to the REAL fingerprint — now it wins over library trust.
    await setVerified(alice.ctx.storage, 'bob@x', bobDeviceId, realFp)
    list = await pa.listPeerIdentities('bob@x')
    expect(list[0]).toEqual({ id: String(bobDeviceId), fingerprint: realFp, trust: 'verified' })
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
    expect(list.find((e) => e.id === String(device1))).toEqual({
      id: String(device1),
      fingerprint: fp1,
      trust: 'verified',
    })
    expect(list.find((e) => e.id === String(device2))).toEqual({
      id: String(device2),
      fingerprint: fp2,
      trust: 'tofu',
    })
  })
})
