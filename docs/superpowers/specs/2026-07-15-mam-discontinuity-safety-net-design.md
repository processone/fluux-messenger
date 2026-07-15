# MAM Discontinuity Safety Net — Design

**Date:** 2026-07-15
**Status:** Approved-in-principle (Part A only), pending spec review → implementation plan
**Scope:** `@fluux/sdk` (MAM catch-up / gap machinery). Chat + room parity. No new UI.

## Problem

Fluux records a history hole and shows the `HistoryGapMarker` ("Load missing
messages") **only** when a forward MAM catch-up ends `complete=false`. This is
deliberate: `mamGap.ts` refuses to infer holes from timestamp discontinuities
because a quiet period and a real gap look identical by timestamp, and ejabberd
archive ids are non-sequential.

That leaves a blind spot: a hole can *form* without ever producing a
`complete=false`. If a catch-up falls back to a `before:''` fetch-latest while
older history is already held, the fetched recent page lands **disjoint above**
the older messages. The query completes clean, nothing is recorded, and the hole
is invisible forever after: every later forward catch-up anchors its cursor on
the newest held message — *above* the hole — returns `complete=true`, and never
looks down. The hole is silent, permanent, and self-perpetuating.

### Field case and root cause

A MUC room showed messages up to ~July 6 and then recent messages, with a
multi-day hole between and no marker. Root cause (established from git history):
the hole formed under **0.17.0**, whose cursor fallback chain was weaker —
cached cursor → preview timestamp → `before:''`. The MDS-stanza-id `after`
fallback (#869) landed 13 hours after the 0.17.0 tag and shipped only in 0.17.1.
In the corner case (empty cache + unavailable preview timestamp at catch-up
time), 0.17.0 dropped straight to `before:''` and manufactured the seam.

0.17.1's hardened chain makes formation much rarer, but the class of bug is not
closed: any future fallback regression, or any path that legitimately resorts to
`before:''` over held history, re-creates it — and today it would again be
recorded nowhere.

### Legacy holes (out of scope, by decision)

Holes already formed under 0.17.0 carry no surviving query-edge evidence
(`mamQueryStates` is ephemeral — rebuilt as `new Map()` each load; only
`roomGaps` etc. persist). Recovering them automatically would require a
timestamp-located, server-confirmed probe (the dropped "Part B"). Decision:
**not worth the machinery** for a one-off legacy population. Remedy for affected
users: **Rooms sidebar → "+" → "Catch up all rooms"** (`forceCatchUpAllRooms`,
45-day window, `preserveGapMarker`) heals the hole manually.

## Core principle: a seam is an un-connected MAM query edge

A hole can only exist where **one MAM query's result stops and a different
query's result begins without proof they connect** — a *seam*. It is a property
of the *fetches*, not of the message timeline. A large timestamp gap *inside* a
contiguously-fetched range is a quiet period, not a hole. Markers may therefore
appear only at seams, which exist in very few places — and with Part B dropped,
**no timestamp is consulted anywhere in this design.**

## Part A — record the seam at formation (pure query-edge)

Two reliable fetch-edge signals write a seam into the persisted
`roomGaps`/`conversationGaps`:

1. **`complete=false` forward catch-up** — already implemented; unchanged
   (regression coverage only).

2. **Non-overlapping fetch-latest over held history — NEW.** Detected entirely
   at merge time, where all evidence is in hand (existing messages, fetched
   page, direction, dedupe result):

   > A backward `before:''` (fetch-latest) page that **does not overlap** any
   > held message (no dedupe hit) and lands **entirely above** existing history
   > creates a seam: `start` = newest pre-existing message's timestamp,
   > `end` = oldest fetched message's timestamp.

   - Overlap (any dedupe hit) → proven connected → no seam.
   - No pre-existing messages below → nothing to disconnect from → no seam.
   - The `start`/`end` values are stored positions for the marker; the
     *detection* uses only structural facts (direction, overlap, above/below
     ordering), never a gap-size heuristic.

   "Held history" must include IndexedDB-persisted messages, not just the
   resident array — the formation case is precisely a run where the resident
   cache is empty but the archive on disk is not. The merge path already loads
   a cache slice for cursor computation (`loadMessagesFromCache(peek)` in
   `catchUpRoom`); the implementation must ensure the seam check sees the
   newest *persisted* message, not just RAM.

Recorded at formation, the seam persists (existing `roomGaps` localStorage
path), survives reload, and positions the existing `HistoryGapMarker` with its
"Load missing messages" button. No re-detection is ever needed.

## Progressive closure (forward and backward)

A seam converges from both edges, riding pagination the user already does:

- **Forward** — `continueRoomCatchUp` ("Load missing messages") / background
  catch-up resumes from the seam boundary (existing: recorded gap wins the
  cursor policy in `selectCatchUpQuery`). Each `complete=true` page moves the
  seam's lower edge up; reaching held messages above clears it (existing
  `syncGap` path).
- **Backward — NEW WIRING.** When the user scrolls up in the recent block,
  load-older pages extend that region down. A backward page that overlaps into
  the region below the seam (dedupe hit / crosses the seam boundary) proves the
  ranges connect: shrink or clear the seam via `syncGap`. Today gap sync is
  forward-only; this extends the shared merge path so both directions maintain
  the same invariant.
- Whichever edge reaches the other first deletes the mark (existing `syncGap`
  clear semantics). Persist only hole marks; nothing else. A healed seam leaves
  no residue.

## Components

### Modified (no new modules expected)

- **Shared timeline/merge path** (`mergeRoomMAMMessages` / `mergeMAMMessages`
  and the shared `timeline.mergeArchive` machinery):
  - New formation check (signal 2) on backward `before:''` merges.
  - New backward closure: seam shrink/clear when a backward page connects the
    regions.
  - Both changes live in the **shared** module so chat and room cannot drift
    (per the chat/room twin rule).
- **`mamGap.ts`** — possibly a small pure helper (e.g.
  `reconcileGapAgainstMerge(gap, mergedPage, direction)`) so formation,
  forward closure, and backward closure share one transition function.

### Reused unchanged

`queryArchive`/`queryRoomArchive`, `selectCatchUpQuery` (recorded gap already
wins the cursor), `roomGaps`/`conversationGaps` + `GapInterval`,
`computeGapEnd`/`syncGap` + persistence, `HistoryGapMarker`,
`continueRoomCatchUp` + chat twin. **No new UI, no new persisted structures, no
timestamps-as-signal.**

## Simplification pass (required after implementation)

The change adds a second producer and a second consumer of gap marks. Before
finishing, audit and fold genuine duplication:

- Unify the near-twin gap-sync blocks in `mergeRoomMAMMessages` and
  `mergeMAMMessages` into one shared helper.
- Fold formation + forward closure + backward closure into a single
  "reconcile gap against merged page" pure function in `mamGap.ts` if the three
  transitions turn out to share shape.
- Re-examine whether `computeGapEnd` and the new helper overlap.

Report concrete findings; fold what genuinely duplicates, leave what doesn't.

## Testing

### Formation (signal 2) — SDK, mock client, chat **and** room
- `before:''` page, no overlap, older history held (in IndexedDB only — resident
  empty) → seam recorded with correct `start`/`end`; marker positioned.
- `before:''` page overlapping held messages (dedupe hit) → no seam.
- `before:''` page with no pre-existing history → no seam.
- `complete=false` forward path → unchanged (regression).
- Force repair (`preserveGapMarker`) → still neither plants nor clears (regression).

### Progressive closure
- Forward catch-up from seam boundary: `complete=true` reaching held messages →
  seam cleared; stopping short (`complete=false`) → seam shrunk (lower edge
  moved up), not cleared.
- **Backward** load-older page crossing/overlapping the seam → seam shrunk then
  cleared (new path), persisted map updated, marker disappears.
- Closure from both directions interleaved → converges, no resurrection of a
  cleared seam.

### Persistence
- Seam recorded → survives store re-create (deserialize) → marker repositions.
- Seam cleared → removed from localStorage (no residue).

### App / UI
- Extend existing `HistoryGapMarker` render tests for the formation-recorded
  seam (reuse, don't duplicate).

### Regression gates
- Full SDK suite + `npm run test:scroll` (merges into the active conversation
  must not disturb scroll).
- `build:sdk` before app typecheck; new SDK export used by the app → add to the
  app test mock.

## Out of scope

- **Part B (legacy recovery)** — dropped by decision; manual "Catch up all
  rooms" is the remedy for pre-existing holes.
- Multiple simultaneous seams per conversation — `GapInterval` holds one; the
  structure leaves room to extend if ever needed.
- Any timestamp-discontinuity scanning or probing.
