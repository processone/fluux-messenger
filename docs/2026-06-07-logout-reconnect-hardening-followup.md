# Logout / auto-reconnect hardening — follow-up plan

**Status:** Deferred until **after 0.16.0 stable**. Do not implement before then.
**Created:** 2026-06-07
**Context:** Follow-up to PR #463 ("Stop logout from immediately reconnecting").

This document captures two defense-in-depth items that were intentionally
**not** shipped in #463, so they are not lost. The live bug is already fixed;
these are hardening measures that touch the two riskiest files in the codebase
(the SDK connection state machine and `App.tsx` routing) and were deferred to
avoid editing core reconnect/routing paths during the 0.16.0 beta.

---

## Background: what #463 already shipped (Phase 1)

The recurring "click logout → immediately logged back in" regression had no
single stored answer to *"should we auto-reconnect?"*. It was re-derived on
every startup from (1) the reactive connection `status`, (2) a non-reactive
read of `getSession()` / `hasFastToken()`, and (3) an in-memory
`autoReconnectCheckedRef` that the post-logout Tauri/WRY `window.location.reload()`
silently resets. Every prior fix only tried to delete a surviving credential
fast enough to beat that reload — a race, so it kept regressing.

Phase 1 replaced the race with a **persisted reconnect-intent flag** as the
single source of truth, at the app layer:

- `apps/fluux/src/utils/reconnectIntent.ts` — `getReconnectIntent()` /
  `markLoggedOut()` / `markConnectActive()`. Stored in `localStorage` under
  `fluux:reconnect-intent` (survives the reload that wipes the in-memory ref);
  defaults to `'active'` when absent (backward compatible).
- `apps/fluux/src/utils/performLogout.ts` — `performLogout()` calls
  `markLoggedOut()` **synchronously as its first statement**, before any
  `await`. Existing credential deletions remain as defense-in-depth.
  `Sidebar.tsx` delegates to it.
- `useSessionPersistence.ts` — the auto-reconnect effect early-returns on
  `getReconnectIntent() === 'logged-out'` (gates both the sessionStorage Path A
  and the FAST-token Path B).
- `LoginScreen.tsx` — the keychain auto-connect effect early-returns on the
  same gate.
- `App.tsx` — `markConnectActive()` is called at the single `status === 'online'`
  chokepoint, which covers every path to online (manual login, keychain,
  Path A/B).
- `connectionMachine.test.ts` — pins the contract that the `disconnected` state
  ignores `SOCKET_DIED` and `TRIGGER_RECONNECT` (a future handler added there
  would now turn a test red).

**Net effect:** for a wrong reconnect to occur after logout, the persisted
intent **and** every credential deletion **and** the SDK's `credentials = null`
floor would all have to fail at once. The reload can outrace an async network
round-trip, but not a synchronous `localStorage.setItem` that already ran.

---

## Remaining structural fragilities (the two families)

These are documented in the diagnosis behind #463 and are *mitigated*, not
*eliminated*:

- **Family A (silent reconnect):** fully covered by the Phase 1 intent flag at
  the app layer. The SDK machine itself still has no notion of "the user does
  not want to be connected" — it relies on not being *asked* to reconnect.
- **Family B (wrong route / stranded on stale view):** mitigated by `ded39358`
  (terminal routing now keys on the reactive `status` first) and further
  hardened indirectly by Phase 1. The brittle coupling remains: the route in
  `App.tsx` still ANDs reactive `status` with a **non-reactive**
  `hasSession = getSession() !== null`.

---

## Item A — SDK-side XState `desired` guard (defense-in-depth)

### Motivation
Move a copy of "should we be connected?" into the SDK connection machine so the
machine itself refuses to *schedule* a reconnect when the user has logged out,
independent of the app. Today this is enforced only by the app not calling
`connect()` (Phase 1) plus the `disconnected` state ignoring reconnect events
by omission (now test-pinned).

### Why deferred
- Marginal safety: Phase 1 already makes the live bug impossible at the app
  layer; the machine does not self-reconnect from `disconnected` today.
- High blast radius: requires editing the **core reconnect transitions** —
  the worst place to introduce a subtle regression during beta. A guard bug
  would break *legitimate* reconnection (wake-from-sleep, network drop), which
  is worse than the bug we fixed.

### Design sketch
- Add `desired: 'connected' | 'disconnected'` to the machine context
  (`packages/fluux-sdk/src/core/connectionMachine.ts`).
- Set `desired = 'connected'` on user `CONNECT`; set `desired = 'disconnected'`
  on user-initiated `DISCONNECT` (the logout path), **not** on transport drops.
- Guard every reconnect-*scheduling* transition on `desired === 'connected'`:
  the `waiting → attempting` `after` (backoff) delay, and the
  `SOCKET_DIED` / `WAKE` / `VISIBLE` / `TRIGGER_RECONNECT` handlers.
- Persist `desired` alongside the machine's existing persisted state and mirror
  it into `connectionStore` if the app needs to read it (optional — the app
  already has `reconnectIntent` for its own decisions; avoid two sources of
  truth diverging — treat the SDK `desired` as transport-internal).

### Files
- `packages/fluux-sdk/src/core/connectionMachine.ts` (context + transitions)
- `packages/fluux-sdk/src/core/Connection.ts` (emit/set `desired` on
  connect/disconnect)
- `packages/fluux-sdk/src/core/connectionMachine.test.ts` (new cases)

### Tests
- After user `DISCONNECT`, the backoff `after` transition does **not** fire
  (no `waiting → attempting`) even when the timer elapses.
- `SOCKET_DIED` / `WAKE` / `VISIBLE` / `TRIGGER_RECONNECT` are no-ops while
  `desired === 'disconnected'`.
- After user `CONNECT`, a transport `SOCKET_DIED` **does** schedule a reconnect
  (no false negative — legitimate reconnection still works).

### Acceptance
Existing reconnect reliability tests stay green; new tests above pass; manual
wake-from-sleep and network-drop reconnection verified unchanged.

---

## Item B — `selectAppView` slice (remove non-reactive `hasSession` from routing)

### Motivation
Make the LoginScreen-vs-ChatLayout decision a pure function of **reactive**
inputs only, so the route can never get stuck because a `sessionStorage` write
did not trigger a re-render, and never depends on an unrelated store write
coincidentally changing a subscribed field.

### Why deferred / reconciliation
- Family B is already mitigated by `ded39358`; this is hardening, not a live-bug
  fix.
- There is a **broader `selectAppView` / `useAppView` refactor already planned
  and intentionally deferred until after 0.16.0 stable** (see the project memory
  note `project_app_view_selector.md`). A one-off divergent slice now would fork
  from that plan. **Fold this slice into that refactor** when it is picked up
  rather than landing it separately.

### Design sketch
- Extract the current routing expression in `App.tsx` into a pure
  `selectAppView(status, ...)` that does **not** read `getSession()` /
  `hasFastToken()` internally.
- Drive the decision from reactive store fields App already subscribes to
  (`status`, and the existing `isAutoReconnecting` / `hasBeenOnline` UI state).
- Remove the `!hasSession` clause from the render decision (it is dead-weight
  coupling after `ded39358`). Keep `getSession()` only where it is genuinely a
  non-render concern.

### Files
- `apps/fluux/src/App.tsx` (extract + call the selector)
- new `apps/fluux/src/App.selectView.ts` (or co-located) — pure function
- new `apps/fluux/src/App.selectView.test.ts`

### Tests
- `selectAppView` returns `'login'` for `disconnected` / `error`, `'chat'` for
  `online`, with **no** dependency on `getSession()` (a spy on `getSession`
  asserts it is never called by the routing decision).
- Retain the existing `App.reconnect.test.tsx` cases (transient-reconnect
  spinner behavior must be preserved exactly).

### Risks
- `App.tsx` is the riskiest file (routing). The slice is mechanical (move an
  existing expression into a pure function) but must preserve the
  spinner / transient-reconnect behavior exactly — the retained
  `App.reconnect.test.tsx` cases are the safety net.

---

## Trigger / when to pick up
After **0.16.0 stable** ships. Prefer landing each item as its own PR, and
**not** while other reconnect/routing churn is in flight (so any regression is
easy to bisect).

## Validation that matters most
Independent of these items: confirm with the original reporter that logout now
sticks on their setup after #463. Real-user confirmation outweighs additional
defense-in-depth.

## Cross-references
- PR #463 — Phase 1 (shipped)
- `docs/CONNECTION.md` — connection / reconnect overview
- Project memory: `project_app_view_selector.md` (deferred routing refactor),
  and the logout-regression diagnosis notes
