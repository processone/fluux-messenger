# Mobile conversation-header spacing

## Problem

On small screens the conversation header (1:1 and rooms) wastes horizontal
space and mis-groups its controls:

- The encryption shield floats in the middle of the header, visually detached
  from the kebab menu, instead of reading as part of the trailing action
  cluster.
- The contact name and presence text truncate far earlier than necessary
  ("Jérôme Sa…", "En li…") even when there is apparent room.

### Root cause

The header is a flat flex row with a uniform `gap-3` (12px):

```
[back] [avatar] [name (flex-1)] [shield] [search] [kebab]
```

On touch devices, `.tap-target` (index.css:906) inflates every icon button to a
44px invisible box. So the 16px shield glyph sits centred in a 44px box, then a
12px gap, then the kebab glyph centred in *its* 44px box — the glyphs end up
~40px apart even though only a 12px gap was requested. Those invisible boxes plus
the uniform gaps also consume the horizontal budget, forcing the name to
truncate early.

A secondary issue: in the status line the local-time clock is `flex-shrink-0`
while the presence text is `truncate`, so under width pressure the meaningful
word ("En ligne") is clipped to keep the less-important time.

## Scope

Both header components, since they share the identical header shell:

- `apps/fluux/src/components/ChatHeader.tsx` (1:1 and lightweight group chats)
- `apps/fluux/src/components/RoomHeader.tsx` (MUC rooms)

Shared shell today (duplicated verbatim in both):
`@container relative aurora-horizon h-14 px-4 flex items-center border-b border-fluux-bg shadow-sm gap-3`

## Design

Three linked changes. All are className / structure-only, gated so **desktop
layout is unchanged**.

### 1. Group the trailing action cluster

Wrap the trailing action buttons in a single flex container with a tight
internal gap, so they read as one unit and their glyphs sit close together:

- `ChatHeader`: wrap `EncryptionIcon` + inline-search `div` + kebab wrapper in
  `<div className="flex items-center gap-1">`.
- `RoomHeader`: wrap the trailing inline action `div`s + kebab in the same
  `flex items-center gap-1` container.

`gap-1` (4px) — the "slight breathing room" option: grouped as a unit but the
two icons stay individually legible. The 44px tap boxes still guarantee the
touch-target separation underneath.

The cluster gap is uniform (not media-gated): grouping trailing icons tightly is
a correct pattern at every width, and on desktop it is a subtle improvement (the
icons read as a group rather than three evenly-spread controls).

### 2. Tighten the outer rhythm on mobile only

Change the header shell gap from `gap-3` to `gap-2 md:gap-3` in both components.
This reclaims spacing between back / avatar / name / cluster on phones while
leaving desktop at the current 12px rhythm.

Combined with #1, roughly ~25px of horizontal budget is returned to the name
area — enough that "Jérôme Sautret" and "En ligne" fit on a normal phone.

### 3. Protect the presence text from the clock (1:1 status line)

In `ChatHeader`'s status row, hide the local-time clock below a narrow
container-query width so the presence word is never sacrificed to the time. The
clock is wrapped so it is `hidden` under the threshold and `flex` above it, e.g.
`hidden @[400px]:flex` (literal string, per the JIT-scanner constraint in
`headerOverflow.ts`). The exact threshold is tuned against preview during
implementation.

Above the threshold, behaviour is unchanged: a long custom status message still
truncates first and the clock still shows. Only the narrowest widths drop the
clock to keep the short presence label intact.

## Non-goals

- No change to icon glyphs, colours, trust semantics, or the encryption popover.
- No change to the overflow-tier collapse thresholds (`440px` / `600px`).
- No broader header refactor. The duplicated shell className is edited in place
  in both files; extracting a shared constant is out of scope for this change.

## Verification

- Preview at phone widths (375 / 390 / 414) via `preview_resize` + dark mode:
  confirm shield sits beside the kebab, name shows in full, status shows
  "En ligne" (no clock) at the narrowest width and gains the clock as width
  grows.
- Confirm desktop (`md+`) header spacing is visually identical to before.
- `npm run typecheck` and the app test suite for the two header components.
