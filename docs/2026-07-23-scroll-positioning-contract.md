# Message-list scroll positioning contract

Status: migration complete. Every placement path is a controller slice, the orchestration hook
holds no frame loop, and each branch decision a test could not otherwise reach is a pure function.
This document is a rule table: one row is one rule, with the file that owns it. Narrative history of
how a rule was found lives in the commit that added its test, named in the last column.

## Purpose and scope

Positioning splits in two. **Position policy** (what is wanted, whether it is reachable, which
request supersedes which, when input cancels automatic positioning) is pure and deterministic.
**Browser reconciliation** (how estimated and measured geometry converges, WebKit layout and
repaint) is imperative and stays in leased executors. Centralising must not weaken a WebKit safeguard.

| Layer | Owner | Holds |
| --- | --- | --- |
| Commit plan | `commitPlan.ts` | Which work a React commit owes, in what order (below) |
| Hook | `useMessageListScroll.ts` | Runs the plan; at most 8 effects, 15 refs (`useMessageListScroll.budget.test.ts`) |
| Controller | `positioningController.ts` | Generations, supersession, input takeover, lease |
| Runner | `positionRunner.ts`, `placementStrategies.ts` | One run lifecycle, seven placement strategies |
| Executors | `*BrowserAdapter.ts`, `useScrollExecutors.ts` | Pixel writes under a lease; no policy |
| Viewport memory | `viewportSession.ts` | Geometry, input and write attribution; values only |
| Persistence | `scrollPersistenceAdapter.ts` | Saved reading position; values only |
| History windows | `directionalHistoryWindowCoordinator.ts` | Older/newer eligibility and identity; values only |
| Virtualizer | `tanstackMessageVirtualizer.ts`, `tanstackVirtualBridge.ts` | Library access, one locked version |

Out of scope: replacing measurement or repaint safeguards, changing entry priority or saved data,
treating a one-shot scroll as enough under virtualization, making raw `scrollTop` a durable position,
and the two isolated contexts under "Ownership boundary".

## Commit events

One pure function, `planCommit(previousFacts, facts)`, returns the ordered event list a commit owes.
The hook builds `facts` from every value the old effects listed as dependencies (callback identities
included), runs the layout events in one layout effect, and the passive events in one passive effect
after paint. An event is planned when a fact in its trigger list changed from the previous commit,
or on the first commit. A replayed setup (StrictMode) plans as a first commit.

| # | Event | Phase | Planned when these change | Skipped when | Does |
| --- | --- | --- | --- | --- | --- |
| 1 | `enter-conversation` | layout | conversation, unread marker, last id, count, read pointer, static, target, live-edge window, entry callbacks | never | Leaves the old room, arbitrates entry, begins exactly one provisional request |
| 2 | `late-synced-read` | layout | conversation, marker, last id, read pointer, static | the late-MDS predicate is false | Synced read at the tail supersedes a restored position |
| 3 | `settle-divider` | layout | conversation, marker, static | not a same-room marker clear, or reader input exists | Settles to live edge when a divider vanishes before input |
| 4 | `refresh-saved-position` | layout | conversation, first/last id, count, live-edge window | static, or no unsettled saved request | Re-drives a restore still waiting for rows |
| 5 | `refresh-live-edge` | layout | conversation, first/last id, count, newer loading, live-edge window | static | Re-drives an idle live-edge request |
| 6 | `restore-directional-window` | layout | conversation, first id, count, interior placement version | static, or no load snapshot | Restores the reader's anchor before paint after a load lands |
| 7 | `arrival` | layout | conversation, last id, outgoing flag, count, live-edge window | not initialised, or static | Follows, holds or ignores a changed bottom row (`newMessageDecision`) |
| 8 | `row-growth` | layout | row signature | conversation changed, or signature unchanged | Re-pins when rows grew under a reader at the edge |
| 9 | `typing-indicator` | layout | typing flag, conversation | decision says skip | Re-pins under the band the indicator takes from the scrollport |
| 10 | `refresh-interaction-hold` | layout | every commit | no hold, or static | Keeps a held message in place and the jump button current |
| 11 | `remember-read-position` | passive | conversation, read pointer | never | Remembers the read position the next departure saves |
| 12 | `publish-committed` | passive | every commit | never | Publishes committed values the browser ports read |
| 13 | `log-mount` | passive | first commit | later commits | Diagnostic mount marker |
| 14 | `store-target` | passive | store target, count, conversation, static | no target and no earlier request | Begins, refreshes or cancels the store-requested target |
| 15 | `release-directional-window` | passive | conversation, live-edge window | coordinator says none | Drops a stale directional anchor on return to the live edge |
| 16 | `older-load-finished` | passive | older-loading flag | not a true-to-false change, static, or reader off the edge | Forces the final repaint after a catch-up |
| 17 | `rearm-marker-clear` | passive | unread marker | marker unchanged | The next first scroll arms marker clearing again |

Order rules: layout events run in table order before paint; passive events after it, never before a
layout event; a layout event never waits on a passive one. A new concern is a new row here, not a
new effect. Guardrails: `commitPlan.test.ts` pins each trigger; `useMessageListScroll.commitOrder.trace.test.tsx`
pins every call the commits make into the controller, session, persistence adapter and coordinator
against `__traces__/useMessageListScroll.commitOrder.trace.txt`.

## Desired positions

| Position | Meaning | Follows appends |
| --- | --- | --- |
| Live edge | Keep the tail visible until genuine takeover | Yes (the only follow-live variant) |
| Fixed anchor, `bottom-fraction` | `rowTop + fraction * rowHeight = scrollTop + viewport`, fraction in `[0, 1]`; saved reading, media and ambient layout | No, even on the newest row at fraction 1 |
| Fixed anchor, `top-offset` | `rowTop - scrollTop = offsetPx`, negative allowed; directional history and message interaction | No |
| Message target | Row at start, top-third, center or end | No |
| Resident top | Top of the loaded window; later travel may load older | No |
| Legacy offset | Anchorless persisted `scrollTop`; never written by new code | No |

A saved content anchor stays authoritative; its raw pixel value is only a fallback. A raw-only saved
state selects legacy offset and still outranks unread and live edge.

## Requests, sources and precedence

Every request has a positive monotonic generation, a conversation, a semantic source and a desired
position, as a discriminated union (provenance and position must agree; a fallback that changes the
position gets honest fallback provenance). Generation allocation is module-private and survives
remounts. The generation watermark survives settlement and cancellation; stale async work is ignored.

| Source | May want | Notes |
| --- | --- | --- |
| Conversation entry (incl. synced live edge) | Saved anchor, legacy offset, unread, live edge | Synced live edge also discards obsolete saved state |
| Explicit user navigation | Target, live edge, unread, resident top | Supersedes the provisional entry |
| Outgoing message | Live edge only | Reader intent; may supersede navigation |
| Ambient live-edge recovery | Live edge | Only from a paused or null state, only if the caller's geometry guard allows |
| Directional history | Top-offset anchor | Preservation class |
| Media remeasurement | Bottom-fraction anchor | Preservation class |
| Ambient layout (divider moved, delayed insertion, width change) | Bottom-fraction anchor | Strictest class |
| Late XEP-0490/MDS | Live edge | Only before takeover |

| Rule | What holds | Owner | Tests |
| --- | --- | --- | --- |
| Class order | Layout preservation yields to every unsettled position. Media and history preservation yield to a converging reader-intent position but may re-anchor an unsettled live-edge follow. Ambient recovery shares the media class. Unknown sources get the strictest class | `scrollPositionModel.ts` | scrollPositionModel.test.ts, positioningController.test.ts |
| Outgoing send | Creates a live-edge request, dropped while an entry restore or directional restore has not yet applied its first position; after that it need not wait for settle | controller, `newMessageDecision.ts` | newMessageDecision.test.ts, positioningController.test.ts |
| Sliding window | A bottom row brought in by a slide off the live edge is neither arrival nor send; no request, the load keeps the reader | `newMessageDecision.ts` | newMessageDecision.test.ts |
| Media vs send | Media preservation never suppresses an outgoing send | controller | positioningController.test.ts |
| Re-open only | Composer-shrink growth and column-width change never create an ambient live-edge request; width change preserves the captured anchor or an owned target | `useViewportResizeReconciliation.ts` | useViewportResizeReconciliation.test.ts |
| Stimuli | Incoming at the live edge, reactions, typing, resize, media and MAM completion reconcile the current request; none turns a fixed reading position into follow-live | controller | positioningController.test.ts |
| Deactivation | Leaving the list clears conversation, request and MDS eligibility, keeps the watermark, rejects later callbacks | controller | positioningController.test.ts |

## Entry arbitration and later supersession

| Rule | What holds | Owner | Tests |
| --- | --- | --- | --- |
| Entry priority | Exactly one provisional request, chosen in order: resolved synced live edge (invalidates stale local state), saved anchor or raw-only offset, first unread message, live edge | `entryArbitration.ts` | entryArbitration.test.ts |
| Explicit target | Not part of entry priority: a newer request that supersedes the provisional one | controller | positioningController.test.ts |
| Synced live edge | Remote read pointer equal to the tail clears obsolete saved state synchronously; an empty conversation never discards a saved position | `entryArbitration.ts` | entryArbitration.test.ts |
| Late MDS | May reposition only the displayed conversation and only while entry is eligible and before takeover, navigation, send or one accepted correction; never issues live edge merely because the pointer reached the tail; a result from the room just left never reactivates | `entryArbitration.ts` | entryArbitration.test.ts, mdsSettleDecision.test.ts |
| After entry | Generation order governs supersession; a newer generation alone does not bypass conversation or MDS guards | controller | positioningController.test.ts |
| Input cancels | Genuine input cancels the current run for every request except explicit targets | controller | positioningController.test.ts, liveScrollOwnership.test.ts |
| Paused live edge | Keeps its generation in paused-user-input until settled geometry shows whether the reader left; input within the threshold settles it and keeps following | controller | positioningController.test.ts |
| Threshold | Following means strictly under `AT_BOTTOM_THRESHOLD` (150 px); at 150 px or more the scroll-to-bottom button is eligible; an active pin claim suppresses it | `fabVisibility.ts` | fabVisibility.test.ts, scrollEventDecisions.test.ts |
| Manual return | Returning to the bottom after a cancel creates a fresh live-edge generation without reopening late MDS | controller | positioningController.test.ts |
| Unread hold | An accepted marker entry or navigation holds reading intent through settlement and cancellation: near-bottom geometry cannot set the at-bottom latch or re-arm following; only directional input ending within the threshold releases it, as does an accepted live-edge request; entry or deactivation resets it | controller, `observeUserInputEnd` | positioningController.test.ts, useMessageListScroll.markerEntry.test.tsx |
| Target takeover | A deliberate upward attempt releases target protection at once, even when clamped. Wheel, keys, directional touch and scrollbar drag share the policy; upward keys are read in capture (not prevented, unmodified, not editable, inside the list); zero or non-moving downward input only pauses maintenance; observed movement takes over either way; after upward takeover, near-bottom alone cannot re-arm follow | controller, `useScrollContainerBinding.ts` | useScrollContainerBinding.test.ts, positioningController.test.ts |
| Saved live-edge fallback | Requests newer slices until the global tail is resident, then applies live edge; with no forward port it lands at the best resident edge and ends | saved executor | positioningController.test.ts |

## Reachability lifecycle

`request -> resolving -> pending(empty-window | around-load | target-not-indexed) | loading-around | unavailable(by source) | recentering-live-edge -> mounting(index) -> reconciling -> position-applied -> paused-user-input -> settled`

| Rule | What holds |
| --- | --- |
| Empty window | A hydrating empty window is not evidence a saved target is missing |
| Absent target | Distinguishes around-load available, in flight and exhausted; an empty completed slice never reloads forever |
| No loader | Behaviour follows provenance: saved restore uses legacy offset then live edge; unread uses live edge; explicit targets wait; directional history uses captured distance from bottom and clamps; media preservation warns and stops |
| Indexed but unmounted | A loaded message can be absent from the measured window; mount, then position, never both in one frame |
| Live edge | Rows do not prove the global tail is resident: a slid-up window recenters, then mounts and reconciles the tail |
| Unread near the start | A mounted marker at the resident start may reject start placement and fall back to live edge, so no scroll-to-zero loads older history |
| Reconciling | The target is reachable; layout may not have settled |

## Placement paths

All seven run through one `PositionRunner` under a lease; each frame must hold the current lease to write.

| Path | Budget and tolerance | Rules that are easy to lose | Tests |
| --- | --- | --- | --- |
| Saved position | 90 frames, 8 stable, 8 px; no drift takeover (deep history may correct over 300 px) | Writes the initial anchor or offset, marks position-applied, then re-asserts; a restore needing none settles after its first write; an unfinished restore excludes ambient corrections | positioningController.trace.test.ts, useMessageListScroll.restore.test.tsx |
| Unread marker | 300 px drift guard only when content height is unchanged since the last landing; a height correction allows another write | Uses row estimates at once; first calibration of a mount commits the spacer and reasserts in the same task before paint, later ones wait for the next render; final landing geometry decides fallback, not a transient clamp | useMessageListScroll.markerEntry.test.tsx, MessageList.calibration.test.tsx |
| Explicit target | Immediate center writes (never a smooth restart) | Settled maintenance only exposes a clipped edge, never recenters a visible or taller-than-view row, keeps its generation, loads nothing, never repeats consumption or highlight, never acquires follow-live | settledTargetReconciler.test.tsx, messageTargetResize.test.tsx |
| Live edge | 60 frames, 8 stable; no drift takeover (growth is its job) | Tail-layout flushes, 4 px missed-frame correction, repaint-burst coalescing (adapter-scoped), background-MAM repaint suppression, `overflowY` stale-paint repair; settled or best-effort flushes owed repaint, takeover or supersession discards it; entry drops repaint debt | liveEdgeBrowserAdapter.test.ts, MessageList.pinBottomRepaint.test.tsx |
| Fixed-anchor preservation | 90 frames, 8 stable, 8 px | Media, divider and insertion stimuli share bottom-fraction geometry | mediaGrowthDecisions.test.ts, ambientAnchorDecisions.test.ts |
| Directional history | 60-frame late-measurement budget, 2 px target shift, 5 px clamp recovery | Accepted before the load; pending until the first resident id changes (or an interior placement under the bound) or the load settles with no shift; boundary input keeps the captured anchor until the first write, then takeover is allowed; explicit requests supersede it | directionalHistoryBrowserAdapter.test.ts, directionalHistoryWindowCoordinator.test.ts |
| Resident top | Settles after 2 frames within 1 px, best-effort after 120 frames | Interpolates from the actual offset each frame; resets the top travel latch; its own progress never counts as pagination evidence | positioningController.trace.test.ts |

Held writes: a frame whose write a released iOS fling still holds is no landing; the loop neither
settles on the fling's position nor spends frames waiting, up to a bound well past a fling's
momentum (`HELD_WRITE_FRAMES`, `HELD_INPUT_TIMEOUT_MS`). Navigation can own motion from the fling
that preceded it: explicit target, return-to-latest until first settle, Home while current, the
marker visit, the jump-to-last-read visit and the handover to live edge. Entry's own divider does not.

### Directional history details

| Rule | What holds | Tests |
| --- | --- | --- |
| Restart | At the resident bound an interior arrival evicts the oldest row, so the first id can change before the batch lands; a later first-id change restores the same anchor again with a fresh request in the same pre-paint pass, only while the reader still reads where the last restore put them (no input and no non-preservation request since that generation) | directionalHistoryWindowCoordinator.test.ts, useMessageListScroll.loadNewer.test.tsx |
| Under the bound | An interior arrival keeps the first id but moves rows below it; the window carries the store's interior placement version, which counts as a shift while a load is pending | directionalHistoryWindowCoordinator.test.ts |
| Refused load | A load the controller refused (interaction hold) or that was superseded holds nothing; ambient insertion keeps the shift and the batch's; the retained-row test uses aliases, since the batch can rename a handle with an archive id | directionalHistoryWindowCoordinator.test.ts |
| Snapshot | Persists until its load settles, not only its cooldown; a settlement from an older load never releases the current one; entry drops the departed room's snapshot | directionalHistoryWindowCoordinator.test.ts |
| Anchor follow | Between capture and landing the anchor follows every scroll event; rendered rows covering the top make the row the reader sees there the anchor (a row mostly past the top yields only if the next starts in the top half); stops changing once rows land before it; a restart requests the held row and placement | directionalHistoryBrowserAdapter.test.ts |
| Hold | From first write to end of execution the virtualizer retains the anchor and compensates every resizing row before it | directionalHistoryBrowserAdapter.test.ts |
| Evidence | Automatic pagination needs independently observed movement reaching the boundary; layout-only resize, typing, media, clamp and delayed corrections supply none. An upward wheel at the resident top is an attributed older-history request even if clamped. Explicit navigation, initial loads and downward wheel at the newer boundary are separate | useDirectionalHistoryLoads.test.ts, scrollEventDecisions.test.ts |

## Message interaction holds

| Rule | What holds | Tests |
| --- | --- | --- |
| Acquire | Desktop direct chats and rooms acquire before click activation on a primary press, keyboard action focus or an open More/reaction/context panel. Passive hover over text or visible toolbar buttons never acquires, whether drafting or reading history. Native touch taps and swipes do not hold | positioningController.interaction.test.ts, useMessageInteractionHold.test.tsx, message-hover.ts |
| Position | Holds the row handle and body top offset through the anchor executor. Measured typing-band changes reconcile the same request and generation, moving only enough to clear the active control and the formerly visible tail when acquired at latest and both fit. The control takes priority when space is tight. New arrivals never become the clearance target. A held final row still compensates its own growth | positioningController.interaction.test.ts, message-interaction-typing.ts |
| Virtualizer | Retains the row and suspends independent compensation; the executor reserves only missing bottom space and restores it on release | positioningController.interaction.test.ts, useMessageInteractionHold.test.tsx |
| Cancel | Native scrolling, selection-edge autoscroll, drag or middle-click autoscroll and find-in-page take priority. Passive mouse movement cannot reacquire after cancellation; another primary press, keyboard action focus or panel opening is needed | positioningController.interaction.test.ts, useMessageInteractionHold.test.tsx, message-hover.ts |
| Replace | Arrivals, typing, media, divider changes and geometry re-arming cannot replace an active hold; later layout stimuli reopen the same generation | positioningController.interaction.test.ts, useMessageInteractionHold.test.tsx |
| Release | Primary press completion or departure with panels closed releases pointer-only ownership; native text selection retains protection until departure. Keyboard focus departure releases its reason. Composer typing, middle press, blur and target removal retain cleanup. Open panels keep ownership across row boundaries. Retraction closes safely without transferring; archive-id backfill preserves identity | positioningController.interaction.test.ts, useMessageInteractionHold.test.tsx, message-hover.ts |
| Resume | Only a reader following latest resumes; geometry is read fresh, including pixels whose scroll callback has not arrived; history readers keep a settled fixed position; a send or explicit jump takes priority and closes panels first; input ending at the unchanged true bottom settles there; upward input never re-arms at its pre-motion bottom | positioningController.interaction.test.ts, useMessageInteractionHold.test.tsx |
| Controls | Jump button also shows for arrivals inside the near-bottom band while holding, hidden while a More or reaction menu is open; toolbar slots stay fixed; the reaction picker captures its list space on open; Escape closes the panel and restores its trigger; touch sheets and static previews never hold | MessageToolbar.interaction.test.tsx, useMessageInteractionHold.test.tsx |

## Viewport observation and attribution

| Rule | What holds | Owner |
| --- | --- | --- |
| Session | One conversation-scoped session; values only (no DOM, virtualizer, scheduler or write); entry resets every fact; observations tagged for the room just left are rejected | `viewportSession.ts` |
| Movement | Compared after viewport clamping and recorded application writes; no unchanged-height or settle-timeout requirement; sampled movement keeps its own geometry for the next native event; a released key keeps ownership of its matching native event until an independent layout change | `viewportSession.ts` |
| Spacer | Height updates go through `commitVirtualizerLayout`, observing before and after the write so a spacer-induced clamp is attributed | `VirtualizerSpacer.tsx` |
| Reading anchor | Observed movement rebases the anchor to a visible row; a height change rebases at the shared boundary, reaching the media batch and any active media request without a new generation; the batch anchor comes from the session, not a DOM snapshot taken after growth | `useMessageListScroll.ts` |
| Fling | Attribution needs both the current lease and the virtualizer's real pending-fling state, for native events and measurement alike; new input still takes over and a new finger ends the old fling; settled maintenance, follow re-pins, missing gesture state and unobserved movement keep their vetoes | `viewportSession.ts` |
| Persistence | Consumes immutable session snapshots; owns entry reads, throttled saves, leave versus mark-left, clearing; rejects stale-room snapshots and controller-owned scrolls | `scrollPersistenceAdapter.ts` |
| Shadow model | Error-contained; failure degrades by the active request's policy and never escapes into an effect or handler. Zero divergences means the model agrees with the semantic label, never that pixels landed; the demo invariant suite fails on any divergence or instrumentation error | `scrollPositionShadow.ts` |

## Virtualizer and native scroll ownership

| Rule | What holds | Proof |
| --- | --- | --- |
| Library lock | `@tanstack/react-virtual` pinned to one exact version, updates without automerge; ten undeclared members reached only through `tanstackVirtualBridge.ts`, each run against the installed library | `tanstackVirtualBridge.test.ts` |
| Bench | `scrollBench/` runs the real list, controller, adapters and library over a scripted scroller; each replay is a past fix and fails when reverted; a scroll bug is reproduced there as a replay first | `scrollBench/replays*.test.tsx` |
| Pending reconciler | The library arms a pending target for up to five seconds on every scroll write; cancelling a lease alone cannot retire it; the adapter reports before/after observations for navigation, measurement and reconcile writes and syncs its cached offset first | `tanstackMessageVirtualizer.*.test.tsx` |
| Clamped compensation | A compensation the browser clamped (spacer not yet grown) counts as the position it meant for resized-row choice, estimate-refresh anchor and next compensation, until the reader leaves that max | `issue1601-measurement-write.test.tsx` |
| Writes | Measurement and immediate offset/index writes publish the landed offset before paint; a reconcile write is refused if its preceding observation finds reader movement; settlement and row release retarget pending centering to the current offset | virtualizer adapter |
| Receipts | `scrollToOffset` and `scrollToIndex` return a receipt: `applied` (read-back offset), `queued` (held for an iOS fling, changes once), or `refused` (`reader`, `superseded`, `dropped`, `detached`); writes carry the lease owner, current while the request is active; a non-current owner is refused, including a held write; measurement compensation has none; emergency writes and target re-anchor pass no owner | `tanstackMessageVirtualizer.receipt.test.tsx` |
| Automatic adjustment | Disabled while a selected message owns positioning; live scrollers disable `overflow-anchor` throughout attachment and restore it on detach | hook, virtualizer |
| Motion state | A scroll is in progress from its first event or first polled offset change until six quiet frames; the reader takeover leaves motion alone; every library-made write reports its read-back as motion with the reader's direction; a report inside React's commit asks for no synchronous render; navigation writes outside a scroll publish at rest | `tanstackMessageVirtualizer.ts` |
| Upward panning | A measured row wholly above the viewport that shrinks is compensated even when scrolling backward (override of the library's fold/direction rule; review on every upgrade); backward growth and spanning remeasures are not; held anchor and suppression take precedence | `tanstackMessageVirtualizer.estimates.test.tsx`, `e2e/scroll-native-pan.ts` |
| Estimates | Resampling metrics during a pan allows up to three chrome corrections per geometry change; sampled width stays put (own-only windows read the content column); a refresh keeps the held anchor or the reader's row in place through the library correction, committing re-render in the same task; a shift larger than the old spacer's room first commits the taller layout windowed at the shifted offset, then writes the shift, before paint; whisper cards are excluded from sampling; an iOS gesture defers the correction | `useRowMetrics.test.tsx`, `e2e/scroll-native-pan-estimates.ts` |
| Proof gap | WebKit upward-wheel and momentum with a shrinking row above the reader is an accepted proof gap | - |

## Behavior inventory

| Trigger | Position | Notes |
| --- | --- | --- |
| Entry with saved state | Bottom-fraction anchor | Empty window waits; absent target loads around; unmounted target mounts |
| Entry with raw-only state | Legacy offset | Outranks unread and live edge |
| Entry with unread | Message at start | Hydration and mounting may delay |
| Entry otherwise | Live edge | Follows until the reader leaves it |
| Reply, search, activity target | Message target | Maintenance rules above |
| Jump to last read | Message at start | Reuses marker placement |
| FAB or End | Unread marker, then live edge | Chosen from current geometry: a marker still below the view is visited first (virtualized start alignment, non-virtualized top-third); visible or above goes live |
| Outgoing message | Live edge | Supersedes history after the first landing |
| Incoming at the live edge | Current or re-armed live edge | Never makes a fixed anchor follow |
| Delayed insertion, divider move, media while reading | Target or bottom-fraction anchor | Ambient precedence |
| Late MDS live edge | Live edge | Only before takeover |
| Load older or newer | Top-offset anchor | Directional rules; clamp to captured distance from bottom if the anchor vanishes |
| Home | Resident top | Does not itself load older |
| Reaction, typing, resize, MAM completion | Reconcile current | Stimulus-specific eligibility |

## Ownership boundary

| Rule | What holds |
| --- | --- |
| One authority | No frame loop inside `useMessageListScroll`; executors are built only in `useScrollExecutors`; `useDirectionalHistoryLoads` builds none and owns no write; emergency bottom and resident-top writes are executor fallbacks |
| Frame lifecycle | Every leased reconciler uses `controllerFrameLoop`, finishing exactly once on stale lease, thrown work, supersession, takeover, deactivation or settle; pin-claim start, renew and release are part of it, so the claim deadline is defense in depth |
| Ambient layout | Entirely inside the scroll owner; `MessageList` supplies only the interior-placement version and a row-position lookup; the virtualized executor corrects through `scrollToOffset` or `scrollToIndex`; the first correction runs in the post-commit pre-paint layout effect |
| API guard | The hook result and active-list registry have reviewed API-shape tests; a new callback fails until its ownership is reviewed; the generic `useMessageScroll` is deleted and kept absent |
| No second writer | `ChatView`, `RoomView`, composer and media callbacks hold no pixel writer; room media uses the same list-owned callback through a stable shell |
| Isolated: static preview | `SearchContextView` has its own scroller, no persistence, follow-live, unread or windows; requests inside any list route by containment (`messageTargetContext`), previews never register; Home keeps one isolated smooth write |
| Isolated: keyboard selection | `useMessageSelection` uses `scrollIntoView({ block: 'nearest' })` as viewport maintenance and reports through `observeUserInputEnd` |
| Future owners | Each must route through the controller or be documented as isolated; new controller code replaces and deletes old owners |

## Test standard

Pure-model tests use paired controls that differ by one semantic fact, and each must name a plausible
wrong implementation that would fail it. Assert complete results; a test that repeats fixture
arithmetic protects nothing.

| Control | Pair |
| --- | --- |
| Follow | Live edge follows an append; an anchor on the same tail row, a target, resident top and legacy offset do not |
| Reachability | Empty window, absent target with and without loader, indexed-unmounted and mounted resolve to different phases; around-load available, in flight, exhausted differ; source policies differ |
| Live edge | An unmounted tail mounts before reconcile; a slid-up window recenters first; a legacy offset reconciles without mounting another row |
| Entry | Unread marker at the resident start falls back to live edge; resolved synced live edge beats a saved anchor; saved and raw-only beat unread; unread beats live edge |
| Navigation | FAB or End picks the marker only while it needs a visit; a newer target supersedes the entry generation |
| Staleness | Stale generation completion and stale input cancellation are ignored, current succeed; deactivation blocks callbacks; cancel and settle keep the watermark |
| MDS and send | Late MDS supersedes eligible entry, not after takeover, navigation or a switch; a send cannot steal pending saved or directional preservation and may proceed after first apply |
| Input | Cancellation and re-arm obey the entry and input rules, including pending directional preservation and unread holds |
| Commit plan | Each event's trigger changes and each skip condition differ by one fact (`commitPlan.test.ts`); the call order across scripted commits matches the recorded trace |
| Types | Incompatible provenance and position pairs fail at compile time |

Pixel convergence stays a real-engine concern: pair mechanism tests with Chromium and WebKit scroll
invariants and desktop WebKit validation for kinetic scrolling and stale paint. Playwright does not
cover iOS fling; validate it on the iOS simulator.

Each change keeps observable behavior, adds a falsifiable regression control, and removes one
source of scroll authority.
