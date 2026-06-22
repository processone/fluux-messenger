# Mobile Admin Overview Launchpad Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the admin server overview the home screen on mobile (matching desktop) and turn its stat cards into one-tap navigation, with a header menu → bottom sheet as the secondary path to all admin sections.

**Architecture:** Four independent changes. (1) Overview stat cards become tappable, config-driven, on every viewport. (2) Back navigation gains an `'overview'` step so a section list returns to the overview instead of exiting admin. (3) The mobile auto-default to `stats` is ungated. (4) `AdminView` gains a mobile-only header menu button that opens a `BottomSheet` hosting the existing `AdminDashboard`. Navigation everywhere goes through `adminStore.getState().setActiveCategory(...)`, matching how `ChatLayout` already drives the admin store.

**Tech Stack:** React + TypeScript, Zustand vanilla store (`adminStore` from `@fluux/sdk`), Vitest + @testing-library/react, Tailwind, react-i18next (33 locales).

## Global Constraints

- Navigate the admin store via `adminStore.getState().setActiveCategory(category)` (imported from `@fluux/sdk`) — do not prop-drill a setter. This matches `ChatLayout.tsx`.
- Mobile-only header controls use the `md:hidden` class and the `.tap-target` sizing class, mirroring the existing back button.
- New i18n keys must be added to ALL 33 locale files in `apps/fluux/src/i18n/locales/`. No em-dash (`—`/`–`) connectors in any locale value.
- Before committing: tests pass with no stderr, `npm run typecheck` passes, linter passes.
- App typecheck in a worktree resolves `@fluux/sdk` to the MAIN repo's built `dist`. This plan does NOT change any SDK type (`AdminCategory` already exists and is exported), so no `build:sdk` is required.
- Run app tests per-workspace from `apps/fluux` (e.g. `cd apps/fluux && npx vitest run <file>`), not bare `vitest` at repo root.

---

### Task 1: Tappable overview stat cards

Cards whose metric maps to a manageable section navigate there on click; the rest stay read-only. Config-driven via an optional `target` on the card definition. Applies on desktop and mobile.

**Files:**
- Modify: `apps/fluux/src/components/admin/adminOverview.ts`
- Modify: `apps/fluux/src/components/ServerOverview.tsx`
- Test: `apps/fluux/src/components/ServerOverview.test.tsx`

**Interfaces:**
- Produces: `OverviewCardDef.target?: AdminCategory` — `'users'` on the `registeredUsers` card, `'rooms'` on the `onlineRooms` card. Other cards leave it undefined.
- Consumes: `adminStore` from `@fluux/sdk` (vanilla store with `.getState().setActiveCategory(category: AdminCategory | null)` and readable `.getState().activeCategory`).

- [ ] **Step 1: Write the failing tests**

Add these tests to `apps/fluux/src/components/ServerOverview.test.tsx`. Add `adminStore` to the imports from `@fluux/sdk` at the top of the file's test body (the existing `vi.mock('@fluux/sdk', importOriginal)` spreads the real module, so `adminStore` is the real vanilla store), and reset it in `beforeEach`:

```tsx
import { ServerOverview } from './ServerOverview'
import { adminStore } from '@fluux/sdk'
```

In the existing `beforeEach`, after the `adminReturn = {...}` assignment, add:

```tsx
  adminStore.getState().setActiveCategory(null)
```

Then add a new describe block:

```tsx
describe('ServerOverview navigation cards', () => {
  it('navigates to user management when the registered-users card is clicked', () => {
    render(<ServerOverview />)
    fireEvent.click(screen.getByRole('button', { name: /Registered users/ }))
    expect(adminStore.getState().activeCategory).toBe('users')
  })

  it('navigates to room management when the rooms card is clicked', () => {
    render(<ServerOverview />)
    fireEvent.click(screen.getByRole('button', { name: /Active rooms/ }))
    expect(adminStore.getState().activeCategory).toBe('rooms')
  })

  it('leaves read-only cards (uptime) non-interactive', () => {
    render(<ServerOverview />)
    expect(screen.queryByRole('button', { name: /Uptime/ })).not.toBeInTheDocument()
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd apps/fluux && npx vitest run src/components/ServerOverview.test.tsx`
Expected: FAIL — the cards render as `<div>`, so `getByRole('button', { name: /Registered users/ })` finds nothing.

- [ ] **Step 3: Add the `target` field to the card config**

In `apps/fluux/src/components/admin/adminOverview.ts`, import `AdminCategory`, extend the interface, and set targets:

```ts
import { Clock, Tag, Users, UserCheck, Hash, Server } from 'lucide-react'
import type { ServerStats, AdminCategory } from '@fluux/sdk'
import { formatDuration, formatCount, type DurationUnits } from '@/utils/format'

export interface OverviewCardDef {
  key: keyof ServerStats
  icon: React.ComponentType<{ className?: string }>
  labelKey: string
  format: (value: NonNullable<ServerStats[keyof ServerStats]>, durationUnits: DurationUnits) => string
  /** When set, the card is interactive and navigates to this admin section on click. */
  target?: AdminCategory
}

export const OVERVIEW_CARDS: OverviewCardDef[] = [
  { key: 'uptimeSeconds', icon: Clock, labelKey: 'admin.overview.cards.uptime', format: (v, u) => formatDuration(v as number, u) },
  { key: 'version', icon: Tag, labelKey: 'admin.overview.cards.version', format: (v) => String(v) },
  { key: 'registeredUsers', icon: Users, labelKey: 'admin.overview.cards.registeredUsers', format: (v) => formatCount(v as number), target: 'users' },
  { key: 'onlineUsers', icon: UserCheck, labelKey: 'admin.overview.cards.onlineUsers', format: (v) => formatCount(v as number) },
  { key: 'onlineRooms', icon: Hash, labelKey: 'admin.overview.cards.onlineRooms', format: (v) => formatCount(v as number), target: 'rooms' },
  { key: 'vhostCount', icon: Server, labelKey: 'admin.overview.cards.vhosts', format: (v) => formatCount(v as number) },
]
```

- [ ] **Step 4: Render tappable cards in ServerOverview**

In `apps/fluux/src/components/ServerOverview.tsx`, add `adminStore` to the `@fluux/sdk` import (`ChevronRight` is already imported from `lucide-react`):

```tsx
import { useAdmin, adminStore, type ServerStats, type AdminCommand } from '@fluux/sdk'
```

Replace the card `.map(...)` body (currently the `<div key={...}>...</div>` block at lines ~72-86) with:

```tsx
          {presentCards.map(card => {
            const Icon = card.icon
            const value = stats![card.key] as NonNullable<ServerStats[keyof ServerStats]>
            const inner = (
              <>
                <div className="flex items-center gap-2 text-fluux-muted mb-2">
                  <Icon className="size-4" />
                  <span className="text-xs font-medium">{t(card.labelKey)}</span>
                  {card.target && <ChevronRight className="size-4 ms-auto rtl-mirror" />}
                </div>
                <div className="text-2xl font-semibold text-fluux-text break-words" title={String(value)}>
                  {card.format(value, durationUnits)}
                </div>
              </>
            )
            if (card.target) {
              const target = card.target
              return (
                <button
                  key={String(card.key)}
                  onClick={() => adminStore.getState().setActiveCategory(target)}
                  className="p-4 rounded-xl bg-fluux-bg border border-fluux-hover text-start hover:bg-fluux-hover hover:border-fluux-brand/40 transition-colors tap-target"
                >
                  {inner}
                </button>
              )
            }
            return (
              <div key={String(card.key)} className="p-4 rounded-xl bg-fluux-bg border border-fluux-hover">
                {inner}
              </div>
            )
          })}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd apps/fluux && npx vitest run src/components/ServerOverview.test.tsx`
Expected: PASS (all existing tests + the 3 new ones).

- [ ] **Step 6: Typecheck and commit**

Run: `npm run typecheck`
Expected: no errors.

```bash
git add apps/fluux/src/components/admin/adminOverview.ts apps/fluux/src/components/ServerOverview.tsx apps/fluux/src/components/ServerOverview.test.tsx
git commit -m "feat(admin): make overview stat cards tappable navigation"
```

---

### Task 2: Back navigation returns to the overview

With the overview as the admin home, the stack is `overview → users/rooms list → detail/session`. Back from a list must return to the overview, not exit admin. Back from the overview (or no category) still exits.

**Files:**
- Modify: `apps/fluux/src/components/adminBackTarget.ts`
- Test: `apps/fluux/src/components/adminBackTarget.test.ts`
- Modify: `apps/fluux/src/components/AdminView.tsx:171-192` (the `handleHeaderBack` handler)
- Test: `apps/fluux/src/components/AdminView.test.tsx`

**Interfaces:**
- Produces: `AdminBackTarget = 'session' | 'user' | 'room' | 'overview' | 'exit'`; `getAdminBackTarget(state: { hasSession: boolean; hasSelectedUser: boolean; hasSelectedRoom: boolean; activeCategory: AdminCategory | null }): AdminBackTarget`.
- Consumes: `adminStore.getState().setActiveCategory('stats')` for the `'overview'` case.

- [ ] **Step 1: Write the failing unit tests**

Replace the entire contents of `apps/fluux/src/components/adminBackTarget.test.ts` with:

```ts
import { describe, it, expect } from 'vitest'
import { getAdminBackTarget } from './adminBackTarget'

const base = { hasSession: false, hasSelectedUser: false, hasSelectedRoom: false, activeCategory: null }

describe('getAdminBackTarget', () => {
  it('prioritises a command session above everything', () => {
    expect(getAdminBackTarget({ ...base, hasSession: true, hasSelectedUser: true, activeCategory: 'users' })).toBe('session')
  })

  it('steps out of a selected user before the list', () => {
    expect(getAdminBackTarget({ ...base, hasSelectedUser: true, activeCategory: 'users' })).toBe('user')
  })

  it('steps out of a selected room before the list', () => {
    expect(getAdminBackTarget({ ...base, hasSelectedRoom: true, activeCategory: 'rooms' })).toBe('room')
  })

  it('returns to the overview from the users list', () => {
    expect(getAdminBackTarget({ ...base, activeCategory: 'users' })).toBe('overview')
  })

  it('returns to the overview from the rooms list', () => {
    expect(getAdminBackTarget({ ...base, activeCategory: 'rooms' })).toBe('overview')
  })

  it('exits admin from the overview itself', () => {
    expect(getAdminBackTarget({ ...base, activeCategory: 'stats' })).toBe('exit')
  })

  it('exits admin when no category is active', () => {
    expect(getAdminBackTarget({ ...base, activeCategory: null })).toBe('exit')
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd apps/fluux && npx vitest run src/components/adminBackTarget.test.ts`
Expected: FAIL — `getAdminBackTarget` does not accept `activeCategory` and never returns `'overview'`.

- [ ] **Step 3: Implement the new back-target logic**

Replace the entire contents of `apps/fluux/src/components/adminBackTarget.ts` with:

```ts
/**
 * Decides where the admin header back button should step to.
 *
 * The admin area is a stack: overview (home) → list → detail/session.
 * On mobile the single header back arrow must step back exactly one level.
 * From a section list it returns to the overview; only the overview (or no
 * category) exits admin. This keeps that decision in one place.
 */
import type { AdminCategory } from '@fluux/sdk'

export type AdminBackTarget = 'session' | 'user' | 'room' | 'overview' | 'exit'

export function getAdminBackTarget(state: {
  hasSession: boolean
  hasSelectedUser: boolean
  hasSelectedRoom: boolean
  activeCategory: AdminCategory | null
}): AdminBackTarget {
  if (state.hasSession) return 'session'
  if (state.hasSelectedUser) return 'user'
  if (state.hasSelectedRoom) return 'room'
  if (state.activeCategory === 'users' || state.activeCategory === 'rooms') return 'overview'
  return 'exit'
}
```

- [ ] **Step 4: Run the unit tests to verify they pass**

Run: `cd apps/fluux && npx vitest run src/components/adminBackTarget.test.ts`
Expected: PASS.

- [ ] **Step 5: Wire the `'overview'` case into AdminView**

In `apps/fluux/src/components/AdminView.tsx`, add `adminStore` to the `@fluux/sdk` import:

```tsx
import { useAdmin, useXMPP, adminStore, type AdminCategory, type AdminUser, type AdminRoom } from '@fluux/sdk'
```

Replace the `handleHeaderBack` function (lines ~171-192) with:

```tsx
  // Mobile header back button: step back exactly one level
  // (detail → list → overview → exit), instead of collapsing to the root.
  const handleHeaderBack = () => {
    switch (
      getAdminBackTarget({
        hasSession: !!currentSession,
        hasSelectedUser: !!selectedUser,
        hasSelectedRoom: !!selectedRoom,
        activeCategory,
      })
    ) {
      case 'session':
        handleCloseSession()
        break
      case 'user':
        setSelectedUser(null)
        break
      case 'room':
        setSelectedRoom(null)
        break
      case 'overview':
        adminStore.getState().setActiveCategory('stats')
        break
      case 'exit':
        onBack?.()
        break
    }
  }
```

- [ ] **Step 6: Update the AdminView back-button tests**

In `apps/fluux/src/components/AdminView.test.tsx`, add a shared `setActiveCategory` mock and expose `adminStore` from the `@fluux/sdk` mock. Replace the `vi.mock('@fluux/sdk', ...)` block (lines ~52-55) with:

```tsx
const setActiveCategory = vi.fn()

vi.mock('@fluux/sdk', () => ({
  useAdmin: () => adminState,
  useXMPP: () => ({ client: { muc: { destroyRoom: vi.fn() } } }),
  adminStore: { getState: () => ({ setActiveCategory }) },
}))
```

Replace the second test (`'calls onBack (exit to admin root) from the room list level'`, lines ~82-92) with two tests:

```tsx
  it('returns to the overview from the room list level (does not exit)', () => {
    const onBack = vi.fn()
    render(<AdminView activeCategory="rooms" onBack={onBack} />)

    expect(screen.getByText('admin.roomList.title')).toBeInTheDocument()

    fireEvent.click(screen.getByLabelText('common.back'))

    expect(setActiveCategory).toHaveBeenCalledWith('stats')
    expect(onBack).not.toHaveBeenCalled()
  })

  it('exits admin from the overview / no-category level', () => {
    const onBack = vi.fn()
    render(<AdminView activeCategory={null} onBack={onBack} />)

    fireEvent.click(screen.getByLabelText('common.back'))

    expect(onBack).toHaveBeenCalledTimes(1)
  })
```

- [ ] **Step 7: Run the AdminView tests to verify they pass**

Run: `cd apps/fluux && npx vitest run src/components/AdminView.test.tsx`
Expected: PASS — the room-detail test is unchanged; the two replaced tests assert the new behavior.

- [ ] **Step 8: Typecheck and commit**

Run: `npm run typecheck`
Expected: no errors.

```bash
git add apps/fluux/src/components/adminBackTarget.ts apps/fluux/src/components/adminBackTarget.test.ts apps/fluux/src/components/AdminView.tsx apps/fluux/src/components/AdminView.test.tsx
git commit -m "feat(admin): back from a section list returns to the overview"
```

---

### Task 3: Mobile lands on the server overview

Drop the `isSmallScreen()` gate on the admin auto-default so phones land on the overview, matching desktop.

**Files:**
- Modify: `apps/fluux/src/components/ChatLayout.tsx:737-741`

**Interfaces:**
- Consumes: the existing `useLayoutEffect` that calls `adminStore.getState().setActiveCategory('stats')`.
- Produces: nothing new — only widens when the default fires.

- [ ] **Step 1: Read the current effect**

Confirm the effect around lines 737-741 reads:

```tsx
  useLayoutEffect(() => {
    if (sidebarView !== 'admin' || isSmallScreen()) return
    if (!adminIsAdmin || adminCategory || adminSession) return
    adminStore.getState().setActiveCategory('stats')
  }, [sidebarView, adminIsAdmin, adminCategory, adminSession])
```

- [ ] **Step 2: Remove the small-screen gate**

Change the first guard line so the default applies on every viewport:

```tsx
    if (sidebarView !== 'admin') return
```

Leave the comment above it updated if it mentions "wide screen": change "on a wide screen, default to" to "default to". Do not touch the other `isSmallScreen()` usages in the file (the import stays).

- [ ] **Step 3: Verify nothing else broke**

Run: `npm run typecheck`
Expected: no errors (`isSmallScreen` is still imported and used elsewhere in the file).

Run: `cd apps/fluux && npx vitest run src/components/ChatLayout.test.tsx`
Expected: PASS (no behavioral assertion in these tests depends on the mobile gate; if one does, update it to expect the overview default and note it in the commit).

- [ ] **Step 4: Manual verification in demo mode**

Run `npm run dev`, open `http://localhost:5173/demo.html`, narrow the window to a phone width (≤ 767px), open the Admin section from the icon rail, and confirm it lands on the server overview (stat cards) rather than the category list. Note the result in the commit body or PR.

- [ ] **Step 5: Commit**

```bash
git add apps/fluux/src/components/ChatLayout.tsx
git commit -m "feat(admin): default to server overview on mobile too"
```

---

### Task 4: Mobile header menu button + section bottom sheet

A mobile-only `☰` button in the `AdminView` header opens a `BottomSheet` hosting the existing `AdminDashboard`. Selecting a main-content section closes the sheet; Announcements/Other expand inline; executing a command closes the sheet to reveal the session form.

**Files:**
- Modify: `apps/fluux/src/components/AdminView.tsx` (header + sheet + close effect)
- Modify: `apps/fluux/src/i18n/locales/en.json` and the other 32 locale files in `apps/fluux/src/i18n/locales/`
- Test: `apps/fluux/src/components/AdminView.test.tsx`

**Interfaces:**
- Consumes: `BottomSheet` from `./ui/BottomSheet` (`open`, `onClose`, `title`, `ariaLabel`, `children`); `AdminDashboard` from `./AdminDashboard` (`activeCategory`, `onCategoryChange: (category: AdminCategory | null) => void`); `adminStore.getState().setActiveCategory`; `currentSession` from `useAdmin()` (already destructured).
- Produces: new i18n key `admin.openSections`.

- [ ] **Step 1: Add the i18n key to English**

In `apps/fluux/src/i18n/locales/en.json`, inside the top-level `"admin"` object (the one starting at the `"title": "Server Administration"` block, ~line 1060), add after `"selectCommand"`:

```json
        "openSections": "Open admin sections",
```

- [ ] **Step 2: Add `admin.openSections` to all 32 other locales**

For every other file in `apps/fluux/src/i18n/locales/*.json`, add the same `"openSections"` key inside its `admin` object with a translation appropriate to that language (e.g. French `"Ouvrir les sections d'administration"`, Spanish `"Abrir las secciones de administración"`, German `"Administrationsbereiche öffnen"`, etc.). Translate naturally per language; do not leave the English value as a placeholder, and use no em-dash (`—`/`–`) connectors.

Verify completeness:

Run: `cd apps/fluux && node -e "const fs=require('fs'),d='src/i18n/locales';for(const f of fs.readdirSync(d)){const j=JSON.parse(fs.readFileSync(d+'/'+f));if(!j.admin||!j.admin.openSections)console.log('MISSING admin.openSections in',f)}"`
Expected: no output (every locale has the key).

- [ ] **Step 3: Write the failing tests**

In `apps/fluux/src/components/AdminView.test.tsx`, extend the `adminState` object so the embedded `AdminDashboard` renders (add these fields to the object literal — they are additive and harmless to the existing tests):

```tsx
  commands: [{ node: 'stat-node', name: 'Stat', category: 'stats' }],
  commandsByCategory: {
    user: [],
    stats: [{ node: 'stat-node', name: 'Stat', category: 'stats' }],
    announcement: [],
    other: [],
  },
  isDiscovering: false,
  isAdmin: true,
  discoverMucService: vi.fn(),
  executeCommand: vi.fn(),
  fetchServerStats: vi.fn(),
```

Then add a new describe block (it relies on the `setActiveCategory` mock added in Task 2):

```tsx
describe('AdminView mobile section sheet', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('opens the section sheet from the header menu button', () => {
    render(<AdminView activeCategory="rooms" onBack={vi.fn()} />)

    // The sheet (and its Statistics section button) is not rendered until opened.
    expect(screen.queryByText('admin.categories.statistics')).not.toBeInTheDocument()

    fireEvent.click(screen.getByLabelText('admin.openSections'))

    expect(screen.getByText('admin.categories.statistics')).toBeInTheDocument()
  })

  it('navigates and closes the sheet when a main-content section is chosen', () => {
    render(<AdminView activeCategory="rooms" onBack={vi.fn()} />)

    fireEvent.click(screen.getByLabelText('admin.openSections'))
    fireEvent.click(screen.getByRole('button', { name: 'admin.categories.users' }))

    expect(setActiveCategory).toHaveBeenCalledWith('users')
    // Sheet closed → its Statistics button is gone again.
    expect(screen.queryByText('admin.categories.statistics')).not.toBeInTheDocument()
  })
})
```

- [ ] **Step 4: Run the tests to verify they fail**

Run: `cd apps/fluux && npx vitest run src/components/AdminView.test.tsx`
Expected: FAIL — there is no `admin.openSections` button and no sheet yet.

- [ ] **Step 5: Add the imports and sheet state to AdminView**

In `apps/fluux/src/components/AdminView.tsx`, add `Menu` to the lucide-react import and import the sheet + dashboard:

```tsx
import { Server, Users, Hash, User, Plus, ArrowLeft, Menu } from 'lucide-react'
```
```tsx
import { BottomSheet } from './ui/BottomSheet'
import { AdminDashboard } from './AdminDashboard'
```

Add sheet state alongside the other `useState` declarations (after `showAddUserModal`, ~line 70):

```tsx
  const [sectionsSheetOpen, setSectionsSheetOpen] = useState(false)
```

Add the sheet's category handler and the close-on-session effect. Place the handler near the other handlers (e.g. after `handleHeaderBack`) and the effect with the other effects:

```tsx
  // Section sheet (mobile): main-content sections navigate and close the sheet;
  // announcements/other only expand inline, so the sheet stays open.
  const handleSheetCategoryChange = (category: AdminCategory | null) => {
    adminStore.getState().setActiveCategory(category)
    if (category === null || category === 'stats' || category === 'users' || category === 'rooms') {
      setSectionsSheetOpen(false)
    }
  }
```
```tsx
  // Executing a command from the sheet opens a session in the main area — close the sheet.
  useEffect(() => {
    if (currentSession) setSectionsSheetOpen(false)
  }, [currentSession])
```

- [ ] **Step 6: Add the header menu button**

In the header (the `<div className={`h-14 ...`}>` at ~line 459), after the `<h2>` title element (line ~473), add the mobile-only menu button:

```tsx
        {onBack && (
          <button
            onClick={() => setSectionsSheetOpen(true)}
            className="p-1 -me-1 ms-auto rounded hover:bg-fluux-hover md:hidden tap-target"
            aria-label={t('admin.openSections')}
          >
            <Menu className="size-5 text-fluux-muted" />
          </button>
        )}
```

- [ ] **Step 7: Render the bottom sheet**

Inside the root container, next to the `AddUserModal` block (before the final `</div>` at ~line 489), add:

```tsx
      {/* Mobile section navigation sheet */}
      <BottomSheet
        open={sectionsSheetOpen}
        onClose={() => setSectionsSheetOpen(false)}
        title={t('admin.title')}
        ariaLabel={t('admin.title')}
      >
        <AdminDashboard activeCategory={activeCategory} onCategoryChange={handleSheetCategoryChange} />
      </BottomSheet>
```

- [ ] **Step 8: Run the tests to verify they pass**

Run: `cd apps/fluux && npx vitest run src/components/AdminView.test.tsx`
Expected: PASS (all back-button tests + the two new sheet tests).

- [ ] **Step 9: Typecheck, lint, full app test run**

Run: `npm run typecheck`
Expected: no errors.

Run: `cd apps/fluux && npx vitest run src/components/AdminView.test.tsx src/components/ServerOverview.test.tsx src/components/adminBackTarget.test.ts`
Expected: PASS, no stderr.

Run the linter (per repo convention, e.g. `npm run lint`).
Expected: clean.

- [ ] **Step 10: Manual verification in demo mode**

Run `npm run dev`, open the demo at a phone width, enter Admin (lands on overview), tap a stat card to enter Users/Rooms, tap the header `☰` to open the section sheet, pick a section (sheet closes and navigates), and confirm the back arrow steps list → overview → exit. Note the result in the PR.

- [ ] **Step 11: Commit**

```bash
git add apps/fluux/src/components/AdminView.tsx apps/fluux/src/components/AdminView.test.tsx apps/fluux/src/i18n/locales
git commit -m "feat(admin): mobile header menu opens admin section sheet"
```

---

## Self-Review

**Spec coverage:**
- "Mobile lands on ServerOverview / drop isSmallScreen gate" → Task 3. ✅
- "Stat cards become navigation (universal), users/rooms tappable, others read-only" → Task 1. ✅
- "Header menu button (mobile-only) opens bottom sheet reusing AdminDashboard" → Task 4. ✅
- "Back navigation gains 'overview' step (list → overview → exit)" → Task 2. ✅
- "Navigate via adminStore.getState().setActiveCategory" → Global Constraints + Tasks 1/2/4. ✅
- "Card→target config-driven via OverviewCardDef.target" → Task 1. ✅
- "Reuse BottomSheet; close rules; close-on-session effect" → Task 4. ✅
- Testing (adminBackTarget cases, ServerOverview card tests, AdminView sheet test) → Tasks 1/2/4. ✅

**Placeholder scan:** No TBD/TODO; every code step shows complete code; the only "translate per language" step (Task 4 Step 2) is inherent to i18n and includes a verification command and example translations. ✅

**Type consistency:** `AdminBackTarget`/`getAdminBackTarget(... activeCategory ...)` (Task 2) match their use in `AdminView.handleHeaderBack`. `OverviewCardDef.target?: AdminCategory` (Task 1) matches `setActiveCategory(target)`. `handleSheetCategoryChange: (category: AdminCategory | null)` matches `AdminDashboard`'s `onCategoryChange`. `adminStore.getState().setActiveCategory` signature is consistent across Tasks 1, 2, 4 and the test mock. ✅
