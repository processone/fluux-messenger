# Surface a failed backup re-publish during key rotation

**Date:** 2026-07-22
**Status:** Approved, ready for implementation
**Scope:** `apps/fluux/src/e2ee/OpenPGPPluginBase.ts`, `apps/fluux/src/components/settings-components/EncryptionSettings.tsx`, one i18n key across 33 locales, two test files.

## Problem

`OpenPGPPluginBase.rotateEncryptionKey(backupPassphrase)` catches a failed
`backupSecretKey` and only `logger.warn`s it. The call then resolves
normally, so `doRotate` fires the "Encryption key rotated" success toast and
closes the passphrase dialog.

The user has just been shown a freshly generated passphrase, told to write it
down, and made to tick "I've saved this passphrase somewhere safe." When the
publish fails they walk away holding a passphrase for a backup that was never
published, believing it is live. The server copy still decrypts only with the
*previous* passphrase, which the dialog has already declared dead.

This was found during the final review of PR #1077 and deliberately left out
of that PR's scope. #1077 raises the stakes: the settings panel now routes
rotation through the re-publish path when the backup probe returns `unknown`,
and `unknown` is by definition correlated with a server we could not reach.
The previously rare race becomes the expected case on that path.

Mitigating but not sufficient: the post-rotate probe re-runs, so the status
line returns to the yellow "couldn't check" state rather than falsely
claiming green. The passphrase, however, is gone by then.

## The distinction to draw

`rotateEncryptionKey` performs three publishes after committing the rotation,
and they are not equivalent:

| Step | Retried by | Verdict |
| --- | --- | --- |
| `publishOwnPublicKeyData` / `...Metadata` | `ensureIdentity`, on every connect | genuinely best-effort; self-heals |
| `backupSecretKey`, no passphrase supplied | nothing, but nothing was promised | best-effort is fine |
| `backupSecretKey`, passphrase supplied | nothing, ever | **must surface** |

When the caller supplies a passphrase, re-publishing the backup is the point
of the call, not a side effect. Nothing retries it, and the passphrase stops
existing the moment the dialog closes.

## Design

### 1. Plugin: throw instead of warn

In the `backupPassphrase !== undefined` branch of `rotateEncryptionKey`,
replace the swallow with a throw. The no-passphrase path keeps its
warn-and-continue, unchanged.

The rotation is **not** unwound. By this point the local cert genuinely holds
the new encryption subkey; claiming otherwise would be a bigger lie than the
error. The error says what happened: the key rotated, the backup did not
publish.

The thrown value is an `E2EEPluginError` that carries:

- `kind` taken from the underlying error's classification (via the existing
  `toPluginError`, so a transient network failure stays transient and the
  app's retry semantics are unaffected);
- `code` pinned to `'backup-publish-failed'`, a new slug. `E2EEPluginError`
  deliberately does not enumerate codes, so no SDK change is needed. The
  pinned code is what lets the caller distinguish "rotation failed" from
  "rotation succeeded, backup failed" without matching on message text.

`backupSecretKey` already throws an `E2EEPluginError` for the encrypt step
and a raw error from `publishPEP`; both are normalized through
`toPluginError` for the `kind` and then re-wrapped with the pinned code.

The code comment must record why the two publishes in the same function are
treated differently, because the asymmetry looks arbitrary otherwise: the
public-key publish self-heals on the next connect, the backup publish never
does.

### 2. Caller: translate the failure, keep the probe refresh

In `doRotate`:

- The `setBackupProbeNonce` bump moves into a `finally`. The rotation
  committed regardless of the backup outcome, so the backup status line is
  stale on both paths and must re-probe either way. This preserves the
  behaviour noted as mitigating context above.
- On `isE2EEPluginError(err) && err.code === 'backup-publish-failed'`:
  `console.error` the technical error (matching how the sibling rotate path
  logs) and rethrow a new `Error` carrying the localized message.
- Any other error rethrows untouched, so the existing `rotateFailed` toast
  path in `handleRotateConfirm` is unaffected.
- The success toast stays on the success path only.

No dialog changes. `BackupPassphraseDialog` already catches a rejected
`onConfirm`, renders `err.message` in its error slot, stays open, and keeps
the same passphrase displayed, so the user can retry without re-copying it.

Retrying re-runs the whole rotation, generating a second encryption subkey.
That is accepted: it converges (the eventual backup wraps the newest cert),
old subkeys stay in the cert for decryption, and the alternative — retry
state tracking in a component PR #1077 is also editing — is not worth the
complexity for a path whose usual outcome is "the server is down, cancel".

### 3. i18n

One new key, `settings.encryption.rotateBackupFailed`, in all 33 locales.
English:

> Your key was rotated, but the new backup could not be published. The
> passphrase above is not active yet. Check your connection and try again.

Three sentences, no em-dashes or en-dashes as connectors, per the house
punctuation convention. It has to convey both facts the user needs: the
rotation *did* happen, and the passphrase they just saved is *not* live.

## Testing

No test covers this today; `SequoiaPgpPlugin.test.ts` covers only the happy
path ("re-wraps the backup when a passphrase is supplied").

### Plugin tests (`SequoiaPgpPlugin.test.ts`)

Inject a failure on `publishPEP` **scoped to the secret-key node only**, so
the public-key publishes still succeed and the test exercises the real
asymmetry rather than a globally broken transport.

1. **With a passphrase, rotation rejects.** `rotateEncryptionKey('pp')`
   rejects with an `E2EEPluginError` whose `code` is `'backup-publish-failed'`.
2. **Control: without a passphrase, the same injection resolves.** Pins the
   asymmetry. This is the test that fails if the throw is ever made
   unconditional, or if the injection is accidentally widened to every node —
   either mistake would leave test 1 passing for the wrong reason.
3. **Rotation still took effect.** After the rejection, the data and metadata
   nodes were still published and the fingerprint is unchanged. Pins that we
   do not unwind, and proves the failure was scoped to the backup step.

### App test (`EncryptionSettings.test.tsx`)

Drive the real rotate flow — in-sync backup marker, rotate button, confirm
dialog, passphrase dialog, acknowledge, publish — against a plugin whose
`rotateEncryptionKey` rejects with the pinned code. Assert the dialog shows
`settings.encryption.rotateBackupFailed` (the mocked `t` returns the key) and
that no success toast fired.

## Out of scope

- The public-key publish swallow in `ensureIdentity` and `rotateEncryptionKey`.
  It self-heals on the next connect; changing it is a separate decision.
- `IdentityChoiceDialog`'s callers collapsing a failed `probeRemoteIdentityState`,
  the other pre-existing issue flagged in #1077's review.
- Avoiding the second subkey on retry (see rationale in §2).

## Branch

Standalone on `main`. PR #1077 touches the same three source files but
neither `rotateEncryptionKey` nor the body of `doRotate`, so the two can
merge independently; conflicts, if any, will be test-file adjacency.
