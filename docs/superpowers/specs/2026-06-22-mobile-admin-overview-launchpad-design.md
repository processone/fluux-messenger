# Mobile admin — overview launchpad + header menu sheet

Date: 2026-06-22
Status: Approved design, pending implementation plan

## Problem

The admin console uses a two-tier layout: a sidebar of section categories
(`AdminDashboard`: Statistics / Users / Rooms / Announcements / Other) plus a
main content area (`AdminView`). Commit `c91c251d` made desktop land on the
`ServerOverview` dashboard as the admin home, but gated that auto-default to
`!isSmallScreen()`. So on mobile, admins still land on the *category menu* —
they must tap "Statistics" to reach the same overview desktop shows by default.

That asymmetry (content on desktop, a menu on mobile) is the thing to fix. The
mobile admin surface is intended for **full admin parity** — admins do real work
on a phone (manage users, destroy rooms, run commands) — so navigation between
sections must stay fast, not buried.

## Approach

Make the overview the mobile home too, and turn it into a **launchpad**: the
vital-signs stat cards become the primary navigation. A header menu button opens
a bottom sheet with the full section list as the secondary/rarely-used path
(command buckets, jumping around).

This was chosen over a bottom tab bar (the app has no bottom bar anywhere —
introducing one only inside admin creates a second navigation language) and over
a persistent top section strip (more layout surgery; the launchpad covers the
common destinations without it).

## Behavior

1. **Mobile lands on `ServerOverview`**, matching desktop. The auto-default
   `useLayoutEffect` in `ChatLayout.tsx` (currently lines ~737-741) drops its
   `isSmallScreen()` early-return so phones get content, not the category menu.

2. **Stat cards are navigation** (universal — desktop *and* mobile):
   - *Registered users* card → `users` management
   - *Rooms* (`onlineRooms`) card → `rooms` management
   - *Uptime*, *Version*, *Online users*, *Vhosts* → read-only.
     (Online users is deliberately not routed to Users — two cards → one
     destination is confusing.)
   Tappable cards get a chevron affordance, `role="button"`, `tabIndex={0}`, an
   Enter/Space keyboard handler, `cursor-pointer`, hover state, and `.tap-target`
   sizing. Read-only cards render exactly as today.

3. **Header menu button (☰) opens a bottom sheet** listing all sections
   (Statistics, Users, Rooms, Announcements, Other). Picking a section sets the
   active category and closes the sheet. The button is **mobile-only**
   (`md:hidden`), mirroring the existing back-button; on desktop the persistent
   sidebar already serves this role, so no menu button there.

4. **Back navigation** reflects the new stack `overview → list → detail/session`:
   - back from a detail/session → up one level (unchanged)
   - back from a `users`/`rooms` **list** → the **overview** (not exit)
   - back from the **overview** (or no category) → **exit admin**

## Components & changes

### `adminOverview.ts` — config-driven targets
Add an optional field to `OverviewCardDef`:
```ts
target?: AdminCategory   // 'users' | 'rooms'
```
Set `target: 'users'` on the `registeredUsers` card and `target: 'rooms'` on the
`onlineRooms` card. Everything stays config-driven — making another card tappable
later is a one-line change.

### `ServerOverview.tsx` — render tappable cards
For cards with a `target`, render an interactive element (button semantics) that
calls `setActiveCategory(card.target)`; otherwise render the current static
`<div>`. `setActiveCategory` is read directly from `useAdminStore` (it is a
store — no prop drilling). A trailing chevron icon signals interactivity.

### `adminBackTarget.ts` — new `'overview'` target
Extend `AdminBackTarget` to include `'overview'` and pass `activeCategory` into
`getAdminBackTarget`:
```ts
export type AdminBackTarget = 'session' | 'user' | 'room' | 'overview' | 'exit'
```
Logic: session/user/room take priority as today; then if `activeCategory` is
`users`/`rooms`, return `'overview'`; otherwise `'exit'`. `AdminView`'s
`handleHeaderBack` adds an `'overview'` case → `setActiveCategory('stats')`.

### `AdminSectionNav` — extracted shared section list (new)
Extract the category-button list currently inside `AdminDashboard` into a small,
self-contained `AdminSectionNav` component (props: active category + an
`onSelect(category)` callback). The desktop sidebar (`AdminDashboard`) and the
mobile sheet both render it, so the section list lives in one place.

### `AdminView.tsx` — mobile header menu button + sheet
- Add a `☰` button to the header, `md:hidden`, opposite the existing back arrow.
- Local `useState` for sheet open/close.
- Render `BottomSheet` (reused from `ui/BottomSheet.tsx` — portal, `max-h-[90dvh]`,
  grab handle, Escape/backdrop close, safe-area) containing `AdminSectionNav`.
  Selecting a section calls `setActiveCategory` and closes the sheet.

### `ChatLayout.tsx` — extend default to mobile
Remove the `isSmallScreen()` early-return from the stats auto-default effect so
the overview is the admin home on every viewport.

## What is NOT changing

- No bottom tab bar (rejected — no app-wide bottom-bar paradigm exists).
- No persistent top section strip.
- Desktop sidebar layout is unchanged except for the extracted `AdminSectionNav`.
- Read-only stat cards keep their exact current appearance.

## Testing

- `adminBackTarget.test.ts`: add cases — list category → `'overview'`; stats/null
  → `'exit'`; existing session/user/room precedence still holds.
- `AdminSectionNav`: render test (all categories present, `onSelect` fires with
  the right category).
- `ServerOverview`: assert the *registered users* and *rooms* cards are buttons
  that call `setActiveCategory('users')` / `('rooms')`; assert read-only cards are
  not interactive.
- `AdminView`: the menu button is `md:hidden` and toggles the sheet; selecting a
  section in the sheet sets the category and closes the sheet.

## Open items

None blocking. Card→target mapping is config-driven, so the read-only-vs-tappable
set can be revisited without structural change.
