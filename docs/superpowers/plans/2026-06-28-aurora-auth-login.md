# Aurora Auth / Login Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the login screen an Aurora-branded first impression — a gradient app-tile mark, a display-font heading, an elevated card, and a faint aurora backdrop — without touching the auth flow.

**Architecture:** Purely visual changes in `LoginScreen.tsx` (the header mark + heading, the form-card elevation, a decorative backdrop glow) plus a one-line radius touch in `LoginErrorPanel.tsx`. Token-based; the gradient mark uses `--fluux-grad` (the brand signature), surfaces inherit the active theme. No new components, no behavior change.

**Tech Stack:** React + TypeScript, Tailwind + CSS custom properties, lucide-react, Vitest + Testing Library. No SDK changes.

## Global Constraints

- **Purely visual — preserve ALL behavior.** No auth/connection flow, field, validation, prefill, remember-me, or persistence changes. The **advanced-mode kebab** (`OverflowMenu`, `LoginScreen.tsx:427-438`, toggles `useAdvancedModeStore`, reveals the server field) is KEPT exactly, and must stay clickable above the new backdrop glow + clear of the centered mark.
- **No copy rewrites.** Reuse all existing `login.*` i18n keys. The footer keeps its two lines: "Made by ProcessOne, the company behind ejabberd" and "**Powered by XMPP**" (links `XMPP` -> `xmpp.org`, already correct — do NOT change to ejabberd).
- **Gradient mark = `--fluux-grad`** (the Fluux brand signature, theme-overridden light/dark; intentionally stays the Aurora gradient on other themes). The backdrop glow uses the theme ACCENT faintly (theme-aware). Surfaces (`bg-fluux-bg`, `bg-fluux-sidebar`) inherit the theme.
- **Decorative layers must NOT reduce text/field contrast** (the backdrop glow is very faint + behind the card). The white glyph on the gradient tile is decorative (3:1 floor).
- **No em-dashes/en-dashes** in any user-facing string. No SDK changes (-> no `build:sdk`).

## File Structure

- Modify: `apps/fluux/src/components/LoginScreen.tsx` — the brand mark + heading (header block ~440-448), the form-card elevation (form ~451), the backdrop glow (root container ~417). Preserve the kebab + server field + footer.
- Modify: `apps/fluux/src/components/LoginErrorPanel.tsx` — radius touch only.
- Test: `apps/fluux/src/components/LoginScreen.test.tsx`.
- Modify: `scripts/screenshots.ts` (best-effort login scene).

---

### Task 1: LoginScreen Aurora branding

**Files:**
- Modify: `apps/fluux/src/components/LoginScreen.tsx`, `apps/fluux/src/components/LoginErrorPanel.tsx`
- Test: `apps/fluux/src/components/LoginScreen.test.tsx`

**Interfaces:** Consumes `MessageCircle` from `lucide-react` (add to the existing lucide import). Uses CSS vars `--fluux-grad`, `--fluux-surface-divider`, `--fluux-shadow-overlay`, `--fluux-bg-accent`.

- [ ] **Step 1: Write the failing test**

Add to `LoginScreen.test.tsx` (follow the file's existing mock setup — it mocks `react-i18next` with `t` returning the key, plus the connection/prefill/window hooks):
```tsx
it('renders the Aurora gradient mark + display-font heading (no flat logo img)', () => {
  renderLogin() // the file's existing render helper / <LoginScreen /> with its mocks
  // display-font heading
  const heading = screen.getByRole('heading', { level: 1 })
  expect(heading.className).toMatch(/font-display/)
  // the flat logo <img> is replaced by the gradient mark (no <img> for the brand)
  expect(screen.queryByRole('img')).toBeNull()
})
```

- [ ] **Step 2: Run it, verify it fails**

Run: `cd apps/fluux && npx vitest run src/components/LoginScreen.test.tsx -t "gradient mark"`
Expected: FAIL — the heading has no `font-display`, and the `<img src="/logo.png">` still renders.

- [ ] **Step 3: Replace the header block with the gradient mark + display heading**

In `LoginScreen.tsx`, add `MessageCircle` to the `lucide-react` import. Replace the header block (~lines 440-448):
```tsx
        {/* Logo / Header */}
        <div className="text-center mb-8">
          {/* Aurora gradient brand mark: the --fluux-grad tile + a soft glow */}
          <div className="relative size-16 mx-auto mb-4">
            <div
              className="absolute -inset-1.5 rounded-2xl blur-xl opacity-60"
              style={{ background: 'var(--fluux-grad)' }}
              aria-hidden="true"
            />
            <div
              className="absolute inset-0 rounded-2xl flex items-center justify-center"
              style={{ background: 'var(--fluux-grad)' }}
            >
              <MessageCircle className="size-8 text-white" aria-hidden="true" />
            </div>
          </div>
          <h1 className="text-3xl font-semibold font-display tracking-tight text-fluux-text">{t('login.title')}</h1>
          <p className="text-fluux-muted mt-2">{t('login.subtitle')}</p>
        </div>
```

- [ ] **Step 4: Elevate the form card**

Update the `<form>` className (~line 451) to add a hairline border + the overlay shadow:
```tsx
        <form onSubmit={handleSubmit} name="login" className="bg-fluux-sidebar rounded-lg p-6 space-y-4 border border-[color:var(--fluux-surface-divider)] shadow-[var(--fluux-shadow-overlay)]">
```

- [ ] **Step 5: Add the faint aurora backdrop glow**

In the root container (~line 417, `<div className="h-full bg-fluux-bg overflow-y-auto relative">`), add the glow as the FIRST child with `z-0`, and give the centering wrapper a `relative z-10` so the content paints above the glow (an absolute element otherwise paints ABOVE its static siblings, so the content needs an explicit higher z):
```tsx
      {/* Faint aurora backdrop glow — decorative, behind the content */}
      <div
        className="pointer-events-none absolute inset-x-0 top-0 h-80 z-0"
        style={{ background: 'radial-gradient(60% 100% at 50% 0%, color-mix(in srgb, var(--fluux-bg-accent), transparent 88%), transparent 70%)' }}
        aria-hidden="true"
      />
```
Then on the centering wrapper (~line 423, `<div className="min-h-full flex items-center justify-center p-4">`) add `relative z-10`:
```tsx
        <div className="min-h-full flex items-center justify-center p-4 relative z-10">
```
The card is opaque `bg-fluux-sidebar` (covers the glow where they overlap) and the advanced-mode kebab keeps its `z-10` within the now-z-10 content (stays above the glow + clickable). Do NOT change the kebab, the server field, remember-me, or the footer.

- [ ] **Step 6: LoginErrorPanel radius touch**

In `LoginErrorPanel.tsx`, change the `plainBoxClass` `rounded` -> `rounded-lg` so the error box matches the card radius. No other change.

- [ ] **Step 7: Run the tests + typecheck**

Run: `cd apps/fluux && npx vitest run src/components/LoginScreen.test.tsx src/components/LoginErrorPanel.test.tsx 2>/dev/null` ; then from repo root `npm run typecheck`.
Expected: PASS / clean. (The connection/field/kebab behavior is unchanged, so the existing LoginScreen tests stay green; update any test that asserted the old `<img>`/`text-2xl` heading.)

- [ ] **Step 8: Commit**

```bash
git add apps/fluux/src/components/LoginScreen.tsx apps/fluux/src/components/LoginErrorPanel.tsx apps/fluux/src/components/LoginScreen.test.tsx
git -c commit.gpgsign=false commit -m "feat(login): Aurora gradient brand mark + display heading + elevated card + backdrop"
```

---

### Task 2: Verification + screenshots

**Files:** Modify `scripts/screenshots.ts`; verify the slice.

- [ ] **Step 1: Full verification**

Run from repo root: `npm run typecheck` (clean), `npm run lint` (0 errors), `npm test` (all pass, no stderr; incl. `LoginScreen.test`). Confirm the login text contrast is already covered (the surfaces are `bg-fluux-sidebar` + `bg-fluux-bg`; `text-muted` on the sidebar surface is guarded by `emptyStateContrast.test.ts`). No new contrast guard expected; if a NEW token/surface was introduced, extend the guard.

- [ ] **Step 2: Add a login screenshot scene (best-effort)**

The demo (`demo.html`) auto-connects and bypasses login, so the login screen may not be reachable from the existing demo harness. In `scripts/screenshots.ts`, attempt a login scene: load the app so the LOGIN renders (e.g. the non-demo entry, or a demo URL param / store state that forces the logged-out LoginScreen). If reachable, capture it in Aurora dark + light + gruvbox (`setTheme`), naming `8x-login-<theme>`. If the harness cannot reach a logged-out state cleanly, SKIP the scene and note why in the report (the LoginScreen unit test + the verification carry the proof); do NOT hack the demo auto-connect.

- [ ] **Step 3: Regenerate + eyeball (if a scene was added)**

If a login scene was added: `npm run screenshots`, then confirm the gradient mark + display heading + elevated card render, the backdrop glow is subtle (fields readable), and the advanced-mode kebab is visible top-right, in dark + light + gruvbox.

- [ ] **Step 4: Commit**

```bash
git add scripts/screenshots.ts screenshots/ 2>/dev/null; git -c commit.gpgsign=false commit -m "test(login): verification + login screenshot scene" || echo "nothing to commit (no scene reachable)"
```

---

## Self-Review notes

- **Spec coverage:** gradient app-tile mark (Task 1 Step 3) · display heading (Step 3) · elevated card (Step 4) · aurora backdrop (Step 5) · error-panel light touch (Step 6) · preserve advanced-mode kebab + server field + footer "Powered by XMPP" (Global Constraints + untouched in the edits) · theme-robust + contrast covered (Task 2 Step 1). All covered.
- **Type consistency:** `MessageCircle` (lucide), the CSS vars (`--fluux-grad`, `--fluux-surface-divider`, `--fluux-shadow-overlay`, `--fluux-bg-accent`) — consistent.
- **No SDK change** -> no `build:sdk`.
- **Known risk flagged:** the login screenshot may be unreachable in the demo harness (demo auto-connects) — Task 2 makes it best-effort and falls back to the unit test, rather than hacking the demo.
