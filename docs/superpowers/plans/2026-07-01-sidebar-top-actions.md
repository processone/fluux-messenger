# Unified Sidebar Header Top-Actions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the three sidebar tabs with header actions (Messages, Rooms, Contacts) one consistent icon grammar — a visible filter toggle, a `＋` create control, and a `⋮` overflow menu — by extracting one small component per tab and reusing the shared `OverflowMenu`.

**Architecture:** Three new presentational components under `apps/fluux/src/components/sidebar-components/` (`MessagesHeaderActions`, `ContactsHeaderActions`, `RoomsHeaderActions`), each taking plain callback props. Management actions use the existing `OverflowMenu`; the Rooms create control is a small split button (`＋` = Quick Chat, `▾` = create-menu) built into `RoomsHeaderActions.tsx`. `Sidebar.tsx` renders the right component per view and no longer contains any hand-rolled dropdown markup or dropdown state.

**Tech Stack:** React + TypeScript, Tailwind, lucide-react icons, react-i18next, Vitest + @testing-library/react (happy-dom env).

## Global Constraints

- **No new i18n keys.** All labels/tooltips reuse existing keys (verified present in `en.json`): `messages.showArchived`, `messages.showActive`, `newMessage.title`, `sidebar.addContact`, `sidebar.blockedUsers`, `common.options`, `rooms.createQuickChat`, `rooms.createRoom`, `rooms.quickChat`, `rooms.permanentRoom`, `rooms.joinRoom`, `rooms.browseRooms`, `rooms.catchUpAll`. If a new key ever becomes necessary, translate it into all 33 locale files and avoid em-dash (`—`/`–`) connectors.
- **No behavior change** to the underlying actions: archive toggles the archived view, Catch-up keeps its `isCatchingUpRooms` guard, Blocked Users navigates to Settings, each modal opens exactly as today.
- **Scope: header toolbar only.** Do not touch panel bodies, the rail icon column, or in-panel search.
- **Verification before commit:** `npx tsc --noEmit -p tsconfig.json` clean AND the affected test files pass with no stderr, run from `apps/fluux/`. SDK is unchanged, so no `build:sdk` is required.
- **Commits:** SSH-signed (user runs `ssh-add ~/.ssh/id_ed25519` first). Never include a Claude footer. Push, if asked, via `gh`/HTTPS.
- **Shared button class:** all three header icon buttons and every `OverflowMenu` trigger use `SIDEBAR_HEADER_ICON_BTN` (added in Task 1) so tap targets and styling are identical.

## File Structure

- **Create** `apps/fluux/src/components/sidebar-components/MessagesHeaderActions.tsx` — archive filter toggle + new-message button.
- **Create** `apps/fluux/src/components/sidebar-components/MessagesHeaderActions.test.tsx`
- **Create** `apps/fluux/src/components/sidebar-components/ContactsHeaderActions.tsx` — add-contact button + `⋮` (Blocked users).
- **Create** `apps/fluux/src/components/sidebar-components/ContactsHeaderActions.test.tsx`
- **Create** `apps/fluux/src/components/sidebar-components/RoomsHeaderActions.tsx` — `RoomsCreateSplitButton` (＋/▾) + `⋮` (Catch up all).
- **Create** `apps/fluux/src/components/sidebar-components/RoomsHeaderActions.test.tsx`
- **Modify** `apps/fluux/src/components/sidebar-components/types.tsx` — add `SIDEBAR_HEADER_ICON_BTN` constant.
- **Modify** `apps/fluux/src/components/sidebar-components/index.ts` — export the three new components and the constant.
- **Modify** `apps/fluux/src/test-setup.ts` — add the i18n keys the new tests assert.
- **Modify** `apps/fluux/src/components/Sidebar.tsx` — render the three components; delete hand-rolled dropdowns, dropdown state/refs, and now-unused imports.

---

### Task 1: Shared button class + MessagesHeaderActions

**Files:**
- Modify: `apps/fluux/src/components/sidebar-components/types.tsx` (after line 84, near the other sidebar constants)
- Modify: `apps/fluux/src/components/sidebar-components/index.ts:12-22` (add `SIDEBAR_HEADER_ICON_BTN` to the types re-export)
- Create: `apps/fluux/src/components/sidebar-components/MessagesHeaderActions.tsx`
- Test: `apps/fluux/src/components/sidebar-components/MessagesHeaderActions.test.tsx`

**Interfaces:**
- Produces: `SIDEBAR_HEADER_ICON_BTN: string` (layout + hover-bg, no text color).
- Produces: `MessagesHeaderActions(props: { showArchived: boolean; onToggleArchived: () => void; onNewMessage: () => void })`.

- [ ] **Step 1: Add the shared constant to `types.tsx`**

Add below `export const SIDEBAR_WIDTH_KEY = 'sidebar-width'` (line 84):

```tsx
/**
 * Shared class for sidebar header icon buttons and OverflowMenu triggers.
 * Layout + hover background only — callers append the text color (muted, or
 * brand when a toggle is active) so there is no conflicting `text-*` class.
 */
export const SIDEBAR_HEADER_ICON_BTN =
  'p-2 rounded-lg hover:bg-fluux-hover transition-colors min-w-[44px] min-h-[44px] flex items-center justify-center'
```

- [ ] **Step 2: Export it from the barrel**

In `index.ts`, add `SIDEBAR_HEADER_ICON_BTN,` to the existing `export { ... } from './types'` block (alongside `SIDEBAR_WIDTH_KEY`).

- [ ] **Step 3: Write the failing test**

Create `MessagesHeaderActions.test.tsx`:

```tsx
import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { MessagesHeaderActions } from './MessagesHeaderActions'

describe('MessagesHeaderActions', () => {
  it('renders the archive toggle inactive and fires onToggleArchived', () => {
    const onToggleArchived = vi.fn()
    render(
      <MessagesHeaderActions showArchived={false} onToggleArchived={onToggleArchived} onNewMessage={vi.fn()} />,
    )
    const toggle = screen.getByRole('button', { name: 'Show archived conversations' })
    expect(toggle).toHaveAttribute('aria-pressed', 'false')
    fireEvent.click(toggle)
    expect(onToggleArchived).toHaveBeenCalledTimes(1)
  })

  it('reflects the active archived state via aria-pressed and label', () => {
    render(<MessagesHeaderActions showArchived onToggleArchived={vi.fn()} onNewMessage={vi.fn()} />)
    const toggle = screen.getByRole('button', { name: 'Show active conversations' })
    expect(toggle).toHaveAttribute('aria-pressed', 'true')
  })

  it('fires onNewMessage when the create button is clicked', () => {
    const onNewMessage = vi.fn()
    render(<MessagesHeaderActions showArchived={false} onToggleArchived={vi.fn()} onNewMessage={onNewMessage} />)
    fireEvent.click(screen.getByRole('button', { name: 'New message' }))
    expect(onNewMessage).toHaveBeenCalledTimes(1)
  })
})
```

- [ ] **Step 4: Run the test to verify it fails**

Run: `npx vitest run src/components/sidebar-components/MessagesHeaderActions.test.tsx`
Expected: FAIL — cannot resolve `./MessagesHeaderActions`.

- [ ] **Step 5: Implement `MessagesHeaderActions.tsx`**

```tsx
import { useTranslation } from 'react-i18next'
import { Archive, Plus } from 'lucide-react'
import { Tooltip } from '../Tooltip'
import { SIDEBAR_HEADER_ICON_BTN } from './types'

interface MessagesHeaderActionsProps {
  /** Whether the archived-conversations filter is active. */
  showArchived: boolean
  /** Toggle the archived filter. */
  onToggleArchived: () => void
  /** Open the New Message modal. */
  onNewMessage: () => void
}

/**
 * Messages tab header actions: an Archive view-filter toggle (visible, reflects
 * active state) followed by a New Message create button.
 */
export function MessagesHeaderActions({ showArchived, onToggleArchived, onNewMessage }: MessagesHeaderActionsProps) {
  const { t } = useTranslation()
  const archiveLabel = showArchived ? t('messages.showActive') : t('messages.showArchived')
  return (
    <div className="flex items-center gap-0.5">
      <Tooltip content={archiveLabel} position="bottom">
        <button
          type="button"
          onClick={onToggleArchived}
          aria-pressed={showArchived}
          aria-label={archiveLabel}
          className={`${SIDEBAR_HEADER_ICON_BTN} ${showArchived ? 'text-fluux-brand' : 'text-fluux-muted hover:text-fluux-text'}`}
        >
          <Archive className="size-5" />
        </button>
      </Tooltip>
      <Tooltip content={t('newMessage.title')} position="bottom">
        <button
          type="button"
          onClick={onNewMessage}
          aria-label={t('newMessage.title')}
          className={`${SIDEBAR_HEADER_ICON_BTN} text-fluux-muted hover:text-fluux-text`}
        >
          <Plus className="size-5" />
        </button>
      </Tooltip>
    </div>
  )
}
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `npx vitest run src/components/sidebar-components/MessagesHeaderActions.test.tsx`
Expected: PASS (3 tests).

- [ ] **Step 7: Commit**

```bash
git add apps/fluux/src/components/sidebar-components/types.tsx \
        apps/fluux/src/components/sidebar-components/index.ts \
        apps/fluux/src/components/sidebar-components/MessagesHeaderActions.tsx \
        apps/fluux/src/components/sidebar-components/MessagesHeaderActions.test.tsx
git commit -m "feat(sidebar): extract MessagesHeaderActions with shared header-icon button class"
```

---

### Task 2: ContactsHeaderActions

**Files:**
- Modify: `apps/fluux/src/test-setup.ts` (i18n `sidebar` + `common` blocks, ~lines 31-41)
- Create: `apps/fluux/src/components/sidebar-components/ContactsHeaderActions.tsx`
- Test: `apps/fluux/src/components/sidebar-components/ContactsHeaderActions.test.tsx`

**Interfaces:**
- Consumes: `SIDEBAR_HEADER_ICON_BTN` (Task 1); `OverflowMenu`, `OverflowMenuItem` from `../OverflowMenu`.
- Produces: `ContactsHeaderActions(props: { onAddContact: () => void; onOpenBlocked: () => void })`.

- [ ] **Step 1: Add the asserted i18n keys to `test-setup.ts`**

In the `common` block (currently `dismiss`/`back`/`forward`) add `options: 'Options',`. In the `sidebar` block (currently `search`/`settings`/`contacts`) add:

```tsx
          addContact: 'Add contact',
          blockedUsers: 'Blocked users',
```

- [ ] **Step 2: Write the failing test**

Create `ContactsHeaderActions.test.tsx`:

```tsx
import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { ContactsHeaderActions } from './ContactsHeaderActions'

describe('ContactsHeaderActions', () => {
  it('fires onAddContact when the add button is clicked', () => {
    const onAddContact = vi.fn()
    render(<ContactsHeaderActions onAddContact={onAddContact} onOpenBlocked={vi.fn()} />)
    fireEvent.click(screen.getByRole('button', { name: 'Add contact' }))
    expect(onAddContact).toHaveBeenCalledTimes(1)
  })

  it('opens the overflow menu and fires onOpenBlocked', () => {
    const onOpenBlocked = vi.fn()
    render(<ContactsHeaderActions onAddContact={vi.fn()} onOpenBlocked={onOpenBlocked} />)
    fireEvent.click(screen.getByRole('button', { name: 'Options' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Blocked users' }))
    expect(onOpenBlocked).toHaveBeenCalledTimes(1)
  })
})
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `npx vitest run src/components/sidebar-components/ContactsHeaderActions.test.tsx`
Expected: FAIL — cannot resolve `./ContactsHeaderActions`.

- [ ] **Step 4: Implement `ContactsHeaderActions.tsx`**

```tsx
import { useTranslation } from 'react-i18next'
import { Plus, Ban } from 'lucide-react'
import { Tooltip } from '../Tooltip'
import { OverflowMenu, type OverflowMenuItem } from '../OverflowMenu'
import { SIDEBAR_HEADER_ICON_BTN } from './types'

interface ContactsHeaderActionsProps {
  /** Open the Add Contact modal. */
  onAddContact: () => void
  /** Navigate to the Blocked Users settings category. */
  onOpenBlocked: () => void
}

/**
 * Contacts tab header actions: an Add Contact create button followed by a `⋮`
 * overflow menu holding the Blocked Users management action.
 */
export function ContactsHeaderActions({ onAddContact, onOpenBlocked }: ContactsHeaderActionsProps) {
  const { t } = useTranslation()
  const items: OverflowMenuItem[] = [
    { key: 'blocked', label: t('sidebar.blockedUsers'), icon: Ban, onClick: onOpenBlocked },
  ]
  return (
    <div className="flex items-center gap-0.5">
      <Tooltip content={t('sidebar.addContact')} position="bottom">
        <button
          type="button"
          onClick={onAddContact}
          aria-label={t('sidebar.addContact')}
          className={`${SIDEBAR_HEADER_ICON_BTN} text-fluux-muted hover:text-fluux-text`}
        >
          <Plus className="size-5" />
        </button>
      </Tooltip>
      <OverflowMenu
        ariaLabel={t('common.options')}
        items={items}
        buttonClassName={`${SIDEBAR_HEADER_ICON_BTN} text-fluux-muted hover:text-fluux-text`}
      />
    </div>
  )
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx vitest run src/components/sidebar-components/ContactsHeaderActions.test.tsx`
Expected: PASS (2 tests).

- [ ] **Step 6: Commit**

```bash
git add apps/fluux/src/components/sidebar-components/ContactsHeaderActions.tsx \
        apps/fluux/src/components/sidebar-components/ContactsHeaderActions.test.tsx \
        apps/fluux/src/test-setup.ts
git commit -m "feat(sidebar): extract ContactsHeaderActions (add-contact + blocked-users overflow)"
```

---

### Task 3: RoomsHeaderActions + RoomsCreateSplitButton

**Files:**
- Modify: `apps/fluux/src/test-setup.ts` (i18n `rooms` block, ~lines 55-58)
- Create: `apps/fluux/src/components/sidebar-components/RoomsHeaderActions.tsx`
- Test: `apps/fluux/src/components/sidebar-components/RoomsHeaderActions.test.tsx`

**Interfaces:**
- Consumes: `SIDEBAR_HEADER_ICON_BTN` (Task 1); `OverflowMenu`, `OverflowMenuItem`; `useClickOutside` from `@/hooks`.
- Produces: `RoomsHeaderActions(props: { onQuickChat: () => void; onPermanentRoom: () => void; onJoinRoom: () => void; onBrowseRooms: () => void; onCatchUpAll: () => void; isCatchingUp: boolean })`.

- [ ] **Step 1: Add the asserted i18n keys to `test-setup.ts`**

Extend the `rooms` block (currently `backToRooms`/`invitationsHeading`) with:

```tsx
          createQuickChat: 'Create Quick Chat',
          createRoom: 'Create Room',
          quickChat: 'Quick Chat',
          permanentRoom: 'Permanent Room',
          joinRoom: 'Join room',
          browseRooms: 'Browse Rooms',
          catchUpAll: 'Catch up all rooms',
```

- [ ] **Step 2: Write the failing test**

Create `RoomsHeaderActions.test.tsx`:

```tsx
import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { RoomsHeaderActions } from './RoomsHeaderActions'

const baseProps = () => ({
  onQuickChat: vi.fn(),
  onPermanentRoom: vi.fn(),
  onJoinRoom: vi.fn(),
  onBrowseRooms: vi.fn(),
  onCatchUpAll: vi.fn(),
  isCatchingUp: false,
})

describe('RoomsHeaderActions', () => {
  it('fires onQuickChat directly from the + button', () => {
    const props = baseProps()
    render(<RoomsHeaderActions {...props} />)
    fireEvent.click(screen.getByRole('button', { name: 'Create Quick Chat' }))
    expect(props.onQuickChat).toHaveBeenCalledTimes(1)
  })

  it('opens the create-menu from the chevron with all four paths', () => {
    render(<RoomsHeaderActions {...baseProps()} />)
    fireEvent.click(screen.getByRole('button', { name: 'Create Room' }))
    expect(screen.getByRole('menuitem', { name: 'Quick Chat' })).toBeInTheDocument()
    expect(screen.getByRole('menuitem', { name: 'Permanent Room' })).toBeInTheDocument()
    expect(screen.getByRole('menuitem', { name: 'Join room' })).toBeInTheDocument()
    expect(screen.getByRole('menuitem', { name: 'Browse Rooms' })).toBeInTheDocument()
  })

  it('fires onPermanentRoom from the create-menu and closes it', () => {
    const props = baseProps()
    render(<RoomsHeaderActions {...props} />)
    fireEvent.click(screen.getByRole('button', { name: 'Create Room' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Permanent Room' }))
    expect(props.onPermanentRoom).toHaveBeenCalledTimes(1)
    expect(screen.queryByRole('menuitem', { name: 'Permanent Room' })).not.toBeInTheDocument()
  })

  it('exposes Catch up all in the overflow menu and fires it', () => {
    const props = baseProps()
    render(<RoomsHeaderActions {...props} />)
    fireEvent.click(screen.getByRole('button', { name: 'Options' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Catch up all rooms' }))
    expect(props.onCatchUpAll).toHaveBeenCalledTimes(1)
  })

  it('disables Catch up all while catching up', () => {
    render(<RoomsHeaderActions {...baseProps()} isCatchingUp />)
    fireEvent.click(screen.getByRole('button', { name: 'Options' }))
    const item = screen.getByRole('menuitem', { name: 'Catch up all rooms' })
    expect(item).toBeDisabled()
  })
})
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `npx vitest run src/components/sidebar-components/RoomsHeaderActions.test.tsx`
Expected: FAIL — cannot resolve `./RoomsHeaderActions`.

- [ ] **Step 4: Implement `RoomsHeaderActions.tsx`**

```tsx
import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Plus, ChevronDown, Zap, Hash, LogIn, Search, RefreshCw } from 'lucide-react'
import { useClickOutside } from '@/hooks'
import { Tooltip } from '../Tooltip'
import { OverflowMenu, type OverflowMenuItem } from '../OverflowMenu'
import { SIDEBAR_HEADER_ICON_BTN } from './types'

interface RoomsHeaderActionsProps {
  /** Create a Quick Chat (the + primary action). */
  onQuickChat: () => void
  /** Open the Create (permanent) Room modal. */
  onPermanentRoom: () => void
  /** Open the Join Room modal. */
  onJoinRoom: () => void
  /** Open the Browse Rooms modal. */
  onBrowseRooms: () => void
  /** Force a MAM catch-up across all rooms. */
  onCatchUpAll: () => void
  /** Whether a catch-up is currently running (disables the item). */
  isCatchingUp: boolean
}

/**
 * Rooms tab header actions: a split create button (`+` = Quick Chat, `▾` opens a
 * create-menu of all four create/join paths) plus a `⋮` overflow menu for the
 * Catch-up maintenance action.
 */
export function RoomsHeaderActions({
  onQuickChat,
  onPermanentRoom,
  onJoinRoom,
  onBrowseRooms,
  onCatchUpAll,
  isCatchingUp,
}: RoomsHeaderActionsProps) {
  const { t } = useTranslation()
  const overflowItems: OverflowMenuItem[] = [
    { key: 'catchup', label: t('rooms.catchUpAll'), icon: RefreshCw, onClick: onCatchUpAll, disabled: isCatchingUp },
  ]
  return (
    <div className="flex items-center gap-0.5">
      <RoomsCreateSplitButton
        onQuickChat={onQuickChat}
        onPermanentRoom={onPermanentRoom}
        onJoinRoom={onJoinRoom}
        onBrowseRooms={onBrowseRooms}
      />
      <OverflowMenu
        ariaLabel={t('common.options')}
        items={overflowItems}
        buttonClassName={`${SIDEBAR_HEADER_ICON_BTN} text-fluux-muted hover:text-fluux-text`}
      />
    </div>
  )
}

interface RoomsCreateSplitButtonProps {
  onQuickChat: () => void
  onPermanentRoom: () => void
  onJoinRoom: () => void
  onBrowseRooms: () => void
}

/**
 * `+` fires Quick Chat directly; the adjacent `▾` opens a create-menu listing
 * all four create/join paths (Quick Chat included, so the shortcut is
 * discoverable). Menu dismissal (click-outside / Escape) mirrors OverflowMenu.
 */
function RoomsCreateSplitButton({ onQuickChat, onPermanentRoom, onJoinRoom, onBrowseRooms }: RoomsCreateSplitButtonProps) {
  const { t } = useTranslation()
  const [isOpen, setIsOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  useClickOutside(ref, () => setIsOpen(false), isOpen)

  useEffect(() => {
    if (!isOpen) return
    const onEsc = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setIsOpen(false)
    }
    document.addEventListener('keydown', onEsc)
    return () => document.removeEventListener('keydown', onEsc)
  }, [isOpen])

  const menuItems = [
    { key: 'quickChat', label: t('rooms.quickChat'), icon: Zap, iconClass: 'text-amber-500', onClick: onQuickChat },
    { key: 'permanentRoom', label: t('rooms.permanentRoom'), icon: Hash, iconClass: '', onClick: onPermanentRoom },
    { key: 'joinRoom', label: t('rooms.joinRoom'), icon: LogIn, iconClass: '', onClick: onJoinRoom },
    { key: 'browseRooms', label: t('rooms.browseRooms'), icon: Search, iconClass: '', onClick: onBrowseRooms },
  ]

  return (
    <div className="relative flex items-center" ref={ref}>
      <Tooltip content={t('rooms.createQuickChat')} position="bottom">
        <button
          type="button"
          onClick={onQuickChat}
          aria-label={t('rooms.createQuickChat')}
          className={`${SIDEBAR_HEADER_ICON_BTN} text-fluux-muted hover:text-fluux-text`}
        >
          <Plus className="size-5" />
        </button>
      </Tooltip>
      <Tooltip content={t('rooms.createRoom')} position="bottom">
        <button
          type="button"
          onClick={() => setIsOpen((open) => !open)}
          aria-label={t('rooms.createRoom')}
          aria-haspopup="menu"
          aria-expanded={isOpen}
          className="-ms-1 p-2 rounded-lg hover:bg-fluux-hover transition-colors text-fluux-muted hover:text-fluux-text flex items-center"
        >
          <ChevronDown className="size-4" />
        </button>
      </Tooltip>
      {isOpen && (
        <div role="menu" className="absolute end-0 top-full mt-1 w-56 fluux-popover rounded-lg py-1 z-50">
          {menuItems.map(({ key, label, icon: Icon, iconClass, onClick }) => (
            <button
              key={key}
              role="menuitem"
              type="button"
              onClick={() => {
                setIsOpen(false)
                onClick()
              }}
              className="w-full flex items-center gap-2 px-3 py-2.5 text-start text-sm text-fluux-text hover:bg-fluux-active transition-colors"
            >
              <Icon className={`size-4 flex-shrink-0 ${iconClass}`} />
              <span>{label}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx vitest run src/components/sidebar-components/RoomsHeaderActions.test.tsx`
Expected: PASS (5 tests).

- [ ] **Step 6: Commit**

```bash
git add apps/fluux/src/components/sidebar-components/RoomsHeaderActions.tsx \
        apps/fluux/src/components/sidebar-components/RoomsHeaderActions.test.tsx \
        apps/fluux/src/test-setup.ts
git commit -m "feat(sidebar): extract RoomsHeaderActions with split create button + catch-up overflow"
```

---

### Task 4: Wire the components into Sidebar.tsx and remove the old dropdowns

**Files:**
- Modify: `apps/fluux/src/components/sidebar-components/index.ts` (export the three new components)
- Modify: `apps/fluux/src/components/Sidebar.tsx` (imports; delete dropdown state/refs/click-outside; replace the header action blocks)

**Interfaces:**
- Consumes: `MessagesHeaderActions`, `ContactsHeaderActions`, `RoomsHeaderActions` (Tasks 1-3). Note the Contacts view key is `'contacts'` (renamed from `'directory'`).

- [ ] **Step 1: Export the new components from the barrel**

In `index.ts`, add after the `UserMenu` export line:

```tsx
export { MessagesHeaderActions } from './MessagesHeaderActions'
export { ContactsHeaderActions } from './ContactsHeaderActions'
export { RoomsHeaderActions } from './RoomsHeaderActions'
```

- [ ] **Step 2: Import the components in `Sidebar.tsx`**

In the `from './sidebar-components'` import block (currently ending with `UserMenu,`), add:

```tsx
  MessagesHeaderActions,
  ContactsHeaderActions,
  RoomsHeaderActions,
```

- [ ] **Step 3: Delete the dropdown state and refs**

Remove these lines from the component body (currently 141-145):

```tsx
  const [showRoomDropdown, setShowRoomDropdown] = useState(false)
  ...
  const roomDropdownRef = useRef<HTMLDivElement>(null)
  const [showContactDropdown, setShowContactDropdown] = useState(false)
  const contactDropdownRef = useRef<HTMLDivElement>(null)
```

Keep `const [isCatchingUpRooms, setIsCatchingUpRooms] = useState(false)` (line 142) — it is still used by the catch-up handler.

- [ ] **Step 4: Delete the click-outside wiring**

Remove the block (currently 212-216):

```tsx
  // Close dropdowns when clicking outside
  const closeRoomDropdown = () => setShowRoomDropdown(false)
  useClickOutside(roomDropdownRef, closeRoomDropdown, showRoomDropdown)
  const closeContactDropdown = () => setShowContactDropdown(false)
  useClickOutside(contactDropdownRef, closeContactDropdown, showContactDropdown)
```

- [ ] **Step 5: Replace the three header action blocks**

Replace everything from `{sidebarView === 'directory' && (` through the closing of the `{sidebarView === 'rooms' && ( ... )}` block (currently lines 316-433, i.e. the entire span between the closing `</h1>` and the header `</div>`) with:

```tsx
          {sidebarView === 'messages' && (
            <MessagesHeaderActions
              showArchived={showArchived}
              onToggleArchived={() => setShowArchived((v) => !v)}
              onNewMessage={() => modalOpen('newMessage')}
            />
          )}
          {sidebarView === 'rooms' && (
            <RoomsHeaderActions
              onQuickChat={() => modalOpen('quickChat')}
              onPermanentRoom={() => setShowCreateRoom(true)}
              onJoinRoom={() => setShowJoinRoom(true)}
              onBrowseRooms={() => setShowBrowseRooms(true)}
              onCatchUpAll={() => {
                if (isCatchingUpRooms) return
                setIsCatchingUpRooms(true)
                void client.mam.forceCatchUpAllRooms().finally(() => setIsCatchingUpRooms(false))
              }}
              isCatchingUp={isCatchingUpRooms}
            />
          )}
          {sidebarView === 'contacts' && (
            <ContactsHeaderActions
              onAddContact={() => modalOpen('addContact')}
              onOpenBlocked={() => navigateToSettings('blocked')}
            />
          )}
```

> Note: the view key is `'contacts'` (the `'directory'` → `'contacts'` rename already landed). The header `<h1>` block and the content-area `sidebarView === 'contacts' ? <ContactList .../>` switch are unchanged.

- [ ] **Step 6: Remove now-unused imports**

In `Sidebar.tsx`:
- From `'@/hooks'` (line 4): remove `useClickOutside`, keeping `{ useWindowDrag, useRouteSync }`.
- From `'lucide-react'` (lines 23-39): remove `ChevronDown`, `Plus`, `Archive`, `Zap`, `LogIn`, `Ban`, `UserPlus`, `RefreshCw`. Keep `MessageCircle`, `Hash`, `Settings`, `Users`, `Server`, `Search`, `CircleArrowUp` (all still used by the icon rail).

- [ ] **Step 7: Typecheck to confirm nothing is unused or missing**

Run from `apps/fluux/`: `npx tsc --noEmit -p tsconfig.json`
Expected: exit 0, no output. (If it flags a still-used import you removed, or an unused one you kept, adjust the import list accordingly.)

- [ ] **Step 8: Run the sidebar-affected tests**

Run from `apps/fluux/`:

```bash
npx vitest run src/components/sidebar-components src/components/ChatLayout.test.tsx
```

Expected: all pass, no stderr.

- [ ] **Step 9: Commit**

```bash
git add apps/fluux/src/components/Sidebar.tsx apps/fluux/src/components/sidebar-components/index.ts
git commit -m "refactor(sidebar): render extracted HeaderActions; remove hand-rolled header dropdowns"
```

---

### Task 5: Full verification (typecheck, tests, live demo)

**Files:** none (verification only).

- [ ] **Step 1: Typecheck the app**

Run from `apps/fluux/`: `npx tsc --noEmit -p tsconfig.json`
Expected: exit 0, no output.

- [ ] **Step 2: Run the full app test suite**

Run from `apps/fluux/`: `npx vitest run`
Expected: all pass, no stderr. (Watch for any test that rendered the old `Sidebar` dropdowns and asserted their internals — none are expected, but fix any fallout here.)

- [ ] **Step 3: Visual check in demo mode**

Start the dev server (`npm run dev` from repo root) and open `http://localhost:5173/demo.html?tutorial=false`. Verify, per `<verification_workflow>` using the preview tools:
- **Messages:** header shows the Archive toggle (active state flips on click, title switches to "Archived") and a `＋` that opens New Message.
- **Rooms:** `＋` opens Quick Chat directly; the `▾` opens a menu with Quick Chat / Permanent Room / Join Room / Browse Rooms; the `⋮` opens Catch up all.
- **Contacts:** `＋` opens Add Contact; the `⋮` opens Blocked users (navigates to Settings ▸ Blocked).
- Capture a screenshot of each of the three headers as proof.

- [ ] **Step 4: Final commit (if any verification fixups were needed)**

```bash
git add -A
git commit -m "test(sidebar): verification fixups for unified header top-actions"
```

(Skip if Steps 1-3 required no changes.)

---

## Self-Review

**Spec coverage:**
- Three-role grammar (filter / create / overflow) → Tasks 1-3 (each component), wired in Task 4.
- Messages unchanged-but-reconciled → Task 1.
- Rooms split button (`＋`=Quick Chat, `▾`=create-menu) + Catch-up in `⋮` → Task 3.
- Contacts `＋` Add contact + `⋮` Blocked users, dropping the redundant `Users` trigger icon → Task 2.
- Reuse `OverflowMenu`, remove the three hand-rolled dropdowns from `Sidebar.tsx` → Tasks 2-4.
- Component extraction under `sidebar-components/` → Tasks 1-3, exported in Task 4.
- Tooltips reuse existing keys, no new i18n → Global Constraints + confirmed values in Tasks 1-3.
- Behavior parity (archive toggle, catch-up guard, blocked navigation) → Task 4 Step 5 handlers.
- Out-of-scope items (panel bodies, rail, in-panel search) → untouched by any task.

**Placeholder scan:** No TBD/TODO; every code and test step contains complete code; every command has an expected result.

**Type consistency:** `SIDEBAR_HEADER_ICON_BTN` (string) defined in Task 1, consumed in Tasks 1-3. Component prop shapes in the Interfaces blocks match the JSX passed in Task 4 Step 5 (`showArchived`/`onToggleArchived`/`onNewMessage`; `onAddContact`/`onOpenBlocked`; `onQuickChat`/`onPermanentRoom`/`onJoinRoom`/`onBrowseRooms`/`onCatchUpAll`/`isCatchingUp`). `OverflowMenuItem` fields (`key`/`label`/`icon`/`onClick`/`disabled`) match the existing component. View key `'contacts'` matches the post-rename codebase.
