/**
 * Creates a lookup map for messages indexed by both client ID and stanza-ID.
 *
 * This is needed because replies and corrections may reference messages by any of:
 * - Client-generated message ID (e.g., "148a9d4f-68ee-4c5c-abca-685bc7981c2b")
 * - Sender-assigned origin-ID (XEP-0359) — the reference XEP-0308 corrections use
 * - Server-assigned stanza-ID from MAM (e.g., "1766999538188692")
 * - Server-assigned stanza-ID from a correction stanza (XEP-0308 + XEP-0359)
 *
 * XEP-0461 (Message Replies) and XEP-0308 (Last Message Correction) reference
 * different identity tiers — replies/reactions use the MUC stanza-id, corrections
 * use the sender-assigned origin-id — so we index by all of them to ensure lookups
 * succeed regardless of which one the remote referenced. For corrected messages we
 * also index by the correction's stanza-ID since other clients may reference the
 * corrected archive entry.
 */

interface MessageWithIds {
  id: string
  stanzaId?: string
  originId?: string
  correctionStanzaIds?: string[]
}

/**
 * Create a lookup map for messages by ID
 * @param messages Array of messages with id and optional stanzaId
 * @returns Map indexed by id, stanzaId, and correctionStanzaIds (when present)
 */
export function createMessageLookup<T extends MessageWithIds>(messages: T[]): Map<string, T> {
  const map = new Map<string, T>()
  // Pass 1 — strong identity tiers: server/client ids and correction archive ids.
  for (const message of messages) {
    map.set(message.id, message)
    if (message.stanzaId) {
      map.set(message.stanzaId, message)
    }
    // Index correction stanza-ids so replies to corrected messages resolve
    if (message.correctionStanzaIds) {
      for (const cid of message.correctionStanzaIds) {
        map.set(cid, message)
      }
    }
  }
  // Pass 2 — origin-id (XEP-0359) is sender-controlled and spoofable, so it is a
  // fallback only: never let it shadow a strong-tier id already indexed above.
  for (const message of messages) {
    if (message.originId && !map.has(message.originId)) {
      map.set(message.originId, message)
    }
  }
  return map
}

/**
 * Resolve a reference id to a message index, with strong-tier priority.
 *
 * Strong tiers (client id, server/MUC stanza-id, correction archive ids) are
 * checked first across ALL messages; the sender-controlled, spoofable origin-id
 * (XEP-0359) is consulted only as a fallback. This guarantees an origin-id can
 * never shadow a real id/stanza-id match on a different message — avoiding
 * over-matching while still resolving corrections that reference the origin-id.
 *
 * @returns The index of the matching message, or -1 if none match.
 */
export function findMessageIndexById<T extends MessageWithIds>(
  messages: T[],
  messageId: string
): number {
  let idx = messages.findIndex((m) =>
    m.id === messageId ||
    m.stanzaId === messageId ||
    m.correctionStanzaIds?.includes(messageId)
  )
  if (idx === -1) {
    idx = messages.findIndex((m) => m.originId === messageId)
  }
  return idx
}

/**
 * Find a message by ID, checking id, stanzaId, originId, and correctionStanzaIds.
 * Useful for corrections and replies that may reference any ID tier. Strong tiers
 * take priority over the spoofable origin-id (see {@link findMessageIndexById}).
 *
 * @param messages Array of messages to search
 * @param messageId The ID to search for (client id, stanza-id, origin-id, or correction stanza-id)
 * @returns The matching message or undefined
 */
export function findMessageById<T extends MessageWithIds>(
  messages: T[],
  messageId: string
): T | undefined {
  const idx = findMessageIndexById(messages, messageId)
  return idx === -1 ? undefined : messages[idx]
}
