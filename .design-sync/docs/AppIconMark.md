---
category: Brand
---

# AppIconMark

The Fluux app icon as a component: the aurora-gradient squircle with the filled white speech
bubble. Used on the login screen, and mirrors the shipped desktop icon source so the login
mark and the installed application icon are the same object.

Mode-agnostic — the tile gradient is fixed, so it looks identical in light and dark themes.
Decorative: it renders `aria-hidden`, so if the mark is the only thing identifying a surface,
put the product name in adjacent text.

Use `HollowIconMark` for the outline variant.

## Props

- `size?: number` — rendered square size in px. Default `72`. The viewBox is 1024x1024, so it
  scales cleanly to any size.
- `className?: string` — appended to the built-in `app-icon-mark` class.

## Example

```tsx
<div className="flex flex-col items-center gap-3">
  <AppIconMark size={96} />
  <h1 className="font-display text-fluux-text">Fluux</h1>
</div>
```
