# Room MAM catch-up on SM resume

**Date:** 2026-07-01
**Status:** Approved (design) — pending implementation plan
**Base:** `main` at `6d26e373` (includes #783, the update-available button)

## Problem

The background room catch-up that seeds sidebar previews and fills history gaps
(`MAM.catchUpAllRooms`, driven from `backgroundSync.ts`) runs **only on a fresh
`'online'` session**, on a 10s delayed timer. The `'resumed'` (stream-management
resume) handler does nothing but log.

So on an SM resume, a joined MAM room that was never caught up **this session** —
an autojoined room the user never opened, or a room whose fresh-session catch-up
was interrupted — keeps `isCaughtUpToLive: false`, shows no preview, and sorts
stale. SM replay only redelivers queued undelivered stanzas; it carries no history
for a room the client never subscribed history for.

This is the deferred follow-up to #783. That PR made page reloads user-triggered
(removing the most common mobile trigger), but the underlying class remains: any
SM resume — a mobile network change (wifi/cellular), an app foregrounding, or the
now-rare user reload — skips the catch-up.

## Existing infrastructure (grounding)

The signal this design needs already exists; no new flag or persistence is
required.

- **`MAMQueryState.isCaughtUpToLive`** (`packages/fluux-sdk/src/core/types/pagination.ts`):
  `true` when a forward catch-up completes with no gap, or after an initial
  `before:''` fetch-latest. This is precisely "successfully updated to live."
- **`mamQueryStates` is NOT persisted.** `roomStore` uses `subscribeWithSelector`
  only (no `persist` middleware); `createEmptyRoomState` initializes
  `mamQueryStates: new Map()` on every load. So `isCaughtUpToLive` is
  **session-scoped**: `false` on each app start, flipped `true` as each room
  catches up during the running session. That is the correct semantics for "did
  we catch this room up this run."
- **`roomGaps` IS persisted** (`packages/fluux-sdk/src/stores/roomStore.ts`,
  `serializeGaps`/`deserializeGaps` to localStorage). An unfilled forward gap
  survives a reload, so `catchUpRoom` forward-fills from the right boundary even
  after the JS context resets.
- **`MAM.catchUpRoom(jid, sessionStartTime)`** (`packages/fluux-sdk/src/core/modules/MAM.ts`):
  cache-aware forward catch-up. `selectCatchUpQuery` returns `{ before: '' }` when
  there is no cursor, so a never-fetched room gets its latest page (seeds the
  preview) and a gap room forward-fills.
- **`MAM.catchUpAllRooms({ concurrency, exclude, sessionStartTime })`**
  (`MAM.ts:1052`) already filters `r.supportsMAM && !r.isQuickChat && exclude` and
  fans out through `executeWithConcurrency(..., 2)`.
- **Vestigial:** `needsCatchUp` / `markAllRoomsNeedsCatchUp` /
  `clearRoomNeedsCatchUp` are defined and bound in `defaultStoreBindings.ts`, but
  for rooms they are never called and never consumed. Dead scaffolding; this
  design ignores it (an optional separate tidy could delete the room bindings).

## Goal / non-goals

**Goal:** on SM resume, seed previews and fill gaps for joined MAM-capable rooms
that are not caught up to live this session, without re-fetching what SM already
replays.

**Non-goals:**
- Unifying the fresh-`'online'` and `'resumed'` paths into a single "ensure caught
  up" driver. Possible later; out of scope here to keep the change focused and low
  risk.
- Removing the vestigial `needsCatchUp` room scaffolding (optional separate tidy).

## Design

### Trigger — `backgroundSync.ts` `'resumed'` handler

The handler (currently `backgroundSync.ts:286`, log-only) gains:

1. Set a resume `sessionStartTime = Date.now()` (mirrors the `'online'` handler)
   so any forward-from-cursor query is bounded consistently.
2. Schedule a resume catch-up pass on a short settle delay
   (`MAM_ROOM_RESUME_CATCHUP_DELAY_MS`, added to `mamCatchUpUtils.ts`, ~3000ms —
   shorter than the fresh 10s because rooms are already joined from persist/SM, but
   non-zero so SM's stanza replay lands first and genuinely-caught-up rooms are
   correctly skipped).
3. Store the timer in a `resumeCatchUpTimer` and clear it on disconnect — extend
   the existing connection-status subscription that already clears
   `roomCatchUpTimer` (`backgroundSync.ts:295`). Also clear on cleanup/unsubscribe.
4. Guard the pass body with `client.isConnected()`.

### Target selection — extend `catchUpAllRooms`

Add an optional `onlyNotCaughtUp?: boolean` to `catchUpAllRooms`. When set, the
filter also requires
`!stores.room.getRoomMAMQueryState(r.jid).isCaughtUpToLive`. This avoids a
near-duplicate method (per the repo's "avoid duplicate code" guidance). The
`'resumed'` pass calls:

```
await client.mam.catchUpAllRooms({
  concurrency: 2,
  exclude: activeRoomJid,       // roomSideEffects owns the active room
  sessionStartTime,             // resume time
  onlyNotCaughtUp: true,
})
```

The fresh `'online'` path is unchanged (no flag → catches up all rooms; on a fresh
session they all start `isCaughtUpToLive: false` anyway, so the two are
equivalent there — noted for a future unification).

The resulting target set on resume is exactly:
- never-fetched rooms (autojoined, never opened) → `{ before: '' }` seeds preview;
- rooms with an unfilled forward gap → forward-fill from persisted `roomGaps`.
Rooms already caught up this session are skipped, so the pass does not duplicate
SM replay or fight stream management.

### Cost

Bounded: `executeWithConcurrency(2)`; a no-gap room's forward query returns
`complete` immediately (cheap). Worst case is right after a reload, when
`mamQueryStates` reset makes all rooms `isCaughtUpToLive: false` and the pass
touches every joined room — but reloads are now user-triggered (post-#783), so
this is rare; ordinary network-blip resumes touch only the small un-caught-up
subset.

### Interaction guards

- Active room excluded (the `roomSideEffects` active-room path handles it).
- `catchUpRoom` merges via `mergeRoomMAMMessages`, which dedups, so any overlap
  with an on-open fetch is harmless (same as today's fresh-session behavior).
- No `supportsMAM` late-disco race on resume: rooms rehydrate `supportsMAM: true`
  from persist and are not re-disco'd, so the fresh-session late-MAM watcher is not
  needed here.

## Files touched

- `packages/fluux-sdk/src/core/backgroundSync.ts` — implement the `'resumed'`
  catch-up pass (set resume `sessionStartTime`, schedule + cancel
  `resumeCatchUpTimer`, connected guard).
- `packages/fluux-sdk/src/core/modules/MAM.ts` — add `onlyNotCaughtUp?: boolean`
  to `catchUpAllRooms` (filter on `!isCaughtUpToLive`).
- `packages/fluux-sdk/src/utils/mamCatchUpUtils.ts` — add
  `MAM_ROOM_RESUME_CATCHUP_DELAY_MS`.
- Tests (below).

## Testing

- **`MAM` unit test:** `catchUpAllRooms({ onlyNotCaughtUp: true })` drives
  `catchUpRoom` only for rooms with `isCaughtUpToLive === false`; caught-up rooms
  and the excluded active room are skipped; QuickChat/non-MAM rooms excluded.
- **`backgroundSync` resume test** (reuse `sideEffects.testHelpers.ts`): simulate
  `'resumed'` → after the delay, `catchUpAllRooms` is called with
  `onlyNotCaughtUp: true` and `exclude` set to the active room; a disconnect before
  the delay cancels the pass (no call). The mock client needs `on()` and a way to
  emit `'resumed'`.
- Run SDK vitest, then `npm run build:sdk` before app typecheck (SDK type surface
  unchanged, but the option is new), plus lint. All green, no stderr.

## Risks / edge cases

- **Do not fight SM:** only `!isCaughtUpToLive` rooms are driven, so SM-replayed
  rooms are never re-fetched.
- **`sessionStartTime` on resume:** set to resume time; for the target set
  (`{ before: '' }` or gap forward-fill) it does not affect correctness.
- **Post-reload cost:** bounded (concurrency 2, cheap no-gap completes, rare
  reloads). If it ever proves heavy for very large room counts, a follow-up can
  cap or stagger; log the count so silent truncation never hides.
- **Active room:** excluded; the on-open path is unaffected.
