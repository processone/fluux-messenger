# Advanced Mode Toggle Placement Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `advancedMode` reachable in-app (fixing the autoconnect trap), declutter the login screen into a kebab, and gate the XMPP console behind the flag.

**Architecture:** `advancedMode` becomes the single "expert surface" switch. Its canonical home moves to the always-visible Settings -> Advanced category (breaking the chicken-and-egg gate). The login screen's two advanced affordances (checkbox + SERVER chevron) collapse into one kebab whose toggle reveals the custom-server field. The console toggle in the user menu is shown only when the flag is on. The store ([advancedModeStore.ts](../../../apps/fluux/src/stores/advancedModeStore.ts)) is unchanged; the persisted key `fluux-advanced-mode` stays, so existing users keep their setting and no migration is needed.

**Tech Stack:** React + TypeScript, Zustand (vanilla store with reactive `useAdvancedModeStore` + non-reactive `isAdvancedMode`), Vitest + Testing Library, react-i18next (33 locales), lucide-react icons, Tailwind.

## Global Constraints

- App tests run from the app package: `cd apps/fluux && npx vitest run <path>` (the repo-root vitest config lacks the `@` path alias).
- Typecheck with `npm run typecheck` from the repo root; lint with `npm run lint`. Both must pass with no errors before each commit.
- Tests must pass with no errors and no stderr noise.
- No em-dashes (`—`) or en-dashes (`–`) in any user-facing string (UI / i18n / prose).
- New i18n keys require a genuine translation in **every** locale file under `apps/fluux/src/i18n/locales/` (33 files); `i18n.test.ts` fails if any key is missing. No placeholders, no English-in-other-locales.
- Commit messages: conventional style, imperative; **never** include any Claude footer or attribution.
- Work happens on the current branch in this worktree; do not commit to `main`.

---

### Task 1: OverflowMenu — checkable toggle item

Add an optional `active` flag to `OverflowMenuItem` so the login kebab can render "Advanced mode" as a toggle with a trailing check and correct a11y semantics. Existing call sites (plain action items) are unaffected because `active` is optional.

**Files:**
- Modify: `apps/fluux/src/components/OverflowMenu.tsx`
- Test: `apps/fluux/src/components/OverflowMenu.test.tsx`

**Interfaces:**
- Consumes: nothing.
- Produces: `OverflowMenuItem` gains `active?: boolean`. When `active` is defined, the item renders with `role="menuitemcheckbox"` and `aria-checked={active}`, plus a trailing check mark when `active === true`. When `active` is `undefined`, behavior is identical to today (`role="menuitem"`, no check).

- [ ] **Step 1: Write the failing tests**

Append these two tests inside the existing `describe('OverflowMenu', ...)` block in `apps/fluux/src/components/OverflowMenu.test.tsx` (just before the closing `})` of the describe):

```tsx
  it('renders an active toggle item with menuitemcheckbox role and aria-checked true', () => {
    render(
      <OverflowMenu
        ariaLabel="More actions"
        items={[{ key: 'adv', label: 'Advanced mode', icon: User, onClick: vi.fn(), active: true }]}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: 'More actions' }))
    const item = screen.getByRole('menuitemcheckbox', { name: 'Advanced mode' })
    expect(item).toHaveAttribute('aria-checked', 'true')
  })

  it('renders an inactive toggle item with aria-checked false', () => {
    render(
      <OverflowMenu
        ariaLabel="More actions"
        items={[{ key: 'adv', label: 'Advanced mode', icon: User, onClick: vi.fn(), active: false }]}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: 'More actions' }))
    const item = screen.getByRole('menuitemcheckbox', { name: 'Advanced mode' })
    expect(item).toHaveAttribute('aria-checked', 'false')
  })
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd apps/fluux && npx vitest run src/components/OverflowMenu.test.tsx`
Expected: FAIL — the two new tests cannot find a `menuitemcheckbox` role (items currently always render `role="menuitem"`).

- [ ] **Step 3: Implement the `active` toggle support**

In `apps/fluux/src/components/OverflowMenu.tsx`:

Change the icon import (line 2) to add `Check`:

```tsx
import { MoreVertical, Check, type LucideIcon } from 'lucide-react'
```

Add the `active` field to the `OverflowMenuItem` interface (after the `disabled` field, around line 16):

```tsx
  /** Disables the item (no click, dimmed). */
  disabled?: boolean
  /**
   * When defined, the item is a checkable toggle: it renders with
   * `role="menuitemcheckbox"`, reflects state via `aria-checked`, and shows a
   * trailing check mark when `true`. Leave undefined for a plain action item.
   */
  active?: boolean
```

Replace the items `.map(...)` block (currently lines 81-96) with:

```tsx
          {items.map(({ key, label, icon: Icon, onClick, danger, disabled, active }) => (
            <button
              key={key}
              role={active === undefined ? 'menuitem' : 'menuitemcheckbox'}
              aria-checked={active === undefined ? undefined : active}
              type="button"
              disabled={disabled}
              onClick={() => {
                setIsOpen(false)
                onClick()
              }}
              className={`w-full flex items-center gap-2 px-3 py-2.5 text-start text-sm transition-colors hover:bg-fluux-active disabled:opacity-50 disabled:cursor-not-allowed ${danger ? 'text-fluux-error' : 'text-fluux-text'}`}
            >
              <Icon className="size-4 flex-shrink-0" />
              <span>{label}</span>
              {active && <Check className="size-4 flex-shrink-0 ms-auto" aria-hidden="true" />}
            </button>
          ))}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd apps/fluux && npx vitest run src/components/OverflowMenu.test.tsx`
Expected: PASS — all existing tests plus the two new ones.

- [ ] **Step 5: Typecheck**

Run: `npm run typecheck`
Expected: PASS, no errors.

- [ ] **Step 6: Commit**

```bash
git add apps/fluux/src/components/OverflowMenu.tsx apps/fluux/src/components/OverflowMenu.test.tsx
git commit -m "feat(overflow-menu): support checkable toggle items"
```

---

### Task 2: Settings -> Advanced category always visible

Drop the `advancedOnly` gate from the `advanced` category so the category itself is always reachable. This breaks the chicken-and-egg trap: the control to flip the flag no longer lives behind the flag. Keep the `advancedOnly?` field on the type and the filter clause in `getVisibleCategories` (harmless, future-proof, keeps the `isAdvancedMode` import live).

**Files:**
- Modify: `apps/fluux/src/components/settings-components/types.ts:42`
- Test: `apps/fluux/src/components/settings-components/types.test.ts` (create)

**Interfaces:**
- Consumes: nothing.
- Produces: `getVisibleCategories()` always includes the `advanced` category regardless of `advancedMode`.

- [ ] **Step 1: Write the failing test**

Create `apps/fluux/src/components/settings-components/types.test.ts`:

```ts
import { describe, it, expect, beforeEach } from 'vitest'
import { getVisibleCategories } from './types'
import { useAdvancedModeStore } from '@/stores/advancedModeStore'

describe('getVisibleCategories — advanced category', () => {
  beforeEach(() => {
    useAdvancedModeStore.setState({ advancedMode: false })
  })

  it('includes the advanced category when advanced mode is OFF', () => {
    useAdvancedModeStore.getState().setAdvancedMode(false)
    const ids = getVisibleCategories().map((c) => c.id)
    expect(ids).toContain('advanced')
  })

  it('includes the advanced category when advanced mode is ON', () => {
    useAdvancedModeStore.getState().setAdvancedMode(true)
    const ids = getVisibleCategories().map((c) => c.id)
    expect(ids).toContain('advanced')
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd apps/fluux && npx vitest run src/components/settings-components/types.test.ts`
Expected: FAIL — the "advanced mode OFF" case does not contain `advanced` (still gated by `advancedOnly`).

- [ ] **Step 3: Remove the `advancedOnly` gate from the category entry**

In `apps/fluux/src/components/settings-components/types.ts`, change line 42 from:

```ts
  { id: 'advanced', labelKey: 'settings.categories.advanced', icon: Wrench, advancedOnly: true },
```

to:

```ts
  { id: 'advanced', labelKey: 'settings.categories.advanced', icon: Wrench },
```

Leave the `advancedOnly?` field on `SettingsCategoryConfig` and the `if (cat.advancedOnly && !isAdvancedMode()) return false` filter clause unchanged.

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd apps/fluux && npx vitest run src/components/settings-components/types.test.ts`
Expected: PASS — both cases contain `advanced`.

- [ ] **Step 5: Typecheck**

Run: `npm run typecheck`
Expected: PASS, no errors (the `isAdvancedMode` import stays used by the retained filter clause).

- [ ] **Step 6: Commit**

```bash
git add apps/fluux/src/components/settings-components/types.ts apps/fluux/src/components/settings-components/types.test.ts
git commit -m "feat(settings): always show the Advanced category"
```

---

### Task 3: AdvancedSettings — flag-aware enable/disable + i18n

Make the Advanced settings panel adapt to the flag: when OFF, explain what advanced mode unlocks and offer an Enable button; when ON, keep today's warning + placeholder + Disable button. Add the two new i18n keys in all 33 locales.

**Files:**
- Modify: `apps/fluux/src/components/settings-components/AdvancedSettings.tsx`
- Modify: `apps/fluux/src/i18n/locales/*.json` (all 33 files: add `settings.advanced.enable` and `settings.advanced.enableDescription`)
- Test: `apps/fluux/src/components/settings-components/AdvancedSettings.test.tsx` (create)

**Interfaces:**
- Consumes: `useAdvancedModeStore((s) => s.advancedMode)` and `setAdvancedMode` (existing store API).
- Produces: a panel that renders a button named `settings.advanced.enable` when off and `settings.advanced.disable` when on.

- [ ] **Step 1: Write the failing tests**

Create `apps/fluux/src/components/settings-components/AdvancedSettings.test.tsx`:

```tsx
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { AdvancedSettings } from './AdvancedSettings'
import { useAdvancedModeStore } from '@/stores/advancedModeStore'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}))

beforeEach(() => {
  useAdvancedModeStore.setState({ advancedMode: false })
})

describe('AdvancedSettings', () => {
  it('shows the enable control (and no disable control) when advanced mode is OFF', () => {
    useAdvancedModeStore.getState().setAdvancedMode(false)
    render(<AdvancedSettings />)
    expect(screen.getByRole('button', { name: 'settings.advanced.enable' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'settings.advanced.disable' })).not.toBeInTheDocument()
  })

  it('enables advanced mode when the enable button is clicked', () => {
    useAdvancedModeStore.getState().setAdvancedMode(false)
    render(<AdvancedSettings />)
    fireEvent.click(screen.getByRole('button', { name: 'settings.advanced.enable' }))
    expect(useAdvancedModeStore.getState().advancedMode).toBe(true)
  })

  it('shows the disable control (and no enable control) when advanced mode is ON', () => {
    useAdvancedModeStore.getState().setAdvancedMode(true)
    render(<AdvancedSettings />)
    expect(screen.getByRole('button', { name: 'settings.advanced.disable' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'settings.advanced.enable' })).not.toBeInTheDocument()
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd apps/fluux && npx vitest run src/components/settings-components/AdvancedSettings.test.tsx`
Expected: FAIL — the OFF case currently renders only the disable button, so `settings.advanced.enable` is not found.

- [ ] **Step 3: Rewrite AdvancedSettings to be flag-aware**

Replace the entire body of `apps/fluux/src/components/settings-components/AdvancedSettings.tsx` with:

```tsx
import { useTranslation } from 'react-i18next'
import { Wrench, AlertTriangle } from 'lucide-react'
import { useAdvancedModeStore } from '@/stores/advancedModeStore'

/**
 * Advanced settings category.
 *
 * This category is always visible in the settings sidebar and is the canonical
 * home for the advanced-mode switch (both directions), so the flag is reachable
 * in-app even when autoconnect skips the login screen. When advanced mode is
 * off it explains the feature and offers to enable it; when on it shows the
 * expert options (placeholder for now) and lets the user turn it back off.
 */
export function AdvancedSettings() {
  const { t } = useTranslation()
  const advancedMode = useAdvancedModeStore((s) => s.advancedMode)
  const setAdvancedMode = useAdvancedModeStore((s) => s.setAdvancedMode)

  return (
    <section className="max-w-md">
      <h3 className="text-xs font-semibold text-fluux-muted uppercase tracking-wide mb-4">
        {t('settings.advanced.title')}
      </h3>

      {!advancedMode ? (
        /* OFF: explain what advanced mode unlocks, then offer to enable it. */
        <div className="space-y-4">
          <p className="text-sm text-fluux-text">{t('settings.advanced.enableDescription')}</p>
          <button
            type="button"
            onClick={() => setAdvancedMode(true)}
            className="px-4 py-2 rounded-lg bg-fluux-brand text-fluux-text-on-accent text-sm font-medium
                       hover:bg-fluux-brand-hover transition-colors tap-target"
          >
            {t('settings.advanced.enable')}
          </button>
        </div>
      ) : (
        /* ON: warning + options placeholder + turn back off. */
        <>
          <div className="flex items-start gap-3 rounded-lg border border-fluux-border bg-fluux-bg p-4 mb-6">
            <AlertTriangle className="size-5 text-fluux-yellow shrink-0 mt-0.5" />
            <p className="text-sm text-fluux-text">{t('settings.advanced.warning')}</p>
          </div>

          <div className="flex flex-col items-center text-center gap-2 rounded-lg border border-dashed border-fluux-border p-6 mb-6">
            <Wrench className="size-6 text-fluux-muted" />
            <p className="text-sm text-fluux-muted">{t('settings.advanced.empty')}</p>
          </div>

          <div className="space-y-3">
            <p className="text-sm text-fluux-text">{t('settings.advanced.disableDescription')}</p>
            <button
              type="button"
              onClick={() => setAdvancedMode(false)}
              className="px-4 py-2 rounded-lg border border-fluux-border text-sm font-medium
                         text-fluux-text hover:bg-fluux-hover transition-colors tap-target"
            >
              {t('settings.advanced.disable')}
            </button>
          </div>
        </>
      )}
    </section>
  )
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd apps/fluux && npx vitest run src/components/settings-components/AdvancedSettings.test.tsx`
Expected: PASS — all three tests.

- [ ] **Step 5: Add the two new i18n keys to English**

In `apps/fluux/src/i18n/locales/en.json`, inside the `settings.advanced` object, add `enable` and `enableDescription` (keep the existing `title`, `warning`, `empty`, `disableDescription`, `disable`):

```json
        "enable": "Enable advanced mode",
        "enableDescription": "Advanced mode unlocks expert options such as custom server settings and the XMPP console."
```

- [ ] **Step 6: Add genuine translations of both keys to every other locale**

For each of the other 32 locale files in `apps/fluux/src/i18n/locales/` (`ar, be, bg, ca, cs, da, de, el, es, et, fi, fr, ga, he, hr, hu, is, it, lt, lv, mt, nb, nl, pl, pt, ro, ru, sk, sl, sv, uk, zh-CN`), add `settings.advanced.enable` and `settings.advanced.enableDescription` with a real translation in that file's language. Match the tone of the sibling `disable` / `warning` strings already present, and use **no em-dashes or en-dashes**. Reference translations:

- `fr`: `"enable": "Activer le mode avancé"`, `"enableDescription": "Le mode avancé débloque des options expertes comme la configuration de serveur personnalisée et la console XMPP."`
- `de`: `"enable": "Erweiterten Modus aktivieren"`, `"enableDescription": "Der erweiterte Modus schaltet Expertenoptionen wie benutzerdefinierte Servereinstellungen und die XMPP-Konsole frei."`
- `es`: `"enable": "Activar el modo avanzado"`, `"enableDescription": "El modo avanzado desbloquea opciones avanzadas como la configuración de servidor personalizada y la consola XMPP."`
- `it`: `"enable": "Attiva la modalità avanzata"`, `"enableDescription": "La modalità avanzata sblocca opzioni avanzate come le impostazioni server personalizzate e la console XMPP."`
- `pt`: `"enable": "Ativar o modo avançado"`, `"enableDescription": "O modo avançado desbloqueia opções avançadas como as definições de servidor personalizadas e a consola XMPP."`
- `nl`: `"enable": "Geavanceerde modus inschakelen"`, `"enableDescription": "De geavanceerde modus ontgrendelt expertopties zoals aangepaste serverinstellingen en de XMPP-console."`

Translate genuinely for the remaining 26 locales (do not copy English). The next step's `i18n.test.ts` run verifies presence in all files.

- [ ] **Step 7: Run the i18n guard and the AdvancedSettings test together**

Run: `cd apps/fluux && npx vitest run src/i18n/i18n.test.ts src/components/settings-components/AdvancedSettings.test.tsx`
Expected: PASS — no missing keys across the 33 locales, and the component tests still pass.

- [ ] **Step 8: Typecheck**

Run: `npm run typecheck`
Expected: PASS, no errors.

- [ ] **Step 9: Commit**

```bash
git add apps/fluux/src/components/settings-components/AdvancedSettings.tsx apps/fluux/src/components/settings-components/AdvancedSettings.test.tsx apps/fluux/src/i18n/locales
git commit -m "feat(settings): enable/disable advanced mode from the Advanced panel"
```

---

### Task 4: UserMenu — gate the console behind advanced mode

Show the "Show console" item only when advanced mode is on (still desktop-only), and close the console if the flag is turned off while it is open, so no orphaned console view remains.

**Files:**
- Modify: `apps/fluux/src/components/sidebar-components/UserMenu.tsx`
- Test: `apps/fluux/src/components/sidebar-components/UserMenu.test.tsx` (create)

**Interfaces:**
- Consumes: `useAdvancedModeStore((s) => s.advancedMode)`; `useConsole()` (`{ toggle, isOpen }`) from `@fluux/sdk`.
- Produces: no exported surface change.

- [ ] **Step 1: Write the failing tests**

Create `apps/fluux/src/components/sidebar-components/UserMenu.test.tsx`:

```tsx
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, screen, fireEvent, act } from '@testing-library/react'
import { UserMenu } from './UserMenu'
import { useAdvancedModeStore } from '@/stores/advancedModeStore'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}))

let consoleIsOpen = false
const toggleConsoleSpy = vi.fn()
vi.mock('@fluux/sdk', () => ({
  useConsole: () => ({ toggle: toggleConsoleSpy, isOpen: consoleIsOpen }),
}))

vi.mock('@/hooks', () => ({
  useClickOutside: () => {},
  useIsMobileWeb: () => false,
  useAnchoredMenu: () => ({
    triggerRef: { current: null },
    menuRef: { current: null },
    position: { x: 0, y: 0 },
  }),
}))

vi.mock('@/stores/modalStore', () => ({
  useModalStore: (selector: (s: unknown) => unknown) => selector({ open: vi.fn() }),
}))

vi.mock('../AboutModal', () => ({ AboutModal: () => null }))
vi.mock('../ChangelogModal', () => ({ ChangelogModal: () => null }))
vi.mock('../Tooltip', () => ({ Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</> }))

function openMenu() {
  // When closed, the only button is the kebab trigger.
  fireEvent.click(screen.getAllByRole('button')[0])
}

beforeEach(() => {
  consoleIsOpen = false
  toggleConsoleSpy.mockClear()
  useAdvancedModeStore.setState({ advancedMode: false })
})

describe('UserMenu — console gating', () => {
  it('hides the console toggle when advanced mode is OFF', () => {
    useAdvancedModeStore.getState().setAdvancedMode(false)
    render(<UserMenu onLogout={vi.fn()} />)
    openMenu()
    expect(screen.queryByText('menu.showConsole')).not.toBeInTheDocument()
  })

  it('shows the console toggle when advanced mode is ON', () => {
    useAdvancedModeStore.getState().setAdvancedMode(true)
    render(<UserMenu onLogout={vi.fn()} />)
    openMenu()
    expect(screen.getByText('menu.showConsole')).toBeInTheDocument()
  })

  it('closes the console when advanced mode is turned off while it is open', () => {
    consoleIsOpen = true
    useAdvancedModeStore.getState().setAdvancedMode(true)
    render(<UserMenu onLogout={vi.fn()} />)
    expect(toggleConsoleSpy).not.toHaveBeenCalled()

    act(() => {
      useAdvancedModeStore.getState().setAdvancedMode(false)
    })
    expect(toggleConsoleSpy).toHaveBeenCalledTimes(1)
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd apps/fluux && npx vitest run src/components/sidebar-components/UserMenu.test.tsx`
Expected: FAIL — the console toggle currently shows regardless of the flag (first test fails), and there is no close-on-disable effect (third test fails).

- [ ] **Step 3: Add the flag subscription and import**

In `apps/fluux/src/components/sidebar-components/UserMenu.tsx`, add the store import after the existing imports (e.g. after line 8 `import { Tooltip } from '../Tooltip'`):

```tsx
import { useAdvancedModeStore } from '@/stores/advancedModeStore'
```

Inside the component, after the `isMobile` line (line 39 `const isMobile = useIsMobileWeb()`), add:

```tsx
  const advancedMode = useAdvancedModeStore((s) => s.advancedMode)

  // The console is an advanced-only surface: if the flag is turned off while it
  // is open, close it so no orphaned console view remains.
  useEffect(() => {
    if (!advancedMode && consoleOpen) {
      toggleConsole()
    }
  }, [advancedMode, consoleOpen, toggleConsole])
```

- [ ] **Step 4: Gate the console menu item on the flag**

Change the console toggle condition (line 78) from:

```tsx
            {!isMobile && (
```

to:

```tsx
            {!isMobile && advancedMode && (
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd apps/fluux && npx vitest run src/components/sidebar-components/UserMenu.test.tsx`
Expected: PASS — all three tests.

- [ ] **Step 6: Typecheck**

Run: `npm run typecheck`
Expected: PASS, no errors.

- [ ] **Step 7: Commit**

```bash
git add apps/fluux/src/components/sidebar-components/UserMenu.tsx apps/fluux/src/components/sidebar-components/UserMenu.test.tsx
git commit -m "feat(user-menu): gate the XMPP console behind advanced mode"
```

---

### Task 5: LoginScreen — kebab unifies advanced mode + server field

Remove the inline advanced-mode checkbox and the separate SERVER disclosure chevron. Add an `OverflowMenu` kebab in the login card corner with a single checkable "Advanced mode" item. Render the custom-server field when `showServerField || advancedMode`, so turning on advanced mode reveals it while the existing auto-reveal triggers (saved server, deep-link prefill, non-auth connection error, Cmd/Ctrl+,) keep working without unlocking the global flag.

**Files:**
- Modify: `apps/fluux/src/components/LoginScreen.tsx`
- Test: `apps/fluux/src/components/LoginScreen.test.tsx`

**Interfaces:**
- Consumes: `OverflowMenu` with `active` (Task 1); `useAdvancedModeStore` `advancedMode` + `setAdvancedMode` (already imported in LoginScreen).
- Produces: no exported surface change.

- [ ] **Step 1: Write the failing tests**

In `apps/fluux/src/components/LoginScreen.test.tsx`, add the store import near the top imports (after line 4 `import { useLoginPrefillStore } ...`):

```tsx
import { useAdvancedModeStore } from '@/stores/advancedModeStore'
```

Then add this `describe` block at the end of the file (after the last existing `describe`):

```tsx
describe('LoginScreen — advanced-mode kebab', () => {
  beforeEach(() => {
    useAdvancedModeStore.setState({ advancedMode: false })
    mockUseConnection.mockReturnValue({ status: 'offline', error: null, connect: mockConnect })
  })

  it('renders the kebab and hides the server field by default', () => {
    render(<LoginScreen />)
    expect(screen.getByRole('button', { name: 'common.options' })).toBeInTheDocument()
    expect(screen.queryByText('login.serverLabel')).not.toBeInTheDocument()
    // The old inline advanced-mode checkbox is gone.
    expect(document.querySelector('#advanced-mode')).toBeNull()
  })

  it('reveals the server field when advanced mode is enabled via the kebab', async () => {
    render(<LoginScreen />)
    fireEvent.click(screen.getByRole('button', { name: 'common.options' }))
    fireEvent.click(screen.getByRole('menuitemcheckbox', { name: 'login.advancedMode' }))

    await waitFor(() => {
      expect(screen.getByText('login.serverLabel')).toBeInTheDocument()
    })
    expect(useAdvancedModeStore.getState().advancedMode).toBe(true)
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd apps/fluux && npx vitest run src/components/LoginScreen.test.tsx`
Expected: FAIL — there is no kebab named `common.options` yet, and `login.serverLabel` is rendered today via the chevron button so the "hidden by default" assertion also fails.

- [ ] **Step 3: Update imports**

In `apps/fluux/src/components/LoginScreen.tsx`:

Change the lucide import (line 6) to drop the now-unused chevrons and add `Wrench`:

```tsx
import { Loader2, KeyRound, Eye, EyeOff, Wrench } from 'lucide-react'
```

Add the OverflowMenu import (after line 16 `import { LoginErrorPanel } from './LoginErrorPanel'`):

```tsx
import { OverflowMenu } from './OverflowMenu'
```

- [ ] **Step 4: Add the kebab to the login card corner**

Make the card block positioned and insert the kebab as its first child. Change line 423 from:

```tsx
        <div className="w-full max-w-md">
        {/* Logo / Header */}
```

to:

```tsx
        <div className="relative w-full max-w-md">
        {/* Advanced-mode kebab — quiet, top-right. The toggle reveals the
            custom-server field below and unlocks the app's expert surfaces. */}
        <div className="absolute top-0 end-0 z-10">
          <OverflowMenu
            ariaLabel={t('common.options')}
            items={[{
              key: 'advanced-mode',
              label: t('login.advancedMode'),
              icon: Wrench,
              active: advancedMode,
              onClick: () => setAdvancedMode(!advancedMode),
            }]}
          />
        </div>
        {/* Logo / Header */}
```

- [ ] **Step 5: Fold the server field into advanced mode**

Replace the entire Server Field block (currently lines 518-560, the `{/* Server Field (Advanced - hidden by default) */}` wrapper containing the chevron `<button>` and the `{showServerField && (...)}` body) with:

```tsx
          {/* Server field — shown when advanced mode is on, or auto-revealed by
              a saved server, a deep-link prefill, or a non-auth connect error. */}
          {(showServerField || advancedMode) && (
            <div>
              <label htmlFor="server" className="block text-xs font-semibold text-fluux-muted uppercase mb-2">
                {t('login.serverLabel')}
              </label>
              <TextInput
                id="server"
                type="text"
                value={server}
                onChange={(e) => {
                  setServer(e.target.value)
                  setCredentialsModified(true)
                  setHasManuallySetServer(true) // Prevent auto-fill after manual edit
                }}
                placeholder={isDesktopApp ? t('login.serverPlaceholderDesktop') : t('login.serverPlaceholder')}
                disabled={isLoading}
                className="w-full px-3 py-2 bg-fluux-bg text-fluux-text rounded
                           border border-fluux-border focus:border-fluux-brand
                           focus-visible:ring-2 focus-visible:ring-fluux-brand/50
                           placeholder:text-fluux-muted disabled:opacity-50"
              />
              <p className="text-xs text-fluux-muted mt-1">
                {isDesktopApp ? t('login.serverHintDesktop') : t('login.serverHint')}
              </p>
              {linkServerHost && (
                <p className="text-xs text-fluux-muted mt-1">
                  {t('login.linkSetServer', { host: linkServerHost })}
                </p>
              )}
            </div>
          )}
```

- [ ] **Step 6: Remove the old inline advanced-mode checkbox**

Delete the advanced-mode checkbox block (currently lines 620-635, the `{/* Advanced mode toggle ... */}` comment and the `<div className="flex items-center justify-center gap-2 mt-4">...</div>` containing the `#advanced-mode` checkbox and its label). The kebab from Step 4 replaces it. Leave the surrounding `</form>` and Footer untouched.

- [ ] **Step 7: Run the tests to verify they pass**

Run: `cd apps/fluux && npx vitest run src/components/LoginScreen.test.tsx`
Expected: PASS — the existing LoginScreen tests plus the two new ones. (The Cmd/Ctrl+, keyboard shortcut and the error/prefill auto-reveal effects still toggle `showServerField`, so those existing tests keep passing.)

- [ ] **Step 8: Typecheck and lint**

Run: `npm run typecheck`
Expected: PASS, no errors (no orphaned `ChevronDown`/`ChevronRight` imports).

Run: `npm run lint`
Expected: PASS, no errors.

- [ ] **Step 9: Commit**

```bash
git add apps/fluux/src/components/LoginScreen.tsx apps/fluux/src/components/LoginScreen.test.tsx
git commit -m "feat(login): move advanced mode into a kebab that reveals the server field"
```

---

### Task 6: Full verification

Confirm the whole app test suite, typecheck, and lint pass together before handing off.

**Files:** none (verification only).

- [ ] **Step 1: Run the full app test suite**

Run: `cd apps/fluux && npx vitest run`
Expected: PASS, no failures and no stderr noise.

- [ ] **Step 2: Typecheck the whole repo**

Run: `npm run typecheck`
Expected: PASS, no errors.

- [ ] **Step 3: Lint**

Run: `npm run lint`
Expected: PASS, no errors.

- [ ] **Step 4: Manual smoke (demo mode)**

Run: `npm run dev`, open `http://localhost:5173/demo.html`, and verify:
- Settings -> Advanced category is visible even with advanced mode off, and the Enable button turns it on.
- The login screen (`http://localhost:5173/`) shows a kebab (no inline checkbox); toggling Advanced mode reveals the server field.
- With advanced mode on, the sidebar user menu shows "Show Console"; turning advanced mode off in Settings hides it and closes an open console.

---

## Self-Review

**Spec coverage:**
- Canonical in-app home (always-visible Advanced category) -> Task 2 + Task 3.
- Login kebab + server-field fold -> Task 5 (depends on Task 1 `active`).
- OverflowMenu toggle enhancement -> Task 1.
- Server info / console gating -> Task 4.
- i18n in all 33 locales, no dashes -> Task 3 steps 5-7 + Global Constraints.
- Tests for each surface -> Tasks 1-5; full suite -> Task 6.

**Refinement vs spec (server-field auto-reveal):** the spec's deep-link note suggested enabling advanced mode when a link prefills a custom server. During planning, the source revealed `showServerField` is already auto-set on prefill, saved server, and non-auth connection errors. Forcing the global flag on for those benign events would wrongly unlock the whole expert surface (e.g. the console) on a mere connection error. The plan instead uses the predicate `showServerField || advancedMode`, which satisfies the spec's "otherwise force the server field visible" clause without that side effect. No spec change required.

**Placeholder scan:** no TBD/TODO; every code step shows full code; the i18n step provides English source + reference translations and requires genuine per-locale translations gated by `i18n.test.ts`.

**Type consistency:** `active?: boolean` is defined in Task 1 and consumed in Task 5; `advancedMode` / `setAdvancedMode` match the existing store API; `useConsole()` returns `{ toggle, isOpen }` as used in Task 4.
