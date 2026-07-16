# Unified MAM Catch-Up (Latest-First + Backward Pointer Growth) Implementation Plan — v2

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the MAM catch-up anchor policy so an opened conversation/room always renders its recent history in one round-trip, unread stays exact via the XEP-0490 pointer, and long offline gaps become recorded seams healed lazily — with the contiguity guarantees holding *by construction*, not by orchestration care.

**Architecture:** Catch-up becomes a 2-phase orchestrator in the MAM module shared by all four call sites. **Phase A (align to live):** cache has messages → forward from the contiguous local edge with a small bail cap; incomplete → bail to a `before:''` fetch-latest (window jumps to the live edge; the #1019 seam machinery records/reconciles the hole). Empty cache → fetch-latest directly. **Phase B (grow to the read pointer, background entities only):** while the XEP-0490 pointer is unresolved, page BACKWARD from the window bottom. Backward growth keeps the held region contiguous *by construction* (each page is adjacent to the window), the single seam interval stays accurate through the existing `closeGapWithBackwardPage` reconciliation, and the page containing the pointer's own message resolves it — no forward stitch, no context page, no `preserveGapMarker` asymmetry. Supporting changes: an explicit fetch-latest merge mode (dedupe + full sort + keep-newest), and fetch-latest marking `isCaughtUpToLive` so SM-resume seeding doesn't loop.

**Tech Stack:** TypeScript, Zustand vanilla stores, Vitest, XEP-0313 (MAM), XEP-0059 (RSM), XEP-0490 (MDS).

## The two-pointer model (core of the design)

#869's root mistake was conflating two pointers that have different owners:

- **Read pointer** (MDS, XEP-0490) — synced across devices, drives unread counts and the divider. Says nothing about what THIS device has downloaded.
- **Coverage pointer** (last downloaded) — necessarily per-device (another device downloading history puts nothing on this disk), drives where downloading resumes. It is a local fact, never published: it lives as the newest contiguously-downloaded message's ARCHIVE ID plus the recorded seam interval.

Consequences enforced throughout this plan: downloading anchors on the coverage id (`after: <last downloaded stanza-id>`, RSM-exact — timestamps only as fallback when a cached message has no stanza-id); unread anchors on the read pointer (Phase B grows the window to it); seams carry the coverage id (`GapInterval.startId`) so heals resume exactly, immune to same-millisecond timestamp collisions.

## Why v2 (flaws found in the v1 forward-stitch design)

- **F1 — stranded second hole:** an incomplete forward stitch (`after: pointer`, cap hit) creates a SECOND disjoint region; the single-interval `GapInterval` can't record two holes, and `preserveGapMarker` can't express "may set, must not clear". Backward growth never creates a second region.
- **F2 — resume-seed loop:** `isCaughtUpToLive` flips only on complete FORWARD queries (`mamState.ts:115`), so an entity synced via fetch-latest is re-picked by `selectRoomsNeedingResumeSeed` on every SM resume, forever. Fixed by marking fetch-latest merges caught-up-to-live.
- **F3 — unresolvable pointer:** RSM `after` never fetches its anchor, so a forward stitch never loads the pointer's own message and `resolveRemoteDisplayed` (which requires `m.stanzaId === pointer` in the array) stays pending forever; v1 needed a bolt-on "context page". Backward growth loads that message as part of its normal walk.
- **F4 — live-edge eviction on the active entity:** backward pages into a capped resident window trim keep-oldest, which can evict the live edge under the user's feet. Phase B therefore runs ONLY for non-active entities (background merges go to IndexedDB, no resident array). The active entity's deep-pointer UX is already owned by the activation machinery (`loadMessagesAroundFromCache` + entry fold + spec-§5 degrade).

## Guarantees by design

| # | Guarantee | Mechanism |
|---|---|---|
| G1 | An opened entity with archived history never renders empty | Phase A always ends with content: forward-complete over cache, or a fetch-latest page |
| G2 | Unread count & divider are exact once the pointer resolves; resolution is reached by growing the window to it | Phase B backward walk; `applyRemoteDisplayed` post-merge recompute |
| G3 | No silent holes: held history is contiguous-by-construction below the live edge except ONE recorded seam | Backward pages are window-adjacent; bail seams recorded at formation (`detectFetchLatestSeam`), shrunk per page (`closeGapWithBackwardPage`) |
| G4 | Bounded, cheap common cases | Warm reconnect: 1 exact forward query. Fresh device, fully-read: 1 fetch-latest. Caps: `MAM_CATCHUP_FORWARD_BAIL_PAGES`, `MAM_POINTER_STITCH_MAX_PAGES` per pass |
| G5 | Convergence across sessions, no unbounded rework | Fetch-latest marks caught-up-to-live (no resume loop); Phase B resumes from the (now deeper) cache each session; purged-pointer walk stops at `complete` |
| G6 | Chat/room parity | Twin orchestrators over the shared policy + shared merge/gap/marker modules |
| G7 | Read and coverage pointers never conflated; downloading is id-exact | Coverage id (`after:`) anchors Phase A and gap heals; MDS pointer only drives Phase B/unread; seams persist `startId`/`endId` |

**Accepted degrades (explicit):** (1) pointer deeper than `MAM_POINTER_STITCH_MAX_PAGES × 100` per pass → badge shows the loaded lower bound until later passes converge; seam marker stays honest. (2) A purged pointer (message expired from archive) is re-walked to `complete` once per session for small archives — rare and cheap; no server signal exists on backward pages. (3) The ACTIVE entity keeps the spec-§5 pointer-beyond-window divider degrade until a background pass stitches it after the user switches away.

## Global Constraints

- Chat/room parity: every behavior change lands in BOTH twins via shared modules where they exist.
- Gate on `npm run test:scroll` (from `apps/fluux`) — message-loading change (memory: sliding-window history).
- Manual repair paths keep their full grind: `forceCatchUpAllRooms` and "Load missing messages" (`MAM_ROOM_FORWARD_MAX_PAGES_MANUAL`) do NOT bail and are untouched.
- Before any commit: `npx vitest run` in `packages/fluux-sdk` green with no stderr; root `npm run typecheck`; root `npm run lint`.
- Never include a Claude footer in commit messages.
- Paths are relative to the worktree root `…/.claude/worktrees/message-loading-gaps-c50347`.

## Key Machinery Facts (read before implementing)

- `resolveRemoteDisplayed` (`packages/fluux-sdk/src/stores/shared/readMarkerSync.ts:46`) needs the pointer's OWN message in the loaded array; both stores re-attempt resolution after EVERY merge (`chatStore.ts:1816-1821`), synchronously inside the query's emit — reading `pendingRemoteDisplayedStanzaId` between orchestrator phases is race-free, including for non-resident entities (`mergedForMarker` override).
- Non-active FORWARD merges hydrate badges via `recomputeCountsFromPointer` (`chatStore.ts:1744`); pointer resolution `advanced` recomputes too (`chatStore.ts:1237`). Exactness needs all post-pointer messages loaded — Phase B's stop condition.
- `prependOlderMessages` (`messageArrayUtils.ts:271`) prepends WITHOUT full sort + trims keep-OLDEST → corrupts a fetch-latest page merged above a non-empty resident array (Task 2 adds the fetch-latest mode).
- `setMAMQueryCompleted` (`mamState.ts:98`): `isCaughtUpToLive = direction === 'forward' ? complete : current` — Task 2 extends it for fetch-latest.
- Backward pages with zero displayable messages still return `rsm.first` (existing "no displayable messages, fetching older" pagination) — Phase B's cursor threading must use `rsm.first`, not message contents.
- `pendingRemoteDisplayedStanzaId` is session state, re-seeded by the MDS fetch at connect — Phase B convergence across sessions is automatic.

---

### Task 1: Revert the superseded `backfillLatestIfEmpty` increment

The minimal fix implemented earlier this session is superseded. Nothing was committed; revert the working tree.

**Files:** all uncommitted changes under `packages/fluux-sdk/src` (types/pagination.ts, modules/MAM.ts, chatSideEffects.ts, roomSideEffects.ts, and the four test files).

- [ ] **Step 1: Revert via git**

Run: `git -C /Users/mremond/AIProjects/fluux-messenger/.claude/worktrees/message-loading-gaps-c50347 checkout -- packages/fluux-sdk/src`

- [ ] **Step 2: Verify clean tree and green baseline**

Run: `git status --short` → only the plan file. Then `cd packages/fluux-sdk && npx vitest run src/core/modules/Chat.mam.test.ts src/core/modules/MAM.catchup.test.ts src/core/chatSideEffects.test.ts src/core/roomSideEffects.test.ts` → PASS.

No commit (tree equals HEAD).

---

### Task 2: Fetch-latest merge mode + caught-up-to-live on fetch-latest

Two coupled semantics of "the window is now at the live edge":

(a) **Merge mode** — a `before:''` page can land ABOVE a non-empty resident array (bail case): dedupe + full sort + keep-NEWEST instead of prepend/keep-oldest; `windowAtLiveEdge` flips true.
(b) **Caught-up state** — a successful fetch-latest puts the entity at the live edge by definition (SM/carbons own everything newer), so it must set `isCaughtUpToLive`; otherwise `selectRoomsNeedingResumeSeed` re-queries such entities on every SM resume, forever (flaw F2).

**Files:**
- Modify: `packages/fluux-sdk/src/stores/shared/messageTimeline.ts` (`mergeArchive`)
- Modify: `packages/fluux-sdk/src/stores/shared/mamState.ts` (`setMAMQueryCompleted`)
- Modify: `packages/fluux-sdk/src/stores/chatStore.ts` (`mergeMAMMessages`: thread `isFetchLatest` into both calls; `windowAtLiveEdge`)
- Modify: `packages/fluux-sdk/src/stores/roomStore.ts` (twin changes in `mergeRoomMAMMessages`)
- Test: `packages/fluux-sdk/src/stores/shared/messageTimeline.test.ts`, `packages/fluux-sdk/src/stores/shared/mamState.test.ts`

**Interfaces:**
- Produces: `mergeArchive(messages, incoming, direction, config, isFetchLatest?: boolean)`; `setMAMQueryCompleted(states, id, complete, direction, oldestFetchedId?, newestFetchedTimestamp?, preserveGapMarker?, isFetchLatest?: boolean)`.

- [ ] **Step 1: Write the failing timeline tests**

Add to `messageTimeline.test.ts` (adapt to the file's local `TestMessage`/config fixtures):

```typescript
describe('mergeArchive fetch-latest mode', () => {
  it('merges a latest page ABOVE resident history with full sort + keep-newest', () => {
    const existing = [
      { id: 'old-1', timestamp: new Date('2026-06-01T10:00:00Z') },
      { id: 'old-2', timestamp: new Date('2026-06-01T11:00:00Z') },
    ] as TestMessage[]
    const incoming = [
      { id: 'new-1', timestamp: new Date('2026-07-16T09:00:00Z') },
      { id: 'new-2', timestamp: new Date('2026-07-16T10:00:00Z') },
    ] as TestMessage[]

    const result = mergeArchive(existing, incoming, 'backward', config, true)

    expect(result.merged.map((m) => m.id)).toEqual(['old-1', 'old-2', 'new-1', 'new-2'])
    expect(result.newestEvicted).toBe(false)
  })

  it('keeps the NEWEST window when the merge exceeds the cap (window jumps to live)', () => {
    const existing = Array.from({ length: 4 }, (_, i) => ({
      id: `old-${i}`, timestamp: new Date(2026, 5, 1, 10, i),
    })) as TestMessage[]
    const incoming = Array.from({ length: 3 }, (_, i) => ({
      id: `new-${i}`, timestamp: new Date(2026, 6, 16, 10, i),
    })) as TestMessage[]

    const result = mergeArchive(existing, incoming, 'backward', { ...config, windowSize: 4 }, true)

    expect(result.merged.map((m) => m.id)).toEqual(['old-3', 'new-0', 'new-1', 'new-2'])
    expect(result.newestEvicted).toBe(false)
  })

  it('plain backward merges are unchanged when isFetchLatest is false', () => {
    const existing = [{ id: 'new-1', timestamp: new Date('2026-07-16T10:00:00Z') }] as TestMessage[]
    const incoming = [{ id: 'old-1', timestamp: new Date('2026-06-01T10:00:00Z') }] as TestMessage[]

    const result = mergeArchive(existing, incoming, 'backward', config)

    expect(result.merged.map((m) => m.id)).toEqual(['old-1', 'new-1'])
  })
})
```

And to `mamState.test.ts`:

```typescript
describe('setMAMQueryCompleted fetch-latest', () => {
  it('marks caught-up-to-live on a fetch-latest merge (window is at the live edge by definition)', () => {
    const states = setMAMQueryCompleted(new Map(), 'a@b.c', false, 'backward', undefined, undefined, false, true)
    expect(states.get('a@b.c')?.isCaughtUpToLive).toBe(true)
  })

  it('plain backward completion still does not mark caught-up-to-live', () => {
    const states = setMAMQueryCompleted(new Map(), 'a@b.c', true, 'backward')
    expect(states.get('a@b.c')?.isCaughtUpToLive).toBe(false)
  })
})
```

- [ ] **Step 2: Run to verify failure**

Run: `cd packages/fluux-sdk && npx vitest run src/stores/shared/messageTimeline.test.ts src/stores/shared/mamState.test.ts`
Expected: FAIL — misordered merge / `isCaughtUpToLive` false.

- [ ] **Step 3: Implement `mergeArchive` mode**

```typescript
export function mergeArchive<T extends TimelineMessage>(
  messages: T[],
  incoming: T[],
  direction: 'backward' | 'forward',
  config: TimelineConfig<T>,
  isFetchLatest = false
): MergeArchiveResult<T> {
  const { messages: existing, patched } = backfillArchiveIds(messages, incoming, config.getKeys)

  // Fetch-latest pages land at the LIVE edge and may sit entirely ABOVE the
  // resident window (bail after an incomplete forward catch-up). The backward
  // prepend assumes incoming pages are older — it would misorder them and
  // keep-oldest could evict the fresh page — so fetch-latest gets dedupe +
  // full sort + keep-NEWEST (the window jumps to live, like jump-to-latest).
  const { merged, newMessages } =
    direction === 'backward' && !isFetchLatest
      ? prependOlderMessages(existing, incoming, config.getKeys, config.windowSize)
      : mergeAndProcessMessages(existing, incoming, config.getKeys, config.windowSize)

  if (newMessages.length === 0 && patched.length === 0) {
    return { merged: messages, newMessages, patched, newestEvicted: false }
  }

  const newestEvicted =
    direction === 'backward' &&
    !isFetchLatest &&
    merged[merged.length - 1]?.id !== existing[existing.length - 1]?.id

  return { merged, newMessages, patched, newestEvicted }
}
```

(`mergeAndProcessMessages` is the existing forward path — verify its actual name at the top of the file and reuse.)

- [ ] **Step 4: Implement `setMAMQueryCompleted` extension**

Add trailing param `isFetchLatest = false`; change the computation:

```typescript
  // Forward: complete === reached live. Fetch-latest: the window IS the live
  // edge by definition (SM/carbons own everything newer), regardless of
  // `complete` (which only says whether OLDER history is exhausted) — without
  // this, an entity synced via fetch-latest is re-seeded on every SM resume.
  const isCaughtUpToLive = direction === 'forward'
    ? complete
    : isFetchLatest
      ? true
      : current.isCaughtUpToLive
```

- [ ] **Step 5: Thread from both stores**

`chatStore.ts` `mergeMAMMessages`: pass `isFetchLatest` as the 5th arg of `timeline.mergeArchive(...)` and the 8th arg of `mamState.setMAMQueryCompleted(...)`; in the ACTIVE branch extend the `windowAtLiveEdge` handling:

```typescript
          let newWindowAtLiveEdge = state.windowAtLiveEdge
          if (newestEvicted) {
            newWindowAtLiveEdge = new Map(state.windowAtLiveEdge)
            newWindowAtLiveEdge.set(conversationId, false)
          } else if (isFetchLatest && newMessages.length > 0) {
            // Fetch-latest lands the window AT the live edge by construction.
            newWindowAtLiveEdge = new Map(state.windowAtLiveEdge)
            newWindowAtLiveEdge.set(conversationId, true)
          }
```

Apply the identical three changes in `roomStore.ts` `mergeRoomMAMMessages` (find its `timeline.mergeArchive(` / `setMAMQueryCompleted(` calls and its live-edge map name).

- [ ] **Step 6: Run store suites**

Run: `cd packages/fluux-sdk && npx vitest run src/stores`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/fluux-sdk/src/stores
git commit -m "feat(mam): fetch-latest merge mode — keep-newest above resident history, marks caught-up-to-live"
```

---

### Task 3: `selectCatchUpQuery` — id-anchored coverage cursor + the two caps

New first-query policy built on the COVERAGE pointer: recorded gap → resume `after: gap.startId` (id-exact) or `start: gap-ts` fallback; else newest pre-session cached message → `after: <its stanza-id>` (id-exact) or `start: ts+1ms` fallback when it has no stanza-id; else `{before: ''}`. The MDS pointer-seed and preview-timestamp anchors are retired. `after` here means the LOCAL coverage id — never the read pointer.

**Files:**
- Modify: `packages/fluux-sdk/src/utils/mamCatchUpUtils.ts`
- Test: `packages/fluux-sdk/src/utils/mamCatchUpUtils.test.ts`

**Interfaces:**
- Produces:
  - `selectCatchUpQuery(messages: Array<{ timestamp?: Date; stanzaId?: string }>, options?: { sessionStartTime?: number; forwardGapTimestamp?: number; forwardGapStartId?: string }): { after?: string; start?: string; before?: string }` (`pointerStanzaId`/`fallbackNewestTimestamp` deleted; `after` = coverage archive id)
  - `export const MAM_CATCHUP_FORWARD_BAIL_PAGES = 3`
  - `export const MAM_POINTER_STITCH_MAX_PAGES = 10`

- [ ] **Step 1: Rewrite the failing tests**

Delete `describe('selectCatchUpQuery pointerStanzaId', ...)` and any `fallbackNewestTimestamp` tests in `mamCatchUpUtils.test.ts`; add:

```typescript
describe('selectCatchUpQuery (latest-first, id-anchored coverage cursor)', () => {
  it('returns before:"" when the local cache is empty', () => {
    expect(selectCatchUpQuery([])).toEqual({ before: '' })
  })

  it('anchors by ARCHIVE ID when the newest pre-session message has a stanza-id', () => {
    const messages = [
      { timestamp: new Date('2026-05-14T09:00:00.000Z'), stanzaId: 'cov-42' },
      { timestamp: new Date('2026-06-14T12:00:05.000Z'), stanzaId: 'live-1' }, // this session
    ]
    expect(selectCatchUpQuery(messages, { sessionStartTime: new Date('2026-06-14T12:00:00Z').getTime() }))
      .toEqual({ after: 'cov-42' })
  })

  it('falls back to a timestamp anchor when the coverage message has no stanza-id', () => {
    const messages = [{ timestamp: new Date('2026-05-14T09:00:00.000Z') }]
    expect(selectCatchUpQuery(messages, { sessionStartTime: new Date('2026-06-14T12:00:00Z').getTime() }))
      .toEqual({ start: '2026-05-14T09:00:00.001Z' })
  })

  it('prefers the recorded gap boundary (id-exact) over newer cached messages', () => {
    const messages = [{ timestamp: new Date('2026-06-01T12:00:00Z'), stanzaId: 'newer' }]
    expect(selectCatchUpQuery(messages, {
      forwardGapTimestamp: new Date('2026-05-14T09:00:00.000Z').getTime(),
      forwardGapStartId: 'gap-edge-7',
    })).toEqual({ after: 'gap-edge-7' })
  })

  it('resumes a recorded gap by timestamp when it carries no id (legacy persisted gap)', () => {
    const messages = [{ timestamp: new Date('2026-06-01T12:00:00Z'), stanzaId: 'newer' }]
    expect(selectCatchUpQuery(messages, { forwardGapTimestamp: new Date('2026-05-14T09:00:00.000Z').getTime() }))
      .toEqual({ start: '2026-05-14T09:00:00.001Z' })
  })

  it('returns before:"" when every cached message is from this session', () => {
    const messages = [{ timestamp: new Date('2026-06-14T12:00:05.000Z'), stanzaId: 's1' }]
    expect(selectCatchUpQuery(messages, { sessionStartTime: new Date('2026-06-14T12:00:00Z').getTime() }))
      .toEqual({ before: '' })
  })
})
```

- [ ] **Step 2: Run to verify failure**

Run: `cd packages/fluux-sdk && npx vitest run src/utils/mamCatchUpUtils.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

Constants (below `MAM_CATCHUP_BACKWARD_MAX`):

```typescript
/** Max auto-pages for the INITIAL forward catch-up phase before bailing to a
 *  fetch-latest (3 × 100 = 300 messages fetched exactly). Beyond this the
 *  orchestrator jumps the window to the live edge and leaves the hole as a
 *  recorded seam, closed lazily (scroll-up / "Load missing"). Manual repair
 *  paths keep MAM_ROOM_FORWARD_MAX_PAGES_MANUAL and never bail. */
export const MAM_CATCHUP_FORWARD_BAIL_PAGES = 3

/** Max backward pages per catch-up pass while growing the window down to an
 *  unresolved XEP-0490 read pointer (10 × 100 = 1000 messages). A deeper
 *  pointer stays pending and later passes resume from the (deeper) cache —
 *  the seam marker keeps the remaining hole honest meanwhile. */
export const MAM_POINTER_STITCH_MAX_PAGES = 10
```

Replace `CatchUpQuery`/`CatchUpQueryOptions`/`selectCatchUpQuery`:

```typescript
/** Result of {@link selectCatchUpQuery}: an id-exact forward `after` cursor
 *  (the COVERAGE pointer — newest contiguously-downloaded archive id), a
 *  timestamp `start` fallback, or a backward `before: ''` fetch-latest when
 *  there is no local edge to resume from. */
export interface CatchUpQuery {
  after?: string
  start?: string
  before?: string
}

/** Optional inputs for {@link selectCatchUpQuery}. */
export interface CatchUpQueryOptions {
  /** Epoch ms the session connected. The cached cursor excludes this-session
   *  messages so a live message can't poison it. Omitted → use the global newest. */
  sessionStartTime?: number
  /** Epoch ms of a recorded forward gap. When set it WINS: resume from the hole
   *  boundary instead of from newer cached messages above it. */
  forwardGapTimestamp?: number
  /** Archive id of the last downloaded message below the recorded gap
   *  (GapInterval.startId) — preferred over the timestamp when present. */
  forwardGapStartId?: string
}

/**
 * The single, shared FIRST-query policy for BOTH 1:1 and MUC catch-up
 * (background sync + active-entity side effects), latest-first model built on
 * the per-device COVERAGE pointer:
 *
 * - recorded gap boundary, else newest pre-session cached message → forward
 *   from the contiguous local edge, id-exact (`after: <archive id>`) whenever
 *   the edge carries a stanza-id — RSM ordering is defined by id, so this is
 *   immune to same-millisecond timestamp collisions and gets an explicit
 *   item-not-found signal when the anchor was purged. Timestamp `start` is the
 *   fallback for edges without a stanza-id (e.g. own-sent never archived);
 * - no usable local edge → `{ before: '' }` fetch-latest, so the entity always
 *   renders recent history in one round-trip.
 *
 * The XEP-0490 READ pointer never drives this anchor (that conflation was
 * #869's bug): the orchestrator grows the window BACKWARD to it afterwards
 * (see MAM.catchUpConversationHistory), and the #1019 seam machinery records
 * any disjoint edge for lazy healing.
 */
export function selectCatchUpQuery(
  messages: Array<{ timestamp?: Date; stanzaId?: string }>,
  options: CatchUpQueryOptions = {},
): CatchUpQuery {
  const { sessionStartTime, forwardGapTimestamp, forwardGapStartId } = options

  // A recorded forward gap wins: resume from the hole boundary, id-exact when
  // the seam carries its last-downloaded id.
  if (forwardGapStartId) return { after: forwardGapStartId }
  if (forwardGapTimestamp !== undefined) {
    return { start: buildCatchUpStartTime(new Date(forwardGapTimestamp)) }
  }

  const cursor = sessionStartTime !== undefined
    ? findCatchUpCursorMessage(messages, sessionStartTime)
    : findNewestMessage(messages)
  if (cursor?.timestamp) {
    const stanzaId = (cursor as { stanzaId?: string }).stanzaId
    return stanzaId ? { after: stanzaId } : { start: buildCatchUpStartTime(cursor.timestamp) }
  }

  return { before: '' }
}
```

Leave `findNewestMessage`, `findCatchUpCursorMessage`, `buildCatchUpStartTime`, `findContinueCatchUpCursor`, `selectRoomsNeedingResumeSeed`, `isConnectionError` untouched (the "Load missing" id-resume lands in Task 6).

- [ ] **Step 4: Run utils tests**

Run: `cd packages/fluux-sdk && npx vitest run src/utils/mamCatchUpUtils.test.ts`
Expected: PASS. (SDK-wide compile breaks resolve in Tasks 4-7; commit lands at Task 7.)

---

### Task 4: Orchestrator `catchUpConversationHistory`

**Files:**
- Modify: `packages/fluux-sdk/src/core/modules/MAM.ts`
- Test: `packages/fluux-sdk/src/core/modules/MAM.catchup.test.ts`

**Interfaces:**
- Consumes: Task 3 policy + caps; existing deps getters `chat.getConversationGapStart`, `chat.getConversationPendingStanzaId`.
- Produces:

```typescript
async catchUpConversationHistory(
  conversationId: string,
  messages: Array<{ timestamp?: Date }>,
  options?: { sessionStartTime?: number; stitchReadPointer?: boolean },
): Promise<void>
```

`stitchReadPointer: true` is passed ONLY by background sync (flaw F4: backward growth into the ACTIVE resident window would keep-oldest-evict the live edge; the active entity's deep-pointer UX is owned by the activation machinery).

- [ ] **Step 1: Write the failing tests**

New describe in `MAM.catchup.test.ts` after `catchUpAllConversations`:

```typescript
  describe('catchUpConversationHistory (latest-first orchestrator)', () => {
    const setupChat = (pending: string | undefined) => {
      vi.mocked(mockStores.chat.getConversationGapStart!).mockReturnValue(undefined)
      vi.mocked(mockStores.chat.getConversationPendingStanzaId!).mockReturnValue(pending)
    }

    it('empty cache: single fetch-latest; no growth when the pointer resolved inside the window', async () => {
      await connectClient()
      setupChat('mds-ptr')

      const querySpy = vi.spyOn(xmppClient.mam, 'queryArchive').mockImplementation(async () => {
        // The fetch-latest merge resolved the pointer (its message was in the page).
        vi.mocked(mockStores.chat.getConversationPendingStanzaId!).mockReturnValue(undefined)
        return { messages: [], complete: false, rsm: { first: 'w-bottom' } }
      })

      await xmppClient.mam.catchUpConversationHistory('alice@example.com', [], { stitchReadPointer: true })

      expect(querySpy).toHaveBeenCalledTimes(1)
      expect(querySpy).toHaveBeenCalledWith(expect.objectContaining({ with: 'alice@example.com', before: '' }))
    })

    it('empty cache + deep pointer: grows the window backward page by page until the pointer resolves', async () => {
      await connectClient()
      setupChat('mds-ptr')

      const calls: any[] = []
      vi.spyOn(xmppClient.mam, 'queryArchive').mockImplementation(async (opts: any) => {
        calls.push(opts)
        if (opts.before === 'page-1-first') {
          // Second backward page contained the pointer's message → resolved.
          vi.mocked(mockStores.chat.getConversationPendingStanzaId!).mockReturnValue(undefined)
          return { messages: [], complete: false, rsm: { first: 'page-2-first' } }
        }
        if (opts.before === '') return { messages: [], complete: false, rsm: { first: 'w-bottom' } }
        return { messages: [], complete: false, rsm: { first: 'page-1-first' } }
      })

      await xmppClient.mam.catchUpConversationHistory('alice@example.com', [], { stitchReadPointer: true })

      expect(calls.map((c) => c.before)).toEqual(['', 'w-bottom', 'page-1-first'])
    })

    it('stops growing at the archive start (purged pointer) instead of looping', async () => {
      await connectClient()
      setupChat('mds-ptr')

      const calls: any[] = []
      vi.spyOn(xmppClient.mam, 'queryArchive').mockImplementation(async (opts: any) => {
        calls.push(opts)
        if (opts.before === '') return { messages: [], complete: false, rsm: { first: 'w-bottom' } }
        return { messages: [], complete: true, rsm: { first: 'page-1-first' } } // archive start
      })

      await xmppClient.mam.catchUpConversationHistory('alice@example.com', [], { stitchReadPointer: true })

      expect(calls).toHaveLength(2)
    })

    it('respects the per-pass page cap for a very deep pointer', async () => {
      await connectClient()
      setupChat('mds-ptr')

      let n = 0
      const querySpy = vi.spyOn(xmppClient.mam, 'queryArchive').mockImplementation(async () => {
        n++
        return { messages: [], complete: false, rsm: { first: `page-${n}-first` } }
      })

      await xmppClient.mam.catchUpConversationHistory('alice@example.com', [], { stitchReadPointer: true })

      // 1 fetch-latest + MAM_POINTER_STITCH_MAX_PAGES backward pages
      expect(querySpy).toHaveBeenCalledTimes(1 + 10)
    })

    it('does NOT grow toward the pointer when stitchReadPointer is off (active entity)', async () => {
      await connectClient()
      setupChat('mds-ptr')

      const querySpy = vi.spyOn(xmppClient.mam, 'queryArchive')
        .mockResolvedValue({ messages: [], complete: false, rsm: { first: 'w-bottom' } })

      await xmppClient.mam.catchUpConversationHistory('alice@example.com', [])

      expect(querySpy).toHaveBeenCalledTimes(1)
    })

    it('non-empty cache: id-exact forward from the coverage edge with the bail cap; done when complete', async () => {
      await connectClient()
      setupChat(undefined)

      const querySpy = vi.spyOn(xmppClient.mam, 'queryArchive')
        .mockResolvedValue({ messages: [], complete: true, rsm: {} })

      const cached = [{ timestamp: new Date('2026-05-14T09:00:00.000Z'), stanzaId: 'cov-42' }]
      await xmppClient.mam.catchUpConversationHistory('alice@example.com', cached, { sessionStartTime: new Date('2026-06-14T12:00:00Z').getTime() })

      expect(querySpy).toHaveBeenCalledTimes(1)
      expect(querySpy).toHaveBeenCalledWith(expect.objectContaining({
        after: 'cov-42', // COVERAGE id, not the read pointer
        maxAutoPages: 3, // MAM_CATCHUP_FORWARD_BAIL_PAGES
      }))
    })

    it('non-empty cache without stanza-ids: timestamp fallback anchor', async () => {
      await connectClient()
      setupChat(undefined)

      const querySpy = vi.spyOn(xmppClient.mam, 'queryArchive')
        .mockResolvedValue({ messages: [], complete: true, rsm: {} })

      const cached = [{ timestamp: new Date('2026-05-14T09:00:00.000Z') }]
      await xmppClient.mam.catchUpConversationHistory('alice@example.com', cached, { sessionStartTime: new Date('2026-06-14T12:00:00Z').getTime() })

      expect(querySpy).toHaveBeenCalledWith(expect.objectContaining({
        start: '2026-05-14T09:00:00.001Z',
        maxAutoPages: 3,
      }))
    })

    it('non-empty cache, long gap: bails to a fetch-latest when the forward phase ends incomplete', async () => {
      await connectClient()
      setupChat(undefined)

      const calls: any[] = []
      vi.spyOn(xmppClient.mam, 'queryArchive').mockImplementation(async (opts: any) => {
        calls.push(opts)
        if (opts.start) return { messages: [], complete: false, rsm: { last: 'x' } }
        return { messages: [], complete: false, rsm: { first: 'w-bottom' } }
      })

      const cached = [{ timestamp: new Date('2026-05-14T09:00:00.000Z') }]
      await xmppClient.mam.catchUpConversationHistory('alice@example.com', cached, { sessionStartTime: new Date('2026-06-14T12:00:00Z').getTime() })

      expect(calls).toHaveLength(2)
      expect(calls[0]).toMatchObject({ start: '2026-05-14T09:00:00.001Z' })
      expect(calls[1]).toMatchObject({ before: '' })
    })
  })
```

Also rewrite the obsolete anchor tests in `catchUpAllConversations` (they are rewired in Task 7 but live in this file): replace `'forward-fills from the persisted last-known timestamp when the message cache is empty (issue #135)'` with:

```typescript
    it('fetch-latest for a persisted conversation whose cache is empty this run (preview anchor retired)', async () => {
      await connectClient()
      vi.mocked(mockStores.chat.getAllConversations).mockReturnValue([{ id: 'alice@example.com', messages: [] }] as any)
      vi.mocked(mockStores.chat.getConversationGapStart!).mockReturnValue(undefined)
      vi.mocked(mockStores.chat.getConversationLastTimestamp!).mockReturnValue(new Date('2026-05-14T09:00:00Z').getTime())

      const querySpy = vi.spyOn(xmppClient.mam, 'queryArchive').mockResolvedValue({ messages: [], complete: false, rsm: {} })

      const catchUpPromise = xmppClient.mam.catchUpAllConversations({ sessionStartTime: new Date('2026-06-14T12:00:00Z').getTime() })
      await waitForAsyncOps(20, 100)
      await catchUpPromise

      expect(querySpy).toHaveBeenCalledWith(expect.objectContaining({ with: 'alice@example.com', before: '' }))
      expect(querySpy).not.toHaveBeenCalledWith(expect.objectContaining({ start: expect.any(String) }))
    })
```

- [ ] **Step 2: Run to verify failure**

Run: `cd packages/fluux-sdk && npx vitest run src/core/modules/MAM.catchup.test.ts -t 'catchUpConversationHistory'`
Expected: FAIL — method missing.

- [ ] **Step 3: Implement**

In `MAM.ts` (import `MAM_CATCHUP_FORWARD_BAIL_PAGES`, `MAM_POINTER_STITCH_MAX_PAGES`), add after `catchUpConversations`:

```typescript
  /**
   * Latest-first catch-up orchestrator for one 1:1 conversation, shared by the
   * active-conversation side effect and background sync.
   *
   * PHASE A — align to live:
   *   cache has messages → forward from the contiguous local edge, capped at
   *   MAM_CATCHUP_FORWARD_BAIL_PAGES (exact and cheap in the common reconnect
   *   case). Incomplete → the gap is long: BAIL with a `before:''` fetch-latest
   *   so the window jumps to the live edge. The incomplete forward records the
   *   gap and the fetch-latest reconciliation (#1019 seam machinery) keeps it
   *   honest as ONE interval, closed lazily. Empty cache → fetch-latest
   *   directly (recent history renders in one round-trip).
   *
   * PHASE B — grow to the read pointer (opt-in, background entities only):
   *   while the XEP-0490 pointer is unresolved, page BACKWARD from the window
   *   bottom. Backward growth keeps held history contiguous BY CONSTRUCTION
   *   (each page is adjacent to the window — no second hole can form), each
   *   merge shrinks the recorded seam (closeGapWithBackwardPage), and the page
   *   containing the pointer's own message resolves it (RSM `after` would
   *   never fetch its anchor). Resolution recomputes exact unread. Stops on:
   *   resolution, archive start (a still-pending pointer was purged — cheap
   *   re-walk next session), missing cursor, or MAM_POINTER_STITCH_MAX_PAGES
   *   (deeper pointers converge across passes from the deeper cache).
   *
   *   NOT run for the active entity: backward pages into its capped resident
   *   window would keep-oldest-evict the live edge under the user; the
   *   activation machinery (load-around + entry fold + spec §5 degrade) owns
   *   the active deep-pointer UX.
   *
   * Merges run synchronously inside each query's emit, so reading the pending
   * pointer between queries observes the previous merge's resolution — for
   * non-resident entities too (mergedForMarker override).
   */
  async catchUpConversationHistory(
    conversationId: string,
    messages: Array<{ timestamp?: Date; stanzaId?: string }>,
    options: { sessionStartTime?: number; stitchReadPointer?: boolean } = {},
  ): Promise<void> {
    const { sessionStartTime, stitchReadPointer = false } = options
    const gapStart = this.deps.stores?.chat.getConversationGapStart?.(conversationId)
    // (Task 6 threads forwardGapStartId from the persisted seam here.)
    const q = selectCatchUpQuery(messages, { sessionStartTime, forwardGapTimestamp: gapStart })
    const isForward = !!(q.start || q.after)

    // Phase A — align to live, anchored on the COVERAGE pointer (id-exact
    // when available; `after` here is the local downloaded edge, never the
    // XEP-0490 read pointer).
    const initial = await this.queryArchive({
      with: conversationId,
      ...q,
      max: isForward ? MAM_CATCHUP_FORWARD_MAX : MAM_CATCHUP_BACKWARD_MAX,
      ...(isForward ? { maxAutoPages: MAM_CATCHUP_FORWARD_BAIL_PAGES } : {}),
    })
    let windowBottom: string | undefined
    if (isForward && !initial.complete) {
      const latest = await this.queryArchive({ with: conversationId, max: MAM_CATCHUP_BACKWARD_MAX, before: '' })
      windowBottom = latest.rsm.first
    } else if (!isForward) {
      windowBottom = initial.rsm.first
    }
    // (forward && complete → contiguous to live over the cache; a pending
    // pointer, if any, lives in the cache and the activation machinery
    // resolves it — no backward growth needed.)

    // Phase B — grow the window down to the read pointer.
    if (!stitchReadPointer) return
    for (let page = 0; page < MAM_POINTER_STITCH_MAX_PAGES; page++) {
      if (!this.deps.stores?.chat.getConversationPendingStanzaId?.(conversationId)) return
      if (!windowBottom) return
      const res = await this.queryArchive({
        with: conversationId,
        before: windowBottom,
        max: MAM_CATCHUP_FORWARD_MAX,
      })
      if (res.complete) return // archive start reached — a still-pending pointer is purged
      if (!res.rsm.first || res.rsm.first === windowBottom) return
      windowBottom = res.rsm.first
    }
  }
```

- [ ] **Step 4: Run tests**

Run: `cd packages/fluux-sdk && npx vitest run src/core/modules/MAM.catchup.test.ts -t 'catchUpConversationHistory'`
Expected: PASS. (Older `catchUpAllConversations` tests may fail until Task 7 rewires — expected.)

No commit yet.

---

### Task 5: Room twin `catchUpRoomHistory`

**Files:**
- Modify: `packages/fluux-sdk/src/core/modules/MAM.ts`
- Test: `packages/fluux-sdk/src/core/modules/MAM.catchup.test.ts`

**Interfaces:**
- Produces: `async catchUpRoomHistory(roomJid: string, messages: Array<{ timestamp?: Date }>, options?: { sessionStartTime?: number; stitchReadPointer?: boolean }): Promise<void>`

- [ ] **Step 1: Write the failing tests**

Mirror Task 4's describe over `queryRoomArchive` for the three central shapes:

```typescript
  describe('catchUpRoomHistory (latest-first orchestrator, room twin)', () => {
    const roomJid = 'room1@conference.example.com'
    const setupRoom = (pending: string | undefined) => {
      vi.mocked(mockStores.room.getRoomGapStart!).mockReturnValue(undefined)
      vi.mocked(mockStores.room.getRoomPendingStanzaId!).mockReturnValue(pending)
      vi.mocked(mockStores.room.getRoom).mockReturnValue({ jid: roomJid, nickname: 'me' } as any)
    }

    it('empty cache: single fetch-latest; no growth when the pointer resolved inside the window', async () => {
      await connectClient()
      setupRoom('mds-ptr')

      const querySpy = vi.spyOn(xmppClient.mam, 'queryRoomArchive').mockImplementation(async () => {
        vi.mocked(mockStores.room.getRoomPendingStanzaId!).mockReturnValue(undefined)
        return { messages: [], complete: false, rsm: { first: 'w-bottom' } }
      })

      await xmppClient.mam.catchUpRoomHistory(roomJid, [], { stitchReadPointer: true })

      expect(querySpy).toHaveBeenCalledTimes(1)
      expect(querySpy).toHaveBeenCalledWith(expect.objectContaining({ roomJid, before: '' }))
    })

    it('empty cache + deep pointer: grows the window backward until the pointer resolves', async () => {
      await connectClient()
      setupRoom('mds-ptr')

      const calls: any[] = []
      vi.spyOn(xmppClient.mam, 'queryRoomArchive').mockImplementation(async (opts: any) => {
        calls.push(opts)
        if (opts.before === 'page-1-first') {
          vi.mocked(mockStores.room.getRoomPendingStanzaId!).mockReturnValue(undefined)
          return { messages: [], complete: false, rsm: { first: 'page-2-first' } }
        }
        if (opts.before === '') return { messages: [], complete: false, rsm: { first: 'w-bottom' } }
        return { messages: [], complete: false, rsm: { first: 'page-1-first' } }
      })

      await xmppClient.mam.catchUpRoomHistory(roomJid, [], { stitchReadPointer: true })

      expect(calls.map((c) => c.before)).toEqual(['', 'w-bottom', 'page-1-first'])
    })

    it('non-empty cache, long gap: bails to a fetch-latest when the forward phase ends incomplete', async () => {
      await connectClient()
      setupRoom(undefined)

      const calls: any[] = []
      vi.spyOn(xmppClient.mam, 'queryRoomArchive').mockImplementation(async (opts: any) => {
        calls.push(opts)
        if (opts.start) return { messages: [], complete: false, rsm: { last: 'x' } }
        return { messages: [], complete: false, rsm: { first: 'w-bottom' } }
      })

      const cached = [{ timestamp: new Date('2026-05-14T09:00:00.000Z') }]
      await xmppClient.mam.catchUpRoomHistory(roomJid, cached, { sessionStartTime: new Date('2026-06-14T12:00:00Z').getTime() })

      expect(calls).toHaveLength(2)
      expect(calls[0]).toMatchObject({ start: '2026-05-14T09:00:00.001Z', maxAutoPages: 3 })
      expect(calls[1]).toMatchObject({ before: '' })
    })
  })
```

- [ ] **Step 2: Run to verify failure**

Run: `cd packages/fluux-sdk && npx vitest run src/core/modules/MAM.catchup.test.ts -t 'catchUpRoomHistory'`
Expected: FAIL — method missing.

- [ ] **Step 3: Implement**

Twin of Task 4's method with `queryRoomArchive`, `roomJid`, `room.getRoomGapStart`, `room.getRoomPendingStanzaId`; doc comment is one line: `/** Room twin of {@link catchUpConversationHistory} — same Phase A/B over queryRoomArchive. */`

```typescript
  /** Room twin of {@link catchUpConversationHistory} — same Phase A/B over queryRoomArchive. */
  async catchUpRoomHistory(
    roomJid: string,
    messages: Array<{ timestamp?: Date; stanzaId?: string }>,
    options: { sessionStartTime?: number; stitchReadPointer?: boolean } = {},
  ): Promise<void> {
    const { sessionStartTime, stitchReadPointer = false } = options
    const gapStart = this.deps.stores?.room.getRoomGapStart?.(roomJid)
    const q = selectCatchUpQuery(messages, { sessionStartTime, forwardGapTimestamp: gapStart })
    const isForward = !!(q.start || q.after)

    const initial = await this.queryRoomArchive({
      roomJid,
      ...q,
      max: isForward ? MAM_CATCHUP_FORWARD_MAX : MAM_CATCHUP_BACKWARD_MAX,
      ...(isForward ? { maxAutoPages: MAM_CATCHUP_FORWARD_BAIL_PAGES } : {}),
    })
    let windowBottom: string | undefined
    if (isForward && !initial.complete) {
      const latest = await this.queryRoomArchive({ roomJid, max: MAM_CATCHUP_BACKWARD_MAX, before: '' })
      windowBottom = latest.rsm.first
    } else if (!isForward) {
      windowBottom = initial.rsm.first
    }

    if (!stitchReadPointer) return
    for (let page = 0; page < MAM_POINTER_STITCH_MAX_PAGES; page++) {
      if (!this.deps.stores?.room.getRoomPendingStanzaId?.(roomJid)) return
      if (!windowBottom) return
      const res = await this.queryRoomArchive({
        roomJid,
        before: windowBottom,
        max: MAM_CATCHUP_FORWARD_MAX,
      })
      if (res.complete) return
      if (!res.rsm.first || res.rsm.first === windowBottom) return
      windowBottom = res.rsm.first
    }
  }
```

- [ ] **Step 4: Run tests**

Run: `cd packages/fluux-sdk && npx vitest run src/core/modules/MAM.catchup.test.ts -t 'catchUpRoomHistory'`
Expected: PASS.

No commit yet.

---

### Task 6: Seams carry the coverage id (`GapInterval.startId`/`endId`)

The persisted seam gains the "last downloaded archive id" below the hole (the user's MAM coverage marker) and the first held id above it, so gap resumes are id-exact. Optional fields — legacy persisted gaps simply lack them and fall back to timestamps (no migration).

**Files:**
- Modify: `packages/fluux-sdk/src/stores/shared/mamGap.ts` (`GapInterval`, `detectFetchLatestSeam`, `closeGapWithBackwardPage`, `syncGapAfterArchiveMerge` input + forward mirror)
- Modify: `packages/fluux-sdk/src/stores/chatStore.ts`, `packages/fluux-sdk/src/stores/roomStore.ts` (thread the two ids into `syncGapAfterArchiveMerge`)
- Modify: `packages/fluux-sdk/src/core/defaultStoreBindings.ts` (expose `getConversationGapStartId` / `getRoomGapStartId`), `packages/fluux-sdk/src/core/storeBindingKeys.ts` (memory: store-binding fan-out — new binding = both files + root typecheck)
- Modify: `packages/fluux-sdk/src/core/modules/MAM.ts` (orchestrators pass `forwardGapStartId`; the "Load missing" continue path prefers `after: startId` — find it via `grep -rn "findContinueCatchUpCursor" packages/fluux-sdk/src`)
- Test: `packages/fluux-sdk/src/stores/shared/mamGap.test.ts`, `packages/fluux-sdk/src/core/modules/MAM.catchup.test.ts`

**Interfaces:**
- Produces: `GapInterval { start: number; end?: number; startId?: string; endId?: string }`; `detectFetchLatestSeam(fetched, newMessagesCount, patchedCount, newestHeldBelowTs, newestHeldBelowId?)` stamps `startId`/`endId`; `syncGapAfterArchiveMerge` input gains `newestHeldBelowId?: string` and `lastFetchedArchiveId?: string` (forward mirror stamps `startId` on an incomplete forward gap); orchestrators read `getConversationGapStartId`/`getRoomGapStartId` and pass `forwardGapStartId` to `selectCatchUpQuery`.

- [ ] **Step 1: Write the failing mamGap tests**

```typescript
describe('GapInterval coverage ids', () => {
  it('detectFetchLatestSeam stamps the last-downloaded id below and the first held id above', () => {
    const fetched = [
      { timestamp: new Date('2026-07-16T10:00:00Z'), stanzaId: 'win-oldest' },
      { timestamp: new Date('2026-07-16T11:00:00Z'), stanzaId: 'win-newest' },
    ]
    const seam = detectFetchLatestSeam(fetched, 2, 0, new Date('2026-06-01T10:00:00Z').getTime(), 'cov-42')
    expect(seam).toMatchObject({ startId: 'cov-42', endId: 'win-oldest' })
  })

  it('closeGapWithBackwardPage moves endId down with the shrinking edge', () => {
    const gap = { start: 1000, end: 5000, startId: 'cov-42', endId: 'old-top' }
    const page = { oldestTs: 3000, newestTs: 4500 }
    const next = closeGapWithBackwardPage(gap, page, false, 'page-oldest-id')
    expect(next).toMatchObject({ start: 1000, end: 3000, startId: 'cov-42', endId: 'page-oldest-id' })
  })

  it('deserializeGaps tolerates legacy entries without ids', () => {
    const legacy = JSON.stringify([['a@b.c', { start: 1000, end: 2000 }]])
    expect(deserializeGaps(legacy).get('a@b.c')).toEqual({ start: 1000, end: 2000 })
  })
})
```

(Signature note: `closeGapWithBackwardPage` gains a trailing `pageOldestId?: string`; the seam-oldest id for `detectFetchLatestSeam` comes from the fetched page's oldest-timestamp message's `stanzaId` — add a tiny helper `oldestMessageStanzaId(fetched)` next to `messagePageExtent` and reuse it in both.)

- [ ] **Step 2: Run to verify failure**

Run: `cd packages/fluux-sdk && npx vitest run src/stores/shared/mamGap.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement mamGap changes**

- `GapInterval` gains `startId?: string; endId?: string` (doc: "archive id of the newest downloaded message below the gap — the per-device COVERAGE marker; id-exact resume cursor for the heal").
- Helper:

```typescript
/** stanzaId of the oldest-timestamp message in a page (undefined when absent). */
export function oldestMessageStanzaId(
  messages: Array<{ timestamp?: Date; stanzaId?: string }>,
): string | undefined {
  let oldest: { ts: number; id?: string } | undefined
  for (const m of messages) {
    const ts = m.timestamp?.getTime()
    if (ts === undefined) continue
    if (!oldest || ts < oldest.ts) oldest = { ts, id: m.stanzaId }
  }
  return oldest?.id
}
```

- `detectFetchLatestSeam(..., newestHeldBelowId?: string)`: final return becomes `{ start: newestHeldBelowTs, end: oldestTs, ...(newestHeldBelowId ? { startId: newestHeldBelowId } : {}), ...(endId ? { endId } : {}) }` with `const endId = oldestMessageStanzaId(fetched)`.
- `closeGapWithBackwardPage(gap, page, complete, pageOldestId?: string)`: the shrink branch returns `{ start: gap.start, end: page.oldestTs, ...(gap.startId ? { startId: gap.startId } : {}), ...(pageOldestId ? { endId: pageOldestId } : {}) }`; the clear/unchanged branches are untouched.
- `syncGapAfterArchiveMerge` input gains `newestHeldBelowId?: string` and `lastFetchedArchiveId?: string`; the forward mirror stamps `startId: lastFetchedArchiveId` when recording an incomplete forward gap; the backward path passes `oldestMessageStanzaId(fetched)` into `closeGapWithBackwardPage` and `newestHeldBelowId` into `detectFetchLatestSeam`.

- [ ] **Step 4: Thread from both stores**

In `chatStore.ts` `mergeMAMMessages`'s `syncGapAfterArchiveMerge({...})` call add:

```typescript
            newestHeldBelowId: [...rawExisting].sort((a, b) => (a.timestamp?.getTime() ?? 0) - (b.timestamp?.getTime() ?? 0)).at(-1)?.stanzaId,
            lastFetchedArchiveId: rsm.last,
```

(`rsm` is the merge's RSM param — for an incomplete forward catch-up `rsm.last` IS the last downloaded archive id.) Twin change in `roomStore.ts`. If the store merge signature doesn't receive `rsm.last` where the sync call sits, thread it — both merges already take `rsm` as a parameter.

- [ ] **Step 5: Expose gap-id getters and consume them**

- `defaultStoreBindings.ts`: `getConversationGapStartId: (id) => chatStore.getState().conversationGaps.get(id)?.startId` + room twin; register both in `storeBindingKeys.ts`.
- Orchestrators (Tasks 4-5 code): `const gapStartId = this.deps.stores?.chat.getConversationGapStartId?.(conversationId)` and pass `forwardGapStartId: gapStartId` to `selectCatchUpQuery` (room twin same).
- "Load missing" continue path: where `findContinueCatchUpCursor` feeds a `start:` query, prefer `after: gap.startId` when present (grep site, small conditional — keep `preserveGapMarker`/manual-cap semantics untouched).

- [ ] **Step 6: Orchestrator test for id-exact gap resume**

Add to the Task 4 describe:

```typescript
    it('resumes a recorded gap id-exact (after: seam startId)', async () => {
      await connectClient()
      setupChat(undefined)
      vi.mocked(mockStores.chat.getConversationGapStart!).mockReturnValue(new Date('2026-05-14T09:00:00Z').getTime())
      vi.mocked(mockStores.chat.getConversationGapStartId!).mockReturnValue('gap-edge-7')

      const querySpy = vi.spyOn(xmppClient.mam, 'queryArchive').mockResolvedValue({ messages: [], complete: true, rsm: {} })

      await xmppClient.mam.catchUpConversationHistory('alice@example.com', [{ timestamp: new Date('2026-06-01T12:00:00Z'), stanzaId: 'newer' }])

      expect(querySpy).toHaveBeenCalledWith(expect.objectContaining({ after: 'gap-edge-7' }))
    })
```

(Add `getConversationGapStartId`/`getRoomGapStartId` to `createMockStores` in `test-utils.ts`.)

- [ ] **Step 7: Run suites and commit**

Run: `cd packages/fluux-sdk && npx vitest run src/stores/shared/mamGap.test.ts src/core/modules/MAM.catchup.test.ts src/stores`
Expected: PASS. Run root `npm run typecheck` (store-binding fan-out gotcha).

```bash
git add -A packages/fluux-sdk
git commit -m "feat(mam): seams carry the coverage archive id — id-exact gap resume"
```

---

### Task 7: Rewire the four call sites and update their tests

**Files:**
- Modify: `packages/fluux-sdk/src/core/chatSideEffects.ts:106-123` (active 1:1 → Phase A only)
- Modify: `packages/fluux-sdk/src/core/roomSideEffects.ts:117-133` (active room → Phase A only)
- Modify: `packages/fluux-sdk/src/core/modules/MAM.ts` (`catchUpConversations` and `catchUpRoom` bodies → orchestrator with `stitchReadPointer: true`)
- Modify: wherever the side-effect client bridges `queryMAM`/`queryRoomMAM` — find with `grep -rn "queryMAM:" packages/fluux-sdk/src` and `grep -n "client\.\(chat\|mam\)\." packages/fluux-sdk/src/core/chatSideEffects.ts`; expose the two orchestrators on the same surface and extend the side-effect client interface type
- Test: `packages/fluux-sdk/src/core/chatSideEffects.test.ts`, `packages/fluux-sdk/src/core/roomSideEffects.test.ts`, `packages/fluux-sdk/src/core/sideEffects.testHelpers.ts` (mock client), `packages/fluux-sdk/src/core/modules/MAM.catchup.test.ts` (older anchor tests), `packages/fluux-sdk/src/core/test-utils.ts` and `apps/fluux/src/test-setup.ts` if the mock surfaces need the new methods (memory: new SDK export used by app → add to app mock)

**Interfaces:**
- Consumes: `catchUpConversationHistory` / `catchUpRoomHistory` (Tasks 4-6).
- Produces: no call site builds MAM anchor queries inline; `selectCatchUpQuery` is imported only by `MAM.ts` and its own test.

- [ ] **Step 1: Rewire `chatSideEffects.fetchMAMForConversation`**

Replace the cursor block + `queryMAM` call with:

```typescript
      // Latest-first orchestrator (shared with background sync). Active entity:
      // Phase A only — backward pointer growth would keep-oldest-evict the live
      // edge from the resident window; the activation machinery owns the active
      // deep-pointer UX. See MAM.catchUpConversationHistory.
      const cachedMessages = chatStore.getState().messages.get(conversationId) || []
      await client.mam.catchUpConversationHistory(conversationId, cachedMessages, { sessionStartTime })
```

Delete the unused `gapStart`/`lastTimestamp`/`pointerStanzaId` reads and now-unused imports.

- [ ] **Step 2: Rewire `roomSideEffects`**

```typescript
      // Latest-first orchestrator — room twin, Phase A only (active entity).
      const roomMessages = roomStore.getState().rooms.get(roomJid)?.messages || []
      await client.mam.catchUpRoomHistory(roomJid, roomMessages, { sessionStartTime })
```

- [ ] **Step 3: Rewire the two background sites in `MAM.ts`**

`catchUpConversations` per-conversation body:

```typescript
          const messages = cached && cached.length > 0 ? cached : (conv.messages ?? [])
          await this.catchUpConversationHistory(conv.id, messages, { sessionStartTime, stitchReadPointer: true })
```

`catchUpRoom` body:

```typescript
    const messages = (await this.deps.stores?.room.loadMessagesFromCache(roomJid, { limit: MAM_CACHE_LOAD_LIMIT, peek: true })) || []
    await this.catchUpRoomHistory(roomJid, messages, { sessionStartTime, stitchReadPointer: true })
```

Remove the dead cursor blocks and now-unused reads (`getConversationLastTimestamp`/`getRoomLastTimestamp` stay in the store bindings — `mergeMAMMessages`' seam fallback still uses them).

- [ ] **Step 4: Update remaining tests**

- `MAM.catchup.test.ts` `catchUpAllConversations`/`catchUpAllRooms`: forward-anchor expectations keep `start:`; `maxAutoPages` expectations become `3`; delete `after:`-seed assertions (covered by Task 4/5 describes); single-call expectations need mocks resolving `complete: true` (else the bail adds a second call); empty-cache tests assert `before: ''` as the FIRST call.
- `chatSideEffects.test.ts` / `roomSideEffects.test.ts`: side effects now assert delegation — extend `createMockClient` in `sideEffects.testHelpers.ts` with the orchestrator mocks on the same namespace found in Step 1, then e.g.:

```typescript
      await vi.waitFor(() => {
        expect(mockClient.mam.catchUpConversationHistory).toHaveBeenCalledWith(
          'contact@example.com',
          expect.any(Array),
          expect.objectContaining({}),  // no stitchReadPointer for the active path
        )
      })
```

Cursor-policy specifics are covered by the orchestrator and utils tests; the side-effect tests keep their cache-load-first assertions (`loadMessagesFromCache` before the catch-up call).
- `apps/fluux/src/test-setup.ts`: add the two new client methods to the SDK mock if the app mock enumerates the client surface.

- [ ] **Step 5: Run the full SDK suite**

Run: `cd packages/fluux-sdk && npx vitest run`
Expected: ALL PASS, no stderr.

- [ ] **Step 6: Commit**

```bash
git add -A packages/fluux-sdk apps/fluux/src/test-setup.ts
git commit -m "feat(mam): latest-first catch-up — align to live, grow window back to the read pointer

Retires the XEP-0490 pointer-seed and preview-timestamp anchors. Phase A
renders recent history in one round-trip (forward from the local edge with a
bail cap, else fetch-latest); Phase B grows the window backward until the
read pointer resolves, keeping held history contiguous by construction and
shrinking the recorded seam page by page. Fixes fully-read conversations
rendering empty on a device with no local cache."
```

---

### Task 8: Full verification

**Files:** none (verification only)

- [ ] **Step 1: SDK + app suites**

Run: `cd packages/fluux-sdk && npx vitest run` → PASS, no stderr.
Run: `cd apps/fluux && npx vitest run` → PASS.

- [ ] **Step 2: Build + typecheck + lint**

From repo root: `npm run build:sdk && npm run typecheck && npm run lint`
Expected: typecheck clean; lint 0 errors (pre-existing `useFocusTrap.ts` warning is known).

- [ ] **Step 3: Scroll e2e gate**

Run: `cd apps/fluux && npm run test:scroll`
Expected: PASS (WebKit invariant-1 settle flake is known — retry once before investigating).

- [ ] **Step 4: Live verification checklist (manual, by maintainer)**

1. Fully-read conversation, empty desktop cache (the lovetox repro): open → history + OMEMO placeholders after ONE `before:''` query in the XML log; sidebar preview populates; no unread badge.
2. Conversation with a few unread synced from mobile: open → history + divider + correct badge (pointer resolved inside the latest page).
3. Fresh install background sync: sidebar previews populate for all conversations; per-conversation XML shows one fetch-latest, plus backward growth only where the pointer sat below the page.
4. Busy room after long offline: open → live edge quickly; "Load missing messages" seam marker above; clicking heals; SM resume does NOT re-query rooms already synced (caught-up-to-live on fetch-latest).

---

## Self-Review Notes

- **Spec coverage:** two-pointer model — coverage id anchors downloading (Tasks 3, 6), read pointer drives unread (Tasks 4-5, G2); latest-first everywhere (Tasks 3-7); lazy single-seam guarantees (#1019 machinery + id stamps, Task 6); resume-loop fix (Task 2b, F2); active-entity eviction hazard excluded by design (F4, Tasks 4/7); interim fix reverted (Task 1); manual repair paths untouched (constraint).
- **Behavioral deltas for the PR description:** (1) empty-cache catch-up renders the latest page first instead of forward-filling the unread backlog before rendering; (2) incomplete forward catch-ups bail at 3 pages to the live edge + seam instead of grinding 50 pages; (3) fetch-latest merges mark the entity caught-up-to-live and flip `windowAtLiveEdge` true; (4) unread badges for >1000-message backlogs converge across passes instead of one 5000-message grind.
- **Type consistency:** orchestrator options `{ sessionStartTime?, stitchReadPointer? }` used identically in Tasks 4/5/6; caps `MAM_CATCHUP_FORWARD_BAIL_PAGES = 3` / `MAM_POINTER_STITCH_MAX_PAGES = 10` (Task 3) asserted as `3` / `1 + 10` in Task 4 tests.
- **Open verification inside execution:** the exact client surface for side effects (`client.mam` vs `client.chat`) — grep-verified in Task 7 Step 1; `mamState.test.ts` existing suite name — verify before adding the new describe.
