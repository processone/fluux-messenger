# Throttled localStorage persistence for chatStore and roomStore

**Date:** 2026-07-24
**Status:** Approved after four review rounds. **Split during planning:** the throttle
(§1, §2 items 1-4, §3, §4, §5.1/5.3/5.4) ships first — see
[the plan](../plans/2026-07-24-throttled-persist.md). The compat-map removal (§2 item 5 and the
§5.2 compat/rebuild-fidelity tests) is deferred to its own cycle; see §2.2 below.

## Problem

`chatStore` wraps its store in zustand `persist` with a custom `storage` adapter
([chatStore.ts:2945](../../../packages/fluux-sdk/src/stores/chatStore.ts)). The adapter's `setItem`
runs `serializeState` → `JSON.stringify` → synchronous `localStorage.setItem`, with no throttling.
It therefore runs on **every** `set()` — including every `setMAMLoading` toggle and every
`mergeMAMMessages` page merge during post-connect catch-up.

`partialize` persists `conversationEntities`, `conversationMeta` **and** the full `conversations`
compat map — the same data a second time — plus archived/drafts/gaps/coverage/pendingRetractions.
Each write is O(number of conversations) regardless of what actually changed.

Measured under vitest with an in-memory backing store on a fast machine (floors, not ceilings). A
simulated catch-up of 180 MAM pages / 9000 messages produced 180 localStorage writes. Holding the
merge workload constant and varying only conversation count:

| Conversations | Time | Bytes written |
|---|---|---|
| 10 | 27 ms | 1.5 MB |
| 100 | 148 ms | 6.5 MB |
| 400 | 403 ms | 23.6 MB |

On mobile WebKit, where `localStorage.setItem` is a synchronous disk write and JS is several times
slower, this is a main-thread stall during the launch catch-up window.

`roomStore` has the same defect on the MUC side: `persistRoomReadState` is called from 9 sites —
several on message-arrival paths that also fire during catch-up — and each call projects all of
`roomMeta` and writes it synchronously. Five sibling helpers (drafts, voted polls, dismissed polls,
gaps, coverage) share the shape.

## Scope

In scope for the **first PR**: a shared throttle module, wired into `chatStore`'s persist adapter
and `roomStore`'s six storage helpers; an explicit flush on Tauri app quit; narrowing the SDK's
zustand peer range to `^5.0.0` (§1.3).

In scope for this **design**, but deferred out of the first PR: removal of the duplicated
`conversations` array from the persisted chat blob (§2 item 5, §2.2, and the compat and
rebuild-fidelity tests in §5.2). It ships in its own cycle — see §2.2 for why and for the agreed
approach.

Out of scope: moving the blob to IndexedDB. `deserializeState` is synchronous on the startup path
and the read-pointer restore ordering (#1081) depends on that, so an async rehydration is a separate
design. Also out of scope: retiring the in-memory `conversations` compat map, which has ~25 readers.

## Key prior finding

`deserializeState` **already rebuilds** the `conversations` compat map from `conversationEntities` +
`conversationMeta` ([chatStore.ts:899-907](../../../packages/fluux-sdk/src/stores/chatStore.ts)).
The persisted `conversations` array is read only in the legacy branch, taken when
`conversationEntities`/`conversationMeta` are absent — i.e. for blobs written before the entity/meta
split. Dropping it from `partialize`/`serializeState` therefore requires no reader changes and does
not retire the legacy read path; it only stops writing the duplicate.

An audit of all 22 sites that write `conversations` found the compat map updated in lockstep with
`conversationMeta` at every one, and `conversationEntities` at creation. But an audit of *call
sites* cannot show that the resulting *values* agree — see the rebuild-fidelity invariant in §5.2,
which is what actually licenses the removal.

## 1. Shared module — `stores/shared/throttledStorage.ts`

A per-key leading + trailing throttle over `localStorage`.

```ts
export function schedule(key: string, produce: () => string): void
export function flushKey(key: string): void
export function cancel(key: string): void
export function flush(): void
export function _resetForTesting(): void
```

`flush` is re-exported from the SDK's public `index.ts` as **`flushPersistentStorage`** — the
generic name is meaningless at the package boundary, where callers (§4.1) are flushing storage, not
some unspecified queue.

The module is a **singleton** holding one timer registry keyed by storage key, not a factory. A
singleton is what lets one `pagehide` handler flush every key — chat blob, room read state, gaps,
coverage — in a single pass. `_resetForTesting` clears the registry and pending timers between
suites, following the `_clearAllRoomReadStateForTesting` precedent in `readStateStorage.ts`.

`schedule` takes a **lazy thunk, not a string**. The expensive part of a persist is
`serializeState` + `JSON.stringify`, not `setItem` alone. Coalesced writes never invoke `produce`,
so a 180-page catch-up costs ~20 serializations rather than 180. Passing an already-serialized
string would leave most of the CPU cost in place.

Semantics, per key:

- **No window open** → invoke `produce()` and write synchronously (leading edge); open a 1000 ms
  window.
- **Window open** → stash the thunk, replacing any earlier pending thunk.
- **Timer fires** → if a thunk is pending, write it and open a *new* window; otherwise close the
  window.

The "open a new window" branch is what makes this a throttle rather than a debounce. A debounce
resets its timer on every write and so, during a continuous burst like a 180-page catch-up, defers
the write for the entire burst — leaving all of it at risk on an abrupt close. A throttle writes at
a steady ~1/second and is never starved. On-disk state is never more than 1 s stale.

Window: **1000 ms**. `stateSnapshot.ts` uses `PERSIST_DEBOUNCE_MS = 500` for the SM snapshot; this
module is deliberately a different mechanism with a different constant, and does not share it.

`flushKey(key)` is the durability escape hatch (§1.2): it writes that key's pending thunk if there
is one, then **closes** the window, so the next `schedule` for that key writes immediately on its
leading edge rather than being coalesced behind a stale window. It carries no thunk of its own — it
reuses whatever the caller already scheduled.

### 1.1 Error absorption and flush semantics

Every current call site swallows storage errors (quota exceeded, private-mode denial) and continues
without persistence. The module preserves that exactly: errors thrown by `produce()` **and** by
`localStorage.setItem` are caught and discarded on all four paths — leading edge, timer callback,
`flush` and `flushKey`. A throwing `produce` must not leave a timer armed or a window half-open, and
must not propagate out of a `set()` call or a `pagehide` handler.

`flush()` writes every pending thunk, clears all timers, and **closes** all windows. A `schedule`
arriving after a flush therefore starts a fresh window and writes immediately. This is the right
semantics for `pagehide` (the page is dying) and makes test sequencing unambiguous.

Flush triggers are registered lazily on the first `schedule` call, guarded by
`typeof window !== 'undefined'` so there is no import-time side effect and headless/bot SDK usage is
unaffected: `pagehide`, `visibilitychange` when `document.visibilityState === 'hidden'`, and
`beforeunload`. `pagehide` and `visibilitychange` are the ones that fire reliably on mobile WebKit;
`beforeunload` is desktop belt-and-braces.

### 1.2 Not everything in the blob is "slightly stale state"

The throttle is safe for state that is a *lagging mirror* of something reconstructible. It is not
safe for a record of a **durable event that arrived once and will not arrive again**. The chat blob
contains one of each, and the design must not treat them alike.

`pendingRetractions` is the second kind. It records an XEP-0424 retraction whose target message was
not resident when it arrived ([chatStore.ts:2150](../../../packages/fluux-sdk/src/stores/chatStore.ts)),
so the tombstone can be applied when the target loads. Losing that entry is not redundant work: once
the coverage record marks the surrounding range as covered, MAM will not re-query it, the retraction
is never re-delivered, and the message stays visible forever. A user asked for a message to be
un-shown and it stays shown.

`roomStore` already treats it as the durable kind — room pending retractions live under their own
key, written synchronously ([roomStore.ts:607](../../../packages/fluux-sdk/src/stores/roomStore.ts)),
and are **not** among the six helpers this design throttles. The chat/room asymmetry is resolved in
favour of the room behaviour.

**Resolution:** `recordPendingRetraction` — the `set()` at
[chatStore.ts:2150-2155](../../../packages/fluux-sdk/src/stores/chatStore.ts) that appends to
`pendingRetractions` — is followed by `flushKey(chatStorageKey)`. The `set()` has already driven the
persist adapter, so the blob carrying the retraction is either on disk (leading edge) or sitting in
the pending thunk; `flushKey` guarantees the second case lands and leaves the first alone.

**Why `flushKey` and not a `writeNow(key, produce)` that serializes on the spot.** In the idle case
`schedule` has *already* serialized and written on its leading edge, so a `writeNow` would serialize
the whole blob a second time and write it again — two full O(conversations) serializations for one
retraction. It would also duplicate the exact serialization expression the adapter owns, and would
have to re-derive the scoped key that the adapter captured eagerly. `flushKey` reuses both.

**This depends on zustand's `persist` calling `setItem` synchronously inside `set()`, and that is a
load-bearing assumption, not a robustness property.** `flushKey` can only flush a thunk that has
already been registered; if the adapter were driven later, `flushKey` would close an empty window
and the eventual `schedule` would write on its own leading edge *at that later time* — still
deferred, still lost to a hard kill in between.

Verified against the installed build (zustand 5.0.13,
`node_modules/zustand/esm/middleware.mjs:370-374`). `recordPendingRetraction` is defined in the
store initializer, so its `set` is the wrapper `persist` passes to `config`:

```js
const configResult = config(
  (...args) => {
    set(...args);
    return setItem();
  },
```

`setItem` runs synchronously before the action returns, so by the time `recordPendingRetraction`
calls `flushKey`, the thunk is registered. (The `api.setState` override at 366-368 has the same
shape and covers callers that reach the store directly, such as `applyMigratedReadPointer`; the
retraction path is the `config` wrapper.)

Because this is an assumption rather than a guarantee, §5.2 pins it with a test that asserts
`recordPendingRetraction()` has persisted *before it returns*. If a zustand upgrade ever defers the
adapter, that test fails rather than the retraction silently becoming losable.

### 1.3 Narrow the zustand peer range to `^5.0.0`

`packages/fluux-sdk/package.json` declares zustand as a peer at `^4.0.0 || ^5.0.0`. That lower
bound is already unsound, independently of this change: v4.0.0's `persist` took
`getStorage`/`serialize`/`deserialize`, not a `storage` object. On 4.0.0 the custom adapter in
`chatStore` would be an unrecognized option and silently ignored — falling back to plain
`localStorage` with default JSON serialization, which turns every persisted `Map` into `{}`. The
store has never worked on the declared lower bound.

This design adds a second dependency on v5 (synchronous `setItem`, §1.2), so the range is corrected
here rather than left as an open question:

```json
"zustand": "^5.0.0"
```

This is not dropping working support — it is removing a claim that was never true. Genuinely
supporting 4.x would need an alternative adapter shape and a minimum-version test matrix, far
outside the scope of a persistence optimization. The app already pins `^5.0.0`, so nothing in this
repo changes behaviour.

Not verified empirically: v4.0.0 was not installed to reproduce the fallback. The reasoning is from
the v4.0.0 `persist` source. Since the outcome is narrowing a range rather than relying on v4
behaviour, an incorrect reading costs nothing.

Rejected alternative: splitting `pendingRetractions` into its own key, matching roomStore's layout.
That is the cleaner long-term shape, but it changes the persisted blob format and needs its own
migration for entries already on disk. `flushKey` gets the same durability with no format change.

## 2. chatStore

1. `setItem` → `schedule(scopedKey, () => JSON.stringify({ state: serializeState(state, scopedKey) }))`.

   **The key is resolved eagerly, at schedule time**, not inside the thunk. This is what makes
   account switching safe by construction: a trailing write that fires after a `switchAccount`
   lands under the key that was current when its state was produced, never under the newly
   switched-to account's key. Resolving the key inside the thunk would write account A's data under
   account B's key.

2. `removeItem` → `cancel(key)` before `localStorage.removeItem(key)`.

3. `switchAccount` → `flush()` before `set(loadScopedChatState(jid))`, so the outgoing account's
   blob is current on disk and an immediate switch-back cannot read a stale one.

4. `recordPendingRetraction` → `flushKey(scopedKey)` after the `set()`, per §1.2.

5. **Drop the compat map:**
   - Remove `conversations` from `partialize`.
   - Remove the `conversations` line from `serializeState`'s return, and drop `'conversations'`
     from its `Pick<...>` parameter type.
   - `PersistedState.conversations` becomes optional (`conversations?: [string, PersistedConversation][]`).
   - The legacy read branch guards with `(persisted.conversations ?? [])`.
   - `withUnmigratedReadState` is then called once per serialize instead of twice.
   - `migrateLegacyConversationListsToScoped` stops passing `conversations` into `serializeState`;
     the blob it writes carries entities + meta, which the new-format read branch handles.

### 2.1 What `reset()` actually does, and why it is left alone

`reset()` calls `localStorage.removeItem(key)` and *then* `set(createEmptyChatState())`
([chatStore.ts:2923-2941](../../../packages/fluux-sdk/src/stores/chatStore.ts)). Zustand `persist`
writes after every `set`, so that trailing `set` re-creates the key holding an **empty** blob. That
is true today, synchronously — the key has never been absent after logout, throttle or no throttle.

This design keeps that behaviour unchanged. Two consequences:

- The invariant to assert is "**no pre-logout data survives**", not "the key is absent". The
  original draft of this spec asserted the latter, which has never been true.
- `cancel(key)` in `removeItem` is **belt-and-braces for chat**: the trailing `set(empty)` targets
  the same key and supersedes any pending thunk regardless. It is genuinely load-bearing for
  *roomStore* (§3.2), where the `removeItem` calls are not followed by anything that re-triggers
  those helper writes.

Reordering to `set` → `cancel` → `removeItem` to make the key truly absent was considered and
**rejected**. `loadScopedChatState` treats a missing key as a cue to run
`migrateLegacyConversationListsToScoped`, which reads the *legacy unscoped* key
([chatStore.ts:1074](../../../packages/fluux-sdk/src/stores/chatStore.ts)). A user who still had a
legacy blob at logout would have it re-migrated on next login. The empty blob suppresses that, so it
is load-bearing and stays.

### 2.2 The compat-map removal is deferred, and how it must be proven

Item 5 above is **not** in the first PR. Two reasons:

1. **It is independent and much less of the win.** The throttle cuts the write *count* from 180 to
   ~20 — that is the main-thread stall. Removing the compat map only halves each remaining write's
   *size*. Coupling them makes the cheap, safe change wait on the expensive, risky one.
2. **It carries a silent-data-loss mode.** `deserializeState`'s rebuild emits only conversations
   having *both* an entity and a meta, and it merges `{ ...entity, ...meta }`. Any conversation whose
   `conversationMeta` drifted from `conversations` — updated in one map, stale in the other — loses
   the drifted field on the next reload, with no error. Nothing surfaces it.

An audit of the 22 write sites is not sufficient evidence, and neither is a test that drives a
handful of them: a regression in any single uncovered path (corrections, reactions, retractions,
receipts, delivery errors, moderation, markers, send state) reintroduces the drift while the test
stays green.

**Decided approach for that PR: centralize, then test the centre.** Route all 22 `conversations`
replacements through one helper that writes `conversationEntities` and `conversationMeta`
alongside, then test that helper plus whatever genuine exceptions remain. This converts an
obligation that 22 call sites must each remember into a structural guarantee a new write site cannot
quietly opt out of — and it is the shape CLAUDE.md's "avoid duplicate code, isolate behaviour" rule
already asks for.

A 22-case matrix was considered and rejected as the *primary* mechanism: it proves today's state
without constraining tomorrow's, so the 23rd write site added next quarter is not covered by
anything. A matrix is still worth having over the helper's exceptions.

The §5.2 "equality after flush" test should also deep-compare the persisted projection against the
expected unthrottled serialization, rather than spot-checking a couple of ids.

## 3. roomStore

Changes, as an explicit list:

1. Route all six writers through the shared module, each under its own resolved storage key so room
   read state coalesces independently of gaps and coverage: `saveDraftsToStorage`,
   `saveVotedPollsToStorage`, `saveDismissedPollsToStorage`, `saveGapsToStorage`,
   `saveCoverageToStorage`, and `persistRoomReadState` (via `saveRoomReadState`).
2. `savePendingRetractionsToStorage` is deliberately **excluded** and stays synchronous, per §1.2.
3. `persistRoomReadState` captures the map into a local before scheduling (§3.1).
4. **`roomStore.switchAccount` calls `flush()` before reassigning `persistedRoomReadState` and
   before `set(createEmptyRoomState(...))`.** The reason is freshness on an immediate return to the
   outgoing account: without the flush, A's last mutations sit in a pending thunk while
   `switchAccount` back to A runs `loadRoomReadState(A)` against a blob that predates them, and the
   stale load then becomes the live state. (It is *not* needed to keep a delayed write off the
   reassigned binding — the local capture in §3.1 already handles that.)
5. `roomStore.reset` cancels all seven keys before clearing them (§3.2).
6. `clearRoomReadState` and `_clearAllRoomReadStateForTesting` cancel before removing (§3.2).
7. The `resolveRoomReadPosition` doc comment is corrected (§3.3).

### 3.1 Trap: capture the map reference, not the module binding

`persistedRoomReadState` is a module-level `let` that `switchAccount` **reassigns**
([roomStore.ts:1635](../../../packages/fluux-sdk/src/stores/roomStore.ts)). A thunk written as
`() => serialize(persistedRoomReadState)` reads the *binding* at flush time, so a pending write for
account A's key would serialize account B's freshly loaded map and write it under A's key.

`persistRoomReadState` must capture the map **by reference into a local** before scheduling:

```ts
const snapshot = persistedRoomReadState
schedule(key, () => serializeRows(snapshot))
```

The map is mutated in place via `.set()` rather than replaced, so holding the reference still gives
latest-value semantics within an account — which is the desired behaviour — while `switchAccount`'s
reassignment leaves the old reference pinned to the old account's data.

**Honest accounting of what guards what.** Because `switchAccount` flushes *before* reassigning
(§3 item 4), every pending thunk has already run while the binding still pointed at the old map. The
flush is therefore the actual guard, and the reference capture is unreachable defence-in-depth: with
the flush in place, deleting `const snapshot = ...` changes no observable behaviour, so no
end-to-end test can distinguish the two. §5.3's A → B → A case catches *both* being removed, not the
capture alone.

The capture stays anyway — it is one line, and it is what makes the trap survivable if a later
change reorders or drops the flush. But it must be documented at the call site as depending on the
flush for its testability, so that a future PR removing the flush understands it is promoting this
line from insurance to load-bearing. Extracting the scheduling into a separately testable function
with an artificial reassignment was considered and rejected: it would test a state the production
path cannot reach, which is its own species of hollow test.

`chatStore` has no equivalent trap: `serializeState` closes over the partialized snapshot passed
into `setItem`, and store state objects are replaced, not mutated.

### 3.2 Every clear path must cancel first

`roomStore.reset()` issues six `localStorage.removeItem` calls plus `clearRoomReadState()`. Each
needs a `cancel(key)` first. Unlike chat (§2.1) this is load-bearing: nothing after the removal
re-triggers those helper writes, so a pending thunk that fires afterwards resurrects logged-out room
read state, gaps or drafts under a key that was just cleared.

The same applies to two paths in `readStateStorage.ts`:

- `clearRoomReadState(jid)` must `cancel` its resolved key before removing it.
- `_clearAllRoomReadStateForTesting` must `cancel` every key in `writtenRoomReadStateKeys` before
  removing them, or a timer armed by one test fires during the next and reintroduces a row the
  cleanup just deleted — a cross-test-contamination source that would look like a flaky suite.

### 3.3 Stale rationale to correct in `resolveRoomReadPosition`

The doc comment on `resolveRoomReadPosition`
([roomStore.ts:300](../../../packages/fluux-sdk/src/stores/roomStore.ts)) currently reasons:

> the SDK state snapshot is debounced by 500 ms, while the durable `readStateStorage` row is written
> synchronously on every advance — so a snapshot restored after a crash is routinely BEHIND the row
> it shadows

Throttling `persistRoomReadState` invalidates the premise: the durable row becomes lagging too, by
up to 1000 ms, and after a crash it can now be the *older* of the two mirrors rather than always the
fresher one.

**The "take the later" rule remains correct.** Its stated invariant is that both `room` (from the
state snapshot) and `restored` (the durable row) are lagging mirrors of one store pointer, so
neither can be ahead of the user's true position. Throttling makes the row lag *more*; it cannot
make it lead. "Take the later" still only ever recovers the freshest mirror.

But the comment's *reasoning* becomes false and would mislead the next reader, so it must be updated
in this change to say both mirrors now lag (snapshot 500 ms, row up to 1000 ms) and that the rule
holds because both still lag rather than because one is synchronous.

## 4. Durability analysis

A hard kill (SIGKILL, force-quit, OOM, crash) within the 1 s window loses at most that window's
mutations. Per persisted map, the *direction* of that loss:

| Data | Loss on hard kill | Class |
|---|---|---|
| Read pointers | Under-advances: a few messages re-shown as unread. Forward-only, so the throttle cannot over-advance — the unrecoverable direction stays unreachable (#1081). | Lagging mirror |
| Gaps / coverage — **monotone** advances (gap shrink/close, coverage deepening) | Gap re-healed or coverage re-walked next session. | Lagging mirror |
| Gaps / coverage — **structural** transitions (new gap formation, gap boundary advance, coverage replacement/removal) | **A newly formed gap is silently lost and NOT re-detected; a lost boundary advance leaves a stale anchor a later "load older" page can erase outright; an invalidated coverage record survives and Phase B seeds from it, skipping the disconnected interval.** | **Durable event** |
| Drafts / poll state | Up to 1 s of typing, or one vote flag. | Lagging mirror |
| **Pending retractions** | **A retraction is forgotten and the message is never tombstoned. Not recoverable — the covered range is not re-queried.** | **Durable event** |

Read pointers, drafts/polls, and the *monotone* gap/coverage moves are bounded-redundancy losses in
the safe direction. Pending retractions and the *structural* gap/coverage transitions are not — both
are excluded from coalescing (§1.2, §4.2).

### 4.2 Gaps and coverage are only half lagging mirrors

The first draft of this design classified the whole gap and coverage maps as lagging mirrors, on the
reasoning that a lost write costs a re-detection or a re-walk. That is true for monotone moves and
**false for the transitions that create or invalidate structure.** Both modules say so themselves:

- `mamGap.ts`'s module doc: gaps are persisted *"so the 'Load missing messages' marker survives a
  reload — otherwise the next session's catch-up cursor (which sits above the gap after the
  session-start fix) would never re-detect it, leaving the gap silent again."* A lost **gap
  formation** is not re-detected. The cursor has already moved above the hole.
- `mamCoverage.ts` calls a `CoverageRecord` *"POSITIVE, DURABLE data"* that *"must never point past
  data that was never stored."* `syncCoverageAfterArchiveMerge`'s `isFetchLatest` branch, when
  `sawCoverageTop` is false — contiguity with the existing record actively **disproven** — replaces
  the record wholesale with `{ bottomId: rsmFirst }`. A lost **replacement** leaves the stale deeper
  record on disk asserting contiguity that was just disproven; Phase B seeds its backward walk from
  it and skips the disconnected interval.

Note these two compound: the gap that would have flagged the hole is lost by the same crash that
preserves the coverage claiming there is no hole.

**Ordering is not available as a discriminator.** `mamGap.ts` states archive ids are non-sequential,
so a store-level helper cannot compare two `bottomId`s and decide which is deeper. Any rule that
depends on ordering ids is unimplementable here.

**Resolution.** Force these transitions out of the window, keeping the throttle for ordinary
monotone advances:

| Map | Transition | Treatment |
|---|---|---|
| gaps | key **added** (formation) | force-flush |
| gaps | `start` / `startId` **changed** (the hole moves UP) | force-flush |
| gaps | shrink / close / removal (`end` moves down) | throttle — a stale gap costs a redundant re-heal |
| coverage | key **added**, `bottomId` **changed**, key **removed** | force-flush |
| coverage | `topId`-only change (re-entry marker) | throttle |

> **The coverage rows above are SUPERSEDED by
> [#1138](2026-07-28-coverage-persistence-cost-design.md).** The "measured follow-up" at the end of
> this section turned out to understate the problem: measurement showed the conservative
> `bottomId`-changed rule cost the *entire* benefit of the throttle on a first session — 400 writes
> and 88.9 MB on the reference profile, identical to the pre-throttle baseline. `created` and
> `deepened` are now throttled, signalled by `CoverageTransition` out of
> `syncCoverageAfterArchiveMerge`; only `replaced` and removal still force a flush. **The gap rows
> are unchanged.** See that document for the current decision table.

**Why the gap rule keys on the lower BOUNDARY, not just the key.** Key-presence alone does not catch
an in-place interval **advance** — the same id's gap moving from `{ start: 1000 }` to
`{ start: 99000 }`, which is the *normal* shape of a multi-page forward catch-up, where each
incomplete page rewrites the same key with a higher hole. Measured under a key-presence-only rule:
zero additional writes, memory at 99000 while disk still holds 1000.

An earlier revision of this section judged that survivable, on this reasoning:

- A gap's `start` / `startId` for an **existing** key only ever move **upward**.
  `syncGapAfterArchiveMerge`'s forward branch takes `start` from `forwardGapTimestamp`, which
  `mamState` sets to the incomplete page's newest fetched timestamp — and each page resumes above the
  last — and `startId` from that merge's `rsm.last`. The backward branch never moves `start` at all:
  `closeGapWithBackwardPage` only lowers `end`.
- So a stale record's anchor always sits **below** the true hole, never above it.
- And `selectCatchUpQuery` gives a recorded gap boundary **priority** over the cached edge ("a
  recorded forward gap wins", [mamCatchUpUtils.ts:217-222](../../../packages/fluux-sdk/src/utils/mamCatchUpUtils.ts)),
  consumed via `io.getGapStart()` / `io.getGapStartId()` in
  [MAM.ts:1478-1480](../../../packages/fluux-sdk/src/core/modules/MAM.ts) — so the next session
  resumes *below* the lost hole and re-detects it.

**That reasoning holds only while the stale interval survives, and it is not guaranteed to.** A
backward "load older" page landing between the stale anchor and the true one hits the opposite branch
of `closeGapWithBackwardPage` ([mamGap.ts:239-243](../../../packages/fluux-sdk/src/stores/shared/mamGap.ts)):
with the true anchor `newestTs <= start` leaves the gap standing, while with the stale one
`oldestTs <= start` **clears** it. The hole above is then unrecorded while the forward cursor already
sits above it — permanent, silent history loss, from one crash inside the window plus a scroll-up. A
throttle must not introduce a permanent-loss path that did not exist before it (every gap write was
synchronous beforehand), so **`start` / `startId` are in the signature and the residual is closed.**

`end` / `endId` deliberately are **not**. The asymmetry is the whole point: `start` advancing is the
hole moving up, and its loss is unrecoverable; `end` shrinking is the hole closing from below, and a
stale un-closed gap only costs a redundant re-heal. The "shrink / close / removal → throttle" row
above still holds, and is pinned by `still coalesces a gap shrink once the baseline is established`
(§5.3, driven through a real backward merge) and `leaves an end-only shrink throttled` (§5.6).

**The cost is bounded, and was measured rather than assumed.** `MAM_CATCHUP_FORWARD_BAIL_PAGES` = 3
([mamCatchUpUtils.ts:58](../../../packages/fluux-sdk/src/utils/mamCatchUpUtils.ts)), so a forward
catch-up auto-paginates at most three pages before bailing to `before:''` — and only an **incomplete**
page writes an advancing boundary at all. The common reconnect completes on page 1 and records no gap.
Measured on the room gaps key:

| Scenario | boundary rule | key-presence-only |
|---|---|---|
| 1 gapped room, 3-page walk | 3 | 3 |
| 10 gapped rooms, 3-page walks interleaved | 30 (3/room) | 12 (1.2/room) |
| reconnect completing on page 1 (no gap) | 0 | 0 |

The single-room walk costs **nothing** extra: the formation already force-flushes and closes the
window, so each later page takes a fresh leading edge either way. The delta appears only when several
gapped entities page concurrently and could otherwise have shared a window, and it stays at the ≤ 3
per gapped entity ceiling. One non-catch-up path also became structural — `clearRoomGapAnchor` strips
`startId` on an archive purge — costing one forced write on a rare path.

**`bottomId`-changed is deliberately conservative, and the cost is flush FREQUENCY.** It force-flushes
the provable deepening in `syncCoverageAfterArchiveMerge`'s plain-backward branch too, which is safe to
throttle in principle. Since ids cannot be ordered at this layer, distinguishing it would mean
threading a "was this monotone" signal out of the sync functions. The decision stands — but the
justification is *not* that a coverage record is small. Size is the wrong axis: the record rides in the
chat blob, so what a force-flush costs is one whole-blob serialization, and the question is how OFTEN.
Three sources, counted honestly:

1. **Coverage bootstrap** ([mamCoverage.ts:136-140](../../../packages/fluux-sdk/src/stores/shared/mamCoverage.ts))
   fires once for every entity that has no record and completes a forward catch-up. On the first
   session after this ships that is essentially *every* conversation: at the 400-conversation profile,
   ~400 O(conversations) blob serializations — the same order as the ~180 writes this work exists to
   remove. Steady state is free (`if (coverage.get(id)) return coverage`).
2. **Phase B read-pointer stitch** loops up to `MAM_POINTER_STITCH_MAX_PAGES` = 10 backward queries
   per entity per session ([MAM.ts:1561-1577](../../../packages/fluux-sdk/src/core/modules/MAM.ts)),
   each advancing `bottomId` and so force-flushing.
3. **A multiplier on top of both:** `flushKey` **closes** the window
   ([throttledStorage.ts:141-142](../../../packages/fluux-sdk/src/stores/shared/throttledStorage.ts)),
   so the *next* mutation is a fresh leading edge instead of being coalesced. Measured on the room
   gap-formation scenario: 3 writes where a pure throttle produces 1.

All three are first-session / launch-window costs, and all three are still strictly better than the
pre-branch baseline, which serialized the blob on **every** mutation unconditionally. The burst test
cannot see any of it — `collapses a long burst…` drives only `setMAMLoading`, so gaps and coverage stay
empty and this path never runs. That is a limitation of the test, not evidence of no cost.

**Measured follow-up, deliberately out of scope here.** A `flushKey` variant that writes the pending
thunk but leaves the timer ARMED would remove multiplier (3) for free. It is a semantic change to a
shared primitive — `recordPendingRetraction` uses `flushKey` too, and it wants the window closed — so
it needs its own change with its own tests, not a rider on this one.

> Measured in [#1138](2026-07-28-coverage-persistence-cost-design.md) §3.2 and **not taken**: it can
> only recover the window-closing half of a structural write, so on an all-structural workload it
> saves nothing, and on a gap-heavy mixed one about 2×. Sources (1) and (2) were removed instead, by
> throttling `created` and `deepened`. The bounding scenario stays in the benchmark for whoever picks
> it up.

Ordinary termination — tab close, app quit, mobile backgrounding — loses nothing, provided §4.1
lands.

### 4.1 Tauri quit requires an explicit flush

`useTauriCloseHandler` currently handles `graceful-shutdown` by calling `markShuttingDown()`, then
`await disconnectBestEffort()` (which races a 2 s timeout), then `stop_xmpp_proxy`, then `exit_app`
([useTauriCloseHandler.ts](../../../apps/fluux/src/hooks/useTauriCloseHandler.ts)). Nothing flushes,
and `pagehide` firing inside the webview before `exit_app` is not something to rely on.

Required: call `flushPersistentStorage()` **synchronously, immediately after `markShuttingDown()`,
before the first `await`**. Placing it after any `await` risks the process exiting first — the
disconnect races a 2 s timeout and `exit_app` follows it.

This makes the flush part of the SDK's public API — exported from `index.ts` as
`flushPersistentStorage` alongside the other lifecycle helpers — rather than an internal detail of
the stores module. Ordering is pinned by §5.4. Until this lands, the "ordinary termination loses
nothing" claim above does not hold on desktop.

## 5. Testing

### 5.1 `stores/shared/throttledStorage.test.ts`

- Leading edge writes immediately and synchronously.
- N schedules inside one window produce exactly 2 writes (leading + trailing).
- A sustained burst writes at ~1 per window and is never starved.
- **Staleness control:** schedule value A then value B inside one window, flush, assert disk holds
  **B**. See §5.3.
- `cancel` drops the pending write and the key is never written.
- `flush` writes pending state synchronously, and a `schedule` after a flush writes immediately
  (window closed, per §1.1).
- `flushKey` writes that key's pending thunk and closes its window, leaving other keys' windows and
  pending thunks untouched.
- `flushKey` on a key with **no** pending thunk performs **zero** writes and still closes the
  window. This is the property that makes the idle case free rather than a second serialization.
- `pagehide` triggers a flush.
- `produce` is *not* invoked for coalesced writes (the lazy-serialization property that motivates
  the thunk API).
- A `produce` that throws, and a `setItem` that throws, are both absorbed on the leading edge, in
  the timer callback and in `flush` — no propagation, no timer left armed.

### 5.2 `stores/chatStore.persist.test.ts`

- **Write count:** 180 simulated page merges plus `setMAMLoading` toggles → assert writes ≤ 25
  **and** > 0.
- **Equality after flush:** the on-disk string deep-equals what an unthrottled `serializeState` +
  `JSON.stringify` would produce for the same final state.
- **Durability round-trip:** mutate read pointers, gaps and coverage → flush → rehydrate via
  `loadScopedChatState` → assert all three survive exactly.
- **Retraction durability — the window must be open first.** The sequence is load-bearing and the
  obvious ordering does not test anything:

  1. Perform an ordinary chat mutation. Its leading edge writes a blob with **no** retraction and
     **opens** the window.
  2. Without advancing the clock, call `recordPendingRetraction`. Its `set()` is now *coalesced*
     into the pending thunk rather than written.
  3. Fire no timer, no `flush`, no lifecycle event — this is the hard kill.
  4. Rehydrate from whatever is on disk.
  5. Assert the retraction is present.

  Starting at step 2 — recording a retraction into an idle store — is hollow: with no window open,
  `schedule` writes it on the leading edge anyway, so the test passes with `flushKey` removed. Step 1
  is the whole test. Remove `flushKey` and this must go red.

- **Retraction persists before `recordPendingRetraction` returns.** Assert the blob is on disk
  immediately after the call, with no clock advance and no microtask yielded. This pins the
  synchronous-`setItem` assumption documented in §1.2: if a zustand upgrade ever defers the adapter,
  this fails loudly instead of the retraction quietly becoming losable.
- **Abrupt close:** mutate → dispatch `pagehide` → assert the write landed with no explicit flush
  call.
- **Logout:** schedule a write → `reset()` → advance timers past the window → assert no pre-logout
  conversation data is present. Per §2.1 the key itself will exist holding an empty blob; asserting
  absence would be asserting something that has never been true.
- **Compat:** new blobs carry no `conversations` key; a legacy blob carrying only `conversations`
  (no entities/meta) still restores through the legacy branch.
- **Rebuild fidelity (replaces the "orphan invariant"):** after a representative matrix exercising
  all 22 `conversations` write paths, assert for **every** conversation that
  `conversations.get(id)` deep-equals `{ ...entities.get(id), ...meta.get(id) }`, with `Date`
  fields normalised. Key-subset containment is not sufficient: a field updated in `conversations`
  but left stale in `conversationMeta` satisfies containment and still loses data on the next
  reload. Content equality is what licenses dropping the compat blob.

### 5.3 `stores/roomStore.throttledPersist.test.ts`

Module-level tests (§5.1) prove the throttle works; they prove nothing about whether the six helpers
are wired to it. A helper left calling `localStorage.setItem` directly passes every test in §5.1.

- Two mutations of the same key inside one window → the **later** value is on disk after flush.
- Key independence: a draft write does not coalesce, delay or clobber gaps, coverage or read state.
  Each key holds its own window.
- Account A → B → A with a write pending on A: assert A's data landed under A's key and that B's
  key never received it. This covers the `switchAccount` flush, freshness on an immediate return to
  A, and A/B key isolation. **It does not cover the §3.1 reference capture** — see below.
- `reset()` → advance past the window → assert no room read state, gaps, coverage or drafts
  reappear.
- `_clearAllRoomReadStateForTesting()` → advance past the window → assert no row reappears. This is
  the cross-test-contamination guard from §3.2; without it the failure surfaces as an unrelated
  flaky suite.
- **Pending retractions remain synchronous — the window must be open on _their own_ key.** The
  throttle is per-key, so opening a window on `room-read-state` says nothing about
  `room-pending-retractions`; a mistakenly throttled helper would still write its first retraction
  on its own leading edge and pass. The discriminating sequence stays entirely on the retraction
  key:

  1. Record a room pending retraction. If the helper were throttled, this opens *its* window.
  2. Without advancing the clock, record a second one.
  3. Fire no timer and no flush.
  4. Assert **both** are on disk.

  The second retraction is the assertion that matters: it is the one that would be sitting in a
  pending thunk if this key were ever routed through `schedule`.

- **Both sides of the §4.2 bound, per map.** The force-flush tests are one-directional: an
  implementation that flushed on *every* gap or coverage write would pass all of them, and the whole
  suite besides. Each map therefore needs a coalescing guard for the transition §4.2 still throttles —
  a gap shrink, and a coverage `topId` refresh. Both take **three** writes, for the reason in §5.5:
  one to establish the baseline (the first write of a session force-flushes on the unknown baseline and
  *closes* the window), one to re-open it, and the one that must be coalesced.

### 5.6 `stores/shared/durableMapPersist.test.ts`

The store suites prove the funnels are wired and the end-to-end durability property holds; they cannot
cheaply reach every row of §4.2's table, and they do not reach the module's two documented baseline
invariants at all. Direct tests over `scheduleDurableMaps`:

- the full decision table — gap added → flush; gap `start` or `startId` advance → flush; gap
  end-only shrink/close/removal → throttle; coverage added / `bottomId` changed / removed → flush;
  `topId`-only → throttle;
- **A → B → A:** the baseline advances on *throttled* writes too, so a there-and-back gap still
  force-flushes. Frozen-baseline mutant → red;
- `cancelDurableMaps` drops the baseline (observed through whether the following write was coalesced,
  since the write right after the cancel is a leading edge either way);
- **omitting a map disables detection for it** — `DurableMaps`' fields are all optional, so a typo
  (`{ gap: … }` for `{ gaps: … }`) type-checks and silently turns detection off. The test states the
  consequence rather than leaving it as folklore;
- the in-place gap **boundary advance** IS flushed — and a `startId`-only advance with it, since an
  incomplete forward page can move the id-exact cursor while `start` stands still. This is the
  crash/restart path §4.2 closes; the store suites carry the end-to-end version
  (`persists the LATEST boundary of a multi-page forward catch-up`, both stores) and the
  gap-erasure consequence (`keeps the gap healable after a load-older page that would erase a stale
  one`).

### 5.4 Tauri quit ordering

`useTauriCloseHandler.test.tsx` already pins ordering by recording `shuttingDownAtDisconnect` at
disconnect time. Extend that pattern with a third recorded fact so the assertion becomes:

```
markShuttingDown → flushPersistentStorage → disconnect
```

Recording *whether the flush had happened by the time disconnect was called* is what makes this
fail if the flush is placed after the first `await`, which is the mistake §4.1 exists to prevent.
Asserting only that `flushPersistentStorage` was called at some point would pass with it placed
after `disconnect`, where a 2 s race and an `exit_app` can beat it.

### 5.5 Guarding against hollow tests

Hollow tests — assertions that cannot fail — are this repo's recurring defect, and review does not
catch them. The retraction test in §5.2 is a worked example: the first draft of this spec specified
it in the order that cannot fail, in the same document that warns about exactly this. **The general
lesson for every test here: a test of "the escape hatch persisted X" must first put the system into
the state where the ordinary path would *not* have persisted X.** Otherwise it measures the ordinary
path.

The same error then recurred in §5.3's retraction case in a subtler form — the window was opened on
a *different key*, and the throttle is per-key, so the system was never actually put into the state
that discriminates. **Corollary: "put the system into that state" means on the exact key under
test.** Both of these passed a reading that only checked whether a window was open somewhere.

A third variant appeared once the force-flush landed, and it is the subtlest yet: **a preparatory step
that a neighbouring force-flush silently undoes.** Two tests were written as "one throttled write opens
the window, then the transition under test is coalesced into it" — and measurement showed the
*preparatory* write force-flushed on its own unknown baseline and CLOSED the window, so the transition
under test landed on a fresh leading edge. One of the two (`coalesces gap writes across two rooms`) was
left with a comment describing a mechanism that no longer ran at all; the other still failed under
control mutation, but for the wrong reason — it could not distinguish "flush on formation" from "flush
on any write". **Corollary: when the fix itself closes windows, "open the window first" needs a
baseline-establishing write before it, and the write count at each step has to be asserted rather than
reasoned about.** Both were caught by counting writes, not by re-reading the comments.

A fourth variant is worth naming because it is not about ordering at all: §5.3's A → B → A case was
labelled as covering the §3.1 reference capture, which it cannot, because the flush that runs first
makes the capture unobservable. **A test cannot cover a guard that a preceding guard renders
unreachable** — mislabelling one as covering the other manufactures false confidence in exactly the
line most likely to be deleted as redundant.

Four specific guards:

**The write-count assertion cannot stand alone.** An implementation that simply drops every trailing
write satisfies "writes ≤ 25". The staleness control in §5.1 is the paired test that kills that
mutant: A-then-B-in-one-window, flush, assert **B**. A leading-edge-only implementation passes the
count test and fails the control. Neither test is sufficient alone; together they pin both bounds.

**The rebuild-fidelity test must exercise mutations, not fixtures.** Asserting the equality over a
hand-built pair of maps proves nothing — it tests the test's own setup. The matrix must drive real
store actions and assert afterwards, so that a future write site which updates `conversations`
without `conversationMeta` fails it.

**The roomStore suite must drive the store, not the module.** §5.1 passing tells you nothing about
whether `saveGapsToStorage` still calls `localStorage.setItem` directly. §5.3 exists to catch a
helper that was never rewired.

**Tests install a counting `localStorage` object mock rather than an injected sink.** The store
suites already use object mocks with no key enumeration
([readStateStorage.ts:62](../../../packages/fluux-sdk/src/stores/shared/readStateStorage.ts)), so
this matches the existing pattern — and, more importantly, it means the code under test is the
production write path. A dependency-injected sink used only by tests would exercise a path
production never takes.

Both load-bearing tests get a documented control run during implementation: break the trailing edge
and confirm the equality test fails; break the leading edge and confirm the write-count lower bound
fails. A break check is necessary but not sufficient (#1064).

## Risks

| Risk | Mitigation |
|---|---|
| Pending retraction lost on hard kill → message never tombstoned | Excluded from the throttle; `flushKey` after `recordPendingRetraction` (§1.2); asserted by the window-open-first test (§5.2) |
| A room helper is never rewired and keeps writing directly | §5.3 drives the store, not the module — module tests cannot catch this |
| Tauri flush placed after the first `await` and beaten by `exit_app` | §5.4 records whether the flush had happened *by disconnect time*, not merely that it happened |
| Pending write resurrects room data after logout | `cancel(key)` before every `removeItem`, including `clearRoomReadState` and the test-only clear (§3.2) |
| Trailing write lands under the wrong account's key | Key resolved eagerly at schedule time; `flush()` on `switchAccount` |
| roomStore thunk reads a reassigned module binding | Capture the map reference into a local before scheduling (§3.1) |
| Compat-map removal silently drops a field | Rebuild-fidelity content equality over a 22-path mutation matrix (§5.2) |
| Desktop quit loses up to 1 s of state | Synchronous flush on `graceful-shutdown` before the first `await` (§4.1) |
| Reordering `reset()` re-migrates legacy data on next login | Behaviour left unchanged; test corrected instead (§2.1) |
| 1 s of lagging-mirror state lost on hard kill | Bounded and analysed as safe-direction only (§4) |
| `resolveRoomReadPosition` rationale silently goes stale | Comment updated in the same change (§3.3) |
| A zustand upgrade defers `setItem`, silently making retractions losable | §5.2 asserts the retraction is on disk before `recordPendingRetraction` returns |
| SDK peer range admits zustand v4, where the `storage` adapter is silently ignored | Peer range narrowed to `^5.0.0` (§1.3) — correcting a claim that was already untrue |
