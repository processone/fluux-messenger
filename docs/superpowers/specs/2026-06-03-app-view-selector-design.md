# App view selector — centralized, reactive login/chat routing

- **Date:** 2026-06-03
- **Status:** Approved (design)
- **Area:** `apps/fluux` top-level routing (`App.tsx`)
- **Follow-up to:** `ded39358` (fix: return to LoginScreen after disconnect/terminal error)

## Context & problem

`App.tsx` decides which top-level surface to render — login form, reconnect
splash, tab-blocked screen, or the chat app — with a four-condition `if`-cascade:

```ts
if (isAutoReconnecting && !hasBeenOnline && status !== 'online') return <Splash/>
if (!isTauri && (tab.blocked || tab.takenOver)) return <TabBlocked/>
if (status === 'disconnected' || status === 'error' || (status !== 'online' && !hasSession)) return <LoginScreen/>
return <ChatLayout/>
```

This structure is fragile in three ways:

1. **Mixes reactive and non-reactive inputs.** Reactive `status` is combined
   with `hasSession = getSession() !== null` — a `sessionStorage` read that does
   not trigger re-renders. That mismatch caused the original bug: "Disconnect
   (keep data)" cleared the session and reset the store, but because
   `connectionStore.reset()` left `status`/`jid`/`error` unchanged after
   `disconnect()` had already set them, App never re-rendered to notice the
   cleared session, stranding the user on a stale "Déconnecté" ChatLayout. (The
   regression was introduced when `d551eb5e` narrowed App's subscription to
   `useConnectionStatus()`.)
2. **Precedence is implicit.** Four ordered `if`-returns whose order is
   load-bearing (the splash must precede login; the shipped fix's clause must sit
   after the splash). The invariants live only in line-order and comments.
3. **The component re-derives lifecycle the SDK already models.**
   `isAutoReconnecting` + `hasBeenOnline` + the flattened `status` string are a
   lossy reconstruction of distinctions the XState connection machine already
   knows (cold-restore vs. transient-recovery vs. terminal vs. fresh).

The shipped fix (`ded39358`) is correct but added a clause to this cascade. This
design replaces the cascade with a single, pure, fully-state-driven selector to
eliminate the bug *class*, not just the one instance.

## Goals

- One source of truth for "which top-level view", as a pure, exhaustively-tested
  function.
- Correctness driven by the reactive `status` (no reliance on a non-reactive
  `sessionStorage` read coinciding with a store change).
- Preserve current behavior for every connection state **except** the two
  approved UX improvements below.
- Keep `App.tsx` thin: orchestration hooks + a `switch` on the view.

## Non-goals / out of scope

- No change to the SDK connection machine or to the flattened `ConnectionStatus`
  API (`status` stays the public contract).
- No new reactive credential store (see "Key simplification").
- `AdminView`'s `clearSession()` is an ad-hoc-command-wizard reset (a different
  symbol from the login-session `clearSession`); unrelated, untouched.
- Not changing `LoginScreen`'s existing error-handling logic (keychain cleanup,
  server-field auto-reveal) beyond adding the localized message mapping.

## Key simplification: no reactive-credentials store needed

Initially this design assumed credential presence had to become reactive. It does
not. Every login-credential clear (`Sidebar` logout, `useSessionPersistence`
failed-reconnect, `clearLocalData`) **always coincides with a `status` change**,
so routing correctness comes entirely from keying on the reactive `status`.
Credential presence influences exactly one decision — *cold-load splash vs.
login* (rule 5). The only mid-flight credential change in that phase is a failed
auto-reconnect clearing creds, and it always coincides with `status === 'error'`,
which rule 1 routes to login ahead of the splash. So `canAutoReconnect` can be a
startup-time value (no store, no `useSyncExternalStore`, no wrapping
`save/clearSession`). Lower risk than a reactive-credential approach.

## Design

### View model

```ts
type AppView =
  | { kind: 'restoring' }                        // cold-load auto-reconnect in flight → splash
  | { kind: 'tabBlocked'; takenOver: boolean }   // web only
  | { kind: 'login' }                            // fresh start / logout / disconnect / terminal error
  | { kind: 'app' }                              // online, or transient reconnect after app shown
```

### Pure selector

```ts
function selectAppView(s: {
  status: ConnectionStatus            // reactive (connection store)
  canAutoReconnect: boolean           // mount-time: session creds OR (rememberMe + FAST token)
  hasShownApp: boolean                // latch: true on 'online', false again on 'disconnected'/'error'
  restoreFinished: boolean            // latch: true once 'online' OR 'error' (never reset) — initial restore resolved
  tab: { blocked: boolean; takenOver: boolean }
  isTauri: boolean
}): AppView
```

No React, no store imports, no side effects. Lives in
`apps/fluux/src/utils/selectAppView.ts` with its `AppView` type.

### Precedence (encoded once)

| # | Condition | → View | Rationale |
|---|-----------|--------|-----------|
| 1 | `status === 'error'` | `login` | Terminal; fast-fails even during cold-load (**tweak 2**). LoginScreen shows the reason (**tweak 1**). |
| 2 | `!isTauri && (tab.blocked || tab.takenOver)` | `tabBlocked` | Another tab owns the connection (web). |
| 3 | `status === 'online'` | `app` | Connected. |
| 4 | `hasShownApp && (status === 'connecting' || status === 'reconnecting')` | `app` | Transient recovery after the app has been shown — keep the user's place. |
| 5 | `canAutoReconnect && !restoreFinished` | `restoring` | *Initial* cold-load auto-reconnect, before it has ever resolved (covers idle `disconnected` + `connecting` + pre-first-online `reconnecting`) — no login flash. |
| 6 | otherwise | `login` | Fresh start, fresh-login `connecting` (no creds), logout/cancel `disconnected` after the app was shown. |

### Latches (two)

Both are pure functions of the `status` history, managed by a single
`useEffect(..., [status])` in `useAppView`; the selector receives them as pure
inputs.

**`hasShownApp`** — distinguishes "transient reconnect → stay in app" (rule 4)
from "logged out / re-login → login" (rule 6):
- `true` when `status === 'online'`; `false` when `status === 'disconnected'` or
  `'error'`; unchanged on transient states.
- Resetting on `disconnected`/`error` is what lets a re-login `connecting` (after
  a prior session) fall to `login` (rule 6) instead of flashing an empty app via
  rule 4.

**`restoreFinished`** — marks that the *initial* cold-load restore has resolved,
gating the splash (rule 5):
- `true` once `status` reaches `'online'` OR `'error'`; **never reset**.
- This is the correction over a naive `!hasShownApp` gate. After a logout with no
  page reload, `hasShownApp` resets to `false` while mount-time
  `canAutoReconnect` is still `true`, so `canAutoReconnect && !hasShownApp` would
  wrongly re-show the splash. `restoreFinished` is already `true` (set when we
  first went online — and a logout always follows an `online`), so rule 5 stays
  off → rule 6 `login`.

### `canAutoReconnect`

Computed once at mount from the current `isAutoReconnecting` init logic:
`getSession() !== null` OR (`xmpp-remember-me` && saved JID/server &&
`hasFastToken(jid)`). Extracted into a small helper so both the hook and tests
use the same definition. Mount-time (non-reactive) is correct because it only
gates rule 5, and rule 5 is additionally gated by `!restoreFinished` — so a stale
`canAutoReconnect === true` after a logout cannot pin the splash open (see
Latches). A failed cold-load reconnect also reaches `status === 'error'`, handled
by rule 1 ahead of rule 5. On a page reload the hook re-initializes
`canAutoReconnect` from current credentials.

### Behavior-parity validation (key rows)

| Scenario | status | canAutoReconnect | hasShownApp | restoreFinished | View |
|----------|--------|------------------|-------------|-----------------|------|
| Cold start, no creds | disconnected | false | false | false | login |
| Fresh login submitting | connecting | false | false | false | login (its own spinner) |
| Fresh login fails | error | false | false | → true | login + reason |
| Cold-load w/ creds, pre-connect | disconnected | true | false | false | restoring |
| Cold-load w/ creds, connecting | connecting | true | false | false | restoring |
| Cold-load auth failure | error | true | false | → true | **login + reason** (today: spins) ← tweak 2 |
| Online | online | * | → true | → true | app |
| Network drop after online | reconnecting | * | true | true | app |
| Logout (keep data) after online | disconnected | true (stale) | → false | true | login ← original bug |
| Re-login connecting (no reload) | connecting | true (stale) | false | true | login |
| Takeover/conflict after online | error | * | → false | → true | login + reason |

(`→` marks a value the latch effect sets on this transition. After being online,
`restoreFinished` stays `true`, which is what keeps the stale mount-time
`canAutoReconnect` from re-triggering the splash on logout / re-login.)

## UX tweaks

### Tweak 2 — fast-fail the cold-load splash

Built into precedence **rule 1**: `status === 'error'` routes to `login`
unconditionally, ahead of the `restoring` splash. A terminal error during the
initial auto-reconnect drops straight to login-with-reason instead of spinning
until an effect notices.

### Tweak 1 — localized terminal-error messages on LoginScreen

`LoginScreen` already renders `error` (the raw SDK string, English). The app is
localized (33 locales). Add an app-side classifier + i18n keys so the login
screen shows a friendly, localized reason:

- Helper `classifyLoginError(error: string): 'auth' | 'sessionReplaced' | 'connection' | null`
  - `auth`: existing `isAuthError(error)` (e.g. includes `not-authorized`)
  - `sessionReplaced`: SDK conflict string `Session replaced by another client`
  - `connection`: starts with `Connection failed`
  - `null`: unrecognized → fall back to showing the raw string (current behavior)
- New i18n keys under the existing `login.*` namespace:
  - `login.error.authFailed`, `login.error.sessionReplaced`, `login.error.connectionFailed`
- Add these keys to **all 33 locale files** (`apps/fluux/src/i18n/locales/*.json`:
  `ar be bg ca cs da de el en es et fi fr ga he hr hu is it lt lv mt nb nl pl pt
  ro ru sk sl sv uk zh-CN`) with proper per-language translations — not an `en`
  fallback. Translations are AI-generated and flagged for optional native-speaker
  review; `en` remains the runtime fallback only if a key is ever missing.

This is a `LoginScreen`-side addition; the selector/refactor is independent of it.
`AppView.login` carries no error — the selector decides *when* to show login,
`LoginScreen` decides *what* to show.

## File layout

- `apps/fluux/src/utils/selectAppView.ts` — `AppView` type + pure `selectAppView()`.
- `apps/fluux/src/utils/selectAppView.test.ts` — table-driven behavior spec.
- `apps/fluux/src/utils/canAutoReconnect.ts` (or co-located) — mount-time helper extracted from the current `isAutoReconnecting` init.
- `apps/fluux/src/hooks/useAppView.ts` — wires reactive inputs (`useConnectionStatus`, `hasShownApp` latch effect, `canAutoReconnect`, `tab`, `isTauri`) → `selectAppView`.
- `apps/fluux/src/App.tsx` — replace the cascade with `const view = useAppView(tabCoordination)` + `switch (view.kind)`. Remove `isAutoReconnecting`/`hasBeenOnline` local state (subsumed). Keep orchestration hooks above the switch and the `'online'` E2EE-bootstrap effect (and the `__wry_was_online` write) in the `app` path.
- `apps/fluux/src/components/LoginScreen.tsx` — add `classifyLoginError` + localized rendering.
- `apps/fluux/src/i18n/locales/*.json` — new `login.error.*` keys in all 33 locales.

## Testing strategy

- **`selectAppView.test.ts`** — exhaustive table over `status × canAutoReconnect × hasShownApp × tab × isTauri`. This is the regression spec; the original bug and both tweaks are explicit rows.
- **`useAppView.test.tsx`** — latch behavior (sets on `online`, clears on `disconnected`/`error`, unchanged on transient) and the mount-time `canAutoReconnect`.
- **`LoginScreen` tests** — `classifyLoginError` mapping + that the localized message renders for each terminal reason, raw fallback for unknown.
- **`App.reconnect.test.tsx`** (existing 8) — kept as end-to-end wiring coverage; all should remain green.

## Migration / rollout

Single PR. The shipped fix stays until the selector replaces it (the swap is
atomic within the PR). Behavior parity is enforced by the `selectAppView` table
mirroring today's post-fix mapping (plus the two approved tweaks). No SDK
changes; no data migration.

## Risks & mitigations

- **High blast radius (every top-level transition), near `0.16.0-beta.3`.**
  Mitigation: pure selector with an exhaustive test table that doubles as a
  behavior snapshot; existing integration tests retained; behavior-parity table
  above reviewed before merge.
- **Latch timing** (`hasShownApp` via effect runs after render). Mitigation:
  the selector's defaults route conservatively (rule 6 → login) so a one-frame
  lag cannot leak the app; covered by `useAppView` tests.
- **i18n coverage** (33 locales × 3 keys = 99 strings). All locales translated
  up front (per maintainer request). AI-generated translations are flagged for
  optional native-speaker review; `en` remains the runtime fallback if any key is
  missing. An `i18n` completeness test (if present) should be extended to assert
  the new keys exist in every locale.
