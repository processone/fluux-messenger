/**
 * Pure core for deriving unread state from the message archive.
 *
 * This is the total-order comparator and read-boundary floor that every later
 * PR-B derivation builds on. It knows nothing about stores, IndexedDB, or React
 * — only how to order two message-cache positions and where the read boundary
 * sits.
 *
 * All functions here are pure.
 */

import type { ReadPointer } from './readPointer'

/**
 * Re-exported so the live `+1` fast path (`notificationState.ts`) and the
 * archive cursor walk (`messageCache.ts`) import the SAME function from the
 * SAME module — both literally call `isRenderableStoredMessage`, so the two
 * can never independently drift into checking slightly different things.
 */
export { isRenderableStoredMessage, type RenderabilityCheckFields } from '../../utils/messageRenderability'

/**
 * The IndexedDB message cache's own tie-break key for a message, built from the
 * CLIENT message id. It has never held an archive id, and could not: XEP-0313
 * §6.2 makes archive ids opaque strings with no guarantee of being numeric,
 * sequenced or globally unique, and unique only per archive — they carry no
 * ordering. This key is chosen to agree with the cache's cursors, and is
 * kind-discriminated because chat and room break same-millisecond ties
 * differently:
 *
 * - Chat breaks ties by `id` only (the chat store's `keyPath: 'id'`,
 *   `messageCache.ts:140`).
 * - Room breaks ties by `from` then `id` (the `room_ts_from_id` index).
 *
 * Chat messages also carry `from`, so a generic "from then id" comparator
 * would be wrong for chat — the `kind` discriminant is what keeps the two
 * apart. Do not generalise this into a single shape.
 */
export type CacheOrderKey = { kind: 'chat'; id: string } | { kind: 'room'; from: string; id: string }

/** Build the kind-appropriate order key for a message. */
export function makeCacheOrderKey(msg: { from?: string; id: string }, kind: 'chat' | 'room'): CacheOrderKey {
  return kind === 'room' ? { kind: 'room', from: msg.from ?? '', id: msg.id } : { kind: 'chat', id: msg.id }
}

/**
 * A position in message-cache order: a timestamp, optionally refined by a key.
 *
 * The tie-break is optional because a pointer migrated from the pre-#1081
 * `lastSeenMessageId` + `lastReadAt` pair carries only a millisecond, with no
 * provable position inside it. Such a value is a FLOOR — it means "at least
 * here", not "exactly here".
 *
 * {@link ExactPosition} is the refinement that does mean "exactly here". Prefer
 * it wherever a position is genuinely resolvable — every message resolves to
 * one, because {@link makeCacheOrderKey} always produces a key — so that the
 * compiler, rather than a comment, is what keeps a floor out of a comparison
 * that assumes exactness.
 */
export interface OrderPosition {
  timestamp: number
  tiebreak?: CacheOrderKey
}

/**
 * A position whose tie-break is known, so it can be ordered exactly against
 * another such position.
 *
 * An `OrderPosition` is deliberately NOT assignable to this (#1173): the only
 * way to obtain one is to actually have a tie-break, which in practice means
 * the position came from a message rather than from a bare `lastReadAt`.
 */
export interface ExactPosition extends OrderPosition {
  tiebreak: CacheOrderKey
}

/**
 * Break a same-millisecond tie between two known tie-breaks. Kind-aware: chat
 * compares `id` only, room compares `from` then `id` — see {@link CacheOrderKey}
 * for why one generic shape would be wrong.
 *
 * Private, and takes the KEYS rather than the positions, so it cannot be
 * mistaken for a general comparator over positions and cannot be reached with a
 * keyless one. The three functions below are the only entry points.
 */
function compareTiebreak(a: CacheOrderKey, b: CacheOrderKey): number {
  if (a.kind === 'room' && b.kind === 'room') {
    if (a.from !== b.from) return a.from < b.from ? -1 : 1
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
  }
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0 // chat: id only
}

/**
 * Total order over two positions that are BOTH exact — timestamp first, then
 * the tie-break. This is the comparator for ordering messages against each
 * other: sorting a resident array, picking the newest of a candidate set.
 *
 * It deliberately has no answer for a keyless position, because there is no
 * single right one. The two questions the codebase actually asks —
 * {@link isAfterBoundary} and {@link mayAdvanceTo} — have OPPOSITE
 * missing-tie-break rules, so a comparator that picked one of them would be
 * silently wrong at every call site that meant the other. That was #1173.
 * Passing a possibly-keyless `OrderPosition` here does not compile.
 */
export function compareExact(a: ExactPosition, b: ExactPosition): number {
  if (a.timestamp !== b.timestamp) return a.timestamp - b.timestamp
  return compareTiebreak(a.tiebreak, b.tiebreak)
}

/**
 * "Is this row after the read boundary?" — the COUNTING and DIVIDER question.
 *
 * A missing tie-break on the BOUNDARY means AT-OR-AFTER its timestamp: every
 * row sharing the boundary's millisecond, including the boundary's own message,
 * counts as after it. That over-counts by up to the same-millisecond sibling
 * set, which is the recoverable direction — an over-count clears the moment the
 * user reads, while an under-count hides a message permanently.
 *
 * `row` is an {@link ExactPosition} because an archive row always resolves to
 * one. That is not a formality: it is what stops this function from being used
 * to answer the advance question, where this same rule is unsafe (#1173).
 */
export function isAfterBoundary(row: ExactPosition, boundary: OrderPosition): boolean {
  if (row.timestamp !== boundary.timestamp) return row.timestamp > boundary.timestamp
  if (!boundary.tiebreak) return true // at-or-after timestamp → over-count (safe)
  return compareTiebreak(row.tiebreak, boundary.tiebreak) > 0
}

/**
 * "May the read pointer advance to this?" — the ADVANCE and SEEN question.
 *
 * A missing tie-break on EITHER side means STRICT MILLISECOND: never overtake.
 * The key is what certifies that a pointer's timestamp is its named message's
 * own, so when either side lacks one, nothing about their relative order within
 * a shared millisecond is provable. The read pointer is forward-only, so a
 * position given away here is unrecoverable; refusing to move merely
 * over-counts, which the user clears by reading.
 *
 * This is the exact inverse of {@link isAfterBoundary}'s rule, on purpose. The
 * two questions are not interchangeable — that is why they are two functions
 * (#1173) rather than one comparator with a warning attached to it.
 */
export function mayAdvanceTo(candidate: OrderPosition, current: OrderPosition): boolean {
  if (candidate.timestamp !== current.timestamp) return candidate.timestamp > current.timestamp
  if (!candidate.tiebreak || !current.tiebreak) return false // strict ms → never overtake (safe)
  return compareTiebreak(candidate.tiebreak, current.tiebreak) > 0
}

/**
 * The floor every unread derivation counts from: the read pointer wins when
 * present, otherwise fall back to the entity's history watermark. This is
 * deliberately NOT the later of the two — see the test named "pointer-wins,
 * not max" for why a `max()` form is wrong: a pointer migrated from the
 * pre-#1081 legacy fields can sit behind a `historyFloor` computed as "now",
 * and taking the max would silently jump the floor forward past a genuine
 * read position.
 */
export function computeFloor(pointer: ReadPointer | undefined, historyFloor: Date | undefined): Date | undefined {
  return pointer ? pointer.timestamp : historyFloor
}

/**
 * True when a pointerless entity still carries a nonzero persisted unread
 * count — a state that cannot be trusted to mean "zero unread" and must defer
 * to a fuller derivation rather than reporting a bare zero.
 */
export function pointerlessDefers(pointer: ReadPointer | undefined, persistedUnread: number): boolean {
  return !pointer && persistedUnread > 0
}

/**
 * Whether an entity's notification state has anything a deactivation-triggered
 * recount could possibly correct (read-state final-fix-2).
 *
 * A truly fresh entity — never read (no pointer ever established) AND already
 * showing zero unread — has nothing to reconcile: there is no stale count to
 * catch up, and no pointer whose archive-derived position could differ from
 * what's shown. Recomputing anyway costs a real cache/archive read for no
 * possible benefit, on every close of a conversation/room the user never even
 * opened for real. An entity with EITHER a pointer (it was genuinely read to
 * some position, which may have advanced further than the last commit) or a
 * nonzero count (which may itself be stale) is worth reconciling.
 */
export function worthReconcilingOnDeactivate(
  meta: { readPointer?: ReadPointer; unreadCount: number } | undefined
): boolean {
  if (!meta) return false
  return meta.readPointer !== undefined || meta.unreadCount > 0
}

/**
 * Runtime guard for a `CacheOrderKey` read back from untrusted storage.
 *
 * No longer on the hydration path: `deserializeReadPointer` rebuilds the key
 * and takes its `id` from `messageId` instead of validating a persisted one.
 * It is kept because it still describes how an OLDER build reads today's
 * on-disk form — the `typeof k.id === 'string'` requirement is what makes an
 * old build drop the new id-less key and degrade to the at-or-after-timestamp
 * fallback (over-count, the safe direction) instead of mis-reading it. That
 * compatibility claim is asserted against this function in `readPointer.test.ts`.
 */
export function isValidCacheOrderKey(v: unknown): v is CacheOrderKey {
  if (!v || typeof v !== 'object') return false
  const k = v as Record<string, unknown>
  if (k.kind === 'chat') return typeof k.id === 'string'
  if (k.kind === 'room') return typeof k.id === 'string' && typeof k.from === 'string'
  return false
}

/**
 * The result of deriving unread state for one conversation/room. Derives
 * `unread` only — mentions stay on the existing live `+1` counter, cleared by
 * explicit read / mark-read (see `countRoomUnreadInArchive` in
 * `messageCache.ts` for why an archive scan cannot recount mentions).
 */
export type RecomputeOutcome =
  | { kind: 'exact'; unread: number }
  | { kind: 'deferred' }
  | { kind: 'unavailable' }
