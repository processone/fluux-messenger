/**
 * What this client has itself published to its XEP-0490 read-marker node.
 *
 * Publishing a read position pushes it to every subscribed resource of the account — this one
 * included — so a marker arriving as `read:displayed-synced` may be another device's reading or
 * this client's own scroll coming back. The wire cannot tell them apart: a PEP item carries no
 * publishing resource. What separates them is what this client remembers publishing.
 *
 * The distinction matters only for the new-message divider. Another device's marker is evidence the
 * user read there, so the line follows it; an echo of our own is the scroll we just made, and the
 * line must stay where the view opened it.
 *
 * Bounded by construction rather than by a clock. A time-to-live cannot bound this correctly: a
 * stream-management replay or a reconnect seed re-reads the node and can deliver an echo long after
 * any expiry, and until then every distinct publish accumulates. Keeping the last few ids per
 * conversation costs a fixed amount and does not care when the echo arrives.
 */

/**
 * How many recent publishes to remember per conversation.
 *
 * An echo can only be one of the markers this client published for that conversation, and it
 * arrives within a handful of publishes of the one that produced it. The bound exists so a long
 * session cannot grow this without limit; it is not a timing assumption.
 */
const REMEMBERED_PUBLISHES_PER_CONVERSATION = 32

/** account JID → conversation JID → recently published stanza ids, oldest first. */
const publishes = new Map<string, Map<string, string[]>>()

export function markLocallyPublishedDisplayed(
  accountJid: string,
  conversationJid: string,
  stanzaId: string,
): void {
  if (!accountJid) return
  let conversations = publishes.get(accountJid)
  if (!conversations) {
    conversations = new Map()
    publishes.set(accountJid, conversations)
  }
  const recent = conversations.get(conversationJid) ?? []
  const existing = recent.indexOf(stanzaId)
  if (existing !== -1) recent.splice(existing, 1)
  recent.push(stanzaId)
  while (recent.length > REMEMBERED_PUBLISHES_PER_CONVERSATION) recent.shift()
  conversations.set(conversationJid, recent)
}

export function wasLocallyPublishedDisplayed(
  accountJid: string,
  conversationJid: string,
  stanzaId: string,
): boolean {
  return publishes.get(accountJid)?.get(conversationJid)?.includes(stanzaId) ?? false
}

export function forgetLocallyPublishedDisplayed(
  accountJid: string,
  conversationJid: string,
  stanzaId: string,
): void {
  const conversations = publishes.get(accountJid)
  const recent = conversations?.get(conversationJid)
  if (!conversations || !recent) return
  const at = recent.indexOf(stanzaId)
  if (at === -1) return
  recent.splice(at, 1)
  if (recent.length === 0) conversations.delete(conversationJid)
  if (conversations.size === 0) publishes.delete(accountJid)
}

export function clearLocallyPublishedDisplayed(accountJid: string): void {
  publishes.delete(accountJid)
}
