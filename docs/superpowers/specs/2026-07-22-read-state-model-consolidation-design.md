# Read-state model consolidation: derived counts, one cache-resolved pointer

**Date:** 2026-07-22
**Status:** Design approved, pending spec review
**Issue:** [#1081](https://github.com/processone/fluux-messenger/issues/1081)
**Follows:** #1076 / [#1080](https://github.com/processone/fluux-messenger/pull/1080)

## Motivation

#1080 closed four separate ways the read pointer could advance without the user having
read anything. All four are guards bolted onto a model that *permits* the bug class. The
pointer is forward-only, so every erroneous advance is unrecoverable — which is what makes
this worth restructuring rather than patching again.

Two structural defects remain:

**`lastReadAt` is a second source of truth, and it is usually the one that runs.** A
backgrounded entity keeps an empty resident array (memory windowing evicts it), so the
read pointer rarely resolves in the slice it is searched against, and counting falls to
the timestamp branch. But `lastReadAt` means "timestamp of the newest *loaded* message
when I last activated or marked read" — not "the last message I read". When the two
disagree the count drifts with no error and no log.

**Counting functions write the pointer.** `recomputeCountsFromPointer` advances it to the
last outgoing message as a heuristic read boundary, and `onActivate` snaps it when it is
not in the loaded slice. A function whose job is to count must not be able to move the
canonical position — especially in a MUC, where `isOutgoing` misattribution (nick /
occupant-id edges) then destroys the position permanently.

## Key architectural insight

The cache can already answer the question. `messageCache` carries compound indexes
`conv_timestamp` (`[conversationId, timestamp]`) and `room_timestamp`
(`[roomJid, timestamp]`), so "count the non-outgoing messages after this point" is a
single indexed range walk over the *complete local archive* — exact over what is cached,
not window-limited (the reconciled PR B design adds a coverage gate so a *partial* local
archive never overwrites a good count).

The pattern already exists, hand-built for one call site. `applyRemoteDisplayed` runs an
async exact recount over `MAM_POINTER_RECOUNT_CACHE_LIMIT` cached messages
(`roomStore.ts`, `chatStore.ts`) *precisely because* the resident slice undercounts. This
design generalises that one special case and deletes it.

The resident slice bites in a third place too: `resolveSeenStanzaId`
(`core/mdsSideEffects.ts`) resolves the pointer's stanza-id from the resident array with a
`lastMessage`-only fallback, and silently returns `undefined` — dropping a publish —
whenever neither matches.

### Rooms have no durable read pointer at all

Found while planning, and it changes the shape of the work. `RoomMetadata.lastSeenMessageId`
is documented as *"persisted, only advances forward"*. It is not persisted:

- `roomStore` has no zustand `persist` middleware. `ROOM_META_FIELDS` is field-routing for
  `commitRoomUpdate`, not a persistence manifest.
- The app's `useSessionPersistence` *reads* `getSavedRooms` on restore, but `saveRooms` —
  the only writer of the `xmpp-rooms` sessionStorage key — has no production caller. It is
  reachable only from its own test. The restore path reads a key nothing writes.

So room read position is purely in-memory, rebuilt each session from MAM catch-up plus the
XEP-0490 seed. This is very likely part of #1076's original symptom: a fresh instance had
no local read state to show, which is exactly the condition under which the catch-up
ordering bug fired.

A design whose premise is "one canonical, durable read pointer" cannot leave this standing
for the entities the issue says are worst affected. Room read-state persistence is
therefore in scope, in PR A.

## Design decisions (approved)

1. **The count becomes a projection, still persisted.** `unreadCount` stays in the store
   and stays in persisted meta, but stops being authoritative: the only writer is one
   `recomputeUnread(entity) = f(floor, archive)`. It is a cache of the derivation, not an
   accumulator.

   Note this is an *improvement* on today rather than preservation of it: chat counts are
   currently persisted and then zeroed on rehydrate (`unreadCount: 0, // Reset unread on
   restore`, `chatStore.ts`), so cold start already flashes zero badges until MAM catch-up
   repopulates them. Under this design the restored count paints immediately and the
   derivation corrects it, so the zeroing goes away.

2. **Four pointer writers, and only four.** The viewport observer, an inbound XEP-0490
   marker, `markReadToNewest` (Escape / ⌘↓ / FAB), and a message composed *on this
   device*. A carbon of our own message from another device explicitly does **not**
   advance it — that inference is the MUC `isOutgoing` misattribution vector.

3. **`lastReadAt` is redefined, not deleted.** It becomes strictly "the timestamp of the
   message the pointer names", written only atomically with the id. It stops being a
   second source of truth by becoming a denormalised field of the same fact — which keeps
   ordering comparisons synchronous and O(1), leaving the cache needed only for counting.

4. **A remote marker on the active view advances the pointer but freezes the divider.**
   The pointer is a fact and should track. The divider is a per-viewing-session affordance
   (already cleared on deactivate, already deliberately kept alive after a FAB jump);
   repainting it under someone's eyes yanks the separator off content they are reading. It
   recomputes on the next activation.

5. **A fresh entity gets an explicit watermark, not a pointer write.** `historyFloor`
   records when the entity entered our world, once, at creation. Joining a room with 10k
   messages of history yields zero unread without anyone touching the pointer.

6. **Four stacked PRs — `A → B0 → B → C` — with a whole-slice review.** (Three when this
   was written; PR B's storage invariant now needs the room-store normalization B0, so B0
   was inserted before B.) Individually-correct steps can fail to compose; the later PRs get
   a combined whole-slice review.

## Data model

The pointer becomes one object, not two fields:

```ts
/** Where the user has read to. Written atomically or not at all. */
interface ReadPointer {
  /** Client message id of the newest message the user has read. */
  messageId: string
  /** Timestamp OF that message — denormalised so ordering stays sync and O(1). */
  timestamp: Date
  /**
   * A **stable** logical ordering key for that message — the tiebreak that makes
   * a `(timestamp, archiveOrderKey)` position total. Added in PR B (see the
   * reconciled design): without it the count cannot locate the pointer's exact
   * position after the resident array is evicted.
   *
   * It is NOT the cache primary key. A room message's `cacheKey` is mutable —
   * first `roomJid:from:id`, then the server `stanzaId` once it arrives, and the
   * two raw rows can even carry different timestamps (see the total-order section
   * and precursor PR B0). The key is instead derived from fields that never change,
   * and is **structured** — not a delimiter-joined string, whose lexical order need
   * not match the tuple order and could collide on the delimiter:
   *   - chat: `{ kind: 'chat', id }`
   *   - room: `{ kind: 'room', from, id }` (stanza-id independent)
   *
   * Absent on a migrated pointer that names no trustworthy message — those fall
   * back to the strict-after-timestamp count.
   */
  archiveOrderKey?: ArchiveOrderKey
}

type ArchiveOrderKey =
  | { kind: 'chat'; id: string }
  | { kind: 'room'; from: string; id: string }
```

`lastSeenMessageId` and `lastReadAt` collapse into `readPointer?: ReadPointer` on
`conversationMeta` / `roomMeta`. Making it one object is the structural fix: today nothing
stops a writer from moving one field and not the other, which is exactly how they drifted.
You cannot write half of an object.

(`archiveOrderKey` is PR B's addition to this PR-A-created shape — additive and optional, so
it needs no data migration: a persisted pointer without it uses the timestamp fallback until
a writer replaces it. Populating it is not one edit but several — the shared
`makeReadPointer` cannot infer a room's `(from, id)` from a `PointerSource { id, timestamp }`,
so it takes an explicit order key (or splits into chat/room constructors), and every
serialization surface must round-trip the field: chat `conversationMeta` persistence, room
`readStateStorage`, the SDK `stateSnapshot`, and their deserializers, each with a round-trip
test.)

To be precise about decision 3: the *field name* `lastReadAt` disappears, but the value it
was supposed to hold survives — corrected — as `readPointer.timestamp`. Nothing is lost;
a field that meant "newest loaded message when I last activated" now means "the timestamp
of the message I read up to", which is what every consumer already assumed it meant.

A second, separate field — `historyFloor?: Date` — is the joined/created watermark. It is
not a read position but an entity-lifecycle fact: written once at entity creation, never
again.

Every derivation uses **`floor = readPointer ? readPointer.timestamp : historyFloor`** —
pointer-wins-else-floor. (The earlier draft of this line said `max(readPointer.timestamp,
historyFloor)`; PR B found that unsafe — a migrated pre-existing conversation is stamped
`historyFloor = now`, so `max` would resolve to *now* and zero its unread. See the
reconciled PR B design. The denormalised timestamp is still the point: the comparison stays
synchronous and O(1).)

### Room read-state persistence (new)

Rooms gain a durable, account-scoped read-state store on the pattern roomStore already
uses four times (`fluux-room-gaps`, `fluux-room-coverage`,
`fluux-room-pending-retractions`, `fluux-room-drafts`): key
`fluux-room-read-state`, holding `readPointer` and `historyFloor` per room JID. Not
`unreadCount` — that is derived, and a room's archive is the thing worth trusting.

The dead `saveRooms` / `getSavedRooms` sessionStorage path and the read-state fields of
`SerializableRoom` are removed rather than wired up: sessionStorage is the wrong durability
tier for a read position, and the scoped-localStorage pattern above is the established one.

### Persisted-shape migration

One-shot, on rehydrate. Chat only in practice — rooms have nothing persisted to migrate
from, so they start from an empty read-state store and populate going forward:

| Persisted state | Migrates to |
|---|---|
| `lastSeenMessageId` + `lastReadAt` | `{ messageId: lastSeenMessageId, timestamp: lastReadAt }` |
| `lastSeenMessageId` only | `{ messageId, timestamp }` resolved from the cache |
| `lastReadAt` only | newest cached message **at or before** that timestamp |
| neither | no pointer — `historyFloor` takes over (**exception:** a restored *non-zero* persisted count defers instead of deriving — see the reconciled PR B design's pointerless-with-count rule) |

The `lastReadAt`-only case is the delicate one, and it errs in the safe direction. Since
today's `lastReadAt` means "newest *loaded* message when I last activated", resolving it
against the cache lands at-or-**behind** the true position, never ahead. Under-advancing
shows extra unread, which the user clears by reading; over-advancing is the unrecoverable
direction.

## Modules

Split by testability — the decision logic stays pure and I/O is isolated.

| Module | Purpose | Sync? |
|---|---|---|
| `stores/shared/readState.ts` *(new)* | Pure core: `countUnreadInSlice(messages, floor, opts)`, `deriveDivider(messages, floor, opts)`. No I/O. | sync |
| ~~`stores/shared/readStateArchive.ts`~~ *(superseded)* | The cache-backed exact count instead lands in `messageCache.ts` as `countUnreadInArchive` — the DB handle, compound index, and stored-message deserialization already live there. See the reconciled PR B design. | async |
| `stores/shared/notificationState.ts` *(shrinks)* | Keeps arrival / notify / badge logic. Loses `recomputeCountsFromPointer`, `onActivate`'s fallback ladder, `onMarkAsRead`'s `advanceSeenTo`. | sync |

## Data flow

**One recompute entry point.** `recomputeUnread(entityId)` is the sole *authoritative*
writer of `unreadCount` / `mentionsCount`. (This is the end state, after PR C. Through PR B,
`recomputeCountsFromPointer` still writes a provisional count that `recomputeUnread`
immediately overwrites — see the reconciled PR B design for that two-phase intermediate.)
Triggers:

- rehydrate / app start (batched, per entity)
- a forward MAM merge for that entity
- a pointer advance (any of the four writers)
- an inbound XEP-0490 marker that advanced the pointer
- a deferred-decrypt drop or retraction that changes what is countable

Per-entity latest-wins coalescing via the existing `createKeyedCoalescer`. The persisted
count paints immediately on cold start, so the async correction is invisible.

**The one fast path, and why it is safe.** A live incoming message while the entity is not
visible still takes a synchronous `+1` — no DB round-trip per message. This is legitimate
*only* because it yields exactly what the derivation would: the message is after the
floor, non-outgoing, and renderable. That last clause is a real fix, not bookkeeping — the
increment path today accepts messages the archive count would reject, which is the
mechanism behind the E2EE phantom-badge class. Both paths call the same
`isRenderableStoredMessage` predicate, so they cannot drift.

**The divider stops being a special case.** Activation loads around the pointer's
timestamp (`loadMessagesAroundFromCache` already exists), then places the divider by
timestamp comparison inside the slice. Decision 4 needs no new machinery:
`resolveRemoteDisplayed`'s `advanced-with-divider` kind is deleted and both active and
inactive entities return `advanced`. Not touching the divider *is* the implementation.

**Publish path.** `resolveSeenStanzaId` resolves via the cache instead of
resident-slice-plus-`lastMessage`-fallback, closing its silent `return undefined` drop.

## Deletions

This is where the payoff is.

| Removed | Why it existed |
|---|---|
| `recomputeCountsFromPointer` (whole function) | Counting half moves to `readState`; the outgoing-boundary pointer write is the heuristic this issue is about |
| `onActivate`'s fallback ladder — `lastReadAt` branch, Nth-from-end branch, brand-new-conversation branch, resume-preserving snap (~120 lines) | All of it exists because the pointer could not resolve in the resident slice |
| `onMarkAsRead`'s `advanceSeenTo` parameter | Mark-read becomes a first-class pointer writer, not an optional side channel |
| `onMessageSeen`'s `currentIdx === -1` guard + `atLiveEdge` escape hatch | There is no unresolvable pointer any more |
| `MAM_POINTER_RECOUNT_CACHE_LIMIT` + both stores' async exact-recount blocks | This was already the general derivation, hand-built for one call site |
| `resolveRemoteDisplayed`'s `advanced-with-divider` kind | Decision 4 |
| the `treatDelayedAsNew` option, everywhere | Moot once the floor is a timestamp: a delayed message timestamped after the floor simply *is* new. It only existed to paper over id-position comparison, and both stores already pass `true` |
| `apps/fluux/src/utils/newMessagesMarker.ts` + its test | Dead code — referenced only by its own test file |

### The four #1080 gates, re-examined

Dead guards are their own liability, so each is decided explicitly:

1. **Presence gate** (unfocused → don't advance `lastSeenMessageId`) — **keep**.
   Independent of the model: painted still is not seen.
2. **Focus-regain gate** (`viewportAtBottom` — mark-read requires genuinely showing the
   newest message) — **keep**. Same reasoning.
3. **`hasPendingRemoteMarker`** — **delete**. Its only job was stopping
   `recomputeCountsFromPointer`'s fresh-entity guard from snapping the pointer past a
   pending marker. Both the guard and that function's pointer write are gone.
4. **`archiveIsTrustworthy` publish gate** — **keep, with a rewritten rationale**. Its
   stated reason (a position derived mid-catch-up) evaporates once catch-up is not a
   pointer writer. It still earns its place as a publish-side backstop, but leaving the
   old comment in place would make it precisely the dead guard the issue warns about.

## Failure modes

**Never write a count from a failed read.** If the IndexedDB read fails or the cache is
unavailable, the derivation returns `unavailable` and the store *leaves the persisted count
in place* — it does **not** count the resident slice or write anything (see the reconciled
PR B design: the store writes only on an `exact` outcome). A zero badge produced by a failed
read would be indistinguishable from "you are caught up" — the same shape as the B3
false-"compromised" defect in the OpenPGP work.

**Unresolvable floor degrades toward more unread, not less.** Pointer message absent from
the cache → fall back to `historyFloor`; neither present → count nothing rather than
everything. Every fallback in this design leans the same way: over-counting is a nuisance
the user clears by reading, while over-advancing the pointer destroys data permanently.

**Cap at 999 with cursor early-out**, so an entity with a huge unread range cannot turn
the walk into a stall. The store holds the capped value; the badge renders `999+`.

**Mention flags are frozen at ingest — carried over, not introduced.** `isMention` is
computed against the room nickname at the time the message arrives and is persisted with
the message, so a derived `mentionsCount` inherits whatever was decided then (a nick
change does not retroactively re-flag history, and MAM-backfilled ranges carry whatever
the ingest path assigned). `recomputeCountsFromPointer` already reads the same stored
flags, so this is unchanged behaviour, noted here so it is not mistaken for a regression
of this work.

## Testing

The pure core is exhaustively unit-tested. The archive derivation runs against
`fake-indexeddb` with seeded archives, asserting exact counts against a real IDB
implementation rather than mocks — the pattern and the dependency already exist in
`utils/messageCache.test.ts`.

Hollow tests are the recurring defect in this codebase, and a deliberate-break check has
already proven insufficient once. Each new assertion gets a **control test** that fails
against a deliberately-wrong implementation.

Regression tests map to actual bug modes, not to functions:

- Backgrounded room, empty resident array, pointer deep in history → exact count. *(Today:
  falls to the timestamp branch and drifts.)*
- MUC message with misattributed `isOutgoing` → pointer does not move.
- Fresh join of a room with a deep archive → zero unread, pointer untouched.
- Remote marker ahead while the entity is active → pointer advances, divider does not
  move.
- Migration from a `lastReadAt`-only entity → resolves at-or-behind the true position,
  never ahead.
- Failed cache read → persisted count preserved, never zeroed.

Gates: `npm test`, `npm run typecheck`, lint, and `npm run test:scroll` (repo root) for
anything touching the loaded window.

## Staging

Four stacked PRs off `main` — `A → B0 → B → C` — with a whole-slice review of the later ones.

**PR A — `ReadPointer` + `historyFloor` + persistence + migration. Implementation complete,
PR [#1089](https://github.com/processone/fluux-messenger/pull/1089) open.**
Everything computes exactly as today, just reading `readPointer.messageId` / `.timestamp`
instead of two independent fields, plus the new room read-state store and the chat
migration.

Not strictly behaviour-neutral, by the decision above: rooms start remembering their read
position across restarts, which they never did. That is the one intended behaviour change
in PR A, and it should be verified against a real restart rather than only in unit tests.
Also removes the dead `saveRooms` path and corrects `RoomMetadata.lastSeenMessageId`'s doc
comment, which currently claims a persistence that does not exist.

The pointer object must come first: the archive count needs a *timestamp* floor, and
before migration the only timestamp available is the `lastReadAt` that lies.

**PR B0 — room message store canonicalization** (precursor to PR B; see its own plan,
`plans/2026-07-23-read-state-b0-*`). Canonicalize the room message store on the **XEP-0359
identity hierarchy** (`stanzaId → originId → from+id`), not `(roomJid, from, id)` alone — a
MUC rewrites the client `id` on echo, so an optimistic copy and its reflection share only
`originId`. An identity-resolving upsert matches an incoming message against every existing
row via all tiers and merges them into one canonical row with a **commutative, field-complete**
merge; the row keeps `identityKeys[]` and `ids[]` multi-entry indexes so no alias is lost
(existing mutation callers hold pre-merge ids), plus the `room_ts_from_id` = `[roomJid,
timestamp, from, id]` order index. A streaming, explicitly-abortable migration replays every
existing user's cache through that same upsert. Its own PR because it is a store migration
with whole-room-cache blast radius, independently reviewable, and a prerequisite for PR B: it
guarantees one logical message = one row = one archive position, so the count needs no dedup.
It also retires the existing "double row in the raw cache" edge at its source.

**PR B — the derivation.** See the reconciled design below — the original sketch here
(`readStateArchive.ts`, "deletes `recomputeCountsFromPointer`") predated PR A and no longer
holds. In short: the count becomes exact over the complete local archive via a new
`messageCache` primitive; the
pure floor/predicate logic lives in `readState.ts`; `recomputeCountsFromPointer` stays as
the provisional count and pointer writer (its count output is ignored). PR B **changes
where the count comes from**; PR C removes the pointer writes.

**PR C — the writers.** Pointer reduced to the four writers; `onActivate`'s ladder
deleted; `recomputeCountsFromPointer` and its guards deleted (the derivation no longer
needs its count, so only its pointer-writes remain to remove); divider derived from the
floor; gate 3 removed and gate 4 re-justified; `resolveSeenStanzaId` cache-resolved; dead
code removed.

## PR B — reconciled design (post-PR-A, assuming B0)

The sections above were written before PR A executed. PR A shifted the ground under PR B's
sketch, so this section supersedes the "PR B" bullet in Staging and the `readStateArchive`
row in Modules. The decisions here were brainstormed against the merged PR A code.

**What PR A changed that matters.** `recomputeCountsFromPointer` now does three jobs at
once: it counts unread, it writes the pointer (the outgoing-boundary advance and the
fresh-entity snap), **and** it carries the two forward-only data-loss guards
(`hasPendingRemoteMarker`, `hasUnmigratedLegacyReadState`). The original plan to "delete
this whole function in PR B" would relocate those guards in the same PR that introduces the
new derivation. A `recomputeUnreadForConversation` scaffold and two slice-limited async
"exact recount" blocks (`MAM_POINTER_RECOUNT_CACHE_LIMIT`) already exist — PR B generalises
those, it does not add a parallel mechanism.

**Decision — the PR B/C boundary.** PR B changes *where the count comes from*; PR C removes
the pointer writes. `recomputeCountsFromPointer` stays exactly as-is through PR B — still
writing the pointer, still carrying the guards — but its count *output* is ignored once the
archive derivation lands. This keeps the two PRs cleanly separable (B = the count source, C
= the pointer writers) and never relocates the data-loss guards in the same step that
changes the count model. PR C then deletes the function; by then only its pointer-writes
remain to remove.

**Decision — the floor formula.** `floor = readPointer ? readPointer.timestamp :
historyFloor`, **not** `max(...)`. A pre-#1081 conversation is stamped `historyFloor = now`
when it flows through `setConversations` (`chatStore.ts`), so `max(lastReadAt, now)` would
resolve to *now* and zero every migrated conversation's unread. Pointer-wins handles the
successfully-migrated case (floor = `lastReadAt`, which is at-or-behind the true position,
so it over-counts slightly — the safe direction). The `historyFloor = now` value is
therefore **never used as a floor for a migrated entity** and is left in place; making it
honest is inert-but-worth-cleaning follow-up in the migration's domain, not PR B.

**Decision — the un-migrated / pending branch defers.** With no pointer, the derivation
must distinguish "genuinely fresh" (floor = `historyFloor` = real creation time → zero,
correct) from "un-migrated legacy state, or a pending remote marker" (floor would be the
bogus `historyFloor = now` → zero → *under*-count, unsafe). The derivation mirrors
`recomputeCountsFromPointer`'s guards: when the entity has un-migrated legacy state or a
pending marker, it **defers** — leaves the persisted count in place rather than deriving a
zero it cannot trust. A cheap registry read, same signals the pointer path already uses.

**Decision — one total order, `(timestamp, primaryKey)`, shared by the pointer side and the
count.** A timestamp alone is not a position: two messages can share a millisecond, and
today three places disagree on how to break that tie. The resident array
(`messageArrayUtils.ts`) sorts by `timestamp` only — ties fall in merge order, which is not
even stable across re-merges. `isAhead` refuses to advance on an equal millisecond. The
IndexedDB compound index orders ties by primary key. So a naive "count messages after
`floor.timestamp`" **under-counts**: with the pointer at `m1 @ t` and an unread `m2 @ t`,
the pointer will not advance (equal ms) yet an `after t` query also excludes `m2` — badge
says zero while `m2` is unread. That is the *unsafe* direction.

The fix is a single total order, **stanza-id-independent** so a room pointer stays resolvable
across a stanza-id arrival: chat `(timestamp, id)`, room `(timestamp, from, id)` scoped by
`roomJid`. (Not `(timestamp, cacheKey)` — `cacheKey` swaps from `roomJid:from:id` to the
`stanzaId` when the server assigns one; `(from, id)` never changes.)

**A logical room message must be one row, not two — normalised in a precursor PR (B0).** The
deeper hazard is not just the *key* swap but that the two raw rows carry *different
timestamps*: a live message keeps its receipt time, its later MAM copy the archive `<delay>`
time, and the cache stores each under its own primary key. So a single cursor cannot dedupe
them by adjacency (they are not adjacent), and the same logical message has *two* archive
positions that can fall on opposite sides of the pointer — counted twice, or counted after
the floor while its already-read twin sits below it. Cursor-level dedup cannot fix this; the
storage must. **PR B0 (see its own plan) canonicalizes the room store on the XEP-0359
identity hierarchy (`stanzaId → originId → from+id`) — an identity-resolving upsert merges
every copy of a logical message into one canonical row (commutatively, field-complete), keeps
`identityKeys[]` + `ids[]` multi-entry indexes so no alias is lost, and streams an
explicitly-abortable migration over existing caches.** After B0, one logical message = one
row = one position, and everything below needs no dedup:

- **The room order is a clean cursor walk** over `room_ts_from_id` = `[roomJid, timestamp,
  from, id]` (added in B0 alongside the re-key). Chat's existing `conv_timestamp` already
  orders by `(conversationId, timestamp)` tie-broken by the `id` primary key — no new index.
- **Resident sort gains the tiebreak** — `messageArrayUtils` compares `id` (chat) /
  `(from, id)` (room) when timestamps are equal. Array index then equals archive order, so
  the viewport observer (which advances the pointer by array index) walks a same-ms run in
  the same order the count uses.
- **The count counts strictly after the pointer's *position*, not its timestamp** — the
  cursor compares each entry's `(timestamp, from, id)` against the pointer's
  `(timestamp, archiveOrderKey)` and counts renderable non-outgoing entries strictly after
  it, so `m2` is counted. When the pointer has no `archiveOrderKey` (a migrated `lastReadAt`),
  fall back to strict-after-timestamp — over-counts there (safe), and the tie edge is moot
  because `lastReadAt` is not a message's exact position.
- **The order key must be persisted on the pointer, not recovered from memory.** The whole
  reason the count exists is that a backgrounded entity's resident array is *evicted* — so
  "locate the pointer by the resident message's fields" fails exactly when it is needed, and
  a room's `id` alone is not unique within the room. So the pointer persists a **structured**
  `archiveOrderKey`, not a delimiter-joined string (whose lexical order need not match the
  tuple order and could collide on a delimiter):

  ```ts
  type ArchiveOrderKey =
    | { kind: 'chat'; id: string }
    | { kind: 'room'; from: string; id: string }
  ```

  The comparator orders structurally (timestamp, then the key's fields), so no string-ordering
  assumption is load-bearing. This is the one point where the total order reaches back into
  PR A's data model.
- **`isAhead` is left ms-only for PR C, which then aligns it to this same total order.** The
  count and the resident advance do not route through `isAhead` (it drives `advance()` for
  the MDS regressive-publish guard), so through PR B leaving it strict only means a
  *published* marker won't cross a same-ms run — a bounded under-advance in the safe
  direction. PR C aligns `isAhead` and the XEP-0490 comparison to `(timestamp, archiveOrderKey)`
  as part of its writer work (persisting `archiveOrderKey` in PR B is what makes that possible);
  this is a deferral of the edit, not of the decision.

Tests must cover several incoming **and** outgoing messages sharing one millisecond, chat
and room: the badge counts the same-ms unread, and the pointer advances through the run
rather than stalling.

**Decision — the count is only as exact as the local archive is *complete*, so it gates on
coverage.** "Archive-exact" is exact over what IndexedDB *holds*, which is not the same as
what the server has. IndexedDB can open cleanly while the archive is partial: MAM catch-up
still running, a known history gap below the live edge, only the newest window cached, or a
partial clear. Deriving then would count fewer messages than exist and **overwrite a correct
persisted count with a smaller one or zero** — the unsafe direction, and the worst-timed
trigger (cold-start rehydrate) fires exactly before catch-up has run.

The derivation therefore gates on coverage, mirroring the publisher's existing
`mdsSideEffects.archiveIsTrustworthy`: it counts only when the local archive is *contiguous
from the floor to the live edge*. That maps onto the coverage records already maintained
(`conversationCoverage` / `roomCoverage`, the "contiguous-with-live bottom"). Note the record
stores a `bottomId`, not a timestamp — so the gate resolves `bottomId` through the cache to
its full `(timestamp, orderKey)` position and compares *that* with the floor: trustworthy
when the floor is at or above the resolved bottom **and** the entity is caught up to live. A
deep gap *below* the floor is fine; we only count above it. If `bottomId` fails to resolve
(the record points at a message no longer cached), the derivation returns `deferred` and the
now-stale coverage record is invalidated so catch-up rebuilds it. When coverage is not yet
trustworthy the derivation **defers** (keeps the persisted count), and the existing
forward-MAM-merge trigger re-runs it once catch-up fills the range.

**Decision — pointerless with a non-zero persisted count also defers.** A genuine pre-#1081
conversation can have `unreadCount > 0`, no `lastSeenMessageId`, and no `lastReadAt` — e.g.
an inactive conversation that received its first message but was never opened, so no read
position was ever recorded. The migration table classifies it as "neither" → no pointer, and
it is stamped `historyFloor = now`, so a naive derivation would compute zero and **erase a
real unread count**. It is not in the un-migrated registry (it has no legacy fields to
migrate), so the earlier defer signals miss it. The general safety net: **whenever there is
no pointer and the persisted count is non-zero, defer** — the count came from somewhere real
(incremental `+1`s) and there is no floor we can trust to re-derive it. Deriving is allowed
pointerless only when the persisted count is already zero (nothing to erase; a genuinely
fresh entity correctly stays zero). This subsumes the un-migrated case without depending on
registry membership.

**The derivation returns an explicit outcome, not a count-or-not.** `recomputeUnread`
resolves to `{ kind: 'exact', unread, mentions } | { kind: 'deferred' } | { kind:
'unavailable' }`. The store writes the count **only on `exact`**. `deferred` (coverage not
trustworthy, or pointerless-with-count, or un-migrated / pending marker) and `unavailable`
(IndexedDB error / cache absent) both leave the persisted count untouched — there is no
"count the resident slice as a lower bound" path, which was ambiguous about what the slice
value was even for. Every non-exact outcome keeps the last trustworthy value and waits for a
later trigger.

**Modules.**

| Module | Purpose | Sync? |
|---|---|---|
| `messageCache.ts` *(+2 fns)* | `countUnreadInArchive(conversationId, {pointer, floor, cap})` and a room twin `countRoomUnreadInArchive` returning `{unread, mentions}`. A cursor from the floor timestamp forward — chat over `conv_timestamp`, room over the `room_ts_from_id` index B0 added — counting `!isOutgoing && isRenderableStoredMessage` strictly after the pointer's **position** in `(timestamp, orderKey)` order (matching the row's stable `(from, id)` / `id` against the pointer's persisted `archiveOrderKey`; strict-after-timestamp fallback when it is absent), early-out at `cap` (999). No dedup — B0 guarantees one row per logical message. Only touches the index range at/after the floor → O(unread)-capped over the *local* archive. A cursor, not `index.count()`, which can neither filter nor honor the tiebreak. | async |
| `stores/shared/readState.ts` *(new, pure)* | `computeFloor(pointer, historyFloor)`; the derivation's outcome + defer logic (`exact | deferred | unavailable`, and the coverage / pointerless-with-count / un-migrated / pending-marker defer conditions); the `(timestamp, archiveOrderKey)` comparator used by the resident sort and the count; re-exports the single `isRenderableStoredMessage` predicate that both the cache walk and the live `+1` path use, so they cannot drift. | sync |
| `chatStore` / `roomStore` | `recomputeUnreadForConversation` rewritten to gate on coverage, compute the floor (pure), call `countUnreadInArchive`, and write the count **only on an `exact` outcome**; a new parallel `recomputeUnreadForRoom` (rooms inline their recount today). | async |

**Data flow — two-phase.** At every count-writing site: (1) `recomputeCountsFromPointer`
runs unchanged, writing an immediate **provisional** count (no flash) and advancing the
pointer; (2) a trigger schedules `recomputeUnread(entity)`, which reads the now-current
pointer, checks coverage, computes the floor, calls `countUnreadInArchive`, and — **only on
an `exact` outcome** — overwrites the provisional count with the archive-derived one; a
`deferred` or `unavailable` outcome leaves the persisted count in place. Triggers: cold-start
rehydrate (batched per entity — typically `deferred` under the coverage gate until catch-up
runs, which is the point), a forward MAM merge past the floor, a pointer advance or inbound
marker that advanced it, and a deferred-decrypt drop / retraction (the E2EE phantom-badge
path already calls `recomputeUnreadForConversation`). The `+1` fast path in
`onMessageReceived` stays synchronous but gains a renderability guard — it increments only
for a message the shared predicate accepts, closing the phantom-badge class at the source.

**PR B is not behaviour-neutral, and that is the point.** Backgrounded conversations with
deep unread stop under-counting; badges become archive-accurate. The regression tests
assert exactly that gap: backgrounded+deep-pointer → exact; migrated pointer → over-counts,
never zero (the `max()` bug this replaces); un-migrated → deferred not zeroed; fresh
deep-backfill room → zero; `+1` on a non-renderable message → no increment; cap at 999;
**several incoming and outgoing messages sharing one millisecond → the same-ms unread is
counted and the pointer advances through the run** (the tie bug), chat and room;
**IndexedDB opens but holds only part of the unread range (mid-catch-up / gap below live) →
`deferred`, persisted count untouched, never zeroed** (the partial-archive trap);
**pointerless conversation with a non-zero persisted count → `deferred`, count preserved**;
**a same-ms pointer absent from memory after restart → located via persisted `archiveOrderKey`,
not a resident lookup**; **two room messages sharing an `id` but different `(from)` senders →
counted as two distinct positions** (the room-id-not-unique case); **a pointer created before
its `stanzaId` arrives → still resolvable after restart / MAM reconciliation** (the stable
`(from, id)` key survives the stanza-id swap). The duplicate-row cases — including the
decisive straddle migration (fallback row at `t1`, stanza row for the same `(from, id)` at
`t2`, on opposite sides of the floor → after upgrade one canonical row, counted once) — are
**B0's** tests, since B0 is what guarantees the single row PR B's count relies on. Every
control gets a deliberate-break verification (this PR's recurring defect is hollow tests).
Gates: `npm test`, typecheck, lint, and `npm run test:scroll` (the recount blocks live in the
MAM merge path, and the resident sort tiebreak touches the loaded window).

**One PR-A cleanup folded in:** PR A shipped a `readFloor()` helper in `readPointer.ts` that
does `max(pointer.timestamp, historyFloor)` — the very formula this design rejects. It has no
production caller but *is* exported from `index.ts`, so the wrong version sits on the SDK's
public surface. PR B deletes it (and its export) in favour of `computeFloor`, so no reader —
inside or outside the SDK — can pick it up.

**PR B0 task order** (the precursor). New canonical room key + `room_ts_from_id` index on a
fresh object store → the upgrade that copies existing rows into it, merging duplicate
`(roomJid, from, id)` rows into one and picking the canonical timestamp → route every room
cache read/write/`getByStanzaId`/merge path through the new key → migration + interop tests,
including the decisive straddle case (fallback row at `t1`, stanza row for the same
`(from, id)` at `t2`, straddling the floor → after upgrade one canonical row, counted once).

**PR B task order** (on a store B0 has normalised). Pure `readState` core (the
`(timestamp, archiveOrderKey)` comparator, `computeFloor`, the outcome/defer logic) and delete
PR A's `readFloor` → persist `archiveOrderKey` (the explicit-structured-order-key constructor
change, plus chat persistence, room `readStateStorage`, `stateSnapshot`, their deserializers,
and round-trip tests) → resident-sort tiebreak in `messageArrayUtils` (isolated,
`test:scroll`-gated, lands before anything depends on the shared order) → cache primitive
(count-after-position, coverage-gated) → chat `recomputeUnread` rewrite + coverage gate +
triggers → room `recomputeUnreadForRoom` + triggers → `+1` renderability guard → delete the
now-dead slice-limited recount internals (and `MAM_POINTER_RECOUNT_CACHE_LIMIT` if nothing
else uses it).

## Risks

- **Deep-history rooms.** The cursor walk over a large unread range, bounded by the cap.
  `npm run test:scroll` is a required gate.
- **PR B0 recreates the room store with whole-room-cache blast radius.** It streams every
  existing user's rows through the identity upsert into a fresh canonical store, collapsing
  the duplicate rows one logical message can hold. This is the riskiest change in the whole
  effort — hence its own PR — and must be exercised against a populated pre-upgrade DB holding
  known echo/stanza duplicate rows, asserting one row survives with the archived timestamp and
  every id/stanza/origin alias still resolves. Two idb-specific hazards the plan pins down:
  the async `upgrade` callback is not awaited by idb, so the migration **explicitly** calls
  `transaction.abort()` on failure rather than relying on a rejected promise; and
  `fake-indexeddb` cannot prove browser abort semantics, so a real-browser abort check is a
  manual pre-merge gate.
- **Multi-device read sync.** The publish path changes shape; the seed/echo-suppression
  logic in `mdsSideEffects` must keep working across the pointer refactor.
- **The migration is forward-only, like the bug.** A migration that over-advances is as
  unrecoverable as the defect it fixes. Mitigation is structural: every migration branch
  resolves at-or-behind today's effective position.
- **Rooms gain persistence they never had.** A wrong pointer that used to evaporate on
  restart now survives one. This raises the cost of any residual pointer-advance bug, and
  is the strongest argument for landing PR C's writer restriction rather than stopping
  after B.
