# Floating date header (scroll-triggered date pill)

Date: 2026-06-29
Status: Approved — ready for implementation plan

## Problem

When the user scrolls up through a conversation, the inline `DateSeparator` for
the day they are reading often sits above the viewport, off-screen. There is then
no on-screen cue for which day the visible messages belong to. The user loses
their temporal bearing while scrolling through history.

## Goal

While scrolling, show a small floating "date pill" centered at the top of the
message area that displays the date of the topmost *visible* message — but only
when the topmost visible element is a message, not a date separator (a separator
already shows its own date). The pill fades out shortly after scrolling stops.

This mirrors the convention in Telegram / WhatsApp.

## Scope

- **In scope:** the live, virtualized conversation view (`MessageList` virtualized
  path), for both direct messages and MUC rooms (both use `MessageList`).
- **Out of scope:**
  - The non-virtualized legacy render path (flag-off) and `staticMode` previews
    (search-context / activity-context views manage their own scroll). The pill is
    not rendered there.
  - Interactivity. The pill is informational only — no click-to-jump / date picker.
    That is a separate, larger feature.

## Behavior

1. **What it shows.** The date of the topmost message currently visible in the
   viewport, formatted with the existing `formatDateHeader(date, t, lang)` — so it
   reads `Today` / `Yesterday` / locale-formatted date, with RTL handled, exactly
   like `DateSeparator`.
2. **Suppression (the core rule).** When the topmost visible row *is* a date
   separator, the pill is hidden — the inline separator already shows the date, so
   no duplicate. Also hidden when there is no date above the topmost row (e.g. the
   load-earlier header is at the top).
3. **Visibility model (scroll-then-fade).** On scroll the pill becomes visible and
   its date updates; ~1.2s after scrolling stops it fades out. Hidden at rest.
4. **Styling.** A centered, rounded-full pill: solid `var(--surface-2)`-equivalent
   background (use the project's float token, e.g. `bg-fluux-float`), a hairline
   border, a soft shadow, muted text at font-weight 500, small text size. It lives
   in the same absolute overlay layer as the existing scroll-to-bottom FAB and
   coexists with it. `pointer-events-none` so it never intercepts clicks. Opacity
   transition for the fade.

## Approach

Chosen approach: **derive the top date from the virtualizer on scroll.**

Rejected alternatives:
- *IntersectionObserver on date-separator rows* — the virtualizer unmounts
  off-screen rows, so the relevant separator is usually not in the DOM when it is
  above the viewport. Unreliable.
- *CSS `position: sticky` separators* — incompatible with the virtualized layout
  (rows are `position: absolute`) and cannot do the scroll-triggered fade.

## Architecture

### Render isolation (key constraint)

This repo has a documented history of render-perf regressions from scroll-driven
state. The pill must **not** cause `MessageList` to re-render on scroll.

Mechanism:
- `MessageList` provides a stable `getTopVisibleDate()` callback (passed via a ref
  so its identity is stable) that closes over the active virtualizer and the flat
  `virtualItems` array.
- A new `FloatingDateHeader` component owns its **own** passive scroll listener on
  the scroll container and its **own** local `{ date, visible }` state. All
  scroll-driven re-renders are confined to the `FloatingDateHeader` subtree.
  `MessageList` itself does not re-render on scroll.

### Components / units

1. **`getTopVisibleDate(virtualItems, scrollTop)` — pure function.**
   - Input: the flat `RenderItem[]` window data the virtualizer exposes
     (`getVirtualItems()` gives `{ index, start, size }`), the full flat
     `virtualItems` array (to resolve `kind`/`date`), and the current `scrollTop`.
   - Find the first row whose bottom edge is at or below the viewport top
     (`start + size > scrollTop`, matching the existing topmost-item logic in
     `useMessageListScroll`).
   - If that topmost row is `kind: 'date'` → return `null` (suppression).
   - Otherwise walk **backward** through the flat `virtualItems` from that index to
     the nearest preceding `kind: 'date'` item and return its `date` string.
   - If none found above (header at top) → return `null`.
   - Pure and fully unit-testable with synthetic item arrays; no DOM needed.

2. **`FloatingDateHeader` — presentational + scroll subscription.**
   - Props: `scrollerRef` (the scroll container), `getTopVisibleDate` (via ref).
   - Attaches a passive `scroll` listener to the scroller. On scroll: compute the
     date, `setState({ date, visible: true })`, and (re)arm a fade timeout (~1.2s)
     that sets `visible: false`. A `null` date forces `visible: false`.
   - Renders the centered pill with `formatDateHeader`; `pointer-events-none`;
     opacity transition for fade.
   - Reads `scrollTop` from the scroller and the virtual window from
     `getTopVisibleDate` (which internally calls the virtualizer). Throttle the
     per-scroll compute with `requestAnimationFrame` coalescing to one update per
     frame.

3. **Wiring in `MessageList`.**
   - Build `getTopVisibleDate` from `activeVirtualizer` + `virtualItems`, stored in
     a ref for stable identity.
   - Render `<FloatingDateHeader>` only on the virtualized path (alongside the
     existing FAB overlay), never in `staticMode` or the legacy path.

## Data flow

```
user scrolls
  → scroll container 'scroll' event (passive)
    → FloatingDateHeader rAF-coalesced handler
      → getTopVisibleDate(virtualItems, scroller.scrollTop)
        → topmost visible row → (date item? null : nearest preceding date)
      → setState({ date, visible: true }) + arm fade timer
  scroll stops
    → fade timer fires → setState({ visible: false })
```

`MessageList` is not involved in any of these updates after the initial render.

## Error / edge handling

- **Topmost row is a date separator** → `null` → hidden (suppression rule).
- **No date above topmost row** (load-earlier header at top, empty list) → `null` →
  hidden.
- **Virtualizer absent** (legacy/staticMode) → `FloatingDateHeader` not rendered.
- **Conversation switch** → `MessageList` remounts (existing behavior), so the pill
  remounts with fresh state; no stale date carries over.
- **MAM prepend / index shift** → the compute reads live virtual items each scroll,
  so the date stays correct after prepends; nothing cached across prepends.

## Testing

- **Unit (pure):** `getTopVisibleDate` with synthetic item arrays + scrollTop —
  covers: topmost is a message (returns its day's date), topmost is a date
  separator (returns `null`), header at top (returns `null`), multi-day boundaries.
- **Component (fake timers, jsdom):** `FloatingDateHeader` — scroll → visible +
  correct text; after the fade timeout → hidden; `null` date → stays hidden. Uses a
  stubbed `getTopVisibleDate`. (Real virtualizer geometry is not exercisable in
  jsdom, so the pure function carries the geometry-logic coverage.)
- **Manual / demo:** scroll a long multi-day conversation in demo mode; confirm the
  pill appears on scroll with the right day, suppresses when an inline separator is
  topmost, and fades after scrolling stops.

## Files (anticipated)

- New: `apps/fluux/src/components/conversation/getTopVisibleDate.ts` (pure)
- New: `apps/fluux/src/components/conversation/getTopVisibleDate.test.ts`
- New: `apps/fluux/src/components/conversation/FloatingDateHeader.tsx`
- New: `apps/fluux/src/components/conversation/FloatingDateHeader.test.tsx`
- Edit: `apps/fluux/src/components/conversation/MessageList.tsx` (wire + render the
  overlay on the virtualized path)

No SDK changes. No i18n key additions (reuses `formatDateHeader`).
