import { Element } from '@xmpp/client'
import { getLocalPart } from './jid'
import { NS_BOOKMARKS, NS_FLUUX } from './namespaces'

/**
 * A parsed XEP-0402 `<conference>` bookmark item.
 *
 * `nick` is left raw (possibly `undefined`) so callers can apply their own
 * default — `fetchBookmarks` only auto-joins when a nick is present, while the
 * live-notification path substitutes `'user'`.
 */
export interface ParsedBookmark {
  jid: string
  name: string
  nick?: string
  autojoin: boolean
  password?: string
  notifyAll: boolean
}

/**
 * Parse a single XEP-0402 bookmark `<item>` (the `<conference>` payload keyed
 * by the room JID in `item@id`). Returns `null` when the item carries no
 * `<conference xmlns='urn:xmpp:bookmarks:1'>` or has no id.
 *
 * Shared by {@link MUC.fetchBookmarks} (initial load) and the PEP
 * live-notification handler so both read bookmarks identically.
 */
export function parseBookmarkItem(item: Element): ParsedBookmark | null {
  const conference = item.getChild('conference', NS_BOOKMARKS)
  if (!conference) return null

  const jid = item.attrs.id // XEP-0402: the room JID is the item id
  if (!jid) return null

  const name = conference.attrs.name || getLocalPart(jid)
  const autojoin = conference.attrs.autojoin === '1' || conference.attrs.autojoin === 'true'
  const nick = conference.getChildText('nick') || undefined
  const password = conference.getChildText('password') || undefined
  const notifyAll = conference.getChild('extensions')?.getChild('notify', NS_FLUUX)?.getText() === 'all'

  return { jid, name, nick, autojoin, password, notifyAll }
}
