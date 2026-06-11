# Continue a whispered conversation (MUC private messages)

**Date:** 2026-06-11
**Status:** Approved

## Problem

A whisper (MUC private message, XEP-0045 §7.5) can only be continued by clicking
"Reply" on one of its messages, which re-enters whisper mode. But the reply
button is hidden on the last message of the conversation
(`canReply={!isLastMessage && !counterpartGone}` in `MessageBubble.tsx`) — a
deliberate choice for public replies, where quoting the last message is
redundant. When the whisper is the last message in the room, there is no way to
continue the private conversation from the whisper frame; the user must go
through the occupant panel.

## Changes

Both changes are in
`apps/fluux/src/components/conversation/MessageBubble.tsx`. No SDK change, no
composer/`whisperTarget` change, no new wiring in `RoomView.tsx`.

### 1. Show the reply button on the last message when it is a whisper

```tsx
canReply={(!isLastMessage || inThread) && !counterpartGone}
```

The existing flow does the rest: `onReply` on a private message reaches
`handleReplyToMessage` (`RoomView.tsx`), which enters whisper mode with the
counterpart-gone guard and toast.

### 2. Make the "Private with {nick}" thread header clickable

The thread-start header (Ear icon + `rooms.whisperThread` label) becomes a real
`<button type="button">` when the counterpart is present:

- Click → `onReply(message)` — same flow as change 1.
- Style: `hover:bg-fluux-private-hover`, rounded corner, `cursor-pointer`,
  consistent with the composer whisper banner.
- Accessibility/tooltip: reuse the existing i18n key
  `rooms.sendPrivateMessage` ("Send private message") as `aria-label`/tooltip.
  No new i18n key, so no translation pass over the 33 locales.
- When the counterpart has left the room (`counterpartGone`), the header stays
  a plain non-clickable `<div>` — the thread footer ("X is no longer in the
  room") already explains why.

## Testing

Extend existing app tests around MessageBubble:

- Reply button present on the last message when it is private; absent when the
  last message is public; absent when the whisper counterpart has left.
- Clicking the thread header calls `onReply` with the message.
- The thread header is not a button when `counterpartGone`.

## Out of scope

- SDK changes.
- Composer / `whisperTarget` behavior.
- Reply button behavior on the last *public* message (unchanged).
