import { Element } from '@xmpp/client'
import { clone, parse as parseXml } from 'ltx'
import { getLocalPart } from './jid'
import { NS_BOOKMARKS, NS_FLUUX } from './namespaces'
import { parseNotifyLevel, type NotifyLevel } from './notifyLevel'
import { logWarn } from './logger'

/**
 * A parsed XEP-0402 `<conference>` bookmark item.
 *
 * `nick` is left raw (possibly `undefined`) so callers can apply their own
 * default — `fetchBookmarks` resolves it via `resolveDefaultMucNick` (profile
 * username, then bare-JID local part) so an autojoin bookmark that omits
 * `<nick>` still rejoins under a sensible nick.
 */
export interface ParsedBookmark {
  jid: string
  name: string
  nick?: string
  autojoin: boolean
  password?: string
  notifyLevel: NotifyLevel
  /**
   * The children of `<extensions>` that Fluux does not own, serialized, in
   * document order. Empty when the bookmark has none: the server's answer is
   * known, unlike a room whose bookmark has not been read. See
   * {@link readForeignExtensions}.
   */
  extensions: string[]
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
  const extensionsEl = conference.getChild('extensions')
  const notifyLevel = parseNotifyLevel(extensionsEl?.getChild('notify', NS_FLUUX)?.getText())
  const extensions = extensionsEl ? readForeignExtensions(extensionsEl) : []

  return { jid, name, nick, autojoin, password, notifyLevel, extensions }
}

/** The one `<extensions>` child Fluux writes itself: the room notification level. */
function isOwnExtension(child: Element): boolean {
  return child.is('notify', NS_FLUUX)
}

/**
 * Serialize every child of a bookmark's `<extensions>` that Fluux does not
 * own, so a later publish can carry it unchanged.
 *
 * XEP-0402 §3.4: clients MUST preserve any XML elements they do not
 * understand within `<extensions/>`. A publish replaces the stored item, so an
 * element dropped here is deleted from the server — for every client of the
 * account (for example another client's XEP-0492 notification setting).
 */
export function readForeignExtensions(extensions: Element): string[] {
  const kept: string[] = []
  for (const child of extensions.children) {
    if (typeof child === 'string' || isOwnExtension(child)) continue
    kept.push(serializeDetached(child))
  }
  return kept
}

/**
 * Rebuild the elements kept by {@link readForeignExtensions} for a publish.
 * An entry that no longer parses is skipped rather than failing the publish.
 */
export function buildForeignExtensions(serialized: readonly string[]): Element[] {
  const elements: Element[] = []
  for (const xmlText of serialized) {
    try {
      elements.push(parseXml(xmlText) as Element)
    } catch (err) {
      logWarn(`Bookmark: skipping an unreadable kept extension: ${err instanceof Error ? err.message : String(err)}`)
    }
  }
  return elements
}

/**
 * `child.toString()` alone loses every namespace declaration made on an
 * ancestor: a prefix (`<conference xmlns:x='…'><extensions><x:state/>`), one
 * used only inside an attribute value, or a default namespace the element
 * inherits. Republished under Fluux's own `<conference xmlns='urn:xmpp:bookmarks:1'>`,
 * the copy would then fail to parse or move into the bookmarks namespace.
 * Copy every declaration in scope onto the detached copy, the nearest one for
 * each name, unless the element declares that name itself.
 */
function serializeDetached(child: Element): string {
  const copy = clone(child)
  for (let node = parentOf(child); node; node = parentOf(node)) {
    for (const [attr, value] of Object.entries(node.attrs)) {
      const isDeclaration = attr === 'xmlns' || attr.startsWith('xmlns:')
      if (isDeclaration && copy.attrs[attr] === undefined) copy.attrs[attr] = value
    }
  }
  return copy.toString()
}

/** ltx links every parsed element to its parent; the SDK's Element type leaves the field out. */
function parentOf(el: Element): Element | null {
  return (el as Element & { parent?: Element | null }).parent ?? null
}
