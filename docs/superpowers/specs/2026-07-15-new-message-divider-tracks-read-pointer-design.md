# New-message divider tracks the read pointer

**Date:** 2026-07-15
**Status:** Design approved, pending spec review

## Motivation

The scroll-to-bottom FAB shows a badge counting the new (unread) messages below the
current position. Two refinements surfaced while building it:

1. The count should be **forward-only** — as the reader scrolls down and sees new
   messages, it counts down; scrolling back up must not resurrect already-seen
   messages.
2. When the reader scrolls back up, the **"New messages" divider** should sit at the
   point they read up to, giving a sense of "here's how far I got," instead of staying
   frozen at the boundary that was new when the conversation opened.

Both are expressions of one idea: the divider and the badge should reflect **reading
progress**, not a static open-time snapshot.

## Key architectural insight

The system already tracks reading progress. `lastSeenMessageId` (the persisted read
pointer, on `conversationMeta` / `roomMeta`) advances forward-only as the reader scrolls,
driven by a viewport `IntersectionObserver` (`useViewportObserver` →
`updateLastSeenMessageId` → the pure `onMessageSeen`). It already drives cross-device MDS
(XEP-0333) sync. The divider (`firstNewMessageId`, a session-only value in
`firstNewMessageMarkers`) is deliberately the **sticky** element: it is derived from
`lastSeenMessageId` once at activation and then left frozen while the pointer creeps
forward.

Therefore, making the divider and badge follow reading progress is a **visual** change
that re-uses an already-advancing, already-synced signal. It adds no new read-state, MDS,
unread-count, or notification behavior — those are all keyed on `lastSeenMessageId` /
`unreadCount`, which already move independently.

There is an exact existing precedent: `applyRemoteDisplayed` →
`resolveRemoteDisplayed` (`shared/readMarkerSync.ts`) recomputes the divider from an
advanced pointer for the active entity by calling `onActivate` with a synthetic state and
keeping only `.firstNewMessageId`. This design mirrors that pattern for a local trigger.

## Design decisions (approved)

- **Divider movement:** snap to the reader's deepest-read point **when they scroll back
  up** — not continuously while reading down (which would make the divider ride the
  viewport bottom and rebuild the virtualized list on every message boundary). It only
  ever moves forward (toward newer messages).
- **Source of "how far read":** the existing persisted read pointer `lastSeenMessageId`.
  Single source of truth for both the badge count and the divider snap. The session-local
  `deepestReadMessageId` watermark added earlier is **removed**.

## Current state (this branch, uncommitted)

An earlier increment this session already shipped (working tree, not yet committed):

- `unreadBadge.ts` — pure `countNewBelowViewport(messages, firstNewMessageId, bottomVisibleId)`.
- Hook `useMessageListScroll` — exposes `bottomVisibleMessageId` (bottom-most-visible row,
  from the existing `lastAnchorRef`).
- `MessageList` — a session-local forward-only `deepestReadMessageId` watermark feeding the
  badge via `countNewBelowViewport`.

This design **refactors** that: the badge switches from the local watermark to the pointer,
and the local watermark + its effects are deleted. `countNewBelowViewport` and
`bottomVisibleMessageId` are retained (the latter now only drives the snap trigger).

## Behavior

Let `P` = index of `lastSeenMessageId` (read pointer), `D` = index of the divider
(`firstNewMessageId`), `B` = index of the current bottom-most-visible row.

- **Reading down:** `P` advances with the viewport (existing behavior). `D` stays put. The
  badge = messages below `P`, so it counts down. The divider does not move (no list
  rebuild while actively reading down).
- **Scroll back up (`B < P`):** the divider snaps to "first unread after the pointer"
  (`resyncDividerToReadPointer`). Because `P` is forward-only, the divider only advances;
  the action is idempotent once the divider already sits there.
- **New messages arrive below:** appended below the pointer, so the badge grows; the
  divider is unaffected (stays at the first-unread boundary).
- **Read through to the bottom:** the existing `clearFirstNewMessageId`-on-reach-bottom
  logic clears the divider; the badge hides. The snap never fires here (it requires an
  existing divider and `B < P`, i.e. not at the bottom).
- **Re-open the conversation:** the divider is already derived from the (persisted,
  possibly cross-device-advanced) pointer — the same derivation the snap uses — so the
  in-session and on-open behaviors are identical.

### Badge / divider consistency

The badge counts strictly below the pointer. When the divider has snapped to
first-unread-after-pointer (`D = P + 1`), "messages below the divider" and "messages below
the pointer" are the same set, so the badge number is unchanged by the snap — only the
divider's visual position moves.

## Components

Mirror the `clearFirstNewMessageId` plumbing at every layer.

### 1. SDK store action — `resyncDividerToReadPointer(conversationId)`

`chatStore.ts` and `roomStore.ts` (twins). For the given conversation:

- Read `meta.lastSeenMessageId` and the resident `messages` array.
- If there is no current marker for the conversation, no-op (do not resurrect a cleared
  divider).
- Recompute the divider exactly as `resolveRemoteDisplayed` does:
  ```
  const divider = onActivate(
    { unreadCount: 0, mentionsCount: 0, lastReadAt: meta.lastReadAt,
      lastSeenMessageId: meta.lastSeenMessageId, firstNewMessageId: undefined },
    messages,
    treatDelayedAsNew ? { treatDelayedAsNew: true } : undefined,
  ).firstNewMessageId
  ```
  (each store passes the same `treatDelayedAsNew` option it already uses at its existing
  `onActivate` / `resolveRemoteDisplayed` call sites — do not introduce a new convention.)
- Set `firstNewMessageMarkers[conversationId] = divider` only when `divider` is a defined id
  that differs from the current marker, writing a new `Map`. When `divider` is `undefined`
  (pointer at/after the newest — nothing unread) this is a **no-op**: the divider is NOT
  cleared here. Clearing is owned by the explicit read-through / mark-read paths, and the
  divider is deliberately kept alive after a FAB jump-to-present so the jump-to-last-read pill
  can offer a return — the snap must never clear it. Touch nothing else — no pointer write, no
  unread/lastReadAt, no MDS.

Notes:
- Forward-only and idempotent by construction: the pointer only advances, so the derived
  divider only advances, and recomputing with an unchanged pointer yields the same id.
- Only meaningful for the active conversation (that is where `messages` are resident);
  callers only invoke it for the active one.

### 2. Expose `lastSeenMessageId` for the active conversation

Currently `useChatActive` hardcodes `lastSeenMessageId: undefined` ("not used by active
view components"). Add a selector:
`useChatStore(s => s.conversationMeta.get(s.activeConversationId)?.lastSeenMessageId)` and
return it. Same for `useRoomActive` (`roomMeta.get(activeRoomJid)?.lastSeenMessageId`).

### 3. Action hooks + active re-export

Add `resyncDividerToReadPointer` to `useChatActions` / `useRoomActions` (getState
delegation, beside `clearFirstNewMessageId` / `updateLastSeenMessageId`) and re-export via
`useChatActive` / `useRoomActive`, matching the existing patterns.

### 4. View prop threading

Thread two new props through `ChatView` → `ChatMessageList` → `MessageList` (and the
`RoomView` equivalents), following the `firstNewMessageId` / `clearFirstNewMessageId`
chains:

- `lastSeenMessageId?: string` — the read pointer for the active conversation.
- `onResyncDivider?: (conversationId: string) => void` — wraps the store action.

### 5. MessageList

- **Badge:** `fabBadgeCount = countNewBelowViewport(deduplicatedMessages, firstNewMessageId,
  lastSeenMessageId)`. Remove the local `deepestReadMessageId` state and its two effects.
- **Snap trigger:** an effect keyed on `bottomVisibleMessageId` (and the pointer / divider):
  ```
  const bIdx = indexOf(bottomVisibleMessageId)
  const pIdx = indexOf(lastSeenMessageId)
  const dIdx = indexOf(firstNewMessageId)
  // Reader scrolled back above the pointer, and the divider still trails it → snap forward.
  if (firstNewMessageId && bIdx >= 0 && pIdx > bIdx && pIdx >= dIdx) {
    onResyncDivider?.(conversationId)
  }
  ```
  The store action's idempotence makes a repeated or slightly-noisy trigger harmless (the
  two "bottom-most visible" signals — `bottomVisibleMessageId` from `findBottomAnchor` and
  the pointer from the viewport observer — can differ by a row at the boundary; the `pIdx >
  bIdx` margin plus idempotence absorb it).

## Edge cases

- **Reader only scrolls up into old history (never past the divider):** the pointer never
  advanced past the divider, so `onActivate` re-derives the same divider — no-op. Correct:
  nothing new was read.
- **Divider already cleared (read to bottom):** UI guard (`if (!firstNewMessageId)`) means
  the snap never fires; the divider stays cleared.
- **Pointer at the newest message:** `onActivate` returns `undefined` → the action is a
  **no-op** (does not clear). This is essential: after a FAB jump-to-present the pointer sits
  at the newest while the divider is intentionally kept alive for the pill; a scroll-up must
  not clear it.
- **Snap only on genuine user scroll:** the snap's bottom-visible tracking updates only on
  non-programmatic scroll, so the entry scroll-to-marker re-assert and FAB jumps never drift
  the divider — it moves only when the reader actually scrolls back up.
- **Sliding-window trim:** indices are compared within the same resident `messages` array
  in the store action (`onActivate` uses `findIndex`), consistent with existing derivation;
  a not-found id yields the existing fallback behavior in `onActivate`.

## Risks

- **Mid-session `firstNewMessageId` change → scroll effects.** Verified safe: the
  conversation-switch effect early-returns on the same conversation; the MDS-settle effect
  acts only on a divider *clear* (`defined → undefined`) and only before the user scrolls;
  the remaining effect merely re-arms `userHasScrolledSinceMarkerRef` (benign, delays
  auto-clear by one scroll event). The FAB two-step (`scrollToBottom`) reads the divider at
  click time — snapping just makes it target the new position, which is desirable.
- **Divider row-height shift.** Moving the marker relocates a `~30px` `NewMessageMarker`
  from one row to another. When both rows are above the viewport (reader scrolled up) the
  content above changes height; the content-anchor restore system is designed to hold
  position against exactly this, but it is the primary thing to prove with `test:scroll`.
  (`onMeasured` already excludes `isFirstNew` rows from the height cache, so no cache
  poisoning.)
- **Badge coupled to synced read state.** A remote MDS advance from another device moves
  the pointer, so the badge here can drop without a local scroll. Accepted as correct
  (those messages were read elsewhere) per the approved architecture choice.

## Testing

- **Pure function:** `countNewBelowViewport` tests already exist; the third argument is now
  the pointer. Add/adjust cases for divider == first-unread-after-pointer consistency.
- **Store action:** unit tests (SDK, pure vitest) — advances the divider forward when the
  pointer advanced; idempotent; no-op when no marker; no-op (does NOT clear) when pointer is at newest;
  writes nothing but `firstNewMessageMarkers`. Chat and room.
- **MessageList (jsdom):** badge is now prop-driven by `lastSeenMessageId` (simpler than the
  geometry mock) — decrements as the pointer prop advances, holds when it does not. Snap
  trigger fires `onResyncDivider` when `bottomVisibleMessageId` moves above the pointer.
- **e2e `test:scroll`:** the gate for all scroll edits. Confirm no position drift / render
  loop when the divider snaps mid-session, on Chromium and WebKit.

## Out of scope

- No change to how the pointer advances, MDS publishing, unread counts, or notifications.
- No new persisted state (the divider stays session-only).
- The jump-to-last-read pill continues to derive its count from `firstNewMessageId`; because
  the divider now tracks the pointer, the pill naturally points at "where you left off,"
  which is an improvement, not a separate change.
