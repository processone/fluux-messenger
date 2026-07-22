# A third state for the OpenPGP backup probe: "unknown"

**Date:** 2026-07-22
**Status:** Design — pending review
**Scope:** `apps/fluux` only. No SDK change, no Rust change, no new cryptography.
**Baseline:** `c2daca9d` on `main` (includes #1064 and the `isBackupInSync` extraction, #1067).

## Problem

`fetchSecretKeyBackup` swallows every error and returns `null`:

```ts
} catch (err) {
  ctx.logger.debug(`…: fetchSecretKeyBackup: ${formatError(err)} (treated as no backup)`)
}
return null
```

`hasSecretKeyBackup()` is `(await fetchSecretKeyBackup()) !== null`, so a timeout, a
disconnected transport, a permission error and a genuinely empty PEP node are all
indistinguishable. Every caller reads "there is no backup on the server" when the
truthful answer is "I could not find out."

This matters because the PEP layer *can* tell the difference. `PubSub.query` sends an
IQ and rejects on error; ejabberd and Prosody return `item-not-found` for a node that
was never created. `item-not-found` means absent. Everything else is an open question.

### The four consumers, and how each fails

| Consumer | Location | Failure on a swallowed probe error |
|---|---|---|
| Backup confirm gate | `EncryptionSettings.tsx:660` | Skips the replace confirmation; overwrites a real backup with no warning |
| Rotate | `EncryptionSettings.tsx:768` | Rotates without re-encrypting the server backup, leaving a real one stale |
| Delete-key dialog | `EncryptionSettings.tsx:1257` | Hides "also delete the server backup", orphaning a real one |
| Unlock dialog | `UnlockEncryptionDialog.tsx:73` | Shows **setup** ("create a new passphrase") instead of **restore** |

The unlock case is the worst: a user whose local key is gone, hitting a transient
network failure, is invited to create a new key while a perfectly good backup sits on
the server.

There is a fifth, in the plugin itself: `restoreSecretKey` calls
`fetchSecretKeyBackup` and raises `no-backup` — *"no secret-key backup found on
server"* — when the fetch returns `null`. On a transport failure that message is a
lie, delivered at the exact moment the user is deciding whether to replace their
identity.

### The codebase already solved this once

`apps/fluux/src/e2ee/secretKeyProbe.ts` implements exactly the right semantics for the
plugin-less toggle-on / auto-init path, and its docstring states the rule:

> `item-not-found` is the only error condition that means "the user has never
> published a backup" … Anything else (timeout, permission, transport down) is an open
> question and must NOT collapse to "no backup."

It exists because silent fresh-key generation on an ambiguous probe would publish a new
fingerprint over metadata pointing at a still-existing backup, forking the identity.
The plugin path never got the same treatment. **This design propagates an established
convention rather than inventing one.**

## The governing principle

**`unknown` fails toward "a backup might exist."**

Every consumer has exactly one dangerous action, and in all five cases it is the action
that assumes absence. One rule, applied consistently, rather than five ad-hoc
judgments.

## Non-goals

- **No detection of the blob's encoding.** Orthogonal to this change; see the #1064
  spec.
- **No retry/backoff logic in the plugin.** The probe answers once. Retrying is a user
  action (see the Check-again button) and staying explicit keeps the state machine
  honest.
- **No generalization into the shared E2EE plugin trait.** That trait
  (`listPeerIdentities`, `setIdentityTrust`) is about trust and identity. XEP-0373 §5
  secret-key backup has no OMEMO counterpart, so the probe stays OpenPGP-local.

## Design

### 1. Plugin API

`fetchSecretKeyBackup` adopts `secretKeyProbe`'s classification:

- `item-not-found` from the IQ → `null` (the server confirmed absence)
- any other failure → **throw**
- an item present but undecodable → **throw** (something *is* there; reporting absence
  would let a caller overwrite it)

Add a probe that never throws:

```ts
export type BackupProbeResult = 'present' | 'absent' | 'unknown'

async probeSecretKeyBackup(): Promise<BackupProbeResult>
```

Delete `hasSecretKeyBackup()`. It has two call sites plus `DemoOpenPGPPlugin`; keeping
a boolean alias would preserve the exact ambiguity this change removes.
`DemoOpenPGPPlugin.hasSecretKeyBackup` (`demo/DemoOpenPGPPlugin.ts:170`) becomes
`probeSecretKeyBackup`, returning `'present'` or `'absent'` from its existing
`state.hasBackup` flag. Demo mode has no failing transport, so it never returns
`'unknown'`.

The `item-not-found` classifier goes **inside `OpenPGPPluginBase.ts`**, not a new
shared module. On `features/omemo` this file lives at
`packages/openpgp-plugin/src/OpenPGPPluginBase.ts`; a new file under
`apps/fluux/src/e2ee/` would land in a directory that branch has deleted and would need
manual relocation on merge. A change inside a renamed file merges on its own.

`restoreSecretKey` maps a thrown fetch to a **transient** `E2EEPluginError`, not
`no-backup`. This is the fifth-consumer fix.

### 2. Component state becomes one exhaustive union

`EncryptionSettings.tsx` currently holds `remoteBackupExists: boolean | null`, where
`null` doubles as "not probed yet". Replace it:

```ts
type BackupProbeState = 'checking' | 'present' | 'absent' | 'unknown'
const [backupProbe, setBackupProbe] = useState<BackupProbeState>('checking')
```

`isBackupInSync` (extracted in #1067) takes the new type as its first parameter and
compares `=== 'present'`.

This is deliberate leverage: `=== true` and `=== false` on a string union are type
errors, so **the compiler enumerates every call site that needs attention**. No site
can be missed by grep failure.

### 3. Consumer behavior

| Consumer | On `unknown` | Why |
|---|---|---|
| Backup confirm | Show the confirmation, new `unknown` copy variant | The user is about to replace something we cannot rule out |
| Rotate | Route to the passphrase dialog, same as in-sync | Over-publishing a backup is benign; leaving a real one stale is not |
| Delete-key dialog | Offer the "also delete the server backup" checkbox | Lets the user clean up a copy we cannot confirm |
| Unlock dialog | `restore` mode, never `setup` | A wrong `restore` guess degrades to `NoRecoveryAvailableError`, which the dialog already handles. A wrong `setup` guess invites a forking key. The asymmetry is the whole argument |

The backup confirm gains a third variant beside `own` and `foreign`. Reusing `foreign`
would assert "this backup wasn't created from this device", which we do not know.

### 4. Status line and retry

The backup section's status line gains a fourth state. `unknown` renders in
`text-fluux-yellow` — the same token the existing mismatch line uses
(`EncryptionSettings.tsx:1129`), since both mean "attention, but nothing is broken" —
plus a **Check again** button that bumps the existing `backupProbeNonce`
(`EncryptionSettings.tsx:588`), already a dependency of the probe effect. Use `fluux-`
design tokens only: a test greps this file for raw Tailwind palette literals.

The retry is not optional polish. Without it, `unknown` is a dead end the user cannot
clear without restarting the app, and the confirmation would nag on every publish.

### 5. i18n

Five new keys under `settings.encryption`, translated across all 33 locales:

- `backupStatusUnknown` — "Couldn't check whether a backup exists on this server."
- `backupStatusRetry` — "Check again"
- `backupReplaceUnknownTitle` — "Replace the backup on this server?"
- `backupReplaceUnknownMessage` — "We couldn't check whether a backup already exists on
  this server. Publishing will replace it if there is one, and the passphrase saved for
  that backup will stop working. Your key itself is unchanged."
- `backupReplaceUnknownAction` — "Publish anyway"

No em-dash connectors.

### Error handling

The probe never throws, so no consumer needs a try/catch. The plugin logs the
classified failure at `debug` with the original error preserved, replacing today's
misleading "(treated as no backup)" wording.

## Testing

**Plugin** (`OpenPGPPluginBase`, both platform subclasses inherit):
- `item-not-found` IQ error → `'absent'`
- timeout / transport error → `'unknown'`
- populated node → `'present'`
- node resolves but the item is undecodable → `'unknown'` (not `'absent'`)
- `restoreSecretKey` on a transport failure raises a **transient** error, not
  `no-backup`

**`EncryptionSettings`:**
- `unknown` renders the status line and the Check-again button
- Check again re-runs the probe
- clicking Back up under `unknown` opens the `unknown` confirm variant, not `own` or
  `foreign`
- rotate under `unknown` opens the passphrase dialog
- the delete dialog receives `backupExists` true under `unknown`

**`UnlockEncryptionDialog`:**
- probe `unknown` selects `restore`, not `setup`

**Test-integrity requirement.** Per the hollow-test finding in #1064, every negative
assertion (`not.toHaveBeenCalled`, `queryBy*` → null) must be paired with a positive
control test in the same fixture that drives the same wire to completion. A negative
assertion is only meaningful once something has proven the positive is reachable. A
deliberate-break check is necessary but has already been shown insufficient on its own.

## Manual verification

Needs a server that can be made unreachable mid-session.

1. With a real backup on the server, block the connection (or point at a dead host),
   open Settings → Encryption, and confirm the status line reads "couldn't check" rather
   than "not backed up".
2. Click Back up. Confirm the `unknown` wording appears rather than publishing straight
   away.
3. Restore connectivity, click Check again, and confirm the line resolves to in-sync.
4. On web with no local key and the server unreachable, confirm the unlock dialog offers
   **restore**, not **setup**.
