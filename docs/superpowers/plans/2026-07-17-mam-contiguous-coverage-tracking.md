# MAM Contiguous-Coverage Tracking (Codex #9 + #10) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make MAM catch-up track *proven contiguous coverage from the live edge* as a first-class engine quantity, so (9) a disjoint search/context island in IndexedDB can never mis-seed the Phase B backward walk, and (10) a seam is only ever formed from a proven MAM boundary — never from an unarchived preview timestamp.

**Architecture:** Both findings are the same underlying gap: today the engine infers "where does our download coverage end" from *whatever happens to be in the cache* (`probeCacheBottom` = global oldest row; seam lower bound = `messagePageExtent(resident).newestTs ?? previewTimestamp`). Neither the global-oldest row nor the preview timestamp is guaranteed to be a proven, archive-anchored boundary of the *contiguous-from-live* region. This plan separates **coverage facts** (proven archive boundaries: a `GapInterval`'s edges, a real MAM page's extent) from **cache contents** (which may include islands and unarchived previews), and routes Phase B seeding and seam formation exclusively through coverage facts.

**Tech Stack:** TypeScript, Zustand vanilla stores, Vitest, XEP-0313 (MAM), XEP-0059 (RSM), XEP-0490 (MDS).

## Context: what shipped in #1029 (this branch is stacked on it)

- Catch-up core `runCatchUpHistory` in `packages/fluux-sdk/src/core/modules/MAM.ts`: Phase A (forward from coverage edge, 3-page bail → fetch-latest); Phase B (background-only backward walk to the XEP-0490 read pointer). Phase B's fallback cursor comes from `probeCacheBottom` (the `io.probeCacheBottom` adapter, MAM.ts ~1129/1294, calls `loadMessagesFromCache({peek:true, oldest:true})`).
- Seam machinery in `packages/fluux-sdk/src/stores/shared/mamGap.ts`: `GapInterval {start, end, startId?, endId?}` — `end`/`endId` is the oldest held message ABOVE the hole (= the bottom of the contiguous-from-live region), `start`/`startId` the newest held BELOW it. `detectFetchLatestSeam(fetched, newMessagesCount, patchedCount, newestHeldBelowTs, newestHeldBelowId?)` forms a seam; both stores call it via `syncGapAfterArchiveMerge`.
- Seam-formation lower bound today: `chatStore.ts:1773` / `roomStore.ts` twin — `newestHeldBelowTs: messagePageExtent(rawExisting).newestTs ?? fallbackHeldTs`, where `fallbackHeldTs = getConversationLastTimestamp` (the persisted **preview** timestamp). The code comment at chatStore.ts:1770-1772 already flags the risk ("a non-archived preview (noLocalStore/tombstone) above the true archive newest could plant a spurious — click-healable — seam").
- Store getters wired via `packages/fluux-sdk/src/core/defaultStoreBindings.ts` (e.g. `getConversationGapStartId` at :98, `getRoomGapStartId` at :137). `GapInterval.endId` exists but has **no** exposed getter yet.
- Context/search fetches (`fetchContext`, MAM.ts:855; `getMessagesAround` path, MAM.ts:1464) already pass `preserveGapMarker: true` — so they never mutate the seam. But they DO write their messages to IndexedDB, which is exactly how a disjoint island lands in the cache and later poisons `probeCacheBottom`.

## Global Constraints

- Chat/room parity: every behavior change lands in BOTH twins via the shared modules (`mamGap.ts`, `runCatchUpHistory`) where they exist; store-specific pieces land in both `chatStore.ts` and `roomStore.ts`.
- Gate on `npm run test:scroll` (from the **repo root** — the script lives there, not in apps/fluux): message-loading change.
- Store-binding fan-out: a new `deps.stores` getter needs `defaultStoreBindings.ts` + its interface type in `packages/fluux-sdk/src/core/types/client.ts` + `createMockStores` in `test-utils.ts`; composite getters are NOT added to `storeBindingKeys.ts` arrays (that file's own convention — the lockstep test walks `Object.keys`, so only the mock must be present). Run root `npm run typecheck` after.
- Before any commit: `npx vitest run` in `packages/fluux-sdk` green with no new stderr; root `npm run typecheck`; root `npm run lint` (1 known pre-existing `useFocusTrap.ts` warning is acceptable).
- Never a Claude footer in commits; `--no-gpg-sign` if SSH signing is unavailable.
- All paths relative to the worktree root `.claude/worktrees/mam-coverage-followup`.

## The invariant this plan establishes

> **Contiguous coverage bottom** = the oldest archive position we hold that is *provably contiguous with the live edge*. It is: the recorded gap's upper edge (`endId`/`end`) when a gap exists; else the true cache bottom (no recorded discontinuity → everything held is contiguous). It is NEVER an island below a recorded gap, and NEVER a preview timestamp.

Phase B seeds its walk from this quantity (finding 9). Seam formation uses only proven boundaries, marking `coverageUnknown` rather than inventing one from a preview (finding 10).

---

### Task 1: Expose the contiguous-coverage-bottom getter

Add a store getter that returns the contiguous-from-live bottom cursor: the recorded gap's `endId` when a gap with an `endId` exists, else undefined (caller falls back to `probeCacheBottom`). This is the seam-aware replacement anchor for Phase B seeding.

**Files:**
- Modify: `packages/fluux-sdk/src/core/defaultStoreBindings.ts` (add `getConversationGapEndId` / `getRoomGapEndId`)
- Modify: `packages/fluux-sdk/src/core/types/client.ts` (binding interface types)
- Modify: `packages/fluux-sdk/src/core/test-utils.ts` (`createMockStores` — default `undefined`)
- Test: none for the getter itself (trivial map read); covered via Task 2's orchestrator tests.

**Interfaces:**
- Produces: `getConversationGapEndId(conversationId): string | undefined` and `getRoomGapEndId(roomJid): string | undefined` — `conversationGaps.get(id)?.endId` / `roomGaps.get(id)?.endId`, mirroring the existing `...GapStartId` getters at defaultStoreBindings.ts:98/137.

- [ ] **Step 1: Add the getters** mirroring `getConversationGapStartId` (defaultStoreBindings.ts:98) and `getRoomGapStartId` (:137):

```typescript
getConversationGapEndId: (conversationId: string) => chatStore.getState().conversationGaps.get(conversationId)?.endId,
```
```typescript
getRoomGapEndId: (roomJid: string) => roomStore.getState().roomGaps.get(roomJid)?.endId,
```

- [ ] **Step 2: Declare them on the bindings interface** in `types/client.ts` next to the `...GapStartId` declarations (same `(id: string) => string | undefined` shape).

- [ ] **Step 3: Add to `createMockStores`** in `test-utils.ts` next to `getConversationGapStartId`/`getRoomGapStartId`: `getConversationGapEndId: vi.fn().mockReturnValue(undefined)` and the room twin.

- [ ] **Step 4: Typecheck**

Run: `cd /Users/mremond/AIProjects/fluux-messenger/.claude/worktrees/mam-coverage-followup && npm run typecheck`
Expected: clean.

- [ ] **Step 5: Commit**

```bash
git add packages/fluux-sdk/src/core/defaultStoreBindings.ts packages/fluux-sdk/src/core/types/client.ts packages/fluux-sdk/src/core/test-utils.ts
git commit --no-gpg-sign -m "feat(mam): expose gap upper-edge id (contiguous coverage bottom) getter"
```

---

### Task 2: Seed Phase B from the contiguous coverage bottom, not the global cache bottom (finding 9)

When Phase B needs its fallback cursor (Phase A ended forward-complete, pointer still pending), prefer the recorded gap's upper edge (`endId`) — the proven bottom of the contiguous-from-live region — over `probeCacheBottom`'s global-oldest row. A disjoint search/context island below a recorded gap can no longer be chosen as the walk's starting point.

**Files:**
- Modify: `packages/fluux-sdk/src/core/modules/MAM.ts` (`runCatchUpHistory` cache-bottom-probe block ~1398; the `io` shape ~1319 and both adapters ~1129/1294)
- Test: `packages/fluux-sdk/src/core/modules/MAM.catchup.test.ts`

**Interfaces:**
- Consumes: `getConversationGapEndId` / `getRoomGapEndId` (Task 1).
- Produces: the `io` object gains `getGapEndId(): string | undefined`; `runCatchUpHistory`'s fallback-cursor logic becomes: `const seamBottom = io.getGapEndId(); windowBottom = seamBottom ?? oldestStanzaId(await io.probeCacheBottom())` (using the same oldest-with-stanzaId extraction the probe path already applies).

- [ ] **Step 1: Write the failing test**

In `MAM.catchup.test.ts`, in the `catchUpConversationHistory` describe, next to the existing cache-bottom-probe tests:

```typescript
    it('seeds Phase B from the recorded gap upper edge, ignoring a disjoint cache island below it', async () => {
      await connectClient()
      // Pointer pending; Phase A completes forward with nothing to bail on.
      vi.mocked(mockStores.chat.getConversationPendingStanzaId!).mockReturnValue('mds-ptr')
      vi.mocked(mockStores.chat.getConversationGapStart!).mockReturnValue(undefined)
      // A recorded gap whose upper edge is 'seam-top' — the contiguous bottom.
      vi.mocked(mockStores.chat.getConversationGapEndId!).mockReturnValue('seam-top')
      // A search island sits far below; probeCacheBottom would return it.
      vi.mocked(mockStores.chat.loadMessagesFromCache!).mockResolvedValue([
        { id: 'island-old', stanzaId: 'island-old', timestamp: new Date('2020-01-01T00:00:00Z') },
      ] as any)

      const calls: any[] = []
      vi.spyOn(xmppClient.mam, 'queryArchive').mockImplementation(async (opts: any) => {
        calls.push(opts)
        if (opts.start || opts.after) return { messages: [], complete: true, rsm: {} } // Phase A done
        return { messages: [], complete: false, rsm: { first: 'p1' } }
      })

      await xmppClient.mam.catchUpConversationHistory('alice@example.com',
        [{ timestamp: new Date('2026-06-01T12:00:00Z'), stanzaId: 'edge' }],
        { sessionStartTime: Date.now(), stitchReadPointer: true })

      const backward = calls.filter((c) => c.before !== undefined && c.before !== '')
      expect(backward[0]?.before).toBe('seam-top')       // seam edge, NOT 'island-old'
      expect(backward.some((c) => c.before === 'island-old')).toBe(false)
    })
```

Add the room twin (`catchUpRoomHistory`, `getRoomGapEndId`, `queryRoomArchive`).

- [ ] **Step 2: Run to verify failure**

Run: `cd packages/fluux-sdk && npx vitest run src/core/modules/MAM.catchup.test.ts -t 'disjoint cache island'`
Expected: FAIL — walk currently seeds from `island-old` (probeCacheBottom).

- [ ] **Step 3: Implement**

Add `getGapEndId` to the `io` interface (MAM.ts ~1319) and to both adapters (~1129/1294): `getGapEndId: () => this.deps.stores?.chat.getConversationGapEndId?.(conversationId)` and the room twin. In `runCatchUpHistory`'s cache-bottom-probe block (~1398), prefer the seam edge:

```typescript
      // Contiguous coverage bottom: a recorded gap's upper edge is the proven
      // bottom of the contiguous-from-live region. Seeding from it (not the
      // global-oldest cache row) keeps the backward walk inside the contiguous
      // region — a disjoint search/context island below a recorded gap can no
      // longer mis-seed the descent (finding 9).
      const seamBottom = io.getGapEndId()
      if (seamBottom) {
        windowBottom = seamBottom
      } else {
        const bottom = await io.probeCacheBottom()
        windowBottom = oldestStanzaId(bottom) // existing extraction
      }
```

(Match the exact existing extraction/guard already in that block — do not duplicate it; refactor minimally so both branches assign `windowBottom`.)

- [ ] **Step 4: Run tests**

Run: `cd packages/fluux-sdk && npx vitest run src/core/modules/MAM.catchup.test.ts`
Expected: PASS (new + existing).

- [ ] **Step 5: Commit**

```bash
git add packages/fluux-sdk/src/core/modules/MAM.ts packages/fluux-sdk/src/core/modules/MAM.catchup.test.ts
git commit --no-gpg-sign -m "fix(mam): seed Phase B from the contiguous coverage bottom, not a disjoint cache island"
```

---

### Task 3: Form seams only from proven MAM boundaries; mark coverage unknown otherwise (finding 10)

The seam lower bound must never come from a preview timestamp. When the pre-merge resident array is empty (background/non-active entity), there is no proven in-memory boundary — today the code falls back to `getConversationLastTimestamp` (the preview), which may be an unarchived message, planting a spurious seam. Fix: drop the preview fallback from seam formation; when no proven boundary exists, do not form a seam and record `coverageUnknown` instead, so the next fetch-latest with a real page can establish the true boundary.

**Files:**
- Modify: `packages/fluux-sdk/src/stores/shared/mamGap.ts` (`detectFetchLatestSeam` / `syncGapAfterArchiveMerge` input contract + a `coverageUnknown` signal)
- Modify: `packages/fluux-sdk/src/stores/chatStore.ts` (~1770-1774) and `packages/fluux-sdk/src/stores/roomStore.ts` (twin) — stop passing the preview timestamp as `newestHeldBelowTs`
- Test: `packages/fluux-sdk/src/stores/shared/mamGap.test.ts`, plus a store-level test in each store's suite

**Interfaces:**
- Produces: `detectFetchLatestSeam` unchanged in signature but its `newestHeldBelowTs` is now *only* a proven boundary (resident extent, never preview). A new tiny piece of state per entity — `coverageUnknown: Set<id>` or a `mamQueryStates` boolean `coverageBottomUnproven` — set true when a fetch-latest landed disjoint above held history but no proven lower boundary existed to anchor a seam; consumed by Task 2's seeder (when `coverageUnknown` is set and no gap endId exists, Phase B must NOT trust `probeCacheBottom`'s global oldest as contiguous — it should fetch-latest-forward again rather than descend, OR simply skip the descent until a real boundary is known). Keep it minimal: a boolean on the existing MAM query state is the lightest home.

- [ ] **Step 1: Write the failing tests**

`mamGap.test.ts` — a disjoint fetch-latest page with NO proven `newestHeldBelowTs` (undefined) must NOT form a seam (already true today: `detectFetchLatestSeam` returns undefined when `newestHeldBelowTs === undefined`, mamGap.ts:199). The behavioral change is at the STORE layer — the preview must no longer be substituted in. So the failing test lives in the store suite:

```typescript
// chatStore.test.ts
it('does not plant a seam from a preview timestamp when the resident array is empty (finding 10)', () => {
  // Persisted preview exists, but no resident messages and no proven archive boundary.
  seedConversationWithPreviewOnly('alice@example.com', { lastMessageTs: t_preview })
  // A fetch-latest page lands entirely above the preview ts.
  chatStore.getState().mergeMAMMessages('alice@example.com', [freshAbovePreview], {}, false, 'backward', /*isFetchLatest*/ true)
  // No spurious seam from the (possibly unarchived) preview.
  expect(chatStore.getState().conversationGaps.has('alice@example.com')).toBe(false)
  // Coverage is flagged unproven so the seeder won't treat cache-oldest as contiguous.
  expect(chatStore.getState().getMAMQueryState('alice@example.com').coverageBottomUnproven).toBe(true)
})
```

Room twin in `roomStore.test.ts`. Also add a POSITIVE test: with a proven resident boundary present, a disjoint fetch-latest still forms the seam as before (guard against over-suppression).

- [ ] **Step 2: Run to verify failure**

Run: `cd packages/fluux-sdk && npx vitest run src/stores/chatStore.test.ts -t 'preview timestamp'`
Expected: FAIL — a seam is currently planted from `fallbackHeldTs`.

- [ ] **Step 3: Implement**

- In `chatStore.ts` (~1773) and `roomStore.ts` twin: change `newestHeldBelowTs: messagePageExtent(rawExisting).newestTs ?? fallbackHeldTs` to `newestHeldBelowTs: messagePageExtent(rawExisting).newestTs` (drop the preview fallback). Remove the now-unused `fallbackHeldTs` seam usage (keep `getConversationLastTimestamp` — it is still used elsewhere, e.g. Phase A's preview-driven paths; verify with grep before deleting anything).
- Add `coverageBottomUnproven?: boolean` to the MAM query state (`mamState.ts` DEFAULT_MAM_STATE + type). Set it true in `syncGapAfterArchiveMerge` (or its caller) when: `isFetchLatest` && the page landed disjoint above held history (`detectFetchLatestSeam` inputs indicate disjoint) && `newestHeldBelowTs === undefined` (no proven boundary). Clear it whenever a proven boundary is later established (any merge with a non-empty resident extent, or a recorded gap gains an `endId`).
- In `runCatchUpHistory`'s seeder (Task 2): when `getGapEndId()` is undefined AND `coverageBottomUnproven` is set, do NOT descend from `probeCacheBottom`'s global oldest (it isn't provably contiguous) — leave `windowBottom` undefined so Phase B no-ops this pass; a later fetch-latest that establishes a real boundary lets the next pass proceed. Add a getter `getConversationCoverageUnproven`/`getRoomCoverageUnproven` (binding fan-out).

- [ ] **Step 4: Run tests**

Run: `cd packages/fluux-sdk && npx vitest run src/stores src/core/modules/MAM.catchup.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/fluux-sdk/src/stores packages/fluux-sdk/src/core
git commit --no-gpg-sign -m "fix(mam): form seams only from proven MAM boundaries; flag unproven coverage instead of trusting the preview timestamp"
```

---

### Task 4: Full verification

**Files:** none (verification only)

- [ ] **Step 1: SDK + app suites**

Run: `cd packages/fluux-sdk && npx vitest run` → PASS, no new stderr.
Run: `cd apps/fluux && npx vitest run` → PASS.

- [ ] **Step 2: Build + typecheck + lint** (from repo root): `npm run build:sdk && npm run typecheck && npm run lint` → clean; lint 0 errors (known `useFocusTrap.ts` warning only).

- [ ] **Step 3: Scroll e2e gate** (from repo root): `npm run test:scroll` → PASS (WebKit invariant-1 settle flake is known — retry once).

- [ ] **Step 4: Live verification checklist (manual, by maintainer)**
  1. Search-jump into deep history (creating a cache island), then reconnect on a conversation with a still-pending deep read pointer → Phase B XML shows the backward walk starting at the seam edge / contiguous bottom, never at the island's oldest id.
  2. A background conversation with only a persisted preview (never archived locally) receiving a fetch-latest → no spurious "Load missing messages" seam appears; the entity is flagged coverage-unproven until a real page lands.

---

## Self-Review Notes

- **Finding 9** — Tasks 1+2: contiguous bottom = gap `endId`; disjoint island below the gap is structurally excluded. Context/search fetches already `preserveGapMarker`, so they never move the gap edge — no change needed there; the fix is purely in *how Phase B chooses its seed*, which now reads the coverage fact (gap edge) instead of the cache fact (global oldest).
- **Finding 10** — Task 3: preview timestamp removed from seam formation; `coverageBottomUnproven` prevents the seeder from treating an unproven cache bottom as contiguous. This is the "mark coverageUnknown" the auditor asked for, scoped to the one decision it actually affects.
- **Open design choice for the implementer:** Task 3's `coverageBottomUnproven` could instead be derived on the fly (no persisted flag) by checking "resident extent empty AND no gap endId AND cache has rows" at seed time. If that read is cheap and race-free, prefer it over new persisted state (YAGNI). Decide during Task 3; if derived, Task 3 collapses to the store seam-fallback removal + the seeder guard, no new state/getter.
- **Not in scope (deferred, tracked separately):** Codex #7 (resume Phase B on entity deactivation); the reviewer's `noLocalStore`×gap-durability interaction and the best-effort-save caveat.
