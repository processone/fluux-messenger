# Command Palette: notify-all rooms in "Needs attention" + red pill

**Date:** 2026-07-13
**Area:** `apps/fluux/src/components/CommandPalette.tsx`
**Type:** App-layer behavior change, no SDK or i18n changes.

## Problem

The command palette's default (empty-query) view has a **"Needs attention"** group. Today it promotes:

- unread DMs (`unreadCount > 0`), and
- rooms with a **mention** (`mentionsCount > 0`).

A room the user has set to **notify for all messages** (`notifyAll` / `notifyAllPersistent`) that has unread messages but *no* mention is **not** promoted into the group, and its unread pill renders grey. This is inconsistent with the sidebar and icon-rail, which already treat that room as the red "attention" tier via `roomActivityTone` (`packages/fluux-sdk/src/stores/roomSelectors.ts`).

The palette should reuse the same source of truth so it matches the rest of the app: **red = needs your attention, grey = ambient unread.**

## Source of truth

`roomActivityTone(room)` (exported from `@fluux/sdk`, already used in `RoomsList.tsx`) returns:

- `'accent'` → a mention, **or** a notify-all room with unread (unless muted / not joined)
- `'neutral'` → other unread
- `'none'` → nothing to signal

## Design

A single predicate drives both group membership and pill color:

```
isAttentionItem(item):
  conversation → (unreadCount ?? 0) > 0        // any unread DM
  room         → activityTone === 'accent'     // mention OR notify-all-unread
```

### Changes (all in `CommandPalette.tsx`)

1. **`CommandItem` interface** — add an optional field:
   `activityTone?: RoomActivityTone` (imported type from `@fluux/sdk`). Populated for room rows only.

2. **Room item builder** (the `joinedRooms` loop, ~line 377) — compute
   `activityTone: roomActivityTone(room)` when building each room `CommandItem`.
   The `Room` objects from `useRoom().joinedRooms` already carry `joined`,
   `muted`, `unreadCount`, `mentionsCount`, `notifyAll`, `notifyAllPersistent`.
   (Bookmarked-not-joined rooms have no unread and need no tone.)

3. **Attention group membership** (`buildDefaultGroups`, ~line 184) — replace the
   two separate filters with `isAttentionItem`:
   - unread DMs: unchanged (`unreadCount > 0`)
   - rooms: `activityTone === 'accent'` (was `mentionsCount > 0`) — keeps mention
     rooms and now also includes notify-all-unread rooms.

4. **`roomTier`** (~line 160) — rank `activityTone === 'accent'` rooms at tier 0 so
   any overflow in the leftover Rooms group stays consistent with the new
   membership rule. Plain unread (`neutral`) stays tier 1, read stays tier 2.

5. **Pill color** (render, ~line 705) — color the pill red (`bg-fluux-brand`) when
   `isAttentionItem(item)`, grey (`bg-fluux-hover`) otherwise. The pill still shows
   the numeric `unreadCount` and still only renders in the default view.

### Resulting pill colors (default view)

| Item                                            | Pill  |
|-------------------------------------------------|-------|
| Unread DM                                       | red   |
| Room with a mention                             | red   |
| Notify-all room with unread                     | red   |
| Ordinary room, plain unread (no notify-all/mention) | grey  |
| No unread                                        | none  |

## Non-goals

- No change to search/filter-mode rendering (pills remain default-view only).
- No change to notification/badge counting logic in the SDK.
- No new i18n keys (the "Needs attention" label already exists).

## Testing

- Unit tests in `CommandPalette.test.tsx`:
  - A notify-all room with unread (no mention) appears in "Needs attention" and
    renders a red pill.
  - An ordinary unread room (not notify-all, no mention) stays out of the
    attention group and renders a grey pill.
  - An unread DM renders a red pill.
  - A mention room is unchanged (still red, still in attention).
- Ensure the app's `@fluux/sdk` test mock exposes `roomActivityTone` (it is already
  a real export used by `RoomsList`; confirm the `CommandPalette.test.tsx` mock
  path resolves it, mirroring `importOriginal` spread if needed).
- `npm run typecheck` and the app test workspace must pass clean (no stderr).
