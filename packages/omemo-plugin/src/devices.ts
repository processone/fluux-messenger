// Read and remove entries of the account's OWN OMEMO device lists, with no
// plugin and no Fluux device involved. Used by the device-management screen,
// which must work before OMEMO is turned on.
//
// A device list is shared with every other client of the account, so a write
// here must change nothing but the removed ids: other devices keep their
// label, `labelsig` and any attribute or child this code does not know. For
// that reason removal edits the element the server returned instead of
// rebuilding the list from ids (see `deviceListToXml`, which drops labels).
import { xml } from '@xmpp/client'
import type { Element } from '@xmpp/client'
import type { PEPItem, PEPPublishOptions } from '@fluux/sdk'
import type { XMPPClient } from '@fluux/sdk/core'
import { queryPepNode, publishPepNode } from '@fluux/sdk/xmpp'
import { dataToElement, elementToData } from './stanzaData'
import { NS_OMEMO, NS_DEVICES, NS_LEGACY_OMEMO, NS_LEGACY_DEVICELIST } from './namespaces'

/** Reads and writes the account's own PEP through a connected client, with no plugin registered. */
export function pepAccessFor(client: XMPPClient): OwnPepAccess {
  return {
    query: (jid, node, maxItems) => queryPepNode(client, jid, node, maxItems),
    publish: (node, item, options) => publishPepNode(client, node, item, options),
  }
}

export type DeviceListProtocol = 'omemo2' | 'legacy'

/** One entry of a device list as another client published it. */
export interface OwnDevice {
  id: number
  /** The name its owner gave it, when it published one. */
  label?: string
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

/** The newest item, as a live element, or `null` when the node is absent or empty. */
async function readCurrent(
  pep: OwnPepAccess,
  jid: string,
  protocol: DeviceListProtocol,
): Promise<{ id: string; el: Element } | null> {
  let items: PEPItem[]
  try {
    items = await pep.query(jid, LISTS[protocol].node, 1)
  } catch (err) {
    if (isNodeAbsent(err)) return null
    throw err
  }
  const item = items[items.length - 1]
  if (!item) return null
  const el = dataToElement(item.payload)
  const { root, xmlns } = LISTS[protocol]
  if (el.name !== root || el.attrs.xmlns !== xmlns) {
    throw new Error(`unexpected ${protocol} device list payload <${el.name}>`)
  }
  return { id: item.id, el }
}

function devicesOf(el: Element): OwnDevice[] {
  return el.getChildren('device').flatMap((d) => {
    const id = parseId(d.attrs.id)
    if (id === null) return []
    const label = d.attrs.label
    return [label ? { id, label } : { id }]
  })
}

async function readList(pep: OwnPepAccess, jid: string, protocol: DeviceListProtocol): Promise<DeviceListRead> {
  try {
    const current = await readCurrent(pep, jid, protocol)
    return { ok: true, devices: current ? devicesOf(current.el) : [] }
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
  const present = new Set<number>()
  const kept: (string | Element)[] = []
  for (const child of current?.el.children ?? []) {
    const id = typeof child === 'string' || child.name !== 'device' ? null : parseId(child.attrs.id)
    if (id !== null && wanted.has(id)) present.add(id)
    else kept.push(child)
  }
  const missing = [...wanted].filter((id) => !present.has(id))
  if (!current || present.size === 0) return { removed: [], missing }
  const { root, xmlns } = LISTS[protocol]
  const next = xml(root, { ...current.el.attrs, xmlns }, ...kept)
  await pep.publish(LISTS[protocol].node, { id: current.id, payload: elementToData(next) })
  return { removed: [...present], missing }
}
