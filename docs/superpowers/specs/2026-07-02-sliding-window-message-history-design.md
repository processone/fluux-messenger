# Sliding-window message history (unlimited scroll-back)

**Date:** 2026-07-02
**Status:** Design approved, pending spec review → implementation plan

## Problem

The in-memory message array per conversation is hard-capped at 5000
(`MAX_MESSAGES_PER_ROOM` in `roomStore.ts`, `MAX_MESSAGES_PER_CONVERSATION` in
`chatStore.ts`), enforced via `trimMessages(msgs, N) = msgs.slice(-N)` — "always keep
the newest N." Consequence: scrolling up past 5000 is a **wall**. `prependOlderMessages`
loads an older batch, then `slice(-5000)` trims it straight back off, so load-older
becomes a no-op past the cap.

We want **unlimited scroll-back** ("go back anywhere in time") without unbounded RAM
growth and without breaking scroll geometry.

## Key insight

The SDK already durably persists every message it has seen (IndexedDB message cache)
and can MAM-query the server to fill gaps. So the in-memory array does **not** need to
hold the whole history — it can stay a **bounded window** over the loaded neighborhood,
with the cache + MAM as the backing store.

This sidesteps the documented blocker for the naive "remove the cap" approach: a huge,
mostly-estimated array collapses the virtualizer's `getTotalSize()` (the running-average
estimate was tried and removed — see `tanstackMessageVirtualizer.ts` lines 112-118).
A bounded window never produces a huge array, so **the size-estimate strategy does not
change**.

## Goals

- Scroll up indefinitely; the 5000 wall is gone.
- Resident RAM stays bounded (≈ one window per active conversation; inactive
  conversations remain fully evicted on switch).
- Existing scroll invariants continue to hold (bottom-stick, catch-up, MDS first-unread
  marker, search "go to message", deep-history restore).
- No virtualizer size-estimate change.

## Non-goals

- Full-history random-access scrollbar (drag-to-any-point-in-time). The scrollbar is
  **progressive**: it represents the currently-loaded window; scrolling to an edge loads
  more. This is the chosen UX (WhatsApp/Signal/Telegram style) and avoids needing a
  reliable total message count (MAM does not give this cheaply) or placeholder rows.
- Persisting the session height cache to IndexedDB (out of scope; unaffected).

## Design

### Core model — bounded bidirectional sliding window

The resident array (`roomRuntime.messages`, and the chatStore equivalent) is a window of
at most `RESIDENT_WINDOW_SIZE` messages (rename of the current constant; **5000**,
tunable) that slides over history as the user scrolls. Trim direction follows load
direction:

| Direction | Trigger | Merge | Evict from | Anchor |
|---|---|---|---|---|
| Older (scroll up) | `onScrollToTop` → cache, MAM for gaps | prepend older | **newest end** | prepend-restore (exists); bottom-evict is anchor-safe (removes rows below viewport) |
| Newer (scroll down) | NEW `onScrollToBottom`-approaching | append newer | **oldest end** | append is anchor-safe at bottom; top-evict needs a NEW correction mirroring prepend-restore |

Today both paths keep the newest N. The change: **older-load keeps the older end**, and
a **new newer-load path** keeps the newer end.

### New/changed pieces

1. **Directional trim helpers** (`messageArrayUtils.ts`)
   - `prependOlderMessages(..., maxCount)` currently does `slice(-maxCount)` (keeps
     newest). Change so, when loading older, it keeps the **oldest** `maxCount`
     (`slice(0, maxCount)` after prepend) — i.e. evict the newest tail.
   - Add the mirror for appends: when appending newer to a slid window, keep the newest
     `maxCount` (existing `slice(-maxCount)` behavior — already correct for appends).
   - Keep these as small pure functions with unit tests.

2. **`loadNewerMessagesFromCache(convId, limit)`** store action, mirror of
   `loadOlderMessagesFromCache`. Loads the next-newer cache slice after the resident
   window's newest message and appends, evicting the oldest end. MAM fallback reuses the
   existing forward-catch-up path when the cache has a gap.

3. **Load-newer scroll trigger** in `useMessageListScroll.ts` — symmetric to the
   `onScrollToTop` / `canLoadMore` machinery: when the user scrolls within a threshold of
   the resident window's bottom AND the window is not at the live edge, fire
   `onLoadNewer`. Wire `onLoadNewer` through `MessageList` like `onScrollToTop`.

4. **Append-newer anchor correction** — evicting the oldest (top) rows shifts every
   offset up by the evicted height. Add a restore mirroring the existing MAM-prepend
   restore (`getOffsetForMessageId` + the scroll hook's per-frame re-assert) so the
   viewport does not jump. This is the main new scroll work and the highest-risk piece.

5. **Live-edge gating on message add** — `addMessage` (roomStore ~1171, chatStore
   equivalent) currently appends every incoming message + trims newest. When the window
   is NOT at the live edge (`isAtBottomRef` false / `isCaughtUpToLive` false), an incoming
   live message must **not** be appended to the resident array (it would create a
   discontinuity — the window's newest and the live message are non-contiguous). Instead:
   the message is still persisted to cache and still updates meta (unread badge, sidebar
   `lastMessage` preview); the view is undisturbed. When the window IS at the live edge,
   behavior is unchanged (append + stick to bottom).

6. **Jump-to-latest** — resets the resident window to the newest slice from cache and
   scrolls to bottom. Reuses the existing "scroll to bottom" affordance; when the window
   has slid up, it first reloads the newest window (via `loadMessagesFromCache` /
   `loadNewerMessagesFromCache` to the tail). A "new messages ↓" indicator surfaces when
   live messages arrive while scrolled up.

### What does NOT change

- **Virtualizer size estimate** — the array stays ≈ `RESIDENT_WINDOW_SIZE`, so the
  constant estimate + session height cache (`messageHeightCache.ts`) keep working. No
  `getTotalSize` strategy change.
- **Conversation-switch eviction** — inactive conversations still cleared to `[]`.
- **Scrollbar** — spans the loaded window (progressive), as chosen.

## Edge cases

- **Window at the live edge, new message arrives** → append + bottom-stick (today's path).
- **Window slid up, new message arrives** → not appended; unread/preview meta update;
  jump-to-latest indicator.
- **Scroll up to the true start of history** → `isHistoryComplete` gates load-older off
  (today's behavior); no eviction of newest is needed once nothing older exists.
- **Search "go to message" / deep-history restore** → already REPLACE the resident array
  with a cache slice centered on the anchor (`loadMessagesAroundFromCache`); this becomes
  the general "recenter the window" primitive and must respect `RESIDENT_WINDOW_SIZE`.
- **Rapid up/down scrolling** → load-older and load-newer must be mutually guarded
  (`isLoadingOlder` / a new `isLoadingNewer`) so they don't thrash the window.

## Testing

- **Unit** (`messageArrayUtils`): directional trim — prepend-older evicts newest;
  append-newer evicts oldest; boundaries and dedup preserved.
- **Store** (`roomStore` / `chatStore`): load-older past the bound keeps sliding (not a
  no-op); `loadNewerMessagesFromCache` appends + evicts oldest; live-message-while-slid-up
  does not append/corrupt the window; jump-to-latest recenters to newest.
- **Scroll e2e** (`npm run test:scroll`): anchor preserved on prepend+evict AND
  append+evict; jump-to-latest lands at bottom; existing invariants (bottom-stick,
  catch-up, MDS marker, search-jump, deep-history restore) still pass.

## Risks

- **Append-newer anchor correction** (top-eviction offset shift) is new and touches the
  same delicate scroll machinery that has a long history of subtle bugs. Mitigate by
  mirroring the proven prepend-restore and covering with scroll e2e.
- **Live-edge gating** must be correct or live messages either vanish (dropped) or corrupt
  the window (gap). Reuse existing `isAtBottomRef` / `isCaughtUpToLive` signals; test both
  branches.
- **Interaction with catch-up / MAM forward gap** — the new load-newer path and the
  existing forward-catch-up both append newer; they must share one code path, not race.

## Open tunables (chosen defaults)

- `RESIDENT_WINDOW_SIZE = 5000` (unchanged value; now a sliding-window bound). Smaller
  (e.g. 1500) trades RAM for more frequent cache loads — revisit after measuring.
- Live-while-scrolled-up = jump-to-latest affordance (no view disruption).

## Scope

Both `roomStore` (MUC) and `chatStore` (1:1), symmetric. Reference implementation shares
the directional-trim helpers and the load-newer/anchor patterns across both stores.
