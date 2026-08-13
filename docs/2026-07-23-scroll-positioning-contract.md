# Message-list scroll positioning contract

Status: migration complete. Saved-position restoration, unread-marker positioning, explicit message
targets, live-edge pinning, fixed-anchor layout preservation, directional history preservation, and
resident-top navigation are authoritative controller slices, and the orchestration hook holds no
positioning frame loop of its own. Every branch decision that a test could not otherwise reach is a
pure function with paired controls.

## Purpose

Message-list positioning historically had several independent implementations for live-edge pinning,
saved-position restoration, unread markers, explicit message targets, directional history loads,
and media re-anchoring. Most are individually justified, but they share `scrollTop`, virtualizer
measurements, cancellation, persistence gates, and WebKit workarounds. Correctness therefore depends
on effect ordering and on every implementation honoring the same implicit rules.

The migration goal is one positioning authority. This document defines the semantic request and
lifecycle contract that authority will consume.

It intentionally separates two concerns:

1. **Position policy:** what position is wanted, whether it is reachable, which newer request
   supersedes an older one, and when user input cancels automatic positioning.
2. **Browser reconciliation:** how estimated and measured geometry converges on that position,
   including WebKit layout/repaint behavior.

The first concern can be pure and deterministic. The second remains the hard browser-specific work;
centralizing it later must not erase or weaken its current safeguards.

## Controller migration and fidelity findings

The controller is held in a ref and owns no React state. For saved positions it owns entry selection,
generation/operation cancellation, reachability, one around-load attempt, and explicit
legacy-offset/live-edge fallback. For unread markers it owns entry and jump-to-last-read requests,
frame scheduling, stale-work cancellation, convergence, and live-edge fallback. For explicit
message targets it owns supersession, one around-load attempt, mounting and center-position
convergence, user takeover, and completion. For live edge it owns entry/FAB/outgoing generations,
same-generation content stimuli, global-tail recentering, the 60-frame/8-stable-frame convergence
budget, and user cancellation. Media growth, unread-divider movement, and delayed live-path
insertions while reading history share one fixed-anchor execution machine with the former
90-frame/8-stable-frame/8px contract. Divider movement and delayed insertion have distinct
`layout-preservation` reasons and are ambient: they are rejected rather than superseding an
unsettled entry restore, explicit target, or user navigation. Leased imperative executors
translate accepted requests into browser/virtualizer writes, and every frame must hold the current
controller lease before it can write. Directional history is accepted before a load begins, remains
pending until the first resident ID changes or the load settles without a window shift, then either
performs its pre-paint anchor/fallback write or releases the request. A landed shift retains the
former full 60-frame late-measurement budget under one lease. Its executor retains WebKit
kinetic-scroll cancellation, 2px target-shift correction, 5px clamp recovery, and bounded
distance-from-bottom fallback. Boundary input while the load is still pending retains the captured
anchor because no pixel owner exists yet; takeover becomes cancellable after the initial
positioning write, matching the former loop's timing. Explicit competing requests still supersede
pending directional history.
All seven authoritative slices share the same controller-owned
`PositionFrameLoop` shape. The saved executor retains the existing fractional-anchor
measurement write, 90-frame budget, 8-frame stability window, and 8px tolerance; only scheduling,
convergence state, and lifecycle ownership moved out of the hook-local loop. Unlike unread-marker
and explicit-target loops, saved-position restoration deliberately has no fixed geometry-drift
takeover threshold: legitimate deep-history measurement corrections can exceed 300px while rows
settle, so user-input cancellation remains its takeover signal.

Viewport observation is now owned by one imperative, conversation-scoped `ViewportSession`. It
holds the latest geometry and bottom anchor, measured-live-edge evidence, genuine-input evidence,
the programmatic-settle window, and independent top/bottom travel latches. It accepts only values:
no DOM element, virtualizer, frame scheduler, or pixel-write operation crosses its boundary.
Conversation entry resets every fact, and observations tagged for the room just left are rejected,
so delayed controller callbacks cannot mutate the new room's evidence.

Scroll persistence is mediated by a value-only `ScrollPersistenceAdapter`. It consumes immutable
viewport-session snapshots and owns entry reads, throttled continuous saves, leave-versus-mark-left
decisions, and explicit saved-position clearing. The adapter rejects stale-room snapshots and
controller-owned scroll events and has no DOM, virtualizer, scheduler, or pixel-write capability.

Directional history windowing is mediated by a value-only
`DirectionalHistoryWindowCoordinator`. It owns older/newer availability, cooldown and travel
eligibility, monotonic load identity, anchor/distance facts, loader invocation, no-shift completion,
and false-to-true live-window cleanup. A loader promise bounds only the snapshot that invoked it:
settlement from an older superseded load cannot release the current request, while an in-flight
load keeps its snapshot until its own first-id shift can reconcile. Conversation entry drops the
departed conversation's snapshot, and delayed settlement or window observation from that snapshot
cannot mutate the active conversation. A dedicated `DirectionalHistoryBrowserAdapter` owns visual
anchor capture, the one-frame settlement scheduler, reachability probes, WebKit kinetic-scroll
cancellation, and anchor/fallback pixel writes under the controller lease.
`useDirectionalHistoryLoads` invokes the adapter and supplies lifecycle completion callbacks; the
orchestration hook only wires its ports and consumes its triggers. The coordinator imports no DOM,
virtualizer, frame scheduler, positioning controller, or pixel-write capability.

Saved-position reconciliation likewise runs through a dedicated browser adapter. It owns
reachability probes, bounded legacy-offset writes, bottom-fraction anchor positioning, and the
restore frame-loop port, while the hook supplies cache loading, live-window recentering, live-edge
fallback, and completion callbacks. The shared bottom-fraction adapter keeps saved restoration and
fixed-anchor preservation on the same row-rect/virtualizer geometry without giving either a second
positioning lifecycle.

Explicit target convergence uses immediate center writes. The former reply/poll/find helper's
native smooth animation is intentionally not retained: restarting a smooth animation while
remeasurement moves the target makes convergence samples unreliable and recreates scroll fighting.

The live-edge executor retains its bottom-specific browser safeguards: tail-layout flushes for late
WebKit measurement, the 4px missed-frame correction, repaint-burst coalescing, background-MAM
repaint suppression, and the `overflowY` stale-paint repair. These remain executor mechanics rather
than competing lifecycle owners. A settled or best-effort generation flushes any owed trailing
repaint; user takeover or supersession deliberately discards that debt so it cannot repaint after
the reader takes control or leak into unrelated content.

They live in a `LiveEdgeBrowserAdapter` whose repaint-burst coalescer and pin-cost probe are
adapter-scoped rather than per-executor: a burst is precisely a run of arrivals each superseding the
last, so state that ended with one executor could never coalesce. Window facts are re-read per call
because a live-edge executor outlives the render that built it, while forward-window availability
and the conversation whose bottom intent is recorded stay per-execution — they are facts of the
request, not live geometry. Conversation entry drops any owed repaint debt so it cannot flush into
the room being opened.

Fixed-anchor preservation and resident-top navigation likewise reconcile through
`AnchorPreservationBrowserAdapter` and `ResidentTopBrowserAdapter`. The first routes all three
ambient stimuli through the shared bottom-fraction geometry under distinct frame-loop labels; the
second issues one animated write and thereafter only observes `scrollTop`.

Resident-top navigation starts one native smooth write from its leased executor, then observes
`scrollTop` without reissuing the target. It settles after two frames within 1px of the resident
top, or releases best-effort after 120 observation frames without snapping. Home resets the prior
top-boundary travel latch, and its controller-owned progress cannot recreate user pagination
evidence; a later genuine user move away from the top can still re-arm ordinary load-older.

Residual shadow observations cover entry staging before an explicit target. A shared error boundary
catches and counts adapter, validator, controller-driver, and executor errors; failure must degrade
according to the active request's source-specific policy and must never escape into the scroll
effect or event handler. The demo scroll-invariant suite fails if either `divergenceCount` or
`instrumentationErrorCount` is non-zero. Retained diagnostic samples are capped, not the pass
criterion.

For residual shadow observations, zero divergences means the model agrees with the hand-authored
semantic `actual` label at each observation site: desired position plus the coarse
waiting/positioning/applied/paused/fallback/idle phase. It does **not** compare rendered pixels and
must not be read as proof that the browser landed
or painted at the requested position, nor does it prove that every ownership site was observed.
Pixel geometry, measurement convergence, and WebKit repaint remain covered by the scroll-invariant
scenarios and the leased imperative reconcilers.

Generation allocation is module-private and shared by controller instances. Each mounted
message-list owns its controller model, but a remount (including StrictMode effect replay) cannot
reuse a generation. No adapter or model helper can mint one.

The three previously prose-only fidelity seams are descriptive of current behavior:

- **Media preservation does not suppress an outgoing send.** The live new-message effect suppresses
  only while entry restore is pending or a directional load has not completed its initial restore.
  A replay captured from the media-growth invariant proves that an outgoing live-edge request
  supersedes an active media anchor.
- **`position-applied` is the current release seam, before measurement settle.** The saved controller
  applies the initial anchor/offset write synchronously, marks the lease applied, and then schedules
  the remaining restore-anchor frames through its shared loop. Directional restoration likewise sets
  `saved.restored` after its initial bounded write and before its measurement re-assert loop.
  Recorded restore facts prove an outgoing request is rejected before that signal and accepted
  immediately after it.
- **Already-resolved synced live edge wins synchronously.** The entry effect compares the remote
  read pointer with the resident tail and clears obsolete saved state before beginning the
  controller request. Late `mds-live-edge` and `mds-settle` remain separate supersession paths only
  for remote state that arrives after entry.

These checks establish policy fidelity; they do not claim that jsdom can prove pixel convergence or
WebKit paint correctness.

## Non-goals for this stage

- Replacing browser measurement/repaint safeguards while migrating positioning policy.
- Changing entry priority, marker placement, saved scroll data, or history loading.
- Removing measurement settle windows, tolerances, or WebKit repaint workarounds.
- Treating a one-shot scroll as sufficient under virtualization.
- Making raw `scrollTop` a new durable position type.
- Migrating static search-context lists in the first controller slice. They do not use the live-list
  positioning hook today and must remain isolated until explicitly brought under this contract.

## Desired positions

`DesiredPosition` has four durable semantic variants plus one migration bridge:

- **Live edge:** keep following appended messages and bottom-of-list UI until genuine user takeover.
- **Fixed anchor:** keep a point in one message at a stable viewport placement. Its placement is a
  discriminated type, so the two geometries cannot be mixed:
  - `bottom-fraction`: saved reading position, media preservation, and ambient layout preservation
    for divider movement or delayed insertion. The fraction is validated in
    `[0, 1]`, where `0` is the row top and `1` its bottom. The exact equation is
    `rowTop + fraction * rowHeight = scrollTop + viewportHeight`;
  - `top-offset`: directional history preservation. The equation is
    `rowTop - scrollTop = offsetPx`; negative offsets are valid when the top-visible row begins
    above the viewport.
- **Message target:** place a message at start, top-third, center, or end for
  unread/reply/search/activity navigation.
- **Resident top:** move to the top of the currently loaded window; ordinary history loading may
  follow.
- **Legacy offset:** transitional support for anchorless persisted `scrollTop` from existing saved
  states. New code must not persist it as the semantic position.

Live edge is the only follow-live variant. A fixed anchor on the newest message with fraction `1`
does **not** follow later appends.

A saved content anchor remains authoritative. Its raw pixel value is a source-specific fallback
when that anchor is unavailable. An old saved state containing only the raw value selects the
transitional legacy-offset position and still outranks unread/live-edge entry, preserving current
behavior.

## Request provenance

Every position request carries:

- a positive, safe-integer monotonic generation;
- the conversation id;
- a semantic source;
- the desired position.

The request is a discriminated union: provenance and desired position must agree. For example, a
late-MDS request can only want live edge, history preservation can only want a top-offset anchor,
and outgoing-message provenance cannot request resident top. A fallback that changes the desired
position also gets honest fallback provenance; it does not retain the source of the failed target.

Sources distinguish:

- provisional conversation entry, including distinct synced-live-edge provenance that tells the
  adapter to discard obsolete saved state;
- explicit user navigation;
- an outgoing message that deliberately returns the sender to live edge;
- directional history preservation;
- media remeasurement preservation;
- ambient layout preservation when the unread divider moves or a delayed live-path message is
  inserted inside the resident window;
- late XEP-0490/MDS supersession.

Incoming messages at the resident live edge, reactions, typing, composer/container/viewport resize,
media measurement, and MAM completion are normally **reconciliation stimuli for the current
request**, not new competing requests. A delayed live-path message placed inside the resident
window is the ambient-layout exception described above. An outgoing send is different: current
behavior deliberately moves a reader out of history, so it creates a live-edge request. The attempt
is dropped while a directional-load or entry-restore preservation step is still pending, matching
the existing send-stick suppression; the preservation owner releases after its first position is
applied, not after the entire measurement-settle loop. Later ordinary stimuli handle content from
any dropped attempt.

## Entry arbitration and later supersession

Entry selects exactly one provisional request:

1. already-resolved synced live edge invalidates stale local state;
2. saved fixed anchor, or transitional raw-only saved offset;
3. first unread message;
4. live edge.

An explicit reply/search/activity target is not folded into this priority table. It is a separate,
newer request and supersedes the provisional entry request.

The entry choice is not final: XEP-0490/MDS state can resolve after entry and reposition an unread
divider. That reconciliation must not issue a live-edge request merely because the remote pointer
reaches the newest message; the active visit's divider remains parked until an explicit clear path
retires it. Before genuine user takeover, an accepted MDS positioning correction is limited to the
currently displayed conversation and only while that provisional entry remains eligible. After
takeover, explicit navigation, outgoing send, or one accepted MDS correction, the late-MDS entry
window closes. A delayed result from the room just left must never reactivate it. A later explicit
user request remains allowed but does not reopen MDS eligibility.

Source priority chooses the one provisional entry request. After entry, generation order governs
permitted supersession; a newer generation alone does not bypass current-conversation or MDS
eligibility guards. Async work tagged with a stale generation is ignored.

User input and follow-live are separate facts. Genuine input cancels the current reconciliation
run immediately. A live-edge request retains its generation in a paused-user-input phase until
settled geometry shows whether the reader left the edge; stale callbacks cannot resume that pause.
Input that remains within the bottom threshold settles the same request and keeps following.
Manually returning to the bottom after another position was cancelled creates a fresh
generation-bearing live-edge request without reopening late-MDS eligibility.

When the message list unmounts or navigation leaves conversations, a generation-guarded deactivation
clears the current conversation, active request, and MDS eligibility while retaining the watermark.
Callbacks from the unmounted conversation are then rejected.

Saved live-edge fallback also respects sliding-window reachability. The leased executor requests
newer resident slices until the global tail becomes resident; only then may it apply the live-edge
position. If no forward-window port exists, it explicitly lands at the best resident edge and ends
ownership rather than leaving restoration permanently pending.

## Reachability lifecycle

The semantic lifecycle is:

```text
request
  -> resolving
      -> pending(empty-window)
      -> loading-around(message)
      -> pending(around-load)
      -> pending(target-not-indexed)
      -> unavailable(source-specific policy)
      -> recentering-live-edge
      -> mounting(index)
      -> reconciling
      -> position-applied
      -> paused-user-input
      -> settled
```

These states have distinct meanings:

- An empty hydrating window is not evidence that a saved target is missing.
- A target absent from a populated item set distinguishes an available around request, a request
  already loading, and an exhausted/unavailable loader. An empty completed slice cannot trigger the
  same load forever.
- If no around-loader can satisfy it, behavior comes from request provenance rather than a generic
  fallback: saved restore uses legacy offset then live edge, unread uses live edge, explicit targets
  wait, directional history uses captured distance-from-bottom and clamps, and media preservation
  warns and stops.
- A loaded/indexed message can still be absent from the measured virtual window.
- Live edge can likewise require mounting the tail of a slid-up virtual window; merely having rows
  does not prove that the global tail is resident. A FAB/live-edge request first recenters a
  slid-up window, then mounts and reconciles the global tail.
- A mounted unread marker near the resident start can still reject start placement and use its
  live-edge fallback, avoiding a scroll-to-zero that spuriously loads older history.
- Mounting a row and positioning it are separate phases. They must not emit competing targets in
  the same frame.
- Reconciling means the semantic target is reachable; it does not mean layout has stabilized.

The generation watermark survives settlement and cancellation. A stale cache load, mount callback,
measurement, or MDS completion cannot revive cancelled work.

## Reconciler responsibilities

The controller-owned reconcilers own the difficult runtime work below. None belongs in the pure
model; browser-specific geometry remains in leased imperative executors. Every slice now reconciles
behind a dedicated browser adapter — directional history, saved position, unread marker, explicit
target, live edge, fixed anchor, and resident top:

- resolve IDs against the loaded item set;
- request an around slice and resume when it arrives;
- mount an off-window virtual row;
- translate current measured geometry into the requested placement;
- perform at most one positioning target per frame;
- re-resolve as estimated rows acquire measured sizes;
- apply purpose-appropriate drift tolerances, stable-frame counts, and hard frame budgets;
- recover when coalesced height deltas hide the final bottom-pin correction;
- distinguish growth-driven programmatic scroll events from genuine takeover;
- keep transient programmatic positions out of saved reading state;
- cancel WebKit kinetic scrolling around directional history loads;
- force/coalesce WebKit repaint when layout is correct but painted pixels are stale;
- guarantee single-flight ownership and cancel stale generations.

In particular, the model describes **what position is wanted**. It does not make measurement settle
or stale-paint reconciliation disappear.

Live-edge reconciliation deliberately has no fixed geometry-drift takeover threshold. Large
geometry changes are the content-growth condition it must absorb, so genuine user input or a newer
generation is its takeover signal. Adding the 300px explicit-target/unread threshold here would
abort valid deep growth and media-settle runs.

## Current behavior inventory

| Current trigger | Semantic position | Reachability / supersession notes |
| --- | --- | --- |
| Entry with saved state | Fixed bottom-relative fractional anchor | Empty window waits; absent target can load around; indexed target may need mounting |
| Entry with raw-only legacy state | Transitional legacy offset | Still outranks unread/live edge; not persisted by new semantic code |
| Entry with unread | Message at start | Cache hydration and virtual mounting may delay resolution |
| Entry without restore/unread | Live edge | Remains follow-live until user leaves it |
| Explicit reply/search/activity target | Message at center | Newer request supersedes provisional entry; missing target can load around |
| Jump-to-last-read | Message at start | Reuses unread-marker placement |
| FAB or live-edge keyboard command | Unread marker, then live edge | If the marker is still below the viewport, first activation visits it (virtualized start alignment; current non-virtualized path uses top-third); a later activation goes live |
| Outgoing message | Live edge | Deliberately supersedes a fixed historical position after its first landing releases preservation ownership; it need not wait for full convergence |
| Incoming message at the resident live edge | Existing live edge only | Must not make a fixed anchor follow |
| Delayed live-path message inserted inside the resident window while reading history | Fixed bottom-relative fractional anchor | Preserve a continuously captured pre-mutation reading point; reject the ambient request while requested navigation is unsettled |
| Late MDS live-edge state | Live edge | Newer automatic request only before user takeover |
| Media at live edge | Existing live edge | Debounced measurement stimulus |
| Media while reading history | Fixed bottom-relative fractional anchor | Preserve the reading point through remeasurement |
| Unread divider moves while reading history | Fixed bottom-relative fractional anchor | Preserve a continuously captured pre-mutation reading point; reject the ambient request while requested navigation is unsettled |
| Load older/newer | Fixed top-relative offset anchor | Wait for the directional window change; release if the load settles without one; if the anchor disappears after a shift, preserve captured distance from bottom and clamp |
| Home / resident-top command | Resident top | Does not itself trigger load-older; later genuine user travel can re-arm ordinary boundary loading |
| Reaction, typing, resize, MAM completion | Current live edge, when active | Geometry stimulus, not a new position request |

The FAB/End choice is made from current geometry, not a remembered click state. If the unread marker
is already visible or above the viewport, the same activation goes directly to live edge.

## Ownership boundary

The controller-owned mechanisms retain leased browser reconcilers for saved anchors, unread markers,
explicit center-aligned targets, live edge, fixed-anchor media/layout preservation, directional
history, and resident top. These
reconcilers implement measurement convergence; they are not separate positioning authorities.
There is no independent positioning frame-loop implementation left inside `useMessageListScroll`.
Executor construction lives in `useScrollExecutors` without exception: it supplies each adapter's
value ports and hands the finished executor back for the hook to submit, so no `createExecutor` call
appears in `useMessageListScroll`. Directional-history availability probes and one-frame settlement
scheduling are encapsulated by `useDirectionalHistoryLoads`, which builds no executor and owns no
pixel write. Exactly three pixel writes remain in the orchestration hook, and none is a positioning
owner —
the two isolated static-preview operations documented below, and the emergency bottom write that
keeps the list usable when the controller itself cannot be constructed.

The executor factories' changing callback identities are part of that integration contract because
dependent effects use them to follow render-scoped window facts. The authoritative explanation and
dependency rules live with the implementation in
`apps/fluux/src/components/conversation/useScrollExecutors.ts`.

Ambient layout preservation is entirely inside the scroll owner. `MessageList` receives only the
store-owned interior-placement version; it receives no raw anchor capture/restore callbacks. The
virtualized executor corrects through `scrollToOffset`/`scrollToIndex` so TanStack's pending-scroll
reconciler is retargeted rather than raced by an unleased `scrollTop` write. Pre-mutation anchors
for divider movement and delayed insertion are captured continuously, and the accepted request
performs its first correction in the post-commit, pre-paint layout effect.

Every leased reconciler uses `controllerFrameLoop`. It owns the concrete scheduled frame and
diagnostic handle, and finishes exactly once when the lease is stale before scheduling, becomes
stale before callback delivery, or frame scheduling/controller callback work throws. Normal
controller unavailable—including a safely contained executor failure—superseded, takeover,
deactivation, and settlement paths call the same finish operation. Live-edge pin-claim
start/renew/release hooks are part of that lifecycle, so the claim deadline is scheduler-failure
defense in depth rather than recovery from an accepted controller gap.

The live hook result and active-list registry have exact reviewed API-shape guards. Adding a new
callback—whether or not its name contains `scrollTop`—fails until its ownership semantics are
reviewed, preventing a low-level anchor/offset/scroller escape hatch from bypassing generations.
The unused generic `useMessageScroll` hook and its raw bottom writers have been deleted, so the app
hook barrel no longer advertises an alternate live-list positioning owner. The ownership guard
keeps that retired surface absent.

The former send/composer/media writers in `ChatView` and `RoomView` have been removed. Outgoing rows
already create a controller-owned live-edge request, scroller resize is observed by the message
list's controller-backed correction path, and room media now receives the same list-owned callback
as 1:1 media. That callback is published through a stable shell so current executor/window changes
do not invalidate every memoized row. These stimuli no longer add a second pixel writer.

Two visually similar scroll operations are explicitly outside this migration:

- `SearchContextView` is a static preview with its own scroller and no live-conversation persistence,
  follow-live, unread, or history-window ownership. Its persistent-highlight positioning loop remains
  isolated from the live message-list controller. Its rows are still interactive, so a reply/poll
  click inside a preview resolves within that preview's own scroller — never the document, and never
  the live conversation. Because several previews can be mounted beside the live list while the
  active-list registry holds only one entry, requests from inside any list route by **containment**
  (`messageTargetContext`), not by registration order; previews therefore do not register at all.
  The registry remains for callers with no enclosing list that mean the live conversation
  (`PollBanner`, find-on-page). Its Home shortcut likewise retains one isolated smooth write because
  static previews deliberately have no active controller conversation to accept that command.
- Keyboard selection in `useMessageSelection` uses
  `scrollIntoView({ block: 'nearest' })` only to keep the selected row visible. It is viewport
  maintenance, not a semantic message-position request, and remains intentionally direct.

A later migration is incomplete until each in-scope owner either routes through the controller or is
explicitly documented as an isolated, non-competing context. New controller code must replace and
delete old owners rather than wrap them indefinitely.

### The virtualizer is a position owner the generations cannot see

`@tanstack/virtual-core` keeps its own pending-scroll reconciler: every `scrollToIndex` /
`scrollToOffset` arms a `scrollState` that survives for up to five seconds and re-applies **its**
target on each frame that measurement moves it. That reconciler is invisible to this contract's
generations — cancelling a controller execution retires the lease and the frame loop, but the
virtualizer keeps re-asserting the position the superseded owner asked for.

Consequently, on the virtualized path an animated command must be issued **through** the virtualizer
(`beginAnimatedScrollToOffset`), never as a raw `scroller.scrollTo({ behavior: 'smooth' })`. Doing so
retargets the reconciler onto the new position instead of racing it, and additionally suppresses the
virtualizer's own size-change scroll adjustments for the animation's duration. A raw smooth write
loses to the previous owner whenever rows are still measuring — reliably so on a slow engine, where
each layout pass costs long enough for the reconciler to re-fire several times mid-animation
(observed as Home snapping back to the live edge on the WebKitGTK CI runner).

An instant write may continue to use `scrollToOffset`/`scrollToIndex`, which additionally push the
landed offset into the virtualizer's offset callback so the window re-renders before paint. That
push is wrong for an animation: it claims the scroller has already arrived.

## Test standard

Pure-model tests use paired controls that differ by one semantic fact. Every test must identify a
plausible incorrect implementation that would make it fail.

Required controls include:

- live edge follows an append; an anchor on the same tail message does not;
- message target, resident top, and legacy offset do not follow appends either;
- empty window, target absent with loader, target absent without loader, indexed/unmounted, and
  mounted resolve to different phases;
- load-around available, in-flight, and exhausted resolve differently;
- source-specific target-unavailable policies remain different;
- an unmounted live-edge tail mounts before reconciliation;
- a slid-up window recenters before treating its resident bottom as the global live edge;
- a legacy raw offset reconciles without mounting an unrelated row;
- a mounted unread marker at the resident start takes its live-edge fallback;
- already-resolved synced live edge changes the entry selection from saved anchor to live edge;
- saved anchor and raw-only legacy state beat unread; unread beats ordinary live-edge fallback;
- FAB/End chooses the unread marker only while live geometry says it still needs a visit;
- a newer explicit target supersedes the provisional entry generation;
- stale generation phase completion is ignored while current generation completion succeeds;
- stale input cancellation is ignored;
- late MDS supersedes eligible entry but is rejected after takeover/navigation and after switching
  conversations;
- outgoing send cannot steal ownership from pending saved/directional preservation;
- outgoing send may proceed after the preservation position is first applied, before full settle;
- input cancels active reconciliation while pending directional-history loads retain their captured
  anchor; settled bottom geometry independently preserves, clears, or re-arms follow-live;
- deactivation blocks callbacks from an unmounted conversation;
- cancellation and settlement preserve the generation watermark;
- incompatible provenance/position pairs fail compile-time controls.

Tests must assert complete results where practical. A test that only repeats fixture arithmetic or
asserts that an enum contains the value supplied by the fixture does not protect behavior.

Pixel convergence remains a real-engine concern. When runtime migration begins, mechanism-level unit
tests must be paired with Chromium/WebKit scroll invariants and real desktop WebKit validation for
kinetic scrolling and stale-paint behavior.

## Incremental migration after this contract

1. [x] Introduce one generation-aware reconciliation controller without changing existing
   positioning.
2. [x] Migrate saved-anchor restoration: delete the legacy restore dispatcher, pending ref, and
   around-load status map; retain the measurement loop only as a generation/operation-leased
   reconciler.
3. [x] Migrate unread and explicit message targets: the controller owns their generations,
   supersession, reachability, frame convergence, and cancellation; their private loops and target
   around-load ref are deleted.
4. [x] Migrate live-edge pinning and media/content-growth preservation while retaining
   bottom-specific measurement/repaint safeguards; delete both private hook-owned loops.
5. [x] Migrate directional history preservation last, retaining kinetic cancellation, full-budget
   late-measurement tracking, distance-from-bottom fallback, and clamp recovery; delete the private
   prepend/window-shift loop.
6. [x] Route resident-top and unread-divider layout preservation through the controller, remove
   public raw anchor restoration, and document the two isolated, non-competing preview/selection
   scroll contexts.
   - [x] Harden the shared frame lifecycle so stale leases and thrown work release monitors and
     live-edge pin claims; guard the public live-scroll API against semantic escape hatches.
   - [x] Delete the unused generic `useMessageScroll` owner, its barrel export, dedicated tests, and
     stale component-test mocks.
7. Split persistence, viewport/interaction tracking, history windowing, and reconciliation out of
   the orchestration hook.
   - [x] Extract a conversation-scoped, observation-only viewport session for current geometry,
     bottom anchor, measured-live-edge and genuine-input evidence, measurement settling, and
     top/bottom travel latches.
   - [x] Move enter/leave/save/clear behavior and throttling behind a persistence adapter consuming
     viewport-session snapshots.
   - [x] Extract directional history load eligibility, invocation, and completion into a window
     coordinator that owns no positioning.
   - [x] Move DOM/virtualizer reconciliation mechanics behind explicit browser adapters.
     - [x] Extract directional-history capture, settlement scheduling, reachability, kinetic
       cancellation, and anchor/fallback writes behind its leased browser adapter.
     - [x] Extract saved-position reachability, legacy-offset and bottom-fraction writes behind its
       leased browser adapter, with shared bottom-fraction geometry for fixed anchors.
     - [x] Extract unread-marker and explicit-target reachability, passive conversation handoff,
       leased positioning, around loading, and target completion behind dedicated browser adapters.
     - [x] Extract the remaining live-edge, fixed-anchor, and resident-top browser executors.
   - [x] Leave the React hook as thin lifecycle orchestration. Taken one cohesive unit at a time so
     each step keeps the scroll invariants as its gate:
     - [x] Move executor construction — the frame-loop factory, the adapters that outlive one
       execution, and every `create*`/`build*Executor` — into `useScrollExecutors`.
     - [x] Extract the scroller/content callback refs, their genuine-input listeners, and the
       non-virtualized content-growth observer into `useScrollContainerBinding`.
     - [x] Extract ambient divider/insertion anchor tracking into
       `useAmbientAnchorPreservation`, with every branch decision as a pure function in
       `ambientAnchorDecisions`.
     - [x] Extract media-growth snapshotting and debouncing into
       `useMediaGrowthPreservation`, with the settled-batch outcome and the genuine-scroll
       discriminator as pure functions in `mediaGrowthDecisions`.
     - [x] Extract directional-history load start, release and post-frame settling into
       `useDirectionalHistoryLoads`. It adds no eligibility rule of its own: the coordinator still
       decides, and the browser adapter still captures and writes.
     - [x] Reduce the scroll and wheel handlers to a value-only interpretation of geometry in
       `scrollEventDecisions`, leaving the handlers to read facts once and apply the plan.
     - [x] Express conversation-entry arbitration as a pure model over facts in
       `entryArbitration`, leaving a thin effect that applies its verdict. The five-condition
       synced-live-edge predicate and its late-resolving twin are now separately testable, including
       the empty-conversation case where a bare pointer comparison would discard a saved position.
     - [x] Express the two remaining ambient re-pins as pure decisions: `mdsSettleDecision` for a
       divider cleared by a late XEP-0490 read-sync, and `typingIndicatorDecision` for the band that
       shrinks the scrollport, the twin of `rowGrowthDecision`. The detectors that remain in the
       hook carry a single condition each, where a decision layer would be ceremony.

Each migration must preserve observable behavior, add a falsifiable regression control, and remove
one previous source of scroll authority.
