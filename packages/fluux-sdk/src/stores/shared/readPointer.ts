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

import { compareOrder, makeArchiveOrderKey, type ArchiveOrderKey } from './readState'

/**
 * Where the user has read to. Written atomically or not at all.
 *
 * ONE deliberate exception to "the timestamp is the message's own": pointers
 * built by the #1081 migration from a legacy `lastSeenMessageId` + `lastReadAt`
 * PAIR carry `lastReadAt` as the timestamp, which is not necessarily the
 * timestamp of the message `messageId` names. That is the status quo preserved
 * exactly — `lastReadAt` is the floor today's unread derivation already counts
 * from, and it is at or behind the named message. Do not "fix" this by resolving
 * the message's real timestamp: that could move the floor FORWARD, and the
 * pointer is forward-only, so a position lost that way is unrecoverable. Only
 * `timestamp` is used for ordering; nothing derives a message from it.
 */
export interface ReadPointer {
  /** Client message id of the newest message the user has read. */
  messageId: string
  /** Timestamp OF that message (see the migration caveat above). */
  timestamp: Date
  /**
   * The archive's own tie-break key for `messageId`, for counting unread
   * strictly-after a POSITION rather than a timestamp alone (two messages can
   * share a millisecond). OPTIONAL, deliberately: a pointer migrated from the
   * pre-#1081 legacy `lastSeenMessageId` + `lastReadAt` pair has only a
   * timestamp and no resolvable message position, so the key is legitimately
   * absent — counting then falls back to at-or-after-timestamp, which can
   * over-count the equal-ms set (the safe direction) rather than under-count.
   */
  archiveOrderKey?: ArchiveOrderKey
}

/**
 * The tie-break as it is written to disk: everything the key needs EXCEPT its
 * `id`, which is `messageId` and is reconstructed at hydration.
 *
 * The id was stored twice — once as `messageId`, once inside the key — and
 * nothing checked the two agreed. Since the ordering scan trusts the key as the
 * at-or-behind boundary, a disagreeing restored pointer could select a row that
 * is actually AHEAD of the read position, which is the unrecoverable direction
 * for a forward-only pointer. Not persisting the second copy makes that
 * disagreement unrepresentable rather than merely rejected at read time.
 *
 * `from` stays: it is the room archive's own `(from, id)` tie-break component
 * and is NOT derivable from the pointer.
 */
export type SerializedArchiveOrderKey = { kind: 'chat' } | { kind: 'room'; from: string }

/** JSON-safe form for localStorage. */
export interface SerializedReadPointer {
  messageId: string
  timestamp: number
  archiveOrderKey?: SerializedArchiveOrderKey
}

/** The minimal message shape a pointer can be built from. */
export interface PointerSource {
  id: string
  /** Sender's JID — needed for the ROOM archive order key's (from, id) tie-break. */
  from?: string
  timestamp: Date
}

/**
 * Build a pointer naming `message`. `kind` is required rather than guessed:
 * this module has no way to know whether it is serving a chat or a room, and
 * the two kinds break same-millisecond ties differently (see
 * {@link ArchiveOrderKey}) — the caller (chat store vs. room store) always
 * knows which, and must say so.
 */
export function makeReadPointer(message: PointerSource, kind: 'chat' | 'room'): ReadPointer {
  return {
    messageId: message.id,
    timestamp: message.timestamp,
    archiveOrderKey: makeArchiveOrderKey(message, kind),
  }
}

/**
 * Is `candidate` strictly further along than `current`?
 *
 * Timestamp first. A same-millisecond tie is broken by the archive order key —
 * but ONLY when both sides carry one (read-state PR C, D2). A key is what
 * certifies that a pointer's timestamp is its named message's own: pointers
 * built by `makeReadPointer` always have one, while a pointer migrated from the
 * pre-#1081 `lastSeenMessageId` + `lastReadAt` pair carries `lastReadAt` and no
 * key at all.
 *
 * Do NOT simplify this to `compareOrder(candidate, current) > 0`. `compareOrder`
 * sorts a MISSING key FIRST, which is the safe direction for a FLOOR
 * (under-advance -> over-count) and the UNSAFE direction for a POINTER: it would
 * let any keyed candidate overtake a migrated keyless pointer sharing its
 * millisecond, advancing a forward-only position past messages nothing has
 * proven were read. Same comparator, inverted safety. When either side is
 * keyless we fall back to strict millisecond comparison — today's behaviour,
 * preserved exactly where the position is not provable.
 */
export function isAhead(candidate: ReadPointer, current: ReadPointer | undefined): boolean {
  if (!current) return true
  const candidateMs = candidate.timestamp.getTime()
  const currentMs = current.timestamp.getTime()
  if (candidateMs !== currentMs) return candidateMs > currentMs

  const candidateKey = candidate.archiveOrderKey
  const currentKey = current.archiveOrderKey
  if (!candidateKey || !currentKey) return false

  return (
    compareOrder(
      { timestamp: candidateMs, archiveOrderKey: candidateKey },
      { timestamp: currentMs, archiveOrderKey: currentKey }
    ) > 0
  )
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
 * Write the pointer, with the tie-break stripped of its redundant `id` (see
 * {@link SerializedArchiveOrderKey}). The in-memory shape is unchanged; only
 * the on-disk form shrinks.
 *
 * An OLDER build reading this format validates the key with
 * `isValidArchiveOrderKey`, which requires `typeof k.id === 'string'` — so it
 * drops the key and degrades to the at-or-after-timestamp fallback, which
 * over-counts rather than under-counts (the safe, recoverable direction). The
 * `messageId` and `timestamp` it needs are untouched.
 */
export function serializeReadPointer(pointer: ReadPointer): SerializedReadPointer {
  const key = pointer.archiveOrderKey
  return {
    messageId: pointer.messageId,
    timestamp: pointer.timestamp.getTime(),
    ...(key ? { archiveOrderKey: key.kind === 'room' ? { kind: 'room', from: key.from } : { kind: 'chat' } } : {}),
  }
}

/**
 * Rebuild the tie-break from an untrusted persisted key, taking the id from
 * `messageId` — the pointer's one name for the message it points at.
 *
 * Any `id` still on disk (every key written before this format) is IGNORED
 * rather than read: it was always the same value, so ignoring it is lossless
 * for consistent data and is exactly the fix for inconsistent data. What
 * remains validated is what cannot be reconstructed: the `kind` discriminant,
 * and `from` for a room key. Anything else yields no key at all, which degrades
 * to the at-or-after-timestamp fallback (over-count, the safe direction).
 */
function hydrateArchiveOrderKey(raw: unknown, messageId: string): ArchiveOrderKey | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const k = raw as Record<string, unknown>
  if (k.kind === 'chat') return { kind: 'chat', id: messageId }
  if (k.kind === 'room' && typeof k.from === 'string') return { kind: 'room', from: k.from, id: messageId }
  return undefined
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
 *
 * `archiveOrderKey` is rebuilt by {@link hydrateArchiveOrderKey} — never taken
 * verbatim — and DROPPED when what it carries is unusable. Storage is untrusted
 * input, so a corrupt key must not ride through into ordering comparisons.
 * Dropping it alone (keeping the rest of the pointer) is deliberate: it degrades
 * to the at-or-after-timestamp fallback, which can over-count rather than
 * under-count (safe direction), without discarding a message id and timestamp
 * that are otherwise fine.
 */
export function deserializeReadPointer(raw: unknown): ReadPointer | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const { messageId, timestamp, archiveOrderKey } = raw as {
    messageId?: unknown
    timestamp?: unknown
    archiveOrderKey?: unknown
  }
  if (typeof messageId !== 'string' || messageId.length === 0) return undefined
  const validKey = hydrateArchiveOrderKey(archiveOrderKey, messageId)

  if (typeof timestamp === 'number') {
    return Number.isFinite(timestamp)
      ? { messageId, timestamp: new Date(timestamp), ...(validKey ? { archiveOrderKey: validKey } : {}) }
      : undefined
  }
  if (typeof timestamp === 'string') {
    const parsed = new Date(timestamp)
    return Number.isNaN(parsed.getTime())
      ? undefined
      : { messageId, timestamp: parsed, ...(validKey ? { archiveOrderKey: validKey } : {}) }
  }
  return undefined
}
