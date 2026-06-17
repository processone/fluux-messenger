# MUC Join Error Feedback — Secondary Join Paths — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Surface a localized failure message when a MUC join initiated from RoomView, BrowseRoomsModal, RoomsList, or a deep link fails — by awaiting the SDK's `joinResult()` and mapping its `RoomJoinError` through one shared helper.

**Architecture:** Extract the modal's existing condition→message `switch` into a pure helper `getRoomJoinErrorMessage(t, err, opts?)`. Expose the already-existing `client.muc.joinResult` on the two hooks that lack it (`useRoomActive`, `useRoom`). At each secondary call site, add `await joinResult(jid)` after `joinRoom(...)` and feed the helper's message to a toast (RoomView, RoomsList, deep link) or the existing inline banner (BrowseRoomsModal). No SDK core/protocol changes, no new i18n keys.

**Tech Stack:** React 19, TypeScript, Zustand, react-i18next, Vitest + Testing Library. Monorepo: `@fluux/sdk` (SDK) + `@xmpp/fluux` (app). Spec: [docs/superpowers/specs/2026-06-16-muc-join-error-secondary-paths-design.md](../specs/2026-06-16-muc-join-error-secondary-paths-design.md).

---

## Worktree / SDK resolution notes (READ FIRST)

This plan runs inside a git worktree at `/Users/mremond/AIProjects/fluux-messenger/.claude/worktrees/elegant-johnson-983602`. Module resolution is split:

- **Vitest and Vite alias `@fluux/sdk` → the worktree's `packages/fluux-sdk/src`** (see `apps/fluux/vitest.config.ts`). So **tests see SDK source live — no build needed** for the SDK hook change to be visible to tests.
- **`tsc` (typecheck) has no SDK path alias**, so app typecheck resolves `@fluux/sdk` via node_modules → the **main repo's** `packages/fluux-sdk/dist/*.d.ts`. That `dist` is an **untracked build artifact** (`git ls-files` = 0). After the SDK hook change (Task 2), the main dist must be rebuilt+synced so `npm run typecheck` sees the new `joinResult`. Task 2 does this with `rsync`.

**Single-file app test command** (run from the worktree root; do NOT `cd` into the app — a bare `vitest` from root mass-fails on `@/` aliases, and `cd` can trap the shell):

```bash
npm run test:run -w @xmpp/fluux -- <path-relative-to-apps/fluux>
```

**Commit signing:** commits are SSH-signed and the `id_ed25519` key is loaded. Per repo convention, never add a Claude footer to commits.

---

## File Structure

| File | Create / Modify | Responsibility |
|---|---|---|
| `apps/fluux/src/utils/roomJoinError.ts` | Create | Pure `getRoomJoinErrorMessage(t, err, opts?)` — single source of truth for join-error wording |
| `apps/fluux/src/utils/roomJoinError.test.ts` | Create | Unit test for the helper (all conditions, both `not-authorized` variants, fallthroughs) |
| `packages/fluux-sdk/src/hooks/useRoomActive.ts` | Modify | Add `joinResult` action (RoomView consumes this hook) |
| `packages/fluux-sdk/src/hooks/useRoom.ts` | Modify | Add `joinResult` action (BrowseRoomsModal, useDeepLink consume this hook) |
| `apps/fluux/src/components/JoinRoomModal.tsx` | Modify | `showJoinError` delegates message to the helper (behavior unchanged) |
| `apps/fluux/src/components/RoomView.tsx` | Modify | `RoomJoinPrompt onJoin`: await `joinResult`, toast on failure |
| `apps/fluux/src/components/BrowseRoomsModal.tsx` | Modify | `handleJoinRoom`: await `joinResult`, inline-error on failure |
| `apps/fluux/src/components/sidebar-components/RoomsList.tsx` | Modify | `onActivate` + `onJoin`: await `joinResult`, toast on failure |
| `apps/fluux/src/hooks/useDeepLink.ts` | Modify | Room branch: await `joinResult`, toast on failure, navigate regardless |
| `apps/fluux/src/components/RoomView.test.tsx` | Modify | Mock `joinResult` + `RoomJoinError`; add a toast-on-failure test |
| `apps/fluux/src/components/BrowseRoomsModal.test.tsx` | Modify | Mock `joinResult` + `RoomJoinError`; add an inline-error-mapping test |

`RoomsList` and `useDeepLink` have **no existing test files**; their uniform `try/catch` logic is covered by the helper unit test. New harnesses for them are out of scope — note the gap in the PR.

---

## Task 1: Shared helper `getRoomJoinErrorMessage`

**Files:**
- Create: `apps/fluux/src/utils/roomJoinError.ts`
- Test: `apps/fluux/src/utils/roomJoinError.test.ts`

- [ ] **Step 1: Write the failing test**

Create `apps/fluux/src/utils/roomJoinError.test.ts`. It imports the **real** `RoomJoinError` (vitest aliases `@fluux/sdk` to the worktree SDK source, so no mock is needed here) and an identity `t`:

```ts
import { describe, it, expect } from 'vitest'
import { RoomJoinError } from '@fluux/sdk'
import { getRoomJoinErrorMessage } from './roomJoinError'

// Identity translate fn: returns the key so assertions read as i18n keys.
const t = (key: string) => key

const err = (condition: string, text?: string) =>
  new RoomJoinError('room@conference.example.com', condition, undefined, text)

describe('getRoomJoinErrorMessage', () => {
  it('maps not-authorized to passwordRequired when no password was sent', () => {
    expect(getRoomJoinErrorMessage(t, err('not-authorized'))).toBe('rooms.passwordRequired')
  })

  it('maps not-authorized to incorrectPassword when a password was sent', () => {
    expect(getRoomJoinErrorMessage(t, err('not-authorized'), { passwordWasSent: true })).toBe(
      'rooms.incorrectPassword',
    )
  })

  it.each([
    ['conflict', 'rooms.nicknameInUse'],
    ['registration-required', 'rooms.membersOnly'],
    ['forbidden', 'rooms.bannedFromRoom'],
    ['service-unavailable', 'rooms.roomFull'],
    ['not-acceptable', 'rooms.registeredNicknameRequired'],
    ['item-not-found', 'rooms.roomNotFound'],
  ])('maps %s to %s', (condition, key) => {
    expect(getRoomJoinErrorMessage(t, err(condition))).toBe(key)
  })

  it('uses server text for an unmapped condition when present', () => {
    expect(getRoomJoinErrorMessage(t, err('resource-constraint', 'Try later'))).toBe('Try later')
  })

  it('falls back to failedToJoinRoom for an unmapped condition with no text', () => {
    expect(getRoomJoinErrorMessage(t, err('resource-constraint'))).toBe('rooms.failedToJoinRoom')
  })

  it('uses the message of a plain Error', () => {
    expect(getRoomJoinErrorMessage(t, new Error('boom'))).toBe('boom')
  })

  it('falls back to failedToJoinRoom for a non-Error value', () => {
    expect(getRoomJoinErrorMessage(t, 'nope')).toBe('rooms.failedToJoinRoom')
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run:
```bash
npm run test:run -w @xmpp/fluux -- src/utils/roomJoinError.test.ts
```
Expected: FAIL — `Failed to resolve import "./roomJoinError"` (the module does not exist yet).

- [ ] **Step 3: Write the helper**

Create `apps/fluux/src/utils/roomJoinError.ts`:

```ts
import { RoomJoinError } from '@fluux/sdk'

// Matches the TranslateFn convention in messagePreviewText.ts / presence.ts.
type TranslateFn = (key: string, options?: Record<string, unknown>) => string

/**
 * Map a room-join failure to a localized, user-facing message. Shared by
 * JoinRoomModal (inline error) and the secondary join paths (RoomView prompt,
 * RoomsList, BrowseRoomsModal, deep link) so the wording stays in sync. Field
 * side effects (revealing the password input, focusing the nickname) stay in
 * the modal — this resolves message text only.
 *
 * @param opts.passwordWasSent disambiguates the two `not-authorized` cases:
 *   false → "password required", true → "incorrect password". Secondary paths
 *   never send a password, so they omit it (defaults to false).
 */
export function getRoomJoinErrorMessage(
  t: TranslateFn,
  err: unknown,
  opts?: { passwordWasSent?: boolean },
): string {
  if (err instanceof RoomJoinError) {
    switch (err.condition) {
      case 'not-authorized':
        return t(opts?.passwordWasSent ? 'rooms.incorrectPassword' : 'rooms.passwordRequired')
      case 'conflict':
        return t('rooms.nicknameInUse')
      case 'registration-required':
        return t('rooms.membersOnly')
      case 'forbidden':
        return t('rooms.bannedFromRoom')
      case 'service-unavailable':
        return t('rooms.roomFull')
      case 'not-acceptable':
        return t('rooms.registeredNicknameRequired')
      case 'item-not-found':
        return t('rooms.roomNotFound')
      default:
        return err.text || t('rooms.failedToJoinRoom')
    }
  }
  return err instanceof Error ? err.message : t('rooms.failedToJoinRoom')
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run:
```bash
npm run test:run -w @xmpp/fluux -- src/utils/roomJoinError.test.ts
```
Expected: PASS (all 12 cases green).

- [ ] **Step 5: Commit**

```bash
git add apps/fluux/src/utils/roomJoinError.ts apps/fluux/src/utils/roomJoinError.test.ts
git commit -m "feat(rooms): shared getRoomJoinErrorMessage helper for join-error wording"
```

---

## Task 2: Expose `joinResult` on `useRoomActive` and `useRoom`

**Files:**
- Modify: `packages/fluux-sdk/src/hooks/useRoomActive.ts` (add callback ~line 150; add to actions object ~line 421 and its deps ~line 457)
- Modify: `packages/fluux-sdk/src/hooks/useRoom.ts` (add callback near `joinRoom` ~line 165; add to return object ~line 580 and its deps ~line 631)

This mirrors `useRoomActions.ts:54` exactly. `client.muc.joinResult` already exists.

- [ ] **Step 1: Add `joinResult` to `useRoomActive`**

In `packages/fluux-sdk/src/hooks/useRoomActive.ts`, immediately after the `joinRoom` `useCallback` (ends at line 150), insert:

```ts
  const joinResult = useCallback(
    async (roomJid: string): Promise<void> => {
      await client.muc.joinResult(roomJid)
    },
    [client],
  )
```

Then add `joinResult,` to the memoized `actions` object (after `joinRoom,` at line 421) **and** to that `useMemo`'s dependency array (after `joinRoom,` at line 457). Both edits are required or the action won't be stable/returned.

- [ ] **Step 2: Add `joinResult` to `useRoom`**

In `packages/fluux-sdk/src/hooks/useRoom.ts`, immediately after its `joinRoom` `useCallback` (around line 165–170), insert the identical block:

```ts
  const joinResult = useCallback(
    async (roomJid: string): Promise<void> => {
      await client.muc.joinResult(roomJid)
    },
    [client],
  )
```

Then add `joinResult,` to the returned object (after `joinRoom,` at line 580) **and** to that `useMemo`'s dependency array (after `joinRoom,` at line 631).

- [ ] **Step 3: Typecheck the SDK source (catches edit errors)**

Run:
```bash
npm run typecheck -w @fluux/sdk
```
Expected: PASS (no errors). This typechecks the worktree SDK source.

- [ ] **Step 4: Build the SDK and sync dist into the main repo's untracked artifact**

`tsup` builds the worktree's `packages/fluux-sdk/dist`; the app's `tsc` resolves `@fluux/sdk` types from the **main** repo's `dist`, so sync them:

```bash
npm run build:sdk
rsync -a --delete packages/fluux-sdk/dist/ /Users/mremond/AIProjects/fluux-messenger/packages/fluux-sdk/dist/
```
Expected: build completes with no errors; rsync prints nothing. (`build:sdk` via tsup can pass while `tsc` fails — Step 5 is the real gate.)

- [ ] **Step 5: Verify the app now typechecks against the new export**

Run:
```bash
npm run typecheck -w @xmpp/fluux
```
Expected: PASS. (No app code uses `joinResult` from these hooks yet, so this simply confirms the synced dist is valid and the new optional action is present.)

- [ ] **Step 6: Commit**

```bash
git add packages/fluux-sdk/src/hooks/useRoomActive.ts packages/fluux-sdk/src/hooks/useRoom.ts
git commit -m "feat(sdk): expose joinResult on useRoomActive and useRoom hooks"
```

(`dist` is untracked, so nothing to commit there.)

---

## Task 3: Refactor `JoinRoomModal.showJoinError` to use the helper

**Files:**
- Modify: `apps/fluux/src/components/JoinRoomModal.tsx` (import + `showJoinError` at lines 53–86)
- Test (unchanged, must stay green): `apps/fluux/src/components/JoinRoomModal.test.tsx`

Behavior is identical — only the message mapping moves into the helper. The existing test file already mocks `joinResult` and a `RoomJoinError` stand-in and asserts every condition→key mapping plus focus behavior, so it is the regression guard.

- [ ] **Step 1: Add the helper import**

In `apps/fluux/src/components/JoinRoomModal.tsx`, after the existing import block (after line 8 `import { ModalShell } from './ModalShell'`), add:

```ts
import { getRoomJoinErrorMessage } from '@/utils/roomJoinError'
```

(Keep the existing `RoomJoinError` import on line 4 — it is still used for the field side-effects.)

- [ ] **Step 2: Replace `showJoinError`**

Replace the entire function (lines 53–86) with:

```ts
  const showJoinError = (err: unknown, passwordWasSent: boolean) => {
    // Field side-effects stay here; the message text comes from the shared helper.
    if (err instanceof RoomJoinError) {
      if (err.condition === 'not-authorized') {
        setShowPassword(true)
        setFocusTarget('password')
      } else if (err.condition === 'conflict') {
        setFocusTarget('nickname')
      }
    }
    setError(getRoomJoinErrorMessage(t, err, { passwordWasSent }))
  }
```

- [ ] **Step 3: Run the modal test suite to verify it stays green**

Run:
```bash
npm run test:run -w @xmpp/fluux -- src/components/JoinRoomModal.test.tsx
```
Expected: PASS (all existing cases, including the `join error handling` describe, still green).

- [ ] **Step 4: Typecheck**

Run:
```bash
npm run typecheck -w @xmpp/fluux
```
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/fluux/src/components/JoinRoomModal.tsx
git commit -m "refactor(rooms): JoinRoomModal uses shared getRoomJoinErrorMessage"
```

---

## Task 4: RoomView join prompt — toast on failure

**Files:**
- Modify: `apps/fluux/src/components/RoomView.tsx` (import; `useRoomActive()` destructure line 77; `RoomJoinPrompt onJoin` lines 584–592)
- Modify: `apps/fluux/src/components/RoomView.test.tsx` (mock `joinResult` + `RoomJoinError`; add test)

`addToast` (line 189) and `t` (line 76) are already in scope.

- [ ] **Step 1: Update the test mock — add `joinResult` and a `RoomJoinError` stand-in**

In `apps/fluux/src/components/RoomView.test.tsx`:

(a) Add a mock fn beside the others (near line 66 `const mockJoinRoom = vi.fn()`):

```ts
const mockJoinResult = vi.fn()
```

(b) In the `vi.mock('@fluux/sdk', () => ({ ... }))` factory, add `joinResult: mockJoinResult,` to the `useRoomActive` return object (right after `joinRoom: mockJoinRoom,` at line 120), and add a `RoomJoinError` export. Because `vi.mock` factories are hoisted, define the class with `vi.hoisted`. Add near the top of the file (after the imports):

```ts
const { RoomJoinError } = vi.hoisted(() => {
  class RoomJoinError extends Error {
    constructor(
      public roomJid: string,
      public condition: string,
      public errorType?: string,
      public text?: string,
    ) {
      super(text || `Room join failed: ${condition}`)
      this.name = 'RoomJoinError'
    }
  }
  return { RoomJoinError }
})
```

Then inside the `@fluux/sdk` factory object, add:

```ts
  joinResult: mockJoinResult,   // <-- inside useRoomActive() return, after joinRoom
```
and as a top-level factory export (anywhere in the returned object, e.g. after `useReferencedMessage`):

```ts
  RoomJoinError,
```

(c) Mock the join-warning hook so `confirmJoin` resolves deterministically. Add a new `vi.mock` near the other `vi.mock('@/...')` blocks:

```ts
vi.mock('@/hooks/useRoomJoinWarning', () => ({
  useRoomJoinWarning: () => ({ confirmJoin: () => Promise.resolve(true), warningDialog: null }),
}))
```

(d) Reset `mockJoinResult` in the existing `beforeEach` (where the other mocks are cleared) — find the `beforeEach` in the top-level `describe('RoomView', ...)` (around line 521) and add:

```ts
    mockJoinResult.mockResolvedValue(undefined)
```

- [ ] **Step 2: Write the failing test**

In the `describe('Non-joined room', ...)` block (around line 545), add:

```ts
    it('toasts a localized message when the join fails', async () => {
      const { useToastStore } = await import('@/stores/toastStore')
      useToastStore.setState({ toasts: [] })
      mockActiveRoom = createRoom({ joined: false })
      mockJoinRoom.mockResolvedValue(undefined)
      mockJoinResult.mockRejectedValue(
        new RoomJoinError('room@conference.example.com', 'registration-required'),
      )

      render(<RoomView />)
      fireEvent.click(screen.getByText(/rooms.joinToParticipate/))

      await waitFor(() => {
        const toasts = useToastStore.getState().toasts
        expect(toasts.some((t) => t.type === 'error' && t.message === 'rooms.membersOnly')).toBe(true)
      })
    })
```

> Note: the join button label is `rooms.joinToParticipate` (per the existing "Non-joined room" test). `useToastStore` is the real store (not mocked), so assert against its state. The `react-i18next` mock used by this file returns the key as the translation, so the message equals `rooms.membersOnly`.

- [ ] **Step 3: Run the test to verify it fails**

Run:
```bash
npm run test:run -w @xmpp/fluux -- src/components/RoomView.test.tsx
```
Expected: FAIL — the new test times out / no error toast (the component does not yet await `joinResult`). Existing RoomView tests still pass.

- [ ] **Step 4: Implement — add `joinResult` to the destructure and toast on failure**

In `apps/fluux/src/components/RoomView.tsx`:

(a) Add the helper import after the existing import block (after line 28 `import { useRoomJoinWarning } from '@/hooks/useRoomJoinWarning'`). RoomView only references the helper (not `RoomJoinError` directly — the helper owns that check), so import just the one symbol to avoid an unused-import lint error:

```ts
import { getRoomJoinErrorMessage } from '@/utils/roomJoinError'
```

(b) Add `joinResult` to the `useRoomActive()` destructure (line 77) — insert it next to `joinRoom`:

```ts
  const { activeRoom, activeMessages, activeTypingUsers, sendMessage, sendWhisper, sendReaction, sendPoll, votePoll, closePoll, sendCorrection, retractMessage, moderateMessage, sendChatState, setRoomNotifyAll, activeAnimation, sendEasterEgg, clearAnimation, clearFirstNewMessageId, updateLastSeenMessageId, joinRoom, joinResult, setRoomAvatar, clearRoomAvatar, fetchOlderHistory, continueRoomCatchUp, activeMAMState, submitRoomConfig, setSubject, destroyRoom, setAffiliation, setRole, targetMessageId, clearTargetMessageId } = useRoomActive()
```

(c) Replace the `RoomJoinPrompt onJoin` (lines 584–592):

```tsx
          <RoomJoinPrompt
            onJoin={async () => {
              // Issue #37: warn before joining a room that would expose the user's real JID.
              if (await confirmJoin(activeRoom.jid)) {
                try {
                  await joinRoom(activeRoom.jid, activeRoom.nickname)
                  await joinResult(activeRoom.jid)
                } catch (err) {
                  addToast('error', getRoomJoinErrorMessage(t, err))
                }
              }
            }}
          />
```

- [ ] **Step 5: Run the test to verify it passes**

Run:
```bash
npm run test:run -w @xmpp/fluux -- src/components/RoomView.test.tsx
```
Expected: PASS (new test + all existing RoomView tests).

- [ ] **Step 6: Typecheck**

Run:
```bash
npm run typecheck -w @xmpp/fluux
```
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add apps/fluux/src/components/RoomView.tsx apps/fluux/src/components/RoomView.test.tsx
git commit -m "feat(rooms): toast join failures from the RoomView join prompt"
```

---

## Task 5: BrowseRoomsModal — inline error on failure

**Files:**
- Modify: `apps/fluux/src/components/BrowseRoomsModal.tsx` (import; `useRoom()` destructure line 27; `handleJoinRoom` lines 241–252)
- Modify: `apps/fluux/src/components/BrowseRoomsModal.test.tsx` (mock `joinResult` + `RoomJoinError`; add test)

`t` is already in scope. The modal already renders an inline error banner (`{error && ...}` line 390) — reuse it via `setError`.

- [ ] **Step 1: Update the test mock — add `joinResult` and a `RoomJoinError` stand-in**

In `apps/fluux/src/components/BrowseRoomsModal.test.tsx`:

(a) Add a mock fn near the top (after line 7 `const mockJoinRoom = vi.fn()`):

```ts
const mockJoinResult = vi.fn()
```

(b) Add a hoisted `RoomJoinError` stand-in (after the imports, before the `vi.mock` calls):

```ts
const { RoomJoinError } = vi.hoisted(() => {
  class RoomJoinError extends Error {
    constructor(
      public roomJid: string,
      public condition: string,
      public errorType?: string,
      public text?: string,
    ) {
      super(text || `Room join failed: ${condition}`)
      this.name = 'RoomJoinError'
    }
  }
  return { RoomJoinError }
})
```

(c) In the `vi.mock('@fluux/sdk', ...)` factory, add `joinResult: mockJoinResult,` to the `useRoom()` return (after `joinRoom: mockJoinRoom,` at line 17) **and** add `RoomJoinError,` as a top-level factory export (e.g. after `generateConsistentColorHexSync`). Also add `joinResult: mockJoinResult,` to the **inline `useRoom` override** inside the `already joined rooms` test (line 529 block) so that test keeps a complete shape.

(d) In the top-level `beforeEach` (line 60), add:

```ts
    mockJoinResult.mockResolvedValue(undefined)
```

- [ ] **Step 2: Write the failing test**

In the `describe('join room functionality', ...)` block (after the existing `'should show error when join fails'` test, ~line 463), add:

```ts
    it('shows a mapped inline error when joinResult rejects with a RoomJoinError', async () => {
      mockJoinRoom.mockResolvedValue(undefined)
      mockJoinResult.mockRejectedValue(
        new RoomJoinError('general@conference.example.com', 'registration-required'),
      )

      render(<BrowseRoomsModal onClose={mockOnClose} />)

      await waitFor(() => {
        expect(screen.getByText('General Chat')).toBeInTheDocument()
      })

      fireEvent.click(screen.getAllByText('rooms.join')[0])

      await waitFor(() => {
        expect(screen.getByText('rooms.membersOnly')).toBeInTheDocument()
      })
      expect(mockOnClose).not.toHaveBeenCalled()
    })
```

- [ ] **Step 3: Run the test to verify it fails**

Run:
```bash
npm run test:run -w @xmpp/fluux -- src/components/BrowseRoomsModal.test.tsx
```
Expected: FAIL — `rooms.membersOnly` never appears (the component does not await `joinResult` yet). Note: the existing `'should show error when join fails'` test still passes because `joinRoom` rejecting a plain `Error` is caught and the helper returns `err.message`.

- [ ] **Step 4: Implement**

In `apps/fluux/src/components/BrowseRoomsModal.tsx`:

(a) Add the helper import after line 16 (`import { ModalShell } from './ModalShell'`):

```ts
import { getRoomJoinErrorMessage } from '@/utils/roomJoinError'
```

(b) Add `joinResult` to the `useRoom()` destructure (line 27):

```ts
  const { browsePublicRooms, joinRoom, joinResult, getRoom, setActiveRoom, mucServiceJid } = useRoom()
```

(c) Replace the `try`/`catch` body of `handleJoinRoom` (lines 241–252):

```ts
    try {
      // Issue #37: warn before joining a room that would expose the user's real JID.
      if (!(await confirmJoin(roomJid))) return
      await joinRoom(roomJid, nickname.trim())
      await joinResult(roomJid)
      void setActiveConversation(null)
      void setActiveRoom(roomJid)
      onClose()
    } catch (err) {
      setError(getRoomJoinErrorMessage(t, err))
    } finally {
      setJoiningRoom(null)
    }
```

- [ ] **Step 5: Run the test to verify it passes**

Run:
```bash
npm run test:run -w @xmpp/fluux -- src/components/BrowseRoomsModal.test.tsx
```
Expected: PASS (new test + all existing BrowseRoomsModal tests, including `'should show error when join fails'`).

- [ ] **Step 6: Typecheck**

Run:
```bash
npm run typecheck -w @xmpp/fluux
```
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add apps/fluux/src/components/BrowseRoomsModal.tsx apps/fluux/src/components/BrowseRoomsModal.test.tsx
git commit -m "feat(rooms): map join failures to the BrowseRoomsModal inline error"
```

---

## Task 6: RoomsList — toast on failure (`onActivate` + `onJoin`)

**Files:**
- Modify: `apps/fluux/src/components/sidebar-components/RoomsList.tsx`

No existing test file. `t` is already in scope (line 42). The handlers are built once in `handlersRef` and read the per-render `latestRef.current`, so `joinResult`, `addToast`, and `t` must be threaded through `latestRef`.

- [ ] **Step 1: Add imports**

(a) Add `useToastStore` import. After line 17 (`import { useSettingsStore } from '@/stores/settingsStore'`), add:

```ts
import { useToastStore } from '@/stores/toastStore'
import { getRoomJoinErrorMessage } from '@/utils/roomJoinError'
```

- [ ] **Step 2: Pull `joinResult` and `addToast`, thread them through `latestRef`**

(a) Add `joinResult` to the `useRoomActions()` destructure (line 51):

```ts
  const { joinRoom, joinResult, leaveRoom, setBookmark, removeBookmark, setActiveRoom } = useRoomActions()
```

(b) Subscribe to the toast action. After the `setActiveConversation` line (line 52), add:

```ts
  const addToast = useToastStore((s) => s.addToast)
```

(c) Add `joinResult`, `addToast`, and `t` to **both** `latestRef` lines (88 and 89):

```ts
  const latestRef = useRef({ setActiveConversation, setActiveRoom, joinRoom, joinResult, leaveRoom, removeBookmark, setBookmark, navigateToRooms, setEditingRoomJid, addToast, t })
  latestRef.current = { setActiveConversation, setActiveRoom, joinRoom, joinResult, leaveRoom, removeBookmark, setBookmark, navigateToRooms, setEditingRoomJid, addToast, t }
```

- [ ] **Step 3: Update `onActivate` to await the outcome and bail on failure**

Replace the `onActivate` handler (lines 109–122) with:

```ts
      onActivate: async (roomJid) => {
        const L = latestRef.current
        const room = roomStore.getState().getRoom(roomJid)
        const hasActive = !!roomStore.getState().activeRoomJid
        if (room?.joined) {
          void L.setActiveConversation(null)
          void L.setActiveRoom(roomJid)
        } else {
          try {
            await L.joinRoom(roomJid, room?.nickname ?? '')
            await L.joinResult(roomJid)
          } catch (err) {
            // Do not activate/navigate into a room we failed to join.
            L.addToast('error', getRoomJoinErrorMessage(L.t, err))
            return
          }
          void L.setActiveConversation(null)
          void L.setActiveRoom(roomJid)
        }
        L.navigateToRooms(roomJid, { replace: hasActive })
      },
```

- [ ] **Step 4: Update `onJoin` (fire-and-forget) to await the outcome and toast**

Replace the `onJoin` handler (lines 123–127) with:

```ts
      onJoin: (roomJid) => {
        const L = latestRef.current
        const room = roomStore.getState().getRoom(roomJid)
        void (async () => {
          try {
            await L.joinRoom(roomJid, room?.nickname ?? '')
            await L.joinResult(roomJid)
          } catch (err) {
            L.addToast('error', getRoomJoinErrorMessage(L.t, err))
          }
        })()
      },
```

- [ ] **Step 5: Typecheck**

Run:
```bash
npm run typecheck -w @xmpp/fluux
```
Expected: PASS.

- [ ] **Step 6: Lint the changed file (catches unused vars / hook rules)**

Run:
```bash
npm run lint -w @xmpp/fluux
```
Expected: PASS (no new errors).

- [ ] **Step 7: Commit**

```bash
git add apps/fluux/src/components/sidebar-components/RoomsList.tsx
git commit -m "feat(rooms): toast join failures from the sidebar room list"
```

---

## Task 7: useDeepLink — toast on failure, navigate regardless

**Files:**
- Modify: `apps/fluux/src/hooks/useDeepLink.ts`

No existing test file. Add `useTranslation` + `useToastStore` to the hook; wrap the room join; navigate regardless (matches the existing issue-#37 "navigate without joining" branch).

- [ ] **Step 1: Add imports**

(a) Add to the top imports (after line 12 `import { useNavigateToTarget } from './useNavigateToTarget'`):

```ts
import { useTranslation } from 'react-i18next'
import { useToastStore } from '@/stores/toastStore'
import { getRoomJoinErrorMessage } from '@/utils/roomJoinError'
```

- [ ] **Step 2: Pull `joinResult`, `t`, and `addToast` in the hook body**

(a) Add `joinResult` to the `useRoom()` destructure (line 25):

```ts
  const { joinRoom, joinResult, getRoomInfo, isNonAnonymousRoomAcknowledged } = useRoom()
```

(b) Immediately below it, add:

```ts
  const { t } = useTranslation()
  const addToast = useToastStore((s) => s.addToast)
```

- [ ] **Step 3: Wrap the join and navigate regardless**

Replace lines 81–86 (the join + navigate block in the `isRoom` branch):

```ts
      // Join the room (reuse the inspection to avoid a second disco query)
      const joinOptions = { ...(password ? { password } : {}), ...(features ? { knownFeatures: features } : {}) }
      try {
        await joinRoom(roomJid, nickname, Object.keys(joinOptions).length > 0 ? joinOptions : undefined)
        await joinResult(roomJid)
      } catch (err) {
        addToast('error', getRoomJoinErrorMessage(t, err))
      }

      // Navigate to the room regardless of outcome: on failure the user lands on
      // the room view with a Join button, and the toast carries the reason. Matches
      // the issue-#37 "navigate without joining" branch above.
      navigateToRoom(roomJid)
```

- [ ] **Step 4: Typecheck**

Run:
```bash
npm run typecheck -w @xmpp/fluux
```
Expected: PASS.

- [ ] **Step 5: Lint the changed file**

Run:
```bash
npm run lint -w @xmpp/fluux
```
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/fluux/src/hooks/useDeepLink.ts
git commit -m "feat(rooms): toast deep-link join failures"
```

---

## Task 8: Full verification

**Files:** none (verification only).

- [ ] **Step 1: Run the full app test suite**

Run:
```bash
npm run test:run -w @xmpp/fluux
```
Expected: PASS, no stderr. Pay attention to any test that renders `RoomsList` (e.g. via Sidebar/ChatLayout) — render-only usage is safe (the new actions are read but only invoked on click), but confirm nothing regressed.

- [ ] **Step 2: Run the SDK test suite**

Run:
```bash
npm run test:run -w @fluux/sdk
```
Expected: PASS (the hook change is additive; SDK MUC tests unaffected).

- [ ] **Step 3: Typecheck the whole repo**

Run:
```bash
npm run typecheck
```
Expected: PASS for all workspaces. (Confirms the synced SDK dist + all app edits.)

- [ ] **Step 4: Lint**

Run:
```bash
npm run lint -w @xmpp/fluux && npm run lint -w @fluux/sdk
```
Expected: PASS.

- [ ] **Step 5: (Optional) Manual demo verification**

Per the design, RoomsList and useDeepLink have no automated tests. If verifying manually: `npm run dev`, open the demo, and confirm a forced join failure surfaces a toast. (Worktree demo needs a `node_modules` symlink to the repo root — see the demo-verification notes; skip if not readily reproducible and note it in the PR.)

- [ ] **Step 6: Final review + push**

Confirm the branch contains the 7 feature/refactor commits. Open a PR with a concise description (what changed + why) and a note that RoomsList/useDeepLink rely on the shared-helper unit test rather than per-site harnesses. No Claude footer.

---

## Self-Review

**Spec coverage:**
- Shared helper → Task 1. ✓
- `joinResult` on `useRoomActive` + `useRoom` → Task 2. ✓
- JoinRoomModal refactor → Task 3. ✓
- RoomView toast → Task 4. ✓
- BrowseRoomsModal inline → Task 5. ✓
- RoomsList (`onActivate` + `onJoin`) → Task 6. ✓
- useDeepLink navigate-regardless + toast → Task 7. ✓
- "no new i18n keys", "no global modal prefill", "no password field added" → honored (no such steps). ✓
- Cross-boundary build/sync + test-mock updates → Task 2 Step 4; Tasks 4/5 Step 1. ✓
- `confirmJoin`-cancel-never-toasts → preserved by the early `return` in RoomView (Task 4c) and BrowseRoomsModal (Task 5c). ✓

**Type consistency:** `getRoomJoinErrorMessage(t, err, opts?)` signature is identical across Tasks 1, 3, 4, 5, 6, 7. `joinResult(roomJid): Promise<void>` matches `useRoomActions.ts:54`. `addToast('error', message)` matches `toastStore.ts` (`addToast(type, message)`). `RoomJoinError(roomJid, condition, errorType?, text?)` matches `packages/fluux-sdk/src/core/errors.ts:13`.

**Placeholder scan:** none — every code step contains complete code.

**Known nuance flagged for the implementer:** in Tasks 4 and 5, the component tests mock `@fluux/sdk` wholesale, so they must export a `RoomJoinError` stand-in **and** a `joinResult` mock, or the helper's `err instanceof RoomJoinError` and the component's `await joinResult(...)` break **even the existing tests**. Both steps are included.

---

## Post-implementation corrections

Two adjustments were made during execution (folded into the Task 7 commit):

1. **`useDeepLink` DOES have a test file** — `apps/fluux/src/hooks/useDeepLink.test.tsx` (note the `.tsx` extension; the plan's file-discovery checked only `.ts` and wrongly concluded "no existing test file"). Adding `await joinResult(...)` regressed 2 of its tests, because — exactly like Tasks 4/5 — its wholesale `@fluux/sdk` mock lacked a `joinResult` mock and a `RoomJoinError` stand-in, so the new code threw in the catch and `navigateToRoom` never ran. Fix: added `mockJoinResult` (+ `mockResolvedValue(undefined)` in `beforeEach`), a `vi.hoisted` `RoomJoinError` stand-in exported from the mock, and a new failure-path test asserting an error toast is surfaced **and** navigation still happens. The full app suite (3214 tests) then passed. Lesson: when auditing for an existing test harness, glob both `.ts` **and** `.tsx`.

2. **Deep-link password accuracy** — deep links can carry `?password=…` (already threaded into `joinOptions`), so the deeplink catch passes `{ passwordWasSent: !!password }` to `getRoomJoinErrorMessage`, yielding "incorrect password" rather than the generic "password required" when the server rejects a supplied password with `not-authorized`. (The other secondary paths genuinely never send a password, so they omit the option.)
