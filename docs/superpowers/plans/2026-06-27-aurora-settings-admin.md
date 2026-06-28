# Aurora Settings and Admin Consistency Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give settings (and, lightly, admin) one consistent Aurora rhythm via a small shared primitive kit, and add a breadcrumb so admin home is always one click away.

**Architecture:** Five presentational primitives in `components/ui/` (`Toggle`, `Select`, `SettingsSection`, `SettingsGroup`, `SettingsRow`) unify the hand-rolled section headers, rows, toggles, and selects across the settings panes. Admin gets a light pass: a shared breadcrumb (home affordance), tokenized colors, and display-font headers. All surfaces are token-based; settings render on `bg-fluux-chat` and admin on `bg-fluux-sidebar`, both already AA-guarded.

**Tech Stack:** React + TypeScript, Tailwind + CSS custom properties, lucide-react, Vitest + Testing Library. No SDK changes.

## Global Constraints

- **Presentational primitives:** the kit lives in `components/ui/`, takes state + strings as props (callers own i18n + state), mirroring `ui/TextInput`/`ui/ListEmpty`. Token-based only.
- **Theme-aware tokens, no hardcoded colors:** replace every literal Tailwind color (`red-500`, `green-500`, `amber-`, `yellow-`, `blue-`) with a `fluux-` token (`text-fluux-red`/`green`/`yellow`/`blue`, `bg-fluux-red/10`, etc.). The `Toggle` on-state is `bg-fluux-brand` + white knob (the existing white-on-accent AA invariant). Dividers use `--fluux-surface-divider`.
- **Layout/consistency only — no behavior or copy change:** migrations keep each pane's controls, logic, and existing i18n keys. No new settings, no copy rewrites.
- **Breadcrumb reuses existing i18n** (`admin.title`, `admin.categories.users`/`.rooms`, `admin.overview.title`); leaf crumbs use live `user.jid`/`room.name`. Crumb separator is a chevron ICON, never an em-dash/slash glyph. No new i18n keys.
- **Contrast already guarded:** settings = `bg-fluux-chat`, admin = `bg-fluux-sidebar`; `emptyStateContrast.test.ts` already asserts `text-normal` + `text-muted` AA on BOTH. No new contrast token work expected (confirm in Task 5).
- **No em-dashes/en-dashes** in any user-facing string. **Admin friendliness redesign is OUT of scope** (separate track).

## File Structure

- Create: `components/ui/Toggle.tsx`, `Select.tsx`, `SettingsSection.tsx`, `SettingsGroup.tsx`, `SettingsRow.tsx` (+ tests for Toggle/Select).
- Create: `components/AdminBreadcrumb.tsx` (+ test).
- Modify: the 11 settings panes + 3 profile subsections in `settings-components/` (Tasks 2-3).
- Modify: `AdminView.tsx`, `AdminUserView.tsx`, `AdminRoomView.tsx`, `EntityListView.tsx`, `AdminCommandForm.tsx`, `admin/UserListItem.tsx` (Task 4).
- Modify: `scripts/screenshots.ts` (Task 5).

---

### Task 1: The shared primitive kit

**Files:**
- Create: `apps/fluux/src/components/ui/Toggle.tsx`, `Select.tsx`, `SettingsSection.tsx`, `SettingsGroup.tsx`, `SettingsRow.tsx`
- Test: `apps/fluux/src/components/ui/Toggle.test.tsx`, `Select.test.tsx`

**Interfaces:**
- Produces: `Toggle({ checked, onChange, disabled?, id?, 'aria-label'? })`, `Select({ children, className?, ...selectProps })`, `SettingsSection({ title, description?, children, className? })`, `SettingsGroup({ children, className? })`, `SettingsRow({ label, description?, htmlFor?, children, className? })`.

- [ ] **Step 1: Write the failing tests**

`apps/fluux/src/components/ui/Toggle.test.tsx` (mirror `ui/ListEmpty.test.tsx` style — props in, role/attr out):
```tsx
import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { Toggle } from './Toggle'

describe('Toggle', () => {
  it('exposes role=switch + aria-checked and toggles on click', () => {
    const onChange = vi.fn()
    render(<Toggle checked={false} onChange={onChange} aria-label="Sounds" />)
    const sw = screen.getByRole('switch', { name: 'Sounds' })
    expect(sw).toHaveAttribute('aria-checked', 'false')
    fireEvent.click(sw)
    expect(onChange).toHaveBeenCalledWith(true)
  })
  it('does not fire onChange when disabled', () => {
    const onChange = vi.fn()
    render(<Toggle checked={false} onChange={onChange} disabled aria-label="Sounds" />)
    fireEvent.click(screen.getByRole('switch'))
    expect(onChange).not.toHaveBeenCalled()
  })
})
```
`apps/fluux/src/components/ui/Select.test.tsx`:
```tsx
import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { Select } from './Select'

describe('Select', () => {
  it('renders options and fires onChange', () => {
    const onChange = vi.fn()
    render(<Select value="a" onChange={onChange}><option value="a">A</option><option value="b">B</option></Select>)
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'b' } })
    expect(onChange).toHaveBeenCalled()
  })
})
```

- [ ] **Step 2: Run, verify they fail**

Run: `cd apps/fluux && npx vitest run src/components/ui/Toggle.test.tsx src/components/ui/Select.test.tsx`
Expected: FAIL (modules not found).

- [ ] **Step 3: Implement the 5 primitives**

`Toggle.tsx` (replicates the existing hand-rolled toggle markup + adds `role="switch"`):
```tsx
interface ToggleProps {
  checked: boolean
  onChange: (next: boolean) => void
  disabled?: boolean
  id?: string
  'aria-label'?: string
}

export function Toggle({ checked, onChange, disabled = false, id, 'aria-label': ariaLabel }: ToggleProps) {
  return (
    <button
      type="button"
      role="switch"
      id={id}
      aria-checked={checked}
      aria-label={ariaLabel}
      disabled={disabled}
      onClick={() => !disabled && onChange(!checked)}
      className={`relative w-9 h-5 rounded-full transition-colors flex-shrink-0 ${
        checked ? 'bg-fluux-brand' : 'bg-fluux-hover'
      } ${disabled ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer'}`}
    >
      <span
        className={`absolute top-0.5 start-0.5 size-4 rounded-full bg-white transition-transform ${
          checked ? 'translate-x-4' : ''
        }`}
      />
    </button>
  )
}
```

`Select.tsx` (the LanguageSettings select style, as a wrapper):
```tsx
import { ChevronDown } from 'lucide-react'
import type { SelectHTMLAttributes, ReactNode } from 'react'

interface SelectProps extends SelectHTMLAttributes<HTMLSelectElement> {
  children: ReactNode
}

export function Select({ children, className = '', ...props }: SelectProps) {
  return (
    <div className="relative">
      <select
        {...props}
        className={`w-full appearance-none px-4 py-3 pe-10 rounded-lg border-2 border-fluux-hover bg-fluux-bg text-fluux-text cursor-pointer hover:border-fluux-muted focus:border-fluux-brand focus:outline-none transition-colors ${className}`}
      >
        {children}
      </select>
      <ChevronDown className="absolute end-3 top-1/2 -translate-y-1/2 size-5 text-fluux-muted pointer-events-none" />
    </div>
  )
}
```

`SettingsSection.tsx` (the shared section label — keeps the existing `text-xs uppercase` style that all 12 panes already use):
```tsx
import type { ReactNode } from 'react'

interface SettingsSectionProps {
  title: string
  description?: string
  children: ReactNode
  className?: string
}

export function SettingsSection({ title, description, children, className = '' }: SettingsSectionProps) {
  return (
    <section className={className}>
      <h3 className="text-xs font-semibold text-fluux-muted uppercase tracking-wide mb-1">{title}</h3>
      {description && <p className="text-xs text-fluux-muted mb-3">{description}</p>}
      <div className={description ? '' : 'mt-3'}>{children}</div>
    </section>
  )
}
```

`SettingsGroup.tsx` (the grouped-row card — hairline border + dividers):
```tsx
import type { ReactNode } from 'react'

export function SettingsGroup({ children, className = '' }: { children: ReactNode; className?: string }) {
  return (
    <div className={`rounded-lg border border-[color:var(--fluux-surface-divider)] divide-y divide-[color:var(--fluux-surface-divider)] overflow-hidden ${className}`}>
      {children}
    </div>
  )
}
```

`SettingsRow.tsx` (uniform label + description + control row):
```tsx
import type { ReactNode } from 'react'

interface SettingsRowProps {
  label: string
  description?: string
  htmlFor?: string
  children?: ReactNode
  className?: string
}

export function SettingsRow({ label, description, htmlFor, children, className = '' }: SettingsRowProps) {
  return (
    <div className={`flex items-center justify-between gap-4 px-4 py-3 ${className}`}>
      <div className="min-w-0">
        <label htmlFor={htmlFor} className="block text-sm text-fluux-text">{label}</label>
        {description && <p className="text-xs text-fluux-muted mt-0.5">{description}</p>}
      </div>
      {children != null && <div className="flex-shrink-0">{children}</div>}
    </div>
  )
}
```

- [ ] **Step 4: Run, verify they pass**

Run: `cd apps/fluux && npx vitest run src/components/ui/Toggle.test.tsx src/components/ui/Select.test.tsx` ; then repo root `npm run typecheck`.
Expected: PASS / clean.

- [ ] **Step 5: Commit**

```bash
git add apps/fluux/src/components/ui/Toggle.tsx apps/fluux/src/components/ui/Select.tsx apps/fluux/src/components/ui/SettingsSection.tsx apps/fluux/src/components/ui/SettingsGroup.tsx apps/fluux/src/components/ui/SettingsRow.tsx apps/fluux/src/components/ui/Toggle.test.tsx apps/fluux/src/components/ui/Select.test.tsx
git -c commit.gpgsign=false commit -m "feat(settings): shared Aurora settings primitive kit (Toggle, Select, Section, Group, Row)"
```

---

### Task 2: Migrate settings panes — batch A (controls + free-form sections)

**Files (Modify):** `settings-components/` — `LanguageSettings.tsx` (2 Selects), `EncryptionSettings.tsx` (1 Toggle), `AppearanceSettings.tsx` (1 Toggle), and wrap sections in `SettingsSection` for `NotificationsSettings.tsx`, `PrivacySettings.tsx`, `StorageSettings.tsx`, `AdvancedSettings.tsx`, `UpdatesSettings.tsx`, `AccessibilitySettings.tsx`. Tokenize their hardcoded colors.
**Test:** the panes' existing `.test.tsx` files.

**Interfaces:** Consumes Task 1's primitives. Import from `@/components/ui/Toggle` etc. (or the `ui` barrel if present).

The migration is mechanical + per-pane. The PATTERN (apply to each):
- Replace the hand-rolled toggle `<button className="relative w-9 h-5 ...">...</button>` (EncryptionSettings ~898, AppearanceSettings ~390) with `<Toggle checked={...} onChange={(next) => ...} disabled={...} aria-label={...} />`, preserving the existing state + handler (e.g. EncryptionSettings: `checked={openpgpEnabled} onChange={handleToggle} disabled={toggleDisabled}`; Appearance snippet: `checked={snippet.enabled} onChange={() => toggleSnippet(snippet.id)}`).
- Replace the `LanguageSettings` `<select className={selectClassName}>...</select>` + its `ChevronDown` overlay + the wrapping `<div className="relative">` with `<Select value={...} onChange={...} id={...}>{options}</Select>` (do this for BOTH selects; drop the now-unused `selectClassName` + `ChevronDown` import + `isDark` if only used for `[color-scheme]`).
- Wrap each pane's existing section header `<h3 className="text-xs font-semibold text-fluux-muted uppercase tracking-wide mb-4">{t(...)}</h3>` + its content in `<SettingsSection title={t(...)}>...</SettingsSection>` (the section header is now the component's; remove the raw `<h3>`). Keep all free-form content (status cards, button-grids, sliders) inside.
- Tokenize hardcoded colors in these panes: `NotificationsSettings.tsx` `text-green-500`/`text-red-500`/`text-yellow-500` (~156/158/231-234/261) -> `text-fluux-green`/`text-fluux-red`/`text-fluux-yellow`; `EncryptionSettings.tsx:890` `bg-yellow-500/15 text-yellow-600 dark:text-yellow-400` -> `bg-fluux-yellow/15 text-fluux-yellow`. (Confirm the `fluux-{green,red,yellow}` utility classes exist in `tailwind.config.js`; they are used elsewhere e.g. `text-fluux-yellow` in the occupant/empty-states slices.)

- [ ] **Step 1: Spot-check the existing pane tests pass on the OLD code**

Run: `cd apps/fluux && npx vitest run src/components/settings-components/AppearanceSettings.test.tsx src/components/settings-components/AccessibilitySettings.test.tsx`
Expected: PASS (baseline before migration).

- [ ] **Step 2: Apply the migration to batch-A panes** (per the pattern above). Each pane keeps its controls, handlers, and i18n keys; only the markup wrappers/toggle/select change.

- [ ] **Step 3: Run the batch-A pane tests + typecheck**

Run: `cd apps/fluux && npx vitest run src/components/settings-components` ; then repo root `npm run typecheck`.
Expected: PASS / clean. (The pane tests assert on i18n keys + control behavior, which are unchanged.) Update any test that queried the old toggle `<button>` by class to query `getByRole('switch')` instead.

- [ ] **Step 4: Commit**

```bash
git add apps/fluux/src/components/settings-components
git -c commit.gpgsign=false commit -m "feat(settings): migrate batch-A panes to the primitive kit + tokenize colors"
```

---

### Task 3: Migrate settings panes — batch B (row-lists + profile)

**Files (Modify):** `settings-components/` — `BlockedUsersSettings.tsx` (blocked-user rows), `AppearanceSettings.tsx` (CSS-snippet rows -> SettingsRow/Group; theme/density/accent grids stay free-form inside SettingsSection), `ProfileSettings.tsx` + `settings-components/profile/` (`VCardSection.tsx`, `DevicesSection.tsx`, `AccountSection.tsx`). Wrap sections in `SettingsSection`; convert their ad-hoc row-lists to `SettingsGroup` + `SettingsRow` where they are genuinely label+control rows.

**Interfaces:** Consumes Task 1's primitives.

- [ ] **Step 1: Apply the row migration**

For each row-list that is a list of `label (+ description) + control/value` rows (e.g. `AccountSection` account-info rows, `StorageSettings` value-rows if not done in batch A, `BlockedUsersSettings` unblock rows), wrap the list in `<SettingsGroup>` and render each row as `<SettingsRow label={...} description={...}>{control}</SettingsRow>`. Free-form subsections (the profile hero, the theme/accent grids, the vCard inline-edit popovers) stay as custom content inside a `SettingsSection` — do NOT force them into rows.

- [ ] **Step 2: Run the affected tests + typecheck**

Run: `cd apps/fluux && npx vitest run src/components/settings-components` ; then repo root `npm run typecheck`.
Expected: PASS / clean.

- [ ] **Step 3: Commit**

```bash
git add apps/fluux/src/components/settings-components
git -c commit.gpgsign=false commit -m "feat(settings): migrate batch-B row-lists + profile to SettingsGroup/Row"
```

---

### Task 4: Admin light pass — breadcrumb + tokens + headers

**Files:**
- Create: `apps/fluux/src/components/AdminBreadcrumb.tsx`, `AdminBreadcrumb.test.tsx`
- Modify: `AdminView.tsx` (host the breadcrumb in the header ~500-527), `AdminUserView.tsx`, `AdminRoomView.tsx`, `EntityListView.tsx`, `AdminCommandForm.tsx`, `admin/UserListItem.tsx`

**Interfaces:** Consumes the admin store (`adminStore`/`useAdminStore`) + the existing navigation handlers.

- [ ] **Step 1: Build `AdminBreadcrumb`**

A presentational breadcrumb: `AdminBreadcrumb({ crumbs }: { crumbs: { label: string; onClick?: () => void }[] })` — renders each crumb (clickable if `onClick`, in `text-fluux-muted hover:text-fluux-text`; the last crumb `text-fluux-text`, non-clickable) separated by a `<ChevronRight className="size-3.5 text-fluux-muted" />` icon. Test (mirror ListEmpty style): renders the labels, fires `onClick` on a crumb, the last crumb has no button.

- [ ] **Step 2: Wire the crumbs in the admin header**

In `AdminView.tsx` (the host header ~500-527), compute the crumb trail from the admin state and render `<AdminBreadcrumb crumbs={...} />` in place of (or beside) the current `getIcon()` + `<h2>{getTitle()}</h2>`:
- Crumb 1 — **home**: `{ label: t('admin.title'), onClick: () => { clearAdminSession(); setSelectedUser?.(null); setSelectedRoom?.(null); adminStore.getState().setActiveCategory('stats') } }` (this is the back-to-admin-home affordance; `'stats'` = the overview home). Use the EXACT handlers AdminView already has in scope (`handleHeaderBack`/`adminStore.getState().setActiveCategory`), per `adminBackTarget.ts` + `AdminView.tsx:178-203`.
- Crumb 2 — **category** (when a user/room is selected): `{ label: t('admin.categories.users') | t('admin.categories.rooms'), onClick: () => setSelectedUser/Room(null) }`.
- Crumb 3 — **leaf** (no onClick): the live `user.jid` / `room.name` (or the category title when at the list level).
Reuse the existing `getTitle()` mapping for labels. Keep the mobile `ArrowLeft`/`Menu` buttons. NOTE the test gotcha: `AdminView` reads `useAdminStore` from `@fluux/sdk/react` (a different specifier than `@fluux/sdk`); any new store read must not break `AdminView.test.tsx`'s mock (see its setup) — prefer reading the already-destructured state/handlers AdminView has rather than adding new store subscriptions.

- [ ] **Step 3: Tokenize admin hardcoded colors + align headers**

Replace the literals: `AdminView.tsx:408` `bg-amber-500/10 text-amber-700 dark:text-amber-300` -> `bg-fluux-yellow/10 text-fluux-yellow`; `AdminRoomView.tsx:126` `text-red-500` -> `text-fluux-red`; `AdminRoomView.tsx:164` + `AdminUserView.tsx:96` `bg-red-500/10 hover:bg-red-500/20 text-red-500` -> `bg-fluux-red/10 hover:bg-fluux-red/20 text-fluux-red`; `AdminCommandForm.tsx:170-172` blue/yellow/red literals -> the `fluux-blue/yellow/red` equivalents; `admin/UserListItem.tsx:47` `text-green-600 dark:text-green-400` -> `text-fluux-green`, `:74` `bg-green-500` -> `bg-fluux-green`. (Confirm each `fluux-` utility exists; if a needed one is missing from `tailwind.config.js`, note it and use the closest existing token rather than inventing a class.) Add `font-display` to the admin `<h2>` titles (`AdminUserView.tsx:54`, `AdminRoomView.tsx:106`, `EntityListView.tsx:61`) so admin and settings share the title type.

- [ ] **Step 4: Run admin tests + typecheck**

Run: `cd apps/fluux && npx vitest run src/components/AdminView.test.tsx src/components/AdminRoomView.test.tsx src/components/AdminBreadcrumb.test.tsx` ; then repo root `npm run typecheck`.
Expected: PASS / clean. If the breadcrumb changed the header structure a test queried, update the query (keep the assertion meaning).

- [ ] **Step 5: Commit**

```bash
git add apps/fluux/src/components/AdminBreadcrumb.tsx apps/fluux/src/components/AdminBreadcrumb.test.tsx apps/fluux/src/components/AdminView.tsx apps/fluux/src/components/AdminUserView.tsx apps/fluux/src/components/AdminRoomView.tsx apps/fluux/src/components/EntityListView.tsx apps/fluux/src/components/AdminCommandForm.tsx apps/fluux/src/components/admin/UserListItem.tsx
git -c commit.gpgsign=false commit -m "feat(admin): breadcrumb home affordance + tokenized colors + display-font headers"
```

---

### Task 5: Verification + screenshots

**Files:** Modify `scripts/screenshots.ts`; verify the whole slice.

- [ ] **Step 1: Confirm the contrast coverage (no new guard expected)**

The settings surface is `bg-fluux-chat` (`--fluux-chat-bg`) and admin is `bg-fluux-sidebar` (`--fluux-sidebar-bg`). `apps/fluux/src/themes/emptyStateContrast.test.ts` already asserts `text-normal` + `text-muted` AA on BOTH across 13 themes x 2 modes. Run it to confirm it is green: `cd apps/fluux && npx vitest run src/themes/emptyStateContrast.test.ts`. (No new token work expected; the kit adds no new text-on-surface pair. If a NEW surface/token was introduced, extend the guard.)

- [ ] **Step 2: Add screenshot scenes**

In `scripts/screenshots.ts`, add scenes: 2-3 settings panes (navigate to settings + a category — e.g. Notifications, Appearance) and one admin view (the demo seeds admin per scene 07; drill into a user/room to show the breadcrumb), in Aurora dark + light + gruvbox. Reuse the existing settings/admin navigation helpers (scene 07 shows how admin is reached). Name them `7x-settings-<theme>` / `7x-admin-breadcrumb-<theme>`. No em-dashes in labels.

- [ ] **Step 3: Regenerate + eyeball**

Run: `npm run screenshots`. Confirm: settings sections have one consistent rhythm, toggles/selects are uniform, the admin breadcrumb shows `Administration > ... ` with the home crumb, colors are tokenized (no off-brand red/amber), text readable in light + dark + gruvbox.

- [ ] **Step 4: Full verification**

Run from repo root: `npm run typecheck` (clean), `npm run lint` (0 errors), `npm test` (all pass, no stderr; incl. the ui primitives, the migrated panes, AdminView/Breadcrumb, emptyStateContrast).

- [ ] **Step 5: Commit**

```bash
git add scripts/screenshots.ts screenshots/
git -c commit.gpgsign=false commit -m "test(settings): settings + admin-breadcrumb screenshot scenes + verification"
```

---

## Self-Review notes

- **Spec coverage:** primitive kit (Task 1) · apply across all settings panes (Tasks 2-3) · admin light pass: breadcrumb home affordance + tokenize + display-font headers (Task 4) · theme-robust, contrast already guarded (Task 5 Step 1) · admin friendliness out of scope (untouched). All covered.
- **Type consistency:** `Toggle({checked,onChange,disabled?,id?,'aria-label'?})`, `Select(...selectProps)`, `SettingsSection/{Group}/{Row}`, `AdminBreadcrumb({crumbs})` — names consistent across tasks.
- **No SDK change** -> no `build:sdk` before typecheck.
- **Known risks flagged:** the `@fluux/sdk` vs `@fluux/sdk/react` dual-path in `AdminView.test.tsx` (Task 4 Step 2); confirm `fluux-{red,green,yellow,blue}` utility classes exist before tokenizing (Tasks 2/4) — use the closest existing token if one is missing, don't invent a class.
