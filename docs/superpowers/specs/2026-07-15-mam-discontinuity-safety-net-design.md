# MAM Discontinuity Safety Net — Design

**Date:** 2026-07-15
**Status:** Approved-in-principle (A + B), pending spec review → implementation plan
**Scope:** `@fluux/sdk` (MAM catch-up / gap machinery) + minimal app wiring. Chat + room parity.

## Problem

Fluux records a history hole and shows the `HistoryGapMarker` ("Load missing
messages") **only** when a forward MAM catch-up ends `complete=false`. This is
deliberate: `mamGap.ts` refuses to infer holes from timestamp discontinuities
because a quiet period and a real gap look identical by timestamp, and ejabberd
archive ids are non-sequential.

That leaves a blind spot. A forward catch-up anchors its cursor on the **newest
message that predates the session** (`findCatchUpCursorMessage`). If a hole
already sits *below* that anchor — old history up to a date, plus a newer disjoint
block, with nothing between — every forward query starts *above* the hole,
returns `complete=true`, and the hole is **never detected, never recorded, never
healed**. It survives restarts and upgrades and is self-perpetuating: once the
recent block exists, the cursor sits above the hole forever.

Observed in the field: a MUC room showing messages up to ~July 6 and then recent
messages, with a multi-day hole between and no marker.

## Core principle: a seam is an un-connected MAM query edge

A hole can only exist where **one MAM query's result stops and a different
query's result begins without proof they connect** — a *seam*. It is a property
of the *fetches*, not of the message timeline. A large timestamp gap *inside* a
single contiguously-fetched range is a quiet period, not a hole. A marker may
therefore appear only at a seam, which exists in very few places.

We do **not** make a timestamp gap the *definition* of a hole. Where a real query
edge exists (Part A), we use it directly and never look at timestamps. Where the
edge evidence is gone (Part B, legacy data), a timestamp gap only chooses *where
to ask the server*; the server remains the sole authority on whether a hole is
real.

## Feasibility finding (drives the A/B split)

`roomStore`/`chatStore` use vanilla `createStore` — **no `persist()`/`partialize`**.
`mamQueryStates` (holding `oldestFetchedId`, `forwardGapTimestamp`) is
re-initialized to `new Map()` on every load; only `roomGaps` and friends persist
via manual localStorage helpers. The backward-pagination cursor is derived from
the **oldest resident message's** stanza-id, explicitly preferred over
`mamState.oldestFetchedId` (`createFetchOlderHistory.ts`).

**Therefore no persisted structural marker of a region's edge exists.** A hole
formed in a past session leaves only the timestamp discontinuity in the message
data. Query-edge detection can cover holes formed *from now on* (edge known at
fetch time, persisted at formation); already-formed holes can only be recovered
via a server-confirmed probe.

## Part A — going-forward edge detection (pure query-edge)

Record a seam into the persisted `roomGaps`/`conversationGaps` at the moments a
hole is *created*, using only reliable fetch signals — no timestamps:

1. **`complete=false` forward catch-up** — already implemented; keep as-is.
2. **`before:''` fetch-latest over existing older history** — the exact path that
   manufactures the reported hole. When `selectCatchUpQuery` resorts to
   `{ before: '' }` (no cached cursor, no preview timestamp, no MDS pointer) yet
   the conversation has older persisted history, the fetched recent page's lower
   edge is a seam against that older history. After the merge, record it:
   `start` = newest held message below the fetched page, `end` = oldest message
   of the fetched page.

Both are written at formation and persist, so the marker survives reload and the
self-perpetuating cursor never has to "re-detect" anything.

Note: with the existing fallback chain (`getRoomLastTimestamp`, MDS pointer),
`before:''` is already rare — which is correct: seams are rare. Part A closes the
residual window where a fetch-latest fires despite older data in IndexedDB.

## Part B — legacy recovery (already-formed holes)

For holes that predate this feature (the reported bug), no live query edge and no
persisted edge exist. On conversation activation (chat **and** room), after the
resident window hydrates:

1. **Locate a candidate seam.** If no seam is already recorded for the
   conversation, scan the hydrated window for the boundary between the recent
   contiguous block and older history (the largest adjacent discontinuity). This
   is a *candidate location only*, never a marker.
2. **Confirm with the server.** Issue a bounded MAM query confined to the
   interval, as a **forward** query so the existing gap-sync path positions the
   seam:
   `queryRoomArchive({ roomJid, start: olderTs+1ms, end: newerTs−1ms, max: MAM_CATCHUP_FORWARD_MAX })`
   (1:1 mirror: `queryArchive({ with, start, end, max })`). `start`/`end` bounds
   are already supported (precedent: MAM.ts jump-to-message uses `end`).
3. **Act on the server's verdict** (via the existing merge):
   - **empty + complete** → not a hole. Nothing recorded; no marker.
   - **non-empty + complete** → small hole; merged messages heal it; no marker.
   - **non-empty + `complete=false`** → real large hole; the merge records the
     seam into `roomGaps` and positions the marker.
4. **Session guard.** Record the probed candidate in an ephemeral session-scoped
   set so reopening the same conversation in one session does not re-probe. Not
   persisted; a genuinely-quiet legacy conversation costs one bounded probe per
   session on first open — negligible and self-limiting as legacy data ages out.

B never plants a marker on a timestamp gap alone — only the server's confirmation
creates one.

## Progressive verification (forward and backward)

A large seam converges from both edges, riding the pagination the user already
does:

- **Forward** — the Part B probe, and thereafter `continueRoomCatchUp` ("Load
  missing messages") / background catch-up. Each `complete=true` page proves its
  span contiguous and moves the seam's lower edge **up** (existing path).
- **Backward** — when the user scrolls up in the recent block, load-older pages
  extend that region **down**; when a backward page overlaps into the older
  region (dedupe overlap / crosses the seam), the ranges have met. **New wiring:**
  extend the merge so a backward page that crosses/overlaps the seam also calls
  `syncGap` to shrink or clear it (today gaps are forward-only driven).
- Whichever edge reaches the other first closes the seam; `syncGap` deletes the
  mark once resolved (existing behavior).

## Persistence model

- **Persist only hole marks** — the existing `roomGaps`/`conversationGaps`
  `Map<jid, GapInterval>`, now written by both Part A (edge at formation) and Part
  B (server-confirmed). **Deleted on resolution** by the existing `syncGap`.
- **A contiguous probe persists nothing** — no marker created, nothing to delete.
  No "verified-contiguous" watermark, no negative cache.
- **Ephemeral in-session guard** for Part B probes; discarded on reload.

## Components

### New (small, isolated)
- **`packages/fluux-sdk/src/stores/shared/discontinuityScan.ts`** — pure,
  chat/room shared: `findSeamCandidate(messages, { knownGap, probed }) → { start, end } | undefined`.
  Returns the single recent/older discontinuity for Part B, or undefined.
  Threshold `DISCONTINUITY_MIN_GAP_MS` (default `3_600_000`) bounds probe volume
  only — correctness comes from the server. Fully unit-testable.
- **Activation helper** (thin) — runs the scanner, fires the Part B probe via the
  existing MAM methods, maintains the session probed-set. Shared, called from
  both chat and room activation paths (`useChatActive`/`useRoomActive`).

### Modified
- **`selectCatchUpQuery` call sites (`catchUpRoom`/`catchUpConversation`)** — when
  the result is `{ before: '' }` and older persisted history exists, record the
  Part A seam after the merge.
- **`mergeRoomMAMMessages`/`mergeMAMMessages`** — backward-direction seam closure
  (the new wiring above), kept in the shared timeline/merge path for parity.

### Reused unchanged
`queryArchive`/`queryRoomArchive` (bounded `start`+`end`), the existing forward
gap-sync path, `roomGaps`/`conversationGaps` + `GapInterval`, `computeGapEnd`/
`syncGap`, `HistoryGapMarker`, `continueRoomCatchUp` + chat twin. **No new UI.**

## Simplification pass (required after implementation)

The net adds a second and third producer of gap marks (Part A edge, Part B
probe) alongside `complete=false`. Before finishing, audit and fold genuine
duplication:
- Unify the gap-sync blocks in the room and chat merge functions into one shared
  helper (they are near-twins).
- Share a single "reconcile gap against merged timeline" function between the
  forward and new backward closure paths.
- Check whether the Part B session probed-set is subsumable by existing
  `mamState` rather than a new structure.

Report concrete findings; fold what genuinely duplicates.

## Testing

### Pure scanner (`discontinuityScan.test.ts`)
- No discontinuity → undefined; one → returned; recent/older seam chosen over an
  ancient one; already covered by `knownGap` → undefined; already `probed` →
  undefined; unsorted input & missing timestamps → robust.

### Part A — edge at formation (SDK, mock client), chat **and** room
- `before:''` fetch-latest with older persisted history → seam recorded in
  `roomGaps`/`conversationGaps`, marker positioned.
- `before:''` with **no** older history → no seam (correct: nothing below).
- `complete=false` forward path → unchanged (regression).

### Part B — server-confirmed recovery (SDK, mock client), chat **and** room
- Candidate → probe empty+complete → no gap; candidate marked probed.
- Candidate → probe non-empty+complete → merged, no marker.
- Candidate → probe non-empty+`complete=false` → seam recorded, marker positioned.
- Session-dedupe → second activation issues no probe.

### Progressive closure
- Forward `continueRoomCatchUp` reaching the seam → mark cleared (existing path;
  add coverage if absent).
- **Backward** load-older page crossing the seam → mark shrinks then clears (new).

### App / UI
- Extend existing `HistoryGapMarker` render tests for the confirmed large-hole
  path rather than duplicating.

### Regression gates
- `npm run test:scroll` — probe/merge into the **active** conversation must not
  disturb scroll position.
- SDK type change → `build:sdk` before app typecheck; new SDK export used by the
  app → add to the app test mock.

## Out of scope (v1)

- Holes entirely outside the loaded resident window (deep history) — only the
  seam in the hydrated window is scanned for Part B.
- Scanning unopened conversations (activation-only).
- Multiple simultaneous seams per conversation — v1 handles the single
  recent/older seam; the `GapInterval` structure leaves room to extend.
- Persisted negative ("verified-contiguous") cache — deliberately omitted.

## Immediate user remedy (independent of this work)

The existing **Rooms sidebar → "+" → "Catch up all rooms"**
(`forceCatchUpAllRooms`, fixed 45-day window, `preserveGapMarker`) already
backfills a hole within 45 days. This safety net makes recovery automatic and
discoverable rather than manual.
