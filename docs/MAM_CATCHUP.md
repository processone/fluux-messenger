# MAM Catch-Up Strategy

This document describes how the SDK uses Message Archive Management (XEP-0313) to keep conversations and rooms up to date, both on initial connect and during normal use.

## Problem

When Fluux is closed, messages continue to flow between contacts and in rooms. On reconnect, only sidebar previews were refreshed (fetching the latest message per conversation). The actual message history was only populated lazily when the user opened each conversation. This meant messages exchanged while offline were not visible until the user navigated to every conversation individually.

Additionally, if a roster contact sent a message while offline but there was no prior conversation, the message would never be discovered — the catch-up only covered conversations already in the store.

## Overview

The SDK uses a **hybrid lazy + background** approach organized into five layers:

| Layer | Trigger | Scope | Speed |
|-------|---------|-------|-------|
| **Preview refresh** | Connect | All non-archived conversations | Fast (max=5, concurrency=3) |
| **Conversation catch-up** | After preview refresh | All non-archived conversations | Slow (max=100, concurrency=2) |
| **Roster discovery** | Connect | Roster contacts without a conversation | Slow (max=50, concurrency=2) |
| **Room catch-up** | 10 s after connect | All MAM-enabled joined rooms | Slow (max=100, concurrency=2) |
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

Runs in parallel with stages 1–2.

- Calls `discoverNewConversationsFromRoster()`.
- Gets all roster contacts via `sortedContacts()`, then filters out those that already have a conversation in the store (active or archived) using `hasConversation()`.
- For each remaining contact, sends a **backward query** with `before=""`, `max=50` to discover any messages.
- If messages are found, the MAM result handler automatically creates the conversation entry in the store.
- Runs at **concurrency 2**.
- Errors are silently ignored per contact (best-effort).

### 4. Room Catch-Up (delayed, background)

Triggered 10 seconds after connect, giving rooms time to finish joining via bookmarks and to discover MAM support.

- Calls `catchUpAllRooms()`.
- Filters rooms to only those that are joined, support MAM, and are not Quick Chat rooms.
- Same forward/backward query pattern as conversation catch-up.
- Runs at **concurrency 2**.
- The 10-second timer is cancelled on disconnect and cleaned up on subscription teardown.

### 5. Lazy Fetch (on demand)

Triggered by side effects when the user opens a conversation or room.

- If the conversation/room has cached messages: forward query from the newest cached timestamp.
- If no cached messages: backward query for recent history.
- Also triggered on reconnect for the currently active conversation/room.
- Triggered when MAM support is discovered for the active room (room MAM discovery can be asynchronous).

## Deduplication

The store layer handles deduplication automatically. If the background catch-up and the lazy fetch both return the same messages, duplicates are discarded by the store based on message IDs. This means the active conversation does not need to be excluded from background catch-up — simpler code with no risk of duplicate messages.

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
| `packages/fluux-sdk/src/core/sideEffects.ts` | Lazy loading triggers: conversation switch, reconnect |
| `packages/fluux-sdk/src/utils/concurrencyUtils.ts` | `executeWithConcurrency()` utility |
| `packages/fluux-sdk/src/core/modules/MAM.catchup.test.ts` | Tests for catch-up and discovery methods |
| `packages/fluux-sdk/src/core/sideEffects.test.ts` | Tests for side-effect wiring |

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
│     └─ catchUpAllRooms()                       ← concurrency 2, max=100
│
├─ User opens conversation
│  └─ fetchMAMForConversation()                  ← on demand, forward query
│
└─ User opens room
   └─ fetchMAMForRoom()                          ← on demand, forward query
```
