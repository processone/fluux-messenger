/**
 * What an anomaly detector may know about a stanza.
 *
 * Structural rather than ltx-typed: the classifier is pure, the tests build
 * literals, and a real `Element` satisfies this shape. Nothing here reaches a
 * record — the app tokenizes `to` at the recorder boundary, and `kind` becomes a
 * closed TAG constant.
 *
 * @module Anomaly/Detectors/StanzaFacts
 */

export type QueryKind =
  | 'disco-info'
  | 'disco-items'
  | 'vcard'
  | 'avatar'
  | 'mam'
  | 'roster'
  | 'other'

export interface ElementLike {
  name: string
  attrs: Record<string, unknown>
  children?: unknown[]
  getChild(name: string, ns?: string): ElementLike | undefined
}

export interface OutFacts {
  id: string
  kind: QueryKind
  /** The JID as addressed. Empty means the account's own server. */
  to: string
  /**
   * Identity for the redundancy check, or `null` when a repeat is legitimate.
   */
  dedupe: string | null
}

export interface InFacts {
  id: string
  type: string
}

const NS_DISCO_INFO = 'http://jabber.org/protocol/disco#info'
const NS_DISCO_ITEMS = 'http://jabber.org/protocol/disco#items'
const NS_VCARD = 'vcard-temp'
const NS_MAM = 'urn:xmpp:mam:2'
const NS_ROSTER = 'jabber:iq:roster'
const NS_PUBSUB = 'http://jabber.org/protocol/pubsub'
const NS_RSM = 'http://jabber.org/protocol/rsm'
const AVATAR_NODES = new Set(['urn:xmpp:avatar:data', 'urn:xmpp:avatar:metadata'])

function str(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function elements(parent: ElementLike): ElementLike[] {
  const out: ElementLike[] = []
  for (const raw of parent.children ?? []) {
    const child = raw as ElementLike | undefined
    if (child && typeof child === 'object' && typeof child.name === 'string') out.push(child)
  }
  return out
}

function text(element: ElementLike): string {
  return (element.children ?? [])
    .filter((child): child is string => typeof child === 'string')
    .join('')
}

function rsmSelector(query: ElementLike): string {
  const set = elements(query).find(
    (element) => element.name === 'set' && str(element.attrs?.xmlns) === NS_RSM,
  )
  const value = (name: string): string | null => {
    const element = set && elements(set).find((child) => child.name === name)
    return element ? text(element) : null
  }
  return JSON.stringify({
    max: value('max'),
    after: value('after'),
    before: value('before'),
    index: value('index'),
  })
}

/**
 * The payload namespace and the node it addresses.
 *
 * The node lives one level down for PubSub — `<pubsub><items node="…"/></pubsub>` —
 * and on the payload itself for disco. Both are read, because for an avatar fetch
 * the node IS the identity: metadata and data are two different queries to the same
 * JID.
 */
function payload(stanza: ElementLike): { ns: string; node: string; selector: string } {
  for (const child of elements(stanza)) {
    const ns = str(child.attrs?.xmlns)
    if (!ns) continue
    const rsm = ns === NS_DISCO_ITEMS ? rsmSelector(child) : ''
    const own = str(child.attrs?.node)
    if (own) return { ns, node: own, selector: rsm }
    for (const grandchild of elements(child)) {
      const node = str(grandchild.attrs?.node)
      if (node) {
        const itemIds = elements(grandchild)
          .filter((element) => element.name === 'item')
          .map((element) => str(element.attrs?.id))
          .filter(Boolean)
          .sort()
        const selector = JSON.stringify({
          itemIds,
          maxItems: str(grandchild.attrs?.max_items),
          subid: str(grandchild.attrs?.subid),
        })
        return { ns, node, selector }
      }
    }
    return { ns, node: '', selector: rsm }
  }
  return { ns: '', node: '', selector: '' }
}

function classify(ns: string, node: string): QueryKind {
  switch (ns) {
    case NS_DISCO_INFO:
      return 'disco-info'
    case NS_DISCO_ITEMS:
      return 'disco-items'
    case NS_VCARD:
      return 'vcard'
    case NS_MAM:
      return 'mam'
    case NS_ROSTER:
      return 'roster'
    case NS_PUBSUB:
      return AVATAR_NODES.has(node) ? 'avatar' : 'other'
    default:
      return 'other'
  }
}

/**
 * Which kinds are judged for redundancy.
 *
 * A MAM query pages through one archive with a different window each time, and a
 * roster or generic IQ has no stable identity a repeat could be measured against.
 * Giving either a dedupe key would report ordinary traffic as an anomaly — the one
 * outcome that costs this log its credibility.
 */
const DEDUPABLE: ReadonlySet<QueryKind> = new Set<QueryKind>([
  'disco-info',
  'disco-items',
  'vcard',
  'avatar',
])

export function outboundFacts(stanza: ElementLike): OutFacts | null {
  if (stanza.name !== 'iq') return null
  const type = str(stanza.attrs.type)
  if (type !== 'get' && type !== 'set') return null
  const id = str(stanza.attrs.id)
  if (!id) return null

  const { ns, node, selector } = payload(stanza)
  const kind = classify(ns, node)
  const to = str(stanza.attrs.to)
  return {
    id,
    kind,
    to,
    dedupe: type === 'get' && DEDUPABLE.has(kind)
      ? `${kind}|${to}|${node}${kind === 'avatar' || kind === 'disco-items' ? `|${selector}` : ''}`
      : null,
  }
}

export function inboundReplyFacts(stanza: ElementLike): InFacts | null {
  if (stanza.name !== 'iq') return null
  const type = str(stanza.attrs.type)
  if (type !== 'result' && type !== 'error') return null
  const id = str(stanza.attrs.id)
  if (!id) return null
  return { id, type }
}
