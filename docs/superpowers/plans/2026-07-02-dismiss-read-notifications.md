# Dismiss Read Conversation Notifications — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When a conversation or room is read, remove *only that conversation's* delivered notification from the OS notification center; leave other conversations' notifications in place.

**Architecture:** Add a macOS-native Tauri command that removes delivered notifications by identifier (macOS posts via a custom `UNUserNotificationCenter` path the notification plugin can't touch). Add a cross-platform JS helper `dismissNotification(navType, navTarget)` that routes to the native command (macOS), the notification plugin by tag (Windows/Linux), or the service worker by tag (web) — mirroring the existing *posting* branch. Delete the broken all-or-nothing `clearAllNotifications()` and call the scoped helper from the two read paths (open/navigate + window-focus).

**Tech Stack:** Rust (Tauri v2, `objc2` / `objc2-user-notifications`), TypeScript/React, Vitest, `@tauri-apps/plugin-notification`, `@tauri-apps/plugin-os`.

**Design spec:** [docs/superpowers/specs/2026-07-02-dismiss-read-notifications-design.md](../specs/2026-07-02-dismiss-read-notifications-design.md)

## Global Constraints

- **Worktree path:** all edits go under `/Users/mremond/AIProjects/fluux-messenger/.claude/worktrees/bold-torvalds-ed4819/`. Tool-reported absolute paths may point at the protected MAIN repo — verify the path contains `.claude/worktrees/bold-torvalds-ed4819/` before editing.
- **macOS notification identifier scheme:** `` `${navType}:${navTarget}` `` — e.g. `conversation:alice@example.com`, `room:team@conf.example.com` (from `macos.rs::encode_identifier`; `navType` never contains `:`).
- **Plugin / web tag scheme:** conversation → `navTarget` (the conversation id); room → `` `room-${navTarget}` `` (from `useDesktopNotifications.ts:182,238`).
- **`navType` values:** the string literals `'conversation'` and `'room'` only.
- **Best-effort posture:** all removal is a nice-to-have; swallow errors, never surface them to the user (matches the code being replaced).
- **Rust command is macOS-only:** gate every new Rust item with `#[cfg(target_os = "macos")]`, matching the sibling notification commands. Non-macOS builds compile with `-D warnings`.
- **Run tests per-workspace** (never bare `vitest` from root): `cd apps/fluux && npx vitest run <path>` for app tests.
- **Commits:** SSH-signed. If a commit fails on signing, ask the user to run `ssh-add ~/.ssh/id_ed25519`. No Claude footer in commit messages.

---

## File Structure

- **Create** `apps/fluux/src/utils/dismissNotification.ts` — the cross-platform per-conversation dismissal helper.
- **Create** `apps/fluux/src/utils/dismissNotification.test.ts` — unit tests for the three platform branches.
- **Create** `apps/fluux/src/hooks/useWindowVisibility.test.tsx` — tests the focus-path wiring (no test exists today).
- **Modify** `apps/fluux/src-tauri/src/notifications/macos.rs` — add `remove_delivered(identifiers)`.
- **Modify** `apps/fluux/src-tauri/src/notifications/mod.rs` — add `#[tauri::command] remove_delivered_notifications`.
- **Modify** `apps/fluux/src-tauri/src/main.rs:1424-1432` — register the command in `generate_handler!`.
- **Modify** `apps/fluux/src/hooks/useNavigateToTarget.ts` — delete `clearAllNotifications`, call `dismissNotification` from `navigateToConversation`/`navigateToRoom`, drop the clear from `navigateToContact`.
- **Modify** `apps/fluux/src/hooks/useNavigateToTarget.test.tsx` — mock `dismissNotification`, assert calls.
- **Modify** `apps/fluux/src/hooks/useDeepLink.test.tsx` — swap the `plugin-notification` mock for a `dismissNotification` mock.
- **Modify** `apps/fluux/src/hooks/useWindowVisibility.ts` — dismiss the active entity's notification on focus regain.

---

## Task 1: Native macOS `remove_delivered_notifications` command

**Files:**
- Modify: `apps/fluux/src-tauri/src/notifications/macos.rs` (add `remove_delivered`)
- Modify: `apps/fluux/src-tauri/src/notifications/mod.rs` (add command)
- Modify: `apps/fluux/src-tauri/src/main.rs:1424-1432` (register)

**Interfaces:**
- Produces (Rust): `pub fn remove_delivered(identifiers: Vec<String>)` in `macos.rs`; `#[tauri::command] pub fn remove_delivered_notifications(identifiers: Vec<String>)` in `mod.rs`.
- Produces (JS-facing): Tauri command name `remove_delivered_notifications`, arg key `identifiers: string[]`, returns `void`.

- [ ] **Step 1: Add `remove_delivered` to `macos.rs`**

Add this function directly after `post` (which ends at line 238):

```rust
/// Remove already-delivered notifications from Notification Center by their
/// identifiers (see `encode_identifier`). Called when a conversation/room is
/// read so its stale entry disappears. Best-effort: no-op when the process is
/// not app-bundled (`current_center()` returns `None`) or when an identifier
/// has no matching delivered notification.
pub fn remove_delivered(identifiers: Vec<String>) {
    let Some(center) = current_center() else {
        return;
    };
    use objc2_foundation::NSArray;
    // Keep the NSStrings alive in `ids` while `refs` borrows them for the call.
    let ids: Vec<Retained<NSString>> = identifiers.iter().map(|s| NSString::from_str(s)).collect();
    let refs: Vec<&NSString> = ids.iter().map(|s| &**s).collect();
    let array = NSArray::from_slice(&refs);
    center.removeDeliveredNotificationsWithIdentifiers(&array);
}
```

- [ ] **Step 2: Add the Tauri command to `mod.rs`**

After `set_notification_listener_ready` (ends at line 72), add:

```rust
#[cfg(target_os = "macos")]
#[tauri::command]
pub fn remove_delivered_notifications(identifiers: Vec<String>) {
    macos::remove_delivered(identifiers);
}
```

- [ ] **Step 3: Register the command in `main.rs`**

In the `tauri::generate_handler![...]` block, the current last notification entry (`main.rs:1432`) is `notifications::set_notification_listener_ready` with **no trailing comma**. Add a comma to it and append the new command:

```rust
            #[cfg(target_os = "macos")]
            notifications::set_notification_listener_ready,
            #[cfg(target_os = "macos")]
            notifications::remove_delivered_notifications
```

- [ ] **Step 4: Verify it compiles (macOS)**

Run: `cd apps/fluux/src-tauri && cargo check`
Expected: compiles with no errors and no new warnings. (This is a thin FFI wrapper over a system API; there is no meaningful Rust unit test — behaviour is verified end-to-end in Task 5.)

- [ ] **Step 5: Commit**

```bash
git add apps/fluux/src-tauri/src/notifications/macos.rs apps/fluux/src-tauri/src/notifications/mod.rs apps/fluux/src-tauri/src/main.rs
git commit -m "feat(notifications): native macOS command to remove delivered notifications by identifier"
```

---

## Task 2: `dismissNotification` cross-platform helper

**Files:**
- Create: `apps/fluux/src/utils/dismissNotification.ts`
- Test: `apps/fluux/src/utils/dismissNotification.test.ts`

**Interfaces:**
- Consumes: `isMacOSDesktop()` from `@/utils/tauriPlatform`; `invoke` from `@tauri-apps/api/core`; `active`/`removeActive` from `@tauri-apps/plugin-notification`; Tauri command `remove_delivered_notifications` (Task 1).
- Produces: `export type NavType = 'conversation' | 'room'` and `export async function dismissNotification(navType: NavType, navTarget: string): Promise<void>`.

- [ ] **Step 1: Write the failing tests**

Create `apps/fluux/src/utils/dismissNotification.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const { isMacOSDesktop, invoke, active, removeActive } = vi.hoisted(() => ({
  isMacOSDesktop: vi.fn(),
  invoke: vi.fn().mockResolvedValue(undefined),
  active: vi.fn().mockResolvedValue([]),
  removeActive: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('@/utils/tauriPlatform', () => ({ isMacOSDesktop }))
vi.mock('@tauri-apps/api/core', () => ({ invoke }))
vi.mock('@tauri-apps/plugin-notification', () => ({ active, removeActive }))

import { dismissNotification } from './dismissNotification'

function setTauri(on: boolean) {
  if (on) (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {}
  else delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__
}

describe('dismissNotification', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    active.mockResolvedValue([])
  })
  afterEach(() => setTauri(false))

  it('macOS: invokes the native command with the conversation identifier', async () => {
    isMacOSDesktop.mockResolvedValue(true)
    setTauri(true)
    await dismissNotification('conversation', 'alice@example.com')
    expect(invoke).toHaveBeenCalledWith('remove_delivered_notifications', {
      identifiers: ['conversation:alice@example.com'],
    })
  })

  it('macOS: uses the room identifier for rooms', async () => {
    isMacOSDesktop.mockResolvedValue(true)
    setTauri(true)
    await dismissNotification('room', 'team@conf.example.com')
    expect(invoke).toHaveBeenCalledWith('remove_delivered_notifications', {
      identifiers: ['room:team@conf.example.com'],
    })
  })

  it('Windows/Linux Tauri: removes plugin notifications matching the tag', async () => {
    isMacOSDesktop.mockResolvedValue(false)
    setTauri(true)
    const match = { id: 1, tag: 'alice@example.com' }
    active.mockResolvedValue([match, { id: 2, tag: 'room-other@conf' }])
    await dismissNotification('conversation', 'alice@example.com')
    expect(invoke).not.toHaveBeenCalled()
    expect(removeActive).toHaveBeenCalledWith([match])
  })

  it('Windows/Linux Tauri: maps rooms to the room-<jid> tag', async () => {
    isMacOSDesktop.mockResolvedValue(false)
    setTauri(true)
    const match = { id: 3, tag: 'room-team@conf.example.com' }
    active.mockResolvedValue([match, { id: 4, tag: 'alice@example.com' }])
    await dismissNotification('room', 'team@conf.example.com')
    expect(removeActive).toHaveBeenCalledWith([match])
  })

  it('Windows/Linux Tauri: no-op when no notification matches the tag', async () => {
    isMacOSDesktop.mockResolvedValue(false)
    setTauri(true)
    active.mockResolvedValue([{ id: 9, tag: 'bob@example.com' }])
    await dismissNotification('conversation', 'alice@example.com')
    expect(removeActive).not.toHaveBeenCalled()
  })

  it('Web: closes service-worker notifications matching the tag', async () => {
    isMacOSDesktop.mockResolvedValue(false)
    setTauri(false)
    const close = vi.fn()
    const getNotifications = vi.fn().mockResolvedValue([{ close }, { close }])
    Object.defineProperty(navigator, 'serviceWorker', {
      configurable: true,
      value: { ready: Promise.resolve({ getNotifications }) },
    })
    await dismissNotification('conversation', 'alice@example.com')
    expect(getNotifications).toHaveBeenCalledWith({ tag: 'alice@example.com' })
    expect(close).toHaveBeenCalledTimes(2)
    delete (navigator as unknown as Record<string, unknown>).serviceWorker
  })

  it('swallows errors from the platform call', async () => {
    isMacOSDesktop.mockResolvedValue(true)
    setTauri(true)
    invoke.mockRejectedValueOnce(new Error('boom'))
    await expect(dismissNotification('conversation', 'alice@example.com')).resolves.toBeUndefined()
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd apps/fluux && npx vitest run src/utils/dismissNotification.test.ts`
Expected: FAIL — `Failed to resolve import './dismissNotification'` (module does not exist yet).

- [ ] **Step 3: Implement the helper**

Create `apps/fluux/src/utils/dismissNotification.ts`:

```ts
import { isMacOSDesktop } from '@/utils/tauriPlatform'

export type NavType = 'conversation' | 'room'

/** Running inside the Tauri desktop app. Checked at call time (not module load)
 *  so tests can toggle it. */
function inTauri(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window
}

/** Tag used by the Tauri notification plugin and the web Notification API
 *  (see useDesktopNotifications.ts). Differs from the macOS native identifier. */
function pluginTag(navType: NavType, navTarget: string): string {
  return navType === 'room' ? `room-${navTarget}` : navTarget
}

/**
 * Remove the delivered notification(s) for a single conversation/room when it
 * is read, leaving other conversations' notifications untouched. Best-effort
 * and platform-specific:
 * - macOS Tauri: native UNUserNotificationCenter command, keyed by identifier
 *   `"<navType>:<navTarget>"`.
 * - Windows/Linux Tauri: notification plugin, keyed by tag.
 * - Web (PWA): service worker registration, keyed by tag.
 */
export async function dismissNotification(navType: NavType, navTarget: string): Promise<void> {
  try {
    if (await isMacOSDesktop()) {
      const { invoke } = await import('@tauri-apps/api/core')
      await invoke('remove_delivered_notifications', {
        identifiers: [`${navType}:${navTarget}`],
      })
      return
    }

    const tag = pluginTag(navType, navTarget)

    if (inTauri()) {
      const { active, removeActive } = await import('@tauri-apps/plugin-notification')
      const delivered = await active()
      const matches = delivered.filter((n) => n.tag === tag)
      if (matches.length > 0) await removeActive(matches)
      return
    }

    // Web PWA: notifications were posted via ServiceWorkerRegistration.showNotification.
    if (typeof navigator !== 'undefined' && navigator.serviceWorker) {
      const registration = await navigator.serviceWorker.ready
      const notifications = await registration.getNotifications({ tag })
      notifications.forEach((n) => n.close())
    }
  } catch {
    // Best-effort: dismissing a read notification is a nice-to-have.
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd apps/fluux && npx vitest run src/utils/dismissNotification.test.ts`
Expected: PASS — all 7 tests green.

- [ ] **Step 5: Commit**

```bash
git add apps/fluux/src/utils/dismissNotification.ts apps/fluux/src/utils/dismissNotification.test.ts
git commit -m "feat(notifications): add per-conversation dismissNotification helper"
```

---

## Task 3: Wire the open/navigate path + delete `clearAllNotifications`

**Files:**
- Modify: `apps/fluux/src/hooks/useNavigateToTarget.ts`
- Modify: `apps/fluux/src/hooks/useNavigateToTarget.test.tsx`
- Modify: `apps/fluux/src/hooks/useDeepLink.test.tsx`

**Interfaces:**
- Consumes: `dismissNotification` from `@/utils/dismissNotification` (Task 2).
- Produces: unchanged public API of `useNavigateToTarget` — `{ navigateToConversation, navigateToContact, navigateToRoom }`.

- [ ] **Step 1: Update `useNavigateToTarget.test.tsx` (failing assertions first)**

Replace the plugin mock at lines 39-42:

```ts
// Mock the per-conversation dismissal helper
const dismissNotification = vi.fn()
vi.mock('@/utils/dismissNotification', () => ({ dismissNotification }))
```

Then add these assertions inside the existing `describe` blocks:

In `describe('navigateToConversation', ...)`, add:

```ts
it('dismisses the conversation notification', () => {
  const { result } = renderHook(() => useNavigateToTarget(), {
    wrapper: createWrapper('/messages'),
  })
  act(() => {
    result.current.navigateToConversation('alice@example.com')
  })
  expect(dismissNotification).toHaveBeenCalledWith('conversation', 'alice@example.com')
})
```

In `describe('navigateToRoom', ...)`, add:

```ts
it('dismisses the room notification', () => {
  const { result } = renderHook(() => useNavigateToTarget(), {
    wrapper: createWrapper('/rooms'),
  })
  act(() => {
    result.current.navigateToRoom('general@conference.example.com')
  })
  expect(dismissNotification).toHaveBeenCalledWith('room', 'general@conference.example.com')
})
```

In `describe('navigateToContact', ...)`, add:

```ts
it('does not dismiss any notification (not a conversation read)', () => {
  const { result } = renderHook(() => useNavigateToTarget(), {
    wrapper: createWrapper('/messages'),
  })
  act(() => {
    result.current.navigateToContact('bob@example.com')
  })
  expect(dismissNotification).not.toHaveBeenCalled()
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd apps/fluux && npx vitest run src/hooks/useNavigateToTarget.test.tsx`
Expected: FAIL — `dismissNotification` is never called (production code still calls the old `clearAllNotifications`).

- [ ] **Step 3: Update `useNavigateToTarget.ts`**

Delete the `clearAllNotifications` helper (lines 17-33) and its comment block. Add an import near the top (after line 12):

```ts
import { dismissNotification } from '@/utils/dismissNotification'
```

In `navigateToConversation`, replace `void clearAllNotifications()` (line 80) with:

```ts
    void dismissNotification('conversation', conversationId)
```

In `navigateToRoom`, replace `void clearAllNotifications()` (line 109) with:

```ts
    void dismissNotification('room', roomJid)
```

In `navigateToContact`, delete the `void clearAllNotifications()` line (line 92) entirely, and update its doc comment: remove the "Clears all active notifications." sentence.

Also update the `navigateToConversation` / `navigateToRoom` doc comments: replace "Clears all active notifications." with "Dismisses this conversation's/room's notification."

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd apps/fluux && npx vitest run src/hooks/useNavigateToTarget.test.tsx`
Expected: PASS — all existing tests plus the 3 new ones.

- [ ] **Step 5: Fix the `useDeepLink.test.tsx` mock**

`useDeepLink` navigates via `useNavigateToTarget`, which no longer imports `@tauri-apps/plugin-notification`. Replace the mock at `useDeepLink.test.tsx:126-127`:

```ts
// Mock the dismissal helper (useNavigateToTarget calls it on navigation)
vi.mock('@/utils/dismissNotification', () => ({ dismissNotification: vi.fn() }))
```

Remove the now-obsolete comment at line 156 about suppressing `clearAllNotifications` console warnings if the corresponding `console.warn` suppression is no longer needed (the helper no longer warns).

Run: `cd apps/fluux && npx vitest run src/hooks/useDeepLink.test.tsx`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/fluux/src/hooks/useNavigateToTarget.ts apps/fluux/src/hooks/useNavigateToTarget.test.tsx apps/fluux/src/hooks/useDeepLink.test.tsx
git commit -m "feat(notifications): dismiss per-conversation notification on open, drop broken clear-all"
```

---

## Task 4: Wire the window-focus read path

**Files:**
- Modify: `apps/fluux/src/hooks/useWindowVisibility.ts`
- Test: `apps/fluux/src/hooks/useWindowVisibility.test.tsx` (create)

**Interfaces:**
- Consumes: `dismissNotification` from `@/utils/dismissNotification` (Task 2); `connectionStore`, `chatStore`, `roomStore` from `@fluux/sdk`.
- Produces: no API change (`useWindowVisibility(): void`).

- [ ] **Step 1: Write the failing test**

Create `apps/fluux/src/hooks/useWindowVisibility.test.tsx`:

```tsx
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook } from '@testing-library/react'

const state = {
  windowVisible: false,
  activeConversationId: null as string | null,
  activeRoomJid: null as string | null,
}
const setWindowVisible = vi.fn()
const markConvRead = vi.fn()
const markRoomRead = vi.fn()
const dismissNotification = vi.fn()

vi.mock('@fluux/sdk', () => ({
  connectionStore: { getState: () => ({ windowVisible: state.windowVisible, setWindowVisible }) },
  chatStore: { getState: () => ({ activeConversationId: state.activeConversationId, markAsRead: markConvRead }) },
  roomStore: { getState: () => ({ activeRoomJid: state.activeRoomJid, markAsRead: markRoomRead }) },
}))
vi.mock('@/utils/dismissNotification', () => ({ dismissNotification }))

import { useWindowVisibility } from './useWindowVisibility'

describe('useWindowVisibility', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    state.windowVisible = false
    state.activeConversationId = null
    state.activeRoomJid = null
    vi.spyOn(document, 'hasFocus').mockReturnValue(true)
  })

  it('dismisses the active conversation notification on focus regain', () => {
    state.activeConversationId = 'alice@example.com'
    renderHook(() => useWindowVisibility())
    expect(markConvRead).toHaveBeenCalledWith('alice@example.com')
    expect(dismissNotification).toHaveBeenCalledWith('conversation', 'alice@example.com')
  })

  it('dismisses the active room notification on focus regain', () => {
    state.activeRoomJid = 'team@conf.example.com'
    renderHook(() => useWindowVisibility())
    expect(markRoomRead).toHaveBeenCalledWith('team@conf.example.com')
    expect(dismissNotification).toHaveBeenCalledWith('room', 'team@conf.example.com')
  })

  it('does nothing when there is no active conversation or room', () => {
    renderHook(() => useWindowVisibility())
    expect(dismissNotification).not.toHaveBeenCalled()
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd apps/fluux && npx vitest run src/hooks/useWindowVisibility.test.tsx`
Expected: FAIL — `dismissNotification` is not called (hook only marks read today).

- [ ] **Step 3: Update `useWindowVisibility.ts`**

Add the import after line 2:

```ts
import { dismissNotification } from '@/utils/dismissNotification'
```

In the `if (!wasFocused && isFocused)` block (lines 27-36), add a dismissal after each `markAsRead`:

```ts
      if (!wasFocused && isFocused) {
        const activeConversationId = chatStore.getState().activeConversationId
        if (activeConversationId) {
          chatStore.getState().markAsRead(activeConversationId)
          void dismissNotification('conversation', activeConversationId)
        }
        const activeRoomJid = roomStore.getState().activeRoomJid
        if (activeRoomJid) {
          roomStore.getState().markAsRead(activeRoomJid)
          void dismissNotification('room', activeRoomJid)
        }
      }
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd apps/fluux && npx vitest run src/hooks/useWindowVisibility.test.tsx`
Expected: PASS — all 3 tests green.

- [ ] **Step 5: Commit**

```bash
git add apps/fluux/src/hooks/useWindowVisibility.ts apps/fluux/src/hooks/useWindowVisibility.test.tsx
git commit -m "feat(notifications): dismiss active conversation notification on window focus"
```

---

## Task 5: Full verification (typecheck, lint, affected tests, manual macOS)

**Files:** none (verification only).

- [ ] **Step 1: Typecheck**

Run: `npm run typecheck`
Expected: no errors. (If the SDK types were touched — they were not here — run `npm run build:sdk` first.)

- [ ] **Step 2: Lint**

Run: `npm run lint`
Expected: no errors on the touched files.

- [ ] **Step 3: Run all affected app tests**

Run: `cd apps/fluux && npx vitest run src/utils/dismissNotification.test.ts src/hooks/useNavigateToTarget.test.tsx src/hooks/useDeepLink.test.tsx src/hooks/useWindowVisibility.test.tsx`
Expected: all PASS, no stderr.

- [ ] **Step 4: Rust build**

Run: `cd apps/fluux/src-tauri && cargo build`
Expected: builds clean, no new warnings.

- [ ] **Step 5: Manual end-to-end on macOS**

Run: `npm run tauri:dev`

Verify (requires a bundled build for native notifications — see spec; under `tauri:dev` the process may be unbundled, in which case `current_center()` is `None` and native dismissal no-ops. If so, verify against a `npm run tauri:build` bundle instead):
1. With the app backgrounded, receive messages from two different conversations (A and B). Confirm two entries in Notification Center.
2. Open conversation A. Confirm A's entry disappears from Notification Center and B's remains.
3. With conversation A already open, background the app, receive a new message from A (entry reappears), then bring the app to the foreground (Cmd-Tab / dock). Confirm A's entry disappears on refocus.

- [ ] **Step 6: Final commit (if any doc/cleanup changes)**

```bash
git add -A
git commit -m "chore(notifications): finalize read-dismissal wiring"
```

(Skip if there is nothing to commit.)

---

## Self-Review Notes

- **Spec coverage:** Rust command (Task 1) ↔ spec §Components.1; JS helper + deletion of `clearAllNotifications` (Task 2, Task 3) ↔ §Components.2; open/navigate wiring (Task 3) ↔ §Components.3.1; focus wiring (Task 4) ↔ §Components.3.2; three-platform matrix ↔ Task 2 tests; manual macOS verification (Task 5) ↔ §Testing.
- **Type consistency:** `dismissNotification(navType: NavType, navTarget: string)` used identically in Tasks 2/3/4; `NavType = 'conversation' | 'room'`; Tauri command `remove_delivered_notifications` with `{ identifiers: string[] }` used identically in Task 1 (Rust) and Task 2 (JS).
- **No placeholders:** every code and test step contains full content.
