# Gated room typing indicator in the sidebar

**Date:** 2026-07-07
**Status:** Design approved, pending implementation plan

## Problem

The sidebar already surfaces typing state for 1:1 chats — `ConversationItem`
renders a shimmer overlay on the contact avatar when the contact is composing
(`ConversationList.tsx`). Room rows (`RoomItem` in `RoomsList.tsx`) show no typing
state at all. This is a parity gap, but rooms are not 1:1 chats and must not be
treated as such.

A 1:1 "typing" signal is rare, directed at you, and worth a glance. A MUC "typing"
signal is near-constant in a busy room and directed at the room, not you. Porting
the always-on 1:1 overlay to rooms would produce a permanent shimmer on active room
rows — ambient noise that competes with the unread badge and signals nothing
actionable. That naive version is explicitly rejected.

## Solution

Show typing on a joined room's sidebar row **only when the room has zero unread**.

A room you are caught up on that suddenly shows "someone is typing" means a new
message is about to land in a conversation you had considered settled — the one
moment room typing carries the same "a reply is coming" value that 1:1 typing has.
Busy rooms almost always have unread, so they display the badge (the stronger
signal) and paint no typing indicator; the two never fight for the same pixels.

### Gating rules

Display the typing indicator on a `RoomItem` row when **all** hold:

- `room.joined` is true (the feature applies to joined rooms only).
- `room.unreadCount === 0` (caught up — the core gate).
- The row is **not** the active room (typing is already shown in `RoomView` for the
  open room; showing it again in the sidebar is redundant).
- After filtering, at least one user remains in the typing set.

The typing set to display is `room.typingUsers` minus:

- The user's own nickname (`room.nickname`) — never show your own typing.
- Ignored users — reuse the same ignore filter `RoomView` already applies to
  `activeTypingUsers` (`filteredTypingUsers`), so behavior is consistent between the
  room view and the sidebar.

### Placement

**Replace the preview line** (the second line of the row, normally the last-message
preview). When the gate is satisfied, that line renders the compact typing indicator
(shimmer dots + "Alice is typing…") instead of the message preview. It reverts to the
preview the instant typing stops.

This is safe precisely because the gate guarantees `unreadCount === 0`: the preview
being replaced is an already-read message, so nothing unseen is hidden. It also names
*who* is typing, which is valuable in a room in a way it is not in a 1:1.

Rejected alternative: mirror the 1:1 avatar overlay. Room avatars render as a raw
`<img>` / `Hash` icon rather than the `Avatar` component that carries the `overlay`
prop, so it is more plumbing, and an avatar overlay cannot name the typing user.

### Component change

`TypingIndicator` (`apps/fluux/src/components/conversation/TypingIndicator.tsx`)
currently hardcodes `py-2 px-4 text-sm` (message-view sizing). Add a compact variant
(e.g. a `variant="compact"` or `size="sm"` prop) that drops the padding and uses
`text-xs` so the indicator fits the sidebar preview line. The aurora shimmer dots and
the existing `chat.typing.*` i18n keys are reused unchanged.

## Performance

No new subscription and no new re-render cost. `RoomItem` subscribes to
`useRoomStore((s) => s.getRoom(roomJid))`. `getRoom` returns the combined room object
from the `rooms` map (`roomStore.ts:1153`), and every `typingUsers` mutation replaces
that map entry with a fresh object reference (`roomStore.ts:961`, `roomStore.ts:1877`).
So the row **already** re-renders on its own room's typing churn today, bounded to that
single row by the per-row subscription. This feature only decides whether to paint on
a render that already happens. In busy rooms the unread gate paints nothing.

**Implementation must verify** this reactivity holds in practice (the row visibly
updates as typing starts/stops) rather than relying on the reference-change reasoning
alone; if a future change mutates `typingUsers` in place, a dedicated boolean selector
would be needed.

## Testing

- Unit-test the gating predicate:
  - `unreadCount > 0` → hidden even when others are typing.
  - Own nickname excluded from the displayed set.
  - Ignored users excluded from the displayed set.
  - Active room → hidden.
  - `unreadCount === 0` + a non-ignored, non-self user typing → shown.
- Render test: compact typing indicator appears and disappears as the room's
  `typingUsers` changes under the gate.
- Demo mode: seed a joined, caught-up room with an occupant composing to eyeball the
  compact indicator in the sidebar.

## Out of scope (YAGNI)

- No SDK work — `room.typingUsers` is already tracked.
- No XEP-0421 occupant-id stability for typing state — typing is ephemeral, and
  nick-based tracking matches what `RoomView` already does.
- No settings toggle — the gate makes the feature quiet by construction.

## Affected files

- `apps/fluux/src/components/sidebar-components/RoomsList.tsx` — `RoomItem` gate + preview-line rendering.
- `apps/fluux/src/components/conversation/TypingIndicator.tsx` — compact variant.
- Ignore-filter helper shared with `RoomView` (`useRoomActive` / wherever
  `filteredTypingUsers` is derived) — reused, factored out if currently inline.
