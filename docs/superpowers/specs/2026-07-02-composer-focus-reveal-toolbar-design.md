# Composer: focus-reveal toolbar on narrow widths

## Problem

The narrow-width composer (#815) always renders two rows once the
`.composer-card` container drops below 420px: the text field on the first line
and a toolbar row (`+` / lock / emoji / send) beneath it
([`index.css` `.composer-actions`](../../../apps/fluux/src/index.css)).

```
┌────────────────────────┐
│ [ Message…           ]  │   ← input, full width
│  +   🛡         😊  ➤   │   ← toolbar, always present
└────────────────────────┘
```

That toolbar row costs a permanent strip of vertical space even when the
composer is idle — the moment it matters most, on a phone-height viewport where
the message list is already tight.

## Goal

On narrow widths, collapse the composer to a slim single row when idle and
"extend" the secondary controls into a drawer only when the user engages the
field. Keep it pure CSS — no JS, no component state — matching #815.

Non-goals: no change to which controls exist, no change to the wide (`≥ 420px`)
single-row layout, no change to the emoji/attach popovers, no JS-driven
measurement or focus state.

## Approach

Anchor the **send button to the top row with the input** so the collapsed state
is a usable single row (input + send). The secondary controls (`+`, lock, emoji)
live in a **second row that is a collapsible drawer**, revealed on
`:focus-within`.

Reuse the existing mechanisms:

- The `.composer-card` already declares `container-type: inline-size` and already
  uses `:focus-within` for its accent focus-edge
  ([`index.css` `.composer-card:focus-within`](../../../apps/fluux/src/index.css)).
  The drawer gates on the **same** `:focus-within`.
- The narrow/wide split stays a `@container (min-width: 420px)` query.

### Layout

Grid areas are unchanged from #815 (`add`, `lock`, `input`, `emoji`, `send`).
Only the narrow template and its focus variant change.

**Narrow, idle (default — not `:focus-within`) — single row:**

```
grid-template-areas: "input send";
grid-template-columns: 1fr auto;
```

`add`, `lock`, `emoji` are placed in a drawer row that is collapsed to zero
height (see below). Send stays beside the input; when there is no text it is the
existing disabled/transparent send affordance.

**Narrow, focused (`:focus-within`) — input + send on top, drawer below:**

```
grid-template-areas:
  "input input send"
  "add   lock  emoji";
grid-template-columns: auto auto 1fr;   /* drawer row: +/lock at inline-start, emoji at inline-end under send */
```

Row 1: `input` (spanning) + `send` at the inline-end corner — unchanged from
idle, so send does **not** move when the drawer opens.
Row 2 (drawer): `add` and `lock` at the inline-start, `emoji` at the inline-end
(sitting under `send`).

**Wide (`@container (min-width: 420px)`) — single row, untouched:**

```
grid-template-areas: "add lock input emoji send";
```

Exactly today's result.

### Drawer collapse / reveal

The drawer must animate as an "extend," so it can't rely on a grid-template swap
alone (grid reflow doesn't transition). Approach:

- Wrap the drawer controls' row so its **height/opacity** transition. Idle:
  `max-height: 0; opacity: 0; overflow: hidden; pointer-events: none`.
  `:focus-within`: `max-height` to a value covering one toolbar row, `opacity: 1`.
- Gate the whole behavior inside the narrow branch only. Wide is never collapsed.
- `prefers-reduced-motion: reduce` → no transition (snap open/closed).

Exact CSS structuring (whether the drawer is a nested element vs. the grid rows
collapsing) is an implementation detail for the plan; the constraint is:
send never reflows between idle and focused, and the reveal is CSS-only.

### Behavior

- **Reveal trigger:** `:focus-within`. Tabbing to the field — or to any control —
  opens the drawer; opening the emoji/attach popovers keeps it open (they are
  DOM children of the card). CSS applies synchronously with focus, so a control
  that receives focus is visible in the same frame (no flash).
- **Collapse on blur, even with a draft.** Send lives on the top row, so a typed
  but unsent draft stays sendable; attach/emoji are one tap away again. This
  avoids any "keep open while draft present" special-casing and keeps it pure CSS.
- **Wide layout is never collapsed** — the drawer logic lives entirely under the
  narrow container query.

### Edge cases

- **`input` cell must shrink**: keep `min-width: 0` on the input area (as today).
- **Autosize width observer**: the input width changes when the layout switches
  and when the drawer opens/closes if it affects input width — it does not here
  (input width is the same in idle and focused narrow states, both `1fr` on the
  top row). The existing width `ResizeObserver` (`resizeToContent(true)`) covers
  the narrow⇄wide switch regardless.
- **Tap targets**: drawer buttons keep `p-3` / `tap-target`; the collapsed drawer
  must not leave them focusable while hidden — `:focus-within` reveals before
  interaction, but confirm keyboard tab order lands on the input first (DOM order
  is `add, lock, input, emoji, send`; focusing a hidden `add`/`lock` still
  triggers `:focus-within` and reveals synchronously, so no dead tab stop).
- **RTL**: `grid-template-areas` follows the inline axis; groups mirror
  automatically. Verify.
- **Escalation banner / edit / reply / attachment previews**: sibling rows above
  the action row, unaffected.

## Testing

- Unit: extend `MessageComposer.layout.test.tsx` — assert the `.composer-actions`
  markup/classes for the drawer (jsdom does not evaluate container queries or
  `:focus-within`, so assert the class strings / structure, mirroring #815's test).
- Manual/preview (demo mode, narrowed pane below 420px):
  - Idle: single row, input + send only; `+`/lock/emoji hidden.
  - Focus the field: drawer extends below with `+`/lock/emoji; send does not move.
  - Blur: drawer collapses; a typed draft keeps send visible.
  - `prefers-reduced-motion`: snaps without animating.
  - Wide (`≥ 420px`): unchanged single row.
  - RTL mirrors the groups.

## Files

- [`apps/fluux/src/index.css`](../../../apps/fluux/src/index.css) — `.composer-actions`
  narrow template, `:focus-within` drawer variant, and the collapse/reveal
  transition.
- [`apps/fluux/src/components/MessageComposer.tsx`](../../../apps/fluux/src/components/MessageComposer.tsx)
  — only if the drawer needs a wrapper element around `add`/`lock`/`emoji`;
  prefer a CSS-only change if the existing grid children suffice.
- [`apps/fluux/src/components/MessageComposer.layout.test.tsx`](../../../apps/fluux/src/components/MessageComposer.layout.test.tsx)
  — drawer structure assertions.
