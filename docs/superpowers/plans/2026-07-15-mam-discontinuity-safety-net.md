# MAM Discontinuity Safety Net Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Record a history-hole "seam" the moment it forms (a `before:''` fetch-latest page landing disjoint above held history) and close it progressively from both directions, so silent MAM gaps can never form unrecorded again.

**Architecture:** All detection is structural (query direction + dedupe overlap + above/below ordering) — no timestamp-gap heuristics. New pure transitions live in the shared `mamGap.ts` module (chat/room twin rule); both stores' merge functions route their gap-sync through one shared `syncGapAfterArchiveMerge` function. A new `isFetchLatest` flag travels from the MAM query call site through the SDK event to the merge. The persisted `roomGaps`/`conversationGaps` maps, the `HistoryGapMarker` UI, and the catch-up cursor policy are reused unchanged.

**Tech Stack:** TypeScript, Zustand vanilla stores, Vitest. Monorepo: `packages/fluux-sdk` (all changes are SDK-side; zero app changes).

**Spec:** `docs/superpowers/specs/2026-07-15-mam-discontinuity-safety-net-design.md`

## Global Constraints

- Chat/room parity: behavior changes go in the shared module (`packages/fluux-sdk/src/stores/shared/`), never inline in one store only.
- Before every commit: SDK tests pass with no errors or stderr; commit messages have NO Claude footer.
- Run SDK tests from the workspace: `cd packages/fluux-sdk && npx vitest run <file>` (never from repo root).
- SDK type changes: run `npm run build:sdk` before the root `npm run typecheck` (worktree SDK resolves to root dist — if app typecheck sees stale types, rebuild).
- Final gates (Task 5): full SDK suite, `npm run build:sdk`, `npm run typecheck`, `npm run test:scroll`.
- No new UI, no new persisted structures, no timestamps-as-signal (page *extents* and ordering are structural facts, not gap-size heuristics).
- Commit signing: SSH key should already be loaded (`ssh-add -l` to verify); if signing fails mid-session, `--no-gpg-sign` is approved.

---

### Task 1: Pure seam helpers in `mamGap.ts`

**Files:**
- Modify: `packages/fluux-sdk/src/stores/shared/mamGap.ts`
- Test: `packages/fluux-sdk/src/stores/shared/mamGap.test.ts`

**Interfaces:**
- Consumes: existing `GapInterval` (same file).
- Produces (Task 2 relies on these exact signatures):
  - `interface PageExtent { oldestTs?: number; newestTs?: number }`
  - `messagePageExtent(messages: Array<{ timestamp?: Date }>): PageExtent`
  - `detectFetchLatestSeam(fetched: Array<{ timestamp?: Date }>, newMessagesCount: number, patchedCount: number, newestHeldBelowTs: number | undefined): GapInterval | undefined`
  - `closeGapWithBackwardPage(gap: GapInterval, page: PageExtent, complete: boolean): GapInterval | undefined`

- [ ] **Step 1: Write the failing tests**

Append to `packages/fluux-sdk/src/stores/shared/mamGap.test.ts` (follow the file's existing import style — it already imports from `./mamGap`; extend that import with the new names):

```typescript
import {
  messagePageExtent,
  detectFetchLatestSeam,
  closeGapWithBackwardPage,
  type GapInterval,
} from './mamGap'

const msg = (iso: string) => ({ timestamp: new Date(iso) })
const ts = (iso: string) => new Date(iso).getTime()

describe('messagePageExtent', () => {
  it('returns min/max timestamps, robust to unsorted input', () => {
    const extent = messagePageExtent([msg('2026-07-10T00:00:00Z'), msg('2026-07-06T00:00:00Z'), msg('2026-07-08T00:00:00Z')])
    expect(extent).toEqual({ oldestTs: ts('2026-07-06T00:00:00Z'), newestTs: ts('2026-07-10T00:00:00Z') })
  })

  it('skips messages without timestamps; empty input yields undefined bounds', () => {
    expect(messagePageExtent([{}, msg('2026-07-06T00:00:00Z')])).toEqual({
      oldestTs: ts('2026-07-06T00:00:00Z'), newestTs: ts('2026-07-06T00:00:00Z'),
    })
    expect(messagePageExtent([])).toEqual({ oldestTs: undefined, newestTs: undefined })
  })
})

describe('detectFetchLatestSeam', () => {
  const page = [msg('2026-07-14T00:00:00Z'), msg('2026-07-15T00:00:00Z')]
  const heldBelowTs = ts('2026-07-06T00:00:00Z')

  it('plants a seam when the page lands entirely above held history with no overlap', () => {
    expect(detectFetchLatestSeam(page, 2, 0, heldBelowTs)).toEqual({
      start: heldBelowTs,               // newest pre-existing message below
      end: ts('2026-07-14T00:00:00Z'),  // oldest fetched message
    })
  })

  it('no seam on dedupe overlap (some fetched messages already held)', () => {
    expect(detectFetchLatestSeam(page, 1, 0, heldBelowTs)).toBeUndefined()
  })

  it('no seam on archive-id backfill (reflection patched onto held messages)', () => {
    expect(detectFetchLatestSeam(page, 2, 1, heldBelowTs)).toBeUndefined()
  })

  it('no seam when nothing is held below', () => {
    expect(detectFetchLatestSeam(page, 2, 0, undefined)).toBeUndefined()
  })

  it('no seam when the page interleaves with held history (ambiguous)', () => {
    // Held newest (July 14T12:00) sits inside the page span — not entirely above.
    expect(detectFetchLatestSeam(page, 2, 0, ts('2026-07-14T12:00:00Z'))).toBeUndefined()
  })

  it('no seam for an empty page or a page with no timestamps', () => {
    expect(detectFetchLatestSeam([], 0, 0, heldBelowTs)).toBeUndefined()
    expect(detectFetchLatestSeam([{}], 1, 0, heldBelowTs)).toBeUndefined()
  })
})

describe('closeGapWithBackwardPage', () => {
  const gap: GapInterval = { start: ts('2026-07-06T00:00:00Z'), end: ts('2026-07-14T00:00:00Z') }

  it('clears the gap when the page crosses it (oldest fetched reaches held history below)', () => {
    const page = { oldestTs: ts('2026-07-05T00:00:00Z'), newestTs: ts('2026-07-14T06:00:00Z') }
    expect(closeGapWithBackwardPage(gap, page, false)).toBeUndefined()
  })

  it('shrinks the gap when the page reaches into it from above', () => {
    const page = { oldestTs: ts('2026-07-10T00:00:00Z'), newestTs: ts('2026-07-14T06:00:00Z') }
    expect(closeGapWithBackwardPage(gap, page, false)).toEqual({
      start: gap.start, end: ts('2026-07-10T00:00:00Z'),
    })
  })

  it('ignores a page entirely below the gap (older-region pagination says nothing)', () => {
    const page = { oldestTs: ts('2026-07-01T00:00:00Z'), newestTs: ts('2026-07-05T00:00:00Z') }
    expect(closeGapWithBackwardPage(gap, page, false)).toBe(gap)
    // Even archive-start (complete=true) below the gap must NOT clear it.
    expect(closeGapWithBackwardPage(gap, page, true)).toBe(gap)
  })

  it('clears the gap when a page from at/above it reaches archive start (complete)', () => {
    const page = { oldestTs: ts('2026-07-08T00:00:00Z'), newestTs: ts('2026-07-14T06:00:00Z') }
    expect(closeGapWithBackwardPage(gap, page, true)).toBeUndefined()
  })

  it('ignores an empty page (no positional info), even when complete', () => {
    expect(closeGapWithBackwardPage(gap, { oldestTs: undefined, newestTs: undefined }, true)).toBe(gap)
  })

  it('ignores a page entirely above the gap end (recent-region pagination not yet at the seam)', () => {
    const page = { oldestTs: ts('2026-07-14T12:00:00Z'), newestTs: ts('2026-07-15T00:00:00Z') }
    expect(closeGapWithBackwardPage(gap, page, false)).toBe(gap)
  })

  it('shrinks an open-ended gap (end undefined) instead of ignoring it', () => {
    const openGap: GapInterval = { start: ts('2026-07-06T00:00:00Z') }
    const page = { oldestTs: ts('2026-07-10T00:00:00Z'), newestTs: ts('2026-07-15T00:00:00Z') }
    expect(closeGapWithBackwardPage(openGap, page, false)).toEqual({
      start: openGap.start, end: ts('2026-07-10T00:00:00Z'),
    })
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd packages/fluux-sdk && npx vitest run src/stores/shared/mamGap.test.ts`
Expected: FAIL — `messagePageExtent`, `detectFetchLatestSeam`, `closeGapWithBackwardPage` are not exported.

- [ ] **Step 3: Implement the helpers**

Append to `packages/fluux-sdk/src/stores/shared/mamGap.ts`:

```typescript
/** Min/max timestamps (epoch ms) of a message page. Robust to unsorted input
 *  and messages without timestamps. */
export interface PageExtent {
  oldestTs?: number
  newestTs?: number
}

/** Compute the timestamp extent of a page of messages. */
export function messagePageExtent(messages: Array<{ timestamp?: Date }>): PageExtent {
  let oldestTs: number | undefined
  let newestTs: number | undefined
  for (const message of messages) {
    const ts = message.timestamp?.getTime()
    if (ts === undefined) continue
    if (oldestTs === undefined || ts < oldestTs) oldestTs = ts
    if (newestTs === undefined || ts > newestTs) newestTs = ts
  }
  return { oldestTs, newestTs }
}

/**
 * Detect a disjoint fetch-latest page: a backward `before:''` page that landed
 * entirely above held history without any connection proof.
 *
 * All checks are STRUCTURAL — direction, dedupe overlap, archive-id backfill,
 * above/below ordering — never a gap-size heuristic:
 * - any dedupe hit (`newMessagesCount < fetched.length`) or archive-id backfill
 *   (`patchedCount > 0`) proves the page connects to held history → no seam;
 * - nothing held below → nothing to disconnect from → no seam;
 * - a page that interleaves with held history is ambiguous → no seam
 *   (conservative: never plant a marker on uncertain evidence).
 *
 * @param fetched - The incoming page, as handed to the merge
 * @param newMessagesCount - How many of `fetched` survived dedupe (merge output)
 * @param patchedCount - Archive-id backfills onto held messages (merge output)
 * @param newestHeldBelowTs - Newest message held BEFORE this merge (resident
 *   newest, or the persisted preview timestamp when the resident array is empty)
 * @returns The seam to record, or undefined when the page is connected/ambiguous
 */
export function detectFetchLatestSeam(
  fetched: Array<{ timestamp?: Date }>,
  newMessagesCount: number,
  patchedCount: number,
  newestHeldBelowTs: number | undefined,
): GapInterval | undefined {
  if (fetched.length === 0) return undefined
  if (newMessagesCount < fetched.length || patchedCount > 0) return undefined
  if (newestHeldBelowTs === undefined) return undefined
  const { oldestTs } = messagePageExtent(fetched)
  if (oldestTs === undefined) return undefined
  if (oldestTs <= newestHeldBelowTs) return undefined
  return { start: newestHeldBelowTs, end: oldestTs }
}

/**
 * Reconcile a recorded gap against a merged BACKWARD page (scroll-up
 * pagination). Backward pages walk contiguously down from their cursor, so a
 * page's extent proves the span it covered:
 *
 * - page entirely below the gap (`newestTs <= start`): older-region pagination,
 *   says nothing about the gap — even `complete` (archive start below the gap)
 *   must not clear it;
 * - `complete` from at/above the gap: everything below the cursor was fetched,
 *   the gap region included → clear;
 * - page reaching held history below (`oldestTs <= start`): regions connected → clear;
 * - page reaching into the gap from above: shrink (`end` moves down to the
 *   page's oldest);
 * - empty page: no positional info → unchanged.
 *
 * @returns The new gap (`undefined` = clear); returns `gap` by reference when unchanged.
 */
export function closeGapWithBackwardPage(
  gap: GapInterval,
  page: PageExtent,
  complete: boolean,
): GapInterval | undefined {
  if (page.oldestTs === undefined || page.newestTs === undefined) return gap
  if (page.newestTs <= gap.start) return gap
  if (complete) return undefined
  if (page.oldestTs <= gap.start) return undefined
  if (gap.end === undefined || page.oldestTs < gap.end) return { start: gap.start, end: page.oldestTs }
  return gap
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd packages/fluux-sdk && npx vitest run src/stores/shared/mamGap.test.ts`
Expected: PASS, all tests (existing + new), no stderr.

- [ ] **Step 5: Commit**

```bash
git add packages/fluux-sdk/src/stores/shared/mamGap.ts packages/fluux-sdk/src/stores/shared/mamGap.test.ts
git commit -m "feat(sdk): pure seam detection/closure helpers in mamGap"
```

---

### Task 2: Shared `syncGapAfterArchiveMerge` transition

**Files:**
- Modify: `packages/fluux-sdk/src/stores/shared/mamGap.ts`
- Test: `packages/fluux-sdk/src/stores/shared/mamGap.test.ts`

**Interfaces:**
- Consumes (Task 1): `detectFetchLatestSeam`, `closeGapWithBackwardPage`, `messagePageExtent`, plus existing `computeGapEnd`, `syncGap`, `GapInterval`.
- Produces (Tasks 3–4 rely on this exact signature):
  ```typescript
  interface ArchiveMergeGapInput {
    gaps: Map<string, GapInterval>
    id: string
    direction: 'backward' | 'forward'
    complete: boolean
    forwardGapTimestamp: number | undefined
    merged: Array<{ timestamp?: Date }>
    fetched: Array<{ timestamp?: Date }>
    newMessagesCount: number
    patchedCount: number
    isFetchLatest: boolean
    newestHeldBelowTs: number | undefined
    preserveGapMarker: boolean
  }
  syncGapAfterArchiveMerge(input: ArchiveMergeGapInput): Map<string, GapInterval>
  ```
  Copy-on-write: returns the SAME map reference when nothing changes (callers skip persistence on identity).

- [ ] **Step 1: Write the failing tests**

Append to `packages/fluux-sdk/src/stores/shared/mamGap.test.ts` (add `syncGapAfterArchiveMerge` and `type ArchiveMergeGapInput` to the import):

```typescript
describe('syncGapAfterArchiveMerge', () => {
  const id = 'room@conference.example.com'
  const base = (over: Partial<ArchiveMergeGapInput>): ArchiveMergeGapInput => ({
    gaps: new Map(),
    id,
    direction: 'backward',
    complete: false,
    forwardGapTimestamp: undefined,
    merged: [],
    fetched: [],
    newMessagesCount: 0,
    patchedCount: 0,
    isFetchLatest: false,
    newestHeldBelowTs: undefined,
    preserveGapMarker: false,
    ...over,
  })

  it('forward: mirrors forwardGapTimestamp into the map with computeGapEnd (existing behavior)', () => {
    const merged = [msg('2026-07-06T00:00:00Z'), msg('2026-07-15T00:00:00Z')]
    const out = syncGapAfterArchiveMerge(base({
      direction: 'forward', forwardGapTimestamp: ts('2026-07-06T00:00:00Z'), merged,
    }))
    expect(out.get(id)).toEqual({ start: ts('2026-07-06T00:00:00Z'), end: ts('2026-07-15T00:00:00Z') })
  })

  it('forward: clears the gap when forwardGapTimestamp is undefined (complete catch-up)', () => {
    const gaps = new Map([[id, { start: 1000, end: 5000 }]])
    const out = syncGapAfterArchiveMerge(base({ direction: 'forward', gaps, complete: true }))
    expect(out.has(id)).toBe(false)
  })

  it('preserveGapMarker: returns the map untouched for BOTH directions', () => {
    const gaps = new Map([[id, { start: 1000, end: 5000 }]])
    expect(syncGapAfterArchiveMerge(base({ direction: 'forward', gaps, preserveGapMarker: true }))).toBe(gaps)
    expect(syncGapAfterArchiveMerge(base({ gaps, preserveGapMarker: true, isFetchLatest: true }))).toBe(gaps)
  })

  it('backward formation: fetch-latest page disjoint above held history plants a seam', () => {
    const fetched = [msg('2026-07-14T00:00:00Z'), msg('2026-07-15T00:00:00Z')]
    const out = syncGapAfterArchiveMerge(base({
      fetched, newMessagesCount: 2, isFetchLatest: true,
      newestHeldBelowTs: ts('2026-07-06T00:00:00Z'),
    }))
    expect(out.get(id)).toEqual({ start: ts('2026-07-06T00:00:00Z'), end: ts('2026-07-14T00:00:00Z') })
  })

  it('backward formation: NOT planted for a plain pagination page (isFetchLatest=false)', () => {
    const fetched = [msg('2026-07-14T00:00:00Z')]
    const out = syncGapAfterArchiveMerge(base({
      fetched, newMessagesCount: 1, newestHeldBelowTs: ts('2026-07-06T00:00:00Z'),
    }))
    expect(out.has(id)).toBe(false)
  })

  it('backward closure: an existing gap takes priority over formation and shrinks/clears', () => {
    const gaps = new Map([[id, { start: ts('2026-07-01T00:00:00Z'), end: ts('2026-07-14T00:00:00Z') }]])
    const fetched = [msg('2026-07-10T00:00:00Z'), msg('2026-07-14T06:00:00Z')]
    const out = syncGapAfterArchiveMerge(base({
      gaps, fetched, newMessagesCount: 2, isFetchLatest: true, // fetch-latest flag must NOT re-plant
      newestHeldBelowTs: ts('2026-06-01T00:00:00Z'),
    }))
    expect(out.get(id)).toEqual({ start: ts('2026-07-01T00:00:00Z'), end: ts('2026-07-10T00:00:00Z') })
  })

  it('backward no-op: returns the SAME map reference when nothing changes', () => {
    const gaps = new Map([[id, { start: ts('2026-07-06T00:00:00Z'), end: ts('2026-07-14T00:00:00Z') }]])
    const fetched = [msg('2026-07-01T00:00:00Z')] // entirely below the gap
    const out = syncGapAfterArchiveMerge(base({ gaps, fetched, newMessagesCount: 1 }))
    expect(out).toBe(gaps)
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd packages/fluux-sdk && npx vitest run src/stores/shared/mamGap.test.ts`
Expected: FAIL — `syncGapAfterArchiveMerge` not exported.

- [ ] **Step 3: Implement `syncGapAfterArchiveMerge` and update the module doc**

Append to `packages/fluux-sdk/src/stores/shared/mamGap.ts`:

```typescript
/** Everything the gap transition needs from an archive merge, both directions. */
export interface ArchiveMergeGapInput {
  /** Current persisted gap map (`roomGaps` / `conversationGaps`). */
  gaps: Map<string, GapInterval>
  /** Room JID / conversation id. */
  id: string
  direction: 'backward' | 'forward'
  /** Server's `<fin complete=…>` for this merge. */
  complete: boolean
  /** `forwardGapTimestamp` AFTER `setMAMQueryCompleted` for this merge (forward only). */
  forwardGapTimestamp: number | undefined
  /** Merged timeline (for `computeGapEnd` on the forward path). */
  merged: Array<{ timestamp?: Date }>
  /** The incoming page, as handed to the merge. */
  fetched: Array<{ timestamp?: Date }>
  /** How many of `fetched` survived dedupe. */
  newMessagesCount: number
  /** Archive-id backfills onto held messages. */
  patchedCount: number
  /** The query was a `before:''` fetch-latest. */
  isFetchLatest: boolean
  /** Newest message held BEFORE this merge (resident newest ?? persisted preview ts). */
  newestHeldBelowTs: number | undefined
  /** Bounded force-repair: leave the marker untouched (neither set nor cleared). */
  preserveGapMarker: boolean
}

/**
 * The single gap transition for BOTH stores and BOTH merge directions.
 *
 * Forward: mirror the (complete=false-driven) `forwardGapTimestamp` into the
 * persisted map — unchanged behavior, extracted from the near-twin blocks in
 * `mergeRoomMAMMessages` / `mergeMAMMessages`.
 *
 * Backward: an existing gap is reconciled against the page (closure takes
 * priority — a fetch-latest while a gap is already recorded must not re-plant
 * a shallower seam over a deeper one); otherwise a disjoint fetch-latest page
 * plants a new seam at formation.
 *
 * Copy-on-write: returns the same map reference when nothing changes, so
 * callers can skip persistence and re-renders.
 */
export function syncGapAfterArchiveMerge(input: ArchiveMergeGapInput): Map<string, GapInterval> {
  const {
    gaps, id, direction, complete, forwardGapTimestamp, merged, fetched,
    newMessagesCount, patchedCount, isFetchLatest, newestHeldBelowTs, preserveGapMarker,
  } = input

  if (preserveGapMarker) return gaps

  if (direction === 'forward') {
    const gapEnd = forwardGapTimestamp !== undefined ? computeGapEnd(merged, forwardGapTimestamp) : undefined
    return syncGap(gaps, id, forwardGapTimestamp, gapEnd)
  }

  const existing = gaps.get(id)
  const next = existing
    ? closeGapWithBackwardPage(existing, messagePageExtent(fetched), complete)
    : isFetchLatest
      ? detectFetchLatestSeam(fetched, newMessagesCount, patchedCount, newestHeldBelowTs)
      : undefined
  return syncGap(gaps, id, next?.start, next?.end)
}
```

Also replace the module doc paragraph (current lines 12–16):

```typescript
 * Detection is driven ONLY by reliable structural signals — never by timestamp
 * discontinuities (a quiet period and a real gap are indistinguishable by
 * timestamp, and ejabberd archive ids are non-sequential):
 * 1. a forward catch-up that ended `complete=false` (the server said there is
 *    more, and we stopped at the page cap);
 * 2. a `before:''` fetch-latest page that landed entirely above held history
 *    with no dedupe overlap — the page provably does not connect to what we
 *    hold, so the boundary between them is a seam (recorded at formation).
 * Recorded gaps close progressively from both directions: forward catch-up
 * resumes from the boundary; backward scroll-up pagination shrinks/clears the
 * gap when its pages reach into or across it.
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd packages/fluux-sdk && npx vitest run src/stores/shared/mamGap.test.ts`
Expected: PASS, no stderr.

- [ ] **Step 5: Commit**

```bash
git add packages/fluux-sdk/src/stores/shared/mamGap.ts packages/fluux-sdk/src/stores/shared/mamGap.test.ts
git commit -m "feat(sdk): shared syncGapAfterArchiveMerge gap transition (both stores, both directions)"
```

---

### Task 3: Room wiring — `isFetchLatest` flag + merge integration

**Files:**
- Modify: `packages/fluux-sdk/src/core/types/sdk-events.ts` (`'room:mam-messages'` payload, ~line 391)
- Modify: `packages/fluux-sdk/src/core/modules/MAM.ts` (`queryRoomArchive` emit, ~line 491)
- Modify: `packages/fluux-sdk/src/bindings/storeBindings.ts` (`'room:mam-messages'` handler, ~line 424)
- Modify: `packages/fluux-sdk/src/stores/roomStore.ts` (type ~line 642, impl `mergeRoomMAMMessages` ~line 2495)
- Test: `packages/fluux-sdk/src/stores/roomStore.test.ts` (extend the existing gap describe block, ~line 2140 area)

**Interfaces:**
- Consumes (Task 2): `syncGapAfterArchiveMerge`, `messagePageExtent` from `./shared/mamGap` (roomStore already imports `computeGapEnd`/`syncGap` from there — extend that import; `syncGap` may become unused in this file after this task, remove it from the import if so).
- Produces: `mergeRoomMAMMessages(roomJid, messages, rsm, complete, direction, preserveGapMarker?, isFetchLatest?)` — Task 4 mirrors this shape for chat.

- [ ] **Step 1: Write the failing tests**

Add to the gap describe block in `packages/fluux-sdk/src/stores/roomStore.test.ts` (same file region as the existing `'clears the persisted gap when a forward catch-up completes'` test; reuse its `jid`, `createRoom`, `RoomMessage` literal idiom):

```typescript
    it('plants a seam when a fetch-latest page lands disjoint above held history', () => {
      const held: RoomMessage = {
        type: 'groupchat', id: 'held', roomJid: jid, from: `${jid}/a`, nick: 'a',
        body: 'held', timestamp: new Date('2026-07-06T00:00:00Z'), isOutgoing: false,
      }
      roomStore.getState().addRoom(createRoom(jid, { joined: true, messages: [held], lastMessage: held }))

      const fetched: RoomMessage = {
        type: 'groupchat', id: 'fresh', roomJid: jid, from: `${jid}/b`, nick: 'b',
        body: 'fresh', timestamp: new Date('2026-07-15T00:00:00Z'), isOutgoing: false,
      }
      // backward + isFetchLatest=true = a `before:''` fetch-latest page
      roomStore.getState().mergeRoomMAMMessages(jid, [fetched], {}, true, 'backward', false, true)

      expect(roomStore.getState().roomGaps.get(jid)).toEqual({
        start: new Date('2026-07-06T00:00:00Z').getTime(),
        end: new Date('2026-07-15T00:00:00Z').getTime(),
      })
    })

    it('does NOT plant a seam when the fetch-latest page overlaps held history (dedupe)', () => {
      const held: RoomMessage = {
        type: 'groupchat', id: 'shared', roomJid: jid, from: `${jid}/a`, nick: 'a',
        body: 'shared', timestamp: new Date('2026-07-14T00:00:00Z'), isOutgoing: false,
      }
      roomStore.getState().addRoom(createRoom(jid, { joined: true, messages: [held], lastMessage: held }))

      const fresh: RoomMessage = {
        type: 'groupchat', id: 'fresh', roomJid: jid, from: `${jid}/b`, nick: 'b',
        body: 'fresh', timestamp: new Date('2026-07-15T00:00:00Z'), isOutgoing: false,
      }
      const dupe: RoomMessage = { ...held } // same id → dedupe hit → connection proof
      roomStore.getState().mergeRoomMAMMessages(jid, [dupe, fresh], {}, true, 'backward', false, true)

      expect(roomStore.getState().roomGaps.has(jid)).toBe(false)
    })

    it('does NOT plant a seam for a plain backward pagination page (isFetchLatest omitted)', () => {
      const held: RoomMessage = {
        type: 'groupchat', id: 'held', roomJid: jid, from: `${jid}/a`, nick: 'a',
        body: 'held', timestamp: new Date('2026-07-06T00:00:00Z'), isOutgoing: false,
      }
      roomStore.getState().addRoom(createRoom(jid, { joined: true, messages: [held], lastMessage: held }))
      const older: RoomMessage = {
        type: 'groupchat', id: 'older', roomJid: jid, from: `${jid}/b`, nick: 'b',
        body: 'older', timestamp: new Date('2026-07-01T00:00:00Z'), isOutgoing: false,
      }
      roomStore.getState().mergeRoomMAMMessages(jid, [older], {}, false, 'backward')

      expect(roomStore.getState().roomGaps.has(jid)).toBe(false)
    })

    it('falls back to the persisted preview timestamp when the resident array is empty', () => {
      const held: RoomMessage = {
        type: 'groupchat', id: 'held', roomJid: jid, from: `${jid}/a`, nick: 'a',
        body: 'held', timestamp: new Date('2026-07-06T00:00:00Z'), isOutgoing: false,
      }
      // Fresh-run shape: resident array EMPTY, preview (meta.lastMessage) persisted.
      roomStore.getState().addRoom(createRoom(jid, { joined: true, lastMessage: held }))

      const fetched: RoomMessage = {
        type: 'groupchat', id: 'fresh', roomJid: jid, from: `${jid}/b`, nick: 'b',
        body: 'fresh', timestamp: new Date('2026-07-15T00:00:00Z'), isOutgoing: false,
      }
      roomStore.getState().mergeRoomMAMMessages(jid, [fetched], {}, true, 'backward', false, true)

      expect(roomStore.getState().roomGaps.get(jid)).toEqual({
        start: new Date('2026-07-06T00:00:00Z').getTime(),
        end: new Date('2026-07-15T00:00:00Z').getTime(),
      })
    })

    it('backward closure: a scroll-up page reaching into the gap shrinks it; crossing clears it', () => {
      roomStore.getState().addRoom(createRoom(jid))
      roomStore.setState({ roomGaps: new Map([[jid, {
        start: new Date('2026-07-06T00:00:00Z').getTime(),
        end: new Date('2026-07-14T00:00:00Z').getTime(),
      }]]) })

      const mid: RoomMessage = {
        type: 'groupchat', id: 'mid', roomJid: jid, from: `${jid}/a`, nick: 'a',
        body: 'mid', timestamp: new Date('2026-07-10T00:00:00Z'), isOutgoing: false,
      }
      const upper: RoomMessage = {
        type: 'groupchat', id: 'upper', roomJid: jid, from: `${jid}/b`, nick: 'b',
        body: 'upper', timestamp: new Date('2026-07-14T06:00:00Z'), isOutgoing: false,
      }
      roomStore.getState().mergeRoomMAMMessages(jid, [mid, upper], {}, false, 'backward')
      expect(roomStore.getState().roomGaps.get(jid)).toEqual({
        start: new Date('2026-07-06T00:00:00Z').getTime(),
        end: new Date('2026-07-10T00:00:00Z').getTime(),
      })

      const below: RoomMessage = {
        type: 'groupchat', id: 'below', roomJid: jid, from: `${jid}/a`, nick: 'a',
        body: 'below', timestamp: new Date('2026-07-05T00:00:00Z'), isOutgoing: false,
      }
      roomStore.getState().mergeRoomMAMMessages(jid, [below, mid], {}, false, 'backward')
      expect(roomStore.getState().roomGaps.has(jid)).toBe(false)
    })

    it('backward closure: an older-region page below the gap leaves it untouched', () => {
      roomStore.getState().addRoom(createRoom(jid))
      const gap = {
        start: new Date('2026-07-06T00:00:00Z').getTime(),
        end: new Date('2026-07-14T00:00:00Z').getTime(),
      }
      roomStore.setState({ roomGaps: new Map([[jid, gap]]) })

      const ancient: RoomMessage = {
        type: 'groupchat', id: 'ancient', roomJid: jid, from: `${jid}/a`, nick: 'a',
        body: 'ancient', timestamp: new Date('2026-07-01T00:00:00Z'), isOutgoing: false,
      }
      roomStore.getState().mergeRoomMAMMessages(jid, [ancient], {}, true, 'backward')
      expect(roomStore.getState().roomGaps.get(jid)).toEqual(gap)
    })
```

(`createRoom(jid, options)` is the file's existing factory — the `messages`/`lastMessage`/`joined` options are already used by neighboring tests, e.g. the sidebar tests near line 127.)

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd packages/fluux-sdk && npx vitest run src/stores/roomStore.test.ts`
Expected: FAIL — new tests fail (`roomGaps` never set on backward merges); all pre-existing tests still pass.

- [ ] **Step 3: Implement the room wiring**

**(a)** `packages/fluux-sdk/src/core/types/sdk-events.ts` — add to the `'room:mam-messages'` payload after `preserveGapMarker`:

```typescript
    /** The query was a `before:''` fetch-latest (seam formation candidate). */
    isFetchLatest?: boolean
```

**(b)** `packages/fluux-sdk/src/core/modules/MAM.ts`, `queryRoomArchive` emit (~line 491) — add the flag:

```typescript
          this.deps.emitSDK('room:mam-messages', {
            roomJid,
            messages: collectedMessages,
            rsm,
            complete,
            direction,
            preserveGapMarker,
            isFetchLatest: !isForward && !before,
          })
```

(`before` is already destructured from `options` at the top of the method — with NO default, so a backward query can carry `before: ''` OR `before: undefined`; both mean "newest page" to the server, hence `!before`, which stays false for a real pagination id. The after-cursor-purged degrade path recurses with `before: ''`, so its emit correctly carries `isFetchLatest: true`.)

**(c)** `packages/fluux-sdk/src/bindings/storeBindings.ts` (~line 424):

```typescript
  on('room:mam-messages', ({ roomJid, messages, rsm, complete, direction, preserveGapMarker, isFetchLatest }) => {
    const stores = getStores()
    stores.room.mergeRoomMAMMessages(roomJid, messages, rsm, complete, direction, preserveGapMarker, isFetchLatest)
  })
```

**(d)** `packages/fluux-sdk/src/stores/roomStore.ts`:

Type (~line 642):

```typescript
  mergeRoomMAMMessages: (roomJid: string, messages: RoomMessage[], rsm: RSMResponse, complete: boolean, direction: MAMQueryDirection, preserveGapMarker?: boolean, isFetchLatest?: boolean) => void
```

Impl (~line 2495) — signature and pre-`set` fallback read:

```typescript
  mergeRoomMAMMessages: (roomJid, mamMessages, rsm, complete, direction, preserveGapMarker = false, isFetchLatest = false) => {
    // Newest persisted timestamp (entity preview) — the seam-formation fallback
    // when the resident array is empty this run (fresh session, history on disk).
    const fallbackHeldTs = get().getRoomLastTimestamp(roomJid)
```

Then replace the forward-only gap block (currently ~lines 2543–2550):

```typescript
      // Mirror the (reliable, complete=false-driven) forward gap into the PERSISTED
      // roomGaps map so the marker survives a reload. `end` = oldest message held
      // above the gap. preserveGapMarker (bounded force repair) leaves it untouched.
      let newGaps = state.roomGaps
      if (direction === 'forward' && !preserveGapMarker) {
        const gapStart = newStates.get(roomJid)?.forwardGapTimestamp
        const gapEnd = gapStart !== undefined ? computeGapEnd(merged, gapStart) : undefined
        newGaps = syncGap(state.roomGaps, roomJid, gapStart, gapEnd)
        if (newGaps !== state.roomGaps) saveGapsToStorage(newGaps)
      }
```

with:

```typescript
      // Persisted gap sync (shared transition, both directions):
      // - forward: mirror the complete=false-driven forwardGapTimestamp (marker
      //   survives a reload);
      // - backward: close/shrink a recorded gap when a scroll-up page reaches
      //   into or across it, or plant a seam when a `before:''` fetch-latest
      //   page lands disjoint above held history (formation).
      const newGaps = syncGapAfterArchiveMerge({
        gaps: state.roomGaps,
        id: roomJid,
        direction,
        complete,
        forwardGapTimestamp: newStates.get(roomJid)?.forwardGapTimestamp,
        merged,
        fetched: mamMessages,
        newMessagesCount: newFromMAM.length,
        patchedCount: patched.length,
        isFetchLatest,
        newestHeldBelowTs: messagePageExtent(existingMessages).newestTs ?? fallbackHeldTs,
        preserveGapMarker,
      })
      if (newGaps !== state.roomGaps) saveGapsToStorage(newGaps)
```

Update the `./shared/mamGap` import: add `syncGapAfterArchiveMerge`, `messagePageExtent`; drop `computeGapEnd`/`syncGap` from it if this was their only use in the file (grep first).

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd packages/fluux-sdk && npx vitest run src/stores/roomStore.test.ts src/stores/shared/mamGap.test.ts`
Expected: PASS (new + all pre-existing gap/persistence/account-scoping tests), no stderr.

- [ ] **Step 5: Run the room-adjacent suites (merge path consumers)**

Run: `cd packages/fluux-sdk && npx vitest run src/stores/roomStore.mds.test.ts src/core/modules/MAM.catchup.test.ts src/core/modules/MAM.preview.test.ts src/core/modules/MUC.test.ts`
Expected: PASS, no stderr.

- [ ] **Step 6: Commit**

```bash
git add packages/fluux-sdk/src/core/types/sdk-events.ts packages/fluux-sdk/src/core/modules/MAM.ts packages/fluux-sdk/src/bindings/storeBindings.ts packages/fluux-sdk/src/stores/roomStore.ts packages/fluux-sdk/src/stores/roomStore.test.ts
git commit -m "feat(sdk): record room history seam at fetch-latest formation; close it on backward scroll"
```

---

### Task 4: Chat wiring — parity with rooms

**Files:**
- Modify: `packages/fluux-sdk/src/core/types/sdk-events.ts` (`'chat:mam-messages'` payload, ~line 196)
- Modify: `packages/fluux-sdk/src/core/modules/MAM.ts` (`queryArchive` emit, ~line 339)
- Modify: `packages/fluux-sdk/src/bindings/storeBindings.ts` (`'chat:mam-messages'` handler, ~line 269)
- Modify: `packages/fluux-sdk/src/stores/chatStore.ts` (type `mergeMAMMessages` ~line 290 region, impl ~line 1600)
- Test: `packages/fluux-sdk/src/stores/chatStore.test.ts` (extend `describe('mergeMAMMessages gap tracking …')`, ~line 157)

**Interfaces:**
- Consumes (Task 2): `syncGapAfterArchiveMerge`, `messagePageExtent` from `./shared/mamGap`.
- Produces: `mergeMAMMessages(conversationId, messages, rsm, complete, direction, isFetchLatest?)`. Chat has no `preserveGapMarker` (no chat force-repair) — pass `preserveGapMarker: false` to the shared function.

- [ ] **Step 1: Write the failing tests**

Add inside `describe('mergeMAMMessages gap tracking (persisted conversationGaps)')` in `packages/fluux-sdk/src/stores/chatStore.test.ts`, reusing its `cid`, `createConversation`, `createMessage` helpers:

```typescript
    it('plants a seam when a fetch-latest page lands disjoint above held history (parity with rooms)', () => {
      chatStore.getState().addConversation(createConversation(cid))
      const held = { ...createMessage(cid, 'held'), id: 'held', timestamp: new Date('2026-07-06T00:00:00Z') }
      chatStore.getState().addMessage(held)

      const fetched = { ...createMessage(cid, 'fresh'), id: 'fresh', timestamp: new Date('2026-07-15T00:00:00Z') }
      chatStore.getState().mergeMAMMessages(cid, [fetched], {}, true, 'backward', true)

      expect(chatStore.getState().conversationGaps.get(cid)).toEqual({
        start: new Date('2026-07-06T00:00:00Z').getTime(),
        end: new Date('2026-07-15T00:00:00Z').getTime(),
      })
    })

    it('does NOT plant a seam on dedupe overlap or plain backward pagination', () => {
      chatStore.getState().addConversation(createConversation(cid))
      const held = { ...createMessage(cid, 'shared'), id: 'shared', timestamp: new Date('2026-07-14T00:00:00Z') }
      chatStore.getState().addMessage(held)

      // Overlapping fetch-latest: dedupe hit → connected.
      const fresh = { ...createMessage(cid, 'fresh'), id: 'fresh', timestamp: new Date('2026-07-15T00:00:00Z') }
      chatStore.getState().mergeMAMMessages(cid, [{ ...held }, fresh], {}, true, 'backward', true)
      expect(chatStore.getState().conversationGaps.has(cid)).toBe(false)

      // Plain pagination (isFetchLatest omitted): never a formation candidate.
      const older = { ...createMessage(cid, 'older'), id: 'older', timestamp: new Date('2026-07-01T00:00:00Z') }
      chatStore.getState().mergeMAMMessages(cid, [older], {}, false, 'backward')
      expect(chatStore.getState().conversationGaps.has(cid)).toBe(false)
    })

    it('backward closure: scroll-up pages shrink then clear a recorded gap', () => {
      chatStore.getState().addConversation(createConversation(cid))
      chatStore.setState({ conversationGaps: new Map([[cid, {
        start: new Date('2026-07-06T00:00:00Z').getTime(),
        end: new Date('2026-07-14T00:00:00Z').getTime(),
      }]]) })

      const mid = { ...createMessage(cid, 'mid'), id: 'mid', timestamp: new Date('2026-07-10T00:00:00Z') }
      const upper = { ...createMessage(cid, 'upper'), id: 'upper', timestamp: new Date('2026-07-14T06:00:00Z') }
      chatStore.getState().mergeMAMMessages(cid, [mid, upper], {}, false, 'backward')
      expect(chatStore.getState().conversationGaps.get(cid)).toEqual({
        start: new Date('2026-07-06T00:00:00Z').getTime(),
        end: new Date('2026-07-10T00:00:00Z').getTime(),
      })

      const below = { ...createMessage(cid, 'below'), id: 'below', timestamp: new Date('2026-07-05T00:00:00Z') }
      chatStore.getState().mergeMAMMessages(cid, [below, { ...mid }], {}, false, 'backward')
      expect(chatStore.getState().conversationGaps.has(cid)).toBe(false)
    })

    it('backward closure: an older-region page below the gap leaves it untouched', () => {
      chatStore.getState().addConversation(createConversation(cid))
      const gap = {
        start: new Date('2026-07-06T00:00:00Z').getTime(),
        end: new Date('2026-07-14T00:00:00Z').getTime(),
      }
      chatStore.setState({ conversationGaps: new Map([[cid, gap]]) })

      const ancient = { ...createMessage(cid, 'ancient'), id: 'ancient', timestamp: new Date('2026-07-01T00:00:00Z') }
      chatStore.getState().mergeMAMMessages(cid, [ancient], {}, true, 'backward')
      expect(chatStore.getState().conversationGaps.get(cid)).toEqual(gap)
    })
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd packages/fluux-sdk && npx vitest run src/stores/chatStore.test.ts`
Expected: FAIL — new tests only; pre-existing pass.

- [ ] **Step 3: Implement the chat wiring**

**(a)** `sdk-events.ts` — add to the `'chat:mam-messages'` payload:

```typescript
    /** The query was a `before:''` fetch-latest (seam formation candidate). */
    isFetchLatest?: boolean
```

**(b)** `MAM.ts`, `queryArchive` emit (~line 339) — add the flag (`before` is destructured from `options` at the top of `queryArchive`; the chat method emits once after its pagination loop, anchored at latest when `before === ''`):

```typescript
      this.deps.emitSDK('chat:mam-messages', {
        conversationId,
        messages: allMessages,
        rsm: lastRsm,
        complete: isComplete,
        direction,
        isFetchLatest: direction === 'backward' && !before,
      })
```

(In `queryArchive` the destructure is `before = ''` — it defaults to fetch-latest — so `!before` is true exactly when no pagination cursor was provided.)

**(c)** `storeBindings.ts` (~line 269):

```typescript
  on('chat:mam-messages', ({ conversationId, messages, rsm, complete, direction, isFetchLatest }) => {
    const stores = getStores()
    stores.chat.mergeMAMMessages(conversationId, messages, rsm, complete, direction, isFetchLatest)
  })
```

**(d)** `chatStore.ts`:

Type:

```typescript
  mergeMAMMessages: (conversationId: string, messages: Message[], rsm: RSMResponse, complete: boolean, direction: MAMQueryDirection, isFetchLatest?: boolean) => void
```

Impl — signature + pre-`set` fallback read:

```typescript
      mergeMAMMessages: (conversationId, mamMessages, rsm, complete, direction, isFetchLatest = false) => {
        // Newest persisted timestamp (entity preview) — the seam-formation fallback
        // when the resident array is empty this run (fresh session, history on disk).
        const fallbackHeldTs = get().getConversationLastTimestamp(conversationId)
```

Replace the forward-only gap block (currently the `let newGaps = state.conversationGaps; if (direction === 'forward') { … }` block, ~lines 1640–1647):

```typescript
          // Persisted gap sync (shared transition, both directions) — see
          // syncGapAfterArchiveMerge. Chat has no bounded force-repair, so
          // preserveGapMarker is always false.
          const newGaps = syncGapAfterArchiveMerge({
            gaps: state.conversationGaps,
            id: conversationId,
            direction,
            complete,
            forwardGapTimestamp: newStates.get(conversationId)?.forwardGapTimestamp,
            merged: trimmed,
            fetched: mamMessages,
            newMessagesCount: newMessages.length,
            patchedCount: patched.length,
            isFetchLatest,
            newestHeldBelowTs: messagePageExtent(rawExisting).newestTs ?? fallbackHeldTs,
            preserveGapMarker: false,
          })
```

(Chat's `conversationGaps` persistence is subscription-driven — no explicit save call here; leave that mechanism untouched.) Update the `./shared/mamGap` import: add `syncGapAfterArchiveMerge`, `messagePageExtent`; drop `computeGapEnd`/`syncGap` if now unused in this file.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd packages/fluux-sdk && npx vitest run src/stores/chatStore.test.ts src/stores/chatStore.mds.test.ts src/core/modules/Chat.mam.test.ts`
Expected: PASS, no stderr.

- [ ] **Step 5: Commit**

```bash
git add packages/fluux-sdk/src/core/types/sdk-events.ts packages/fluux-sdk/src/core/modules/MAM.ts packages/fluux-sdk/src/bindings/storeBindings.ts packages/fluux-sdk/src/stores/chatStore.ts packages/fluux-sdk/src/stores/chatStore.test.ts
git commit -m "feat(sdk): chat parity for seam formation + backward closure"
```

---

### Task 5: Simplification audit + full verification gates

**Files:**
- Possibly modify: `packages/fluux-sdk/src/stores/shared/mamGap.ts`, `roomStore.ts`, `chatStore.ts` (fold only what the audit confirms)
- No new files.

**Interfaces:**
- Consumes: everything from Tasks 1–4.
- Produces: the final, verified branch state.

- [ ] **Step 1: Simplification audit (spec-mandated; report findings, fold only genuine duplication)**

Check each and apply only what holds:
1. **Twin gap blocks folded?** After Tasks 3–4 both stores should call `syncGapAfterArchiveMerge` and neither should import `computeGapEnd`/`syncGap` directly anymore. Grep: `grep -n 'computeGapEnd\|syncGap(' packages/fluux-sdk/src/stores/roomStore.ts packages/fluux-sdk/src/stores/chatStore.ts` — expect no hits outside the shared call. Remove leftover imports.
2. **`computeGapEnd` vs new helpers:** `computeGapEnd(messages, start)` is "oldest ts strictly newer than start" — semantically `messagePageExtent`-adjacent but not identical (threshold filter). If, after reading both, one can express the other in ≤2 lines without contortion, fold; otherwise leave and note why in the commit message body. Do NOT force it.
3. **Dead `newestFetchedTimestamp` duplication:** both merge functions compute `newestFetchedTimestamp` for `setMAMQueryCompleted` with identical 3-line expressions. If trivially extractable into `mamState` or `mamGap` without changing signatures, do it; otherwise leave.
4. **Unused exports:** if `messagePageExtent` ended up used only inside `mamGap.ts` (stores inline their own extent), un-export it.

- [ ] **Step 2: Full SDK suite**

Run: `cd packages/fluux-sdk && npx vitest run`
Expected: PASS, zero failures, no stderr.

- [ ] **Step 3: Build + typecheck (SDK types changed → app must see fresh dist)**

Run from repo root:
```bash
npm run build:sdk && npm run typecheck
```
Expected: both succeed. (Worktree gotcha: the app resolves the SDK to the root dist — `build:sdk` must run before the root typecheck or the app sees stale types.)

- [ ] **Step 4: Scroll regression gate**

Run: `npm run test:scroll`
Expected: PASS. (Merges into the active conversation must not disturb scroll; this gate is mandatory for any change on the merge path.)

- [ ] **Step 5: App test suite (SDK event payload changed — verify the app mock still aligns)**

Run: `cd apps/fluux && npx vitest run`
Expected: PASS. The new event field is optional and no app-facing SDK export changed, so no mock updates should be needed — if a mock complains about `mergeMAMMessages` arity, extend the app's SDK mock in `test-setup.ts` via the `importOriginal` spread pattern.

- [ ] **Step 6: Commit (audit results) and wrap up**

```bash
git add -A
git commit -m "refactor(sdk): fold gap-sync duplication after seam safety net (audit results in body)"
```

Then follow `superpowers:finishing-a-development-branch` — the branch is `mr/message-loading-gaps-c50347`; target a PR to `main` (squash-merge flow), concise description, no test plans, no Claude footer.

---

## Verification checklist (maps plan → spec)

- Spec "formation signal 2" → Task 1 `detectFetchLatestSeam` + Task 3/4 wiring + formation tests.
- Spec "IndexedDB-held history visible to the check" → `fallbackHeldTs` from entity preview (`getRoomLastTimestamp` / `getConversationLastTimestamp`) + "falls back to the persisted preview timestamp" tests.
- Spec "backward closure NEW WIRING" → Task 1 `closeGapWithBackwardPage` + closure tests in both stores.
- Spec "forward unchanged (regression)" → existing forward gap tests must stay green (Tasks 3/4 Step 4 runs them); `preserveGapMarker` covered in Task 2 tests + existing room test.
- Spec "persistence + account scoping" → existing localStorage tests stay green (Task 3 Step 4).
- Spec "simplification pass" → Task 5 Step 1.
- Spec "no new UI" → no app source files touched anywhere in this plan.
- Spec regression gates → Task 5 Steps 2–5.
