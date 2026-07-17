# MAM Durable Coverage (Codex round 3) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the four Codex round-3 blocking issues: (1) coverage cursor persisted before the page write, (2) gap deletion not gated on IndexedDB write success, (3) contiguous-coverage bottom not positive/durable data, (4) the 5-page signal-only cap leaving an empty conversation with no durable resume.

**Architecture:** Three pillars. (a) `saveMessages`/`saveRoomMessages` return a commit boolean; every gap/coverage transition that *shrinks* the recorded hole (or advances coverage past data written by this merge) defers until that boolean is `true` — generalizing the existing `deferGapClear` pattern. (b) A new persisted per-entity `CoverageRecord { bottomId, topId? }` (shared pure module `mamCoverage.ts`, wired into both stores like `GapInterval`) is the positive, durable "contiguous-with-live bottom" — it survives fresh sessions and gap closure, and Phase B seeds from it. (c) The backward signal-only walk uses the record as a floor: when a page contains `topId`, the cursor jumps straight to `bottomId`, so successive sessions descend instead of re-walking the same newest pages; on give-up the record advances to the walk's deepest `rsm.first`.

**Tech Stack:** TypeScript, Zustand vanilla stores, Vitest, idb (IndexedDB), localStorage persistence.

## Global Constraints

- Worktree: `/Users/mremond/AIProjects/fluux-messenger/.claude/worktrees/awesome-yalow-2c1a44` — all paths below relative to it. Branch: `mr/mam-resync-blocking-issues-9b92d2` (already checked out).
- Run SDK tests from `packages/fluux-sdk` (`npx vitest run <file>`), NOT the repo root (vitest workspace scope).
- After any SDK type change, run `npm run build:sdk` at root before root `npm run typecheck`.
- Any change touching MAM merge/scroll machinery gates on `npm run test:scroll` at the REPO ROOT before the final commit.
- New store methods must be added to `packages/fluux-sdk/src/core/storeBindingKeys.ts` (fan-out contract, enforced by `core/storeBindingKeys.test.ts`).
- Commits: conventional style, no Claude footer. SSH signing may be unavailable — use `git commit --no-gpg-sign` (approved 2026-07-06).
- Never weaken the safety invariant: **a persisted cursor (gap `startId`/`endId`, coverage `bottomId`) must never point past data that is not durably stored.** A *lagging* cursor is acceptable (self-healing via dedupe); a *skipping* cursor is data loss.

---

### Task 1: Durable-commit signal from messageCache

**Files:**
- Modify: `packages/fluux-sdk/src/utils/messageCache.ts` (saveMessages ~line 319, saveRoomMessages ~line 749)
- Test: `packages/fluux-sdk/src/utils/messageCache.test.ts` (existing `describe('saveMessages')` ~line 161)

**Interfaces:**
- Produces: `saveMessages(messages: Message[]): Promise<boolean>` and `saveRoomMessages(messages: RoomMessage[]): Promise<boolean>` — `true` iff the IndexedDB transaction committed (`tx.done` resolved). Errors are still swallowed (warn + `false`), never thrown. Empty input returns `true` (nothing to commit = trivially durable).

- [ ] **Step 1: Write the failing tests** (append inside the existing `describe('saveMessages')` and the room twin describe):

```typescript
    it('resolves true when the transaction commits', async () => {
      await expect(messageCache.saveMessages([createTestMessage('c1', 'm1')])).resolves.toBe(true)
    })

    it('resolves true for an empty batch', async () => {
      await expect(messageCache.saveMessages([])).resolves.toBe(true)
    })

    it('resolves false when the transaction fails', async () => {
      // Force getDB to reject for this call.
      const spy = vi.spyOn(idb, 'openDB').mockRejectedValueOnce(new Error('quota'))
      await expect(messageCache.saveMessages([createTestMessage('c1', 'm2')])).resolves.toBe(false)
      spy.mockRestore()
    })
```

Adapt the failure-injection to whatever this test file already uses to simulate IndexedDB errors (it uses `fake-indexeddb` — check how existing error-path tests, e.g. around `isIndexedDBAvailable`, inject failure, and reuse that mechanism; if none exists, mock the module-level `getDB` seam the same way the file's other tests reach internals). Mirror the same three tests for `saveRoomMessages`.

- [ ] **Step 2: Run to verify failure**

Run: `cd packages/fluux-sdk && npx vitest run src/utils/messageCache.test.ts`
Expected: new tests FAIL (`resolves.toBe(true)` gets `undefined`).

- [ ] **Step 3: Implement**

```typescript
export async function saveMessages(messages: Message[]): Promise<boolean> {
  if (messages.length === 0) return true
  try {
    const db = await getDB(getStorageScopeJid())
    const tx = db.transaction(MESSAGES_STORE, 'readwrite')
    const store = tx.objectStore(MESSAGES_STORE)
    for (const msg of messages) {
      await putChatMessageGuarded(store, msg)
    }
    await tx.done
    return true
  } catch (error) {
    if (isIndexedDBAvailable()) {
      console.warn('Failed to save messages:', error)
    }
    return false
  }
}
```

Same shape for `saveRoomMessages` (return `true` after `tx.done`, `false` in catch, `true` for empty input). Update both functions' JSDoc: "Resolves `true` iff the transaction committed — callers advancing durable cursors must gate on it."

- [ ] **Step 4: Run tests**

Run: `cd packages/fluux-sdk && npx vitest run src/utils/messageCache.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/fluux-sdk/src/utils/messageCache.ts packages/fluux-sdk/src/utils/messageCache.test.ts
git commit --no-gpg-sign -m "fix(mam): saveMessages/saveRoomMessages report commit success (Codex r3 #2)"
```

---

### Task 2: chatStore — defer every existing-gap transition until durable commit

**Files:**
- Modify: `packages/fluux-sdk/src/stores/chatStore.ts` (mergeMAMMessages, lines ~1873–1927)
- Test: `packages/fluux-sdk/src/stores/chatStore.test.ts` (existing deferred-clearance tests ~lines 395–440, mock factory ~line 35)

**Interfaces:**
- Consumes: `saveMessages(): Promise<boolean>` from Task 1.
- Produces: the semantics later tasks build on — inside `mergeMAMMessages`, `prevGap` (captured entry), `deferGapCommit` (boolean), and a single deferred `set()` applying `newGaps.get(conversationId)` guarded by `s.conversationGaps.get(conversationId) === prevGap` and `committed === true`.

- [ ] **Step 1: Update existing test mocks for the boolean contract**

In `chatStore.test.ts`'s `vi.mock('../utils/messageCache', ...)` factory, ensure `saveMessages: vi.fn().mockResolvedValue(true)` (and reset to `mockResolvedValue(true)` in `beforeEach` if the file resets mocks). Update the held-promise tests: `let resolveSave!: (ok: boolean) => void`, `new Promise<boolean>((resolve) => { resolveSave = resolve })`, `resolveSave(true)`.

- [ ] **Step 2: Write the failing tests** (same describe block as the existing clearance tests):

```typescript
    it('forward ADVANCE of an existing gap is deferred until the page is durably cached', async () => {
      chatStore.getState().addConversation(createConversation(cid))
      chatStore.setState({ conversationGaps: new Map([[cid, {
        start: new Date('2026-07-06T00:00:00Z').getTime(),
        startId: 'old-cursor',
      }]]) })
      let resolveSave!: (ok: boolean) => void
      vi.mocked(messageCache.saveMessages).mockReturnValue(
        new Promise<boolean>((resolve) => { resolveSave = resolve })
      )
      const m = { ...createMessage(cid, 'fwd'), id: 'fwd', timestamp: new Date('2026-07-07T00:00:00Z') }
      // Incomplete forward page: gap start moves up and startId advances to rsm.last.
      chatStore.getState().mergeMAMMessages(cid, [m], { last: 'new-cursor' }, false, 'forward')

      // Advance must NOT be visible while the write is pending.
      expect(chatStore.getState().conversationGaps.get(cid)?.startId).toBe('old-cursor')
      await Promise.resolve()
      expect(chatStore.getState().conversationGaps.get(cid)?.startId).toBe('old-cursor')

      resolveSave(true)
      await vi.waitFor(() => {
        expect(chatStore.getState().conversationGaps.get(cid)?.startId).toBe('new-cursor')
      })
    })

    it('gap transition is dropped when the durable write reports failure', async () => {
      chatStore.getState().addConversation(createConversation(cid))
      chatStore.setState({ conversationGaps: new Map([[cid, {
        start: new Date('2026-07-06T00:00:00Z').getTime(),
        startId: 'old-cursor',
      }]]) })
      vi.mocked(messageCache.saveMessages).mockResolvedValue(false)
      const m = { ...createMessage(cid, 'fwd'), id: 'fwd', timestamp: new Date('2026-07-07T00:00:00Z') }
      chatStore.getState().mergeMAMMessages(cid, [m], { last: 'new-cursor' }, false, 'forward')
      await Promise.resolve(); await Promise.resolve()
      // Failed write → cursor must NOT advance past unstored data.
      expect(chatStore.getState().conversationGaps.get(cid)?.startId).toBe('old-cursor')
    })

    it('gap FORMATION applies immediately (conservative — records a hole)', () => {
      chatStore.getState().addConversation(createConversation(cid))
      let resolveSave!: (ok: boolean) => void
      vi.mocked(messageCache.saveMessages).mockReturnValue(
        new Promise<boolean>((resolve) => { resolveSave = resolve })
      )
      const m = { ...createMessage(cid, 'fwd'), id: 'fwd', timestamp: new Date('2026-07-07T00:00:00Z') }
      chatStore.getState().mergeMAMMessages(cid, [m], { last: 'c1' }, false, 'forward')
      // No pre-existing gap: the incomplete forward merge plants one NOW.
      expect(chatStore.getState().conversationGaps.has(cid)).toBe(true)
      resolveSave(true)
    })
```

(Adjust `createConversation`/`createMessage` helper names to the file's actual helpers.)

- [ ] **Step 3: Run to verify the new tests fail**

Run: `cd packages/fluux-sdk && npx vitest run src/stores/chatStore.test.ts -t 'ADVANCE'`
Expected: FAIL (advance currently applies synchronously).

- [ ] **Step 4: Implement** — in `mergeMAMMessages`, replace the `deferGapClear` block (lines ~1873–1890) with:

```typescript
          // Crash-window safety (Codex r3 #1/#2): the gap map is persisted
          // synchronously (localStorage) while saveMessages to IndexedDB is
          // fire-and-forget AND absorbs errors. Persisting a transition that
          // SHRINKS the recorded hole (deletion, forward startId advance,
          // backward end/endId shrink) before the page write commits lets a
          // crash — or a silently failed write — skip the page forever: the
          // resume cursor would point past data that was never stored. So ANY
          // transition of an EXISTING gap defers until the durable write
          // reports success. Formation (prevGap undefined) records a hole —
          // conservative — and applies immediately. A merge with nothing
          // persistable has no crash window and applies immediately.
          const prevGap = state.conversationGaps.get(conversationId)
          const persistableMessages = newMessages.filter(msg => !isNoLocalStore(msg))
          const deferGapCommit =
            newGaps !== state.conversationGaps &&
            prevGap !== undefined &&
            persistableMessages.length > 0
          const gapsAfterMerge = deferGapCommit ? state.conversationGaps : newGaps
```

and replace the `savePromise.then(...)` block (lines ~1908–1925) with:

```typescript
            const savePromise = messageCache.saveMessages(persistableMessages)
            if (deferGapCommit) {
              // The page is durably cached — now the transition is safe.
              void savePromise.then((committed) => {
                if (!committed) return
                set((s) => {
                  // State may have moved on (a later merge advanced or
                  // re-planted the gap): only transition the exact interval
                  // this merge computed from. Reference equality suffices —
                  // every gap transition (syncGap) creates a new object. A
                  // lost race leaves a LAGGING (conservative) cursor, never a
                  // skipping one.
                  if (s.conversationGaps.get(conversationId) !== prevGap) return s
                  const next = new Map(s.conversationGaps)
                  const target = newGaps.get(conversationId)
                  if (target) next.set(conversationId, target)
                  else next.delete(conversationId)
                  return { conversationGaps: next }
                })
              })
            } else {
              void savePromise
            }
```

Delete the now-unused `clearedGap`/`deferGapClear` names.

- [ ] **Step 5: Run the full store test file**

Run: `cd packages/fluux-sdk && npx vitest run src/stores/chatStore.test.ts`
Expected: PASS (including the pre-existing clearance tests, which are a subset of the new rule).

- [ ] **Step 6: Commit**

```bash
git add packages/fluux-sdk/src/stores/chatStore.ts packages/fluux-sdk/src/stores/chatStore.test.ts
git commit --no-gpg-sign -m "fix(mam): chat gap advance/shrink/clear commits only after durable page write (Codex r3 #1)"
```

---

### Task 3: roomStore — same deferral, twin implementation

**Files:**
- Modify: `packages/fluux-sdk/src/stores/roomStore.ts` (mergeRoomMAMMessages, lines ~2705–2766)
- Test: `packages/fluux-sdk/src/stores/roomStore.test.ts` (deferred test ~line 2317; mock factory at top)

**Interfaces:**
- Consumes: `saveRoomMessages(): Promise<boolean>`.
- Produces: identical semantics to Task 2 on `roomGaps`, plus `saveGapsToStorage(next)` inside the deferred apply (roomStore persists gaps manually, not via zustand persist).

- [ ] **Step 1: Update mocks + write the three twin tests** (advance-deferred / failure-dropped / formation-immediate) against `mergeRoomMAMMessages` and `roomGaps`, mirroring Task 2 Step 2 with the room helpers this file already uses.

- [ ] **Step 2: Run to verify failure**

Run: `cd packages/fluux-sdk && npx vitest run src/stores/roomStore.test.ts -t 'ADVANCE'`
Expected: FAIL.

- [ ] **Step 3: Implement** — same replacement as Task 2 Step 4 with `roomGaps`/`roomJid`/`newFromMAM`, keeping `if (gapsAfterMerge !== state.roomGaps) saveGapsToStorage(gapsAfterMerge)` for the immediate path, and calling `saveGapsToStorage(next)` inside the deferred `set()` (as the existing deferred-clear already does at line ~2758).

- [ ] **Step 4: Run tests**

Run: `cd packages/fluux-sdk && npx vitest run src/stores/roomStore.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/fluux-sdk/src/stores/roomStore.ts packages/fluux-sdk/src/stores/roomStore.test.ts
git commit --no-gpg-sign -m "fix(mam): room gap advance/shrink/clear commits only after durable page write (Codex r3 #1)"
```

---

### Task 4: Shared pure module `mamCoverage.ts`

**Files:**
- Create: `packages/fluux-sdk/src/stores/shared/mamCoverage.ts`
- Test: `packages/fluux-sdk/src/stores/shared/mamCoverage.test.ts`

**Interfaces:**
- Produces (consumed by Tasks 5–8):

```typescript
export interface CoverageRecord {
  /** Archive id of the OLDEST entry proven contiguous with the live edge. */
  bottomId: string
  /** Archive id of the NEWEST entry seen by the fetch-latest walk that
   *  established this record (page-1 rsm.last). Lets a later walk detect it
   *  re-entered covered territory and jump to bottomId. */
  topId?: string
}
export interface MergeArchiveExtras {
  /** The `before` cursor the query was started with ('' = fetch-latest). */
  initialBefore?: string
  /** rsm.last of the FIRST page of a backward walk (newest covered entry). */
  fetchLatestTopId?: string
}
export function serializeCoverage(map: Map<string, CoverageRecord>): string
export function deserializeCoverage(json: string): Map<string, CoverageRecord>
export interface ArchiveMergeCoverageInput {
  coverage: Map<string, CoverageRecord>
  id: string
  direction: 'backward' | 'forward'
  isFetchLatest: boolean
  preserveGapMarker: boolean
  /** rsm.first of the merge's LAST page (deepest entry seen, signals included). */
  rsmFirst?: string
  fetchLatestTopId?: string
  initialBefore?: string
  /** Any dedupe hit or archive-id backfill — proof the page connects to held history. */
  connectedToHeld: boolean
}
export function syncCoverageAfterArchiveMerge(input: ArchiveMergeCoverageInput): Map<string, CoverageRecord>
```

- [ ] **Step 1: Write the failing tests**

```typescript
import { describe, it, expect } from 'vitest'
import { syncCoverageAfterArchiveMerge, serializeCoverage, deserializeCoverage, type CoverageRecord } from './mamCoverage'

const base = (over: Partial<Parameters<typeof syncCoverageAfterArchiveMerge>[0]> = {}) => ({
  coverage: new Map<string, CoverageRecord>(),
  id: 'a@b',
  direction: 'backward' as const,
  isFetchLatest: true,
  preserveGapMarker: false,
  connectedToHeld: false,
  ...over,
})

describe('syncCoverageAfterArchiveMerge', () => {
  it('fetch-latest establishes the record from the walk extent', () => {
    const out = syncCoverageAfterArchiveMerge(base({ rsmFirst: 'deep', fetchLatestTopId: 'top' }))
    expect(out.get('a@b')).toEqual({ bottomId: 'deep', topId: 'top' })
  })

  it('signal-only give-up (zero messages, rsm.first set) still establishes the record', () => {
    // Codex r3 #4: the walked window IS proven contiguous coverage even with
    // zero displayable messages — this is the durable resume for the cap.
    const out = syncCoverageAfterArchiveMerge(base({ rsmFirst: 'page5-first', fetchLatestTopId: 'page1-last' }))
    expect(out.get('a@b')).toEqual({ bottomId: 'page5-first', topId: 'page1-last' })
  })

  it('disjoint fetch-latest REPLACES a stale record', () => {
    const coverage = new Map([['a@b', { bottomId: 'old-deep', topId: 'old-top' }]])
    const out = syncCoverageAfterArchiveMerge(base({ coverage, rsmFirst: 'new-deep', fetchLatestTopId: 'new-top' }))
    expect(out.get('a@b')).toEqual({ bottomId: 'new-deep', topId: 'new-top' })
  })

  it('connected fetch-latest keeps the deeper existing bottom, refreshes topId', () => {
    const coverage = new Map([['a@b', { bottomId: 'deep', topId: 'old-top' }]])
    const out = syncCoverageAfterArchiveMerge(base({ coverage, rsmFirst: 'shallow', fetchLatestTopId: 'new-top', connectedToHeld: true }))
    expect(out.get('a@b')).toEqual({ bottomId: 'deep', topId: 'new-top' })
  })

  it('plain backward page extends the bottom only when resumed exactly from it', () => {
    const coverage = new Map([['a@b', { bottomId: 'deep', topId: 'top' }]])
    const extended = syncCoverageAfterArchiveMerge(base({ coverage, isFetchLatest: false, initialBefore: 'deep', rsmFirst: 'deeper' }))
    expect(extended.get('a@b')).toEqual({ bottomId: 'deeper', topId: 'top' })
    const stray = syncCoverageAfterArchiveMerge(base({ coverage, isFetchLatest: false, initialBefore: 'elsewhere', rsmFirst: 'x' }))
    expect(stray).toBe(coverage) // copy-on-write no-op
  })

  it('never touches the record for preserveGapMarker (windowed) or forward merges', () => {
    const coverage = new Map([['a@b', { bottomId: 'deep' }]])
    expect(syncCoverageAfterArchiveMerge(base({ coverage, preserveGapMarker: true, rsmFirst: 'x' }))).toBe(coverage)
    expect(syncCoverageAfterArchiveMerge(base({ coverage, direction: 'forward', isFetchLatest: false, rsmFirst: 'x' }))).toBe(coverage)
  })

  it('empty fetch-latest with no rsm.first (empty archive) is a no-op', () => {
    const coverage = new Map<string, CoverageRecord>()
    expect(syncCoverageAfterArchiveMerge(base({}))).toBe(coverage.constructor === Map ? expect.anything() && syncCoverageAfterArchiveMerge(base({})) : undefined)
    // simpler: identity check
    const c2 = new Map<string, CoverageRecord>()
    expect(syncCoverageAfterArchiveMerge(base({ coverage: c2 }))).toBe(c2)
  })

  it('returns the same reference when the computed record is unchanged', () => {
    const coverage = new Map([['a@b', { bottomId: 'deep', topId: 'top' }]])
    expect(syncCoverageAfterArchiveMerge(base({ coverage, rsmFirst: 'deep', fetchLatestTopId: 'top' }))).toBe(coverage)
  })
})

describe('coverage (de)serialization', () => {
  it('round-trips', () => {
    const m = new Map([['a@b', { bottomId: 'x', topId: 'y' }]])
    expect(deserializeCoverage(serializeCoverage(m))).toEqual(m)
  })
  it('returns empty map on garbage', () => {
    expect(deserializeCoverage('nope').size).toBe(0)
  })
})
```

(Clean up the duplicated identity test — keep only the `c2` variant.)

- [ ] **Step 2: Run to verify failure**

Run: `cd packages/fluux-sdk && npx vitest run src/stores/shared/mamCoverage.test.ts`
Expected: FAIL (module missing).

- [ ] **Step 3: Implement**

```typescript
/**
 * Persisted contiguous-with-live coverage (Codex r3 #3/#4).
 *
 * A `CoverageRecord` is POSITIVE, DURABLE data: the archive id of the oldest
 * entry proven contiguous with the live edge for this device. Unlike a
 * `GapInterval` (which describes a hole and vanishes when the hole closes) or
 * `coverageBottomUnproven` (session-scoped), the record survives fresh
 * sessions and gap closure, so:
 * - Phase B (read-pointer stitch) seeds its backward walk from it and never
 *   from a disjoint cache island (e.g. a fetchContext window);
 * - a signal-only fetch-latest walk resumes BELOW prior coverage instead of
 *   re-walking the same newest pages every session (`topId` marks re-entry
 *   into covered territory; the walk jumps to `bottomId`).
 *
 * Advancing `bottomId` past a page that carries persistable messages must be
 * gated on the durable IndexedDB commit of that page (same invariant as gap
 * transitions): the record must never point past data that was never stored.
 *
 * @module Stores/Shared/MamCoverage
 */

export interface CoverageRecord {
  /** Archive id of the OLDEST entry proven contiguous with the live edge. */
  bottomId: string
  /** Archive id of the NEWEST entry seen by the fetch-latest walk that
   *  established this record (page-1 rsm.last). */
  topId?: string
}

/** Extra merge inputs carried on the mam-messages emit (both entity kinds). */
export interface MergeArchiveExtras {
  /** The `before` cursor the query was started with ('' = fetch-latest). */
  initialBefore?: string
  /** rsm.last of the FIRST page of a backward walk (newest covered entry). */
  fetchLatestTopId?: string
}

export function serializeCoverage(map: Map<string, CoverageRecord>): string {
  return JSON.stringify(Array.from(map.entries()))
}

export function deserializeCoverage(json: string): Map<string, CoverageRecord> {
  try {
    const entries = JSON.parse(json) as [string, CoverageRecord][]
    return new Map(entries.filter(([, r]) => typeof r?.bottomId === 'string'))
  } catch {
    return new Map()
  }
}

export interface ArchiveMergeCoverageInput {
  coverage: Map<string, CoverageRecord>
  id: string
  direction: 'backward' | 'forward'
  isFetchLatest: boolean
  preserveGapMarker: boolean
  /** rsm.first of the merge's LAST page (deepest entry seen, signals included). */
  rsmFirst?: string
  fetchLatestTopId?: string
  initialBefore?: string
  /** Any dedupe hit or archive-id backfill — proof the page connects to held history. */
  connectedToHeld: boolean
}

/**
 * Pure coverage transition, called from both stores' archive merges.
 *
 * - fetch-latest, connected to held history, record exists → the deeper
 *   existing bottom stands; only the walk top refreshes;
 * - fetch-latest otherwise (disjoint or first-ever, INCLUDING a signal-only
 *   give-up with zero displayable messages) → replace with the walk extent;
 * - plain backward page → extend the bottom ONLY when the query resumed
 *   id-exactly from it (initialBefore === bottomId);
 * - forward merges and preserveGapMarker (bounded windowed) queries prove
 *   nothing about the live-contiguous bottom → no-op.
 *
 * Copy-on-write: returns the SAME map reference when nothing changes.
 */
export function syncCoverageAfterArchiveMerge(input: ArchiveMergeCoverageInput): Map<string, CoverageRecord> {
  const { coverage, id, direction, isFetchLatest, preserveGapMarker, rsmFirst, fetchLatestTopId, initialBefore, connectedToHeld } = input
  if (preserveGapMarker) return coverage
  if (direction !== 'backward') return coverage
  const existing = coverage.get(id)

  if (isFetchLatest) {
    if (!rsmFirst) return coverage
    if (connectedToHeld && existing) {
      if (fetchLatestTopId && fetchLatestTopId !== existing.topId) {
        const next = new Map(coverage)
        next.set(id, { ...existing, topId: fetchLatestTopId })
        return next
      }
      return coverage
    }
    if (existing && existing.bottomId === rsmFirst && existing.topId === fetchLatestTopId) return coverage
    const next = new Map(coverage)
    next.set(id, { bottomId: rsmFirst, ...(fetchLatestTopId ? { topId: fetchLatestTopId } : {}) })
    return next
  }

  if (existing && rsmFirst && initialBefore === existing.bottomId && rsmFirst !== existing.bottomId) {
    const next = new Map(coverage)
    next.set(id, { ...existing, bottomId: rsmFirst })
    return next
  }
  return coverage
}
```

- [ ] **Step 4: Run tests**

Run: `cd packages/fluux-sdk && npx vitest run src/stores/shared/mamCoverage.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/fluux-sdk/src/stores/shared/mamCoverage.ts packages/fluux-sdk/src/stores/shared/mamCoverage.test.ts
git commit --no-gpg-sign -m "feat(mam): shared persisted contiguous-coverage record + pure transition (Codex r3 #3)"
```

---

### Task 5: chatStore — wire the coverage record

**Files:**
- Modify: `packages/fluux-sdk/src/stores/chatStore.ts`
- Test: `packages/fluux-sdk/src/stores/chatStore.test.ts`

**Interfaces:**
- Consumes: Task 4's module; Task 2's `deferGapCommit` machinery.
- Produces (store API used by Tasks 7–8):
  - state: `conversationCoverage: Map<string, CoverageRecord>` (persisted)
  - method: `getConversationCoverage(conversationId: string): CoverageRecord | undefined`
  - method: `clearConversationCoverage(conversationId: string, ifBottomId?: string): void` — deletes the record; when `ifBottomId` is given, only if it matches `bottomId` (purge-event guard)
  - `mergeMAMMessages(..., preserveGapMarker = false, extras?: MergeArchiveExtras)` — new trailing optional param

- [ ] **Step 1: Write the failing tests**

```typescript
  describe('conversationCoverage (persisted contiguous-with-live bottom)', () => {
    it('fetch-latest establishes the record and it survives resetMAMStates (fresh session)', async () => {
      chatStore.getState().addConversation(createConversation(cid))
      const m = { ...createMessage(cid, 'm1'), id: 'm1', stanzaId: 'sid-1', timestamp: new Date('2026-07-15T00:00:00Z') }
      chatStore.getState().mergeMAMMessages(cid, [m], { first: 'sid-1', last: 'sid-1' }, false, 'backward', true, false,
        { initialBefore: '', fetchLatestTopId: 'sid-1' })
      await vi.waitFor(() => {
        expect(chatStore.getState().getConversationCoverage(cid)).toEqual({ bottomId: 'sid-1', topId: 'sid-1' })
      })
      chatStore.getState().resetMAMStates()
      expect(chatStore.getState().getConversationCoverage(cid)).toEqual({ bottomId: 'sid-1', topId: 'sid-1' })
    })

    it('signal-only give-up (zero messages) records coverage immediately (nothing to persist)', () => {
      chatStore.getState().addConversation(createConversation(cid))
      chatStore.getState().mergeMAMMessages(cid, [], { first: 'p5-first', last: 'p5-last' }, false, 'backward', true, false,
        { initialBefore: '', fetchLatestTopId: 'p1-last' })
      expect(chatStore.getState().getConversationCoverage(cid)).toEqual({ bottomId: 'p5-first', topId: 'p1-last' })
    })

    it('bottom advance with persistable messages defers until the durable write commits, and drops on failure', async () => {
      chatStore.getState().addConversation(createConversation(cid))
      chatStore.setState({ conversationCoverage: new Map([[cid, { bottomId: 'deep', topId: 'top' }]]) })
      let resolveSave!: (ok: boolean) => void
      vi.mocked(messageCache.saveMessages).mockReturnValue(new Promise<boolean>((r) => { resolveSave = r }))
      const older = { ...createMessage(cid, 'old'), id: 'old', stanzaId: 'deeper', timestamp: new Date('2026-07-01T00:00:00Z') }
      chatStore.getState().mergeMAMMessages(cid, [older], { first: 'deeper' }, false, 'backward', false, false,
        { initialBefore: 'deep' })
      expect(chatStore.getState().getConversationCoverage(cid)?.bottomId).toBe('deep')
      resolveSave(true)
      await vi.waitFor(() => {
        expect(chatStore.getState().getConversationCoverage(cid)?.bottomId).toBe('deeper')
      })
    })

    it('clearConversationCoverage with ifBottomId only clears a matching record', () => {
      chatStore.setState({ conversationCoverage: new Map([[cid, { bottomId: 'x' }]]) })
      chatStore.getState().clearConversationCoverage(cid, 'other')
      expect(chatStore.getState().getConversationCoverage(cid)).toBeDefined()
      chatStore.getState().clearConversationCoverage(cid, 'x')
      expect(chatStore.getState().getConversationCoverage(cid)).toBeUndefined()
    })
  })
```

Add a persistence round-trip test in the block that already tests `conversationGaps` serialization (search `serializeState` usage in the test file; if none exists, assert via `localStorage` after a merge, matching how gap persistence is asserted).

- [ ] **Step 2: Run to verify failure**

Run: `cd packages/fluux-sdk && npx vitest run src/stores/chatStore.test.ts -t 'conversationCoverage'`
Expected: FAIL.

- [ ] **Step 3: Implement**

1. State: add `conversationCoverage: Map<string, CoverageRecord>` to `ChatState` (next to `conversationGaps`, line ~196) and to `createEmptyChatState()` (`new Map()`).
2. Persistence: add `conversationCoverage?: [string, CoverageRecord][]` to `PersistedState` (~line 401); serialize in `serializeState` (~419), restore in `deserializeState` (~529); add `'conversationCoverage'` to the `Pick<...>` unions of `serializeState`, `deserializeState`, `createEmptyChatState`, `migrateLegacyConversationListsToScoped`, `loadScopedChatState`; add to `partialize` (~2332). Import `CoverageRecord, MergeArchiveExtras, syncCoverageAfterArchiveMerge` from `./shared/mamCoverage`.
3. Methods (near the gap accessors):

```typescript
      getConversationCoverage: (conversationId) => get().conversationCoverage.get(conversationId),
      clearConversationCoverage: (conversationId, ifBottomId) => {
        set((state) => {
          const existing = state.conversationCoverage.get(conversationId)
          if (!existing) return state
          if (ifBottomId !== undefined && existing.bottomId !== ifBottomId) return state
          const next = new Map(state.conversationCoverage)
          next.delete(conversationId)
          return { conversationCoverage: next }
        })
      },
```

4. Merge wiring — in `mergeMAMMessages` (signature gains `extras?: MergeArchiveExtras`), right after the gap block from Task 2:

```typescript
          // Persisted coverage record (Codex r3 #3/#4) — positive durable
          // twin of the gap machinery; see mamCoverage.ts. Advancing the
          // bottom past a page with persistable messages must wait for the
          // durable commit: the record must never point past unstored data.
          const newCoverage = syncCoverageAfterArchiveMerge({
            coverage: state.conversationCoverage,
            id: conversationId,
            direction,
            isFetchLatest,
            preserveGapMarker,
            rsmFirst: rsm.first,
            fetchLatestTopId: extras?.fetchLatestTopId,
            initialBefore: extras?.initialBefore,
            connectedToHeld: newMessages.length < mamMessages.length || patched.length > 0,
          })
          const prevCoverage = state.conversationCoverage.get(conversationId)
          const deferCoverageCommit =
            newCoverage !== state.conversationCoverage &&
            persistableMessages.length > 0
          const coverageAfterMerge = deferCoverageCommit ? state.conversationCoverage : newCoverage
```

Add `conversationCoverage: coverageAfterMerge` to ALL THREE return objects of the `set()` (the two early returns at ~1899/1903 and the final one). Extend the deferred `.then()` from Task 2 to fire when `deferGapCommit || deferCoverageCommit` and apply both under their own reference guards:

```typescript
                set((s) => {
                  const out: Partial<ChatState> = {}
                  if (deferGapCommit && s.conversationGaps.get(conversationId) === prevGap) {
                    const next = new Map(s.conversationGaps)
                    const target = newGaps.get(conversationId)
                    if (target) next.set(conversationId, target)
                    else next.delete(conversationId)
                    out.conversationGaps = next
                  }
                  if (deferCoverageCommit && s.conversationCoverage.get(conversationId) === prevCoverage) {
                    const target = newCoverage.get(conversationId)
                    if (target) {
                      const next = new Map(s.conversationCoverage)
                      next.set(conversationId, target)
                      out.conversationCoverage = next
                    }
                  }
                  return Object.keys(out).length > 0 ? out : s
                })
```

5. Confirm `resetMAMStates` only touches `mamQueryStates` (it must NOT clear `conversationCoverage`).

- [ ] **Step 4: Run tests, then the two other chatStore suites that exercise merges**

Run: `cd packages/fluux-sdk && npx vitest run src/stores/chatStore.test.ts src/stores/chatStore.mds.test.ts src/stores/chatStore.resyncDivider.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/fluux-sdk/src/stores/chatStore.ts packages/fluux-sdk/src/stores/chatStore.test.ts
git commit --no-gpg-sign -m "feat(mam): persisted conversation coverage record in chatStore (Codex r3 #3)"
```

---

### Task 6: roomStore — wire the coverage record (twin)

**Files:**
- Modify: `packages/fluux-sdk/src/stores/roomStore.ts`
- Test: `packages/fluux-sdk/src/stores/roomStore.test.ts`

**Interfaces:**
- Produces: `roomCoverage: Map<string, CoverageRecord>`; `getRoomCoverage(roomJid)`; `clearRoomCoverage(roomJid, ifBottomId?)`; `mergeRoomMAMMessages(..., extras?: MergeArchiveExtras)`. Persisted in localStorage under `'fluux-room-coverage'` (scoped via `buildScopedStorageKey`, twin of `ROOM_GAPS_STORAGE_KEY_BASE` at line ~171).

- [ ] **Step 1: Write the failing tests** — the four tests of Task 5 Step 1 transposed (`mergeRoomMAMMessages`, `getRoomCoverage`, `resetRoomMAMStates` survival, `saveRoomMessages` mock).

- [ ] **Step 2: Run to verify failure**

Run: `cd packages/fluux-sdk && npx vitest run src/stores/roomStore.test.ts -t 'roomCoverage'`

- [ ] **Step 3: Implement** — mirror Task 5: `ROOM_COVERAGE_STORAGE_KEY_BASE = 'fluux-room-coverage'`, `loadCoverageFromStorage(jid?)` / `saveCoverageToStorage(map, jid?)` (twins of the gap helpers at lines ~171–190, using `serializeCoverage`/`deserializeCoverage`); load in `createEmptyRoomState(...)` boot call (line ~721) and in the account-switch reload (line ~1176); persist with `saveCoverageToStorage` wherever `roomCoverage` changes (immediate path + deferred apply + clear). Merge wiring identical to Task 5 Step 3.4 with `newFromMAM`/`mamMessages`/`patched` and the three `set()` returns of `mergeRoomMAMMessages` (lines ~2731/2740 and the final one). `resetRoomMAMStates` must not clear it.

- [ ] **Step 4: Run tests**

Run: `cd packages/fluux-sdk && npx vitest run src/stores/roomStore.test.ts src/stores/roomStore.mds.test.ts src/stores/roomStore.resyncDivider.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/fluux-sdk/src/stores/roomStore.ts packages/fluux-sdk/src/stores/roomStore.test.ts
git commit --no-gpg-sign -m "feat(mam): persisted room coverage record in roomStore (Codex r3 #3)"
```

---

### Task 7: SDK plumbing — events, bindings, Phase B seeding

**Files:**
- Modify: `packages/fluux-sdk/src/core/types/sdk-events.ts` (`chat:mam-messages`, `room:mam-messages` payloads; new purge events)
- Modify: `packages/fluux-sdk/src/bindings/storeBindings.ts` (lines ~276, ~283, ~444, ~450)
- Modify: `packages/fluux-sdk/src/core/defaultStoreBindings.ts` (~lines 97–100 and 138–141) + the `StoreBindings` interface it implements (find with `grep -rn "getConversationGapEndId" packages/fluux-sdk/src` — every file listing that key gets the new keys)
- Modify: `packages/fluux-sdk/src/core/storeBindingKeys.ts` (add the new store methods)
- Modify: `packages/fluux-sdk/src/core/modules/MAM.ts` (emits at ~360 and ~592; `runCatchUpHistory` io + seed at ~1319/~1397; both adapters that build `io`)
- Modify: `packages/fluux-sdk/src/core/test-utils.ts` (mockStores: add `getConversationCoverage`, `clearConversationCoverage`, `getRoomCoverage`, `clearRoomCoverage` as `vi.fn()`)
- Test: `packages/fluux-sdk/src/core/modules/Chat.mam.test.ts` (Phase B seeding block — search `getConversationGapEndId` / `seamBottom` describe)

**Interfaces:**
- Consumes: store APIs from Tasks 5–6.
- Produces:
  - `chat:mam-messages` payload gains `initialBefore?: string`, `fetchLatestTopId?: string`; `room:mam-messages` likewise.
  - New SDK events: `'chat:mam-coverage-purged': { conversationId: string; before: string }` and `'room:mam-coverage-purged': { roomJid: string; before: string }`.
  - Bindings getters: `getConversationCoverage(conversationId): CoverageRecord | undefined`, `getRoomCoverage(roomJid): CoverageRecord | undefined`.
  - `runCatchUpHistory` io gains `getCoverageBottomId: () => string | undefined`.

- [ ] **Step 1: Write the failing test** — in the Phase B seeding describe of `Chat.mam.test.ts`, add:

```typescript
    it('Phase B seeds the backward walk from the persisted coverage record when no gap endId exists', async () => {
      // Arrange like the existing 'seeds from gap endId' test, but:
      vi.mocked(mockStores.chat.getConversationGapEndId).mockReturnValue(undefined)
      vi.mocked(mockStores.chat.getConversationCoverage).mockReturnValue({ bottomId: 'coverage-bottom' })
      // ... run catchUpConversationHistory with a pending pointer and a
      // forward-complete Phase A (windowBottom unset), then assert the first
      // Phase B query uses before: 'coverage-bottom' (inspect the sent IQ's
      // RSM <before> exactly as the neighbouring seeding tests do).
    })
```

Fill the arrange/assert scaffolding by copying the adjacent "seeds from gap endId"/"probe" tests in that describe verbatim and swapping the mocks + expected cursor.

- [ ] **Step 2: Run to verify failure**

Run: `cd packages/fluux-sdk && npx vitest run src/core/modules/Chat.mam.test.ts -t 'coverage record'`
Expected: FAIL (`getConversationCoverage` not called / seed falls through to probe).

- [ ] **Step 3: Implement**

1. `sdk-events.ts`: extend both mam-messages payloads with the two optional fields; declare the two purge events next to `chat:mam-anchor-purged` / `room:mam-anchor-purged`.
2. `MAM.ts` emits: in `queryArchive`'s single emit (~360) add `initialBefore: isForwardPaginate ? undefined : before` and `fetchLatestTopId` (a `let` captured as `rsm.last` when `page === 0 && !isForwardPaginate`). In `queryRoomArchive`'s backward emit (~592) add `initialBefore: before` and the same page-0 capture.
3. `storeBindings.ts`: pass the two new fields through to `mergeMAMMessages(...)` / `mergeRoomMAMMessages(...)` as the `extras` arg; add handlers:

```typescript
  on('chat:mam-coverage-purged', ({ conversationId, before }) => {
    stores.chat.clearConversationCoverage(conversationId, before)
  })
  // Room twin.
  on('room:mam-coverage-purged', ({ roomJid, before }) => {
    stores.room.clearRoomCoverage(roomJid, before)
  })
```

4. `defaultStoreBindings.ts` + `StoreBindings` interface: add `getConversationCoverage` (next to line 100) and `getRoomCoverage` (next to line 141) delegating to the store getters; add `clearConversationCoverage`/`clearRoomCoverage` if the interface carries the merge/clear methods (follow how `clearConversationGap`-style methods are declared — mirror exactly what `storeBindings.ts` consumes).
5. `storeBindingKeys.ts`: add every new store method name; run `npx vitest run src/core/storeBindingKeys.test.ts` to confirm the contract.
6. `runCatchUpHistory`: add `getCoverageBottomId: () => string | undefined` to the `io` type; change the seed (line ~1403):

```typescript
      // Contiguous coverage bottom: prefer the recorded gap's proven upper
      // edge, else the persisted coverage record (survives fresh sessions and
      // gap closure — Codex r3 #3); only when NEITHER exists fall back to the
      // cache-bottom probe, still gated on the unproven flag.
      const seamBottom = io.getGapEndId() ?? io.getCoverageBottomId()
```

Wire both adapters: chat adapter `getCoverageBottomId: () => this.deps.stores?.chat.getConversationCoverage?.(conversationId)?.bottomId`, room adapter twin.
7. `test-utils.ts` mockStores: add the four new fns (`vi.fn()`; getters default `mockReturnValue(undefined)`).

- [ ] **Step 4: Run the MAM + bindings suites**

Run: `cd packages/fluux-sdk && npx vitest run src/core/modules/Chat.mam.test.ts src/core/storeBindingKeys.test.ts src/bindings 2>/dev/null || npx vitest run src/core/modules/Chat.mam.test.ts src/core/storeBindingKeys.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/fluux-sdk/src/core/types/sdk-events.ts packages/fluux-sdk/src/bindings/storeBindings.ts packages/fluux-sdk/src/core/defaultStoreBindings.ts packages/fluux-sdk/src/core/storeBindingKeys.ts packages/fluux-sdk/src/core/modules/MAM.ts packages/fluux-sdk/src/core/test-utils.ts packages/fluux-sdk/src/core/modules/Chat.mam.test.ts
git commit --no-gpg-sign -m "feat(mam): coverage record plumbing — events, bindings, Phase B seeds from persisted bottom (Codex r3 #3)"
```

---

### Task 8: Signal-only walk — coverage floor jump + purged-anchor degrade

**Files:**
- Modify: `packages/fluux-sdk/src/core/modules/MAM.ts` (`queryArchive` backward loop ~325–345 and catch ~278–295; `queryRoomArchive` backward loop ~555–574 and catch ~487–500)
- Test: `packages/fluux-sdk/src/core/modules/Chat.mam.test.ts` (signal-only cap tests around line 3405)

**Interfaces:**
- Consumes: bindings getters from Task 7, purge events from Task 7.
- Produces: behavior only (no new API).

- [ ] **Step 1: Write the failing tests** (next to the existing cap tests; reuse their stanza-listener + iqCaller mock scaffolding):

```typescript
    it('backward walk jumps to the persisted coverage floor once a page contains its topId', async () => {
      // Coverage record from a previous session's give-up.
      vi.mocked(mockStores.chat.getConversationCoverage).mockReturnValue({ bottomId: 'old-deep', topId: 'known-top' })
      // Page 1 (before:''): signal-only, CONTAINS entry id 'known-top'.
      // Expected: page 2's RSM <before> is 'old-deep' (the jump), NOT page 1's rsm.first.
      // Build two iqCaller responses exactly like the cap test at ~3405 does,
      // giving page 1 an entry with archive id 'known-top' and rsm
      // {first: 'p1-first', last: 'known-top'}; page 2 carries a real message.
      // Assert on the second captured IQ: set/before === 'old-deep'.
    })

    it('signal-only give-up emits the walk extent so the store records coverage', async () => {
      // Run the existing 5-page all-signal scenario (1:1 twin of ~3405) and
      // assert the single chat:mam-messages emit carries
      // { initialBefore: '', fetchLatestTopId: 'archive-id-of-page-1-last' }.
    })

    it('purged before-anchor equal to the coverage bottom degrades to fetch-latest and emits coverage-purged', async () => {
      vi.mocked(mockStores.chat.getConversationCoverage).mockReturnValue({ bottomId: 'purged-id' })
      // First IQ (before: 'purged-id') rejects with an item-not-found error
      // (reuse the error shape from the existing after-anchor degrade test);
      // second IQ (before:'') resolves with one message.
      // Assert: result.degradedToFetchLatest === true AND emitSDK was called
      // with 'chat:mam-coverage-purged', { conversationId, before: 'purged-id' }.
    })
```

Flesh out each with the concrete `createMockElement` scaffolding copied from the neighbouring tests (the after-anchor degrade test and the ~3405 cap test contain every mock shape needed).

- [ ] **Step 2: Run to verify failure**

Run: `cd packages/fluux-sdk && npx vitest run src/core/modules/Chat.mam.test.ts -t 'floor'`
Expected: FAIL.

- [ ] **Step 3: Implement in `queryArchive`**

Before the page loop:

```typescript
    // Persisted coverage record (Codex r3 #4): floor for the signal-only walk
    // and purge-detection anchor for a coverage-seeded before-cursor.
    const coverageRecord = !isForwardPaginate
      ? this.deps.stores?.chat.getConversationCoverage?.(conversationId)
      : undefined
    let jumpedToFloor = false
```

In the backward `else` branch (currently `if (rsm.first) { currentBefore = rsm.first ... }`):

```typescript
            if (rsm.first) {
              // Once this walk re-enters previously-covered territory (the
              // page contains the record's top entry), everything down to the
              // record's bottom is already proven signal-only — jump the
              // cursor straight there so successive sessions descend instead
              // of re-walking the same newest pages (Codex r3 #4).
              if (coverageRecord?.topId && !jumpedToFloor &&
                  rawEntries.some((e) => e.archiveId === coverageRecord.topId)) {
                currentBefore = coverageRecord.bottomId
                jumpedToFloor = true
              } else {
                currentBefore = rsm.first
              }
              this.deps.emitSDK('console:event', {
                message: `Page ${page + 1} had no displayable messages, fetching older...`,
                category: 'sm',
              })
            } else {
              break
            }
```

In the `sendIQ` catch (after the existing `after`-purge branch):

```typescript
            if (page === 0 && !after && currentBefore && currentBefore === coverageRecord?.bottomId && isItemNotFoundError(iqError)) {
              // The coverage-seeded before-anchor was purged from the archive:
              // drop the stale record (the degrade site is the only place that
              // KNOWS the id is gone) and degrade to fetch-latest.
              logInfo(`MAM before-cursor purged for ...@${getDomain(conversationId) || '*'} — degrading to fetch-latest`)
              this.deps.emitSDK('chat:mam-coverage-purged', { conversationId, before: currentBefore })
              const degraded = await this.queryArchive({ with: withJid, max, before: '', preserveGapMarker })
              return { ...degraded, degradedToFetchLatest: true }
            }
```

- [ ] **Step 4: Twin the three changes in `queryRoomArchive`** (`stores?.room.getRoomCoverage?.(roomJid)`, backward branch at ~564, catch at ~487, emit `'room:mam-coverage-purged'` with `{ roomJid, before: currentBefore }`).

- [ ] **Step 5: Run the full MAM suites**

Run: `cd packages/fluux-sdk && npx vitest run src/core/modules/Chat.mam.test.ts`
Expected: PASS, including the untouched cap test at ~3405 (its `toMatchObject` assertions tolerate the added emit fields).

- [ ] **Step 6: Commit**

```bash
git add packages/fluux-sdk/src/core/modules/MAM.ts packages/fluux-sdk/src/core/modules/Chat.mam.test.ts
git commit --no-gpg-sign -m "fix(mam): signal-only walk resumes below persisted coverage; purged floor degrades cleanly (Codex r3 #4)"
```

---

### Task 9: Full verification & PR

**Files:** none new.

- [ ] **Step 1: SDK build + full SDK tests**

Run (from repo root): `npm run build:sdk && cd packages/fluux-sdk && npx vitest run`
Expected: all pass, no stderr noise.

- [ ] **Step 2: Root typecheck + lint + app tests**

Run (from root): `npm run typecheck && npm run lint --if-present && npm test`
Expected: clean. (If the app's `test-setup.ts` SDK mock breaks on new exports, add the new symbols there via the `importOriginal` spread pattern.)

- [ ] **Step 3: Scroll invariants gate**

Run (from repo ROOT): `npm run test:scroll`
Expected: pass (merge-path changes gate on this).

- [ ] **Step 4: Push and open the PR**

```bash
git push -u origin mr/mam-resync-blocking-issues-9b92d2
gh pr create --title "fix(mam): durable coverage commits + persisted contiguous-coverage record (Codex r3)" --body "$(cat <<'EOF'
Fixes the four Codex round-3 blocking issues on the MAM resync work:

- Gap transitions that shrink the recorded hole (forward startId advance, backward endId shrink, deletion) now commit only after the page's IndexedDB write reports success; saveMessages/saveRoomMessages return a commit boolean instead of silently absorbing failures.
- New persisted per-entity CoverageRecord (bottomId/topId) — positive, durable contiguous-with-live coverage that survives fresh sessions and gap closure. Phase B seeds from it instead of the global cache-oldest, so disjoint fetchContext islands can no longer mis-seed the walk.
- The 5-page signal-only backward walk records its extent as coverage and later walks jump below it (topId re-entry → bottomId), so an all-signal newest region converges across sessions instead of re-walking the same pages. A purged coverage anchor degrades to fetch-latest and clears the stale record.
EOF
)"
```

Expected: PR created against `main`.

---

## Self-review notes (already applied)

- Finding 1 covers BOTH the forward `rsm.last` advance Codex cited and the backward `endId` shrink (same crash class), via the single "any existing-gap transition defers" rule; formation stays immediate (conservative).
- Finding 2's boolean gates gap AND coverage deferred applies.
- Finding 3: record survives `resetMAMStates` (Task 5 test), is persisted (partialize / `fluux-room-coverage`), never touched by `preserveGapMarker` merges (fetchContext islands — Task 4 test), survives gap closure (record independent of `conversationGaps`).
- Finding 4: give-up records the walk extent immediately (nothing persistable → no crash window), floor jump converges across sessions, `selectCatchUpQuery` unchanged.
- Known accepted limitations (document in PR if reviewers ask): a lost deferred-apply race leaves a lagging cursor (self-healing via dedupe, never skipping); replacement of a deeper record by a >5-pages-of-new-traffic walk orphans old coverage (pathological volume, still sound); signal-only pages with zero persistable messages advance cursors immediately (their modifications persist via separate cache-update paths).
