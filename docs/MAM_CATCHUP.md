# MAM Catch-Up Strategy

This document describes how the SDK uses Message Archive Management (XEP-0313) to keep conversations and rooms up to date, both on initial connect and during normal use.

## Problem

When Fluux is closed, messages continue to flow between contacts and in rooms. On reconnect, only sidebar previews were refreshed (fetching the latest message per conversation). The actual message history was only populated lazily when the user opened each conversation. This meant messages exchanged while offline were not visible until the user navigated to every conversation individually.

Additionally, if a roster contact sent a message while offline but there was no prior conversation, the message would never be discovered, because the catch-up only covered conversations already in the store.

## Overview

The SDK uses a **hybrid lazy + background** approach organized into five layers:

| Layer | Trigger | Scope | Speed |
|-------|---------|-------|-------|
| **Preview refresh** | Connect | All non-archived conversations | Fast (max=5, concurrency=3) |
| **Conversation catch-up** | After preview refresh | All non-archived conversations | Slow (max=100, concurrency=2) |
| **Roster discovery** | Connect | Roster contacts without a conversation | Slow (max=50, concurrency=2) |
| **Room catch-up** | 10 s after fresh-session setup; per room on SM resume | Confirmed, inactive MAM-enabled rooms | Slow (max=100, concurrency=2) |
| **Lazy fetch** | User opens a conversation/room | Single conversation or room | On demand |

Additionally, once per day, archived conversations are checked for new activity and auto-unarchived if new incoming messages are found.

## Message Corrections

Corrections cross the SDK event boundary before history rows are deduplicated. The store checks
the target's author and applies the revision to the resident message or directly to its cached
row. This also covers background catch-up that only peeks at the cache. The original message's
timestamp and identity remain unchanged; reference aliases follow
[Message Identifiers](MESSAGE_IDENTIFIERS.md#3-canonical-identity-is-a-tiered-ladder-not-a-single-field).
Resident updates replay pending retractions when new aliases make their targets resolvable. Live
chat and room corrections also try the scoped cache handoff before creating a message for an unknown target.
Cache completions match the canonical target and author before copying correction content into a
resident row or preview. A source revision/payload precondition prevents a delayed completion from
replacing an intervening edit, while known predecessor evidence permits updating an older activation
snapshot; search indexing reconciles against the current cached row before atomically replacing
the document and its token postings. Both room preview projections change together. Account and
store-session changes cancel completion updates to resident state, including an account switch
away and back to the same JID.
Outgoing corrections select their predecessors at the current store/cache boundary after sending,
including when another device's edit arrived while encryption was pending. Genuine live mutations
also incorporate the current durable predecessor when the resident window is an older snapshot.
Their operation provenance is transient: history, decryption, and completion updates cannot reuse it.

Revision ordering uses archive chronology, known predecessor identities, and comparable live
observations within one receipt session. Receipt sequence is captured before asynchronous
decryption; counters from different sessions never order revisions. An archive echo can add aliases
and a date to the same revision without replacing its earliest live observation. Retained live and
archive observations are merged before content selection, including when the revision is an
alternative. Known archive provenance survives reloads, so a later live replay cannot gain fresh
ordering authority from its receipt alone.

An undated edit with evidence that it follows the held revision records that predecessor and the
archive chronology already observed. The signed content date retains its provenance separately,
including after deferred decryption; local wall clocks and signed device clocks do not order
revisions. Legacy rows without revision metadata have unknown chronology; a replay identified by
their known correction aliases cannot replace their saved text, while a genuinely new correction can. Selecting
legacy content also preserves its unknown revision identity; an older fetched revision cannot label it.

Equal-date room edits share their archive-order group across nickname changes when a stable
occupant ID identifies the author. Known target aliases share that group as well, including aliases
resolved by indexed, author-checked cache lookups when the original is outside the fetched page.
Conflicting archive revision IDs distinguish edits even when a sender reuses its client ID.
Predecessor identities retain their revision grouping; older flat predecessor metadata is read
conservatively so weak aliases cannot override conflicting archive identities.

Only observed predecessor relationships are retained. When two revisions cannot be ordered, the
unselected content and its metadata remain cached as an alternative. A provisional content choice
creates no predecessor proof; later archive evidence can resolve it. Distinct corrections sharing
an archive timestamp retain their observed entry order through predecessor identities, including
across contiguous query pages. Archive IDs and page positions are never converted into globally
sortable clocks.

When an incoming live correction leaves alternatives unresolved and MAM is supported or has
responded in the current session, its store/cache completion queues automatic archive reconciliation.
`MAM.reconcileCorrectionBatch` bounds each request and batch, first checking recent archive entries
and then walking forward from a known correction or original-message cursor. The walk retains its
cursor and observed order across batches up to a captured archive endpoint; a batch limit does not
discard unresolved work. It stops on resolution or retraction, that endpoint, archive completion,
missing or repeated cursors, request failure, or account/session/target invalidation. If evidence
remains unavailable, the alternatives survive for later evidence. Returned modifications must
resolve through the scoped, author-checked reference lookup to the queued canonical target,
including original IDs absorbed by an earlier cache merge.

Before emitting or returning history, queries reconcile their rows through read-only store/cache
bindings using the same revision selection as persistence. Reconciliation copies correction content
and identity/retraction metadata, preserving the fetched page's reactions and other history fields.
Bounded search-context queries retain a newer cached edit even when its correction lies outside the
requested window. Failed cache reads fall back to fetched history and resident revisions. Queries
cancel when their initiating account or session changes, without emitting stale history or status.
Cache hydration refreshes correction state after its initial read and reconciles duplicates with
the current resident rows and previews, including latest and around-message loads. It preserves
resident reactions and rejects obsolete account, store, or entity generations.
Deferred recovery carries a write precondition naming the source payload, revision, author,
occupant and account. Resident messages, cached rows and sidebar previews independently check
that precondition before accepting recovered content or clearing the payload. A selected encrypted
correction is queued for recovery even when its original is outside the resident window.

Revision selection is implemented in `packages/fluux-sdk/src/core/types/message-internal.ts`;
the store/cache integration regressions are in
`packages/fluux-sdk/src/utils/messageCache.corrections.test.ts`.

## Detailed Flow

### 1. Preview Refresh (fast, sidebar)

Triggered immediately when the connection comes online and MAM is discovered.

- Calls `refreshConversationPreviews()`.
- For each non-archived conversation, queries the archive with `max=5` to fetch only the most recent messages.
- Updates `lastMessage` in the store so the sidebar shows correct previews.
- Runs at **concurrency 3** to complete quickly.

### 2. Conversation Catch-Up (slow, background)

Chains after the preview refresh completes.

- Calls `catchUpAllConversations()`.
- For each non-archived conversation:
  - If there are cached messages: sends a **forward query** with `max=100`,
    preferring an id-exact `after` cursor from the held archive edge. When the
    edge has no archive id, such as the user's own last send, it falls back to
    an inclusive `start` timestamp.
  - If no cached messages exist: sends a **backward query** with `before=""`, `max=50` to fetch the latest messages.
- A completed forward walk can seed a missing contiguous-coverage record. The
  resume cursor is the preferred bottom; a timestamp-resumed walk instead uses
  the oldest persistable archive id returned by that whole walk. An incomplete
  walk never seeds coverage.
- Coverage keeps raw MAM `bottomId` / `topId` cursors for pagination, including
  cursors that name bodyless signals. Its separate `countBottomId` names a
  persistable message from the same contiguous walk. `null` means the walk has
  no materialized counting anchor yet; legacy records without the field still
  resolve their raw bottom through the cache.
- Coverage changes wait for the walk's cache writes to succeed, then trigger
  an unread recount, including for the active conversation. Signal-only walks
  retain their pagination cursors but cannot certify an unread count.
- A completed forward catch-up can also repair an unusable counting anchor,
  even when it returns no messages. The replacement must resolve from that
  walk's resume cursor or persistable extent; an unrelated cached message is
  not proof of continuity. Repair rebases coverage conservatively and never
  moves the read pointer. Bounded repair queries and walks carrying message
  modifications cannot certify coverage without a durability proof.
- For an inactive entity whose XEP-0490 read marker is still unresolved, a
  second phase walks backward from the live-edge window toward that marker. A
  page cap, an active-entity bail, a missing or non-advancing cursor, and a
  cache-seeded archive-start response are inconclusive, so the marker remains
  pending. A complete response proves absence only after the walk descended
  from the live edge, or when a fetch-latest response returned the whole
  archive.
- When the server proves that the frozen marker is absent and it has not been
  replaced during the walk, the chat or room store removes only that pending
  marker, recomputes unread from the local pointer, and allows the local read
  position to publish. The read pointer itself never moves. A session-scoped,
  account-and-entity-keyed negative cache prevents the same stale MDS seed from
  restoring the marker before the replacement publish lands; seedless passes
  remain pending for a later session.
- Runs at **concurrency 2** to be gentle on the server.
- Errors are silently ignored per conversation (best-effort).

### 3. Roster Discovery (new conversations)

Runs in parallel with stages 1-2.

- Calls `discoverNewConversationsFromRoster()`.
- Gets all roster contacts via `sortedContacts()`, then filters out those that already have a conversation in the store (active or archived) using `hasConversation()`.
- For each remaining contact, sends a **backward query** with `before=""`, `max=50` to discover any messages.
- If messages are found, the MAM result handler automatically creates the conversation entry in the store.
- Runs at **concurrency 2**.
- Errors are silently ignored per contact (best-effort).

### 4. Room Catch-Up (delayed, background)

Triggered 10 seconds after fresh-session setup, giving rooms time to finish joining via bookmarks and to discover MAM support.

- Filters rooms to those that confirmed self-presence in the current session,
  are still joined, support MAM, are not Quick Chat rooms, and are not active.
- Peeks at each room's cached messages and uses the same forward/backward query,
  coverage-bootstrap, durability, and unread-recount rules as conversation
  catch-up.
- Revalidates the session, membership, active room, and foreground ownership
  after cache hydration so an obsolete background attempt cannot query MAM.
- Rooms that join or discover MAM after the initial pass are caught up once
  eligible. If a foreground attempt releases an inactive room, ownership is
  handed to this background path rather than issuing overlapping queries.
- Runs at **concurrency 2**.
- The 10-second timer is cancelled on disconnect and cleaned up on subscription teardown.

On an SM resume the delayed pass never runs, so room coverage comes from the
resume seed instead: rooms joined, MAM-enabled, inactive, and **not** already
caught up to live are queried with `catchUpRoom`. Caught-up rooms are skipped:
SM replayed their traffic, and re-querying them on every resume is exactly the
cost this predicate avoids.

The seed is evaluated per room rather than once, because `handleSmResumption`
re-fetches bookmarks after a long disconnect and joins any room that is not
currently joined, hundreds of milliseconds after the resume event. Such a room
is not in `joinedRooms()` when the resume handler runs, and the fresh-session
triggers that would otherwise cover it (the `room:joined` catch-up, the late-MAM
retry, the `mucJoined` preview fetch) are all disabled on a resumed session. It
therefore joins and is caught up as it becomes eligible, once per session.

### 5. Lazy Fetch (on demand)

Triggered by side effects when the user opens a conversation or room.

- If the conversation/room has cached messages: use the same id-exact forward
  cursor or inclusive timestamp fallback as background catch-up.
- If no cached messages: backward query for recent history.
- On a fresh session, the active room may display hydrated cache immediately,
  but it waits for successful self-presence (`room:joined`) in that session
  before querying its archive.
- A successful SM resume trusts preserved room membership and does not repeat
  foreground MAM for an archive already held locally. A room whose archive has
  never been held remains eligible on first open or late MAM discovery.
- The active-room catch-up revalidates room, join, and connection state after
  cache hydration; a superseded attempt cannot query MAM or clear its
  replacement's tracking.
- MAM support discovered asynchronously can trigger the active-room fetch only
  after the same session/join eligibility checks pass.

The detailed fresh-session, SM-resume, and cache-hydration invariants are owned
by the [confirmed-join design](superpowers/specs/2026-07-27-room-mam-after-join-design.md).

## Deduplication

The store layer deduplicates returned messages through the
[message-identity boundary](MESSAGE_IDENTIFIERS.md#3-canonical-identity-is-a-tiered-ladder-not-a-single-field).
In addition, the foreground and delayed room paths coordinate ownership: the background pass
excludes the active room, observes foreground coverage for the current
membership, and accepts a released attempt only after the room becomes
inactive. This prevents duplicate room archive queries instead of relying on
store deduplication alone.

## Concurrency

Preview, catch-up, and roster-discovery passes use `executeWithConcurrency()` from
`utils/concurrencyUtils.ts` to limit parallel MAM requests:

| Operation | Concurrency |
|-----------|-------------|
| Preview refresh | 3 |
| Conversation catch-up | 2 |
| Roster discovery | 2 |
| Room catch-up | 2 |

Lower concurrency for catch-up keeps server load reasonable during background work.

## Key Files

| File | Role |
|------|------|
| `packages/fluux-sdk/src/core/modules/MAM.ts` | MAM query methods, preview refresh, catch-up, roster discovery |
| `packages/fluux-sdk/src/core/backgroundSync.ts` | Orchestrates all background sync stages on connect |
| `packages/fluux-sdk/src/core/chatSideEffects.ts` and `roomSideEffects.ts` | Active conversation/room cache and MAM triggers |
| `packages/fluux-sdk/src/core/roomMamHandoff.ts` and `roomMembershipEpoch.ts` | Coordinates foreground/background room ownership across membership changes |
| `packages/fluux-sdk/src/utils/mamCatchUpUtils.ts` | Selects id or timestamp catch-up anchors and derives a walk's persistable extent |
| `packages/fluux-sdk/src/stores/shared/mamCoverage.ts` | Owns coverage bootstrap and extension rules |
| `packages/fluux-sdk/src/stores/shared/purgedMarkers.ts` | Holds session-scoped proofs for absent XEP-0490 markers |
| `packages/fluux-sdk/src/utils/concurrencyUtils.ts` | `executeWithConcurrency()` utility |
| `packages/fluux-sdk/src/core/modules/MAM.catchup.test.ts` | Tests for catch-up and discovery methods |
| `packages/fluux-sdk/src/core/roomSideEffects.test.ts` and `backgroundSync.test.ts` | Tests for room trigger, ownership, and handoff wiring |

## Sequence Diagram

```
Connect / Reconnect
│
├─ MAM support discovered
│  │
│  ├─ refreshConversationPreviews()              ← concurrency 3, max=5
│  │  └─ then: catchUpAllConversations()         ← concurrency 2, max=100
│  │
│  ├─ refreshArchivedConversationPreviews()      ← once per day
│  │
│  ├─ discoverNewConversationsFromRoster()       ← concurrency 2, max=50
│  │
│  └─ setTimeout(10s)
│     └─ confirmed inactive room catch-up        ← concurrency 2, max=100
│
├─ User opens conversation
│  └─ fetchMAMForConversation()                  ← on demand, forward query
│
├─ Fresh-session self-presence for active room
│  └─ fetchMAMForRoom()                          ← after cache + eligibility checks
│
├─ Successful SM resume
│  └─ trust membership; skip held room archive
│
└─ User opens eligible room
   └─ fetchMAMForRoom()                          ← on demand, cache first
```
