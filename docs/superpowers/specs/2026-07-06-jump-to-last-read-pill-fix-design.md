# Jump-to-Last-Read Pill Fix Design

**Date:** 2026-07-06
**Status:** Approved (design), pending implementation plan
**Resolves:** [#870](https://github.com/processone/fluux-messenger/issues/870) (jump-to-last-read pill is dead UI)
**Follows:** [#869](https://github.com/processone/fluux-messenger/issues/869) (MUC catch-up & read-state redesign), spec `2026-07-06-muc-catchup-read-state-design.md` §2/§6

## Problem

The jump-to-last-read pill shipped with #869 but is effectively dead UI.
Its visibility is `visible={!!firstNewMessageId && markerAboveViewport}`
in `MessageList.tsx`, and its action (`scrollToMarker`) and count
(`markerUnreadCount`) all ride the same `firstNewMessageId` value. The
message-list scroll layer clears that value on three **non-read** events,
collapsing the anchor's lifetime to the ~48px window where the divider
straddles the viewport top:

- **Scrolled past** — `markerRect.bottom < scrollerRect.top`
  (`useMessageListScroll.ts` ~1812).
- **Trimmed from DOM** — marker row virtualized away, element not found
  (~1817).
- **FAB second step** — `scrollToBottom` explicitly calls
  `clearFirstNewMessageId()` (~1339) on the jump-to-present.

Result: via the FAB two-step and via Esc (marks read), the anchor clears
before the pill can durably show, and `scrollToMarker` would no-op even
if it did. The pill essentially never appears.

## Key finding: the anchor is already decoupled

`clearFirstNewMessageId` is **purely visual**. In both stores it only
deletes an entry from the `firstNewMessageMarkers` Map
(`roomStore.ts` ~1720, mirror in `chatStore.ts`) — it has **no**
read-state side effects. The read pointer (`lastSeenMessageId`) advances
independently through the viewport IntersectionObserver
(`updateLastSeenMessageId` → `notifState.onMessageSeen`, which never
touches `firstNewMessageMarkers`) and through inbound MDS. Counts are
always re-derivable from the pointer.

So `firstNewMessageId` **already is** the "divider anchor for this visit"
that spec §2 describes ("persists for the visit while the viewport
advances `lastSeenMessageId` underneath"). The only defect is that the
scroll layer clears it too aggressively. This makes approach (b) —
repurpose the existing anchor by correcting its clear conditions —
strictly better than approach (a) — introduce a parallel per-visit
anchor. A parallel value would be redundant with the store anchor and
would desync the pill's jump target from the rendered divider row.

## Decision: clear semantics ("skipped vs read-through")

The divider + pill clear on a genuine **read-through** gesture but persist
through a **skip**:

- **Read-through** — manually scrolling *down* through the divider to the
  bottom = "I read the backlog" → clear, no pill.
- **Skip** — a FAB / programmatic jump-to-present past the divider =
  "I skipped it" → keep the anchor, show the pill so the reading position
  stays one click away until the visit ends.
- **Always clears** regardless of scroll gesture: Esc (mark read),
  mark-all-read, leaving the tab / deactivation, and sending a message
  (500ms, user is engaged).

This resolves the source contradiction between spec §2 ("persists for the
visit ... clears on deactivation") and #870 ("clear-on-genuine-read-scroll
should stay") in favor of #870's model: distinguishing reading from
skipping is the more useful UX and matches Slack/Discord, where the NEW
line stays until you leave or mark read.

## The fix (approach b)

All changes are in `apps/fluux/src/components/conversation/useMessageListScroll.ts`.
The net effect is a **removal** of clear branches from the fragile scroll
logic — no new state, no new store surface.

1. **Remove the "scrolled past" clear branch** (~1805–1815). This fires
   exactly when the user has moved toward the present without reading to
   the bottom — the pill's reason to exist.
2. **Remove the "trimmed / not-in-DOM" clear branch** (~1816–1820). The
   anchor must outlive virtualization. Pill visibility already computes
   from the virtualizer offset (`getOffsetForMessageId`, ~1753), which
   works for unmounted rows, so this survives trimming for free.
3. **Remove the explicit clear in the FAB's `scrollToBottom`** (~1339).
   The jump still marks read — the viewport observer advances the pointer
   as the newest message enters view (unchanged) — but the anchor now
   survives so the pill appears.
4. **Keep the "reached bottom" manual clear** (~1801), already gated
   `!programmaticScroll` and by the first-scroll / `recentUserScrollIntent`
   guards. This is the read-through gesture. If `test:scroll` reveals that
   a settling FAB `reassertBottom('fab')` scroll trips it after the loop
   clears `reassertLoopRef`, harden the gate with the existing
   `isProgrammaticScroll(...)` window rather than the bare
   `!programmaticScroll` check.

Everything the pill needs — visibility (`markerAboveViewport`), count
(`markerUnreadCount`), action (`scrollToMarker` → `runMarkerReassertLoop`),
and the rendered divider row (`showNewMarker`) — continues to ride the one
persisted `firstNewMessageId`, so they stay in sync by construction.

## Behavior after the fix

- **Open at divider:** anchor visible → `offset ≈ scrollTop` → pill hidden.
- **FAB two-step:** first click scrolls to the marker (align start;
  `offset ≈ scrollTop`, pill hidden, divider at top); second click goes to
  the bottom → divider now above viewport → pill shows "N new · Jump to
  last read"; clicking it returns to the divider.
- **Manual read-through:** scrolling down through the divider to the bottom
  clears the anchor (read-through), pill gone.
- **Esc / leave / mark-all-read:** clears the anchor.
- **Next visit:** the pointer is at newest (the jump/read marked it read),
  so activation derives no divider — caught up, opens at bottom.
- **Degraded count:** when the count can't be derived from cache
  (`markerUnreadCount === 0`), the pill degrades to "You were away · Jump
  to last read" (existing `JumpToLastReadPill` copy).

## Edge cases

- **Non-virtualized mode:** all rows are always mounted, so the removed
  trim branch was never reachable there and pill visibility uses the DOM
  `offsetTop` fallback. No behavior change. Virtualization is default-on,
  so this path is secondary.
- **Prepend / append while anchor persists:** the divider is a fixed
  message id; loading older or newer messages does not change which
  message it points to. `markerUnreadCount` (messages from the divider to
  the end) recomputes correctly.
- **Own MDS echo mid-visit:** existing `lastConsideredSeenId` dedup makes
  our own published marker a no-op on return, so the active-entity
  `advanced-with-divider` recompute does not delete the divider mid-visit.
  Unchanged by this fix; covered by existing tests.

## Testing

This is the codebase's most fragile area. Gate every change on
`npm run test:scroll` — green **before and after**.

- **Scroll invariants (`npm run test:scroll`, 46 invariants, ~3 min):**
  run green before starting and after each change.
- **New e2e (`scripts/scroll-invariants.ts`, Playwright):** the spec §6
  test deferred from #869. FAB-jump past a divider → assert the pill
  appears; click the pill → assert it returns to the divider. Fraction
  anchors are not verifiable in jsdom, so this must be a real Playwright
  test, not a unit test.
- **Isolated `JumpToLastReadPill.test.tsx`** (props-driven) stays as-is.
- **Full app suite** (`apps/fluux` vitest) + **root typecheck**
  (`npm run typecheck`) green, no stderr.

## Out of scope

- No change to the read-pointer / MDS / counting machinery from #869.
- No change to the store `firstNewMessageMarkers` surface or its
  activation derivation (`onActivate`).
- No new settings, no keyboard shortcut for the pill.
