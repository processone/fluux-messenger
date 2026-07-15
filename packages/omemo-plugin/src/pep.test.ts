import { describe, it, expect } from 'vitest'
import { xml } from '@xmpp/client'
import { createMockPluginContext } from './testing/MockPluginContext'
import {
  publishDeviceList,
  fetchDeviceList,
  subscribeDeviceList,
  publishBundle,
  fetchBundle,
  deviceListToXml,
  deviceListFromXml,
  bundleToXml,
  bundleFromXml,
} from './pep'
import type { Bundle } from '@fluux/omemo'

const sampleBundle = (): Bundle => ({
  ik: new Uint8Array(32).fill(1),
  spkId: 1,
  spk: new Uint8Array(32).fill(2),
  spkSig: new Uint8Array(64).fill(3),
  preKeys: Array.from({ length: 25 }, (_v, i) => ({
    id: i + 1,
    key: new Uint8Array(32).map((_b, j) => (i * 32 + j + 200) % 256),
  })),
})

describe('OMEMO 2 PEP', () => {
  it('device list publish/fetch round-trips', async () => {
    const a = createMockPluginContext('a@x')
    const b = createMockPluginContext('b@x', a.net)
    await publishDeviceList(a.ctx.xmpp, [5, 6])
    expect((await fetchDeviceList(b.ctx.xmpp, 'a@x')).sort()).toEqual([5, 6])
  })

  it('bundle publish/fetch round-trips byte-exact', async () => {
    const a = createMockPluginContext('a@x')
    const b = createMockPluginContext('b@x', a.net)
    const bundle = sampleBundle()
    await publishBundle(a.ctx.xmpp, 5, bundle)
    const got = await fetchBundle(b.ctx.xmpp, 'a@x', 5)
    expect(got).toEqual(bundle)
  })

  it('fetchDeviceList of a jid with no published list returns []', async () => {
    const a = createMockPluginContext('a@x')
    const b = createMockPluginContext('b@x', a.net)
    expect(await fetchDeviceList(b.ctx.xmpp, 'a@x')).toEqual([])
  })

  it('fetchBundle of a missing bundle returns null', async () => {
    const a = createMockPluginContext('a@x')
    const b = createMockPluginContext('b@x', a.net)
    expect(await fetchBundle(b.ctx.xmpp, 'a@x', 5)).toBeNull()
  })

  it('subscribeDeviceList fires the callback when the peer republishes its device list', async () => {
    const a = createMockPluginContext('a@x')
    const b = createMockPluginContext('b@x', a.net)
    const seen: number[][] = []
    const sub = subscribeDeviceList(b.ctx.xmpp, 'a@x', (ids) => seen.push(ids))

    await publishDeviceList(a.ctx.xmpp, [1, 2, 3])
    expect(seen).toEqual([[1, 2, 3]])

    await publishDeviceList(a.ctx.xmpp, [1, 2, 3, 4])
    expect(seen).toEqual([
      [1, 2, 3],
      [1, 2, 3, 4],
    ])

    sub.unsubscribe()
    await publishDeviceList(a.ctx.xmpp, [9])
    expect(seen).toHaveLength(2)
  })

  it('deviceListFromXml filters a non-numeric device id', () => {
    const el = xml(
      'devices',
      { xmlns: 'urn:xmpp:omemo:2' },
      xml('device', { id: '7' }),
      xml('device', { id: 'not-a-number' }),
      xml('device', {}),
    )
    expect(deviceListFromXml(el)).toEqual([7])
  })

  it('bundleFromXml filters a non-numeric prekey id', () => {
    const b = sampleBundle()
    const el = bundleToXml(b)
    // Tamper with one prekey id to be non-numeric, matching how a malformed
    // peer bundle could look on the wire.
    el.getChild('prekeys')!.getChildren('pk')[0].attrs.id = 'bogus'
    const parsed = bundleFromXml(el)
    expect(parsed.preKeys.some((p) => Number.isNaN(p.id))).toBe(false)
    expect(parsed.preKeys).toHaveLength(b.preKeys.length - 1)
  })

  it('round-trips deviceListToXml/deviceListFromXml directly', () => {
    expect(deviceListFromXml(deviceListToXml([3, 1, 2]))).toEqual([3, 1, 2])
  })

  it('publishes device-list and bundle nodes with the interop-critical open access model', async () => {
    // Peers can only READ an `open` PEP node; a `maxItems:1`/id `current` singleton is
    // how XEP-0384 keeps exactly one live device-list/bundle item. Assert the plugin
    // publishes with those options so a regression to whitelist/default can't slip by.
    const a = createMockPluginContext('a@x')
    await publishDeviceList(a.ctx.xmpp, [5, 6])
    await publishBundle(a.ctx.xmpp, 5, sampleBundle())

    for (const pub of a.publishes) {
      expect(pub.itemId).toBe('current')
      expect(pub.options).toEqual({ accessModel: 'open', maxItems: 1 })
    }
    expect(a.publishes).toHaveLength(2)
  })
})
