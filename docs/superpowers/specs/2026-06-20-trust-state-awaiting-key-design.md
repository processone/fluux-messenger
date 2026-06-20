# Trust-state integrity: don't alarm when the key is merely unavailable

- **Date:** 2026-06-20
- **Status:** Draft — awaiting maintainer review
- **Area:** E2EE / OpenPGP trust-state integrity (app layer)
- **Related:** PR #608 (OpenPGP keychain/TSK passphrase desync recovery), `apps/fluux/src/e2ee/trustStateIntegrity.ts`, [feedback: security iconography calm by default]

## 1. Problem

After a benign OpenPGP key **recovery** (the #608 keychain/TSK passphrase desync — the cert is unchanged, only the at-rest wrapping passphrase is fixed), the Encryption settings screen showed the **trust-state "compromised" banner**: *"Local trust data may have been tampered with. Silent key re-pinning is blocked to prevent key substitution"* with a *"Re-verify and continue"* button ([en.json:707-708](apps/fluux/src/i18n/locales/en.json), [TrustStateCompromisedBanner.tsx](apps/fluux/src/components/TrustStateCompromisedBanner.tsx)).

This is a **false positive**. The recovery preserved the same certificate, so the same peers are pinned and the encrypt-to-self trust-state seal is still valid; nothing was tampered with and nothing needs re-pinning. Being told your trust data "may have been tampered with" — and being pushed to re-verify contacts whose keys never changed — is both alarming and wrong.

## 2. Root cause

The trust-state seal is a signed, encrypt-to-self blob of the TOFU pins + verified peers + key-change alerts, validated on init once the key is available ([trustStateIntegrity.ts:95-161](apps/fluux/src/e2ee/trustStateIntegrity.ts)). Its decrypt-failure branch is:

```ts
try {
  decrypted = await decryptFn(sealArmored, ownPublicArmored)
} catch {
  if (storesAreEmpty()) return { status: 'pending-seal' }
  return { status: 'compromised', details: ['Trust state seal could not be decrypted'] }
}
```

It treats **every** decrypt failure as `'compromised'` — even though the codebase already distinguishes *"the secret key is unavailable"* (`key-locked` transient / `key-unrecoverable` permanent) from a genuine decrypt failure ([OpenPGPPluginBase.ts:272-313](apps/fluux/src/e2ee/OpenPGPPluginBase.ts)). A decrypt failure because the key isn't usable yet is **not** evidence of tampering — but the catch block discards the error class and alarms anyway.

Compounding it: the status is re-evaluated per session and **not persisted** ([trustStateStatusStore.ts](apps/fluux/src/stores/trustStateStatusStore.ts)), the integrity check is deliberately deferred while the key is `key-unrecoverable` (init returns early without `activateSubscriptions`, [OpenPGPPluginBase.ts:553-561](apps/fluux/src/e2ee/OpenPGPPluginBase.ts)), but the recovery-completion path does not reliably **re-run** the verification once the key is back — so a deferred/transient state has no clean path to resolve to `sealed`.

Finally, **none of these transitions are logged** to the webview console, so the original incident is not diagnosable from `~/Library/Logs/com.processone.fluux/*` — only the in-app console store would have anything, and the recovery path doesn't record there either.

## 3. Goal, security boundary, non-goals

**Goal:** stop the trust-state integrity check from raising the "compromised" alarm when the only problem is that the secret key was not usable at verification time; resolve to the correct verdict once the key is available; and make the transitions diagnosable.

**Security boundary (chosen):** *minimal & security-safe* — the change must **only ever remove false alarms**, never weaken a real tamper signal. Specifically, all of these still return `compromised`: the seal decrypts but the pins/verified/alerts don't match current storage; the signature is foreign/invalid (decrypt succeeded ⇒ key was usable); the payload is malformed; the seal is absent while the key is usable.

**Non-goals (explicitly out of scope):**
- Auto-resealing when the encryption **subkey** genuinely changed (fingerprint unchanged) — that trades detection strength for convenience and was declined.
- Reworking the banner copy.
- Changing what the seal protects or how it is bound.

## 4. Design

### 4.1 New status `awaiting-key`
Add `awaiting-key` to `TrustStateStatus` ([trustStateStatusStore.ts](apps/fluux/src/stores/trustStateStatusStore.ts)): *the seal could not be checked because the secret key was not usable; no verdict yet.* It renders **no banner** — `TrustStateCompromisedBanner` remains gated strictly on `status === 'compromised'`.

### 4.2 Classify the decrypt failure in `verifyTrustStateSeal`
Add an injected predicate parameter `isKeyUnavailable?: (err: unknown) => boolean` (default `() => false`, preserving current behavior for callers/tests that don't pass it). Change the decrypt catch to bind the error and consult it:

```ts
} catch (err) {
  if (isKeyUnavailable(err)) return { status: 'awaiting-key' }
  if (storesAreEmpty()) return { status: 'pending-seal' }
  return { status: 'compromised', details: ['Trust state seal could not be decrypted'] }
}
```

This is the entire security-relevant change, and it is monotonic — it can only convert a former `compromised`/`pending-seal` into `awaiting-key` when the key was unavailable. No other branch changes. The predicate is supplied by the plugin (which owns the `E2EEPluginError` codes), keeping `trustStateIntegrity.ts` headless and the function a pure, injectable unit.

The plugin passes a predicate recognizing key-unavailability, e.g. `err instanceof E2EEPluginError && (err.code === 'key-locked' || err.code === 'key-unrecoverable')` (exact recognizer confirmed against `errors.ts` during implementation).

### 4.3 Re-verify when the key becomes available
`verifyTrustStateOnInit` must run (or re-run) after the secret key becomes usable — i.e., after a successful recovery / unlock, not only on the first activation. The implementation plan will enumerate the exact completion points (`doInstallKey`, `retireAndGenerateIdentity`, `WebOpenPGPPlugin.unlock`, and the `notifyKeyUnlocked` path) and ensure each drives a re-verification, with the existing double-activation guard ([OpenPGPPluginBase.ts:575](apps/fluux/src/e2ee/OpenPGPPluginBase.ts)) not blocking the re-check. For an unchanged cert this resolves `awaiting-key → sealed` with **zero user action**.

### 4.4 Instrumentation
On every trust-state verdict, log the status + reason/details (and, for the decrypt-failure branch, whether it was classified key-unavailable) to **both** the webview console (so it lands in `fluux.log`) and the in-app console store. This makes any future trust-state incident diagnosable from logs — the gap that made this incident unanalyzable.

### 4.5 What does NOT change
The seal format, the encrypt-to-self binding, the pins-mismatch/foreign-signature/malformed-payload/seal-absent-while-usable branches, and the banner copy. The `'compromised'` path is reachable exactly as before for genuine tampering.

## 5. Security analysis

The seal defends against localStorage tampering: an attacker who edits `pinnedFingerprintByJid` to substitute a peer's key is caught because the signed seal (which they cannot forge) still holds the correct pins → pins-mismatch → `compromised`. That path is untouched.

An attacker can also **delete or corrupt** the seal to force the absent/undecryptable branches. This design keeps those as `compromised` **when the key is usable**. The only relaxation is: a decrypt failure *attributable to the secret key being unavailable* is treated as "no verdict yet" rather than "tampered." That is sound because (a) it is not a tamper signal — the key simply could not run, and (b) once the key is available (§4.3) the seal is checked for real, so a genuine deletion/corruption with a usable key still alarms. Net: strictly fewer false alarms, identical true-positive coverage.

## 6. Testing (the verification — logs cannot be)

Pure-function unit tests on `verifyTrustStateSeal` (it takes injected `encryptFn`/`decryptFn`, so no jsdom/keys needed), plus store/banner gating:

- **Reproduction (the bug):** seal valid, `decryptFn` throws a key-unavailable error, `isKeyUnavailable` returns true, stores non-empty → asserts `awaiting-key`, **not** `compromised`.
- **No weakening (true positives preserved):** (a) decrypt succeeds but pins differ → `compromised`; (b) decrypt succeeds, signature foreign → `compromised`; (c) decrypt throws a *non*-key-unavailable error (`isKeyUnavailable` false) with non-empty stores → `compromised`; (d) seal absent while initialized + stores non-empty → `compromised`.
- **Default-arg behavior:** omitting `isKeyUnavailable` preserves today's behavior (every decrypt failure → `compromised`/`pending-seal`) so existing callers/tests are unaffected.
- **Banner gating:** `awaiting-key` renders no `TrustStateCompromisedBanner`; `compromised` still does.
- **Recovery resolves:** an `awaiting-key` verdict followed by the key becoming available re-runs verification and lands on `sealed` for an unchanged cert (integration-level test of the §4.3 wiring; scope confirmed in the plan).
- **Plugin predicate:** the plugin's `isKeyUnavailable` recognizer returns true for `key-locked`/`key-unrecoverable` `E2EEPluginError`s and false for a generic error.

## 7. Files touched (anticipated)
- `apps/fluux/src/stores/trustStateStatusStore.ts` — add `awaiting-key`.
- `apps/fluux/src/e2ee/trustStateIntegrity.ts` — `isKeyUnavailable` param + decrypt-catch classification + transition logging.
- `apps/fluux/src/e2ee/OpenPGPPluginBase.ts` — pass the predicate into `verifyTrustStateSeal`; ensure re-verify after recovery/unlock; instrumentation.
- `apps/fluux/src/e2ee/WebOpenPGPPlugin.ts` / the Sequoia (desktop) plugin — re-verify-after-unlock parity (confirm during implementation).
- `apps/fluux/src/components/TrustStateCompromisedBanner.tsx` — confirm gating stays `compromised`-only (likely no change).
- Tests alongside the above.

## 8. Verification gate
`npm test` (app) green, no stderr; `npm run typecheck`; lint clean. The reproduction test must fail before the §4.2 change and pass after.
