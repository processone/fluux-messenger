// OMEMO 2 (XEP-0384) device-list + bundle PEP mapping, published/fetched over
// the host-provided `XMPPPrimitives`. This module owns the Bundle/DeviceList
// <-> XML mapping and never talks to `@xmpp/client` directly except to build
// or read the payload `Element` at the plugin trait boundary.
import { xml } from '@xmpp/client'
import type { Element } from '@xmpp/client'
import type { XMPPPrimitives, E2EESubscription } from '@fluux/sdk'
import type { Bundle } from '@fluux/omemo'
import { b64encode, b64decode } from '@fluux/omemo'
import { elementToData, dataToElement } from './stanzaData'
import { NS_OMEMO, devicesNode, bundleNode } from './namespaces'

const CURRENT_ITEM_ID = 'current'
const PUBLISH_OPTIONS = { accessModel: 'open' as const, maxItems: 1 }

/** Parses a stanza `id` attribute as a non-negative integer, or `null` if malformed. */
function parseDeviceId(raw: string | undefined): number | null {
  if (raw === undefined) return null
  return /^\d+$/.test(raw) ? Number(raw) : null
}

export function deviceListToXml(ids: number[]): Element {
  return xml('devices', { xmlns: NS_OMEMO }, ...ids.map((id) => xml('device', { id: String(id) })))
}

export function deviceListFromXml(el: Element): number[] {
  return el
    .getChildren('device')
    .map((d) => parseDeviceId(d.attrs.id as string | undefined))
    .filter((n): n is number => n !== null)
}

export function bundleToXml(b: Bundle): Element {
  return xml(
    'bundle',
    { xmlns: NS_OMEMO },
    xml('ik', {}, b64encode(b.ik)),
    xml('spk', { id: String(b.spkId) }, b64encode(b.spk)),
    xml('spks', {}, b64encode(b.spkSig)),
    xml('prekeys', {}, ...b.preKeys.map((p) => xml('pk', { id: String(p.id) }, b64encode(p.key)))),
  )
}

export function bundleFromXml(el: Element): Bundle {
  const spk = el.getChild('spk')
  const ik = el.getChild('ik')
  const spks = el.getChild('spks')
  const prekeys = el.getChild('prekeys')
  if (!spk || !ik || !spks || !prekeys) {
    throw new Error('malformed OMEMO 2 bundle: missing ik/spk/spks/prekeys')
  }
  const spkId = parseDeviceId(spk.attrs.id as string | undefined)
  if (spkId === null) {
    throw new Error(`malformed OMEMO 2 bundle: non-numeric spk id "${String(spk.attrs.id)}"`)
  }
  return {
    ik: b64decode(ik.text()),
    spkId,
    spk: b64decode(spk.text()),
    spkSig: b64decode(spks.text()),
    preKeys: prekeys
      .getChildren('pk')
      .map((p) => ({ id: parseDeviceId(p.attrs.id as string | undefined), key: b64decode(p.text()) }))
      .filter((p): p is { id: number; key: Uint8Array } => p.id !== null),
  }
}

export async function publishDeviceList(xmpp: XMPPPrimitives, deviceIds: number[]): Promise<void> {
  await xmpp.publishPEP(
    devicesNode(),
    { id: CURRENT_ITEM_ID, payload: elementToData(deviceListToXml(deviceIds)) },
    PUBLISH_OPTIONS,
  )
}

export async function fetchDeviceList(xmpp: XMPPPrimitives, jid: string): Promise<number[]> {
  const items = await xmpp.queryPEP(jid, devicesNode(), 1)
  return items[0] ? deviceListFromXml(dataToElement(items[0].payload)) : []
}

export function subscribeDeviceList(
  xmpp: XMPPPrimitives,
  jid: string,
  cb: (ids: number[]) => void,
): E2EESubscription {
  return xmpp.subscribePEP(jid, devicesNode(), (item) => cb(deviceListFromXml(dataToElement(item.payload))))
}

export async function publishBundle(xmpp: XMPPPrimitives, deviceId: number, bundle: Bundle): Promise<void> {
  await xmpp.publishPEP(
    bundleNode(deviceId),
    { id: CURRENT_ITEM_ID, payload: elementToData(bundleToXml(bundle)) },
    PUBLISH_OPTIONS,
  )
}

export async function fetchBundle(xmpp: XMPPPrimitives, jid: string, deviceId: number): Promise<Bundle | null> {
  const items = await xmpp.queryPEP(jid, bundleNode(deviceId), 1)
  return items[0] ? bundleFromXml(dataToElement(items[0].payload)) : null
}
