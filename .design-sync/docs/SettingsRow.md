---
category: Settings
---

# SettingsRow

One line in a settings pane: a label on the leading side, an optional description under it,
and an optional control on the trailing side. This is where `Toggle` and `Select` live.

The row has two shapes, chosen by whether you pass `onClick`:

- **Static row** (no `onClick`) — a `<div>`. Use it when the row *contains* the control, and
  the control handles the interaction.
- **Action row** (`onClick`) — the whole row becomes a full-width `<button>`, so the entire
  surface is the click target. Use it for navigation and actions.

Do not combine `onClick` with an interactive child. A button inside a button is invalid HTML;
an action row's `children` must be non-interactive decoration such as a chevron or a value.

## Props

- `label: string` — required.
- `description?: string` — a muted second line.
- `htmlFor?: string` — pairs the label with a control's `id`.
- `onClick?: () => void` — switches the row to the action shape.
- `danger?: boolean` — tints the label with the destructive red. The description stays muted.
  If you pass an icon as `children`, tint it yourself to match.
- `disabled?: boolean` — only meaningful with `onClick`; renders a real disabled `<button>`.
- `children?: ReactNode` — the trailing control or decoration.

## Example

```tsx
<SettingsRow label="Read receipts" description="Let contacts see when you have read their messages.">
  <Toggle checked={receipts} onChange={setReceipts} aria-label="Read receipts" />
</SettingsRow>

<SettingsRow label="Delete account" description="This cannot be undone." onClick={confirmDelete} danger />
```
