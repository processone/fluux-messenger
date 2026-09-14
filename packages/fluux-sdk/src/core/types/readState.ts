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
 * Kind-specific local tie-break within one timestamp.
 *
 * The cache cursor only narrows the candidates; its consumer compares this full
 * key before counting. Room `row` evidence must survive identity enrichment
 * independently of the current archive name. Ordering and legacy-pointer rules
 * are owned by `docs/MESSAGE_IDENTIFIERS.md`, section 5.
 *
 * @category Read state
 */
export type CacheOrderKey =
  | { kind: 'chat'; id: string }
  | { kind: 'room'; from: string; id: string; occupantId?: string; row?: string }

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
 * A read position's local name and, when addressable, its archive name.
 *
 * `addressable` alone does not establish room publication authority. Keep its
 * confirmation and scope evidence intact; publication and legacy resolution
 * follow `docs/MESSAGE_IDENTIFIERS.md`, section 4.
 *
 * @category Read state
 */
export type PointerIdentity = { readonly unconfirmed?: boolean } & (
  | {
      readonly state: 'addressable'
      readonly messageId: string
      readonly occupantId?: string
      readonly archiveId: string
      /** Room archive and account that confirmed the ID; absent on older pointers. */
      readonly archiveScope?: { readonly roomJid: string; readonly accountJid: string | null }
    }
  | { readonly state: 'local'; readonly messageId: string; readonly occupantId?: string }
)

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
