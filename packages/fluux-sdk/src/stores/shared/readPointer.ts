/**
 * The read pointer — where the user has read to.
 *
 * This replaces the `lastSeenMessageId` + `lastReadAt` pair, which were two
 * independent fields describing one fact and drifted apart in practice (issue
 * #1081): `lastReadAt` meant "timestamp of the newest LOADED message when I last
 * activated", not "the timestamp of the message I read up to". Nothing stopped a
 * writer from moving one and not the other.
 *
 * Here they are one object. You cannot write half of it. The timestamp is
 * denormalised from the message the id names, which is what keeps ordering
 * comparisons synchronous and O(1) — the message cache is then needed only for
 * counting, not for deciding which of two positions is further along.
 *
 * All functions here are pure.
 */

/** Where the user has read to. Written atomically or not at all. */
export interface ReadPointer {
  /** Client message id of the newest message the user has read. */
  messageId: string
  /** Timestamp OF that message. */
  timestamp: Date
}

/** JSON-safe form for localStorage. */
export interface SerializedReadPointer {
  messageId: string
  timestamp: number
}

/** The minimal message shape a pointer can be built from. */
export interface PointerSource {
  id: string
  timestamp: Date
}

/** Build a pointer naming `message`. */
export function makeReadPointer(message: PointerSource): ReadPointer {
  return { messageId: message.id, timestamp: message.timestamp }
}

/**
 * Is `candidate` strictly further along than `current`?
 *
 * Equal timestamps are NOT an advance, even with a different id. Two messages
 * can share a millisecond (MAM archives routinely do), and treating a
 * same-instant sibling as progress would make the XEP-0490 publisher re-assert a
 * position it already published, forever. Refusing to advance there under-counts
 * at worst, which is the recoverable direction.
 */
export function isAhead(candidate: ReadPointer, current: ReadPointer | undefined): boolean {
  if (!current) return true
  return candidate.timestamp.getTime() > current.timestamp.getTime()
}

/**
 * Forward-only advance. Returns `current` **by reference** when the candidate is
 * not ahead, so Zustand selectors can skip the re-render.
 */
export function advance(current: ReadPointer | undefined, candidate: ReadPointer): ReadPointer {
  if (!current) return candidate
  return isAhead(candidate, current) ? candidate : current
}

/**
 * The floor every unread derivation counts from: the LATER of the read pointer
 * and the entity's history watermark.
 *
 * `historyFloor` records when the entity entered our world (join / creation). It
 * is not a read position — it is what stops a freshly joined room with 10k
 * messages of history from reporting 10k unread, without anyone having to write
 * the pointer to do it.
 */
export function readFloor(
  pointer: ReadPointer | undefined,
  historyFloor: Date | undefined
): Date | undefined {
  if (pointer && historyFloor) {
    return pointer.timestamp.getTime() >= historyFloor.getTime() ? pointer.timestamp : historyFloor
  }
  return pointer?.timestamp ?? historyFloor
}

export function serializeReadPointer(pointer: ReadPointer): SerializedReadPointer {
  return { messageId: pointer.messageId, timestamp: pointer.timestamp.getTime() }
}

/**
 * Rebuild a pointer from untrusted storage. Anything malformed yields
 * `undefined` — "no pointer" — rather than a pointer holding an Invalid Date,
 * which would poison every comparison it touched with silent `false`.
 *
 * Accepts `timestamp` as either epoch ms (the on-disk form `serializeReadPointer`
 * writes) or an ISO string (what a chat pointer riding inside `conversationMeta`
 * becomes after a plain `JSON.stringify` turns its `Date` into a string). Both
 * encodings exist on disk today — this is the one place that reads either back.
 * We still only ever WRITE epoch ms; the string branch is read-only tolerance.
 */
export function deserializeReadPointer(raw: unknown): ReadPointer | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const { messageId, timestamp } = raw as { messageId?: unknown; timestamp?: unknown }
  if (typeof messageId !== 'string' || messageId.length === 0) return undefined

  if (typeof timestamp === 'number') {
    return Number.isFinite(timestamp) ? { messageId, timestamp: new Date(timestamp) } : undefined
  }
  if (typeof timestamp === 'string') {
    const parsed = new Date(timestamp)
    return Number.isNaN(parsed.getTime()) ? undefined : { messageId, timestamp: parsed }
  }
  return undefined
}
