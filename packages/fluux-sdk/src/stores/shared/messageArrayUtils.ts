/**
 * Shared utilities for working with message arrays.
 *
 * These generic functions can be used by both chatStore and roomStore
 * to reduce code duplication for common message array operations.
 */

import { compareExact, exactPosition } from './readState'

/**
 * Generic interface for messages with a timestamp.
 * Both Message and RoomMessage satisfy this interface.
 *
 * `id` and `from` are required for the timestamp-tiebreak sort below — the
 * resident array must break same-millisecond ties with the SAME total order
 * as the archive (`readState.ts`'s `compareExact`), or the two can disagree
 * about which message came second. `occupantId` is the room key's third
 * component: drop it and two occupants under one reassigned nick sort as one
 * position again.
 */
export interface TimestampedMessage {
  timestamp: Date
  id: string
  from?: string
  occupantId?: string
}

/**
 * Deduplicate messages by filtering out items that already exist.
 *
 * @param existing - Array of existing messages
 * @param incoming - Array of incoming messages to filter
 * @param getKey - Function to extract a unique key from a message
 * @returns Filtered array of incoming messages that don't exist in existing
 *
 * @example
 * ```typescript
 * import { deduplicateMessages } from './messageArrayUtils'
 * import { CHAT_SCOPE, canonicalKey } from '../../utils/messageIdentity'
 *
 * declare const existingMessages: Message[]
 * declare const mamMessages: Message[]
 *
 * // The key MUST come from `utils/messageIdentity` — never spell a tier ladder
 * // here. A hand-written key drops a rung (two copies of one message then both
 * // survive) or forgets the room scope (two rooms then collide).
 * const chatMsgs = deduplicateMessages(
 *   existingMessages,
 *   mamMessages,
 *   (m) => canonicalKey(CHAT_SCOPE, m)
 * )
 * ```
 */
export function deduplicateMessages<T>(
  existing: T[],
  incoming: T[],
  getKey: (message: T) => string
): T[] {
  const existingKeys = new Set<string>()

  for (const msg of existing) {
    existingKeys.add(getKey(msg))
  }

  return incoming.filter((msg) => !existingKeys.has(getKey(msg)))
}

/**
 * Build a set of keys from existing messages for deduplication checks.
 * Useful when you need to check multiple keys per message (e.g., stanzaId AND from+id).
 *
 * @param messages - Array of messages
 * @param getKeys - Function that returns an array of keys for a single message
 * @returns Set of all keys
 *
 * @example
 * ```typescript
 * import { buildMessageKeySet } from './messageArrayUtils'
 *
 * declare const existingMessages: Message[]
 *
 * // Chat messages need to check both stanzaId and from+id
 * const existingIds = buildMessageKeySet(existingMessages, (m) => {
 *   const keys: string[] = []
 *   if (m.stanzaId) keys.push(`stanzaId:${m.stanzaId}`)
 *   keys.push(`from:${m.from}:id:${m.id}`)
 *   return keys
 * })
 * ```
 */
export function buildMessageKeySet<T>(
  messages: T[],
  getKeys: (message: T) => string[]
): Set<string> {
  const keySet = new Set<string>()

  for (const msg of messages) {
    for (const key of getKeys(msg)) {
      keySet.add(key)
    }
  }

  return keySet
}

export function findMessagesSharingIdentity<T>(
  messages: readonly T[],
  incoming: T,
  getKeys: (message: T) => string[]
): T[] {
  const incomingKeys = new Set(getKeys(incoming))
  return messages.filter((message) =>
    getKeys(message).some((key) => incomingKeys.has(key))
  )
}

/**
 * Check if a message is a duplicate based on a key set.
 *
 * @param message - The message to check
 * @param keySet - Set of existing keys
 * @param getKeys - Function that returns an array of keys for the message
 * @returns true if any of the message's keys exist in the set
 */
export function isMessageDuplicate<T>(
  message: T,
  keySet: Set<string>,
  getKeys: (message: T) => string[]
): boolean {
  return getKeys(message).some((key) => keySet.has(key))
}

/**
 * Identity fields an archived/echoed copy of a message can carry.
 */
export interface ArchiveIdentifiableMessage {
  stanzaId?: string
  originId?: string
}

/**
 * Backfill the server `stanzaId` (and `originId`) onto existing in-memory
 * messages from their archived/echoed duplicates.
 *
 * Outgoing messages are created with only a client `originId` and no server
 * `stanzaId` (the server assigns it on archiving). When their archived copy
 * later arrives via MAM (or a carbon) it carries the `stanzaId` but is dropped
 * as a duplicate, so the live copy never receives one — which breaks backward
 * MAM pagination, whose RSM cursor must be a server archive id. This patches
 * the missing fields, matching an incoming "donor" to an existing message by
 * any shared identity key (e.g. `originId`).
 *
 * Pure: never mutates inputs. Returns the SAME `existing` array reference when
 * nothing changed, so callers can cheaply skip a store update; otherwise a
 * copy-on-write array with the patched messages plus the list of patches (for
 * persistence).
 */
export function backfillArchiveIds<T extends ArchiveIdentifiableMessage>(
  existing: T[],
  incoming: T[],
  getKeys: (message: T) => string[],
  sameMessage?: (a: T, b: T) => boolean,
  getMergeCandidates?: (incoming: T, candidates: readonly T[]) => T[]
): { messages: T[]; patched: T[] } {
  // Only incoming messages that carry a stanzaId can donate one.
  const donors = incoming.filter((m) => m.stanzaId)
  if (donors.length === 0) return { messages: existing, patched: [] }

  // Index every identity key of each donor so an existing message can find its
  // matching archived copy by any shared key.
  const donorByKey = sameMessage ? undefined : new Map<string, T>()
  if (donorByKey) {
    for (const donor of donors) {
      for (const key of getKeys(donor)) {
        if (!donorByKey.has(key)) donorByKey.set(key, donor)
      }
    }
  }

  let messages = existing
  const patched: T[] = []
  for (let i = 0; i < existing.length; i++) {
    const current = existing[i]
    if (current.stanzaId) continue // already has a server archive id

    const identityDonors = sameMessage
      ? findMessagesSharingIdentity(donors, current, getKeys)
      : []
    const matchingDonors = getMergeCandidates
      ? getMergeCandidates(current, identityDonors)
      : identityDonors
    let donor = matchingDonors.find((candidate) => sameMessage?.(current, candidate))
    if (!sameMessage) {
      for (const key of getKeys(current)) {
        const match = donorByKey!.get(key)
        if (match) {
          donor = match
          break
        }
      }
    }
    if (!donor?.stanzaId) continue

    const updated: T = {
      ...current,
      stanzaId: donor.stanzaId,
      ...(!current.originId && donor.originId ? { originId: donor.originId } : {}),
    }
    if (messages === existing) messages = [...existing] // copy-on-write
    messages[i] = updated
    patched.push(updated)
  }

  return { messages, patched }
}

/**
 * Sort messages by timestamp in ascending order (oldest first).
 *
 * Same-millisecond ties break by the message cache's own tie-break key
 * (`readState.ts`'s `compareExact`), kind-discriminated: chat by `id` only,
 * room by `from`, then `id`, then the occupant-id. This is deliberately NOT a
 * generic `from`-then-`id` comparator — chat messages carry `from` too, so
 * inferring the tiebreak from field presence would silently apply the room rule
 * to chat. The resident array and archive adjudicator must agree on this order;
 * the room IndexedDB cursor stops at `id`, and every row it visits is compared
 * again here. Otherwise the read pointer (positioned in cache order) and the
 * viewport observer (walking this resident order) can disagree about which
 * message came second.
 *
 * @param messages - Array of messages to sort
 * @param kind - Which tie-break rule applies (`'chat'` = id only, `'room'` = from, id, occupant)
 * @returns New sorted array (does not mutate input)
 */
export function sortMessagesByTimestamp<T extends TimestampedMessage>(
  messages: T[],
  kind: 'chat' | 'room'
): T[] {
  return [...messages].sort((a, b) =>
    compareExact(exactPosition(a, kind), exactPosition(b, kind))
  )
}

/**
 * Trim messages array to a maximum count, keeping the most recent messages.
 *
 * @param messages - Array of messages (should be sorted by timestamp ascending)
 * @param maxCount - Maximum number of messages to keep
 * @returns Trimmed array with at most maxCount messages (most recent)
 */
export function trimMessages<T>(messages: T[], maxCount: number): T[] {
  if (maxCount <= 0) {
    return []
  }
  if (messages.length <= maxCount) {
    return messages
  }
  return messages.slice(-maxCount)
}

/**
 * Keep the OLDEST `maxCount` messages (front of a timestamp-ascending array),
 * evicting the newest tail. Used by the sliding window's load-older path so that
 * scrolling up past the window bound slides the window instead of dropping the
 * just-loaded older batch (the mirror of {@link trimMessages}, which keeps newest).
 *
 * @param messages - Array of messages (should be sorted by timestamp ascending)
 * @param maxCount - Maximum number of messages to keep
 * @returns Trimmed array with at most maxCount messages (oldest)
 */
export function trimMessagesKeepOldest<T>(messages: T[], maxCount: number): T[] {
  if (maxCount <= 0) return []
  if (messages.length <= maxCount) return messages
  return messages.slice(0, maxCount)
}

/**
 * Merge two message arrays, deduplicate, sort by timestamp, and trim.
 * This is a convenience function that combines the common operations.
 *
 * @param existing - Existing messages array
 * @param incoming - Incoming messages to merge
 * @param getKeys - Function that returns keys for deduplication
 * @param kind - Which tie-break rule the sort applies (see {@link sortMessagesByTimestamp})
 * @param maxCount - Maximum messages to keep (optional, no trim if not provided)
 * @returns Merged, deduplicated, sorted, and optionally trimmed array
 */
export function mergeAndProcessMessages<T extends TimestampedMessage>(
  existing: T[],
  incoming: T[],
  getKeys: (message: T) => string[],
  kind: 'chat' | 'room',
  maxCount?: number,
  sameMessage?: (a: T, b: T) => boolean,
  getMergeCandidates?: (incoming: T, candidates: readonly T[]) => T[]
): { merged: T[]; newMessages: T[] } {
  // Build key set from existing messages
  const keySet = buildMessageKeySet(existing, getKeys)

  // Filter duplicates
  const newMessages = incoming.filter((msg) => {
    if (!sameMessage) return !isMessageDuplicate(msg, keySet, getKeys)
    const candidates = findMessagesSharingIdentity(existing, msg, getKeys)
    const matches = getMergeCandidates ? getMergeCandidates(msg, candidates) : candidates
    return !matches.some((resident) => sameMessage(resident, msg))
  })

  // Merge and sort
  let merged = sortMessagesByTimestamp([...newMessages, ...existing], kind)

  // Trim if maxCount provided
  if (maxCount !== undefined) {
    merged = trimMessages(merged, maxCount)
  }

  return { merged, newMessages }
}

/**
 * Efficiently prepend older messages to an existing array.
 *
 * This is optimized for MAM pagination where we're loading OLDER messages
 * (before the current oldest message). Since MAM with `before` returns messages
 * that are all older than existing ones, we can prepend without a full re-sort.
 *
 * This avoids the visual "blink" that occurs when full re-sorting causes
 * React to re-render the entire message list.
 *
 * @param existing - Existing messages array (must already be sorted by timestamp)
 * @param older - Older messages to prepend (will be sorted among themselves)
 * @param getKeys - Function that returns keys for deduplication
 * @param kind - Which tie-break rule the sort applies (see {@link sortMessagesByTimestamp})
 * @param maxCount - Maximum messages to keep (optional, no trim if not provided)
 * @returns Merged array with older messages prepended, and the new messages added
 */
export function prependOlderMessages<T extends TimestampedMessage>(
  existing: T[],
  older: T[],
  getKeys: (message: T) => string[],
  kind: 'chat' | 'room',
  maxCount?: number,
  sameMessage?: (a: T, b: T) => boolean,
  getMergeCandidates?: (incoming: T, candidates: readonly T[]) => T[]
): { merged: T[]; newMessages: T[] } {
  // Build key set from existing messages
  const keySet = buildMessageKeySet(existing, getKeys)

  // Filter duplicates from older messages
  const newMessages = older.filter((msg) => {
    if (!sameMessage) return !isMessageDuplicate(msg, keySet, getKeys)
    const candidates = findMessagesSharingIdentity(existing, msg, getKeys)
    const matches = getMergeCandidates ? getMergeCandidates(msg, candidates) : candidates
    return !matches.some((resident) => sameMessage(resident, msg))
  })

  if (newMessages.length === 0) {
    return { merged: existing, newMessages: [] }
  }

  // A backward page IS older than the resident window, but only to the
  // millisecond. A same-millisecond group can straddle the page boundary — MAM
  // pages by archive id, not by time — and the cache breaks those ties by `id`
  // for chat and `(from, id)` for room. Prepending without a full sort places
  // such a sibling ahead of a resident one the cache orders first, so the
  // resident array stops agreeing with the cache walk. Two things then go wrong:
  // the viewport observer advances the read pointer by RESIDENT INDEX, so it can
  // move past a message the cache still counts as unread (a silent under-count,
  // the unrecoverable direction), and `trimMessagesKeepOldest` below evicts by
  // position, so it drops the wrong row at the window bound.
  let merged = sortMessagesByTimestamp([...newMessages, ...existing], kind)

  // Load-older slides the window: keep the OLDEST maxCount so the just-loaded older
  // batch survives and the newest tail is evicted (was trimMessages = keep-newest,
  // which dropped the loaded batch at the bound — the old scroll-back "wall").
  if (maxCount !== undefined) {
    merged = trimMessagesKeepOldest(merged, maxCount)
  }

  return { merged, newMessages }
}
