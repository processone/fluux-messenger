// Read and remove entries of the account's OWN OMEMO device lists, with no
// plugin and no Fluux device involved. Used by the device-management screen,
// which must work before OMEMO is turned on.
//
// A device list is shared with every other client of the account, so a write
// here must change nothing but the removed ids: other devices keep their
// label, `labelsig` and any attribute or child this code does not know. For
// that reason removal edits the element the server returned instead of
// rebuilding the list from ids. Elements are matched by expanded name
// (namespace + local name), because clients may serialize prefixed XML.
import type { PEPItem, PEPPublishOptions, XMLElementData } from '@fluux/sdk'
import { NS_OMEMO, NS_DEVICES, NS_BUNDLES, NS_LEGACY_OMEMO, NS_LEGACY_DEVICELIST, NS_LEGACY_BUNDLES_PREFIX } from './namespaces'

export type DeviceListProtocol = 'omemo2' | 'legacy'

/** One entry of a device list as another client published it. */
export interface OwnDevice {
  id: number
  /** The name its owner gave it, when it published one. */
  label?: string
  /**
   * Its identity key in hex (32 bytes, for both protocols), as the device's own bundle publishes it.
   * Absent when the bundle is missing or unreadable; the device stays listed.
   */
  fingerprint?: string
}

/** What this module needs from the account's PEP: reads and writes of its own nodes. */
export interface OwnPepAccess {
  query(jid: string, node: string, maxItems?: number): Promise<PEPItem[]>
  publish(node: string, item: PEPItem, options?: PEPPublishOptions): Promise<void>
}

/** One list's read: its devices, or why it could not be read. Never an empty list for a failure. */
export type DeviceListRead = { ok: true; devices: OwnDevice[] } | { ok: false; error: Error }

export interface OwnDeviceLists {
  omemo2: DeviceListRead
  legacy: DeviceListRead
}

export interface RemoveResult {
  /** Ids that were in the list and are no longer. */
  removed: number[]
  /** Ids asked for that were not in the list; nothing was published for them. */
  missing: number[]
}

const LISTS = {
  omemo2: { node: NS_DEVICES, root: 'devices', xmlns: NS_OMEMO },
  legacy: { node: NS_LEGACY_DEVICELIST, root: 'list', xmlns: NS_LEGACY_OMEMO },
} as const

const parseId = (raw: string | undefined): number | null => (raw !== undefined && /^\d+$/.test(raw) ? Number(raw) : null)

/** `item-not-found` is how servers say the node was never created; any other error is a real failure. */
function isNodeAbsent(err: unknown): boolean {
  return (err instanceof Error ? err.message : String(err)).includes('item-not-found')
}

/** Prefix (`''` for the default namespace) to namespace URI, in scope at an element. */
type Scope = Readonly<Record<string, string>>

/** The namespaces `el` declares, added to those inherited from its parent. */
function scopeOf(el: XMLElementData, inherited: Scope): Scope {
  let scope = inherited
  for (const [name, value] of Object.entries(el.attrs)) {
    if (name === 'xmlns') scope = { ...scope, '': value }
    else if (name.startsWith('xmlns:')) scope = { ...scope, [name.slice(6)]: value }
  }
  return scope
}

/** True when `el`, in `inherited` scope, is the element `local` in namespace `ns`, whatever prefix it was written with. */
function isElement(el: XMLElementData, inherited: Scope, local: string, ns: string): boolean {
  const colon = el.name.indexOf(':')
  const prefix = colon < 0 ? '' : el.name.slice(0, colon)
  return el.name.slice(colon + 1) === local && scopeOf(el, inherited)[prefix] === ns
}

const elementChildren = (el: XMLElementData): XMLElementData[] =>
  el.children.filter((c): c is XMLElementData => typeof c !== 'string')

/** The newest item's payload, or `null` when the node is absent or empty. */
async function readItem(
  pep: OwnPepAccess,
  jid: string,
  node: string,
  maxItems?: number,
): Promise<PEPItem | null> {
  let items: PEPItem[]
  try {
    items = await pep.query(jid, node, maxItems)
  } catch (err) {
    if (isNodeAbsent(err)) return null
    throw err
  }
  return items[items.length - 1] ?? null
}

/** The current list item, checked to be the protocol's list element. */
async function readCurrent(pep: OwnPepAccess, jid: string, protocol: DeviceListProtocol): Promise<PEPItem | null> {
  const { node, root, xmlns } = LISTS[protocol]
  const item = await readItem(pep, jid, node, 1)
  if (item && !isElement(item.payload, {}, root, xmlns)) {
    throw new Error(`unexpected ${protocol} device list payload <${item.payload.name}>`)
  }
  return item
}

/** The `<device>` entries of a list, with their ids; anything else in the list is not a device. */
function deviceEntries(list: XMLElementData, protocol: DeviceListProtocol): { el: XMLElementData; id: number | null }[] {
  const { xmlns } = LISTS[protocol]
  const scope = scopeOf(list, {})
  return elementChildren(list)
    .filter((c) => isElement(c, scope, 'device', xmlns))
    .map((el) => ({ el, id: parseId(el.attrs.id) }))
}

function fromBase64(text: string): Uint8Array | null {
  try {
    return Uint8Array.from(atob(text.replace(/\s+/g, '')), (c) => c.charCodeAt(0))
  } catch {
    return null
  }
}

/**
 * The identity key a bundle publishes, as the hex of its 32-byte Curve25519 form: the fingerprint the plugin
 * itself shows. A legacy key is already that, behind a type byte (0x05). An OMEMO 2 `ik` is the Ed25519 key and
 * is converted the way the plugin converts it. `null` when the key is missing or unreadable.
 */
async function identityFingerprint(bundle: XMLElementData, protocol: DeviceListProtocol): Promise<string | null> {
  const ns = protocol === 'omemo2' ? NS_OMEMO : NS_LEGACY_OMEMO
  if (!isElement(bundle, {}, 'bundle', ns)) return null
  const scope = scopeOf(bundle, {})
  const key = elementChildren(bundle).find((c) => isElement(c, scope, protocol === 'omemo2' ? 'ik' : 'identityKey', ns))
  const text = key?.children.filter((c): c is string => typeof c === 'string').join('')
  let bytes = text ? fromBase64(text) : null
  if (!bytes) return null
  try {
    if (protocol === 'legacy') {
      if (bytes.length === 33 && bytes[0] === 0x05) bytes = bytes.slice(1)
    } else if (bytes.length === 32) {
      // Loaded here, not at the top, so reading only a legacy list never pulls in the crypto package.
      bytes = (await import('@fluux/omemo')).fingerprint(bytes)
    }
  } catch {
    return null
  }
  return bytes.length === 32 ? [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('') : null
}

/** Fingerprints by device id; a missing or unreadable bundle leaves its device out of the map. */
async function readFingerprints(
  pep: OwnPepAccess,
  jid: string,
  protocol: DeviceListProtocol,
  ids: number[],
): Promise<Map<number, string>> {
  const found = new Map<number, string>()
  if (ids.length === 0) return found
  if (protocol === 'omemo2') {
    // One shared node holds every device's bundle, as the item whose id is the device id.
    const items = await pep.query(jid, NS_BUNDLES).catch(() => [] as PEPItem[])
    for (const item of items) {
      const id = parseId(item.id)
      const print = id !== null && ids.includes(id) ? await identityFingerprint(item.payload, protocol) : null
      if (id !== null && print) found.set(id, print)
    }
  } else {
    await Promise.all(
      ids.map(async (id) => {
        const item = await readItem(pep, jid, `${NS_LEGACY_BUNDLES_PREFIX}${id}`, 1).catch(() => null)
        const print = item ? await identityFingerprint(item.payload, protocol) : null
        if (print) found.set(id, print)
      }),
    )
  }
  return found
}

async function readList(pep: OwnPepAccess, jid: string, protocol: DeviceListProtocol): Promise<DeviceListRead> {
  try {
    const current = await readCurrent(pep, jid, protocol)
    const entries = current ? deviceEntries(current.payload, protocol) : []
    const devices: OwnDevice[] = []
    for (const { el, id } of entries) {
      if (id !== null) devices.push(el.attrs.label ? { id, label: el.attrs.label } : { id })
    }
    const prints = await readFingerprints(pep, jid, protocol, devices.map((d) => d.id))
    return { ok: true, devices: devices.map((d) => (prints.has(d.id) ? { ...d, fingerprint: prints.get(d.id) } : d)) }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err : new Error(String(err)) }
  }
}

/** Reads the account's OMEMO 2 and legacy device lists. A failure on one list leaves the other readable. */
export async function readOwnDeviceLists(pep: OwnPepAccess, accountJid: string): Promise<OwnDeviceLists> {
  const [omemo2, legacy] = await Promise.all([
    readList(pep, accountJid, 'omemo2'),
    readList(pep, accountJid, 'legacy'),
  ])
  return { omemo2, legacy }
}

/**
 * Removes `ids` from one of the account's device lists. The list is read again
 * just before the write, so a change another client made since the screen
 * loaded is kept. Nothing is published when none of the ids is in the list.
 * Throws when the list cannot be read or is malformed, leaving it as it was.
 */
export async function removeOwnDevices(
  pep: OwnPepAccess,
  accountJid: string,
  protocol: DeviceListProtocol,
  ids: readonly number[],
): Promise<RemoveResult> {
  const wanted = new Set(ids)
  const current = await readCurrent(pep, accountJid, protocol)
  const doomed = new Set(
    current ? deviceEntries(current.payload, protocol).filter((e) => e.id !== null && wanted.has(e.id)).map((e) => e.el) : [],
  )
  const present = new Set([...doomed].map((el) => parseId(el.attrs.id)))
  const missing = [...wanted].filter((id) => !present.has(id))
  if (!current || doomed.size === 0) return { removed: [], missing }
  // The root keeps its attributes, so every prefix declared on it still resolves for what stays.
  const next: XMLElementData = {
    ...current.payload,
    children: current.payload.children.filter((c) => typeof c === 'string' || !doomed.has(c)),
  }
  await pep.publish(LISTS[protocol].node, { id: current.id, payload: next })
  return { removed: [...present].filter((id): id is number => id !== null), missing }
}

/**
 * Adds one device to the account's OMEMO 2 list for the plugin's own publication, keeping every entry already
 * there as published (labels included). Does nothing when the id is listed. Throws when the list cannot be
 * read or is malformed, rather than replacing it. `options` apply when the list does not exist yet or is written.
 */
export async function addOwnOmemo2Device(
  pep: OwnPepAccess,
  accountJid: string,
  deviceId: number,
  options?: PEPPublishOptions,
): Promise<void> {
  const current = await readCurrent(pep, accountJid, 'omemo2')
  const root: XMLElementData = current?.payload ?? { name: 'devices', attrs: { xmlns: NS_OMEMO }, children: [] }
  if (deviceEntries(root, 'omemo2').some((e) => e.id === deviceId)) return
  const colon = root.name.indexOf(':')
  const device: XMLElementData = {
    name: colon < 0 ? 'device' : `${root.name.slice(0, colon)}:device`,
    attrs: { id: String(deviceId) },
    children: [],
  }
  await pep.publish(NS_DEVICES, { id: current?.id ?? 'current', payload: { ...root, children: [...root.children, device] } }, options)
}
