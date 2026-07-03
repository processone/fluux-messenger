# Suppress Native Context Menu on Desktop - Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Suppress the raw WebView right-click menu on the packaged Fluux desktop app, everywhere except editable fields and active text selections.

**Architecture:** A pure predicate `shouldSuppressNativeMenu` decides per-event whether to suppress, and a thin hook `useNativeContextMenuSuppression` wires one `document` `contextmenu` listener (bubble phase, so it runs after React's own handlers) gated to `isTauri() && import.meta.env.PROD`. Wired once in `App.tsx`.

**Tech Stack:** React, TypeScript, Vitest (happy-dom env), Vite (`import.meta.env`).

## Global Constraints

- All work lives in `apps/fluux`. Run all commands from `apps/fluux`.
- Test env is happy-dom by default (`vitest.config.ts`); no per-file env override needed here.
- Reuse the existing `isTauri()` helper from `apps/fluux/src/utils/tauri.ts` - do not re-implement Tauri detection.
- No changes to `tauri.conf.json`.
- No em-dashes or en-dashes in any user-facing string (none are introduced here, but keep code comments plain too).

---

## File Structure

- **Create** `apps/fluux/src/hooks/useNativeContextMenuSuppression.ts` - the pure predicate `shouldSuppressNativeMenu` plus the `useNativeContextMenuSuppression` hook.
- **Create** `apps/fluux/src/hooks/useNativeContextMenuSuppression.test.ts` - unit tests for the predicate.
- **Modify** `apps/fluux/src/App.tsx` - call the hook once in the top-level `App` component.

---

### Task 1: Pure predicate `shouldSuppressNativeMenu` + tests

**Files:**
- Create: `apps/fluux/src/hooks/useNativeContextMenuSuppression.ts`
- Test: `apps/fluux/src/hooks/useNativeContextMenuSuppression.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `export function shouldSuppressNativeMenu(target: EventTarget | null, selection: Selection | null, defaultPrevented: boolean): boolean` - returns `true` when the native context menu should be suppressed.

- [ ] **Step 1: Write the failing test**

Create `apps/fluux/src/hooks/useNativeContextMenuSuppression.test.ts`:

```ts
import { describe, it, expect, afterEach } from 'vitest'
import { shouldSuppressNativeMenu } from './useNativeContextMenuSuppression'

/** Build a minimal Selection-like object over the contents of `node`. */
function selectionOver(node: Node, text = 'selected'): Selection {
  const range = document.createRange()
  range.selectNodeContents(node)
  return {
    isCollapsed: false,
    rangeCount: 1,
    toString: () => text,
    getRangeAt: () => range,
  } as unknown as Selection
}

describe('shouldSuppressNativeMenu', () => {
  afterEach(() => {
    document.body.innerHTML = ''
  })

  it('suppresses on a plain element', () => {
    const div = document.createElement('div')
    document.body.appendChild(div)
    expect(shouldSuppressNativeMenu(div, null, false)).toBe(true)
  })

  it('suppresses when target is not an element', () => {
    expect(shouldSuppressNativeMenu(null, null, false)).toBe(true)
    expect(shouldSuppressNativeMenu(new EventTarget(), null, false)).toBe(true)
  })

  it('allows on an input', () => {
    const input = document.createElement('input')
    document.body.appendChild(input)
    expect(shouldSuppressNativeMenu(input, null, false)).toBe(false)
  })

  it('allows on a textarea', () => {
    const ta = document.createElement('textarea')
    document.body.appendChild(ta)
    expect(shouldSuppressNativeMenu(ta, null, false)).toBe(false)
  })

  it('allows inside contenteditable="true"', () => {
    const ce = document.createElement('div')
    ce.setAttribute('contenteditable', 'true')
    const span = document.createElement('span')
    span.textContent = 'hi'
    ce.appendChild(span)
    document.body.appendChild(ce)
    expect(shouldSuppressNativeMenu(span, null, false)).toBe(false)
  })

  it('suppresses inside contenteditable="false"', () => {
    const ce = document.createElement('div')
    ce.setAttribute('contenteditable', 'false')
    const span = document.createElement('span')
    span.textContent = 'hi'
    ce.appendChild(span)
    document.body.appendChild(ce)
    expect(shouldSuppressNativeMenu(span, null, false)).toBe(true)
  })

  it('allows when a non-collapsed selection intersects the target', () => {
    const p = document.createElement('p')
    p.textContent = 'some words'
    document.body.appendChild(p)
    expect(shouldSuppressNativeMenu(p, selectionOver(p), false)).toBe(false)
  })

  it('suppresses when the selection is collapsed', () => {
    const p = document.createElement('p')
    p.textContent = 'some words'
    document.body.appendChild(p)
    const collapsed = { isCollapsed: true, rangeCount: 0, toString: () => '', getRangeAt: () => document.createRange() } as unknown as Selection
    expect(shouldSuppressNativeMenu(p, collapsed, false)).toBe(true)
  })

  it('suppresses when the selection is empty whitespace', () => {
    const p = document.createElement('p')
    p.textContent = 'some words'
    document.body.appendChild(p)
    expect(shouldSuppressNativeMenu(p, selectionOver(p, '   '), false)).toBe(true)
  })

  it('does not suppress when the event was already handled (defaultPrevented)', () => {
    const div = document.createElement('div')
    document.body.appendChild(div)
    expect(shouldSuppressNativeMenu(div, null, true)).toBe(false)
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd apps/fluux && npx vitest run src/hooks/useNativeContextMenuSuppression.test.ts`
Expected: FAIL - `shouldSuppressNativeMenu` is not exported / module not found.

- [ ] **Step 3: Write the minimal implementation**

Create `apps/fluux/src/hooks/useNativeContextMenuSuppression.ts`:

```ts
/**
 * Native context-menu suppression for the desktop app.
 *
 * On packaged Tauri builds we hide the raw WebView menu (Reload, Inspect
 * Element, Save Image As...) everywhere except where the native menu is
 * genuinely useful: editable fields and active text selections. Web / PWA
 * builds are never affected, and `tauri:dev` keeps the menu so right-click
 * Inspect Element still works while developing.
 */

/** True when an active, non-empty selection intersects the target element. */
function isTargetWithinSelection(target: Element, selection: Selection | null): boolean {
  if (!selection || selection.isCollapsed || selection.rangeCount === 0) return false
  if (selection.toString().trim() === '') return false
  return selection.getRangeAt(0).intersectsNode(target)
}

/**
 * Decide whether the native context menu should be suppressed for a
 * `contextmenu` event.
 *
 * Returns `false` (allow the native menu) when:
 * - the event was already handled by a component (`defaultPrevented`),
 * - the target is inside an `<input>`, `<textarea>`, or contenteditable region,
 * - the target falls within an active text selection.
 * Otherwise returns `true` (suppress).
 */
export function shouldSuppressNativeMenu(
  target: EventTarget | null,
  selection: Selection | null,
  defaultPrevented: boolean,
): boolean {
  if (defaultPrevented) return false
  if (!(target instanceof Element)) return true

  // Editable regions keep the native menu (cut / copy / paste / spellcheck).
  if (target.closest('input, textarea')) return false
  if (target instanceof HTMLElement && target.isContentEditable) return false

  // An active selection under the cursor keeps the native menu (copy).
  if (isTargetWithinSelection(target, selection)) return false

  return true
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd apps/fluux && npx vitest run src/hooks/useNativeContextMenuSuppression.test.ts`
Expected: PASS (all cases green, no stderr).

- [ ] **Step 5: Commit**

```bash
git add apps/fluux/src/hooks/useNativeContextMenuSuppression.ts apps/fluux/src/hooks/useNativeContextMenuSuppression.test.ts
git commit -m "feat(app): add shouldSuppressNativeMenu predicate for desktop context menu"
```

---

### Task 2: `useNativeContextMenuSuppression` hook + wire into App

**Files:**
- Modify: `apps/fluux/src/hooks/useNativeContextMenuSuppression.ts`
- Modify: `apps/fluux/src/App.tsx`

**Interfaces:**
- Consumes: `shouldSuppressNativeMenu` (Task 1); `isTauri` from `apps/fluux/src/utils/tauri.ts`.
- Produces: `export function useNativeContextMenuSuppression(): void` - registers/cleans up the global listener under the platform gate.

- [ ] **Step 1: Add the hook to the module**

Append to `apps/fluux/src/hooks/useNativeContextMenuSuppression.ts`. Add the imports at the top of the file:

```ts
import { useEffect } from 'react'
import { isTauri } from '../utils/tauri'
```

Add at the end of the file:

```ts
/**
 * Install a global `contextmenu` listener that suppresses the native WebView
 * menu on packaged desktop builds. No-op on web / PWA and on `tauri:dev`.
 *
 * The listener is attached to `document` in the bubble phase, so React's own
 * `onContextMenu` handlers (attached on the `#root` container) run first; any
 * component that already called `preventDefault` is respected via the
 * `defaultPrevented` check in `shouldSuppressNativeMenu`.
 */
export function useNativeContextMenuSuppression(): void {
  useEffect(() => {
    if (!isTauri() || !import.meta.env.PROD) return
    const handler = (event: MouseEvent) => {
      if (shouldSuppressNativeMenu(event.target, window.getSelection(), event.defaultPrevented)) {
        event.preventDefault()
      }
    }
    document.addEventListener('contextmenu', handler)
    return () => document.removeEventListener('contextmenu', handler)
  }, [])
}
```

- [ ] **Step 2: Typecheck the new module**

Run: `cd apps/fluux && npx tsc --noEmit`
Expected: no errors related to `useNativeContextMenuSuppression.ts` (a clean pass overall).

- [ ] **Step 3: Wire the hook into the App component**

In `apps/fluux/src/App.tsx`, add the import near the other hook imports:

```ts
import { useNativeContextMenuSuppression } from './hooks/useNativeContextMenuSuppression'
```

Then call it once inside the top-level `App` component, alongside the other top-level hook calls. Locate the App component body and add the call near the top of its hook block:

```ts
  useNativeContextMenuSuppression()
```

To find the anchor, run: `grep -n "^function App\|^export default function App\|const App" apps/fluux/src/App.tsx` and place the call just after the component's opening `{`, next to the existing top-level hooks (it takes no arguments and has no ordering dependency).

- [ ] **Step 4: Typecheck the wiring**

Run: `cd apps/fluux && npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 5: Run the full hook test + lint**

Run: `cd apps/fluux && npx vitest run src/hooks/useNativeContextMenuSuppression.test.ts && npm run lint`
Expected: tests PASS, lint clean.

- [ ] **Step 6: Commit**

```bash
git add apps/fluux/src/hooks/useNativeContextMenuSuppression.ts apps/fluux/src/App.tsx
git commit -m "feat(app): suppress native context menu on packaged desktop builds"
```

---

## Self-Review

**Spec coverage:**
- Editable / selection / already-handled / everything-else behavior → Task 1 predicate + tests. ✓
- Gating on `isTauri() && import.meta.env.PROD` → Task 2 hook. ✓
- Bubble-phase `document` listener relying on `defaultPrevented` → Task 2 hook + Task 1 `defaultPrevented` branch. ✓
- Wire once in `App.tsx` → Task 2 Step 3. ✓
- Pure-predicate unit tests (all spec cases) → Task 1 Step 1. ✓
- No `tauri.conf.json` change → respected. ✓

**Placeholder scan:** No TBD/TODO; all test and implementation code is complete and copy-paste ready.

**Type consistency:** `shouldSuppressNativeMenu(target, selection, defaultPrevented)` and `useNativeContextMenuSuppression()` names/signatures match between tasks and the spec. `isTargetWithinSelection` is file-private and consistent.

**Implementation note vs spec:** The spec listed `target.closest('input, textarea')` plus `target.isContentEditable`; the plan uses exactly that (guarded with `instanceof HTMLElement`). Equivalent behavior, verified to work under happy-dom.
