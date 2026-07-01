# Calm two-tone badges on the nav tabs

**Date:** 2026-07-01
**Status:** Approved design, pending implementation plan

## Problem

The `#` rooms icon tab only shows an indicator when you are **mentioned**, or
when a room you explicitly set to *notify all* has unread messages. Ordinary
room unread is invisible at the tab level. The result: you switch to the Rooms
view and discover unread the tab never hinted at — which feels strange.

The DM tab already shows a "calm" dot for any unread. We want to port that idea
to the `#` tab, but with two tones so ambient activity reads differently from
things that are actually addressed to you.

## Palette

Two tones, reused on tabs and per-row:

- **Grey dot** — `bg-fluux-gray` (`--fluux-color-gray`): ambient "new messages".
- **Accent dot** — `bg-fluux-brand` (`--fluux-bg-accent`, blue): priority — an
  @-mention, or unread in a room set to *notify all*.

**Accent always wins** over grey when both conditions are present.

## Behaviour

### `#` rooms tab (core change)

A single derived indicator computed over **joined, non-muted** rooms:

1. `accent` — if any qualifying room has `mentionsCount > 0`, **or**
   (`notifyAll || notifyAllPersistent`) with `unreadCount > 0`.
2. else `neutral` (grey) — if any qualifying room has `unreadCount > 0`.
3. else nothing.

**Muted rooms are fully silent**: they contribute neither grey nor accent, even
when they contain an @-mention. This matches the "all joined rooms *minus muted*"
scope chosen during design. (Single, well-isolated rule — easy to change later if
we decide mentions should break through mute.)

### DM tab

Change its dot from red → **blue accent**. A 1:1 DM is inherently addressed to
you, so the DM tab is always accent-tone. Trigger logic is unchanged: dot when
`totalUnread > 0`.

### Per-row (rooms list), for palette consistency

- **`@N` mention badge**: red → **blue** (`bg-fluux-brand`).
- **Unread dot**: currently blue brand → **grey** (`bg-fluux-gray`), so a room
  row reads the same grey-ambient / blue-priority story as the tab. (Without
  this, the unread dot and the mention badge would both be blue, distinguishable
  only by shape.)

DM per-row count badge already uses `bg-fluux-badge` (accent) and needs no change.

## Components touched

- **`packages/fluux-sdk/src/stores/roomStore.ts`** — add one derived selector
  `roomTabIndicator(): 'none' | 'neutral' | 'accent'`. Returns a primitive, so
  selector subscriptions don't churn. Reuses the existing per-room walk pattern
  (`roomEntities` + `roomMeta`), honouring `entity.joined`, `meta.muted`,
  `meta.mentionsCount`, `meta.unreadCount`, `meta.notifyAll`,
  `meta.notifyAllPersistent`.
- **`apps/fluux/src/components/sidebar-components/IconRailNavLink.tsx`** — add a
  `tone?: 'accent' | 'neutral'` prop (default `'accent'`). The dot colour stops
  being hardcoded `bg-fluux-red`: `accent → bg-fluux-brand`,
  `neutral → bg-fluux-gray`. Numeric-badge path is untouched (this design keeps
  tabs as plain dots).
- **`apps/fluux/src/components/Sidebar.tsx`** — feed `roomTabIndicator()` into
  the rooms tab (`showBadge` when not `'none'`, `tone` from the value); set the
  DM tab `tone='accent'`. Removes the ad-hoc
  `totalMentionsCount > 0 || totalNotifiableUnreadCount > 0` expression at the
  tab in favour of the selector.
- **`apps/fluux/src/components/sidebar-components/RoomsList.tsx`** — recolour the
  per-row mention badge (red → `bg-fluux-brand`) and unread dot
  (`bg-fluux-brand` → `bg-fluux-gray`).

## Testing

- **SDK (vitest):** unit-test `roomTabIndicator()` across the matrix — muted vs
  non-muted; mention vs plain unread vs notifyAll-unread vs nothing; joined vs
  not-joined. Assert accent-wins-over-grey and muted-is-silent.
- **App:** assert `IconRailNavLink` renders the correct dot class per `tone`, and
  that `Sidebar` maps `'accent' | 'neutral' | 'none'` to the right tab state.

## Out of scope

- Numeric counts on the tabs (design keeps plain dots).
- Changing when the DM tab lights up (unchanged).
- Any change to notification sounds / native notifications / mute semantics
  beyond reading the existing `muted` flag.
