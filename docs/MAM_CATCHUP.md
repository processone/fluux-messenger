# MAM Catch-Up Strategy

This document describes how the SDK uses Message Archive Management (XEP-0313) to keep conversations and rooms up to date, both on initial connect and during normal use.

## Problem

When Fluux is closed, messages continue to flow between contacts and in rooms. On reconnect, only sidebar previews were refreshed (fetching the latest message per conversation). The actual message history was only populated lazily when the user opened each conversation. This meant messages exchanged while offline were not visible until the user navigated to every conversation individually.

Additionally, if a roster contact sent a message while offline but there was no prior conversation, the message would never be discovered, because the catch-up only covered conversations already in the store.

## Overview

The SDK uses a **hybrid lazy + background** approach organized into five layers:

| Layer | Trigger | Scope | Speed |
|-------|---------|-------|-------|
| **Preview refresh** | Connect | All non-archived conversations | Fast (max=5, concurrency=3) |
| **Conversation catch-up** | After preview refresh | All non-archived conversations | Slow (max=100, concurrency=2) |
| **Roster discovery** | Connect | Roster contacts without a conversation | Slow (max=50, concurrency=2) |
| **Room catch-up** | 10 s after fresh-session setup; per room on SM resume | Confirmed, inactive MAM-enabled rooms | Slow (max=100, concurrency=2) |
| **Lazy fetch** | User opens a conversation/room | Single conversation or room | On demand |

Additionally, once per day, archived conversations are checked for new activity and auto-unarchived if new incoming messages are found.

## Detailed Flow

### 1. Preview Refresh (fast, sidebar)

Triggered immediately when the connection comes online and MAM is discovered.

- Calls `refreshConversationPreviews()`.
- For each non-archived conversation, queries the archive with `max=5` to fetch only the most recent messages.
- Updates `lastMessage` in the store so the sidebar shows correct previews.
- Runs at **concurrency 3** to complete quickly.

### 2. Conversation Catch-Up (slow, background)

Chains after the preview refresh completes.

- Calls `catchUpAllConversations()`.
- For each non-archived conversation:
  - If there are cached messages: sends a **forward query** with `start` = newest cached timestamp + 1 ms, `max=100`. This fetches only messages newer than what is already in the store.
  - If no cached messages exist: sends a **backward query** with `before=""`, `max=50` to fetch the latest messages.
- Runs at **concurrency 2** to be gentle on the server.
- Errors are silently ignored per conversation (best-effort).

### 3. Roster Discovery (new conversations)

Runs in parallel with stages 1-2.

- Calls `discoverNewConversationsFromRoster()`.
- Gets all roster contacts via `sortedContacts()`, then filters out those that already have a conversation in the store (active or archived) using `hasConversation()`.
- For each remaining contact, sends a **backward query** with `before=""`, `max=50` to discover any messages.
- If messages are found, the MAM result handler automatically creates the conversation entry in the store.
- Runs at **concurrency 2**.
- Errors are silently ignored per contact (best-effort).

### 4. Room Catch-Up (delayed, background)

Triggered 10 seconds after fresh-session setup, giving rooms time to finish joining via bookmarks and to discover MAM support.

- Filters rooms to those that confirmed self-presence in the current session,
  are still joined, support MAM, are not Quick Chat rooms, and are not active.
- Peeks at each room's cached messages and uses the same forward/backward query
  pattern as conversation catch-up.
- Revalidates the session, membership, active room, and foreground ownership
  after cache hydration so an obsolete background attempt cannot query MAM.
- Rooms that join or discover MAM after the initial pass are caught up once
  eligible. If a foreground attempt releases an inactive room, ownership is
  handed to this background path rather than issuing overlapping queries.
- Runs at **concurrency 2**.
- The 10-second timer is cancelled on disconnect and cleaned up on subscription teardown.

On an SM resume the delayed pass never runs, so room coverage comes from the
resume seed instead: rooms joined, MAM-enabled, inactive, and **not** already
caught up to live are queried with `catchUpRoom`. Caught-up rooms are skipped:
SM replayed their traffic, and re-querying them on every resume is exactly the
cost this predicate avoids.

The seed is evaluated per room rather than once, because `handleSmResumption`
re-fetches bookmarks after a long disconnect and joins any room that is not
currently joined, hundreds of milliseconds after the resume event. Such a room
is not in `joinedRooms()` when the resume handler runs, and the fresh-session
triggers that would otherwise cover it (the `room:joined` catch-up, the late-MAM
retry, the `mucJoined` preview fetch) are all disabled on a resumed session. It
therefore joins and is caught up as it becomes eligible, once per session.

### 5. Lazy Fetch (on demand)

Triggered by side effects when the user opens a conversation or room.

- If the conversation/room has cached messages: forward query from the newest cached timestamp.
- If no cached messages: backward query for recent history.
- On a fresh session, the active room may display hydrated cache immediately,
  but it waits for successful self-presence (`room:joined`) in that session
  before querying its archive.
- A successful SM resume trusts preserved room membership and does not repeat
  foreground MAM for an archive already held locally. A room whose archive has
  never been held remains eligible on first open or late MAM discovery.
- The active-room catch-up revalidates room, join, and connection state after
  cache hydration; a superseded attempt cannot query MAM or clear its
  replacement's tracking.
- MAM support discovered asynchronously can trigger the active-room fetch only
  after the same session/join eligibility checks pass.

The detailed fresh-session, SM-resume, and cache-hydration invariants are owned
by the [confirmed-join design](superpowers/specs/2026-07-27-room-mam-after-join-design.md).

## Deduplication

The store layer still deduplicates returned messages by ID. In addition, the
foreground and delayed room paths coordinate ownership: the background pass
excludes the active room, observes foreground coverage for the current
membership, and accepts a released attempt only after the room becomes
inactive. This prevents duplicate room archive queries instead of relying on
store deduplication alone.

## Concurrency

All background queries use `executeWithConcurrency()` from `utils/concurrencyUtils.ts` to limit parallel MAM requests:

| Operation | Concurrency |
|-----------|-------------|
| Preview refresh | 3 |
| Conversation catch-up | 2 |
| Roster discovery | 2 |
| Room catch-up | 2 |

Lower concurrency for catch-up keeps server load reasonable during background work.

## Key Files

| File | Role |
|------|------|
| `packages/fluux-sdk/src/core/modules/MAM.ts` | MAM query methods, preview refresh, catch-up, roster discovery |
| `packages/fluux-sdk/src/core/backgroundSync.ts` | Orchestrates all background sync stages on connect |
| `packages/fluux-sdk/src/core/chatSideEffects.ts` and `roomSideEffects.ts` | Active conversation/room cache and MAM triggers |
| `packages/fluux-sdk/src/core/roomMamHandoff.ts` and `roomMembershipEpoch.ts` | Coordinates foreground/background room ownership across membership changes |
| `packages/fluux-sdk/src/utils/concurrencyUtils.ts` | `executeWithConcurrency()` utility |
| `packages/fluux-sdk/src/core/modules/MAM.catchup.test.ts` | Tests for catch-up and discovery methods |
| `packages/fluux-sdk/src/core/roomSideEffects.test.ts` and `backgroundSync.test.ts` | Tests for room trigger, ownership, and handoff wiring |

## Sequence Diagram

```
Connect / Reconnect
│
├─ MAM support discovered
│  │
│  ├─ refreshConversationPreviews()              ← concurrency 3, max=5
│  │  └─ then: catchUpAllConversations()         ← concurrency 2, max=100
│  │
│  ├─ refreshArchivedConversationPreviews()      ← once per day
│  │
│  ├─ discoverNewConversationsFromRoster()       ← concurrency 2, max=50
│  │
│  └─ setTimeout(10s)
│     └─ confirmed inactive room catch-up        ← concurrency 2, max=100
│
├─ User opens conversation
│  └─ fetchMAMForConversation()                  ← on demand, forward query
│
├─ Fresh-session self-presence for active room
│  └─ fetchMAMForRoom()                          ← after cache + eligibility checks
│
├─ Successful SM resume
│  └─ trust membership; skip held room archive
│
└─ User opens eligible room
   └─ fetchMAMForRoom()                          ← on demand, cache first
```
