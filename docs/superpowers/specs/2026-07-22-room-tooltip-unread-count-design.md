# Room row tooltip: show the unread count

## Problem

In the sidebar Rooms list, a room with unread activity shows only a dot. The
count is never rendered on the row — only mentions get a number, via the `@N`
badge. So "3 unread" and "300 unread" look identical.

The count is reachable today, but badly:

- It lives in a second `Tooltip` wrapped around the 10px activity dot
  (`RoomsList.tsx`), so you have to hover the dot itself, not the row.
- That tooltip is nested *inside* the row tooltip, so hovering the dot pops two
  bubbles at once.
- Its content is a hardcoded English template literal, `` `${room.unreadCount} unread` ``
  — untranslated in all 33 locales.
- It is gated on `mentionsCount === 0`, matching the dot's own visibility rule.
  When a room has mentions the dot is replaced by the `@N` badge, and the total
  unread becomes completely unreachable — which is exactly the case where the
  user most wants it.

## Solution

Fold the unread count into the room **row** tooltip as a headline line, and
delete the dot's own tooltip.

### Behaviour

| Room state | Tooltip |
|---|---|
| Joined, `unreadCount > 0` | **`37 unread messages`** <br> `12 users • MyNick` |
| Joined, `unreadCount === 0` | `12 users • MyNick` (single line — unchanged) |
| Joining | `Joining...` (unchanged) |
| Not joined | `Double-click to join` (unchanged) |

The headline appears whenever `room.joined && room.unreadCount > 0`, **including
when mentions exist**. Mentions get no line of their own: the `@N` badge on the
row already carries that number, so the tooltip adds only what the row cannot
show.

The detail line keeps its current composition exactly: `N users`, plus
` • <nickname>` when the room has a nickname. Its existing manual singular/plural
selection between the `rooms.user` and `rooms.users` keys is carried over
unchanged — migrating it to i18next plurals is not part of this change.

The activity dot keeps its two-tier colour (`roomActivityTone`) and loses its
`Tooltip` wrapper. The unread line is **not** tinted — the dot already carries
the attention signal on the row, and coloured tooltip text reads as an alert.

### Module boundary

New pure module `apps/fluux/src/utils/roomTooltip.ts`, alongside the existing
`roomTyping.ts` / `roomJoinError.ts` helpers:

```ts
export interface RoomTooltipParts {
  /** "37 unread messages", or null when there is nothing unread to announce. */
  headline: string | null
  /** "12 users • MyNick" | "Joining..." | "Double-click to join" */
  detail: string
}

export function roomTooltipParts(
  room: Pick<Room, 'joined' | 'isJoining' | 'unreadCount' | 'occupants' | 'nickname'>,
  t: TFunction,
): RoomTooltipParts
```

The narrow `Pick<>` keeps the function testable with a plain object literal and
no rendering. All string composition and all state branching live here; it
replaces the inline `getTooltipContent` closure in `RoomsList`.

Note that `mentionsCount` is deliberately **absent** from the `Pick<>`. The
headline must not depend on it, and leaving it out of the input type makes the
old `mentionsCount === 0` gate structurally unrepresentable in this module. The
risk of reintroducing that gate therefore sits in the component, and is covered
by a render test rather than a unit test.

`RoomsList` keeps only presentation:

- `headline === null` → pass the bare `detail` **string** to `Tooltip`, byte-for-byte
  today's behaviour for the unchanged states.
- otherwise → pass a two-line node: headline in `font-medium` (default text
  colour), detail in `text-xs text-fluux-muted`. This is the hierarchy already
  established by `ContactDevicesTooltip` in `sidebar-components/types.tsx`.

### i18n

Two new keys under `rooms`, following the `chat.newMessagesCount` convention
already used in this codebase (base key = singular, `_other` = plural):

```json
"unreadMessages":       "{{count}} unread message",
"unreadMessages_other": "{{count}} unread messages"
```

"unread messages" rather than a bare "unread": the bare adjective has no good
translation in most of the 33 locales. All locales are translated in the same
change, edited surgically (parse → mutate → `stringify(, , 4) + "\n"`).

If the component-level test resolves these keys through the `test-setup.ts` i18n
subset, both the base and `_other` forms must be added there — the existing
`newMessagesCount` pair is the precedent.

## Testing

**`apps/fluux/src/utils/roomTooltip.test.ts`** — the pure function:

- joined, unread > 0 → headline set, detail `"12 users • MyNick"`
- joined, unread === 0 → headline `null`
- singular (`count: 1`) vs plural
- no nickname → detail is just `"12 users"`
- `isJoining` → headline `null`, detail `"Joining..."`
- not joined → headline `null`, detail `"Double-click to join"`

**Render test in `RoomsList`**:

- hover a room row with `unreadCount > 0` → both lines appear in the tooltip
- hover a room row with `unreadCount > 0` **and** `mentionsCount > 0` → the
  headline still appears. This is the regression the feature exists to prevent,
  and it can only be caught here.
- the activity dot no longer has its own tooltip

The render test is not optional. The pure-function tests would all pass even if
`RoomsList` never called `roomTooltipParts` — only the render test proves the
wiring. `Tooltip` uses a show delay (700ms default on this row) so the test
needs fake timers or an explicit advance.

## Out of scope

- The DM/conversation row tooltip. Those rows already render the unread count as
  a numeric badge over the avatar, so a tooltip line would be redundant.
- The icon rail tooltip (aggregate unread across a view).
- Capping either badge at `99+`.
