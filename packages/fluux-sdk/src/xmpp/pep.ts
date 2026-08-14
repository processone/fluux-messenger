/**
 * Raw PEP reads, for nodes the SDK does not model.
 *
 * @module XMPP/PEP
 */

import type { XMPPClient } from '../core/XMPPClient'
import type { PEPItem } from '../core/e2ee'

/**
 * Read items from a PEP node by name (XEP-0060, XEP-0163).
 *
 * The SDK models the PEP nodes it understands — avatars, nicknames, bookmarks,
 * read markers — and exposes them as domain state. This is for the ones it does
 * not: you name the node, and you get its items with their payloads as
 * {@link XMLElementData}, element names and namespaces included. Interpreting
 * that is the caller's job.
 *
 * The E2EE plugin surface offers the same read through `PluginContext.xmpp`,
 * which is where a plugin should get it. This exists for the case a plugin
 * cannot cover: code that must query a node *before* any plugin is registered.
 *
 * @param client - A connected client.
 * @param jid - Bare JID whose node to read; the account's own JID for a
 *   personal node.
 * @param node - The node's name, e.g. `urn:xmpp:openpgp:0:public-keys`.
 * @param maxItems - Cap on returned items, mapped to PubSub's `max_items`.
 *   Omit for the server's default.
 * @returns The node's items, oldest-first as the server returned them. An
 *   absent node raises the server's `item-not-found`, which callers usually
 *   want to tell apart from an empty node.
 *
 * @example
 * ```typescript
 * import { queryPepNode } from '@fluux/sdk/xmpp'
 *
 * const items = await queryPepNode(client, 'bob@example.com', 'urn:xmpp:openpgp:0:public-keys', 1)
 * for (const item of items) {
 *   if (item.payload.name === 'public-keys-list') console.log(item.id)
 * }
 * ```
 */
export async function queryPepNode(
  client: XMPPClient,
  jid: string,
  node: string,
  maxItems?: number,
): Promise<PEPItem[]> {
  return client.internal.pubsub.query(jid, node, maxItems)
}
