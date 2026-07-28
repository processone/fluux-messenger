# Unread count is one canonical number across every numeric surface — acceptance spec

Scope: an addendum to the read-state consolidation design
([2026-07-22-read-state-model-consolidation-design.md](2026-07-22-read-state-model-consolidation-design.md)),
landing inside **PR B** (the count derivation) on top of **B0** (the canonical
one-row-per-message store). This document fixes the model for **three independent count
computations feeding five numeric renderings** (conversation sidebar, room tooltip, divider,
floating pill, FAB badge) that today disagree, and specifies the acceptance tests PR B must
pass.

## The principle

**There is exactly one unread count per conversation/room: the number of eligible messages
whose canonical archive position is strictly after the effective read boundary.** An
**eligible** message is incoming (`!isOutgoing`) and renderable (`isRenderableStoredMessage`);
delayed/offline messages are *not* excluded — a delayed message whose archive position is
after the boundary simply *is* unread (the design removes `treatDelayedAsNew` precisely
because a timestamp floor makes it moot). The **effective read boundary** is the read
pointer's position when a pointer is present, otherwise `historyFloor`
(`computeFloor(readPointer, historyFloor)`), subject to the design's documented defer
conditions (coverage-incomplete, pointerless-with-count, un-migrated / pending marker). The
count is derived once (PR B: archive-cursor, coverage-gated, capped — `countUnreadInArchive` /
the store's `unreadCount`) and every user-visible unread surface renders *that same number*.

**There are five numeric renderings of the one count** — all must show the same value:

- **Conversation sidebar counter** — the canonical count.
- **Room row tooltip** — the canonical count. The room row's unread dot remains a
  non-numeric presence indicator, and its `@mentionsCount` badge is a separate quantity.
- **Divider** (`NewMessageMarker`, the in-list "New messages" line) — positioned at the first
  eligible message after the boundary, and it **labels the canonical count** (e.g.
  *"2 new messages"*). It takes no count today (`NewMessageMarker.tsx` — only `provisional`);
  PR B passes the canonical count to it and the test asserts the **divider's own text**.
- **Floating marker pill** (`JumpToLastReadPill`, shown while the divider is above the
  viewport) — the canonical count.
- **FAB badge** — when shown, the canonical count.

No surface may recount DOM rows or the loaded/resident message array. The current
`markerUnreadCount` (resident-array length − divider index, `MessageList.tsx`) and
`countNewBelowViewport` (`unreadBadge.ts`) are **removed**. The three `MessageList` numeric
surfaces receive the canonical count as one prop; the conversation counter and room tooltip
read the same store projection. All five format it through **one shared formatter** (see the
cap decision below) so identical values render identically.

**The divider live-tracks the boundary, but never moves the reader.** The divider is a true
canonical-count surface (not a frozen session anchor — this supersedes design decision #4's
freeze): when the effective read boundary changes, including a **remote XEP-0490 marker** that
advances the pointer while the conversation is active, the divider repositions to the new
boundary or disappears, and its label follows the canonical count. A count of `0` removes the
divider **and** its floating pill. The hard constraint: **repositioning or removing the divider
must preserve the currently visible message's pixel offset** — a remote pointer update changes
the semantic boundary but must **not** visually scroll the reader. This reuses the existing
content-anchor scroll mechanism (anchor a stable visible message, re-assert its offset after the
divider mutates the list layout); it is a scroll-anchoring requirement, `test:scroll`-gated.

**Scrolling is navigation, not read state.** The viewport position governs exactly two
things and never the count:

| FAB property | Driven by | Rule |
|---|---|---|
| **Visibility** | viewport / window | Visible when the conversation is away from the bottom (or the sliding window is slid up). Unchanged from today. |
| **Badge** | read state | The canonical count, through the shared formatter. `0` ⇒ no badge, even while the FAB is visible. |
| **Action** | **marker geometry**, not the count | Two-step, preserved exactly as `useMessageListScroll.ts` already implements it: **first click goes to the divider only when the divider is still *below* the viewport** (`markerOffset > viewportBottom`); when the divider is on-screen or scrolled *above* the viewport, or there is no divider, the click goes straight to the bottom. A non-zero canonical count is **not** sufficient to pick the marker as the destination — relative geometry decides. |

There is **no user-visible "messages below the viewport" count** anywhere. A conversation
the user has fully read, then scrolled up in, shows a visible FAB with **no badge** — the
messages below the fold are read, so they contribute nothing to unread.

**Display cap.** The derivation/store caps the value at **999** (design), which bounds the
cursor early-out. Display is then a single **shared UI formatter** (`formatUnreadCount`) used
by all five numeric surfaces, so the same value renders identically everywhere; the exact display
threshold (the design renders `999+`) is the one product-design knob — change the formatter's
constant, never a per-surface literal. This resolves the earlier `99+`-vs-`999+` split: one
store cap (999), one formatter, five identical numeric renderings.

## Convergence at the live edge, and the on-arrival pointer precondition

When the room is **active, focused, and the viewport is at the live edge**, the local read
pointer advances *optimistically and locally* — the canonical count becomes `0`, the divider
and pill are removed, and the FAB is hidden (viewport at bottom) **immediately**, without
waiting on the server. MDS / XEP-0490 publication is a best-effort side effect that retries
independently; the UI never blocks the count/marker on a publish acknowledgement. A lingering
non-zero count while the user is settled at the bottom is a brief transitional state, never the
steady state.

**PR B tightens one existing pointer writer's precondition (a scoped, acknowledged exception to
the B/C boundary).** Today `onMessageReceived` (`notificationState.ts`) treats
`userSeesMessage = isActive && windowVisible` as "seen" and advances the pointer on arrival —
so an active, focused, but **scrolled-up** conversation wrongly marks new messages read, and the
archive derivation then faithfully derives `0`. Removing the count force-zero is not enough; the
count is correct, the *pointer* is wrong. PR B therefore gates this advance: **an incoming
message advances the pointer only when the user is demonstrably at the live edge.** This is *not*
a new or relocated writer — PR C still owns removing/consolidating writers — it only tightens an
existing writer's unsafe precondition, which is squarely in the safe direction (it advances the
forward-only pointer *less* often). Required properties:

- Use the **real viewport-at-live-edge signal** (the app's `viewportAtBottom`-class evidence) —
  **not** `windowVisible`, **not** active status, **not** the sliding-window `windowAtLiveEdge`.
- Treat **missing / stale / unknown** viewport state **conservatively as "not at the live
  edge"** → do not advance.
**Viewport evidence ownership and freshness.** The **SDK owns** an entity-scoped runtime
evidence state — `unknown | at-edge | away` — associated with the current **activation
generation**. Activating or switching a conversation/room **synchronously** creates a new
generation with `unknown` evidence. The app **reports** measured viewport state through an
**explicit SDK action**, including that generation; reports carrying a **previous generation are
ignored**. `onMessageReceived` advances the pointer only when the current entity's
**current-generation** evidence is explicitly `at-edge`.

The existing boolean `isAtBottomRef` may remain internal to `ChatView`/`RoomView` scroll
mechanics, but it must **not** itself serve as cross-entity semantic evidence, and the SDK must
**not** import `apps/fluux` utilities (today `registerViewportBottomRef` is app-owned, so it is
*not* the app→SDK boundary `onMessageReceived` needs — this replaces it with the SDK-owned,
generation-stamped state above). PR C still owns writer removal/consolidation; PR B changes only
this precondition.

## Coverage-incomplete never falls back to a viewport count

When the local archive is not contiguous from the floor to the live edge, PR B's derivation
returns `deferred` and the **last trustworthy count is kept** (see the design's coverage
gate). There is explicitly **no** "substitute the count of loaded/visible rows" fallback for
any surface — a partial archive keeps the previous canonical number, it does not silently
show a viewport-derived one. Any place that cannot obtain an exact count defers; it does not
improvise a DOM-row count.

## What changes in the code (PR B app-side task)

- **Delete** `apps/fluux/src/components/conversation/unreadBadge.ts`
  (`countNewBelowViewport`) and its tests.
- **Delete** the `markerUnreadCount` resident-array memo in `MessageList.tsx`.
- **Thread the canonical count** (`meta.unreadCount` / `room.unreadCount`, PR B's
  pointer-derived value) from `ChatView` / `RoomView` into `MessageList` as a single
  `unreadCount` prop. Route the **conversation sidebar counter**, **room row tooltip**,
  **divider** (`NewMessageMarker` — add a `count` prop; it has none today), floating
  **marker pill** (`JumpToLastReadPill count=`), and **FAB badge** through the shared
  `formatUnreadCount`.
- **Divider text is a real acceptance surface** — the tests assert `NewMessageMarker`'s own
  rendered text (e.g. *"2 new messages"*), not only the pill's.
- **Divider live-tracks the boundary with anchor preservation** — it repositions/clears when the
  boundary moves (including a remote XEP-0490 advance), and every such mutation preserves the
  visible message's pixel offset via the content-anchor mechanism. `test:scroll`-gated.
- **Marker/divider position** stays `firstNewMessageId` (first eligible message after the
  effective read boundary); only its *count label* is added/switched to the canonical value.
- **FAB visibility** (`fabVisible`) and the **two-step action** are unchanged — the action's
  destination stays the existing **marker-geometry** rule in `useMessageListScroll.ts`
  (marker below the viewport ⇒ marker first; otherwise bottom), *not* a `count > 0` test.
- **Remove the active-conversation force-zero** of `unreadCount` **and tighten the on-arrival
  pointer precondition** (`onMessageReceived` in `notificationState.ts`): the count is
  pointer-driven for active conversations too, and the pointer advances on arrival only when a
  **real viewport-at-live-edge signal** is present (unknown/stale ⇒ conservatively *not* at the
  edge). This is a scoped precondition-tightening on an existing writer, not a new/relocated one;
  PR C still owns writer removal. The signal must be threaded into the SDK `ctx` (as
  `windowVisible` was for #1080), sourced from the app's `viewportAtBottom`-class evidence — not
  `windowAtLiveEdge`.
- **Add SDK-owned, generation-stamped viewport evidence.** The SDK holds an entity-scoped
  `unknown | at-edge | away` state keyed by activation generation; activating/switching an entity
  synchronously starts a new generation at `unknown`. Add an explicit SDK action for the app to
  report measured viewport state *with its generation*; the SDK ignores reports from an older
  generation. The app's `isAtBottomRef` stays boolean and internal to scroll mechanics — it is
  **not** the semantic evidence, and the SDK does **not** import `apps/fluux`. Exercised by
  scenarios 2, 5, the precondition controls (8), and the switch-race negative control (9).
- Rewrite `MessageList.fab.test.tsx` (its current assertions encode the resident-array /
  `countNewBelowViewport` semantics being removed).

## Acceptance tests

Every control gets a deliberate-break verification (this effort's recurring defect is hollow
tests — a test that still passes when the behavior is broken is not done). Where a test spans
store + UI, split it: the count value is asserted at the store/derivation layer, the
rendering at the component layer, both reading the *same* canonical number.

### 1. Everything read, user scrolls upward
- **Given** a conversation with the read pointer at the newest message (all read), rendered
  and scrolled to the bottom.
- **When** the user scrolls up so the bottom is off-screen.
- **Then** the FAB **is visible**; the FAB has **no badge**; the sidebar counter is `0`; **no
  divider and no floating pill** are shown.
- *Break check:* if the badge were a below-viewport/resident count it would show a non-zero
  number here — assert the badge element is absent.

### 2. Scrolled up, two new eligible messages arrive
- **Given** the conversation open, the user scrolled up (not at the live edge), the effective
  read boundary behind the newest.
- **When** two incoming, renderable messages whose canonical archive positions are strictly
  after the effective read boundary arrive (no `non-delayed` qualifier — a delayed message
  after the boundary is still unread).
- **Then** the sidebar shows `2`; the **divider** (`NewMessageMarker`) text shows
  *"2 new messages"*; the FAB badge shows `2` — **the same number on every rendered surface**
  (and the floating pill too if the divider is above the viewport).
- *Break check:* assert the values are equal and equal to `2`; a divergence (e.g. the FAB
  showing a different, resident-relative number) fails.

### 3. Scroll down and back up without advancing the read pointer
- **Given** unread present and a marker showing count `N`.
- **When** the viewport moves down then back up **without** the read pointer advancing (no
  focused-at-live-edge convergence).
- **Then** the canonical count stays `N` across all surfaces — it does **not** change because
  the viewport moved.
- *Break check:* drive scroll events only; assert sidebar/marker/FAB count is unchanged.

### 4. Activate the FAB — two-step is marker-geometry driven
- **Given** unread present **and the divider still *below* the viewport** (the user is scrolled
  up above the unread block, e.g. `markerOffset > viewportBottom`).
- **When** the user activates the FAB.
- **Then** the first click scrolls **down to the divider** (the intended two-step behavior); a
  second click then goes to the bottom.
- **And** the complementary case: when the divider is on-screen or scrolled *above* the
  viewport, or there is no divider, a click goes **straight to the bottom** — even while the
  canonical count is > 0. The destination is decided by marker geometry, **not** by the count.
- *Break check:* with the divider above the viewport but count > 0, assert the target is the
  bottom (not the marker) — a count-driven rule would wrongly scroll up to the marker.

### 5. Reach the live edge while active and focused
- **Given** the room active, window focused, unread present.
- **When** the viewport reaches the live edge (bottom) so the convergence gates are satisfied.
- **Then** the local read pointer advances (optimistically, not gated on MDS publish); the
  sidebar becomes `0`; the divider and floating pill are removed; the FAB is hidden (viewport
  at bottom).
- *Break check:* assert convergence happens without a resolved publish promise (publish is
  best-effort); assert every surface reaches the cleared state (sidebar `0`, no divider, no
  pill, no FAB).

### 6. Previously-read messages below the viewport
- **Given** the conversation fully read, then the user scrolled up so read messages sit below
  the fold.
- **When** rendered in that state.
- **Then** the FAB may be visible (viewport away from bottom) but its badge is **absent** —
  read messages below the viewport never contribute to the badge.
- *Break check:* place several read messages below the viewport and assert the badge element
  does not render.

### 7. Remote XEP-0490 marker advances the pointer while scrolled up
- **Given** the conversation active, the user **scrolled up** with the divider visible and a
  canonical count of `N` (> 0), a specific message anchored at a known pixel offset in the
  viewport.
- **When** an inbound XEP-0490 read marker from another device advances the effective boundary
  (canonical count drops to `M`, `0 ≤ M < N`).
- **Then** the canonical count updates to `M` on **every rendered surface** (sidebar, divider,
  floating pill, FAB badge); the divider **moves** to the new boundary (or, if `M = 0`, the
  divider **and** the floating pill are **removed**); the FAB may remain visible (viewport away
  from bottom) but shows **no badge** when `M = 0`; and the anchored message **stays at the same
  pixel offset** throughout — no visual scroll.
- *Break checks:* (a) omit the content-anchor re-assert → the anchored message's offset shifts
  when the divider mutates the layout (fails); (b) leave any surface on the stale `N` (fails the
  all-surfaces-agree assertion).

### 8. On-arrival pointer-advance precondition (positive + negative controls)
The pointer advances on message arrival **only** at the real live edge. Assert at the store
layer (pointer + unread), driving `onMessageReceived` / the store path with an explicit
viewport signal in `ctx`:
- **Active + focused + scrolled up** (not at live edge) → pointer **unchanged**; unread
  **increases**. *(This is the negative control that must bite — the pre-PR-B code advances
  here.)*
- **Active + focused + at the live edge** → pointer **advances**; count converges to `0`.
- **Active + focused + unknown / missing / stale viewport state** → treated conservatively as
  not-at-edge → pointer **unchanged**.
- **Window hidden** → pointer **unchanged** (the existing gate; unaffected).

### 9. Viewport-evidence freshness across a conversation switch (negative control)
- **Given** conversation A active and **at the bottom** (A's current-generation evidence is
  `at-edge`).
- **When** the user switches to conversation B (a new generation for B starts at `unknown`), and
  a message arrives in B **before B has reported its own viewport state**.
- **Then** the pointer of B **must not advance** — B's unread **increments** (B's current-generation
  evidence is still `unknown`).
- **And** a **late `at-edge` report carrying conversation A's old generation**, arriving after the
  switch, **is ignored** — it must not mark B (or A) at-edge or advance any pointer.
- **And** after B reports `at-edge` on **its own** generation, a subsequent arrival in B **may**
  advance B's pointer.
- *Break checks (must bite):* (a) start B's evidence at `at-edge`/`true` (or inherit A's) instead
  of `unknown` → the pre-report arrival wrongly advances B and zeroes its count; (b) accept the
  stale-generation report → it flips B to at-edge and the next arrival wrongly advances. Assert
  both fail.

### Additional (carried from the design, count-source)
- Active-but-scrolled-up conversation is **not** force-zeroed (the removed shortcut).
- Coverage-incomplete → the surfaces keep the last canonical count (`deferred`), never a
  resident/viewport count.
- The store caps at `999`; the one shared `formatUnreadCount` renders the capped value
  identically on all five numeric surfaces (conversation sidebar, room tooltip, divider,
  floating pill, FAB) — assert a large count formats to the same string everywhere, not a
  per-surface literal.
