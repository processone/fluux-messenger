# Message-View Virtualization — Design

- **Date:** 2026-06-23
- **Status:** Approved (design); pending implementation plan
- **Related:** `.claude/plans/pour-la-virtualisation-de-partitioned-cocke.md` (Phase 1 + Phase 2 sketch), Phase 1 commits (rooms/chat memory windowing `56a65f4b`/`3bfd0064`, anchor restore 1e), occupant-panel virtualization `6cba7eec`, `docs/superpowers/specs/2026-06-05-perf-stress-ui-harness-design.md`, the `#540` content-visibility revert

## Context

The message list is **not virtualized**: the whole message array of the active conversation/room mounts in the DOM (up to `MAX_MESSAGES_PER_*` = 1000). On Linux/WebKitGTK this causes a **multi-second main-thread freeze** when switching into a large busy room (`[MainThreadStall] ~3191ms` measured on a 1000-message, 97-occupant room), plus FPS drops on sustained scroll and window resize. macOS/WKWebView does not reproduce the freeze (cheap layout), so **DOM node count is the platform-independent proxy** for the layout cost (~1000 rows ≈ 47k nodes).

A prior attempt to integrate a generic library (react-virtuoso) failed — *"doesn't work reliably with our scroll behavior"*. A `content-visibility:auto` stopgap (#497) was reverted (#540) because it regressed macOS (rows vanishing on text selection, frozen toolbar, scroll jumps). The lesson from #540: **a fix that helps Linux but regresses macOS is not a fix** — every change must be verified on both engines.

**Phase 1 (done)** windowed *memory*: only the active conversation/room keeps its message array resident; non-active are evicted and re-hydrated from IndexedDB, the MAM merge is gated, and the catch-up cursor is decoupled. This bounded RAM and reduced the switch-mount to a ~120-message re-hydration window. The **occupant panel was also virtualized** (`6cba7eec`) with `@tanstack/react-virtual`, validating the library in the app's real layout on both engines (501 occupants → ~32 mounted rows).

**Phase 2 (this spec)** windows the *view*: render only the visible slice of messages, keeping the DOM bounded both at switch time and during sustained scroll. This is the harder half — it collides with the bespoke scroll machinery in `useMessageListScroll.ts`, which is exactly why a generic component (which wants to *own* the scroll container) could not be dropped in.

### Why this is hard

Every scroll behavior in `useMessageListScroll.ts` reads the **real, fully-mounted DOM**: `querySelector('[data-message-id]')`, `element.offsetTop`/`offsetHeight`, and `scroller.scrollHeight`. The behaviors are: stick-to-bottom + auto-scroll, the `ResizeObserver` scroll correction (with the WebKitGTK anti-loop rAF), MAM prepend with offset-based anchor restore + a 15-frame anti-momentum re-assert, jump-to-message / reply-scroll / marker scroll, conversation-switch position restore, the bottom-most-visible anchor capture (1e), and the read-marker `IntersectionObserver`. When rows are unmounted, `querySelector` returns null and `offsetTop` no longer exists.

## Goals

- Bound the mounted DOM to the visible window + overscan regardless of backlog size (switch into a 1000-message room mounts **≤ ~60 `.message-row`**, not 1000).
- Eliminate the WebKitGTK switch freeze (3 s → a few hundred ms) and keep sustained scroll/resize bounded (the persistent stall).
- **Zero behavior regression**: all existing scroll behaviors remain pixel-correct on macOS **and** Linux.
- Preserve multi-message select-and-copy (a #540 regression cause).
- Keep the virtualizer implementation **swappable** behind a small interface, so the `@tanstack` choice is not load-bearing.

## Non-goals

- Migrating find-on-page to `searchIndex` (full-history, tokenized search). Find-on-page stays array-based over the loaded window — same coverage as today post-Phase-1 — and only rebinds its scroll-to-match to the virtualizer. The index migration is a separate follow-up.
- A general virtualization library for arbitrary lists. This is purpose-built for the message list's scroll model. (The occupant panel already uses `@tanstack/react-virtual` directly for the easy/plain-scroll case.)
- Changing the IndexedDB pagination or the Phase 1 memory model.

## Architecture

### The interface (the real design — small, swappable)

The virtualizer's job is to hand the scroll hook the same facts it reads from the DOM today, but for **mounted and unmounted** rows alike:

```ts
interface MessageVirtualizer {
  getVirtualItems(): { index: number; start: number; size: number; key: string }[]
  getTotalSize(): number                            // stable estimated total height == scrollHeight
  getOffsetForMessageId(id: string): number | null  // offset of a message, mounted OR not
  ensureMessageMounted(id: string): Promise<void>    // expand the window so the row mounts next commit
  measureElement(el: HTMLElement | null): void       // measure + cache the real per-row height
  // getItemKey = messageId → the measurement cache follows the MESSAGE, not the index
  //   (this is what survives MAM prepend, which shifts every index)
}
```

### The render (mirrors the validated occupant panel)

Flatten date-group headers + the new-message marker + message rows into a single `items[]` index, each with a stable `key` (`messageId` or a separator key). The content wrapper becomes the spacer:

```tsx
<div ref={setScrollContainerRef} onScroll={handleScroll}>          {/* scroll container: unchanged */}
  <div ref={contentWrapperRef} style={{ height: v.getTotalSize(), position: 'relative' }}>
    {v.getVirtualItems().map(it => (
      <div key={items[it.index].key} data-message-id={…} className="message-row"
           ref={v.measureElement}
           style={{ position: 'absolute', transform: `translateY(${it.start}px)`, width: '100%' }}>
        {renderRow(items[it.index])}
      </div>
    ))}
  </div>
</div>
```

### The invariant that keeps most behaviors unchanged

Because the content wrapper's height equals `getTotalSize()`, the scroll container's native `scrollHeight` **already equals** the virtualized total. So everything that reads `scroller.scrollHeight` or sets `scrollTop = scrollHeight` is **unchanged**: stick-to-bottom, the `ResizeObserver` correction, the new-message effect, the typing/reactions effects, FAB visibility, and the load-at-top trigger.

Only behaviors that read a *specific element's* `offsetTop` when that element might be unmounted must rebind. That surface is small (~6 points), not the whole machinery.

### Implementation behind the interface

Implement `MessageVirtualizer` with `@tanstack/react-virtual` (already a dependency, validated on the occupant panel). It provides `getVirtualItems`, `getTotalSize`, `getOffsetForIndex` (→ `getOffsetForMessageId` via an id→index map), `scrollToIndex` (→ `ensureMessageMounted`), `measureElement`, and `getItemKey`. If the spike (below) shows it cannot anchor cleanly on prepend, swap to a **custom implementation behind the same interface** — the integration work is unaffected.

## Behavior rebinding

| Behavior | Today | After |
|---|---|---|
| Stick-to-bottom / RO correction / new-msg / typing / reactions / FAB / load-at-top | `scroller.scrollHeight`, `scrollTop = scrollHeight` | **unchanged** (wrapper height == `scrollHeight`) |
| MAM prepend anchor | `anchorEl.offsetTop − savedOffsetFromTop` | `getOffsetForMessageId(id) − savedOffsetFromTop`, 2-step (see below) |
| Jump to message / reply / target / marker | `querySelector` → `offsetTop` | `await ensureMessageMounted(id)` → `getOffsetForMessageId(id)` + alignment |
| Find-on-page scroll-to-match | `querySelector` → `offsetTop` | same as jump (`ensureMessageMounted` → offset); array scan + coverage unchanged (see Non-goals) |
| Bottom-most-visible anchor capture (1e) | binary search over `.message-row` `offsetTop` | binary search over the mounted window / `getVirtualItems` start offsets |
| Read marker (`IntersectionObserver`) | observe mounted rows | re-observe the mounted set on each window change |
| Multi-message select + copy | DOM selection (`useMessageCopyFormatter`) | store-backed reconstruction when the selection spans unmounted rows (see below) |

### The three hard points

**① MAM prepend anchor (the crux).** Older messages insert at the front, shifting every index; `getItemKey = messageId` keeps each measurement bound to its message. Restore in **two steps** (this is the alignment tuning to expect):
1. *Immediate*: `scrollTop = getOffsetForMessageId(anchorId) − savedOffsetFromTop`. The just-prepended rows above the anchor are still **estimated**, so the offset is approximate.
2. *Corrected*: on the next frame, after the virtualizer has **measured** the new rows, re-run the correction. The existing 15-frame anti-momentum re-assert absorbs the settle.

**② Jump (reply / target / marker).** `await ensureMessageMounted(id)` expands the window so the row mounts on the next commit, then `getOffsetForMessageId(id)` + alignment (e.g. `offset − clientHeight/3`). Works even when the target is at index 5 while the viewport is at index 500.

**③ Read marker (`IntersectionObserver`).** Re-observe the mounted set whenever the window changes (disconnect + observe). The bottom-most-visible computation runs over mounted rows (the visible ones are mounted by definition; unmounted rows are off-viewport → never "seen"), so `lastSeenMessageId` advances correctly.

## Multi-message copy (store-backed, parity)

Intercept the `copy` event on the scroll container. The selection's two endpoints are always on **mounted** rows (you can only select visible content), so resolve each to its `.message-row[data-message-id]` ancestor.

- Selection within the mounted window → let native DOM copy proceed (today's `useMessageCopyFormatter` path, unchanged).
- Selection that **spans** unmounted rows → reconstruct from the in-memory message array of the active conversation: `messages.slice(indexOf(startId), indexOf(endId) + 1)`, format each with the same per-message formatter, join, then `clipboardData.setData('text/plain', …)` + `preventDefault`. The spanning case copies whole messages from start to end (which is what "select 5 → 500" means).

This is a pure function (`{ startId, endId, messages } → text`) and is unit-tested as such.

> **Verified correction (2026-06-24, Blink; DOM-spec, so same on WebKit).** The premise
> above — that a selection can *span* unmounted rows — is **false**. Removing a node from
> the DOM relocates any live Range boundary to the parent (per the DOM spec's node-remove
> steps), so the browser **collapses** a selection the instant a selected row scrolls out
> and unmounts (measured: a 92-char selection → 0, `isCollapsed`, both boundaries on the
> spacer). You therefore **cannot** select across off-screen virtualized rows, and the
> `messages.slice(startId..endId)` "spanning" reconstruction never triggers. What ships:
> the store-backed path reconstructs the **within-window** selection from the array so the
> virtualized rows carry correct dates/names (the windowed DOM splits date separators into
> separate items the DOM walk can't follow). Copying a very large range in one gesture is a
> **known limitation** of DOM virtualization vs the old full-mount path (and vs the #540
> `content-visibility` attempt, which kept rows in the DOM). A virtualization-friendly bulk
> copy (a select-mode, or ⌘A → copy the loaded range from the array) is a follow-up.

## Alignment module

A pure, DOM-free, unit-tested module `messageScrollAlignment.ts` centralizes the scroll math (today scattered as inline magic numbers):

- `anchorBottomScrollTop(offset, size, bottomGap, clientHeight)` = `offset + size + bottomGap − clientHeight` (the 1e bottom-anchor restore)
- `markerScrollTop(offset, clientHeight)` = `max(0, offset − clientHeight/3)` (marker / target "1/3 from top")
- `prependAnchorScrollTop(newOffset, savedOffsetFromTop)` = `newOffset − savedOffsetFromTop`

The hook calls these with offsets from the virtualizer instead of inline math, so alignment can be tuned and tested without a live build.

**Estimate-vs-measured divergence** is the main source of micro-jumps. Mitigations: anchor on **measured** offsets (never estimated); the 2-step prepend correction (immediate estimated + post-measure corrected); a generous overscan; and reusing the existing 15-frame anti-momentum re-assert to absorb measure-settling. The estimate seed (`estimateSize`) uses a measured running average, not a constant.

## Phasing

Spike-first — the spike precedes any integration.

- **2.0 — Throwaway spike, decision gate.** Build the `@tanstack` `MessageVirtualizer` impl + a harness that exercises only the hard cases, with acceptance criteria on macOS **and** Linux/WebKitGTK:
  - prepend-anchor pixel accuracy (load older ×5, anchor does not move, no jump on measure-settle);
  - jump-to-unmounted (index 5 from 500, lands aligned);
  - stick-to-bottom coexistence (our `scrollTop` writes vs the library's scroll observation — no fight);
  - variable heights (image/reaction/collapse loading after mount → measurement corrects, no drift).
  - **Gate:** green → continue with `@tanstack`. Red → swap to a custom impl behind the same interface; integration unaffected.
- **2.1 — Integration, rooms first, behind a flag.** Refactor `useMessageListScroll` to consume the interface (the ~6 rebind points). Wire the windowed render in the room message list. Feature flag `enableMessageVirtualization` (default OFF) so we ship dark, A/B, and roll back instantly; both render paths coexist during the bake.
- **2.2 — Store-backed copy + read-marker re-observe + bottom-anchor capture rebind.**
- **2.3 — Chat mirror (1:1)**, same as Phase 1.
- **2.4 — Flip the flag on** after both-platform verification; remove the flag and the old non-virtualized path after a bake period.

## Two-platform de-risking (the #540 lesson)

Every phase is verified on **both** macOS (WKWebView) and Linux (WebKitGTK) before merge. macOS does not reproduce the freeze but catches correctness/alignment regressions (jumps, blank viewport, lost selection); Linux confirms the perf win. The spike especially must pass on both before the integration starts.

## Testing

- **Unit (deterministic, CI):**
  - `messageScrollAlignment.test.ts` — the pure alignment math on numeric fixtures.
  - `messageCopyFromStore` — the pure `{ endpoints, array } → text` reconstruction.
  - The adapter — offset / `ensureMessageMounted` / window logic against a fake virtualizer (and a `vi.mock('@tanstack/react-virtual')` "render-all" mock for the render, as done for the occupant panel).
  - Existing `useMessageListScroll` / `MessageList.scroll` tests adapted to drive the interface.
- **Demo node-count (platform-independent proxy, perf-stress-ui guard):** `measureSwitch(big room)` asserts mounted `.message-row` ≤ ~60 (vs 1000) — the same measurement that proved the occupant panel (32 / 501). Regression guard recorded in `RENDER_PERF_TESTS.md`.
- **Two-platform manual:** macOS — the six behaviors correct (no jump/blank/selection loss); Linux — the 3 s freeze is gone (the confirmatory measurement the plan calls for).

## Units (isolation)

- `MessageVirtualizer` (interface) + `tanstackMessageVirtualizer.ts` (impl) — what to render, where each row sits, offsets for any id.
- `messageScrollAlignment.ts` (pure) — scroll-position math.
- `messageCopyFromStore.ts` (pure) — cross-window copy reconstruction.
- `useMessageListScroll.ts` (refactored) — consumes the interface instead of touching the DOM directly.
- The windowed render in the message list (flatten + window + spacer).

## Open risks

- **Prepend-anchoring vs `@tanstack`'s index-keyed measurement cache** — the single biggest risk; the spike's decision gate exists precisely for this. `getItemKey` should keep measurements bound to messages, but this must be proven, not assumed.
- **Alignment micro-jumps from estimate/measure divergence** — mitigated by measured-offset anchoring + 2-step correction + overscan; the spike measures pixel accuracy explicitly.
- **Imperative `scrollTop` writes coexisting with the library's scroll observation** — verified in the spike (stick-to-bottom case).
- **Date-group/separator flattening edge cases** (empty groups, marker position) — covered by adapting the existing grouping tests.

## Spike results — 2026-06-23 (macOS, headless preview)

Ran the throwaway harness (`/spike.html`, 1000 varied-height rows) against the committed `@tanstack` adapter + alignment + interface, viewport 1200×900.

**Validated (positive):**
- **Windowing:** 1000 messages → **24 mounted rows** (`≤ ~60` ✓); `getTotalSize` tracks measured rows.
- **Scroll tracking:** on a scroll event, `@tanstack`'s window moves to the correct index range (e.g. scroll to msg-200 → window 180–216, msg-200 mounted) and `getOffsetForIndex` stays consistent with each row's `translateY`.
- **Prepend-anchor convergence:** the immediate (estimated) restore drifted +318px because `@tanstack` re-measures the newly-mounted rows after the prepend; applying the designed **post-measure correction** (re-read offset → re-set scrollTop) brought the anchor to its saved offset with **delta 0 in one step**. The 2-step correction in the design is therefore load-bearing and converges.

**Could not be validated headlessly (preview-fidelity limits, not findings against the design):**
- The headless preview **throttles `requestAnimationFrame`**, so the 2-step correction's rAF (and `ensureMessageMounted`'s rAF) do not auto-fire — the immediate-only restore drifts until corrected. Worked around by dispatching corrections synchronously from evals.
- Programmatic `scrollTop` does **not auto-fire `scroll`** in the headless preview (real WKWebView/WebKitGTK do); worked around with an explicit `dispatchEvent`.
- Therefore: real-rAF pixel-accuracy, **smoothness** (no visible mid-correction flash), jump-to-unmounted exact alignment, and steady-state stick-to-bottom (needs the content-`ResizeObserver` re-stick loop, which the simplified harness omits) **must be confirmed on real engines**.

**Gate status:** windowing + the core mechanism (scroll tracking, offset consistency, anchor convergence) are **positive**, with **no red flag** for `@tanstack`. The decision to keep `@tanstack` (vs. the custom fallback) is **pending the real macOS (`tauri:dev`) and Linux/WebKitGTK runs** of `/spike.html`, which is kept on the branch for that purpose. Current lean: **proceed with `@tanstack` into Phase 2.1 behind the flag**, and confirm smoothness on real engines during integration. The harness is removed once that confirmation lands.
