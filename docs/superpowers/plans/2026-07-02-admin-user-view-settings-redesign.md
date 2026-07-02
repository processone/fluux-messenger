# Admin User View — Settings-Kit Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restyle `AdminUserView`'s stacked-button "Actions" box into the shared Settings primitive kit (`SettingsSection`/`SettingsGroup`/`SettingsRow`), and replace its static subtitle with a live online/offline indicator.

**Architecture:** `SettingsRow` gains two additive props (`danger`, `disabled`) it currently lacks but this screen needs; `AdminUserView` is restructured to use `SettingsSection` + `SettingsGroup` + `SettingsRow` per action, with row order and behavior (confirm dialogs, handlers) unchanged from today.

**Tech Stack:** TypeScript, React 19, Vitest + Testing Library, react-i18next, Tailwind.

**Spec:** `docs/superpowers/specs/2026-07-02-admin-user-view-settings-redesign-design.md`

## Global Constraints

- No SDK, store, or i18n-key changes (spec: "Testing" section). Reuse existing `admin.users.online` / `admin.users.offline` keys (already used by `UserListItem.tsx:75`).
- `AdminUserView`'s public prop interface (`user`, `onBack`, `onDeleteUser`, `onEndSessions`, `onChangePassword`, `onBanAccount`, `canBanAccount`, `isExecuting`) does not change — `AdminView.tsx` (the parent) needs no changes.
- Action handlers, confirm-dialog copy/variants, and the underlying `client.admin`/`executeCommandForUser` calls are untouched — this is a presentation-only change.
- Row order stays: Change password, End sessions, Ban account (when `canBanAccount`), Delete user.
- Every new/changed `SettingsRow` call site must keep working while `isExecuting` is true: the row must render as a real disabled `<button>` (not silently drop `onClick`), matching today's `disabled={isExecuting}` behavior on the plain buttons it replaces. `SettingsRow` has no `disabled` prop today — Task 1 adds one.
- Typecheck + lint + full `apps/fluux` test suite green before each commit (per repo CLAUDE.md).

---

### Task 1: Add `danger` and `disabled` props to `SettingsRow`

**Files:**
- Modify: `apps/fluux/src/components/ui/SettingsRow.tsx`
- Test: `apps/fluux/src/components/ui/SettingsRow.test.tsx`

**Interfaces:**
- Consumes: nothing new.
- Produces: `SettingsRowProps` gains `danger?: boolean` (label renders `text-fluux-error` instead of `text-fluux-text` when true) and `disabled?: boolean` (row renders as a real disabled `<button>`: `disabled` attribute set, `disabled:opacity-50 disabled:cursor-not-allowed` classes added, `onClick` still passed to the `<button>` element — the native `disabled` attribute is what actually blocks the click, so `onClick` does not need to be conditionally omitted). Both props are additive; every existing call site (which passes neither) is unaffected.

- [ ] **Step 1: Write the failing tests**

Append to `apps/fluux/src/components/ui/SettingsRow.test.tsx` (inside the existing `describe('SettingsRow', ...)` block, after the existing two `it(...)` calls):

```tsx
  it('renders the label in the danger color when danger is true', () => {
    render(<SettingsRow label="Delete account" danger onClick={() => {}} />)
    expect(screen.getByText('Delete account')).toHaveClass('text-fluux-error')
    expect(screen.getByText('Delete account')).not.toHaveClass('text-fluux-text')
  })

  it('renders the label in the default color when danger is omitted', () => {
    render(<SettingsRow label="Change password" onClick={() => {}} />)
    expect(screen.getByText('Change password')).toHaveClass('text-fluux-text')
  })

  it('renders a disabled button and does not fire onClick when disabled is true', () => {
    const onClick = vi.fn()
    render(<SettingsRow label="Delete account" onClick={onClick} disabled />)
    const row = screen.getByRole('button', { name: /delete account/i })
    expect(row).toBeDisabled()
    fireEvent.click(row)
    expect(onClick).not.toHaveBeenCalled()
  })

  it('renders an enabled button when disabled is omitted', () => {
    render(<SettingsRow label="Change password" onClick={() => {}} />)
    expect(screen.getByRole('button', { name: /change password/i })).not.toBeDisabled()
  })
```

- [ ] **Step 2: Run the tests to confirm they fail**

Run: `cd apps/fluux && npx vitest run src/components/ui/SettingsRow.test.tsx`
Expected: FAIL — the first two new tests fail because the label always renders `text-fluux-text` (no `danger` prop exists yet); the third fails because the button is never `disabled` (native click still fires and `onClick` is called); the fourth passes already (document it still runs green as a baseline, but run the whole file together to see the two real failures).

- [ ] **Step 3: Implement the props**

Replace the full contents of `apps/fluux/src/components/ui/SettingsRow.tsx` with:

```tsx
import type { ReactNode } from 'react'

interface SettingsRowProps {
  label: string
  description?: string
  htmlFor?: string
  /**
   * When provided, the whole row becomes a full-width clickable button so the
   * entire surface is the click/touch target. Use ONLY for action rows whose
   * `children` are non-interactive decoration — a button-in-button is invalid
   * HTML, so do NOT combine `onClick` with an interactive child (Toggle/Select).
   */
  onClick?: () => void
  /** Renders the label in the destructive (red) color. Caller is responsible for tinting any icon passed as `children` to match. */
  danger?: boolean
  /** Disables the row: renders a real disabled `<button>` (native `disabled` attribute), dimmed and unclickable. Only meaningful together with `onClick`. */
  disabled?: boolean
  children?: ReactNode
  className?: string
}

export function SettingsRow({
  label,
  description,
  htmlFor,
  onClick,
  danger = false,
  disabled = false,
  children,
  className = '',
}: SettingsRowProps) {
  const inner = (
    <>
      <div className="min-w-0">
        <label htmlFor={htmlFor} className={`block text-sm ${danger ? 'text-fluux-error' : 'text-fluux-text'}`}>
          {label}
        </label>
        {description && <p className="text-xs text-fluux-muted mt-0.5">{description}</p>}
      </div>
      {children != null && <div className="flex-shrink-0">{children}</div>}
    </>
  )

  if (onClick) {
    return (
      <button
        type="button"
        onClick={onClick}
        disabled={disabled}
        className={`w-full text-start flex items-center justify-between gap-4 px-4 py-3 hover:bg-fluux-hover transition-colors cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:bg-transparent ${className}`}
      >
        {inner}
      </button>
    )
  }

  return (
    <div className={`flex items-center justify-between gap-4 px-4 py-3 ${className}`}>
      {inner}
    </div>
  )
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd apps/fluux && npx vitest run src/components/ui/SettingsRow.test.tsx`
Expected: PASS (6 tests: the original 2 plus the 4 new ones)

- [ ] **Step 5: Typecheck**

Run: `cd apps/fluux && npx tsc --noEmit -p tsconfig.json` (or from repo root: `npx tsc --noEmit -p apps/fluux/tsconfig.json`)
Expected: PASS — no other `SettingsRow` call site passes `danger`/`disabled` yet, so this is purely additive.

- [ ] **Step 6: Commit**

```bash
git add apps/fluux/src/components/ui/SettingsRow.tsx apps/fluux/src/components/ui/SettingsRow.test.tsx
git commit -m "feat(ui): add danger and disabled props to SettingsRow"
```

---

### Task 2: Restructure `AdminUserView` to use the Settings kit

**Files:**
- Modify: `apps/fluux/src/components/AdminUserView.tsx`
- Modify: `apps/fluux/src/components/AdminUserView.test.tsx`

**Interfaces:**
- Consumes: `SettingsRow` from Task 1 (`danger?: boolean`, `disabled?: boolean` — both additive, used here). `SettingsSection` (`title: string`, `children: ReactNode`) and `SettingsGroup` (`children: ReactNode`) from `@/components/ui/SettingsSection` and `@/components/ui/SettingsGroup` (unchanged, already exist — see `apps/fluux/src/components/settings-components/profile/AccountSection.tsx` for the exact usage idiom this task mirrors).
- Produces: no change to `AdminUserView`'s exported prop interface. `AdminView.tsx` (the parent, `apps/fluux/src/components/AdminView.tsx:346-357`) is unaffected and needs no edits.

- [ ] **Step 1: Write the failing tests**

Replace the full contents of `apps/fluux/src/components/AdminUserView.test.tsx` with:

```tsx
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { AdminUserView } from './AdminUserView'
import type { AdminUser } from '@fluux/sdk'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, params?: Record<string, string>) => {
      const translations: Record<string, string> = {
        'common.close': 'Close',
        'admin.userView.manageUser': 'Manage user account',
        'admin.userView.actions': 'Actions',
        'admin.users.changePassword': 'Change password',
        'admin.users.endSessions': 'End sessions',
        'admin.users.delete': 'Delete user',
        'admin.users.banAccount': 'Ban account',
        'admin.users.online': 'Online',
        'admin.users.offline': 'Offline',
        'admin.userView.confirmDelete': 'Delete User',
        'admin.userView.confirmDeleteMessage': `Are you sure you want to delete ${params?.jid}? This action cannot be undone.`,
        'admin.userView.confirmEndSessions': 'End Sessions',
        'admin.userView.confirmEndSessionsMessage': `Are you sure you want to end all sessions for ${params?.jid}? The user will be disconnected immediately.`,
        'admin.userView.confirmBan': 'Ban Account',
        'admin.userView.confirmBanMessage': `Are you sure you want to ban ${params?.jid}? This will disconnect the user and prevent them from logging in again.`,
        'common.cancel': 'Cancel',
      }
      return translations[key] || key
    },
  }),
}))

describe('AdminUserView', () => {
  const mockUser: AdminUser = {
    jid: 'testuser@example.com',
    username: 'testuser',
  }

  const mockOnBack = vi.fn()
  const mockOnDeleteUser = vi.fn()
  const mockOnEndSessions = vi.fn()
  const mockOnChangePassword = vi.fn()
  const mockOnBanAccount = vi.fn()

  beforeEach(() => {
    vi.clearAllMocks()
    document.documentElement.setAttribute('data-motion', 'reduced')
  })
  afterEach(() => {
    document.documentElement.removeAttribute('data-motion')
  })

  const renderView = (overrides: Partial<React.ComponentProps<typeof AdminUserView>> = {}) =>
    render(
      <AdminUserView
        user={mockUser}
        onBack={mockOnBack}
        onDeleteUser={mockOnDeleteUser}
        onEndSessions={mockOnEndSessions}
        onChangePassword={mockOnChangePassword}
        onBanAccount={mockOnBanAccount}
        canBanAccount={true}
        isExecuting={false}
        {...overrides}
      />
    )

  describe('status indicator', () => {
    it('shows Online with a dot when isOnline is true', () => {
      renderView({ user: { ...mockUser, isOnline: true } })
      expect(screen.getByText('Online')).toBeInTheDocument()
      expect(screen.queryByText('Manage user account')).not.toBeInTheDocument()
    })

    it('shows Offline with a dot when isOnline is false', () => {
      renderView({ user: { ...mockUser, isOnline: false } })
      expect(screen.getByText('Offline')).toBeInTheDocument()
      expect(screen.queryByText('Manage user account')).not.toBeInTheDocument()
    })

    it('falls back to the generic caption when isOnline is undefined', () => {
      renderView({ user: { ...mockUser, isOnline: undefined } })
      expect(screen.getByText('Manage user account')).toBeInTheDocument()
      expect(screen.queryByText('Online')).not.toBeInTheDocument()
      expect(screen.queryByText('Offline')).not.toBeInTheDocument()
    })
  })

  describe('actions', () => {
    it('renders all four action rows when canBanAccount is true', () => {
      renderView()
      expect(screen.getByRole('button', { name: /change password/i })).toBeInTheDocument()
      expect(screen.getByRole('button', { name: /end sessions/i })).toBeInTheDocument()
      expect(screen.getByRole('button', { name: /ban account/i })).toBeInTheDocument()
      expect(screen.getByRole('button', { name: /delete user/i })).toBeInTheDocument()
    })

    it('omits the ban row when canBanAccount is false', () => {
      renderView({ canBanAccount: false })
      expect(screen.queryByText('Ban account')).not.toBeInTheDocument()
    })

    it('calls onChangePassword directly with the JID, no confirmation', () => {
      renderView()
      fireEvent.click(screen.getByRole('button', { name: /change password/i }))
      expect(mockOnChangePassword).toHaveBeenCalledWith('testuser@example.com')
    })

    it('disables all action rows while isExecuting', () => {
      renderView({ isExecuting: true })
      expect(screen.getByRole('button', { name: /change password/i })).toBeDisabled()
      expect(screen.getByRole('button', { name: /end sessions/i })).toBeDisabled()
      expect(screen.getByRole('button', { name: /ban account/i })).toBeDisabled()
      expect(screen.getByRole('button', { name: /delete user/i })).toBeDisabled()
    })
  })

  describe('end sessions', () => {
    it('shows a confirmation dialog when clicked', () => {
      renderView()
      fireEvent.click(screen.getByRole('button', { name: /end sessions/i }))
      expect(
        screen.getByText(
          'Are you sure you want to end all sessions for testuser@example.com? The user will be disconnected immediately.'
        )
      ).toBeInTheDocument()
    })

    it('calls onEndSessions with the JID when confirmed', () => {
      renderView()
      fireEvent.click(screen.getByRole('button', { name: /end sessions/i }))
      const confirmButton = screen
        .getAllByRole('button')
        .find(btn => btn.textContent === 'End Sessions' && btn.className.includes('bg-orange-500'))
      expect(confirmButton).toBeDefined()
      fireEvent.click(confirmButton!)
      expect(mockOnEndSessions).toHaveBeenCalledWith('testuser@example.com')
    })
  })

  describe('delete user', () => {
    it('shows a confirmation dialog when clicked', () => {
      renderView()
      fireEvent.click(screen.getByRole('button', { name: /delete user/i }))
      expect(
        screen.getByText('Are you sure you want to delete testuser@example.com? This action cannot be undone.')
      ).toBeInTheDocument()
    })

    it('calls onDeleteUser with the JID when confirmed', () => {
      renderView()
      fireEvent.click(screen.getByRole('button', { name: /delete user/i }))
      const confirmButton = screen
        .getAllByRole('button')
        .find(btn => btn.textContent === 'Delete User' && btn.className.includes('bg-red-500'))
      expect(confirmButton).toBeDefined()
      fireEvent.click(confirmButton!)
      expect(mockOnDeleteUser).toHaveBeenCalledWith('testuser@example.com')
    })
  })

  describe('ban account', () => {
    it('shows a confirmation dialog when clicked', () => {
      renderView()
      fireEvent.click(screen.getByRole('button', { name: /ban account/i }))
      expect(
        screen.getByText(
          'Are you sure you want to ban testuser@example.com? This will disconnect the user and prevent them from logging in again.'
        )
      ).toBeInTheDocument()
    })

    it('calls onBanAccount with the JID when confirmed', () => {
      renderView()
      fireEvent.click(screen.getByRole('button', { name: /ban account/i }))
      const confirmButton = screen
        .getAllByRole('button')
        .find(btn => btn.textContent === 'Ban Account' && btn.className.includes('bg-red-500'))
      expect(confirmButton).toBeDefined()
      fireEvent.click(confirmButton!)
      expect(mockOnBanAccount).toHaveBeenCalledWith('testuser@example.com')
    })

    it('closes the dialog on cancel without calling onBanAccount', () => {
      renderView()
      fireEvent.click(screen.getByRole('button', { name: /ban account/i }))
      fireEvent.click(screen.getByText('Cancel'))
      expect(
        screen.queryByText(
          'Are you sure you want to ban testuser@example.com? This will disconnect the user and prevent them from logging in again.'
        )
      ).not.toBeInTheDocument()
      expect(mockOnBanAccount).not.toHaveBeenCalled()
    })
  })
})
```

- [ ] **Step 2: Run the tests to confirm they fail**

Run: `cd apps/fluux && npx vitest run src/components/AdminUserView.test.tsx`
Expected: FAIL — the status-indicator tests fail (no "Online"/"Offline" text exists yet, "Manage user account" always renders), and any test using `getByRole('button', { name: /.../i })` on a label that today lives inside a plain `<button><Icon/><span>Label</span></button>` may already pass by coincidence (the accessible name includes the label text) — but the disabled-row tests fail because the current plain buttons already do support `disabled={isExecuting}` correctly (this part won't fail). Confirm the actual failures are the 3 status-indicator tests before proceeding; if others unexpectedly fail, read the failure message before writing implementation (per TDD: a wrong-reason failure means fix the test, not the code).

- [ ] **Step 3: Implement the restructured component**

Replace the full contents of `apps/fluux/src/components/AdminUserView.tsx` with:

```tsx
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ArrowLeft, Trash2, Power, Key, ShieldOff } from 'lucide-react'
import type { AdminUser } from '@fluux/sdk'
import { Tooltip } from './Tooltip'
import { ConfirmDialog } from './ConfirmDialog'
import { SettingsSection } from './ui/SettingsSection'
import { SettingsGroup } from './ui/SettingsGroup'
import { SettingsRow } from './ui/SettingsRow'

interface AdminUserViewProps {
  user: AdminUser
  onBack: () => void
  onDeleteUser: (jid: string) => void
  onEndSessions: (jid: string) => void
  onChangePassword: (jid: string) => void
  onBanAccount: (jid: string) => void
  /** Discovery-driven: only render the Ban action when the server advertises it. */
  canBanAccount: boolean
  isExecuting: boolean
}

export function AdminUserView({
  user,
  onBack,
  onDeleteUser,
  onEndSessions,
  onChangePassword,
  onBanAccount,
  canBanAccount,
  isExecuting,
}: AdminUserViewProps) {
  const { t } = useTranslation()
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false)
  const [showEndSessionsConfirm, setShowEndSessionsConfirm] = useState(false)
  const [showBanConfirm, setShowBanConfirm] = useState(false)

  const handleDelete = () => {
    onDeleteUser(user.jid)
    setShowDeleteConfirm(false)
  }

  const handleEndSessions = () => {
    onEndSessions(user.jid)
    setShowEndSessionsConfirm(false)
  }

  const handleBan = () => {
    onBanAccount(user.jid)
    setShowBanConfirm(false)
  }

  return (
    <div className="flex-1 flex flex-col min-h-0">
      {/* Header with back button */}
      <div className="flex items-center gap-3 mb-6">
        <Tooltip content={t('common.close')} position="right">
          <button
            onClick={onBack}
            className="p-1.5 text-fluux-muted hover:text-fluux-text hover:bg-fluux-hover
                       rounded-lg transition-colors"
            aria-label={t('common.close')}
          >
            <ArrowLeft className="size-5 rtl-mirror" />
          </button>
        </Tooltip>
        <div className="flex-1 min-w-0">
          <h2 className="text-lg font-semibold font-display text-fluux-text truncate">{user.jid}</h2>
          {user.isOnline === undefined ? (
            <p className="text-sm text-fluux-muted">{t('admin.userView.manageUser')}</p>
          ) : (
            <div className="flex items-center gap-2">
              <span className={`size-2 rounded-full ${user.isOnline ? 'bg-fluux-green' : 'bg-fluux-muted'}`} />
              <span className="text-sm text-fluux-text">
                {t(user.isOnline ? 'admin.users.online' : 'admin.users.offline')}
              </span>
            </div>
          )}
        </div>
      </div>

      {/* Actions section */}
      <div className="flex-1 min-h-0 overflow-y-auto">
        <SettingsSection title={t('admin.userView.actions')}>
          <SettingsGroup>
            <SettingsRow
              label={t('admin.users.changePassword')}
              onClick={() => onChangePassword(user.jid)}
              disabled={isExecuting}
            >
              <Key className="size-4 text-fluux-muted" aria-hidden />
            </SettingsRow>

            <SettingsRow
              label={t('admin.users.endSessions')}
              onClick={() => setShowEndSessionsConfirm(true)}
              disabled={isExecuting}
            >
              <Power className="size-4 text-fluux-muted" aria-hidden />
            </SettingsRow>

            {canBanAccount && (
              <SettingsRow
                label={t('admin.users.banAccount')}
                onClick={() => setShowBanConfirm(true)}
                disabled={isExecuting}
                danger
              >
                <ShieldOff className="size-4 text-fluux-error" aria-hidden />
              </SettingsRow>
            )}

            <SettingsRow
              label={t('admin.users.delete')}
              onClick={() => setShowDeleteConfirm(true)}
              disabled={isExecuting}
              danger
            >
              <Trash2 className="size-4 text-fluux-error" aria-hidden />
            </SettingsRow>
          </SettingsGroup>
        </SettingsSection>
      </div>

      {showDeleteConfirm && (
        <ConfirmDialog
          title={t('admin.userView.confirmDelete')}
          message={t('admin.userView.confirmDeleteMessage', { jid: user.jid })}
          confirmLabel={t('admin.users.delete')}
          onConfirm={handleDelete}
          onCancel={() => setShowDeleteConfirm(false)}
        />
      )}

      {showEndSessionsConfirm && (
        <ConfirmDialog
          title={t('admin.userView.confirmEndSessions')}
          message={t('admin.userView.confirmEndSessionsMessage', { jid: user.jid })}
          confirmLabel={t('admin.users.endSessions')}
          variant="warning"
          onConfirm={handleEndSessions}
          onCancel={() => setShowEndSessionsConfirm(false)}
        />
      )}

      {showBanConfirm && (
        <ConfirmDialog
          title={t('admin.userView.confirmBan')}
          message={t('admin.userView.confirmBanMessage', { jid: user.jid })}
          confirmLabel={t('admin.userView.confirmBan')}
          onConfirm={handleBan}
          onCancel={() => setShowBanConfirm(false)}
        />
      )}
    </div>
  )
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd apps/fluux && npx vitest run src/components/AdminUserView.test.tsx`
Expected: PASS (all tests across all `describe` blocks)

- [ ] **Step 5: Typecheck and lint**

Run: `cd apps/fluux && npx tsc --noEmit -p tsconfig.json && npx eslint src/components/AdminUserView.tsx src/components/AdminUserView.test.tsx`
Expected: PASS, no errors or warnings

- [ ] **Step 6: Run the full app test suite**

Run: `cd apps/fluux && npx vitest run`
Expected: PASS, no stderr (per repo CLAUDE.md pre-commit gate) — this also re-verifies `AdminView.test.tsx` still passes unchanged, confirming the parent needs no edits

- [ ] **Step 7: Commit**

```bash
git add apps/fluux/src/components/AdminUserView.tsx apps/fluux/src/components/AdminUserView.test.tsx
git commit -m "feat(admin): restyle AdminUserView with the Settings primitive kit"
```

---

### Task 3: Manual verification in the demo preview

**Files:** none (verification only)

- [ ] **Step 1: Start the dev server and open demo mode**

Use the preview tooling: start the `dev` server, navigate to `/demo.html?tutorial=false`.

- [ ] **Step 2: Navigate to a user detail view**

Click the Administration icon in the rail → click "Utilisateurs" (Users) → click any user row (e.g. `emma@fluux.chat`).

- [ ] **Step 3: Verify the redesigned screen**

Confirm via screenshot and/or snapshot:
- The subtitle under the JID shows an "En ligne"/"Hors ligne"-style status with a colored dot (not the old static "Gérer le compte utilisateur" caption) — demo users have `isOnline` set.
- Actions render as a bordered group of full-width rows (not the old individually-boxed buttons), each with a leading icon.
- "Bannir le compte" and "Supprimer l'utilisateur" rows render in red.
- Clicking "Bannir le compte" opens the confirm dialog exactly as before; confirming it returns to the user list with no console errors (mirrors the manual check already done for the Ban account feature itself).

- [ ] **Step 4: Check the browser console**

Confirm no new errors/warnings via the console-logs tool (level: error).

- [ ] **Step 5: Stop the preview server**

No commit for this task — it's a verification checkpoint. If any issue is found, fix it in Task 2's files, re-run Task 2's Step 6 (full suite), and amend or add a follow-up commit before proceeding.
