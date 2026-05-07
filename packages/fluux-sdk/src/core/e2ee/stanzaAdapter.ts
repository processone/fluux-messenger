import { xml } from '@xmpp/client'
import type { Element } from '@xmpp/client'
import type { XMLElementData } from './types'

/**
 * Convert a live `@xmpp/client` Element into the structural {@link XMLElementData}
 * form that plugins consume. JSON-serializable so the same shape works for
 * TS plugins and native/WASM plugins bridged across an IPC boundary.
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
 * Inverse of {@link elementToData}. Builds a real Element from the structural
 * form produced by a plugin, ready to be dropped into an outgoing stanza.
 */
export function dataToElement(data: XMLElementData): Element {
  const children = data.children.map((child) =>
    typeof child === 'string' ? child : dataToElement(child),
  )
  return xml(data.name, data.attrs, ...children) as Element
}
