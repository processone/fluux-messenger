# Read-state PR B — derive the unread count from the archive Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the incremental / slice-limited unread count with one canonical count — the archived count plus a transient overlay for never-archived messages — rendered identically by every numeric unread surface; and tighten the on-arrival pointer advance so an active-but-scrolled-up conversation stays unread.

**Architecture:** A pure `readState` core (order comparator, `computeFloor`, derivation outcome) drives a coverage-gated IndexedDB cursor primitive. The stores commit a derived count **only** on an `exact` outcome and otherwise leave the last trusted value alone; the legacy `recomputeCountsFromPointer` is kept for its pointer/guard effects but its **count output is discarded from the start**. A per-entity recount version makes async derivations latest-wins. The app renders the one store count through a shared formatter across every numeric surface, and a new SDK-owned entity+generation viewport-evidence state gates the on-arrival pointer advance.

**Tech Stack:** TypeScript, Zustand vanilla stores, `idb` (IndexedDB), Vitest, React 19 + @testing-library/react, Playwright (`test:scroll`), i18next.

**Reference documents (read before starting):**
- Design: [2026-07-22-read-state-model-consolidation-design.md](../specs/2026-07-22-read-state-model-consolidation-design.md) — the "PR B — reconciled design" section is authoritative.
- Acceptance spec (nine UI acceptance tests, verbatim Given/When/Then + break checks): [2026-07-23-read-state-unread-count-single-source-acceptance.md](../specs/2026-07-23-read-state-unread-count-single-source-acceptance.md). Tasks 11–12 implement these as written.

## Global Constraints

- **B0 is merged** (squashed as `5f85db60`, #1102). This plan's branch is `mr/read-state-b`, cut from `main` at `562220fa`. Line references were re-verified against that commit; note `#1114` moved RoomsList's unread dot and `@N` mention badge after the timestamp (semantics unchanged — unread is still a dot, the number still lives in the row tooltip).
- **`deferred` must preserve the last TRUSTED count.** The legacy `recomputeCountsFromPointer` keeps running for its pointer advance and its two data-loss guards, but **its count output is never written**. `unreadCount` changes only via (a) the renderability-guarded `+1`/mark-read paths and (b) an `exact` derivation. There is no provisional count, so "deferred leaves it untouched" genuinely means the last trusted value.
- **The canonical count = archived count + a position-aware transient overlay.** Eligible `noLocalStore` messages are never written to IndexedDB (`message-internal.ts:26`; set by `MUC.ts:256`, `roomStore.ts:1526`) yet must count as unread — existing tests assert it (`chatStore.test.ts:1403`, `roomStore.test.ts:1408`). The overlay is scoped by `{accountScope, kind, entityId}`, identified through **B0's tiered room identity** (`roomMessageIdentity.ts`: `stanzaId → originId → from+id`, indexing every alias — never a bare id and never a `from+id`-only key), stores each entry's `OrderPosition`, and is **never cleared on deactivation** — only when the pointer passes an entry, the message is removed, or the account is torn down.
- **All fallbacks lean toward more unread, never less.** Over-counting clears by reading; under-counting hides messages, and over-advancing the forward-only pointer is unrecoverable.
- **PR B derives `unreadCount` ONLY. Archive recounts must NEVER write `mentionsCount`.** Follow the
  authoritative [mention-count contract](../specs/2026-07-22-read-state-model-consolidation-design.md#mention-counts-remain-live-only):
  the archive primitive and transient overlay contain no mention result, completeness flag, or
  mention scan cap. `unreadCount` still caps at 999.
- **Hollow tests are this effort's recurring defect.** Every control gets a deliberate-break verification: break the behavior, confirm the test fails, revert. A test that can't fail is not done.
- **i18n:** `chat.newMessagesCount` **already exists** (`"{{count}} new message"` / `_other`). Task 12 changes the placeholder to `{{displayCount}}` in **all 33 locales** (`apps/fluux/src/i18n/locales/*.json`, written back with `json.dumps(d, ensure_ascii=False, indent=4) + "\n"`, no em-dash connectors); the numeric `count` is still passed so i18next selects the plural form. `i18n.test.ts` enforces parity.
- **SDK→app:** an SDK signature change requires `npm run build:sdk` before app typecheck; a new SDK export used by the app must be added to `apps/fluux/src/test-setup.ts` (via the `importOriginal` spread).
- **Commits:** SSH-signed, no Claude footer. Squash-merge to `main` via PR.
- **Gates before every commit:** `npm test` (no stderr), `npm run typecheck`, `npm run lint`. Tasks touching scroll/marker layout (3, 11, 12): also `npm run test:scroll` from the repo root.

---

## File Structure

**New:** `packages/fluux-sdk/src/stores/shared/readState.ts` (+test) — pure core (T1); `packages/fluux-sdk/src/stores/shared/transientUnread.ts` (+test) — the `noLocalStore` overlay (T6); `packages/fluux-sdk/src/stores/shared/viewportEvidence.ts` (+test) — generation-scoped evidence (T11); `apps/fluux/src/utils/formatUnreadCount.ts` (+test) (T12).

**Modified:** `readPointer.ts` (T1,T2) · `index.ts` (T1) · `readStateStorage.ts`, `chatStore.ts` persist, `stateSnapshot.ts` (T2) · `messageArrayUtils.ts` (T3) · `messageCache.ts` (T4) · `mamCoverage.ts` (T5) · `chatStore.ts` (T7) · `roomStore.ts`, `storeBindingKeys.ts`, `core/e2ee/deferredDecrypt.ts` (T8) · `notificationState.ts` (T9, T11) · `mamCatchUpUtils.ts` (T10) · `useMessageListScroll.ts`, `ChatView.tsx`, `RoomView.tsx` (T11,T12) · `MessageList.tsx`, `NewMessageMarker.tsx`, delete `unreadBadge.ts` (T12).

---

### Task 1: Pure `readState` core — order key, floor, outcome

**Files:** Create `packages/fluux-sdk/src/stores/shared/readState.ts` + `.test.ts`; modify `readPointer.ts` (delete `readFloor`, lines 87–95); modify `index.ts:199` (drop the `readFloor` export).

**Interfaces produced:**
```ts
export type ArchiveOrderKey =
  | { kind: 'chat'; id: string }
  | { kind: 'room'; from: string; id: string }

export function makeArchiveOrderKey(msg: { from?: string; id: string }, kind: 'chat' | 'room'): ArchiveOrderKey
export interface OrderPosition { timestamp: number; archiveOrderKey?: ArchiveOrderKey }
export function compareOrder(a: OrderPosition, b: OrderPosition): number
export function computeFloor(pointer: ReadPointer | undefined, historyFloor: Date | undefined): Date | undefined
export function pointerlessDefers(pointer: ReadPointer | undefined, persistedUnread: number): boolean
export function isValidArchiveOrderKey(v: unknown): v is ArchiveOrderKey

export type RecomputeOutcome =
  | { kind: 'exact'; unread: number }
  | { kind: 'deferred' }
  | { kind: 'unavailable' }
```

> **Order semantics (do not generalise):** chat archive order breaks a same-millisecond tie by **`id` only** (the chat store's `keyPath: 'id'`, `messageCache.ts:140`); room breaks it by **`from` then `id`** (`room_ts_from_id`). Chat messages *also* carry `from`, so a generic "from then id" comparator is **wrong for chat**. The `kind` discriminant is what keeps them apart.

- [ ] **Step 1: Failing test** (`readState.test.ts`):

```ts
import { describe, it, expect } from 'vitest'
import { compareOrder, computeFloor, makeArchiveOrderKey, pointerlessDefers, isValidArchiveOrderKey } from './readState'
import { makeReadPointer } from './readPointer'

describe('compareOrder', () => {
  it('orders by timestamp first', () => {
    expect(compareOrder({ timestamp: 1 }, { timestamp: 2 })).toBeLessThan(0)
  })
  it('room ties break by (from, id)', () => {
    const a = { timestamp: 5, archiveOrderKey: makeArchiveOrderKey({ from: 'r@c/al', id: 'z' }, 'room') }
    const b = { timestamp: 5, archiveOrderKey: makeArchiveOrderKey({ from: 'r@c/bo', id: 'a' }, 'room') }
    expect(compareOrder(a, b)).toBeLessThan(0) // 'al' < 'bo' wins over id
  })
  it('chat ties break by id ONLY, ignoring from', () => {
    const a = { timestamp: 5, archiveOrderKey: makeArchiveOrderKey({ from: 'zed@x', id: 'a' }, 'chat') }
    const b = { timestamp: 5, archiveOrderKey: makeArchiveOrderKey({ from: 'amy@x', id: 'b' }, 'chat') }
    expect(compareOrder(a, b)).toBeLessThan(0) // id 'a' < 'b'; `from` must not participate
  })
  it('a missing key sorts before a present one at equal timestamp (conservative)', () => {
    const k = { timestamp: 5, archiveOrderKey: makeArchiveOrderKey({ id: 'a' }, 'chat') }
    expect(compareOrder({ timestamp: 5 }, k)).toBeLessThan(0)
  })
})

describe('computeFloor', () => {
  it('is pointer-wins, not max (migrated pointer behind historyFloor=now)', () => {
    const p = makeReadPointer({ id: 'm', timestamp: new Date(1000) }, 'chat')
    expect(computeFloor(p, new Date(9_999_999))!.getTime()).toBe(1000)
  })
  it('falls back to historyFloor when pointerless', () => {
    expect(computeFloor(undefined, new Date(42))!.getTime()).toBe(42)
  })
})

describe('pointerlessDefers', () => {
  it('defers pointerless with a real persisted count', () => expect(pointerlessDefers(undefined, 3)).toBe(true))
  it('allows a pointerless zero (genuinely fresh)', () => expect(pointerlessDefers(undefined, 0)).toBe(false))
})

describe('isValidArchiveOrderKey', () => {
  it('rejects untrusted shapes', () => {
    expect(isValidArchiveOrderKey({ kind: 'room', id: 'x' })).toBe(false) // missing from
    expect(isValidArchiveOrderKey({ kind: 'nope', id: 'x' })).toBe(false)
    expect(isValidArchiveOrderKey({ kind: 'chat', id: 'x' })).toBe(true)
  })
})
```

- [ ] **Step 2: Run → FAIL** — `cd packages/fluux-sdk && npx vitest run src/stores/shared/readState.test.ts`

- [ ] **Step 3: Implement:**

```ts
export function makeArchiveOrderKey(msg: { from?: string; id: string }, kind: 'chat' | 'room'): ArchiveOrderKey {
  return kind === 'room' ? { kind: 'room', from: msg.from ?? '', id: msg.id } : { kind: 'chat', id: msg.id }
}

export function compareOrder(a: OrderPosition, b: OrderPosition): number {
  if (a.timestamp !== b.timestamp) return a.timestamp - b.timestamp
  const ak = a.archiveOrderKey, bk = b.archiveOrderKey
  if (!ak && !bk) return 0
  if (!ak) return -1            // unresolved sorts first → under-advance → over-count (safe)
  if (!bk) return 1
  if (ak.kind === 'room' && bk.kind === 'room') {
    if (ak.from !== bk.from) return ak.from < bk.from ? -1 : 1
    return ak.id < bk.id ? -1 : ak.id > bk.id ? 1 : 0
  }
  return ak.id < bk.id ? -1 : ak.id > bk.id ? 1 : 0   // chat: id only
}

export function computeFloor(pointer: ReadPointer | undefined, historyFloor: Date | undefined) {
  return pointer ? pointer.timestamp : historyFloor
}

export function pointerlessDefers(pointer: ReadPointer | undefined, persistedUnread: number) {
  return !pointer && persistedUnread > 0
}

export function isValidArchiveOrderKey(v: unknown): v is ArchiveOrderKey {
  if (!v || typeof v !== 'object') return false
  const k = v as Record<string, unknown>
  if (k.kind === 'chat') return typeof k.id === 'string'
  if (k.kind === 'room') return typeof k.id === 'string' && typeof k.from === 'string'
  return false
}
```

- [ ] **Step 4: Delete `readFloor`** from `readPointer.ts:87-95`, drop it from `index.ts:199`, delete its tests in `readPointer.test.ts`.
- [ ] **Step 5: Run tests + `npm run typecheck`** → clean (proves no lingering `readFloor` caller).
- [ ] **Step 6: Deliberate-break** — make the chat branch use `from` then `id`; the "chat ties break by id ONLY" test must FAIL; revert.
- [ ] **Step 7: Commit** — `feat(read-state): pure readState core — kind-aware order key, computeFloor, outcome`

---

### Task 2: Persist a validated `archiveOrderKey` on the read pointer

**Files:** `readPointer.ts`; `readStateStorage.ts:161,99`; `stateSnapshot.ts:187,203`; `chatStore.ts:894,924`; tests in `readPointer.test.ts`, `readStateStorage.test.ts`.

**Interfaces:** `ReadPointer { messageId; timestamp; archiveOrderKey? }`; `makeReadPointer(msg: { id: string; from?: string; timestamp: Date }, kind: 'chat' | 'room'): ReadPointer`. `deserializeReadPointer` **validates** the persisted key with `isValidArchiveOrderKey` and drops it when invalid (never passes untrusted JSON through).

- [ ] **Step 1: Failing tests:**

```ts
it('round-trips a room pointer with its archiveOrderKey', () => {
  const p = makeReadPointer({ id: 'm1', from: 'r@c/alice', timestamp: new Date(1000) }, 'room')
  expect(p.archiveOrderKey).toEqual({ kind: 'room', from: 'r@c/alice', id: 'm1' })
  expect(deserializeReadPointer(serializeReadPointer(p))!.archiveOrderKey)
    .toEqual({ kind: 'room', from: 'r@c/alice', id: 'm1' })
})
it('drops a malformed persisted archiveOrderKey instead of trusting it', () => {
  const back = deserializeReadPointer({ messageId: 'm', timestamp: 1000, archiveOrderKey: { kind: 'room', id: 'x' } })
  expect(back!.archiveOrderKey).toBeUndefined()   // missing `from` → invalid → dropped
  expect(back!.messageId).toBe('m')               // the pointer itself survives
})
it('a legacy pointer with no key deserializes with archiveOrderKey undefined', () => {
  expect(deserializeReadPointer({ messageId: 'm', timestamp: 1000 })!.archiveOrderKey).toBeUndefined()
})
```

- [ ] **Step 2: Run → FAIL.**
- [ ] **Step 3: Implement** the type + `kind` param. Grep `makeReadPointer(` and update **every** call site to pass `kind` (`notificationState.ts:131,151,305,450` + inside `recomputeCountsFromPointer` at `:555,578` — thread `kind` in from the store: chat stores pass `'chat'`, room stores `'room'`).
- [ ] **Step 4: Verify all three persistence surfaces** with a round-trip test each — `readStateStorage.ts` (`:161`/`:99`), `stateSnapshot.ts` (`:187`/`:203`), chat `deserializeState` (`:894`/`:924`). Assert, don't assume.
- [ ] **Step 5: Run tests, `npm run build:sdk`, `npm run typecheck`.**
- [ ] **Step 6: Deliberate-break** — make `deserializeReadPointer` skip validation; the malformed-key test must FAIL; revert.
- [ ] **Step 7: Commit** — `feat(read-state): persist a validated structured archiveOrderKey`

---

### Task 3: Resident-array sort tiebreak (kind-aware)

**Files:** `packages/fluux-sdk/src/stores/shared/messageArrayUtils.ts:183-187` + its test.

**Interfaces:** `sortMessagesByTimestamp<T>(messages: T[], kind: 'chat' | 'room'): T[]` — an **explicit kind**, not a generic `from`-then-`id`. Chat ties → `id`; room ties → `from` then `id`. Update both call sites (`mergeAndProcessMessages:232-253`, `prependOlderMessages:271-302`) to thread the kind from their store.

- [ ] **Step 1: Failing tests — chat and room separately:**

```ts
it('room: same-ms ties break by (from, id)', () => {
  const t = new Date(5000)
  const msgs = [{ id: 'a', from: 'r@c/zed', timestamp: t }, { id: 'b', from: 'r@c/amy', timestamp: t }]
  expect(sortMessagesByTimestamp(msgs, 'room').map(m => m.id)).toEqual(['b', 'a']) // amy < zed
})
it('chat: same-ms ties break by id, ignoring from', () => {
  const t = new Date(5000)
  const msgs = [{ id: 'b', from: 'amy@x', timestamp: t }, { id: 'a', from: 'zed@x', timestamp: t }]
  expect(sortMessagesByTimestamp(msgs, 'chat').map(m => m.id)).toEqual(['a', 'b']) // id only
})
```

- [ ] **Step 2: Run → FAIL** (today's comparator is timestamp-only).
- [ ] **Step 3: Implement** using the same rules as `compareOrder` (reuse it: build `OrderPosition`s via `makeArchiveOrderKey(m, kind)` so the resident order and the archive order cannot drift).
- [ ] **Step 4: Run unit tests → PASS; `npm run test:scroll` (repo root) → PASS.**
- [ ] **Step 5: Deliberate-break** — make the chat path use `from` then `id`; the chat test must FAIL; revert.
- [ ] **Step 6: Commit** — `feat(read-state): kind-aware same-ms resident sort tiebreak`

---

### Task 4: Archive count primitive (unread only) + the `isMention` merge invariant

**Files:** `packages/fluux-sdk/src/utils/messageCache.ts` (two new exports; the room one is the **first** query against `room_ts_from_id`, which exists at `:173` but is currently never queried) + `messageCache.test.ts`.

**Interfaces:**
```ts
export interface UnreadCountArgs {
  floor: Date
  pointer?: { timestamp: Date; archiveOrderKey?: ArchiveOrderKey }
  unreadCap?: number      // default 999
}
export interface ArchiveCount { unread: number }
export function countUnreadInArchive(conversationId: string, a: UnreadCountArgs): Promise<ArchiveCount | null>
export function countRoomUnreadInArchive(roomJid: string, a: UnreadCountArgs): Promise<ArchiveCount | null>
```

**Behavior:** cursor from `floor` forward (chat `conv_timestamp`; room `room_ts_from_id`), counting rows that are `!isOutgoing && isRenderableStoredMessage(row)` **strictly after** the pointer position via `compareOrder` (missing `archiveOrderKey` ⇒ at-or-after timestamp — over-counts, safe). `unread` stops incrementing at `unreadCap` and the walk then **ends** — nothing further can be learned, since mentions are out of scope. No `isMention` is read anywhere. `null` on IndexedDB error.

- [ ] **Step 1: Failing tests** — (a) counts renderable incoming after the pointer; (b) excludes outgoing; (c) excludes non-renderable; (d) **same-ms**: pointer at `m1@t`, unread `m2@t` later by `(from,id)` → 1; (e) unread saturates at `unreadCap`; (f) missing `archiveOrderKey` → at-or-after timestamp; (g) `null` on IndexedDB error. Example (d):

```ts
it('counts a same-ms unread strictly after the pointer position (room)', async () => {
  const t = new Date(5000)
  await messageCache.saveRoomMessages([
    { type:'groupchat', id:'m1', roomJid:'r@c', from:'r@c/al', body:'a', timestamp:t, isOutgoing:false },
    { type:'groupchat', id:'m2', roomJid:'r@c', from:'r@c/al', body:'b', timestamp:t, isOutgoing:false },
  ] as RoomMessage[])
  const res = await messageCache.countRoomUnreadInArchive('r@c', {
    floor: t,
    pointer: { timestamp: t, archiveOrderKey: { kind:'room', from:'r@c/al', id:'m1' } },
  })
  expect(res).toEqual({ unread: 1 })
})
```

- [ ] **Step 2: Run → FAIL.**
- [ ] **Step 3: Implement** both with `openCursor(IDBKeyRange.bound(...))` + `cursor.continue()`; room bound `[roomJid, floorMs, '', '']`→`[roomJid, Infinity, '￿', '￿']`. try/catch → `null`.
- [ ] **Step 4: Run → PASS.**
- [ ] **Step 5: Deliberate-break ×2** — (a) `>=` instead of strict-after → test (d) becomes 2 and FAILS; (b) drop the `isOutgoing` filter → test (b) FAILS. Revert each.
**Also in this task — the `isMention` merge invariant (a narrowly-tested B0 correction).** `mergeRoomRows` (`messageCache.ts` ~474-486) takes `isMention` from the `contentOwner` row, unlike `isRetracted`/`isModerated` which it ORs. So re-ingesting a live-counted message from MAM (whose copy has no flag) can silently erase an already-established mention. **`isMention` is monotonic evidence: an absent or false flag on one copy must never erase a `true` established by another.** OR it **independently of content ownership**, exactly as the other monotonic flags are handled.

- [ ] **Step 5b: Failing test for the merge invariant** — merge a flagged copy with an unflagged copy and assert `isMention === true` in **both row orders** (`merge(a,b)` and `merge(b,a)`), since `mergeRoomRows` is required to be commutative. Deliberate-break: restore the `contentOwner`-sourced read → one order FAILS. Revert.

- [ ] **Step 6: Commit** — `feat(cache): archive unread count primitive; make isMention monotonic on merge`

---

### Task 5: Count-trustworthy coverage gate

**Files:** `packages/fluux-sdk/src/stores/shared/mamCoverage.ts` + test; a small `resolveArchivePosition` in `messageCache.ts`.

**Interfaces:**
```ts
export function isCaughtUpForCounting(mam: { hasQueried: boolean; isLoading: boolean; isCaughtUpToLive: boolean }): boolean
export type CoverageBottom = OrderPosition | 'missing' | 'unresolvable'
export function resolveCoverageBottom(entityId: string, record: CoverageRecord | undefined, isRoom: boolean): Promise<CoverageBottom>
```

> **Two corrections to the naive gate.** (1) `mdsSideEffects.archiveIsTrustworthy:200` treats *never queried and not loading* as trustworthy — correct for the publisher's freshly-created entity, but **unsafe for counting** on a **restored** entity that has durable coverage from a previous session and has not yet caught up across the offline interval. For counting, require `!isLoading && isCaughtUpToLive` with **no never-queried shortcut**. (2) A **missing** coverage record means *not yet covered* → the caller must **defer**, not proceed.

- [ ] **Steps:** failing tests for `isCaughtUpForCounting` (never-queried+idle ⇒ **false**, loading ⇒ false, caught-up ⇒ true, not-caught-up ⇒ false) and `resolveCoverageBottom` (resolvable ⇒ position, no record ⇒ `'missing'`, dangling `bottomId` ⇒ `'unresolvable'`). Implement. Deliberate-break: restore the never-queried shortcut → the restored-entity test FAILS. Commit `feat(read-state): count-trustworthy gate (strict caught-up + coverage bottom)`.

---

### Task 6: Transient overlay for never-archived (`noLocalStore`) messages

**Files:** Create `packages/fluux-sdk/src/stores/shared/transientUnread.ts` + test.

**Why:** `noLocalStore` messages (MUC ephemera, Quick Chat) are never written to IndexedDB but **must** count as unread — asserted today by `chatStore.test.ts:1403` and `roomStore.test.ts:1408`. Archive-only counting erases them, and Quick Chat rooms make this common, not an edge case.

**Interfaces:**
```ts
export interface ScopeKey { accountScope: string; kind: 'chat' | 'room'; entityId: string }
export interface TransientEntry { position: OrderPosition }

// Delegates to B0's roomMessageIdentity for rooms (canonical key + every alias); chat uses `id`.
// OVERLOADED so TypeScript enforces the right shape - the room form REQUIRES roomJid (+ from, id).
export function transientIdentity(msg: RoomIdentityFields, kind: 'room'): string
export function transientIdentity(msg: { id: string }, kind: 'chat'): string
export function transientAliases(msg: RoomIdentityFields, kind: 'room'): string[]
export function transientAliases(msg: { id: string }, kind: 'chat'): string[]
// `added` drives the fast `+1`; `requiresRecount` drives the projection refresh. They are
// INDEPENDENT: a merge adds nothing yet can still change what the overlay contributes.
export interface NoteTransientResult { added: boolean; requiresRecount: boolean }
export function noteTransient(key: ScopeKey, entry: TransientEntry, identity: string, aliases?: string[]): NoteTransientResult
export function transientCounts(key: ScopeKey, boundary: OrderPosition | undefined): { unread: number }
export function pruneTransient(key: ScopeKey, boundary: OrderPosition): { removed: number }
// Accepts ANY alias. Returns whether an entry actually went away, so the caller can schedule a recount.
export function removeTransient(key: ScopeKey, alias: string): { removed: boolean }
export function clearTransientScope(accountScope: string): void                // account teardown ONLY
```

> **Four properties that make this non-lossy — get each right:**
> 1. **Scope key is `{accountScope, kind, entityId}`**, matching the viewport-evidence key. A bare `entityId` leaks across accounts.
> 2. **Identity reuses B0's tiered room identity — do not invent a `from+id`-only key.** B0 defines room identity as `stanzaId → originId → from+id` (`packages/fluux-sdk/src/utils/roomMessageIdentity.ts`). A `from+id`-only overlay key breaks twice: the same logical message gets noted once under `from+id` and **again** once a stanza/origin id arrives (double count), and a retraction that references the **stanza-id** fails to find the entry to remove. So: store the entry under `roomCanonicalKey(m)` and index **every** alias from `roomIdentityKeys(m)` to that entry, so a later stanza-bearing copy resolves to the *same* entry (no double count) and `removeTransient` succeeds when given any tier. Chat keeps the simple `id`. `transientIdentity` delegates to `roomIdentityKeys`/`roomCanonicalKey` rather than reimplementing them.
> 3. **Entries carry their `OrderPosition`**, so they can be compared against the read boundary. They deliberately do NOT carry `isMention` — PR B derives `unreadCount` only and archive recounts never write `mentionsCount` (see Global Constraints), so a mention field here would be unused machinery.
> 4. **Never cleared on deactivation.** Clearing on deactivate silently drops unread when the user switches away while scrolled up. Entries leave only when (a) the pointer passes them (`pruneTransient`), (b) the message is retracted/removed (`removeTransient`), or (c) the account is torn down (`clearTransientScope`). Because `transientCounts` compares each entry against the *current* boundary, a partial pointer advance reduces the count correctly with no clearing at all — pruning is a memory bound, not a correctness mechanism.

**Storage — two structures per scope (a single `Map<identity, entry>` cannot satisfy both requirements).** Putting every alias into one map makes `transientCounts` count one message once per alias; storing only the canonical key makes alias lookup and stanza-id retraction fail. So:

```ts
interface TransientScope {
  entries: Map<string /* canonicalId */, { entry: TransientEntry; aliases: Set<string> }>
  canonicalByAlias: Map<string /* any alias */, string /* canonicalId */>
}
// Map<scopeKeyString, TransientScope>
```

- `transientCounts()` / `pruneTransient()` iterate **`entries` only** — never the alias index — so each logical message is counted exactly once.
- `noteTransient()` first resolves **every** supplied alias through `canonicalByAlias`. If they resolve to **more than one** existing canonical entry, it **coalesces them into one** (union the alias sets, keep the earliest `position`, re-point every alias at the survivor) rather than picking the first — a higher identity tier arriving later can bridge two entries that were previously distinct, exactly as B0's `upsertStoredRoomRow` merges every identity match. Its result distinguishes three cases:
  - **new logical entry** → `{ added: true, requiresRecount: false }` — take the fast `+1`;
  - **plain alias registration, nothing semantic changed** → `{ added: false, requiresRecount: false }` — do nothing;
  - **coalesced two or more entries, or moved the retained `position`** → `{ added: false, requiresRecount: true }` — **schedule the entity recount**, because the overlay's contribution changed even though no message was added (coalescing `2 → 1` is the canonical case: the fast path correctly declines to increment, but the stored count is now stale by one).
- `removeTransient()` accepts **any** alias, resolves it to the canonical id, and deletes the entry **plus every one of its aliases** from `canonicalByAlias`.

Tasks 7/8 commit `unread = min(999, archive.unread + transient.unread)`. `mentionsCount` is untouched by any of this.

> **The overlay is an INPUT to the stored count, so every overlay mutation must update the projection.** Changing the overlay alone leaves the persisted count stale in both directions:
> - **Retraction/removal:** a `noLocalStore` message arrives (store count `1`), is retracted, `removeTransient` drops the entry — and with no recount the sidebar stays at `1`.
> - **Alias dedup:** `noteTransient` correctly merges a stanza-bearing copy into an existing entry, but the `+1` fast path has *already* incremented the store — a double count.
>
> - **Coalescing:** a bridging alias merges two separately-counted entries — the overlay drops `2 → 1` and the fast path *correctly* declines to increment, yet the store still reads `2` unless something recounts.
>
> Contract: the `+1` fast path increments **only on `added: true`**; **any** overlay mutation that reports a change — `noteTransient` returning `requiresRecount: true`, or `removeTransient`/`pruneTransient` reporting a removal — **schedules `recomputeUnreadForConversation` / `recomputeUnreadForRoom`**. Overlay mutation is a first-class recount trigger (Tasks 7/8), on the same latest-wins path as every other trigger.

- [ ] **Step 1: Failing tests** (lifecycle, identity, and alias cases):

```ts
const K = { accountScope: 'me@x', kind: 'room' as const, entityId: 'r@c' }
const msg = { roomJid: 'r@c', from: 'r@c/al', id: 'm1' }
// Always derive identity + aliases from B0's roomMessageIdentity - never hand-build a key.
const note = (m: typeof msg & { stanzaId?: string }, at: number) =>
  noteTransient(K, { position: { timestamp: at } },
    transientIdentity(m, 'room'), transientAliases(m, 'room'))

it('survives switching away and back (never cleared on deactivate)', () => {
  note(msg, 10)
  // simulate deactivate + reactivate: nothing is called; the entry must remain
  expect(transientCounts(K, { timestamp: 5 }).unread).toBe(1)
})
it('re-noting the same logical message after a stanzaId arrives does not double-count', () => {
  note(msg, 10)
  note({ ...msg, stanzaId: 'S1' }, 10)   // same logical message, higher identity tier
  expect(transientCounts(K, { timestamp: 5 }).unread).toBe(1) // NOT 2
})
it('removeTransient resolves a retraction that references only the stanza-id', () => {
  note({ ...msg, stanzaId: 'S1' }, 10)
  removeTransient(K, roomStanzaKey('r@c', 'S1'))
  expect(transientCounts(K, { timestamp: 5 }).unread).toBe(0)
})
it('two room messages with the SAME id but different senders count as two', () => {
  note({ roomJid: 'r@c', from: 'r@c/al', id: 'dup' }, 10)
  note({ roomJid: 'r@c', from: 'r@c/bo', id: 'dup' }, 11)
  expect(transientCounts(K, { timestamp: 5 }).unread).toBe(2)
})
it('a partial pointer advance drops only the passed entries', () => {
  note({ roomJid: 'r@c', from: 'r@c/al', id: 'a' }, 10)
  note({ roomJid: 'r@c', from: 'r@c/al', id: 'b' }, 20)
  expect(transientCounts(K, { timestamp: 15 }).unread).toBe(1) // only the t=20 one remains unread
})
it('returns added:false when an alias merges into an existing entry', () => {
  expect(note(msg, 10).added).toBe(true)
  expect(note({ ...msg, stanzaId: 'S1' }, 10).added).toBe(false)  // merged, not new
})
it('coalesces two entries when a later alias bridges them', () => {
  // Two copies land separately (no shared tier yet), then a copy carrying BOTH tiers arrives.
  noteTransient(K, { position: { timestamp: 10 } }, 'origin-key-O', ['origin-key-O'])
  noteTransient(K, { position: { timestamp: 10 } }, 'stanza-key-S', ['stanza-key-S'])
  expect(transientCounts(K, { timestamp: 5 }).unread).toBe(2)
  const r = noteTransient(K, { position: { timestamp: 10 } },
    'stanza-key-S', ['stanza-key-S', 'origin-key-O'])   // bridges both
  expect(r).toEqual({ added: false, requiresRecount: true })    // nothing added, but 2 -> 1
  expect(transientCounts(K, { timestamp: 5 }).unread).toBe(1)   // coalesced, not 2
})
it('a plain alias registration reports no semantic change', () => {
  note(msg, 10)
  const r = noteTransient(K, { position: { timestamp: 10 } },
    transientIdentity(msg, 'room'), transientAliases(msg, 'room'))
  expect(r).toEqual({ added: false, requiresRecount: false })
})
it('removeTransient reports whether anything was removed', () => {
  note(msg, 10)
  expect(removeTransient(K, transientIdentity(msg, 'room')).removed).toBe(true)
  expect(removeTransient(K, transientIdentity(msg, 'room')).removed).toBe(false)
})

```

- [ ] **Step 2: Run → FAIL.**
- [ ] **Step 3: Implement**; `transientCounts` counts entries with `compareOrder(entry.position, boundary) > 0` (a `undefined` boundary counts everything).
- [ ] **Step 4: Wire** — `noteTransient` from the `+1` path when the message is `noLocalStore` **and** renderable (Task 9), carrying its `OrderPosition`, **incrementing the store only on `added: true` and scheduling a recount when `requiresRecount` is true**; `pruneTransient` on pointer advance; `removeTransient` on retraction/removal, **scheduling a recount when `removed` is true**; `clearTransientScope` on account teardown/scope switch. **Do not** hook deactivation.
- [ ] **Step 5: Deliberate-break ×2** — (a) return 0 from `transientCounts` ⇒ the existing `noLocalStore` tests (`chatStore.test.ts:1403`, `roomStore.test.ts:1408`) FAIL; (b) key by `messageId` alone ⇒ the same-id-different-sender test FAILS. Revert.
- [ ] **Step 6: Commit** — `feat(read-state): position-aware transient overlay for never-archived messages`

---

### Task 7: Chat derivation — discard the legacy count, latest-wins, rederive the divider

**Files:** `packages/fluux-sdk/src/stores/chatStore.ts:2219-2281` (rewrite) + trigger sites (`:2575` MAM merge, `:1817-1864` remote marker, cold-start rehydrate) + `chatStore.test.ts`.

**Interfaces:** `recomputeUnreadForConversation(conversationId): Promise<void>` (signature unchanged — already bound at `storeBindingKeys.ts:67`).

**The derivation:**
1. **Discard the legacy count.** At every site that calls `recomputeCountsFromPointer`, keep its `readPointer` (and its guard behavior) but **do not write its `unreadCount`/`mentionsCount`**. This is what makes `deferred` preserve the last *trusted* value rather than a provisional one.
2. Bump a **per-entity recount version** (`recountVersion.set(id, v+1)`) and capture `v` before any await.
3. Defer conditions: un-migrated legacy read state **or** pending remote marker ⇒ `deferred`; `pointerlessDefers(readPointer, unreadCount)` ⇒ `deferred`.
4. `floor = computeFloor(readPointer, historyFloor)`; `!floor` ⇒ `deferred`.
5. Coverage: `if (!isCaughtUpForCounting(mam)) return deferred`; `bottom = await resolveCoverageBottom(...)`; `'missing'` ⇒ `deferred`; `'unresolvable'` ⇒ invalidate the record + `deferred`; `compareOrder(bottom, floorPos) > 0` ⇒ `deferred`.
6. `res = await countUnreadInArchive(id, { floor, pointer: readPointer })`; `null` ⇒ `unavailable`.
7. **Latest-wins commit:** re-read the version; if `recountVersion.get(id) !== v`, **discard** (a newer recount owns the result). Otherwise:
   - `unreadCount = min(999, res.unread + transient.unread)` — commits unconditionally on `exact`.
   - **`mentionsCount` is NOT written.** Archive recounts never touch it — it stays on the live `+1` path, cleared only by explicit read / mark-read. See the Global Constraints for why (MAM never sets `isMention`, so a scan would zero a correctly live-counted mention).
8. **Rederive the divider.** When the boundary moved (a remote pointer advance), recompute `firstNewMessageMarkers[id]` = the first eligible message after the new boundary, or **delete** the entry when the count is 0. `firstNewMessageId` is store-owned (every write site reads `state.firstNewMessageMarkers`), so the UI cannot live-track a divider whose store id never changes — this step is what makes acceptance scenario 7 possible.

- [ ] **Steps:** failing tests for — backgrounded deep pointer ⇒ `exact`; migrated pointer (no key) ⇒ over-counts, never zero; un-migrated ⇒ `deferred`; pointerless-with-count ⇒ `deferred`; **not caught up ⇒ `deferred` and the persisted count is unchanged even though `recomputeCountsFromPointer` ran** (the reviewer's test: make the legacy fn's would-be count differ from the persisted one, then assert the persisted value survives); missing coverage ⇒ `deferred`; unresolvable bottom ⇒ `deferred` + invalidated; **latest-wins: start recount A (slow), then B (fast); B commits; A finishes last and must NOT overwrite**; **remote advance moves `firstNewMessageMarkers` and deletes it at zero**; **`mentionsCount` is left UNCHANGED by an `exact` recount, by a `deferred` one, and by an `unavailable` one** (three separate assertions — seed a non-zero `mentionsCount`, drive each outcome, assert it still reads the seeded value); **the transient overlay is summed into the committed unread**.

  **Store-level projection tests (not overlay-unit tests) — these are what catch the stale-projection class:**
  - re-noting the same logical message through a **new alias** does **not** increment the visible count twice (`added: false` ⇒ no `+1`);
  - **retracting the only transient unread** moves the visible count `1 → 0` (removal schedules a recount);
  - **removing one of two** transient unread messages moves it `2 → 1`;
  - **a bridging alias that coalesces two separately-counted transient entries moves the visible count `2 → 1`** (`added: false, requiresRecount: true` — the fast path adds nothing, so only the scheduled recount can fix the projection);
  - an **`unavailable`/`deferred`** recount triggered by an overlay change stays **conservative** — it must not clear the trusted count.

  Deliberate-break each. Wire **five** triggers — cold-start rehydrate, forward MAM merge past the floor, pointer advance / inbound marker, deferred-decrypt drop, and **any overlay mutation that reported a change** (`noteTransient` returning `requiresRecount: true`, or `removeTransient`/`pruneTransient` reporting a removal). Commit `feat(chat): archive-derived unread — trusted-count preservation, latest-wins, divider rederivation`.

---

### Task 8: Room derivation (new) + close the deferred-decrypt room gap

**Files:** `roomStore.ts` (add `recomputeUnreadForRoom`), `storeBindingKeys.ts` (`roomBindingMethodKeys`), `core/e2ee/deferredDecrypt.ts:175-198`, tests.

Mirror Task 7 exactly — **including the five recount triggers, the five store-level projection tests above (alias re-note no double increment, retraction 1→0, one-of-two 2→1, coalesce 2→1, deferred stays conservative), and the three `mentionsCount`-untouched assertions (exact / deferred / unavailable)** — plus: the unread-only `countRoomUnreadInArchive`; the room-specific control **two messages sharing an `id` but different `from` ⇒ two distinct positions**; and wire `recomputeUnreadForRoom` into the room deferred-decrypt drop path, which calls **no** recount today (a real phantom-badge gap on the room side). A new store method must be added to the store **and** `storeBindingKeys.ts`.

- [ ] **Steps:** as Task 7, plus a `deferredDecrypt.test.ts` control: a dropped encrypted room message that inflated the badge ⇒ the recount corrects it; deliberate-break by not calling it ⇒ phantom badge persists. `build:sdk` + gates. Commit `feat(room): archive-derived room unread; close the deferred-decrypt room recount gap`.

---

### Task 9: `+1` fast-path renderability guard (and transient tagging)

**Files:** `notificationState.ts` (increment branch `:157`) + test.

Increment `unreadCount` only for a message the shared `isRenderableStoredMessage` predicate accepts (re-export it from `readState.ts` so the live path and the cache walk cannot drift). When the accepted message is `noLocalStore`, call **`noteTransient`** (Task 6) with its `OrderPosition` and the identity + aliases from `transientIdentity`/`transientAliases`, and **increment `unreadCount` only when it returns `added: true`**, while **scheduling a recount when it returns `requiresRecount: true`** — an alias-merge of an already-known message must not increment a second time, but a merge that coalesced entries or moved the retained position must still refresh the projection.

- [ ] **Steps:** failing tests — a non-renderable incoming message must NOT increment; a renderable one must; a renderable `noLocalStore` one increments **and** registers in the overlay; **the same logical message re-delivered under a higher identity tier (`added: false`) does NOT increment again**. Deliberate-breaks: (a) drop the renderability guard ⇒ the phantom-increment test FAILS; (b) increment unconditionally instead of on `added` ⇒ the alias-re-delivery test FAILS. Commit `fix(read-state): +1 increments only for renderable messages; tag transient ones`.

---

### Task 10: Delete the slice-limited recount internals — **NO-OP, superseded by Task 7**

> **Execution outcome (2026-07-27):** nothing to delete. Task 7's rewrite already removed the genuinely dead block (the ~50-line re-fetch + recompute in `applyRemoteDisplayed`). The two surviving `MAM_POINTER_RECOUNT_CACHE_LIMIT` consumers feed `recomputeCountsFromPointer`'s **pointer-advance** path for non-resident entities — the mechanism PR B deliberately keeps and PR C removes. Attempting the deletion broke 5 tests that deliberately seed a non-resident entity to prove that path fires. **Retire the constant in PR C, alongside `recomputeCountsFromPointer` itself.**

**Files inspected:** `chatStore.ts`, `roomStore.ts`, the old resident-slice recount paths, and `mamCatchUpUtils.ts`.

- [x] **Outcome:** the genuinely dead exact-recount block was removed by Tasks 7/8. Keep
  `MAM_POINTER_RECOUNT_CACHE_LIMIT` and its two surviving pointer-path consumers; PR C removes
  them with `recomputeCountsFromPointer`. No separate Task 10 code commit.

---

### Task 11: SDK-owned viewport evidence + gate the on-arrival advance

**Files:** Create `viewportEvidence.ts` + test; modify `notificationState.ts` (`EntityContext`, the `userSeesMessage` gate), chat/room `onActivate`, `useMessageListScroll.ts`, `ChatView.tsx`, `RoomView.tsx`, `apps/fluux/src/test-setup.ts`.

**Interfaces:**
```ts
export type ViewportEvidence = 'unknown' | 'at-edge' | 'away'
export interface EvidenceKey { kind: 'chat' | 'room'; entityId: string; accountScope: string }
export function beginViewportGeneration(key: EvidenceKey): number   // synchronous on activate/switch; resets to 'unknown'
export function currentViewportGeneration(key: EvidenceKey): number // so the app can obtain the token it must echo back
export function reportViewport(key: EvidenceKey, generation: number, evidence: 'at-edge' | 'away'): void // stale gen ignored
export function currentViewportEvidence(key: EvidenceKey): ViewportEvidence
export function clearViewportEvidence(accountScope: string): void   // account teardown
```
`EntityContext` gains `viewportAtLiveEdge?: boolean`, derived by the store as `currentViewportEvidence(key) === 'at-edge'`. `userSeesMessage = ctx.isActive && ctx.windowVisible && ctx.viewportAtLiveEdge === true`.

**Generation ownership — exactly one owner.** The **SDK activation path** (`setActiveConversation` / `setActiveRoom`, i.e. the `onActivate` sites) calls `beginViewportGeneration(key)` **synchronously** and is its **sole** caller. The **view never begins a generation** — it only *reads* the current one via `currentViewportGeneration(key)` and reports against it. (If both called `begin`, the view's call would immediately invalidate the token the SDK just created, and the first measurement after every switch would be discarded.)

**App plumbing (this is what makes it executable):**
- `useMessageListScroll` gains an option `onLiveEdgeMeasured?: (atEdge: boolean) => void`, invoked wherever `isAtBottomRef.current` is assigned **from real geometry**. Refs don't re-render, so a callback is the only reliable channel. **Do not** report from `useMessageListScroll.ts:609`, which sets `isAtBottomRef.current = true` on conversation switch — that is precisely the unsafe stale default; evidence must stay `unknown` until measured.
- `ChatView`/`RoomView` **capture the generation once per activation and close over it** — resolving it *inside* the callback would defeat the whole mechanism, because a delayed report from the old view would fetch the *new* generation and be accepted as current:

```tsx
// The generation is an ACTIVATION value, so read it on EVERY render. A useMemo keyed only on
// account/kind/entity would keep a stale token when the SAME entity is re-activated (a new
// generation with unchanged deps), and every later report would be rejected forever.
const generation = currentViewportGeneration(key)

const reportLiveEdge = useCallback(
  (atEdge: boolean) => reportViewport(key, generation, atEdge ? 'at-edge' : 'away'),
  [key, generation],
)
// ...
onLiveEdgeMeasured={reportLiveEdge}
```

  Each render's callback closes over the token captured *for that render*, so a delayed callback from a previous activation still carries the old token and is correctly rejected. **Never** call `currentViewportGeneration` from inside the report callback. `isAtBottomRef` stays boolean and internal to scroll mechanics.

  *Reactivity requirement:* the generation must be a **reactive** value so a same-entity reactivation re-renders the view — expose it through the activation state the view already subscribes to, or give the evidence module a subscribe hook. Reading a non-reactive value per render is not enough on its own.

  *Ordering requirement:* the SDK's `onActivate` begins the generation **synchronously** during activation, before the view renders for the new entity — so the render-time read yields the fresh token. Assert this ordering in a test.

  *Required test:* **same-entity reactivation** — activate A, report at-edge, deactivate, re-activate A (new generation), and confirm (a) a late report carrying the *previous* generation is rejected, and (b) a report on the new generation is accepted.

- [ ] **Steps:** implement the generation map keyed by `kind|entityId|accountScope`; unit-test freshness (new generation ⇒ `unknown`; current-gen report reflected; **stale-generation report ignored**; `clearViewportEvidence` wipes the scope). Gate `onMessageReceived`. Wire `beginViewportGeneration` into both `onActivate` paths, the callback into both views, the new export into `test-setup.ts`. Implement acceptance **scenarios 8 and 9** (the four precondition controls; the switch-race negative control **including the late stale-generation report ignored**). Deliberate-breaks: gate on `isActive && windowVisible` only ⇒ scrolled-up control FAILS; skip the generation check in `reportViewport` ⇒ stale-report control FAILS. `build:sdk` + gates. Commit `feat(read-state): SDK-owned generation-scoped viewport evidence gates the on-arrival advance`.

---

### Task 12: Single-source every numeric UI surface; live-track divider

**Files:** Create `apps/fluux/src/utils/formatUnreadCount.ts` (+test); modify `MessageList.tsx` (delete `markerUnreadCount:232` and `fabBadgeCount:729`), `NewMessageMarker.tsx:11`, **`JumpToLastReadPill.tsx:26`**, **`sidebar-components/ConversationList.tsx:304-306`**, **`utils/roomTooltip.ts:44` (+ `roomTooltip.test.ts`)**, `useMessageListScroll.ts` (expose anchor API), `ChatView.tsx`/`RoomView.tsx`; delete `unreadBadge.ts` (+test); 33 locale files (**both** `chat.newMessagesCount` and `rooms.unreadMessages`, each with its `_other` form); rewrite `MessageList.fab.test.tsx`.

**Numeric-surface inventory (verified — every one that renders a number must go through the formatter):**

| Surface | Today | Change |
|---|---|---|
| `ConversationList.tsx:306` | renders `{conversation.unreadCount}` **raw, uncapped** | route through `formatUnreadCount` |
| `NewMessageMarker.tsx` (divider) | no count at all | add `count`, render via the i18n call below |
| `JumpToLastReadPill.tsx:26` | formats itself: `t('chat.newMessagesCount', { count })` | pass `displayCount` too (same key change) |
| FAB badge (`MessageList.tsx:940`) | own `fabBadgeCount` + inline `> 99 ? '99+'` | canonical `unreadCount` via `formatUnreadCount` |
| **`roomTooltip.ts:44`** (room row tooltip) | `t('rooms.unreadMessages', { count: room.unreadCount })` — **raw count**, its own i18n key | pass `displayCount` too; `rooms.unreadMessages` / `_other` get the same `{{count}}`→`{{displayCount}}` treatment across 33 locales |
| `RoomsList.tsx:463` | a **dot**, not a number (the count itself lives in the row tooltip above) | unchanged — still driven by the same canonical `unreadCount > 0`; **no formatter needed** |
| `RoomsList.tsx:475` `@{mentionsCount}` | mention badge | **separate quantity** — out of scope for the unread formatter |

Each **numeric** surface (the first five rows) gets a `998 / 999 / 1000` test asserting `"998"`, `"999+"`, `"999+"`. `roomTooltip.ts` **already exists on `main`** (the room-tooltip-unread-count plan landed), so this is a modification with existing tests to extend — not a new file.

**Interfaces:**
```ts
export function formatUnreadCount(n: number): string   // n >= 999 ? '999+' : String(n)
// NewMessageMarker({ provisional?, count?: number })
// MessageList prop: unreadCount: number
```
> **`>= 999`, not `> 999`** — the stored count saturates at 999 (Task 4), so it never reaches 1000; `> 999` would render a saturated "999 or more" as an exact "999". Treating 999 as "999+" is consistent across every numeric surface.

**i18n:** the key **already exists**. Change the placeholder in all 33 locales from `{{count}}` to `{{displayCount}}` for `chat.newMessagesCount` and `chat.newMessagesCount_other`, and call it as `t('chat.newMessagesCount', { count: unreadCount, displayCount: formatUnreadCount(unreadCount) })` — numeric `count` still drives i18next plural selection while `displayCount` supplies the capped text.

**Anchor API + a genuinely pre-mutation capture point.** `useMessageListScroll` keeps `ScrollAnchor` capture and `restoreToAnchor(scroller, anchor)` **module-private**; expose them through the hook's return as `captureAnchor(): ScrollAnchor | null` and `restoreAnchor(a: ScrollAnchor): boolean`.

> **Why "capture in a layout effect keyed on `firstNewMessageId`" does not work:** by the time that effect runs React has already committed the DOM, so the geometry read there is *post*-mutation — there is nothing left to capture. The divider change also originates in the **store** (Tasks 7/8 rederive `firstNewMessageMarkers`), which has no DOM access, so the SDK cannot capture either.
>
> **Do this instead — continuously-maintained anchor, pre-paint restore.** `MessageList` keeps a `lastAnchorRef` refreshed from `captureAnchor()` on scroll settle and on each committed render **while the divider id is unchanged**, so a valid pre-mutation anchor always exists. A `useLayoutEffect` keyed on `firstNewMessageId` detects the change and calls `restoreAnchor(lastAnchorRef.current)` — `useLayoutEffect` runs after the DOM mutation but **before paint**, so the corrected offset is what the user sees and there is no visual scroll. Guard the refresh so it does not overwrite the anchor during the mutation render itself (compare the previous divider id held in a ref).

Test it by asserting the anchored message's `offsetTop`-relative viewport position is byte-identical before and after a remote-marker divider move (acceptance scenario 7), with the break check being "skip the `restoreAnchor` call ⇒ the offset shifts."

- [ ] **Steps:** implement `formatUnreadCount` (tests: `998`→`"998"`, `999`→`"999+"`, `1000`→`"999+"`). Add `count` to `NewMessageMarker`; add `displayCount` to `JumpToLastReadPill`'s i18n call; route `ConversationList.tsx:306` through the formatter; update `roomTooltipParts` to pass `displayCount` alongside the numeric `count` and extend `roomTooltip.test.ts` with the `998/999/1000` control. In `MessageList`, delete the two resident-array counts, take `unreadCount`, feed divider + pill + FAB badge through `formatUnreadCount`; leave `fabVisible` and the geometry two-step untouched. Implement the continuously-maintained anchor + pre-paint `restoreAnchor`. Delete `unreadBadge.ts`. Sweep 33 locales (`{{count}}`→`{{displayCount}}`); `i18n.test.ts` green. Add a `998/999/1000` test to **each** of the five numeric surfaces. Rewrite `MessageList.fab.test.tsx` and add divider tests implementing acceptance **scenarios 1–7 verbatim**, with the break-checks written there. Gates + **`npm run test:scroll`**. Commit `feat(ui): one canonical unread count across every numeric surface; live-track divider with anchor preservation`.

---

## Self-Review notes

- **Round-1 review items closed:** (1) trusted-count preservation — legacy count output discarded from the start, T7 test; (2) divider rederivation moved into T7/T8 (store-owned `firstNewMessageMarkers`), T12 only preserves the anchor; (3) `noLocalStore` overlay — T6, wired in T9, summed in T7/T8; (4) kind-aware order in T1/T3 (chat=`id`, room=`(from,id)`), tested separately; (5) strict caught-up + defer on missing coverage in T5; (6) per-entity recount version, latest-wins commit + test in T7/T8; (7) executable viewport plumbing in T11. Plus `archiveOrderKey` naming, deserialize validation, existing i18n key + `{{displayCount}}` + `>= 999`, named anchor API.
- **Round-7 (plan-owner re-scope, post-Task-4 review):** applied the design's authoritative [mention-count contract](../specs/2026-07-22-read-state-model-consolidation-design.md#mention-counts-remain-live-only): PR B derives unread only, removes mention-scan machinery, proves archive outcomes leave `mentionsCount` unchanged, and OR-merges `isMention` as monotonic evidence.
- **Round-6 review items closed:** `noteTransient` now returns `{ added, requiresRecount }` — the two are independent, because a merge adds nothing yet can still change the overlay's contribution. Coalescing (`2 → 1`) or a retained `position` moving across the boundary sets `requiresRecount: true` and schedules the entity recount; plain alias registration sets neither. Added the store-level control: two separately-counted transient entries, a bridging alias arrives, visible count must become `1`.
- **Round-5 review items closed:** the overlay is an **input to the stored count**, so mutating it now updates the projection: `noteTransient` returns `{ added }` and the `+1` path increments only on `added: true` (killing the alias-merge double count); `removeTransient`/`pruneTransient` report removals and **schedule a recount** (killing the stale-after-retraction count); overlay mutation is a **fifth explicit recount trigger** in Tasks 7/8; four **store-level** projection tests added (alias re-note, retract 1→0, one-of-two 2→1, deferred stays conservative); and `noteTransient` **coalesces** when supplied aliases resolve to multiple existing entries rather than picking the first — the same merge-every-match rule as B0's `upsertStoredRoomRow`.
- **Round-4 review items closed:** (A) the transient overlay's storage was **internally inconsistent** — one `Map<identity, entry>` either double-counts (every alias in the map) or breaks alias/retraction lookup (canonical only); it is now two structures per scope, `entries` (iterated for counting) plus `canonicalByAlias` (resolution only), with merge-on-alias-hit and remove-all-aliases semantics. (B) the viewport token was memoized **per entity**, stranding a stale token across a **same-entity reactivation**; it is now an activation value read every render behind a `useCallback([key, generation])`, with an explicit reactivity requirement and a same-entity reactivation test. (C) room identity helpers are **overloaded** so TypeScript enforces `roomJid`, and the examples pass it. (D) the surface-count phrase now says five.
- **Round-3 review items closed:** (i) the viewport generation is **captured once per activation and closed over** — resolving it inside the report callback would have let a late report from the old view fetch the *new* generation and be accepted, silently defeating stale-rejection; (ii) `roomTooltip.ts` added as a **fifth** numeric surface (it renders `rooms.unreadMessages` with a raw count; it exists on `main`), including its locale key and `998/999/1000` control; (iii) the transient overlay now reuses **B0's tiered room identity** (`roomIdentityKeys`/`roomCanonicalKey` + alias index) so a message re-noted after a stanza-id arrives doesn't double-count and a stanza-id retraction can remove it — two new tests; (iv) mechanical: the raw NUL byte is now written as a six-character backslash escape in the sample string (the recurring Write trap — verify `tr -cd '\000' | wc -c` is 0), and Task 9's stale `noteTransientUnread` is now `noteTransient`.
- **Round-2 review items closed:** its mention-overlay and mention-scan proposal was superseded by Round 7. The surviving constraints are account-scoped tiered room identity, no deactivation clear, one viewport-generation owner, complete numeric-surface formatter coverage, and a continuously-maintained pre-mutation scroll anchor.
- **Ordering:** T1→T2→T3→T4→T5→T6→T7→T8→T9→T10→T11→T12. T6 must precede T9 (which registers into it) and T7/T8 (which sum it).
- **Type consistency:** `ArchiveOrderKey`/`compareOrder`/`OrderPosition` (T1) reused verbatim in T2/T3/T4/T5; `ArchiveCount` (T4) is `{unread}` only — mentions are out of PR B's scope; `EvidenceKey` (T11) used by both views.
- **Pre-merge:** a real-browser spot-check that a remote marker while scrolled up does not visually scroll (WebKit momentum), same posture as B0's migration gate.
