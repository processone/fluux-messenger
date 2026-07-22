# Explicit re-publish of the OpenPGP secret-key backup

**Date:** 2026-07-22
**Status:** Design — pending review
**Scope:** UI only, in `apps/fluux`. No plugin-layer change, no SDK change, no Rust
change, no new cryptography.

## Problem

A user cannot re-publish their XEP-0373 §5 secret-key backup once one exists for
the current key. The backup button row in
`apps/fluux/src/components/settings-components/EncryptionSettings.tsx` is wrapped
in `!checking && !inSync`, so reaching the in-sync state removes **both** "Back up
to server" and "Restore from server" from the UI. In-sync is a dead end.

That matters because `inSync` is derived from a local marker
(`fluux:openpgp:backedUpFingerprint:<bareJid>`, `backupMarker.ts`) that records
only a **fingerprint**. The backup blob is SKESK-encrypted, so nothing in the UI
can see how it was encoded. A backup published by Fluux ≤0.17.1 is encrypted with
the legacy-normalized passphrase (NFKD → lowercase → whitespace collapse, #1021),
which no spec-compliant client — Gajim included — can open with the code the user
was shown. The marker still matches, so the status line reads green
"This key is backed up on the server" over a blob that is useless for interop, and
the UI offers no way to fix it.

Discovered while testing OpenPGP interop against Gajim: the server copy was still
legacy-encoded and there was no in-app route to re-publish it.

### Why heal-on-restore did not cover this

`healLegacyBackupEncoding` (`OpenPGPPluginBase.ts`) re-publishes verbatim after a
legacy-encoded backup is successfully restored, but it only runs from
`restoreSecretKey` — and on web, `unlock()` only reaches `restoreSecretKey` on its
**recovery branch**, when the local key is missing or won't decrypt
(`WebOpenPGPPlugin.ts`, `isRecoverableLocalFailure`). The at-rest wrap has never
been normalized (`encryptKey({ privateKey, passphrase })` takes the raw string,
before and after #1024 — verified against the diff of `1a5660c9`), so the local key
has always opened with the displayed code, `ensureIdentity()` succeeds, and the
heal never fires. On desktop, at-rest is an independent keychain secret and
`restoreSecretKey` is never called at startup at all.

The heal is therefore correct but rarely triggered. It is not the bug; the missing
explicit lever is.

## Non-goals

- **No detection of the blob's encoding.** After this change the green in-sync line
  can still sit over a legacy-encoded backup. The button makes it *fixable*, not
  *detectable*. Recording the encoding alongside the fingerprint in the marker is a
  separate, larger change and is deliberately out of scope.
- **No removal of heal-on-restore.** See "Heal-on-restore stays" below.
- **No user-supplied passphrase.** Re-publishing always draws a fresh code.
- **No change to the key itself.** Re-publishing rewrites the backup node only;
  rotation remains a separate action.
- **No fix for the web at-rest wrap.** It self-converges; see §4 for why the
  apparent bug is left alone.

## Design

### 1. The button row renders unconditionally

Drop `!inSync` from the row's condition in `EncryptionSettings.tsx`; the row renders
whenever `!checking`. "Restore from server" keeps its own
`remoteBackupExists === true` guard and so becomes visible in-sync too — it is the
passphrase-preserving repair path and there is no reason to hide it.

`inSync` is **not** deleted. It keeps feeding the status line, which is what
actually communicates state:

| state | status line |
|---|---|
| `remoteBackupExists === null` | `backupStatusChecking` (muted) |
| in-sync | `backupStatusInSync` (green) |
| backup exists, marker missing/differs | `backupStatusMismatch` (yellow) |
| no backup | `backupStatusNone` (muted) |

The resulting invariant: **the buttons say what you can do, the status line says
where you are.** The two stop being coupled.

### 2. The confirmation gate widens

`handleBackupRequest` currently confirms only on *conflict* — a remote backup whose
fingerprint this device did not publish. Publishing now always replaces an existing
blob *and* always invalidates the code the user saved (the dialog draws a fresh
passphrase every time, `BackupPassphraseDialog.tsx`), so the in-sync case needs a
confirmation of its own.

Gate becomes `remoteBackupExists === true`, with two variants. Replace the boolean
`showBackupConflictConfirm` with `backupConfirmVariant: 'foreign' | 'own' | null`:

- **`'foreign'`** — marker missing or differs. Existing copy, unchanged:
  `backupConflictTitle` / `backupConflictMessage` / `backupConflictAction`.
- **`'own'`** — marker matches the current fingerprint. Three new keys under
  `settings.encryption`, phrased to track the existing
  `rotateConfirmMessageWithBackup`, which already describes this consequence:

  - `backupReplaceOwnTitle` — "Replace your backup?"
  - `backupReplaceOwnMessage` — "A new passphrase will be generated and your server
    backup re-encrypted with it. The passphrase you saved for the current backup will
    stop working, including in any other client you set it up in. Your key itself is
    unchanged."
  - `backupReplaceOwnAction` — "Replace backup"

  Rendered through the existing `ConfirmDialog` with `variant="danger"`, matching the
  `'foreign'` variant.

`remoteBackupExists === false` skips the confirm and opens the dialog directly, as
today.

New keys translated across all 33 locales in `apps/fluux/src/i18n/locales/`.

### 3. Heal-on-restore stays

Unchanged. It and the button solve different problems and only the heal can solve
its one:

- A restore is the only moment the app holds the plaintext passphrase and the
  decrypted key together, so it is the only place the server copy can be re-encoded
  **while preserving the passphrase**.
- The button always rotates to a fresh code, which forces the user to re-record it
  and re-key every other client.

Removing the heal would mean the only route to a verbatim server copy costs a new
passphrase. `backupImportAllWithLegacyFallback` and the file-import fallback also
stay — they are what keeps ≤0.17.1 backups restorable at all.

### 4. Considered and rejected: fixing the web at-rest wrap

Recorded so the next person tracing this finds the reasoning instead of
rediscovering it as a bug.

`doInstallKey` passes `workingPassphrase` — the form that *opened the blob* — into
`backupImportSelected`, which on web uses it both to re-wrap the key at rest and to
set the session passphrase (`WebOpenPGPPlugin.ts`). After a restore that needed the
legacy fallback, the local key is therefore wrapped under the **lowercased** form
while the user knows only the uppercase code.

This looks like a bug and is not worth fixing, because it self-converges:

1. Restore #1 — local decrypt fails, recovery runs, the heal rewrites the server
   copy verbatim. Local key still wrapped legacy.
2. Any subsequent unlock — local decrypt fails again, recovery runs again, but
   verbatim now opens the server copy, so `workingPassphrase` **is** the typed
   passphrase and the re-wrap corrects itself.

Step 2 needs no user action and no prompt. `attemptCachedUnlockOrPrompt`
(`silentRestore.ts`) feeds the cached passphrase straight into `plugin.unlock()`,
and the recovery branch returns `{ recovered: true }` without throwing — so a
cached unlock converges silently and the dialog never opens. The 24h passphrase
cache TTL (`webPassphraseCache.ts`) only bounds the worst case; it is not the
mechanism.

The condition is also self-limiting: only a restore from a not-yet-healed backup
wraps legacy, and that same restore heals it, so it can happen at most once per
account, only for accounts migrating from ≤0.17.1.

A contained fix exists (re-wrap under the typed passphrase at the end of
`WebOpenPGPPlugin.unlock`'s recovery branch, ~10 lines). It buys one avoided
recovery round-trip in a migration that completes on its own, so it is not worth
the code or the test. Threading a second passphrase through `doInstallKey` was
rejected more firmly still: it would touch `RestoreResult.backupContext`, the
`backupImportSelected` abstract signature, both plugin implementations, four call
sites, and the public `installSelectedKey` plus its two app-side callers.

The picker sub-path (`installSelectedKey`, reached via `KeyPickerRequiredError`)
has the same property, matching the limitation heal-on-restore already documents
for the multi-key path.

### Error handling

Unchanged. `handleBackupConfirm` leaves the dialog open on failure so the user can
retry, and re-publish is idempotent at the PEP layer — `publishPEP` uses
`maxItems: 1` and the fixed `CURRENT_ITEM_ID`, so a repeat publish overwrites rather
than accumulating items. `writeBackedUpFingerprint` runs only after a successful
publish, so a failed re-publish cannot manufacture a false in-sync state.

## Testing

One new test, in `EncryptionSettings`: with `remoteBackupExists === true` and a
marker matching the current fingerprint, the backup button renders, and clicking it
opens the `'own'` confirm variant rather than publishing directly.

No plugin-layer test is needed — no plugin-layer code changes.

Unchanged and expected to stay green, which is the regression check that the heal
and the encrypt path both survived: the heal tests in `SequoiaPgpPlugin.test.ts` and
`WebOpenPGPPlugin.test.ts`, and `consumeSequoiaVectors.test.ts` /
`consumeMigrationVectors.test.ts` (backup encryption bytes do not change, so the
golden vectors must not need regenerating — if they do, something in the encrypt
path moved and that is a bug in the implementation).

Per the project's recurring hollow-test defect, each new test is gated on a
deliberate-break run: introduce the exact regression, confirm the test FAILS, revert,
confirm green. Review alone has not caught hollow assertions in this area before.

## Manual verification

1. On an account whose backup is legacy-encoded, open Encryption settings and
   confirm the status line reads green in-sync **and** the button row is present.
2. Click "Back up to server", confirm the `'own'` dialog wording, publish, and save
   the new code.
3. Import the account into Gajim and confirm the backup opens with the displayed
   code — the interop check this whole change exists for.
4. Separately, confirm "Restore from server" with the old uppercase code still
   repairs the blob via the heal without changing the passphrase.
