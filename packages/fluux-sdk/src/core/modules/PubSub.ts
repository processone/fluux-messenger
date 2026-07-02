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
 * - XEP-0402: PEP Native Bookmarks (live multi-device room-bookmark sync)
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
import { NS_PUBSUB, NS_NICK, NS_OPENPGP_PUBLIC_KEYS, NS_BOOKMARKS, NS_MDS, NS_CONVERSATIONS } from '../namespaces'
import { parseMdsItems } from './Mds'
import { parseConversationsItem } from './ConversationSync'
import { generateUUID } from '../../utils/uuid'
import { dataToElement, elementToData } from '../e2ee/stanzaAdapter'
import type { PEPItem, Subscription, XMLElementData } from '../e2ee'
import { parseBookmarkItem } from '../bookmarkItem'

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
    const bareFrom = getBareJid(from)

    // XEP-0060 §12.4 sibling-level notifications: `<purge>` wipes every
    // item on a node (node kept), `<delete>` removes the node entirely.
    // For OX specifically either event means "the peer no longer
    // advertises keys here" — semantically identical to a retract for
    // our cache-invalidation purposes. Handle these before the `items`
    // early-return below because they arrive *without* an `<items>`
    // child. Keeping this OX-specific: generic subscribers don't have a
    // useful payload to deliver for bulk removal, so there's nothing to
    // dispatch to them.
    const removalNode =
      event.getChild('purge')?.attrs.node ??
      event.getChild('delete')?.attrs.node
    if (removalNode === NS_OPENPGP_PUBLIC_KEYS) {
      this.invalidateOpenPgpKeys(bareFrom)
      return
    }

    const items = event.getChild('items')
    if (!items) return

    const node = items.attrs.node

    // XEP-0084: User Avatar (Metadata)
    if (node === 'urn:xmpp:avatar:metadata') {
      this.handleAvatarMetadata(bareFrom, items)
    }

    // XEP-0172: User Nickname
    if (node === NS_NICK) {
      this.handleNicknameUpdate(bareFrom, items)
    }

    // XEP-0373: OpenPGP public-keys metadata.
    // A headline here means the peer rotated, published, or retracted a
    // single key item (`<items>` may contain either `<item>` or
    // `<retract>` children per XEP-0060 §12.4). Evict any cached
    // "supported" or "not-supported" probe result for this peer so the
    // next send re-fetches and the new key is actually used. Plugin-
    // local key caches are cleared via the same hook so a rotated
    // fingerprint doesn't get masked by a stale positive entry either.
    if (node === NS_OPENPGP_PUBLIC_KEYS) {
      this.invalidateOpenPgpKeys(bareFrom)
    }

    // XEP-0402: PEP Native Bookmarks. A headline here means another of our own
    // clients added/changed/removed a room bookmark — keep the room list in
    // sync live instead of only on the next reconnect's fetchBookmarks.
    if (node === NS_BOOKMARKS) {
      this.handleBookmarksUpdate(bareFrom, items)
    }

    // XEP-0490: Message Displayed Synchronization. A push here means another
    // of our own clients updated its last-displayed position for a 1:1
    // conversation — sync the read position across devices.
    if (node === NS_MDS) {
      this.handleMdsUpdate(bareFrom, items)
    }

    // Fluux private conversation list. A headline here means another of our
    // own clients archived/unarchived (or added) a 1:1 conversation — keep
    // the list in sync live instead of only on the next reconnect's fetch.
    if (node === NS_CONVERSATIONS) {
      this.handleConversationsUpdate(bareFrom, items)
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
   * Delete one of our own PEP nodes entirely (XEP-0060 §8.2).
   *
   * Unlike {@link retract}, which removes a single item while leaving the
   * node (and its configuration) intact, this tears the node down so a
   * subsequent {@link publish} recreates it with whatever `publish-options`
   * the publisher wants. That's what lets us self-heal a node whose
   * persisted access model no longer matches the current policy (e.g. an
   * old `accessModel='presence'` OpenPGP public-key node that now needs
   * to be `'open'`): the server refuses to reconfigure on publish with
   * `precondition-not-met`, but we can delete + recreate.
   */
  async deleteNode(node: string): Promise<void> {
    const iq = xml('iq', { type: 'set', id: `pubsub_del_${generateUUID()}` },
      xml('pubsub', { xmlns: `${NS_PUBSUB}#owner` },
        xml('delete', { node }),
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
  /**
   * XEP-0373 OpenPGP public-keys PEP change handler.
   *
   * Routed through the E2EE manager so we drop the shared capability
   * cache entry *and* the plugin's own positive key cache in one call.
   * If the manager itself isn't built yet (a real race during the
   * initial PEP burst on stream open) we log so the drop is visible —
   * the plugin-level queue inside E2EEManager catches the more common
   * "manager up, plugin not yet registered" case automatically. When
   * `getE2EEManager` itself is not wired (E2EE disabled in this build)
   * the call is silently skipped — there's nothing to recover.
   */
  private invalidateOpenPgpKeys(bareFrom: string): void {
    const accessor = this.deps.getE2EEManager
    if (!accessor) return
    const manager = accessor()
    if (!manager) {
      console.warn(
        `[PubSub] OpenPGP key-change from ${bareFrom} dropped: E2EE manager not built yet`,
      )
      return
    }
    manager.notifyPeerKeysChanged(bareFrom, 'openpgp')
  }

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

  /**
   * Handle an XEP-0402 PEP bookmark notification (live multi-device sync).
   *
   * Only our OWN account publishes to our bookmarks node, so we ignore events
   * whose `from` is not our bare JID — this prevents a contact from injecting
   * rooms into our list. `<item>` children add/update a bookmark (the store's
   * setBookmark creates the room if we don't have it yet); `<retract>` removes
   * one.
   */
  private handleBookmarksUpdate(bareFrom: string, items: Element): void {
    const ownBareJid = getBareJid(this.deps.getCurrentJid() ?? '')
    if (!ownBareJid || bareFrom !== ownBareJid) return

    for (const item of items.getChildren('item')) {
      const parsed = parseBookmarkItem(item)
      if (!parsed) continue
      this.deps.emitSDK('room:bookmark', {
        roomJid: parsed.jid,
        bookmark: {
          name: parsed.name,
          nick: parsed.nick || 'user',
          autojoin: parsed.autojoin,
          password: parsed.password,
          notifyAll: parsed.notifyAll,
        },
      })
    }

    for (const retract of items.getChildren('retract')) {
      const roomJid = retract.attrs.id
      if (roomJid) {
        this.deps.emitSDK('room:bookmark-removed', { roomJid })
      }
    }
  }

  /**
   * XEP-0490: apply an incoming displayed-marker notification from our own
   * MDS node. Other entities' MDS nodes are ignored (own-account PEP only).
   */
  private handleMdsUpdate(bareFrom: string, items: Element): void {
    const ownBareJid = getBareJid(this.deps.getCurrentJid() ?? '')
    if (!ownBareJid || bareFrom !== ownBareJid) return

    for (const { conversationJid, stanzaId } of parseMdsItems(items)) {
      this.deps.emitSDK('read:displayed-synced', {
        conversationId: conversationJid,
        stanzaId,
      })
    }
  }

  /**
   * Fluux private PEP: apply an incoming conversation-list notification from
   * our own node. Other entities' nodes are ignored (own-account PEP only).
   * The list is published as a single item (id="current") holding the full
   * set, so we emit the whole parsed list for the consumer to reconcile.
   */
  private handleConversationsUpdate(bareFrom: string, items: Element): void {
    const ownBareJid = getBareJid(this.deps.getCurrentJid() ?? '')
    if (!ownBareJid || bareFrom !== ownBareJid) return

    const item = items.getChild('item')
    if (!item) return

    this.deps.emitSDK('conversation:list-synced', {
      conversations: parseConversationsItem(item),
    })
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
