import { xml } from '@xmpp/client'
import type { Element } from '@xmpp/client'
import { NS_MDS, NS_CHAT_MARKERS, NS_STANZA_ID } from '../namespaces'
import type { ModuleDependencies } from './BaseModule'
import { PepNode, type PepCodec, type PublishOptions } from './PepNode'

/** A per-conversation last-displayed marker (XEP-0490). */
export interface DisplayedMarker {
  /** Conversation bare JID (the PEP item id). */
  conversationJid: string
  /** XEP-0359 stanza-id of the last displayed message. */
  stanzaId: string
  /**
   * True when the item was published in the pre-0.18 Fluux payload (a bare
   * XEP-0333 `<displayed/>` instead of the XEP-0490 wrapper). Other clients
   * cannot read that shape — the consumer should republish it in spec format.
   */
  legacy?: boolean
}

export type DisplayedMarkerFetchResult =
  | { status: 'authoritative'; markers: DisplayedMarker[] }
  | { status: 'unknown' }

/**
 * Parse the `<items/>` of an MDS node into markers.
 * Accepts the XEP-0490 payload (`<displayed xmlns='urn:xmpp:mds:displayed:0'>`
 * wrapping a XEP-0359 `<stanza-id/>`) and, as a migration fallback, the
 * pre-0.18 Fluux payload (a bare XEP-0333 `<displayed id=…/>`), flagged
 * `legacy`. Items with neither shape are skipped.
 * Exported so PubSub can reuse it for incoming `+notify` events.
 */
export function parseMdsItems(itemsEl: Element): DisplayedMarker[] {
  return itemsEl.getChildren('item').flatMap((item) => {
    const marker = mdsCodec.decode(item)
    return marker ? [marker] : []
  })
}

/**
 * `max_items='max'` retains one item per conversation rather than a single
 * current value; `send_last_published_item='never'` keeps our own markers from
 * being replayed to us on every reconnect.
 */
const MDS_NODE_OPTIONS: PublishOptions = {
  persistItems: true,
  maxItems: 'max',
  sendLastPublishedItem: 'never',
  accessModel: 'whitelist',
}

/** What a publish carries: the marker plus the archive that issued the id. */
interface DisplayedMarkerWrite {
  stanzaId: string
  /** XEP-0359 `by`: our own bare JID for 1:1, the room JID for MUC. */
  stanzaIdBy: string
}

const mdsCodec: PepCodec<DisplayedMarker, DisplayedMarkerWrite> = {
  encode: ({ stanzaId, stanzaIdBy }) => xml('displayed', { xmlns: NS_MDS },
    xml('stanza-id', { xmlns: NS_STANZA_ID, id: stanzaId, by: stanzaIdBy }),
  ),
  decode: (item) => {
    const conversationJid = item.attrs.id
    if (!conversationJid) return undefined
    const stanzaId = item.getChild('displayed', NS_MDS)?.getChild('stanza-id', NS_STANZA_ID)?.attrs.id
    if (stanzaId) return { conversationJid, stanzaId }
    const legacyStanzaId = item.getChild('displayed', NS_CHAT_MARKERS)?.attrs.id
    return legacyStanzaId
      ? { conversationJid, stanzaId: legacyStanzaId, legacy: true }
      : undefined
  },
}

/**
 * XEP-0490: Message Displayed Synchronization.
 *
 * Publishes/fetches the per-conversation last-displayed stanza-id to the private
 * PEP node `urn:xmpp:mds:displayed:0` (item id = conversation bare JID, payload =
 * an XEP-0490 `<displayed/>` wrapper containing an XEP-0359 `<stanza-id/>`).
 * Request/response only — incoming `+notify` events are handled in PubSub.
 */
export class Mds {
  private readonly deps: ModuleDependencies
  private readonly node: PepNode<DisplayedMarker, DisplayedMarkerWrite>

  constructor(deps: ModuleDependencies) {
    this.deps = deps
    this.node = new PepNode(deps, NS_MDS, mdsCodec, MDS_NODE_OPTIONS)
  }

  /**
   * Publish the last-displayed stanza-id for a conversation.
   * The node is created on first publish with one item per conversation JID.
   *
   * @param stanzaIdBy - XEP-0359 `by`: the archive that assigned the stanza-id
   *   (our own bare JID for 1:1, the room JID for MUC).
   */
  async publishDisplayed(conversationJid: string, stanzaId: string, stanzaIdBy: string): Promise<void> {
    await this.node.publish(conversationJid, { stanzaId, stanzaIdBy })
  }

  /**
   * Best-effort retract of a conversation's displayed marker (e.g. on delete).
   * Tolerates an absent item or missing node — the goal is node hygiene, not
   * correctness, and a still-active conversation on another device will simply
   * republish its marker.
   */
  async retractDisplayed(conversationJid: string): Promise<void> {
    if (!this.deps.getCurrentJid()) return
    try {
      await this.node.retract(conversationJid)
    } catch {
      // Best-effort: item may not exist, or the node may be absent.
    }
  }

  /**
   * Best-effort fetch of all displayed markers from our own MDS node.
   * Returns an empty array when the node is absent or its state is unavailable.
   */
  async fetchAllDisplayed(timeoutMs?: number): Promise<DisplayedMarker[]> {
    const result = await this.fetchAllDisplayedResult(timeoutMs)
    return result.status === 'authoritative' ? result.markers : []
  }

  /**
   * Fetch all displayed markers while preserving whether the node response was
   * authoritative. A missing node is authoritative and contains no markers;
   * transport, timeout, and unexpected failures are unknown.
   */
  async fetchAllDisplayedResult(timeoutMs?: number): Promise<DisplayedMarkerFetchResult> {
    const result = await this.node.get({ timeoutMs })
    switch (result.status) {
      case 'ok': return { status: 'authoritative', markers: result.items }
      case 'absent': return { status: 'authoritative', markers: [] }
      case 'unavailable': return { status: 'unknown' }
    }
  }
}
