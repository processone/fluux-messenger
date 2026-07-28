# Start active-room MAM only after confirmed join

**Date:** 2026-07-27

**Status:** Approved

**Scope:** `@fluux/sdk` room side effects and focused network-scenario tests

## Problem

On a PWA reload, Fluux hydrates the SM-resumable room snapshot before opening
the XMPP socket. The snapshot deliberately preserves `joined=true`, because a
successful Stream Management resume keeps the server-side MUC membership and
replays only the changes.

When SM cannot resume and the connection falls back to a fresh session, the
current ordering exposes that provisional snapshot state to room side effects:

1. `Connection` emits `online`.
2. `setupRoomSideEffects` sees the hydrated active room as joined and starts
   its MAM catch-up.
3. The fresh-session lifecycle resets MAM state, marks the previous rooms as
   not joined, and rejoins them.
4. The room later receives its confirmed self-presence.

This permits a room archive query to start before the fresh session has
confirmed MUC membership. On mobile, the cache-hydration surface and subsequent
join/history states make the transition especially visible as a two-stage
load.

## Design

Make confirmed `joined=true` state a hard precondition for the initial MAM
catch-up of the active room during a fresh session. The successful
`room:joined` event becomes the primary trigger.

Because the hydrated snapshot also carries `joined=true`, the store flag alone
cannot distinguish preserved SM state from a join confirmed in the new stream.
`setupRoomSideEffects` will therefore keep a session-local set of room JIDs
whose successful `room:joined` event has been observed. A genuine fresh
transport `online` event enables this confirmation gate and clears the set. A
`resumed` event disables the gate because SM preserves membership without new
joins; the uninterrupted synthetic-online exception is described below.

The `online` handler in `setupRoomSideEffects` will continue to:

- record `sessionStartTime`, preserving the catch-up boundary used to avoid
  skipping an offline gap when live messages arrive during synchronization;
- on a genuine fresh transport session, clear `fetchInitiated` and the
  session-local confirmed-room set so a new successful `room:joined` event is
  required before room MAM can start;
- on the uninterrupted post-resume synthetic `online`, preserve both
  resume-seeded fetch tracking and join confirmations already observed during
  full fresh setup.

It will no longer call `fetchMAMForRoom` for the active room.

The existing `room:joined` listener will start the foreground catch-up after
the MUC module has received self-presence and the store binding has committed
`joined=true`. Before applying the active-room filter it records the successful
join in the session-local set, so a room joined in the background remains
eligible when opened later. A `joined=false` event removes the room from the
set. Existing guards remain authoritative:

- only the active room is fetched by this listener;
- Quick Chat rooms are skipped;
- unsupported MAM rooms are skipped;
- disconnected clients are skipped;
- `fetchInitiated` and the room MAM loading state prevent duplicate queries.

The existing `supportsMAM` watcher remains a fallback trigger when room
capability discovery resolves only after self-presence. It routes through the
same `fetchMAMForRoom` preconditions, including the session-local confirmation
gate, and therefore cannot start a query from hydrated `joined=true` state
before the new stream confirms membership.

After the IndexedDB cache load and immediately before calling
`catchUpRoomHistory`, `fetchMAMForRoom` will re-read the room and connection
state. If the room is no longer joined, is no longer active, or the connection
is no longer online, it will clear the loading state, remove the room from
`fetchInitiated`, and return. This closes the leave/disconnect race during the
asynchronous cache read and leaves the room retryable.

The resulting genuine fresh-transport flow is:

```text
online
  -> record session start and reset fetch tracking
  -> fresh-session setup
  -> invalidate previous MUC membership
  -> rejoin/autojoin
  -> receive self-presence
  -> room:joined
  -> load active-room cache
  -> revalidate active/joined/online state
  -> run MAM catch-up
```

## Review follow-up guards

Successful SM resumption still emits `resumed` before post-connection
lifecycle work. If the cache-integrity marker is missing, that same transport
session is upgraded to full fresh setup: rooms may rejoin and emit
`room:joined` before `SessionLifecycle` emits its synthetic `online`.
`setupRoomSideEffects` privately remembers that the next uninterrupted
post-resume `online` may be synthetic and preserves both join confirmations
already observed during setup and `fetchInitiated` entries seeded by the
successful resume. Any transition away from `online` cancels that marker, so a
later genuine fresh transport session clears both sets as usual. Preserving
resume-seeded tracking is required for an archive-held active room: clearing it
would allow a later join event to issue a duplicate foreground MAM query.

Each asynchronous foreground room catch-up also receives a private per-room
owner identity when it starts. After cache hydration, after MAM completion,
and before error cleanup, the continuation verifies that it still owns the
room attempt. Fresh-session MAM reset plus confirmed rejoin may start a
replacement while an older cache promise is pending; the replacement becomes
the sole owner, and the older continuation returns without querying MAM or
mutating `fetchInitiated` or loading state.

## Unchanged behavior

- A successful SM resume continues to trust hydrated MUC membership and does
  not issue a foreground room MAM query for an archive already held locally.
- The `resumed` handler disables the fresh-session confirmation gate; rooms
  that genuinely need their first archive after resume retain the existing
  first-open and late-capability fallback paths.
- A room first opened after SM resume still fetches its archive when it has
  never been queried and has no resident history.
- The delayed background room catch-up remains responsible for inactive joined
  rooms and continues to exclude the active room.
- The MUC join handler may still refresh the cache-first sidebar preview. That
  operation updates only `lastMessage`; it does not populate the active message
  timeline.
- Global `online` event ordering, snapshot serialization, and fresh-session
  orchestration remain unchanged.

## Error and retry behavior

- A cache-read failure keeps the existing behavior: it is logged, treated as
  an empty cache result, and MAM may still proceed if the room remains valid.
- A disconnect or room leave during cache hydration aborts before MAM and
  clears the loading/fetch guards so a later confirmed join can retry.
- A MAM transport failure continues through the existing catch block, which
  clears loading state and makes the room retryable.
- A room whose self-presence never arrives never starts MAM. Its existing join
  timeout/error flow remains responsible for surfacing the join failure.

## Testing

Add a focused regression test that starts with a hydrated active room carrying
`joined=true` and MAM support:

1. Emit fresh-session `online`.
2. Assert that no room MAM catch-up starts.
3. Mark the room not joined to model fresh-session invalidation.
4. Confirm the join and emit `room:joined`.
5. Assert that exactly one active-room catch-up starts with the recorded
   `sessionStartTime`.

Add race coverage for:

- the active room leaving while its cache read is pending;
- the connection dropping while its cache read is pending;
- the active room changing while its cache read is pending.
- an uninterrupted `resumed → room:joined → synthetic online` upgrade;
- an uninterrupted post-resume synthetic `online` retaining archive-held
  fetch tracking, while a later genuine fresh session clears it;
- an older cache attempt resolving after a fresh-session retry owns the room;
- an older cache failure attempting cleanup after that replacement starts.

Retain and run the existing regressions for:

- fresh-session fallback eventually catching up the active room;
- SM resume issuing no redundant MAM for an archive already held;
- first open after SM resume fetching a never-held archive;
- non-active `room:joined` events not starting foreground MAM.

Run the full unit suite, typecheck, and lint before committing the functional
change.

## Non-goals

- Reordering the global `online` event.
- Changing persisted `joined` snapshot semantics.
- Redesigning the fresh-session or SM-resumption lifecycle.
- Removing the separate cache-first sidebar preview refresh.
- Removing the redundant first-activation IndexedDB read; that is a separate,
  independently testable optimization if the visual symptom remains after the
  network-ordering fix.
