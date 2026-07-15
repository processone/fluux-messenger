// @xmpp/xml's DefinitelyTyped types model `xml` as a default export only
// (the runtime module also exposes it as a named export, but we import per
// the types so `tsc` can verify usage).
import xml from '@xmpp/xml'
import type { Element } from '@xmpp/xml'
// ltx ships the parser that @xmpp/xml is built on; @xmpp/xml does not
// re-export `parse`, so we depend on ltx directly (pinned to the version
// already resolved by @xmpp/xml so both dedupe to a single copy).
import { parse as ltxParse } from 'ltx'
import type { XMLElementData } from '@fluux/sdk'

/**
 * Converts a live `@xmpp/xml` `Element` into the plain, structural
 * `XMLElementData` shape used at the E2EE plugin trait boundary.
 */
export function elementToData(el: Element): XMLElementData {
  return {
    name: el.name,
    attrs: { ...el.attrs },
    children: el.children.map((c) => (typeof c === 'string' ? c : elementToData(c as Element))),
  }
}

/**
 * Builds a live `@xmpp/xml` `Element` from the plain `XMLElementData` shape.
 * Uses `xml()` (ltx under the hood) so attribute/text escaping is always
 * handled by the library, never by hand-rolled string concatenation.
 */
export function dataToElement(d: XMLElementData): Element {
  const children = d.children.map((c) => (typeof c === 'string' ? c : dataToElement(c)))
  return xml(d.name, d.attrs, ...children)
}

/**
 * Parses an XML string into a live `Element`, relying on ltx's parser for
 * correct entity handling. This is the only sanctioned way to turn a raw
 * string into an `Element` in this package — never hand-roll XML parsing.
 */
export function parseXml(s: string): Element {
  return ltxParse(s) as unknown as Element
}

/** Serializes a live `Element` back to an XML string. */
export function serializeElement(el: Element): string {
  return el.toString()
}
