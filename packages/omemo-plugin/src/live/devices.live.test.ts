// Live proof of the OMEMO device-list read and remove path against a disposable local XMPP server (ejabberd
// on loopback) through the real SDK `XMPPClient`. Skipped unless OMEMO_LIVE_WS is set:
//
//   OMEMO_LIVE_WS=ws://127.0.0.1:45281/ws OMEMO_LIVE_EVIDENCE=<dir> npx vitest run src/live
//
// Accounts alice, bob, carol and dave on `localhost` must exist, with password `pw-<name>-1`. Lists and bundles
// are the python-omemo reference's (src/fixtures). A second, raw @xmpp/client connection seeds and reads the
// server, so what the SDK reports is checked against what the server stores, not against the SDK itself.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { describe, it, expect, afterAll } from 'vitest'
import { parse } from 'ltx'
import { XMPPClient } from '@fluux/sdk/core'
import { OmemoPlugin } from '../OmemoPlugin'
import { pepAccessFor, readOwnDeviceLists, removeOwnDevices } from '../devices'
import { NS_DEVICES, NS_BUNDLES, NS_LEGACY_DEVICELIST, NS_LEGACY_BUNDLES_PREFIX } from '../namespaces'

const WS = process.env.OMEMO_LIVE_WS
const EVIDENCE = process.env.OMEMO_LIVE_EVIDENCE
interface Side { devices: string; bundles: Record<string, string>; fingerprints: Record<string, string> }
const fixture = JSON.parse(readFileSync(new URL('../fixtures/own_devices.json', import.meta.url), 'utf8')) as { omemo2: Side; legacy: Side }

interface Raw {
  request(iq: unknown): Promise<{ toString(): string; getChild(n: string, ns?: string): { getChild(n: string, ns?: string): { children: { toString(): string }[] } | undefined } | undefined }>
}
interface RawClient { iqCaller: Raw; start(): Promise<unknown>; stop(): Promise<unknown> }
const PUBSUB = 'http://jabber.org/protocol/pubsub'

async function rawClient(user: string, resource: string): Promise<RawClient> {
  const { client } = (await import('@xmpp/client')) as unknown as { client(o: object): RawClient }
  const c = client({ service: WS, domain: 'localhost', username: user, password: `pw-${user}-1`, resource })
  await c.start()
  return c
}

const FORM = (maxItems: string) =>
  `<publish-options><x xmlns='jabber:x:data' type='submit'><field var='FORM_TYPE' type='hidden'><value>http://jabber.org/protocol/pubsub#publish-options</value></field>` +
  `<field var='pubsub#access_model'><value>open</value></field><field var='pubsub#persist_items'><value>true</value></field>` +
  `<field var='pubsub#max_items'><value>${maxItems}</value></field></x></publish-options>`

/** Publishes `itemXml` (an `<item>`) the way a real client does, with its publish options. */
async function seed(c: RawClient, node: string, itemXml: string, maxItems = '1'): Promise<void> {
  await c.iqCaller.request(parse(`<iq type='set'><pubsub xmlns='${PUBSUB}'><publish node='${node}'>${itemXml}</publish>${FORM(maxItems)}</pubsub></iq>`))
}
const item = (id: string, payload: string): string => `<item id='${id}'>${payload}</item>`

/** What the server stores for a node: the raw items, as the server serialized them. */
const lastResponse: Record<string, string> = {}
async function stored(c: RawClient, node: string): Promise<string[]> {
  try {
    const res = await c.iqCaller.request(parse(`<iq type='get'><pubsub xmlns='${PUBSUB}'><items node='${node}'/></pubsub></iq>`))
    lastResponse[node] = res.toString()
    return (res.getChild('pubsub', PUBSUB)?.getChild('items')?.children ?? []).map((i) => i.toString())
  } catch {
    return []
  }
}

/** Deletes the account's OMEMO nodes so a rerun starts from the same state. */
async function wipe(c: RawClient): Promise<void> {
  const nodes = [NS_DEVICES, NS_BUNDLES, NS_LEGACY_DEVICELIST, ...legacyIds.map((id) => `${NS_LEGACY_BUNDLES_PREFIX}${id}`)]
  for (const node of nodes) {
    await c.iqCaller
      .request(parse(`<iq type='set'><pubsub xmlns='${PUBSUB}#owner'><delete node='${node}'/></pubsub></iq>`))
      .catch(() => undefined)
  }
}

async function seedAccount(c: RawClient, opts: { omit?: Set<string>; legacyGarbled?: string } = {}): Promise<void> {
  await wipe(c)
  await seed(c, NS_DEVICES, item('current', fixture.omemo2.devices))
  await seed(c, NS_LEGACY_DEVICELIST, item('current', fixture.legacy.devices))
  for (const [id, b] of Object.entries(fixture.omemo2.bundles)) if (!opts.omit?.has(id)) await seed(c, NS_BUNDLES, item(id, b), 'max')
  for (const [id, b] of Object.entries(fixture.legacy.bundles)) {
    const payload = id === opts.legacyGarbled ? "<bundle xmlns='eu.siacs.conversations.axolotl'><identityKey>!!</identityKey></bundle>" : b
    if (!opts.omit?.has(id)) await seed(c, `${NS_LEGACY_BUNDLES_PREFIX}${id}`, item('current', payload), 'max')
  }
}

async function sdkClient(user: string): Promise<XMPPClient> {
  const client = new XMPPClient()
  await client.connect({ jid: `${user}@localhost/sdk`, password: `pw-${user}-1`, server: WS!, skipDiscovery: true })
  return client
}

const log: Record<string, unknown> = {}
afterAll(() => {
  if (EVIDENCE) {
    mkdirSync(EVIDENCE, { recursive: true })
    writeFileSync(`${EVIDENCE}/omemo-live-observations.json`, JSON.stringify(log, null, 2))
  }
})

const sorted = (xs: number[]): number[] => [...xs].sort((a, b) => a - b)
const omemo2Ids = Object.keys(fixture.omemo2.bundles).map(Number)
const legacyIds = Object.keys(fixture.legacy.bundles).map(Number)

describe.runIf(WS)('OMEMO own device lists on a real server', () => {
  it('read-both-lists: reads names and canonical fingerprints; an empty account reads empty', async () => {
    const wiper = await rawClient('dave', 'wipe')
    await wipe(wiper)
    await wiper.stop()
    const dave = await sdkClient('dave')
    const empty = await readOwnDeviceLists(pepAccessFor(dave), 'dave@localhost')
    expect(empty).toEqual({ omemo2: { ok: true, devices: [] }, legacy: { ok: true, devices: [] } })
    const noPlugin = !dave.e2ee?.hasPlugins()
    await dave.disconnect()

    const seeder = await rawClient('alice', 'seed')
    await seedAccount(seeder)
    log.aliceStoredBefore = { omemo2: await stored(seeder, NS_DEVICES), legacy: await stored(seeder, NS_LEGACY_DEVICELIST) }
    const alice = await sdkClient('alice')
    const lists = await readOwnDeviceLists(pepAccessFor(alice), 'alice@localhost')
    log.aliceRead = lists
    if (!lists.omemo2.ok || !lists.legacy.ok) throw new Error('lists should read')
    expect(sorted(lists.omemo2.devices.map((d) => d.id))).toEqual(sorted(omemo2Ids))
    expect(lists.omemo2.devices.map((d) => d.label).filter(Boolean).sort()).toEqual(['Laptop', 'Phone'])
    for (const d of lists.omemo2.devices) expect(d.fingerprint).toBe(fixture.omemo2.fingerprints[d.id])
    expect(sorted(lists.legacy.devices.map((d) => d.id))).toEqual(sorted(legacyIds))
    for (const d of lists.legacy.devices) expect(d.fingerprint).toBe(fixture.legacy.fingerprints[d.id])
    log.noPluginAfterRead = noPlugin && !alice.e2ee?.hasPlugins()
    expect(log.noPluginAfterRead).toBe(true)
    await alice.disconnect()
    await seeder.stop()
  }, 60000)

  it('bundle-fallback: devices without a readable bundle stay listed without a fingerprint', async () => {
    const seeder = await rawClient('carol', 'seed')
    const noOmemo2 = String(omemo2Ids[0])
    const noLegacy = String(legacyIds[0])
    await seedAccount(seeder, { omit: new Set([noOmemo2, noLegacy]), legacyGarbled: String(legacyIds[1]) })
    const carol = await sdkClient('carol')
    const lists = await readOwnDeviceLists(pepAccessFor(carol), 'carol@localhost')
    log.carolRead = lists
    if (!lists.omemo2.ok || !lists.legacy.ok) throw new Error('lists should read')
    expect(lists.omemo2.devices).toHaveLength(omemo2Ids.length)
    expect(lists.legacy.devices).toHaveLength(legacyIds.length)
    const without = [...lists.omemo2.devices, ...lists.legacy.devices].filter((d) => d.fingerprint === undefined).map((d) => d.id)
    expect(sorted(without)).toEqual(sorted([Number(noOmemo2), Number(noLegacy), legacyIds[1]]))
    await carol.disconnect()
    await seeder.stop()
  }, 60000)

  it('remove-keeps-others: the chosen devices go, everything else is stored as it was', async () => {
    const seeder = await rawClient('alice', 'check')
    await seedAccount(seeder)
    // A foreign element also called `device`, sharing a removed id, sits in the list another client published.
    const target = omemo2Ids[0]
    const withForeign = fixture.omemo2.devices.replace(/<\/ns0:devices>$/, `<device xmlns='urn:example:other' id='${target}'/></ns0:devices>`)
    await seed(seeder, NS_DEVICES, item('current', withForeign))
    const before = { omemo2: await stored(seeder, NS_DEVICES), legacy: await stored(seeder, NS_LEGACY_DEVICELIST) }
    const alice = await sdkClient('alice')
    const pep = pepAccessFor(alice)
    const r1 = await removeOwnDevices(pep, 'alice@localhost', 'omemo2', [target, 424242])
    const r2 = await removeOwnDevices(pep, 'alice@localhost', 'legacy', [legacyIds[0]])
    expect(r1).toEqual({ removed: [target], missing: [424242] })
    expect(r2).toEqual({ removed: [legacyIds[0]], missing: [] })
    const after = { omemo2: await stored(seeder, NS_DEVICES), legacy: await stored(seeder, NS_LEGACY_DEVICELIST) }
    log.removal = { before, after }
    const entries = (xml: string[]): string[] => collect(parse(xml[0]), 'device')
    const was = entries(before.omemo2)
    const now = entries(after.omemo2)
    // Same entries, byte for byte, minus the removed OMEMO 2 device; the foreign `device` stays.
    expect(now).toEqual(was.filter((e) => !isRemoved(e, target)))
    expect(now.some((e) => e.includes('urn:example:other'))).toBe(true)
    expect(now.some((e) => isRemoved(e, target))).toBe(false)
    expect(entries(after.legacy)).toEqual(entries(before.legacy).filter((e) => !isRemoved(e, legacyIds[0])))
    expect(r1.removed).toEqual([target])
    // A removal with no matching id publishes nothing: the stored item is untouched.
    const r3 = await removeOwnDevices(pep, 'alice@localhost', 'legacy', [999])
    expect(r3).toEqual({ removed: [], missing: [999] })
    expect(await stored(seeder, NS_LEGACY_DEVICELIST)).toEqual(after.legacy)
    log.noPluginAfterRemove = !alice.e2ee?.hasPlugins()
    expect(log.noPluginAfterRemove).toBe(true)
    // The bundles were not touched by any of this, and no device was added.
    expect((await stored(seeder, NS_BUNDLES)).length).toBe(omemo2Ids.length)
    await alice.disconnect()
    await seeder.stop()
  }, 60000)

  it('plugin-writer-keeps-names: ensureIdentity adds our device once and keeps the others as published', async () => {
    const seeder = await rawClient('bob', 'seed')
    await wipe(seeder)
    await seed(seeder, NS_DEVICES, item('current', fixture.omemo2.devices))
    const before = await stored(seeder, NS_DEVICES)
    const bob = await sdkClient('bob')
    const plugin = new OmemoPlugin()
    await bob.e2ee!.register(plugin)
    const id = await plugin.ensureIdentity()
    const afterFirst = await stored(seeder, NS_DEVICES)
    await plugin.ensureIdentity()
    const afterSecond = await stored(seeder, NS_DEVICES)
    log.writer = { before, afterFirst, afterSecond }
    const was = collect(parse(before[0]), 'device')
    const now = collect(parse(afterFirst[0]), 'device')
    expect(now.slice(0, was.length)).toEqual(was)
    expect(now).toHaveLength(was.length + 1)
    expect(now[was.length]).toMatch(new RegExp(`\\bid=['"]${id.devices?.[0]?.deviceId}['"]`))
    expect(afterSecond).toEqual(afterFirst) // the repeat publishes no device list change
    const lists = await readOwnDeviceLists(pepAccessFor(bob), 'bob@localhost')
    if (!lists.omemo2.ok) throw new Error('list should read')
    expect(lists.omemo2.devices.find((d) => String(d.id) === id.devices?.[0]?.deviceId)?.fingerprint).toBe(id.fingerprint)
    expect(lists.omemo2.devices.map((d) => d.label).filter(Boolean).sort()).toEqual(['Laptop', 'Phone'])
    // A list that is not an OMEMO list is refused and left as it was.
    await seed(seeder, NS_DEVICES, item('current', "<wrong xmlns='urn:xmpp:omemo:2'><device id='5' label='Other'/></wrong>"))
    const wrongStored = await stored(seeder, NS_DEVICES)
    await expect(plugin.ensureIdentity()).rejects.toThrow(/unexpected/)
    expect(await stored(seeder, NS_DEVICES)).toEqual(wrongStored)
    await bob.disconnect()
    await seeder.stop()
  }, 90000)

  it('inherited-namespaces: a prefix the server dropped is an error, never a guess or a rewrite', async () => {
    // A prefix declared on the <item> is dropped by this server (it keeps only the item id), so the payload comes
    // back with an unbound prefix. The SDK's copy of declarations in scope is proven with xmpp.js elements in
    // PubSub.pep.test.ts; what this server can show is that such a list is refused and left as stored.
    const seeder = await rawClient('dave', 'seed')
    await wipe(seeder)
    await seed(seeder, NS_DEVICES, `<item id='current' xmlns:o='urn:xmpp:omemo:2'><o:devices><o:device id='1' label='A'/><o:device id='2' label='B'/></o:devices></item>`)
    const raw = await stored(seeder, NS_DEVICES)
    log.inheritedFullResponse = lastResponse[NS_DEVICES]
    const dave = await sdkClient('dave')
    const pep = pepAccessFor(dave)
    const read = await readOwnDeviceLists(pep, 'dave@localhost')
    expect(read.omemo2.ok).toBe(false)
    await expect(removeOwnDevices(pep, 'dave@localhost', 'omemo2', [1])).rejects.toThrow(/unexpected/)
    expect(await stored(seeder, NS_DEVICES)).toEqual(raw)
    // A prefix declared on the payload itself, which this server keeps, reads and edits normally.
    await seed(seeder, NS_DEVICES, `<item id='current'><o:devices xmlns:o='urn:xmpp:omemo:2'><o:device id='1' label='A'/><o:device id='2' label='B'/></o:devices></item>`)
    log.selfContainedStored = await stored(seeder, NS_DEVICES)
    expect((await readOwnDeviceLists(pep, 'dave@localhost')).omemo2).toEqual({ ok: true, devices: [{ id: 1, label: 'A' }, { id: 2, label: 'B' }] })
    await removeOwnDevices(pep, 'dave@localhost', 'omemo2', [1])
    log.selfContainedAfter = await stored(seeder, NS_DEVICES)
    expect((await readOwnDeviceLists(pep, 'dave@localhost')).omemo2).toEqual({ ok: true, devices: [{ id: 2, label: 'B' }] })
    await dave.disconnect()
    await seeder.stop()
  }, 60000)
})

/** The serialized `local`-named descendants of the list element, in order. */
function collect(root: { children: unknown[]; toString(): string }, local: string): string[] {
  const out: string[] = []
  const walk = (el: { name?: string; children?: unknown[]; toString(): string }): void => {
    for (const c of el.children ?? []) {
      if (typeof c === 'string') continue
      const child = c as { name: string; children: unknown[]; toString(): string }
      if (child.name === local || child.name.endsWith(`:${local}`)) out.push(child.toString())
      else walk(child)
    }
  }
  walk(root)
  return out
}
const isRemoved = (entry: string, id: number): boolean => new RegExp(`\\bid=['"]${id}['"]`).test(entry) && !entry.includes('urn:example:other')
