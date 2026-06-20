# Room/Chat Header Overflow Kebab Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Collapse lower-priority header actions into an overflow ("kebab") menu when the header is too narrow, driven by container width, in both the MUC room header and the 1:1 chat header.

**Architecture:** A reusable, data-driven overflow toolbar. Every collapsible action is rendered twice — once inline, once inside a kebab surface — and CSS container queries (`@container` + arbitrary `@min-[…px]` variants) decide which copy is visible at the current header width, so there is **zero React re-render on resize**. The kebab opens an anchored dropdown on hover/fine-pointer devices and a portaled `BottomSheet` (with a local sub-sheet stack for nested menus) on touch. Notification and room-management option sets are extracted to plain data so the inline dropdown, the kebab dropdown, and the kebab sub-sheet all render from one source.

**Tech Stack:** React 18, TypeScript, Tailwind CSS + `@tailwindcss/container-queries`, Vitest (happy-dom, with `@vitest-environment jsdom` pinned where a test asserts computed color/rgb), lucide-react icons, react-i18next.

## Global Constraints

- App-only change. No `@fluux/sdk` type or export changes — do not touch `packages/fluux-sdk`.
- Reuse existing primitives: `BottomSheet` (`components/ui/BottomSheet.tsx`), `useAnchoredMenu` (`hooks/useAnchoredMenu.ts`), `useHasHover`/`hasHover` (`hooks/useHasHover.ts`), `OverflowMenu`/`OverflowMenuItem` types where convenient. Do not modify `BottomSheet`.
- Touch vs hover is a **capability** decision: use `useHasHover()` / the `can-hover:`/`touch:` Tailwind variants, never `useIsMobileWeb()`.
- Container-query class strings must appear **verbatim** in source (Tailwind JIT cannot see dynamically-concatenated variant prefixes). Only use the literal tier constants defined in Task 1.
- i18n: reuse existing keys (listed per task). If any new key is added, translate it into all 33 locales — do not leave English placeholders. Scan new copy for em-dash connectors (`—`/`–`) and avoid them.
- Members/occupant toggle is the only always-pinned room action; it is never placed in the kebab.
- Before commit: `npm run typecheck`, the affected unit tests, and the linter must pass with no errors or stderr.

## File Structure

- Create `apps/fluux/src/components/header/headerOverflow.ts` — types + tier class constants + pure helpers.
- Create `apps/fluux/src/components/header/headerOverflow.test.ts` — tier helper tests.
- Create `apps/fluux/src/components/header/HeaderOverflowKebab.tsx` — kebab trigger + hover dropdown / touch sub-sheet surfaces.
- Create `apps/fluux/src/components/header/HeaderOverflowKebab.test.tsx` — kebab behavior tests.
- Create `apps/fluux/src/components/header/HeaderSubmenuButton.tsx` — inline trigger + anchored dropdown rendered from a group.
- Create `apps/fluux/src/components/header/HeaderSubmenuButton.test.tsx`.
- Create `apps/fluux/src/components/header/roomHeaderActions.ts` — pure builders that turn a `Room` + handlers into notification / management `HeaderActionGroup`s.
- Create `apps/fluux/src/components/header/roomHeaderActions.test.ts`.
- Modify `apps/fluux/tailwind.config.js` — register the container-queries plugin.
- Modify `apps/fluux/package.json` — add the `@tailwindcss/container-queries` dev dependency.
- Modify `apps/fluux/src/components/RoomHeader.tsx` — consume the new pieces.
- Modify `apps/fluux/src/components/ChatHeader.tsx` — collapse search, move profile/archive into `HeaderOverflowKebab`.

---

### Task 1: Tailwind container queries + tier class constants

**Files:**
- Modify: `apps/fluux/package.json`
- Modify: `apps/fluux/tailwind.config.js:73-85`
- Create: `apps/fluux/src/components/header/headerOverflow.ts`
- Test: `apps/fluux/src/components/header/headerOverflow.test.ts`

**Interfaces:**
- Produces:
  - `type HeaderActionItem = { key: string; label: string; description?: string; icon: LucideIcon; active?: boolean; danger?: boolean; disabled?: boolean; onSelect: () => void }`
  - `type HeaderActionGroup = { title: string; items: HeaderActionItem[] }`
  - `type OverflowTier = 'pinned' | 'search' | 'wide'`
  - `const OVERFLOW_TIER: Record<OverflowTier, { inline: string; kebab: string }>`
  - `const KEBAB_TRIGGER_CLASS: string`
  - `function inlineClass(tier: OverflowTier): string` and `function kebabClass(tier: OverflowTier): string`

- [ ] **Step 1: Add the dev dependency**

Run:
```bash
cd apps/fluux && npm install -D @tailwindcss/container-queries && cd ../..
```
Expected: `package.json` gains `"@tailwindcss/container-queries"` under `devDependencies`; lockfile updates.

- [ ] **Step 2: Register the plugin in tailwind.config.js**

Modify the `plugins` array (currently lines 73-85) so it also loads the container-queries plugin. Add the import at the top and the plugin to the array:

```js
import plugin from 'tailwindcss/plugin'
import containerQueries from '@tailwindcss/container-queries'
```

```js
  plugins: [
    containerQueries,
    plugin(({ addVariant }) => {
      addVariant('can-hover', '@media (hover: hover) and (pointer: fine)')
      addVariant('touch', '@media (hover: none), (pointer: coarse)')
    }),
  ],
```

- [ ] **Step 3: Write the failing test for the tier helpers**

Create `apps/fluux/src/components/header/headerOverflow.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { OVERFLOW_TIER, KEBAB_TRIGGER_CLASS, inlineClass, kebabClass } from './headerOverflow'

describe('headerOverflow tiers', () => {
  it('pinned actions are always inline and never in the kebab', () => {
    expect(inlineClass('pinned')).toBe('flex')
    expect(kebabClass('pinned')).toBe('hidden')
  })

  it('search reveals inline at the medium container width and hides its kebab copy there', () => {
    expect(inlineClass('search')).toBe('hidden @min-[440px]:flex')
    expect(kebabClass('search')).toBe('flex @min-[440px]:hidden')
  })

  it('wide-tier actions reveal inline only on a wide container', () => {
    expect(inlineClass('wide')).toBe('hidden @min-[600px]:flex')
    expect(kebabClass('wide')).toBe('flex @min-[600px]:hidden')
  })

  it('the kebab trigger is hidden once the widest tier is inline', () => {
    expect(KEBAB_TRIGGER_CLASS).toContain('@min-[600px]:hidden')
  })

  it('OVERFLOW_TIER strings are literal so Tailwind JIT can see them', () => {
    // Guards against anyone refactoring to dynamic concatenation.
    expect(OVERFLOW_TIER.wide.inline).toBe('hidden @min-[600px]:flex')
  })
})
```

- [ ] **Step 4: Run the test to verify it fails**

Run:
```bash
cd apps/fluux && npx vitest run src/components/header/headerOverflow.test.ts; cd ../..
```
Expected: FAIL — cannot find module `./headerOverflow`.

- [ ] **Step 5: Implement headerOverflow.ts**

Create `apps/fluux/src/components/header/headerOverflow.ts`:

```ts
import type { LucideIcon } from 'lucide-react'

/** A single selectable action or option (a kebab/sheet row, or a dropdown item). */
export interface HeaderActionItem {
  key: string
  label: string
  /** Optional secondary line (e.g. the notification mode subtitle). */
  description?: string
  icon: LucideIcon
  /** Renders a check / active styling (e.g. the current notification mode). */
  active?: boolean
  /** Destructive (red) styling. */
  danger?: boolean
  disabled?: boolean
  onSelect: () => void
}

/** A titled set of items — a nested menu (notifications, room management). */
export interface HeaderActionGroup {
  title: string
  items: HeaderActionItem[]
}

/**
 * Collapse priority for a header action.
 * - `pinned`  — always inline, never collapses (members toggle).
 * - `search`  — collapses second (revealed inline on a medium-width header).
 * - `wide`    — collapses first (revealed inline only on a wide header).
 */
export type OverflowTier = 'pinned' | 'search' | 'wide'

/**
 * Container-query class pairs. The container is the `<header>` (marked
 * `@container`). `inline` is applied to the inline copy of an action; `kebab` to
 * its copy inside the overflow surface. Exactly one copy is visible at any width.
 *
 * NOTE: every string here is a literal so Tailwind's JIT content scanner emits
 * the arbitrary `@min-[…]` container variants. Never build these by
 * concatenating a tier prefix at runtime.
 */
export const OVERFLOW_TIER: Record<OverflowTier, { inline: string; kebab: string }> = {
  pinned: { inline: 'flex', kebab: 'hidden' },
  search: { inline: 'hidden @min-[440px]:flex', kebab: 'flex @min-[440px]:hidden' },
  wide: { inline: 'hidden @min-[600px]:flex', kebab: 'flex @min-[600px]:hidden' },
}

/** Hide the kebab trigger once the widest collapsible tier is shown inline. */
export const KEBAB_TRIGGER_CLASS = 'flex @min-[600px]:hidden'

export function inlineClass(tier: OverflowTier): string {
  return OVERFLOW_TIER[tier].inline
}

export function kebabClass(tier: OverflowTier): string {
  return OVERFLOW_TIER[tier].kebab
}
```

- [ ] **Step 6: Run the test to verify it passes**

Run:
```bash
cd apps/fluux && npx vitest run src/components/header/headerOverflow.test.ts; cd ../..
```
Expected: PASS (5 tests).

- [ ] **Step 7: Typecheck and commit**

Run:
```bash
npm run typecheck
```
Expected: no errors.

```bash
git add apps/fluux/package.json apps/fluux/package-lock.json apps/fluux/tailwind.config.js apps/fluux/src/components/header/headerOverflow.ts apps/fluux/src/components/header/headerOverflow.test.ts
git commit -m "feat(header): container-query overflow tiers + action types"
```

---

### Task 2: HeaderOverflowKebab — hover dropdown + touch sub-sheet

**Files:**
- Create: `apps/fluux/src/components/header/HeaderOverflowKebab.tsx`
- Test: `apps/fluux/src/components/header/HeaderOverflowKebab.test.tsx`

**Interfaces:**
- Consumes: `HeaderActionItem`, `HeaderActionGroup` (Task 1); `BottomSheet` (`components/ui/BottomSheet.tsx`); `useHasHover` (`hooks/useHasHover.ts`); `useAnchoredMenu` (`hooks/useAnchoredMenu.ts`); `useClickOutside` (`hooks/useClickOutside.ts`).
- Produces:
  - `type OverflowEntry = { kind: 'action'; key: string; label: string; icon: LucideIcon; danger?: boolean; disabled?: boolean; onSelect: () => void; kebabClassName?: string } | { kind: 'submenu'; key: string; label: string; icon: LucideIcon; group: HeaderActionGroup; kebabClassName?: string }`
  - `function HeaderOverflowKebab(props: { ariaLabel: string; entries: OverflowEntry[]; triggerClassName?: string }): JSX.Element | null`

**Behavior contract:**
- Renders nothing when `entries` is empty.
- Trigger is a `MoreVertical` button with `aria-haspopup="menu"`, `aria-expanded`.
- On open: if `useHasHover()` is `true`, render an anchored dropdown (flat list; a `submenu` entry renders its group title as a section header followed by its items). If `false`, render a `BottomSheet` whose root view lists actions and one row per submenu; tapping a submenu row pushes a sub-view (`sheetView` = that entry key) titled with the group title and a back affordance; selecting any item fires `onSelect` and closes the whole sheet; closing resets `sheetView` to `'root'`.
- Each entry's outer wrapper carries its `kebabClassName` (the tier `kebab` class) so the row is container-query hidden when its inline copy is showing.

- [ ] **Step 1: Write the failing tests**

Create `apps/fluux/src/components/header/HeaderOverflowKebab.test.tsx`:

```tsx
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { Bell, Search, UserPlus } from 'lucide-react'
import { HeaderOverflowKebab, type OverflowEntry } from './HeaderOverflowKebab'

const mockHasHover = vi.fn(() => true)
vi.mock('@/hooks/useHasHover', () => ({
  useHasHover: () => mockHasHover(),
  hasHover: () => mockHasHover(),
}))

function makeEntries(onSearch = vi.fn(), onMode = vi.fn()): OverflowEntry[] {
  return [
    { kind: 'action', key: 'search', label: 'Search', icon: Search, onSelect: onSearch },
    { kind: 'action', key: 'invite', label: 'Invite', icon: UserPlus, onSelect: vi.fn() },
    {
      kind: 'submenu', key: 'notify', label: 'Notifications', icon: Bell,
      group: { title: 'Notifications', items: [
        { key: 'mentions', label: 'Mentions only', icon: Bell, onSelect: onMode },
      ] },
    },
  ]
}

describe('HeaderOverflowKebab', () => {
  beforeEach(() => { mockHasHover.mockReturnValue(true) })

  it('renders nothing with no entries', () => {
    const { container } = render(<HeaderOverflowKebab ariaLabel="More" entries={[]} />)
    expect(container.firstChild).toBeNull()
  })

  it('hover: opens an anchored dropdown with flat actions and a submenu section', () => {
    render(<HeaderOverflowKebab ariaLabel="More" entries={makeEntries()} />)
    fireEvent.click(screen.getByLabelText('More'))
    expect(screen.getByText('Search')).toBeInTheDocument()
    expect(screen.getByText('Invite')).toBeInTheDocument()
    // submenu group title acts as a section header in the dropdown
    expect(screen.getByText('Notifications')).toBeInTheDocument()
    expect(screen.getByText('Mentions only')).toBeInTheDocument()
  })

  it('hover: selecting an action fires onSelect and closes', () => {
    const onSearch = vi.fn()
    render(<HeaderOverflowKebab ariaLabel="More" entries={makeEntries(onSearch)} />)
    fireEvent.click(screen.getByLabelText('More'))
    fireEvent.click(screen.getByText('Search'))
    expect(onSearch).toHaveBeenCalledTimes(1)
    expect(screen.queryByText('Invite')).not.toBeInTheDocument()
  })

  it('touch: opens a bottom sheet, navigates into a submenu and back', () => {
    mockHasHover.mockReturnValue(false)
    const onMode = vi.fn()
    render(<HeaderOverflowKebab ariaLabel="More" entries={makeEntries(vi.fn(), onMode)} />)
    fireEvent.click(screen.getByLabelText('More'))
    // root sheet shows the submenu as a navigable row
    fireEvent.click(screen.getByText('Notifications'))
    // sub-view shows the option
    fireEvent.click(screen.getByText('Mentions only'))
    expect(onMode).toHaveBeenCalledTimes(1)
  })

  it('touch: back returns to root without firing actions', () => {
    mockHasHover.mockReturnValue(false)
    render(<HeaderOverflowKebab ariaLabel="More" entries={makeEntries()} />)
    fireEvent.click(screen.getByLabelText('More'))
    fireEvent.click(screen.getByText('Notifications'))
    fireEvent.click(screen.getByLabelText('Back'))
    // root actions visible again
    expect(screen.getByText('Search')).toBeInTheDocument()
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run:
```bash
cd apps/fluux && npx vitest run src/components/header/HeaderOverflowKebab.test.tsx; cd ../..
```
Expected: FAIL — cannot find module `./HeaderOverflowKebab`.

- [ ] **Step 3: Implement HeaderOverflowKebab.tsx**

Create `apps/fluux/src/components/header/HeaderOverflowKebab.tsx`:

```tsx
import { useEffect, useRef, useState } from 'react'
import { MoreVertical, ChevronLeft, ChevronRight, Check, type LucideIcon } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { BottomSheet } from '../ui/BottomSheet'
import { useHasHover } from '@/hooks/useHasHover'
import { useAnchoredMenu, useClickOutside } from '@/hooks'
import type { HeaderActionGroup, HeaderActionItem } from './headerOverflow'

export type OverflowEntry =
  | {
      kind: 'action'
      key: string
      label: string
      icon: LucideIcon
      danger?: boolean
      disabled?: boolean
      onSelect: () => void
      /** Container-query class controlling when this row is visible in the kebab. */
      kebabClassName?: string
    }
  | {
      kind: 'submenu'
      key: string
      label: string
      icon: LucideIcon
      group: HeaderActionGroup
      kebabClassName?: string
    }

interface HeaderOverflowKebabProps {
  ariaLabel: string
  entries: OverflowEntry[]
  triggerClassName?: string
}

const DEFAULT_TRIGGER =
  'p-1.5 rounded hover:bg-fluux-hover text-fluux-muted hover:text-fluux-text transition-colors tap-target'

const ROW =
  'w-full flex items-center gap-3 px-3 py-2.5 text-start text-sm transition-colors hover:bg-fluux-hover disabled:opacity-50 disabled:cursor-not-allowed'

/** Shared item row used by both the dropdown and the sheet. */
function ItemRow({ item, onPick }: { item: HeaderActionItem; onPick: () => void }) {
  const Icon = item.icon
  return (
    <button
      type="button"
      role="menuitem"
      disabled={item.disabled}
      onClick={onPick}
      className={`${ROW} ${item.danger ? 'text-fluux-red' : 'text-fluux-text'}`}
    >
      <Icon className="size-4 flex-shrink-0 text-fluux-muted" />
      <span className="flex-1">
        <span className="block">{item.label}</span>
        {item.description && (
          <span className="block text-xs text-fluux-muted">{item.description}</span>
        )}
      </span>
      {item.active && <Check className="size-4 text-fluux-brand" />}
    </button>
  )
}

export function HeaderOverflowKebab({ ariaLabel, entries, triggerClassName }: HeaderOverflowKebabProps) {
  const { t } = useTranslation()
  const [isOpen, setIsOpen] = useState(false)
  const [sheetView, setSheetView] = useState<string>('root')
  const hasHover = useHasHover()
  const containerRef = useRef<HTMLDivElement>(null)
  const menu = useAnchoredMenu(isOpen && hasHover)

  useClickOutside(containerRef, () => setIsOpen(false), isOpen && hasHover)

  useEffect(() => {
    if (!isOpen) return
    const onEsc = (e: KeyboardEvent) => { if (e.key === 'Escape') setIsOpen(false) }
    document.addEventListener('keydown', onEsc)
    return () => document.removeEventListener('keydown', onEsc)
  }, [isOpen])

  const close = () => { setIsOpen(false); setSheetView('root') }

  if (entries.length === 0) return null

  const trigger = (
    <button
      ref={menu.triggerRef}
      type="button"
      onClick={() => setIsOpen((v) => !v)}
      aria-label={ariaLabel}
      aria-haspopup="menu"
      aria-expanded={isOpen}
      className={triggerClassName ?? DEFAULT_TRIGGER}
    >
      <MoreVertical className="size-4" />
    </button>
  )

  // --- Hover / fine pointer: anchored dropdown ---------------------------------
  if (hasHover) {
    return (
      <div className="relative" ref={containerRef}>
        {trigger}
        {isOpen && (
          <div
            ref={menu.menuRef}
            role="menu"
            style={{ left: menu.position.x, top: menu.position.y }}
            className="fixed w-64 max-w-[calc(100vw-1rem)] bg-fluux-bg border border-fluux-hover rounded-lg shadow-lg z-50 py-1"
          >
            {entries.map((e) =>
              e.kind === 'action' ? (
                <div key={e.key} className={e.kebabClassName}>
                  <ItemRow
                    item={{ key: e.key, label: e.label, icon: e.icon, danger: e.danger, disabled: e.disabled, onSelect: e.onSelect }}
                    onPick={() => { close(); e.onSelect() }}
                  />
                </div>
              ) : (
                <div key={e.key} className={e.kebabClassName}>
                  <div className="px-3 pt-2 pb-1 text-xs font-semibold text-fluux-muted">{e.group.title}</div>
                  {e.group.items.map((item) => (
                    <ItemRow key={item.key} item={item} onPick={() => { close(); item.onSelect() }} />
                  ))}
                </div>
              ),
            )}
          </div>
        )}
      </div>
    )
  }

  // --- Touch: bottom sheet with a one-level sub-sheet stack --------------------
  const activeSubmenu = entries.find((e) => e.kind === 'submenu' && e.key === sheetView)
  const inSub = activeSubmenu && activeSubmenu.kind === 'submenu'

  const sheetTitle = inSub ? (
    <button type="button" onClick={() => setSheetView('root')} aria-label={t('common.back', 'Back')} className="flex items-center gap-1 text-fluux-text">
      <ChevronLeft className="size-4" />
      <span>{activeSubmenu.group.title}</span>
    </button>
  ) : ariaLabel

  return (
    <div className="relative" ref={containerRef}>
      {trigger}
      <BottomSheet open={isOpen} onClose={close} title={sheetTitle} ariaLabel={ariaLabel}>
        {inSub ? (
          <div role="menu" className="py-1">
            {activeSubmenu.group.items.map((item) => (
              <ItemRow key={item.key} item={item} onPick={() => { close(); item.onSelect() }} />
            ))}
          </div>
        ) : (
          <div role="menu" className="py-1">
            {entries.map((e) =>
              e.kind === 'action' ? (
                <ItemRow
                  key={e.key}
                  item={{ key: e.key, label: e.label, icon: e.icon, danger: e.danger, disabled: e.disabled, onSelect: e.onSelect }}
                  onPick={() => { close(); e.onSelect() }}
                />
              ) : (
                <button
                  key={e.key}
                  type="button"
                  onClick={() => setSheetView(e.key)}
                  className={`${ROW} text-fluux-text`}
                >
                  <e.icon className="size-4 flex-shrink-0 text-fluux-muted" />
                  <span className="flex-1">{e.label}</span>
                  <ChevronRight className="size-4 text-fluux-muted" />
                </button>
              ),
            )}
          </div>
        )}
      </BottomSheet>
    </div>
  )
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run:
```bash
cd apps/fluux && npx vitest run src/components/header/HeaderOverflowKebab.test.tsx; cd ../..
```
Expected: PASS (5 tests). If `common.back` is missing from the test i18n, the fallback string `'Back'` is used — the `getByLabelText('Back')` assertion still resolves.

- [ ] **Step 5: Commit**

```bash
git add apps/fluux/src/components/header/HeaderOverflowKebab.tsx apps/fluux/src/components/header/HeaderOverflowKebab.test.tsx
git commit -m "feat(header): overflow kebab with hover dropdown and touch sub-sheets"
```

---

### Task 3: Room notification + management option builders (data)

**Files:**
- Create: `apps/fluux/src/components/header/roomHeaderActions.ts`
- Test: `apps/fluux/src/components/header/roomHeaderActions.test.ts`

**Interfaces:**
- Consumes: `HeaderActionGroup`, `HeaderActionItem` (Task 1); `Room` type from `@fluux/sdk`; a `TFunction` from `i18next`.
- Produces:
  - `function buildNotifyGroup(args: { room: Room; t: TFunction; setRoomNotifyAll: (jid: string, all: boolean, persistent?: boolean) => Promise<void> }): HeaderActionGroup`
  - `function buildManagementGroup(args: { room: Room; t: TFunction; isOwner: boolean; canManageRoom: boolean; onConfig: () => void; onAvatar: () => void; onClearAvatar: () => void; onMembers: () => void; onHats: () => void }): HeaderActionGroup | null` — returns `null` when `!canManageRoom`.
  - `function notifyModeOf(room: Room): 'mentions' | 'all-session' | 'all-always'`

The builders centralize the logic currently inlined in `RoomHeader.tsx` (`getNotifyMode` at 102-107, `handleSelectMode` at 117-139, the notification dropdown items at 203-248, and the management dropdown items at 289-395).

- [ ] **Step 1: Write the failing tests**

Create `apps/fluux/src/components/header/roomHeaderActions.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest'
import type { Room } from '@fluux/sdk'
import { buildNotifyGroup, buildManagementGroup, notifyModeOf } from './roomHeaderActions'

const t = ((k: string) => k) as any

function room(partial: Partial<Room> = {}): Room {
  return {
    jid: 'room@conf.example.com',
    name: 'Room',
    occupants: new Map(),
    notifyAll: false,
    notifyAllPersistent: false,
    isQuickChat: false,
    avatar: undefined,
    supportsHats: true,
    ...partial,
  } as Room
}

describe('notifyModeOf', () => {
  it('maps flags to modes', () => {
    expect(notifyModeOf(room())).toBe('mentions')
    expect(notifyModeOf(room({ notifyAll: true }))).toBe('all-session')
    expect(notifyModeOf(room({ notifyAll: true, notifyAllPersistent: true }))).toBe('all-always')
  })
})

describe('buildNotifyGroup', () => {
  it('omits the persistent option for quick chats', () => {
    const g = buildNotifyGroup({ room: room({ isQuickChat: true }), t, setRoomNotifyAll: vi.fn() })
    expect(g.items.map((i) => i.key)).toEqual(['mentions', 'all-session'])
  })

  it('marks the active mode and wires onSelect', () => {
    const setRoomNotifyAll = vi.fn().mockResolvedValue(undefined)
    const g = buildNotifyGroup({ room: room({ notifyAll: true }), t, setRoomNotifyAll })
    expect(g.items.find((i) => i.key === 'all-session')!.active).toBe(true)
    g.items.find((i) => i.key === 'mentions')!.onSelect()
    expect(setRoomNotifyAll).toHaveBeenCalledWith('room@conf.example.com', false, false)
  })
})

describe('buildManagementGroup', () => {
  const handlers = { onConfig: vi.fn(), onAvatar: vi.fn(), onClearAvatar: vi.fn(), onMembers: vi.fn(), onHats: vi.fn() }

  it('returns null when the user cannot manage the room', () => {
    expect(buildManagementGroup({ room: room(), t, isOwner: false, canManageRoom: false, ...handlers })).toBeNull()
  })

  it('admin (non-owner) sees settings/subject/membership but not avatar or hats', () => {
    const g = buildManagementGroup({ room: room(), t, isOwner: false, canManageRoom: true, ...handlers })!
    const keys = g.items.map((i) => i.key)
    expect(keys).toContain('settings')
    expect(keys).toContain('membership')
    expect(keys).not.toContain('avatar')
    expect(keys).not.toContain('hats')
  })

  it('owner sees avatar + hats; clear-avatar only when an avatar exists', () => {
    const without = buildManagementGroup({ room: room(), t, isOwner: true, canManageRoom: true, ...handlers })!
    expect(without.items.map((i) => i.key)).not.toContain('clear-avatar')
    const withAvatar = buildManagementGroup({ room: room({ avatar: 'data:...' }), t, isOwner: true, canManageRoom: true, ...handlers })!
    expect(withAvatar.items.map((i) => i.key)).toContain('clear-avatar')
  })

  it('disables hats when the room does not support them', () => {
    const g = buildManagementGroup({ room: room({ supportsHats: false }), t, isOwner: true, canManageRoom: true, ...handlers })!
    expect(g.items.find((i) => i.key === 'hats')!.disabled).toBe(true)
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run:
```bash
cd apps/fluux && npx vitest run src/components/header/roomHeaderActions.test.ts; cd ../..
```
Expected: FAIL — cannot find module `./roomHeaderActions`.

- [ ] **Step 3: Implement roomHeaderActions.ts**

Create `apps/fluux/src/components/header/roomHeaderActions.ts`:

```ts
import type { TFunction } from 'i18next'
import type { Room } from '@fluux/sdk'
import { Bell, BellOff, BellRing, Settings, Type, Image, Trash2, UserMinus, Award } from 'lucide-react'
import type { HeaderActionGroup } from './headerOverflow'

export type NotifyMode = 'mentions' | 'all-session' | 'all-always'

export function notifyModeOf(room: Room): NotifyMode {
  if (room.notifyAllPersistent) return 'all-always'
  if (room.notifyAll) return 'all-session'
  return 'mentions'
}

interface NotifyArgs {
  room: Room
  t: TFunction
  setRoomNotifyAll: (jid: string, all: boolean, persistent?: boolean) => Promise<void>
}

export function buildNotifyGroup({ room, t, setRoomNotifyAll }: NotifyArgs): HeaderActionGroup {
  const mode = notifyModeOf(room)
  const select = (next: NotifyMode) => {
    switch (next) {
      case 'mentions':
        void setRoomNotifyAll(room.jid, false, false)
        if (room.notifyAllPersistent) void setRoomNotifyAll(room.jid, false, true)
        break
      case 'all-session':
        void setRoomNotifyAll(room.jid, true, false)
        if (room.notifyAllPersistent) void setRoomNotifyAll(room.jid, false, true)
        break
      case 'all-always':
        void setRoomNotifyAll(room.jid, true, true)
        break
    }
  }

  const items = [
    {
      key: 'mentions', label: t('rooms.mentionsOnly'), description: t('rooms.defaultBehavior'),
      icon: BellOff, active: mode === 'mentions', onSelect: () => select('mentions'),
    },
    {
      key: 'all-session', label: t('rooms.allMessages'), description: t('rooms.thisSessionOnly'),
      icon: Bell, active: mode === 'all-session', onSelect: () => select('all-session'),
    },
  ]
  if (!room.isQuickChat) {
    items.push({
      key: 'all-always', label: t('rooms.allMessages'), description: t('rooms.alwaysSavedToBookmark'),
      icon: BellRing, active: mode === 'all-always', onSelect: () => select('all-always'),
    })
  }
  return { title: t('rooms.notificationSettings'), items }
}

interface ManagementArgs {
  room: Room
  t: TFunction
  isOwner: boolean
  canManageRoom: boolean
  onConfig: () => void
  onAvatar: () => void
  onClearAvatar: () => void
  onMembers: () => void
  onHats: () => void
}

export function buildManagementGroup(args: ManagementArgs): HeaderActionGroup | null {
  const { room, t, isOwner, canManageRoom, onConfig, onAvatar, onClearAvatar, onMembers, onHats } = args
  if (!canManageRoom) return null

  const items: HeaderActionGroup['items'] = [
    { key: 'settings', label: t('rooms.roomSettings'), description: t('rooms.configureRoom'), icon: Settings, onSelect: onConfig },
    { key: 'subject', label: t('rooms.changeSubject'), icon: Type, onSelect: onConfig },
  ]
  if (isOwner) {
    items.push({ key: 'avatar', label: t('rooms.changeAvatar'), icon: Image, onSelect: onAvatar })
    if (room.avatar) {
      items.push({ key: 'clear-avatar', label: t('rooms.removeAvatar'), icon: Trash2, danger: true, onSelect: onClearAvatar })
    }
  }
  if (canManageRoom) {
    items.push({ key: 'membership', label: t('rooms.manageMembership'), description: t('rooms.kickBanMembers'), icon: UserMinus, onSelect: onMembers })
  }
  if (isOwner) {
    items.push({
      key: 'hats', label: t('rooms.manageHats'),
      description: room.supportsHats ? t('rooms.manageHatsDesc') : t('rooms.hatsNotEnabled'),
      icon: Award, disabled: !room.supportsHats, onSelect: onHats,
    })
  }
  return { title: t('rooms.manageRoom'), items }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run:
```bash
cd apps/fluux && npx vitest run src/components/header/roomHeaderActions.test.ts; cd ../..
```
Expected: PASS.

- [ ] **Step 5: Typecheck and commit**

```bash
npm run typecheck
```
Expected: no errors.

```bash
git add apps/fluux/src/components/header/roomHeaderActions.ts apps/fluux/src/components/header/roomHeaderActions.test.ts
git commit -m "feat(header): data builders for room notify + management groups"
```

---

### Task 4: HeaderSubmenuButton — inline trigger + anchored dropdown from a group

**Files:**
- Create: `apps/fluux/src/components/header/HeaderSubmenuButton.tsx`
- Test: `apps/fluux/src/components/header/HeaderSubmenuButton.test.tsx`

**Interfaces:**
- Consumes: `HeaderActionGroup` (Task 1); `useAnchoredMenu`, `useClickOutside`; `Tooltip` (`components/Tooltip.tsx`).
- Produces:
  - `function HeaderSubmenuButton(props: { ariaLabel: string; tooltip: string; icon: LucideIcon; active?: boolean; group: HeaderActionGroup; className?: string }): JSX.Element` — the inline replacement for the hand-written notification / management dropdowns. Renders a trigger (icon + `ChevronDown`) and, when open, the group's items as an anchored dropdown using the same markup the kebab dropdown uses.

- [ ] **Step 1: Write the failing test**

Create `apps/fluux/src/components/header/HeaderSubmenuButton.test.tsx`:

```tsx
import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { Bell } from 'lucide-react'
import { HeaderSubmenuButton } from './HeaderSubmenuButton'

describe('HeaderSubmenuButton', () => {
  const group = {
    title: 'Notifications',
    items: [
      { key: 'mentions', label: 'Mentions only', icon: Bell, active: true, onSelect: vi.fn() },
      { key: 'all', label: 'All messages', icon: Bell, onSelect: vi.fn() },
    ],
  }

  it('opens the dropdown and lists the group items', () => {
    render(<HeaderSubmenuButton ariaLabel="Notify" tooltip="Notify" icon={Bell} group={group} />)
    fireEvent.click(screen.getByLabelText('Notify'))
    expect(screen.getByText('Mentions only')).toBeInTheDocument()
    expect(screen.getByText('All messages')).toBeInTheDocument()
  })

  it('fires an item onSelect and closes', () => {
    const onSelect = vi.fn()
    const g = { ...group, items: [{ key: 'mentions', label: 'Mentions only', icon: Bell, onSelect }] }
    render(<HeaderSubmenuButton ariaLabel="Notify" tooltip="Notify" icon={Bell} group={g} />)
    fireEvent.click(screen.getByLabelText('Notify'))
    fireEvent.click(screen.getByText('Mentions only'))
    expect(onSelect).toHaveBeenCalledTimes(1)
    expect(screen.queryByText('Mentions only')).not.toBeInTheDocument()
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run:
```bash
cd apps/fluux && npx vitest run src/components/header/HeaderSubmenuButton.test.tsx; cd ../..
```
Expected: FAIL — module not found.

- [ ] **Step 3: Implement HeaderSubmenuButton.tsx**

Create `apps/fluux/src/components/header/HeaderSubmenuButton.tsx`:

```tsx
import { useEffect, useRef, useState } from 'react'
import { ChevronDown, Check, type LucideIcon } from 'lucide-react'
import { Tooltip } from '../Tooltip'
import { useAnchoredMenu, useClickOutside } from '@/hooks'
import type { HeaderActionGroup } from './headerOverflow'

interface HeaderSubmenuButtonProps {
  ariaLabel: string
  tooltip: string
  icon: LucideIcon
  active?: boolean
  group: HeaderActionGroup
  /** Override trigger classes (the caller passes the active/idle styling). */
  className?: string
}

export function HeaderSubmenuButton({ ariaLabel, tooltip, icon: Icon, active, group, className }: HeaderSubmenuButtonProps) {
  const [open, setOpen] = useState(false)
  const containerRef = useRef<HTMLDivElement>(null)
  const menu = useAnchoredMenu(open)

  useClickOutside(containerRef, () => setOpen(false), open)
  useEffect(() => {
    if (!open) return
    const onEsc = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false) }
    document.addEventListener('keydown', onEsc)
    return () => document.removeEventListener('keydown', onEsc)
  }, [open])

  const idle = 'hover:bg-fluux-hover text-fluux-muted hover:text-fluux-text'
  const on = 'bg-fluux-brand/20 text-fluux-brand'

  return (
    <div className="relative" ref={containerRef}>
      <Tooltip content={tooltip} position="bottom" disabled={open}>
        <button
          ref={menu.triggerRef}
          onClick={() => setOpen((v) => !v)}
          aria-label={ariaLabel}
          aria-haspopup="menu"
          aria-expanded={open}
          className={className ?? `flex items-center gap-1 px-2 py-1.5 rounded-lg transition-colors tap-target ${active ? on : idle}`}
        >
          <Icon className="size-4" />
          <ChevronDown className={`size-3 transition-transform ${open ? 'rotate-180' : ''}`} />
        </button>
      </Tooltip>

      {open && (
        <div
          ref={menu.menuRef}
          role="menu"
          style={{ left: menu.position.x, top: menu.position.y }}
          className="fixed w-64 max-w-[calc(100vw-1rem)] bg-fluux-bg border border-fluux-hover rounded-lg shadow-lg z-30 py-1"
        >
          {group.items.map((item) => {
            const ItemIcon = item.icon
            return (
              <button
                key={item.key}
                type="button"
                role="menuitem"
                disabled={item.disabled}
                onClick={() => { setOpen(false); item.onSelect() }}
                className={`w-full flex items-center gap-3 px-3 py-2 text-start transition-colors hover:bg-fluux-hover disabled:opacity-50 disabled:cursor-not-allowed ${item.danger ? 'text-fluux-red' : 'text-fluux-text'}`}
              >
                <ItemIcon className="size-4 flex-shrink-0 text-fluux-muted" />
                <span className="flex-1">
                  <span className="block text-sm">{item.label}</span>
                  {item.description && <span className="block text-xs text-fluux-muted">{item.description}</span>}
                </span>
                {item.active && <Check className="size-4 text-fluux-brand" />}
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}
```

- [ ] **Step 4: Run to verify it passes**

Run:
```bash
cd apps/fluux && npx vitest run src/components/header/HeaderSubmenuButton.test.tsx; cd ../..
```
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/fluux/src/components/header/HeaderSubmenuButton.tsx apps/fluux/src/components/header/HeaderSubmenuButton.test.tsx
git commit -m "feat(header): inline submenu button rendered from group data"
```

---

### Task 5: Wire RoomHeader to the overflow system

**Files:**
- Modify: `apps/fluux/src/components/RoomHeader.tsx`

**Interfaces:**
- Consumes: `buildNotifyGroup`, `buildManagementGroup`, `notifyModeOf` (Task 3); `HeaderSubmenuButton` (Task 4); `HeaderOverflowKebab`, `OverflowEntry` (Task 2); `inlineClass`, `kebabClass` (Task 1).

This task replaces the three hand-written action blocks (notification 179-251, invite 253-262, management 264-399) and the inline search (401-412) with: inline copies tagged with tier `inline` classes plus one `HeaderOverflowKebab`. The members toggle (414-429) stays pinned and unchanged. The modals (441-489) and the avatar-error banner (431-439) are unchanged. There is no separate failing-unit-test step here — coverage comes from Tasks 2-4 plus the manual pass in Task 7; this task is a structural refactor verified by typecheck, the existing suite, and the demo run.

- [ ] **Step 1: Mark the header as a container and import the new pieces**

Change the imports block. Replace the `useAnchoredMenu` usage for the two dropdowns with the new components. Update the lucide import to drop now-unused icons and keep the ones still referenced (`Hash`, `ArrowLeft`, `Users`, `X`, `ChevronRight`, `Bell`, `BellOff`, `BellRing`, `Settings`, `UserPlus`, `Search`). Add after the existing imports:

```tsx
import { HeaderSubmenuButton } from './header/HeaderSubmenuButton'
import { HeaderOverflowKebab, type OverflowEntry } from './header/HeaderOverflowKebab'
import { buildNotifyGroup, buildManagementGroup, notifyModeOf } from './header/roomHeaderActions'
import { inlineClass, kebabClass } from './header/headerOverflow'
```

Change the `<header>` opening tag (line 142) to add `@container`:

```tsx
    <header className={`@container h-14 ${titleBarClass} px-4 flex items-center border-b border-fluux-bg shadow-sm gap-3`} {...dragRegionProps}>
```

- [ ] **Step 2: Replace local notify/owner menu state with builders**

Remove `showNotifyMenu`, `showOwnerMenu`, `notifyMenuRef`, `ownerMenuRef`, `notifyMenu`, `ownerMenu`, the two `useClickOutside` calls, `getNotifyMode`/`notifyMode`, `NotifyIcon`, and `handleSelectMode` (lines 74-75, 82-85, 94-99, 101-139 as applicable). Keep the modal state (`showAvatarModal`, `showInviteModal`, `showConfigModal`, `showMembersModal`, `showHatsModal`, `avatarError`). Compute the groups instead:

```tsx
  const mode = notifyModeOf(room)
  const NotifyIcon = mode === 'mentions' ? BellOff : mode === 'all-always' ? BellRing : Bell
  const notifyGroup = buildNotifyGroup({ room, t, setRoomNotifyAll })
  const managementGroup = buildManagementGroup({
    room, t, isOwner, canManageRoom,
    onConfig: () => setShowConfigModal(true),
    onAvatar: () => setShowAvatarModal(true),
    onClearAvatar: async () => {
      try { await clearRoomAvatar(room.jid) } catch { setAvatarError(t('rooms.avatarClearFailed')) }
    },
    onMembers: () => setShowMembersModal(true),
    onHats: () => { if (room.supportsHats) setShowHatsModal(true) },
  })
```

- [ ] **Step 3: Replace the inline action blocks**

Replace everything from the `{/* Notification dropdown */}` block through the end of the search block (current lines 179-412) with inline copies (tier-tagged) followed by the kebab. The members toggle block (414-429) stays exactly as-is, immediately after:

```tsx
      {/* Notification settings — inline copy (wide tier) */}
      <div className={inlineClass('wide')}>
        <HeaderSubmenuButton
          ariaLabel={t('rooms.notificationSettings')}
          tooltip={t('rooms.notificationSettings')}
          icon={NotifyIcon}
          active={mode !== 'mentions'}
          group={notifyGroup}
        />
      </div>

      {/* Invite member — inline copy (wide tier) */}
      <div className={inlineClass('wide')}>
        <Tooltip content={t('rooms.inviteMember')} position="bottom">
          <button
            onClick={() => setShowInviteModal(true)}
            className="p-1.5 rounded-lg hover:bg-fluux-hover text-fluux-muted hover:text-fluux-text transition-colors tap-target"
            aria-label={t('rooms.inviteMember')}
          >
            <UserPlus className="size-4" />
          </button>
        </Tooltip>
      </div>

      {/* Room management — inline copy (wide tier, owners/admins only) */}
      {managementGroup && (
        <div className={inlineClass('wide')}>
          <HeaderSubmenuButton
            ariaLabel={t('rooms.manageRoom')}
            tooltip={t('rooms.manageRoom')}
            icon={Settings}
            group={managementGroup}
          />
        </div>
      )}

      {/* Search — inline copy (search tier) */}
      {onSearchInConversation && (
        <div className={inlineClass('search')}>
          <Tooltip content={t('chat.searchInConversation', 'Search in conversation')} position="bottom">
            <button
              onClick={onSearchInConversation}
              className="p-1.5 rounded hover:bg-fluux-hover text-fluux-muted hover:text-fluux-text transition-colors tap-target"
              aria-label={t('chat.searchInConversation', 'Search in conversation')}
            >
              <Search className="size-4" />
            </button>
          </Tooltip>
        </div>
      )}

      {/* Overflow kebab — holds the collapsed copies */}
      <HeaderOverflowKebab
        ariaLabel={t('rooms.roomActions', 'Room actions')}
        entries={[
          ...(onSearchInConversation
            ? [{ kind: 'action', key: 'search', label: t('chat.searchInConversation', 'Search in conversation'), icon: Search, onSelect: onSearchInConversation, kebabClassName: kebabClass('search') } as OverflowEntry]
            : []),
          { kind: 'action', key: 'invite', label: t('rooms.inviteMember'), icon: UserPlus, onSelect: () => setShowInviteModal(true), kebabClassName: kebabClass('wide') },
          { kind: 'submenu', key: 'notify', label: t('rooms.notificationSettings'), icon: NotifyIcon, group: notifyGroup, kebabClassName: kebabClass('wide') },
          ...(managementGroup
            ? [{ kind: 'submenu', key: 'manage', label: t('rooms.manageRoom'), icon: Settings, group: managementGroup, kebabClassName: kebabClass('wide') } as OverflowEntry]
            : []),
        ]}
      />
```

- [ ] **Step 4: Add the `rooms.roomActions` i18n key**

Add `"roomActions": "Room actions"` to the `rooms` namespace in `apps/fluux/src/i18n/locales/en.json` (or the en source file), then translate it into all 33 locales. Find the canonical English file:

```bash
grep -rl '"notificationSettings"' apps/fluux/src/i18n/locales | head
```
Add the sibling key in each locale file with a correct translation (no English placeholders, no em-dash connectors).

- [ ] **Step 5: Typecheck and run the room/header suites**

Run:
```bash
npm run typecheck
cd apps/fluux && npx vitest run src/components/header src/components/RoomHeader 2>&1 | tail -20; cd ../..
```
Expected: typecheck clean; header tests pass. (If no `RoomHeader.test.tsx` exists, only the header dir tests run — that's fine.)

- [ ] **Step 6: Commit**

```bash
git add apps/fluux/src/components/RoomHeader.tsx apps/fluux/src/i18n/locales
git commit -m "feat(rooms): collapse room header actions into overflow kebab"
```

---

### Task 6: Wire ChatHeader (collapse search, move profile/archive into the kebab)

**Files:**
- Modify: `apps/fluux/src/components/ChatHeader.tsx`

**Interfaces:**
- Consumes: `HeaderOverflowKebab`, `OverflowEntry` (Task 2); `inlineClass`, `kebabClass` (Task 1).

Replaces the `OverflowMenu` usage (15, 18, 70-80, 178-186) and the always-visible search (166-176) so search collapses on narrow widths and profile/archive get the touch sheet. The `EncryptionIcon` (155-164 + the function below) stays unchanged — it is a status control, not an overflow action.

- [ ] **Step 1: Swap imports**

Remove the `OverflowMenu` import (line 18) and add:

```tsx
import { HeaderOverflowKebab, type OverflowEntry } from './header/HeaderOverflowKebab'
import { inlineClass, kebabClass } from './header/headerOverflow'
```

- [ ] **Step 2: Mark the header a container**

Change line 83 to add `@container`:

```tsx
    <header className={`@container h-14 ${titleBarClass} px-4 flex items-center border-b border-fluux-bg shadow-sm gap-3`} {...dragRegionProps}>
```

- [ ] **Step 3: Build the kebab entries (replaces the `menuItems` block at 70-80)**

```tsx
  // 1:1 overflow entries: search (collapses on narrow widths) + profile/archive
  // (always in the kebab). Group chats expose none of these.
  const overflowEntries: OverflowEntry[] = []
  if (onSearchInConversation) {
    overflowEntries.push({ kind: 'action', key: 'search', label: t('chat.searchInConversation', 'Search in conversation'), icon: Search, onSelect: onSearchInConversation, kebabClassName: kebabClass('search') })
  }
  if (!isGroupChat) {
    if (onShowProfile) {
      overflowEntries.push({ kind: 'action', key: 'profile', label: t('sidebar.viewProfile'), icon: User, onSelect: onShowProfile, kebabClassName: kebabClass('pinned') })
    }
    if (isArchived && onUnarchive) {
      overflowEntries.push({ kind: 'action', key: 'unarchive', label: t('conversations.unarchive'), icon: ArchiveRestore, onSelect: onUnarchive, kebabClassName: kebabClass('pinned') })
    } else if (!isArchived && onArchive) {
      overflowEntries.push({ kind: 'action', key: 'archive', label: t('conversations.archive'), icon: Archive, onSelect: onArchive, kebabClassName: kebabClass('pinned') })
    }
  }
```

Note: `kebabClass('pinned')` is `'hidden'`, which would hide profile/archive. They must always show in the kebab, so pass **no** `kebabClassName` for them (leave it `undefined`). Correct the three pushes above to omit `kebabClassName` for profile/unarchive/archive; keep it only on `search`.

- [ ] **Step 4: Replace the inline search (166-176) with a tier-tagged copy and the kebab (178-186)**

```tsx
      {/* Search in conversation — inline copy (collapses on narrow widths) */}
      {onSearchInConversation && (
        <div className={inlineClass('search')}>
          <button
            onClick={onSearchInConversation}
            className="p-1.5 rounded hover:bg-fluux-hover text-fluux-muted hover:text-fluux-text transition-colors tap-target"
            aria-label={t('chat.searchInConversation', 'Search in conversation')}
            title={t('chat.searchInConversation', 'Search in conversation')}
          >
            <Search className="size-4" />
          </button>
        </div>
      )}

      {/* Overflow (kebab) menu */}
      <HeaderOverflowKebab ariaLabel={t('contacts.actionsMenu')} entries={overflowEntries} />
```

- [ ] **Step 5: Typecheck and run the chat-header / layout suites**

Run:
```bash
npm run typecheck
cd apps/fluux && npx vitest run src/components/header src/components/ChatLayout 2>&1 | tail -20; cd ../..
```
Expected: clean typecheck; tests pass. If `ChatLayout.test.tsx` mocks `OverflowMenu` or asserts on the old search button, update those expectations to the kebab.

- [ ] **Step 6: Commit**

```bash
git add apps/fluux/src/components/ChatHeader.tsx
git commit -m "feat(chat): collapse 1:1 header search into the overflow kebab"
```

---

### Task 7: Verification pass (demo, both surfaces, both widths)

**Files:** none (verification only).

- [ ] **Step 1: Restart the dev server (required after the Tailwind plugin change)**

Run:
```bash
npm run build:sdk
```
Then start the demo dev server fresh (kill any running Vite first) and open `http://localhost:5173/demo.html`. The container-queries plugin and the new `@container`/`@min-[…]` utilities are only picked up after a restart.

- [ ] **Step 2: Desktop width — nothing collapses**

At a wide window, confirm the room header shows members, search, invite, notifications, and (as owner in demo) management inline, and the kebab trigger is hidden. Take a screenshot for the record.

- [ ] **Step 3: Narrow width — actions collapse, members stays**

Resize narrow (or use the preview resize to ~360px). Confirm: only the members toggle remains inline; the kebab appears; search collapses too. Open the kebab.

- [ ] **Step 4: Hover vs touch surfaces**

With a mouse, the kebab opens an anchored dropdown; the notification/management groups render as sections. Emulate touch (DevTools device toolbar) and reload: the kebab opens a bottom sheet; tapping Notifications or Room management slides to a sub-sheet with a back affordance; selecting an option closes the sheet. Note: headless preview freezes the sheet's `animate-sheet-up`; assert on class names / force a frame via screenshot rather than relying on the animation.

- [ ] **Step 5: 1:1 header**

Open a 1:1 chat. At narrow width search collapses into the kebab; profile + archive are always in the kebab; on touch they open via the bottom sheet.

- [ ] **Step 6: Full gate + commit any test fixups**

Run:
```bash
npm run typecheck
npm test 2>&1 | tail -30
npm run lint 2>&1 | tail -20
```
Expected: typecheck clean, tests green with no stderr, lint clean. Fix any fallout (e.g. a `ChatLayout`/snapshot test referencing the old `OverflowMenu`), then commit:

```bash
git add -A
git commit -m "test(header): update expectations for overflow kebab"
```

---

## Self-Review

- **Spec coverage:** container-query collapse (Tasks 1,5,6) ✓; members pinned (Task 5) ✓; search collapses in 1:1 (Task 6) ✓; touch bottom sheet + sub-sheets (Task 2) ✓; hover dropdown (Task 2) ✓; capability gating via `useHasHover` (Task 2) ✓; owner/admin management gating (Task 3) ✓; DRY option data feeding inline + kebab (Tasks 3,4,5) ✓; Tailwind plugin + restart caveat (Tasks 1,7) ✓; testing approach asserts classes not widths (Task 1) ✓.
- **Type consistency:** `HeaderActionItem`/`HeaderActionGroup` (Task 1) consumed unchanged by Tasks 2-5; `OverflowEntry` defined in Task 2, consumed in Tasks 5-6; `buildNotifyGroup`/`buildManagementGroup`/`notifyModeOf` signatures match between Task 3 definition and Task 5 call sites.
- **Known follow-up flagged in Task 6 Step 3:** profile/archive must NOT carry `kebabClass('pinned')` (which is `'hidden'`); they take no `kebabClassName` so they always show in the kebab. This is called out inline so the implementer doesn't hide them.
- **Tuning note:** the `@min-[440px]` / `@min-[600px]` thresholds are first estimates; Task 7 manual pass is where they get tuned to the real header content.
