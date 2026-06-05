# OpenPGP Web Key Recovery — Design

- **Date:** 2026-06-05
- **Status:** Approved (pending spec review)
- **Scope:** `apps/fluux` web E2EE (`WebOpenPGPPlugin`) — web/browser only

## Problem

The web E2EE plugin (`WebOpenPGPPlugin`) stores the account's OpenPGP private key in
IndexedDB, encrypted under a session passphrase the user enters each session. Unlock
decrypts that local blob with the entered passphrase (`decryptKey`).

When the local blob cannot be decrypted with the user's **current** passphrase, the
unlock dialog dead-ends with "wrong passphrase" — even though the key is recoverable
from the server-side secret-key backup (XEP-0373 §5) using that **same** passphrase.
The user is locked out of E2EE on that device with no in-app path forward.

Observed in practice: the same passphrase (pasted from a password manager) unlocked on
macOS Safari but failed on Android Brave. The two browsers have independent IndexedDB;
Android's stored blob was encrypted under an **older** backup passphrase (rotated since),
so the current passphrase legitimately fails against the stale local copy. The server
backup opens fine with the current passphrase. Manually invoking `restoreSecretKey()`
on Android recovered and re-provisioned the key, confirming the fix.

Two secondary defects made this hard to diagnose and impossible to self-recover:

1. The unlock path never falls back to the server backup.
2. Every `decryptKey` failure is relabeled `wrong-passphrase`, masking the real cause
   (`WebOpenPGPPlugin.ts:104`).
3. The settings **État** showed "Génération de votre clé…" while the key was actually
   locked — contradictory status.

## Goals

- **Auto-fallback recovery at unlock:** try the local key; on a recoverable failure,
  transparently recover from the server backup with the same passphrase, re-provision
  the local copy, and unlock.
- **Cover all "key not usable" cases** through one passphrase-entry point:
  - (a) stale / undecryptable local key
  - (b) no local key but a server backup exists (fresh device) — restore, not generate
  - (c) normal unlock (local key opens)
- **Honest errors:** conclude "wrong passphrase" only after **both** local and backup
  decryption fail on the passphrase; otherwise surface the real reason.
- **Accurate status** on the encryption settings screen.

## Non-goals

- Desktop / Sequoia plugin (OS keychain, no passphrase — different model).
- Migrating the on-disk normalization asymmetry (backup decrypt normalizes via
  `NFKD → lowercase → collapse whitespace`; local store uses the raw passphrase).
  Auto-recovery self-heals a diverged local blob, so this is left as optional future
  hardening rather than a risky re-encryption migration of existing blobs.
- Group/MUC E2EE, OMEMO.

## Approach

**Chosen:** orchestrate in `WebOpenPGPPlugin.unlock()`, reusing the existing
`restoreSecretKey()` recovery primitive (base class). `unlock` attempts the local path
(`ensureIdentity`); on a recoverable failure it calls `restoreSecretKey(passphrase)`,
which fetches and decrypts the server backup and overwrites the stale local blob with
one re-encrypted under the current passphrase.

**Rejected:** embedding a non-publishing recovery branch inside `ensureKeyMaterial` —
more cohesive but duplicates the decrypt-backup logic `restoreSecretKey` already owns.
No double-publish risk in the chosen approach: `ensureIdentity` throws at
`ensureKeyMaterial` **before** its publish step, so only the recovery path publishes.

## Design

### 1. Plugin — `WebOpenPGPPlugin.unlock(passphrase)`

New control flow:

```
setSessionPassphrase(passphrase)
try:
  await ensureIdentity()                 // local path (decrypt; or generate for a truly fresh account)
  activateSubscriptions()
  return { recovered: false }
catch (err):
  if not isRecoverable(err):             // not a key-availability problem → real failure
    clearSessionPassphrase(); throw err
  // local key absent or stale → recover from server backup with the same passphrase
  try:
    const result = await restoreSecretKey(passphrase)
    if result.needsPicker:
      clearSessionPassphrase()
      throw KeyPickerRequiredError(result.candidates, result.backupContext)
    activateSubscriptions()
    return { recovered: true }
  catch (recoverErr):
    clearSessionPassphrase()
    throw classifyRecoveryFailure(err, recoverErr)
```

- **`isRecoverable(err)`** — `err.code ∈ { 'wrong-passphrase', 'needs-identity-decision' }`.
  These are exactly "the local copy is missing or won't open." Other errors (network,
  `pep-unsupported`, etc.) are not passphrase-recoverable and propagate unchanged.
- **`classifyRecoveryFailure(localErr, recoverErr)`**
  - `recoverErr.code === 'no-backup'`:
    - `localErr.code === 'wrong-passphrase'` (a stale local blob exists but there is no
      backup to recover from) → `NoRecoveryAvailableError` → dialog offers file import.
    - `localErr.code === 'needs-identity-decision'` (no local key; server advertises a
      published key but has **no** secret backup) → re-throw `needs-identity-decision`,
      preserving the existing IdentityChoiceDialog routing (import key file / retire
      identity). Auto-recovery only engages when a secret backup actually exists.
  - `recoverErr.code === 'wrong-passphrase'` → `wrong-passphrase` (now genuinely true:
    both local and backup rejected it).
  - otherwise → propagate `recoverErr` (e.g. transient server error) so the user retries.
- **Return type** changes from `Promise<void>` to `Promise<{ recovered: boolean }>` so
  the dialog can show the "restored from backup" note. `unlock` is consumed only by the
  unlock dialog and the debug API.

`restoreSecretKey` / `doInstallKey` already re-encrypt + store the local blob under the
(raw) current passphrase, set the in-memory key, set the session passphrase, publish the
public key, and reconcile own-key state. After recovery, future raw-passphrase unlocks
match — the divergence is healed.

### 2. Dialog — `UnlockEncryptionDialog` gains a third mode

Today the dialog chooses setup-vs-unlock from `hasNoLocalKey()` alone. Add a Restore mode
driven by `hasNoLocalKey()` × `hasSecretKeyBackup()`:

| Local key | Server backup | Mode        | UI                                                            |
|-----------|---------------|-------------|--------------------------------------------------------------|
| present   | —             | **Unlock**  | single field, "enter passphrase"                             |
| absent    | present       | **Restore** | single field, "enter your existing passphrase to restore" (no confirm) |
| absent    | absent        | **Setup**   | create-new, with confirm field                               |

Mode is resolved on dialog mount from `hasNoLocalKey()` (local, fast) and
`hasSecretKeyBackup()` (one PEP probe). This fixes fresh-device case (b): a device with no
local key but a server backup currently lands in the **setup / create-new** screen
(wrong), which then trips the silent-generation guard. Restore mode routes it straight to
`unlock(passphrase)` → recovery.

**Setup is optimistic.** When the server advertises a published key but has no secret
backup (and there is no local key), `unlock` surfaces `needs-identity-decision`; the
dialog falls through to the **existing IdentityChoiceDialog** (import key file / retire
identity) — unchanged behavior, now reached through the unified entry point.

Failure handling:

- show the **real** error message (no blanket "wrong passphrase").
- `NoRecoveryAvailableError` → explanation + an **"Import key file"** action
  (`pickKeyFile` → `importKeyFromFile`).
- `KeyPickerRequiredError` → existing key-picker UI → `installSelectedKey`.
- success with `{ recovered: true }` → subtle inline note: "Key restored from your
  server backup."

### 3. Status — `EncryptionSettings` "État"

Replace the unconditional "Génération de votre clé…" with states reflecting reality:

```
Locked → Unlocking… → Restoring from backup… → Unlocked (<short-fingerprint>)
                                              ↘ Needs decision
                                              ↘ Error: <reason>
```

Source the state from plugin lock state + the in-flight unlock/recovery operation, not a
placeholder that always reads "generating."

### 4. Error model

- Remove the catch-all relabel at `WebOpenPGPPlugin.ts:104` that turns every `decryptKey`
  failure into `wrong-passphrase`. Preserve the original error as the `cause` on the
  wrapping `E2EEPluginError`; the orchestrator (§1) decides the final user-facing
  classification.
- Add typed signals `NoRecoveryAvailableError` and `KeyPickerRequiredError` (or
  `E2EEPluginError` codes `no-recovery-available`, `needs-picker`).

## Components / files touched

- `apps/fluux/src/e2ee/WebOpenPGPPlugin.ts` — `unlock()` orchestration; remove error
  mask; return `{ recovered }`.
- `apps/fluux/src/e2ee/OpenPGPPluginBase.ts` — verify `restoreSecretKey` error codes
  (`no-backup`, `needs-picker`/`needsPicker`) are stable for the orchestrator; no
  behavior change expected.
- `apps/fluux/src/components/UnlockEncryptionDialog.tsx` — three modes; failure handling;
  recovered note; import-file action.
- `apps/fluux/src/components/settings-components/EncryptionSettings.tsx` — accurate État.
- i18n — new keys (restore-mode title/body, "restored from backup" note,
  no-backup/import messaging, status strings) in **every** locale; the i18n parity test
  enforces presence, and translations must be real (project rule), not placeholders.
- Tests — see below.

## Testing

Unit (vitest), mock storage + mock PEP backup:

| Local         | Backup            | Passphrase          | Expected                                  |
|---------------|-------------------|---------------------|-------------------------------------------|
| ok            | —                 | correct             | unlock, `recovered: false`                |
| stale         | present           | correct-for-backup  | recover, `recovered: true`, local reprovisioned |
| stale         | present           | wrong-for-both      | `wrong-passphrase`                        |
| stale         | absent            | wrong-for-local     | `NoRecoveryAvailable` (had-local variant) |
| absent        | present           | correct             | recover, `recovered: true`                |
| absent        | absent            | (setup)             | generate (fresh account)                  |
| absent        | present multi-key | correct             | `KeyPickerRequired`                        |
| ok-in-memory  | —                 | —                   | cached, no storage read                   |

- Dialog: mode selection from `hasNoLocalKey` × `hasSecretKeyBackup`; failure rendering
  (real error, import-file action, picker escalation, recovered note).
- i18n parity test passes.

## Risks

- **Server fetch on wrong passphrase:** a genuinely-wrong attempt now also queries the
  server backup. Acceptable (rare, user-initiated); can short-circuit when no backup is
  advertised.
- **Multi-key backups:** handled via picker escalation; verify selection-by-advertised-
  fingerprint still narrows confidently before falling back to the picker.
- **i18n churn:** new keys across all locales; the parity test guards omissions, and the
  project rule requires genuine translations, not placeholders.
