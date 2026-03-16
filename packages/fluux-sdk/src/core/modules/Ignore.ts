import { xml } from '@xmpp/client'
import { getBareJid } from '../jid'
import { generateUUID } from '../../utils/uuid'
import { NS_PUBSUB, NS_IGNORED_USERS } from '../namespaces'
import type { ModuleDependencies } from './BaseModule'
import type { IgnoredUser } from '../../stores/ignoreStore'

/**
 * Ignore module for managing per-room ignored users via PEP (XEP-0223).
 *
 * Stores ignored user lists as private PubSub items, one item per room,
 * following the bookmarks pattern (XEP-0402). The PEP node uses
 * `access_model=whitelist` so only the owner can read/write.
 *
 * This module does not handle incoming stanzas — it only provides
 * request/response methods for fetching and publishing ignore lists.
 */
export class Ignore {
  private deps: ModuleDependencies

  constructor(deps: ModuleDependencies) {
    this.deps = deps
  }

  /**
   * Fetch ignored users for a specific room from private PEP storage (XEP-0223).
   * Returns the list of ignored users for that room, or an empty array if none.
   */
  async fetchIgnoredUsersForRoom(roomJid: string): Promise<IgnoredUser[]> {
    const currentJid = this.deps.getCurrentJid()
    if (!currentJid) return []

    const bareJid = getBareJid(currentJid)
    const iq = xml('iq', { type: 'get', to: bareJid, id: `ignored_${generateUUID()}` },
      xml('pubsub', { xmlns: NS_PUBSUB },
        xml('items', { node: NS_IGNORED_USERS },
          xml('item', { id: roomJid })
        )
      )
    )

    try {
      const result = await this.deps.sendIQ(iq)
      const item = result.getChild('pubsub', NS_PUBSUB)?.getChild('items')?.getChild('item')
      const container = item?.getChild('ignored-users', NS_IGNORED_USERS)
      if (!container) return []

      const users: IgnoredUser[] = []
      for (const userEl of container.getChildren('user')) {
        const identifier = userEl.attrs.identifier
        const displayName = userEl.attrs.name
        if (!identifier || !displayName) continue
        const user: IgnoredUser = { identifier, displayName }
        if (userEl.attrs.jid) {
          user.jid = userEl.attrs.jid
        }
        users.push(user)
      }
      return users
    } catch {
      // Node may not exist yet, or item not found
      return []
    }
  }

  /**
   * Save ignored users for a room to private PEP storage (XEP-0223).
   */
  async setIgnoredUsers(roomJid: string, users: IgnoredUser[]): Promise<void> {
    if (!this.deps.getCurrentJid()) throw new Error('Not connected')

    const userElements = users.map(u => {
      const attrs: Record<string, string> = {
        identifier: u.identifier,
        name: u.displayName,
      }
      if (u.jid) attrs.jid = u.jid
      return xml('user', attrs)
    })

    const iq = xml('iq', { type: 'set', id: `ignored_set_${generateUUID()}` },
      xml('pubsub', { xmlns: NS_PUBSUB },
        xml('publish', { node: NS_IGNORED_USERS },
          xml('item', { id: roomJid },
            xml('ignored-users', { xmlns: NS_IGNORED_USERS }, ...userElements)
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

  /**
   * Remove ignored users list for a room from PEP storage.
   * Called when a room's ignore list becomes empty.
   */
  async removeIgnoredUsers(roomJid: string): Promise<void> {
    if (!this.deps.getCurrentJid()) throw new Error('Not connected')

    const iq = xml('iq', { type: 'set', id: `ignored_remove_${generateUUID()}` },
      xml('pubsub', { xmlns: NS_PUBSUB },
        xml('retract', { node: NS_IGNORED_USERS },
          xml('item', { id: roomJid })
        )
      )
    )

    await this.deps.sendIQ(iq)
  }
}
