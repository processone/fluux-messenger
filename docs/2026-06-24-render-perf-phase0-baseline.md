# Render-perf Phase 0 baseline (sidebar / list churn)

Baseline measurement for the non-virtualization render-perf plan (the "Codex plan").
Captured 2026-06-24 in demo mode. This is the reference the Phase 1-4 fixes regress against:
after each fix, re-run `await __perf.baseline()` and confirm the targeted number drops.

## What was instrumented (Phase 0 prep)

1. `apps/fluux/src/utils/renderLoopDetector.ts` - a cumulative, never-resetting render
   tally (`getRenderTally()` / `resetRenderTally()`), incremented at the top of
   `detectRenderLoop()` before the cooldown early-return. `getRenderStats()` uses a
   self-resetting 1s window and cannot measure a flood spanning >1s; the tally can.
2. `apps/fluux/src/components/MemberList.tsx` - added `detectRenderLoop('MemberList')`
   before its `useRoster()` call and `return null`, so its renders-while-invisible are
   counted. It was the only one of Codex's 7 targets not already instrumented
   (`ChatView` and `ContactList` already call `detectRenderLoop`).
3. `apps/fluux/src/demo/perfHarness.ts` - five scenario drivers on `window.__perf`
   plus `tally()` / `baseline()`. react-scan is now OPT-IN via `?perf=scan` (it can
   saturate the renderer with Compiler + StrictMode); the default `?perf=1` path uses
   the cheap detector tally.

## How to run

```bash
# In a worktree, link node_modules first (the dev server needs it):
ln -s <main-checkout>/node_modules <worktree>/node_modules   # remove when done

npm run dev    # serves :5173
# open http://localhost:5173/demo.html?perf=1&tutorial=false
```

In the browser console:

```js
await __perf.baseline()            // runs all 5 scenarios under the CURRENT tab
await __perf.scenario('presenceFlap')   // one scenario; opts e.g. { times: 30, stepMs: 16 }
__perf.tally()                     // cumulative render counts since last reset
```

Scenarios (all read live store state and target a NON-active entity where relevant):
`rosterStorm` | `presenceFlap` | `chatMessageInactive` | `roomMessageInactive` | `toggleModal`.

### Two gotchas that shape the method

- **StrictMode doubles dev renders.** Divide raw tallies by 2 for logical counts.
  All numbers in the table below are LOGICAL (already halved).
- **Events must be spaced (`stepMs`, default 16ms = ~1 frame).** A synchronous burst
  is coalesced by React 18 into a single render, which hides the per-event cost.
  Codex's criteria are per-event ("a presence change must not re-render the whole
  list"), so the drivers space events by default. `stepMs:0` measures the coalesced case.
- **Sidebar tabs mount one list at a time.** `ConversationList` mounts on `#/messages`,
  `ContactList` on `#/contacts`, `RoomsList` on `#/rooms`. Run a scenario under the tab
  whose list you want to measure. `MemberList` and `Sidebar` are always mounted.

## Baseline (logical renders; demo mode, 2026-06-24)

| Scenario (per-event) | Tab | ChatLayout | Sidebar | ConversationList | ContactList | MemberList |
|---|---|---:|---:|---:|---:|---:|
| presenceFlap (1 contact x30) | #/messages | 0 | 0 | **30** | n/m | **30** |
| presenceFlap (1 contact x30) | #/contacts | 0 | 1 | n/m | **31** | **30** |
| rosterStorm (100 presences)  | #/messages | 0 | 0 | **100** | n/m | **100** |
| chatMessageInactive (x20)    | #/messages | 0 | 20 | 20 | n/m | 0 |
| roomMessageInactive (x20)    | #/messages | 0 | 0 | 0 | n/m | 0 |
| toggleModal (3x open/close)  | #/messages | **6** | **6** | **6** | n/m | **6** |

`n/m` = component not mounted on that tab. `ChatView` / `RoomView` were 0 throughout
(no conversation/room was active; re-measure with one open to baseline those).

## What the numbers confirm (maps to the plan)

- **Phase 4 (ContactList) - biggest structural win.** One contact flapping presence,
  with no group reorder, re-renders the entire ContactList ~1:1 (31 for 30 flaps).
  The parent re-maps full `Contact` objects on every roster change.
- **Phase 3 (ConversationList).** Same coupling: 30/30 and 100/100 on presence churn,
  and 20/20 on messages into an inactive conversation. The parent is coupled to roster
  churn (it rebuilds a contact map) and to the full `useChat()` list. Note Sidebar stays
  at 0 during presence churn, so the churn is ConversationList's OWN subscription, not
  propagated from a parent - the fix is local (port the RoomsList id-only pattern).
- **Phase 1.3 (MemberList) - cheapest win.** It re-renders in EVERY scenario (30, 100,
  and 6 on modal toggles) while rendering `null` (no groupchat active). Gating its
  `useRoster()` subscription on an active groupchat zeroes all of this out.
- **Phase 1.2 (LayoutContext).** Opening/closing the command palette re-renders
  ChatLayout, Sidebar, ConversationList, and MemberList once each per transition - none
  of which have anything to do with the palette. The unmemoized context value is the
  blast radius. (ContactList would also show 6 here; it was on the wrong tab.)
- **Phase 2 (Sidebar badges) - low value, as suspected.** Sidebar is 0 on presence
  churn and only re-renders when an unread count actually changes (the 20 on
  chatMessageInactive is legitimate, and Sidebar is a shallow icon rail). The badges
  are already isolated via primitive selectors; extracting badge components buys little.

## Acceptance targets for the fixes

Re-run the same scenario after each fix; the target number should collapse:

- ContactList: presenceFlap@contacts 31 -> ~1 (only the flapped row, if its dot changed).
- ConversationList: presenceFlap@messages 30 -> ~0-1; rosterStorm 100 -> ~0-1.
- MemberList: every scenario -> 0 while no groupchat is active.
- Modal toggle: ChatLayout still re-renders (it owns the modal), but Sidebar /
  ConversationList / ContactList / MemberList -> 0.
- ConversationList on inactive message (20) -> only the affected row re-renders.

Per-fix unit guards go in each phase (see `packages/fluux-sdk/src/stores/RENDER_PERF_TESTS.md`).
