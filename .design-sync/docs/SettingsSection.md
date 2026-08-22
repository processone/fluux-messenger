---
category: Settings
---

# SettingsSection

The outermost of the three settings primitives. It renders a small uppercase heading, an
optional description, and whatever you nest inside — normally one or more `SettingsGroup`s.

The Fluux settings panes are built as a stack of these, each section covering one topic
(Appearance, Privacy, Encryption). The heading is deliberately quiet: uppercase, muted,
extra-small, letter-spaced. It is a `<section>`, so it also carries the document structure.

Composition order is always `SettingsSection` → `SettingsGroup` → `SettingsRow`.

## Props

- `title: string` — required, the section heading.
- `description?: string` — a muted line under the heading. When present it also tightens the
  spacing above the children.
- `className?: string` — usually a top margin between stacked sections (`mt-6`).

## Example

```tsx
<SettingsSection title="Privacy" description="Control what other people can see.">
  <SettingsGroup>
    <SettingsRow label="Read receipts">
      <Toggle checked={receipts} onChange={setReceipts} aria-label="Read receipts" />
    </SettingsRow>
  </SettingsGroup>
</SettingsSection>
```
