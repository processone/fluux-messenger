# RoomAvatar — shared room-avatar component

**Date:** 2026-07-09
**Status:** Approved (design)
**Branch:** claude/room-avatar-cmd-k-shape-9ad68a

## Problem

Room avatars must render as rounded squares (`rounded-xl`), contacts as circles.
Today "room-ness" leaks to every caller, so each site re-derives the shape,
fallback icon, and consistent color independently. This guarantees drift — the
Cmd-K palette rendered rooms as circles because it forgot to pass `shape`.

Current state (three sites, three implementations):

| Site | Image path | Fallback path | Shape decision |
|------|-----------|---------------|----------------|
| `CommandPalette.tsx` | `<Avatar>` | `fallbackIcon={<Hash>}` | per-caller `shape={...}` |
| `RoomHeader.tsx` | `<Avatar shape="square">` | separate hand-rolled `<div rounded-xl>` | mixed |
| `sidebar-components/ConversationList.tsx` | raw `<img rounded-xl>` + own `roomAvatarBroken` state | raw `<Hash rounded-xl>` + own color call | hardcoded, bypasses `Avatar` |

The sidebar reimplements broken-image detection, consistent-color generation,
and the Hash fallback that `Avatar` already provides.

## Goal

A single `RoomAvatar` wrapper that bakes in the room-avatar contract so no caller
can forget it, and retires the duplicated sidebar implementation.

## Design

### Component

`apps/fluux/src/components/RoomAvatar.tsx` — a thin wrapper over `Avatar` that
hard-codes the three things every room avatar must agree on:

- `shape="square"` (→ `rounded-xl`)
- `fallbackIcon={<Hash>}`, sized to the avatar
- room consistent-color — already `Avatar`'s default from `identifier`, so nothing extra

Rooms have no presence, so `RoomAvatar` does not expose presence props.

### Props

A curated subset of `AvatarProps` (discrete props — chosen because the three
callers share no common object and this avoids coupling to the SDK `Room` type):

```ts
interface RoomAvatarProps {
  identifier: string          // room JID — drives color + fallback
  name?: string
  avatarUrl?: string
  size?: AvatarSize           // defaults to 'sm'
  overlay?: React.ReactNode   // sidebar typing indicator
  className?: string
}
```

Internally it maps `size → Hash icon className` (e.g. `xs`→`size-3.5`,
`sm`→`size-4`, `header`→`size-5`) and renders:

```tsx
<Avatar shape="square" fallbackIcon={<Hash className={hashClassForSize(size)} />} {...rest} />
```

### Call-site migrations

1. **CommandPalette.tsx** — the `item.type === 'room'` branch renders
   `<RoomAvatar>`; the contact/conversation branch keeps `<Avatar>`. The interim
   `shape={...}` one-liner is removed. `presenceBorderColor` is dropped for room
   rows (rooms have no presence dot).
2. **RoomHeader.tsx** — `<Avatar shape="square">` plus its separate hand-rolled
   `<div rounded-xl>` fallback branch collapse into one `<RoomAvatar size="header">`.
3. **ConversationList.tsx** — the raw `<img rounded-xl>` + `<Hash>` fallback +
   `roomAvatarBroken` state + local `generateConsistentColorHexSync` call all
   retire in favor of `<RoomAvatar overlay={isTyping ? <TypingIndicator/> : undefined}>`.
   Net deletion and a strict upgrade: inherits `Avatar`'s WebKit broken-blob
   detection (the sidebar currently only does `onError`/`onLoad`).

### Testing

- `RoomAvatar.test.tsx`: renders `rounded-xl` (not `rounded-full`); shows the
  Hash fallback with no `avatarUrl`; renders `<img>` when given one; forwards `overlay`.
- Regression lock: CommandPalette room rows carry the square shape (guards the
  original bug).
- Existing CommandPalette / ConversationList / RoomHeader tests stay green.

## Out of scope

- Presence rings on room avatars.
- The RoomView mention avatar (that's an occupant, not a room).
- Any SDK changes.
