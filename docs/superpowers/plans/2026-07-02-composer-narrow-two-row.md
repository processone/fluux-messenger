# Composer two-row layout on narrow widths — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** On narrow composer widths, put the text field on its own full-width first line and drop the action buttons to a toolbar row below; keep the current single row above the breakpoint.

**Architecture:** Convert the composer's action row from flexbox to a CSS grid with named areas. The card becomes a container-query context; a `@container (min-width: …)` rule swaps the grid template between two-row (default) and single-row (wide). Grid placement is by `grid-area`, so the same DOM reflows with no JavaScript and no component state.

**Tech Stack:** React, Tailwind v4 (container queries), plain CSS in `apps/fluux/src/index.css`, Vitest + Testing Library.

## Global Constraints

- Container-query convention matches the header overflow kebab: `@container` context on a parent, mobile-first `@[Wpx]:` / `@container (min-width: Wpx)` overrides (`apps/fluux/src/components/header/headerOverflow.ts`).
- No new component state, no JS measurement for the reflow (the layout is pure CSS).
- Desktop/wide layout must remain visually identical to today.
- The five grid-area names are fixed and must match between the CSS template and the JSX: `add`, `lock`, `input`, `emoji`, `send`.
- App tests run in the app workspace (happy-dom); this is a class-string assertion test, no container-query evaluation needed.

---

## File Structure

- `apps/fluux/src/index.css` — add `container-type` to `.composer-card`; add the `.composer-actions` grid rules + `@container` override.
- `apps/fluux/src/components/MessageComposer.tsx` — swap the action row's `flex items-center` for `composer-actions`; add `[grid-area:…]` classes to the five children.
- `apps/fluux/src/components/MessageComposer.layout.test.tsx` — new render test asserting the grid classes are wired (jsdom-safe class-string assertions).

---

### Task 1: Responsive two-row composer layout

**Files:**
- Create: `apps/fluux/src/components/MessageComposer.layout.test.tsx`
- Modify: `apps/fluux/src/index.css` (`.composer-card` rule ~934; add `.composer-actions` rules)
- Modify: `apps/fluux/src/components/MessageComposer.tsx:859` (action row + children ~859–999)

**Interfaces:**
- Consumes: nothing new — `MessageComposer` public props unchanged.
- Produces: CSS class `composer-actions` (grid row) and per-control `[grid-area:add|lock|input|emoji|send]` utility classes; `.composer-card` gains `container-type: inline-size`.

- [ ] **Step 1: Write the failing test**

Create `apps/fluux/src/components/MessageComposer.layout.test.tsx`:

```tsx
import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { MessageComposer } from './MessageComposer'

describe('MessageComposer responsive layout', () => {
  const onSend = vi.fn().mockResolvedValue(true)

  it('lays the action row out as a grid with named areas', () => {
    render(<MessageComposer placeholder="Type a message" onSend={onSend} />)

    const textarea = screen.getByPlaceholderText('Type a message')
    const row = textarea.closest('.composer-actions')
    expect(row).not.toBeNull()

    // The text field occupies the `input` grid area.
    expect(textarea.className).toContain('[grid-area:input]')

    // The flanking controls carry their own grid areas so the template can
    // place them on either one row (wide) or two rows (narrow).
    expect(row!.innerHTML).toContain('grid-area:add')
    expect(row!.innerHTML).toContain('grid-area:emoji')
    expect(row!.innerHTML).toContain('grid-area:send')
  })

  it('places the encryption lock in the `lock` grid area when encrypted', () => {
    render(
      <MessageComposer
        placeholder="Type a message"
        onSend={onSend}
        encryptionState={{ kind: 'encrypted', trust: 'unverified' }}
      />
    )

    const row = screen.getByPlaceholderText('Type a message').closest('.composer-actions')
    expect(row!.innerHTML).toContain('grid-area:lock')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/fluux && npx vitest run src/components/MessageComposer.layout.test.tsx`
Expected: FAIL — `row` is `null` (the action row still uses `flex items-center`, not `composer-actions`), and the `[grid-area:…]` tokens are absent.

- [ ] **Step 3: Add the grid CSS**

In `apps/fluux/src/index.css`, add `container-type: inline-size` to the existing `.composer-card` rule (~line 934):

```css
.composer-card {
  container-type: inline-size;
  border: 1px solid var(--fluux-border);
  border-radius: var(--fluux-radius-l);
}
```

Then, immediately after the `.composer-card:focus-within` rule, add the grid:

```css
/* Composer action row. One row when the card is wide enough; on narrow widths
 * (phone, narrowed pane) the text field takes the full first line and the
 * controls drop to a toolbar row below — `add`/`lock` at the inline-start,
 * `emoji`/`send` grouped at the inline-end (same order as the wide row).
 * Container-query driven off `.composer-card`; no JS. RTL mirrors automatically
 * because grid-template-areas follows the inline axis. */
.composer-actions {
  display: grid;
  align-items: center;
  grid-template-columns: auto auto 1fr auto auto;
  grid-template-areas:
    "input input input input input"
    "add   lock  .     emoji send";
}
@container (min-width: 420px) {
  .composer-actions {
    grid-template-areas: "add lock input emoji send";
  }
}
```

Note: both templates use the same 5 columns. When there is no lock element, its `auto` column collapses to 0 width, so there is no gap. The `.` cell (the `1fr` column) is the flexible spacer that pushes `emoji`/`send` to the inline-end in the two-row layout.

- [ ] **Step 4: Wire the grid-area classes in `MessageComposer.tsx`**

Make these edits inside the render (all within the `~859–999` action-row block):

1. Action row container (line ~859):
```tsx
      <div className="composer-actions">
```
(was `<div className="flex items-center">`)

2. Attach-menu wrapper (line ~869):
```tsx
        <div className="relative [grid-area:add]" ref={attachMenuRef}>
```
(was `<div className="relative" ref={attachMenuRef}>`)

3. Leading encryption lock — both branches (lines ~929 and ~939). Add `[grid-area:lock]` to each:
```tsx
            <button
              type="button"
              data-encryption-lock
              onClick={onEncryptionClick}
              aria-label={lockInfo.label}
              className="p-1.5 flex-shrink-0 rounded-lg hover:bg-fluux-bg transition-colors [grid-area:lock]"
            >
```
```tsx
            <span data-encryption-lock aria-label={lockInfo.label} className="p-1.5 flex-shrink-0 [grid-area:lock]">
```

4. Input — default path: in `defaultRenderInput()` (line ~662), append `[grid-area:input]` to the TextArea className:
```tsx
      className={`${MESSAGE_INPUT_BASE_CLASSES} ${MESSAGE_INPUT_TEXT_CLASSES} [grid-area:input]`}
```

5. Input — custom `renderInput` wrapper (line ~947): replace `flex-1` with the grid area (keep `min-w-0`):
```tsx
          <div className="[grid-area:input] min-w-0 flex items-center relative">
```
(was `<div className="flex-1 min-w-0 flex items-center relative">`)

6. Emoji wrapper (line ~964):
```tsx
        <div className="relative [grid-area:emoji]" ref={emojiPickerRef}>
```
(was `<div className="relative" ref={emojiPickerRef}>`)

7. Send button (line ~988): append `[grid-area:send]` to its className (keep the existing classes, including `m-1`):
```tsx
          className="group/send relative m-1 p-2.5 rounded-xl tap-target flex items-center justify-center
                     bg-fluux-brand text-white hover:bg-fluux-brand-hover
                     disabled:bg-transparent disabled:text-fluux-muted disabled:cursor-not-allowed
                     transition-colors [grid-area:send]"
```

Leave the hidden file input (`className="hidden"`, line ~861) unchanged — `display:none` excludes it from grid placement.

- [ ] **Step 5: Run the layout test to verify it passes**

Run: `cd apps/fluux && npx vitest run src/components/MessageComposer.layout.test.tsx`
Expected: PASS (both tests).

- [ ] **Step 6: Run the full composer suite + typecheck**

Run: `cd apps/fluux && npx vitest run src/components/MessageComposer && npm run typecheck`
Expected: All existing MessageComposer tests (typing throttle, autosize, offline) still PASS; typecheck clean. The autosize tests must stay green — the width `ResizeObserver` path is unchanged; only the input's container changed from a flex child to a grid child (both give it a measurable width).

- [ ] **Step 7: Commit**

```bash
git add apps/fluux/src/index.css apps/fluux/src/components/MessageComposer.tsx apps/fluux/src/components/MessageComposer.layout.test.tsx
git commit -m "feat(composer): two-row layout on narrow widths"
```

---

### Task 2: Live-verify and tune the breakpoint

**Files:**
- Modify (only if tuning needed): `apps/fluux/src/index.css` (the `@container (min-width: 420px)` value)

**Interfaces:**
- Consumes: the `.composer-actions` grid from Task 1.
- Produces: a tuned breakpoint value (or confirmation that 420px is right).

- [ ] **Step 1: Run the app in demo mode**

Run the dev server and open demo mode (`http://localhost:5173/demo.html`). Open a 1:1 conversation with the composer visible.

- [ ] **Step 2: Verify the wide layout is unchanged**

At a normal desktop window width, confirm the composer is a single row identical to before: `[+] [🔒] [input] [🙂] [➤]`.

- [ ] **Step 3: Verify the narrow reflow**

Narrow the window (or the chat pane) until the composer card drops below the breakpoint. Confirm:
- the text field spans the full first line,
- `[+]` and `🔒` sit at the inline-start of the toolbar row,
- `🙂` and `➤` are grouped at the inline-end (send in the bottom corner),
- touch targets look unshrunken,
- typing a long message still autosizes correctly (no clamped/stuck height after the reflow).

- [ ] **Step 4: Verify RTL**

Switch the app to an RTL locale (e.g. Arabic) and repeat Step 3: the left/right groups must mirror — `[+]`/lock at the inline-start (right edge), emoji/send at the inline-end (left edge).

- [ ] **Step 5: Tune if needed, then commit**

If the switch fires too early or too late (single-row text lane still cramped, or two rows shown when there's clearly room), adjust the `420px` value in the `@container` rule and re-check. If no change is needed, skip the commit.

```bash
git add apps/fluux/src/index.css
git commit -m "fix(composer): tune narrow-layout breakpoint"
```

---

## Self-Review

**Spec coverage:**
- Grid with named areas → Task 1 Step 3–4. ✓
- Two-row narrow / single-row wide templates → Task 1 Step 3. ✓
- Container-query on width, header-kebab convention → Task 1 Step 3 (`container-type` on card + `@container`). ✓
- `input` cell `min-width: 0` → Task 1 Step 4 items 4–5 (default TextArea already has `min-w-0` via `MESSAGE_INPUT_BASE_CLASSES`… note: it does not — see below). ✓ (see note)
- Autosize width observer still works → Task 1 Step 6 guard. ✓
- Popovers unaffected → no change to `.relative` wrappers. ✓
- RTL auto-mirror → Task 2 Step 4. ✓
- Tap targets preserved → Task 1 keeps existing padding/`tap-target`; Task 2 Step 3 checks. ✓
- Breakpoint is a tuned starting value → Task 2. ✓

Note on `min-width: 0` for the default TextArea: `MESSAGE_INPUT_BASE_CLASSES` contains `flex-1` but not `min-w-0`. In a flex row `flex-1` implies `min-width: 0`? No — it does not; flex items default to `min-width: auto`. Today it works because the textarea is `rows={1}` with an explicit JS-set height and `overflow-y:auto`, so it does not push the row wide. As a grid item in the `1fr` column, the `1fr` track already resolves against available space and the textarea will not force overflow (it wraps via `word-break`/`overflow-wrap` in `.message-input`). If, during Task 2 live verify, the single-row input refuses to shrink on very narrow widths, add `min-w-0` to the default TextArea className alongside `[grid-area:input]`. This is called out here so the implementer knows the exact remedy rather than guessing.

**Placeholder scan:** No TBD/TODO; all steps show concrete CSS/JSX/test code and exact commands. ✓

**Type consistency:** Area names `add`/`lock`/`input`/`emoji`/`send` are identical between the CSS `grid-template-areas` and every `[grid-area:…]` class. No function signatures introduced. ✓
