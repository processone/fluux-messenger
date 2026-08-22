---
category: Brand
---

# HollowIconMark

The outline variant of the Fluux app icon: the same aurora-gradient squircle as `AppIconMark`,
but with the chat bubble drawn as a white stroke with a drop shadow instead of a glass fill.
It mirrors the shipped hollow desktop icon source.

Pick between the two by which installed icon variant the build ships — they are alternates,
not a hierarchy. Like `AppIconMark` it is mode-agnostic and decorative (`aria-hidden`).

## Props

- `size?: number` — rendered square size in px. Default `72`. The viewBox is 1024x1024.
- `className?: string`

## Example

```tsx
<HollowIconMark size={96} />
```
