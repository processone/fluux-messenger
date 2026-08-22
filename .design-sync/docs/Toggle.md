---
category: Forms
---

# Toggle

A binary switch for a single setting. Use it inside a `SettingsRow`, as the row's trailing
child — that is the only place the Fluux app uses it.

Toggle is fully controlled: it holds no internal state and calls `onChange` with the *next*
value. There is no label built in; the adjacent `SettingsRow` supplies the visible label, so
pass `aria-label` (or wire `id` to the row's `htmlFor`) to keep the switch named.

## Props

- `checked: boolean` — required, controlled.
- `onChange: (next: boolean) => void` — receives the value to switch to, not an event.
- `disabled?: boolean` — the setting is unavailable. Renders at 50% opacity, `cursor-not-allowed`.
- `loading?: boolean` — an async write is in flight. Reads as *busy* rather than *blocked*:
  `cursor-wait` wins over the disabled cursor, and clicks are ignored. Prefer this over
  `disabled` while a change is being persisted.
- `id`, `aria-label` — accessibility wiring.

## Example

```tsx
<SettingsRow label="Read receipts" description="Let contacts see when you have read their messages.">
  <Toggle checked={receipts} onChange={setReceipts} aria-label="Read receipts" />
</SettingsRow>
```
