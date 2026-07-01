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

Three tones, low → high urgency, reused on tabs and per-row:

- **`neutral` — grey dot** — `bg-fluux-gray` (`--fluux-color-gray`): ambient
  "new messages" in rooms.
- **`accent` — blue dot** — `bg-fluux-brand` (`--fluux-bg-accent`): priority in
  rooms — an @-mention, or unread in a room set to *notify all*.
- **`strong` — red dot** — `bg-fluux-badge-strong` (**new themable token**, see
  below): direct messages, the most important.

Within the rooms tab, **accent wins over neutral** when both apply. The DM tab is
always `strong`.

### New token

Introduce a dedicated, themeable notification colour instead of hardcoding red:

- `apps/fluux/src/index.css`: `--fluux-badge-strong: var(--fluux-status-error);`
  (defaults to today's red; light/dark/custom themes can override it
  independently of the error red).
- `apps/fluux/tailwind.config.js`: expose `'badge-strong': 'var(--fluux-badge-strong)'`
  so `bg-fluux-badge-strong` is available.

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

Keep the red dot (DMs outrank room mentions), but drive it from the new
`strong` tone / `bg-fluux-badge-strong` token instead of hardcoded
`bg-fluux-red`. Trigger logic is unchanged: dot when `totalUnread > 0`.

### Per-row (rooms list), for palette consistency

- **`@N` mention badge**: red → **blue** (`bg-fluux-brand`) — room mentions are
  `accent`, not `strong`.
- **Unread dot**: currently blue brand → **grey** (`bg-fluux-gray`), so a room
  row reads the same grey-ambient / blue-priority story as the tab. (Without
  this, the unread dot and the mention badge would both be blue, distinguishable
  only by shape.)

### Per-row (DM list)

DM per-row count badge currently uses `bg-fluux-badge` (blue accent).
**Recommended:** switch it to `bg-fluux-badge-strong` so DMs read red end-to-end
(tab dot + row count). Flag if per-row DM counts should stay blue.

## Components touched

- **`apps/fluux/src/index.css`** — add `--fluux-badge-strong: var(--fluux-status-error);`
  (and any per-theme override blocks that already redefine status/badge colours).
- **`apps/fluux/tailwind.config.js`** — expose `'badge-strong': 'var(--fluux-badge-strong)'`.
- **`packages/fluux-sdk/src/stores/roomStore.ts`** — add one derived selector
  `roomTabIndicator(): 'none' | 'neutral' | 'accent'` (rooms only ever use grey or
  blue — never `strong`). Returns a primitive, so selector subscriptions don't
  churn. Reuses the existing per-room walk pattern (`roomEntities` + `roomMeta`),
  honouring `entity.joined`, `meta.muted`, `meta.mentionsCount`,
  `meta.unreadCount`, `meta.notifyAll`, `meta.notifyAllPersistent`.
- **`apps/fluux/src/components/sidebar-components/IconRailNavLink.tsx`** — add a
  `tone?: 'neutral' | 'accent' | 'strong'` prop (default `'strong'`, preserving
  today's red default). The dot colour stops being hardcoded `bg-fluux-red`:
  `neutral → bg-fluux-gray`, `accent → bg-fluux-brand`,
  `strong → bg-fluux-badge-strong`. Numeric-badge path is untouched (this design
  keeps tabs as plain dots).
- **`apps/fluux/src/components/Sidebar.tsx`** — feed `roomTabIndicator()` into
  the rooms tab (`showBadge` when not `'none'`, `tone` from the value); set the
  DM tab `tone='strong'`. Removes the ad-hoc
  `totalMentionsCount > 0 || totalNotifiableUnreadCount > 0` expression at the
  tab in favour of the selector.
- **`apps/fluux/src/components/sidebar-components/RoomsList.tsx`** — recolour the
  per-row mention badge (red → `bg-fluux-brand`) and unread dot
  (`bg-fluux-brand` → `bg-fluux-gray`).
- **`apps/fluux/src/components/sidebar-components/ConversationList.tsx`**
  (recommended) — switch the per-row DM count badge `bg-fluux-badge` →
  `bg-fluux-badge-strong` so DMs read red end-to-end.

## Testing

- **SDK (vitest):** unit-test `roomTabIndicator()` across the matrix — muted vs
  non-muted; mention vs plain unread vs notifyAll-unread vs nothing; joined vs
  not-joined. Assert accent-wins-over-grey and muted-is-silent.
- **App:** assert `IconRailNavLink` renders the correct dot class per `tone`
  (`neutral`/`accent`/`strong`), and that `Sidebar` maps the rooms indicator
  (`'accent' | 'neutral' | 'none'`) and the `strong` DM tab to the right state.

## Out of scope

- Numeric counts on the tabs (design keeps plain dots).
- Changing when the DM tab lights up (unchanged).
- Any change to notification sounds / native notifications / mute semantics
  beyond reading the existing `muted` flag.
