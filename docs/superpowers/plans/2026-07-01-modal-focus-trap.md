# Modal & Cmd-K Focus Trap Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Keep keyboard focus inside a modal / command palette / overlay while it is open, cycling Tab within it and returning focus to the opener on close.

**Architecture:** One small `useFocusTrap` hook applied centrally in `ModalOverlay` (covers all standard modals + Cmd-K) and in the four portaled overlays. A shared `focusable.ts` module supplies the focusable-element machinery to both `useFocusTrap` and the existing `useRestoreFocus`. `useFocusTrap` owns entering/leaving the trap (initial focus, Tab wrap, return focus); `useRestoreFocus` continues to own window-blur restoration.

**Tech Stack:** React 18, TypeScript, Vitest + Testing Library (jsdom), Tailwind.

## Global Constraints

- App code lives under `apps/fluux/src`. Run app tests per-workspace, not bare `vitest` from root.
- DOM/focus tests MUST pin `@vitest-environment jsdom` (the app default is happy-dom).
- No new dependencies — the codebase deliberately carries no focus-trap library.
- `ModalOverlay` is the single source of truth for modal chrome; do not duplicate its behaviour elsewhere.

---

### Task 1: Extract shared `focusable` helper

**Files:**
- Create: `apps/fluux/src/hooks/focusable.ts`
- Create: `apps/fluux/src/hooks/focusable.test.ts`
- Modify: `apps/fluux/src/hooks/useRestoreFocus.ts` (replace inlined selector with the import)

**Interfaces:**
- Produces: `FOCUSABLE_SELECTOR: string`, `getFocusableElements(container: HTMLElement): HTMLElement[]`

- [ ] **Step 1: Write the failing test**

Create `apps/fluux/src/hooks/focusable.test.ts`:

```ts
// @vitest-environment jsdom
import { describe, it, expect, afterEach } from 'vitest'
import { getFocusableElements } from './focusable'

function mount(html: string): HTMLElement {
  const root = document.createElement('div')
  root.innerHTML = html
  document.body.appendChild(root)
  return root
}

afterEach(() => {
  document.body.innerHTML = ''
})

describe('getFocusableElements', () => {
  it('returns focusable descendants in DOM order', () => {
    const root = mount(
      '<button>a</button><input /><a href="#">l</a>',
    )
    const els = getFocusableElements(root)
    expect(els.map((e) => e.tagName)).toEqual(['BUTTON', 'INPUT', 'A'])
  })

  it('excludes disabled and tabindex="-1" elements', () => {
    const root = mount(
      '<button disabled>a</button><button tabindex="-1">b</button><button>c</button>',
    )
    const els = getFocusableElements(root)
    expect(els).toHaveLength(1)
    expect(els[0].textContent).toBe('c')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/fluux && npx vitest run src/hooks/focusable.test.ts`
Expected: FAIL — cannot resolve `./focusable`.

- [ ] **Step 3: Create the helper**

Create `apps/fluux/src/hooks/focusable.ts`:

```ts
// Tab-order focusable elements, excluding programmatically-removed ones.
export const FOCUSABLE_SELECTOR =
  'input:not([disabled]), textarea:not([disabled]), select:not([disabled]), ' +
  'a[href], button:not([disabled]), [tabindex]:not([tabindex="-1"])'

/** Focusable descendants of `container`, in DOM (tab) order. */
export function getFocusableElements(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR))
}
```

- [ ] **Step 4: Point `useRestoreFocus` at the shared helper**

In `apps/fluux/src/hooks/useRestoreFocus.ts`, delete the local `FOCUSABLE_SELECTOR` const (lines 3-6) and add the import at the top:

```ts
import { FOCUSABLE_SELECTOR } from './focusable'
```

Leave the rest of the file unchanged (it references `FOCUSABLE_SELECTOR` at what is currently line 46).

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd apps/fluux && npx vitest run src/hooks/focusable.test.ts src/hooks/useRestoreFocus.test.ts`
Expected: PASS. (If `useRestoreFocus.test.ts` does not exist, run only `focusable.test.ts`.)

- [ ] **Step 6: Typecheck**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add apps/fluux/src/hooks/focusable.ts apps/fluux/src/hooks/focusable.test.ts apps/fluux/src/hooks/useRestoreFocus.ts
git commit -m "refactor(focus): extract shared focusable helper"
```

---

### Task 2: `useFocusTrap` hook

**Files:**
- Create: `apps/fluux/src/hooks/useFocusTrap.ts`
- Create: `apps/fluux/src/hooks/useFocusTrap.test.tsx`

**Interfaces:**
- Consumes: `getFocusableElements` from `./focusable` (Task 1).
- Produces: `useFocusTrap<T extends HTMLElement>(containerRef: RefObject<T | null>, options?: { initialFocusRef?: RefObject<HTMLElement | null>; active?: boolean }): void`

- [ ] **Step 1: Write the failing test**

Create `apps/fluux/src/hooks/useFocusTrap.test.tsx`:

```tsx
// @vitest-environment jsdom
import { describe, it, expect, afterEach } from 'vitest'
import { render, cleanup, fireEvent } from '@testing-library/react'
import { useRef } from 'react'
import { useFocusTrap } from './useFocusTrap'

afterEach(cleanup)

function Trap({ active = true }: { active?: boolean }) {
  const ref = useRef<HTMLDivElement>(null)
  useFocusTrap(ref, { active })
  return (
    <div ref={ref}>
      <button>first</button>
      <button>middle</button>
      <button>last</button>
    </div>
  )
}

describe('useFocusTrap', () => {
  it('moves focus into the container on mount', () => {
    const { getByText } = render(<Trap />)
    expect(document.activeElement).toBe(getByText('first'))
  })

  it('wraps Tab from the last element to the first', () => {
    const { getByText } = render(<Trap />)
    const last = getByText('last')
    last.focus()
    fireEvent.keyDown(last, { key: 'Tab' })
    expect(document.activeElement).toBe(getByText('first'))
  })

  it('wraps Shift+Tab from the first element to the last', () => {
    const { getByText } = render(<Trap />)
    const first = getByText('first')
    first.focus()
    fireEvent.keyDown(first, { key: 'Tab', shiftKey: true })
    expect(document.activeElement).toBe(getByText('last'))
  })

  it('focuses the container itself when it has no focusable children', () => {
    function Empty() {
      const ref = useRef<HTMLDivElement>(null)
      useFocusTrap(ref)
      return <div ref={ref} data-testid="empty" />
    }
    const { getByTestId } = render(<Empty />)
    expect(document.activeElement).toBe(getByTestId('empty'))
  })

  it('restores focus to the opener on unmount', () => {
    const opener = document.createElement('button')
    document.body.appendChild(opener)
    opener.focus()
    const { unmount } = render(<Trap />)
    expect(document.activeElement).not.toBe(opener)
    unmount()
    expect(document.activeElement).toBe(opener)
    opener.remove()
  })

  it('does nothing while inactive', () => {
    const opener = document.createElement('button')
    document.body.appendChild(opener)
    opener.focus()
    render(<Trap active={false} />)
    expect(document.activeElement).toBe(opener)
    opener.remove()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/fluux && npx vitest run src/hooks/useFocusTrap.test.tsx`
Expected: FAIL — cannot resolve `./useFocusTrap`.

- [ ] **Step 3: Implement the hook**

Create `apps/fluux/src/hooks/useFocusTrap.ts`:

```ts
import { useLayoutEffect, type RefObject } from 'react'
import { getFocusableElements } from './focusable'

interface FocusTrapOptions {
  /** Preferred element to focus on open; falls back to the first focusable
   *  element, then the container itself. */
  initialFocusRef?: RefObject<HTMLElement | null>
  /** Gate the trap (e.g. an overlay's `open`/`isOpen` flag). Default true. */
  active?: boolean
}

/**
 * Hard focus trap for an open modal / overlay:
 *
 * - moves focus into the container when it opens,
 * - cycles Tab / Shift+Tab within the container so focus never reaches the UI
 *   beneath it,
 * - returns focus to the element that was focused before it opened, on close.
 *
 * The keydown listener is attached to the container (not `document`), so a
 * stacked overlay wins automatically: the lower overlay's container never
 * receives the event because focus lives in the top one.
 *
 * Complements {@link useRestoreFocus}, which reclaims focus across OS window
 * blur; this hook owns entering and leaving the trap.
 */
export function useFocusTrap<T extends HTMLElement>(
  containerRef: RefObject<T | null>,
  { initialFocusRef, active = true }: FocusTrapOptions = {},
) {
  useLayoutEffect(() => {
    if (!active) return
    const container = containerRef.current
    if (!container) return

    // Captured before we move focus, so we can restore the opener on close.
    const previouslyFocused =
      document.activeElement instanceof HTMLElement &&
      !container.contains(document.activeElement)
        ? document.activeElement
        : null

    // Let the container hold focus itself when it has no focusable children, so
    // focus can never fall through to the page beneath.
    if (!container.hasAttribute('tabindex')) container.tabIndex = -1

    if (!container.contains(document.activeElement)) {
      const target =
        initialFocusRef?.current ?? getFocusableElements(container)[0] ?? container
      target.focus()
    }

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Tab') return
      const focusables = getFocusableElements(container)
      if (focusables.length === 0) {
        e.preventDefault()
        container.focus()
        return
      }
      const first = focusables[0]
      const last = focusables[focusables.length - 1]
      const activeEl = document.activeElement
      if (e.shiftKey && activeEl === first) {
        e.preventDefault()
        last.focus()
      } else if (!e.shiftKey && activeEl === last) {
        e.preventDefault()
        first.focus()
      }
    }

    container.addEventListener('keydown', handleKeyDown)

    return () => {
      container.removeEventListener('keydown', handleKeyDown)
      if (previouslyFocused?.isConnected) previouslyFocused.focus()
    }
  }, [containerRef, initialFocusRef, active])
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd apps/fluux && npx vitest run src/hooks/useFocusTrap.test.tsx`
Expected: PASS (all 6 cases).

- [ ] **Step 5: Typecheck**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add apps/fluux/src/hooks/useFocusTrap.ts apps/fluux/src/hooks/useFocusTrap.test.tsx
git commit -m "feat(focus): add useFocusTrap hook"
```

---

### Task 3: Wire the trap into `ModalOverlay`

This covers every standard modal, dialog, and the command palette (all built on `ModalOverlay`).

**Files:**
- Modify: `apps/fluux/src/components/ModalOverlay.tsx`
- Create: `apps/fluux/src/components/ModalOverlay.focustrap.test.tsx`

**Interfaces:**
- Consumes: `useFocusTrap` (Task 2).

- [ ] **Step 1: Write the failing test**

Create `apps/fluux/src/components/ModalOverlay.focustrap.test.tsx`:

```tsx
// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from 'vitest'
import { render, cleanup, fireEvent } from '@testing-library/react'
import { ModalOverlay } from './ModalOverlay'

afterEach(cleanup)

describe('ModalOverlay focus trap', () => {
  it('wraps Tab within the panel', () => {
    const { getByText } = render(
      <ModalOverlay onClose={vi.fn()}>
        <button>alpha</button>
        <button>omega</button>
      </ModalOverlay>,
    )
    const omega = getByText('omega')
    omega.focus()
    fireEvent.keyDown(omega, { key: 'Tab' })
    expect(document.activeElement).toBe(getByText('alpha'))
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/fluux && npx vitest run src/components/ModalOverlay.focustrap.test.tsx`
Expected: FAIL — Tab does not wrap (focus stays on `omega`).

- [ ] **Step 3: Add the hook**

In `apps/fluux/src/components/ModalOverlay.tsx`:

Add the import next to the other hook imports (near current line 9):

```ts
import { useFocusTrap } from '@/hooks/useFocusTrap'
```

Add the hook call immediately before the existing `useRestoreFocus(panelRef, focusRef)` (current line 100):

```ts
  // Trap Tab focus inside the panel and return focus to the opener on close.
  useFocusTrap(panelRef, { initialFocusRef: focusRef })
  // Keep keyboard focus inside the modal across OS window blur/refocus.
  useRestoreFocus(panelRef, focusRef)
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd apps/fluux && npx vitest run src/components/ModalOverlay.focustrap.test.tsx`
Expected: PASS.

- [ ] **Step 5: Guard against regressions in existing modal tests**

Run: `cd apps/fluux && npx vitest run src/components/CommandPalette src/components/ModalOverlay`
Expected: PASS (no regression from the added hook). Vitest skips any pattern with no matching test file, so this is safe even if one suite doesn't exist.

- [ ] **Step 6: Typecheck**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add apps/fluux/src/components/ModalOverlay.tsx apps/fluux/src/components/ModalOverlay.focustrap.test.tsx
git commit -m "feat(focus): trap focus in ModalOverlay (all modals + Cmd-K)"
```

---

### Task 4: Wire the trap into the portaled overlays

These bypass `ModalOverlay`. Each gets a `useFocusTrap` call gated on its open flag.

**Files:**
- Modify: `apps/fluux/src/components/ui/BottomSheet.tsx`
- Modify: `apps/fluux/src/components/ImageLightbox.tsx`
- Modify: `apps/fluux/src/components/ImageContextMenu.tsx`
- Modify: `apps/fluux/src/components/conversation/UserInfoPopover.tsx`

**Interfaces:**
- Consumes: `useFocusTrap` (Task 2).

- [ ] **Step 1: BottomSheet**

The panel `<div role="dialog">` currently has no ref. Add one and trap on `open`.

Add imports (BottomSheet currently imports `createPortal` from `react-dom`; it needs `useRef` from react and the hook):

```ts
import { useEffect, useRef } from 'react'
import { useFocusTrap } from '@/hooks/useFocusTrap'
```

(If `useEffect` is already imported from `'react'`, just add `useRef` to that import.)

Inside the component, before the `if (!open ...) return null` early return, add:

```ts
  const panelRef = useRef<HTMLDivElement>(null)
  useFocusTrap(panelRef, { active: open })
```

Attach the ref to the dialog panel (the `<div role="dialog" aria-modal="true" ...>`):

```tsx
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
```

- [ ] **Step 2: ImageLightbox**

The overlay is mounted only while shown, so `active` defaults to true. Trap the whole overlay container so the download/close buttons are inside.

Add imports:

```ts
import { useRef } from 'react'
import { useFocusTrap } from '@/hooks/useFocusTrap'
```

(Merge `useRef` into any existing `'react'` import.)

Inside the component (near the top, after the existing hooks), add:

```ts
  const overlayRef = useRef<HTMLDivElement>(null)
  useFocusTrap(overlayRef)
```

Attach the ref to the outer `createPortal` container div (`<div className="fixed inset-0 bg-black/90 ...">`):

```tsx
    <div
      ref={overlayRef}
      className="fixed inset-0 bg-black/90 flex flex-col items-center justify-center z-50"
    >
```

- [ ] **Step 3: ImageContextMenu**

It already has `menu.menuRef` and early-returns when closed. Trap on `menu.isOpen`, calling the hook before the early return.

Add import:

```ts
import { useFocusTrap } from '@/hooks/useFocusTrap'
```

Inside the component, before `if (!menu.isOpen) return null`, add:

```ts
  useFocusTrap(menu.menuRef, { active: menu.isOpen })
```

(No JSX change — the ref is already on the menu `<div ref={menu.menuRef}>`.)

- [ ] **Step 4: UserInfoPopover**

It already has `popoverRef` and renders the portal on `isOpen`. Trap on `isOpen`.

Add import:

```ts
import { useFocusTrap } from '@/hooks/useFocusTrap'
```

Inside the component, after the existing `useClickOutside(popoverRef, ...)` call, add:

```ts
  useFocusTrap(popoverRef, { active: isOpen })
```

(No JSX change — the ref is already on the popover `<div ref={popoverRef}>`.)

- [ ] **Step 5: Typecheck**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 6: Run the affected suites**

Run: `cd apps/fluux && npx vitest run src/components/ui/BottomSheet src/components/ImageLightbox src/components/ImageContextMenu src/components/conversation/UserInfoPopover`
Expected: PASS for any suites that exist; missing suites are simply skipped by vitest (no matching files). No new failures.

- [ ] **Step 7: Commit**

```bash
git add apps/fluux/src/components/ui/BottomSheet.tsx apps/fluux/src/components/ImageLightbox.tsx apps/fluux/src/components/ImageContextMenu.tsx apps/fluux/src/components/conversation/UserInfoPopover.tsx
git commit -m "feat(focus): trap focus in portaled overlays"
```

---

### Task 5: Full verification

**Files:** none (verification only).

- [ ] **Step 1: Typecheck**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 2: Lint**

Run: `npm run lint`
Expected: no errors, no stderr.

- [ ] **Step 3: Run the new + focus-related tests**

Run: `cd apps/fluux && npx vitest run src/hooks/focusable.test.ts src/hooks/useFocusTrap.test.tsx src/components/ModalOverlay.focustrap.test.tsx`
Expected: PASS.

- [ ] **Step 4: Run the app test suite**

Run: `cd apps/fluux && npx vitest run`
Expected: PASS, no stderr regressions.

- [ ] **Step 5: Manual/preview verification (demo mode)**

Start the dev server (`npm run dev`, open `http://localhost:5173/demo.html`) and confirm:
  1. Open the command palette (Cmd-K): focus is on the search input; Tab / Shift+Tab cycle only within the palette; Escape closes and focus returns to where it was.
  2. Open a standard modal (e.g. Add Contact): Tab cannot reach the sidebar/composer; closing returns focus to the opener.
  3. Open the image lightbox: Tab cycles between the download and close buttons only.

- [ ] **Step 6: Final commit (if any verification fixups were needed)**

Only if Steps 1-5 required changes:

```bash
git add -A
git commit -m "fix(focus): verification fixups for focus trap"
```
