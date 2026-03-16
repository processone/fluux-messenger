import { xml } from '@xmpp/client'
import { getBareJid } from '../jid'
import { generateUUID } from '../../utils/uuid'
import { NS_PUBSUB, NS_CONVERSATIONS } from '../namespaces'
import type { ModuleDependencies } from './BaseModule'

/**
 * A conversation entry synced to/from the server.
 * Minimal: only JID and archived flag. Name and metadata are derived locally.
 */
export interface SyncedConversation {
  jid: string
  archived: boolean
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
  private deps: ModuleDependencies

  constructor(deps: ModuleDependencies) {
    this.deps = deps
  }

  /**
   * Fetch the conversation list from private PEP storage (XEP-0223).
   * Returns the list of conversations with their archived status,
   * or an empty array if the node does not exist.
   */
  async fetchConversations(): Promise<SyncedConversation[]> {
    const currentJid = this.deps.getCurrentJid()
    if (!currentJid) return []

    const bareJid = getBareJid(currentJid)
    const iq = xml('iq', { type: 'get', to: bareJid, id: `conv_list_${generateUUID()}` },
      xml('pubsub', { xmlns: NS_PUBSUB },
        xml('items', { node: NS_CONVERSATIONS },
          xml('item', { id: 'current' })
        )
      )
    )

    try {
      const result = await this.deps.sendIQ(iq)
      const item = result.getChild('pubsub', NS_PUBSUB)?.getChild('items')?.getChild('item')
      const container = item?.getChild('conversations', NS_CONVERSATIONS)
      if (!container) return []

      const conversations: SyncedConversation[] = []
      for (const convEl of container.getChildren('conversation')) {
        const jid = convEl.attrs.jid
        if (!jid) continue
        conversations.push({
          jid,
          archived: convEl.attrs.archived === 'true',
        })
      }
      return conversations
    } catch {
      // Node may not exist yet, or item not found
      return []
    }
  }

  /**
   * Publish the conversation list to private PEP storage (XEP-0223).
   * Writes the full list as a single item (id="current"), replacing any previous data.
   */
  async publishConversations(conversations: SyncedConversation[]): Promise<void> {
    if (!this.deps.getCurrentJid()) throw new Error('Not connected')

    const convElements = conversations.map(c => {
      const attrs: Record<string, string> = { jid: c.jid }
      if (c.archived) {
        attrs.archived = 'true'
      }
      return xml('conversation', attrs)
    })

    const iq = xml('iq', { type: 'set', id: `conv_list_set_${generateUUID()}` },
      xml('pubsub', { xmlns: NS_PUBSUB },
        xml('publish', { node: NS_CONVERSATIONS },
          xml('item', { id: 'current' },
            xml('conversations', { xmlns: NS_CONVERSATIONS }, ...convElements)
          )
        ),
        // XEP-0223: Publish options for private storage
        xml('publish-options', {},
          xml('x', { xmlns: 'jabber:x:data', type: 'submit' },
            xml('field', { var: 'FORM_TYPE', type: 'hidden' },
              xml('value', {}, 'http://jabber.org/protocol/pubsub#publish-options')
            ),
            xml('field', { var: 'pubsub#persist_items' },
              xml('value', {}, 'true')
            ),
            xml('field', { var: 'pubsub#access_model' },
              xml('value', {}, 'whitelist')
            )
          )
        )
      )
    )

    await this.deps.sendIQ(iq)
  }
}
