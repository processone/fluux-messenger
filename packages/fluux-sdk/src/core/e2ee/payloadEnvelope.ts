/**
 * Payload envelope for the E2EE plaintext boundary.
 *
 * The plugin trait encrypts a `Uint8Array` — conceptually "plaintext bytes"
 * that Sequoia (or any other plugin) wraps in a literal packet. On its own
 * this only carries a body string, which forces metadata-leaking elements
 * (XEP-0066 OOB, XEP-0446 file-metadata, XEP-0085 chat states, XEP-0444
 * reactions, …) to ride outside the encrypted envelope.
 *
 * This module widens the boundary: the plaintext is a serialized XML fragment
 * — `<payload xmlns='jabber:client'>…children…</payload>` — whose children
 * are the stanza extension elements the host chose to protect, per the
 * XEP-0420 §9 policy. The envelope is intentionally a minimal subset of
 * XEP-0373 §4.1 (no `<to/>`/`<time/>`/`<rpad/>` affixes yet — those are a
 * separate compliance task). Once the full envelope lands, `serialize` grows
 * those children and `parse` validates them; the host contract here does
 * not change.
 *
 * On inbound, {@link parse} returns the extracted children when the plaintext
 * is a valid payload envelope. It returns `null` when the plaintext is a
 * bare string (legacy body-only format), letting the decrypt path fall back
 * to the historical "replace `<body>` with plaintext string" behaviour.
 *
 * @packageDocumentation
 * @module E2EE/PayloadEnvelope
 */

import { xml } from '@xmpp/client'
import type { Element } from '@xmpp/client'
import * as ltx from 'ltx'

/** XML namespace we tag on the `<payload/>` so ltx parses correctly. */
const PAYLOAD_NAMESPACE = 'jabber:client'
const PAYLOAD_ELEMENT = 'payload'

/**
 * Serialize one or more stanza-extension children into a payload envelope
 * string suitable for passing to the E2EE plugin as plaintext.
 *
 * The wrapping `<payload xmlns='jabber:client'>` is fixed so the inbound
 * side knows where to dispatch. Callers should pass Elements already built
 * via `xml(...)` — the serializer does not validate content.
 */
export function serialize(children: Element[]): string {
  const envelope = xml(PAYLOAD_ELEMENT, { xmlns: PAYLOAD_NAMESPACE }, ...children)
  return envelope.toString()
}

/**
 * Attempt to parse plaintext produced by {@link serialize} back into its
 * children. Returns the children array on success, or `null` when the
 * plaintext is not a payload envelope (legacy bare-body-string format, or
 * malformed XML).
 *
 * This is deliberately permissive: any parse failure falls back to the
 * legacy path rather than throwing, so a single malformed ciphertext can't
 * bring down the inbound pipeline. Real tamper detection lives one layer
 * up, in the AEAD tag of the encryption plugin itself — if we got here
 * with bytes, the plugin already vouched for their integrity.
 */
export function parse(plaintext: string): Element[] | null {
  if (plaintext.length === 0) return null
  // Fast reject: anything that doesn't start with `<payload` is a legacy
  // bare body string. Keeps us from paying ltx.parse for every decrypt.
  if (!plaintext.startsWith(`<${PAYLOAD_ELEMENT}`)) return null
  let root: ltx.Element
  try {
    root = ltx.parse(plaintext)
  } catch {
    return null
  }
  if (root.name !== PAYLOAD_ELEMENT) return null
  // Only surface element children — text between children (indentation,
  // whitespace) would otherwise leak into callers that append directly to
  // a stanza. Our serializer never emits text between children, so this
  // is safe to drop.
  const out: Element[] = []
  for (const child of root.children) {
    if (typeof child === 'string') continue
    out.push(child as unknown as Element)
  }
  return out
}

/**
 * Probe without allocating: is this plaintext string a payload envelope?
 * Used by the decrypt path to decide between the new child-fragment flow
 * and the legacy body-string flow.
 */
export function isPayloadEnvelope(plaintext: string): boolean {
  return plaintext.startsWith(`<${PAYLOAD_ELEMENT}`)
}
