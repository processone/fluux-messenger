/**
 * A single typed PEP node (XEP-0163 / XEP-0223 private storage).
 *
 * Every feature that keeps account state on a PEP node needs the same four
 * things: build the `<iq>`, carry the right `publish-options`, tell "the node
 * does not exist" apart from "we could not reach it", and map `<item>` payloads
 * to and from a domain type. Declaring the node once with its codec keeps that
 * in one place instead of once per feature.
 *
 * @category Modules
 */
import { xml } from '@xmpp/client'
import type { Element } from '@xmpp/client'
import { getBareJid } from '../jid'
import { generateUUID } from '../../utils/uuid'
import { NS_PUBSUB } from '../namespaces'
import { hasErrorCondition } from '../../utils/xmppError'
import type { ModuleDependencies } from './BaseModule'

/**
 * Node configuration sent as XEP-0060 `publish-options`. The server either
 * honours them or rejects the publish with `<conflict/>` when the node already
 * exists with an incompatible configuration.
 */
export interface PublishOptions {
  /** `pubsub#persist_items` — whether the node retains items between sessions. */
  persistItems?: boolean
  /** `pubsub#access_model` — who may read the node. */
  accessModel?: 'open' | 'whitelist' | 'presence' | 'roster' | 'authorize'
  /**
   * `pubsub#max_items` — maximum retained items. `1` gives current-value
   * semantics; `'max'` asks the server for its ceiling, which is what a
   * one-item-per-entity node (XEP-0490) needs.
   */
  maxItems?: number | 'max'
  /** `pubsub#send_last_published_item` — when to replay to new subscribers. */
  sendLastPublishedItem?: 'never' | 'on_sub' | 'on_sub_and_presence'
}

/**
 * Translates between a domain value and the payload inside `<item>`.
 *
 * `TWrite` defaults to `T` but is separate because the two directions can
 * legitimately differ: XEP-0490 publishes a marker with the archive JID that
 * assigned the stanza-id, and that attribute is not part of what a reader gets
 * back.
 */
export interface PepCodec<T, TWrite = T> {
  /** Build the single child element that goes inside `<item>`. */
  encode(value: TWrite): Element
  /**
   * Read one `<item>`. Receives the item element itself, not just its payload,
   * so a codec can use `item.attrs.id` (XEP-0490 keys markers by conversation
   * JID that way). Return `undefined` to skip an item that does not parse.
   */
  decode(item: Element): T | undefined
}

/**
 * Outcome of a read. Four cases, split by what the caller can DO about each.
 *
 * - `ok` — the server answered with items.
 * - `absent` — the server answered that nothing is published. A FACT: a fresh
 *   account seeds its first value on this, and XEP-0490's read-position
 *   seeding depends on telling it apart from silence.
 * - `refused` — the server answered that we may not read this node at all.
 *   Also a fact, and a durable one: a deployment that forbids PEP avatars
 *   forbids them for every contact on that domain, so a caller can remember it
 *   and stop asking.
 * - `unavailable` — no answer. Timeout, transport, anything transient. Nothing
 *   was learned, so nothing should be remembered.
 *
 * `refused` and `unavailable` were one case until the avatar paths needed them
 * apart, for the same reason `absent` had to be split out: collapsing an answer
 * into a non-answer loses the only thing that made it actionable.
 */
export type PepFetch<T> =
  | { status: 'ok'; items: T[] }
  | { status: 'absent' }
  | { status: 'refused'; condition: string }
  | { status: 'unavailable' }

/**
 * Conditions that mean "this node is not available to you", as opposed to a
 * transport failure. A server that answers either for one contact's avatar node
 * answers the same for every contact it hosts.
 */
const REFUSAL_CONDITIONS = ['forbidden', 'service-unavailable'] as const

/** Read options. Defaults to every item on our own node. */
export interface PepGetOptions {
  /** Fetch one item by id instead of the whole node. */
  itemId?: string
  /** Cap on returned items, newest first. */
  maxItems?: number
  /** Whose node to read. Defaults to our own bare JID. */
  jid?: string
  timeoutMs?: number
}

export class PepNode<T, TWrite = T> {
  constructor(
    private readonly deps: ModuleDependencies,
    /** The node name, which is also its payload namespace for our own nodes. */
    readonly node: string,
    private readonly codec: PepCodec<T, TWrite>,
    /** Applied to every publish, so a node cannot be created two ways. */
    private readonly publishOptions?: PublishOptions,
  ) {}

  /**
   * Read the node. Never throws: a rejection is classified rather than
   * propagated, because every caller has to make that distinction anyway.
   */
  async get(options: PepGetOptions = {}): Promise<PepFetch<T>> {
    const target = options.jid ?? this.ownBareJid()
    if (!target) return { status: 'unavailable' }

    const attrs: Record<string, string> = { node: this.node }
    if (options.maxItems !== undefined) attrs.max_items = String(options.maxItems)
    const itemsEl = options.itemId !== undefined
      ? xml('items', attrs, xml('item', { id: options.itemId }))
      : xml('items', attrs)

    const iq = xml('iq', { type: 'get', to: target, id: `pep_get_${generateUUID()}` },
      xml('pubsub', { xmlns: NS_PUBSUB }, itemsEl),
    )

    let result: Element
    try {
      result = await this.deps.sendIQ(iq, options.timeoutMs)
    } catch (error) {
      // Every branch here asks the same question: did the server ANSWER? An
      // answer is actionable however unwelcome; silence is not.
      if (hasErrorCondition(error, 'item-not-found')) return { status: 'absent' }
      const refusal = REFUSAL_CONDITIONS.find((c) => hasErrorCondition(error, c))
      if (refusal) return { status: 'refused', condition: refusal }
      return { status: 'unavailable' }
    }

    const items = result.getChild('pubsub', NS_PUBSUB)?.getChild('items')
    // A result with no `<items/>` is malformed rather than empty: the server
    // answered, but not the question we asked.
    if (!items) return { status: 'unavailable' }
    return { status: 'ok', items: items.getChildren('item').flatMap((item) => {
      const decoded = this.codec.decode(item)
      return decoded === undefined ? [] : [decoded]
    }) }
  }

  /** Every item, or `fallback` when the node is absent or unreachable. */
  async getOr(fallback: T[], options: PepGetOptions = {}): Promise<T[]> {
    const result = await this.get(options)
    return result.status === 'ok' ? result.items : fallback
  }

  /** Publish one item, creating the node with {@link publishOptions} if needed. */
  async publish(itemId: string, value: TWrite): Promise<void> {
    this.requireSession()
    const children: Element[] = [
      xml('publish', { node: this.node },
        xml('item', { id: itemId }, this.codec.encode(value)),
      ),
    ]
    const options = buildPublishOptions(this.publishOptions)
    if (options) children.push(options)

    await this.deps.sendIQ(
      xml('iq', { type: 'set', id: `pep_pub_${generateUUID()}` },
        xml('pubsub', { xmlns: NS_PUBSUB }, ...children),
      ),
    )
  }

  /** Remove one item. Rejects if the server refuses; callers decide whether that matters. */
  async retract(itemId: string): Promise<void> {
    this.requireSession()
    await this.deps.sendIQ(
      xml('iq', { type: 'set', id: `pep_ret_${generateUUID()}` },
        xml('pubsub', { xmlns: NS_PUBSUB },
          xml('retract', { node: this.node }, xml('item', { id: itemId })),
        ),
      ),
    )
  }

  private ownBareJid(): string | null {
    const jid = this.deps.getCurrentJid()
    return jid ? getBareJid(jid) : null
  }

  private requireSession(): void {
    if (!this.deps.getCurrentJid()) throw new Error('Not connected')
  }
}

/**
 * Serialise `publish-options` as a XEP-0004 submit form.
 *
 * Booleans go out as `true`/`false` rather than `1`/`0`: both are valid
 * `xs:boolean`, and this is the form XEP-0223's own examples use.
 */
export function buildPublishOptions(options?: PublishOptions): Element | null {
  if (!options) return null
  const fields: Element[] = []
  if (options.persistItems !== undefined) {
    fields.push(formField('pubsub#persist_items', options.persistItems ? 'true' : 'false'))
  }
  if (options.accessModel !== undefined) {
    fields.push(formField('pubsub#access_model', options.accessModel))
  }
  if (options.maxItems !== undefined) {
    fields.push(formField('pubsub#max_items', String(options.maxItems)))
  }
  if (options.sendLastPublishedItem !== undefined) {
    fields.push(formField('pubsub#send_last_published_item', options.sendLastPublishedItem))
  }
  if (fields.length === 0) return null
  return xml('publish-options', {},
    xml('x', { xmlns: 'jabber:x:data', type: 'submit' },
      xml('field', { var: 'FORM_TYPE', type: 'hidden' },
        xml('value', {}, 'http://jabber.org/protocol/pubsub#publish-options'),
      ),
      ...fields,
    ),
  )
}

function formField(varName: string, value: string): Element {
  return xml('field', { var: varName }, xml('value', {}, value))
}
