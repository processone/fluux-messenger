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

import type {
  CacheOrderKey,
  ExactPosition,
  PointerOrder,
  ReadPointer,
} from '../../core/types/readState'

/**
 * Re-exported so the live `+1` fast path (`notificationState.ts`) and the
 * archive cursor walk (`messageCache.ts`) import the SAME function from the
 * SAME module — both literally call `isRenderableStoredMessage`, so the two
 * can never independently drift into checking slightly different things.
 */
export { isRenderableStoredMessage, type RenderabilityCheckFields } from '../../utils/messageRenderability'

/**
 * The cache-order types are declared in `core/types/readState.ts` — they are
 * domain types on the SDK's public surface, and `core/types` must not depend on
 * a store. They are re-exported here because this module owns the comparators
 * that operate on them, and every consumer of a comparator wants both.
 */
export type { CacheOrderKey, ExactPosition, FloorPosition, PointerOrder } from '../../core/types/readState'

/** Build the kind-appropriate order key for a message. */
export function makeCacheOrderKey(msg: { from?: string; id: string }, kind: 'chat' | 'room'): CacheOrderKey {
  return kind === 'room' ? { kind: 'room', from: msg.from ?? '', id: msg.id } : { kind: 'chat', id: msg.id }
}

/**
 * The exact cache-order position of a real message.
 *
 * The one place the `{ role, timestamp, tiebreak }` literal is assembled, so
 * the kind-discriminated tie-break rule (see {@link CacheOrderKey}) cannot be
 * re-spelled slightly differently at one of the many sites that need a row's
 * position.
 */
export function exactPosition(
  msg: { from?: string; id: string; timestamp: Date },
  kind: 'chat' | 'room'
): ExactPosition {
  return { role: 'exact', timestamp: msg.timestamp.getTime(), tiebreak: makeCacheOrderKey(msg, kind) }
}

/**
 * Break a same-millisecond tie between two known tie-breaks. Kind-aware: chat
 * compares `id` only, room compares `from` then `id` — see {@link CacheOrderKey}
 * for why one generic shape would be wrong.
 *
 * Private, and takes the KEYS rather than the positions, so it cannot be
 * mistaken for a general comparator over positions and cannot be reached with a
 * floor one. The three functions below are the only entry points.
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
 * It deliberately has no answer for a floor position, because there is no
 * single right one. The two questions the codebase actually asks —
 * {@link isAfterBoundary} and {@link mayAdvanceTo} — have OPPOSITE floor rules,
 * so a comparator that picked one of them would be silently wrong at every call
 * site that meant the other. That was #1173.
 * Passing a possibly-floor {@link PointerOrder} here does not compile.
 */
export function compareExact(a: ExactPosition, b: ExactPosition): number {
  if (a.timestamp !== b.timestamp) return a.timestamp - b.timestamp
  return compareTiebreak(a.tiebreak, b.tiebreak)
}

/**
 * "Is this row after the read boundary?" — the COUNTING and DIVIDER question.
 *
 * A FLOOR boundary means AT-OR-AFTER its timestamp: every row sharing the
 * boundary's millisecond, including the boundary's own message, counts as after
 * it. That over-counts by up to the same-millisecond sibling set, which is the
 * recoverable direction — an over-count clears the moment the user reads, while
 * an under-count hides a message permanently.
 *
 * `row` is an {@link ExactPosition} because an archive row always resolves to
 * one. That is not a formality: it is what stops this function from being used
 * to answer the advance question, where this same rule is unsafe (#1173).
 */
export function isAfterBoundary(row: ExactPosition, boundary: PointerOrder): boolean {
  if (boundary.role === 'floor') return row.timestamp >= boundary.timestamp // over-count (safe)
  if (row.timestamp !== boundary.timestamp) return row.timestamp > boundary.timestamp
  return compareTiebreak(row.tiebreak, boundary.tiebreak) > 0
}

/**
 * "May the read pointer advance to this?" — the ADVANCE and SEEN question.
 *
 * A FLOOR on EITHER side means STRICT MILLISECOND: never overtake. An exact
 * position certifies that a timestamp is its named message's own, so when
 * either side is only a floor, nothing about their relative order within a
 * shared millisecond is provable. The read pointer is forward-only, so a
 * position given away here is unrecoverable; refusing to move merely
 * over-counts, which the user clears by reading.
 *
 * `candidate` is a {@link PointerOrder} rather than an `ExactPosition` because
 * a pointer migrated from the legacy pair really is a floor and really does get
 * offered as a candidate (`advance`, the #1081 backfill) — the floor rule below
 * is the answer for it, not a signature to tighten away.
 *
 * This is the exact inverse of {@link isAfterBoundary}'s rule, on purpose. The
 * two questions are not interchangeable — that is why they are two functions
 * (#1173) rather than one comparator with a warning attached to it.
 */
export function mayAdvanceTo(candidate: PointerOrder, current: PointerOrder): boolean {
  if (candidate.role === 'floor' || current.role === 'floor') {
    return candidate.timestamp > current.timestamp // strict ms → never overtake (safe)
  }
  if (candidate.timestamp !== current.timestamp) return candidate.timestamp > current.timestamp
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
  return pointer ? new Date(pointer.order.timestamp) : historyFloor
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
 * The result of deriving unread state for one conversation/room. Derives
 * `unread` only — mentions stay on the existing live `+1` counter, cleared by
 * explicit read / mark-read (see `countRoomUnreadInArchive` in
 * `messageCache.ts` for why an archive scan cannot recount mentions).
 */
export type RecomputeOutcome =
  | { kind: 'exact'; unread: number }
  | { kind: 'deferred' }
  | { kind: 'unavailable' }
