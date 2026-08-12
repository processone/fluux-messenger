import { xml } from '@xmpp/client'
import type { Element } from '@xmpp/client'
import { NS_CONVERSATIONS } from '../namespaces'
import type { ModuleDependencies } from './BaseModule'
import { PepNode, type PepCodec, type PublishOptions } from './PepNode'

/**
 * A conversation entry synced to/from the server.
 * Minimal: only JID and archived flag. Name and metadata are derived locally.
 */
export interface SyncedConversation {
  jid: string
  archived: boolean
}

/**
 * Parse a PEP `<item>` (id="current") holding the conversation list into
 * {@link SyncedConversation} entries. Shared by the IQ fetch path and the
 * live PEP-notify handler so both interpret the wire format identically.
 * Returns an empty array if the item has no `<conversations>` container.
 */
export function parseConversationsItem(item: Element | undefined): SyncedConversation[] {
  return (item && conversationsCodec.decode(item)) || []
}

/** XEP-0223 private storage: owner-only, retained across sessions. */
const CONVERSATIONS_NODE_OPTIONS: PublishOptions = {
  persistItems: true,
  accessModel: 'whitelist',
}

/** The whole list lives in a single item, so its id is a constant. */
const CURRENT_ITEM_ID = 'current'

const conversationsCodec: PepCodec<SyncedConversation[]> = {
  encode: (conversations) => xml('conversations', { xmlns: NS_CONVERSATIONS },
    ...conversations.map((c) => xml('conversation',
      c.archived ? { jid: c.jid, archived: 'true' } : { jid: c.jid },
    )),
  ),
  decode: (item) => {
    const container = item.getChild('conversations', NS_CONVERSATIONS)
    if (!container) return undefined
    const conversations: SyncedConversation[] = []
    for (const convEl of container.getChildren('conversation')) {
      const jid = convEl.attrs.jid
      if (!jid) continue
      conversations.push({ jid, archived: convEl.attrs.archived === 'true' })
    }
    return conversations
  },
}

/**
 * ConversationSync module for persisting the 1:1 conversation list via PEP (XEP-0223).
 *
 * Stores the list of active and archived conversations as a single PEP item
 * using `access_model=whitelist` so only the owner can read/write.
 *
 * This module does not handle incoming stanzas — it only provides
 * request/response methods for fetching and publishing the conversation list.
 */
export class ConversationSync {
  private readonly node: PepNode<SyncedConversation[]>

  constructor(deps: ModuleDependencies) {
    this.node = new PepNode(deps, NS_CONVERSATIONS, conversationsCodec, CONVERSATIONS_NODE_OPTIONS)
  }

  /**
   * Fetch the conversation list from private PEP storage (XEP-0223).
   * Returns the list of conversations with their archived status, or an empty
   * array when the node, the item, or the session is missing.
   */
  async fetchConversations(timeoutMs?: number): Promise<SyncedConversation[]> {
    const lists = await this.node.getOr([], { itemId: CURRENT_ITEM_ID, timeoutMs })
    return lists[0] ?? []
  }

  /**
   * Publish the conversation list to private PEP storage (XEP-0223).
   * Writes the full list as a single item, replacing any previous data.
   */
  async publishConversations(conversations: SyncedConversation[]): Promise<void> {
    await this.node.publish(CURRENT_ITEM_ID, conversations)
  }
}
