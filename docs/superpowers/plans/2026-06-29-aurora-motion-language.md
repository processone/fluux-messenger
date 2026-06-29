# Aurora Motion Language Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the app a small named motion vocabulary (duration and easing tokens), migrate the existing animations onto it without changing their feel, and add graceful enter and exit animation to modals, dialogs, and the command palette.

**Architecture:** Two pieces. (1) A token layer: CSS custom properties in `index.css` `:root` plus matching Tailwind utilities, with existing animations rewritten to reference the named easings. (2) A modal motion layer: a shared `useModalTransition` hook that supplies enter and exit classes plus a `requestClose` wrapper that delays the real `onClose` so the exit animation can play, applied to the shared `ModalShell` and the four standalone dialog surfaces. New CSS keyframes drive the enter and exit. Everything is pure CSS gated by the existing `data-motion` switch; no animation library.

**Tech Stack:** React + TypeScript, Tailwind + CSS custom properties, Vitest + Testing Library (`renderHook`). No SDK changes.

## Global Constraints

- **Pure CSS only, no animation library.** All motion is CSS `@keyframes` / transitions plus the existing global `data-motion` gate. No new dependency. No SDK changes (no `build:sdk`).
- **Token values (exact):** `--fluux-duration-fast: 150ms`, `--fluux-duration-base: 200ms`, `--fluux-duration-slow: 300ms`, `--fluux-ease-standard: ease-out`, `--fluux-ease-emphasized: cubic-bezier(0.32, 0.72, 0, 1)`, `--fluux-ease-spring: cubic-bezier(0.34, 1.56, 0.64, 1)`. Defined in `:root` only (motion is global, never theme-overridden).
- **Feel-preserving migration.** Durations are NOT changed. Generic animations whose value already equals a token adopt that token; bespoke animations (drawer 220ms, FAB 0.4s/0.25s, reaction burst 450ms, highlight 1.5s, typing 1.2s, fall) keep their literal duration and only adopt the named easing token where one matches. `typing-dot` (ease-in-out) and `fall` (linear) have no token and are left untouched.
- **Modal exit = 150ms** (the `fast` duration); reduced motion skips the delay and closes instantly; a double-close must fire `onClose` only once.
- **No em-dashes or en-dashes** in any user-facing string (this slice adds no UI copy, but keep comments clean too per project convention).
- **Tests are unit-only.** Motion is transient and does not screenshot reliably. Proof is a static token guard plus hook and `ModalShell` behavior tests. Run app tests from `apps/fluux` (the repo-root vitest config lacks the `@` alias).

## File Structure

- Modify `apps/fluux/src/index.css`: add the six tokens to `:root`; migrate existing `animation:` shorthands onto the easing tokens; add the new modal keyframes and classes.
- Modify `apps/fluux/tailwind.config.js`: add `transitionDuration` and `transitionTimingFunction` named entries; rewrite the three existing `animation` shorthands to reference the vars.
- Create `apps/fluux/src/themes/motionTokens.test.ts`: static guard over `index.css` and `tailwind.config.js`.
- Modify `apps/fluux/src/components/conversation/MessageList.tsx`, `apps/fluux/src/components/Sidebar.tsx`, `apps/fluux/src/components/conversation/ReactionBurst.tsx`: migrate the component-level inline animations onto the tokens.
- Create `apps/fluux/src/hooks/useModalTransition.ts` + `apps/fluux/src/hooks/useModalTransition.test.ts`: the shared transition hook.
- Modify `apps/fluux/src/components/ModalShell.tsx` + `apps/fluux/src/components/ModalShell.test.tsx`: apply the hook (covers ~18 dialogs).
- Modify `apps/fluux/src/components/CommandPalette.tsx`, `apps/fluux/src/components/ConfirmDialog.tsx`, `apps/fluux/src/components/BackupPassphraseDialog.tsx`, `apps/fluux/src/components/AvatarCropModal.tsx`: apply the hook to the standalone surfaces.

---

### Task 1: Motion token vocabulary + CSS-layer migration

**Files:**
- Modify: `apps/fluux/src/index.css` (`:root` near line 133; `animation:` shorthands at lines 796, 797, 987, 1073, 1077)
- Modify: `apps/fluux/tailwind.config.js` (lines 69-87)
- Test: `apps/fluux/src/themes/motionTokens.test.ts`

**Interfaces:**
- Produces: CSS vars `--fluux-duration-fast|base|slow`, `--fluux-ease-standard|emphasized|spring`; Tailwind utilities `duration-fast|base|slow` and `ease-standard|emphasized|spring`.

- [ ] **Step 1: Write the failing guard test**

Create `apps/fluux/src/themes/motionTokens.test.ts`. It reads the source files from `process.cwd()` (the app runs vitest from `apps/fluux`; `import.meta.url` is not a `file://` path under vitest, so use the cwd-relative path):

```ts
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const css = readFileSync(join(process.cwd(), 'src/index.css'), 'utf-8')
const tw = readFileSync(join(process.cwd(), 'tailwind.config.js'), 'utf-8')

describe('motion tokens', () => {
  it('defines the duration and easing tokens in :root', () => {
    expect(css).toMatch(/--fluux-duration-fast:\s*150ms/)
    expect(css).toMatch(/--fluux-duration-base:\s*200ms/)
    expect(css).toMatch(/--fluux-duration-slow:\s*300ms/)
    expect(css).toMatch(/--fluux-ease-standard:\s*ease-out/)
    expect(css).toMatch(/--fluux-ease-emphasized:\s*cubic-bezier\(0\.32, 0\.72, 0, 1\)/)
    expect(css).toMatch(/--fluux-ease-spring:\s*cubic-bezier\(0\.34, 1\.56, 0\.64, 1\)/)
  })

  it('exposes the tokens as Tailwind utilities', () => {
    expect(tw).toMatch(/fast:\s*'var\(--fluux-duration-fast\)'/)
    expect(tw).toMatch(/base:\s*'var\(--fluux-duration-base\)'/)
    expect(tw).toMatch(/slow:\s*'var\(--fluux-duration-slow\)'/)
    expect(tw).toMatch(/standard:\s*'var\(--fluux-ease-standard\)'/)
    expect(tw).toMatch(/emphasized:\s*'var\(--fluux-ease-emphasized\)'/)
    expect(tw).toMatch(/spring:\s*'var\(--fluux-ease-spring\)'/)
  })

  it('migrates the drawer and bounce animations onto the easing/duration tokens', () => {
    // drawer keeps 220ms, adopts the emphasized easing token
    expect(css).toMatch(/\.animate-drawer-in\s*\{\s*animation:\s*drawer-in-end 220ms var\(--fluux-ease-emphasized\)/)
    // bounce migrates fully (0.3s = slow) onto tokens
    expect(css).toMatch(/\.bounce-top\s*\{\s*animation:\s*bounce-top var\(--fluux-duration-slow\) var\(--fluux-ease-standard\)/)
    // no bespoke bezier literal remains on the drawer shorthand
    expect(css).not.toMatch(/animation:\s*drawer-in-end 220ms cubic-bezier/)
  })
})
```

- [ ] **Step 2: Run it, verify it fails**

Run: `cd apps/fluux && npx vitest run src/themes/motionTokens.test.ts`
Expected: FAIL (tokens not defined yet, drawer still uses the literal bezier).

- [ ] **Step 3: Add the tokens to `:root`**

In `apps/fluux/src/index.css`, immediately after the Aurora identity block (after `--fluux-glass-blur: 12px;` at line 136), add:

```css

  /* ── Motion language: duration + easing tokens (global, never themed) ──
     Three durations and three easings form the app's motion vocabulary.
     Migrated animations reference these; new modal motion uses them natively.
     The reduced-motion gate ([data-motion="reduced"]) collapses all of it. */
  --fluux-duration-fast: 150ms;
  --fluux-duration-base: 200ms;
  --fluux-duration-slow: 300ms;
  --fluux-ease-standard: ease-out;
  --fluux-ease-emphasized: cubic-bezier(0.32, 0.72, 0, 1);
  --fluux-ease-spring: cubic-bezier(0.34, 1.56, 0.64, 1);
```

- [ ] **Step 4: Wire the tokens into Tailwind**

In `apps/fluux/tailwind.config.js`, add `transitionDuration` and `transitionTimingFunction` inside `theme.extend` (after the `fontFamily` block at line 68, before `keyframes`):

```js
      transitionDuration: {
        fast: 'var(--fluux-duration-fast)',
        base: 'var(--fluux-duration-base)',
        slow: 'var(--fluux-duration-slow)',
      },
      transitionTimingFunction: {
        standard: 'var(--fluux-ease-standard)',
        emphasized: 'var(--fluux-ease-emphasized)',
        spring: 'var(--fluux-ease-spring)',
      },
```

Then rewrite the three `animation` shorthands (lines 84-86) to reference the tokens (durations unchanged; `sheet-up` keeps its bespoke 220ms and adopts the emphasized easing):

```js
      animation: {
        'tooltip-in': 'tooltip-in var(--fluux-duration-fast) var(--fluux-ease-standard)',
        'toast-in': 'toast-in var(--fluux-duration-base) var(--fluux-ease-standard)',
        'sheet-up': 'sheet-up 220ms var(--fluux-ease-emphasized)',
      },
```

- [ ] **Step 5: Migrate the index.css animation shorthands**

In `apps/fluux/src/index.css`, edit these shorthands (durations unchanged, easing or duration swapped to tokens):

Lines 796-797 (drawer, keep 220ms, adopt emphasized easing):
```css
  .animate-drawer-in { animation: drawer-in-end 220ms var(--fluux-ease-emphasized); }
  [dir="rtl"] .animate-drawer-in { animation: drawer-in-end-rtl 220ms var(--fluux-ease-emphasized); }
```

Line 987 (message-highlight, keep 1.5s, adopt standard easing):
```css
  animation: message-highlight 1.5s var(--fluux-ease-standard);
```

Lines 1073 and 1077 (bounce, 0.3s = slow, full token migration):
```css
.bounce-top {
  animation: bounce-top var(--fluux-duration-slow) var(--fluux-ease-standard);
}
```
```css
.bounce-bottom {
  animation: bounce-bottom var(--fluux-duration-slow) var(--fluux-ease-standard);
}
```

Leave `typing-dot` (1.2s ease-in-out infinite, lines 1119/1124/1129) and `fall` (linear, line 1102) untouched: neither value maps to a token.

- [ ] **Step 6: Run the guard + typecheck**

Run: `cd apps/fluux && npx vitest run src/themes/motionTokens.test.ts` (expect PASS), then from repo root `npm run typecheck` (expect clean). Tailwind config changes need no build to typecheck.

- [ ] **Step 7: Commit**

```bash
git add apps/fluux/src/index.css apps/fluux/tailwind.config.js apps/fluux/src/themes/motionTokens.test.ts
git -c commit.gpgsign=false commit -m "feat(motion): duration + easing token vocabulary + migrate CSS animations"
```

---

### Task 2: Migrate component inline animations onto tokens

**Files:**
- Modify: `apps/fluux/src/components/conversation/MessageList.tsx:668` (message-send) and `:701-702` (FAB spring)
- Modify: `apps/fluux/src/components/Sidebar.tsx:419` (sidebar-view-enter)
- Modify: `apps/fluux/src/components/conversation/ReactionBurst.tsx:47` (reaction-burst)
- Test: `apps/fluux/src/themes/motionTokens.test.ts` (extend)

**Interfaces:**
- Consumes: the CSS vars from Task 1.

- [ ] **Step 1: Extend the guard test**

Append to `apps/fluux/src/themes/motionTokens.test.ts`:

```ts
describe('component animations reference motion tokens', () => {
  const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf-8')

  it('MessageList send + FAB animations use tokens', () => {
    const f = read('src/components/conversation/MessageList.tsx')
    expect(f).toMatch(/message-send var\(--fluux-duration-slow\) var\(--fluux-ease-standard\)/)
    expect(f).toMatch(/fab-spring-in_0\.4s_var\(--fluux-ease-spring\)_forwards/)
  })

  it('Sidebar view-enter uses tokens', () => {
    expect(read('src/components/Sidebar.tsx')).toMatch(/sidebar-view-enter var\(--fluux-duration-fast\) var\(--fluux-ease-standard\)/)
  })

  it('ReactionBurst uses the standard easing token', () => {
    expect(read('src/components/conversation/ReactionBurst.tsx')).toMatch(/reaction-burst \$\{DURATION_MS\}ms var\(--fluux-ease-standard\)/)
  })
})
```

- [ ] **Step 2: Run it, verify it fails**

Run: `cd apps/fluux && npx vitest run src/themes/motionTokens.test.ts -t "component animations"`
Expected: FAIL (components still use literals).

- [ ] **Step 3: Migrate MessageList**

In `apps/fluux/src/components/conversation/MessageList.tsx`, line 668, change the message-send inline style:
```tsx
                    style={msg.id === lastSentMessageId ? { animation: 'message-send var(--fluux-duration-slow) var(--fluux-ease-standard)' } : undefined}
```
Lines 701-702, change the FAB enter easing to the spring token (durations 0.4s/0.25s and the exit `ease-in` stay literal; only the spring easing tokenizes):
```tsx
            ? 'animate-[fab-spring-in_0.4s_var(--fluux-ease-spring)_forwards]'
            : 'animate-[fab-spring-out_0.25s_ease-in_forwards] pointer-events-none'
```

- [ ] **Step 4: Migrate Sidebar**

In `apps/fluux/src/components/Sidebar.tsx`, line 419:
```tsx
              <div key={sidebarView} className="h-full md:h-auto" style={{ animation: 'sidebar-view-enter var(--fluux-duration-fast) var(--fluux-ease-standard)' }}>
```

- [ ] **Step 5: Migrate ReactionBurst**

In `apps/fluux/src/components/conversation/ReactionBurst.tsx`, line 47 (keep the `DURATION_MS` template, swap `ease-out` to the token):
```tsx
              animation: `reaction-burst ${DURATION_MS}ms var(--fluux-ease-standard) forwards`,
```

- [ ] **Step 6: Run the guard + typecheck**

Run: `cd apps/fluux && npx vitest run src/themes/motionTokens.test.ts` (expect PASS), then `npm run typecheck` from repo root (expect clean).

- [ ] **Step 7: Commit**

```bash
git add apps/fluux/src/components/conversation/MessageList.tsx apps/fluux/src/components/Sidebar.tsx apps/fluux/src/components/conversation/ReactionBurst.tsx apps/fluux/src/themes/motionTokens.test.ts
git -c commit.gpgsign=false commit -m "refactor(motion): migrate component inline animations onto motion tokens"
```

---

### Task 3: `useModalTransition` hook

**Files:**
- Create: `apps/fluux/src/hooks/useModalTransition.ts`
- Test: `apps/fluux/src/hooks/useModalTransition.test.ts`

**Interfaces:**
- Produces: `useModalTransition(options?: { panelInClass?: string }): { panelClass: string; scrimClass: string; isClosing: boolean; requestClose: (onClose: () => void) => void }` and `MODAL_EXIT_MS = 150`.
- Reduced motion is detected from `document.documentElement`'s `data-motion` attribute (`'reduced'` / `'full'`), falling back to `matchMedia('(prefers-reduced-motion: reduce)')`.

- [ ] **Step 1: Write the failing tests**

Create `apps/fluux/src/hooks/useModalTransition.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { useModalTransition, MODAL_EXIT_MS } from './useModalTransition'

function setMotion(value: 'full' | 'reduced') {
  document.documentElement.setAttribute('data-motion', value)
}

describe('useModalTransition', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    setMotion('full')
  })
  afterEach(() => {
    vi.useRealTimers()
    document.documentElement.removeAttribute('data-motion')
  })

  it('starts with the enter classes and not closing', () => {
    const { result } = renderHook(() => useModalTransition())
    expect(result.current.panelClass).toBe('modal-panel-in')
    expect(result.current.scrimClass).toBe('scrim-in')
    expect(result.current.isClosing).toBe(false)
  })

  it('honors a custom enter class', () => {
    const { result } = renderHook(() => useModalTransition({ panelInClass: 'command-palette-in' }))
    expect(result.current.panelClass).toBe('command-palette-in')
  })

  it('plays the exit then calls onClose after the exit duration (motion full)', () => {
    const onClose = vi.fn()
    const { result } = renderHook(() => useModalTransition())
    act(() => result.current.requestClose(onClose))
    expect(result.current.panelClass).toBe('modal-panel-out')
    expect(result.current.scrimClass).toBe('scrim-out')
    expect(onClose).not.toHaveBeenCalled()
    act(() => { vi.advanceTimersByTime(MODAL_EXIT_MS) })
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('closes immediately with no exit when motion is reduced', () => {
    setMotion('reduced')
    const onClose = vi.fn()
    const { result } = renderHook(() => useModalTransition())
    act(() => result.current.requestClose(onClose))
    expect(onClose).toHaveBeenCalledTimes(1)
    expect(result.current.isClosing).toBe(false)
  })

  it('guards against a double close', () => {
    const onClose = vi.fn()
    const { result } = renderHook(() => useModalTransition())
    act(() => {
      result.current.requestClose(onClose)
      result.current.requestClose(onClose)
    })
    act(() => { vi.advanceTimersByTime(MODAL_EXIT_MS) })
    expect(onClose).toHaveBeenCalledTimes(1)
  })
})
```

- [ ] **Step 2: Run it, verify it fails**

Run: `cd apps/fluux && npx vitest run src/hooks/useModalTransition.test.ts`
Expected: FAIL (module does not exist).

- [ ] **Step 3: Implement the hook**

Create `apps/fluux/src/hooks/useModalTransition.ts`:

```ts
import { useCallback, useRef, useState } from 'react'

/** Exit animation duration. Matches --fluux-duration-fast in index.css. */
export const MODAL_EXIT_MS = 150

/** Whether motion should be suppressed: explicit data-motion wins, else the OS query. */
function isReducedMotion(): boolean {
  const attr = document.documentElement.getAttribute('data-motion')
  if (attr === 'reduced') return true
  if (attr === 'full') return false
  return (
    typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches
  )
}

interface ModalTransitionOptions {
  /** Override the enter animation class (e.g. the command palette's drop). */
  panelInClass?: string
}

/**
 * Drives a modal's enter and exit animation. The panel and scrim get enter
 * classes on mount; `requestClose` swaps to the exit classes, then calls the
 * caller's `onClose` after the exit animation (so the parent unmounts on
 * schedule). When motion is reduced the exit is skipped and onClose fires at
 * once. A double close fires onClose only once.
 */
export function useModalTransition(options?: ModalTransitionOptions) {
  const [isClosing, setIsClosing] = useState(false)
  const closingRef = useRef(false)

  const requestClose = useCallback((onClose: () => void) => {
    if (closingRef.current) return
    closingRef.current = true
    if (isReducedMotion()) {
      onClose()
      return
    }
    setIsClosing(true)
    setTimeout(onClose, MODAL_EXIT_MS)
  }, [])

  const panelClass = isClosing ? 'modal-panel-out' : (options?.panelInClass ?? 'modal-panel-in')
  const scrimClass = isClosing ? 'scrim-out' : 'scrim-in'

  return { panelClass, scrimClass, isClosing, requestClose }
}
```

- [ ] **Step 4: Run the tests + typecheck**

Run: `cd apps/fluux && npx vitest run src/hooks/useModalTransition.test.ts` (expect PASS), then `npm run typecheck` from repo root (expect clean).

- [ ] **Step 5: Commit**

```bash
git add apps/fluux/src/hooks/useModalTransition.ts apps/fluux/src/hooks/useModalTransition.test.ts
git -c commit.gpgsign=false commit -m "feat(motion): useModalTransition hook (enter/exit + delayed close)"
```

---

### Task 4: Modal keyframes + apply to ModalShell

**Files:**
- Modify: `apps/fluux/src/index.css` (add modal keyframes after the FAB block, around line 1197)
- Modify: `apps/fluux/src/components/ModalShell.tsx`
- Test: `apps/fluux/src/components/ModalShell.test.tsx`

**Interfaces:**
- Consumes: `useModalTransition` (Task 3); the duration/easing tokens (Task 1).
- Produces: CSS classes `modal-panel-in`, `modal-panel-out`, `scrim-in`, `scrim-out`, `command-palette-in` (the last consumed in Task 5).

- [ ] **Step 1: Add the modal keyframes to index.css**

In `apps/fluux/src/index.css`, after the `fab-spring-out` block (after line 1197), add. The panel animates transform only (scale); the scrim layer carries the fade, so the panel is not double-faded. `forwards` on the exits holds the final frame during the brief unmount delay.

```css

/* Modal / dialog / command-palette enter + exit (Aurora motion language).
   The scrim layer fades (opacity); the panel scales (transform) so the two
   compose without double-fading the panel. Exits use `forwards` to hold the
   end frame for the ~150ms before the component unmounts. */
@keyframes modal-panel-in  { from { transform: scale(0.97); } to { transform: scale(1); } }
@keyframes modal-panel-out { from { transform: scale(1); }    to { transform: scale(0.98); } }
@keyframes command-palette-in { from { transform: translateY(-8px) scale(0.98); } to { transform: translateY(0) scale(1); } }
@keyframes scrim-in  { from { opacity: 0; } to { opacity: 1; } }
@keyframes scrim-out { from { opacity: 1; } to { opacity: 0; } }

.modal-panel-in     { animation: modal-panel-in var(--fluux-duration-base) var(--fluux-ease-emphasized); }
.modal-panel-out    { animation: modal-panel-out var(--fluux-duration-fast) var(--fluux-ease-standard) forwards; }
.command-palette-in { animation: command-palette-in var(--fluux-duration-base) var(--fluux-ease-emphasized); }
.scrim-in  { animation: scrim-in var(--fluux-duration-base) var(--fluux-ease-standard); }
.scrim-out { animation: scrim-out var(--fluux-duration-fast) var(--fluux-ease-standard) forwards; }
```

- [ ] **Step 2: Write the failing ModalShell tests**

Replace the body of the existing test file or add a new `describe` to `apps/fluux/src/components/ModalShell.test.tsx`. (Read the existing file first to reuse its render setup and i18n mock.) Add:

```tsx
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { ModalShell } from './ModalShell'

function setMotion(value: 'full' | 'reduced') {
  document.documentElement.setAttribute('data-motion', value)
}

describe('ModalShell motion', () => {
  beforeEach(() => { vi.useFakeTimers(); setMotion('full') })
  afterEach(() => { vi.useRealTimers(); document.documentElement.removeAttribute('data-motion') })

  it('renders the enter classes on mount', () => {
    const { container } = render(<ModalShell title="T" onClose={() => {}}>body</ModalShell>)
    expect(container.querySelector('.scrim-in')).toBeTruthy()
    expect(container.querySelector('.modal-panel-in')).toBeTruthy()
  })

  it('plays the exit then calls onClose after the delay (motion full)', () => {
    const onClose = vi.fn()
    const { container } = render(<ModalShell title="T" onClose={onClose}>body</ModalShell>)
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(onClose).not.toHaveBeenCalled()
    expect(container.querySelector('.modal-panel-out')).toBeTruthy()
    vi.advanceTimersByTime(150)
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('closes immediately when motion is reduced', () => {
    setMotion('reduced')
    const onClose = vi.fn()
    render(<ModalShell title="T" onClose={onClose}>body</ModalShell>)
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(onClose).toHaveBeenCalledTimes(1)
  })
})
```

- [ ] **Step 3: Run them, verify they fail**

Run: `cd apps/fluux && npx vitest run src/components/ModalShell.test.tsx`
Expected: FAIL (no enter classes; Escape calls onClose synchronously).

- [ ] **Step 4: Apply the hook in ModalShell**

In `apps/fluux/src/components/ModalShell.tsx`, import the hook and route close through it. Full updated component body (the render and Escape handler change; the scrim div gets `scrimClass`, the panel div gets `panelClass`, and every close path calls `close`):

```tsx
import { useEffect, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { X } from 'lucide-react'
import { Tooltip } from './Tooltip'
import { useRestoreFocus } from '@/hooks/useRestoreFocus'
import { useModalTransition } from '@/hooks/useModalTransition'

interface ModalShellProps {
  title: React.ReactNode
  onClose: () => void
  /** Tailwind width class for the panel, e.g. 'max-w-sm' (default), 'max-w-md', 'w-80' */
  width?: string
  /** Extra classes on the panel div, e.g. 'max-h-[80vh]' */
  panelClassName?: string
  children: React.ReactNode
}

export function ModalShell({
  title,
  onClose,
  width = 'max-w-sm',
  panelClassName,
  children,
}: ModalShellProps) {
  const { t } = useTranslation()
  const panelRef = useRef<HTMLDivElement>(null)
  const { panelClass, scrimClass, requestClose } = useModalTransition()
  const close = () => requestClose(onClose)

  useRestoreFocus(panelRef)

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close()
    }
    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return (
    <div
      data-modal="true"
      className={`fixed inset-0 modal-scrim flex items-center justify-center z-50 ${scrimClass}`}
    >
      <button
        type="button"
        aria-hidden="true"
        tabIndex={-1}
        onClick={close}
        className="absolute inset-0 cursor-default"
      />
      <div ref={panelRef} className={`relative z-10 fluux-glass rounded-lg w-full ${width} mx-4 ${panelClass} ${panelClassName ?? ''}`}>
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-fluux-hover flex-shrink-0">
          <h2 className="text-lg font-semibold text-fluux-text">{title}</h2>
          <Tooltip content={t('common.close')}>
            <button
              onClick={close}
              aria-label={t('common.close')}
              className="p-1 text-fluux-muted hover:text-fluux-text rounded hover:bg-fluux-hover tap-target"
            >
              <X className="size-4" />
            </button>
          </Tooltip>
        </div>

        {children}
      </div>
    </div>
  )
}
```

Note: the Escape effect now depends on a fresh `close` each render but uses an empty dep array with the eslint-disable so the listener is bound once; `requestClose` is stable (`useCallback`) and `onClose` is captured per render, which is correct because the close path reads the latest `onClose` through the closure at call time. If the existing lint config forbids the disable comment, instead wrap `close` in `useCallback(() => requestClose(onClose), [requestClose, onClose])` and depend on it.

- [ ] **Step 5: Run the tests + typecheck**

Run: `cd apps/fluux && npx vitest run src/components/ModalShell.test.tsx` (expect PASS), then `npm run typecheck` from repo root (expect clean).

- [ ] **Step 6: Commit**

```bash
git add apps/fluux/src/index.css apps/fluux/src/components/ModalShell.tsx apps/fluux/src/components/ModalShell.test.tsx
git -c commit.gpgsign=false commit -m "feat(motion): modal enter/exit keyframes + apply to ModalShell"
```

---

### Task 5: Apply enter-exit to the four standalone dialogs

**Files:**
- Modify: `apps/fluux/src/components/ConfirmDialog.tsx`, `apps/fluux/src/components/CommandPalette.tsx`, `apps/fluux/src/components/BackupPassphraseDialog.tsx`, `apps/fluux/src/components/AvatarCropModal.tsx`

**Interfaces:**
- Consumes: `useModalTransition` (Task 3); the keyframe classes incl. `command-palette-in` (Task 4).

Each dialog has its own scrim container and panel and calls `onClose`/`onCancel` from multiple places (Escape handler, backdrop button, close button, action handlers). The change is uniform: add the hook, put `scrimClass` on the scrim container and `panelClass` on the panel, and route every close path through `requestClose`.

- [ ] **Step 1: ConfirmDialog (the worked example)**

In `apps/fluux/src/components/ConfirmDialog.tsx`: import the hook; derive `cancel`; apply classes; route Escape and the backdrop/cancel buttons through `cancel`. (The Confirm button still calls `onConfirm` directly: confirming is the caller's action, which unmounts the dialog itself.)

```tsx
import { useEffect, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { useRestoreFocus } from '@/hooks/useRestoreFocus'
import { useModalTransition } from '@/hooks/useModalTransition'
```
Inside the component, after `const panelRef = useRef...`:
```tsx
  const { panelClass, scrimClass, requestClose } = useModalTransition()
  const cancel = () => requestClose(onCancel)
```
Change the Escape handler (line 30) to `if (e.key === 'Escape') cancel()` and drop `onCancel` from the dep array (use `[]` with an eslint-disable, mirroring ModalShell). Change the scrim container (line 43) to append `${scrimClass}`, the backdrop button `onClick` (line 49) to `cancel`, the panel div (line 52) to append `${panelClass}`, and the footer Cancel button `onClick` (line 57) to `cancel`.

- [ ] **Step 2: CommandPalette (uses the drop variant)**

In `apps/fluux/src/components/CommandPalette.tsx`: import the hook; `const { panelClass, scrimClass, requestClose } = useModalTransition({ panelInClass: 'command-palette-in' })`. Add `const close = () => requestClose(onClose)`.

The palette calls `onClose()` from many action handlers (lines 219, 291, 352-358, 474, 502). Those are post-action dismissals where the panel unmounts anyway; route the user-driven dismissals (the Escape handler and the backdrop click at line 532) through `close`, and leave the action-completion `onClose()` calls as-is (an action that navigates away does not need the 150ms exit). Concretely: find the Escape `onClose()` and the backdrop button `onClick={onClose}` (line 532) and change them to `close`. Apply `${scrimClass}` to the scrim container (line 526) and `${panelClass}` to the panel (line 539).

- [ ] **Step 3: BackupPassphraseDialog**

In `apps/fluux/src/components/BackupPassphraseDialog.tsx`: import the hook; `const { panelClass, scrimClass, requestClose } = useModalTransition()`; `const cancel = () => requestClose(onCancel)`. The Escape handler (line 89) keeps its `!isPublishing` guard: `if (e.key === 'Escape' && !isPublishing) cancel()`. Apply `${scrimClass}` to the scrim container (line 146), `${panelClass}` to the panel (line 156), and route the backdrop button (line 153) and the footer cancel button (line 267) `onClick` through `cancel`. Leave the publish/confirm path calling its own handler.

- [ ] **Step 4: AvatarCropModal**

In `apps/fluux/src/components/AvatarCropModal.tsx`: import the hook; `const { panelClass, scrimClass, requestClose } = useModalTransition()`; `const close = () => requestClose(onClose)`. It early-returns `null` when `!isOpen` (line 358), so it follows the same pattern: `requestClose` delays `onClose`, and the component stays mounted (still `isOpen`) through the exit. The scrim is `bg-black/70` (kept for image contrast); append `${scrimClass}` to it (line 361) so the backdrop fades, and `${panelClass}` to the panel (line 362). Route the header close button (line 368) and the footer cancel button (line 565) through `close`. Leave the Save path (line 350 region) calling `onClose()` after a successful save (it is an action completion).

- [ ] **Step 5: Typecheck + run the affected suites**

Run from repo root: `npm run typecheck` (expect clean). Then `cd apps/fluux && npx vitest run src/components/CommandPalette.test.tsx src/components/AvatarCropModal.test.tsx 2>/dev/null` if those tests exist (some may not); they must stay green. Any test asserting a synchronous `onClose` on Escape/backdrop is updated to advance timers by 150ms first (motion full) or set `data-motion="reduced"`.

- [ ] **Step 6: Commit**

```bash
git add apps/fluux/src/components/ConfirmDialog.tsx apps/fluux/src/components/CommandPalette.tsx apps/fluux/src/components/BackupPassphraseDialog.tsx apps/fluux/src/components/AvatarCropModal.tsx
git -c commit.gpgsign=false commit -m "feat(motion): enter/exit animation for the standalone dialogs"
```

---

### Task 6: Verification

**Files:** none (verification only).

- [ ] **Step 1: Full gate**

Run from repo root: `npm run typecheck` (clean), `npm run lint` (0 errors), `npm test` (all pass, no new failures). Confirm `motionTokens.test.ts`, `useModalTransition.test.ts`, and `ModalShell.test.tsx` are green, and that the existing animation/modal tests still pass.

- [ ] **Step 2: Confirm the onClose-timing risk is clear**

Grep the `onClose`/`onCancel` callers of the touched dialogs for any that rely on a synchronous side effect at close time (a save, a navigation, a store write that must happen before the 150ms). Expected: none; every caller just flips an `isOpen`/visibility state. Record the finding (the spec flagged this as the one behavior change to verify).

```bash
grep -rn "onClose=\|onCancel=" apps/fluux/src/components | grep -iE "ConfirmDialog|BackupPassphrase|AvatarCrop|CommandPalette|ModalShell" | head -40
```

- [ ] **Step 3: No screenshot scene**

Motion does not screenshot reliably (a modal mid-enter is not a stable capture; the resting state is unchanged from today). Do NOT add a screenshot scene. The unit tests carry the proof. Note this in the report.

- [ ] **Step 4: Commit (if anything was adjusted)**

If Step 2 surfaced a caller needing a synchronous close (unexpected), fix it and commit; otherwise nothing to commit (verification only).

---

## Self-Review notes

- **Spec coverage:** token vocabulary (Task 1) · Tailwind wiring (Task 1) · feel-preserving CSS migration (Task 1) · component-inline migration (Task 2) · `useModalTransition` hook with reduced-motion + double-close guards (Task 3) · ModalShell enter/exit covering ~18 dialogs (Task 4) · the 4 standalone dialogs incl. the command-palette drop (Task 5) · risk verification + unit-test-only proof + no screenshot (Task 6). All spec sections covered.
- **Type consistency:** `useModalTransition(options?: { panelInClass?: string })` returns `{ panelClass, scrimClass, isClosing, requestClose }` and `MODAL_EXIT_MS` (150) consistently across Tasks 3, 4, 5. Class names `modal-panel-in/out`, `scrim-in/out`, `command-palette-in` defined in Task 4, consumed in Tasks 4 and 5.
- **Token value consistency:** the same six token values appear in the Global Constraints, the Task 1 `:root` block, the Task 1 guard test, and the Tailwind wiring. `MODAL_EXIT_MS` (150) equals `--fluux-duration-fast` and the exit keyframe duration.
- **Known risk flagged:** `ModalShell.onClose` now fires 150ms later; Task 6 Step 2 verifies no caller depends on a synchronous close.
- **No SDK change** so no `build:sdk`.
