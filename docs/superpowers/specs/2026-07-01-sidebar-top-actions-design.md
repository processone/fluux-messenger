# Unified sidebar header top-actions

**Date:** 2026-07-01
**Status:** Approved (design) — pending implementation plan

## Problem

The sidebar main-panel header (`apps/fluux/src/components/Sidebar.tsx`, the
`h-14` bar) renders a per-view cluster of top-right action controls. Today each
tab invents its own grammar:

| Tab | Trigger | Icon | Behavior |
|-----|---------|------|----------|
| Messages | two bare icons | `Archive`, `Plus` | Archive toggles the archived view; `Plus` opens the New Message modal |
| Rooms | one dropdown | `Plus` + `ChevronDown` | menu: Quick Chat, Permanent Room, Join Room, Browse Rooms, Catch Up All |
| Contacts | one dropdown | `Users` + `ChevronDown` | menu: Add Contact, Blocked Users |

Three problems:

1. **No consistent icon grammar.** The trigger is `Plus` on Messages, `Plus▾`
   on Rooms, and the *entity* icon `Users▾` on Contacts (redundant with the
   "Contacts" title right next to it). A user cannot predict from the icon
   whether it fires an action or opens a menu.
2. **"Create" menus mix in non-create actions.** The Rooms `+` menu includes
   *Catch Up All* (a sync/maintenance action); the Contacts `+` menu includes
   *Blocked Users* (which navigates to Settings). A `+` trigger implies "add
   something," so bundling management actions under it is semantically wrong.
3. **Three hand-rolled dropdowns.** Each menu is inlined in `Sidebar.tsx`
   (~120 lines total) with its own open-state, `useClickOutside` ref, and
   popover markup — despite the app already having a reusable `OverflowMenu`
   component (`apps/fluux/src/components/OverflowMenu.tsx`) that handles kebab
   trigger, click-outside, Escape, `role="menu"` semantics, and checkable
   items.

## Goal

One icon grammar and one set of shared components across all sidebar tabs, so
each header toolbar is predictable, and the per-tab JSX in `Sidebar.tsx` shrinks
to a small extracted component per tab.

Scope is **the header toolbar only** — no changes to panel bodies, the rail icon
column, or the in-panel search on Contacts/Search.

## Design

### Three roles, one grammar

Every header action falls into exactly one role, and each role has a fixed icon
and a fixed slot. Slots are ordered left-to-right after the title:
**filter → create → overflow**, so the same role always lands in the same place.

| Role | Control | Icon | Behavior |
|------|---------|------|----------|
| **Filter / view toggle** | standalone button | the filter's own icon (e.g. `Archive`) | toggles a view mode; shows active state (brand color) |
| **Create / add** | standalone button | `Plus` (with `ChevronDown` only when the tab has several create paths) | direct action, or a split button whose `▾` opens a create-menu |
| **Manage / secondary** | `OverflowMenu` | `MoreVertical` (`⋮`) | opens the shared kebab menu |

A filter/view toggle deliberately stays a **visible standalone control**, not an
overflow item — it reflects persistent view state and benefits from an
always-visible active indicator.

### Per-tab result

```
Messages:  [Archive toggle]  [Plus → New message]
Rooms:     [Plus/▾ split]  [⋮]
             Plus → New quick chat (direct)
             ▾    → Quick Chat · Permanent Room · Join Room · Browse Rooms
             ⋮    → Catch up all
Contacts:  [Plus → Add contact]  [⋮]
             ⋮    → Blocked users
```

- **Messages** — already filter + create; only reconciled to the shared grammar
  (icon, order, tooltips). No `⋮` needed today (no secondary actions).
- **Rooms** — the create control becomes a **split button**: clicking `Plus`
  creates a Quick Chat directly (the fastest, most casual path); the `▾` opens a
  create-menu listing all four create/join paths (Quick Chat included, for
  discoverability that `Plus` is the shortcut to it). *Catch Up All* moves out of
  the create menu into a separate `⋮` overflow, because it is maintenance, not
  creation.
- **Contacts** — the trigger icon changes from `Users▾` to `Plus` for *Add
  contact* as a direct button. *Blocked Users* moves into a `⋮` overflow.

### Components

The header currently inlines all three tabs' menus in `Sidebar.tsx`. Extract one
small, focused component per tab so each toolbar is understandable and testable
in isolation, and `Sidebar.tsx` no longer carries the dropdown markup:

- **`MessagesHeaderActions`** — archive toggle (existing behavior: `showArchived`
  state lifted in via props/callbacks) + new-message button. Mostly a move of the
  existing JSX.
- **`RoomsHeaderActions`** — a `RoomsCreateSplitButton` + an `OverflowMenu` for
  *Catch up all* (with its `disabled`/spinner state while catching up, which
  `OverflowMenu` already supports via `disabled`).
- **`ContactsHeaderActions`** — an add-contact `Plus` button + an `OverflowMenu`
  for *Blocked users*.

These live under `apps/fluux/src/components/sidebar-components/` alongside the
other extracted sidebar pieces.

### Shared-component reuse

- All `⋮` overflows use the existing **`OverflowMenu`** (`MoreVertical` trigger,
  click-outside + Escape, `role="menu"`, `active` checkable items, `danger`,
  `disabled`). This removes the three hand-rolled dropdowns from `Sidebar.tsx`.
- The one bespoke piece is **`RoomsCreateSplitButton`**: a `Plus` button
  (`onClick` → Quick Chat) adjacent to a `▾` button (`onClick` → toggles a menu),
  built on the existing **`useClickOutside`** hook and the shared `fluux-popover`
  styling so it visually matches `OverflowMenu`. It is the only place needing a
  non-kebab menu trigger, so a dedicated small component is preferred over
  generalizing `OverflowMenu` (YAGNI — a single consumer).

### Tooltips / i18n

Reuse existing keys where possible to minimize 33-locale churn:

- `Plus` tooltip: Messages → `newMessage.title` (existing); Contacts →
  `sidebar.addContact` (existing); Rooms → `rooms.createQuickChat`
  (existing = "Create Quick Chat"). No new key required.
- `▾` create-menu trigger and `⋮` overflow triggers: `common.options` (existing,
  already used by the Contacts trigger today).
- Any new key is translated into all 33 locales in the same change (no English
  placeholders), and scanned for em-dash connectors before commit.

## Behavior parity / edge cases

- **Archive toggle** keeps its current semantics: toggling flips `showArchived`,
  the header title switches to `messages.archivedTitle`, and the toggle shows the
  active (brand) color. Leaving the Messages view resets `showArchived` (existing
  effect).
- **Catch up all** keeps its guard: while `isCatchingUpRooms`, the item is
  disabled and its icon spins (`OverflowMenu` `disabled` + a spinning icon).
- **Blocked users** continues to navigate to the Settings "blocked" category.
- **Keyboard/focus**: `OverflowMenu` already provides `role="menu"` semantics,
  Escape-to-close, and click-outside. The split button's `▾` menu mirrors that
  via `useClickOutside` + Escape.

## Testing

- Component tests (happy-dom, jsdom for any color/DOM-snapshot assertions per the
  test-env rules) for each extracted header component:
  - `MessagesHeaderActions`: archive toggle fires the callback and reflects
    active state; new-message button opens the modal.
  - `RoomsHeaderActions`: `Plus` fires Quick Chat; `▾` opens the four-item
    create-menu; `⋮` opens Catch-up and is disabled while catching up.
  - `ContactsHeaderActions`: `Plus` fires Add Contact; `⋮` opens Blocked Users →
    navigates to Settings.
- Reuse `OverflowMenu`'s existing tests for the shared menu behavior (no need to
  re-test click-outside/Escape per consumer).
- Any newly asserted i18n label keys are added to the `test-setup.ts` i18n
  subset.

## Out of scope

- Panel bodies, the rail icon column, in-panel search (Contacts/Search).
- Rehoming *Catch up all* / *Blocked users* to entirely different surfaces — they
  stay reachable from their tab, just under `⋮` instead of `+`.
- Renaming i18n keys or variables (e.g. `emptyState.directory.*`) — unrelated.
