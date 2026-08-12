import { xml } from '@xmpp/client'
import { NS_IGNORED_USERS } from '../namespaces'
import type { ModuleDependencies } from './BaseModule'
import { PepNode, type PepCodec, type PublishOptions } from './PepNode'
import type { IgnoredUser } from '../../stores/ignoreStore'

/** XEP-0223 private storage: owner-only, retained across sessions. */
const IGNORE_NODE_OPTIONS: PublishOptions = {
  persistItems: true,
  accessModel: 'whitelist',
}

/** One item per room, each holding that room's whole ignore list. */
const ignoredUsersCodec: PepCodec<IgnoredUser[]> = {
  encode: (users) => xml('ignored-users', { xmlns: NS_IGNORED_USERS },
    ...users.map((user) => {
      const attrs: Record<string, string> = {
        identifier: user.identifier,
        name: user.displayName,
      }
      if (user.jid) attrs.jid = user.jid
      return xml('user', attrs)
    }),
  ),
  decode: (item) => {
    const container = item.getChild('ignored-users', NS_IGNORED_USERS)
    if (!container) return undefined
    const users: IgnoredUser[] = []
    for (const userEl of container.getChildren('user')) {
      const identifier = userEl.attrs.identifier
      const displayName = userEl.attrs.name
      if (!identifier || !displayName) continue
      const user: IgnoredUser = { identifier, displayName }
      if (userEl.attrs.jid) user.jid = userEl.attrs.jid
      users.push(user)
    }
    return users
  },
}

/**
 * Ignore module for managing per-room ignored users via PEP (XEP-0223).
 *
 * Stores ignored user lists as private PubSub items, one item per room,
 * following the bookmarks pattern (XEP-0402).
 *
 * This module does not handle incoming stanzas — it only provides
 * request/response methods for fetching and publishing ignore lists.
 */
export class Ignore {
  private readonly node: PepNode<IgnoredUser[]>

  constructor(deps: ModuleDependencies) {
    this.node = new PepNode(deps, NS_IGNORED_USERS, ignoredUsersCodec, IGNORE_NODE_OPTIONS)
  }

  /**
   * Fetch ignored users for a specific room from private PEP storage (XEP-0223).
   * Returns the list of ignored users for that room, or an empty array when the
   * node, the item, or the session is missing.
   */
  async fetchIgnoredUsersForRoom(roomJid: string): Promise<IgnoredUser[]> {
    const lists = await this.node.getOr([], { itemId: roomJid })
    return lists[0] ?? []
  }

  /**
   * Save ignored users for a room to private PEP storage (XEP-0223).
   */
  async setIgnoredUsers(roomJid: string, users: IgnoredUser[]): Promise<void> {
    await this.node.publish(roomJid, users)
  }

  /**
   * Remove ignored users list for a room from PEP storage.
   * Called when a room's ignore list becomes empty.
   */
  async removeIgnoredUsers(roomJid: string): Promise<void> {
    await this.node.retract(roomJid)
  }
}
