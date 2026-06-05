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
