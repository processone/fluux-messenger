import type { ReadPointer } from './types/readState'
import { advance } from '../stores/shared/readPointer'

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
interface PublishedDisplayed {
  retained?: ReadPointer
  inFlight: Map<number, ReadPointer>
}

export type LocalDisplayedPublishOutcome = 'published' | 'ambiguous' | 'rejected'

export interface LocalDisplayedPublishClaim {
  settle(outcome: LocalDisplayedPublishOutcome): void
}

const published = new Map<string, Map<string, PublishedDisplayed>>()
let nextClaimId = 0

const key = (accountJid: string): Map<string, PublishedDisplayed> => {
  let byConversation = published.get(accountJid)
  if (!byConversation) {
    byConversation = new Map()
    published.set(accountJid, byConversation)
  }
  return byConversation
}

function entry(
  byConversation: Map<string, PublishedDisplayed>,
  conversationJid: string,
): PublishedDisplayed {
  let value = byConversation.get(conversationJid)
  if (!value) {
    value = { inFlight: new Map() }
    byConversation.set(conversationJid, value)
  }
  return value
}

/**
 * Record a position this client published.
 */
export function noteLocallyPublishedDisplayed(
  accountJid: string,
  conversationJid: string,
  readPointer: ReadPointer,
): void {
  if (!accountJid) return
  const byConversation = key(accountJid)
  const value = entry(byConversation, conversationJid)
  value.retained = advance(value.retained, readPointer)
}

export function beginLocallyPublishedDisplayed(
  accountJid: string,
  conversationJid: string,
  readPointer: ReadPointer,
): LocalDisplayedPublishClaim {
  if (!accountJid) return { settle: () => {} }

  const byConversation = key(accountJid)
  const value = entry(byConversation, conversationJid)
  const claimId = ++nextClaimId
  value.inFlight.set(claimId, readPointer)
  let settled = false

  return {
    settle(outcome: LocalDisplayedPublishOutcome): void {
      if (settled) return
      settled = true
      value.inFlight.delete(claimId)
      if (outcome !== 'rejected') value.retained = advance(value.retained, readPointer)

      if (byConversation.get(conversationJid) !== value) return
      if (value.retained || value.inFlight.size > 0) return
      byConversation.delete(conversationJid)
      if (byConversation.size === 0 && published.get(accountJid) === byConversation) {
        published.delete(accountJid)
      }
    },
  }
}

/** The furthest position this client has published for a conversation, if any. */
export function locallyPublishedDisplayed(
  accountJid: string,
  conversationJid: string,
): ReadPointer | undefined {
  const value = published.get(accountJid)?.get(conversationJid)
  if (!value) return undefined
  let highWater = value.retained
  for (const readPointer of value.inFlight.values()) {
    highWater = advance(highWater, readPointer)
  }
  return highWater
}

export function clearLocallyPublishedDisplayed(accountJid: string): void {
  published.delete(accountJid)
}
