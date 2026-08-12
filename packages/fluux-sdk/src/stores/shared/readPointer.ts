/**
 * The read pointer — where the user has read to.
 *
 * A read position has ONE order and TWO names, and they answer different
 * questions:
 *
 * - **order** — `(timestamp, tiebreak)`. The only comparable data. Local,
 *   derived from the message cache's own cursor order, and never rewritten.
 * - **local name** — `messageId`. Resolves against the cache and the DOM, which
 *   is keyed by it. Every pointer has one.
 * - **wire name** — the XEP-0359 archive id. The only cross-device identity, and
 *   the only thing XEP-0490 can publish. NOT every pointer has one.
 *
 * The archive id cannot replace the order: XEP-0313 §6.2 makes archive ids
 * opaque strings that carry no ordering and are unique only per archive. And the
 * order cannot address the wire: a receiver MUST ignore an id it cannot find,
 * and the tie-break holds the CLIENT message id. So the pointer carries both,
 * minted together from one message, never independently writable.
 *
 * "We cannot address this position yet" is therefore a STATE
 * ({@link PointerIdentity}'s `local` variant), not an absent field each consumer
 * rediscovers. Every consumer must handle it to compile.
 *
 * This replaces the `lastSeenMessageId` + `lastReadAt` pair, which were two
 * independent fields describing one fact and drifted apart in practice (issue
 * #1081). Here they are one object. You cannot write half of it. The timestamp
 * is denormalised from the message the name identifies, which is what keeps
 * ordering comparisons synchronous and O(1) — the message cache is then needed
 * only for counting, not for deciding which of two positions is further along.
 *
 * All functions here are pure.
 */

import { mayAdvanceTo, exactPosition } from './readState'
import type {
  CacheOrderKey,
  PointerIdentity,
  ReadPointer,
} from '../../core/types/readState'

/**
 * The pointer types are declared in `core/types/readState.ts` — they are domain
 * types on the SDK's public surface, and `core/types` must not depend on a
 * store. They are re-exported here because this module owns the constructors
 * and comparators, and every consumer of those wants both.
 */
export type { PointerIdentity, ReadPointer } from '../../core/types/readState'

/**
 * The order as it is written to disk: everything the tie-break needs EXCEPT its
 * `id`, which is `identity.messageId` and is reconstructed at hydration.
 *
 * The id was stored twice — once as the name, once inside the key — and nothing
 * checked the two agreed. Since the ordering scan trusts the key as the
 * at-or-behind boundary, a disagreeing restored pointer could select a row that
 * is actually AHEAD of the read position, which is the unrecoverable direction
 * for a forward-only pointer. Not persisting the second copy makes that
 * disagreement unrepresentable rather than merely rejected at read time.
 *
 * `from` stays: it is the room cache's `(from, id)` tie-break component and is
 * NOT derivable from the pointer.
 */
export type SerializedCacheOrderKey = { kind: 'chat' } | { kind: 'room'; from: string }

export type SerializedPointerOrder =
  | { role: 'exact'; timestamp: number; tiebreak: SerializedCacheOrderKey }
  | { role: 'floor'; timestamp: number }

/**
 * JSON-safe form for localStorage.
 *
 * Mirrors the in-memory shape, which matters because the two persistence paths
 * do NOT agree on how they write: room read state and the state snapshot call
 * {@link serializeReadPointer}, while a chat pointer riding inside
 * `conversationMeta` is written by a plain `JSON.stringify` of the live object.
 * Keeping the serialized shape structurally identical to the live one means
 * both paths produce the SAME on-disk shape, so {@link deserializeReadPointer}
 * has one current format to read rather than two. The only difference the
 * explicit serializer makes is dropping the tie-break's redundant `id`; the
 * blob path leaves it in, and hydration ignores it either way.
 */
export interface SerializedReadPointer {
  order: SerializedPointerOrder
  identity: PointerIdentity
}

/** The minimal message shape a pointer can be built from. */
export interface PointerSource {
  id: string
  /** Sender's JID — needed for the ROOM cache order key's (from, id) tie-break. */
  from?: string
  timestamp: Date
  /**
   * The message's XEP-0359 archive id, when it has one.
   *
   * This is what makes the minted pointer `addressable`, and taking it from the
   * SAME message the pointer names is what binds the wire name to this position
   * by IDENTITY. Never source it from a neighbouring row, a timestamp match, or
   * a shared `origin-id`: that would give a correctly-ordered pointer a FOREIGN
   * name, which is the defect this whole shape exists to make unrepresentable.
   */
  stanzaId?: string
}

/**
 * Build a pointer naming `message`. `kind` is required rather than guessed:
 * this module has no way to know whether it is serving a chat or a room, and
 * the two kinds break same-millisecond ties differently (see
 * {@link CacheOrderKey}) — the caller (chat store vs. room store) always
 * knows which, and must say so.
 *
 * The identity is `addressable` exactly when the message already carries an
 * archive id. That is the free convergence path: every peer message, and every
 * MUC reflection, mints an immediately publishable pointer. A message with no
 * archive id mints `local`, which is honest rather than degraded-by-omission.
 */
export function makeReadPointer(message: PointerSource, kind: 'chat' | 'room'): ReadPointer {
  return {
    order: exactPosition(message, kind),
    identity: message.stanzaId
      ? { state: 'addressable', messageId: message.id, archiveId: message.stanzaId }
      : { state: 'local', messageId: message.id },
  }
}

/**
 * Forward NAME convergence: attach a now-known archive id to a `local` pointer.
 *
 * Three rules, and each of them is load-bearing:
 *
 * 1. **It touches `identity` only.** `order` is carried by reference, so
 *    convergence cannot move the cursor — the pointer names a position it
 *    already held, it does not acquire a new one.
 * 2. **The caller must bind by IDENTITY.** `archiveId` has to come from the very
 *    message `identity.messageId` names. Matching by timestamp, or by an
 *    `origin-id` two rows share, would attach a foreign wire name to a correct
 *    order — the same defect at a new site. The repository's existing
 *    enrichment machinery (`backfillArchiveIds`) is already identity-keyed;
 *    keep it that way.
 * 3. **A `floor` pointer is never enriched.** Its name and its order already
 *    disagree — `lastReadAt` can sit behind the message it names — so giving it
 *    a wire name would widen a visible inconsistency instead of fixing one.
 *
 * Returns `pointer` BY REFERENCE when nothing changes, so Zustand selectors can
 * skip the re-render.
 */
export function withArchiveId(pointer: ReadPointer, archiveId: string): ReadPointer {
  if (pointer.identity.state === 'addressable') return pointer
  if (pointer.order.role === 'floor') return pointer
  if (archiveId.length === 0) return pointer
  return {
    order: pointer.order,
    identity: { state: 'addressable', messageId: pointer.identity.messageId, archiveId },
  }
}

/**
 * Is `candidate` strictly further along than `current`?
 *
 * This is the ADVANCE question, so it is answered by {@link mayAdvanceTo}: a
 * same-millisecond tie is broken by the cache order key ONLY when both sides are
 * `exact`, and otherwise it refuses to move. An exact
 * order is what certifies that a pointer's timestamp is its named message's
 * own — pointers built by `makeReadPointer` always have one, while a pointer
 * migrated from the pre-#1081 `lastSeenMessageId` + `lastReadAt` pair carries
 * `lastReadAt` and is a `floor`.
 *
 * The counting question's comparator (`isAfterBoundary`) has the OPPOSITE
 * floor rule and must never be substituted here — it would let any exact
 * candidate overtake a migrated floor pointer sharing its millisecond,
 * advancing a forward-only position past messages nothing has proven were read.
 * That used to be guarded by this comment alone (#1173); it is now guarded by
 * the type — `isAfterBoundary` takes an `ExactPosition` row, which a pointer's
 * order, being possibly a floor, is not. See `readState.enforcement.test.ts`.
 *
 * Identity plays NO part here. A pointer is not further along for having
 * acquired a wire name, which is why {@link withArchiveId} cannot move a cursor
 * even in principle.
 */
export function isAhead(candidate: ReadPointer, current: ReadPointer | undefined): boolean {
  if (!current) return true
  return mayAdvanceTo(candidate.order, current.order)
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
 * An OLDER build reading this format looks for a TOP-LEVEL `messageId` and
 * `timestamp`, finds neither under `order` / `identity`, and reads NO POINTER at
 * all. That degrades in the safe direction and is asserted rather than assumed
 * (`readPointer.test.ts`): with no pointer, `computeFloor` falls back to the
 * entity's `historyFloor`, which over-counts unread and publishes nothing to the
 * XEP-0490 node — never an over-advanced forward-only position. It is a larger
 * degrade than the previous format's (which kept the name and timestamp and lost
 * only the tie-break), and it is the deliberate price of having exactly ONE copy
 * of the name on disk: writing the legacy top-level fields alongside the nested
 * ones would re-create the two-names-that-can-disagree shape this series exists
 * to remove.
 */
export function serializeReadPointer(pointer: ReadPointer): SerializedReadPointer {
  const { order } = pointer
  return {
    order:
      order.role === 'exact'
        ? {
            role: 'exact',
            timestamp: order.timestamp,
            tiebreak:
              order.tiebreak.kind === 'room'
                ? { kind: 'room', from: order.tiebreak.from }
                : { kind: 'chat' },
          }
        : { role: 'floor', timestamp: order.timestamp },
    identity: pointer.identity,
  }
}

/**
 * Rebuild the tie-break from an untrusted persisted key, taking the id from the
 * identity's `messageId` — the pointer's one name for the message it points at.
 *
 * Any `id` still on disk (every key written by the chat blob's plain
 * `JSON.stringify`) is IGNORED rather than read: it was always the same value,
 * so ignoring it is lossless for consistent data and is exactly the fix for
 * inconsistent data. What remains validated is what cannot be reconstructed: the
 * `kind` discriminant, and `from` for a room key. Anything else yields no key at
 * all, which degrades the order to a `floor` (over-count, the safe direction).
 */
function hydrateCacheOrderKey(raw: unknown, messageId: string): CacheOrderKey | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const k = raw as Record<string, unknown>
  if (k.kind === 'chat') return { kind: 'chat', id: messageId }
  if (k.kind === 'room' && typeof k.from === 'string') return { kind: 'room', from: k.from, id: messageId }
  return undefined
}

/**
 * Epoch ms from either encoding found on disk.
 *
 * Epoch ms is what {@link serializeReadPointer} writes and what the live
 * `order.timestamp` already is. An ISO string is what a chat pointer written
 * BEFORE this shape became a plain `JSON.stringify` of a `Date`. Both exist on
 * disk; this is the one place that reads either back.
 */
function hydrateTimestamp(raw: unknown): number | undefined {
  if (typeof raw === 'number') return Number.isFinite(raw) ? raw : undefined
  if (typeof raw === 'string') {
    const parsed = new Date(raw).getTime()
    return Number.isNaN(parsed) ? undefined : parsed
  }
  return undefined
}

/**
 * Rebuild the CURRENT (nested) on-disk shape.
 *
 * The order's `role` is not trusted from disk any further than it can be
 * honoured: an `exact` order whose tie-break comes back unusable degrades to a
 * `floor` rather than being dropped, which preserves the pointer's name and
 * timestamp and costs only an over-count. A `floor` claiming a tie-break is
 * simply read as the floor it says it is.
 *
 * The identity's `archiveId` is required for the `addressable` state and
 * ignored everywhere else, so a blob claiming `addressable` without one hydrates
 * as `local` — degraded, which is the state that always has a defined meaning,
 * rather than a pointer whose wire name is `undefined` at the publisher.
 */
function hydrateNested(raw: Record<string, unknown>): ReadPointer | undefined {
  const rawOrder = raw.order
  const rawIdentity = raw.identity
  if (!rawOrder || typeof rawOrder !== 'object') return undefined
  if (!rawIdentity || typeof rawIdentity !== 'object') return undefined

  const identityFields = rawIdentity as Record<string, unknown>
  const messageId = identityFields.messageId
  if (typeof messageId !== 'string' || messageId.length === 0) return undefined

  const orderFields = rawOrder as Record<string, unknown>
  const timestamp = hydrateTimestamp(orderFields.timestamp)
  if (timestamp === undefined) return undefined

  const tiebreak =
    orderFields.role === 'exact' ? hydrateCacheOrderKey(orderFields.tiebreak, messageId) : undefined

  const archiveId = identityFields.archiveId
  return {
    order: tiebreak ? { role: 'exact', timestamp, tiebreak } : { role: 'floor', timestamp },
    identity:
      identityFields.state === 'addressable' && typeof archiveId === 'string' && archiveId.length > 0
        ? { state: 'addressable', messageId, archiveId }
        : { state: 'local', messageId },
  }
}

/**
 * Rebuild the PRE-IDENTITY flat shape — the migration, and the only place it
 * happens.
 *
 * Two of the three populations §5.4 of the design names live here, and neither
 * moves a stored position by so much as a millisecond:
 *
 * - **Keyed pointers (the bulk)** — `{ messageId, timestamp, tiebreak }` (or the
 *   older `archiveOrderKey` under the same rules). Shape change only: the
 *   timestamp is carried verbatim, the tie-break's id is reconstructed from
 *   `messageId` exactly as the previous format already did, and the order stays
 *   `exact`. They enter as `local` because NO archive id was ever stored — there
 *   is nothing to promote them with, and inventing one is the foreign-name
 *   defect. They converge the first time the position advances onto a message
 *   that carries an archive id.
 * - **Keyless legacy pointers** — the #1081 migration's
 *   `{ messageId, lastReadAt }`, which never had a tie-break. They become
 *   `floor`, which is what they always meant. They can never converge, and that
 *   is honest rather than a defect: converging one means resolving the named
 *   message's real timestamp, which could move the floor FORWARD on a
 *   forward-only pointer. They self-heal instead, the first time the user reads
 *   in that entity — any fresh `exact` pointer is ahead, and `advance` takes it.
 *
 * (The third population, pointerless entities, has nothing to migrate: no
 * pointer in, no pointer out.)
 */
function hydrateLegacyFlat(raw: Record<string, unknown>): ReadPointer | undefined {
  const messageId = raw.messageId
  if (typeof messageId !== 'string' || messageId.length === 0) return undefined
  const timestamp = hydrateTimestamp(raw.timestamp)
  if (timestamp === undefined) return undefined

  // The tie-break was written under `tiebreak`, and under `archiveOrderKey`
  // before the on-disk rename — a name that was always wrong (the key never held
  // an archive id; it is the IndexedDB cursor tie-break built from the CLIENT
  // message id). Both are read here and neither is written any more.
  const tiebreak = hydrateCacheOrderKey(raw.tiebreak ?? raw.archiveOrderKey, messageId)

  return {
    order: tiebreak ? { role: 'exact', timestamp, tiebreak } : { role: 'floor', timestamp },
    // No archive id was EVER stored in this format, so every migrated pointer
    // enters degraded. This is the whole migration: a shape change, and an
    // honest starting identity.
    identity: { state: 'local', messageId },
  }
}

/**
 * Rebuild a pointer from untrusted storage — the ONE site that owns validity.
 *
 * Every persisted pointer enters through here (room read state, the state
 * snapshot, and the chat blob), and what it returns has type-level invariants:
 * an order that is exactly one of `exact` / `floor`, and an identity that is
 * exactly one of `addressable` / `local`. No consumer re-checks, and none can:
 * there is no "half-valid" pointer left to check for. Per-consumer validation is
 * precisely the per-site patching this shape exists to end.
 *
 * Anything malformed yields `undefined` — "no pointer" — rather than a pointer
 * holding an Invalid Date or a name with no position, which would poison every
 * comparison it touched with silent `false`.
 *
 * The current nested shape is tried first; anything else falls through to the
 * pre-identity flat migration. The discriminator is the presence of `order`,
 * which the flat shape never had.
 *
 * REMOVABLE WHEN storage still holding the flat shape no longer matters, which
 * is a bounded condition rather than "forever": every writer re-serializes the
 * WHOLE blob, not the row that changed — `saveRoomReadState` stringifies the
 * entire room map, the chat persist adapter re-emits every `conversationMeta`
 * entry, and the state snapshot re-serializes every room. So the FIRST persist
 * any build from this one onwards performs converts the entire account, not
 * merely the conversation that was read; an account opened once after upgrading
 * is fully converted, dormant ones are not. Deleting this branch then costs
 * those dormant entities their read position entirely — they fall back to the
 * history floor and over-count, the recoverable direction, but the user does
 * lose the position. Remove it only once that trade is acceptable for the oldest
 * storage still in the field.
 */
export function deserializeReadPointer(raw: unknown): ReadPointer | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const fields = raw as Record<string, unknown>
  return fields.order !== undefined ? hydrateNested(fields) : hydrateLegacyFlat(fields)
}
