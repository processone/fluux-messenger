/**
 * PubSub Module (XEP-0060 + XEP-0163 PEP)
 *
 * Handles incoming PubSub events from message stanzas and exposes general-
 * purpose publish / query / subscribe helpers for features built on PEP,
 * including E2EE plugins (XEP-0373 OpenPGP key publication, XEP-0384 OMEMO
 * bundles, etc.).
 *
 * Native PEP nodes handled in-place:
 * - XEP-0084: User Avatar (avatar metadata notifications)
 * - XEP-0172: User Nickname
 *
 * Additional nodes (crypto, MLS KeyPackages, etc.) are served through the
 * generic {@link PubSub.subscribe} mechanism — callers register a callback
 * for `(jid, node)` and receive parsed items as they arrive.
 *
 * @category Modules
 */
import { xml } from '@xmpp/client'
import type { Element } from '@xmpp/client'
import { BaseModule } from './BaseModule'
import { getBareJid } from '../jid'
import { NS_PUBSUB, NS_NICK } from '../namespaces'
import { generateUUID } from '../../utils/uuid'
import { dataToElement, elementToData } from '../e2ee/stanzaAdapter'
import type { PEPItem, Subscription, XMLElementData } from '../e2ee'

/**
 * Options accepted by {@link PubSub.publish}. These map to XEP-0060
 * publish-options form fields.
 */
export interface PublishOptions {
  /** `pubsub#persist_items` — whether the node retains items between sessions. */
  persistItems?: boolean
  /** `pubsub#access_model` — who may read the node. */
  accessModel?: 'open' | 'whitelist' | 'presence' | 'roster' | 'authorize'
  /** `pubsub#max_items` — maximum retained items. Use `1` for current-value nodes. */
  maxItems?: number
  /** `pubsub#send_last_published_item` — when to replay to new subscribers. */
  sendLastPublishedItem?: 'never' | 'on_sub' | 'on_sub_and_presence'
}

const NS_PUBSUB_EVENT = `${NS_PUBSUB}#event`

/**
 * PubSub module for XEP-0060 PubSub and XEP-0163 PEP.
 *
 * Processes incoming PubSub event messages, dispatches to native handlers
 * (avatar/nickname), and invokes any callbacks registered via
 * {@link PubSub.subscribe}. Publishers can send items to their own PEP
 * nodes via {@link PubSub.publish}; readers fetch remote nodes via
 * {@link PubSub.query}.
 *
 * @category Modules
 */
export class PubSub extends BaseModule {
  /** `(jid \u0000 node)` → set of user-registered callbacks. */
  private readonly subscriptions = new Map<string, Set<(item: PEPItem) => void>>()

  /**
   * Handle incoming stanzas - specifically message stanzas containing PubSub events.
   */
  handle(stanza: Element): boolean | void {
    if (stanza.is('message')) {
      const pubsubEvent = stanza.getChild('event', NS_PUBSUB_EVENT)
      if (pubsubEvent) {
        const from = stanza.attrs.from
        if (from) {
          this.handlePubSubEvent(from, pubsubEvent)
        }
        return true
      }
    }
    return false
  }

  /**
   * Handle a PubSub event element.
   *
   * This method can be called directly for synthetic events (e.g., from
   * vcard-temp:x:update presence which is translated to a PubSub-like event
   * for consistent avatar handling).
   *
   * @param from - The JID the event is from
   * @param event - The PubSub event element
   */
  handlePubSubEvent(from: string, event: Element): void {
    const items = event.getChild('items')
    if (!items) return

    const node = items.attrs.node
    const bareFrom = getBareJid(from)

    // XEP-0084: User Avatar (Metadata)
    if (node === 'urn:xmpp:avatar:metadata') {
      this.handleAvatarMetadata(bareFrom, items)
    }

    // XEP-0172: User Nickname
    if (node === NS_NICK) {
      this.handleNicknameUpdate(bareFrom, items)
    }

    // Dispatch to any user-registered subscribers for (bareFrom, node).
    // Fired after native handlers so subscribers see the same stream even
    // when a node is also natively handled.
    if (node) {
      this.dispatchToSubscribers(bareFrom, node, items)
    }
  }

  /**
   * Publish an item to one of our own PEP nodes (XEP-0163).
   *
   * The item payload is the child element that goes inside `<item>`. Pass
   * any optional `publish-options` for node configuration; the server will
   * either honor them or reject with `<conflict>` if the node exists with
   * incompatible config.
   */
  async publish(node: string, item: PEPItem, options?: PublishOptions): Promise<void> {
    const pubsubChildren: Array<ReturnType<typeof xml>> = [
      xml('publish', { node },
        xml('item', { id: item.id }, dataToElement(item.payload)),
      ),
    ]
    const publishOptions = buildPublishOptions(options)
    if (publishOptions) pubsubChildren.push(publishOptions)

    const iq = xml('iq', { type: 'set', id: `pubsub_pub_${generateUUID()}` },
      xml('pubsub', { xmlns: NS_PUBSUB }, ...pubsubChildren),
    )
    await this.deps.sendIQ(iq)
  }

  /**
   * Retract a previously published item from one of our own PEP nodes.
   * Silently tolerated by the server if the item is already absent.
   */
  async retract(node: string, itemId: string): Promise<void> {
    const iq = xml('iq', { type: 'set', id: `pubsub_ret_${generateUUID()}` },
      xml('pubsub', { xmlns: NS_PUBSUB },
        xml('retract', { node },
          xml('item', { id: itemId }),
        ),
      ),
    )
    await this.deps.sendIQ(iq)
  }

  /**
   * Fetch items from a remote PEP node. If `maxItems` is provided, the
   * server is asked for at most that many of the most recent items;
   * otherwise the default retained set is returned.
   */
  async query(jid: string, node: string, maxItems?: number): Promise<PEPItem[]> {
    const itemsEl = maxItems !== undefined
      ? xml('items', { node, max_items: String(maxItems) })
      : xml('items', { node })
    const iq = xml('iq', { type: 'get', to: jid, id: `pubsub_q_${generateUUID()}` },
      xml('pubsub', { xmlns: NS_PUBSUB }, itemsEl),
    )
    const result = await this.deps.sendIQ(iq)
    const pubsub = result.getChild('pubsub', NS_PUBSUB)
    const items = pubsub?.getChild('items')
    if (!items) return []
    return parseItems(items)
  }

  /**
   * Subscribe to PEP notifications from `jid` for `node`.
   *
   * This does not send an explicit `<subscribe>` stanza — PEP notifications
   * are pushed automatically when the recipient advertises the `+notify`
   * feature via CAPS. The callback is invoked for every incoming event
   * that matches `(jid, node)`.
   *
   * Returns a subscription handle with `unsubscribe()` to remove the
   * callback. Callbacks are invoked synchronously on the stanza thread;
   * throw-safe (a throwing callback does not break other subscribers).
   */
  subscribe(jid: string, node: string, callback: (item: PEPItem) => void): Subscription {
    const key = subscriptionKey(jid, node)
    let set = this.subscriptions.get(key)
    if (!set) {
      set = new Set()
      this.subscriptions.set(key, set)
    }
    set.add(callback)
    return {
      unsubscribe: () => {
        const current = this.subscriptions.get(key)
        if (!current) return
        current.delete(callback)
        if (current.size === 0) this.subscriptions.delete(key)
      },
    }
  }

  /**
   * Handle XEP-0084 User Avatar metadata notification.
   * Triggers avatar data fetch when new avatar is published.
   */
  private handleAvatarMetadata(bareFrom: string, items: Element): void {
    const item = items.getChild('item')
    const metadata = item?.getChild('metadata', 'urn:xmpp:avatar:metadata')
    const info = metadata?.getChild('info')

    if (info) {
      const hash = info.attrs.id
      if (hash) {
        // Emit event for Profile module to fetch avatar data
        this.deps.emit('avatarMetadataUpdate', bareFrom, hash)
      }
    } else if (item && !metadata) {
      // Avatar removed - empty item means avatar was deleted
      this.deps.emit('avatarMetadataUpdate', bareFrom, null)
    }
  }

  /**
   * Handle XEP-0172 User Nickname update.
   * Updates the contact's name in the roster.
   */
  private handleNicknameUpdate(bareFrom: string, items: Element): void {
    const item = items.getChild('item')
    const nick = item?.getChild('nick', NS_NICK)?.text()

    if (nick) {
      // SDK event only - binding calls store.updateContact
      this.deps.emitSDK('roster:contact-updated', { jid: bareFrom, updates: { name: nick } })
    }
  }

  private dispatchToSubscribers(bareFrom: string, node: string, items: Element): void {
    const subs = this.subscriptions.get(subscriptionKey(bareFrom, node))
    if (!subs || subs.size === 0) return
    const parsed = parseItems(items)
    for (const item of parsed) {
      for (const cb of subs) {
        try {
          cb(item)
        } catch {
          // Subscriber callbacks are firewalled from each other and from the
          // stanza loop. Swallowing is intentional — logging via deps.emit
          // would risk cascading into the same callback pool.
        }
      }
    }
  }
}

function subscriptionKey(jid: string, node: string): string {
  return `${jid}\u0000${node}`
}

function parseItems(itemsEl: Element): PEPItem[] {
  return itemsEl.getChildren('item').flatMap((itemEl) => {
    const firstChild = itemEl.children.find((c): c is Element => typeof c !== 'string')
    if (!firstChild) return []
    const payload: XMLElementData = elementToData(firstChild)
    return [{
      id: itemEl.attrs.id ?? '',
      payload,
    }]
  })
}

function buildPublishOptions(options?: PublishOptions) {
  if (!options) return null
  const fields: Array<ReturnType<typeof xml>> = []
  if (options.persistItems !== undefined) {
    fields.push(formField('pubsub#persist_items', options.persistItems ? '1' : '0'))
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

function formField(varName: string, value: string) {
  return xml('field', { var: varName }, xml('value', {}, value))
}
