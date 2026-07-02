# Composer Focus-Reveal Toolbar Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** On narrow widths, collapse the composer to a slim `input + send` row when idle and extend the `+`/lock/emoji controls into a drawer only when the field is engaged (`:focus-within`).

**Architecture:** Pure CSS on top of #815's grid. The narrow `.composer-actions` template becomes a fixed two-row grid (`input input send` / `add lock emoji`); the three drawer items collapse to zero height by default and expand on `.composer-card:focus-within`. Send stays anchored to the top row so it never reflows. No JS, no component state. The only TSX change is adding a shared marker class to the three drawer wrappers.

**Tech Stack:** React 19, Tailwind (arbitrary `[grid-area:*]` utilities), CSS container queries + `:focus-within`, Vitest + Testing Library (jsdom).

## Global Constraints

- **Pure CSS, no JS/state** — reveal is `:focus-within` on `.composer-card`; no new React state, effects, or props.
- **Wide layout (`≥ 420px` container) unchanged** — single `"add lock input emoji send"` row, drawer never collapsed.
- **Send never reflows** between idle and focused (stays top-row inline-end).
- **Collapse on blur even with a draft** — no "keep open if draft" special-casing.
- **Respect `prefers-reduced-motion: reduce`** — no transition.
- **Do not put `overflow: hidden` on the drawer wrappers in the expanded state** — it would clip the absolutely-positioned attach/emoji popovers. `overflow: hidden` applies only in the collapsed (`:not(:focus-within)`) state, where popovers are never open.
- **Breakpoint stays `420px`**, matching #815.
- Work happens in the worktree at `.claude/worktrees/eloquent-mcclintock-6bb18a/`. Verify edited paths start with that prefix (never the main checkout).

---

### Task 1: Mark the drawer wrappers (`+` / lock / emoji)

Add a shared `composer-drawer-item` class to the three secondary-control wrappers so CSS can collapse them as a group. This is the only markup change; it is inert until Task 2 adds the CSS.

**Files:**
- Modify: `apps/fluux/src/components/MessageComposer.tsx` (the `+` wrapper ~line 869, the two encryption-lock variants ~lines 934 & 939, the emoji wrapper ~line 964)
- Test: `apps/fluux/src/components/MessageComposer.layout.test.tsx`

**Interfaces:**
- Consumes: existing grid areas `add`, `lock`, `emoji`, `input`, `send` from #815.
- Produces: a `composer-drawer-item` class present on exactly the `add` and `emoji` wrappers always, and on the `lock` wrapper when `encryptionState.kind === 'encrypted'`. Task 2's CSS selects `.composer-drawer-item`.

- [ ] **Step 1: Write the failing tests**

Add these two tests to `apps/fluux/src/components/MessageComposer.layout.test.tsx` (inside the existing `describe`):

```tsx
  it('marks the +/emoji controls as collapsible drawer items', () => {
    render(<MessageComposer placeholder="Type a message" onSend={onSend} />)

    const row = screen.getByPlaceholderText('Type a message').closest('.composer-actions')!

    // No encryption → only the + and emoji wrappers are drawer items.
    const drawerItems = row.querySelectorAll('.composer-drawer-item')
    expect(drawerItems.length).toBe(2)

    const add = row.querySelector('[class*="grid-area:add"]')
    const emoji = row.querySelector('[class*="grid-area:emoji"]')
    expect(add?.classList.contains('composer-drawer-item')).toBe(true)
    expect(emoji?.classList.contains('composer-drawer-item')).toBe(true)
  })

  it('marks the encryption lock as a drawer item when encrypted', () => {
    render(
      <MessageComposer
        placeholder="Type a message"
        onSend={onSend}
        encryptionState={{ kind: 'encrypted', fingerprint: 'ABCD1234', trust: 'unverified' }}
      />
    )

    const row = screen.getByPlaceholderText('Type a message').closest('.composer-actions')!
    const lock = row.querySelector('[class*="grid-area:lock"]')
    expect(lock?.classList.contains('composer-drawer-item')).toBe(true)
    // + / lock / emoji are all drawer items now.
    expect(row.querySelectorAll('.composer-drawer-item').length).toBe(3)
  })
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd apps/fluux && npx vitest run src/components/MessageComposer.layout.test.tsx`
Expected: the two new tests FAIL (`expect(received).toBe(true)` / length `0` or `1`, class not yet present). The two existing tests still PASS.

- [ ] **Step 3: Add the marker class in `MessageComposer.tsx`**

Append ` composer-drawer-item` to each of these four `className` strings (do not change anything else on the elements):

The `+` attach-menu wrapper:
```tsx
        <div className="relative [grid-area:add] composer-drawer-item" ref={attachMenuRef}>
```

The interactive encryption-lock button:
```tsx
            <button
              type="button"
              data-encryption-lock
              onClick={onEncryptionClick}
              aria-label={lockInfo.label}
              className="p-1.5 flex-shrink-0 rounded-lg hover:bg-fluux-bg transition-colors [grid-area:lock] composer-drawer-item"
            >
```

The non-interactive encryption-lock span:
```tsx
            <span data-encryption-lock aria-label={lockInfo.label} className="p-1.5 flex-shrink-0 [grid-area:lock] composer-drawer-item">
```

The emoji wrapper:
```tsx
        <div className="relative [grid-area:emoji] composer-drawer-item" ref={emojiPickerRef}>
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd apps/fluux && npx vitest run src/components/MessageComposer.layout.test.tsx`
Expected: all four tests PASS, no stderr.

- [ ] **Step 5: Typecheck**

Run: `npm run typecheck`
Expected: passes (no new type errors).

- [ ] **Step 6: Commit**

```bash
git add apps/fluux/src/components/MessageComposer.tsx apps/fluux/src/components/MessageComposer.layout.test.tsx
git commit -m "feat(composer): mark +/lock/emoji as drawer items"
```

---

### Task 2: Collapse/reveal the drawer in CSS

Rewrite the narrow `.composer-actions` template to a fixed two-row grid with send anchored top-right, collapse the drawer items by default, and expand them on `.composer-card:focus-within`. Keep the wide single-row layout and its `420px` breakpoint intact.

**Files:**
- Modify: `apps/fluux/src/index.css` (the `.composer-actions` block + `@container (min-width: 420px)` override, currently ~lines 953–971)

**Interfaces:**
- Consumes: `.composer-drawer-item` (Task 1), `.composer-card` (has `container-type: inline-size` and is the `:focus-within` host, ~lines 943–951), grid areas `input`/`send`/`add`/`lock`/`emoji`.
- Produces: no new selectors consumed by other tasks.

- [ ] **Step 1: Replace the `.composer-actions` rules**

Replace the existing block (from the comment above `.composer-actions` through the closing `}` of the `@container (min-width: 420px)` rule — currently lines 953–971) with:

```css
/* Composer action row. On narrow widths (phone, narrowed pane) the input + send
 * sit on a top row and the secondary controls (+ / lock / emoji) form a drawer
 * beneath it that is collapsed while idle and extends on focus. On wide widths
 * it is the single comfortable row. Container-query + :focus-within driven off
 * `.composer-card`; no JS. RTL mirrors automatically (areas follow the inline
 * axis). */
.composer-actions {
  display: grid;
  align-items: center;
  grid-template-columns: auto 1fr auto;
  grid-template-areas:
    "input input send"
    "add   lock  emoji";
}

/* The drawer controls. Expanded height by default; collapsed to zero while the
 * card is idle. `overflow: hidden` is applied ONLY in the collapsed state so it
 * clips the shrinking icons without ever clipping the (focus-only) attach/emoji
 * popovers, which open upward out of these wrappers. */
.composer-drawer-item {
  max-height: 3.5rem;
  opacity: 1;
  transition: max-height 160ms ease, opacity 160ms ease;
}
.composer-card:not(:focus-within) .composer-drawer-item {
  max-height: 0;
  opacity: 0;
  overflow: hidden;
}

@container (min-width: 420px) {
  .composer-actions {
    grid-template-columns: auto auto 1fr auto auto;
    grid-template-areas: "add lock input emoji send";
  }
  /* Wide is a comfortable single row — the drawer is never collapsed. */
  .composer-card:not(:focus-within) .composer-drawer-item {
    max-height: none;
    opacity: 1;
    overflow: visible;
  }
}

@media (prefers-reduced-motion: reduce) {
  .composer-drawer-item {
    transition: none;
  }
}
```

- [ ] **Step 2: Re-run the layout unit tests (guard against markup regressions)**

Run: `cd apps/fluux && npx vitest run src/components/MessageComposer.layout.test.tsx`
Expected: all four tests PASS (jsdom does not evaluate container queries or `:focus-within`, so this only confirms the markup contract from Task 1 is intact).

- [ ] **Step 3: Verify in the preview (demo mode, narrow)**

Start the dev server and open demo mode; narrow the chat pane (or the window) so the `.composer-card` container is below `420px`.

Confirm:
1. **Idle, empty:** single row — `input` + `send` only; `+`/lock/emoji are not visible and take no vertical space.
2. **Focus the field:** the `+`/(lock)/emoji drawer extends below; **`send` does not move** (stays top inline-end).
3. **Type then blur:** drawer collapses; `send` stays visible and the typed draft is preserved.
4. **Open the emoji picker / attach menu:** popovers are not clipped (drawer is expanded because focus is within the card).
5. **Wide (`≥ 420px`):** unchanged single row `+ lock input emoji send`.
6. **Reduced motion** (`preview_resize` cannot set this; use `preview_eval` to add a `<style>` forcing `prefers-reduced-motion` is unreliable — instead verify the class carries `transition: none` under the media query by reading the rule, or note it as visual-only): the extend snaps without animating.
7. **RTL:** switch language/dir to RTL and confirm `+`/lock hug the inline-start and emoji/send the inline-end (mirrored).

Capture a screenshot of the idle (collapsed) and focused (extended) narrow states for the summary.

- [ ] **Step 4: Full app test suite + typecheck + lint**

Run: `cd apps/fluux && npx vitest run`
Expected: green, no stderr.

Run: `npm run typecheck`
Expected: passes.

Run the linter as configured for the repo (e.g. `npm run lint` if present); expected: passes.

- [ ] **Step 5: Commit**

```bash
git add apps/fluux/src/index.css
git commit -m "feat(composer): focus-reveal drawer on narrow widths"
```

---

## Self-Review

**Spec coverage:**
- Idle narrow = `input + send` only → Task 2 narrow template + default-collapsed drawer. ✓
- Focused narrow = drawer extends, send stays put → Task 2 fixed two-row template + `:focus-within` expand. ✓
- Pure CSS, no state → Task 1 (class only) + Task 2 (CSS only). ✓
- Collapse on blur incl. draft → `.composer-card:not(:focus-within)` with no draft exception. ✓
- Motion + reduced-motion → Task 2 transition + media query. ✓
- Wide unchanged, `420px` breakpoint → Task 2 `@container (min-width: 420px)`. ✓
- Popover clipping avoided → `overflow: hidden` only in collapsed state (constraint + Task 2). ✓
- RTL, tap targets, autosize width observer → covered by unchanged #815 behavior; RTL verified in Task 2 Step 3. ✓

**Placeholder scan:** none — all code and commands are literal.

**Type consistency:** the only shared symbol across tasks is the CSS class `composer-drawer-item`, spelled identically in Task 1 (markup + tests) and Task 2 (selectors).
