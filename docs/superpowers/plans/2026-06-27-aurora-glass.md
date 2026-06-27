# Aurora Glass — Modals + Command Palette Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the command palette and modal panels a theme-robust frosted-glass surface, with a reduce-transparency accessibility preference, grouped with Animation + Character size in a new Accessibility settings pane.

**Architecture:** A shared `.fluux-glass` CSS class (mirroring `.fluux-popover`) provides a solid theme-derived elevated surface, with a `@supports`-gated frosted variant (translucent `color-mix` of the theme's own `--fluux-bg-float` + `backdrop-filter: blur`). Frost is the default; a `[data-transparency="reduced"]` attribute (set by resolving a `transparencyMode` preference against the OS `prefers-reduced-transparency`, mirroring the existing `motionPreference` resolution in `useTheme.ts`) overrides it back to solid. A cross-theme guard test enforces readability across all 13 themes.

**Tech Stack:** React + TypeScript, Tailwind + CSS custom properties (`index.css`), Zustand (`settingsStore`), i18next (33 locales), Vitest + Testing Library, lucide-react.

## Global Constraints

- **Theme-robust (binding):** NO hardcoded surface colors for glass — the glass background derives from each theme's `--fluux-bg-float` (solid and frosted paths). The glass border + scrim are white/black alpha overlays. The hardcoded navy `--fluux-glass-bg` is removed.
- **Readability first:** the frosted background is ~88% opaque (`color-mix(... transparent 12%)`); never below 85% opacity. If a theme looks too see-through, raise opacity.
- **Graceful fallback:** the frosted variant is gated by `@supports (backdrop-filter: blur(1px)) and (background: color-mix(in srgb, red, blue))`; unsupported → solid theme-derived panel. Reduce-transparency → solid.
- **Accessibility preference** mirrors `motionPreference` exactly: `transparencyMode: 'system' | 'full' | 'reduced'`, default `'system'`, persist key `'fluux-transparency'`, resolved against `window.matchMedia('(prefers-reduced-transparency: reduce)')`.
- **Scope:** the command palette + modal panels (`ModalShell` + `ConfirmDialog`, `BackupPassphraseDialog`, `AvatarCropModal`, `ui/BottomSheet`). NOT the `.fluux-popover` dropdown menus.
- **i18n:** new keys (`settings.categories.accessibility`, transparency labels/descriptions) translated in all 33 `apps/fluux/src/i18n/locales/*.json`. Reuse existing `settings.motion*` / `settings.fontSize*` keys for the moved controls. **No em-dashes/en-dashes.**

## File Structure

- `apps/fluux/src/index.css` — remove hardcoded `--fluux-glass-bg`; add `--fluux-glass-border`; add the `.fluux-glass` class. MODIFY.
- `apps/fluux/src/themes/glass.test.ts` — cross-theme glass guard. CREATE.
- `apps/fluux/src/stores/settingsStore.ts` — add `transparencyMode`. MODIFY.
- `apps/fluux/src/hooks/useTheme.ts` — add the `data-transparency` resolution (mirror the `data-motion` effect ~line 295-311). MODIFY.
- `apps/fluux/src/components/settings-components/types.ts` — add the `'accessibility'` category. MODIFY.
- `apps/fluux/src/components/SettingsView.tsx` — add `case 'accessibility'`. MODIFY.
- `apps/fluux/src/components/settings-components/AccessibilitySettings.tsx` — new pane (Animation + Transparency + Character size). CREATE.
- `apps/fluux/src/components/settings-components/AppearanceSettings.tsx` — remove Motion + Font Size blocks. MODIFY.
- `apps/fluux/src/components/settings-components/index.ts` — export `AccessibilitySettings`. MODIFY.
- `apps/fluux/src/i18n/locales/*.json` (33) — new keys. MODIFY.
- `apps/fluux/src/components/ModalShell.tsx`, `CommandPalette.tsx`, `ConfirmDialog.tsx`, `BackupPassphraseDialog.tsx`, `AvatarCropModal.tsx`, `ui/BottomSheet.tsx` — apply `.fluux-glass` + scrim token. MODIFY.
- `scripts/screenshots.ts` — glass theme-variant scenes. MODIFY.

---

### Task 1: Glass CSS (`.fluux-glass` + tokens) + cross-theme guard

**Files:**
- Modify: `apps/fluux/src/index.css`
- Create: `apps/fluux/src/themes/glass.test.ts`

**Interfaces:**
- Produces: `.fluux-glass` class (solid theme-derived base; frosted by default where supported; `[data-transparency="reduced"]` overrides to solid). Tokens `--fluux-glass-border` (dark/light), `--fluux-glass-blur` (existing 12px). `--fluux-glass-bg` removed.

- [ ] **Step 1: Write the failing guard test**

`apps/fluux/src/themes/glass.test.ts` (mirror `surfaceHierarchy.test.ts` / `themeContrast.test.ts` resolution helpers — import the same `themeTokens(theme, mode)` + luminance/contrast utilities those tests use):

```ts
// For every builtin theme x mode: the glass panel's SOLID fallback (--fluux-bg-float)
// must keep normal text readable (AA), and the glass border must be perceptible.
import { describe, it, expect } from 'vitest'
// ...import the builtins list + the themeTokens resolver + contrast helpers used by surfaceHierarchy.test.ts

for (const theme of ALL_BUILTINS) {
  for (const mode of ['dark', 'light'] as const) {
    it(`${theme.id}/${mode}: text readable on glass fallback + border perceptible`, () => {
      const v = themeTokens(theme, mode)
      const float = resolve(v, '--fluux-bg-float')
      const text = resolve(v, '--fluux-text-normal')
      expect(contrast(text, float)).toBeGreaterThanOrEqual(4.5)        // AA body on the panel
      const border = compositeAlphaOver(resolve(v, '--fluux-glass-border'), float)
      expect(contrast(border, float)).toBeGreaterThanOrEqual(1.25)     // hairline visible
    })
  }
}
```

(Match the exact helper names/signatures the sibling theme tests use; `compositeAlphaOver` composites the alpha border over the surface, like the surface-divider check.)

- [ ] **Step 2: Run it — expect FAIL** (no `--fluux-glass-border` yet, or the assertion shape compiles).

Run: `cd apps/fluux && npx vitest run src/themes/glass.test.ts`

- [ ] **Step 3: Tokens in `index.css`**

- Remove the hardcoded `--fluux-glass-bg` in BOTH `:root` (the navy `rgba(20,27,48,0.74)`) and `.light` (the white `rgba(255,255,255,0.72)`).
- Add `--fluux-glass-border` next to `--fluux-glass-blur`: in `:root` `rgba(255,255,255,0.12)`, in `.light` `rgba(0,0,0,0.10)`.
- Keep `--fluux-glass-blur: 12px` and `--fluux-shadow-overlay`.
- Confirm `--fluux-modal-backdrop` exists (the unused modal-token block ~line 319-322); if its value is not a sensible dark alpha for the scrim, set `--fluux-modal-backdrop: rgba(0,0,0,0.5)` in `:root` (used in Task 4).

- [ ] **Step 4: Add the `.fluux-glass` class**

In `index.css` `@layer components` (near `.fluux-popover`):

```css
.fluux-glass {
  /* Solid theme-derived fallback (no blur / reduced transparency). */
  background-color: var(--fluux-bg-float);
  border: 1px solid var(--fluux-glass-border);
  box-shadow: var(--fluux-shadow-overlay);
}
/* Frosted by default where supported. Theme-derived translucent surface + blur.
   ~88% opaque for readability. */
@supports (backdrop-filter: blur(1px)) and (background: color-mix(in srgb, red, blue)) {
  .fluux-glass {
    background-color: color-mix(in srgb, var(--fluux-bg-float), transparent 12%);
    backdrop-filter: blur(var(--fluux-glass-blur));
    -webkit-backdrop-filter: blur(var(--fluux-glass-blur));
  }
}
/* Reduce-transparency: override back to the solid surface. */
[data-transparency="reduced"] .fluux-glass {
  background-color: var(--fluux-bg-float);
  backdrop-filter: none;
  -webkit-backdrop-filter: none;
}
```

- [ ] **Step 5: Run the guard — expect PASS** (all 13 themes x 2 modes).

Run: `cd apps/fluux && npx vitest run src/themes/glass.test.ts`
Expected: PASS. If a theme FAILS (its `--fluux-bg-float` text contrast < AA), STOP and report it — that is a real theme readability gap, not a test-authoring issue.

- [ ] **Step 6: Commit**

```bash
git add apps/fluux/src/index.css apps/fluux/src/themes/glass.test.ts
git -c commit.gpgsign=false commit -m "feat(glass): .fluux-glass surface (theme-derived frost + solid fallback) + cross-theme guard"
```

---

### Task 2: `transparencyMode` preference + `data-transparency` resolution

**Files:**
- Modify: `apps/fluux/src/stores/settingsStore.ts`
- Modify: `apps/fluux/src/hooks/useTheme.ts`
- Test: `apps/fluux/src/stores/settingsStore.test.ts`

**Interfaces:**
- Produces: `type TransparencyMode = 'system' | 'full' | 'reduced'`; `settingsStore` gains `transparencyMode` + `setTransparencyMode`. `useTheme` sets `document.documentElement` `data-transparency` to `full`/`reduced` resolved from the mode + the OS query.

- [ ] **Step 1: Write the failing store test**

In `settingsStore.test.ts` (mirror the `motionPreference` tests):

```ts
it('defaults transparencyMode to system and persists on set', () => {
  expect(useSettingsStore.getState().transparencyMode).toBe('system')
  useSettingsStore.getState().setTransparencyMode('reduced')
  expect(useSettingsStore.getState().transparencyMode).toBe('reduced')
  expect(localStorage.getItem('fluux-transparency')).toBe('reduced')
})
```

- [ ] **Step 2: Run it — expect FAIL.**

- [ ] **Step 3: Add to `settingsStore.ts`** (mirror `motionPreference`/`getInitialMotion`/`MOTION_KEY` exactly):

```ts
export type TransparencyMode = 'system' | 'full' | 'reduced'
// SettingsState: transparencyMode: TransparencyMode; setTransparencyMode: (v: TransparencyMode) => void
const TRANSPARENCY_KEY = 'fluux-transparency'
function getInitialTransparency(): TransparencyMode {
  try { const s = localStorage.getItem(TRANSPARENCY_KEY); if (s === 'system' || s === 'full' || s === 'reduced') return s } catch { /* */ }
  return 'system'
}
// in create(): transparencyMode: getInitialTransparency(),
//   setTransparencyMode: (value) => { try { localStorage.setItem(TRANSPARENCY_KEY, value) } catch { /* */ } set({ transparencyMode: value }) },
```

- [ ] **Step 4: Add the `data-transparency` resolution in `useTheme.ts`**

Read the existing `motionPreference` effect at `useTheme.ts:295-311` and add a sibling block immediately after it, mirroring it for transparency: read `transparencyMode` from the settings store, resolve `'system'` via `window.matchMedia('(prefers-reduced-transparency: reduce)')`, set `document.documentElement.setAttribute('data-transparency', resolved)` (`'full'` or `'reduced'`), and (for `'system'`) subscribe to the media-query `change` to follow live OS changes. Use `transparencyMode` as the effect dep.

```ts
// Apply transparency preference. Sets data-transparency="full"|"reduced" on <html>;
// CSS frosts .fluux-glass by default and the [data-transparency="reduced"] rule
// reverts to a solid surface. 'system' resolves from prefers-reduced-transparency.
const transparencyMode = useSettingsStore((s) => s.transparencyMode)
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

(Place it where the motion effect lives so it runs once at the app root via `ThemeProvider`. Import `useSettingsStore`/`useEffect` if not already imported there.)

- [ ] **Step 5: Run the store test — expect PASS;** typecheck.

Run: `cd apps/fluux && npx vitest run src/stores/settingsStore.test.ts -t transparency` then from repo root `npm run typecheck`.

- [ ] **Step 6: Commit**

```bash
git add apps/fluux/src/stores/settingsStore.ts apps/fluux/src/stores/settingsStore.test.ts apps/fluux/src/hooks/useTheme.ts
git -c commit.gpgsign=false commit -m "feat(a11y): transparencyMode preference + data-transparency resolution"
```

---

### Task 3: Accessibility settings pane (move Animation + Character size, add Transparency)

**Files:**
- Modify: `apps/fluux/src/components/settings-components/types.ts`, `SettingsView.tsx`, `AppearanceSettings.tsx`, `settings-components/index.ts`
- Create: `apps/fluux/src/components/settings-components/AccessibilitySettings.tsx`
- Modify: `apps/fluux/src/i18n/locales/*.json` (33)
- Test: `AccessibilitySettings.test.tsx` (create), `AppearanceSettings.test.tsx` (relocate the moved-control tests), `i18n.test.ts`

**Interfaces:**
- Consumes: `motionPreference`/`setMotionPreference`, `fontSize`/`setFontSize`, `transparencyMode`/`setTransparencyMode` (Task 2).
- Produces: a new `'accessibility'` settings category + `AccessibilitySettings` pane. `AppearanceSettings` no longer has Motion or Font Size.

- [ ] **Step 1: Add the category**

In `types.ts`: add `| 'accessibility'` to `SettingsCategory`, and an entry to `SETTINGS_CATEGORIES` (place after `appearance`): `{ id: 'accessibility', labelKey: 'settings.categories.accessibility', icon: Accessibility }` — import `Accessibility` from `lucide-react`.
In `SettingsView.tsx`: add `case 'accessibility': return <AccessibilitySettings />` (import it from `./settings-components`).

- [ ] **Step 2: i18n keys (English first, then all 32 locales)**

In `en.json`: `settings.categories.accessibility` = "Accessibility"; under `settings`: `transparency` = "Transparency", `transparencyFull` = "Full", `transparencyReduced` = "Reduced", `transparencyFullDescription` = "Frosted glass panels for menus and dialogs.", `transparencyReducedDescription` = "Solid panels, no blur or translucency.", `transparencySystemDescription` = "Follow your system reduce-transparency setting." Add the same keys to the other 32 locales with genuine translations. (`settings.motion*`, `settings.fontSize*`, `settings.system` already exist and are reused.) No em-dashes.

- [ ] **Step 3: Write the failing pane test**

`AccessibilitySettings.test.tsx`:

```tsx
it('renders Animation, Transparency, and Character size, and switches transparency', () => {
  render(<AccessibilitySettings />)
  expect(screen.getByText('settings.motion')).toBeInTheDocument()
  expect(screen.getByText('settings.transparency')).toBeInTheDocument()
  expect(screen.getByText('settings.fontSize')).toBeInTheDocument()
  fireEvent.click(screen.getByRole('button', { name: /transparencyReduced/i }))
  expect(useSettingsStore.getState().transparencyMode).toBe('reduced')
})
```

- [ ] **Step 4: Create `AccessibilitySettings.tsx`**

Move the Motion block (the `motionOptions` array + the Motion section JSX, ~`AppearanceSettings.tsx:17-21,283-310`) and the Font Size block (the `FONT_SIZE_*` consts + the slider JSX, ~`AppearanceSettings.tsx:23-25,312-344`) into this new pane verbatim, plus a new Transparency block mirroring the Motion block's markup:

```tsx
const transparencyOptions: { value: TransparencyMode; labelKey: string; icon: typeof Sun; descriptionKey: string }[] = [
  { value: 'full', labelKey: 'settings.transparencyFull', icon: Sparkles, descriptionKey: 'settings.transparencyFullDescription' },
  { value: 'reduced', labelKey: 'settings.transparencyReduced', icon: CircleSlash, descriptionKey: 'settings.transparencyReducedDescription' },
  { value: 'system', labelKey: 'settings.system', icon: Monitor, descriptionKey: 'settings.transparencySystemDescription' },
]
```

The pane: `<section className="max-w-md">` with an `<h3>` `t('settings.accessibility')` header and the three `space-y-6` blocks (Animation, Transparency, Character size), each mirroring the existing Motion/Font-Size markup. Read/write the stores via `useSettingsStore` selectors. Import `type TransparencyMode` from the store.

- [ ] **Step 5: Remove Motion + Font Size from `AppearanceSettings.tsx`**

Delete the `motionOptions` array, the `FONT_SIZE_*` consts, the Motion section JSX, and the Font Size section JSX. Remove now-unused imports (`Sparkles`, `CircleSlash`, the font-size handlers) only if no longer referenced. Keep theme mode, theme picker, accent, snippets.

- [ ] **Step 6: Export + relocate tests**

`settings-components/index.ts`: export `AccessibilitySettings`. Move any `AppearanceSettings.test.tsx` assertions about Motion/Font Size into `AccessibilitySettings.test.tsx`; leave the theme-mode assertions in `AppearanceSettings.test.tsx`.

- [ ] **Step 7: Run the tests — expect PASS;** typecheck.

Run: `cd apps/fluux && npx vitest run src/components/settings-components/AccessibilitySettings.test.tsx src/components/settings-components/AppearanceSettings.test.tsx src/i18n/i18n.test.ts` then `npm run typecheck`.

- [ ] **Step 8: Commit**

```bash
git add apps/fluux/src/components/settings-components/ apps/fluux/src/components/SettingsView.tsx apps/fluux/src/i18n/locales/
git -c commit.gpgsign=false commit -m "feat(a11y): Accessibility settings pane (Animation + Transparency + Character size)"
```

---

### Task 4: Apply `.fluux-glass` to the modal + palette surfaces

**Files:**
- Modify: `ModalShell.tsx`, `CommandPalette.tsx`, `ConfirmDialog.tsx`, `BackupPassphraseDialog.tsx`, `AvatarCropModal.tsx`, `ui/BottomSheet.tsx`
- Test: `ModalShell` test (create/extend), `CommandPalette` test if present

**Interfaces:**
- Consumes: `.fluux-glass` (Task 1), `--fluux-modal-backdrop` (Task 1).
- Produces: the in-scope panels use `fluux-glass`; the scrims use the backdrop token.

- [ ] **Step 1: Write the failing test**

```tsx
// ModalShell panel carries fluux-glass; scrim uses the backdrop token, not bg-black/50
it('renders the panel as a glass surface', () => {
  const { container } = render(<ModalShell title="X" onClose={() => {}}><div /></ModalShell>)
  expect(container.querySelector('.fluux-glass')).not.toBeNull()
  expect(container.querySelector('.bg-black\\/50')).toBeNull()
})
```

- [ ] **Step 2: Run it — expect FAIL.**

- [ ] **Step 3: ModalShell** (`ModalShell.tsx`): panel (~line 45) `bg-fluux-sidebar rounded-lg shadow-xl ...` becomes `fluux-glass rounded-lg ...` (drop `bg-fluux-sidebar` + `shadow-xl`; `.fluux-glass` supplies bg + border + shadow). Scrim (~line 36) `bg-black/50` becomes a backdrop using the token: replace with an element styled `style={{ background: 'var(--fluux-modal-backdrop)' }}` (or a `.modal-scrim` utility class added to `index.css` = `background: var(--fluux-modal-backdrop)`), keeping `fixed inset-0 ... z-50`.

- [ ] **Step 4: CommandPalette** (`CommandPalette.tsx`): panel (~line 509-514) `bg-fluux-sidebar rounded-lg shadow-2xl ... border border-fluux-hover` becomes `fluux-glass rounded-lg ...` (drop `bg-fluux-sidebar`, `shadow-2xl`, `border border-fluux-hover`). Overlay (~line 499) `bg-black/50` becomes the scrim token (as Step 3). Verify the selected-row tint (`bg-fluux-brand/50`) + input text still read on the glass.

- [ ] **Step 5: The four roller modals** — apply the same swap to each panel + scrim: `ConfirmDialog.tsx:38,47`, `BackupPassphraseDialog.tsx:141,151`, `AvatarCropModal.tsx:361,362` (keep its darker `bg-black/70` scrim if its image content needs the contrast — note in the report), `ui/BottomSheet.tsx:54,67` (keep `rounded-t-2xl`).

- [ ] **Step 6: Run the tests + typecheck — expect PASS.**

Run: `cd apps/fluux && npx vitest run src/components/ModalShell* src/components/CommandPalette* 2>/dev/null` then `npm run typecheck`.

- [ ] **Step 7: Commit**

```bash
git add apps/fluux/src/components/ModalShell.tsx apps/fluux/src/components/CommandPalette.tsx apps/fluux/src/components/ConfirmDialog.tsx apps/fluux/src/components/BackupPassphraseDialog.tsx apps/fluux/src/components/AvatarCropModal.tsx apps/fluux/src/components/ui/BottomSheet.tsx apps/fluux/src/index.css
git -c commit.gpgsign=false commit -m "feat(glass): frost the command palette + modal panels"
```

---

### Task 5: Screenshots + full verification

**Files:**
- Modify: `scripts/screenshots.ts`
- Verify: whole suite, typecheck, lint, screenshots

- [ ] **Step 1: Add glass theme-variant scenes**

In `scripts/screenshots.ts`: capture the command palette open (the existing `10-command-palette-dark` scene covers Aurora dark — confirm it still renders the glass) and add: the command palette in Aurora **light** and in **gruvbox**, **dracula**, **rose-pine** (use the theme seam the existing theme scenes use to switch theme); plus one **modal** open (e.g. About or Create Room) in Aurora dark + light. Name them e.g. `40-glass-palette-<theme>` / `41-glass-modal-<mode>`. Confirm the glass tints per theme.

- [ ] **Step 2: Typecheck + lint**

Run from repo root: `npm run typecheck && npm run lint` → clean.

- [ ] **Step 3: Full suite**

Run from repo root: `npm test` → all pass, no stderr. Confirm `glass.test.ts` + `i18n.test.ts` (all 33 locales) green.

- [ ] **Step 4: Screenshots**

Run from repo root: `npm run screenshots` → completes; the palette/modal scenes show frosted glass tinting per theme; spot-check that content is readable (not too transparent).

- [ ] **Step 5: Commit**

```bash
git add scripts/screenshots.ts screenshots/
git -c commit.gpgsign=false commit -m "feat(glass): theme-variant glass screenshot scenes + regen"
```

---

## Self-Review

**Spec coverage:**
- `.fluux-glass` (solid base + `@supports` frost + reduced override) → Task 1. ✓
- Theme-derived (no hardcoded navy; `color-mix` of `--fluux-bg-float`) → Task 1. ✓
- `--fluux-glass-border` / scrim token → Task 1. ✓
- Readability-first (~88% opaque) → Task 1 + Global Constraints. ✓
- `transparencyMode` + OS resolution (`prefers-reduced-transparency`) → Task 2. ✓
- Applied to palette + modals (incl. 4 rollers) → Task 4. ✓
- Accessibility pane (Animation moved + Transparency new + Character size moved); Appearance keeps theme/accent/snippets → Task 3. ✓
- Cross-theme guard → Task 1; screenshots per theme → Task 5. ✓
- i18n 33 locales; no em-dash → Task 3 + Global Constraints. ✓
- Dropdown menus out of scope → not touched. ✓

**Placeholder scan:** no TBD/TODO; code shown for each step. The guard test (Task 1 step 1) references the sibling test's helpers by behavior — the implementer matches the exact names by reading `surfaceHierarchy.test.ts`/`themeContrast.test.ts`.

**Type consistency:** `TransparencyMode` defined in Task 2, consumed in Task 3; `transparencyMode`/`setTransparencyMode`; `data-transparency` value (`full`/`reduced`) matches the `[data-transparency="reduced"]` CSS selector (Task 1); `.fluux-glass` consistent Tasks 1/4; `'accessibility'` category id consistent Task 3.

## Open flags for the controller / human

- **Frost gating refined from the spec:** the spec gated frost ON `[data-transparency="full"]`; this plan frosts by **default** (in `@supports`) and reverts on `[data-transparency="reduced"]`, so the glass works before/without the JS attribute and there is no solid-to-frost flash. Same end behavior. Flag if you prefer the literal spec gating.
- If `glass.test.ts` reveals a theme whose `--fluux-bg-float` text contrast is below AA, that is a pre-existing theme gap surfaced by the guard — report before adjusting tokens.
