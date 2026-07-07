# Cmd+K: promote attention-rooms into the top "Needs attention" group

**Date:** 2026-07-07
**Status:** Design — approved for planning
**Scope:** `apps/fluux` only. No SDK changes.

## Problem

The Cmd+K command palette's default (empty-query) view builds groups in a fixed
order in `buildDefaultGroups` ([CommandPalette.tsx:167](../../../apps/fluux/src/components/CommandPalette.tsx)):

1. Unread DMs (`unreadCount > 0`), up to 5 — label `commandPalette.unread`
2. Read DMs, up to 5 — label `sidebar.messages`
3. Rooms, up to 4, tier-sorted internally (mentions → unread → read) — label `sidebar.rooms`

Because rooms are always their own group *below* the DM groups, a room where
the user was **@mentioned** or received an **unread whisper** renders below
already-read DMs. The mention priority (`roomTier`) only orders rooms *within*
the rooms group; it never lets an attention-room compete for the top slot.

The top group should surface everything addressed to the user specifically —
unread DMs and attention-rooms alike — not just DMs.

## Key insight: one predicate covers mentions + whispers

Incoming whispers (XEP-0045 private messages) already increment a room's
`mentionsCount` — see `Chat.ts` `processRoomWhisper` emitting `room:whisper`
with `incrementMentions: !isOutgoing`. There is no separate whisper-unread
counter, and none is needed.

Therefore **"mention or unread whisper" collapses to a single condition:
`room.mentionsCount > 0`**. This is exactly the "someone addressed me
specifically" signal, and it is already tracked in `RoomMetadata`. No SDK work
is required.

## Design

### Top group: "Needs attention"

Replace the DM-only unread group with a combined **attention** group that
contains:

- Unread DMs — conversations with `unreadCount > 0`
- Attention-rooms — rooms with `mentionsCount > 0`

Ordering: **interleave DMs and attention-rooms by most-recent activity**
(the `lastMessage` timestamp), so the group reads as one chronological
"what's waiting for me" list rather than "all DMs, then all rooms." The
existing red mention badge already distinguishes attention-rooms visually
([CommandPalette.tsx:678](../../../apps/fluux/src/components/CommandPalette.tsx)),
so mixing types in one list stays readable.

Cap the group at **6 items total**. DMs and attention-rooms compete for those
slots purely by recency. Any attention-room that overflows the cap still
appears in the rooms group below (unchanged tier-sort), so nothing is lost.

Label: new i18n key **`commandPalette.attention`** → "Needs attention"
(translated to all 33 locales; no English placeholders).

### Rooms group below: exclude promoted rooms

The rooms group must exclude rooms already shown in the attention group to
avoid duplicates. A room appears in the attention group iff it has
`mentionsCount > 0` **and** it made the 6-item cap. Concretely:

- Compute the attention group first, capturing the set of room JIDs it contains.
- The rooms group filters those JIDs out, then keeps its existing behavior:
  tier-sort (`roomTier`) the remainder, take up to 4, label `sidebar.rooms`.

This means a mention-room that overflowed the attention cap still shows below —
and since `roomTier` puts `mentionsCount > 0` at tier 0, it lands at the top of
the rooms group. No mention-room disappears.

### Read DMs group: unchanged

Read DMs (`unreadCount === 0`) keep their own group under `sidebar.messages`,
up to 5, below the attention group. Only *unread* DMs move into the attention
group (they already were in the top group; the change is that rooms now join
them, not that DMs move).

## Data changes

`CommandItem` needs a sortable timestamp to interleave by recency. Add:

```ts
/** Timestamp (ms) of the last message, for recency ordering in the attention group. */
sortTimestamp?: number
```

Populate it when building items from `conv.lastMessage` and `room.lastMessage`
(read the message timestamp field — verify exact field name on `RoomMessage` /
conversation message at implementation time). Items without a last message
(contacts, bookmarked-not-joined rooms, views, actions) leave it undefined;
they never enter the attention group so ordering is unaffected.

## Behavior summary

| Item | Where it appears |
|------|------------------|
| Unread DM | Attention group (by recency); if pushed out by the cap, not shown in the default view — see Edge cases |
| DM, read | `sidebar.messages` group |
| Room, `mentionsCount > 0` | Attention group if within cap; else top of rooms group (tier 0) |
| Room, unread no mention | Rooms group (tier 1) |
| Room, read | Rooms group (tier 2) |

## Edge cases

- **Attention cap vs. unread DMs.** Today unread DMs cap at 5. With a shared
  6-item attention cap, if a user has many unread DMs *and* mention-rooms, some
  unread DMs could be pushed out. Unlike rooms, DMs have no "overflow" group to
  catch them (read-DM group is `unreadCount === 0` only). Decision: the shared
  cap is acceptable — the palette default view is a shortcut, not a complete
  inbox; the full lists live in the sidebar. If this proves too tight in
  practice, raise the cap. Document the cap constant clearly.
- **Active conversation/room excluded.** The existing guards (`activeConversationId`,
  `activeRoomJid`) still skip the currently-open item before grouping. Unchanged.
- **Ties in `sortTimestamp`.** Fall back to a stable order (e.g. keep DMs before
  rooms, or by JID) so rendering is deterministic.
- **Missing timestamp.** An attention-room with no `lastMessage` (edge: mention
  recorded but preview absent) sorts to the bottom of the attention group via a
  `?? 0` default, not excluded.

## Testing

Extend `CommandPalette.test.tsx`:

- Room with `mentionsCount > 0` appears in the attention group, above read DMs.
- Attention group interleaves a mention-room and an unread DM by recency.
- A mention-room that overflows the cap appears in the rooms group (tier 0), not
  duplicated in the attention group.
- Unread room with `mentionsCount === 0` stays in the rooms group, not promoted.
- Group label renders `commandPalette.attention`. Add the key to the
  `test-setup.ts` i18n subset if asserted by label text.

## Out of scope

- No new SDK field or store selector (whispers already bump `mentionsCount`).
- No separate whisper-unread counter or per-occupant whisper tracking.
- No change to search/filter mode (non-empty query) ranking.
- No change to 1:1 mention detection (DMs still have no mention concept).
