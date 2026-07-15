import { describe, it, expect } from 'vitest'
import { OmemoPlugin } from './OmemoPlugin'
import { createMockPluginContext } from './testing/MockPluginContext'
import { fetchDeviceList, fetchBundle } from './pep'

describe('OmemoPlugin identity/probe', () => {
  it('ensureIdentity publishes our device-list + bundle and returns a fingerprint', async () => {
    const a = createMockPluginContext('a@x')
    const p = new OmemoPlugin()
    await p.init(a.ctx)
    const id = await p.ensureIdentity()
    expect(id.fingerprint).toMatch(/[0-9a-f]/i)
    const devs = await fetchDeviceList(a.ctx.xmpp, 'a@x')
    expect(devs).toHaveLength(1)
    expect(await fetchBundle(a.ctx.xmpp, 'a@x', devs[0])).not.toBeNull()
  })

  it('ensureIdentity is idempotent: calling twice does not double-add our device', async () => {
    const a = createMockPluginContext('a@x')
    const p = new OmemoPlugin()
    await p.init(a.ctx)
    const first = await p.ensureIdentity()
    const second = await p.ensureIdentity()
    expect(second.fingerprint).toBe(first.fingerprint)
    const devs = await fetchDeviceList(a.ctx.xmpp, 'a@x')
    expect(devs).toHaveLength(1)
    expect(String(devs[0])).toBe(first.devices?.[0]?.deviceId)
  })

  it('probePeer reports supported when the peer advertises a device', async () => {
    const a = createMockPluginContext('a@x')
    const b = createMockPluginContext('b@x', a.net)
    const pa = new OmemoPlugin()
    await pa.init(a.ctx)
    await pa.ensureIdentity()
    const pb = new OmemoPlugin()
    await pb.init(b.ctx)
    expect((await pb.probePeer('a@x')).supported).toBe(true)
    expect((await pb.probePeer('nobody@x')).supported).toBe(false)
  })

  it('getDeviceTrust of an unrecorded device returns unknown', async () => {
    const a = createMockPluginContext('a@x')
    const p = new OmemoPlugin()
    await p.init(a.ctx)
    expect(await p.getDeviceTrust('stranger@x', '12345')).toBe('unknown')
  })

  it('getPeerTrust of a peer with no trust records returns unknown', async () => {
    const a = createMockPluginContext('a@x')
    const b = createMockPluginContext('b@x', a.net)
    const pb2 = new OmemoPlugin()
    await pb2.init(b.ctx)
    const pa = new OmemoPlugin()
    await pa.init(a.ctx)
    await pa.ensureIdentity()
    // b has never processed a bundle from a, so no trust record exists yet.
    expect(await pb2.getPeerTrust('a@x')).toBe('unknown')
  })

  it('two plugin instances over a shared network can discover each other after ensureIdentity', async () => {
    const alice = createMockPluginContext('alice@x')
    const bob = createMockPluginContext('bob@x', alice.net)

    const alicePlugin = new OmemoPlugin()
    await alicePlugin.init(alice.ctx)
    await alicePlugin.ensureIdentity()

    const bobPlugin = new OmemoPlugin()
    await bobPlugin.init(bob.ctx)
    await bobPlugin.ensureIdentity()

    const probe = await alicePlugin.probePeer('bob@x')
    expect(probe.supported).toBe(true)

    const bobDevices = await fetchDeviceList(alice.ctx.xmpp, 'bob@x')
    expect(bobDevices).toHaveLength(1)
    const bundle = await fetchBundle(alice.ctx.xmpp, 'bob@x', bobDevices[0])
    expect(bundle).not.toBeNull()
  })
})
