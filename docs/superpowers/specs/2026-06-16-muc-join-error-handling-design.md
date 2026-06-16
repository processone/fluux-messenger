# MUC Join Error Handling + Room Password UI

- **Date:** 2026-06-16
- **Status:** Approved (design)
- **Area:** SDK (`packages/fluux-sdk` — MUC module) + App (`apps/fluux` — JoinRoomModal, i18n)
- **UX_REVIEW item:** 5.3 — "No password-room or nickname-conflict UI captured. JoinRoomModal collects JID + nickname only."

## Problem

When joining a MUC fails, the user gets no useful feedback. Three layered causes:

1. **Join errors are dropped before the MUC module sees them.** `MUC.handle()` only dispatches presences that carry `<x xmlns='http://jabber.org/protocol/muc#user'>` (`packages/fluux-sdk/src/core/modules/MUC.ts:128`). A XEP-0045 join-error presence is
   `<presence from='room@svc/nick' type='error'><x xmlns='…/muc'/><error type='auth'><not-authorized/></error></presence>` —
   it echoes the **`muc`** namespace (or nothing), **not `muc#user`**. So `handle()` returns `false` and the error is never processed. (Even when a server *does* echo `muc#user`, the presence lands at `MUC.ts:160-162`, which only `console.error`s and returns.)

2. **Because the error is dropped, the pending join times out and retries** (`handleJoinTimeout`, `MUC.ts:357`) until it exhausts `MAX_JOIN_RETRIES` — instead of failing fast with a reason.

3. **`joinRoom()` resolves the instant the presence is sent** (`MUC.ts:540-543`), never waiting for the outcome. The modal's `await joinRoom()` therefore resolves immediately regardless of success/failure, so its existing `try/catch` can never fire.

The SDK already *parses* the error (`parseXMPPError` → `{ type, condition, text }`, `packages/fluux-sdk/src/utils/xmppError.ts`) and already *supports* sending a password (`joinRoom(jid, nick, { password })` builds the correct `<password>` element, `MUC.ts:512-514`, plumbed through `useRoomActions`). What is missing is **routing the error, settling the join with a reason, and the UI to act on it.**

## Goals

- Surface *why* a join failed and let the user recover where possible (enter/correct password, change nickname).
- Let a user supply a room password — both proactively (upfront) and reactively (when the server demands one).
- Stop the pointless retry loop on terminal errors (auth/conflict/forbidden).

## Non-goals (follow-ups)

- Background toasts for **autojoin / bookmark / deeplink** join failures (banned/members-only failing silently outside the modal). This is a separate surface; layer the event-based Approach B on later.
- Persisting a one-off password beyond the existing bookmark `password` field on `RoomEntity`.
- Membership/registration flows (XEP-0045 registration) for members-only rooms — we only *explain* the `registration-required` failure.

## Approach

**Promise-based outcome (chosen over an event/store-field approach).** The join becomes await-able for the *real* outcome via a dedicated `joinResult(roomJid)` promise that resolves on the self-presence (status 110) confirmation and **rejects with a typed `RoomJoinError`** on a terminal error or after retry exhaustion. This fits the modal's imperative "click → await → react" flow and reuses its existing `try/catch`; `error.condition` drives the UI.

`joinRoom()` itself is left **unchanged** (it still resolves when the presence is sent). It has ~6 app callers — including fire-and-forget ones (`RoomView` `onJoin`, `RoomsList`'s `void joinRoom(...)`) — and ~12 SDK tests that rely on the await-then-feed-presence pattern; making `joinRoom()` reject would turn those into unhandled rejections and force rewriting the tests. A separate opt-in awaitable surfaces the outcome with no blast radius on existing callers.

Rejected alternatives:
- **Event / store field** (`room:join-error` event or `joinError` on the entity): aligns with the store-binding pattern and would also serve background failures, but is awkward for a modal (listener keyed by JID, race handling, cleanup) and risks the frozen-derived-value class. Kept in reserve for the out-of-scope background-toast follow-up.
- **Both:** more code than this PR needs (YAGNI).

## Design

### SDK

**1. `RoomJoinError`** — new exported error type (added to `packages/fluux-sdk/src/index.ts`):

```ts
class RoomJoinError extends Error {
  roomJid: string
  condition: string    // XMPP condition, e.g. 'not-authorized' | 'conflict' | 'registration-required' | 'forbidden' | 'timeout'
  errorType?: string   // XMPP error type: 'auth' | 'cancel' | 'modify' | 'wait' | …
  text?: string        // server-provided text, if any
}
```

`'timeout'` is a synthetic condition used when retries are exhausted (no server condition available).

**2. Route the error.** In `MUC.handle()`, also dispatch a `type='error'` presence whose **bare from-JID is in `pendingJoins`** (precisely scopes it to joins we initiated; avoids grabbing unrelated error presences and does not depend on the server echoing any `<x>` namespace). On such a presence:
- `parseXMPPError(stanza)` → condition/type/text.
- **Clear the join timeout** so no retry runs (a terminal auth/conflict/forbidden error will never succeed on retry).
- **Reject** the pending join's deferred with `RoomJoinError`.
- Keep the existing cleanup emit `room:updated { joined: false, isJoining: false }` and `pendingOccupants.delete(roomJid)`.

**3. Add `joinResult(roomJid)` — a dedicated outcome promise.** `joinRoom()` additionally registers a **join-outcome deferred** in a new `joinDeferreds` map (`Map<string, { promise, resolve, reject, settled }>`), created before the presence is sent. A new public method `joinResult(roomJid): Promise<void>` returns that deferred's promise. It is settled exactly once by:
- **success** — the self-presence (status 110) join-confirmed path (`MUC.ts:224` `isSelf` branch) → `resolve()`;
- **terminal error** — the routing in (2) → `reject(RoomJoinError)`;
- **retry exhaustion** — `handleJoinTimeout` after `MAX_JOIN_RETRIES` → `reject(RoomJoinError(roomJid, 'timeout'))` (added alongside the existing `room:updated` emit).

The deferred is **reused across timeout retries** (a retry sees a still-pending deferred and keeps it) and settled **in place** (not deleted) so a `joinResult()` called slightly later still observes the result; the next fresh join for that room replaces it, and `cleanup()` clears the map. The deferred carries an internal no-op `.catch()` so SDK-internal joins that never call `joinResult()` don't raise unhandled-rejection warnings — independent consumers still observe the rejection. `joinResult()` for a room with no registered deferred resolves immediately.

**4. Hook + modal wiring.** Add a `joinResult` action to `useRoomActions` (`return await client.muc.joinResult(roomJid)`). The modal calls `await joinRoom(jid, nick, { password })` then `await joinResult(jid)` — the second await is what surfaces `RoomJoinError`. `joinRoom()` and its other callers are untouched, so no call-site audit is needed.

### App — `JoinRoomModal.tsx`

One password `<input type="password">`, surfaced two ways (per chosen UX):
- A collapsible **"This room is password-protected"** toggle the user can open proactively (upfront, optional).
- Auto-expanded and focused when the server returns `not-authorized`.

On submit, pass `{ password }` to `joinRoom` when present. Keep the entered JID/nick across a failed attempt so the user can correct one field and retry. Track a local `passwordAttempted` flag to disambiguate the two `not-authorized` messages (the condition is identical; only the modal knows whether a password was already sent).

**Condition → UX mapping** (legacy codes shown for reference only; the code switches on `condition`):

| `condition` (code) | Modal reaction | i18n key |
|---|---|---|
| `not-authorized` (401), no password sent | Reveal + focus password field | `rooms.passwordRequired` |
| `not-authorized` (401), password was sent | Keep field, show error | `rooms.incorrectPassword` |
| `conflict` (409) | Focus + mark nickname field | `rooms.nicknameInUse` |
| `registration-required` (407) | Inline message, no retry field | `rooms.membersOnly` |
| `forbidden` (403) | Inline message (terminal) | `rooms.bannedFromRoom` |
| `service-unavailable` (503) | Inline message | `rooms.roomFull` |
| `not-acceptable` (406) | Inline message | `rooms.registeredNicknameRequired` |
| `item-not-found` (404) | Inline message | `rooms.roomNotFound` |
| default / `timeout` | Existing generic message + server `text` if any | `rooms.failedToJoinRoom` |

### i18n

New keys under `rooms` in `apps/fluux/src/i18n/locales/en.json`, translated into all 33 locales:

| Key | English |
|---|---|
| `rooms.passwordProtected` | "This room is password-protected" (toggle label) |
| `rooms.roomPassword` | "Password" (field label) |
| `rooms.passwordRequired` | "This room is password-protected. Enter the password to join." |
| `rooms.incorrectPassword` | "Incorrect password." |
| `rooms.nicknameInUse` | "That nickname is already in use in this room." |
| `rooms.membersOnly` | "This room is members-only — you need to be a member to join." |
| `rooms.bannedFromRoom` | "You've been banned from this room." |
| `rooms.roomFull` | "This room is full." |
| `rooms.registeredNicknameRequired` | "This room requires your registered nickname." |
| `rooms.roomNotFound` | "Room not found." |

## Testing

**SDK (`MUC.test.ts`):**
- A `type='error'` presence (with `<x muc>` and with no `<x>` — the realistic shapes that miss the `muc#user` gate) from a room with an in-flight join settles `joinResult()` as a **reject** carrying the right `condition` (cover `not-authorized`, `conflict`, `registration-required`, `forbidden`).
- A terminal error **clears the timeout and does not retry** (regression guard against the current retry-until-timeout behavior).
- Self-presence (110) **resolves** `joinResult()`.
- Retry exhaustion rejects `joinResult()` with `condition: 'timeout'`.
- Existing join/error tests (which feed `<x muc#user>` error presences and `await joinRoom()`) remain green — `joinRoom()` semantics are unchanged.

**App (`JoinRoomModal.test.tsx`):**
- Each condition renders the correct message/field state per the mapping table.
- `not-authorized` reveals + focuses the password field; a second `not-authorized` after a password was sent shows "Incorrect password."
- `conflict` lets the user edit the nickname and resubmit.
- Manual "password-protected" toggle reveals the field upfront and the password is passed to `joinRoom`.

**Cross-boundary note:** `RoomJoinError` is a new SDK export — rebuild the SDK (`npm run build:sdk`) before app typecheck, and add it to the app test `vi.mock('@fluux/sdk', …)` (spread `importOriginal`) so app tests resolve it.

## File reference index

| Concern | Location |
|---|---|
| Handler gate (drops join errors) | `packages/fluux-sdk/src/core/modules/MUC.ts:128` |
| No-nick / nick error branches | `packages/fluux-sdk/src/core/modules/MUC.ts:147`, `:160` |
| Self-presence (110) success path | `packages/fluux-sdk/src/core/modules/MUC.ts:173` |
| Join timeout / retry | `packages/fluux-sdk/src/core/modules/MUC.ts:357`, `:390` |
| `joinRoom()` + password element | `packages/fluux-sdk/src/core/modules/MUC.ts:440`, `:512` |
| Error parsing | `packages/fluux-sdk/src/utils/xmppError.ts` |
| Room types (`password?`, `isJoining`) | `packages/fluux-sdk/src/core/types/room.ts:163` |
| `joinRoom` action hook | `packages/fluux-sdk/src/hooks/useRoomActions.ts:46` |
| Modal | `apps/fluux/src/components/JoinRoomModal.tsx` |
| i18n (rooms) | `apps/fluux/src/i18n/locales/en.json:170` |
