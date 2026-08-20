import type { ReadPointer } from './types/readState'

/**
 * How far this client has itself told the account it read, per conversation.
 *
 * Publishing a XEP-0490 read position pushes it to every subscribed resource — this one included —
 * so a marker arriving as `read:displayed-synced` may be another device's reading or this client's
 * own scroll coming back. The wire cannot say which: a PEP item carries no publishing resource.
 *
 * Asking "did we publish this exact item?" needs a ledger, and a ledger has to be bounded, expired
 * and carried across reconnects — none of which the protocol supports, and each of which leaks. The
 * question that can be answered from one value is better: does this marker reach FURTHER than
 * anything this client has claimed? A marker that does carries something we did not already know,
 * whoever sent it. One that does not carries nothing new — it is our own echo, a replay of it, or a
 * device that has read no further than we told the account we had.
 *
 * Only the new-message divider consults this. The read pointer is forward-only and cannot be harmed
 * by a position it already holds.
 */
const published = new Map<string, Map<string, ReadPointer>>()

const key = (accountJid: string): Map<string, ReadPointer> => {
  let byConversation = published.get(accountJid)
  if (!byConversation) {
    byConversation = new Map()
    published.set(accountJid, byConversation)
  }
  return byConversation
}

/**
 * Record a position this client published.
 *
 * Callers pass positions in the order they publish them, and publication follows a forward-only read
 * pointer, so the newest value is the furthest. Recording an ambiguous publish — a timeout that may
 * still have committed server-side — is the safe direction: at worst the divider ignores a marker
 * covering ground this client had already read.
 */
export function noteLocallyPublishedDisplayed(
  accountJid: string,
  conversationJid: string,
  readPointer: ReadPointer,
): void {
  if (!accountJid) return
  key(accountJid).set(conversationJid, readPointer)
}

/** The furthest position this client has published for a conversation, if any. */
export function locallyPublishedDisplayed(
  accountJid: string,
  conversationJid: string,
): ReadPointer | undefined {
  return published.get(accountJid)?.get(conversationJid)
}

export function clearLocallyPublishedDisplayed(accountJid: string): void {
  published.delete(accountJid)
}
