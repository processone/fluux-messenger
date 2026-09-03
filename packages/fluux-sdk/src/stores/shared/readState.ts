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

/**
 * Build the kind-appropriate order key for a message.
 *
 * `occupantId` is read for a ROOM key only. A chat message has no XEP-0421
 * occupant, and admitting one here would give the chat cache a tie-break
 * component its `keyPath: 'id'` store cannot reproduce.
 */
export function makeCacheOrderKey(
  msg: { from?: string; id: string; occupantId?: string },
  kind: 'chat' | 'room'
): CacheOrderKey {
  if (kind !== 'room') return { kind: 'chat', id: msg.id }
  return {
    kind: 'room',
    from: msg.from ?? '',
    id: msg.id,
    ...(msg.occupantId ? { occupantId: msg.occupantId } : {}),
  }
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
  msg: { from?: string; id: string; occupantId?: string; timestamp: Date },
  kind: 'chat' | 'room'
): ExactPosition {
  return { role: 'exact', timestamp: msg.timestamp.getTime(), tiebreak: makeCacheOrderKey(msg, kind) }
}

/**
 * Break a same-millisecond tie between two known tie-breaks. Kind-aware: chat
 * compares `id` only, room compares `from`, then `id`, then the occupant-id —
 * see {@link CacheOrderKey} for why one generic shape would be wrong.
 *
 * Private, and takes the KEYS rather than the positions, so it cannot be
 * mistaken for a general comparator over positions and cannot be reached with a
 * floor one. The three functions below are the only entry points.
 */
function compareTiebreak(a: CacheOrderKey, b: CacheOrderKey): number {
  if (a.kind === 'room' && b.kind === 'room') {
    if (a.from !== b.from) return a.from < b.from ? -1 : 1
    if (a.id !== b.id) return a.id < b.id ? -1 : 1
    // An absent occupant-id sorts FIRST. The direction is arbitrary; being
    // TOTAL is not. A rule that made an absent occupant compare equal to every
    // present one would be intransitive — absent = A and absent = B while
    // A < B — and `sortMessagesByTimestamp` feeds this straight to
    // `Array.prototype.sort`, which answers an intransitive comparator with an
    // arbitrary permutation. The resident order is what the viewport observer
    // walks, so that permutation would move the read pointer.
    //
    // Whether the pair is DECIDABLE at all is a separate question, and the two
    // callers below answer it differently — see {@link occupantEvidenceMissing}.
    const ao = a.occupantId ?? ''
    const bo = b.occupantId ?? ''
    return ao < bo ? -1 : ao > bo ? 1 : 0
  }
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0 // chat: id only
}

/**
 * Whether two keys name the same room row but only ONE of them knows which
 * occupant wrote it.
 *
 * This is the rung's "no evidence" state, and it is not hypothetical: a pointer
 * hydrated from a blob written before the occupant-id was carried has none and
 * can never acquire one, while the row it names does. Every existing room meets
 * this pair on first read.
 *
 * An absent occupant-id must not SEPARATE two copies — `occupantConflict` in
 * `utils/messageIdentity.ts` — so the order {@link compareTiebreak} imposes on
 * such a pair is a convention, not a fact, and a caller that must not be wrong
 * has to ask this instead of reading that order.
 */
function occupantEvidenceMissing(a: CacheOrderKey, b: CacheOrderKey): boolean {
  if (a.kind !== 'room' || b.kind !== 'room') return false
  if (a.from !== b.from || a.id !== b.id) return false
  return (a.occupantId === undefined) !== (b.occupantId === undefined)
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
 * it. That over-counts by up to the same-millisecond sibling set, choosing the
 * recoverable direction: a later pointer advance can correct an over-count,
 * while an under-count hides a message permanently. The occupant-evidence
 * branch below has one accepted, narrower case that reading does not clear.
 *
 * `row` is an {@link ExactPosition} because an archive row always resolves to
 * one. That is not a formality: it is what stops this function from being used
 * to answer the advance question, where this same rule is unsafe (#1173).
 */
export function isAfterBoundary(row: ExactPosition, boundary: PointerOrder): boolean {
  if (boundary.role === 'floor') return row.timestamp >= boundary.timestamp // over-count (safe)
  if (row.timestamp !== boundary.timestamp) return row.timestamp > boundary.timestamp
  // No occupant evidence — the same choice the floor branch above makes, one
  // rung down. This DIRECTION IS A DECISION, not a consequence of how the
  // operators happen to order a missing value: counting protects a genuinely
  // unread row from disappearing whenever the boundary names an occupant.
  //
  // Accepted limit: three separate rows can share one millisecond, sender JID
  // and client id when one was written before occupant identity was carried and
  // the other two carry conflicting occupant ids, keeping all three separate.
  // Once the pointer names one of those qualified occupants, the occupant-less
  // row counts as unread and reading does not clear it: the advance question
  // will not move the pointer backwards within the shared millisecond. Zero
  // occurrences of even the two-row mixed form were found across 50,163 real
  // cached room rows; the wider same-room, same-millisecond superset had 11
  // pairs (0.02%), and this three-row shape is narrower still. This is accepted
  // rather than overlooked. It ends for the legacy row once a new mint carrying
  // occupant identity replaces its pre-change representation, because the
  // comparison is then no longer mixed.
  if (occupantEvidenceMissing(row.tiebreak, boundary.tiebreak)) return true
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
 * over-counts, which a later provable pointer advance can correct.
 *
 * `candidate` is a {@link PointerOrder} rather than an `ExactPosition` because
 * a pointer migrated from the legacy pair really is a floor and really does get
 * offered as a candidate (`advance`, the #1081 backfill) — the floor rule below
 * is the answer for it, not a signature to tighten away.
 *
 * This is the exact inverse of {@link isAfterBoundary}'s rule, on purpose. The
 * two questions are not interchangeable — that is why they are two functions
 * (#1173) rather than one comparator with a warning attached to it.
 *
 * The occupant rung is where the two stop being mirror images. In the clearable
 * direction, a pointer holding no occupant-id may advance onto a row that names
 * one. Refusing there would strand the pointer: the pair shares a millisecond,
 * so no later position could lift it. Advancing refines the pointer's name
 * rather than overtaking a message, and the next mint carries the occupant-id.
 * In the opposite direction, a row holding no occupant-id cannot move a pointer
 * that already names one; the total order refuses that backwards move. This is
 * the accepted non-clearing limit described at {@link isAfterBoundary}.
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
 * recount could possibly correct.
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
