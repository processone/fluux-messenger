import { xml } from '@xmpp/client'
import type { Element } from '@xmpp/client'
import { NS_SAVED_MESSAGES, NS_PUBSUB, NS_DATA_FORMS } from '../namespaces'
import { getBareJid } from '../jid'
import { generateUUID } from '../../utils/uuid'
import { dataToElement, elementToData } from '../e2ee/stanzaAdapter'
import type { ModuleDependencies } from './BaseModule'
import { PepNode, type PepCodec, type PepFetch, type PublishOptions } from './PepNode'
import { forwardedCopyElement, parseSavedForwardedCopy } from './messagingUtils'
import type { SavedMessage } from '../types/saved'
import { savedMessageKey, savedItemId, sameSavedMessage } from '../../utils/savedMessageKeys'

/**
 * Private, retained, one item per saved message. The node asks for a concrete
 * `max_items` so that its limit can be read back as a number (a node set to
 * `max` says nothing of it); a service with a lower ceiling refuses or lowers
 * the value, and the client reads what it actually holds. It refuses a save at
 * that limit, because servers drop the oldest item without an error.
 */
export const SAVED_NODE_MAX_ITEMS = 256

/** What every write carries: the privacy constraints, which any existing node already meets. */
const SAVED_NODE_OPTIONS: PublishOptions = {
  persistItems: true,
  accessModel: 'whitelist',
  sendLastPublishedItem: 'never',
}

/** Only a write that creates the node asks for the limit; a node that exists keeps the limit it was given. */
const SAVED_NODE_CREATE_OPTIONS: PublishOptions = { ...SAVED_NODE_OPTIONS, maxItems: SAVED_NODE_MAX_ITEMS }

const NS_FORWARD_URI = 'urn:xmpp:forward:0'

export { savedMessageKey, savedItemId, sameSavedMessage }

function buildCodec(getOwnBareJid: () => string | null): PepCodec<SavedMessage> {
  return {
    encode: (entry) => {
      // The conversation is read back from from/to: a room's address is the sender's
      // room JID; in a chat the other party is whichever address is not ours.
      const copy = forwardedCopyElement(
        { from: entry.from, text: entry.encrypted ? '' : entry.text, timestamp: entry.sentAt, type: entry.type },
        {
          to: entry.to,
          id: entry.messageId, stanzaId: entry.stanzaId, stanzaIdBy: entry.stanzaIdBy,
          originId: entry.originId, occupantId: entry.occupantId,
        },
      )
      return xml('saved', {
        xmlns: NS_SAVED_MESSAGES,
        stamp: new Date(entry.savedAt).toISOString(),
        ...(entry.encrypted && { encrypted: 'true' }),
        ...(entry.deleted && { deleted: 'true' }),
      }, copy, ...(entry.extras ?? []).map(dataToElement))
    },
    decode: (item) => {
      const itemId = item.attrs.id
      const saved = item.getChild('saved', NS_SAVED_MESSAGES)
      const forwarded = saved?.getChildren('forwarded').find((el: Element) => el.attrs?.xmlns === NS_FORWARD_URI)
      if (!itemId || !saved || !forwarded) return undefined
      const copy = parseSavedForwardedCopy(forwarded)
      if (!copy) return undefined
      const savedAt = new Date(saved.attrs.stamp ?? '').getTime()
      const type = copy.type ?? 'groupchat'
      const ownBare = getOwnBareJid()
      const fromBare = getBareJid(copy.from)
      const conversationJid = type === 'groupchat'
        ? fromBare
        : (ownBare && fromBare === ownBare ? getBareJid(copy.to ?? '') : fromBare)
      if (!conversationJid) return undefined
      const extras = saved.children
        .filter((child): child is Element => typeof child !== 'string' && child.name !== 'forwarded')
        .map((child) => elementToData(child))
      return {
        id: itemId, conversationJid, type, from: copy.from, text: copy.text,
        savedAt: Number.isFinite(savedAt) ? savedAt : 0,
        ...(copy.to && { to: copy.to }),
        ...(saved.attrs.encrypted === 'true' && { encrypted: true as const }),
        ...(saved.attrs.deleted === 'true' && { deleted: true as const }),
        ...(copy.timestamp !== undefined && { sentAt: copy.timestamp }),
        ...(copy.id && { messageId: copy.id }),
        ...(copy.stanzaId && copy.stanzaIdBy && { stanzaId: copy.stanzaId, stanzaIdBy: copy.stanzaIdBy }),
        ...(copy.originId && { originId: copy.originId }),
        ...(copy.occupantId && { occupantId: copy.occupantId }),
        ...(extras.length > 0 && { extras }),
      }
    },
  }
}

/** What a notification (or fetch) said: the entries it carried and the item ids it retracted. */
export interface SavedItemsUpdate {
  upserts: SavedMessage[]
  removedIds: string[]
}

/**
 * Parse the `<items/>` of a saved-messages node or notification. Exported so
 * PubSub reads incoming `+notify` events with the same codec as a fetch.
 */
export function parseSavedItems(itemsEl: Element, ownBareJid: string | null): SavedItemsUpdate {
  const codec = buildCodec(() => ownBareJid)
  const upserts = itemsEl.getChildren('item').flatMap((item) => {
    const entry = codec.decode(item)
    return entry ? [entry] : []
  })
  const removedIds = itemsEl.getChildren('retract').flatMap((r) => (r.attrs.id ? [r.attrs.id as string] : []))
  return { upserts, removedIds }
}

/**
 * Fluux saved messages: private PEP node `urn:xmpp:fluux:saved-messages:0`,
 * one item per saved message holding a XEP-0297 forwarded copy.
 * See docs/XEP-SAVED_MESSAGES.md. Request/response only; incoming `+notify`
 * events are handled in PubSub and the sync lives in savedMessagesSideEffects.
 */
export class SavedMessages {
  private readonly deps: ModuleDependencies
  private readonly node: PepNode<SavedMessage>
  private readonly createNode: PepNode<SavedMessage>

  constructor(deps: ModuleDependencies) {
    this.deps = deps
    const codec = buildCodec(() => this.ownBare())
    this.node = new PepNode(deps, NS_SAVED_MESSAGES, codec, SAVED_NODE_OPTIONS)
    this.createNode = new PepNode(deps, NS_SAVED_MESSAGES, codec, SAVED_NODE_CREATE_OPTIONS)
  }

  private ownBare(): string | null {
    const jid = this.deps.getCurrentJid()
    return jid ? getBareJid(jid) : null
  }

  /** Read every saved message. `absent` and `ok` are answers; `refused` and `unavailable` are not. */
  fetchAll(timeoutMs?: number): Promise<PepFetch<SavedMessage>> {
    return this.node.get({ timeoutMs })
  }

  /**
   * `create` is set when the node may not exist yet: the write then asks for the concrete limit. The caller decides
   * whether a refusal is worth repeating without it, so that the repeat stays under its own account and session guard.
   */
  async publish(entry: SavedMessage, options: { create?: boolean } = {}): Promise<void> {
    await (options.create ? this.createNode : this.node).publish(entry.id, entry)
  }

  async retract(itemId: string): Promise<void> {
    // Other devices learn of a removal only if the server is asked to notify them.
    await this.node.retract(itemId, { notify: true })
  }

  /**
   * The node's effective `pubsub#max_items` from its owner configuration, or
   * `undefined` when it cannot be read (no node yet, or the server hides it).
   */
  async fetchMaxItems(): Promise<number | undefined> {
    if (!this.deps.getCurrentJid()) return undefined
    try {
      const result = await this.deps.sendIQ(
        xml('iq', { type: 'get', id: `saved_cfg_${generateUUID()}` },
          xml('pubsub', { xmlns: `${NS_PUBSUB}#owner` }, xml('configure', { node: NS_SAVED_MESSAGES })),
        ),
      )
      const form = result.getChild('pubsub', `${NS_PUBSUB}#owner`)?.getChild('configure')?.getChild('x', NS_DATA_FORMS)
      const field = form?.getChildren('field').find((f: Element) => f.attrs.var === 'pubsub#max_items')
      const raw = field?.getChildText('value') ?? ''
      // `max` says nothing of a number: the limit stays unknown, and so does what a save could push out.
      const value = Number.parseInt(raw, 10)
      return Number.isFinite(value) && value > 0 ? value : undefined
    } catch {
      return undefined
    }
  }
}
