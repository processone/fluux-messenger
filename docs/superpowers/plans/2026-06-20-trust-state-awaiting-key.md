# Trust-state `awaiting-key` Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop the trust-state integrity check from raising the "compromised" alarm when the only problem is that the secret key was not usable at verification time; resolve to the correct verdict once the key is available; and instrument the transitions.

**Architecture:** Add a non-alarming `awaiting-key` status. In `verifyTrustStateSeal`, a decrypt failure caused by an *unavailable secret key* (recognized via an injected predicate) returns `awaiting-key` instead of `compromised`. The OpenPGP plugin supplies the predicate and re-runs the verification after a recovery/unlock so a deferred state resolves to `sealed` for an unchanged cert. The change is monotonic — it can only remove false alarms; every genuine tamper signal still returns `compromised`.

**Tech Stack:** TypeScript, React, Zustand, Vitest. Spec: `docs/superpowers/specs/2026-06-20-trust-state-awaiting-key-design.md`.

---

## File Structure

| File | Responsibility | Tasks |
|---|---|---|
| `apps/fluux/src/stores/trustStateStatusStore.ts` | Add the `awaiting-key` status value | T1 |
| `apps/fluux/src/e2ee/trustStateIntegrity.ts` | Classify key-unavailable decrypt failures as `awaiting-key`; transition logging | T1, T4 |
| `apps/fluux/src/e2ee/trustStateIntegrity.test.ts` (new) | Unit tests for the classification (reproduction + no-weakening) | T1 |
| `apps/fluux/src/e2ee/OpenPGPPluginBase.ts` | Supply the key-unavailable predicate; re-verify after recovery; instrumentation | T2, T3, T4 |
| `apps/fluux/src/e2ee/keyUnavailable.ts` (new) | Pure `isSecretKeyUnavailableError` predicate | T2 |
| `apps/fluux/src/e2ee/keyUnavailable.test.ts` (new) | Predicate unit test | T2 |
| `apps/fluux/src/components/TrustStateCompromisedBanner.test.tsx` (new) | Confirm `awaiting-key` renders no banner | T5 |

## Execution order
T1 → T2 → T3 → T4 → T5. T1 adds the status + the core classification (pure, fully unit-tested). T2 adds the predicate the plugin passes in. T3 wires the re-verify after recovery. T4 adds instrumentation. T5 confirms banner gating. Each task: strict TDD, commit at the end. Test command: `cd apps/fluux && npx vitest run <path>`. Pre-commit gate (CLAUDE.md): tests green no stderr, `npm run typecheck`, lint clean.

---

### Task 1: `awaiting-key` status + `verifyTrustStateSeal` classification

**Files:**
- Modify: `apps/fluux/src/stores/trustStateStatusStore.ts` (the `TrustStateStatus` union + doc comment)
- Modify: `apps/fluux/src/e2ee/trustStateIntegrity.ts` (`verifyTrustStateSeal` signature + decrypt catch, ~`:114-133`)
- Test: `apps/fluux/src/e2ee/trustStateIntegrity.test.ts` (new)

- [ ] **Step 1: Write the failing test.** Create `apps/fluux/src/e2ee/trustStateIntegrity.test.ts`. It uses the public `sealTrustState` to write a seal (so the test never needs the private scoped key — both writer and reader use the same `getSealKey()`), then drives `verifyTrustStateSeal` with stub decrypt fns, mirroring the decrypt-stub style of `verificationSync.test.ts`:

```ts
import { describe, expect, it, beforeEach } from 'vitest'
import { E2EEPluginError } from '@fluux/sdk'
import { sealTrustState, verifyTrustStateSeal } from './trustStateIntegrity'
import { usePinnedPrimaryFingerprintsStore } from '@/stores/pinnedPrimaryFingerprintsStore'
import { useVerifiedPeerKeysStore } from '@/stores/verifiedPeerKeysStore'
import { useKeyChangeAlertsStore } from '@/stores/keyChangeAlertsStore'

const OWN_FP = 'AAAA1111BBBB2222CCCC3333DDDD4444EEEE5555'
const OWN_PUBLIC = 'OWN-PUBLIC-ARMOR'
const passthroughEncrypt = async (plaintext: string) => plaintext

// Predicate the plugin will supply (see Task 2). Inlined here to test the gate.
const isKeyUnavailable = (err: unknown) =>
  err instanceof E2EEPluginError && (err.code === 'key-unrecoverable' || err.code === 'key-locked')

function setPins(pins: Record<string, string>) {
  usePinnedPrimaryFingerprintsStore.setState({ pinnedFingerprintByJid: pins })
}

beforeEach(() => {
  localStorage.clear()
  usePinnedPrimaryFingerprintsStore.setState({ pinnedFingerprintByJid: {} })
  useVerifiedPeerKeysStore.setState({ verifiedFingerprintByJid: {} })
  useKeyChangeAlertsStore.setState({ alertsByJid: {} })
})

describe('verifyTrustStateSeal: key-unavailable classification', () => {
  it('returns awaiting-key (not compromised) when decrypt fails because the secret key is unavailable', async () => {
    setPins({ 'peer@example.com': 'PEERFP' })
    await sealTrustState(passthroughEncrypt, OWN_PUBLIC)
    const decryptUnavailable = async () => {
      throw new E2EEPluginError('permanent', 'key-unrecoverable', 'cannot unlock')
    }
    const res = await verifyTrustStateSeal(decryptUnavailable, OWN_PUBLIC, OWN_FP, isKeyUnavailable)
    expect(res.status).toBe('awaiting-key')
  })

  it('still returns compromised when decrypt fails for a non-key reason', async () => {
    setPins({ 'peer@example.com': 'PEERFP' })
    await sealTrustState(passthroughEncrypt, OWN_PUBLIC)
    const decryptBroken = async () => { throw new Error('garbage') }
    const res = await verifyTrustStateSeal(decryptBroken, OWN_PUBLIC, OWN_FP, isKeyUnavailable)
    expect(res.status).toBe('compromised')
  })

  it('still returns compromised when the seal decrypts but pins no longer match', async () => {
    setPins({ 'peer@example.com': 'OLDFP' })
    await sealTrustState(passthroughEncrypt, OWN_PUBLIC)
    setPins({ 'peer@example.com': 'TAMPERED' }) // mutate after sealing
    const decryptOriginal = async (ciphertext: string) => ({
      plaintext: ciphertext, signatureVerified: true, signerFingerprint: OWN_FP, signaturePresent: true,
    })
    const res = await verifyTrustStateSeal(decryptOriginal, OWN_PUBLIC, OWN_FP, isKeyUnavailable)
    expect(res.status).toBe('compromised')
  })

  it('still returns compromised on a foreign signature (decrypt succeeded => key was usable)', async () => {
    setPins({ 'peer@example.com': 'PEERFP' })
    await sealTrustState(passthroughEncrypt, OWN_PUBLIC)
    const decryptForeign = async (ciphertext: string) => ({
      plaintext: ciphertext, signatureVerified: true, signerFingerprint: 'FFFFFFFF', signaturePresent: true,
    })
    const res = await verifyTrustStateSeal(decryptForeign, OWN_PUBLIC, OWN_FP, isKeyUnavailable)
    expect(res.status).toBe('compromised')
  })

  it('returns sealed when decrypt succeeds and pins match', async () => {
    setPins({ 'peer@example.com': 'PEERFP' })
    await sealTrustState(passthroughEncrypt, OWN_PUBLIC)
    const decryptOk = async (ciphertext: string) => ({
      plaintext: ciphertext, signatureVerified: true, signerFingerprint: OWN_FP, signaturePresent: true,
    })
    const res = await verifyTrustStateSeal(decryptOk, OWN_PUBLIC, OWN_FP, isKeyUnavailable)
    expect(res.status).toBe('sealed')
  })

  it('defaults to current behavior when no predicate is passed (decrypt failure => compromised)', async () => {
    setPins({ 'peer@example.com': 'PEERFP' })
    await sealTrustState(passthroughEncrypt, OWN_PUBLIC)
    const decryptUnavailable = async () => {
      throw new E2EEPluginError('permanent', 'key-unrecoverable', 'cannot unlock')
    }
    const res = await verifyTrustStateSeal(decryptUnavailable, OWN_PUBLIC, OWN_FP)
    expect(res.status).toBe('compromised')
  })
})
```

- [ ] **Step 2: Run it — expect FAIL.** `cd apps/fluux && npx vitest run src/e2ee/trustStateIntegrity.test.ts` — the first test fails (`expected 'compromised' ... 'awaiting-key'`) because `verifyTrustStateSeal` has no `isKeyUnavailable` param and `'awaiting-key'` is not a valid status.

- [ ] **Step 3: Minimal implementation.**

In `trustStateStatusStore.ts`, add the status to the union and the doc comment:
```ts
export type TrustStateStatus =
  | 'uninitialized'
  | 'sealed'
  | 'pending-seal'
  | 'awaiting-key'
  | 'compromised'
```
(Add a doc line: `` - `awaiting-key`   — the secret key was not usable, so the seal could not be checked; no verdict yet. ``)

In `trustStateIntegrity.ts`, add the parameter (default preserves behavior) and classify the catch:
```ts
export async function verifyTrustStateSeal(
  decryptFn: DecryptFn,
  ownPublicArmored: string,
  ownFingerprint: string,
  isKeyUnavailable: (err: unknown) => boolean = () => false,
): Promise<{ status: TrustStateStatus; details?: string[] }> {
```
Change ONLY the decrypt catch (currently `:128-133`):
```ts
  let decrypted: Awaited<ReturnType<DecryptFn>>
  try {
    decrypted = await decryptFn(sealArmored, ownPublicArmored)
  } catch (err) {
    // A decrypt failure because the secret key is unavailable (locked /
    // unrecoverable / recovering) is NOT a tamper signal — there is simply no
    // verdict yet. Only a decrypt failure with a usable key is suspicious.
    if (isKeyUnavailable(err)) return { status: 'awaiting-key' }
    if (storesAreEmpty()) return { status: 'pending-seal' }
    return { status: 'compromised', details: ['Trust state seal could not be decrypted'] }
  }
```

- [ ] **Step 4: Run it — expect PASS.** `cd apps/fluux && npx vitest run src/e2ee/trustStateIntegrity.test.ts` — all six pass. Then `cd apps/fluux && npx tsc --noEmit -p tsconfig.json` clean.

- [ ] **Step 5: Commit.**
```bash
git add apps/fluux/src/stores/trustStateStatusStore.ts apps/fluux/src/e2ee/trustStateIntegrity.ts apps/fluux/src/e2ee/trustStateIntegrity.test.ts
git commit -m "fix(e2ee): classify key-unavailable trust-seal decrypt failures as awaiting-key, not compromised"
```

---

### Task 2: `isSecretKeyUnavailableError` predicate + wire into `verifyTrustStateOnInit`

**Files:**
- Create: `apps/fluux/src/e2ee/keyUnavailable.ts`
- Test: `apps/fluux/src/e2ee/keyUnavailable.test.ts` (new)
- Modify: `apps/fluux/src/e2ee/OpenPGPPluginBase.ts` (`verifyTrustStateOnInit`, ~`:649-653`)

- [ ] **Step 1: Write the failing test.** Create `apps/fluux/src/e2ee/keyUnavailable.test.ts`:
```ts
import { describe, expect, it } from 'vitest'
import { E2EEPluginError } from '@fluux/sdk'
import { isSecretKeyUnavailableError } from './keyUnavailable'

describe('isSecretKeyUnavailableError', () => {
  it('is true for key-unrecoverable and key-locked E2EEPluginErrors', () => {
    expect(isSecretKeyUnavailableError(new E2EEPluginError('permanent', 'key-unrecoverable', 'x'))).toBe(true)
    expect(isSecretKeyUnavailableError(new E2EEPluginError('transient', 'key-locked', 'x'))).toBe(true)
  })
  it('is false for other E2EEPluginError codes', () => {
    expect(isSecretKeyUnavailableError(new E2EEPluginError('permanent', 'wrong-passphrase', 'x'))).toBe(false)
    expect(isSecretKeyUnavailableError(new E2EEPluginError('permanent', 'malformed-key', 'x'))).toBe(false)
  })
  it('is false for non-plugin errors', () => {
    expect(isSecretKeyUnavailableError(new Error('boom'))).toBe(false)
    expect(isSecretKeyUnavailableError('nope')).toBe(false)
    expect(isSecretKeyUnavailableError(undefined)).toBe(false)
  })
})
```

- [ ] **Step 2: Run it — expect FAIL.** `cd apps/fluux && npx vitest run src/e2ee/keyUnavailable.test.ts` — fails: module/function not found.

- [ ] **Step 3: Minimal implementation.** Create `apps/fluux/src/e2ee/keyUnavailable.ts`:
```ts
import { E2EEPluginError } from '@fluux/sdk'

/**
 * True when an error means the local secret key was not usable (locked, or
 * unrecoverable / recovering) — as opposed to a genuine cryptographic failure.
 * Used to avoid mistaking "the key could not run" for "trust data was tampered".
 */
export function isSecretKeyUnavailableError(err: unknown): boolean {
  return (
    err instanceof E2EEPluginError &&
    (err.code === 'key-unrecoverable' || err.code === 'key-locked')
  )
}
```
In `OpenPGPPluginBase.ts`, import it and pass it as the 4th arg in `verifyTrustStateOnInit` (`:649-653`):
```ts
    const { status, details } = await verifyTrustStateSeal(
      (ciphertext, senderPub) => this.decryptWithOwnKey(jid, ciphertext, senderPub),
      ownPublicArmored,
      ownFingerprint,
      isSecretKeyUnavailableError,
    )
```
(Add `import { isSecretKeyUnavailableError } from './keyUnavailable'` near the other e2ee imports.)

- [ ] **Step 4: Run it — expect PASS.** `cd apps/fluux && npx vitest run src/e2ee/keyUnavailable.test.ts` — passes. Then `cd apps/fluux && npx tsc --noEmit -p tsconfig.json` clean (confirms the new arg typechecks against `verifyTrustStateSeal`).

- [ ] **Step 5: Commit.**
```bash
git add apps/fluux/src/e2ee/keyUnavailable.ts apps/fluux/src/e2ee/keyUnavailable.test.ts apps/fluux/src/e2ee/OpenPGPPluginBase.ts
git commit -m "feat(e2ee): supply key-unavailable predicate to the trust-state seal check"
```

---

### Task 3: Re-verify the trust-state after recovery / unlock

**Files:**
- Modify: `apps/fluux/src/e2ee/OpenPGPPluginBase.ts` (`doInstallKey` ~`:1177`, `retireAndGenerateIdentity` ~`:885`)
- Modify: `apps/fluux/src/e2ee/WebOpenPGPPlugin.ts` (`unlock`, ~`:637`/`:665`) — confirm parity
- Test: `apps/fluux/src/e2ee/SequoiaPgpPlugin.test.ts` (extend; reuse the existing `makeContext` harness at ~`:468-558`)

**Context:** `verifyTrustStateOnInit` runs only from `activateSubscriptions` (`:616`). The recovery completions (`doInstallKey:1177`, `retireAndGenerateIdentity:885`) currently call only `ctx.notifyKeyUnlocked()`, so a state left at `awaiting-key` (or a stale verdict) never re-resolves once the key is back. Make recovery re-run the verification.

- [ ] **Step 1: Write the failing test.** In `SequoiaPgpPlugin.test.ts`, add a test using the existing `makeContext` harness. Drive the plugin so the seal check first sees an unavailable key (status `awaiting-key`), then complete a recovery and assert the status re-resolves to `sealed`. Concretely (adapt to the harness's `fake.invoke` decrypt hook — the harness lets you make `decryptWithOwnKey` throw a `key-unrecoverable` E2EEPluginError during the initial seal check, then succeed after recovery):
```ts
it('re-verifies the trust state after recovery (awaiting-key -> sealed)', async () => {
  const { ctx } = makeContext('me@example.com')
  const plugin = new SequoiaPgpPlugin({ invoke: fake.invoke })
  // Arrange: a valid seal exists for the own key, but the first decrypt-to-self
  // throws key-unrecoverable (desync), so the seal check defers.
  fake.failNextOwnDecryptWith('key-unrecoverable')
  await plugin.init(ctx)
  expect(getTrustStateStatus()).toBe('awaiting-key')

  // Act: recovery restores the same cert; the next decrypt succeeds.
  await plugin.restoreSecretKey('correct horse battery staple')

  // Assert: the seal validates against the unchanged cert.
  expect(getTrustStateStatus()).toBe('sealed')
})
```
If the existing `fake` invoke harness has no per-call decrypt-failure hook, add one (a single-shot `failNextOwnDecryptWith(code)` that makes the next `decrypt` invoke reject with that classified message) — keep it confined to the test harness.

- [ ] **Step 2: Run it — expect FAIL.** `cd apps/fluux && npx vitest run src/e2ee/SequoiaPgpPlugin.test.ts -t "re-verifies the trust state after recovery"` — fails: after `restoreSecretKey`, status stays `awaiting-key` (recovery never re-runs the seal check).

- [ ] **Step 3: Minimal implementation.** In `OpenPGPPluginBase.ts`, after the key is installed in both recovery completions, re-run the seal check. At the end of `doInstallKey` (after `ctx.notifyKeyUnlocked?.()`, `:1177`) and `retireAndGenerateIdentity` (after `:885`):
```ts
    ctx.notifyKeyUnlocked?.()
    // The secret key is now usable again — re-run the trust-state seal check so a
    // deferred `awaiting-key` verdict resolves (to `sealed` for an unchanged cert).
    this.activateSubscriptions()   // idempotent: sets up subs if not yet active
    void this.verifyTrustStateOnInit()  // explicit re-check even when subs were already active
```
(`activateSubscriptions` is guarded against double-activation at `:575`; the explicit `verifyTrustStateOnInit` covers the case where subscriptions were already active.) Confirm `WebOpenPGPPlugin.unlock` (`:637`/`:665`) ends with the same re-check (it already calls `activateSubscriptions`; add the explicit `void this.verifyTrustStateOnInit()` if subs may already be active there).

- [ ] **Step 4: Run it — expect PASS.** `cd apps/fluux && npx vitest run src/e2ee/SequoiaPgpPlugin.test.ts` (full file) and `src/e2ee/WebOpenPGPPlugin.test.ts` — green, no stderr. `cd apps/fluux && npx tsc --noEmit -p tsconfig.json` clean.

- [ ] **Step 5: Commit.**
```bash
git add apps/fluux/src/e2ee/OpenPGPPluginBase.ts apps/fluux/src/e2ee/WebOpenPGPPlugin.ts apps/fluux/src/e2ee/SequoiaPgpPlugin.test.ts
git commit -m "fix(e2ee): re-verify trust-state seal after key recovery/unlock"
```

---

### Task 4: Instrument trust-state transitions

**Files:**
- Modify: `apps/fluux/src/e2ee/OpenPGPPluginBase.ts` (`verifyTrustStateOnInit`, ~`:644-659`)
- Test: `apps/fluux/src/e2ee/SequoiaPgpPlugin.test.ts` (extend)

- [ ] **Step 1: Write the failing test.** Assert that on a non-trivial verdict the plugin records a console-store event so future incidents are diagnosable. Using the harness (the `ctx` exposes the console/security hooks; use whichever the plugin already writes to — `consoleStore.addEvent` is the app-wide console). Add:
```ts
it('logs the trust-state verdict after init', async () => {
  const events: string[] = []
  const spy = vi.spyOn(consoleStore.getState(), 'addEvent').mockImplementation((m: string) => { events.push(m) })
  const { ctx } = makeContext('me@example.com')
  const plugin = new SequoiaPgpPlugin({ invoke: fake.invoke })
  await plugin.init(ctx)
  expect(events.some((e) => /trust.?state/i.test(e))).toBe(true)
  spy.mockRestore()
})
```
(Import `consoleStore` from the SDK as the existing plugin code does, e.g. `import { consoleStore } from '@fluux/sdk'` — match the existing import in `OpenPGPPluginBase.ts`.)

- [ ] **Step 2: Run it — expect FAIL.** `cd apps/fluux && npx vitest run src/e2ee/SequoiaPgpPlugin.test.ts -t "logs the trust-state verdict"` — fails: no trust-state console event emitted.

- [ ] **Step 3: Minimal implementation.** In `verifyTrustStateOnInit` (`:644-659`), after computing `{ status, details }` and before/at `setTrustStateStatus`, log to both the webview console and the in-app console store:
```ts
    const reason = details && details.length ? ` (${details.join('; ')})` : ''
    console.log(`[E2EE] Trust-state verdict: ${status}${reason}`)
    this.ctx?.console?.addEvent?.(`Trust-state integrity: ${status}${reason}`, 'security')
    if (status === 'pending-seal') {
      await this.sealTrustStateNow()
      return
    }
    setTrustStateStatus(status, details)
```
(Use the plugin's existing console-store accessor — match how `OpenPGPPluginBase.ts` already emits console events elsewhere, e.g. via `ctx.console.addEvent` or an imported `consoleStore`; the category string should match the existing convention.)

- [ ] **Step 4: Run it — expect PASS.** `cd apps/fluux && npx vitest run src/e2ee/SequoiaPgpPlugin.test.ts` — green. `npx tsc --noEmit -p tsconfig.json` clean.

- [ ] **Step 5: Commit.**
```bash
git add apps/fluux/src/e2ee/OpenPGPPluginBase.ts apps/fluux/src/e2ee/SequoiaPgpPlugin.test.ts
git commit -m "feat(e2ee): instrument trust-state integrity verdict transitions"
```

---

### Task 5: Confirm `awaiting-key` renders no banner

**Files:**
- Test: `apps/fluux/src/components/TrustStateCompromisedBanner.test.tsx` (new)

The banner already gates on `status !== 'compromised'` (`TrustStateCompromisedBanner.tsx:30`), so `awaiting-key` is silent today. This test locks that in so a future change can't accidentally surface it.

- [ ] **Step 1: Write the failing test (then make it pass without prod change, characterizing the contract).** Create `apps/fluux/src/components/TrustStateCompromisedBanner.test.tsx`:
```tsx
import { describe, expect, it, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import { TrustStateCompromisedBanner } from './TrustStateCompromisedBanner'
import { useTrustStateStatusStore } from '@/stores/trustStateStatusStore'
import type { TrustStateStatus } from '@/stores/trustStateStatusStore'

beforeEach(() => {
  useTrustStateStatusStore.setState({ status: 'uninitialized', mismatchDetails: undefined })
})

const silent: TrustStateStatus[] = ['uninitialized', 'sealed', 'pending-seal', 'awaiting-key']

describe('TrustStateCompromisedBanner', () => {
  it.each(silent)('renders nothing for status %s', (status) => {
    useTrustStateStatusStore.setState({ status })
    const { container } = render(<TrustStateCompromisedBanner />)
    expect(container).toBeEmptyDOMElement()
  })

  it('renders the warning only for compromised', () => {
    useTrustStateStatusStore.setState({ status: 'compromised' })
    render(<TrustStateCompromisedBanner />)
    expect(screen.getByText(/integrity check failed|tampered/i)).toBeInTheDocument()
  })
})
```
(If `TrustStateCompromisedBanner` needs a client/provider prop, wrap it the way other component tests in `apps/fluux/src/components/*.test.tsx` do — follow the nearest existing banner test for the provider boilerplate.)

- [ ] **Step 2: Run it.** `cd apps/fluux && npx vitest run src/components/TrustStateCompromisedBanner.test.tsx` — the `awaiting-key` case passes (banner already silent) and the `compromised` case passes. If the `compromised` text matcher mismatches, adjust to the actual i18n string at `en.json:settings.encryption.trustStateCompromised.title`.

- [ ] **Step 3: Full app suite + gates.** `cd apps/fluux && npx vitest run` (whole suite, no stderr), `npx tsc --noEmit -p tsconfig.json`, `npm run lint`. All clean.

- [ ] **Step 4: Commit.**
```bash
git add apps/fluux/src/components/TrustStateCompromisedBanner.test.tsx
git commit -m "test(e2ee): lock in that awaiting-key (and other non-compromised) statuses show no banner"
```

---

## Self-review notes
- **Spec coverage:** §4.1 awaiting-key → T1; §4.2 classification → T1; §4.3 re-verify after recovery → T3; §4.4 instrumentation → T4; §4.5 banner unchanged → T5 (characterization); §6 tests → T1 (reproduction + no-weakening + default-arg), T2 (predicate), T3 (recovery resolves), T5 (banner gating).
- **Security boundary:** only the decrypt-catch `isKeyUnavailable(err)` branch changes verdicts, and only from compromised→awaiting-key when the key was unavailable. T1's no-weakening cases pin that mismatch / foreign-sig / non-key-error / (default-arg) still return `compromised`.
- **Harness uncertainty (T3/T4):** the exact `fake.invoke` decrypt-failure hook and the plugin's console accessor are confirmed against `SequoiaPgpPlugin.test.ts` / `OpenPGPPluginBase.ts` at implementation time; if the single-shot decrypt-failure hook doesn't exist, add it to the test harness (test-only).
