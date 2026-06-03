# App View Selector Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace `App.tsx`'s login/chat `if`-cascade with a single pure, status-driven `selectAppView()` + `useAppView()` hook, and surface localized terminal-error reasons on the login screen.

**Architecture:** A pure `selectAppView()` decides the top-level view from the reactive connection `status` plus two status-history latches (`hasShownApp`, `restoreFinished`) and a mount-time `canAutoReconnect`. `useAppView()` wires the reactive inputs; `App.tsx` switches on the result. `LoginScreen` maps SDK terminal-error strings to localized i18n messages.

**Tech Stack:** React, Zustand via `@fluux/sdk` hooks, Vitest + `@testing-library/react`, i18next.

**Spec:** [docs/superpowers/specs/2026-06-03-app-view-selector-design.md](../specs/2026-06-03-app-view-selector-design.md)

**Run tests from:** `apps/fluux` (e.g. `cd apps/fluux && npx vitest run <path>`).

---

### Task 1: Pure `selectAppView`

**Files:**
- Create: `apps/fluux/src/utils/selectAppView.ts`
- Test: `apps/fluux/src/utils/selectAppView.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// apps/fluux/src/utils/selectAppView.test.ts
import { describe, it, expect } from 'vitest'
import { selectAppView, type AppView, type AppViewInput } from './selectAppView'

const base: AppViewInput = {
  status: 'disconnected',
  canAutoReconnect: false,
  hasShownApp: false,
  restoreFinished: false,
  tab: { blocked: false, takenOver: false },
  isTauri: true,
}

describe('selectAppView', () => {
  const cases: Array<[string, Partial<AppViewInput>, AppView['kind']]> = [
    ['cold start, no creds', { status: 'disconnected' }, 'login'],
    ['fresh login submitting', { status: 'connecting' }, 'login'],
    ['fresh login fails', { status: 'error' }, 'login'],
    ['cold-load creds, pre-connect', { status: 'disconnected', canAutoReconnect: true }, 'restoring'],
    ['cold-load creds, connecting', { status: 'connecting', canAutoReconnect: true }, 'restoring'],
    ['cold-load creds, reconnecting', { status: 'reconnecting', canAutoReconnect: true }, 'restoring'],
    ['cold-load auth failure (fast-fail)', { status: 'error', canAutoReconnect: true }, 'login'],
    ['online', { status: 'online' }, 'app'],
    ['network drop after shown', { status: 'reconnecting', hasShownApp: true }, 'app'],
    ['connecting after shown', { status: 'connecting', hasShownApp: true }, 'app'],
    ['logout after online', { status: 'disconnected', canAutoReconnect: true, restoreFinished: true }, 'login'],
    ['re-login connecting (no reload)', { status: 'connecting', canAutoReconnect: true, restoreFinished: true }, 'login'],
    ['terminal error after online', { status: 'error', canAutoReconnect: true, restoreFinished: true }, 'login'],
    ['tab blocked (web)', { status: 'disconnected', isTauri: false, tab: { blocked: true, takenOver: false } }, 'tabBlocked'],
    ['tab taken over (web) beats online', { status: 'online', isTauri: false, tab: { blocked: false, takenOver: true } }, 'tabBlocked'],
    ['tab flags ignored on tauri', { status: 'online', isTauri: true, tab: { blocked: true, takenOver: true } }, 'app'],
  ]

  it.each(cases)('%s → %s', (_name, override, expected) => {
    expect(selectAppView({ ...base, ...override }).kind).toBe(expected)
  })

  it('passes takenOver through on tabBlocked', () => {
    const v = selectAppView({ ...base, isTauri: false, tab: { blocked: false, takenOver: true } })
    expect(v).toEqual({ kind: 'tabBlocked', takenOver: true })
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/fluux && npx vitest run src/utils/selectAppView.test.ts`
Expected: FAIL — cannot resolve `./selectAppView`.

- [ ] **Step 3: Write minimal implementation**

```ts
// apps/fluux/src/utils/selectAppView.ts
import type { ConnectionStatus } from '@fluux/sdk'

export type AppView =
  | { kind: 'restoring' }
  | { kind: 'tabBlocked'; takenOver: boolean }
  | { kind: 'login' }
  | { kind: 'app' }

export interface AppViewInput {
  status: ConnectionStatus
  canAutoReconnect: boolean
  hasShownApp: boolean
  restoreFinished: boolean
  tab: { blocked: boolean; takenOver: boolean }
  isTauri: boolean
}

/**
 * Decide the top-level app surface from the connection lifecycle plus two
 * status-history latches. Pure — see the design spec for the precedence
 * rationale (docs/superpowers/specs/2026-06-03-app-view-selector-design.md).
 */
export function selectAppView(s: AppViewInput): AppView {
  // 1. Terminal error → login (fast-fails even during cold-load; LoginScreen shows the reason)
  if (s.status === 'error') return { kind: 'login' }
  // 2. Web tab coordination — another tab owns the connection
  if (!s.isTauri && (s.tab.blocked || s.tab.takenOver)) {
    return { kind: 'tabBlocked', takenOver: s.tab.takenOver }
  }
  // 3. Connected
  if (s.status === 'online') return { kind: 'app' }
  // 4. Transient recovery after the app has been shown — keep the user's place
  if (s.hasShownApp && (s.status === 'connecting' || s.status === 'reconnecting')) {
    return { kind: 'app' }
  }
  // 5. Initial cold-load auto-reconnect, before it has ever resolved — splash
  if (s.canAutoReconnect && !s.restoreFinished) return { kind: 'restoring' }
  // 6. Fresh start / logout / disconnect / re-login
  return { kind: 'login' }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/fluux && npx vitest run src/utils/selectAppView.test.ts`
Expected: PASS (17 cases).

- [ ] **Step 5: Commit**

```bash
git add apps/fluux/src/utils/selectAppView.ts apps/fluux/src/utils/selectAppView.test.ts
git commit -m "feat(app): add pure selectAppView routing selector"
```

---

### Task 2: `computeCanAutoReconnect` helper

**Files:**
- Create: `apps/fluux/src/utils/canAutoReconnect.ts`
- Test: `apps/fluux/src/utils/canAutoReconnect.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// apps/fluux/src/utils/canAutoReconnect.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest'

const { mockGetSession, mockHasFastToken } = vi.hoisted(() => ({
  mockGetSession: vi.fn(),
  mockHasFastToken: vi.fn(),
}))

vi.mock('@fluux/sdk', () => ({ hasFastToken: (...a: unknown[]) => mockHasFastToken(...a) }))
vi.mock('@/hooks/useSessionPersistence', () => ({ getSession: () => mockGetSession() }))

import { computeCanAutoReconnect } from './canAutoReconnect'

describe('computeCanAutoReconnect', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    localStorage.clear()
    mockGetSession.mockReturnValue(null)
    mockHasFastToken.mockReturnValue(false)
  })

  it('true when a stored session exists', () => {
    mockGetSession.mockReturnValue({ jid: 'a@b', password: 'x', server: 'b' })
    expect(computeCanAutoReconnect()).toBe(true)
  })

  it('true when rememberMe + saved JID/server + FAST token', () => {
    localStorage.setItem('xmpp-remember-me', 'true')
    localStorage.setItem('xmpp-last-jid', 'a@b')
    localStorage.setItem('xmpp-last-server', 'b')
    mockHasFastToken.mockReturnValue(true)
    expect(computeCanAutoReconnect()).toBe(true)
  })

  it('derives server from JID domain when saved server is empty', () => {
    localStorage.setItem('xmpp-remember-me', 'true')
    localStorage.setItem('xmpp-last-jid', 'a@b')
    mockHasFastToken.mockReturnValue(true)
    expect(computeCanAutoReconnect()).toBe(true)
  })

  it('false when no session and no FAST token', () => {
    localStorage.setItem('xmpp-remember-me', 'true')
    localStorage.setItem('xmpp-last-jid', 'a@b')
    mockHasFastToken.mockReturnValue(false)
    expect(computeCanAutoReconnect()).toBe(false)
  })

  it('false when rememberMe not set even with a FAST token', () => {
    localStorage.setItem('xmpp-last-jid', 'a@b')
    mockHasFastToken.mockReturnValue(true)
    expect(computeCanAutoReconnect()).toBe(false)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/fluux && npx vitest run src/utils/canAutoReconnect.test.ts`
Expected: FAIL — cannot resolve `./canAutoReconnect`.

- [ ] **Step 3: Write minimal implementation**

```ts
// apps/fluux/src/utils/canAutoReconnect.ts
import { hasFastToken } from '@fluux/sdk'
import { getSession } from '@/hooks/useSessionPersistence'

/**
 * Whether the app has credentials to auto-reconnect on cold load: a stored
 * session, or a remembered FAST-token login. A mount-time fact (see the design
 * spec). Mirrors the previous `isAutoReconnecting` init in App.tsx.
 */
export function computeCanAutoReconnect(): boolean {
  if (getSession() !== null) return true
  const rememberMe = localStorage.getItem('xmpp-remember-me') === 'true'
  const savedJid = localStorage.getItem('xmpp-last-jid')
  const savedServer = localStorage.getItem('xmpp-last-server')
  const effectiveServer = savedServer || (savedJid ? savedJid.split('@')[1] : null)
  return !!(rememberMe && savedJid && effectiveServer && hasFastToken(savedJid))
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/fluux && npx vitest run src/utils/canAutoReconnect.test.ts`
Expected: PASS (5 cases).

- [ ] **Step 5: Commit**

```bash
git add apps/fluux/src/utils/canAutoReconnect.ts apps/fluux/src/utils/canAutoReconnect.test.ts
git commit -m "feat(app): extract computeCanAutoReconnect mount-time helper"
```

---

### Task 3: `useAppView` hook (two latches)

**Files:**
- Create: `apps/fluux/src/hooks/useAppView.ts`
- Test: `apps/fluux/src/hooks/useAppView.test.tsx`

- [ ] **Step 1: Write the failing test**

```tsx
// apps/fluux/src/hooks/useAppView.test.tsx
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook } from '@testing-library/react'

const { mockUseConnectionStatus, mockCanAutoReconnect, mockIsTauri } = vi.hoisted(() => ({
  mockUseConnectionStatus: vi.fn(),
  mockCanAutoReconnect: vi.fn(),
  mockIsTauri: vi.fn(),
}))

vi.mock('@fluux/sdk', () => ({ useConnectionStatus: () => mockUseConnectionStatus() }))
vi.mock('@/utils/canAutoReconnect', () => ({ computeCanAutoReconnect: () => mockCanAutoReconnect() }))
vi.mock('@/utils/tauri', () => ({ isTauri: () => mockIsTauri() }))

import { useAppView } from './useAppView'

const noTab = { blocked: false, takenOver: false }

describe('useAppView', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockIsTauri.mockReturnValue(true)
    mockCanAutoReconnect.mockReturnValue(false)
    mockUseConnectionStatus.mockReturnValue({ status: 'disconnected' })
  })

  it('shows restoring on cold-load with creds, then app once online', () => {
    mockCanAutoReconnect.mockReturnValue(true)
    mockUseConnectionStatus.mockReturnValue({ status: 'connecting' })
    const { result, rerender } = renderHook(() => useAppView(noTab))
    expect(result.current.kind).toBe('restoring')

    mockUseConnectionStatus.mockReturnValue({ status: 'online' })
    rerender()
    expect(result.current.kind).toBe('app')
  })

  it('keeps app during an in-session reconnect, returns to login on logout', () => {
    mockCanAutoReconnect.mockReturnValue(true)
    mockUseConnectionStatus.mockReturnValue({ status: 'online' })
    const { result, rerender } = renderHook(() => useAppView(noTab))
    expect(result.current.kind).toBe('app')

    mockUseConnectionStatus.mockReturnValue({ status: 'reconnecting' })
    rerender()
    expect(result.current.kind).toBe('app') // hasShownApp latched

    mockUseConnectionStatus.mockReturnValue({ status: 'disconnected' })
    rerender()
    expect(result.current.kind).toBe('login') // logout
  })

  it('does not re-show the splash on re-login connecting after a prior session', () => {
    mockCanAutoReconnect.mockReturnValue(true) // stale: app was loaded with creds
    mockUseConnectionStatus.mockReturnValue({ status: 'online' })
    const { result, rerender } = renderHook(() => useAppView(noTab))
    expect(result.current.kind).toBe('app') // restoreFinished latched true

    mockUseConnectionStatus.mockReturnValue({ status: 'disconnected' })
    rerender()
    expect(result.current.kind).toBe('login')

    mockUseConnectionStatus.mockReturnValue({ status: 'connecting' })
    rerender()
    expect(result.current.kind).toBe('login') // NOT restoring — restoreFinished gates rule 5
  })

  it('returns tabBlocked on web when another tab holds the connection', () => {
    mockIsTauri.mockReturnValue(false)
    mockUseConnectionStatus.mockReturnValue({ status: 'disconnected' })
    const { result } = renderHook(() => useAppView({ blocked: true, takenOver: false }))
    expect(result.current).toEqual({ kind: 'tabBlocked', takenOver: false })
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/fluux && npx vitest run src/hooks/useAppView.test.tsx`
Expected: FAIL — cannot resolve `./useAppView`.

- [ ] **Step 3: Write minimal implementation**

```ts
// apps/fluux/src/hooks/useAppView.ts
import { useEffect, useState } from 'react'
import { useConnectionStatus } from '@fluux/sdk'
import { selectAppView, type AppView } from '@/utils/selectAppView'
import { computeCanAutoReconnect } from '@/utils/canAutoReconnect'
import { isTauri } from '@/utils/tauri'

interface TabState {
  blocked: boolean
  takenOver: boolean
}

/**
 * Decide the top-level app surface reactively. Wires connection status + two
 * status-history latches + mount-time credential presence into the pure
 * selectAppView(). See the design spec.
 *
 * - hasShownApp:   true on 'online', false again on 'disconnected'/'error'
 * - restoreFinished: true once 'online' OR 'error' (never reset) — gates the
 *   cold-load splash so a stale canAutoReconnect cannot re-show it after logout.
 */
export function useAppView(tab: TabState): AppView {
  const { status } = useConnectionStatus()
  const [canAutoReconnect] = useState(computeCanAutoReconnect)
  const [hasShownApp, setHasShownApp] = useState(false)
  const [restoreFinished, setRestoreFinished] = useState(false)

  useEffect(() => {
    if (status === 'online') {
      setHasShownApp(true)
      setRestoreFinished(true)
    } else if (status === 'error') {
      setHasShownApp(false)
      setRestoreFinished(true)
    } else if (status === 'disconnected') {
      setHasShownApp(false)
    }
    // 'connecting' / 'reconnecting' / 'verifying': latches unchanged
  }, [status])

  return selectAppView({
    status,
    canAutoReconnect,
    hasShownApp,
    restoreFinished,
    tab,
    isTauri: isTauri(),
  })
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/fluux && npx vitest run src/hooks/useAppView.test.tsx`
Expected: PASS (4 cases).

- [ ] **Step 5: Commit**

```bash
git add apps/fluux/src/hooks/useAppView.ts apps/fluux/src/hooks/useAppView.test.tsx
git commit -m "feat(app): add useAppView hook wiring status + latches into selector"
```

---

### Task 4: Wire `useAppView` into `App.tsx`

**Files:**
- Modify: `apps/fluux/src/App.tsx`
- Test: `apps/fluux/src/App.reconnect.test.tsx` (existing; must stay green), `apps/fluux/src/App.routes.test.tsx` (existing)

> This task is a refactor with end-to-end test coverage rather than a new unit; the existing `App.reconnect.test.tsx` (8 tests) and `App.routes.test.tsx` are the safety net. Run them after each edit.

- [ ] **Step 1: Confirm the safety-net tests pass before changing anything**

Run: `cd apps/fluux && npx vitest run src/App.reconnect.test.tsx src/App.routes.test.tsx`
Expected: PASS (current behavior).

- [ ] **Step 2: Add the import and remove the obsolete local state**

In `apps/fluux/src/App.tsx`, add to the imports near the other hooks:

```ts
import { useAppView } from './hooks/useAppView'
```

Delete the `isAutoReconnecting` state block (currently `const [isAutoReconnecting, setIsAutoReconnecting] = useState(() => { ... })`) and the `hasBeenOnline` state (`const [hasBeenOnline, setHasBeenOnline] = useState(false)`). Also remove the now-unused `hasFastToken` import if nothing else uses it (the `isAutoReconnecting` initializer was its only consumer).

- [ ] **Step 3: Simplify the `status === 'online'` effect (keep E2EE bootstrap, drop latch bookkeeping)**

Replace the existing online effect (the `useEffect` that began `if (status === 'online') { setIsAutoReconnecting(false); setHasBeenOnline(true); ... }`) with:

```tsx
  // E2EE bootstrap once the account JID is available (fresh online only).
  // Latch/routing bookkeeping now lives in useAppView.
  useEffect(() => {
    if (status !== 'online') return
    // LoginScreen reads this flag to trigger the WRY webview reload workaround
    // on macOS after a later disconnect. '__wry_' prefix survives clearLocalData.
    sessionStorage.setItem('__wry_was_online', '1')
    void registerE2EEPlugins(client).then(async () => {
      if (isTauri || !isOpenpgpEnabled()) return
      const accountJid = jid ? jid.split('/')[0] : null
      const plugin = client.e2ee?.getPlugin('openpgp') as
        | { hasNoLocalKey?: () => Promise<boolean> }
        | null
        | undefined
      if (accountJid && plugin?.hasNoLocalKey) {
        try {
          const hasNoLocal = await plugin.hasNoLocalKey()
          if (hasNoLocal) {
            const state = await probeRemoteIdentityState(client, accountJid)
            if (state.hasServerIdentity) {
              setPendingIdentityChoice({
                accountJid,
                hasBackup: state.backupMessage !== null,
                publishedFingerprints: state.publishedFingerprints,
              })
              return
            }
          }
        } catch {
          // Probe failure: fall through to the unlock dialog.
        }
      }
      if (isKeyLocked()) {
        openWebUnlockDialog()
      }
    })
  }, [status, client, jid, openWebUnlockDialog])
```

(This preserves the exact E2EE/identity-choice logic; it only removes the `setIsAutoReconnecting`/`setHasBeenOnline` calls and the obsolete `else if` branch.)

- [ ] **Step 4: Replace the four render gates with a single `switch`**

Compute the view just before the return block (after `hasSession`/effects are set up):

```tsx
  const view = useAppView({
    blocked: tabCoordination.blocked,
    takenOver: tabCoordination.takenOver,
  })
```

Then replace the four `if (...) return (...)` gates (the spinner gate, the tab-blocked gate, the login gate, and the `return (<><TitleBar/><Routes>...` app block) with one switch. The `restoring`, `tabBlocked`, and `login` arms reuse the existing JSX; the `app` arm keeps the `<Routes>` and all the modal blocks:

```tsx
  switch (view.kind) {
    case 'restoring':
      return (
        <>
          <TitleBar />
          <div className="flex h-screen items-center justify-center bg-fluux-bg">
            <div className="text-center">
              <div className="animate-spin rounded-full size-8 border-b-2 border-fluux-brand mx-auto mb-4" />
              <p className="text-fluux-muted">{t('status.reconnecting')}</p>
            </div>
          </div>
        </>
      )

    case 'tabBlocked':
      return (
        <>
          <TitleBar />
          <TabBlockedScreen
            takenOver={view.takenOver}
            onTakeOver={tabCoordination.takeOver}
          />
        </>
      )

    case 'login':
      return (
        <>
          <TitleBar />
          <LoginScreen claimConnection={tabCoordination.claimConnection} />
        </>
      )

    case 'app':
      return (
        <>
          <TitleBar />
          <Routes>
            <Route path="/messages/:jid?" element={<ChatLayout />} />
            <Route path="/rooms/:jid?" element={<ChatLayout />} />
            <Route path="/contacts/:jid?" element={<ChatLayout />} />
            <Route path="/archive/:jid?" element={<ChatLayout />} />
            <Route path="/events" element={<ChatLayout />} />
            <Route path="/search" element={<ChatLayout />} />
            <Route path="/admin/*" element={<ChatLayout />} />
            <Route path="/settings/:category?" element={<ChatLayout />} />
            <Route path="/" element={<Navigate to="/messages" replace />} />
            <Route path="*" element={<Navigate to="/messages" replace />} />
          </Routes>
          {showUpdateModal && update.available && update.updaterEnabled && (
            <UpdateModal
              state={update}
              onDownload={update.downloadAndInstall}
              onRelaunch={update.relaunchApp}
              onDismiss={handleUpdateDismiss}
            />
          )}
          {showWebUnlockDialog && (
            <UnlockEncryptionDialog client={client} onClose={() => closeWebUnlockDialog()} />
          )}
          {pendingIdentityChoice && (
            <IdentityChoiceDialog
              hasServerBackup={pendingIdentityChoice.hasBackup}
              publishedFingerprints={pendingIdentityChoice.publishedFingerprints}
              onRestoreFromServer={handleIdentityRestoreFromServer}
              onImportFromFile={handleIdentityImportFromFile}
              onReplaceIdentity={handleIdentityReplaceIdentity}
              onCancel={() => setPendingIdentityChoice(null)}
            />
          )}
          {pendingImportFile && (
            <RestorePassphraseDialog
              title={t('settings.encryption.importFileDialogTitle')}
              body={t('settings.encryption.importFileDialogBody')}
              confirmLabel={t('settings.encryption.importFileAction')}
              onConfirm={handleImportFilePassphrase}
              onCancel={() => setPendingImportFile(null)}
            />
          )}
        </>
      )
  }
```

Remove the now-dead `hasSession` const if nothing else references it after this edit (the gate was its only consumer).

- [ ] **Step 5: Run the safety-net tests and typecheck**

Run: `cd apps/fluux && npx vitest run src/App.reconnect.test.tsx src/App.routes.test.tsx`
Expected: PASS (8 + routes). If a test references removed internals, update the test to drive behavior via `mockUseConnectionStatus` + `mockGetSession` only.

Run: `npm run typecheck` (repo root)
Expected: no errors (watch for unused-import errors from removed `useState`/`hasFastToken`).

- [ ] **Step 6: Commit**

```bash
git add apps/fluux/src/App.tsx
git commit -m "refactor(app): route top-level view via useAppView selector"
```

---

### Task 5: Localized terminal-error mapping (`LoginScreen`)

**Files:**
- Create: `apps/fluux/src/utils/loginError.ts`
- Test: `apps/fluux/src/utils/loginError.test.ts`
- Modify: `apps/fluux/src/components/LoginScreen.tsx`

- [ ] **Step 1: Write the failing test**

```ts
// apps/fluux/src/utils/loginError.test.ts
import { describe, it, expect } from 'vitest'
import { classifyLoginError, loginErrorMessage } from './loginError'

describe('classifyLoginError', () => {
  it('classifies auth failures', () => {
    expect(classifyLoginError('not-authorized')).toBe('auth')
    expect(classifyLoginError('Authentication failed')).toBe('auth')
  })
  it('classifies session takeover', () => {
    expect(classifyLoginError('Session replaced by another client')).toBe('sessionReplaced')
  })
  it('classifies connection failures', () => {
    expect(classifyLoginError('Connection failed: timeout')).toBe('connection')
    expect(classifyLoginError('Connection failed. Check your server address and try again.')).toBe('connection')
  })
  it('returns null for unrecognized errors', () => {
    expect(classifyLoginError('some other thing')).toBeNull()
  })
})

describe('loginErrorMessage', () => {
  const t = (k: string) => `t:${k}`
  it('maps known kinds to i18n keys', () => {
    expect(loginErrorMessage('not-authorized', t)).toBe('t:login.error.authFailed')
    expect(loginErrorMessage('Session replaced by another client', t)).toBe('t:login.error.sessionReplaced')
    expect(loginErrorMessage('Connection failed: x', t)).toBe('t:login.error.connectionFailed')
  })
  it('falls back to the raw string for unknown errors', () => {
    expect(loginErrorMessage('weird', t)).toBe('weird')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/fluux && npx vitest run src/utils/loginError.test.ts`
Expected: FAIL — cannot resolve `./loginError`.

- [ ] **Step 3: Write minimal implementation**

```ts
// apps/fluux/src/utils/loginError.ts
export type LoginErrorKind = 'auth' | 'sessionReplaced' | 'connection'

/**
 * Classify an SDK connection-error string into a known login-error category,
 * or null to fall back to showing the raw string. Auth detection matches the
 * SDK's terminal AUTH_ERROR string and the not-authorized stream error.
 */
export function classifyLoginError(error: string): LoginErrorKind | null {
  const lower = error.toLowerCase()
  if (lower.includes('not-authorized') || lower.includes('authentication failed')) return 'auth'
  if (lower.includes('replaced by another')) return 'sessionReplaced'
  if (lower.startsWith('connection failed')) return 'connection'
  return null
}

const KEY: Record<LoginErrorKind, string> = {
  auth: 'login.error.authFailed',
  sessionReplaced: 'login.error.sessionReplaced',
  connection: 'login.error.connectionFailed',
}

/** Localized, user-facing message for a connection error; raw string if unknown. */
export function loginErrorMessage(error: string, t: (key: string) => string): string {
  const kind = classifyLoginError(error)
  return kind ? t(KEY[kind]) : error
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/fluux && npx vitest run src/utils/loginError.test.ts`
Expected: PASS.

- [ ] **Step 5: Use it in LoginScreen and de-duplicate `isAuthError`**

In `apps/fluux/src/components/LoginScreen.tsx`:

1. Add the import:

```ts
import { classifyLoginError, loginErrorMessage } from '@/utils/loginError'
```

2. Replace the local `isAuthError` helper (lines ~19-23) with a delegation so there is one classifier:

```ts
/** Check if a connection error is an authentication failure (bad credentials) */
function isAuthError(error: string): boolean {
  return classifyLoginError(error) === 'auth'
}
```

3. Replace the error render block (currently `{error && (<div ...>{error}</div>)}`, ~lines 501-505) with the localized message:

```tsx
          {/* Error Message */}
          {error && (
            <div className="p-3 bg-fluux-red/20 border border-fluux-red/50 rounded text-fluux-red text-sm">
              {loginErrorMessage(error, t)}
            </div>
          )}
```

- [ ] **Step 6: Run LoginScreen tests + typecheck**

Run: `cd apps/fluux && npx vitest run src/components/LoginScreen.test.tsx src/utils/loginError.test.ts`
Expected: PASS. (If `LoginScreen.test.tsx` asserts the raw error text for a recognized string, update it to assert the i18n key/text.)

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add apps/fluux/src/utils/loginError.ts apps/fluux/src/utils/loginError.test.ts apps/fluux/src/components/LoginScreen.tsx
git commit -m "feat(login): show localized terminal-error reason on the login screen"
```

---

### Task 6: i18n keys in all 33 locales

**Files:**
- Modify: every `apps/fluux/src/i18n/locales/*.json` (33 files)
- Test: `apps/fluux/src/i18n/i18n.test.ts` (existing; auto-enforces key parity)

> The i18n completeness test already asserts every locale has the same key set as `en` (excluding plural variants). So `en` defines the keys and the test fails until all 33 locales include them — no new test needed.

- [ ] **Step 1: Add the keys to `en.json` (source of truth) and run the parity test to watch it fail**

Add under the existing `login` object in `apps/fluux/src/i18n/locales/en.json`:

```json
"error": {
  "authFailed": "Authentication failed. Check your username and password.",
  "sessionReplaced": "Your session was taken over by another device.",
  "connectionFailed": "Couldn't connect to the server. Check your server address and try again."
}
```

Run: `cd apps/fluux && npx vitest run src/i18n/i18n.test.ts`
Expected: FAIL — the other 32 locales are missing `login.error.*`.

- [ ] **Step 2: Add `fr.json` translations**

Add under `login` in `apps/fluux/src/i18n/locales/fr.json`:

```json
"error": {
  "authFailed": "Échec de l'authentification. Vérifiez votre identifiant et votre mot de passe.",
  "sessionReplaced": "Votre session a été reprise par un autre appareil.",
  "connectionFailed": "Connexion au serveur impossible. Vérifiez l'adresse du serveur et réessayez."
}
```

- [ ] **Step 3: Add translations to the remaining 31 locales**

For each of `ar be bg ca cs da el es et fi ga he hr hu is it lt lv mt nb nl pl pt ro ru sk sl sv uk zh-CN`, add the same `login.error` object with a proper translation of the three strings for that language. (Generate the translations — e.g. ask the assistant to produce all 31 at execution time — and flag RTL/less-common locales for native-speaker review per the spec.) Place the `error` object inside each file's existing `login` object, matching that file's indentation.

- [ ] **Step 4: Run the parity test to verify it passes**

Run: `cd apps/fluux && npx vitest run src/i18n/i18n.test.ts`
Expected: PASS (all 33 locales now contain `login.error.authFailed`, `login.error.sessionReplaced`, `login.error.connectionFailed`).

- [ ] **Step 5: Commit**

```bash
git add apps/fluux/src/i18n/locales
git commit -m "i18n: add login.error.* terminal-reason strings for all locales"
```

---

### Task 7: Final verification

**Files:** none (verification only)

- [ ] **Step 1: Full app test suite**

Run: `cd apps/fluux && npx vitest run`
Expected: all files pass (the new `selectAppView`, `canAutoReconnect`, `useAppView`, `loginError` tests plus the existing suite, including `App.reconnect.test.tsx` and `i18n.test.ts`).

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck` (repo root)
Expected: no errors in either workspace.

- [ ] **Step 3: Manual smoke (optional, in the running app)**

In Tauri or web: log in → app; "Disconnect (keep data)" → LoginScreen (no stale chat); kill network briefly while online → stays in app with the reconnect indicator; cold-load with a saved session → splash then app; force an auth failure → LoginScreen showing the localized reason.

- [ ] **Step 4: Commit any final touch-ups** (only if Step 1/2 required fixes)

```bash
git add -A
git commit -m "test(app): finalize app-view selector refactor"
```

---

## Self-Review

**Spec coverage:**
- Pure `selectAppView` + precedence (incl. fast-fail rule 1) → Task 1. ✓
- Two latches `hasShownApp` + `restoreFinished` → Task 3. ✓
- Mount-time `canAutoReconnect` → Task 2. ✓
- `App.tsx` switch + removal of `isAutoReconnecting`/`hasBeenOnline`, E2EE effect retained → Task 4. ✓
- Tweak 2 (fast-fail) → encoded as rule 1 (Task 1), exercised in Task 1 + Task 3 tests. ✓
- Tweak 1 (localized terminal errors): classifier + LoginScreen → Task 5; all-locale i18n → Task 6. ✓
- Boundary parity (existing `App.reconnect.test.tsx`/`App.routes.test.tsx` stay green) → Task 4. ✓

**Type consistency:** `AppView`/`AppViewInput` (Task 1) are imported unchanged by `useAppView` (Task 3). `computeCanAutoReconnect` (Task 2) name matches its use in Task 3. `classifyLoginError`/`loginErrorMessage` (Task 5) names match the test and LoginScreen usage. i18n keys `login.error.{authFailed,sessionReplaced,connectionFailed}` are identical across Task 5's `KEY` map and Task 6's locale entries.

**Placeholder scan:** The only generated-at-execution content is the 31 non-en/fr translations (Task 6 Step 3) — inherently per-language content, bounded by the en source strings and enforced by `i18n.test.ts`. No vague "add error handling"/"TBD" steps.
