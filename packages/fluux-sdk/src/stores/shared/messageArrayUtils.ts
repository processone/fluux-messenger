/**
 * Shared utilities for working with message arrays.
 *
 * These generic functions can be used by both chatStore and roomStore
 * to reduce code duplication for common message array operations.
 */

/**
 * Generic interface for messages with a timestamp.
 * Both Message and RoomMessage satisfy this interface.
 */
export interface TimestampedMessage {
  timestamp: Date
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
 * // Chat messages: dedupe by stanzaId or from+id combo
 * const newMsgs = deduplicateMessages(
 *   existingMessages,
 *   mamMessages,
 *   (m) => m.stanzaId ? `stanzaId:${m.stanzaId}` : `from:${m.from}:id:${m.id}`
 * )
 *
 * // Room messages: dedupe by stanzaId or id
 * const newMsgs = deduplicateMessages(
 *   existingMessages,
 *   mamMessages,
 *   (m) => m.stanzaId || m.id
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
  getKeys: (message: T) => string[]
): { messages: T[]; patched: T[] } {
  // Only incoming messages that carry a stanzaId can donate one.
  const donors = incoming.filter((m) => m.stanzaId)
  if (donors.length === 0) return { messages: existing, patched: [] }

  // Index every identity key of each donor so an existing message can find its
  // matching archived copy by any shared key.
  const donorByKey = new Map<string, T>()
  for (const donor of donors) {
    for (const key of getKeys(donor)) {
      if (!donorByKey.has(key)) donorByKey.set(key, donor)
    }
  }

  let messages = existing
  const patched: T[] = []
  for (let i = 0; i < existing.length; i++) {
    const current = existing[i]
    if (current.stanzaId) continue // already has a server archive id

    let donor: T | undefined
    for (const key of getKeys(current)) {
      const match = donorByKey.get(key)
      if (match) {
        donor = match
        break
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
 * @param messages - Array of messages to sort
 * @returns New sorted array (does not mutate input)
 */
export function sortMessagesByTimestamp<T extends TimestampedMessage>(
  messages: T[]
): T[] {
  return [...messages].sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime())
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
 * @param maxCount - Maximum messages to keep (optional, no trim if not provided)
 * @returns Merged, deduplicated, sorted, and optionally trimmed array
 */
export function mergeAndProcessMessages<T extends TimestampedMessage>(
  existing: T[],
  incoming: T[],
  getKeys: (message: T) => string[],
  maxCount?: number
): { merged: T[]; newMessages: T[] } {
  // Build key set from existing messages
  const keySet = buildMessageKeySet(existing, getKeys)

  // Filter duplicates
  const newMessages = incoming.filter((msg) => !isMessageDuplicate(msg, keySet, getKeys))

  // Merge and sort
  let merged = sortMessagesByTimestamp([...newMessages, ...existing])

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
 * @param maxCount - Maximum messages to keep (optional, no trim if not provided)
 * @returns Merged array with older messages prepended, and the new messages added
 */
export function prependOlderMessages<T extends TimestampedMessage>(
  existing: T[],
  older: T[],
  getKeys: (message: T) => string[],
  maxCount?: number
): { merged: T[]; newMessages: T[] } {
  // Build key set from existing messages
  const keySet = buildMessageKeySet(existing, getKeys)

  // Filter duplicates from older messages
  const newMessages = older.filter((msg) => !isMessageDuplicate(msg, keySet, getKeys))

  if (newMessages.length === 0) {
    return { merged: existing, newMessages: [] }
  }

  // Sort only the new messages among themselves
  // (they all go at the front since they're older than existing)
  const sortedNew = sortMessagesByTimestamp(newMessages)

  // Prepend to existing - no full re-sort needed since new messages are all older
  let merged = [...sortedNew, ...existing]

  // Trim if maxCount provided (removes oldest from front)
  if (maxCount !== undefined) {
    merged = trimMessages(merged, maxCount)
  }

  return { merged, newMessages }
}
