# Settings Sidebar Grouping Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reorder the settings sidebar into four conceptual groups and add small-caps section headers, with Profile sitting bare at the top.

**Architecture:** Tag each settings category with a `group`, expose a pure `getGroupedVisibleCategories()` helper that returns platform-filtered groups in order (skipping empties), and have `SettingsSidebar` render one labeled `<section>`-like block per group. Group header labels are new i18n keys translated across all 33 locales.

**Tech Stack:** TypeScript, React, react-i18next, Tailwind, Vitest, lucide-react.

## Global Constraints

- No em-dashes or en-dashes in any user-facing string (use "&" / "and", as in the existing "Language & Region").
- Every new i18n key MUST have a real, non-empty translation in all 33 locale files; `apps/fluux/src/i18n/i18n.test.ts` enforces key parity and non-empty values.
- App tests run from `apps/fluux` (root vitest config lacks the `@` alias).
- No Claude footer in commit messages.
- Do not change any settings panel content, advanced-mode visibility, or platform gating.

---

### Task 1: i18n group label keys in all 33 locales

**Files:**
- Modify: every file in `apps/fluux/src/i18n/locales/*.json` (33 files) — add `settings.groups.{general,privacy,system}` right after `settings.categories`.
- Test: `apps/fluux/src/i18n/i18n.test.ts` (existing; no edit, run only)

**Interfaces:**
- Consumes: nothing.
- Produces: i18n keys `settings.groups.general`, `settings.groups.privacy`, `settings.groups.system` available to later tasks.

- [ ] **Step 1: Write the insertion script**

Create `scratchpad-add-groups.mjs` at the repo root with this exact content:

```js
import { readFileSync, writeFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

const DIR = 'apps/fluux/src/i18n/locales'

const GENERAL = {
  ar: 'عام', be: 'Агульныя', bg: 'Общи', ca: 'General', cs: 'Obecné',
  da: 'Generelt', de: 'Allgemein', el: 'Γενικά', en: 'General', es: 'General',
  et: 'Üldine', fi: 'Yleiset', fr: 'Général', ga: 'Ginearálta', he: 'כללי',
  hr: 'Općenito', hu: 'Általános', is: 'Almennt', it: 'Generale', lt: 'Bendra',
  lv: 'Vispārīgi', mt: 'Ġenerali', nb: 'Generelt', nl: 'Algemeen', pl: 'Ogólne',
  pt: 'Geral', ro: 'General', ru: 'Общие', sk: 'Všeobecné', sl: 'Splošno',
  sv: 'Allmänt', uk: 'Загальні', 'zh-CN': '通用',
}

const PRIVACY = {
  ar: 'الخصوصية والأمان', be: 'Прыватнасць і бяспека', bg: 'Поверителност и сигурност',
  ca: 'Privadesa i seguretat', cs: 'Soukromí a zabezpečení', da: 'Privatliv og sikkerhed',
  de: 'Datenschutz & Sicherheit', el: 'Απόρρητο και ασφάλεια', en: 'Privacy & Security',
  es: 'Privacidad y seguridad', et: 'Privaatsus ja turvalisus', fi: 'Yksityisyys ja turvallisuus',
  fr: 'Confidentialité et sécurité', ga: 'Príobháideachas agus slándáil', he: 'פרטיות ואבטחה',
  hr: 'Privatnost i sigurnost', hu: 'Adatvédelem és biztonság', is: 'Persónuvernd og öryggi',
  it: 'Privacy e sicurezza', lt: 'Privatumas ir sauga', lv: 'Konfidencialitāte un drošība',
  mt: 'Privatezza u sigurtà', nb: 'Personvern og sikkerhet', nl: 'Privacy en beveiliging',
  pl: 'Prywatność i bezpieczeństwo', pt: 'Privacidade e segurança', ro: 'Confidențialitate și securitate',
  ru: 'Конфиденциальность и безопасность', sk: 'Súkromie a zabezpečenie', sl: 'Zasebnost in varnost',
  sv: 'Integritet och säkerhet', uk: 'Конфіденційність і безпека', 'zh-CN': '隐私与安全',
}

const SYSTEM = {
  ar: 'النظام', be: 'Сістэма', bg: 'Система', ca: 'Sistema', cs: 'Systém',
  da: 'System', de: 'System', el: 'Σύστημα', en: 'System', es: 'Sistema',
  et: 'Süsteem', fi: 'Järjestelmä', fr: 'Système', ga: 'Córas', he: 'מערכת',
  hr: 'Sustav', hu: 'Rendszer', is: 'Kerfi', it: 'Sistema', lt: 'Sistema',
  lv: 'Sistēma', mt: 'Sistema', nb: 'System', nl: 'Systeem', pl: 'System',
  pt: 'Sistema', ro: 'Sistem', ru: 'Система', sk: 'Systém', sl: 'Sistem',
  sv: 'System', uk: 'Система', 'zh-CN': '系统',
}

for (const file of readdirSync(DIR).filter((f) => f.endsWith('.json'))) {
  const code = file.replace('.json', '')
  const path = join(DIR, file)
  const obj = JSON.parse(readFileSync(path, 'utf8'))
  if (!obj.settings || !obj.settings.categories) throw new Error(`no settings.categories in ${file}`)
  if (!(code in GENERAL)) throw new Error(`no translation for locale ${code}`)

  const rebuilt = {}
  for (const [k, v] of Object.entries(obj.settings)) {
    rebuilt[k] = v
    if (k === 'categories') {
      rebuilt.groups = { general: GENERAL[code], privacy: PRIVACY[code], system: SYSTEM[code] }
    }
  }
  obj.settings = rebuilt
  writeFileSync(path, JSON.stringify(obj, null, 4) + '\n')
}
console.log('done')
```

- [ ] **Step 2: Run the script**

```bash
node scratchpad-add-groups.mjs
```

Expected output: `done`

- [ ] **Step 3: Verify diffs are addition-only**

```bash
git diff --stat apps/fluux/src/i18n/locales/
```

Expected: 33 files changed, each `+5` insertions (the `"groups": { … },` block), `0` deletions. If any file shows deletions, the round-trip assumption failed for that locale; stop and inspect.

- [ ] **Step 4: Run the i18n parity test**

```bash
cd apps/fluux && npx vitest run src/i18n/i18n.test.ts
```

Expected: PASS, including "should have all English keys", "should not have extra keys", and "should not have empty translation values" for every locale.

- [ ] **Step 5: Delete the throwaway script and commit**

```bash
rm scratchpad-add-groups.mjs
git add apps/fluux/src/i18n/locales/
git commit -m "i18n: add settings group labels (general, privacy, system)"
```

---

### Task 2: Group data model and `getGroupedVisibleCategories()` helper

**Files:**
- Modify: `apps/fluux/src/components/settings-components/types.ts`
- Test: `apps/fluux/src/components/settings-components/types.test.ts` (extend existing)

**Interfaces:**
- Consumes: existing `getVisibleCategories()`, `SettingsCategoryConfig`.
- Produces:
  - `type SettingsGroup = 'account' | 'general' | 'privacy' | 'system'`
  - `SettingsCategoryConfig.group: SettingsGroup` (now required)
  - `interface SettingsGroupSection { group: SettingsGroup; labelKey: string | null; items: SettingsCategoryConfig[] }`
  - `getGroupedVisibleCategories(): SettingsGroupSection[]`

- [ ] **Step 1: Write the failing tests**

Append to `apps/fluux/src/components/settings-components/types.test.ts`:

```typescript
import { getGroupedVisibleCategories } from './types'

describe('getGroupedVisibleCategories', () => {
  beforeEach(() => {
    useAdvancedModeStore.setState({ advancedMode: false })
  })

  it('returns groups in account, general, privacy, system order', () => {
    const groups = getGroupedVisibleCategories().map((g) => g.group)
    expect(groups).toEqual(['account', 'general', 'privacy', 'system'])
  })

  it('puts profile alone in the account group with no header label', () => {
    const account = getGroupedVisibleCategories().find((g) => g.group === 'account')!
    expect(account.labelKey).toBeNull()
    expect(account.items.map((c) => c.id)).toEqual(['profile'])
  })

  it('orders the privacy group encryption, privacy, blocked with a header label', () => {
    const privacy = getGroupedVisibleCategories().find((g) => g.group === 'privacy')!
    expect(privacy.labelKey).toBe('settings.groups.privacy')
    expect(privacy.items.map((c) => c.id)).toEqual(['encryption', 'privacy', 'blocked'])
  })

  it('orders the general group appearance, accessibility, language, notifications', () => {
    const general = getGroupedVisibleCategories().find((g) => g.group === 'general')!
    expect(general.labelKey).toBe('settings.groups.general')
    expect(general.items.map((c) => c.id)).toEqual([
      'appearance', 'accessibility', 'language', 'notifications',
    ])
  })

  it('omits a group whose items are all platform-filtered out', () => {
    // In the jsdom test env isTauri() is false, so storage and updates are
    // hidden; the system group still has advanced, so it is present.
    const system = getGroupedVisibleCategories().find((g) => g.group === 'system')!
    expect(system.items.map((c) => c.id)).toEqual(['advanced'])
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd apps/fluux && npx vitest run src/components/settings-components/types.test.ts
```

Expected: FAIL with `getGroupedVisibleCategories is not a function` (or import error).

- [ ] **Step 3: Implement the data model and helper**

In `apps/fluux/src/components/settings-components/types.ts`:

Add the group type and make `group` required on the config interface:

```typescript
export type SettingsGroup = 'account' | 'general' | 'privacy' | 'system'

export interface SettingsCategoryConfig {
  id: SettingsCategory
  labelKey: string
  icon: LucideIcon
  group: SettingsGroup
  /** Only show in Tauri desktop app */
  tauriOnly?: boolean
  /** Only show when in-app updater is enabled (macOS/Windows, not Linux) */
  updaterOnly?: boolean
}
```

Replace the `SETTINGS_CATEGORIES` array with the reordered, group-tagged version:

```typescript
export const SETTINGS_CATEGORIES: SettingsCategoryConfig[] = [
  { id: 'profile', labelKey: 'settings.categories.profile', icon: User, group: 'account' },

  { id: 'appearance', labelKey: 'settings.categories.appearance', icon: Palette, group: 'general' },
  { id: 'accessibility', labelKey: 'settings.categories.accessibility', icon: Accessibility, group: 'general' },
  { id: 'language', labelKey: 'settings.categories.language', icon: Globe, group: 'general' },
  { id: 'notifications', labelKey: 'settings.categories.notifications', icon: Bell, group: 'general' },

  { id: 'encryption', labelKey: 'settings.categories.encryption', icon: Lock, group: 'privacy' },
  { id: 'privacy', labelKey: 'settings.categories.privacy', icon: ShieldCheck, group: 'privacy' },
  { id: 'blocked', labelKey: 'settings.categories.blocked', icon: Ban, group: 'privacy' },

  { id: 'storage', labelKey: 'settings.categories.storage', icon: HardDrive, tauriOnly: true, group: 'system' },
  { id: 'updates', labelKey: 'settings.categories.updates', icon: Download, updaterOnly: true, group: 'system' },
  { id: 'advanced', labelKey: 'settings.categories.advanced', icon: Wrench, group: 'system' },
]
```

Add the group ordering, label map, section type, and helper (place after `getVisibleCategories`):

```typescript
export interface SettingsGroupSection {
  group: SettingsGroup
  /** i18n key for the group header, or null for a group rendered with no header */
  labelKey: string | null
  items: SettingsCategoryConfig[]
}

const SETTINGS_GROUP_ORDER: SettingsGroup[] = ['account', 'general', 'privacy', 'system']

const SETTINGS_GROUP_LABEL_KEYS: Record<SettingsGroup, string | null> = {
  account: null,
  general: 'settings.groups.general',
  privacy: 'settings.groups.privacy',
  system: 'settings.groups.system',
}

/**
 * Group the platform-visible categories into ordered sections for the sidebar.
 * Groups with no visible items are omitted, so platform/updater filtering can
 * never leave an empty header behind.
 */
export function getGroupedVisibleCategories(): SettingsGroupSection[] {
  const visible = getVisibleCategories()
  return SETTINGS_GROUP_ORDER.map((group) => ({
    group,
    labelKey: SETTINGS_GROUP_LABEL_KEYS[group],
    items: visible.filter((cat) => cat.group === group),
  })).filter((section) => section.items.length > 0)
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd apps/fluux && npx vitest run src/components/settings-components/types.test.ts
```

Expected: PASS (both the pre-existing advanced-category tests and the five new ones).

- [ ] **Step 5: Commit**

```bash
git add apps/fluux/src/components/settings-components/types.ts apps/fluux/src/components/settings-components/types.test.ts
git commit -m "feat(settings): group and reorder settings categories"
```

---

### Task 3: Render grouped sections in `SettingsSidebar`

**Files:**
- Modify: `apps/fluux/src/components/settings-components/SettingsSidebar.tsx`
- Test: `apps/fluux/src/components/settings-components/SettingsSidebar.test.tsx` (create)

**Interfaces:**
- Consumes: `getGroupedVisibleCategories`, `SettingsGroupSection`, `SettingsCategory` from `./types`.
- Produces: no new exports.

- [ ] **Step 1: Write the failing render test**

Create `apps/fluux/src/components/settings-components/SettingsSidebar.test.tsx`:

```tsx
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import { SettingsSidebar } from './SettingsSidebar'
import { useAdvancedModeStore } from '@/stores/advancedModeStore'

// t() returns the key, so headers render as their i18n key paths.
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}))

beforeEach(() => {
  useAdvancedModeStore.setState({ advancedMode: false })
})

describe('SettingsSidebar', () => {
  it('renders a heading for general, privacy, and system groups', () => {
    render(<SettingsSidebar activeCategory="profile" onCategoryChange={vi.fn()} />)
    expect(screen.getByRole('heading', { name: 'settings.groups.general' })).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'settings.groups.privacy' })).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'settings.groups.system' })).toBeInTheDocument()
  })

  it('renders Profile bare with no account heading', () => {
    render(<SettingsSidebar activeCategory="profile" onCategoryChange={vi.fn()} />)
    expect(screen.getByRole('button', { name: /settings\.categories\.profile/ })).toBeInTheDocument()
    expect(screen.queryByText('settings.groups.account')).not.toBeInTheDocument()
    // Profile button precedes the first group heading in document order.
    const profile = screen.getByRole('button', { name: /settings\.categories\.profile/ })
    const firstHeading = screen.getByRole('heading', { name: 'settings.groups.general' })
    expect(profile.compareDocumentPosition(firstHeading) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
cd apps/fluux && npx vitest run src/components/settings-components/SettingsSidebar.test.tsx
```

Expected: FAIL — no headings are rendered by the current flat-list implementation.

- [ ] **Step 3: Rewrite the sidebar to render grouped sections**

Replace the entire contents of `apps/fluux/src/components/settings-components/SettingsSidebar.tsx`:

```tsx
import { useTranslation } from 'react-i18next'
import { getGroupedVisibleCategories, type SettingsCategory } from './types'
import { useAdvancedModeStore } from '@/stores/advancedModeStore'

interface SettingsSidebarProps {
  activeCategory: SettingsCategory
  onCategoryChange: (category: SettingsCategory) => void
}

export function SettingsSidebar({ activeCategory, onCategoryChange }: SettingsSidebarProps) {
  const { t } = useTranslation()
  // Re-render the sidebar when advanced mode is toggled.
  useAdvancedModeStore((s) => s.advancedMode)
  const sections = getGroupedVisibleCategories()

  return (
    <nav className="py-2">
      {sections.map((section) => (
        <div key={section.group} className="mt-4 first:mt-0">
          {section.labelKey && (
            <h3 className="px-3 pb-1 text-xs font-semibold uppercase tracking-wide text-fluux-muted">
              {t(section.labelKey)}
            </h3>
          )}
          <ul className="space-y-1">
            {section.items.map((category) => {
              const Icon = category.icon
              const isActive = activeCategory === category.id

              return (
                <li key={category.id}>
                  <button
                    onClick={() => onCategoryChange(category.id)}
                    className={`w-full flex items-center gap-3 px-3 py-2 rounded-lg text-start transition-colors
                      ${isActive
                        ? 'bg-fluux-brand/10 text-fluux-brand'
                        : 'text-fluux-text hover:bg-fluux-hover'
                      }`}
                  >
                    <Icon className={`size-5 ${isActive ? 'text-fluux-brand' : 'text-fluux-muted'}`} />
                    <span className="text-sm font-medium">{t(category.labelKey)}</span>
                  </button>
                </li>
              )
            })}
          </ul>
        </div>
      ))}
    </nav>
  )
}
```

- [ ] **Step 4: Run the render test to verify it passes**

```bash
cd apps/fluux && npx vitest run src/components/settings-components/SettingsSidebar.test.tsx
```

Expected: PASS.

- [ ] **Step 5: Run the full settings test suite and typecheck**

```bash
cd apps/fluux && npx vitest run src/components/settings-components/
npm run typecheck
```

(`npm run typecheck` is run from the repo root.) Expected: all settings tests PASS, typecheck reports no errors.

- [ ] **Step 6: Commit**

```bash
git add apps/fluux/src/components/settings-components/SettingsSidebar.tsx apps/fluux/src/components/settings-components/SettingsSidebar.test.tsx
git commit -m "feat(settings): render grouped settings sidebar with section headers"
```

---

## Self-Review

**Spec coverage:**
- Reorder + four groups -> Task 2 (`SETTINGS_CATEGORIES`, `getGroupedVisibleCategories`).
- Profile bare, no header -> Task 2 (`account` labelKey null) + Task 3 render test.
- Encryption leads privacy group; Storage in system -> Task 2 ordering tests.
- `group` field + helper that skips empty groups -> Task 2.
- Small-caps `<h3>` headers, account renders headerless -> Task 3.
- Fix stale advanced-mode comment -> Task 3 (comment replaced with an accurate one).
- Three i18n keys, real translations in 33 locales, no empties -> Task 1.
- Routing unchanged (`DEFAULT_SETTINGS_CATEGORY` untouched) -> no task needed; left as-is.
- Tests for the helper -> Task 2.

**Placeholder scan:** none — every step has concrete code/commands and expected output.

**Type consistency:** `SettingsGroup`, `SettingsGroupSection`, `getGroupedVisibleCategories`, `SETTINGS_GROUP_LABEL_KEYS` are defined in Task 2 and used with the same names/shapes in Task 3 and the tests. The i18n keys `settings.groups.{general,privacy,system}` from Task 1 match the keys used in `SETTINGS_GROUP_LABEL_KEYS` and the render test.
