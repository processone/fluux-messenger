# Throttled localStorage persistence for chatStore and roomStore

**Date:** 2026-07-24
**Status:** Revised after review — ready for implementation planning

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

In scope: a shared throttle module, wired into `chatStore`'s persist adapter and `roomStore`'s six
storage helpers; removal of the duplicated `conversations` array from the persisted chat blob; an
explicit flush on Tauri app quit.

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
export function writeNow(key: string, produce: () => string): void
export function cancel(key: string): void
export function flush(): void
export function _resetForTesting(): void
```

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

`writeNow(key, produce)` is the durability escape hatch (§1.2): it discards any pending thunk for
the key, writes `produce()` synchronously, and **closes** the window — so the next `schedule` for
that key writes immediately on its leading edge rather than being coalesced behind a stale window.

### 1.1 Error absorption and flush semantics

Every current call site swallows storage errors (quota exceeded, private-mode denial) and continues
without persistence. The module preserves that exactly: errors thrown by `produce()` **and** by
`localStorage.setItem` are caught and discarded on all three paths — leading edge, timer callback,
and `flush`/`writeNow`. A throwing `produce` must not leave a timer armed or a window half-open, and
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
`pendingRetractions` — is followed by an explicit `writeNow` on the chat storage key. Cost is one
synchronous serialize, identical to today's behaviour, on a path that fires only when a retraction
target is not resident. It is rare and not on the catch-up hot path, so it does not reintroduce the
stall.

Rejected alternative: splitting `pendingRetractions` into its own key, matching roomStore's layout.
That is the cleaner long-term shape, but it changes the persisted blob format and needs its own
migration for entries already on disk. `writeNow` gets the same durability with no format change.

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

4. `recordPendingRetraction` → `writeNow` on the chat key, per §1.2.

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

## 3. roomStore

Route all six writers through the shared module, each under its own resolved storage key so room
read state coalesces independently of gaps and coverage:

`saveDraftsToStorage`, `saveVotedPollsToStorage`, `saveDismissedPollsToStorage`,
`saveGapsToStorage`, `saveCoverageToStorage`, and `persistRoomReadState` (via `saveRoomReadState`).

`savePendingRetractionsToStorage` is deliberately **excluded** and stays synchronous, per §1.2.

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
reassignment leaves the old reference pinned to the old account's data. `switchAccount` also
flushes, so this is defence in depth rather than the only guard.

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
| Gaps / coverage | Gap re-detected or coverage re-walked next session. | Lagging mirror |
| Drafts / poll state | Up to 1 s of typing, or one vote flag. | Lagging mirror |
| **Pending retractions** | **A retraction is forgotten and the message is never tombstoned. Not recoverable — the covered range is not re-queried.** | **Durable event** |

The first three are bounded-redundancy losses in the safe direction. The fourth is not, which is why
it is excluded from the throttle via `writeNow` (§1.2). With that carve-out, no unsafe loss mode
remains.

Ordinary termination — tab close, app quit, mobile backgrounding — loses nothing, provided §4.1
lands.

### 4.1 Tauri quit requires an explicit flush

`useTauriCloseHandler` currently handles `graceful-shutdown` by calling `markShuttingDown()`, then
`await disconnectBestEffort()` (which races a 2 s timeout), then `stop_xmpp_proxy`, then `exit_app`
([useTauriCloseHandler.ts](../../../apps/fluux/src/hooks/useTauriCloseHandler.ts)). Nothing flushes,
and `pagehide` firing inside the webview before `exit_app` is not something to rely on.

Required: call the flush **synchronously, immediately after `markShuttingDown()`, before the first
`await`**. Placing it after any `await` risks the process exiting first.

This makes flush part of the SDK's public API — exported from `index.ts` alongside the other
lifecycle helpers — rather than an internal detail of the stores module. Until this lands, the
"ordinary termination loses nothing" claim above does not hold on desktop.

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
- `writeNow` writes synchronously, discards a pending thunk for that key, and closes the window.
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
- **Retraction durability:** record a pending retraction, then simulate a hard kill (advance no
  timers, fire no flush) → rehydrate → assert the retraction is on disk. This test must fail if
  `recordPendingRetraction` is left on the throttled path.
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

### 5.3 Guarding against hollow tests

Hollow tests — assertions that cannot fail — are this repo's recurring defect, and review does not
catch them. Three specific guards:

**The write-count assertion cannot stand alone.** An implementation that simply drops every trailing
write satisfies "writes ≤ 25". The staleness control in §5.1 is the paired test that kills that
mutant: A-then-B-in-one-window, flush, assert **B**. A leading-edge-only implementation passes the
count test and fails the control. Neither test is sufficient alone; together they pin both bounds.

**The rebuild-fidelity test must exercise mutations, not fixtures.** Asserting the equality over a
hand-built pair of maps proves nothing — it tests the test's own setup. The matrix must drive real
store actions and assert afterwards, so that a future write site which updates `conversations`
without `conversationMeta` fails it.

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
| Pending retraction lost on hard kill → message never tombstoned | Excluded from the throttle; `writeNow` after `recordPendingRetraction` (§1.2); asserted by the retraction-durability test |
| Pending write resurrects room data after logout | `cancel(key)` before every `removeItem`, including `clearRoomReadState` and the test-only clear (§3.2) |
| Trailing write lands under the wrong account's key | Key resolved eagerly at schedule time; `flush()` on `switchAccount` |
| roomStore thunk reads a reassigned module binding | Capture the map reference into a local before scheduling (§3.1) |
| Compat-map removal silently drops a field | Rebuild-fidelity content equality over a 22-path mutation matrix (§5.2) |
| Desktop quit loses up to 1 s of state | Synchronous flush on `graceful-shutdown` before the first `await` (§4.1) |
| Reordering `reset()` re-migrates legacy data on next login | Behaviour left unchanged; test corrected instead (§2.1) |
| 1 s of lagging-mirror state lost on hard kill | Bounded and analysed as safe-direction only (§4) |
| `resolveRoomReadPosition` rationale silently goes stale | Comment updated in the same change (§3.3) |
