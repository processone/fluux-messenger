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

import { mayAdvanceTo, makeCacheOrderKey, type CacheOrderKey } from './readState'

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
   * The message cache's tie-break key for `messageId`, for counting unread
   * strictly-after a POSITION rather than a timestamp alone (two messages can
   * share a millisecond). OPTIONAL, deliberately: a pointer migrated from the
   * pre-#1081 legacy `lastSeenMessageId` + `lastReadAt` pair has only a
   * timestamp and no resolvable message position, so the key is legitimately
   * absent — counting then falls back to at-or-after-timestamp, which can
   * over-count the equal-ms set (the safe direction) rather than under-count.
   */
  tiebreak?: CacheOrderKey
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
 * `from` stays: it is the room cache's `(from, id)` tie-break component
 * and is NOT derivable from the pointer.
 */
export type SerializedCacheOrderKey = { kind: 'chat' } | { kind: 'room'; from: string }

/**
 * JSON-safe form for localStorage.
 *
 * The persisted property is `tiebreak`, matching the in-memory field. Builds
 * before this one wrote it as `archiveOrderKey` — a name that was always wrong
 * (the key never held an archive id; it is the IndexedDB cursor tie-break built
 * from the CLIENT message id). Those blobs are still READ, by the fallback in
 * {@link deserializeReadPointer}, which is where the condition for eventually
 * deleting that tolerance is recorded.
 */
export interface SerializedReadPointer {
  messageId: string
  timestamp: number
  tiebreak?: SerializedCacheOrderKey
}

/** The minimal message shape a pointer can be built from. */
export interface PointerSource {
  id: string
  /** Sender's JID — needed for the ROOM cache order key's (from, id) tie-break. */
  from?: string
  timestamp: Date
}

/**
 * Build a pointer naming `message`. `kind` is required rather than guessed:
 * this module has no way to know whether it is serving a chat or a room, and
 * the two kinds break same-millisecond ties differently (see
 * {@link CacheOrderKey}) — the caller (chat store vs. room store) always
 * knows which, and must say so.
 */
export function makeReadPointer(message: PointerSource, kind: 'chat' | 'room'): ReadPointer {
  return {
    messageId: message.id,
    timestamp: message.timestamp,
    tiebreak: makeCacheOrderKey(message, kind),
  }
}

/**
 * Is `candidate` strictly further along than `current`?
 *
 * This is the ADVANCE question, so it is answered by {@link mayAdvanceTo}: a
 * same-millisecond tie is broken by the cache order key ONLY when both sides
 * carry one (read-state PR C, D2), and otherwise it refuses to move. A key is
 * what certifies that a pointer's timestamp is its named message's own —
 * pointers built by `makeReadPointer` always have one, while a pointer migrated
 * from the pre-#1081 `lastSeenMessageId` + `lastReadAt` pair carries
 * `lastReadAt` and no key at all.
 *
 * The counting question's comparator (`isAfterBoundary`) has the OPPOSITE
 * missing-key rule and must never be substituted here — it would let any keyed
 * candidate overtake a migrated keyless pointer sharing its millisecond,
 * advancing a forward-only position past messages nothing has proven were read.
 * That used to be guarded by this comment alone (#1173); it is now guarded by
 * the type — `isAfterBoundary` takes an `ExactPosition` row, which a pointer,
 * being possibly keyless, is not. See `readState.enforcement.test.ts`.
 */
export function isAhead(candidate: ReadPointer, current: ReadPointer | undefined): boolean {
  if (!current) return true
  return mayAdvanceTo(
    { timestamp: candidate.timestamp.getTime(), tiebreak: candidate.tiebreak },
    { timestamp: current.timestamp.getTime(), tiebreak: current.tiebreak }
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
 * {@link SerializedCacheOrderKey}). The in-memory key keeps its full shape;
 * only the on-disk form omits the redundant `id`.
 *
 * An OLDER build reading this format finds no tie-break at all: it looks only
 * under `archiveOrderKey` (and would reject this id-less key anyway, via
 * `isValidCacheOrderKey`'s `typeof k.id === 'string'` requirement). It
 * therefore degrades to the at-or-after-timestamp fallback, which over-counts
 * rather than under-counts — the safe, recoverable direction, since a keyless
 * pointer can only UNDER-advance. The `messageId` and `timestamp` it needs are
 * untouched. Asserted in `readPointer.test.ts` against a replica of that
 * build's read, not assumed.
 */
export function serializeReadPointer(pointer: ReadPointer): SerializedReadPointer {
  const key = pointer.tiebreak
  return {
    messageId: pointer.messageId,
    timestamp: pointer.timestamp.getTime(),
    // The on-disk name is `tiebreak`, the same as in memory. `archiveOrderKey`
    // is read back but never written — see {@link deserializeReadPointer}.
    ...(key ? { tiebreak: key.kind === 'room' ? { kind: 'room', from: key.from } : { kind: 'chat' } } : {}),
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
function hydrateCacheOrderKey(raw: unknown, messageId: string): CacheOrderKey | undefined {
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
 * {@link serializeReadPointer} writes epoch ms; the chat storage blob writes an
 * ISO string through its plain `JSON.stringify`.
 *
 * The tie-break is likewise accepted under either name — `tiebreak` (what we
 * write) or the historical `archiveOrderKey` — and the condition for eventually
 * dropping that second name is recorded at the fallback itself.
 *
 * `tiebreak` is rebuilt by {@link hydrateCacheOrderKey} — never taken
 * verbatim — and DROPPED when what it carries is unusable. Storage is untrusted
 * input, so a corrupt key must not ride through into ordering comparisons.
 * Dropping it alone (keeping the rest of the pointer) is deliberate: it degrades
 * to the at-or-after-timestamp fallback, which can over-count rather than
 * under-count (safe direction), without discarding a message id and timestamp
 * that are otherwise fine.
 */
export function deserializeReadPointer(raw: unknown): ReadPointer | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const { messageId, timestamp, tiebreak, archiveOrderKey } = raw as {
    messageId?: unknown
    timestamp?: unknown
    tiebreak?: unknown
    archiveOrderKey?: unknown
  }
  if (typeof messageId !== 'string' || messageId.length === 0) return undefined
  // Same shape as the `timestamp` tolerance above: this is the one place that
  // reads either name back. We still only ever WRITE `tiebreak`; the
  // `archiveOrderKey` branch is read-only tolerance for blobs written before the
  // on-disk rename.
  //
  // REMOVABLE WHEN storage still holding the old name no longer matters, which
  // is a bounded condition rather than "forever": every writer re-serializes the
  // WHOLE blob, not the row that changed — `saveRoomReadState` stringifies the
  // entire room map, the chat persist adapter re-emits every `conversationMeta`
  // entry, and the state snapshot re-serializes every room. So the FIRST persist
  // any build from this one onwards performs sheds `archiveOrderKey` for the
  // entire account, not merely for the conversation that was read; an account
  // opened once after upgrading is fully converted, dormant ones are not.
  // Deleting this branch then costs those dormant pointers their tie-break and
  // nothing else — `messageId` and `timestamp` still load, so they degrade to
  // the at-or-after-timestamp fallback (over-count, the recoverable direction),
  // never to a lost read position. Remove it once that trade is acceptable for
  // the oldest storage still in the field.
  const validKey = hydrateCacheOrderKey(tiebreak ?? archiveOrderKey, messageId)

  if (typeof timestamp === 'number') {
    return Number.isFinite(timestamp)
      ? { messageId, timestamp: new Date(timestamp), ...(validKey ? { tiebreak: validKey } : {}) }
      : undefined
  }
  if (typeof timestamp === 'string') {
    const parsed = new Date(timestamp)
    return Number.isNaN(parsed.getTime())
      ? undefined
      : { messageId, timestamp: parsed, ...(validKey ? { tiebreak: validKey } : {}) }
  }
  return undefined
}
