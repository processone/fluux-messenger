import { describe, it, expect } from 'vitest'
import { createMockPluginContext, seedPeer } from './testing/MockPluginContext'
import { readOwnDeviceLists, removeOwnDevices, type OwnPepAccess } from './devices'
import { parseXml, elementToData } from './stanzaData'
import { NS_DEVICES, NS_LEGACY_DEVICELIST } from './namespaces'

const ME = 'me@example.org'

// Lists as other clients publish them: labels, a labelsig, an unknown attribute and an unknown child.
const OMEMO2 = `<devices xmlns='urn:xmpp:omemo:2'>
  <device id='111' label='Laptop' labelsig='c2ln'/>
  <device id='222' label='Phone' x-extra='keep'><note>kept</note></device>
  <device id='333'/>
</devices>`
const LEGACY = `<list xmlns='eu.siacs.conversations.axolotl'>
  <device id='444' label='Conversations'/>
  <device id='555'/>
</list>`

function setup() {
  const { ctx, net, publishes } = createMockPluginContext(ME)
  const pep: OwnPepAccess = { query: (jid, node, max) => ctx.xmpp.queryPEP(jid, node, max), publish: (n, i, o) => ctx.xmpp.publishPEP(n, i, o) }
  seedPeer(net, ME, NS_DEVICES, elementToData(parseXml(OMEMO2)))
  seedPeer(net, ME, NS_LEGACY_DEVICELIST, elementToData(parseXml(LEGACY)))
  return { pep, net, publishes }
}
const stored = (net: ReturnType<typeof setup>['net'], node: string) => net.nodes.get(`${ME} ${node}`)![0].payload

describe('own OMEMO device lists', () => {
  it('reads OMEMO 2 and legacy lists with the labels other clients gave', async () => {
    const { pep } = setup()
    const lists = await readOwnDeviceLists(pep, ME)
    expect(lists.omemo2).toEqual({ ok: true, devices: [{ id: 111, label: 'Laptop' }, { id: 222, label: 'Phone' }, { id: 333 }] })
    expect(lists.legacy).toEqual({ ok: true, devices: [{ id: 444, label: 'Conversations' }, { id: 555 }] })
  })

  it('reads an account with no lists as empty', async () => {
    const { ctx } = createMockPluginContext(ME)
    const lists = await readOwnDeviceLists({ query: (j, n, m) => ctx.xmpp.queryPEP(j, n, m), publish: async () => {} }, ME)
    expect(lists).toEqual({ omemo2: { ok: true, devices: [] }, legacy: { ok: true, devices: [] } })
  })

  it('treats item-not-found as an absent list and any other failure as an error for that list only', async () => {
    const { pep } = setup()
    const failing: OwnPepAccess = {
      publish: pep.publish,
      query: (_jid, node) =>
        node === NS_DEVICES ? Promise.reject(new Error('item-not-found')) : Promise.reject(new Error('service-unavailable')),
    }
    const lists = await readOwnDeviceLists(failing, ME)
    expect(lists.omemo2).toEqual({ ok: true, devices: [] })
    expect(lists.legacy.ok).toBe(false)
  })

  it('removes the chosen device and leaves every other entry exactly as published', async () => {
    const { pep, net, publishes } = setup()
    const result = await removeOwnDevices(pep, ME, 'omemo2', [111])
    expect(result).toEqual({ removed: [111], missing: [] })
    const el = stored(net, NS_DEVICES)
    expect(el.attrs).toEqual({ xmlns: 'urn:xmpp:omemo:2' })
    const kids = el.children.filter((c) => typeof c !== 'string')
    expect(kids.map((c) => (c as { attrs: Record<string, string> }).attrs)).toEqual([
      { id: '222', label: 'Phone', 'x-extra': 'keep' },
      { id: '333' },
    ])
    expect(JSON.stringify(kids[0])).toContain('kept')
    expect(publishes).toHaveLength(1)
    // the legacy list was not touched
    expect(stored(net, NS_LEGACY_DEVICELIST)).toEqual(elementToData(parseXml(LEGACY)))
  })

  it('removes from the legacy list and keeps the other labels', async () => {
    const { pep, net } = setup()
    await removeOwnDevices(pep, ME, 'legacy', [555])
    expect((await readOwnDeviceLists(pep, ME)).legacy).toEqual({ ok: true, devices: [{ id: 444, label: 'Conversations' }] })
    expect(stored(net, NS_LEGACY_DEVICELIST).attrs.xmlns).toBe('eu.siacs.conversations.axolotl')
  })

  it('publishes nothing when the id is not in the list', async () => {
    const { pep, publishes } = setup()
    expect(await removeOwnDevices(pep, ME, 'omemo2', [999])).toEqual({ removed: [], missing: [999] })
    expect(publishes).toHaveLength(0)
  })

  it('refuses a malformed payload without rewriting it', async () => {
    const { pep, net, publishes } = setup()
    seedPeer(net, ME, NS_DEVICES, elementToData(parseXml("<wrong xmlns='urn:xmpp:omemo:2'><device id='1'/></wrong>")))
    await expect(removeOwnDevices(pep, ME, 'omemo2', [1])).rejects.toThrow(/unexpected/)
    expect(publishes).toHaveLength(0)
  })

  it('keeps a device another client added after the screen loaded', async () => {
    const { pep, net } = setup()
    await readOwnDeviceLists(pep, ME)
    seedPeer(net, ME, NS_DEVICES, elementToData(parseXml("<devices xmlns='urn:xmpp:omemo:2'><device id='111'/><device id='777' label='New'/></devices>")))
    await removeOwnDevices(pep, ME, 'omemo2', [111])
    expect((await readOwnDeviceLists(pep, ME)).omemo2).toEqual({ ok: true, devices: [{ id: 777, label: 'New' }] })
  })
})
