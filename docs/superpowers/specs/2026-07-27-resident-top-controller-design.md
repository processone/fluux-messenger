# Resident-Top Controller Migration Design

## Goal

Complete scroll-positioning migration step 6 by making the generation-aware
positioning controller the sole owner of the live message list's Home /
resident-top navigation. Preserve the current smooth animation and history-load
timing while deleting the hook's direct positioning owner and its shadow-only
observation.

## Current behavior

`useMessageListScroll.scrollToTop` currently:

1. sets `lastLoadTimeRef.current` to prevent the Home action itself from being
   mistaken for an ordinary load-older trigger;
2. records a shadow `resident-top` request;
3. directly calls `scroller.scrollTo({ top: 0, behavior: 'smooth' })`.

The semantic request already exists in `scrollPositionModel`, but the controller
does not execute it. This is the last live-list position outside the controller's
shared generation and single-flight lifecycle.

## Chosen approach

Add an authoritative resident-top controller slice with a leased observation
loop.

The executor issues exactly one smooth write after the request is accepted. The
controller then observes `scrollTop` on animation frames until the browser has
remained within 1 pixel of resident top for two consecutive frames. The loop
must never reissue the smooth write: restarting a native animation on every
frame would recreate scroll fighting.

The observation budget is 120 frames. If the browser does not reach resident
top within that budget, the controller completes best-effort and does not snap.
This preserves the current one-shot behavior and avoids a late visible jump.

Instant per-frame convergence is rejected because it would remove the existing
Home animation. A controller method that merely wraps the current direct call
is also rejected because it would not own cancellation, supersession, or
completion.

## Controller contract

`scrollPositionModel` will export `ResidentTopRequest`, the existing
`user-navigation/resident-top` member of `PositionRequest`.

`positioningController` will expose:

- `ResidentTopExecutor`, with reachability, leased loop creation, one-shot
  smooth start, current `scrollTop` observation, and completion reporting;
- `beginResidentTopNavigation`, which mints and accepts the request, resolves
  current reachability, cancels older executions, starts the smooth write once,
  and schedules observation;
- a resident-top execution state holding its request, operation/abort state,
  frame loop, remaining budget, and stable-frame count.

The request uses the same module-private monotonic generation allocator and
`PositionExecutionLease` contract as the six existing authoritative slices.
A newer positioning request, conversation deactivation, or native user input
aborts the resident-top loop. Stale callbacks must fail their lease check before
they can observe, settle, or complete anything.

An empty resident window is treated as unavailable for this explicit command:
the current one-shot write would have no useful effect, and retaining an
unrefreshable pending resident-top request could incorrectly supersede later
content behavior.

Completion outcomes are `settled`, `best-effort`, `user-takeover`, and
`superseded`. Completion is diagnostic and must not introduce another pixel
write.

## Hook adapter

`useMessageListScroll` will build a resident-top executor that:

- derives reachability from the current first resident row;
- uses `beginControllerFrameLoop('resident-top', lease)`;
- calls `scroller.scrollTo({ top: 0, behavior: 'smooth' })` exactly once from
  the controller-owned executor;
- reports `scroller.scrollTop` without mutating it during observation.

`lastLoadTimeRef.current = Date.now()` remains before the controller request, so
the existing load-older guard is unchanged. Ordinary later top-boundary
navigation can still trigger the existing history-loading path.

The published `scrollToTop` command will use a stable callback shell. The
executor legitimately closes over current conversation/window facts, but those
changes must not rebind the global Home / Mod+ArrowUp listener or invalidate
consumers on every append.

The old `observeRequest({ event: 'home-key', ... })` block and the hook-level
direct `scrollTo` call are deleted.

## Failure behavior

All controller/executor calls remain inside the existing scroll instrumentation
boundary. Invalid reachability or a missing scroller results in a no-op request,
not an exception escaping the keyboard handler. A failed request does not fall
back to an unleased direct write, because that would retain the competing
position owner this migration is meant to remove.

## Tests

Controller tests must prove:

- a resident-top request performs one smooth start and only observes afterward;
- changing observed positions converge and settle without additional writes;
- native user input cancels the current generation and stale frames do nothing;
- a newer request supersedes resident-top before its next frame;
- budget exhaustion completes best-effort without a forced snap;
- an empty window does not leave an active resident-top owner.

Each behavior test must have a plausible wrong implementation that would make it
fail. The single-write test is the control against restarting the smooth
animation in the frame loop.

Hook tests must prove through runtime behavior that Home and Mod+ArrowUp route
through the controller, preserve `behavior: 'smooth'`, issue exactly one write,
and keep the published callback stable across message/window updates. These
tests must fail if the deleted shadow-plus-direct-write path is restored; they
must not merely grep implementation text.

The Playwright scroll-invariant suite will add a real-engine Home scenario for
Chromium and WebKit: start away from resident top, invoke Home, observe smooth
progress to the resident top, and assert no scroll divergence or instrumentation
error. Existing 52 scenarios remain the regression gate.

## Documentation and completion

The scroll-positioning contract will mark step 6 complete, remove resident-top
from the remaining-owner list, and state that all live-list semantic positions
are controller-owned. `SearchContextView` positioning and keyboard-selection
`scrollIntoView({ block: 'nearest' })` remain documented as isolated,
non-competing contexts.

Step 7—splitting persistence, user intent, history windowing, and browser
reconciliation out of `useMessageListScroll`—is explicitly outside this PR.
