# Render-count regression guards

When fixing a render-perf issue, add a guard so it can't silently regress.

## Store/hook level (preferred — real store, no app mock)
Use the SDK render-stability helpers (`renderStability.helpers.tsx`): seed the
store, capture a baseline, dispatch a background update, assert the subscription
result is unchanged (`toEqual`) or the hook's render count did not increase.

Examples in this repo:
- `roomStore.sidebarJids.test.ts` — selector returns the same JIDs after a
  non-reordering message (so `useShallow` bails).
- `roomStore.perRoomStability.test.ts` — `getRoom(B)` keeps its ref after a
  message to room A (so a per-row subscription only fires for the changed row).
- `useListKeyboardNav.test.tsx` — `getItemProps` hover handlers stay
  identity-stable across renders AND reorders.

## Component level (stretch)
To assert a background message re-renders only its row, render the component
against the REAL store (override the global `@fluux/sdk` app mock in that test
file with `vi.unmock` / `importActual`) and count renders with a module-level
counter or React Profiler. Account for StrictMode double-rendering.

## Node-count guard — message-list virtualization (demo measurement, not a unit test)
The message list is windowed behind `enableMessageVirtualization`. Its win is a
**bounded mounted DOM**: switching into a large room must mount only the visible
window + overscan, not the whole backlog. jsdom has no layout, so the virtualizer
mounts nothing there and the structural tests (`MessageList.virtualized.test.tsx`)
use a render-all `@tanstack` mock — they CANNOT assert the bound. The bound is a
**demo-mode measurement** in a real layout engine (the same proxy that validated the
occupant panel, 32/501), because node count is platform-independent (the WebKitGTK
switch freeze is layout cost; node count is its proxy and is measurable on Blink too).

**Guard:** with the flag ON, switching into a 1000-message room mounts **≤ ~60
`.message-row`** (vs ~1000). Reproduce:

1. `npm run dev`, open
   `http://localhost:5173/demo.html?stress=rooms:1,messages:1000,occupants:97,activate:1,msgStep:0&tutorial=false`
2. Demo init clears `fluux:*` localStorage (`apps/fluux/src/demo.tsx`), so set the flag
   AFTER load then re-mount the list (navigate `#/` then back into the room — no reload):
   `localStorage.setItem('fluux:flags:enableMessageVirtualization','true')`
3. Measure: `__perf.domNodes('[data-message-list]')` (needs `&perf=1`), or directly
   `document.querySelectorAll('.message-row').length`.

**Measured (2026-06-24, Chromium/Blink via the preview harness):**

| state                    | `.message-row` | nodes in `[data-message-list]` |
|--------------------------|----------------|--------------------------------|
| flag OFF (baseline)      | 1000           | 47011                          |
| flag ON, window at top   | 14             | 688                            |
| flag ON, scrolled middle | 33             | 1585                           |

Both flag-ON states are far under the ≤60 target (~68× node reduction), and the
window tracks scroll (indices 0–15 → 530–562 after a mid-list scroll). The WebKitGTK
freeze going away (3 s → a few hundred ms) is the confirmatory **real-engine** check
that the two-platform pass (`docs/superpowers/plans/2026-06-23-message-view-virtualization.md`
Task 11) runs on Linux; node count is the engine-independent regression signal.
