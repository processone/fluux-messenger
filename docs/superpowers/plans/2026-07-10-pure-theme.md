# Pure Theme Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a "Pure" builtin theme whose dark mode is true-black (OLED) and light mode is flat-white (e-ink), with glass/blur automatically flattened when it is active.

**Architecture:** Pure is a single `ThemeDefinition` (dark = OLED, light = e-ink) registered like any other builtin, so it inherits the picker, swatches, persistence, and mode toggle for free. The only mechanism added is an optional `transparency?: 'reduced'` field on `ThemeDefinition` that `useTheme` folds into the effective `data-transparency` attribute (reduced-wins), reusing the codebase's existing `[data-transparency="reduced"]` solid-fallback CSS to flatten every glass surface. No new CSS selectors, no store changes, no UI changes.

**Tech Stack:** React + TypeScript, Zustand stores, CSS custom properties (`--fluux-*`), Vitest.

## Global Constraints

- Theme id is `pure`, display name is `Pure`, author `Fluux`, version `1.0.0` — exact strings.
- Only Tier-1 foundation vars + a handful of explicit surface/border pins are overridden; semantic/component tokens cascade. Do not override the palette (`--fluux-color-*`) or `--fluux-text-error` — Pure intentionally inherits them (they clear the per-theme contrast tests on pure black/white by construction).
- Keep `--fluux-surface-divider` at its inherited alpha-on-surface value (white-alpha dark / black-alpha light). Do NOT override it — the surface-hierarchy divider-direction test depends on it.
- The main content surface must be true black on OLED: `--fluux-chat-bg` resolves to `#000000` in dark, `#ffffff` in light. Because the surface-hierarchy test requires `luminance(sidebar-bg) <= luminance(chat-bg)`, the sidebar/rail/primary chrome surfaces must be equally black/white (flat) — hierarchy is carried by borders, not surface luminance.
- Transparency merge is **reduced-wins**: a theme may force `reduced`, never force `full` over a user/OS `reduced` preference.
- All work happens in `apps/fluux/`. Run theme tests from that package: `cd apps/fluux && npx vitest run src/themes/`.
- No Claude footer in commits.

---

## File Structure

- **Create** `apps/fluux/src/themes/transparency.ts` — pure `resolveTransparency()` helper (the reduced-wins merge), unit-testable without React.
- **Create** `apps/fluux/src/themes/transparency.test.ts` — unit tests for the helper.
- **Modify** `apps/fluux/src/themes/types.ts` — add optional `transparency?: 'reduced'` to `ThemeDefinition`.
- **Modify** `apps/fluux/src/hooks/useTheme.ts` — use `resolveTransparency()` in the transparency effect; add `activeThemeId` to its deps.
- **Create** `apps/fluux/src/themes/builtins/pure.ts` — the Pure `ThemeDefinition`.
- **Modify** `apps/fluux/src/themes/builtins/index.ts` — import + register `pureTheme`.
- **Modify** `apps/fluux/src/themes/builtins/index.test.ts` — assert Pure is registered with correct identity, transparency flag, and true-black/white chrome anchors.

---

## Task 1: Transparency preference plumbing

Adds the `transparency?: 'reduced'` field and the reduced-wins merge, wired into `useTheme`. Extracting the merge into a pure helper keeps it unit-testable without rendering the hook.

**Files:**
- Create: `apps/fluux/src/themes/transparency.ts`
- Test: `apps/fluux/src/themes/transparency.test.ts`
- Modify: `apps/fluux/src/themes/types.ts`
- Modify: `apps/fluux/src/hooks/useTheme.ts:346-358`

**Interfaces:**
- Produces: `resolveTransparency(opts: { themeWantsReduced: boolean; transparencyMode: 'full' | 'reduced' | 'system'; systemReducedMatches: boolean }): 'full' | 'reduced'`
- Produces: `ThemeDefinition.transparency?: 'reduced'`

- [ ] **Step 1: Write the failing test**

Create `apps/fluux/src/themes/transparency.test.ts`:

```typescript
import { describe, it, expect } from 'vitest'
import { resolveTransparency } from './transparency'

describe('resolveTransparency (reduced-wins merge)', () => {
  it('theme requesting reduced forces reduced even when user chose full', () => {
    expect(
      resolveTransparency({ themeWantsReduced: true, transparencyMode: 'full', systemReducedMatches: false }),
    ).toBe('reduced')
  })

  it('theme not requesting reduced defers to an explicit user setting', () => {
    expect(
      resolveTransparency({ themeWantsReduced: false, transparencyMode: 'full', systemReducedMatches: true }),
    ).toBe('full')
    expect(
      resolveTransparency({ themeWantsReduced: false, transparencyMode: 'reduced', systemReducedMatches: false }),
    ).toBe('reduced')
  })

  it('system mode resolves from the OS media query when the theme is neutral', () => {
    expect(
      resolveTransparency({ themeWantsReduced: false, transparencyMode: 'system', systemReducedMatches: true }),
    ).toBe('reduced')
    expect(
      resolveTransparency({ themeWantsReduced: false, transparencyMode: 'system', systemReducedMatches: false }),
    ).toBe('full')
  })

  it('a theme can never force full over a user/OS reduced preference', () => {
    expect(
      resolveTransparency({ themeWantsReduced: false, transparencyMode: 'reduced', systemReducedMatches: false }),
    ).toBe('reduced')
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd apps/fluux && npx vitest run src/themes/transparency.test.ts`
Expected: FAIL — cannot find module `./transparency`.

- [ ] **Step 3: Create the helper**

Create `apps/fluux/src/themes/transparency.ts`:

```typescript
export type TransparencyMode = 'full' | 'reduced' | 'system'
export type ResolvedTransparency = 'full' | 'reduced'

/**
 * Resolve the effective transparency for the current theme + user setting.
 *
 * Reduced-wins: a theme may FORCE reduced transparency (the "Pure" theme does,
 * so its glass surfaces render solid), but a theme can never force `full` over a
 * user or OS `reduced` preference. When the theme is neutral, the user's own
 * setting decides ('system' consults the OS prefers-reduced-transparency query).
 */
export function resolveTransparency(opts: {
  themeWantsReduced: boolean
  transparencyMode: TransparencyMode
  systemReducedMatches: boolean
}): ResolvedTransparency {
  if (opts.themeWantsReduced) return 'reduced'
  if (opts.transparencyMode === 'reduced') return 'reduced'
  if (opts.transparencyMode === 'full') return 'full'
  return opts.systemReducedMatches ? 'reduced' : 'full'
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd apps/fluux && npx vitest run src/themes/transparency.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Add the `transparency` field to the type**

In `apps/fluux/src/themes/types.ts`, inside `interface ThemeDefinition`, add the field immediately after the `variables: { … }` block (before `swatches?`):

```typescript
  /**
   * Optional display-optimisation hint. When set to 'reduced', selecting this
   * theme forces the app into reduced-transparency mode (glass surfaces render
   * solid) regardless of the user's transparency setting — used by "Pure" so its
   * true-black / flat-white surfaces are not broken by frosted panels. A theme
   * can only tighten transparency, never loosen it. See resolveTransparency().
   */
  transparency?: 'reduced'
```

- [ ] **Step 6: Wire the helper into `useTheme`**

In `apps/fluux/src/hooks/useTheme.ts`, add the import near the other theme imports at the top of the file:

```typescript
import { resolveTransparency } from '@/themes/transparency'
```

Then replace the transparency effect (currently at lines 346-358):

```typescript
  useEffect(() => {
    const resolve = () => {
      if (transparencyMode === 'reduced') return 'reduced'
      if (transparencyMode === 'full') return 'full'
      return window.matchMedia('(prefers-reduced-transparency: reduce)').matches ? 'reduced' : 'full'
    }
    document.documentElement.setAttribute('data-transparency', resolve())
    if (transparencyMode !== 'system') return
    const mq = window.matchMedia('(prefers-reduced-transparency: reduce)')
    const on = () => document.documentElement.setAttribute('data-transparency', resolve())
    mq.addEventListener('change', on)
    return () => mq.removeEventListener('change', on)
  }, [transparencyMode])
```

with:

```typescript
  useEffect(() => {
    const themeWantsReduced = getActiveTheme()?.transparency === 'reduced'
    const resolve = () =>
      resolveTransparency({
        themeWantsReduced,
        transparencyMode,
        systemReducedMatches: window.matchMedia('(prefers-reduced-transparency: reduce)').matches,
      })
    document.documentElement.setAttribute('data-transparency', resolve())
    if (transparencyMode !== 'system') return
    const mq = window.matchMedia('(prefers-reduced-transparency: reduce)')
    const on = () => document.documentElement.setAttribute('data-transparency', resolve())
    mq.addEventListener('change', on)
    return () => mq.removeEventListener('change', on)
  }, [transparencyMode, activeThemeId, getActiveTheme])
```

(The `activeThemeId` dep makes the effect re-run when the user switches themes, so a theme's `transparency` preference is applied/cleared on switch. `activeThemeId` and `getActiveTheme` are already destructured in the hook at lines 220-221.)

- [ ] **Step 7: Typecheck**

Run: `cd apps/fluux && npx tsc --noEmit -p tsconfig.json` (or `npm run typecheck` from repo root).
Expected: no errors.

- [ ] **Step 8: Commit**

```bash
git add apps/fluux/src/themes/transparency.ts apps/fluux/src/themes/transparency.test.ts apps/fluux/src/themes/types.ts apps/fluux/src/hooks/useTheme.ts
git commit -m "feat(theme): add theme transparency preference (reduced-wins)"
```

---

## Task 2: Pure theme definition + registration

Creates the Pure theme and registers it. The token map is chosen so every builtin-theme contrast/hierarchy test passes by construction (true-black/white surfaces = maximum contrast; flat chrome satisfies the `<=` hierarchy check; inherited palette/error tokens clear AA against pure black/white).

**Files:**
- Create: `apps/fluux/src/themes/builtins/pure.ts`
- Modify: `apps/fluux/src/themes/builtins/index.ts`
- Test: `apps/fluux/src/themes/builtins/index.test.ts`

**Interfaces:**
- Consumes: `ThemeDefinition` (incl. `transparency?` from Task 1).
- Produces: `export const pureTheme: ThemeDefinition` with `id: 'pure'`; appended to `builtinThemes`.

- [ ] **Step 1: Write the failing test**

In `apps/fluux/src/themes/builtins/index.test.ts`, add these cases inside the `describe('builtin themes', …)` block:

```typescript
  it('registers the Pure theme optimized for OLED/e-ink', () => {
    const pure = getBuiltinTheme('pure')
    expect(pure).toBeDefined()
    expect(pure?.name).toBe('Pure')
    // Forces solid glass so true-black / flat-white is not broken by frost.
    expect(pure?.transparency).toBe('reduced')
    // OLED: the main content + sidebar chrome are true black.
    expect(pure?.variables.dark?.['--fluux-chat-bg']).toBe('#000000')
    expect(pure?.variables.dark?.['--fluux-sidebar-bg']).toBe('#000000')
    // e-ink: the main content + sidebar chrome are flat white.
    expect(pure?.variables.light?.['--fluux-chat-bg']).toBe('#ffffff')
    expect(pure?.variables.light?.['--fluux-sidebar-bg']).toBe('#ffffff')
  })
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd apps/fluux && npx vitest run src/themes/builtins/index.test.ts`
Expected: FAIL — `getBuiltinTheme('pure')` is `undefined`.

- [ ] **Step 3: Create the Pure theme**

Create `apps/fluux/src/themes/builtins/pure.ts`:

```typescript
import type { ThemeDefinition } from '../types'

/**
 * Pure — true-black for OLED (dark) and flat-white for e-ink (light).
 *
 * Dark: chat + all chrome surfaces are #000000 so OLED panels power those pixels
 * off (battery + no light bleed). Depth is carried by hairline borders and the
 * inherited alpha divider, not by surface luminance — the surface-hierarchy guard
 * requires luminance(sidebar) <= luminance(chat), so the chrome is deliberately
 * flat black. Elevated non-chrome surfaces (float/popover/hover rows) get a hair
 * of lift for affordance. Accent is Aurora's teal preset — restrained but vivid,
 * it pops on black.
 *
 * Light: everything is #ffffff, flat, with strong dark structure and a near-black
 * "ink" accent so interactive elements read as high-contrast bold and survive
 * e-ink's shallow grayscale rendering. Muted text stays dark (not light gray).
 *
 * transparency: 'reduced' forces every glass surface solid (see resolveTransparency)
 * — frosted translucency would break true black on OLED and does not render on e-ink.
 *
 * The palette (--fluux-color-*), syntax tokens, and --fluux-text-error are
 * intentionally inherited: on pure black / pure white they clear the per-theme
 * WCAG contrast guards by construction, so overriding them adds risk without benefit.
 */
export const pureTheme: ThemeDefinition = {
  id: 'pure',
  name: 'Pure',
  author: 'Fluux',
  version: '1.0.0',
  description: 'True black for OLED, flat white for e-ink — maximum-contrast minimalism',
  transparency: 'reduced',
  variables: {
    dark: {
      // Foundation — neutral ramp. base-00..base-30 are true black so every
      // chrome surface (bg-primary=base-10, sidebar=base-20, chat=base-30) is #000.
      '--fluux-base-00': '#000000',
      '--fluux-base-05': '#000000',
      '--fluux-base-10': '#000000',
      '--fluux-base-20': '#000000',
      '--fluux-base-30': '#000000',
      '--fluux-base-40': '#141414', // hover rows — subtle lift on the black canvas
      '--fluux-base-50': '#1c1c1c', // float / popover surface
      '--fluux-base-60': '#262626', // float hover
      '--fluux-base-70': '#6e6e6e',
      '--fluux-base-80': '#9a9a9a', // text-muted (≈7:1 on #000)
      '--fluux-base-90': '#fafafa', // text-normal (just under #fff to soften halation)
      '--fluux-base-100': '#ffffff',
      // Foundation — accent (Aurora teal: pops on true black)
      '--fluux-accent-h': '174',
      '--fluux-accent-s': '70%',
      '--fluux-accent-l': '52%',
      // Borders — hairlines carry the depth the flat surfaces don't.
      '--fluux-border-color': 'rgba(255, 255, 255, 0.14)',
      '--fluux-glass-border': 'rgba(255, 255, 255, 0.18)',
      // Pin the chrome surfaces to true black directly so the intent is explicit
      // and independent of ramp-derivation changes.
      '--fluux-chat-bg': '#000000',
      '--fluux-sidebar-bg': '#000000',
      '--fluux-bg-float': '#1c1c1c',
    },
    light: {
      // Foundation — neutral ramp inverted; base-00..base-30 flat white so every
      // chrome surface is #fff. Text ramp (base-90/100) is pure black ink.
      '--fluux-base-00': '#ffffff',
      '--fluux-base-05': '#ffffff',
      '--fluux-base-10': '#ffffff',
      '--fluux-base-20': '#ffffff',
      '--fluux-base-30': '#ffffff',
      '--fluux-base-40': '#f2f2f2', // hover rows — faint lift
      '--fluux-base-50': '#ffffff', // float / popover (border carries elevation)
      '--fluux-base-60': '#ebebeb',
      '--fluux-base-70': '#8a8a8a',
      '--fluux-base-80': '#3a3a3a', // text-muted kept dark for e-ink depth
      '--fluux-base-90': '#000000', // text-normal ink
      '--fluux-base-100': '#000000',
      // Foundation — accent (near-black "ink"; text-on-accent computes to white)
      '--fluux-accent-h': '0',
      '--fluux-accent-s': '0%',
      '--fluux-accent-l': '10%',
      // Strong dark structure.
      '--fluux-border-color': 'rgba(0, 0, 0, 0.16)',
      '--fluux-glass-border': 'rgba(0, 0, 0, 0.18)',
      // The .light block sets --fluux-bg-secondary to a tinted value; pin it and
      // the chrome surfaces flat white.
      '--fluux-bg-secondary': '#ffffff',
      '--fluux-chat-bg': '#ffffff',
      '--fluux-sidebar-bg': '#ffffff',
      '--fluux-bg-float': '#ffffff',
    },
  },
  swatches: {
    dark: ['#000000', '#0a0a0a', '#38E0C4', '#fafafa'],
    light: ['#ffffff', '#f2f2f2', '#1a1a1a', '#000000'],
  },
}
```

- [ ] **Step 4: Register the theme**

In `apps/fluux/src/themes/builtins/index.ts`, add the import alongside the other builtin imports (after the `indigoTheme` import):

```typescript
import { pureTheme } from './pure'
```

Then append `pureTheme` to the `builtinThemes` array (last entry, after `githubTheme`):

```typescript
export const builtinThemes: ThemeDefinition[] = [
  fluuxTheme,
  indigoTheme,
  draculaTheme,
  nordTheme,
  gruvboxTheme,
  catppuccinMochaTheme,
  solarizedTheme,
  oneDarkTheme,
  tokyoNightTheme,
  monokaiTheme,
  rosePineTheme,
  kanagawaTheme,
  githubTheme,
  pureTheme,
]
```

- [ ] **Step 5: Run the registration test to verify it passes**

Run: `cd apps/fluux && npx vitest run src/themes/builtins/index.test.ts`
Expected: PASS.

- [ ] **Step 6: Run the full theme test suite (contrast + hierarchy + glass gates)**

Run: `cd apps/fluux && npx vitest run src/themes/`
Expected: PASS — including `themeContrast.test.ts`, `surfaceHierarchy.test.ts`, and `glass.test.ts` for `pure/dark` and `pure/light`.

If a per-theme case fails, adjust only the failing token (keep the intent):
- `glass … border perceptible`: raise the `--fluux-glass-border` alpha (e.g. 0.18 → 0.22).
- `surfaceHierarchy depth order`: ensure `--fluux-sidebar-bg` luminance ≤ `--fluux-chat-bg` (they are equal here, which passes).
- `text-error … AA` or `sender-name … AA`: these pass by construction on #000/#fff; if not, that indicates a token was overridden that should have been inherited — remove the override.

- [ ] **Step 7: Commit**

```bash
git add apps/fluux/src/themes/builtins/pure.ts apps/fluux/src/themes/builtins/index.ts apps/fluux/src/themes/builtins/index.test.ts
git commit -m "feat(theme): add Pure theme (true-black OLED / flat-white e-ink) (#952)"
```

---

## Task 3: Full verification (tests, typecheck, manual demo)

Confirms the whole app is green and the theme behaves in the running app — glass flattens when Pure is active and restores when switching away.

**Files:** none (verification only).

- [ ] **Step 1: Run the full app test suite**

Run: `cd apps/fluux && npx vitest run`
Expected: PASS, no stderr. (Pure is now part of every `builtinThemes` iteration.)

- [ ] **Step 2: Typecheck the whole repo**

Run: `npm run typecheck` (repo root).
Expected: no errors.

- [ ] **Step 3: Lint**

Run: `npm run lint` (repo root) — or the app's lint script if scoped.
Expected: no new errors.

- [ ] **Step 4: Manual verification in demo mode**

Start the dev server (`npm run dev`, open `http://localhost:5173/demo.html?tutorial=false`) or use the preview tooling. Then:
- Settings → Appearance → pick **Pure**. In **dark** mode confirm the chat and sidebar are true black `#000` with a visible hairline divider; the accent (send button, active item) reads as teal.
- Switch to **light** mode: confirm flat white `#fff`, dark structure, near-black accent.
- Open a modal and the command palette (⌘K): confirm the panels are **solid** (no frosted translucency) in both modes.
- Note the current transparency setting, then switch from Pure back to Aurora: confirm frosted glass **returns** (Pure's forced-reduced state was not persisted onto the user's setting).

- [ ] **Step 5: Capture proof**

Take a screenshot of Pure dark (a chat view + an open modal) and Pure light, to attach to the PR / issue #952.

- [ ] **Step 6: Final commit (only if any fixup was needed in steps 1-4)**

```bash
git add -A
git commit -m "test(theme): verify Pure theme across suites"
```

---

## Self-Review

**Spec coverage:**
- One theme, two modes (dark=OLED, light=e-ink) → Task 2 (`pure.ts`), selected via existing mode toggle (no change needed). ✓
- True black `#000` OLED surfaces / flat white `#fff` e-ink → Task 2 token map + `builtins/index.test.ts` anchors. ✓
- Split accent (teal OLED / ink e-ink) → Task 2 accent HSL per mode. ✓
- Flatten glass via theme transparency preference (reduced-wins) → Task 1. ✓
- Validation gates (themeContrast, surfaceHierarchy, glass, typecheck, manual) → Task 2 Step 6, Task 3. ✓
- No i18n key, no store change, no motion coupling → nothing in the plan adds them. ✓

**Placeholder scan:** none — every code step contains complete content.

**Type consistency:** `resolveTransparency` signature is identical in Task 1's helper, test, and `useTheme` call site. `transparency?: 'reduced'` is defined in Task 1 (types.ts) and consumed in Task 2 (`pure.ts`) and the `useTheme` effect. `pureTheme` export name matches its import in `index.ts`. Token names (`--fluux-chat-bg`, `--fluux-sidebar-bg`, `--fluux-glass-border`, `--fluux-surface-divider`) match the derivations verified in `index.css`.
