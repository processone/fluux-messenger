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
