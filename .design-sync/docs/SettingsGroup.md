---
category: Settings
---

# SettingsGroup

A rounded, bordered card that groups related `SettingsRow`s and draws the hairline dividers
between them. It is purely a container: no heading, no padding of its own — the rows supply
their own padding, and the group clips them to its radius.

Put it inside a `SettingsSection`. Rows that belong together (all the notification switches,
all the account actions) go in one group; unrelated rows go in separate groups so the
dividers do not imply a relationship that is not there.

Both the border and the dividers use `--fluux-surface-divider`, so the card reads as a subtle
inset on any theme rather than a hard outline.

## Props

- `children: ReactNode` — required, normally `SettingsRow` elements.
- `className?: string` — spacing against neighbouring content (`mb-3`).

## Example

```tsx
<SettingsGroup>
  <SettingsRow label="Desktop notifications">
    <Toggle checked={desktop} onChange={setDesktop} aria-label="Desktop notifications" />
  </SettingsRow>
  <SettingsRow label="Sound">
    <Toggle checked={sound} onChange={setSound} aria-label="Sound" />
  </SettingsRow>
</SettingsGroup>
```
