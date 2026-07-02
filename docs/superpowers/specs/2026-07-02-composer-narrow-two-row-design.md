# Composer two-row layout on narrow widths

## Problem

The message composer lays all controls on a single horizontal row
([`MessageComposer.tsx`](../../../apps/fluux/src/components/MessageComposer.tsx),
the `flex items-center` block):

```
[ + ]  [🔒]  [────── textarea flex-1 ──────]  [🙂]  [➤]
```

Four fixed-width controls flank the field — the `+` attach menu, the leading
encryption lock, the emoji button, and the send button — spending ~160–180px of
fixed chrome before any text fits. On a narrow viewport (phone width, or a
narrowed chat pane) this leaves the text lane a cramped sliver.

## Goal

On narrow widths, give the text field the full first line and drop the action
buttons to a toolbar row beneath it. Above the breakpoint, keep the current
single-row layout exactly as-is.

Non-goals: no change to which controls exist, no change to desktop layout, no
change to the emoji/attach popovers, no JS-driven measurement or state.

## Approach

Convert the single action row from `flex` to a **CSS grid with named areas**,
and swap the grid template at a **container-query width breakpoint**. Because
grid placement is driven by `grid-area` (not DOM order), the same markup reflows
between one and two rows with no JavaScript and no component state.

This matches the existing responsive pattern in the app: `@container` on a
parent plus mobile-first `@[Wpx]:` min-width variants, already used for the
header overflow kebab
([`headerOverflow.ts`](../../../apps/fluux/src/components/header/headerOverflow.ts)).

### Layout

The `.composer-card` (or the immediate wrapper of the action row) gets
`@container`. The action row becomes a grid whose children carry stable
`grid-area` names:

- `add` — the `+` attach-menu button
- `lock` — the leading encryption lock/shield (present only when encrypted)
- `input` — the text field (default `TextArea` **and** the `renderInput`
  mention-overlay wrapper share this area)
- `emoji` — the emoji button
- `send` — the send button

**Narrow (default, mobile-first) — two rows:**

```
grid-template-areas:
  "input input input input"
  "add   lock  .    emoji send";   /* emoji + send grouped at the inline-end */
grid-template-columns: auto auto 1fr auto auto;
```

Row 1: `input` spans all columns (full width).
Row 2: `add` and `lock` at the inline-start, a `1fr` spacer, then `emoji` and
`send` grouped at the inline-end — preserving the desktop emoji→send order.

**Wide (`@[<breakpoint>px]:`) — single row:**

```
grid-template-areas: "add lock input emoji send";
grid-template-columns: auto auto 1fr auto auto;
```

Identical to today's visual result.

### Breakpoint

Start at `@[420px]:` for the single-row template (below 420px container width →
two rows). This is a starting value, tuned live against the real chat pane — the
switch should fire while the single-row text lane is still comfortable, before
it becomes a sliver. Kept as a single literal so it is trivial to adjust, in the
spirit of the header tiers (440 / 600).

### Edge cases

- **`input` cell must shrink**: the input area needs `min-width: 0` so the grid
  column can collapse below content width (same reason the current flex child
  carries `min-w-0`).
- **Autosize width observer**: switching to a full-width input changes the
  textarea width, which the existing width `ResizeObserver`
  (`resizeToContent(true)`) already re-measures — no new wiring, but the spec
  calls it out as the thing that keeps the height correct across the reflow.
- **Popovers**: the attach menu (`absolute bottom-full start-0`) and emoji
  picker (`absolute bottom-full end-0`) anchor to their own buttons and open
  upward; they continue to work unchanged in either layout.
- **RTL**: `grid-template-areas` follows the inline axis, so the left/right
  groups mirror automatically in RTL — no explicit handling needed. Verify.
- **Tap targets**: the buttons keep their current padding
  (`p-3` / `tap-target`); the two-row toolbar must not shrink them below the
  existing touch size.
- **Encryption escalation banner / edit / reply / attachment previews**: these
  are sibling rows above the action row inside the card and are unaffected.

## Testing

- Unit: a render test asserting the action row carries `@container` and the
  grid-template classes for both breakpoints (mirrors
  `headerOverflow.test.ts` style — assert the class strings, since jsdom does
  not evaluate container queries).
- Manual/preview: narrow the chat pane / demo mode below and above the
  breakpoint; confirm the input goes full-width with the toolbar below, send
  stays at the inline-end bottom corner, emoji sits beside send, and the
  desktop single row is visually unchanged. Verify RTL mirrors the groups.

## Files

- [`apps/fluux/src/components/MessageComposer.tsx`](../../../apps/fluux/src/components/MessageComposer.tsx)
  — the action row markup and grid classes.
- Possibly a small CSS addition in `index.css` if the grid templates are cleaner
  as a named utility than inline `@[...]` Tailwind variants; prefer the Tailwind
  variant approach first to match `headerOverflow`.
