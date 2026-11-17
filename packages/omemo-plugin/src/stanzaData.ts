// Use the ONE @xmpp lineage the project shares: `xml` + the `Element` type come
// from @xmpp/client (the same package @fluux/sdk uses), and `parse` from ltx —
// both at the SDK's exact versions. Types come from the local ambient shim
// (src/xmpp.d.ts), mirroring the SDK; @xmpp/client / ltx ship no declarations.
import { xml } from '@xmpp/client'
import type { Element } from '@xmpp/client'
import { parse as ltxParse } from 'ltx'
import type { XMLElementData } from '@fluux/sdk'

/**
 * Converts a live `@xmpp/client` `Element` into the plain, structural
 * `XMLElementData` shape used at the E2EE plugin trait boundary.
 */
export function elementToData(el: Element): XMLElementData {
  return {
    name: el.name,
    attrs: { ...(el.attrs ?? {}) } as Record<string, string>,
    children: (el.children ?? []).map((child) =>
      typeof child === 'string' ? child : elementToData(child as Element),
    ),
  }
}

/**
 * Builds a live `Element` from the plain `XMLElementData` shape. Uses `xml()`
 * (ltx under the hood) so attribute/text escaping is always handled by the
 * library, never by hand-rolled string concatenation.
 */
export function dataToElement(d: XMLElementData): Element {
  const children = d.children.map((child) => (typeof child === 'string' ? child : dataToElement(child)))
  return xml(d.name, d.attrs, ...children) as Element
}

/**
 * Parses an XML string into a live `Element`, relying on ltx's parser for
 * correct entity handling. This is the only sanctioned way to turn a raw
 * string into an `Element` in this package — never hand-roll XML parsing.
 */
export function parseXml(s: string): Element {
  return ltxParse(s)
}

/** Serializes a live `Element` back to an XML string (ltx handles escaping). */
export function serializeElement(el: Element): string {
  return el.toString()
}
