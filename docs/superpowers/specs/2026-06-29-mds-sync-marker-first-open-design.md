# Sync marker only on first open (Approach A)

Date: 2026-06-29

## Problem

Returning to a conversation often jumps to the bottom (or a wrong mid-point) instead of
restoring where the user was. Root contributor: XEP-0490 (Message Displayed Synchronization)
advances the persisted, forward-only `lastSeenMessageId` from other devices' read positions.
The unread divider (`firstNewMessageId`) is derived from `lastSeenMessageId`, and the message
list's conversation-switch effect scrolls to that divider on **every** open where a divider
exists and no scrolled-up position was saved — not only the first open. So a cross-device read
sync ends up driving scroll position on each re-open.

## Desired behavior (confirmed)

- **First open per app session**: the synced read marker may position the view (scroll to the
  unread divider as today).
- **Re-open within the session (navigate-back / reload)**: restore this client's local scroll
  position; do **not** scroll to the synced marker. If there is no saved local position (the
  user was at the bottom), go to the bottom.
- "First open per session" = `scrollStateManager` has not yet initialized this conversation.
  The manager is an in-memory singleton reset on logout and rebuilt on app reload, so this is
  naturally per-session and identical on web and Tauri/WebKit.

## Approach A — gate the divider scroll-branch to first-open-per-session (app-only)

In the conversation-switch `useLayoutEffect` of
`apps/fluux/src/components/conversation/useMessageListScroll.ts`:

1. Capture `firstOpen = !scrollStateManager.isInitialized(conversationId)` **before** calling
   `enterConversation` (which flips the `initialized` flag).
2. Change the unread-divider branch condition from `else if (firstNewMessageId)` to
   `else if (firstNewMessageId && firstOpen)`.
3. Everything else is unchanged:
   - `restore-position` branch still runs first (independent of `firstOpen`) — saved local
     position always wins on re-open.
   - `targetMessageId` branch (explicit reply/search/activity jump) still works on re-open.
   - Falling through with no saved position lands at the bottom.

The divider line is still rendered as a visual aid; we only stop auto-scrolling to it on
re-open.

### Why this matches the two requirements

- On the genuine first open, `enterConversation` returns `scroll-to-bottom` (first view) and
  `firstOpen` is true → the marker branch positions at the divider (unchanged behavior).
- On a return, `firstOpen` is false → the marker branch is skipped. If a scrolled-up position
  was saved, `restore-position` already restored it; otherwise the local position was the
  bottom, so bottom is correct.

## Out of scope

- No change to XEP-0490 read-state semantics: cross-device unread badges and read-sync continue
  to work (this is purely a scroll-positioning gate). The SDK entry-fold (Approach B) is **not**
  changed.

## Cross-platform

Approach A is pure React scroll-decision logic with no platform-specific branch. It executes
identically on web (Chromium) and Tauri (WebKit). Verified in demo mode on web; the same code
path runs on desktop.

## Testing

- Unit (existing scroll suite, `useMessageListScroll.restore.test.tsx` /
  `MessageList.virtualizedScroll.test.tsx`):
  - First open with a divider → scrolls to the marker.
  - Re-open of the same conversation (initialized) with a divider and a saved scrolled-up
    position → restores the saved position, does **not** scroll to the marker.
  - Re-open with a divider and no saved position (was at bottom) → lands at bottom, not marker.
- Manual/demo (web): open a conversation with unread → lands at divider; scroll up; switch away
  and back → restores position rather than jumping to the divider/bottom.
