# Sliding-window message history Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the fixed 5000-message "keep newest" cap with a bounded bidirectional sliding window so users can scroll back through unlimited history, backed by the SDK's IndexedDB cache + MAM, without unbounded RAM or broken scroll geometry.

**Architecture:** The resident in-memory message array stays bounded (`RESIDENT_WINDOW_SIZE`) but becomes a window that slides over history: scroll-up loads older and evicts the newest end; scroll-down loads newer and evicts the oldest end. The array never grows huge, so the virtualizer's size-estimate is untouched. A per-conversation `windowAtLiveEdge` flag gates whether incoming live messages append to the resident array.

**Tech Stack:** Zustand vanilla stores (`@fluux/sdk`), `@tanstack/react-virtual`, Vitest (SDK: pure; app: happy-dom/jsdom), the app's scroll e2e harness (`npm run test:scroll`).

## Global Constraints

- SDK public API stays clean — no new `@xmpp/*` leakage into the app (CLAUDE.md).
- Both `roomStore` (MUC) and `chatStore` (1:1) change symmetrically; share logic via `packages/fluux-sdk/src/stores/shared/messageArrayUtils.ts`.
- Scroll behavior is correctness-sensitive: every scroll-touching task ends by running `npm run test:scroll` from `apps/fluux` and it MUST stay green.
- After any SDK type/signature change: run `npm run build:sdk` before app typecheck (worktree app resolves `@fluux/sdk` to `packages/fluux-sdk/dist`).
- Run SDK tests from `packages/fluux-sdk` (`npx vitest run src/...`); app tests from `apps/fluux` (`npx vitest run src/...`). Never `npx vitest run apps/...` from repo root (loses `@/` alias).
- `RESIDENT_WINDOW_SIZE = 5000` (unchanged value; now a sliding-window bound).
- No Claude footer in commits.

---

## Phase 1 — Data layer (SDK stores). Deliverable: the store can slide the window, fully unit-tested, before any UI wiring.

### Task 1: Directional trim helper

**Files:**
- Modify: `packages/fluux-sdk/src/stores/shared/messageArrayUtils.ts`
- Test: `packages/fluux-sdk/src/stores/shared/messageArrayUtils.test.ts` (exists — add cases)

**Interfaces:**
- Produces: `trimMessagesKeepOldest<T>(messages: T[], maxCount: number): T[]` — keeps the OLDEST `maxCount` (front of a timestamp-ascending array), i.e. evicts the newest tail. Mirror of the existing `trimMessages` (which keeps newest via `slice(-maxCount)`).

- [ ] **Step 1: Write the failing test**

Add to `messageArrayUtils.test.ts`:
```typescript
import { trimMessagesKeepOldest } from './messageArrayUtils'

describe('trimMessagesKeepOldest', () => {
  it('keeps the oldest maxCount (evicts the newest tail)', () => {
    const msgs = [1, 2, 3, 4, 5].map((n) => ({ timestamp: new Date(n) }))
    expect(trimMessagesKeepOldest(msgs, 3)).toEqual(msgs.slice(0, 3))
  })
  it('returns input unchanged when under the limit', () => {
    const msgs = [1, 2].map((n) => ({ timestamp: new Date(n) }))
    expect(trimMessagesKeepOldest(msgs, 3)).toBe(msgs)
  })
  it('returns [] for maxCount <= 0', () => {
    const msgs = [{ timestamp: new Date(1) }]
    expect(trimMessagesKeepOldest(msgs, 0)).toEqual([])
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/fluux-sdk && npx vitest run src/stores/shared/messageArrayUtils.test.ts`
Expected: FAIL — `trimMessagesKeepOldest is not a function`.

- [ ] **Step 3: Write minimal implementation**

Add to `messageArrayUtils.ts` next to `trimMessages`:
```typescript
/**
 * Keep the OLDEST `maxCount` messages (front of a timestamp-ascending array),
 * evicting the newest tail. Used by the sliding window's load-older path so that
 * scrolling up past the window bound slides the window instead of dropping the
 * just-loaded older batch (the mirror of {@link trimMessages}, which keeps newest).
 */
export function trimMessagesKeepOldest<T>(messages: T[], maxCount: number): T[] {
  if (maxCount <= 0) return []
  if (messages.length <= maxCount) return messages
  return messages.slice(0, maxCount)
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/fluux-sdk && npx vitest run src/stores/shared/messageArrayUtils.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/fluux-sdk/src/stores/shared/messageArrayUtils.ts packages/fluux-sdk/src/stores/shared/messageArrayUtils.test.ts
git commit -m "feat(sdk): add trimMessagesKeepOldest for sliding-window eviction"
```

---

### Task 2: `prependOlderMessages` slides instead of dropping

**Files:**
- Modify: `packages/fluux-sdk/src/stores/shared/messageArrayUtils.ts:255-284` (`prependOlderMessages`)
- Test: `packages/fluux-sdk/src/stores/shared/messageArrayUtils.test.ts`

**Interfaces:**
- Consumes: `trimMessagesKeepOldest` (Task 1).
- Produces: `prependOlderMessages` unchanged signature; when `maxCount` is set it now keeps the OLDEST `maxCount` (evicts newest), so a load-older at the bound slides the window.

- [ ] **Step 1: Write the failing test**

```typescript
import { prependOlderMessages } from './messageArrayUtils'

describe('prependOlderMessages sliding window', () => {
  const keys = (m: { id: string }) => [m.id]
  const at = (id: string, t: number) => ({ id, timestamp: new Date(t) })
  it('at the bound, keeps the just-loaded older batch and evicts the newest', () => {
    const existing = [at('c', 3), at('d', 4)]            // resident window (bound 2)
    const older = [at('a', 1), at('b', 2)]               // scroll-up loads these
    const { merged, newMessages } = prependOlderMessages(existing, older, keys, 2)
    expect(merged.map((m) => m.id)).toEqual(['a', 'b'])  // slid up: oldest 2 kept, c/d evicted
    expect(newMessages.map((m) => m.id)).toEqual(['a', 'b'])
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/fluux-sdk && npx vitest run src/stores/shared/messageArrayUtils.test.ts -t "sliding window"`
Expected: FAIL — merged is `['c','d']` (old `slice(-2)` behavior dropped the loaded batch).

- [ ] **Step 3: Write minimal implementation**

In `prependOlderMessages`, replace the trim (currently `merged = trimMessages(merged, maxCount)` at ~line 280) with:
```typescript
  // Load-older slides the window: keep the OLDEST maxCount so the just-loaded older
  // batch survives and the newest tail is evicted (was trimMessages = keep-newest,
  // which dropped the loaded batch at the bound — the old scroll-back "wall").
  if (maxCount !== undefined) {
    merged = trimMessagesKeepOldest(merged, maxCount)
  }
```
Add `trimMessagesKeepOldest` to the existing import/definitions in the same file (same module — no import needed).

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/fluux-sdk && npx vitest run src/stores/shared/messageArrayUtils.test.ts`
Expected: PASS (all, including prior cases).

- [ ] **Step 5: Commit**

```bash
git add packages/fluux-sdk/src/stores/shared/messageArrayUtils.ts packages/fluux-sdk/src/stores/shared/messageArrayUtils.test.ts
git commit -m "feat(sdk): prependOlderMessages slides the window instead of dropping the batch"
```

---

### Task 3: Rename cap → `RESIDENT_WINDOW_SIZE` and fix the inlined load-older trim (roomStore)

**Files:**
- Modify: `packages/fluux-sdk/src/stores/roomStore.ts` — rename `MAX_MESSAGES_PER_ROOM` (line 49) → `RESIDENT_WINDOW_SIZE`; fix the inlined older-load trim at `loadOlderMessagesFromCache` (line 2089).
- Test: `packages/fluux-sdk/src/stores/roomStore.test.ts` (or the room MAM/cache test file)

**Interfaces:**
- Consumes: `trimMessagesKeepOldest` (Task 1) — add to the `messageArrayUtils` import at `roomStore.ts:26`.
- Produces: `loadOlderMessagesFromCache` now slides the window (keeps oldest) instead of no-op-ing at the bound.

- [ ] **Step 1: Write the failing test**

Add a store test that seeds a room at the window bound, then loads older from cache and asserts the older messages are now resident (not dropped). Follow the existing room-store test setup (mock `messageCache.getRoomMessages`). Assert:
```typescript
// after seeding `RESIDENT_WINDOW_SIZE` resident messages and mocking cache to return
// 50 older, call loadOlderMessagesFromCache; the oldest resident id must now be an
// older-batch id and length must stay === RESIDENT_WINDOW_SIZE.
expect(room.messages.length).toBe(RESIDENT_WINDOW_SIZE)
expect(room.messages[0].id).toBe(/* an older-batch id */)
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/fluux-sdk && npx vitest run src/stores/roomStore.test.ts -t "load older slides"`
Expected: FAIL — oldest resident id is still the pre-load oldest (older batch dropped by `trimMessages`).

- [ ] **Step 3: Write minimal implementation**

1. Rename the constant and all usages: `MAX_MESSAGES_PER_ROOM` → `RESIDENT_WINDOW_SIZE` (line 49 definition + usages at 312, 1171, 2089, 2196-2202, and the doc comment at 47). Keep the value `5000`.
2. At `loadOlderMessagesFromCache` (line 2089), change:
```typescript
   const merged = trimMessages(sorted, RESIDENT_WINDOW_SIZE)
```
to:
```typescript
   // Load-older slides the window (keep oldest) so scroll-back past the bound works.
   const merged = trimMessagesKeepOldest(sorted, RESIDENT_WINDOW_SIZE)
```
3. Add `trimMessagesKeepOldest` to the import at `roomStore.ts:26`.

Note: the MAM backward path at line ~2192 already uses `prependOlderMessages` (fixed in Task 2) — no change needed there beyond the constant rename.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/fluux-sdk && npx vitest run src/stores/roomStore.test.ts`
Expected: PASS. Then `npm run build:sdk` from repo root.

- [ ] **Step 5: Commit**

```bash
git add packages/fluux-sdk/src/stores/roomStore.ts packages/fluux-sdk/src/stores/roomStore.test.ts
git commit -m "feat(sdk): room load-older slides the window; rename cap to RESIDENT_WINDOW_SIZE"
```

---

### Task 4: Same for chatStore (1:1)

**Files:**
- Modify: `packages/fluux-sdk/src/stores/chatStore.ts` — rename `MAX_MESSAGES_PER_CONVERSATION` (line 28) → `RESIDENT_WINDOW_SIZE`; fix the inlined older-load trim in `loadOlderMessagesFromCache`.
- Test: `packages/fluux-sdk/src/stores/chatStore.test.ts`

**Interfaces:**
- Consumes: `trimMessagesKeepOldest`; add to `messageArrayUtils` import at `chatStore.ts:12`.
- Produces: chat `loadOlderMessagesFromCache` slides the window.

- [ ] **Step 1: Write the failing test**

Mirror Task 3's test for `chatStore` (seed to bound, mock `messageCache.getMessages` older return, assert slide). Use the chat-store test's existing setup.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/fluux-sdk && npx vitest run src/stores/chatStore.test.ts -t "load older slides"`
Expected: FAIL (older batch dropped).

- [ ] **Step 3: Write minimal implementation**

1. Rename `MAX_MESSAGES_PER_CONVERSATION` → `RESIDENT_WINDOW_SIZE` (definition + usages at 102, 1511-1517, 1753, and the inlined loadOlder trim). Keep `5000`.
2. In chat `loadOlderMessagesFromCache`, change the older-load trim from `trimMessages(..., RESIDENT_WINDOW_SIZE)` to `trimMessagesKeepOldest(..., RESIDENT_WINDOW_SIZE)`.
3. Add `trimMessagesKeepOldest` to the import at `chatStore.ts:12`.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/fluux-sdk && npx vitest run src/stores/chatStore.test.ts` then `npm run build:sdk`.
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/fluux-sdk/src/stores/chatStore.ts packages/fluux-sdk/src/stores/chatStore.test.ts
git commit -m "feat(sdk): chat load-older slides the window; rename cap to RESIDENT_WINDOW_SIZE"
```

---

### Task 5: `windowAtLiveEdge` flag + live-edge gating on message add

**Files:**
- Modify: `packages/fluux-sdk/src/stores/roomStore.ts` (runtime type, `addMessage` ~1171, older-load sets flag false, `activateRoom`/recenter sets true) and `chatStore.ts` (equivalent).
- Modify: the client-facing state types (`RoomRuntime` / chat runtime) to add `windowAtLiveEdge: boolean` (default `true`).
- Test: `roomStore.test.ts`, `chatStore.test.ts`

**Interfaces:**
- Produces: per-conversation `windowAtLiveEdge: boolean`. `addMessage` appends+`trimMessages` (keep newest, evict oldest) only when `true`; when `false` it updates `lastMessage`/unread meta and does NOT append. Load-older that evicts the newest resident sets `false`.

- [ ] **Step 1: Write the failing test**

```typescript
// roomStore.test.ts
it('does not append a live message when the window has slid off the live edge', () => {
  // 1. seed a room at the live edge with N messages; expect windowAtLiveEdge === true
  // 2. slide the window up (loadOlderMessagesFromCache at the bound) → windowAtLiveEdge === false
  // 3. addMessage(liveMsg)
  const room = roomStore.getState().getRoom(JID)!
  expect(room.messages.some((m) => m.id === liveMsg.id)).toBe(false) // not appended
  expect(room.lastMessage?.id).toBe(liveMsg.id)                       // meta still updated
})
it('appends a live message when the window is at the live edge', () => {
  // seed at edge (windowAtLiveEdge true), addMessage → appended + oldest evicted at bound
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/fluux-sdk && npx vitest run src/stores/roomStore.test.ts -t "live edge"`
Expected: FAIL — live message is appended regardless (no gating yet).

- [ ] **Step 3: Write minimal implementation**

1. Add `windowAtLiveEdge: boolean` to the room runtime state (default `true` at room creation, ~lines 1795/1824 where `occupants: new Map()` etc. are initialized).
2. In `loadOlderMessagesFromCache` and the backward-MAM merge, after computing `merged`, set `windowAtLiveEdge = merged[merged.length - 1]?.id === existing.messages[existing.messages.length - 1]?.id` (i.e. `false` when the newest resident changed = the tail was evicted).
3. In `addMessage` (~1171), gate:
```typescript
   const runtime = state.roomRuntime.get(roomJid)
   if (runtime && runtime.windowAtLiveEdge === false) {
     // Window has slid up: do NOT append (would create a gap). Update lastMessage +
     // unread meta only; the message is persisted to cache elsewhere and loads on
     // jump-to-latest. (Keep existing meta/unread update code; skip the messages
     // array mutation + trim.)
     return { /* meta/unread updates only */ }
   }
   // else: existing append + trimMessages(keep-newest) path (evicts oldest at bound)
```
4. `activateRoom` (full latest load) and the recenter-to-latest path (Task 6) set `windowAtLiveEdge = true`.
5. Repeat for `chatStore`.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/fluux-sdk && npx vitest run src/stores/roomStore.test.ts src/stores/chatStore.test.ts` then `npm run build:sdk`.
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/fluux-sdk/src/stores/roomStore.ts packages/fluux-sdk/src/stores/chatStore.ts packages/fluux-sdk/src/stores/*.test.ts
git commit -m "feat(sdk): gate live-message append on windowAtLiveEdge (sliding window)"
```

---

### Task 6: `loadNewerMessagesFromCache` + `recenterToLatest` actions

**Files:**
- Modify: `packages/fluux-sdk/src/stores/roomStore.ts` (new actions + interface in the `RoomState` action list ~line 504) and `chatStore.ts` (~line 338).
- Modify: SDK store binding surfaces per the room-store binding fan-out: `client.ts` interface, `defaultStoreBindings.ts`, `test-utils.ts` mock (memory: room-store method must be added in all 3).
- Test: `roomStore.test.ts`, `chatStore.test.ts`

**Interfaces:**
- Produces:
  - `loadNewerMessagesFromCache(convId: string, limit?: number): Promise<Message[]|RoomMessage[]>` — mirror of `loadOlderMessagesFromCache` but loads the next-newer cache slice AFTER the resident newest and appends, evicting the oldest end (`trimMessages` keep-newest). Sets `windowAtLiveEdge = true` when the cache returns nothing newer (window reached the tail).
  - `recenterToLatest(convId: string): Promise<void>` — reset the resident window to the newest slice from cache (reuse `loadMessagesFromCache` latest-N) and set `windowAtLiveEdge = true`. Used by jump-to-latest.

- [ ] **Step 1: Write the failing test**

```typescript
it('loadNewerMessagesFromCache appends newer and evicts the oldest at the bound', async () => {
  // seed a slid-up window; mock messageCache to return newer slice; call action;
  // assert newest resident id === newer-batch tail, length === RESIDENT_WINDOW_SIZE,
  // and windowAtLiveEdge flips true only when no more-newer remain.
})
it('recenterToLatest reloads the newest window and sets windowAtLiveEdge true', async () => { /* ... */ })
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/fluux-sdk && npx vitest run src/stores/roomStore.test.ts -t "loadNewer"`
Expected: FAIL — action undefined.

- [ ] **Step 3: Write minimal implementation**

Implement `loadNewerMessagesFromCache` as a mirror of `loadOlderMessagesFromCache` (roomStore ~2050): use `messageCache.getRoomMessages(roomJid, { after: newestInMemory.timestamp, limit })`, append + `trimMessages(sorted, RESIDENT_WINDOW_SIZE)` (keep newest = evict oldest), and set `windowAtLiveEdge = cachedMessages.length < limit` (nothing more newer ⇒ at the tail). Implement `recenterToLatest` by calling the existing `loadMessagesFromCache(convId, { limit: RESIDENT_WINDOW_SIZE })` latest path and setting `windowAtLiveEdge = true`. Add both to the `RoomState`/`ChatState` interfaces, `client.ts`, `defaultStoreBindings.ts`, and `test-utils.ts` mock.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/fluux-sdk && npx vitest run src/stores/roomStore.test.ts src/stores/chatStore.test.ts` then root `npm run typecheck` (dts can pass while tsc fails — run root typecheck).
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/fluux-sdk/src
git commit -m "feat(sdk): loadNewerMessagesFromCache + recenterToLatest for sliding window"
```

---

## Phase 2 — Scroll layer (app). Deliverable: the UI drives the slide bidirectionally with anchor-stable scrolling. HIGH RISK — mirror existing proven patterns; `npm run test:scroll` gates every task.

### Task 7: Load-newer scroll trigger, wired to the store

**Files:**
- Modify: `apps/fluux/src/components/conversation/useMessageListScroll.ts` — add an `onLoadNewer` trigger symmetric to the existing `onScrollToTop`/`canLoadMore` machinery (anchors: `onScrollToTop` prop at line 225/286; `canLoadMore` at line 436; the scroll-position handler that fires load-older).
- Modify: `apps/fluux/src/components/conversation/MessageList.tsx` — thread an `onLoadNewer?: () => void` prop next to `onScrollToTop` (props at line 95/149/441).
- Modify: `apps/fluux/src/components/RoomView.tsx` and the 1:1 `ChatView` — pass `onLoadNewer={loadNewer}` where they currently pass `onScrollToTop={fetchOlderHistory}` (RoomView `RoomMessageList` at line 541-586, prop `onScrollToTop`/`onLoadAround`). Wire `loadNewer` to the store `loadNewerMessagesFromCache` (via `useRoomActive` / chat equivalent, mirroring how `fetchOlderHistory` / `loadMessagesAround` are exposed at `useRoomActive.ts`).
- Test: `apps/fluux/src/components/conversation/useMessageListScroll.test.tsx` (or the scroll test file), plus `npm run test:scroll`.

**Interfaces:**
- Consumes: store `loadNewerMessagesFromCache` (Task 6).
- Produces: `onLoadNewer` fires when the viewport is within the load threshold of the resident window's BOTTOM AND `windowAtLiveEdge` is false (guarded by a new `isLoadingNewer` flag mirroring `isLoadingOlder`).

- [ ] **Step 1: Write the failing test**

Add a hook/behavior test asserting: when scrolled near the bottom of a slid-up window (not at live edge), `onLoadNewer` is called once (guarded, not thrashing). Mirror the existing load-older trigger test in the same file.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/fluux && npx vitest run src/components/conversation/useMessageListScroll.test.tsx -t "load newer"`
Expected: FAIL — `onLoadNewer` never called (trigger absent).

- [ ] **Step 3: Write minimal implementation**

Add the mirror of the load-older path: a `canLoadNewer = !windowAtLiveEdge && !isLoadingNewer && !!onLoadNewer` guard, a bottom-proximity check in the same scroll handler that computes top-proximity for load-older, and fire `onLoadNewer()`. Thread the prop through `MessageList` and `RoomView`/`ChatView` to the store action. Keep it READ-ONLY w.r.t. scrollTop (do not write scroll here — Task 8 handles anchoring).

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/fluux && npx vitest run src/components/conversation/useMessageListScroll.test.tsx && npm run test:scroll`
Expected: PASS; scroll e2e green.

- [ ] **Step 5: Commit**

```bash
git add apps/fluux/src/components/conversation/useMessageListScroll.ts apps/fluux/src/components/conversation/MessageList.tsx apps/fluux/src/components/RoomView.tsx apps/fluux/src/components/ChatView.tsx apps/fluux/src/components/conversation/useMessageListScroll.test.tsx
git commit -m "feat(app): load-newer scroll trigger for the sliding window"
```

---

### Task 8: Append-newer anchor correction (the hard one)

**Files:**
- Modify: `apps/fluux/src/components/conversation/useMessageListScroll.ts` — add an eviction-aware restore mirroring the existing MAM-prepend restore (anchors: `prependRef` at line 387; `restoreToAnchor` at line 201; the prepend-restore `useLayoutEffect`; `getOffsetForMessageId` usage; the per-frame re-assert loop referenced at lines 104/316-322).
- Test: `apps/fluux/src/components/conversation/MessageList.virtualizedScroll.test.tsx` + `npm run test:scroll`.

**Interfaces:**
- Consumes: the virtualizer's `getOffsetForMessageId` (already used by the prepend restore).
- Produces: after a load-newer that evicts the OLDEST (top) rows, the viewport stays visually anchored on the same message (offsets shift up by the evicted height; correct scrollTop by the same delta before paint — the mirror of the prepend restore, which corrects for rows added at the top).

- [ ] **Step 1: Write the failing test**

Add a virtualized-scroll test: with a slid window, trigger load-newer (append + evict-oldest); assert the currently-anchored message's on-screen offset is unchanged (± tolerance) across the count change. Mirror the existing prepend-restore assertion in `MessageList.virtualizedScroll.test.tsx`.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/fluux && npx vitest run src/components/conversation/MessageList.virtualizedScroll.test.tsx -t "append-newer anchor"`
Expected: FAIL — viewport jumps by the evicted top height.

- [ ] **Step 3: Write minimal implementation**

Mirror the prepend restore for the eviction case: capture the anchor message id + its pre-change offset before the array update (as `prependRef` does for prepend), then in the layout effect after the count change, compute the new offset via `getOffsetForMessageId` and set `scrollTop` to keep the anchor fixed, reusing the single-flight re-assert loop (do NOT start a competing loop — supersede per the existing single-flight rule at lines 316-322). Route any programmatic scroll through `scrollToOffset` (which pushes the offset into the virtualizer callback with `isScrolling=false` — never a synthetic scroll event; see `tanstackMessageVirtualizer.ts:239-253`).

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/fluux && npx vitest run src/components/conversation/MessageList.virtualizedScroll.test.tsx && npm run test:scroll`
Expected: PASS; scroll e2e green (bottom-stick, catch-up, MDS marker, search-jump, deep-history restore all still pass).

- [ ] **Step 5: Commit**

```bash
git add apps/fluux/src/components/conversation/useMessageListScroll.ts apps/fluux/src/components/conversation/MessageList.virtualizedScroll.test.tsx
git commit -m "feat(app): anchor-stable append-newer eviction for the sliding window"
```

---

### Task 9: Jump-to-latest affordance + "new messages" indicator

**Files:**
- Modify: `apps/fluux/src/components/RoomView.tsx` / `ChatView.tsx` — wire the existing scroll-to-bottom FAB to call `recenterToLatest` (Task 6) when `windowAtLiveEdge` is false (otherwise the plain scroll-to-bottom).
- Modify: the FAB/indicator component to show a "new messages ↓" state when a live message arrives while `windowAtLiveEdge` is false (the meta/unread already updates from Task 5).
- Test: component test for the FAB state + `npm run test:scroll`.

**Interfaces:**
- Consumes: `recenterToLatest` (Task 6), `windowAtLiveEdge` (Task 5, exposed via the room/chat active hook).

- [ ] **Step 1: Write the failing test**

Component test: when `windowAtLiveEdge` is false and a new live message arrives, the scroll-to-bottom control renders the "new messages" affordance; clicking it calls `recenterToLatest` then scrolls to bottom.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/fluux && npx vitest run src/components/RoomView.test.tsx -t "jump to latest"`
Expected: FAIL — control not wired to `recenterToLatest`.

- [ ] **Step 3: Write minimal implementation**

Expose `windowAtLiveEdge` through `useRoomActive` / chat active hook (focused selector). In the FAB handler: `if (!windowAtLiveEdge) { await recenterToLatest(jid) } scrollToBottom()`. Render the "new messages" label when `!windowAtLiveEdge` and unread > 0.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/fluux && npx vitest run src/components/RoomView.test.tsx && npm run test:scroll`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/fluux/src/components/RoomView.tsx apps/fluux/src/components/ChatView.tsx apps/fluux/src/components/conversation
git commit -m "feat(app): jump-to-latest recenter + new-messages indicator for sliding window"
```

---

### Task 10: Full verification & RAM check

**Files:** none (verification only).

- [ ] **Step 1: Typecheck + lint + full suites**

Run:
```bash
cd /Users/mremond/AIProjects/fluux-messenger/.claude/worktrees/fervent-mayer-6832c0
npm run build:sdk
cd packages/fluux-sdk && npx vitest run
cd ../../apps/fluux && npx vitest run && npx tsc --noEmit -p tsconfig.json && npx eslint src && npm run test:scroll
```
Expected: all green, typecheck/lint clean.

- [ ] **Step 2: Manual RAM + unlimited-scroll check (perf harness)**

Follow the `perf-stress-ui` skill: `npm run dev`, open `demo.html?stress=rooms:1,messages:1000,activate:1,msgStep:0&perf=1&tutorial=false`, scroll up past the old 5000 wall (seed >5000 if needed), confirm: (a) scroll-back continues past 5000, (b) `[data-message-list]` DOM stays windowed, (c) `roomStore.getState().getRoom(jid).messages.length` stays ≈ `RESIDENT_WINDOW_SIZE` while scrolling (window slides, not grows), (d) scroll-down + jump-to-latest recenters. Record the resident length before/after deep scroll-back as the RAM-bound evidence.

- [ ] **Step 3: Commit any doc/notes**

```bash
git add -A && git commit -m "chore: verify sliding-window message history"
```

---

## Self-Review

**Spec coverage:** window model (Tasks 1-2), directional eviction (2-4), load-newer (6), live-edge gating (5), scroll triggers (7), append-newer anchor (8), jump-to-latest + indicator (9), no estimate change (by construction — window stays bounded), both stores (3-6), testing (each task + Task 10). All spec sections map to a task.

**Placeholder scan:** Phase 1 steps carry real code. Phase 2 steps intentionally anchor to exact existing functions/line ranges to mirror (the 2638-line scroll hook's prepend-restore) rather than reproduce delicate code verbatim; each still has a concrete failing test, exact run command, and commit.

**Type consistency:** `trimMessagesKeepOldest`, `windowAtLiveEdge`, `loadNewerMessagesFromCache`, `recenterToLatest`, `onLoadNewer`, `isLoadingNewer`, `RESIDENT_WINDOW_SIZE` are used consistently across tasks.
