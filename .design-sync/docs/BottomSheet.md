---
category: Overlays
---

# BottomSheet

A mobile-first panel that slides up from the bottom edge over a dimmed backdrop. Use it for
touch action menus — the per-message actions menu is the canonical case — where a centered
modal or a hover toolbar does not fit thumb ergonomics.

It renders nothing when `open` is false. When open it portals to `document.body`, which is
required rather than incidental: sheets are triggered from deep inside the message list, whose
rows use paint containment that would otherwise trap a `position: fixed` overlay inside a row.

The panel is glass-surfaced (`fluux-glass`), capped at `90dvh` with its content area
scrolling, and safe-area padded so the last row clears the home indicator. It traps focus while
open, closes on Escape and on backdrop tap, and carries `data-modal="true"` so global keyboard
handling treats it as a modal.

## Props

- `open: boolean` — required.
- `onClose: () => void` — required. Fired by Escape and by backdrop tap.
- `title?: ReactNode` — a small muted heading above the content.
- `ariaLabel?: string` — name the dialog when there is no visible `title`.
- `panelClassName?: string` — extra classes on the panel, typically a `max-h-*`.
- `children: ReactNode` — the sheet body. It scrolls; the sheet does not grow past the viewport.

## Example

```tsx
<BottomSheet open={open} onClose={() => setOpen(false)} title="Message actions">
  <button type="button" className="w-full px-4 py-3 text-start text-fluux-text hover:bg-fluux-hover">
    Reply
  </button>
  <button type="button" className="w-full px-4 py-3 text-start text-fluux-error hover:bg-fluux-hover">
    Delete
  </button>
</BottomSheet>
```
