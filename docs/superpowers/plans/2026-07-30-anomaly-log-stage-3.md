# Stage 3 — the first real detectors

Design: `docs/superpowers/specs/2026-07-29-client-anomaly-detection-log-design.md` §5.1, §5.3.
Stages 0–2 shipped (#1167, #1178, #1187). Stage 2 was fan-out: no detection logic. This stage adds
the first three detectors that actually decide something.

This plan preserves implementation history. The current emitted contracts, severities, context
fields, and named non-cases are owned by `docs/ANOMALY_INVARIANTS.md`.

**No SDK change.** Everything here is observable from public app surfaces.

---

## 0. What changed since the spec was written

Three findings from reading the current code. Each changes a detector's design, so they come first.

### 0.1 `fab-at-live-edge` cannot be written as the spec words it

The spec says "FAB visible while the list is at the bottom". That state is **unreachable** from the
rule that decides FAB visibility:

```ts
// fabVisibility.ts
if (pinningToBottom) return false
return distFromBottom > threshold      // FAB_THRESHOLD = 300
```

`AT_BOTTOM_THRESHOLD` is 150. So "at the bottom" and "FAB shown" are separated by a 150px dead band
and cannot both hold — a detector comparing them would be **unfalsifiable**, the hollow-test failure
mode this repo keeps rediscovering.

The real bug class is **stale state**: `showScrollToBottom` is React state written from the scroll
handler in `useMessageListScroll.ts`. If the handler stops firing after the list returns to the
bottom, the FAB stays up while the viewport is at the live edge. That is what users see, and it is
what `project_fab_flash_open_at_bottom` was about.

So the detector must compare the **rendered FAB state** against a **fresh, independent measurement**.
This is load-bearing: reading the hook's own `isAtBottomRef` would make the detector blind exactly
when the bug is present, which §5.1 calls the worst possible detector failure.

→ **Requires a new measurement seam.** See §1.2 and Decision D1.

### 0.2 `unread-survives-focus` live-edge contract

See `docs/ANOMALY_INVARIANTS.md` for the current sampling contract and named non-cases. It owns the
runtime semantics; this implementation plan does not duplicate them.

### 0.3 `jump-target-miss` has an exact settle point already

The explicit-target executor's `complete(request, outcome, applied)`
in `useMessageListScroll.ts` runs after the jump settles, already re-finds the element via
`findMessageTargetElement`, and already knows whether the position was `applied`. No new seam.

---

## 1. Surfaces

### 1.1 Existing, reused as-is

| Surface | Use |
|---|---|
| `isViewportAtBottom(kind, id)` (`utils/viewportAtBottom.ts`) | Did the user actually see the newest message |
| `document.hasFocus()` / `visibilityState` | Focused |
| SDK `chatStore` / `roomStore` state | `unreadCount`, active conversation id + kind |
| Explicit-target `complete()` callback | `jump-target-miss` settle point |
| `signalAnomaly` (`utils/anomalySignal.ts`) | The stage-2 seam, extended with detector variants |

### 1.2 New: a scroller-element registry

`src/utils/viewportScroller.ts` — mirrors `viewportAtBottom.ts` exactly (same key shape, same
replace-on-remount semantics, same unknown-id-is-safe rule), but registers the scroller **ref**
rather than a boolean ref, so a detector can measure `scrollHeight - scrollTop - clientHeight`
itself.

Registered from `ChatView` and `RoomView`, alongside their existing boolean-ref registrations.
The registrations are guarded by `__FLUUX_ANOMALY__`, and the build audit treats this support module
as instrumentation so a release fails if it survives dead-code elimination.

---

## 2. The detectors

Each decision lives in a pure detector with focused firing and healthy-control coverage. See
`docs/ANOMALY_INVARIANTS.md` for the current record semantics rather than duplicating them here.

---

## 3. The evaluation tick

`unread-survives-focus` and `fab-at-live-edge` both need "held continuously for N ms", so both need a
clock. One gated `setInterval` (1s) inside the anomaly tree drives both evaluators;
`jump-target-miss` is event-driven and needs no tick.

Mounted from `install()`'s refcounted attach block, alongside the digest timer and the signal handler
— so a StrictMode remount cannot produce two tickers, which the stage-2 refcount already proves.

`AnomalyInstaller` mounts inside `XMPPProvider` in `main.tsx` so SDK state is reachable, but
outside `HashRouter` — no route access, which is fine since no detector needs it.

---

## 4. Registry and value additions

| Addition | Where |
|---|---|
| `ID.unreadSurvivesFocus`, `ID.fabAtLiveEdge`, `ID.jumpTargetMiss` | `values.ts` |
| Rows for all three, plus their named non-cases | `docs/ANOMALY_INVARIANTS.md` |
| `CTX.distFromBottom`, `CTX.heldMs`, `CTX.offBy` | `values.ts` |
| Three new `AnomalySignal` variants | `utils/anomalySignal.ts` |

Parity between `ID` and the registry doc is already enforced by `values.test.ts`.

---

## 5. Tasks

| # | Task | Gate |
|---|---|---|
| 1 | `viewportScroller.ts` registry + tests; register in ChatView/RoomView | unit |
| 2 | `unreadSurvivesFocus.ts` pure detector + tests (fire, control, every reset) | unit |
| 3 | `fabAtLiveEdge.ts` pure detector + tests (fire and healthy-settle controls) | unit |
| 4 | `jumpTargetMiss.ts` pure predicate + wire into `complete()`; tests | unit |
| 5 | Registry/value/signal additions; extend `signalRecords` mapping | unit + parity |
| 6 | Tick driver in `install()`; StrictMode test | unit |
| 7 | Demo-mode validation of at least one detector firing and staying silent | manual + Playwright |
| 8 | Full gates: `npm test`, `typecheck`, `lint`, `check:anomaly:prod`/`:dev`, `test:scroll` | all |

Break checks per §7.1: revert each guarantee, confirm the matching test fails.

---

## 5b. What the browser found that the unit tests could not

The e2e control test — "a healthy demo session trips none of the detectors" — failed on
its first run with **both** timed detectors firing. Every unit test passed at the time.
Three defects, all in the SAMPLING rather than in the detectors:

1. **The FAB is always in the DOM.** Visibility is `inert={!fabVisible}` on its wrapper
   in `MessageList.tsx`, so `querySelector(...) !== null` read `true` forever. Fixed
   by requiring no inert ancestor, and by using `querySelectorAll` so a hidden FAB
   earlier in the document cannot mask a live one.
2. **`fabVisible` is `showScrollToBottom || windowSlidUp`** in `MessageList.tsx`.
   With the window slid up the button legitimately means "jump to the latest", even
   with the viewport at the bottom of what is loaded. `windowAtLiveEdge` is now part of
   the sample, and the detector's premise is narrower for it.
3. **The demo could not reach a read state.** `markAsRead` runs on a focus TRANSITION
   (`useWindowVisibility.ts`) or on leaving a tab (`useViewNavigation.ts`) — never
   while a page stays focused, which is a headless page's whole life. The control now
   drives a real transition and asserts the count reached 0, so it cannot pass by
   watching nothing.

None of these were fixable by weakening a detector, and the second one narrowed a
detector that would otherwise have been deleted for crying wolf. This is the argument
for the system-level control test as a gate rather than a nicety.

## 6. Decisions — settled 2026-07-30

- **D1 → ship the scroller registry** (option a). `fab-at-live-edge` stays in stage 3 with an
  independent measurement.
- **D2 → `suspect`, not `bug`.** `bug` keeps meaning "an invariant broke". Promote only if the
  daily-driver log shows it is not noisy.
- **D3 → 2s / 1s as written**, understood to be guesses pending real log data, and subject to §6.1:
  a detector that keeps crying wolf gets deleted, not tuned forever.

Original framing, kept for the record:



**D1 — the scroller registry (§1.2).** It is the only way `fab-at-live-edge` is not blind when the
bug fires. Its guarded registrations let release builds eliminate the module, and the build audit
fails if that support code survives. Alternatives: (a) keep the registry in anomaly builds; (b)
drop `fab-at-live-edge` from stage 3 and revisit with the stage-5 SDK seams; (c) write it against the
hook's own state and accept that it cannot see the bug — **not recommended**, it is a hollow
detector by construction.

**D2 — `unread-survives-focus` severity.** Spec says `bug`. But the app marks read on focus regain
(`useWindowVisibility`), so a lingering count for 2s is more likely a *propagation* delay than a
broken invariant. `suspect` would keep the log's `bug` class meaning "an invariant broke". Recommend
`suspect` for its first outing, promote to `bug` once the daily-driver log shows it is not noisy.

**D3 — hold windows.** 2s (spec) and 1s (my choice). Both are guesses until there is real log data.
Fine to ship and tune, but tuning must not become indefinite — §6.1 says a detector that keeps
producing false positives gets deleted, not tuned forever.
