# Display-gated keepalive as the reconnect authority

- **Date:** 2026-06-19
- **Status:** Draft — awaiting maintainer review
- **Area:** macOS connection lifecycle (Tauri + SDK)
- **Related:** [docs/CONNECTION.md](../../CONNECTION.md), [docs/2026-06-07-logout-reconnect-hardening-followup.md](../../2026-06-07-logout-reconnect-hardening-followup.md), [docs/MAM_CATCHUP.md](../../MAM_CATCHUP.md)

## 1. Problem

On macOS, Fluux currently reconnects only when the app window is **focused** after a sleep/wake cycle, not when the Mac is simply in use again. Field evidence (`~/Library/Logs/com.processone.fluux/fluux.log.2026-06-19`):

1. `09:44:56` `system-will-sleep`; `09:46:52` socket dies (`code 1006`).
2. Reconnect backoff attempts 1–5 (1→2→4→8→16s) all fail with `UpstreamConnectFailed` and **churn through the start of sleep** — the JS `setTimeout` ladder kept firing while the network was down.
3. `09:51` a backoff attempt succeeds during a brief DarkWake and SM-resumes; the Mac immediately returns to deep sleep.
4. From `09:51` → `12:21` (~2.5h) the machine is asleep. The native proxy holds TCP `conn_id=8` open the whole time — a **zombie socket** carrying no traffic. No disconnect event fires, so nothing triggers a reconnect, and no JS runs to detect it.
5. `12:21:31` real wake. macOS **dropped** `NSWorkspaceDidWakeNotification` — the deferred wake fired `+9022s` after the real wake because only `NSApplicationDidBecomeActiveNotification` (app focus) arrived. That focus event → `system-did-wake-deferred` → `window.location.reload()` → conn_id=8 torn down → SM resumed. **That focus is why the user saw reconnection only on refocus.**

Two root causes:

- **The reconnect path is keyed on app focus**, via `system-did-wake-deferred` (emitted from the `NSApplicationDidBecomeActiveNotification` observer, `main.rs:900-950`, `940-944`). Because macOS drops the system wake notification, focus becomes the only reliable trigger.
- **The native keepalive — which is focus-independent and immune to dropped OS notifications — is not display-aware.** It fires every 30s (`main.rs:1939-1954`) and routes to `handleKeepaliveTick` (`Connection.ts:984-994`), but it neither suppresses reconnects during DarkWake (battery churn) nor acts as the authoritative wake/health driver.

## 2. Goal & contract

Reconnect as fast as possible whenever the Mac is **actively in use** (primary display on), regardless of whether the Fluux window is focused — because notifications require a live connection. Do **not** reconnect while the primary display is off (closed lid with no external screen, idle screen-off) to avoid DarkWake/PowerNap battery churn.

**Behavioral contract**

1. **Primary display off** → do **not** reconnect; hold reconnect attempts. (Wording is "primary/active display off", not "lid closed": clamshell with an awake external display correctly counts as in-use — `CGMainDisplayID` reports the external display.)
2. **Primary display on** → reconnect ASAP, **regardless of app focus**, subject only to the existing auto-reconnect intent gate.
3. **Webview reload** (the WRY blank-render fix, wry#184) is **decoupled** from reconnect: it happens when the window is *shown* and only if the prior hidden span exceeded `SLEEP_THRESHOLD_MS`. Focus is no longer the network-reconnect trigger — only the rendering trigger.

**Non-goals:** changing the Linux/Windows wake handling; changing the exponential-backoff math; replacing the WRY reload with a lighter render-repair (noted as a future investigation).

## 3. Architecture: the native keepalive becomes the reconnect authority

The native Rust keepalive thread is the only wake/health signal that is both **focus-independent** and **immune to dropped OS notifications** and WKWebView throttling (`backgroundThrottling: "disabled"` at `tauri.conf.json:42`, plus `disable_app_nap()` at `main.rs:880-898`). We promote it to the authoritative driver and add a single new signal — `displayActive` — that maps exactly to the contract.

Signal flow:

```
Rust 30s loop ──(measures real elapsed; probes CGDisplayIsAsleep)──▶ emit "xmpp-keepalive" { displayActive, sleptMs }
        │  (KEEPS emitting every 30s even when displayActive=false)
        ▼
usePlatformState Effect 5 ──gate: displayActive && intent==='active' && !reloadCooldown──▶ client.handleKeepaliveTick(displayActive, sleptMs)
        │                                                  └─ updates displayActiveRef (read by Effect 3 heartbeat & Effect 4 visibility)
        ▼
SDK Connection.handleKeepaliveTick ──displayActive?──▶ verify/reconnect ; ──!displayActive?──▶ no-op
        ▼
connectionMachine: reconnecting.paused (no timer) ◀──displayAsleep──▶ reconnecting.waiting (backoff ladder)
```

`system-did-wake` / `system-did-wake-deferred` are **demoted to reload-only** (rendering), no longer reconnect triggers.

## 4. The changes

Four core mechanism changes (#1–#4) plus two cross-cutting hardening changes (#5 intent guard, #6 server-sourced resume timeout).

### #1 — Native keepalive: wake-aware + display-aware (Rust)
`apps/fluux/src-tauri/src/main.rs:1939-1954`

- Replace the bare `sleep(30s)` loop with one that **measures real wall-clock elapsed** per iteration. If `elapsed` exceeds a generous floor (`>= ~120s`, aligned conceptually with `SLEEP_THRESHOLD_MS=180000`, well above 30s + scheduler jitter), the machine slept → emit an **immediate** tick rather than waiting out the next interval.
- Probe `is_display_active()` (`main.rs:848-860`) **fresh every tick** and emit a structured payload: `emit("xmpp-keepalive", { displayActive, sleptMs })` (serde camelCase, mirroring `WakeEventPayload` at `main.rs:862-866`).
- **Keep emitting every 30s even when `displayActive=false`.** Only the JS-side reconnect work is gated; the tick itself must keep arriving so the state machine can learn when the display comes back. (XMPP critique, finding 2.)
- **Fail open:** on any FFI error, default `displayActive=true` — never `false`. Since `system-did-wake` is demoted, a stuck-`false` probe would otherwise silently kill reconnection forever. (Correctness finding 6.)

**Pure seams to extract for testing** (the FFI + thread stay thin, untested):
- `detect_sleep_gap(elapsed, interval, margin) -> Option<u64 sleptMs>` — wall-clock wake detection (mirrors JS `didTimerSleepThrough` 1.5× drift, `connectionUtils.test.ts:168-178`).
- `build_keepalive_payload(display_active, slept_ms) -> KeepalivePayload` — assert serde camelCase.
- `next_wait(slept) -> Duration` — returns `Duration::ZERO` (fire now) on a sleep gap.
- Inject the display probe as `impl Fn() -> bool` so tests substitute a fake.

### #2 — JS keepalive gate (app layer)
`apps/fluux/src/hooks/usePlatformState.ts:626-678` (Effect 5)

- Parse the new payload defensively (a legacy `()` payload from an older binary must yield `displayActive=undefined`, treated as `true` — no throw).
- Gate before invoking the SDK, in this order:
  1. `getReconnectIntent() === 'active'` — **the intent gate** (see §6, blocker 1).
  2. `displayActive !== false` — display gate (contract rule 1).
  3. If the tick reports a **sleep gap** (`sleptMs >= SLEEP_THRESHOLD_MS`), route it through `shouldHandleWake('keepalive')` so it honors `POST_RELOAD_COOLDOWN_MS` and `WAKE_DEBOUNCE_MS` (see §6, findings 4 & 8). A normal steady-state tick (`sleptMs ~30000`) skips the debounce and just runs the health probe.
- Thread `displayActive` into `client.handleKeepaliveTick(displayActive, sleptMs)`.
- Maintain a `displayActiveRef` updated on every tick (default `true` pre-first-tick). Effect 3 (heartbeat, `:517-541`) and Effect 4 (visibility, `:547-622`) read it: a visibility/focus `'visible'` nudge is suppressed when the last tick reported `displayActive=false`.

**Teardown / reconnect ordering (the maintainer's question).** The reconnect must lead and be independent of the reload. `handleDeadSocket` (`Connection.ts:1149-1212`) already tears down the old client before creating the new one, so teardown-before-reconnect is its natural order. The refinement: a **dead-confidence fast-path** — when `sleptMs >= SM_SESSION_TIMEOUT_MS` (or the health probe fails), skip the verify ping and go straight to teardown + reconnect (the existing `sleepExceedsSMTimeout` branch). The reload is no longer in the reconnect critical path at all. (SM resume on the in-place reconnect path is proven by the `09:51` log entry — no reload involved.)

### #3 — State machine: hold backoff while display-asleep
`packages/fluux-sdk/src/core/connectionMachine.ts:547-585` (reconnecting.waiting)

- Add a `displayAsleep` context field and `DISPLAY_ACTIVE` / `DISPLAY_INACTIVE` events (driven from the keepalive tick via `Connection.handleKeepaliveTick`).
- Implement the hold as an **explicit `reconnecting.paused` substate with no `after` timer** (not a guard on the existing `after`). Rationale: guarding the `after` consumes the timer and leaves nothing armed on resume; an explicit substate makes "no timer scheduled while asleep" structurally true and trivially testable with `advanceTimersByTime`. (High finding 3; test-plan gap recommendation.)
- **Preserve the attempt counter and `nextRetryDelayMs` across pause/resume.** The display gate PAUSES the ladder; it never RESETS it. This is the fix for the `09:46-09:47` churn.
- **Edge-triggered kick with hysteresis** (high finding 5): the first `DISPLAY_ACTIVE` after a `DISPLAY_INACTIVE` (a real asleep→active transition, ideally confirmed sticky) sends an immediate kick to `attempting`. A single anomalous `displayActive=true` sample must not kick; do not level-trigger every active tick (that would defeat the backoff and hammer the server every 30s).
- Long-sleep SM logic stays orthogonal: `WAKE`/resume with `sleepDurationMs > SM_SESSION_TIMEOUT_MS` still sets `smResumeViable=false`.

### #4 — Decouple reload from reconnect; build the window-shown reload first
`apps/fluux/src/hooks/usePlatformState.ts:296-333, 450-510, 547-622`

**Order of operations matters** (medium finding 7): today the only OS-wake reload trigger is `maybeReloadOnLongWake()` called *inside* `handleWakeFromSleep()`. Naively "removing the reconnect trigger" from the deferred path would also remove its reload. So:

1. **First** build a `window-shown` reload trigger: on window show / `visibilitychange→visible`, compute the hidden span and call `maybeReloadOnLongWake`-equivalent (reload only if span `>= SLEEP_THRESHOLD_MS` and Tauri). Route the existing inline Effect 4 reload (`~:586`) through `maybeReloadOnLongWake` too, so the decision is unit-testable via the pure fn rather than spying on `window.location.reload()`.
2. **Then** demote `system-did-wake` and `system-did-wake-deferred`: they call the reload path *without* the subsequent `notifySystemState('awake')`. No reconnect from these events.
3. **Spinner decoupling** (blocker 2, §6): the full-screen `isAutoReconnecting` spinner must not depend on a reconnect the display-gate can suppress.

### #5 — Auto-reconnect intent guard (`desired`): systemic gate
`packages/fluux-sdk/src/core/connectionMachine.ts` + SDK injection + app wiring

This redesign promotes the keepalive into a first-class reconnect authority with new wake-kick paths — exactly when a per-entry-point intent check is most likely to grow a new hole. So the "should we auto-reconnect?" decision is enforced at **one systemic chokepoint**, not re-derived per path (the scattered re-derivation that made the logout-reconnect bug recur). This realizes the deferred Phase 2 SDK-side `desired` guard from [docs/2026-06-07-logout-reconnect-hardening-followup.md](../../2026-06-07-logout-reconnect-hardening-followup.md).

- Gate at the **single reconnect funnel** — `Connection.attemptReconnect`. Every reconnect (backoff `after`, the `DISPLAY_ACTIVE`/wake kick, and dead-socket recovery) flows through `reconnecting.attempting` → the subscribe callback at `Connection.ts:282-294` → `attemptReconnect`. At the top of `attemptReconnect`, if `!shouldAutoReconnect()`, clean up and send `DISCONNECT` → `disconnected` instead of connecting. The deny path lands in `disconnected` (a clean spinner-exit state) and sits at reconnect *initiation*, so it cannot strand the machine. **No new machine context flag** — the regression-prone XState machine is untouched by this gate.
- Drive it from a **pull-based predicate injected into the SDK** (`shouldAutoReconnect: () => boolean`, evaluated live at the chokepoint — no cached copy to drift). The app wires it to `() => getReconnectIntent() === 'active'`, keeping the SDK headless (it knows "allowed?", not the `localStorage` flag).
- **Defense-in-depth (Option A):** also keep the cheap app-layer early-out in Effect 5 — skip the tick entirely when `getReconnectIntent() !== 'active'`, so we never even nudge.

### #6 — Source the SM resume timeout from the server
`packages/fluux-sdk/src/core/connectionMachine.ts:83`, `Connection.ts`

`SM_SESSION_TIMEOUT_MS` is hardcoded to 600000 (10 min), but the authoritative window is the **`max` attribute the server returns on `<enabled .../>`** (XEP-0198 §3), exposed by xmpp.js as `streamManagement.max` (seconds). ejabberd's default is often 300s, so the hardcode over-estimates the window and triggers doomed `<resume/>` attempts.

- Capture `streamManagement.max` when SM is enabled, convert to ms, store it on the connection (and surface it to the machine guards).
- Use the server value wherever SM-resume viability is gated (`connectionMachine.ts:282, 291`); **fall back to the 600000 constant only when the server omits `max`.**

## 5. Teardown / reconnect / reload ordering (summary)

| Situation | Order |
|---|---|
| Display on, app hidden/unfocused, socket dead | keepalive tick → (dead-confidence fast-path) teardown old client → reconnect (SM-resume or fresh). **No reload.** |
| Display off | keepalive tick gated → no teardown, no reconnect; backoff held in `reconnecting.paused`. |
| Window shown after long hidden span | `maybeReloadOnLongWake` → reload (rendering only). If a healthy connection already exists, the reload re-establishes it (accepted cost; only when render repair is actually needed). |

Reconnect leads; reload is a lazy, rendering-only follow-up.

## 6. Regression landmines & mitigations

| # | Landmine | Mitigation |
|---|----------|------------|
| **B1 (blocker)** | Keepalive reconnect **bypasses `reconnectIntent`** (`reconnectIntent.ts:26-42`). The SDK never reads it; promoting the tick to the reconnect authority can silently log a user back in if a tick lands during a logout race (the machine isn't yet `disconnected`; `performLogout`'s disconnect is timeout-bounded). | **Resolved → systemic SDK `desired` guard (Option B) + Effect 5 early-out (Option A defense-in-depth), see change #5.** A `desired` flag guards every entry into `reconnecting`, driven by an injected `shouldAutoReconnect` predicate wired to `getReconnectIntent() === 'active'`; plus the cheap app-layer skip. Covers all reconnect triggers, not just the keepalive tick. |
| **B2 (blocker)** | Holding backoff strands the `isAutoReconnecting` spinner on "Reconnexion…" forever — it only clears on `status==='online'` (`App.tsx:191-257`), but a held machine never reaches online. Reproduces PR #466. | Decouple spinner exit from "reconnect completing": when backoff is held because `displayAsleep`, App drops the full-screen spinner and shows ChatLayout in a "reconnecting/paused" chrome state. Guarantee the first `DISPLAY_ACTIVE` tick advances the machine. |
| 3 | XState `after` hold semantics (resume-from-zero / stale fire). | Explicit `reconnecting.paused` substate; kick on first display-active tick; preserve attempt counter (§4 #3). |
| 4 | Thundering herd: keepalive tick + `system-did-wake` + visibility all fire on wake; Effect 5 is **not** behind `shouldHandleWake` debounce. | Route gap-triggered keepalive reconnect through `shouldHandleWake('keepalive')` / share `handleAwakeInFlight` single-flight (`Connection.ts:1281-1346`). Benign steady-state probe stays ungated. |
| 5 | Display flapping (CGDisplayIsAsleep oscillation) → reconnect storm / backoff defeat. | Edge-trigger + hysteresis; pause-never-reset the ladder (§4 #3). |
| 6 | FFI failure / legacy payload / multi-display. | Fail open (`displayActive` defaults `true`); defensive payload parse; document clamshell-with-external = display-active = desired. |
| 8 | `POST_RELOAD_COOLDOWN_MS` (60s) only gates app-layer wake handlers, not Effect 5. | Gap-triggered keepalive reconnect passes through `isWithinReloadCooldown` (`usePlatformState.ts:97-105`). |

## 7. XMPP-protocol invariants (must be stated to be correct)

- **SM-resume viability is decoupled from OS-sleep detection.** Idle screen-off / clamshell-on-power do **not** fire `NSWorkspaceWillSleepNotification`, so `sleepStartTime` is never recorded and `smResumeViable` can be stale-`true`. On the first display-active tick, compute display-off elapsed from accumulated `sleptMs` (or last successful SM ack), and if it `>=` the SM resume window (server `<enabled max>` if present, else `SM_SESSION_TIMEOUT_MS`; see change #6), send `WAKE` with that duration so `markSmResumeNotViable` + `smPersistence.clearCache()` run **before** the attempt — going straight to fresh bind instead of a doomed `<resume/>`. (XMPP findings 1, 3, 7.)
- **No liveness while display-asleep is intentional.** `disableSmKeepalive` already silences xmpp.js's SM keepalive (`Connection.ts:1580-1584`); gating the native tick means zero outbound traffic during display-off. The stream may be half-open; this is **detected and recovered on the first display-active tick.** The Rust tick must keep firing (carrying `displayActive=false`) so the machine can be released.
- **First display-active tick uses a wake-style verify, not the steady-state probe.** A single SM-`<r/>` ack can be locally buffered into a dead TCP socket; on ambiguity, prefer reconnect over a second wait. Use a shorter wake-verify timeout. (XMPP finding 4 + open question.)
- **Forward MAM catch-up even on SM resume after display-off.** A zombie socket means the server may believe it delivered messages SM won't redeliver (SM only replays *unacked* stanzas). Reuse `selectCatchUpQuery` on resume-after-display-off, not just on fresh bind. (XMPP finding 5; ties into [docs/MAM_CATCHUP.md].)
- **Fresh bind must re-enable Carbons (XEP-0280, session-scoped) and re-send correct presence** (respecting auto-away/XA captured before display-off). (XMPP finding 5.)
- **Conflict after long display-off is expected and user-actionable.** Use a randomized/server-assigned resource so a stale zombie session doesn't self-conflict; surface a reconnect affordance from `terminal.conflict`. (XMPP finding 9.)

## 8. Test strategy (priority deliverable)

Reuse existing seams: pure-fn `describe` blocks (`usePlatformState.test.tsx:455-533`), the `tauriListeners` Map + `mockConnectionStatus` harness (`:8-111`), `createActor`+`send`+`getSnapshot`+fake timers (`connectionMachine.test.ts:319-333`), the `handleKeepaliveTick` describe (`Connection.test.ts:4117-4192`), and the race harness `connectAndGoOnline`/`getMachineState` (`Connection.races.test.ts:71-99`). All new logic lands in pure functions first so it is testable without jsdom/timers.

**A. Pure-fn unit (new seams in `usePlatformState`)**
- `shouldRunKeepaliveReconnect(payload, intent)`: `false` when `displayActive===false` (any intent); `false` when `displayActive===true` but `intent==='logged-out'`; `true` when `displayActive===true && intent==='active'`; `true` (fail-open) when `displayActive===undefined && intent==='active'`.
- `parseKeepalivePayload(raw)`: legacy `()`/undefined → `{displayActive:undefined, sleptMs:undefined}` no throw; well-formed object parsed.
- `isKeepaliveWakeTick(sleptMs)`: `true` at `>= SLEEP_THRESHOLD_MS`, `false` for ~30s.
- Reload-decoupling routes through `shouldReloadWebviewOnWake` (Tauri-only; threshold boundary).

**B. `usePlatformState` hook (Effect 5 gate + Effect 2 demotion)**
- `{displayActive:false}` tick while online → no `handleKeepaliveTick`/health-check (no churn).
- `{displayActive:true}` while online → `handleKeepaliveTick(true)` **with no `window.focus` event** (focus-independent path).
- **Field regression:** `reconnecting` + `{displayActive:true, sleptMs:600000}` with no focus → reconnect kick fires.
- `{displayActive:true}` + `intent==='logged-out'` → no reconnect.
- Tick within reload cooldown → ignored even with `displayActive=true`.
- `system-did-wake`/`-deferred` with `displayActive:true` → **no** `notifySystemState('awake')`; deferred long-span → reload only.
- Legacy `()` payload → no throw, defaults to active.
- Visibility `'visible'` suppressed when last tick was `displayActive=false`; `displayActiveRef` defaults active pre-first-tick (focus nudge still works on cold start).

**C. SDK `Connection.handleKeepaliveTick(displayActive, sleptMs)`**
- `(false)` connected → no SM `<r/>`; `(true)` connected → sends `<r/>`.
- `(false)` reconnecting.waiting → no nudge (no new client); `(true)` → nudge.
- `(false)` ×20 during a long display-off → zero sends, zero clients (no accumulation).
- `(true)` in terminal states → no-op.

**D. `connectionMachine` (CHANGE #3)**
- In `reconnecting.waiting` with `displayAsleep`, advancing timers past `nextRetryDelayMs` does **not** transition (ladder paused).
- `reconnectAttempt`/`nextRetryDelayMs` do **not** grow while held across many would-be fires (the `09:46-09:47` bug).
- `DISPLAY_ACTIVE` while held → immediate `attempting`, skipping remaining backoff.
- After resume + `CONNECTION_ERROR`, backoff resumes from preserved attempt (e.g. still 4000ms), not reset.
- `WAKE` with `sleepDurationMs > SM_SESSION_TIMEOUT_MS` while held still marks `smResumeViable=false`.
- `DISPLAY_INACTIVE` in `connected.healthy` / terminal → ignored.
- Held → `DISCONNECT` (user logout) → `disconnected`, context cleared (machine-level spinner-stranding escape).
- **`shouldAutoReconnect` gate (change #5, SDK):** `attemptReconnect` with `shouldAutoReconnect() === false` creates **no** client and drives the machine to `disconnected`; with `true`, reconnect proceeds. Verified for entry via the backoff `after`, the wake kick, and dead-socket recovery — all funnel through `attemptReconnect`. (The systemic intent gate; covers paths the app-layer Effect 5 check does not.)
- **Server resume window (change #6):** SM-resume viability uses the captured server `max` (e.g. 300s) when present; falls back to `SM_SESSION_TIMEOUT_MS` (600s) when `<enabled>` omits `max`.

**E. Double-fire race & spinner-stranding**
- Keepalive tick + `system-did-wake` within `WAKE_DEBOUNCE_MS` → single reconnect.
- SDK: KEEPALIVE nudge concurrent with `handleAwake` → only one `attemptReconnect` (respects `deadSocketRecoveryInProgress`).
- Spinner-exit path: held → `DISPLAY_ACTIVE` → `attempting` → `CONNECTION_SUCCESS` → `connected` (status reaches online).
- Negative: display stays asleep + `intent==='active'` → machine rests in `reconnecting.paused`; App must render a paused state, not a spinning "Reconnexion…".

**F. Rust (`#[cfg(test)]`)**
- `detect_sleep_gap`: `Some(sleptMs)` on `elapsed >> interval`; `None` for normal loop + jitter (no false positives).
- `build_keepalive_payload` serde camelCase.
- Display probe read fresh per tick (injected fake), value flows into payload (guards stuck-`false` landmine).
- `next_wait` returns `ZERO` on sleep gap.

## 9. Decisions & remaining questions

**Resolved**

1. **SM resume timeout — sourced from the server.** Read `streamManagement.max` (the `<enabled max>` value, XEP-0198 §3); fall back to `SM_SESSION_TIMEOUT_MS=600000` only when the server omits it. (Change #6.)
2. **Intent gate — Option B + A.** Systemic SDK-side `desired` guard on every entry into `reconnecting`, driven by an injected `shouldAutoReconnect` predicate (`() => getReconnectIntent() === 'active'`), plus the cheap Effect 5 early-out as defense-in-depth. Realizes the deferred Phase 2 guard. (Change #5.)

**Still open (can be settled during implementation)**

3. **Spinner UX** (B2): exact resting-state treatment when `reconnecting + displayAsleep` (distinct "paused/offline" chrome vs. silent ChatLayout).
4. **Forward MAM catch-up on resume-after-display-off**: confirm `selectCatchUpQuery` is reused on the SM-resume path, and confirm the fresh-session path re-enables Carbons (both to be verified against the code during implementation).

## 10. Verification

- `npm test` (SDK + app) green, no stderr; `npm run typecheck`; lint clean (per CLAUDE.md pre-commit gate).
- Manual: induce a long display-off on AC power (idle screen-off, app unfocused) and confirm reconnect on display-on without focusing Fluux; confirm DarkWake does not reconnect; confirm no spinner stranding.
