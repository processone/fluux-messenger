# MAM Discontinuity Safety Net — Design

**Date:** 2026-07-15
**Status:** Approved (design), pending implementation plan
**Scope:** `@fluux/sdk` (MAM catch-up / gap machinery) + minimal app wiring. Chat + room parity.

## Problem

Fluux records a history hole and shows the `HistoryGapMarker` ("Load missing
messages") **only** when a forward MAM catch-up ends `complete=false` (the server
said "there is more" and we stopped at the page cap). This is deliberate:
`mamGap.ts` refuses to infer holes from timestamp discontinuities because a quiet
period and a real gap look identical by timestamp, and ejabberd archive ids are
non-sequential.

That leaves a blind spot. A forward catch-up anchors its cursor on the **newest
message that predates the session** (`findCatchUpCursorMessage`). If a hole
already sits *below* that anchor — e.g. the client holds old history up to a
date, plus a newer disjoint block fetched by a `before:''` fetch-latest, with
nothing in between — every forward query starts *above* the hole, returns
`complete=true`, and the hole is **never detected, never recorded, and never
healed**. It survives restarts and upgrades because forward-only catch-up is
structurally blind to a hole beneath its anchor, and there is no timestamp
fallback.

Observed in the field: a MUC room showing messages up to ~July 6 and then recent
messages, with a multi-day hole between and no marker.

## Design principle

Holes can only exist at a **seam** between two separately-fetched regions. Seams
are few — for v1, the single seam between the recent/live block and the older
history beneath it. A marker can therefore only ever sit at a seam, never
scattered across quiet stretches. This is what makes the feature
false-positive-proof by construction.

We do **not** reverse the "never guess from timestamps" rule. A timestamp gap is
used only to decide **where to ask the server**; the server (via a bounded MAM
query) remains the sole authority on whether a hole is real. Timestamps locate a
*candidate* seam; MAM confirms it.

## Signal flow

On conversation activation (chat **and** room), after the resident window
hydrates:

1. **Detect the seam (pure, shared).** Scan the resident messages for the single
   boundary between the recent contiguous block and the older history — the
   largest adjacent gap `≥ DISCONTINUITY_MIN_GAP_MS` (default **1 hour**) not
   already covered by a known `roomGaps`/`conversationGaps` entry and not already
   probed this session. At most **one** candidate.

2. **Eager bounded probe.** Issue a MAM query confined to the interval:
   `queryRoomArchive({ roomJid, start: olderTs+1ms, end: newerTs−1ms, max: MAM_CATCHUP_FORWARD_MAX })`
   (1:1 mirror: `queryArchive({ with, start, end, max })`), issued as a **forward**
   query so the existing forward gap-sync path positions the seam. `start`/`end`
   bounds are already supported (precedent: MAM.ts jump-to-message uses `end`).

3. **Confirm via the existing merge.** Results flow through
   `mergeRoomMAMMessages` / `mergeMAMMessages`, which already merge + dedupe and,
   on `complete=false`, record `forwardGapTimestamp` → `roomGaps` → position the
   `HistoryGapMarker`. Therefore:
   - **Probe empty + complete** → not a hole. Nothing recorded; no marker.
   - **Probe non-empty + complete** → small hole; merged messages heal it; no
     marker.
   - **Probe non-empty + `complete=false`** → large hole; the merge records the
     seam and positions the marker automatically.

4. **Record the probe in a session-scoped guard** (ephemeral) so reopening the
   same conversation in one session does not re-probe the same seam. Not
   persisted — see Persistence.

## Progressive verification (forward and backward)

A large seam is not closed by one giant fetch; it converges from both edges,
riding the pagination the user already does.

- **Forward** — the initial probe, and thereafter `continueRoomCatchUp` ("Load
  missing messages") / background catch-up. Each `complete=true` page proves its
  span contiguous and moves the seam's lower edge **up**. (Existing path.)
- **Backward** — when the user scrolls up in the recent block, load-older pages
  extend that region **down**. When a backward page overlaps into the older
  region (dedupe overlap / crosses the seam boundary), the two regions have met.
  (**New wiring** — see below.)
- Whichever edge reaches the other first closes the seam; `syncGap` deletes the
  mark once resolved (existing behavior).

## Persistence model

- **Persist only hole marks** — the existing `roomGaps` / `conversationGaps`
  `Map<jid, GapInterval>`. Created when a probe (or `complete=false`) confirms a
  seam; **deleted on resolution** by the existing `syncGap`. Survives reload so
  the marker isn't silent again next session.
- **A contiguous probe persists nothing** — it simply never creates a mark, so
  there is nothing to delete. No "verified-contiguous" watermark, no negative
  cache. Re-probing a genuinely quiet seam on a later session costs one bounded
  MAM query — negligible because candidate detection is limited to one seam.
- **Ephemeral in-session guard** — a session-scoped set of already-probed seams,
  thrown away on reload.

## Components

### New (small, isolated)

- **`packages/fluux-sdk/src/stores/shared/discontinuityScan.ts`** — pure,
  chat/room shared:
  ```
  findSeamCandidate(
    messages: Array<{ timestamp?: Date }>,
    opts: { minGapMs: number; knownGap?: GapInterval; probed: (start: number, end: number) => boolean },
  ): { start: number; end: number } | undefined
  ```
  Returns the single recent/older seam, or undefined. Fully unit-testable.

- **Activation helper** (thin) — runs the scanner against the resident window,
  fires the bounded probe via the existing MAM methods, and maintains the
  session probed-set. Invoked from both the chat and room activation paths
  (`useChatActive` / `useRoomActive`, where the resident window already
  hydrates). Shared implementation, called from both twins.

- **Constant** `DISCONTINUITY_MIN_GAP_MS` (default `3_600_000`).

### Modified

- **`mergeRoomMAMMessages` / `mergeMAMMessages`** — extend the gap-sync block so
  a **backward** page that crosses/overlaps the seam also calls `syncGap` to
  shrink or clear the interval. Forward already shrinks it. Keep this change in
  the shared timeline/merge path so chat and room stay in parity.

### Reused unchanged

`queryArchive` / `queryRoomArchive` (bounded `start`+`end`), both merge
functions' existing forward path, `roomGaps` / `conversationGaps` + `GapInterval`
(the seam), `computeGapEnd` / `syncGap`, `HistoryGapMarker`,
`continueRoomCatchUp` + chat twin. **No new UI.**

## Simplification pass (required after implementation)

The net makes the safety net a *second* producer of gap marks (alongside the
`complete=false` path). Before finishing, audit and fold genuine duplication:

- Can the gap-sync blocks in the room and chat merge functions be unified into
  one shared helper (they should already be near-twins)?
- Does the new backward-closure logic overlap the existing forward
  `computeGapEnd`/`syncGap` enough to share a single "reconcile gap against
  merged timeline" function usable by both directions?
- Is the session probed-set subsumable by existing `mamState` rather than a new
  structure?

Report concrete findings; fold what genuinely duplicates, leave what doesn't.

## Testing

### Pure scanner (`discontinuityScan.test.ts`)
- No gap → undefined.
- One seam above threshold → returned.
- Sub-threshold gap → undefined.
- Multiple gaps → the recent/older seam selected (not an ancient one).
- Seam already covered by `knownGap` → undefined.
- Seam already in `probed` → undefined.
- Unsorted input; messages with missing timestamps → robust.

### Probe → merge integration (SDK, mock client) — chat **and** room
- Candidate → probe empty + complete → no gap recorded; seam marked probed.
- Candidate → probe non-empty + complete → merged; no marker.
- Candidate → probe non-empty + `complete=false` → `forwardGapTimestamp` /
  `roomGaps` set; marker positioned at the seam.
- Session-dedupe → second activation issues no probe.

### Progressive closure
- Forward `continueRoomCatchUp` reaching the seam → `syncGap` clears the mark
  (existing path; add a covering test if absent).
- **Backward** load-older page crossing the seam → mark shrinks then clears
  (new path).

### App / UI
- Extend existing `HistoryGapMarker` render tests for the probe-confirmed
  large-hole path rather than duplicating.

### Regression gates
- `npm run test:scroll` — probe results merged into the **active** conversation
  must not disturb scroll position.
- SDK type change → `build:sdk` before app typecheck. New SDK export used by the
  app → add to the app test mock.

## Out of scope (v1)

- Holes entirely outside the loaded resident window (deep history) — only the
  seam visible in the hydrated window is scanned.
- Scanning unopened conversations (activation-only).
- Multiple simultaneous seams per conversation — v1 handles the single
  recent/older seam; the interval structure leaves room to extend later.
- Persisted negative ("verified-contiguous") cache — deliberately omitted.

## Immediate user remedy (independent of this work)

The existing **Rooms sidebar → "+" → "Catch up all rooms"**
(`forceCatchUpAllRooms`, fixed 45-day window, `preserveGapMarker`) already
backfills a hole within 45 days. This safety net makes recovery automatic and
discoverable rather than manual.
