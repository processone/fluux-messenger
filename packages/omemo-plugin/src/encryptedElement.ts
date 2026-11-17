// OMEMO 2 <encrypted> wire element <-> OmemoMessage mapping (XEP-0384).
//
// The <encrypted> element is the OMEMO transport payload attached to a message:
//
//   <encrypted xmlns='urn:xmpp:omemo:2'>
//     <header sid='N'>
//       <keys jid='...'>
//         <key rid='N' [kex='true']>b64</key>
//         ...
//       </keys>
//       ...one <keys> group per recipient JID...
//     </header>
//     <payload>b64</payload>   <!-- omitted for key-transport messages -->
//   </encrypted>
//
// Field and attribute names here are an INTEROP CONTRACT with other OMEMO 2
// implementations (Conversations, python-omemo, ...): do not rename them.
//
// Uses the ONE @xmpp lineage the project shares: `xml` + the `Element` type from
// @xmpp/client (typed by the local ambient shim, src/xmpp.d.ts), and
// b64encode/b64decode + the message types from @fluux/omemo. No hand-rolled XML.
import { xml } from '@xmpp/client'
import type { Element } from '@xmpp/client'
import { b64encode, b64decode } from '@fluux/omemo'
import type { OmemoMessage, OmemoKey } from '@fluux/omemo'
import { NS_OMEMO } from './namespaces'

/**
 * Serializes an `OmemoMessage` into a live `<encrypted xmlns='urn:xmpp:omemo:2'>`
 * `Element`. The flat `msg.keys` list is grouped into one `<keys jid='...'>`
 * element per distinct recipient JID (preserving key order within each group).
 * `kex='true'` is emitted only for key-exchange keys (never `kex='false'`), and
 * `<payload>` is omitted entirely for key-transport (payload-less) messages.
 */
export function buildEncrypted(msg: OmemoMessage): Element {
  const byJid = new Map<string, OmemoKey[]>()
  for (const k of msg.keys) {
    const group = byJid.get(k.jid)
    if (group) group.push(k)
    else byJid.set(k.jid, [k])
  }

  const header = xml('header', { sid: String(msg.sid) })
  for (const [jid, keys] of byJid) {
    const keysEl = xml('keys', { jid })
    for (const k of keys) {
      const attrs: Record<string, string> = { rid: String(k.rid) }
      if (k.kex) attrs.kex = 'true'
      keysEl.append(xml('key', attrs, b64encode(k.data)))
    }
    header.append(keysEl)
  }

  const enc = xml('encrypted', { xmlns: NS_OMEMO }, header)
  if (msg.payload) enc.append(xml('payload', {}, b64encode(msg.payload)))
  return enc
}

/**
 * Parses a live `<encrypted>` `Element` back into an `OmemoMessage`, flattening
 * every `<keys jid>` group into the flat `keys` list and tagging each key with
 * its group's JID. Hostile / malformed input is rejected rather than silently
 * coerced: a non-numeric `sid`/`rid` throws (never a silent `NaN`), a `<keys>`
 * group missing its `jid` throws, and non-base64 `<key>`/`<payload>` text
 * throws (garbage never becomes empty bytes) via `b64decode`.
 */
export function parseEncrypted(el: Element): OmemoMessage {
  if (el.name !== 'encrypted' || el.attrs.xmlns !== NS_OMEMO) {
    throw new Error('not a urn:xmpp:omemo:2 <encrypted> element')
  }
  const header = el.getChild('header')
  if (!header) throw new Error('<encrypted> missing <header>')

  const sid = Number(header.attrs.sid)
  if (!Number.isInteger(sid)) throw new Error(`invalid <header> sid: ${header.attrs.sid}`)

  const keys: OmemoKey[] = []
  for (const keysEl of header.getChildren('keys')) {
    const jid = keysEl.attrs.jid
    if (!jid) throw new Error('<keys> group missing jid attribute')
    for (const keyEl of keysEl.getChildren('key')) {
      const rid = Number(keyEl.attrs.rid)
      if (!Number.isInteger(rid)) throw new Error(`invalid <key> rid: ${keyEl.attrs.rid}`)
      keys.push({
        jid,
        rid,
        kex: keyEl.attrs.kex === 'true',
        data: b64decode(keyEl.text()),
      })
    }
  }

  const payloadEl = el.getChild('payload')
  if (payloadEl) return { sid, keys, payload: b64decode(payloadEl.text()) }
  return { sid, keys }
}
