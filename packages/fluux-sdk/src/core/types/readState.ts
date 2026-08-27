/**
 * Read-position type definitions: cache order, and the read pointer.
 *
 * These are domain types, not store internals — they are part of the SDK's
 * public surface, and `core/types` must stay a leaf layer that no state
 * implementation can reach into. The pure functions that build and compare
 * these values live in `stores/shared/readState.ts` and
 * `stores/shared/readPointer.ts`, which re-export the types declared here.
 *
 * @packageDocumentation
 * @module Types/ReadState
 */

/**
 * The IndexedDB message cache's own tie-break key for a message, built from the
 * CLIENT message id. It has never held an archive id, and could not: XEP-0313
 * §6.2 makes archive ids opaque strings with no guarantee of being numeric,
 * sequenced or globally unique, and unique only per archive — they carry no
 * ordering. This key is chosen to agree with the cache's cursors, and is
 * kind-discriminated because chat and room break same-millisecond ties
 * differently:
 *
 * - Chat breaks ties by `id` only (the chat store's `keyPath: 'id'` in
 *   `messageCache.ts`).
 * - Room breaks ties by `from` then `id` (the `room_ts_from_id` index).
 *
 * Chat messages also carry `from`, so a generic "from then id" comparator
 * would be wrong for chat — the `kind` discriminant is what keeps the two
 * apart. Do not generalise this into a single shape.
 *
 * @category Read state
 */
export type CacheOrderKey = { kind: 'chat'; id: string } | { kind: 'room'; from: string; id: string }

/**
 * A position that is exactly located in message-cache order: a timestamp
 * refined by the tie-break that resolves its millisecond.
 *
 * Every real message yields one, because `makeCacheOrderKey` always
 * produces a key — use `exactPosition` rather than assembling the literal.
 *
 * `role` is not redundant with the presence of `tiebreak`: it is what makes
 * {@link PointerOrder} a DISCRIMINATED union, so narrowing reads as
 * `order.role === 'floor'` at every consumer instead of as an incidental
 * "the optional field happens to be missing" test. A weaker position cannot be
 * passed where an exact one is required (#1173).
 *
 * @category Read state
 */
export interface ExactPosition {
  readonly role: 'exact'
  readonly timestamp: number
  readonly tiebreak: CacheOrderKey
}

/**
 * A position known only to a millisecond: "at least here", not "exactly here".
 *
 * This is what a pointer migrated from the pre-#1081 `lastSeenMessageId` +
 * `lastReadAt` pair carries — `lastReadAt` sits at or behind the message the
 * pointer names, with no provable position inside its millisecond. It is also
 * where an {@link ExactPosition} degrades when its persisted tie-break comes
 * back unusable: dropping to a floor over-counts (the safe direction) rather
 * than trusting a key we cannot rebuild.
 *
 * Deliberately has NO `tiebreak` property at all rather than an optional one:
 * with `role` discriminating, `order.tiebreak` does not typecheck on this
 * variant, so nothing can read a key off a floor and nothing can smuggle one in.
 *
 * @category Read state
 */
export interface FloorPosition {
  readonly role: 'floor'
  readonly timestamp: number
}

/**
 * Where a read pointer sits in message-cache order — see {@link ReadPointer}.
 *
 * The two variants are the two things a stored position can honestly claim, and
 * every comparator answers them differently on purpose. Note that
 * `readonly` here stops a position being MUTATED, not rebuilt: a consumer can
 * still construct a fresh order object with a different timestamp. Never moving
 * a stored position stays a review concern (`stores/shared/readPointer.ts`),
 * which the type makes visible — you have to name `order` — rather than
 * impossible.
 *
 * @category Read state
 */
export type PointerOrder = ExactPosition | FloorPosition

/**
 * How a read position can be NAMED.
 *
 * `messageId` is on both variants — it always exists, and it is the pointer's
 * ONE local name. `archiveId` exists only on `addressable`, so reaching for it
 * forces the consumer to say what it does when the position has no wire name.
 *
 * - **`addressable`** — the named message carried an XEP-0359 archive id when
 *   the pointer was minted. Publishable as-is: the XEP-0490 publisher reads
 *   `archiveId` and is done, with no lookup, no residency requirement and no
 *   cache read.
 * - **`local`** — degraded, and EXPLICITLY so. The archive id genuinely does not
 *   exist yet (or, for the user's own 1:1 sends, may never: the server does not
 *   echo them back, so the only id they ever have is a client-generated
 *   `origin-id`, which is not publishable). No model can conjure one. What the
 *   variant buys is that the state is named once instead of being rediscovered
 *   at each consumer, and that the publisher's at-or-behind fallback (#1189) is
 *   the DEFINITION of this branch rather than a patch bolted onto it.
 *
 * XEP-0359's `by` is deliberately NOT stored: it is a function of the entity
 * (`isRoom(jid) ? jid : ownBareJid()`), so storing it would be a second
 * derivable copy of something the publisher already knows.
 *
 * @category Read state
 */
export type PointerIdentity =
  | { readonly state: 'addressable'; readonly messageId: string; readonly archiveId: string }
  | { readonly state: 'local'; readonly messageId: string }

/**
 * Where the user has read to. Written atomically or not at all.
 *
 * ONE deliberate exception to "the timestamp is the message's own": pointers
 * built by the #1081 migration from a legacy `lastSeenMessageId` + `lastReadAt`
 * PAIR carry `lastReadAt` as the timestamp, which is not necessarily the
 * timestamp of the message the identity names. Those pointers carry a
 * `role: 'floor'` order, which says exactly that: "at least here". That is the
 * status quo preserved exactly — `lastReadAt` is the floor today's unread
 * derivation already counts from, and it is at or behind the named message. Do
 * not "fix" this by resolving the message's real timestamp: that could move the
 * floor FORWARD, and the pointer is forward-only, so a position lost that way is
 * unrecoverable. Only `order` is used for ordering; nothing derives a message
 * from it.
 *
 * ONE resolution is legitimate, and only on evidence: `onMessageSeen` accepts a
 * matching XEP-0359 server ID as proof, or confines a local chat pointer to the
 * unique newest resident row under the cache's `id` key. It replaces only the
 * approximate order. The position does not move — it stays on the message the
 * identity already names. Resolving onto any OTHER message is the forward move
 * forbidden above.
 *
 * @category Read state
 */
export interface ReadPointer {
  /**
   * Where this position sits in message-cache order. Never rewritten to a
   * different position; server identity proof or constrained local evidence may
   * replace a floor with the exact position of the same named message without
   * changing `identity`.
   */
  readonly order: PointerOrder
  /** What this position is called — locally, and on the wire when we can. */
  readonly identity: PointerIdentity
}
