# Message-list scroll positioning contract

Status: migration in progress. Saved-position restoration, unread-marker positioning, explicit
message targets, live-edge pinning, and media remeasurement preservation are authoritative
controller slices. Directional history preservation remains shadow-observed.

## Purpose

Message-list positioning currently has several independent implementations for live-edge pinning,
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
budget, and user cancellation. Media growth while reading history is a separate fixed-anchor
request with the former 90-frame/8-stable-frame/8px contract. Hook executors translate accepted
requests into browser/virtualizer writes, and every frame must hold the current controller lease
before it can write. All five authoritative slices share the same controller-owned
`PositionFrameLoop` shape. The saved executor retains the existing fractional-anchor
measurement write, 90-frame budget, 8-frame stability window, and 8px tolerance; only scheduling,
convergence state, and lifecycle ownership moved out of the hook-local loop. Unlike unread-marker
and explicit-target loops, saved-position restoration deliberately has no fixed geometry-drift
takeover threshold: legitimate deep-history measurement corrections can exceed 300px while rows
settle, so user-input cancellation remains its takeover signal.

Explicit target convergence uses immediate center writes. The former reply/poll/find helper's
native smooth animation is intentionally not retained: restarting a smooth animation while
remeasurement moves the target makes convergence samples unreliable and recreates scroll fighting.

The live-edge executor retains its bottom-specific browser safeguards: tail-layout flushes for late
WebKit measurement, the 4px missed-frame correction, repaint-burst coalescing, background-MAM
repaint suppression, and the `overflowY` stale-paint repair. These remain executor mechanics rather
than competing lifecycle owners.

Directional-history preservation still runs the model beside `useMessageListScroll`: fact adapters
read current virtualizer and DOM geometry, and observed decisions are compared with the model
decision. The instrumentation runs in production so real traces can exercise it. A shared error
boundary catches and counts adapter, validator,
controller-driver, and executor errors; failure must degrade according to the active request's
source-specific policy and must never escape into the scroll effect or event handler. The demo
scroll-invariant suite fails if either `divergenceCount` or `instrumentationErrorCount` is non-zero.
Retained diagnostic samples are capped, not the pass criterion.

For the remaining shadow-observed slice, zero divergences means the model agrees with the
hand-authored semantic `actual` label at each observation site: desired position plus the coarse
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
  - `bottom-fraction`: saved reading position and media preservation. The fraction is validated in
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
- late XEP-0490/MDS supersession.

Incoming messages, reactions, typing, composer/container/viewport resize, media measurement, and MAM
completion are normally **reconciliation stimuli for the current request**, not new competing
requests. An outgoing send is different: current behavior deliberately moves a reader out of
history, so it creates a live-edge request. The attempt is dropped while a directional-load or
entry-restore preservation step is still pending, matching the existing send-stick suppression;
the preservation owner releases after its first position is applied, not after the entire
measurement-settle loop. Later ordinary stimuli handle content from any dropped attempt.

## Entry arbitration and later supersession

Entry selects exactly one provisional request:

1. already-resolved synced live edge invalidates stale local state;
2. saved fixed anchor, or transitional raw-only saved offset;
3. first unread message;
4. live edge.

An explicit reply/search/activity target is not folded into this priority table. It is a separate,
newer request and supersedes the provisional entry request.

The entry choice is not final. XEP-0490/MDS state can resolve after entry:

- a remote read pointer reaches the live edge; or
- a stale unread divider clears.

Before genuine user takeover, either event may issue a newer live-edge request, but only for the
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
model; browser-specific geometry remains in leased hook executors:

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
| Incoming message | Existing live edge only | Must not make a fixed anchor follow |
| Late MDS live-edge state | Live edge | Newer automatic request only before user takeover |
| Media at live edge | Existing live edge | Debounced measurement stimulus |
| Media while reading history | Fixed bottom-relative fractional anchor | Preserve the reading point through remeasurement |
| Load older/newer | Fixed top-relative offset anchor | Wait for the directional window change; if the anchor disappears, preserve captured distance from bottom and clamp |
| Home / resident-top command | Resident top | May subsequently trigger ordinary load-older |
| Reaction, typing, resize, MAM completion | Current live edge, when active | Geometry stimulus, not a new position request |

The FAB/End choice is made from current geometry, not a remembered click state. If the unread marker
is already visible or above the viewport, the same activation goes directly to live edge.

## Current owners to migrate

The controller-owned mechanisms retain leased browser reconcilers for saved anchors, unread markers,
explicit center-aligned targets, live edge, and media preservation. These reconcilers implement
measurement convergence; they are not separate positioning authorities. The only remaining
independent frame-loop implementation inside `useMessageListScroll` is directional-load measurement
reassertion.

There are also positioning owners outside their shared single-flight ref:

- send/composer resize writes in `ChatView` and `RoomView`;
- resident-top's direct writer;

Two visually similar scroll operations are explicitly outside this migration:

- `SearchContextView` is a static preview with its own scroller and no live-conversation persistence,
  follow-live, unread, or history-window ownership. Its persistent-highlight positioning loop remains
  isolated from the live message-list controller. Its rows are still interactive, so a reply/poll
  click inside a preview resolves within that preview's own scroller — never the document, and never
  the live conversation. Because several previews can be mounted beside the live list while the
  active-list registry holds only one entry, requests from inside any list route by **containment**
  (`messageTargetContext`), not by registration order; previews therefore do not register at all.
  The registry remains for callers with no enclosing list that mean the live conversation
  (`PollBanner`, find-on-page).
- Keyboard selection in `useMessageSelection` uses
  `scrollIntoView({ block: 'nearest' })` only to keep the selected row visible. It is viewport
  maintenance, not a semantic message-position request, and remains intentionally direct.

A later migration is incomplete until each in-scope owner either routes through the controller or is
explicitly documented as an isolated, non-competing context. New controller code must replace and
delete old owners rather than wrap them indefinitely.

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
- input cancels reconciliation while settled bottom geometry independently preserves, clears, or
  re-arms follow-live;
- deactivation blocks callbacks from an unmounted conversation;
- cancellation and settlement preserve the generation watermark;
- incompatible provenance/position pairs fail compile-time controls.

Tests must assert complete results where practical. A test that only repeats fixture arithmetic or
asserts that an enum contains the value supplied by the fixture does not protect behavior.

Pixel convergence remains a real-engine concern. When runtime migration begins, mechanism-level unit
tests must be paired with Chromium/WebKit scroll invariants and real desktop WebKit validation for
kinetic scrolling and stale-paint behavior.

## Incremental migration after this contract

1. Introduce one generation-aware reconciliation controller without changing existing positioning.
2. [x] Migrate saved-anchor restoration: delete the legacy restore dispatcher, pending ref, and
   around-load status map; retain the measurement loop only as a generation/operation-leased
   reconciler.
3. [x] Migrate unread and explicit message targets: the controller owns their generations,
   supersession, reachability, frame convergence, and cancellation; their private loops and target
   around-load ref are deleted.
4. [x] Migrate live-edge pinning and media/content-growth preservation while retaining
   bottom-specific measurement/repaint safeguards; delete both private hook-owned loops.
5. Migrate directional history preservation last, retaining kinetic cancellation and clamp recovery.
6. Route or isolate the remaining owners outside `useMessageListScroll`.
7. Split persistence, user-intent tracking, history windowing, and reconciliation out of the
   orchestration hook.

Each migration must preserve observable behavior, add a falsifiable regression control, and remove
one previous source of scroll authority.
