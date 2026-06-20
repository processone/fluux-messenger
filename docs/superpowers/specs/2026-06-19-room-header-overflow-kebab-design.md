# Room/Chat Header Overflow Kebab — Design

**Date:** 2026-06-19
**Status:** Approved design, ready for implementation plan

## Problem

The room (MUC) header (`RoomHeader.tsx`) packs the most actions of any header in the
app — notification dropdown, invite, room-management dropdown (owner/admin), search,
and the members toggle — yet it is the **only** primary header without an overflow
menu. On narrow screens (phone, tablet split-view) these buttons crowd the header.
Nothing collapses except the back button (`md:hidden`).

By contrast the 1:1 `ChatHeader.tsx` already has a kebab (`OverflowMenu`, holding
profile + archive) but keeps search as an always-visible button — which we also want
to collapse on narrow widths.

## Goals

- Collapse lower-priority header actions into an overflow ("kebab") menu when the
  header is too narrow to show them comfortably.
- Drive the collapse from **container width**, not a fixed viewport breakpoint, so it
  behaves correctly on desktop, tablet, split-view, and phone with one mechanism.
- Add **zero render cost** on resize — this header sits above a non-virtualized
  message list and the codebase is render-performance sensitive (RenderLoopDetector,
  prior render-storm fixes).
- Reuse the existing mobile bottom-sheet idiom (#578) for touch and the existing
  anchored dropdown for hover/pointer devices.
- Share one mechanism between `RoomHeader` and `ChatHeader` rather than building two.

## Non-Goals

- No change to which actions exist, only where they are surfaced.
- No pixel-perfect per-item measurement (explicitly rejected — see Alternatives).
- No redesign of the notification or room-management option sets themselves.

## Decisions (from brainstorming)

- **Adaptive, container-width based** collapse (not a fixed `md:`/`lg:` breakpoint).
- **Members toggle is the only always-pinned** primary action in the room header.
- **Search also collapses in the 1:1 header** (extends scope to `ChatHeader`).
- Touch kebab opens a **bottom sheet with sub-sheets**; nested dropdowns
  (notifications, room management) push to a second-level view.
- Implementation approach: **CSS container queries** (Approach A), not JS measurement.

## Architecture

### `HeaderActionBar` — one reusable overflow toolbar

Both headers consume a single new component that takes a priority-ordered list of
**action descriptors** (data) and renders an inline row plus a kebab.

```ts
type HeaderActionGroup = {
  title: string
  items: Array<{ key: string; label: string; icon: LucideIcon
                 active?: boolean; danger?: boolean; onSelect: () => void }>
}

type HeaderAction = {
  key: string
  label: string
  icon: LucideIcon
  priority: number              // higher = stays inline longer
  visible?: boolean             // owner/admin gating, etc. (default true)
  onSelect?: () => void         // simple action (search, invite)
  submenu?: HeaderActionGroup   // nested set (notifications, room management)
  // Optional escape hatch: a custom inline renderer when the existing inline
  // control is richer than a plain icon button (e.g. notification dropdown).
  renderInline?: (ctx) => ReactNode
}
```

### Zero-JS collapse ("priority navigation" trick)

Every action is rendered **twice** — once in the inline row, once inside the kebab —
and **CSS container queries** decide which copy is visible at the current container
width:

- The inline copy of an action that has overflowed is `display:none`.
- The kebab copy of an action still shown inline is `display:none`.

Exactly one copy is ever visible. No `ResizeObserver`, no `setState` on resize, no
React re-render. The two surfaces stay in lock-step the same way `MessageToolbar`
(hover) and `MessageActionSheet` (touch) do today in `MessageBubble`.

The kebab trigger itself is hidden by container query at the widest tier, so desktop
never shows an empty overflow button.

## Collapse tiers (room header)

Priority order, collapse-first → collapse-last:
**management → invite → notifications → search → members.**

| Container width | Inline (room)                                    | In kebab                          |
| --------------- | ------------------------------------------------ | --------------------------------- |
| Wide (desktop)  | members, search, invite, notifications, mgmt     | — (kebab hidden)                  |
| Medium (tablet) | members, search                                  | invite, notifications, mgmt       |
| Narrow (phone)  | members                                          | search, invite, notifications, mgmt |

`ChatHeader` uses the same mechanism with a shorter list: search collapses on narrow
widths; profile/archive remain kebab-only at all widths (as today).

## Kebab presentation — capability-gated, two surfaces

The kebab trigger opens one of two surfaces, both fed by the same descriptors:

- **Hover / fine pointer** (`useHasHover()` / `can-hover:`): anchored dropdown via the
  existing `useAnchoredMenu`, a flat list with section dividers for submenus.
- **Touch / coarse pointer**: `BottomSheet` (`components/ui/BottomSheet.tsx`).

`BottomSheet` is single-level, so the sub-sheet stack lives **in the kebab component**,
not in `BottomSheet`:

- Local state `sheetView: 'root' | <submenuKey>`.
- Root view lists simple actions plus a row per `submenu` action; tapping a submenu row
  sets `sheetView` to that key.
- The sheet `title` shows a back chevron when `sheetView !== 'root'` that returns to
  root. Closing the sheet resets to root.

No modification to `BottomSheet`.

## Header wiring

### `RoomHeader.tsx`

Build the descriptor list:

- **members** — pinned; remains its own inline button (highest priority, never in kebab).
- **search** — simple `onSelect`.
- **invite** — simple `onSelect` (UserPlus).
- **notifications** — `submenu` (mentions / all-session / all-always); the existing
  inline dropdown becomes its `renderInline`; its options feed the sub-sheet.
- **management** — `submenu`, `visible` gated on owner/admin; existing inline dropdown
  becomes its `renderInline`; options feed the sub-sheet.

### `ChatHeader.tsx`

- **search** — collapsible descriptor.
- **profile / archive** — kebab-only (as today); migrate off the standalone
  `OverflowMenu` onto `HeaderActionBar` so they gain the touch bottom-sheet surface.

## Tailwind / build changes

- Add `@tailwindcss/container-queries` plugin to `tailwind.config.js`.
- Mark the action row as a container (`@container`) and use `@`-prefixed container
  variants for the tier rules.
- Existing `can-hover:` / `touch:` variants are reused for the dropdown-vs-sheet choice.

## Testing

- **Unit:**
  - descriptor → surface mapping (an action with `submenu` renders a sub-sheet row +
    second view; a simple action renders a direct row).
  - `visible` gating: a non-owner produces no management descriptor (no inline button,
    no kebab row).
  - sub-sheet navigation state: root → submenu → back → root; close resets to root.
  - priority ordering of the descriptor list.
  - Assert container-query **class names** (per the codebase's class-assertion
    convention), not measured widths.
- **Manual (demo mode):** desktop / tablet / phone container widths; a touch-emulation
  pass exercising the bottom sheet and sub-sheets.

## Rollout caveats (carry into the plan)

- Adding the Tailwind container-queries plugin **requires a dev-server restart**
  (same class of gotcha as `addVariant`).
- Verify **both** paths: `can-hover:` anchored dropdown and `touch:` bottom sheet.
- Headless preview **freezes the sheet animation** — assert on class names and force
  frames via screenshot rather than relying on computed transition state.
- In a worktree, app typecheck resolves `@fluux/sdk` to the root dist; this change is
  app-only (no SDK type changes expected), so the SDK-dist sync gotcha should not apply
  — confirm during implementation.

## Alternatives considered

- **B. JS measured "priority+" overflow** (`ResizeObserver` measuring each button):
  pixel-perfect but runs JS + `setState` on every resize above a hot, non-virtualized
  message list — the exact render-churn pattern the codebase repeatedly fixes. Rejected.
- **C. Fixed `md:`/`lg:` Tailwind breakpoints:** viewport-based, not container-based,
  so tablet split-view and narrow desktop windows collapse incorrectly. Rejected.
