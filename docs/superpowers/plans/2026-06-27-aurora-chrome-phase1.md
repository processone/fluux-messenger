# Aurora Chrome + Density — Phase 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a global Display-density preference (Comfortable / Compact) and bring the sidebar lists + icon rail up to the Aurora polish: density-aware spacing/avatars, an unread emphasis on rows, and a Settings toggle.

**Architecture:** A `densityMode` preference in the existing `settingsStore` drives a `data-density` attribute on `document.documentElement` (mirroring how theme mode is applied). Spacing/width/gap density values come from CSS keyed on `[data-density="compact"]` against semantic classes (`.sidebar-row`, `.icon-rail*`), so a density flip costs **no row re-render**. Avatar sizing — which CSS can't cleanly scale (the presence dot is per-preset) — is selected from `densityMode` via a narrow store selector in the row (the row already subscribes to the store for `timeFormat`). The central message pane is **out of scope** (Phase 2).

**Tech Stack:** React + TypeScript, Zustand (`settingsStore`), Tailwind + CSS custom properties (`index.css`), Vitest + Testing Library, i18next (33 locales), lucide-react.

## Global Constraints

- **Render-perf (binding):** Density is applied via `document.documentElement[data-density]` + CSS for all spacing/width/gap. The ONLY component read of `densityMode` is for the Avatar `size` prop, via a narrow selector `useSettingsStore((s) => s.densityMode)` (same pattern as `timeFormat`) — this re-renders rows only on a density toggle, never on unrelated settings changes. The sidebar list-item memoization must stay intact. Do NOT add a `densityMode` prop threaded through the list (it would defeat the memo).
- **Density values (exact):**
  - Sidebar row: avatar **md (40px)** comfortable / **sm (32px)** compact; padding-block **8px** / **4px**; gap **12px** / **8px**.
  - Icon rail: width **56px (w-14)** / **48px (w-12)**; button **40px (size-10)** / **36px (size-9)**; icon **20px** / **18px**; gap **8px** / **6px**.
- **Default `comfortable`**, persisted to `localStorage` key `'fluux-density'`.
- **i18n:** new settings keys (`settings.density`, `settings.comfortable`, `settings.compact`, + descriptions) need a real translation in **every one of the 33 locale files** (`apps/fluux/src/i18n/locales/*.json`); `i18n.test.ts` enforces presence. **No em-dashes / en-dashes** in any user-facing string.
- **No message-pane changes** (Phase 2). No extraction of a shared row primitive (apply the treatment to each row in place).

## File Structure

- `apps/fluux/src/stores/settingsStore.ts` — add `densityMode` (MODIFY).
- `apps/fluux/src/hooks/useDensity.ts` — new hook: reads `densityMode`, sets `data-density` on `document.documentElement` (CREATE).
- the app-root component that applies theme — call `useDensity()` there (MODIFY; find where the theme mode is applied to `document.documentElement`).
- `apps/fluux/src/components/settings-components/AppearanceSettings.tsx` — add the density toggle (MODIFY).
- `apps/fluux/src/i18n/locales/*.json` (33 files) — add density keys (MODIFY).
- `apps/fluux/src/index.css` — `.sidebar-row` + `.icon-rail*` density CSS (MODIFY).
- `apps/fluux/src/components/sidebar-components/ConversationList.tsx`, `ContactList.tsx`, `RoomsList.tsx` — `.sidebar-row` class, avatar size-by-density, unread name emphasis (MODIFY).
- `apps/fluux/src/components/Sidebar.tsx` + `sidebar-components/IconRailNavLink.tsx` — rail density classes (MODIFY).
- `scripts/screenshots.ts` — comfortable/compact sidebar scenes (MODIFY).

---

### Task 1: `densityMode` preference + `useDensity` hook

**Files:**
- Modify: `apps/fluux/src/stores/settingsStore.ts`
- Create: `apps/fluux/src/hooks/useDensity.ts`
- Modify: the app-root theme-application component (call `useDensity()`)
- Test: `apps/fluux/src/stores/settingsStore.test.ts` (extend), `apps/fluux/src/hooks/useDensity.test.ts` (create)

**Interfaces:**
- Produces: `type DensityMode = 'comfortable' | 'compact'`; `settingsStore` gains `densityMode: DensityMode` + `setDensityMode(mode)`; `useDensity()` sets `document.documentElement` attribute `data-density` to the current mode.

- [ ] **Step 1: Write the failing store test**

In `settingsStore.test.ts` (mirror existing `timeFormat` tests):

```ts
it('defaults densityMode to comfortable and persists on set', () => {
  localStorage.clear()
  // fresh import or reset — follow the file's existing reset pattern
  const { setDensityMode } = useSettingsStore.getState()
  expect(useSettingsStore.getState().densityMode).toBe('comfortable')
  setDensityMode('compact')
  expect(useSettingsStore.getState().densityMode).toBe('compact')
  expect(localStorage.getItem('fluux-density')).toBe('compact')
})
```

- [ ] **Step 2: Run it — expect FAIL** (`densityMode` undefined).

Run: `cd apps/fluux && npx vitest run src/stores/settingsStore.test.ts -t density`

- [ ] **Step 3: Add `densityMode` to the store**

In `settingsStore.ts`, mirroring `timeFormat` exactly:

```ts
export type DensityMode = 'comfortable' | 'compact'
// ...in SettingsState:
  densityMode: DensityMode
  setDensityMode: (mode: DensityMode) => void
// ...constant:
const DENSITY_KEY = 'fluux-density'
// ...initializer:
function getInitialDensity(): DensityMode {
  try {
    const stored = localStorage.getItem(DENSITY_KEY)
    if (stored === 'comfortable' || stored === 'compact') return stored
  } catch { /* localStorage not available */ }
  return 'comfortable'
}
// ...in create():
  densityMode: getInitialDensity(),
  setDensityMode: (mode) => {
    try { localStorage.setItem(DENSITY_KEY, mode) } catch { /* localStorage not available */ }
    set({ densityMode: mode })
  },
```

- [ ] **Step 4: Run the store test — expect PASS.**

- [ ] **Step 5: Write the failing hook test**

`useDensity.test.ts`:

```tsx
import { renderHook } from '@testing-library/react'
import { useDensity } from './useDensity'
import { useSettingsStore } from '@/stores/settingsStore'

it('sets data-density on documentElement to the current mode', () => {
  useSettingsStore.getState().setDensityMode('compact')
  renderHook(() => useDensity())
  expect(document.documentElement.getAttribute('data-density')).toBe('compact')
})
```

- [ ] **Step 6: Run it — expect FAIL.**

- [ ] **Step 7: Create the hook**

`apps/fluux/src/hooks/useDensity.ts`:

```ts
import { useEffect } from 'react'
import { useSettingsStore } from '@/stores/settingsStore'

/**
 * Applies the current density preference to the document root as a
 * `data-density` attribute, so CSS keyed on `[data-density="compact"]` adjusts
 * spacing app-wide with no React re-render of list rows.
 */
export function useDensity(): void {
  const densityMode = useSettingsStore((s) => s.densityMode)
  useEffect(() => {
    document.documentElement.setAttribute('data-density', densityMode)
  }, [densityMode])
}
```

- [ ] **Step 8: Call it at the app root**

Find the component where the theme mode is applied to `document.documentElement` (search the codebase: the place that calls the theme-apply hook / `applyMode`, near `useTheme.ts` usage — likely `App.tsx` or a top-level provider). Add `useDensity()` there alongside the existing theme application, and import it. (It must run once at the root, not per-row.)

- [ ] **Step 9: Run both tests — expect PASS.**

Run: `cd apps/fluux && npx vitest run src/stores/settingsStore.test.ts src/hooks/useDensity.test.ts`

- [ ] **Step 10: Typecheck + commit**

```bash
npm run typecheck
git add apps/fluux/src/stores/settingsStore.ts apps/fluux/src/stores/settingsStore.test.ts apps/fluux/src/hooks/useDensity.ts apps/fluux/src/hooks/useDensity.test.ts <app-root-file>
git -c commit.gpgsign=false commit -m "feat(density): densityMode preference + useDensity (data-density root attribute)"
```

---

### Task 2: Settings "Display density" toggle + i18n

**Files:**
- Modify: `apps/fluux/src/components/settings-components/AppearanceSettings.tsx`
- Modify: `apps/fluux/src/i18n/locales/*.json` (all 33)
- Test: `apps/fluux/src/components/settings-components/AppearanceSettings.test.tsx` (create or extend), `apps/fluux/src/i18n/i18n.test.ts` (already enforces key presence)

**Interfaces:**
- Consumes: `densityMode` + `setDensityMode` from Task 1.
- Produces: a "Display density" two-option control in the Appearance section.

- [ ] **Step 1: Add i18n keys (English first)**

In `apps/fluux/src/i18n/locales/en.json`, in the `settings` object (near `mode`/`motion` ~line 812-827):

```json
"density": "Display density",
"comfortable": "Comfortable",
"compact": "Compact",
"densityComfortableDescription": "Roomy spacing, larger avatars.",
"densityCompactDescription": "Tighter spacing so more fits on screen."
```

(No em-dashes / en-dashes.)

- [ ] **Step 2: Add the same keys to the other 32 locale files**

For each `apps/fluux/src/i18n/locales/<lang>.json` (every file except `en.json`), add the five keys under `settings` with a **real translation** for that language (not the English text). `i18n.test.ts` will fail if any key is missing in any locale.

- [ ] **Step 3: Write the failing component test**

`AppearanceSettings.test.tsx` (follow the file's existing render/mocks if present; otherwise mirror another settings test):

```tsx
it('renders the density toggle and switches density', () => {
  render(<AppearanceSettings />)
  const compact = screen.getByRole('button', { name: /compact/i })
  fireEvent.click(compact)
  expect(useSettingsStore.getState().densityMode).toBe('compact')
})
```

- [ ] **Step 4: Run it — expect FAIL.**

- [ ] **Step 5: Add the density control**

In `AppearanceSettings.tsx`: add the options array near `motionOptions` (~line 17):

```tsx
const densityOptions: { value: DensityMode; labelKey: string; descriptionKey: string }[] = [
  { value: 'comfortable', labelKey: 'settings.comfortable', descriptionKey: 'settings.densityComfortableDescription' },
  { value: 'compact', labelKey: 'settings.compact', descriptionKey: 'settings.densityCompactDescription' },
]
```

Import `type DensityMode` from the settings store; read state in the component (near line 199):

```tsx
const densityMode = useSettingsStore((s) => s.densityMode)
const setDensityMode = useSettingsStore((s) => s.setDensityMode)
```

Add a section in the returned JSX after the Motion block (~line 310), mirroring that block's markup but as a 2-column grid:

```tsx
{/* Display density */}
<div className="space-y-3">
  <label className="text-sm font-medium text-fluux-text">{t('settings.density')}</label>
  <div className="grid grid-cols-2 gap-3">
    {densityOptions.map((option) => {
      const isSelected = densityMode === option.value
      return (
        <button
          key={option.value}
          onClick={() => setDensityMode(option.value)}
          className={`flex flex-col items-center gap-2 p-4 rounded-lg border-2 transition-all
            ${isSelected ? 'border-fluux-brand bg-fluux-brand/10' : 'border-fluux-hover bg-fluux-bg hover:border-fluux-muted'}`}
        >
          <span className={`text-sm font-medium ${isSelected ? 'text-fluux-text' : 'text-fluux-muted'}`}>
            {t(option.labelKey)}
          </span>
        </button>
      )
    })}
  </div>
  <p className="text-xs text-fluux-muted mt-2">
    {t(densityOptions.find(o => o.value === densityMode)?.descriptionKey || '')}
  </p>
</div>
```

- [ ] **Step 6: Run the component + i18n tests — expect PASS.**

Run: `cd apps/fluux && npx vitest run src/components/settings-components/AppearanceSettings.test.tsx src/i18n/i18n.test.ts`

- [ ] **Step 7: Typecheck + commit**

```bash
npm run typecheck
git add apps/fluux/src/components/settings-components/AppearanceSettings.tsx apps/fluux/src/components/settings-components/AppearanceSettings.test.tsx apps/fluux/src/i18n/locales/
git -c commit.gpgsign=false commit -m "feat(density): Display density toggle in Appearance settings"
```

---

### Task 3: Sidebar rows — density + unread emphasis

**Files:**
- Modify: `apps/fluux/src/index.css` (`.sidebar-row` density CSS)
- Modify: `apps/fluux/src/components/sidebar-components/ConversationList.tsx`, `ContactList.tsx`, `RoomsList.tsx`
- Test: extend the existing list tests (or `ConversationList.test.tsx`)

**Interfaces:**
- Consumes: `data-density` (Task 1), `densityMode` selector, `Avatar` `size` prop (`md`=40px / `sm`=32px).
- Produces: the shared `.sidebar-row` row styling; rows render avatar `md` in comfortable / `sm` in compact; unread rows render a brighter semibold name.

- [ ] **Step 1: Write the failing test (ConversationItem)**

```tsx
// unread row → semibold + brighter name; read row → font-medium
it('emphasizes the name on unread conversations', () => {
  // render ConversationList with one unread (unreadCount>0) and one read conversation
  // (follow the file's existing test harness for seeding conversations)
  // unread name element has 'font-semibold'; read name has 'font-medium'
})
it('uses a compact avatar when density is compact', () => {
  useSettingsStore.getState().setDensityMode('compact')
  // render; the 1:1 Avatar should be size-8 (sm); in comfortable it is size-10 (md)
})
```

(Write these against the real seeding the test file already uses; assert via `container.querySelector`/class checks.)

- [ ] **Step 2: Run — expect FAIL.**

- [ ] **Step 3: Add the density CSS**

In `index.css`, near the sidebar styles, add:

```css
/* Sidebar list rows. Horizontal padding stays a utility (px-2); the density-
 * varying vertical padding + gap live here so a [data-density] flip needs no
 * row re-render. Comfortable is the default. */
.sidebar-row { padding-block: 8px; column-gap: 12px; }
[data-density="compact"] .sidebar-row { padding-block: 4px; column-gap: 8px; }
```

- [ ] **Step 4: Apply to `ConversationItem`**

In `ConversationList.tsx` row (~line 275): add `sidebar-row` to the className and **remove** the `py-1.5 gap-3` utilities (now CSS-driven); keep `px-2`. Read density + size the avatar:

```tsx
const densityMode = useSettingsStore((s) => s.densityMode)
const avatarSize = densityMode === 'compact' ? 'sm' : 'md'
// group avatar: const avatarBox = densityMode === 'compact' ? 'size-8' : 'size-10'
```

- 1:1 Avatar (~line 311): `size={avatarSize}`.
- Group avatar img/Hash (~line 295/302): replace `size-8` with `${avatarBox}` (keep `rounded-xl`, and the Hash `p-1.5`).
- Unread name (~line 325): make the name conditional on `conversation.unreadCount > 0`:

```tsx
<p dir="auto" className={`truncate ${conversation.unreadCount > 0 ? 'font-semibold text-fluux-text' : 'font-medium'}`}>{conversation.name}</p>
```

Leave the unread count badge where it is (overlaid on the avatar — this position is deliberate per the `UX_REVIEW §3.1` comment at ~line 286, to preserve name-column width; see the flag in "Open flags").

- [ ] **Step 5: Apply the identical treatment to `ContactItem` and the `RoomsList` row**

- `ContactList.tsx` (`ContactItem` ~line 370): add `sidebar-row`, remove `py-1.5 gap-3`, size the avatar by density (`Avatar size={avatarSize}`). Contacts have no unread, so no name-emphasis branch (name stays `font-medium`).
- `RoomsList.tsx` (row ~line 381): same as ConversationItem — `sidebar-row`, density avatar (group avatar box `size-8`→`size-10`), and the unread name emphasis using the room's unread count field (match the field RoomsList already uses for its unread badge).

- [ ] **Step 6: Run the list tests + the perf/memo guard — expect PASS.**

Run: `cd apps/fluux && npx vitest run src/components/sidebar-components/ src/components/renderLoop* 2>/dev/null; cd apps/fluux && npx vitest run src/components/sidebar-components`
Expected: PASS; no new re-render warnings.

- [ ] **Step 7: Typecheck + commit**

```bash
npm run typecheck
git add apps/fluux/src/index.css apps/fluux/src/components/sidebar-components/
git -c commit.gpgsign=false commit -m "feat(chrome): density-aware sidebar rows + unread name emphasis"
```

---

### Task 4: Icon rail density

**Files:**
- Modify: `apps/fluux/src/index.css` (`.icon-rail*` density CSS)
- Modify: `apps/fluux/src/components/Sidebar.tsx` (rail container ~line 220), `apps/fluux/src/components/sidebar-components/IconRailNavLink.tsx`
- Test: extend `IconRailNavLink` / Sidebar test if present (else a light render assertion)

**Interfaces:**
- Consumes: `data-density`.
- Produces: `.icon-rail` (container) + `.icon-rail-btn` (button) classes whose width/size respond to density via CSS.

- [ ] **Step 1: Add the density CSS**

```css
/* Icon rail density. Width + button + icon shrink in compact. */
.icon-rail { width: 56px; }
.icon-rail-btn { width: 40px; height: 40px; }
.icon-rail-btn svg { width: 20px; height: 20px; }
[data-density="compact"] .icon-rail { width: 48px; }
[data-density="compact"] .icon-rail-btn { width: 36px; height: 36px; }
[data-density="compact"] .icon-rail-btn svg { width: 18px; height: 18px; }
```

- [ ] **Step 2: Apply the classes**

- `Sidebar.tsx` rail container (~line 220): add `icon-rail`; **remove** the `w-14` utility (CSS now owns width). Keep `bg-fluux-bg flex flex-col items-center pt-8 pb-safe-3 gap-2`.
- `IconRailNavLink.tsx` button (~line 40-54): add `icon-rail-btn`; **remove** the `size-10` utility (CSS owns it). The icon stays `size-5` as a base, but the `.icon-rail-btn svg` rule overrides dimensions per density. Keep `rounded-xl` and the active/inactive color classes.

- [ ] **Step 3: Verify render + typecheck**

Run: `cd apps/fluux && npx vitest run src/components/sidebar-components/IconRailNavLink.test.tsx 2>/dev/null; npm run typecheck`
Expected: PASS / clean (if no test exists for IconRailNavLink, add a minimal one asserting the `icon-rail-btn` class is present).

- [ ] **Step 4: Commit**

```bash
git add apps/fluux/src/index.css apps/fluux/src/components/Sidebar.tsx apps/fluux/src/components/sidebar-components/IconRailNavLink.tsx
git -c commit.gpgsign=false commit -m "feat(chrome): density-aware icon rail"
```

---

### Task 5: Screenshots + full verification

**Files:**
- Modify: `scripts/screenshots.ts`
- Verify: whole suite, typecheck, lint, i18n, screenshots

- [ ] **Step 1: Add comfortable + compact sidebar scenes**

In `scripts/screenshots.ts`, following the existing scene pattern, add two scenes that render the sidebar with `data-density="comfortable"` and `data-density="compact"` (set the density via the settings store or by toggling the attribute before capture). Capture the conversation list at both densities. Name them e.g. `3x-chrome-comfortable.png` / `3x-chrome-compact.png`.

- [ ] **Step 2: Typecheck + lint**

Run from repo root: `npm run typecheck && npm run lint`
Expected: clean, 0 errors.

- [ ] **Step 3: Full suite (incl. i18n)**

Run from repo root: `npm test`
Expected: all pass, no stderr. `i18n.test.ts` green (all 33 locales have the density keys).

- [ ] **Step 4: Screenshots**

Run from repo root: `npm run screenshots`
Expected: completes; the comfortable/compact scenes render with visibly different row density.

- [ ] **Step 5: Commit**

```bash
git add scripts/screenshots.ts screenshots/
git -c commit.gpgsign=false commit -m "feat(chrome): density screenshot scenes + regen"
```

---

## Self-Review

**Spec coverage:**
- Global `densityMode` preference + persist + default comfortable → Task 1. ✓
- `data-density` root attribute mechanism → Task 1 (`useDensity`). ✓
- Settings "Display density" toggle + i18n → Task 2. ✓
- Density values for sidebar rows → Task 3; icon rail → Task 4. ✓ (Message pane = Phase 2, out of scope. ✓)
- Chrome polish: unread emphasis → Task 3; active state kept (unchanged) → Task 3. ✓
- Render-perf (CSS for spacing, narrow selector only for avatar, memo intact) → Global Constraints + Tasks 1/3. ✓
- Accessibility (unread name AA, toggle keyboard) → toggle uses buttons; unread name uses `text-fluux-text` (AA on sidebar). Verified in Task 5 screenshots + the contrast already holds for `text-fluux-text`.
- Testing + screenshots → Task 5. ✓

**Placeholder scan:** no TBD/TODO; each code step shows real code. The "find the app-root theme-apply site" (Task 1 step 8) and "match the RoomsList unread field" (Task 3 step 5) are concrete anchors, not placeholders.

**Type consistency:** `DensityMode` defined in Task 1, imported in Tasks 2-3; `densityMode`/`setDensityMode` names consistent; `data-density` attribute value matches the `[data-density="compact"]` CSS selector in Tasks 3-4; Avatar `size` values (`md`/`sm`) match the Avatar preset names.

## Open flags for the controller / human

- **Unread badge position.** The design spec said move the unread count badge to the row's trailing edge. During planning, the code revealed a deliberate `UX_REVIEW §3.1` decision to overlay it on the avatar so the name column keeps full width. This plan therefore **keeps the badge on the avatar** and delivers the unread "pull" via the **name emphasis** (semibold + brighter) instead. If you prefer the trailing-edge badge (accepting slightly more name truncation on unread rows), say so and Task 3 changes accordingly.
- **Phase 2** (central message-pane density) is a separate plan after this lands.
