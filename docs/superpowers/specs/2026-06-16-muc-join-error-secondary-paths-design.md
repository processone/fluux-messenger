# MUC Join Error Feedback — Secondary Join Paths (Approach B follow-up)

- **Date:** 2026-06-16
- **Status:** Approved (design)
- **Area:** App (`apps/fluux` — RoomView, BrowseRoomsModal, RoomsList, useDeepLink, JoinRoomModal, a new util) + SDK hooks (`useRoomActive`, `useRoom`)
- **Parent spec:** [2026-06-16-muc-join-error-handling-design.md](./2026-06-16-muc-join-error-handling-design.md) — this implements its **Non-goals → "Background toasts for autojoin / bookmark / deeplink join failures … layer the event-based Approach B on later."**

## Problem

`JoinRoomModal` awaits `joinResult(jid)` and maps a typed `RoomJoinError` to UI. Every *other* join entry point still ignores the outcome: it calls `joinRoom()` (which resolves the instant the presence is sent) and never awaits `joinResult()`. A failed join (wrong password, banned, members-only, nickname clash, …) just flips the local `isJoining`/spinner back off with **no user-visible feedback**.

Affected call sites:

| Site | Current code | Feedback today |
|---|---|---|
| `apps/fluux/src/components/RoomView.tsx` (`RoomJoinPrompt onJoin`) | `await joinRoom(jid, nick)` | none |
| `apps/fluux/src/components/BrowseRoomsModal.tsx` (`handleJoinRoom`) | `await joinRoom(...)` in `try/catch` | a `catch` that never fires (joinRoom resolves on send) |
| `apps/fluux/src/components/sidebar-components/RoomsList.tsx` (`onActivate`, `onJoin`) | `await joinRoom` / `void joinRoom` | none |
| `apps/fluux/src/hooks/useDeepLink.ts` (room branch) | `await joinRoom(...)` | errors swallowed by `handleXmppUriSafely`'s `console.error` |

## Goal

Surface *why* a join initiated from these paths failed, using a localized message, reusing the parent spec's `rooms.*` keys. Keep the condition→message mapping identical to the modal's by extracting it into one shared helper.

## Non-goals

- **No global "open `JoinRoomModal` pre-filled" mechanism.** Decision: for a password-protected room reached via a secondary path, just surface the `rooms.passwordRequired` message; the user opens the Join Room dialog (the one surface with a password field) to actually enter it. `JoinRoomModal` is opened only from `Sidebar.tsx` local state — a programmatic prefill-open would require new cross-cutting wiring (Sidebar + a global trigger + all four sites), which YAGNI rules out for this follow-up.
- **No password field** added to `BrowseRoomsModal` or `RoomsList`.
- **No new i18n keys** — all 8 (`passwordRequired`, `incorrectPassword`, `nicknameInUse`, `membersOnly`, `bannedFromRoom`, `roomFull`, `registeredNicknameRequired`, `roomNotFound`) plus `failedToJoinRoom` already exist in `en.json` (all 33 locales) and are already em-dash-free.
- **No change to `joinRoom()` semantics** or the SDK MUC core — the SDK side (the `joinResult` promise, error routing, `RoomJoinError`) shipped with the parent spec.

## Design

### 1. Shared mapping helper (new) — `apps/fluux/src/utils/roomJoinError.ts`

A pure function, the single source of truth for join-error wording:

```ts
import { RoomJoinError } from '@fluux/sdk'

// Matches the convention in messagePreviewText.ts / presence.ts.
type TranslateFn = (key: string, options?: Record<string, unknown>) => string

/**
 * Map a room-join failure to a localized, user-facing message.
 * Shared by JoinRoomModal (inline error) and the secondary join paths
 * (RoomView prompt, RoomsList, BrowseRoomsModal, deep link) so the wording
 * stays in sync. Field side effects (revealing the password input, focusing
 * the nickname) stay in the modal — this resolves message text only.
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

This is the `switch` lifted verbatim out of `JoinRoomModal.showJoinError`.

### 2. SDK: expose `joinResult` on the two hooks that lack it

`client.muc.joinResult` already exists; only `useRoomActions` re-exports it. Add the identical `useCallback` plus an entry in the memoized actions object **and** its deps array to:

- `packages/fluux-sdk/src/hooks/useRoomActive.ts` (consumed by RoomView)
- `packages/fluux-sdk/src/hooks/useRoom.ts` (consumed by BrowseRoomsModal, useDeepLink)

```ts
const joinResult = useCallback(
  async (roomJid: string): Promise<void> => {
    await client.muc.joinResult(roomJid)
  },
  [client],
)
```

Purely additive to the hook return. Per the worktree-dist gotcha, run `npm run build:sdk` and sync the built dist before app typecheck. `useRoomActions` is unchanged (already has it).

### 3. Call-site changes

Each site keeps its existing success flow; the new line is `await joinResult(jid)` immediately after `joinRoom(...)`, with feedback in the `catch`.

**a. `JoinRoomModal.tsx` (refactor, no behavior change).** `showJoinError` keeps its field side-effects but delegates the message:

```ts
const showJoinError = (err: unknown, passwordWasSent: boolean) => {
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

**b. `RoomView.tsx` — `RoomJoinPrompt onJoin`.** `addToast` (`useToastStore`) and `t` already in scope; add `joinResult` to the `useRoomActive()` destructure:

```ts
onJoin={async () => {
  if (await confirmJoin(activeRoom.jid)) {
    try {
      await joinRoom(activeRoom.jid, activeRoom.nickname)
      await joinResult(activeRoom.jid)
    } catch (err) {
      addToast('error', getRoomJoinErrorMessage(t, err))
    }
  }
}}
```

**c. `BrowseRoomsModal.tsx` — `handleJoinRoom`.** Add `joinResult` to the `useRoom()` destructure; map the error into the **existing inline banner** (`setError`). The modal stays open so the user can pick another room or fix the nickname:

```ts
try {
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

**d. `RoomsList.tsx` — `onActivate` + `onJoin`.** The handlers are built once in `handlersRef` and read `latestRef.current`. Add `joinResult` (from `useRoomActions()`), `addToast` (new `useToastStore` subscription), and `t` to the `latestRef` object (both the initializer and the per-render `latestRef.current = {…}`).

- `onActivate`: on join failure, toast and **return before** `setActiveConversation`/`setActiveRoom`/`navigateToRooms` — never enter/navigate to a room we failed to join.
- `onJoin` (fire-and-forget): wrap the body in `void (async () => { … })()` so the `await joinResult` + `catch` toast work.

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
      L.addToast('error', getRoomJoinErrorMessage(L.t, err))
      return
    }
    void L.setActiveConversation(null)
    void L.setActiveRoom(roomJid)
  }
  L.navigateToRooms(roomJid, { replace: hasActive })
},
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

**e. `useDeepLink.ts` — room branch.** Add `useTranslation` (`t`) and `useToastStore` (`addToast`) to the hook; wrap the join, then **navigate regardless** of outcome (matches the existing issue-#37 "navigate without joining" branch — landing the user on the room view with a Join button; the toast carries the failure reason):

```ts
try {
  await joinRoom(roomJid, nickname, Object.keys(joinOptions).length > 0 ? joinOptions : undefined)
  await joinResult(roomJid)
} catch (err) {
  addToast('error', getRoomJoinErrorMessage(t, err))
}
navigateToRoom(roomJid)
```

`handleXmppUri` is reassigned to `handleXmppUriRef.current` every render, so it closes over the current `t`/`addToast` (no ref plumbing needed).

### Error-handling nuances

- **`confirmJoin` cancel never toasts.** RoomView and BrowseRoomsModal `return` from the `confirmJoin` guard *before* `joinResult`, so declining the issue-#37 real-JID warning is silent. (RoomsList and useDeepLink don't gate on `confirmJoin` today; out of scope — unchanged.)
- **`joinResult()` resolves immediately when no deferred is registered** (already-joined / no-op join), so success paths are untouched.
- **If `joinRoom` itself rejects** (e.g. offline), the same `catch` runs; the helper falls to the `err.message` branch.

## Testing

- **New** `apps/fluux/src/utils/roomJoinError.test.ts` — pure unit test: each `condition` → expected key; both `not-authorized` variants (`passwordWasSent` true/false); a `default`/`timeout` with and without `err.text`; a plain `Error`; a non-Error value. Use an identity `t` (`(k) => k`) so assertions read as keys.
- **`JoinRoomModal.test.tsx`** stays green unchanged (internal refactor; message mapping identical).
- **`BrowseRoomsModal.test.tsx`** — add a case: a join whose `joinResult` rejects with a `RoomJoinError` renders the mapped message in the inline banner and leaves the modal open.
- **`RoomView.test.tsx`** — add a representative toast case: `RoomJoinPrompt` join failure calls `addToast('error', …)` with the mapped message.
- **RoomsList / useDeepLink** have no existing test harness; add focused coverage only if low-friction, otherwise rely on the shared-helper test + manual/demo verification. Note any skipped coverage in the PR.
- **Cross-boundary:** `npm run build:sdk` + dist sync so the app sees `joinResult` on `useRoomActive`/`useRoom`; if a test file's `vi.mock('@fluux/sdk', …)` stubs those hooks with a fixed object, add `joinResult` to the stub (spread `importOriginal` where used). Run the SDK unit tests, the app tests, `npm run typecheck`, and the linter before commit.

## File reference index

| Concern | Location |
|---|---|
| New shared helper | `apps/fluux/src/utils/roomJoinError.ts` (+ `.test.ts`) |
| Modal mapping (source of the lifted `switch`) | `apps/fluux/src/components/JoinRoomModal.tsx:53` |
| RoomView join prompt | `apps/fluux/src/components/RoomView.tsx:584` |
| Browse modal join | `apps/fluux/src/components/BrowseRoomsModal.tsx:233` |
| RoomsList handlers | `apps/fluux/src/components/sidebar-components/RoomsList.tsx:101` |
| Deep-link room branch | `apps/fluux/src/hooks/useDeepLink.ts:81` |
| `joinResult` hook additions | `packages/fluux-sdk/src/hooks/useRoomActive.ts`, `useRoom.ts` (mirror `useRoomActions.ts:54`) |
| Toast mechanism | `apps/fluux/src/stores/toastStore.ts` (`addToast`), mounted `ChatLayout.tsx:849` |
| i18n keys | `apps/fluux/src/i18n/locales/en.json:203-213` |
