# Modal & Cmd-K focus trap — design

**Date:** 2026-07-01
**Status:** Approved, pending implementation

## Problem

When a modal or the Cmd-K command palette is open, keyboard focus can leave the
panel and land on the interface underneath it. `Tab` / `Shift+Tab` walk out of
the open overlay into the sidebar, composer, or main content, which is both an
accessibility defect and a UX surprise: the visible layer is the modal, but the
keyboard is driving the layer beneath it.

The existing [`useRestoreFocus`](../../../apps/fluux/src/hooks/useRestoreFocus.ts)
hook only reclaims focus when the OS window regains focus (WebKit/Tauri resets
`document.activeElement` to `<body>` on window blur). It does **not** intercept
Tab, so intra-window tabbing escapes the panel.

## Goal

While any modal, dialog, command palette, or overlay is open:

1. Focus is placed **on the panel** when it opens.
2. `Tab` / `Shift+Tab` cycle **only** through the panel's focusable elements —
   focus can never reach the interface beneath.
3. When the panel closes, focus **returns** to the element that was focused
   before it opened.

## Approach

A single small hook, `useFocusTrap`, applied centrally.

Rejected alternatives:

- **Add `focus-trap-react` / Radix / HeadlessUI** — the codebase deliberately
  carries no focus-trap dependency; the logic is ~40 lines.
- **Fold trapping into `useRestoreFocus`** — conflates window-blur restoration
  with Tab-trapping, and would not reach the portaled overlays that don't use
  that hook.

## Components

### `apps/fluux/src/hooks/focusable.ts` (new)

Extract the tab-order focusable machinery currently inlined in
`useRestoreFocus`:

```ts
export const FOCUSABLE_SELECTOR =
  'input:not([disabled]), textarea:not([disabled]), select:not([disabled]), ' +
  'a[href], button:not([disabled]), [tabindex]:not([tabindex="-1"])'

/** Focusable descendants of `container`, in DOM (tab) order. */
export function getFocusableElements(container: HTMLElement): HTMLElement[]
```

`useRestoreFocus` is updated to import from here (no behaviour change).

### `apps/fluux/src/hooks/useFocusTrap.ts` (new)

```ts
useFocusTrap<T extends HTMLElement>(
  containerRef: RefObject<T | null>,
  options?: {
    initialFocusRef?: RefObject<HTMLElement | null>
    active?: boolean // default true; lets a caller gate the trap
  },
)
```

Behaviour, all inside a single `useEffect` keyed on the container and `active`:

- **On activate:** capture `document.activeElement` as the return target. If
  focus is not already inside the container, move it to
  `initialFocusRef` → first focusable → the container itself (which is given
  `tabindex="-1"` when it has no focusable children).
- **Tab wrap:** a `keydown` listener attached **to the container element** (not
  `document`). This scoping means a stacked modal wins automatically — the lower
  modal's container never receives the event because focus lives in the top one.
  - `Tab` while the last focusable is active → `preventDefault`, focus first.
  - `Shift+Tab` while the first focusable is active → `preventDefault`, focus
    last.
  - No focusable children → `preventDefault`, keep focus on the container.
- **On deactivate / unmount:** restore focus to the captured return target, but
  only if it is still connected to the DOM and focusable (guard with
  `document.contains` / `isConnected`). Fires after the exit transition, since
  `ModalOverlay` unmounts the panel only after `useModalTransition` completes.

This hook owns *entering and leaving* the trap (initial focus in, Tab cycling,
return focus out). `useRestoreFocus` continues to own *staying in* across OS
window blur. The two compose without overlap.

### `apps/fluux/src/components/ModalOverlay.tsx`

Add one call next to the existing `useRestoreFocus`:

```ts
useFocusTrap(panelRef, { initialFocusRef: focusRef })
useRestoreFocus(panelRef, focusRef)
```

This single change covers every standard modal and dialog (all ~28 components
built on `ModalOverlay` / `ModalShell`) plus the command palette.

### Portaled overlays

These bypass `ModalOverlay`; add `useFocusTrap(ref)` to each:

- `apps/fluux/src/components/ui/BottomSheet.tsx`
- `apps/fluux/src/components/ImageLightbox.tsx`
- `apps/fluux/src/components/ImageContextMenu.tsx`
- `apps/fluux/src/components/conversation/UserInfoPopover.tsx`

Note on `UserInfoPopover` and `ImageContextMenu`: these are non-modal (they
dismiss on click-outside). A hard Tab-trap is slightly unconventional for a
popover, but full coverage was requested. They already close on Escape /
outside-click, so the trap only keeps Tab cycling while open.

## Testing

Unit test `apps/fluux/src/hooks/useFocusTrap.test.tsx` (jsdom — pin
`@vitest-environment jsdom`):

- On mount, focus lands inside the container (first focusable, or the
  `initialFocusRef` when provided).
- `Tab` keydown while the last focusable is active moves focus to the first.
- `Shift+Tab` keydown while the first focusable is active moves focus to the
  last.
- A container with no focusable children receives focus itself.
- On unmount, focus returns to the element focused before mount.

jsdom does not perform native tabbing, so tests drive focus with `.focus()` and
dispatch `Tab` `keydown` events, asserting the wrap our handler performs.

## Out of scope

- Reworking `useRestoreFocus`'s window-blur behaviour (unchanged).
- Any visual / animation changes to modals.
