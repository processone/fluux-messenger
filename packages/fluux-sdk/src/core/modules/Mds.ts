import { xml } from '@xmpp/client'
import type { Element } from '@xmpp/client'
import { getBareJid } from '../jid'
import { generateUUID } from '../../utils/uuid'
import { NS_PUBSUB, NS_MDS, NS_CHAT_MARKERS } from '../namespaces'
import type { ModuleDependencies } from './BaseModule'

/** A per-conversation last-displayed marker (XEP-0490). */
export interface DisplayedMarker {
  /** Conversation bare JID (the PEP item id). */
  conversationJid: string
  /** XEP-0359 stanza-id of the last displayed message. */
  stanzaId: string
}

/**
 * Parse the `<items/>` of an MDS node into markers.
 * Items without a `<displayed/>` child carrying an id are skipped.
 * Exported so PubSub can reuse it for incoming `+notify` events.
 */
export function parseMdsItems(itemsEl: Element): DisplayedMarker[] {
  const markers: DisplayedMarker[] = []
  for (const item of itemsEl.getChildren('item')) {
    const conversationJid = item.attrs.id
    const stanzaId = item.getChild('displayed', NS_CHAT_MARKERS)?.attrs.id
    if (conversationJid && stanzaId) {
      markers.push({ conversationJid, stanzaId })
    }
  }
  return markers
}

/**
 * XEP-0490: Message Displayed Synchronization.
 *
 * Publishes/fetches the per-conversation last-displayed stanza-id to the private
 * PEP node `urn:xmpp:mds:displayed:0` (item id = conversation bare JID, payload =
 * an XEP-0333 `<displayed/>`). Request/response only — incoming `+notify` events
 * are handled in PubSub.
 */
export class Mds {
  private deps: ModuleDependencies

  constructor(deps: ModuleDependencies) {
    this.deps = deps
  }

  /**
   * Publish the last-displayed stanza-id for a 1:1 conversation.
   * The node is created on first publish with current-value semantics
   * (max_items=max so all conversations are retained; one item per JID).
   */
  async publishDisplayed(conversationJid: string, stanzaId: string): Promise<void> {
    if (!this.deps.getCurrentJid()) throw new Error('Not connected')

    const iq = xml('iq', { type: 'set', id: `mds_set_${generateUUID()}` },
      xml('pubsub', { xmlns: NS_PUBSUB },
        xml('publish', { node: NS_MDS },
          xml('item', { id: conversationJid },
            xml('displayed', { xmlns: NS_CHAT_MARKERS, id: stanzaId }),
          ),
        ),
        xml('publish-options', {},
          xml('x', { xmlns: 'jabber:x:data', type: 'submit' },
            xml('field', { var: 'FORM_TYPE', type: 'hidden' },
              xml('value', {}, 'http://jabber.org/protocol/pubsub#publish-options'),
            ),
            xml('field', { var: 'pubsub#persist_items' }, xml('value', {}, 'true')),
            xml('field', { var: 'pubsub#max_items' }, xml('value', {}, 'max')),
            xml('field', { var: 'pubsub#send_last_published_item' }, xml('value', {}, 'never')),
            xml('field', { var: 'pubsub#access_model' }, xml('value', {}, 'whitelist')),
          ),
        ),
      ),
    )

    await this.deps.sendIQ(iq)
  }

  /**
   * Best-effort retract of a conversation's displayed marker (e.g. on delete).
   * Tolerates an absent item or missing node — the goal is node hygiene, not
   * correctness, and a still-active conversation on another device will simply
   * republish its marker.
   */
  async retractDisplayed(conversationJid: string): Promise<void> {
    if (!this.deps.getCurrentJid()) return

    const iq = xml('iq', { type: 'set', id: `mds_retract_${generateUUID()}` },
      xml('pubsub', { xmlns: NS_PUBSUB },
        xml('retract', { node: NS_MDS },
          xml('item', { id: conversationJid }),
        ),
      ),
    )

    try {
      await this.deps.sendIQ(iq)
    } catch {
      // Best-effort: item may not exist, or the node may be absent.
    }
  }

  /**
   * Fetch all per-conversation displayed markers from our own MDS node.
   * Returns an empty array if the node does not exist yet.
   */
  async fetchAllDisplayed(timeoutMs?: number): Promise<DisplayedMarker[]> {
    const currentJid = this.deps.getCurrentJid()
    if (!currentJid) return []

    const bareJid = getBareJid(currentJid)
    const iq = xml('iq', { type: 'get', to: bareJid, id: `mds_get_${generateUUID()}` },
      xml('pubsub', { xmlns: NS_PUBSUB },
        xml('items', { node: NS_MDS }),
      ),
    )

    try {
      const result = await this.deps.sendIQ(iq, timeoutMs)
      const items = result.getChild('pubsub', NS_PUBSUB)?.getChild('items')
      if (!items) return []
      return parseMdsItems(items)
    } catch {
      return []
    }
  }
}
