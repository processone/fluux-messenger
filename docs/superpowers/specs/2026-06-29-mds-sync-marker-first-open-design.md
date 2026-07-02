# Sync marker only on first open (XEP-0490)

Date: 2026-06-29

## Problem

Returning to a conversation could jump to the bottom (or a wrong mid-point). The unread divider
(`firstNewMessageId`) is derived from `lastSeenMessageId`, which XEP-0490 (Message Displayed
Synchronization) advances from other devices' read positions. The synced read position was being
consumed on **every** conversation open, so a cross-device read-sync could reposition the divider
on each return.

## Desired behavior (confirmed)

- The XEP-0490 synced read position drives the divider only on the **first open of a conversation
  per app session**.
- On a re-open within the session (navigate-back / reload), the synced marker is **not**
  re-applied; the client keeps the position it already had.
- XEP-0490 markers are broadcast live over PEP, so after the first consumption the live
  `read:displayed-synced` notifies keep loaded conversations current — there is no need to
  re-check pending markers on each open during a session.

## Approach B — gate the XEP-0490 entry fold in the SDK (chosen)

`activateConversation` (chatStore) and `activateRoom` (roomStore) fold a pending
`pendingRemoteDisplayedStanzaId` into `lastSeenMessageId` before deriving the divider. Gate that
fold to the **first activation of each conversation/room per session**:

- A module-level `Set<string>` (`mdsConsumedThisSession`) per store records which
  conversations/rooms have had their synced marker consumed this session.
- On activation: if not yet consumed, fold the pending marker (as before) and mark consumed; if
  already consumed, skip the fold (a `[MDS]` debug line records the skip).
- The set is cleared in each store's `reset()` (logout/account switch), so it is naturally
  per app session and platform-agnostic (web and Tauri/WebKit behave identically).

Pending markers that arrive while a conversation is loaded are still applied live via the
`read:displayed-synced` binding (unread badges stay correct); only the entry-time *fold* is gated.

## Why NOT Approach A (scroll-layer gate)

The first attempt gated the message-list `firstNewMessageId` scroll branch on first-open-per-session.
That was the wrong layer: at the scroll layer a **stale/synced** marker and a **genuine "new
message arrived while away"** marker are indistinguishable, so it suppressed the latter on re-entry
and broke the deliberate e2e invariant *"return to room after a new message shows the marker and the
message"* (`scripts/scroll-invariants.ts`). Provenance is only knowable in the SDK, so the gate
belongs there. The scroll-layer branch is left unchanged (`else if (firstNewMessageId)`); a
`firstOpenThisSession` value is still logged there for diagnostics only.

## Out of scope

No change to XEP-0490 read-state semantics beyond the entry-fold gate: cross-device unread badges
and live read-sync continue to work.

## Diagnostics (kept in, gated off by default)

Under the shared `fluux:scroll-debug` flag (`__fluuxScrollDebug(true)`), retained until confirmed on
the desktop build:
- `[Nav]` screen transitions in ChatLayout (view mount/unmount, active ids)
- `[Scroll]` MessageList MOUNT/UNMOUNT, no-saved-state→bottom, and a new-message "no bottom-row
  change" line (covers "sent a message but it didn't scroll")
- `[MDS]` XEP-0490 dispatch + activation folds (and skips), logging `lastSeenMessageId` before/after

## Testing

- SDK unit (chatStore.mds.test.ts / roomStore.mds.test.ts): a second activation in the same session
  with a fresh further-ahead pending marker does NOT re-fold (`lastSeenMessageId` unchanged);
  first-open fold still applies. Both verified RED (gate defeated) → GREEN.
- e2e (`scripts/scroll-invariants.ts`): the "new message while away → divider visible on re-entry"
  invariant passes (chromium verified locally; webkit via CI).
- App scroll unit suite unchanged behavior (the scroll-layer marker branch is not gated).

## Addendum (2026-07-02): the seed lands AFTER first open (race)

Approach B assumes the pending `pendingRemoteDisplayedStanzaId` is present when
`activateConversation`/`activateRoom` runs, so the entry fold can consume it before the
divider is derived. But the fresh-session seed (`mdsSideEffects` `online` handler →
`client.mds.fetchAllDisplayed()`) is a fire-and-forget async PEP fetch that is NOT awaited by
activation. If the user opens a conversation before that IQ round-trips back, `pending` is
undefined at the fold, so:

1. the divider is derived from the STALE local read position (first open lands at the last
   *local* place, not the synced read), and
2. the seed lands moments later and advances `lastSeenMessageId` **live** — but the old code only
   updated the badge, never the divider, so the corrected position only surfaced on the NEXT open
   ("jumps to the end only on re-open").

### Fix (two layers, provenance stays in the SDK)

- **SDK — `applyRemoteDisplayed` recomputes the divider for the ACTIVE conversation.** When a
  marker advances `lastSeenMessageId` and `activeConversationId`/`activeRoomJid` matches, re-derive
  `firstNewMessageMarkers[id]` via `notifState.onActivate` (chat: `treatDelayedAsNew:true`; rooms:
  default). Inactive entities are left untouched (recomputed on their next activation). This extends
  the doc's existing "applied live" path from the badge to the divider. Tests:
  `chatStore.mds.test.ts` / `roomStore.mds.test.ts` — "recomputes … when a late marker advances the
  ACTIVE conversation/room past the divider" + a non-active gate (RED → GREEN).
- **App — settle-window re-scroll (`useMessageListScroll`).** The conversation-switch effect captures
  the marker id at entry and its re-assert loop chases that stale target, so the SDK divider clear
  needs a companion `useLayoutEffect`: on a live divider CLEAR (defined → undefined) for the SAME
  conversation, while the user has NOT scrolled since entry (`userHasScrolledSinceEntryRef`), call
  `reassertBottom()` (single-flight → supersedes the stale marker loop). Self-contained prev-conv ref
  so a genuine switch is excluded. Not verifiable in jsdom/preview (rAF gated); verify on device /
  via `scripts/scroll-invariants.ts`.

Note: the divider recompute is deliberately NOT gated by `mdsConsumedThisSession` — that gate is only
about re-*folding* a stale marker at ENTRY. A genuine forward read-sync arriving live SHOULD move the
divider (that is what "keep loaded conversations current" means); the settle-window/user-scroll gate
in the app is what prevents yanking a user who has taken over the scroll.
