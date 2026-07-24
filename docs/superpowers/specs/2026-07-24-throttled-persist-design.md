# Throttled localStorage persistence for chatStore and roomStore

**Date:** 2026-07-24
**Status:** Approved, ready for implementation planning

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
storage helpers; removal of the duplicated `conversations` array from the persisted chat blob.

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

An audit of all 22 sites that write `conversations` confirms the compat map is updated in lockstep
with `conversationMeta` at every one, and `conversationEntities` at creation. The rebuild is
lossless. §"Orphan invariant" turns that audit result into an asserted invariant.

## 1. Shared module — `stores/shared/throttledStorage.ts`

A per-key leading + trailing throttle over `localStorage`.

```ts
export function schedule(key: string, produce: () => string): void
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

Flush triggers are registered lazily on the first `schedule` call, guarded by
`typeof window !== 'undefined'` so there is no import-time side effect and headless/bot SDK usage is
unaffected: `pagehide`, `visibilitychange` when `document.visibilityState === 'hidden'`, and
`beforeunload`. `pagehide` and `visibilitychange` are the ones that fire reliably on mobile WebKit;
`beforeunload` is desktop belt-and-braces.

## 2. chatStore

1. `setItem` → `schedule(scopedKey, () => JSON.stringify({ state: serializeState(state, scopedKey) }))`.

   **The key is resolved eagerly, at schedule time**, not inside the thunk. This is what makes
   account switching safe by construction: a trailing write that fires after a `switchAccount`
   lands under the key that was current when its state was produced, never under the newly
   switched-to account's key. Resolving the key inside the thunk would write account A's data under
   account B's key.

2. `removeItem` → `cancel(key)` **before** `localStorage.removeItem(key)`. Without the cancel, a
   write scheduled just before logout fires a second later and resurrects the blob that `reset()`
   just removed.

3. `switchAccount` → `flush()` before `set(loadScopedChatState(jid))`, so the outgoing account's
   blob is current on disk and an immediate switch-back cannot read a stale one.

4. **Drop the compat map:**
   - Remove `conversations` from `partialize`.
   - Remove the `conversations` line from `serializeState`'s return, and drop `'conversations'`
     from its `Pick<...>` parameter type.
   - `PersistedState.conversations` becomes optional (`conversations?: [string, PersistedConversation][]`).
   - The legacy read branch guards with `(persisted.conversations ?? [])`.
   - `withUnmigratedReadState` is then called once per serialize instead of twice.
   - `migrateLegacyConversationListsToScoped` stops passing `conversations` into `serializeState`;
     the blob it writes carries entities + meta, which the new-format read branch handles.

## 3. roomStore

Route all six writers through the shared module, each under its own resolved storage key so room
read state coalesces independently of gaps and coverage:

`saveDraftsToStorage`, `saveVotedPollsToStorage`, `saveDismissedPollsToStorage`,
`saveGapsToStorage`, `saveCoverageToStorage`, and `persistRoomReadState` (via `saveRoomReadState`).

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

### 3.2 reset() must cancel seven keys

`roomStore.reset()` issues six `localStorage.removeItem` calls plus `clearRoomReadState()`. Each
needs a `cancel(key)` first, for the same resurrection reason as chatStore's `removeItem`. Logged-out
room read state reappearing after logout is precisely the failure this guards.

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
mutations. Per durable map, the *direction* of that loss:

- **Read pointers** — forward-only. A lost write under-advances the pointer: a few messages
  re-shown as unread. Per #1081 that is the safe direction; over-advancing is the unrecoverable one,
  and a throttle cannot cause it.
- **Gaps / coverage** — a lost write means a gap is re-detected or coverage re-walked next session.
  Redundant work, never silent history loss.
- **Drafts / poll state** — up to 1 s of typing or one vote flag. Recoverable by the user.

There is no unsafe loss mode, only a bounded-redundancy one. Ordinary termination — tab close, app
quit, mobile backgrounding — is covered by the flush triggers and loses nothing.

**To verify during implementation:** that the Tauri quit path flushes, rather than relying on
`pagehide` firing inside the webview on window close.

## 5. Testing

### 5.1 `stores/shared/throttledStorage.test.ts`

- Leading edge writes immediately and synchronously.
- N schedules inside one window produce exactly 2 writes (leading + trailing).
- A sustained burst writes at ~1 per window and is never starved.
- **Staleness control:** schedule value A then value B inside one window, flush, assert disk holds
  **B**. See §5.3.
- `cancel` drops the pending write and the key is never written.
- `flush` writes pending state synchronously.
- `pagehide` triggers a flush.
- `produce` is *not* invoked for coalesced writes (the lazy-serialization property that motivates
  the thunk API).

### 5.2 `stores/chatStore.persist.test.ts`

- **Write count:** 180 simulated page merges plus `setMAMLoading` toggles → assert writes ≤ 25
  **and** > 0.
- **Equality after flush:** the on-disk string deep-equals what an unthrottled `serializeState` +
  `JSON.stringify` would produce for the same final state.
- **Durability round-trip:** mutate read pointers, gaps and coverage → flush → rehydrate via
  `loadScopedChatState` → assert all three survive exactly.
- **Abrupt close:** mutate → dispatch `pagehide` → assert the write landed with no explicit flush
  call.
- **Logout:** schedule a write → `reset()` → advance timers past the window → assert the key is
  still absent.
- **Compat:** new blobs carry no `conversations` key; a legacy blob carrying only `conversations`
  (no entities/meta) still restores through the legacy branch.
- **Orphan invariant:** after a representative sequence of store operations,
  `conversations.keys() ⊆ conversationEntities.keys() ∩ conversationMeta.keys()`.

### 5.3 Guarding against hollow tests

Hollow tests — assertions that cannot fail — are this repo's recurring defect, and review does not
catch them. Two specific guards:

**The write-count assertion cannot stand alone.** An implementation that simply drops every trailing
write satisfies "writes ≤ 25". The staleness control in §5.1 is the paired test that kills that
mutant: A-then-B-in-one-window, flush, assert **B**. A leading-edge-only implementation passes the
count test and fails the control. Neither test is sufficient alone; together they pin both bounds.

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
| Pending write resurrects data after logout | `cancel(key)` before every `removeItem`; asserted by the logout test |
| Trailing write lands under the wrong account's key | Key resolved eagerly at schedule time; `flush()` on `switchAccount` |
| roomStore thunk reads a reassigned module binding | Capture the map reference into a local before scheduling (§3.1) |
| Orphaned conversation dropped by the compat-map removal | Orphan invariant test (§5.2) |
| 1 s of durable state lost on hard kill | Bounded and analysed as safe-direction only (§4) |
| `resolveRoomReadPosition` rationale silently goes stale | Comment updated in the same change (§3.3) |
