/**
 * Pure core for deriving unread state from the message archive.
 *
 * This is the total-order comparator and read-boundary floor that every later
 * PR-B derivation builds on. It knows nothing about stores, IndexedDB, or React
 * — only how to order two archive positions and where the read boundary sits.
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
 * The archive's own tie-break key for a message, kind-discriminated because
 * chat and room break same-millisecond ties differently:
 *
 * - Chat breaks ties by `id` only (the chat store's `keyPath: 'id'`,
 *   `messageCache.ts:140`).
 * - Room breaks ties by `from` then `id` (the `room_ts_from_id` index).
 *
 * Chat messages also carry `from`, so a generic "from then id" comparator
 * would be wrong for chat — the `kind` discriminant is what keeps the two
 * apart. Do not generalise this into a single shape.
 */
export type ArchiveOrderKey = { kind: 'chat'; id: string } | { kind: 'room'; from: string; id: string }

/** Build the kind-appropriate order key for a message. */
export function makeArchiveOrderKey(msg: { from?: string; id: string }, kind: 'chat' | 'room'): ArchiveOrderKey {
  return kind === 'room' ? { kind: 'room', from: msg.from ?? '', id: msg.id } : { kind: 'chat', id: msg.id }
}

/** A position in archive order: a timestamp, optionally refined by an order key. */
export interface OrderPosition {
  timestamp: number
  archiveOrderKey?: ArchiveOrderKey
}

/**
 * Total order over archive positions: timestamp first, then the kind-aware
 * tie-break key. A missing key sorts BEFORE a present one at an equal
 * timestamp — unresolved sorts first, which under-advances rather than
 * over-advances (under-counting unread is the recoverable direction).
 */
export function compareOrder(a: OrderPosition, b: OrderPosition): number {
  if (a.timestamp !== b.timestamp) return a.timestamp - b.timestamp
  const ak = a.archiveOrderKey,
    bk = b.archiveOrderKey
  if (!ak && !bk) return 0
  if (!ak) return -1 // unresolved sorts first → under-advance → over-count (safe)
  if (!bk) return 1
  if (ak.kind === 'room' && bk.kind === 'room') {
    if (ak.from !== bk.from) return ak.from < bk.from ? -1 : 1
    return ak.id < bk.id ? -1 : ak.id > bk.id ? 1 : 0
  }
  return ak.id < bk.id ? -1 : ak.id > bk.id ? 1 : 0 // chat: id only
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

/** Runtime guard for an `ArchiveOrderKey` read back from untrusted storage. */
export function isValidArchiveOrderKey(v: unknown): v is ArchiveOrderKey {
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
