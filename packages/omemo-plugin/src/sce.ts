// XEP-0420 Stanza Content Encryption (SCE) envelope build/parse.
//
// This is the content-framing layer OMEMO encrypts: the plaintext <body> (and
// any other affix elements) is wrapped in an <envelope xmlns='urn:xmpp:sce:1'>,
// the envelope is what gets encrypted, and the peer re-injects the framed
// elements after decrypting. Content children are placed DIRECTLY under
// <content> (NOT wrapped in a <payload>), so a strict XEP-0420 peer such as
// Conversations re-injects the real <body> as-is.
//
// Uses the ONE @xmpp lineage the project shares: `xml` + the `Element` type from
// @xmpp/client (typed by the local ambient shim, src/xmpp.d.ts), and b64encode
// from @fluux/omemo. Randomness comes ONLY from the injected `rpadRng` — no
// wall-clock, no global RNG — so envelope construction is fully deterministic
// under test.
import { xml } from '@xmpp/client'
import type { Element } from '@xmpp/client'
import { b64encode } from '@fluux/omemo'
import { NS_SCE } from './namespaces'

/**
 * Builds a XEP-0420 `<envelope>`. The `content` children are placed DIRECTLY
 * under `<content>`. A mandatory `<rpad>` of 1..200 random bytes (base64) is
 * added for length-hiding; `<from>`, `<to>` and `<time>` affix elements are
 * added when the corresponding option is present.
 */
export function buildEnvelope(
  content: Element[],
  opts: { from?: string; to?: string; timeIso?: string },
  rpadRng: (n: number) => Uint8Array,
): Element {
  const rpadLen = (rpadRng(1)[0] % 200) + 1 // 1..200 bytes, per XEP-0420 guidance
  const env = xml(
    'envelope',
    { xmlns: NS_SCE },
    xml('content', {}, ...content),
    xml('rpad', {}, b64encode(rpadRng(rpadLen))),
  )
  if (opts.from) env.append(xml('from', { jid: opts.from }))
  if (opts.to) env.append(xml('to', { jid: opts.to }))
  if (opts.timeIso) env.append(xml('time', { stamp: opts.timeIso }))
  return env
}

/**
 * Parses a XEP-0420 `<envelope>`. Throws if the element is not a
 * `urn:xmpp:sce:1` `<envelope>` or is missing `<content>`. Returns the element
 * children of `<content>` (text nodes are filtered out), plus the affix values.
 */
export function parseEnvelope(envelope: Element): {
  content: Element[]
  from?: string
  to?: string
  timeIso?: string
} {
  if (envelope.name !== 'envelope' || envelope.attrs.xmlns !== NS_SCE) {
    throw new Error('not a urn:xmpp:sce:1 envelope')
  }
  const contentEl = envelope.getChild('content')
  if (!contentEl) throw new Error('SCE envelope missing <content>')
  const content = contentEl.children.filter((c): c is Element => typeof c !== 'string')
  return {
    content,
    from: envelope.getChild('from')?.attrs.jid,
    to: envelope.getChild('to')?.attrs.jid,
    timeIso: envelope.getChild('time')?.attrs.stamp,
  }
}
