# Display-Gated Keepalive Reconnect — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** On macOS, make the native keepalive the focus-independent reconnect authority — reconnect whenever the primary display is on (regardless of window focus), hold reconnect attempts while the display is off, and decouple the WRY webview reload from reconnect.

**Architecture:** The Rust 30s keepalive thread becomes wake- and display-aware (measures real elapsed wall-clock; probes `CGDisplayIsAsleep`; emits `{displayActive, sleptMs}`). The app-layer Effect 5 gates the tick on display state + reconnect intent and forwards it to the SDK. The connection state machine gains a `reconnecting.paused` substate that holds the backoff ladder (counter preserved) while the display is off and resumes on a display-active kick. A single pull-based `shouldAutoReconnect` gate at `Connection.attemptReconnect` enforces logout intent across every reconnect path. SM resume viability is gated on the server-advertised `<enabled max>` window.

**Tech Stack:** TypeScript, React, Zustand, XState v5 (`@xmpp/client` Stream Management), Vitest; Rust + Tauri v2 (objc2, Core Graphics FFI), `cargo test`.

**Spec:** `docs/superpowers/specs/2026-06-19-display-gated-reconnect-design.md` (changes #1–#6, contract, §7 invariants, §8 test matrix).

---

## File Structure

| File | Responsibility | Tasks |
|---|---|---|
| `apps/fluux/src/hooks/usePlatformState.ts` | Pure gate helpers + Effect 5 keepalive wiring + Effect 2/4 reload decoupling + `displayActive` return | A-T1..3, D-T1..4, D-T6 |
| `apps/fluux/src/App.tsx` | Full-screen spinner not stranded while display-paused | D-T6 |
| `apps/fluux/src/main.tsx` | Inject `shouldAutoReconnect = () => getReconnectIntent() === 'active'` | D-T5 |
| `packages/fluux-sdk/src/core/connectionMachine.ts` | `displayAsleep`/`smResumeWindowMs` context, `DISPLAY_*`/`SM_ENABLED` events, `reconnecting.paused` substate, `paused → 'reconnecting'` status mapping | B-T1..7 |
| `packages/fluux-sdk/src/core/modules/Connection.ts` | `shouldAutoReconnect` gate at `attemptReconnect`, `handleKeepaliveTick(displayActive, sleptMs)`, capture `streamManagement.max` → `SM_ENABLED` | C-T1..6 |
| `packages/fluux-sdk/src/core/modules/BaseModule.ts`, `types/client.ts`, `XMPPClient.ts`, `provider/XMPPProvider.tsx` | Thread the `shouldAutoReconnect` predicate end-to-end | C-T1, C-T4, D-T5 |
| `apps/fluux/src-tauri/src/main.rs` | Wake/display-aware keepalive thread + pure seams (`detect_sleep_gap`, `next_wait`, `build_keepalive_payload`, `keepalive_step`) | E-T1..7 |

## Execution order & cross-task dependencies

Execute in the order printed: **A → B → C → D → E**.

- **A (JS pure fns)** — dependency-free; consumed by D's Effect 5.
- **B (machine)** — adds `DISPLAY_ACTIVE` / `DISPLAY_INACTIVE` / `SM_ENABLED` events, `displayAsleep`/`smResumeWindowMs` context, the `reconnecting.paused` substate, and the **`paused → 'reconnecting'` status mapping (B-T7)**. Must land before C (which sends those events and must typecheck) and before D-T6 (which relies on `paused` mapping to `'reconnecting'`, not `'disconnected'`).
- **C (SDK Connection)** — adds `XMPPClientConfig.shouldAutoReconnect` + the `attemptReconnect` gate, the `handleKeepaliveTick(displayActive, sleptMs)` signature, and the `SM_ENABLED` emit. Depends on B's events for typecheck.
- **D (app wiring)** — consumes A's pure fns and C's `handleKeepaliveTick`/`XMPPClientConfig`. Run `npm run build:sdk` before the app typecheck (SDK type changed — see MEMORY pitfall).
- **E (Rust)** — independent; the JS side tolerates the legacy `()` payload via `parseKeepalivePayload`, so E lands last.

**Conventions:** every task is strict TDD (failing test → run-fail → minimal impl → run-pass → commit). Pre-commit gate (CLAUDE.md): tests pass with no stderr, `npm run typecheck`, lint clean. Test commands: SDK `cd packages/fluux-sdk && npx vitest run <path>`; app `cd apps/fluux && npx vitest run <path>`; Rust `cd apps/fluux/src-tauri && cargo test <name>`.

---

## Regression safety (MANDATORY — apply within the referenced tasks)

A regression audit read the existing suites. Apply the following; do not skip the full-suite gates.

### Existing tests that MUST be updated (otherwise compile/runtime failure)

- **B-T1 — machine context literals.** Adding `displayAsleep`/`smResumeWindowMs` to `ConnectionMachineContext` breaks two hand-constructed context objects in `connectionMachine.test.ts`:
  - `getReconnectInfoFromContext > should return attempt and target time from context` (~`:1195-1210`)
  - `getReconnectInfoFromContext > should return null target time when not reconnecting` (~`:1212-1226`)

  Add `displayAsleep: false,` and `smResumeWindowMs: SM_SESSION_TIMEOUT_MS,` to **both** literals (they otherwise fail to typecheck). Make this part of B-T1's implementation step and re-run the whole file.

- **D-T6 — App.reconnect mock default.** `App.reconnect.test.tsx` mocks `usePlatformState: () => mockUsePlatformState()` returning `undefined`. Once App runs `const { displayActive } = usePlatformState()`, that throws. The mock MUST default to returning `{ displayActive: true }` (controllable via the hoisted `mockPlatformDisplayActive`). Confirm the existing `keeps platform-state listeners mounted during the initial auto-reconnect spinner` (`:110-119`) and `stays on ChatLayout during a transient reconnect` (`:181-195`) tests still pass after the mock change.

### No-breakage confirmations (audit-verified — do not "fix" what isn't broken)

- **usePlatformState (Effect 2 demotion / Effect 5 gating):** there are currently **no** existing tests asserting `system-did-wake[-deferred] → notifySystemState('awake')` or the keepalive listener's call/signature, so the demotion and gating break nothing. Precisely because it was untested, D-T1/T2/T3 MUST add the new guards (they do).
- **SDK Connection (`attemptReconnect` gate):** the `shouldAutoReconnect` default `() => true` and the optional `handleKeepaliveTick` params leave every existing reconnect/SM-resume test and the no-arg `handleKeepaliveTick` tests (`Connection.test.ts:4118-4192`) green. C-T3 still adds the `displayActive`-gated companions.

### Implementation caution (avoid a NEW double-reconnect)

- **C-T3:** `handleKeepaliveTick(true, …)` sends `DISPLAY_ACTIVE`, which in `reconnecting.waiting`/`paused` already kicks to `attempting` (B-T5), so the subsequent `nudgeReconnect()` is redundant for those states. Keep the `deadSocketRecoveryInProgress`/single-flight guards (C-T6) and verify via the existing `nudges reconnect when in reconnecting.waiting` test (`Connection.test.ts:4133`) that **exactly one** client is created, not two.

### Full-suite gates (do NOT rely on `-t`-filtered runs alone)

Run the WHOLE affected file(s) at each phase boundary, and both packages at the end:
- After **B**: `cd packages/fluux-sdk && npx vitest run src/core/connectionMachine.test.ts`
- After **C**: `cd packages/fluux-sdk && npx vitest run src/core/modules/Connection.test.ts src/core/modules/Connection.races.test.ts`
- After **D**: `npm run build:sdk` then `cd apps/fluux && npx vitest run` (whole app suite — the Effect changes have wide reach)
- After **E**: `cd apps/fluux/src-tauri && cargo test && cargo build`
- **Final:** `npm test` (SDK + app) with **no stderr**, `npm run typecheck`, lint clean, `cargo test`.

---

## Phase A — JS pure-function seams (spec #2/#4 helpers)

### Task Group A — JS pure-function seams (changes #2 & #4 helpers)

These three pure functions live in `apps/fluux/src/hooks/usePlatformState.ts` alongside the existing `shouldHandleDisplayWake` / `shouldReloadWebviewOnWake` helpers, exported and unit-tested by direct call (no React, no timers), mirroring the existing `describe` blocks in `apps/fluux/src/hooks/usePlatformState.test.tsx`. They share the existing `SLEEP_THRESHOLD_MS = 180_000` constant and the `ReconnectIntent = 'active' | 'logged-out'` type from `apps/fluux/src/utils/reconnectIntent.ts`.

#### Task A-T1: `parseKeepalivePayload` — defensive payload parse

**Files:**
- Modify: `apps/fluux/src/hooks/usePlatformState.ts` (add exported `KeepalivePayload` interface + `parseKeepalivePayload` after `shouldHandleDisplayWake`, ~line 142)
- Test: `apps/fluux/src/hooks/usePlatformState.test.tsx` (new `describe('parseKeepalivePayload')` block placed after the `describe('shouldHandleDisplayWake')` block, ~line 471; add import at line 94-105)

- [ ] **Step 1: Write the failing test.** Add the import to the existing import block (lines 94-105), inserting after `shouldHandleDisplayWake,`:
  ```ts
  shouldHandleDisplayWake,
  parseKeepalivePayload,
  ```
  Add a new `describe` block immediately after the closing `})` of `describe('shouldHandleDisplayWake', ...)` (line 471):
  ```tsx
  describe('parseKeepalivePayload', () => {
    // The Rust keepalive thread emits { displayActive, sleptMs } (serde
    // camelCase). An older binary emits the legacy () payload (undefined).
    // Parsing must never throw and must default a missing displayActive to
    // undefined so the downstream gate fails open (treats it as active).

    it('parses a well-formed payload', () => {
      expect(parseKeepalivePayload({ displayActive: true, sleptMs: 30_000 })).toEqual({
        displayActive: true,
        sleptMs: 30_000,
      })
      expect(parseKeepalivePayload({ displayActive: false, sleptMs: 600_000 })).toEqual({
        displayActive: false,
        sleptMs: 600_000,
      })
    })

    it('returns undefined fields for a legacy () / undefined payload (no throw)', () => {
      expect(parseKeepalivePayload(undefined)).toEqual({
        displayActive: undefined,
        sleptMs: undefined,
      })
      expect(parseKeepalivePayload(null)).toEqual({
        displayActive: undefined,
        sleptMs: undefined,
      })
    })

    it('ignores fields of the wrong type without throwing', () => {
      expect(parseKeepalivePayload({ displayActive: 'yes', sleptMs: 'soon' })).toEqual({
        displayActive: undefined,
        sleptMs: undefined,
      })
    })

    it('does not throw on a non-object primitive', () => {
      expect(parseKeepalivePayload(42)).toEqual({
        displayActive: undefined,
        sleptMs: undefined,
      })
      expect(parseKeepalivePayload('xmpp-keepalive')).toEqual({
        displayActive: undefined,
        sleptMs: undefined,
      })
    })
  })
  ```

- [ ] **Step 2: Run it, expect FAIL.** `cd apps/fluux && npx vitest run src/hooks/usePlatformState.test.tsx` — fails: `parseKeepalivePayload` is not exported (import/undefined error).

- [ ] **Step 3: Minimal implementation.** In `apps/fluux/src/hooks/usePlatformState.ts`, immediately after the `shouldHandleDisplayWake` function (after line 142), add:
  ```ts
  /**
   * Payload for the Rust 30s `xmpp-keepalive` tick. Mirrors the Rust
   * `KeepalivePayload` (serde camelCase). An older binary emits the legacy
   * `()` payload (undefined); both fields are then absent.
   */
  export interface KeepalivePayload {
    /** False on macOS DarkWake/PowerNap (display off). Absent on a legacy build. */
    displayActive?: boolean
    /** Wall-clock ms elapsed since the previous tick — large after a sleep gap. */
    sleptMs?: number
  }

  /**
   * Safely extract a {@link KeepalivePayload} from a raw Tauri event payload.
   *
   * A legacy `()` payload (undefined) or any malformed value yields
   * `{ displayActive: undefined, sleptMs: undefined }` — never throws. A
   * missing/undefined `displayActive` is treated as `true` (fail-open) by the
   * downstream gate, so losing the field can never silently kill reconnection.
   */
  export function parseKeepalivePayload(raw: unknown): KeepalivePayload {
    if (!raw || typeof raw !== 'object') {
      return { displayActive: undefined, sleptMs: undefined }
    }
    const record = raw as Record<string, unknown>
    return {
      displayActive:
        typeof record.displayActive === 'boolean' ? record.displayActive : undefined,
      sleptMs: typeof record.sleptMs === 'number' ? record.sleptMs : undefined,
    }
  }
  ```

- [ ] **Step 4: Run it, expect PASS.** `cd apps/fluux && npx vitest run src/hooks/usePlatformState.test.tsx` — the new `parseKeepalivePayload` block passes; existing tests still green.

- [ ] **Step 5: Commit.**
  ```bash
  git add apps/fluux/src/hooks/usePlatformState.ts apps/fluux/src/hooks/usePlatformState.test.tsx
  git commit -m "feat(platform): add parseKeepalivePayload defensive parse for keepalive tick"
  ```

#### Task A-T2: `shouldRunKeepaliveReconnect` — display + intent gate

**Files:**
- Modify: `apps/fluux/src/hooks/usePlatformState.ts` (add `shouldRunKeepaliveReconnect` after `parseKeepalivePayload`; add `import type { ReconnectIntent } from '../utils/reconnectIntent'` near the top imports, after line 5 `import { isTauri } from '../utils/tauri'`)
- Test: `apps/fluux/src/hooks/usePlatformState.test.tsx` (new `describe('shouldRunKeepaliveReconnect')` block after the `parseKeepalivePayload` block; extend the import)

- [ ] **Step 1: Write the failing test.** Extend the import block (lines 94-105), adding after `parseKeepalivePayload,`:
  ```ts
  parseKeepalivePayload,
  shouldRunKeepaliveReconnect,
  ```
  Add a new `describe` block right after the `describe('parseKeepalivePayload', ...)` block:
  ```tsx
  describe('shouldRunKeepaliveReconnect', () => {
    // Two gates, in this order:
    //  1. payload.displayActive === false  -> never reconnect (DarkWake).
    //  2. intent !== 'active'              -> never reconnect (logout race).
    // A missing displayActive (legacy build) fails open to true.

    it('returns false when the display is asleep, regardless of intent', () => {
      expect(shouldRunKeepaliveReconnect({ displayActive: false }, 'active')).toBe(false)
      expect(shouldRunKeepaliveReconnect({ displayActive: false }, 'logged-out')).toBe(false)
    })

    it('returns false when the display is on but the user logged out', () => {
      expect(shouldRunKeepaliveReconnect({ displayActive: true }, 'logged-out')).toBe(false)
    })

    it('returns true when the display is on and the intent is active', () => {
      expect(shouldRunKeepaliveReconnect({ displayActive: true }, 'active')).toBe(true)
    })

    it('fails open: undefined displayActive (legacy build) + active intent -> true', () => {
      expect(shouldRunKeepaliveReconnect({ displayActive: undefined }, 'active')).toBe(true)
      expect(shouldRunKeepaliveReconnect({}, 'active')).toBe(true)
    })

    it('still blocks an undefined-display tick when the user logged out', () => {
      expect(shouldRunKeepaliveReconnect({ displayActive: undefined }, 'logged-out')).toBe(false)
    })
  })
  ```

- [ ] **Step 2: Run it, expect FAIL.** `cd apps/fluux && npx vitest run src/hooks/usePlatformState.test.tsx` — fails: `shouldRunKeepaliveReconnect` is not exported.

- [ ] **Step 3: Minimal implementation.** In `apps/fluux/src/hooks/usePlatformState.ts`, add the type import after line 5 (`import { isTauri } from '../utils/tauri'`):
  ```ts
  import { isTauri } from '../utils/tauri'
  import type { ReconnectIntent } from '../utils/reconnectIntent'
  ```
  Then, immediately after `parseKeepalivePayload`, add:
  ```ts
  /**
   * Decide whether a keepalive tick should drive a reconnect/health check.
   *
   * Order matters and both gates are hard blocks:
   *  1. `payload.displayActive === false` -> false. The primary display is off
   *     (closed lid with no external screen, idle screen-off, DarkWake); we hold
   *     reconnect attempts to avoid PowerNap/DarkWake battery churn.
   *  2. `intent !== 'active'` -> false. The user deliberately logged out; never
   *     log them back in on a tick that lands during a logout race.
   *
   * A missing/undefined `displayActive` (legacy binary emitting the `()`
   * payload) fails open to "display active" — losing the field must never
   * silently kill reconnection now that the keepalive is the reconnect authority.
   */
  export function shouldRunKeepaliveReconnect(
    payload: KeepalivePayload,
    intent: ReconnectIntent
  ): boolean {
    if (payload.displayActive === false) return false
    if (intent !== 'active') return false
    return true
  }
  ```

- [ ] **Step 4: Run it, expect PASS.** `cd apps/fluux && npx vitest run src/hooks/usePlatformState.test.tsx` — the new block passes; existing tests still green.

- [ ] **Step 5: Commit.**
  ```bash
  git add apps/fluux/src/hooks/usePlatformState.ts apps/fluux/src/hooks/usePlatformState.test.tsx
  git commit -m "feat(platform): add shouldRunKeepaliveReconnect display+intent gate"
  ```

#### Task A-T3: `isKeepaliveWakeTick` — sleep-gap classification

**Files:**
- Modify: `apps/fluux/src/hooks/usePlatformState.ts` (add `isKeepaliveWakeTick` after `shouldRunKeepaliveReconnect`)
- Test: `apps/fluux/src/hooks/usePlatformState.test.tsx` (new `describe('isKeepaliveWakeTick')` block after the `shouldRunKeepaliveReconnect` block; extend the import)

- [ ] **Step 1: Write the failing test.** Extend the import block, adding after `shouldRunKeepaliveReconnect,`:
  ```ts
  shouldRunKeepaliveReconnect,
  isKeepaliveWakeTick,
  ```
  Add a new `describe` block right after the `describe('shouldRunKeepaliveReconnect', ...)` block:
  ```tsx
  describe('isKeepaliveWakeTick', () => {
    // A steady-state tick reports sleptMs ~= 30s (the interval). A tick that
    // arrives after a sleep gap reports a much larger sleptMs and must be
    // routed through the wake debounce/cooldown rather than the plain probe.
    // Threshold is SLEEP_THRESHOLD_MS (180s), shared with the wake reload gate.

    const THRESHOLD = 180_000 // SLEEP_THRESHOLD_MS

    it('returns true at and above the sleep threshold (real wake gap)', () => {
      expect(isKeepaliveWakeTick(THRESHOLD)).toBe(true)
      expect(isKeepaliveWakeTick(600_000)).toBe(true)
      expect(isKeepaliveWakeTick(2.5 * 60 * 60 * 1000)).toBe(true)
    })

    it('returns false for a steady-state ~30s tick', () => {
      expect(isKeepaliveWakeTick(30_000)).toBe(false)
      expect(isKeepaliveWakeTick(0)).toBe(false)
      expect(isKeepaliveWakeTick(THRESHOLD - 1)).toBe(false)
    })

    it('treats undefined sleptMs (legacy build) as a non-wake tick', () => {
      expect(isKeepaliveWakeTick(undefined)).toBe(false)
    })
  })
  ```

- [ ] **Step 2: Run it, expect FAIL.** `cd apps/fluux && npx vitest run src/hooks/usePlatformState.test.tsx` — fails: `isKeepaliveWakeTick` is not exported.

- [ ] **Step 3: Minimal implementation.** In `apps/fluux/src/hooks/usePlatformState.ts`, immediately after `shouldRunKeepaliveReconnect`, add:
  ```ts
  /**
   * Decide whether a keepalive tick represents a real sleep/wake gap (rather
   * than a steady-state ~30s tick).
   *
   * The Rust thread measures wall-clock elapsed per iteration; after the
   * machine slept the first post-wake tick carries a large `sleptMs`. A
   * wake-tick must be routed through `shouldHandleWake('keepalive')` so it
   * honors the post-reload cooldown and the wake debounce; a steady-state tick
   * skips that and just runs the cheap health probe.
   *
   * Uses the project-wide SLEEP_THRESHOLD_MS line. An undefined `sleptMs`
   * (legacy `()` payload) is treated as a non-wake tick.
   */
  export function isKeepaliveWakeTick(sleptMs: number | undefined): boolean {
    return (sleptMs ?? 0) >= SLEEP_THRESHOLD_MS
  }
  ```

- [ ] **Step 4: Run it, expect PASS.** `cd apps/fluux && npx vitest run src/hooks/usePlatformState.test.tsx` — the new block passes; existing tests still green.

- [ ] **Step 5: Pre-commit gate + commit.** Verify typecheck and lint are clean (these helpers touch exported types consumed later by Effect 5):
  ```bash
  cd apps/fluux && npm run typecheck && npm run lint
  ```
  Then commit:
  ```bash
  git add apps/fluux/src/hooks/usePlatformState.ts apps/fluux/src/hooks/usePlatformState.test.tsx
  git commit -m "feat(platform): add isKeepaliveWakeTick sleep-gap classifier"
  ```

---


## Phase B — Connection state machine (spec #3/#6 + status mapping)

#### Task B-T1 — Add `displayAsleep` + `smResumeWindowMs` context with safe defaults

**Files:**
- Modify: `packages/fluux-sdk/src/core/connectionMachine.ts:112-136` (context interface), `:307-316` (initial context)
- Test: `packages/fluux-sdk/src/core/connectionMachine.test.ts` (extend the `initial state > should have default context` block, after line 40)

- [ ] **Step 1: Write the failing test.** Add to the existing `describe('initial state')` block in `connectionMachine.test.ts`, after the `should have default context` test (after line ~46, before the closing `})` of the describe):

```typescript
    it('should default displayAsleep to false and smResumeWindowMs to SM_SESSION_TIMEOUT_MS', () => {
      const actor = createActor(connectionMachine).start()
      const { context } = actor.getSnapshot()
      expect(context.displayAsleep).toBe(false)
      expect(context.smResumeWindowMs).toBe(SM_SESSION_TIMEOUT_MS)
      actor.stop()
    })
```

- [ ] **Step 2: Run it — expect FAIL.** `cd packages/fluux-sdk && npx vitest run src/core/connectionMachine.test.ts` — fails: `context.displayAsleep` is `undefined`, `context.smResumeWindowMs` is `undefined`.

- [ ] **Step 3: Minimal implementation.** Add two fields to `ConnectionMachineContext` (after `retryInitialFailure: boolean` at line 135):

```typescript
  retryInitialFailure: boolean
  /** When true, the primary display is off (asleep). Reconnect backoff is held
   *  in reconnecting.paused — no timer is armed — until DISPLAY_ACTIVE arrives. */
  displayAsleep: boolean
  /** SM resume window in ms. Defaults to SM_SESSION_TIMEOUT_MS; overridden by the
   *  server's <enabled max> value (XEP-0198 §3) via the SM_ENABLED event. */
  smResumeWindowMs: number
```

Add matching defaults to the `context` block (after `retryInitialFailure: false,` at line 315):

```typescript
    retryInitialFailure: false,
    displayAsleep: false,
    smResumeWindowMs: SM_SESSION_TIMEOUT_MS,
```

- [ ] **Step 4: Run it — expect PASS.** `cd packages/fluux-sdk && npx vitest run src/core/connectionMachine.test.ts` — the new test passes; all existing pass.

- [ ] **Step 5: Commit.** `git add packages/fluux-sdk/src/core/connectionMachine.ts packages/fluux-sdk/src/core/connectionMachine.test.ts && git commit -m "feat(sdk): add displayAsleep + smResumeWindowMs to connection machine context"`

---

#### Task B-T2 — Add `DISPLAY_ACTIVE` / `DISPLAY_INACTIVE` / `SM_ENABLED` events; `SM_ENABLED` sets `smResumeWindowMs`

**Files:**
- Modify: `packages/fluux-sdk/src/core/connectionMachine.ts:92-108` (event union), `:189-277` (actions), `:321-325` (top-level `on`)
- Test: `packages/fluux-sdk/src/core/connectionMachine.test.ts` (new `describe('SM_ENABLED')` block, place after the `exponential backoff` describe, around line 557)

- [ ] **Step 1: Write the failing test.** Add a new describe block:

```typescript
  describe('SM_ENABLED (server resume window)', () => {
    it('should set smResumeWindowMs from the server max at top level', () => {
      const actor = createActor(connectionMachine).start()
      actor.send({ type: 'CONNECT' })
      actor.send({ type: 'CONNECTION_SUCCESS' })
      // ejabberd default 300s
      actor.send({ type: 'SM_ENABLED', maxMs: 300_000 })
      expect(actor.getSnapshot().context.smResumeWindowMs).toBe(300_000)
      actor.stop()
    })

    it('should not transition state on SM_ENABLED', () => {
      const actor = createActor(connectionMachine).start()
      actor.send({ type: 'CONNECT' })
      actor.send({ type: 'CONNECTION_SUCCESS' })
      actor.send({ type: 'SM_ENABLED', maxMs: 300_000 })
      expect(actor.getSnapshot().value).toEqual({ connected: 'healthy' })
      actor.stop()
    })
  })
```

- [ ] **Step 2: Run it — expect FAIL.** `cd packages/fluux-sdk && npx vitest run src/core/connectionMachine.test.ts` — fails: `SM_ENABLED` event not in union (type error / no assign happens, `smResumeWindowMs` stays default `600000`).

- [ ] **Step 3: Minimal implementation.** Extend the event union (after `| { type: 'SET_RETRY_INITIAL'; retry: boolean }` at line 107):

```typescript
  | { type: 'SET_RETRY_INITIAL'; retry: boolean }
  | { type: 'DISPLAY_ACTIVE' }
  | { type: 'DISPLAY_INACTIVE' }
  | { type: 'SM_ENABLED'; maxMs: number }
```

Add a `setSmResumeWindow` action to the `actions` block (after `markSmResumeNotViable` at line 276):

```typescript
    markSmResumeNotViable: assign({
      smResumeViable: false,
    }),

    // Capture the server-advertised SM resume window (XEP-0198 <enabled max>).
    setSmResumeWindow: assign(({ event }) => {
      if (event.type === 'SM_ENABLED') {
        return { smResumeWindowMs: event.maxMs }
      }
      return {}
    }),
```

Handle `SM_ENABLED` at the top level alongside `SET_RETRY_INITIAL` (lines 321-325):

```typescript
  on: {
    SET_RETRY_INITIAL: {
      actions: 'setRetryInitialFailure',
    },
    SM_ENABLED: {
      actions: 'setSmResumeWindow',
    },
  },
```

- [ ] **Step 4: Run it — expect PASS.** `cd packages/fluux-sdk && npx vitest run src/core/connectionMachine.test.ts`.

- [ ] **Step 5: Commit.** `git add packages/fluux-sdk/src/core/connectionMachine.ts packages/fluux-sdk/src/core/connectionMachine.test.ts && git commit -m "feat(sdk): add SM_ENABLED event to set server-sourced SM resume window"`

---

#### Task B-T3 — SM-timeout guards compare against `context.smResumeWindowMs` (server max overrides default)

**Files:**
- Modify: `packages/fluux-sdk/src/core/connectionMachine.ts:278-296` (guards `sleepExceedsSMTimeout`, `sleepExceedsSMTimeoutFromContext`)
- Test: `packages/fluux-sdk/src/core/connectionMachine.test.ts` (extend the `SM_ENABLED` describe from T2)

- [ ] **Step 1: Write the failing test.** Add to the `describe('SM_ENABLED (server resume window)')` block:

```typescript
    it('should use server max (300s) to gate SM resume viability on WAKE', () => {
      const actor = createActor(connectionMachine).start()
      actor.send({ type: 'CONNECT' })
      actor.send({ type: 'CONNECTION_SUCCESS' })
      actor.send({ type: 'SM_ENABLED', maxMs: 300_000 })
      actor.send({ type: 'SOCKET_DIED' })
      // Now reconnecting.waiting. A 400s sleep exceeds the 300s server window
      // even though it is below the 600s default constant.
      actor.send({ type: 'WAKE', sleepDurationMs: 400_000 })
      expect(actor.getSnapshot().context.smResumeViable).toBe(false)
      actor.stop()
    })

    it('should fall back to SM_SESSION_TIMEOUT_MS when server omits max', () => {
      const actor = createActor(connectionMachine).start()
      actor.send({ type: 'CONNECT' })
      actor.send({ type: 'CONNECTION_SUCCESS' })
      actor.send({ type: 'SOCKET_DIED' })
      // No SM_ENABLED → default 600s window. A 400s sleep stays viable.
      actor.send({ type: 'WAKE', sleepDurationMs: 400_000 })
      expect(actor.getSnapshot().context.smResumeViable).toBe(true)
      actor.stop()
    })
```

- [ ] **Step 2: Run it — expect FAIL.** `cd packages/fluux-sdk && npx vitest run src/core/connectionMachine.test.ts` — the first new test fails: guard still compares 400000 against the 600000 constant → `smResumeViable` stays `true`.

- [ ] **Step 3: Minimal implementation.** Rewrite the two guards (lines 279-292) to read `context.smResumeWindowMs`:

```typescript
    // Did the sleep duration exceed the SM resume window (server max if known)?
    sleepExceedsSMTimeout: ({ context, event }) => {
      if (event.type === 'WAKE') {
        return (event.sleepDurationMs ?? 0) > context.smResumeWindowMs
      }
      return false
    },

    // Did the sleep duration (computed from context) exceed the SM resume window?
    // Used when SOCKET_DIED arrives in sleeping state before WAKE.
    sleepExceedsSMTimeoutFromContext: ({ context }) => {
      if (context.sleepStartTime == null) return false
      return (Date.now() - context.sleepStartTime) > context.smResumeWindowMs
    },
```

- [ ] **Step 4: Run it — expect PASS.** `cd packages/fluux-sdk && npx vitest run src/core/connectionMachine.test.ts` — new tests pass; existing SM-timeout tests (which never send `SM_ENABLED`, so window defaults to 600s) stay green.

- [ ] **Step 5: Commit.** `git add packages/fluux-sdk/src/core/connectionMachine.ts packages/fluux-sdk/src/core/connectionMachine.test.ts && git commit -m "feat(sdk): gate SM resume viability on server-sourced smResumeWindowMs"`

---

#### Task B-T4 — Add `reconnecting.paused` substate; `DISPLAY_INACTIVE` (waiting→paused) holds backoff with counter preserved

**Files:**
- Modify: `packages/fluux-sdk/src/core/connectionMachine.ts:142-154` (`ConnectionStateValue` union), `:189-277` (actions: `setDisplayAsleep`/`clearDisplayAsleep`), `:547-585` (waiting `on`), `:586-625` (new `paused` substate after `attempting`)
- Test: `packages/fluux-sdk/src/core/connectionMachine.test.ts` (new `describe('display-gated backoff (paused)')` block, place after the `reconnection cycle` describe, around line 490)

- [ ] **Step 1: Write the failing test.** Add a new describe block:

```typescript
  describe('display-gated backoff (paused)', () => {
    let actor: ReturnType<typeof createActor<typeof connectionMachine>>

    beforeEach(() => {
      actor = createActor(connectionMachine).start()
      actor.send({ type: 'CONNECT' })
      actor.send({ type: 'CONNECTION_SUCCESS' })
      actor.send({ type: 'SOCKET_DIED' })
      // reconnecting.waiting, attempt=1
    })

    it('should move waiting -> paused on DISPLAY_INACTIVE and set displayAsleep', () => {
      actor.send({ type: 'DISPLAY_INACTIVE' })
      expect(actor.getSnapshot().value).toEqual({ reconnecting: 'paused' })
      expect(actor.getSnapshot().context.displayAsleep).toBe(true)
      actor.stop()
    })

    it('should preserve the attempt counter and delay when pausing', () => {
      // Build up backoff to attempt 3 (delay 4000ms)
      actor.send({ type: 'TRIGGER_RECONNECT' })
      actor.send({ type: 'CONNECTION_ERROR', error: 'fail' })
      actor.send({ type: 'TRIGGER_RECONNECT' })
      actor.send({ type: 'CONNECTION_ERROR', error: 'fail' })
      expect(actor.getSnapshot().context.reconnectAttempt).toBe(3)
      expect(actor.getSnapshot().context.nextRetryDelayMs).toBe(4000)

      actor.send({ type: 'DISPLAY_INACTIVE' })
      expect(actor.getSnapshot().value).toEqual({ reconnecting: 'paused' })
      // Counter and delay untouched by the pause.
      expect(actor.getSnapshot().context.reconnectAttempt).toBe(3)
      expect(actor.getSnapshot().context.nextRetryDelayMs).toBe(4000)
      actor.stop()
    })

    it('should NOT advance the ladder while paused (no after timer armed)', async () => {
      vi.useFakeTimers()
      try {
        const timed = createActor(connectionMachine).start()
        timed.send({ type: 'CONNECT' })
        timed.send({ type: 'CONNECTION_SUCCESS' })
        timed.send({ type: 'SOCKET_DIED' })
        timed.send({ type: 'DISPLAY_INACTIVE' })
        expect(timed.getSnapshot().value).toEqual({ reconnecting: 'paused' })

        // Advance well past any backoff delay (cap is 120s).
        await vi.advanceTimersByTimeAsync(MAX_RECONNECT_DELAY * 5)
        expect(timed.getSnapshot().value).toEqual({ reconnecting: 'paused' })
        expect(timed.getSnapshot().context.reconnectAttempt).toBe(1)
        expect(timed.getSnapshot().context.nextRetryDelayMs).toBe(INITIAL_RECONNECT_DELAY)
        timed.stop()
      } finally {
        vi.useRealTimers()
      }
    })

    it('should ignore DISPLAY_INACTIVE in connected.healthy', () => {
      const c = createActor(connectionMachine).start()
      c.send({ type: 'CONNECT' })
      c.send({ type: 'CONNECTION_SUCCESS' })
      c.send({ type: 'DISPLAY_INACTIVE' })
      expect(c.getSnapshot().value).toEqual({ connected: 'healthy' })
      c.stop()
    })

    it('should ignore DISPLAY_INACTIVE in terminal.conflict', () => {
      const c = createActor(connectionMachine).start()
      c.send({ type: 'CONNECT' })
      c.send({ type: 'CONNECTION_SUCCESS' })
      c.send({ type: 'CONFLICT' })
      c.send({ type: 'DISPLAY_INACTIVE' })
      expect(c.getSnapshot().value).toEqual({ terminal: 'conflict' })
      c.stop()
    })
  })
```

- [ ] **Step 2: Run it — expect FAIL.** `cd packages/fluux-sdk && npx vitest run src/core/connectionMachine.test.ts` — fails: no `paused` state, `DISPLAY_INACTIVE` is unhandled in `waiting` (stays `waiting`).

- [ ] **Step 3: Minimal implementation.**

Add `{ reconnecting: 'paused' }` to `ConnectionStateValue` (after line 149):

```typescript
  | { reconnecting: 'waiting' }
  | { reconnecting: 'attempting' }
  | { reconnecting: 'paused' }
```

Add two actions to the `actions` block (after `setSmResumeWindow` from T2):

```typescript
    // Mark the primary display as off (entering reconnecting.paused)
    setDisplayAsleep: assign({
      displayAsleep: true,
    }),

    // Clear the display-off flag (resuming from reconnecting.paused)
    clearDisplayAsleep: assign({
      displayAsleep: false,
    }),
```

In `reconnecting.waiting`, add a `DISPLAY_INACTIVE` handler inside its `on` (after the `VISIBLE` handler, line 583):

```typescript
            VISIBLE: {
              target: 'attempting',
              actions: 'clearTargetTime',
            },
            // Primary display went off — hold the backoff ladder with no timer.
            // Preserve reconnectAttempt/nextRetryDelayMs (PAUSE, never RESET).
            DISPLAY_INACTIVE: {
              target: 'paused',
              actions: 'setDisplayAsleep',
            },
```

Add the new `paused` substate after the `attempting` state (after its closing `},` at line 623, before the `reconnecting` states block closes at 624):

```typescript
        /**
         * Display-gated hold. The primary display is off, so the backoff ladder
         * is paused with NO `after` timer armed — zero reconnect work happens
         * until the display comes back. The attempt counter and nextRetryDelayMs
         * are preserved so the ladder resumes where it left off.
         */
        paused: {
          on: {
            // Display came back — kick straight to attempting, preserving the
            // attempt counter so failure continues the existing backoff.
            DISPLAY_ACTIVE: {
              target: 'attempting',
              actions: ['clearDisplayAsleep', 'clearTargetTime'],
            },
            // User logout / cancel — clean exit.
            DISCONNECT: {
              target: '#connection.disconnected',
              actions: 'resetReconnectState',
            },
            // Explicit trigger also resumes the attempt.
            TRIGGER_RECONNECT: {
              target: 'attempting',
              actions: ['clearDisplayAsleep', 'clearTargetTime'],
            },
          },
        },
```

Note: `DISCONNECT`/`CONFLICT`/`AUTH_ERROR`/`CANCEL_RECONNECT` already exist on the parent `reconnecting.on` (lines 522-539) and apply to `paused`; the explicit `DISCONNECT` above is redundant-safe but kept for clarity per the contract (`paused: on DISCONNECT -> disconnected`). The parent `resetReconnectState` does not clear `displayAsleep`; see T6 for that.

- [ ] **Step 4: Run it — expect PASS.** `cd packages/fluux-sdk && npx vitest run src/core/connectionMachine.test.ts`.

- [ ] **Step 5: Commit.** `git add packages/fluux-sdk/src/core/connectionMachine.ts packages/fluux-sdk/src/core/connectionMachine.test.ts && git commit -m "feat(sdk): hold reconnect backoff in reconnecting.paused while display asleep"`

---

#### Task B-T5 — `DISPLAY_ACTIVE` resumes the ladder (paused→attempting preserving counter; waiting→attempting kick)

**Files:**
- Modify: `packages/fluux-sdk/src/core/connectionMachine.ts:547-585` (waiting `on`: add `DISPLAY_ACTIVE` kick)
- Test: `packages/fluux-sdk/src/core/connectionMachine.test.ts` (extend the `display-gated backoff (paused)` describe from T4)

- [ ] **Step 1: Write the failing test.** Add to the `describe('display-gated backoff (paused)')` block:

```typescript
    it('should resume paused -> attempting on DISPLAY_ACTIVE, preserving the counter', () => {
      // Build up to attempt 3, then pause
      actor.send({ type: 'TRIGGER_RECONNECT' })
      actor.send({ type: 'CONNECTION_ERROR', error: 'fail' })
      actor.send({ type: 'TRIGGER_RECONNECT' })
      actor.send({ type: 'CONNECTION_ERROR', error: 'fail' })
      expect(actor.getSnapshot().context.reconnectAttempt).toBe(3)
      actor.send({ type: 'DISPLAY_INACTIVE' })
      expect(actor.getSnapshot().value).toEqual({ reconnecting: 'paused' })

      // Display back → immediate attempt, counter intact.
      actor.send({ type: 'DISPLAY_ACTIVE' })
      expect(actor.getSnapshot().value).toEqual({ reconnecting: 'attempting' })
      expect(actor.getSnapshot().context.displayAsleep).toBe(false)
      expect(actor.getSnapshot().context.reconnectAttempt).toBe(3)
      expect(actor.getSnapshot().context.reconnectTargetTime).toBeNull()
      actor.stop()
    })

    it('should continue backoff from the preserved attempt after resume + CONNECTION_ERROR', () => {
      actor.send({ type: 'TRIGGER_RECONNECT' })
      actor.send({ type: 'CONNECTION_ERROR', error: 'fail' })
      actor.send({ type: 'TRIGGER_RECONNECT' })
      actor.send({ type: 'CONNECTION_ERROR', error: 'fail' })
      expect(actor.getSnapshot().context.reconnectAttempt).toBe(3)
      expect(actor.getSnapshot().context.nextRetryDelayMs).toBe(4000)

      actor.send({ type: 'DISPLAY_INACTIVE' })
      actor.send({ type: 'DISPLAY_ACTIVE' })
      // attempting again, then a failure should advance 3 -> 4 (8000ms), not reset.
      actor.send({ type: 'CONNECTION_ERROR', error: 'fail' })
      expect(actor.getSnapshot().context.reconnectAttempt).toBe(4)
      expect(actor.getSnapshot().context.nextRetryDelayMs).toBe(8000)
      actor.stop()
    })

    it('should treat DISPLAY_ACTIVE in waiting as an immediate kick to attempting', () => {
      // Still in waiting (attempt=1). DISPLAY_ACTIVE acts like VISIBLE.
      expect(actor.getSnapshot().value).toEqual({ reconnecting: 'waiting' })
      actor.send({ type: 'DISPLAY_ACTIVE' })
      expect(actor.getSnapshot().value).toEqual({ reconnecting: 'attempting' })
      expect(actor.getSnapshot().context.reconnectAttempt).toBe(1)
      actor.stop()
    })

    it('should ignore DISPLAY_ACTIVE in connected.healthy', () => {
      const c = createActor(connectionMachine).start()
      c.send({ type: 'CONNECT' })
      c.send({ type: 'CONNECTION_SUCCESS' })
      c.send({ type: 'DISPLAY_ACTIVE' })
      expect(c.getSnapshot().value).toEqual({ connected: 'healthy' })
      c.stop()
    })
```

- [ ] **Step 2: Run it — expect FAIL.** `cd packages/fluux-sdk && npx vitest run src/core/connectionMachine.test.ts` — the `waiting` kick test fails: `DISPLAY_ACTIVE` is unhandled in `waiting`, so it stays `waiting`. (The paused→attempting tests already pass from T4's `paused.DISPLAY_ACTIVE` handler.)

- [ ] **Step 3: Minimal implementation.** Add a `DISPLAY_ACTIVE` handler to `reconnecting.waiting.on` (after the `DISPLAY_INACTIVE` handler added in T4):

```typescript
            DISPLAY_INACTIVE: {
              target: 'paused',
              actions: 'setDisplayAsleep',
            },
            // Display active while waiting acts as an immediate kick (like VISIBLE).
            DISPLAY_ACTIVE: {
              target: 'attempting',
              actions: ['clearDisplayAsleep', 'clearTargetTime'],
            },
```

- [ ] **Step 4: Run it — expect PASS.** `cd packages/fluux-sdk && npx vitest run src/core/connectionMachine.test.ts`.

- [ ] **Step 5: Commit.** `git add packages/fluux-sdk/src/core/connectionMachine.ts packages/fluux-sdk/src/core/connectionMachine.test.ts && git commit -m "feat(sdk): resume reconnect ladder on DISPLAY_ACTIVE (paused/waiting kick)"`

---

#### Task B-T6 — Clear `displayAsleep` on `resetReconnectState` and long-sleep SM logic still works while held

**Files:**
- Modify: `packages/fluux-sdk/src/core/connectionMachine.ts:190-199` (`resetReconnectState`)
- Test: `packages/fluux-sdk/src/core/connectionMachine.test.ts` (extend the `display-gated backoff (paused)` describe from T4)

- [ ] **Step 1: Write the failing test.** Add to the `describe('display-gated backoff (paused)')` block:

```typescript
    it('should clear displayAsleep when reset via DISCONNECT from paused', () => {
      actor.send({ type: 'DISPLAY_INACTIVE' })
      expect(actor.getSnapshot().context.displayAsleep).toBe(true)
      actor.send({ type: 'DISCONNECT' })
      expect(actor.getSnapshot().value).toBe('disconnected')
      expect(actor.getSnapshot().context.displayAsleep).toBe(false)
      actor.stop()
    })

    it('should still mark SM resume not viable on WAKE with a long sleep while waiting', () => {
      // WAKE (long) is orthogonal to the display gate — viability still flips.
      actor.send({ type: 'WAKE', sleepDurationMs: SM_SESSION_TIMEOUT_MS + 1000 })
      expect(actor.getSnapshot().context.smResumeViable).toBe(false)
      expect(actor.getSnapshot().context.reconnectAttempt).toBe(1)
      actor.stop()
    })
```

- [ ] **Step 2: Run it — expect FAIL.** `cd packages/fluux-sdk && npx vitest run src/core/connectionMachine.test.ts` — the reset test fails: `resetReconnectState` does not clear `displayAsleep`, so it stays `true` after `DISCONNECT`. (The second test passes — covers the orthogonality regression from spec §8.D.)

- [ ] **Step 3: Minimal implementation.** Add `displayAsleep: false` to `resetReconnectState` (lines 191-199):

```typescript
    resetReconnectState: assign({
      reconnectAttempt: 0,
      nextRetryDelayMs: 0,
      reconnectTargetTime: null,
      lastError: null,
      smResumeViable: true,
      sleepStartTime: null,
      retryInitialFailure: false,
      displayAsleep: false,
    }),
```

- [ ] **Step 4: Run it — expect PASS.** `cd packages/fluux-sdk && npx vitest run src/core/connectionMachine.test.ts` — full file green, no stderr.

- [ ] **Step 5: Verify gate + commit.** Run the SDK typecheck and the full suite to confirm no machine regressions: `cd packages/fluux-sdk && npx tsc --noEmit && npx vitest run src/core/connectionMachine.test.ts`. Then `git add packages/fluux-sdk/src/core/connectionMachine.ts packages/fluux-sdk/src/core/connectionMachine.test.ts && git commit -m "feat(sdk): clear displayAsleep on reconnect reset; keep WAKE SM logic orthogonal to display gate"`

---


#### Task B-T7: Map `reconnecting.paused` to status `'reconnecting'` (status-mapping coverage)

`getConnectionStatusFromState` (`connectionMachine.ts:712-722`) switches on `stateValue.reconnecting` with only `waiting` and `attempting` cases and **no `default`** inside the `reconnecting` block, so a `{ reconnecting: 'paused' }` value falls through to the function's final `return 'disconnected'` (line 730). Reporting `'disconnected'` while the machine is merely display-paused would route the user to the LoginScreen (App gates LoginScreen on `status === 'disconnected'`) and strand D-T6's spinner logic. Map `paused → 'reconnecting'`.

**Files:**
- Modify: `packages/fluux-sdk/src/core/connectionMachine.ts:712-722` (the `reconnecting` switch in `getConnectionStatusFromState`)
- Test: `packages/fluux-sdk/src/core/connectionMachine.test.ts` (new `describe('getConnectionStatusFromState (paused)')` block; add `getConnectionStatusFromState` to the existing `connectionMachine` import if not already imported)

- [ ] **Step 1: Write the failing test.** Ensure the import line at the top of `connectionMachine.test.ts` includes `getConnectionStatusFromState` (add it to the existing `import { ... } from './connectionMachine'` if absent). Add a new describe block after the `display-gated backoff (paused)` block:

```typescript
  describe('getConnectionStatusFromState (paused)', () => {
    it('maps reconnecting.paused to the reconnecting status (not disconnected)', () => {
      expect(getConnectionStatusFromState({ reconnecting: 'paused' })).toBe('reconnecting')
    })

    it('keeps store status reconnecting while held in paused (no bounce to disconnected)', () => {
      const actor = createActor(connectionMachine).start()
      actor.send({ type: 'CONNECT' })
      actor.send({ type: 'CONNECTION_SUCCESS' })
      actor.send({ type: 'SOCKET_DIED' })
      actor.send({ type: 'DISPLAY_INACTIVE' })
      expect(actor.getSnapshot().value).toEqual({ reconnecting: 'paused' })
      expect(getConnectionStatusFromState(actor.getSnapshot().value)).toBe('reconnecting')
      actor.stop()
    })
  })
```

- [ ] **Step 2: Run it — expect FAIL.** `cd packages/fluux-sdk && npx vitest run src/core/connectionMachine.test.ts` — fails: `paused` falls through the `reconnecting` switch and the function returns `'disconnected'`.

- [ ] **Step 3: Minimal implementation.** Add a `paused` case to the `reconnecting` switch (after the `attempting` case at line 721):

```typescript
      case 'attempting':
        // Stays 'reconnecting' (not 'connecting') so the UI label and all
        // status-driven effects see a stable value across the whole
        // waiting↔attempting loop. This prevents wake-detection effects from
        // re-entering handleAwake() mid-reconnect.
        return 'reconnecting'
      case 'paused':
        // Display-gated hold (no backoff timer armed). Still 'reconnecting' from
        // the store/UI's view so App does NOT route to LoginScreen
        // (status === 'disconnected') or strand the full-screen spinner while
        // the primary display is off.
        return 'reconnecting'
```

- [ ] **Step 4: Run it — expect PASS.** `cd packages/fluux-sdk && npx vitest run src/core/connectionMachine.test.ts` — new tests pass; existing status-mapping tests stay green.

- [ ] **Step 5: Verify gate + commit.** `cd packages/fluux-sdk && npx tsc --noEmit && npx vitest run src/core/connectionMachine.test.ts`. Then:

```bash
git add packages/fluux-sdk/src/core/connectionMachine.ts packages/fluux-sdk/src/core/connectionMachine.test.ts
git commit -m "fix(sdk): map reconnecting.paused to 'reconnecting' status (avoid disconnected bounce)"
```

---

## Phase C — SDK Connection wiring (spec #2/#5/#6)

## Task Group C — SDK Connection wiring (spec changes #2, #5, #6)

> Scope: `packages/fluux-sdk/src/core/modules/Connection.ts` + `packages/fluux-sdk/src/core/XMPPClient.ts` + `packages/fluux-sdk/src/core/types/client.ts`. The connection-machine changes (`DISPLAY_ACTIVE`/`DISPLAY_INACTIVE`/`SM_ENABLED` events, `displayAsleep`/`smResumeWindowMs` context, `reconnecting.paused`) are owned by the machine task group and are assumed present. These tasks send those events and verify behaviour through observable effects (mock client-factory call counts, SM `<r/>` sends, the machine reaching `disconnected`, and a spy on the actor's `send`), so they neither duplicate nor depend on the machine group's internal assertions.

Test commands (confirmed against repo): SDK → `cd packages/fluux-sdk && npx vitest run <path>`. Pre-commit gate per CLAUDE.md: tests green with no stderr, `npm run typecheck`, lint clean.

---

#### Task C-T1: Inject `shouldAutoReconnect` predicate into Connection + XMPPClient

Add the injected predicate (defaulting to `() => true`) so the SDK stays headless but can be told "is auto-reconnect allowed right now?".

**Files:**
- Modify: `packages/fluux-sdk/src/core/modules/BaseModule.ts:13` (add `shouldAutoReconnect?` to `ModuleDependencies`)
- Modify: `packages/fluux-sdk/src/core/modules/Connection.ts:146` (private field), `:217` (constructor capture)
- Modify: `packages/fluux-sdk/src/core/types/client.ts:401` (add `shouldAutoReconnect?` to `XMPPClientConfig`)
- Modify: `packages/fluux-sdk/src/core/XMPPClient.ts:484` (store config field), `:647` (wire into `moduleDeps`)
- Test: `packages/fluux-sdk/src/core/modules/Connection.test.ts` (new `describe('shouldAutoReconnect injection')` near the `handleKeepaliveTick` describe, ~`:4193`)

Steps:

- [ ] **Step 1: Write the failing test.** Add to `Connection.test.ts`:
  ```typescript
  describe('shouldAutoReconnect injection', () => {
    it('defaults to allowing reconnect when no predicate is provided', () => {
      // xmppClient is constructed in the outer beforeEach with no predicate
      expect((xmppClient.connection as any).shouldAutoReconnect()).toBe(true)
    })

    it('uses the injected predicate', () => {
      const client = new XMPPClient({ debug: false, shouldAutoReconnect: () => false })
      expect((client.connection as any).shouldAutoReconnect()).toBe(false)
    })

    it('evaluates the predicate live (pull-based, not cached)', () => {
      let allowed = true
      const client = new XMPPClient({ debug: false, shouldAutoReconnect: () => allowed })
      expect((client.connection as any).shouldAutoReconnect()).toBe(true)
      allowed = false
      expect((client.connection as any).shouldAutoReconnect()).toBe(false)
    })
  })
  ```

- [ ] **Step 2: Run it (expect FAIL).** `cd packages/fluux-sdk && npx vitest run src/core/modules/Connection.test.ts -t "shouldAutoReconnect injection"` — fails: `shouldAutoReconnect` is `undefined` on the connection.

- [ ] **Step 3: Minimal implementation.**
  In `BaseModule.ts`, add to `ModuleDependencies` after `getE2EEManager?`:
  ```typescript
    /**
     * Pull-based predicate: "is automatic reconnection currently allowed?"
     * Evaluated live at the single reconnect funnel (Connection.attemptReconnect).
     * Keeps the SDK headless — the app wires this to its reconnect-intent flag.
     * Defaults to always-allowed when omitted.
     */
    shouldAutoReconnect?: () => boolean
  ```
  In `Connection.ts` after `private credentials: ConnectOptions | null = null` (`:146`):
  ```typescript
    // Pull-based gate evaluated at the top of attemptReconnect(). Defaults to
    // always-allowed so non-app SDK consumers (bots) reconnect unconditionally.
    private shouldAutoReconnect: () => boolean = () => true
  ```
  In the `Connection` constructor (`:217`), after `super(deps)`:
  ```typescript
      if (deps.shouldAutoReconnect) {
        this.shouldAutoReconnect = deps.shouldAutoReconnect
      }
  ```
  In `types/client.ts`, add to `XMPPClientConfig` before the closing brace (`:401`):
  ```typescript
    /**
     * Pull-based predicate the SDK evaluates before each automatic reconnect
     * attempt. Return `false` to suppress auto-reconnect (e.g., after an
     * explicit logout). Evaluated live — no cached copy. Defaults to always-on.
     */
    shouldAutoReconnect?: () => boolean
  ```
  In `XMPPClient.ts`, add a private field (near `storageAdapter`) and capture in the constructor (`:484`):
  ```typescript
      this.shouldAutoReconnect = config.shouldAutoReconnect
  ```
  (declare `private shouldAutoReconnect?: () => boolean` with the other private fields), then thread it into `moduleDeps` (`:647`, after `getE2EEManager`):
  ```typescript
        shouldAutoReconnect: this.shouldAutoReconnect,
  ```

- [ ] **Step 4: Run it (expect PASS).** `cd packages/fluux-sdk && npx vitest run src/core/modules/Connection.test.ts -t "shouldAutoReconnect injection"` — passes. Then `npm run typecheck` from repo root.

- [ ] **Step 5: Commit.**
  ```bash
  git add packages/fluux-sdk/src/core/modules/BaseModule.ts packages/fluux-sdk/src/core/modules/Connection.ts packages/fluux-sdk/src/core/types/client.ts packages/fluux-sdk/src/core/XMPPClient.ts packages/fluux-sdk/src/core/modules/Connection.test.ts
  git commit -m "feat(sdk): inject shouldAutoReconnect predicate into Connection"
  ```

---

#### Task C-T2: Gate `attemptReconnect` on `shouldAutoReconnect()` (spec change #5, §8.D)

Every reconnect entry (backoff `after`, wake kick, dead-socket recovery, display-active kick) funnels through `reconnecting.attempting` → the subscribe callback (`Connection.ts:282-294`) → `attemptReconnect`. Gate at the very top: when the predicate denies, clean up the in-flight client and drive the machine to `disconnected` instead of connecting.

**Files:**
- Modify: `packages/fluux-sdk/src/core/modules/Connection.ts:2328` (top of `attemptReconnect`)
- Test: `packages/fluux-sdk/src/core/modules/Connection.test.ts` (extend `describe('shouldAutoReconnect injection')`)

Steps:

- [ ] **Step 1: Write the failing test.** Add to the `shouldAutoReconnect injection` describe:
  ```typescript
  it('attemptReconnect with shouldAutoReconnect()===false creates no client and drives the machine to disconnected', async () => {
    let allowed = true
    const client = new XMPPClient({ debug: false, shouldAutoReconnect: () => allowed })
    client.bindStores(mockStores)

    const p = client.connect({
      jid: 'user@example.com',
      password: 'secret',
      server: 'example.com',
      skipDiscovery: true,
    })
    mockXmppClientInstance._emit('online')
    await p

    // Deny further reconnects, then kill the socket.
    allowed = false
    mockClientFactory.mockClear()
    mockXmppClientInstance._emit('disconnect', { clean: false })
    // SOCKET_DIED → reconnecting.waiting → (after) attempting → attemptReconnect gate
    await vi.advanceTimersByTimeAsync(2000)

    // No new client created — the gate short-circuited before createXmppClient.
    expect(mockClientFactory).not.toHaveBeenCalled()
    // Machine landed in disconnected (clean spinner-exit state).
    expect((client.connection as any).getMachineState()).toBe('disconnected')

    client.cancelReconnect()
  })

  it('attemptReconnect with shouldAutoReconnect()===true proceeds to create a client', async () => {
    const client = new XMPPClient({ debug: false, shouldAutoReconnect: () => true })
    client.bindStores(mockStores)

    const p = client.connect({
      jid: 'user@example.com',
      password: 'secret',
      server: 'example.com',
      skipDiscovery: true,
    })
    mockXmppClientInstance._emit('online')
    await p

    mockClientFactory.mockClear()
    mockXmppClientInstance._emit('disconnect', { clean: false })
    await vi.advanceTimersByTimeAsync(2000)

    expect(mockClientFactory).toHaveBeenCalled()
    client.cancelReconnect()
  })
  ```

- [ ] **Step 2: Run it (expect FAIL).** `cd packages/fluux-sdk && npx vitest run src/core/modules/Connection.test.ts -t "shouldAutoReconnect"` — the deny test fails: a client is created and the machine does not reach `disconnected`.

- [ ] **Step 3: Minimal implementation.** In `Connection.ts`, insert at the very top of `attemptReconnect` (`:2329`, immediately after the opening `logInfo('attemptReconnect: starting')`):
  ```typescript
    // Single systemic reconnect funnel gate (spec change #5). Every reconnect
    // entry — backoff `after`, the display-active/wake kick, and dead-socket
    // recovery — reaches here via reconnecting.attempting. When the app says
    // auto-reconnect is not desired (e.g. post-logout), tear down any in-flight
    // client and land in `disconnected` (a clean spinner-exit state) instead of
    // opening a connection. No machine context flag — the regression-prone
    // XState machine is untouched by this gate.
    if (!this.shouldAutoReconnect()) {
      logInfo('attemptReconnect: shouldAutoReconnect() === false, aborting and disconnecting')
      this.stores.console.addEvent('Reconnect suppressed: auto-reconnect not desired', 'connection')
      this.cleanupClient()
      this.sendMachineEvent({ type: 'DISCONNECT' }, 'attemptReconnect:not-desired')
      return
    }
  ```

- [ ] **Step 4: Run it (expect PASS).** `cd packages/fluux-sdk && npx vitest run src/core/modules/Connection.test.ts -t "shouldAutoReconnect"` — passes. Then run the full file to confirm no regression: `cd packages/fluux-sdk && npx vitest run src/core/modules/Connection.test.ts` and `cd packages/fluux-sdk && npx vitest run src/core/modules/Connection.races.test.ts`.

- [ ] **Step 5: Commit.**
  ```bash
  git add packages/fluux-sdk/src/core/modules/Connection.ts packages/fluux-sdk/src/core/modules/Connection.test.ts
  git commit -m "feat(sdk): gate attemptReconnect on shouldAutoReconnect funnel (change #5)"
  ```

---

#### Task C-T3: `handleKeepaliveTick(displayActive?, sleptMs?)` — display gate + DISPLAY_* dispatch (spec change #2, §8.C)

When `displayActive === false`: no health check, no nudge; send `DISPLAY_INACTIVE` to the machine so a held ladder enters `reconnecting.paused`. Otherwise: send `DISPLAY_ACTIVE`, then route existing connected → `verifyConnectionHealth`, reconnecting → `nudgeReconnect`. A legacy no-arg tick (`displayActive === undefined`) keeps current behaviour (fail-open).

**Files:**
- Modify: `packages/fluux-sdk/src/core/modules/Connection.ts:984` (`handleKeepaliveTick`)
- Test: `packages/fluux-sdk/src/core/modules/Connection.test.ts` (extend the existing `describe('handleKeepaliveTick')` at `:4117`)

Steps:

- [ ] **Step 1: Write the failing tests.** Add inside the existing `describe('handleKeepaliveTick')`. These call the SDK method directly (the wrapper is updated in C-T4; for now drive via `xmppClient.connection.handleKeepaliveTick(...)`):
  ```typescript
  describe('display gating', () => {
    function getActor() {
      return (xmppClient.connection as any).getConnectionActor()
    }

    it('(false) when connected runs NO health check (no SM <r/>)', async () => {
      // outer beforeEach leaves us disconnected; connect first
      const p = xmppClient.connect({
        jid: 'user@example.com', password: 'secret', server: 'example.com', skipDiscovery: true,
      })
      mockXmppClientInstance._emit('online')
      await p
      mockXmppClientInstance.send.mockClear()

      ;(xmppClient.connection as any).handleKeepaliveTick(false, 30_000)
      await vi.advanceTimersByTimeAsync(100)

      expect(mockXmppClientInstance.send).not.toHaveBeenCalled()
    })

    it('(false) sends DISPLAY_INACTIVE to the machine', async () => {
      const actor = getActor()
      const sendSpy = vi.spyOn(actor, 'send')

      ;(xmppClient.connection as any).handleKeepaliveTick(false, 30_000)

      expect(sendSpy).toHaveBeenCalledWith(expect.objectContaining({ type: 'DISPLAY_INACTIVE' }))
      expect(sendSpy).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'DISPLAY_ACTIVE' }))
    })

    it('(true) when connected runs a health check (SM <r/>) and sends DISPLAY_ACTIVE', async () => {
      const p = xmppClient.connect({
        jid: 'user@example.com', password: 'secret', server: 'example.com', skipDiscovery: true,
      })
      mockXmppClientInstance._emit('online')
      await p
      mockXmppClientInstance.send.mockClear()
      const actor = getActor()
      const sendSpy = vi.spyOn(actor, 'send')

      mockXmppClientInstance.send.mockImplementation(() => {
        setTimeout(() => {
          mockXmppClientInstance._emit('nonza', createMockElement('a', { xmlns: 'urn:xmpp:sm:3', h: '5' }))
        }, 50)
        return Promise.resolve()
      })

      ;(xmppClient.connection as any).handleKeepaliveTick(true, 30_000)
      await vi.advanceTimersByTimeAsync(100)

      expect(sendSpy).toHaveBeenCalledWith(expect.objectContaining({ type: 'DISPLAY_ACTIVE' }))
      expect(mockXmppClientInstance.send).toHaveBeenCalled()
    })

    it('(undefined) keeps legacy fail-open behaviour: connected runs a health check', async () => {
      const p = xmppClient.connect({
        jid: 'user@example.com', password: 'secret', server: 'example.com', skipDiscovery: true,
      })
      mockXmppClientInstance._emit('online')
      await p
      mockXmppClientInstance.send.mockClear()
      mockXmppClientInstance.send.mockImplementation(() => {
        setTimeout(() => {
          mockXmppClientInstance._emit('nonza', createMockElement('a', { xmlns: 'urn:xmpp:sm:3', h: '5' }))
        }, 50)
        return Promise.resolve()
      })

      ;(xmppClient.connection as any).handleKeepaliveTick()
      await vi.advanceTimersByTimeAsync(100)

      expect(mockXmppClientInstance.send).toHaveBeenCalled()
    })

    it('(false) x20 during a long display-off creates zero clients (no accumulation)', async () => {
      const p = xmppClient.connect({
        jid: 'user@example.com', password: 'secret', server: 'example.com', skipDiscovery: true,
      })
      mockXmppClientInstance._emit('online')
      await p
      // Kill the socket so the machine is reconnecting.
      mockXmppClientInstance._emit('disconnect', { clean: false })
      await vi.advanceTimersByTimeAsync(1000)
      await vi.advanceTimersByTimeAsync(30_000) // let first attempt fail → waiting
      const clientsBefore = mockClientFactory.mock.calls.length

      for (let i = 0; i < 20; i++) {
        ;(xmppClient.connection as any).handleKeepaliveTick(false, 30_000)
        await vi.advanceTimersByTimeAsync(0)
      }

      expect(mockClientFactory.mock.calls.length).toBe(clientsBefore)
      expect(mockXmppClientInstance.send).not.toHaveBeenCalled()
    })
  })
  ```

- [ ] **Step 2: Run them (expect FAIL).** `cd packages/fluux-sdk && npx vitest run src/core/modules/Connection.test.ts -t "display gating"` — fails: `handleKeepaliveTick` takes no args and ignores `displayActive`, so DISPLAY_* is never sent and `(false)` still runs the probe/nudge.

- [ ] **Step 3: Minimal implementation.** In `Connection.ts`, replace `handleKeepaliveTick` (`:984-994`) and update its JSDoc:
  ```typescript
    /**
     * Handle a keepalive tick from an external clock (e.g., Rust native timer).
     *
     * Display-gated: when `displayActive === false` the tick does NO network
     * work (no health check, no reconnect nudge) and only informs the machine
     * via DISPLAY_INACTIVE so a held backoff ladder enters reconnecting.paused.
     * When `displayActive` is true or undefined (legacy no-arg tick, fail-open):
     * send DISPLAY_ACTIVE, then route by state — reconnecting → nudge, connected
     * → lightweight health check, anything else → no-op.
     *
     * @param displayActive Primary-display power state from the native probe.
     *   `false` => display off (do not reconnect). `undefined` => legacy payload,
     *   treated as active (fail-open).
     * @param sleptMs Real wall-clock elapsed reported by the native loop. A long
     *   gap indicates the machine slept; used to send an immediate wake kick.
     */
    handleKeepaliveTick(displayActive?: boolean, sleptMs?: number): void {
      if (displayActive === false) {
        // Display off: zero outbound work; just release/hold the ladder.
        this.sendMachineEvent({ type: 'DISPLAY_INACTIVE' }, 'keepalive:display-inactive')
        return
      }

      // Display on (or legacy fail-open): mark the machine active. In
      // reconnecting.waiting this acts as an immediate kick to attempting.
      this.sendMachineEvent({ type: 'DISPLAY_ACTIVE' }, 'keepalive:display-active')

      if (this.isInReconnectingState()) {
        // A long elapsed gap means we just woke — go immediately rather than
        // waiting out the (possibly frozen) backoff timer.
        if (sleptMs != null && sleptMs >= SM_SESSION_TIMEOUT_MS) {
          this.handleDeadSocket({ immediateReconnect: true, source: 'keepalive-wake' })
          return
        }
        this.nudgeReconnect()
        return
      }
      if (!this.isInConnectedState()) return
      this.verifyConnectionHealth().catch((err) => {
        const msg = err instanceof Error ? err.message : String(err)
        logInfo(`Keepalive health check error: ${msg}`)
      })
    }
  ```
  Ensure `SM_SESSION_TIMEOUT_MS` is imported at the top of `Connection.ts` (it is already exported from `../connectionMachine`; add to the existing import if not present).

- [ ] **Step 4: Run them (expect PASS).** `cd packages/fluux-sdk && npx vitest run src/core/modules/Connection.test.ts -t "display gating"` — passes. Also re-run the pre-existing `handleKeepaliveTick` tests: `cd packages/fluux-sdk && npx vitest run src/core/modules/Connection.test.ts -t "handleKeepaliveTick"` (the legacy no-arg tests at `:4118-4192` must still pass).

- [ ] **Step 5: Commit.**
  ```bash
  git add packages/fluux-sdk/src/core/modules/Connection.ts packages/fluux-sdk/src/core/modules/Connection.test.ts
  git commit -m "feat(sdk): display-gate handleKeepaliveTick with DISPLAY_* dispatch (change #2)"
  ```

---

#### Task C-T4: Forward `(displayActive, sleptMs)` through the XMPPClient wrapper

**Files:**
- Modify: `packages/fluux-sdk/src/core/XMPPClient.ts:1112` (`handleKeepaliveTick` wrapper)
- Test: `packages/fluux-sdk/src/core/modules/Connection.test.ts` (one wrapper-forwarding test in the `handleKeepaliveTick` describe)

Steps:

- [ ] **Step 1: Write the failing test.** Add inside `describe('handleKeepaliveTick')`:
  ```typescript
  it('XMPPClient.handleKeepaliveTick forwards (displayActive, sleptMs) to the connection', () => {
    const spy = vi.spyOn(xmppClient.connection, 'handleKeepaliveTick')
    xmppClient.handleKeepaliveTick(false, 120_000)
    expect(spy).toHaveBeenCalledWith(false, 120_000)
  })
  ```

- [ ] **Step 2: Run it (expect FAIL).** `cd packages/fluux-sdk && npx vitest run src/core/modules/Connection.test.ts -t "forwards (displayActive, sleptMs)"` — fails: the wrapper drops both args (`this.connection.handleKeepaliveTick()`).

- [ ] **Step 3: Minimal implementation.** In `XMPPClient.ts`, replace the wrapper (`:1112-1114`) and update the JSDoc to mention the new params:
  ```typescript
    /**
     * Handle a keepalive tick from an external clock (e.g., Rust native timer).
     *
     * The SDK routes the tick internally based on connection state and the
     * display-power signal: nudges a stalled reconnect loop, runs a health
     * check when connected, or no-ops. When `displayActive` is `false` the
     * tick does no network work and only informs the state machine.
     *
     * @param displayActive Primary-display power state (undefined = legacy
     *   payload, treated as active / fail-open).
     * @param sleptMs Real wall-clock elapsed reported by the native loop.
     */
    handleKeepaliveTick(displayActive?: boolean, sleptMs?: number): void {
      this.connection.handleKeepaliveTick(displayActive, sleptMs)
    }
  ```

- [ ] **Step 4: Run it (expect PASS).** `cd packages/fluux-sdk && npx vitest run src/core/modules/Connection.test.ts -t "forwards (displayActive, sleptMs)"` — passes. Then `npm run typecheck` from repo root.

- [ ] **Step 5: Commit.**
  ```bash
  git add packages/fluux-sdk/src/core/XMPPClient.ts packages/fluux-sdk/src/core/modules/Connection.test.ts
  git commit -m "feat(sdk): forward displayActive/sleptMs through XMPPClient keepalive wrapper"
  ```

---

#### Task C-T5: Capture `streamManagement.max` → `SM_ENABLED` event (spec change #6)

When SM is enabled, read the server's `<enabled max="…">` (seconds, may be absent) and send `{ type: "SM_ENABLED", maxMs: max*1000 }` to the machine so the resume-viability guards compare against the server window. The `<enabled/>` nonza handler at `Connection.ts:1767-1785` already reads `nonza.attrs.max`.

**Files:**
- Modify: `packages/fluux-sdk/src/core/modules/Connection.ts:1768` (inside the `<enabled/>` nonza branch)
- Test: `packages/fluux-sdk/src/core/modules/Connection.test.ts` (new `describe('SM server resume window (change #6)')`)

Steps:

- [ ] **Step 1: Write the failing test.** The `<enabled/>` nonza is emitted on the real connect path. Spy on the actor's `send` and assert the `SM_ENABLED` event with the converted ms; assert no event (or no `maxMs`) when `max` is absent:
  ```typescript
  describe('SM server resume window (change #6)', () => {
    function getActor() {
      return (xmppClient.connection as any).getConnectionActor()
    }

    it('sends SM_ENABLED with maxMs derived from <enabled max> seconds', async () => {
      const actor = getActor()
      const sendSpy = vi.spyOn(actor, 'send')

      const p = xmppClient.connect({
        jid: 'user@example.com', password: 'secret', server: 'example.com', skipDiscovery: true,
      })
      // Give the live SM object an id so the persistence branch is satisfied.
      ;(mockXmppClientInstance as any).streamManagement = { id: 'sm-id-123', inbound: 0, enabled: true }
      mockXmppClientInstance._emit('nonza', createMockElement('enabled', { xmlns: 'urn:xmpp:sm:3', id: 'sm-id-123', max: '300' }))
      mockXmppClientInstance._emit('online')
      await p

      expect(sendSpy).toHaveBeenCalledWith({ type: 'SM_ENABLED', maxMs: 300_000 })
    })

    it('does not send SM_ENABLED when the server omits max', async () => {
      const actor = getActor()
      const sendSpy = vi.spyOn(actor, 'send')

      const p = xmppClient.connect({
        jid: 'user@example.com', password: 'secret', server: 'example.com', skipDiscovery: true,
      })
      ;(mockXmppClientInstance as any).streamManagement = { id: 'sm-id-456', inbound: 0, enabled: true }
      mockXmppClientInstance._emit('nonza', createMockElement('enabled', { xmlns: 'urn:xmpp:sm:3', id: 'sm-id-456' }))
      mockXmppClientInstance._emit('online')
      await p

      expect(sendSpy).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'SM_ENABLED' }))
    })
  })
  ```

- [ ] **Step 2: Run them (expect FAIL).** `cd packages/fluux-sdk && npx vitest run src/core/modules/Connection.test.ts -t "SM server resume window"` — fails: no `SM_ENABLED` event is ever sent.

- [ ] **Step 3: Minimal implementation.** In `Connection.ts`, inside the `if (nonza.is('enabled', 'urn:xmpp:sm:3'))` branch (`:1768`), right after the existing `logInfo(\`SM enabled ...\`)` line (`:1773`), before `this.smResumeCompleted = true`:
  ```typescript
        // Source the SM resume window from the server (XEP-0198 §3 <enabled max>,
        // seconds). The machine guards compare sleep duration against this window
        // instead of the hardcoded SM_SESSION_TIMEOUT_MS, which over-estimates
        // (ejabberd often grants 300s). Only override when the server sends max;
        // otherwise the machine keeps its SM_SESSION_TIMEOUT_MS default.
        if (nonza.attrs.max != null) {
          const maxSec = Number(nonza.attrs.max)
          if (Number.isFinite(maxSec) && maxSec > 0) {
            this.sendMachineEvent(
              { type: 'SM_ENABLED', maxMs: maxSec * 1000 },
              'sm-enabled:server-max'
            )
          }
        }
  ```
  (`sendMachineEvent` accepts `ConnectionMachineEvent`; the machine group has added `SM_ENABLED` to the union, so this typechecks once that group's change is present.)

- [ ] **Step 4: Run them (expect PASS).** `cd packages/fluux-sdk && npx vitest run src/core/modules/Connection.test.ts -t "SM server resume window"` — passes. Then `npm run typecheck` from repo root.

- [ ] **Step 5: Commit.**
  ```bash
  git add packages/fluux-sdk/src/core/modules/Connection.ts packages/fluux-sdk/src/core/modules/Connection.test.ts
  git commit -m "feat(sdk): capture server SM max and emit SM_ENABLED (change #6)"
  ```

---

#### Task C-T6: Race — KEEPALIVE concurrent with handleAwake respects `deadSocketRecoveryInProgress` (§8.E)

A display-active keepalive wake kick (`handleKeepaliveTick(true, longSleptMs)`) firing concurrently with an in-flight `handleAwake` must not spawn a second `attemptReconnect` / second client — the existing `handleAwakeInFlight` single-flight + `deadSocketRecoveryInProgress` guard must coalesce them.

**Files:**
- Test only: `packages/fluux-sdk/src/core/modules/Connection.races.test.ts` (new test in the `Connection race conditions` describe, using the existing `connectAndGoOnline` / `getMachineState` / `hasActiveClient` helpers at `:71-99`)

Steps:

- [ ] **Step 1: Write the failing test.** Add to `Connection.races.test.ts`:
  ```typescript
  it('coalesces a display-active keepalive wake kick concurrent with handleAwake into a single reconnect', async () => {
    await connectAndGoOnline(xmppClient, mockXmppClientInstance)

    // Socket dies → machine goes reconnecting; first attempt in flight.
    mockXmppClientInstance._emit('disconnect', { clean: false })
    await vi.advanceTimersByTimeAsync(1000)
    await vi.advanceTimersByTimeAsync(30_000) // first attempt fails → reconnecting.waiting

    mockClientFactory.mockClear()

    // Fire both wake paths within the same tick: the OS deferred-wake path and
    // the native keepalive wake kick (long sleptMs), both display-active.
    void (xmppClient as any).notifySystemState('awake', SM_SESSION_TIMEOUT_MS + 60_000)
    ;(xmppClient.connection as any).handleKeepaliveTick(true, SM_SESSION_TIMEOUT_MS + 60_000)

    await vi.advanceTimersByTimeAsync(2000)

    // Only a single new client is created despite two concurrent wake signals.
    expect(mockClientFactory.mock.calls.length).toBeLessThanOrEqual(1)
  })
  ```

- [ ] **Step 2: Run it (expect FAIL or PASS-confirm).** `cd packages/fluux-sdk && npx vitest run src/core/modules/Connection.races.test.ts -t "coalesces a display-active keepalive wake kick"`. If it FAILs (two clients created), the keepalive wake-kick path bypasses the single-flight; proceed to Step 3. If it already passes (the `handleDeadSocket` + `handleAwakeInFlight`/`deadSocketRecoveryInProgress` guards already coalesce), record that the C-T3 implementation satisfies the race and skip to Step 5 (the test still pins the invariant).

- [ ] **Step 3: Minimal implementation (only if Step 2 failed).** In `Connection.ts` `handleKeepaliveTick`, guard the wake-kick branch with the existing single-flight flag so it does not stack on an in-flight wake recovery. Replace the `sleptMs >= SM_SESSION_TIMEOUT_MS` branch added in C-T3 with:
  ```typescript
        if (sleptMs != null && sleptMs >= SM_SESSION_TIMEOUT_MS) {
          // Defer to an in-flight wake recovery rather than spawning a parallel
          // teardown+reconnect (handleAwake's single-flight already owns it).
          if (this.deadSocketRecoveryInProgress || this.handleAwakeInFlight) {
            this.nudgeReconnect()
            return
          }
          this.handleDeadSocket({ immediateReconnect: true, source: 'keepalive-wake' })
          return
        }
  ```

- [ ] **Step 4: Run it (expect PASS).** `cd packages/fluux-sdk && npx vitest run src/core/modules/Connection.races.test.ts -t "coalesces a display-active keepalive wake kick"` — passes. Then run both connection suites: `cd packages/fluux-sdk && npx vitest run src/core/modules/Connection.test.ts src/core/modules/Connection.races.test.ts`.

- [ ] **Step 5: Commit.**
  ```bash
  git add packages/fluux-sdk/src/core/modules/Connection.ts packages/fluux-sdk/src/core/modules/Connection.races.test.ts
  git commit -m "test(sdk): pin keepalive-wake/handleAwake single-flight coalescing (race)"
  ```

---


## Phase D — App-layer wiring (spec #2/#4/#5; blockers B1/B2)

## Task Group D — App-layer wiring (spec changes #2, #4, #5 app-layer; blockers B1/B2)

These tasks assume the contract signatures from groups A/B (`XMPPClientConfig.shouldAutoReconnect`, `XMPPClient.handleKeepaliveTick(displayActive?, sleptMs?)`, the new `reconnecting.paused` substate that still maps to status `'reconnecting'`) and group C (the `usePlatformState` pure fns `parseKeepalivePayload`, `shouldRunKeepaliveReconnect`, `isKeepaliveWakeTick`, plus the `KeepalivePayload` interface and `SLEEP_THRESHOLD_MS` already present) already exist. Group C lands the pure fns in `usePlatformState.ts`; Group D consumes them in the hook's effects and in App.tsx.

> Test commands: app → `cd apps/fluux && npx vitest run <path>`. Pre-commit gate (CLAUDE.md): tests pass with no stderr, `npm run typecheck` clean, lint clean.

---

#### Task D-T1 — Effect 5 keepalive gate (parse + intent/display early-out + wake-tick cooldown + forward args)

Rewire the `xmpp-keepalive` listener (`apps/fluux/src/hooks/usePlatformState.ts:636-640`) so it parses the structured payload, applies the intent+display gate via `shouldRunKeepaliveReconnect(parseKeepalivePayload(raw), getReconnectIntent())`, routes sleep-gap ticks through `shouldHandleWake('keepalive')` for the post-reload cooldown / debounce, otherwise calls `client.handleKeepaliveTick(payload.displayActive, payload.sleptMs)`, and maintains a `displayActiveRef` (default `true`).

**Files:**
- Modify: `apps/fluux/src/hooks/usePlatformState.ts:636-640` (keepalive listener inside Effect 5), plus a new `displayActiveRef` in the Refs block near `:216-224`, plus a new import line near `:1-6`.
- Test: `apps/fluux/src/hooks/usePlatformState.test.tsx`

Steps:

- [ ] **Step 1: write the failing tests.** Add a `getReconnectIntent` mock and a keepalive `describe` block. The mock module must be added with the other `vi.mock` calls (near `:53-91`), and the `mockClientHandleKeepaliveTick` added to the hoisted block + the `useXMPP` client mock.

  In the `vi.hoisted` return object (`:23-41`) add:
  ```ts
    mockClientHandleKeepaliveTick: vi.fn(),
    mockGetReconnectIntent: vi.fn(() => 'active' as 'active' | 'logged-out'),
  ```
  and destructure them at `:8-19`.

  Add the client method to the `useXMPP` mock (`:65-70`):
  ```ts
        handleKeepaliveTick: mockClientHandleKeepaliveTick,
  ```
  Add a new mock after the `@fluux/sdk` mock (`:91`):
  ```ts
  vi.mock('@/utils/reconnectIntent', () => ({
    getReconnectIntent: () => mockGetReconnectIntent(),
  }))
  ```
  Then the new test block:
  ```ts
  describe('Effect 5 keepalive gate', () => {
    const fireKeepalive = async (payload: unknown) => {
      await act(async () => {
        await Promise.resolve() // let listen() register
      })
      const handler = tauriListeners.get('xmpp-keepalive')
      expect(handler).toBeDefined()
      await act(async () => {
        handler!({ payload })
        await Promise.resolve()
      })
    }

    beforeEach(() => {
      ;(window as any).__TAURI_INTERNALS__ = {}
      mockGetReconnectIntent.mockReturnValue('active')
    })

    it('forwards displayActive + sleptMs to handleKeepaliveTick on a steady-state tick', async () => {
      mockConnectionStatus.current = 'online'
      renderHook(() => usePlatformState())
      await fireKeepalive({ displayActive: true, sleptMs: 30_000 })
      expect(mockClientHandleKeepaliveTick).toHaveBeenCalledWith(true, 30_000)
    })

    it('does not call handleKeepaliveTick when displayActive is false', async () => {
      mockConnectionStatus.current = 'online'
      renderHook(() => usePlatformState())
      await fireKeepalive({ displayActive: false, sleptMs: 30_000 })
      expect(mockClientHandleKeepaliveTick).not.toHaveBeenCalled()
    })

    it('does not call handleKeepaliveTick when intent is logged-out', async () => {
      mockGetReconnectIntent.mockReturnValue('logged-out')
      mockConnectionStatus.current = 'online'
      renderHook(() => usePlatformState())
      await fireKeepalive({ displayActive: true, sleptMs: 30_000 })
      expect(mockClientHandleKeepaliveTick).not.toHaveBeenCalled()
    })

    it('treats a legacy () payload as display-active (fail-open)', async () => {
      mockConnectionStatus.current = 'online'
      renderHook(() => usePlatformState())
      await fireKeepalive(undefined)
      expect(mockClientHandleKeepaliveTick).toHaveBeenCalledWith(undefined, undefined)
    })

    it('routes a wake-tick through the post-reload cooldown (suppressed within cooldown)', async () => {
      writeReloadMarker(Date.now() - 1_000)
      mockConnectionStatus.current = 'reconnecting'
      renderHook(() => usePlatformState())
      await fireKeepalive({ displayActive: true, sleptMs: 600_000 })
      expect(mockClientHandleKeepaliveTick).not.toHaveBeenCalled()
    })

    it('runs a wake-tick once the cooldown has elapsed', async () => {
      clearReloadMarker()
      mockConnectionStatus.current = 'reconnecting'
      renderHook(() => usePlatformState())
      await fireKeepalive({ displayActive: true, sleptMs: 600_000 })
      expect(mockClientHandleKeepaliveTick).toHaveBeenCalledWith(true, 600_000)
    })
  })
  ```

- [ ] **Step 2: run it (expect FAIL).** `cd apps/fluux && npx vitest run src/hooks/usePlatformState.test.tsx` — expected FAIL: `mockClientHandleKeepaliveTick` is never called (current listener calls `client.handleKeepaliveTick()` with no args and no gate), and `@/utils/reconnectIntent` is not imported by the hook.

- [ ] **Step 3: minimal implementation.** Add the import at the top of `usePlatformState.ts` (after line 6):
  ```ts
  import { getReconnectIntent } from '@/utils/reconnectIntent'
  ```
  Add a ref in the Refs block (after `osIdleUnavailableLoggedRef` at `:224`):
  ```ts
    // Last keepalive tick's displayActive value. Defaults true pre-first-tick
    // so a cold-start visibility/focus nudge still works (fail-open).
    const displayActiveRef = useRef(true)
  ```
  Replace the keepalive listener (`:636-640`) with:
  ```ts
        // Rust-driven keepalive tick every 30s. The Rust thread keeps emitting
        // even when the display is asleep; the JS-side reconnect work is gated
        // here. The SDK routes the tick internally (nudge / health check / no-op).
        void listen('xmpp-keepalive', (event) => {
          const payload = parseKeepalivePayload(event?.payload)
          displayActiveRef.current = payload.displayActive !== false
          // Intent gate (defense-in-depth, change #5) + display gate (contract
          // rule 1): never even nudge when logged-out or while display asleep.
          if (!shouldRunKeepaliveReconnect(payload, getReconnectIntent())) return
          // A sleep-gap tick is a wake signal: honor the post-reload cooldown
          // and the cross-source debounce. A steady-state ~30s tick skips that
          // and just runs the health probe.
          if (isKeepaliveWakeTick(payload.sleptMs) && !shouldHandleWake('keepalive')) {
            return
          }
          client.handleKeepaliveTick(payload.displayActive, payload.sleptMs)
        }).then((fn) => {
          if (cleanedUp) { fn() } else { unlistenKeepalive = fn }
        })
  ```
  Add `shouldHandleWake` to Effect 5's dependency array (`:678`): change `}, [client])` to `}, [client, shouldHandleWake])`.

- [ ] **Step 4: run it (expect PASS).** `cd apps/fluux && npx vitest run src/hooks/usePlatformState.test.tsx` — expected PASS for the new block and all pre-existing tests.

- [ ] **Step 5: typecheck + commit.** `cd apps/fluux && npx tsc --noEmit -p tsconfig.json` clean, then:
  ```
  git add apps/fluux/src/hooks/usePlatformState.ts apps/fluux/src/hooks/usePlatformState.test.tsx
  git commit -m "feat(app): gate keepalive reconnect on display + intent, route wake-ticks through cooldown"
  ```

---

#### Task D-T2 — Effect 4 visibility/focus nudge suppressed when display asleep

When the last keepalive tick reported `displayActive=false`, the `visibilitychange→visible` nudge and the `window.focus` nudge in Effect 4 must not call `notifySystemState('visible')` — reconnect stays display-gated. `displayActiveRef` (added in T1) defaults `true`, so cold-start focus still nudges.

**Files:**
- Modify: `apps/fluux/src/hooks/usePlatformState.ts` Effect 4 — the `notifySystemState('visible')` site at `:592-596` and the `handleWindowFocus` body at `:605-613`.
- Test: `apps/fluux/src/hooks/usePlatformState.test.tsx`

Steps:

- [ ] **Step 1: write the failing tests.** Add to the `window focus reconnect trigger` describe (after `:301`), reusing the existing keepalive `fireKeepalive` helper pattern inline:
  ```ts
    it('suppresses the focus nudge when the last keepalive tick was displayActive=false', async () => {
      ;(window as any).__TAURI_INTERNALS__ = {}
      mockConnectionStatus.current = 'reconnecting'
      renderHook(() => usePlatformState())

      // A display-off tick lands first, recording displayActive=false.
      await act(async () => { await Promise.resolve() })
      const ka = tauriListeners.get('xmpp-keepalive')
      await act(async () => {
        ka?.({ payload: { displayActive: false, sleptMs: 30_000 } })
        await Promise.resolve()
      })
      vi.clearAllMocks()

      await act(async () => {
        window.dispatchEvent(new Event('focus'))
        await Promise.resolve()
      })

      expect(mockClientNotifySystemState).not.toHaveBeenCalledWith('visible')
    })

    it('still nudges on focus before any tick has arrived (cold-start fail-open)', async () => {
      mockConnectionStatus.current = 'reconnecting'
      renderHook(() => usePlatformState())

      await act(async () => {
        window.dispatchEvent(new Event('focus'))
        await Promise.resolve()
      })

      expect(mockClientNotifySystemState).toHaveBeenCalledWith('visible')
    })
  ```

- [ ] **Step 2: run it (expect FAIL).** `cd apps/fluux && npx vitest run src/hooks/usePlatformState.test.tsx` — expected FAIL on the first new test: the focus handler still nudges regardless of the last tick's display state.

- [ ] **Step 3: minimal implementation.** In `handleWindowFocus` (`:605-613`), add the guard after the status check:
  ```ts
      const handleWindowFocus = () => {
        if (statusRef.current !== 'reconnecting') return
        // Reconnect is display-gated: if the last keepalive tick reported the
        // primary display off, a focus event must not nudge a reconnect.
        if (!displayActiveRef.current) return
        if (!shouldHandleWake('window-focus')) return

        console.log('[PlatformState] Window focused while reconnecting, triggering reconnect')
        client.notifySystemState('visible').catch((err) => {
          console.error('[PlatformState] Error handling window focus:', err)
        })
      }
  ```
  In the `handleVisibilityChange` non-reload nudge branch (`:590-596`), guard the `'visible'` notify:
  ```ts
        // Sub-threshold, machine was awake, or web mode: just nudge a
        // stalled reconnect via notifySystemState('visible') — unless the
        // last keepalive tick reported the display off (display-gated reconnect).
        if (!displayActiveRef.current) return
        try {
          await client.notifySystemState('visible')
        } catch (err) {
          console.error('[PlatformState] Error handling visibility change:', err)
        }
  ```

- [ ] **Step 4: run it (expect PASS).** `cd apps/fluux && npx vitest run src/hooks/usePlatformState.test.tsx` — expected PASS for the two new tests and all existing visibility/focus tests.

- [ ] **Step 5: typecheck + commit.** `cd apps/fluux && npx tsc --noEmit -p tsconfig.json` clean, then:
  ```
  git add apps/fluux/src/hooks/usePlatformState.ts apps/fluux/src/hooks/usePlatformState.test.tsx
  git commit -m "feat(app): suppress visibility/focus reconnect nudge while primary display is off"
  ```

---

#### Task D-T3 — Effect 2 demotion: OS wake/deferred-wake reload-only (no notifySystemState('awake'))

`system-did-wake` and `system-did-wake-deferred` are demoted to rendering-only. They run the reload path via `maybeReloadOnLongWake` but never call `client.notifySystemState('awake')` — the keepalive tick is now the reconnect authority. `system-will-sleep` is unchanged (it still records `sleepStartRef`).

**Files:**
- Modify: `apps/fluux/src/hooks/usePlatformState.ts` — Effect 2 wake handlers (`:460-490`); the shared `handleWakeFromSleep` (`:318-333`) is no longer used by Effect 2, so the wake handlers call a new reload-only path.
- Test: `apps/fluux/src/hooks/usePlatformState.test.tsx`

Steps:

- [ ] **Step 1: write the failing tests.** Add a new describe block:
  ```ts
  describe('Effect 2 OS-wake demotion (reload-only)', () => {
    beforeEach(() => {
      ;(window as any).__TAURI_INTERNALS__ = {}
      clearReloadMarker()
    })

    it('does NOT call notifySystemState("awake") on system-did-wake (reconnect is keepalive-driven)', async () => {
      mockConnectionStatus.current = 'online'
      renderHook(() => usePlatformState())
      await act(async () => { await Promise.resolve() })

      const wake = tauriListeners.get('system-did-wake')
      expect(wake).toBeDefined()
      await act(async () => {
        wake!({ payload: { displayActive: true } })
        await Promise.resolve()
      })

      expect(mockClientNotifySystemState).not.toHaveBeenCalledWith('awake', expect.anything())
    })

    it('does NOT call notifySystemState("awake") on system-did-wake-deferred', async () => {
      mockConnectionStatus.current = 'online'
      renderHook(() => usePlatformState())
      await act(async () => { await Promise.resolve() })

      const deferred = tauriListeners.get('system-did-wake-deferred')
      expect(deferred).toBeDefined()
      await act(async () => {
        deferred!({ payload: 9000 })
        await Promise.resolve()
      })

      expect(mockClientNotifySystemState).not.toHaveBeenCalledWith('awake', expect.anything())
    })
  })
  ```

- [ ] **Step 2: run it (expect FAIL).** `cd apps/fluux && npx vitest run src/hooks/usePlatformState.test.tsx` — expected FAIL: both handlers currently call `handleWakeFromSleep`, which calls `client.notifySystemState('awake', durationMs)`.

- [ ] **Step 3: minimal implementation.** Replace the two wake handler bodies in Effect 2 (`:460-490`) so they call `maybeReloadOnLongWake` directly instead of `handleWakeFromSleep`:
  ```ts
        // Immediate wake notification — DEMOTED to rendering-only. The native
        // keepalive tick is the reconnect authority now; OS wake only triggers
        // the WRY webview reload when the sleep span is long enough.
        void listen<SystemWakePayload | undefined>('system-did-wake', (event) => {
          if (cancelled) return
          if (!shouldHandleDisplayWake(event.payload)) {
            console.log('[PlatformState] Ignoring system-did-wake (display asleep / DarkWake)')
            logEvent('Ignored wake (display asleep / DarkWake)')
            return
          }
          if (!shouldHandleWake('system-did-wake')) return
          const sleepDuration = sleepStartRef.current ? Date.now() - sleepStartRef.current : undefined
          sleepStartRef.current = null
          maybeReloadOnLongWake(sleepDuration, 'system-did-wake')
        }).then(fn => {
          if (cancelled) { fn() } else { unlistenWake = fn }
        })

        // Deferred wake notification — DEMOTED to rendering-only (same rationale).
        void listen<number>('system-did-wake-deferred', (event) => {
          if (cancelled) return
          const delaySecs = event.payload || 0
          if (!shouldHandleWake('system-did-wake-deferred')) return
          const sleepDuration = sleepStartRef.current ? Date.now() - sleepStartRef.current : undefined
          sleepStartRef.current = null
          maybeReloadOnLongWake(sleepDuration, `system-did-wake-deferred +${delaySecs}s`)
        }).then(fn => {
          if (cancelled) { fn() } else { unlistenWakeDeferred = fn }
        })
  ```
  Update Effect 2's dependency array (`:510`): replace `handleWakeFromSleep` with `maybeReloadOnLongWake` → `}, [client, shouldHandleWake, logEvent, maybeReloadOnLongWake])`.

- [ ] **Step 4: run it (expect PASS).** `cd apps/fluux && npx vitest run src/hooks/usePlatformState.test.tsx` — expected PASS. (Note: `handleWakeFromSleep` and the heartbeat Effect 3 remain unchanged — the existing heartbeat tests still pass.)

- [ ] **Step 5: typecheck + lint + commit.** `cd apps/fluux && npx tsc --noEmit -p tsconfig.json` clean; if `handleWakeFromSleep` is now only referenced by Effect 3, leave it (still used by the heartbeat). Then:
  ```
  git add apps/fluux/src/hooks/usePlatformState.ts apps/fluux/src/hooks/usePlatformState.test.tsx
  git commit -m "feat(app): demote OS wake events to reload-only (keepalive owns reconnect)"
  ```

---

#### Task D-T4 — Window-shown reload routed through maybeReloadOnLongWake

The inline `window.location.reload()` in Effect 4's visibility handler (`:582-588`) is replaced by routing through `maybeReloadOnLongWake`, so the reload decision is unit-testable via the pure `shouldReloadOnVisibilityWake` cross-check and the marker is written consistently. The heartbeat cross-check (`shouldReloadOnVisibilityWake`) gates whether we even attempt the reload.

**Files:**
- Modify: `apps/fluux/src/hooks/usePlatformState.ts` Effect 4 visibility reload branch (`:577-588`).
- Test: `apps/fluux/src/hooks/usePlatformState.test.tsx`

Steps:

- [ ] **Step 1: write the failing test.** The existing inline path calls `window.location.reload()` directly without writing the reload marker. Add a test asserting the marker is written when a long visibility-wake occurs in Tauri (proving it routed through `maybeReloadOnLongWake`, which is the only writer of the marker). Because `window.location.reload` is not implemented in jsdom, stub it:
  ```ts
  describe('Effect 4 window-shown reload routing', () => {
    beforeEach(() => {
      ;(window as any).__TAURI_INTERNALS__ = {}
      clearReloadMarker()
    })

    it('routes a long visibility-wake reload through maybeReloadOnLongWake (writes the reload marker)', async () => {
      const reloadSpy = vi.fn()
      Object.defineProperty(window, 'location', {
        configurable: true,
        value: { ...window.location, reload: reloadSpy },
      })

      const start = Date.now()
      mockConnectionStatus.current = 'online'
      renderHook(() => usePlatformState())

      // Hide the page.
      await act(async () => {
        Object.defineProperty(document, 'hidden', { configurable: true, value: true })
        document.dispatchEvent(new Event('visibilitychange'))
        await Promise.resolve()
      })

      // Advance the clock past SLEEP_THRESHOLD_MS so both hidden-span AND
      // heartbeat-gap exceed it (real sleep), then show the page.
      vi.setSystemTime(new Date(start + 200_000))
      await act(async () => {
        Object.defineProperty(document, 'hidden', { configurable: true, value: false })
        document.dispatchEvent(new Event('visibilitychange'))
        await Promise.resolve()
      })

      expect(reloadSpy).toHaveBeenCalled()
      expect(readReloadMarker()).toBeGreaterThan(0)
    })
  })
  ```

- [ ] **Step 2: run it (expect FAIL).** `cd apps/fluux && npx vitest run src/hooks/usePlatformState.test.tsx` — expected FAIL on `readReloadMarker()` (the current inline reload at `:586` does not write the marker; only `maybeReloadOnLongWake` does).

- [ ] **Step 3: minimal implementation.** Replace the inline reload branch (`:582-588`) with a call through `maybeReloadOnLongWake`, keeping the heartbeat cross-check as the gate:
  ```ts
        // If the hide was long enough to count as a real sleep on Tauri,
        // reload the webview (same rendering-context hazard as OS sleep).
        // Cross-check the JS heartbeat: a small gap means JS was running
        // (machine awake, app merely hidden) — no rendering loss, no reload.
        // Route through maybeReloadOnLongWake so the decision/marker write is
        // shared with the OS-wake path and unit-testable.
        if (shouldReloadOnVisibilityWake(hiddenDuration, heartbeatGap, isTauri())) {
          if (maybeReloadOnLongWake(hiddenDuration, 'visibility')) return
        }
  ```

- [ ] **Step 4: run it (expect PASS).** `cd apps/fluux && npx vitest run src/hooks/usePlatformState.test.tsx` — expected PASS for the new test plus the existing `shouldReloadOnVisibilityWake` pure-fn tests.

- [ ] **Step 5: typecheck + commit.** `cd apps/fluux && npx tsc --noEmit -p tsconfig.json` clean, then:
  ```
  git add apps/fluux/src/hooks/usePlatformState.ts apps/fluux/src/hooks/usePlatformState.test.tsx
  git commit -m "feat(app): route window-shown reload through maybeReloadOnLongWake"
  ```

---

#### Task D-T5 — Wire shouldAutoReconnect predicate into XMPPProvider → client construction

Thread an injected `shouldAutoReconnect: () => boolean` predicate from `main.tsx` through `XMPPProvider` into `XMPPClientConfig`, wired to `() => getReconnectIntent() === 'active'`. This realizes the systemic intent gate (change #5, B1) at the app boundary. (The SDK consumes it in `Connection.attemptReconnect` — group B.)

**Files:**
- Modify: `packages/fluux-sdk/src/provider/XMPPProvider.tsx` — add `shouldAutoReconnect?` to `XMPPProviderProps` (`:30-84`) and pass it into the `config` object (`:157`).
- Modify: `apps/fluux/src/main.tsx` — import `getReconnectIntent`, pass the prop (`:112`).
- Test: `packages/fluux-sdk/src/provider/XMPPProvider.persistence.test.tsx` (extend) — assert the prop flows into the constructed client config.

Steps:

- [ ] **Step 1: write the failing test.** Inspect `XMPPProvider.persistence.test.tsx` for its existing `XMPPClient` mock; add a test that renders `<XMPPProvider shouldAutoReconnect={...}>` (no `client` prop) and asserts the captured `XMPPClientConfig` includes the predicate. Concretely, if the test mocks `../core/XMPPClient`, capture the constructor arg:
  ```ts
  it('threads shouldAutoReconnect into the constructed client config', () => {
    const predicate = () => true
    render(
      <XMPPProvider shouldAutoReconnect={predicate}>
        <div />
      </XMPPProvider>
    )
    // XMPPClient mock records constructor config as capturedConfig
    expect(capturedConfig.shouldAutoReconnect).toBe(predicate)
  })
  ```
  (Match the existing mock's capture mechanism in that file; if the file currently constructs a real `XMPPClient`, add a `vi.mock('../core/XMPPClient', ...)` that records the config, following the pattern already used for the `client`-injection tests.)

- [ ] **Step 2: run it (expect FAIL).** `cd packages/fluux-sdk && npx vitest run src/provider/XMPPProvider.persistence.test.tsx` — expected FAIL: `XMPPProviderProps` has no `shouldAutoReconnect`, so the prop is dropped and `capturedConfig.shouldAutoReconnect` is `undefined`.

- [ ] **Step 3: minimal implementation.** In `XMPPProvider.tsx`, add to `XMPPProviderProps` (after `client?` at `:83`):
  ```ts
    /**
     * Predicate evaluated live at every reconnect funnel to decide whether the
     * client may auto-reconnect. The app wires this to
     * `() => getReconnectIntent() === 'active'` so the SDK stays headless — it
     * knows "allowed?", not the localStorage flag. Omitted → always allowed.
     */
    shouldAutoReconnect?: () => boolean
  ```
  Add it to the destructured props (`:139-145`):
  ```ts
    shouldAutoReconnect,
  ```
  Pass it into the config (`:157`):
  ```ts
        const config: XMPPClientConfig = { debug, storageAdapter, proxyAdapter, shouldAutoReconnect }
  ```

- [ ] **Step 4: run it (expect PASS).** `cd packages/fluux-sdk && npx vitest run src/provider/XMPPProvider.persistence.test.tsx` — expected PASS. Then rebuild the SDK so the app sees the new prop: `npm run build:sdk` (from repo root).

- [ ] **Step 5: wire main.tsx.** Add the import in `apps/fluux/src/main.tsx` (after `:17`):
  ```ts
  import { getReconnectIntent } from './utils/reconnectIntent'
  ```
  Update the provider element (`:112`):
  ```tsx
        <XMPPProvider
          debug={import.meta.env.DEV}
          proxyAdapter={proxyAdapter}
          shouldAutoReconnect={() => getReconnectIntent() === 'active'}
        >
  ```

- [ ] **Step 6: typecheck + commit.** `cd packages/fluux-sdk && npx tsc --noEmit` clean and `cd apps/fluux && npx tsc --noEmit -p tsconfig.json` clean, then:
  ```
  git add packages/fluux-sdk/src/provider/XMPPProvider.tsx packages/fluux-sdk/src/provider/XMPPProvider.persistence.test.tsx apps/fluux/src/main.tsx packages/fluux-sdk/dist
  git commit -m "feat(app): inject shouldAutoReconnect=getReconnectIntent()===active into the SDK client"
  ```

---

#### Task D-T6 — App.tsx spinner not stranded when reconnecting while display asleep (B2 / §8.E)

When the machine holds in `reconnecting.paused` (display off) during the *initial* auto-reconnect, `status` stays `'reconnecting'` and the full-screen spinner (`isAutoReconnecting && !hasBeenOnline && status !== 'online'`) would spin forever. Expose `displayActive` from `usePlatformState` and have App drop the full-screen spinner (rendering ChatLayout / paused chrome) when the display is reported off.

**Files:**
- Modify: `apps/fluux/src/hooks/usePlatformState.ts` — change the hook's return from `void` to `{ displayActive: boolean }`, backed by reactive state synced from `displayActiveRef`.
- Modify: `apps/fluux/src/App.tsx` — consume the returned `displayActive` (`:77`) and add it to the spinner gate (`:340`).
- Test: `apps/fluux/src/App.reconnect.test.tsx` (extend) + `apps/fluux/src/hooks/usePlatformState.test.tsx` (return-value test).

Steps:

- [ ] **Step 1: write the failing tests.**

  In `usePlatformState.test.tsx`, add to the `Effect 5 keepalive gate` describe:
  ```ts
    it('returns displayActive=false after a display-off tick', async () => {
      mockConnectionStatus.current = 'online'
      const { result } = renderHook(() => usePlatformState())
      await act(async () => { await Promise.resolve() })
      const ka = tauriListeners.get('xmpp-keepalive')
      await act(async () => {
        ka?.({ payload: { displayActive: false, sleptMs: 30_000 } })
        await Promise.resolve()
      })
      expect(result.current.displayActive).toBe(false)
    })

    it('defaults displayActive=true before any tick', () => {
      mockConnectionStatus.current = 'reconnecting'
      const { result } = renderHook(() => usePlatformState())
      expect(result.current.displayActive).toBe(true)
    })
  ```

  In `App.reconnect.test.tsx`, the `usePlatformState` mock currently returns `undefined`. Change it to return a controllable value and add a test. Update the hoisted mock and the `vi.mock`:
  ```ts
  // in vi.hoisted: add mockPlatformDisplayActive: { current: true }
  vi.mock('./hooks/usePlatformState', () => ({
    usePlatformState: () => {
      mockUsePlatformState()
      return { displayActive: mockPlatformDisplayActive.current }
    },
  }))
  ```
  Add a test in the `App connection gate — initial load and fresh login` describe:
  ```ts
    it('drops the full-screen spinner and shows ChatLayout when reconnecting while display is asleep (B2)', () => {
      // Initial auto-reconnect (stored session, never been online) holds in
      // reconnecting.paused: status stays 'reconnecting' forever. The spinner
      // must NOT strand — render ChatLayout (paused chrome) instead.
      mockPlatformDisplayActive.current = false
      mockGetSession.mockReturnValue({
        jid: 'user@example.com',
        password: 'secret',
        server: 'example.com',
      })
      mockUseConnectionStatus.mockReturnValue({ status: 'reconnecting', jid: 'user@example.com' })

      render(
        <MemoryRouter initialEntries={['/messages']}>
          <App />
        </MemoryRouter>
      )

      expect(screen.queryByText('Reconnecting...')).not.toBeInTheDocument()
      expect(screen.getByTestId('chat-layout')).toBeInTheDocument()
    })

    it('still shows the spinner when reconnecting with display active (normal initial reconnect)', () => {
      mockPlatformDisplayActive.current = true
      mockGetSession.mockReturnValue({
        jid: 'user@example.com',
        password: 'secret',
        server: 'example.com',
      })
      mockUseConnectionStatus.mockReturnValue({ status: 'reconnecting', jid: 'user@example.com' })

      render(
        <MemoryRouter initialEntries={['/messages']}>
          <App />
        </MemoryRouter>
      )

      expect(screen.getByText('Reconnecting...')).toBeInTheDocument()
    })
  ```
  Add `mockPlatformDisplayActive: { current: true }` to the `vi.hoisted` block and reset it in `beforeEach` (`mockPlatformDisplayActive.current = true`).

- [ ] **Step 2: run it (expect FAIL).** `cd apps/fluux && npx vitest run src/hooks/usePlatformState.test.tsx src/App.reconnect.test.tsx` — expected FAIL: `usePlatformState` returns `undefined` (so `result.current.displayActive` throws / is undefined) and App ignores `displayActive` in the spinner gate.

- [ ] **Step 3: minimal implementation.**

  In `usePlatformState.ts`, add reactive state next to the refs. After the `displayActiveRef` declaration (added in T1), add:
  ```ts
    // Reactive mirror of displayActiveRef for App's spinner gate. Refs don't
    // re-render; this state lets App drop the full-screen "Reconnexion…"
    // spinner when the machine holds in reconnecting.paused (display off).
    const [displayActive, setDisplayActive] = useState(true)
  ```
  Import `useState` at the top (`:1`): `import { useEffect, useRef, useState, useCallback } from 'react'`.
  In the keepalive listener (from T1), set both the ref and state:
  ```ts
          const active = payload.displayActive !== false
          displayActiveRef.current = active
          setDisplayActive(active)
  ```
  At the end of the hook (after Effect 6, `:723`), return:
  ```ts
    return { displayActive }
  ```

  In `App.tsx`, change the call (`:77`):
  ```tsx
    const { displayActive } = usePlatformState()
  ```
  Update the spinner gate (`:340`):
  ```tsx
    if (isAutoReconnecting && !hasBeenOnline && status !== 'online' && displayActive) {
  ```

- [ ] **Step 4: run it (expect PASS).** `cd apps/fluux && npx vitest run src/hooks/usePlatformState.test.tsx src/App.reconnect.test.tsx` — expected PASS, including the existing `keeps platform-state listeners mounted during the initial auto-reconnect spinner` test (which still asserts `mockUsePlatformState` called once and the spinner text — display defaults active there).

- [ ] **Step 5: full app suite + typecheck + commit.** `cd apps/fluux && npx vitest run` (no stderr), `cd apps/fluux && npx tsc --noEmit -p tsconfig.json` clean, then:
  ```
  git add apps/fluux/src/hooks/usePlatformState.ts apps/fluux/src/App.tsx apps/fluux/src/hooks/usePlatformState.test.tsx apps/fluux/src/App.reconnect.test.tsx
  git commit -m "fix(app): don't strand the auto-reconnect spinner while reconnecting with display off"
  ```

---


## Phase E — Rust native keepalive (spec #1)

## Task Group E — Rust native keepalive (spec change #1)

All paths are absolute under the repo root `/Users/mremond/AIProjects/fluux-messenger/.claude/worktrees/hungry-hypatia-542e57`. Tests run with `cd apps/fluux/src-tauri && cargo test <name>`. The pure seams (`KeepalivePayload`, `detect_sleep_gap`, `next_wait`, `build_keepalive_payload`, `keepalive_step`) live at **crate top level** (un-gated by `target_os`) so `cargo test` compiles and runs them on any host; `is_display_active()` stays inside the macOS-gated `mod macos`, and the loop injects it as `impl Fn() -> bool` so the FFI stays a thin shim.

> Context confirmed from source: `is_display_active()` and `WakeEventPayload` are inside `#[cfg(target_os = "macos")] mod macos` (`main.rs:819-866`). The keepalive thread is at crate top level inside the Tauri setup closure (`main.rs:1943-1954`) and currently emits `("xmpp-keepalive", ())`. There is one existing `#[cfg(test)] mod tests` at `main.rs:2004-2074`. `serde::{Deserialize, Serialize}` is imported at `main.rs:186`; `serde`/`serde_json` are in `Cargo.toml`.

---

#### Task E-T1: `KeepalivePayload` struct + serde camelCase

**Files:**
- Modify: `/Users/mremond/AIProjects/fluux-messenger/.claude/worktrees/hungry-hypatia-542e57/apps/fluux/src-tauri/src/main.rs` (insert at crate top level, immediately before `#[tauri::command]\nfn log_to_terminal` at `main.rs:1019`)
- Test: same file, `#[cfg(test)] mod tests` at `main.rs:2004`

Steps:

- [ ] **Step 1: Write the failing test.** Add to `mod tests` (after the last `test_pick_proxy_uri_trims_surrounding_whitespace` test, before the closing `}` at `main.rs:2074`):
```rust
    #[test]
    fn test_keepalive_payload_serializes_camel_case() {
        let payload = KeepalivePayload {
            display_active: true,
            slept_ms: 120_000,
        };
        let json = serde_json::to_string(&payload).expect("serialize");
        assert_eq!(json, r#"{"displayActive":true,"sleptMs":120000}"#);
    }

    #[test]
    fn test_keepalive_payload_is_clone() {
        let payload = KeepalivePayload {
            display_active: false,
            slept_ms: 0,
        };
        let cloned = payload.clone();
        assert!(!cloned.display_active);
        assert_eq!(cloned.slept_ms, 0);
    }
```

- [ ] **Step 2: Run it (expect FAIL — `KeepalivePayload` not found).**
  `cd apps/fluux/src-tauri && cargo test keepalive_payload`
  Expected: compile error `cannot find struct, variant or union type 'KeepalivePayload' in this scope`.

- [ ] **Step 3: Minimal implementation.** Insert at crate top level immediately before `main.rs:1019` (`#[tauri::command]\nfn log_to_terminal`):
```rust
/// Payload for the native `xmpp-keepalive` event. Serialized with camelCase
/// keys to match the WebView's `KeepalivePayload` interface
/// (`displayActive`, `sleptMs`). Mirrors `macos::WakeEventPayload`'s serde
/// convention so the JS side can parse both uniformly.
#[derive(Serialize, Clone)]
struct KeepalivePayload {
    #[serde(rename = "displayActive")]
    display_active: bool,
    #[serde(rename = "sleptMs")]
    slept_ms: u64,
}
```

- [ ] **Step 4: Run it (expect PASS).**
  `cd apps/fluux/src-tauri && cargo test keepalive_payload`
  Expected: `test result: ok. 2 passed`.

- [ ] **Step 5: Commit.**
  `git add apps/fluux/src-tauri/src/main.rs && git commit -m "feat(tauri): add KeepalivePayload struct with camelCase serde for keepalive event"`

---

#### Task E-T2: `build_keepalive_payload` constructor

**Files:**
- Modify: `/Users/mremond/AIProjects/fluux-messenger/.claude/worktrees/hungry-hypatia-542e57/apps/fluux/src-tauri/src/main.rs` (insert immediately after the `KeepalivePayload` struct from E-T1)
- Test: same file, `mod tests`

Steps:

- [ ] **Step 1: Write the failing test.** Add to `mod tests`:
```rust
    #[test]
    fn test_build_keepalive_payload_carries_fields() {
        let payload = build_keepalive_payload(true, 90_000);
        assert!(payload.display_active);
        assert_eq!(payload.slept_ms, 90_000);
    }

    #[test]
    fn test_build_keepalive_payload_inactive_display() {
        let payload = build_keepalive_payload(false, 0);
        assert!(!payload.display_active);
        assert_eq!(payload.slept_ms, 0);
    }
```

- [ ] **Step 2: Run it (expect FAIL).**
  `cd apps/fluux/src-tauri && cargo test build_keepalive_payload`
  Expected: `cannot find function 'build_keepalive_payload' in this scope`.

- [ ] **Step 3: Minimal implementation.** Insert immediately after the `KeepalivePayload` struct:
```rust
/// Construct a keepalive payload. Pure seam so the loop's payload shape is
/// unit-testable without the FFI display probe or the Tauri emitter.
fn build_keepalive_payload(display_active: bool, slept_ms: u64) -> KeepalivePayload {
    KeepalivePayload {
        display_active,
        slept_ms,
    }
}
```

- [ ] **Step 4: Run it (expect PASS).**
  `cd apps/fluux/src-tauri && cargo test build_keepalive_payload`
  Expected: `test result: ok. 2 passed`.

- [ ] **Step 5: Commit.**
  `git add apps/fluux/src-tauri/src/main.rs && git commit -m "feat(tauri): add build_keepalive_payload pure constructor"`

---

#### Task E-T3: keepalive interval/margin constants + `detect_sleep_gap`

**Files:**
- Modify: `/Users/mremond/AIProjects/fluux-messenger/.claude/worktrees/hungry-hypatia-542e57/apps/fluux/src-tauri/src/main.rs` (insert after `build_keepalive_payload`)
- Test: same file, `mod tests`

Steps:

- [ ] **Step 1: Write the failing test.** Add to `mod tests` (the no-false-positive jitter case is the load-bearing one — a normal 30s loop with scheduler jitter must NOT register as a sleep gap):
```rust
    #[test]
    fn test_detect_sleep_gap_normal_interval_no_gap() {
        // Steady-state 30s tick: not a sleep.
        assert_eq!(
            detect_sleep_gap(KEEPALIVE_INTERVAL, KEEPALIVE_INTERVAL, SLEEP_GAP_MARGIN),
            None
        );
    }

    #[test]
    fn test_detect_sleep_gap_scheduler_jitter_no_false_positive() {
        // 30s + 89s of jitter is still under the 120s floor → no false positive.
        let elapsed = KEEPALIVE_INTERVAL + Duration::from_secs(89);
        assert_eq!(detect_sleep_gap(elapsed, KEEPALIVE_INTERVAL, SLEEP_GAP_MARGIN), None);
    }

    #[test]
    fn test_detect_sleep_gap_exact_floor_is_gap() {
        // Exactly interval + margin = 120s → treated as slept (inclusive boundary).
        let elapsed = KEEPALIVE_INTERVAL + SLEEP_GAP_MARGIN;
        assert_eq!(
            detect_sleep_gap(elapsed, KEEPALIVE_INTERVAL, SLEEP_GAP_MARGIN),
            Some(120_000)
        );
    }

    #[test]
    fn test_detect_sleep_gap_long_sleep_returns_millis() {
        let elapsed = Duration::from_secs(9000);
        assert_eq!(
            detect_sleep_gap(elapsed, KEEPALIVE_INTERVAL, SLEEP_GAP_MARGIN),
            Some(9_000_000)
        );
    }
```

- [ ] **Step 2: Run it (expect FAIL).**
  `cd apps/fluux/src-tauri && cargo test detect_sleep_gap`
  Expected: `cannot find value 'KEEPALIVE_INTERVAL'` / `cannot find function 'detect_sleep_gap'`.

- [ ] **Step 3: Minimal implementation.** Insert after `build_keepalive_payload` (add `use std::time::Duration;` at the top of the inserted block only if not already in scope — it is referenced fully-qualified elsewhere, so use `std::time::Duration` directly in signatures):
```rust
/// Native keepalive cadence. The thread emits an `xmpp-keepalive` event every
/// `KEEPALIVE_INTERVAL`, regardless of display state.
const KEEPALIVE_INTERVAL: std::time::Duration = std::time::Duration::from_secs(30);

/// Floor above the interval beyond which an iteration's measured wall-clock
/// elapsed is attributed to the machine having slept rather than to scheduler
/// jitter. `30s + 90s = 120s`, well above any plausible jitter and aligned
/// with the JS `SLEEP_THRESHOLD_MS`-driven wake handling.
const SLEEP_GAP_MARGIN: std::time::Duration = std::time::Duration::from_secs(90);

/// Wall-clock wake detection. When a loop iteration's measured `elapsed` is at
/// or above `interval + margin`, the machine almost certainly slept through the
/// `sleep()` call; return `Some(elapsed_ms)` so the loop can fire immediately.
/// Otherwise (normal tick + jitter) return `None`. Pure seam — no FFI, no clock.
fn detect_sleep_gap(
    elapsed: std::time::Duration,
    interval: std::time::Duration,
    margin: std::time::Duration,
) -> Option<u64> {
    if elapsed >= interval + margin {
        Some(elapsed.as_millis() as u64)
    } else {
        None
    }
}
```
Also add `use std::time::Duration;` inside `mod tests` (after `use super::*;` at `main.rs:2006`) so the test bodies can write `Duration::from_secs(...)`:
```rust
    use std::time::Duration;
```

- [ ] **Step 4: Run it (expect PASS).**
  `cd apps/fluux/src-tauri && cargo test detect_sleep_gap`
  Expected: `test result: ok. 4 passed`.

- [ ] **Step 5: Commit.**
  `git add apps/fluux/src-tauri/src/main.rs && git commit -m "feat(tauri): add detect_sleep_gap wall-clock wake detection with jitter floor"`

---

#### Task E-T4: `next_wait`

**Files:**
- Modify: `/Users/mremond/AIProjects/fluux-messenger/.claude/worktrees/hungry-hypatia-542e57/apps/fluux/src-tauri/src/main.rs` (insert after `detect_sleep_gap`)
- Test: same file, `mod tests`

Steps:

- [ ] **Step 1: Write the failing test.** Add to `mod tests`:
```rust
    #[test]
    fn test_next_wait_no_gap_uses_interval() {
        assert_eq!(next_wait(None), KEEPALIVE_INTERVAL);
    }

    #[test]
    fn test_next_wait_after_gap_fires_immediately() {
        // A detected sleep gap → fire the next tick immediately (zero wait).
        assert_eq!(next_wait(Some(9_000_000)), Duration::ZERO);
    }
```

- [ ] **Step 2: Run it (expect FAIL).**
  `cd apps/fluux/src-tauri && cargo test next_wait`
  Expected: `cannot find function 'next_wait' in this scope`.

- [ ] **Step 3: Minimal implementation.** Insert after `detect_sleep_gap`:
```rust
/// Decide how long to wait before the next keepalive iteration. When the prior
/// iteration detected a sleep gap (`Some`), wait `ZERO` so the post-wake tick
/// fires immediately instead of waiting out another full interval; otherwise
/// wait the normal `KEEPALIVE_INTERVAL`. Pure seam.
fn next_wait(slept: Option<u64>) -> std::time::Duration {
    if slept.is_some() {
        std::time::Duration::ZERO
    } else {
        KEEPALIVE_INTERVAL
    }
}
```

- [ ] **Step 4: Run it (expect PASS).**
  `cd apps/fluux/src-tauri && cargo test next_wait`
  Expected: `test result: ok. 2 passed`.

- [ ] **Step 5: Commit.**
  `git add apps/fluux/src-tauri/src/main.rs && git commit -m "feat(tauri): add next_wait so post-sleep keepalive tick fires immediately"`

---

#### Task E-T5: testable `keepalive_step` seam (fresh display probe per emit, fail-open)

This seam composes the pure fns and the injected display probe into one tick's work, returning what would be emitted plus the next wait. It lets us assert: (a) the display probe is read **fresh per call** and its value flows into the payload, and (b) a sleep gap produces an immediate-fire wait. The Tauri `emit` stays out of the seam (untested shim).

**Files:**
- Modify: `/Users/mremond/AIProjects/fluux-messenger/.claude/worktrees/hungry-hypatia-542e57/apps/fluux/src-tauri/src/main.rs` (insert after `next_wait`)
- Test: same file, `mod tests`

Steps:

- [ ] **Step 1: Write the failing test.** Add to `mod tests` (uses an injected fake probe with a `Cell` to prove freshness — the value flips between calls and each payload reflects the current read):
```rust
    #[test]
    fn test_keepalive_step_steady_state_uses_probe_and_interval() {
        let (payload, wait) =
            keepalive_step(KEEPALIVE_INTERVAL, KEEPALIVE_INTERVAL, SLEEP_GAP_MARGIN, || true);
        assert!(payload.display_active);
        assert_eq!(payload.slept_ms, 0);
        assert_eq!(wait, KEEPALIVE_INTERVAL);
    }

    #[test]
    fn test_keepalive_step_sleep_gap_immediate_and_carries_slept_ms() {
        let elapsed = Duration::from_secs(9000);
        let (payload, wait) =
            keepalive_step(elapsed, KEEPALIVE_INTERVAL, SLEEP_GAP_MARGIN, || true);
        assert_eq!(payload.slept_ms, 9_000_000);
        assert_eq!(wait, Duration::ZERO);
    }

    #[test]
    fn test_keepalive_step_probe_read_fresh_each_call() {
        // Probe flips false→true between calls; each payload reflects the
        // value read at that call (guards the stuck-`false` landmine).
        let state = std::cell::Cell::new(false);
        let probe = || {
            let v = state.get();
            state.set(!v);
            v
        };
        let (p1, _) = keepalive_step(KEEPALIVE_INTERVAL, KEEPALIVE_INTERVAL, SLEEP_GAP_MARGIN, &probe);
        let (p2, _) = keepalive_step(KEEPALIVE_INTERVAL, KEEPALIVE_INTERVAL, SLEEP_GAP_MARGIN, &probe);
        assert!(!p1.display_active);
        assert!(p2.display_active);
    }

    #[test]
    fn test_keepalive_step_display_inactive_still_emits() {
        // Display off → still produce a payload (the tick keeps arriving so
        // the state machine can learn when the display returns).
        let (payload, wait) =
            keepalive_step(KEEPALIVE_INTERVAL, KEEPALIVE_INTERVAL, SLEEP_GAP_MARGIN, || false);
        assert!(!payload.display_active);
        assert_eq!(payload.slept_ms, 0);
        assert_eq!(wait, KEEPALIVE_INTERVAL);
    }
```

- [ ] **Step 2: Run it (expect FAIL).**
  `cd apps/fluux/src-tauri && cargo test keepalive_step`
  Expected: `cannot find function 'keepalive_step' in this scope`.

- [ ] **Step 3: Minimal implementation.** Insert after `next_wait`:
```rust
/// One keepalive iteration's pure work: detect a sleep gap from the measured
/// `elapsed`, probe the display state **fresh** (so a transient stuck reading
/// can't poison later ticks), build the payload, and compute the next wait.
/// Returns the payload to emit and the duration to sleep before the next tick.
/// The Tauri `emit` and the real wall-clock measurement stay in the thread;
/// this seam takes them as inputs so it is fully unit-testable.
fn keepalive_step<F: Fn() -> bool>(
    elapsed: std::time::Duration,
    interval: std::time::Duration,
    margin: std::time::Duration,
    display_probe: F,
) -> (KeepalivePayload, std::time::Duration) {
    let slept = detect_sleep_gap(elapsed, interval, margin);
    let display_active = display_probe();
    let payload = build_keepalive_payload(display_active, slept.unwrap_or(0));
    (payload, next_wait(slept))
}
```

- [ ] **Step 4: Run it (expect PASS).**
  `cd apps/fluux/src-tauri && cargo test keepalive_step`
  Expected: `test result: ok. 4 passed`.

- [ ] **Step 5: Commit.**
  `git add apps/fluux/src-tauri/src/main.rs && git commit -m "feat(tauri): add keepalive_step seam composing sleep-gap detection + fresh display probe"`

---

#### Task E-T6: crate-level fail-open display probe wrapper

The keepalive thread is at crate top level, but `is_display_active()` is private to `#[cfg(target_os = "macos")] mod macos`. Add a crate-level `keepalive_display_active()` that fails open: returns `true` on non-macOS and (per contract) defaults `true` on any probe failure. Since the macOS FFI call cannot itself signal failure as a `Result`, the fail-open semantics are encoded by the wrapper's non-macOS arm and documented for the macOS arm; the macOS arm delegates to `macos::is_display_active()`.

**Files:**
- Modify: `/Users/mremond/AIProjects/fluux-messenger/.claude/worktrees/hungry-hypatia-542e57/apps/fluux/src-tauri/src/main.rs` (insert after `keepalive_step`); also make `is_display_active` reachable from crate level
- Test: same file, `mod tests`

Steps:

- [ ] **Step 1: Write the failing test.** Add to `mod tests` (on the test host — macOS — this asserts the wrapper is callable and returns a bool; the load-bearing guarantee is that it never panics and is never `false` by construction on non-macOS):
```rust
    #[test]
    fn test_keepalive_display_active_is_callable() {
        // Must not panic; on non-macOS hosts it fails open to `true`.
        let _v: bool = keepalive_display_active();
    }

    #[cfg(not(target_os = "macos"))]
    #[test]
    fn test_keepalive_display_active_fails_open_off_macos() {
        assert!(keepalive_display_active());
    }
```

- [ ] **Step 2: Run it (expect FAIL).**
  `cd apps/fluux/src-tauri && cargo test keepalive_display_active`
  Expected: `cannot find function 'keepalive_display_active' in this scope`.

- [ ] **Step 3: Minimal implementation.** First, expose the macOS probe to the crate: change `fn is_display_active() -> bool {` at `main.rs:853` to `pub(crate) fn is_display_active() -> bool {`. Then insert the wrapper after `keepalive_step`:
```rust
/// Crate-level display-active probe for the keepalive thread. Fails open:
/// returns `true` on platforms without a display-sleep probe, and the macOS
/// `CGDisplayIsAsleep` path is documented to default active on any ambiguity.
/// Failing open is mandatory — since `system-did-wake` is demoted to
/// reload-only, a stuck-`false` probe would otherwise silently kill
/// reconnection forever.
fn keepalive_display_active() -> bool {
    #[cfg(target_os = "macos")]
    {
        macos::is_display_active()
    }
    #[cfg(not(target_os = "macos"))]
    {
        true
    }
}
```

- [ ] **Step 4: Run it (expect PASS).**
  `cd apps/fluux/src-tauri && cargo test keepalive_display_active`
  Expected: `test result: ok. 1 passed` on macOS (the `not(target_os="macos")` test is excluded on this host) — the call compiles and returns without panic.

- [ ] **Step 5: Commit.**
  `git add apps/fluux/src-tauri/src/main.rs && git commit -m "feat(tauri): add fail-open keepalive_display_active wrapper over macOS display probe"`

---

#### Task E-T7: rewrite the keepalive thread to measure elapsed, fire on gap, emit `KeepalivePayload`

Wire the seams into the live thread (`main.rs:1943-1954`). The loop is not directly unit-tested (it owns the real clock + Tauri emitter); correctness is covered by the seam tests E-T3..E-T6. This step is verified by `cargo build` + the full test suite staying green, and a manual reading of the rewritten loop.

**Files:**
- Modify: `/Users/mremond/AIProjects/fluux-messenger/.claude/worktrees/hungry-hypatia-542e57/apps/fluux/src-tauri/src/main.rs:1943-1954`

Steps:

- [ ] **Step 1: Write/extend the failing test.** No new unit test (the loop is the untested shim). Add one guard test to `mod tests` proving the loop body's exact composition matches the seam contract under a simulated wake, by re-deriving the loop's per-iteration outputs through `keepalive_step` (this pins that the rewrite must use immediate-fire on a gap):
```rust
    #[test]
    fn test_loop_contract_fires_immediately_after_simulated_sleep() {
        // Iteration 1: a 2.5h sleep gap → emit immediately (ZERO wait), payload
        // carries the slept_ms. Iteration 2: steady state → 30s wait.
        let (p1, w1) =
            keepalive_step(Duration::from_secs(9000), KEEPALIVE_INTERVAL, SLEEP_GAP_MARGIN, || true);
        assert_eq!(w1, Duration::ZERO);
        assert_eq!(p1.slept_ms, 9_000_000);

        let (p2, w2) =
            keepalive_step(KEEPALIVE_INTERVAL, KEEPALIVE_INTERVAL, SLEEP_GAP_MARGIN, || true);
        assert_eq!(w2, KEEPALIVE_INTERVAL);
        assert_eq!(p2.slept_ms, 0);
    }
```

- [ ] **Step 2: Run it (expect PASS already — seams exist).**
  `cd apps/fluux/src-tauri && cargo test loop_contract`
  Expected: `test result: ok. 1 passed`. (This test pins the contract the loop rewrite must honor.)

- [ ] **Step 3: Rewrite the loop.** Replace `main.rs:1943-1954`:
```rust
            if let Some(window) = app.get_webview_window("main") {
                let running = keepalive_flag_for_setup.clone();
                std::thread::spawn(move || {
                    while running.load(Ordering::Relaxed) {
                        std::thread::sleep(std::time::Duration::from_secs(30));
                        if !running.load(Ordering::Relaxed) {
                            break;
                        }
                        let _ = window.emit("xmpp-keepalive", ());
                    }
                });
            }
```
with:
```rust
            if let Some(window) = app.get_webview_window("main") {
                let running = keepalive_flag_for_setup.clone();
                std::thread::spawn(move || {
                    // Measure real wall-clock elapsed per iteration so a sleep
                    // the machine slept through (the `sleep()` call returns
                    // late) is detected and the post-wake tick fires
                    // immediately instead of waiting out another full interval.
                    // The display state is probed FRESH every emit and the tick
                    // keeps arriving every interval even when the display is
                    // off, so the JS state machine can learn when it returns.
                    let mut wait = KEEPALIVE_INTERVAL;
                    while running.load(Ordering::Relaxed) {
                        let started = std::time::Instant::now();
                        std::thread::sleep(wait);
                        if !running.load(Ordering::Relaxed) {
                            break;
                        }
                        let elapsed = started.elapsed();
                        let (payload, next) = keepalive_step(
                            elapsed,
                            KEEPALIVE_INTERVAL,
                            SLEEP_GAP_MARGIN,
                            keepalive_display_active,
                        );
                        let _ = window.emit("xmpp-keepalive", payload);
                        wait = next;
                    }
                });
            }
```

- [ ] **Step 4: Build + full suite (expect PASS, no stderr).**
  `cd apps/fluux/src-tauri && cargo build && cargo test`
  Expected: `cargo build` succeeds; `cargo test` reports all tests passing including the keepalive seam tests, no warnings to stderr.

- [ ] **Step 5: Commit.**
  `git add apps/fluux/src-tauri/src/main.rs && git commit -m "feat(tauri): rewrite keepalive thread to measure elapsed, fire immediately on sleep gap, emit KeepalivePayload with fresh display probe"`

---


---

## Deferred items & verification (not full TDD tasks in this plan)

These spec items are intentionally **out of scope for this plan** (which covers changes #1–#6 plus the `paused` status-mapping fix) and are tracked as follow-ups or verification spikes, per spec §7/§9:

1. **Forward MAM catch-up on SM-resume-after-display-off** (spec §7, §9.4): a zombie socket means the server may have "delivered" messages SM will not redeliver (SM replays only *unacked* stanzas). Verify whether the resume path already runs `selectCatchUpQuery` (see `docs/MAM_CATCHUP.md`); if not, add a forward catch-up on resume-after-display-off. **Verification spike** before committing to a task.
2. **Carbons (XEP-0280) re-enable + correct presence on fresh bind** (spec §7, §9.4): confirm the fresh-session (`'online'`) side-effects re-request Carbons (session-scoped) and re-broadcast presence reflecting any auto-away/XA state captured before display-off. Verify against `chatSideEffects`/the fresh `online` handler.
3. **First display-active tick: wake-style short-timeout verify** (spec §7): C-T3 routes a long-gap tick straight to `handleDeadSocket({ immediateReconnect: true })` and a steady-state tick to `verifyConnectionHealth`. The shorter wake-verify timeout for the first post-display-off probe is a refinement, not yet a task.
4. **Conflict-after-long-display-off / randomized resource** (spec §7): ensure fresh bind uses a unique/server-assigned resource so a stale zombie session does not self-conflict, and surface a reconnect affordance from `terminal.conflict`. Smaller hardening, follow-up.

## Final verification (after all tasks land)

- `npm test` (SDK + app) green, **no stderr**; `npm run typecheck`; lint clean; `cd apps/fluux/src-tauri && cargo test` green.
- Manual (spec §10): long display-off on AC power with the window unfocused → reconnect on display-on **without focusing Fluux**; DarkWake does **not** reconnect; no full-screen spinner stranding; logout during an in-flight reconnect does **not** silently log back in.
