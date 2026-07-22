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
single indexed range walk over the *whole* archive — exact, not window-limited.

The pattern already exists, hand-built for one call site. `applyRemoteDisplayed` runs an
async exact recount over `MAM_POINTER_RECOUNT_CACHE_LIMIT` cached messages
(`roomStore.ts`, `chatStore.ts`) *precisely because* the resident slice undercounts. This
design generalises that one special case and deletes it.

The resident slice bites in a third place too: `resolveSeenStanzaId`
(`core/mdsSideEffects.ts`) resolves the pointer's stanza-id from the resident array with a
`lastMessage`-only fallback, and silently returns `undefined` — dropping a publish —
whenever neither matches.

## Design decisions (approved)

1. **The count becomes a projection, still persisted.** `unreadCount` stays in the store
   and stays in persisted meta, but stops being authoritative: the only writer is one
   `recomputeUnread(entity) = f(floor, archive)`. Persisting it avoids a blank-badge flash
   on cold start; it is a cache of the derivation, not an accumulator.

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

6. **Three stacked PRs, one whole-slice review.** Individually-correct steps can fail to
   compose; the final review reads the combined diff.

## Data model

The pointer becomes one object, not two fields:

```ts
/** Where the user has read to. Written atomically or not at all. */
interface ReadPointer {
  /** Client message id of the newest message the user has read. */
  messageId: string
  /** Timestamp OF that message — denormalised so ordering stays sync and O(1). */
  timestamp: Date
}
```

`lastSeenMessageId` and `lastReadAt` collapse into `readPointer?: ReadPointer` on
`conversationMeta` / `roomMeta`. Making it one object is the structural fix: today nothing
stops a writer from moving one field and not the other, which is exactly how they drifted.
You cannot write half of an object.

To be precise about decision 3: the *field name* `lastReadAt` disappears, but the value it
was supposed to hold survives — corrected — as `readPointer.timestamp`. Nothing is lost;
a field that meant "newest loaded message when I last activated" now means "the timestamp
of the message I read up to", which is what every consumer already assumed it meant.

A second, separate field — `historyFloor?: Date` — is the joined/created watermark. It is
not a read position but an entity-lifecycle fact: written once at entity creation, never
again.

Every derivation uses **`floor = max(readPointer.timestamp, historyFloor)`** — one
comparison between two timestamps, which is the entire reason for denormalising the
timestamp onto the pointer.

### Persisted-shape migration

One-shot, on rehydrate, in both stores and in the app's `useSessionPersistence`:

| Persisted state | Migrates to |
|---|---|
| `lastSeenMessageId` + `lastReadAt` | `{ messageId: lastSeenMessageId, timestamp: lastReadAt }` |
| `lastSeenMessageId` only | `{ messageId, timestamp }` resolved from the cache |
| `lastReadAt` only | newest cached message **at or before** that timestamp |
| neither | no pointer — `historyFloor` takes over |

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
| `stores/shared/readStateArchive.ts` *(new)* | Cache-backed exact derivation over the whole archive via the `conv_timestamp` / `room_timestamp` range indexes, filtered by `isRenderableStoredMessage`, early-out at the display cap. | async |
| `stores/shared/notificationState.ts` *(shrinks)* | Keeps arrival / notify / badge logic. Loses `recomputeCountsFromPointer`, `onActivate`'s fallback ladder, `onMarkAsRead`'s `advanceSeenTo`. | sync |

## Data flow

**One recompute entry point.** `recomputeUnread(entityId)` is the sole writer of
`unreadCount` / `mentionsCount`. Triggers:

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
unavailable, the derivation falls back to counting the resident slice (a lower bound) and
*leaves the persisted count in place* rather than zeroing it. A zero badge produced by a
failed read is indistinguishable from "you are caught up" — the same shape as the B3
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

Three stacked PRs off `main`, reviewed as one slice at the end.

**PR A — `ReadPointer` + `historyFloor` + migration.** Behaviour-neutral: everything
computes exactly as today, just reading `readPointer.messageId` / `.timestamp` instead of
two independent fields. Touches `ROOM_META_FIELDS`, its chat equivalent, and the app's
`useSessionPersistence`. A base PR that changes no behaviour is a strong place to review a
persisted-shape change from.

The pointer object must come first: the archive count needs a *timestamp* floor, and
before migration the only timestamp available is the `lastReadAt` that lies.

**PR B — the derivation.** `readState.ts` + `readStateArchive.ts` + `recomputeUnread`,
count derived against the floor. Deletes both per-store async recount blocks and
`recomputeCountsFromPointer`.

**PR C — the writers.** Pointer reduced to the four writers; `onActivate`'s ladder
deleted; divider derived from the floor; gate 3 removed and gate 4 re-justified;
`resolveSeenStanzaId` cache-resolved; dead code removed.

## Risks

- **Deep-history rooms.** The cursor walk over a large unread range, bounded by the cap.
  `npm run test:scroll` is a required gate.
- **Multi-device read sync.** The publish path changes shape; the seed/echo-suppression
  logic in `mdsSideEffects` must keep working across the pointer refactor.
- **The migration is forward-only, like the bug.** A migration that over-advances is as
  unrecoverable as the defect it fixes. Mitigation is structural: every migration branch
  resolves at-or-behind today's effective position.
