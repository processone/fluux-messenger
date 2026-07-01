# Cmd-K: Prioritize Unread Conversations — Design

**Date:** 2026-07-01
**Status:** Approved (brainstorming), pending implementation plan

## Problem

The command palette (Cmd-K / Ctrl-K) is the primary "where do I go?" jump target.
On open with an empty query it lists up to 5 recent 1:1 conversations sorted purely
by recency, plus contacts, rooms, views, and actions. Unread state is invisible:
`conversation.unreadCount`, `room.unreadCount`, and `room.mentionsCount` are already
present in the data the palette consumes, but the palette neither displays nor sorts
by them. The most likely reason a user opens Cmd-K — jump to a chat with something
new in it — is unsupported.

## Goal

Surface unread state in the empty-query default view so unread chats are the fastest
thing to reach, without disrupting search or the rest of the palette.

## Scope

- **In scope:** empty-query default view of `CommandPalette.tsx` only.
- **Out of scope:** typed-search results (unchanged — type-grouped as today), SDK
  changes (none needed), contacts/views/actions sections (unchanged).

As soon as the user types a query, behavior reverts to the current type-grouped
results. Rationale: a search match should not be reordered by unread; an empty
palette is the moment where unread is the strongest signal.

## Behavior

### 1. New "Unread" section (DMs only), pinned at top

- A new section renders **above all existing sections**, listing only 1:1
  conversations with `unreadCount > 0`.
- Sorted by recency (most recent unread first).
- Capped at 5 (matching the current conversations cap); the rest remain reachable
  by typing.
- Conversations shown here are **removed from the regular recent-conversations
  section** — no duplication. Dedup key: conversation JID.

### 2. Rooms section: unread-first ordering

- Keep the single Rooms section (no separate room-unread section).
- Sort so unread rooms come first, then recency within each tier.
- Tiebreak tiers, highest first: **mentions (`mentionsCount > 0`) > unread
  (`unreadCount > 0`) > read**, then recency within each tier. A room where the
  user was @-mentioned outranks a room with only unread traffic.

### 3. Unread badge

- Show a small count badge on items that carry unread — in the new Unread section
  and on unread rooms — so the count is visible, not only implied by order.
- Uses counts already present on the data objects (`unreadCount`; rooms may also
  reflect `mentionsCount`). No new data source.

### 4. Empty state

- When there are zero unread DMs, the Unread section does not render (no empty
  header). With no unread anywhere, the palette looks exactly as it does today.

## Implementation Notes

- All changes live in
  `apps/fluux/src/components/CommandPalette.tsx` — the `allItems` builder plus the
  grouping/render path. The recency sort for conversations/rooms already exists in
  the SDK (`useChat`), so this layer only partitions and reorders what it receives.
- One new i18n key for the "Unread" section header, translated across all 33
  locales per project convention (no English placeholders).
- The new section participates in the existing keyboard navigation (arrow keys /
  enter) since it flows through the same grouped-items list the palette already
  renders and indexes.

## Testing

- Unit coverage in the palette's test file for the empty-query builder:
  - Unread DMs appear in the Unread section and are absent from the recent section.
  - Zero unread DMs → no Unread section rendered.
  - Rooms ordering: mention-room before unread-room before read-room, recency
    within tier.
  - Typed query → no Unread section; existing type-grouped behavior intact.
- Badge rendering assertions (count present on unread items, absent on read items).
