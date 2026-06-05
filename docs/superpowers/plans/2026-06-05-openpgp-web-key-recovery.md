# OpenPGP Web Key Recovery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When the web unlock fails because the local key copy can't be decrypted, automatically recover the key from the server backup using the same passphrase — instead of dead-ending with "wrong passphrase."

**Architecture:** Orchestrate in `WebOpenPGPPlugin.unlock()`, reusing the existing base-class `restoreSecretKey()` recovery primitive. The plugin change alone fixes the bug (the existing dialog already calls `unlock()`); the dialog/settings/i18n tasks are UX polish on top. Web-only; desktop (Sequoia/keychain) is untouched.

**Tech Stack:** TypeScript, React, Zustand, openpgp.js v6, Vitest. Spec: `docs/superpowers/specs/2026-06-05-openpgp-web-key-recovery-design.md`.

**Working dir:** worktree `.claude/worktrees/feat+openpgp-web-key-recovery` (branch `worktree-feat+openpgp-web-key-recovery`).

**One-time setup before Task 1** (worktree was created without install):
```bash
npm install
npm run build:sdk
```
Baseline check (must be green before starting):
```bash
cd apps/fluux && npx vitest run src/e2ee/WebOpenPGPPlugin.test.ts
```
Expected: PASS.

---

## File Structure

- `apps/fluux/src/e2ee/recoveryErrors.ts` — **new.** Two app-layer error types (`KeyPickerRequiredError`, `NoRecoveryAvailableError`) the orchestrator throws and the dialog catches.
- `apps/fluux/src/e2ee/recoveryErrors.test.ts` — **new.** Unit tests for the error types.
- `apps/fluux/src/e2ee/WebOpenPGPPlugin.ts` — **modify.** De-mask the decrypt error (log real cause); rewrite `unlock()` into the try-local-then-recover orchestration; add `isRecoverableLocalFailure` / `classifyRecoveryFailure` helpers.
- `apps/fluux/src/e2ee/WebOpenPGPPlugin.test.ts` — **modify.** Add a writable-PEP test ctx helper + an `unlock — auto-recovery` describe block.
- `apps/fluux/src/components/UnlockEncryptionDialog.tsx` — **modify.** Three modes (unlock/restore/setup) from `hasNoLocalKey` × `hasSecretKeyBackup`; consume `{recovered}`; handle `KeyPickerRequiredError` / `NoRecoveryAvailableError`; keep the skip in every mode.
- `apps/fluux/src/components/settings-components/EncryptionSettings.tsx` — **modify.** Add a `locked` plugin status so the panel stops showing "Generating your key…" while the key is merely locked.
- `apps/fluux/src/i18n/locales/*.json` (33 files) — **modify.** New `settings.encryption.*` keys.
- `apps/fluux/src/i18n/i18n.test.ts` — unchanged; it enforces key parity across locales.

---

## Task 1: App-layer recovery error types

**Files:**
- Create: `apps/fluux/src/e2ee/recoveryErrors.ts`
- Test: `apps/fluux/src/e2ee/recoveryErrors.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// apps/fluux/src/e2ee/recoveryErrors.test.ts
import { describe, expect, it } from 'vitest'
import { KeyPickerRequiredError, NoRecoveryAvailableError } from './recoveryErrors'
import type { KeyBundle } from './OpenPGPPluginBase'

const bundle: KeyBundle = { fingerprint: 'a'.repeat(40), publicArmored: 'PUB', keychainBacked: false }

describe('recoveryErrors', () => {
  it('KeyPickerRequiredError carries candidates + backup context and a stable code', () => {
    const err = new KeyPickerRequiredError([bundle], { message: 'MSG', passphrase: 'PP' })
    expect(err).toBeInstanceOf(Error)
    expect(err.code).toBe('needs-picker')
    expect(err.candidates).toHaveLength(1)
    expect(err.backupContext).toEqual({ message: 'MSG', passphrase: 'PP' })
  })

  it('NoRecoveryAvailableError records whether a local key existed', () => {
    expect(new NoRecoveryAvailableError(true).hadLocalKey).toBe(true)
    expect(new NoRecoveryAvailableError(false).hadLocalKey).toBe(false)
    expect(new NoRecoveryAvailableError(true).code).toBe('no-recovery-available')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/fluux && npx vitest run src/e2ee/recoveryErrors.test.ts`
Expected: FAIL — `Cannot find module './recoveryErrors'`.

- [ ] **Step 3: Write minimal implementation**

```ts
// apps/fluux/src/e2ee/recoveryErrors.ts
/**
 * App-layer signals raised by WebOpenPGPPlugin.unlock()'s auto-recovery
 * path so the unlock dialog can react without parsing error messages.
 * Kept in the app (not the SDK): they carry UI-routing payloads and are
 * only consumed by the dialog.
 */
import type { KeyBundle } from './OpenPGPPluginBase'

/** Server backup holds more than one key — the UI must let the user pick. */
export class KeyPickerRequiredError extends Error {
  readonly code = 'needs-picker' as const
  constructor(
    readonly candidates: KeyBundle[],
    readonly backupContext: { message: string; passphrase: string },
  ) {
    super('Multiple keys found in backup; selection required')
    this.name = 'KeyPickerRequiredError'
  }
}

/** No server backup exists to recover from (with or without a local key). */
export class NoRecoveryAvailableError extends Error {
  readonly code = 'no-recovery-available' as const
  constructor(readonly hadLocalKey: boolean, cause?: unknown) {
    super(
      hadLocalKey
        ? 'The local key could not be decrypted and no server backup is available.'
        : 'No local key and no server backup is available.',
    )
    this.name = 'NoRecoveryAvailableError'
    if (cause !== undefined) (this as { cause?: unknown }).cause = cause
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/fluux && npx vitest run src/e2ee/recoveryErrors.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/fluux/src/e2ee/recoveryErrors.ts apps/fluux/src/e2ee/recoveryErrors.test.ts
git commit -m "feat(e2ee): add recovery error types for web unlock auto-recovery"
```

---

## Task 2: De-mask the local decrypt failure (log the real cause)

**Files:**
- Modify: `apps/fluux/src/e2ee/WebOpenPGPPlugin.ts` (the `decryptKey` catch in `ensureKeyMaterial`, ~lines 100-111)

The current catch throws a `wrong-passphrase` error with a hardcoded message and discards the real reason from the logs. Keep the `wrong-passphrase` **code** (existing tests + the orchestrator depend on it) but log the underlying cause so failures stop being silently relabeled.

- [ ] **Step 1: Apply the edit**

Find:
```ts
      try {
        const privateKey = await decryptKey({ privateKey: encryptedKey, passphrase })
        this.ownPrivateKey = privateKey
        return this.bundleFromKey(privateKey)
      } catch (err) {
        throw new E2EEPluginError(
          'permanent',
          'wrong-passphrase',
          'WebOpenPGPPlugin: could not decrypt stored private key — wrong passphrase',
          err,
        )
      }
```

Replace with:
```ts
      try {
        const privateKey = await decryptKey({ privateKey: encryptedKey, passphrase })
        this.ownPrivateKey = privateKey
        return this.bundleFromKey(privateKey)
      } catch (err) {
        // Do NOT swallow the real reason: the message is almost always a
        // genuine wrong passphrase, but it can also be a corrupt/foreign
        // blob. Log the underlying cause and keep it on the error chain so
        // unlock()'s recovery path and any future diagnosis can see it.
        this.requireCtx().logger.warn(
          `WebOpenPGPPlugin: stored private key did not decrypt: ${
            err instanceof Error ? err.message : String(err)
          }`,
        )
        throw new E2EEPluginError(
          'permanent',
          'wrong-passphrase',
          'WebOpenPGPPlugin: could not decrypt stored private key — wrong passphrase',
          err,
        )
      }
```

- [ ] **Step 2: Run the existing suite to verify no regression**

Run: `cd apps/fluux && npx vitest run src/e2ee/WebOpenPGPPlugin.test.ts`
Expected: PASS (the `rejects a wrong passphrase with wrong-passphrase code` test still passes; the code is unchanged).

- [ ] **Step 3: Commit**

```bash
git add apps/fluux/src/e2ee/WebOpenPGPPlugin.ts
git commit -m "fix(e2ee): log real cause when stored key fails to decrypt"
```

---

## Task 3: `unlock()` auto-recovery orchestration (the core fix)

**Files:**
- Modify: `apps/fluux/src/e2ee/WebOpenPGPPlugin.ts` (rewrite `unlock`, ~lines 534-546; add helpers + imports)
- Modify: `apps/fluux/src/e2ee/WebOpenPGPPlugin.test.ts` (add writable-PEP ctx helper + `unlock — auto-recovery` describe)

- [ ] **Step 1: Write the failing tests**

Add this helper near the other `makeCtx*` helpers (after `makeCtxWithSharedPep`, ~line 193). It is a shared-PEP ctx whose `publishPEP`/`retractPEP`/`deletePEP` actually mutate the map, so `backupSecretKey` publishes a real, fetchable backup:

```ts
function makeCtxWithWritablePep(
  accountJid: string,
  shared: SharedPep,
  sharedBackend?: InMemoryStorageBackend,
): { ctx: PluginContext; backend: InMemoryStorageBackend } {
  const backend = sharedBackend ?? new InMemoryStorageBackend()
  const xmpp: XMPPPrimitives = {
    sendStanza: async () => {},
    queryDisco: async () => ({
      features: [
        { var: 'http://jabber.org/protocol/pubsub' },
        { var: 'http://jabber.org/protocol/pubsub#publish-options' },
      ],
      identities: [{ category: 'pubsub', type: 'pep' }],
    }),
    publishPEP: async (node, item) => {
      shared.set(pepKey(accountJid, node), [{ id: item.id, payload: item.payload }])
    },
    retractPEP: async (node) => { shared.delete(pepKey(accountJid, node)) },
    deletePEP: async (node) => { shared.delete(pepKey(accountJid, node)) },
    queryPEP: async (jid, node): Promise<PEPItem[]> => shared.get(pepKey(jid, node)) ?? [],
    subscribePEP: () => ({ unsubscribe: () => {} }),
  }
  const ctx: PluginContext = {
    storage: createPluginStorage(backend, 'openpgp-test'),
    xmpp,
    logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
    account: { jid: accountJid },
    reportSecurityContextUpdate: () => {},
  }
  return { ctx, backend }
}
```

Then add a new describe block at the end of the top-level `describe('WebOpenPGPPlugin', ...)` (before its closing `})`):

```ts
  describe('unlock — auto-recovery from server backup', () => {
    const PP = 'current-backup-passphrase-123'

    it('returns recovered:false on a normal local unlock', async () => {
      const backend = new InMemoryStorageBackend()
      const setup = new WebOpenPGPPlugin()
      setSessionPassphrase(PP)
      await setup.init(makeCtx('alice@example.com', backend).ctx)
      const fp = setup.getOwnFingerprint()

      clearSessionPassphrase()
      const fresh = new WebOpenPGPPlugin()
      await fresh.init(makeCtx('alice@example.com', backend).ctx)
      const result = await fresh.unlock(PP)

      expect(result).toEqual({ recovered: false })
      expect(fresh.getOwnFingerprint()).toBe(fp)
    })

    it('recovers a stale local key from the server backup (rotated passphrase)', async () => {
      // Source device: key K stored locally under the OLD passphrase, and a
      // server backup published under the NEW (current) passphrase.
      const shared: SharedPep = new Map()
      const sourceBackend = new InMemoryStorageBackend()
      setSessionPassphrase('old-local-passphrase')
      const source = new TestableWebOpenPGPPlugin()
      await source.init(makeCtxWithWritablePep('alice@example.com', shared, sourceBackend).ctx)
      const original = await source.callEnsureKeyMaterial('alice@example.com')
      await source.backupSecretKey(PP) // publishes the backup under the NEW passphrase

      // Fresh device reuses the same backend → local blob is K-under-OLD.
      clearSessionPassphrase()
      const device = new WebOpenPGPPlugin()
      await device.init(makeCtxWithWritablePep('alice@example.com', shared, sourceBackend).ctx)
      expect(device.getOwnFingerprint()).toBeNull() // locked

      const result = await device.unlock(PP) // NEW passphrase fails locally, opens the backup

      expect(result).toEqual({ recovered: true })
      expect(device.getOwnFingerprint()).toBe(original.fingerprint)
    })

    it('recovers when there is no local key but a server backup exists', async () => {
      const shared: SharedPep = new Map()
      setSessionPassphrase('source-session-pp')
      const source = new TestableWebOpenPGPPlugin()
      await source.init(makeCtxWithWritablePep('alice@example.com', shared).ctx)
      const original = await source.callEnsureKeyMaterial('alice@example.com')
      await source.backupSecretKey(PP)

      clearSessionPassphrase()
      const device = new WebOpenPGPPlugin() // empty backend
      await device.init(makeCtxWithWritablePep('alice@example.com', shared).ctx)

      const result = await device.unlock(PP)

      expect(result).toEqual({ recovered: true })
      expect(device.getOwnFingerprint()).toBe(original.fingerprint)
    })

    it('throws NoRecoveryAvailableError when local is stale and there is no backup', async () => {
      const backend = new InMemoryStorageBackend()
      const setup = new WebOpenPGPPlugin()
      setSessionPassphrase('real-passphrase')
      await setup.init(makeCtx('alice@example.com', backend).ctx)

      clearSessionPassphrase()
      const device = new WebOpenPGPPlugin()
      await device.init(makeCtx('alice@example.com', backend).ctx)

      const { NoRecoveryAvailableError } = await import('./recoveryErrors')
      await expect(device.unlock('wrong-and-no-backup')).rejects.toBeInstanceOf(
        NoRecoveryAvailableError,
      )
      const { isKeyLocked } = await import('./webPassphraseStore')
      expect(isKeyLocked()).toBe(true) // rolled back
    })

    it('throws wrong-passphrase when neither local nor backup decrypt', async () => {
      const shared: SharedPep = new Map()
      const backend = new InMemoryStorageBackend()
      setSessionPassphrase('local-pp')
      const source = new TestableWebOpenPGPPlugin()
      await source.init(makeCtxWithWritablePep('alice@example.com', shared, backend).ctx)
      await source.callEnsureKeyMaterial('alice@example.com')
      await source.backupSecretKey('backup-pp')

      clearSessionPassphrase()
      const device = new WebOpenPGPPlugin()
      await device.init(makeCtxWithWritablePep('alice@example.com', shared, backend).ctx)

      await expect(device.unlock('neither-of-them')).rejects.toMatchObject({
        code: 'wrong-passphrase',
      })
    })
  })
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd apps/fluux && npx vitest run src/e2ee/WebOpenPGPPlugin.test.ts -t "auto-recovery"`
Expected: FAIL — `unlock` returns `undefined` (not `{recovered}`), and the stale/no-local cases reject with `wrong-passphrase`/`needs-identity-decision` instead of recovering.

- [ ] **Step 3: Implement the orchestration**

In `apps/fluux/src/e2ee/WebOpenPGPPlugin.ts`, update the imports at the top:

```ts
import { E2EEPluginError, isE2EEPluginError } from '@fluux/sdk'
import {
  OpenPGPPluginBase,
  type CertValidation,
  type DecryptOutput,
  type KeyBundle,
  type RestoreResult,
} from './OpenPGPPluginBase'
import { KeyPickerRequiredError, NoRecoveryAvailableError } from './recoveryErrors'
```

Add these module-level helpers near the top of the file (after the imports, before the class):

```ts
/**
 * A local-key failure that the server backup might fix: the stored blob
 * won't decrypt with this passphrase, or there's no local blob but the
 * server advertises an identity. Both are worth a backup-recovery attempt.
 */
function isRecoverableLocalFailure(err: unknown): boolean {
  return (
    isE2EEPluginError(err) &&
    (err.code === 'wrong-passphrase' || err.code === 'needs-identity-decision')
  )
}

/** Decide the final error after BOTH the local key and the backup failed. */
function classifyRecoveryFailure(localErr: unknown, recoverErr: unknown): Error {
  const localCode = isE2EEPluginError(localErr) ? localErr.code : undefined
  const recoverCode = isE2EEPluginError(recoverErr) ? recoverErr.code : undefined
  if (recoverCode === 'no-backup') {
    // No secret backup to recover from. When the local failure was a
    // published-identity-without-backup, preserve that error so the host's
    // existing IdentityChoiceDialog routing (import file / retire) applies.
    if (localCode === 'needs-identity-decision') {
      return localErr instanceof Error ? localErr : new Error(String(localErr))
    }
    return new NoRecoveryAvailableError(localCode === 'wrong-passphrase', recoverErr)
  }
  if (recoverCode === 'wrong-passphrase') {
    return new E2EEPluginError(
      'permanent',
      'wrong-passphrase',
      'WebOpenPGPPlugin: wrong passphrase — neither the local key nor the server backup could be decrypted',
      recoverErr,
    )
  }
  // Transient (server unreachable, etc.) — surface as-is so the user retries.
  return recoverErr instanceof Error ? recoverErr : new Error(String(recoverErr))
}
```

Replace the existing `unlock` method:

```ts
  async unlock(passphrase: string): Promise<void> {
    setSessionPassphrase(passphrase)
    try {
      // Re-run ensureIdentity to decrypt the key and re-publish if needed.
      await this.ensureIdentity()
      // Activate PEP and store subscriptions now that the key is loaded.
      this.activateSubscriptions()
    } catch (err) {
      // Roll back passphrase on failure so the locked state is preserved.
      clearSessionPassphrase()
      throw err
    }
  }
```

with:

```ts
  async unlock(passphrase: string): Promise<{ recovered: boolean }> {
    setSessionPassphrase(passphrase)
    try {
      // Happy path: decrypt the local key and publish/subscribe.
      await this.ensureIdentity()
      this.activateSubscriptions()
      return { recovered: false }
    } catch (err) {
      if (!isRecoverableLocalFailure(err)) {
        clearSessionPassphrase()
        throw err
      }
      // The local copy is missing or won't open with this passphrase. The
      // key is recoverable from the server backup if the passphrase is the
      // current one — try that before giving up.
      let result: RestoreResult
      try {
        result = await this.restoreSecretKey(passphrase)
      } catch (recoverErr) {
        clearSessionPassphrase()
        throw classifyRecoveryFailure(err, recoverErr)
      }
      if ('needsPicker' in result) {
        clearSessionPassphrase()
        throw new KeyPickerRequiredError(result.candidates, result.backupContext)
      }
      // restoreSecretKey installed + published the recovered key and set the
      // session passphrase. Activate subscriptions and report recovery.
      this.activateSubscriptions()
      return { recovered: true }
    }
  }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd apps/fluux && npx vitest run src/e2ee/WebOpenPGPPlugin.test.ts`
Expected: PASS — the new `auto-recovery` block (5 tests) plus all pre-existing tests, including `unlock › clears the session passphrase on a wrong-passphrase unlock` (now a stale-local + no-backup path → still rejects + rolls back).

- [ ] **Step 5: Typecheck**

Run: `npm run typecheck`
Expected: PASS — `unlock`'s new return type is only consumed by the dialog (Task 4) and the debug API, which ignore it today.

- [ ] **Step 6: Commit**

```bash
git add apps/fluux/src/e2ee/WebOpenPGPPlugin.ts apps/fluux/src/e2ee/WebOpenPGPPlugin.test.ts
git commit -m "feat(e2ee): auto-recover web key from server backup on unlock failure"
```

> **Checkpoint:** the bug is now functionally fixed. The existing `UnlockEncryptionDialog` calls `plugin.unlock(passphrase)` and ignores the return, so stale-blob and no-local-key-with-backup cases already auto-recover. Tasks 4–6 are UX polish.

---

## Task 4: Unlock dialog — three modes, recovered note, recovery edges

**Files:**
- Modify: `apps/fluux/src/components/UnlockEncryptionDialog.tsx`

This replaces the two-state `isFirstTime` with a three-mode model and consumes the new `unlock` outcome. Keep the **skip** button in every mode (opt-in invariant).

- [ ] **Step 1: Add imports and mode state**

At the top, add imports:
```ts
import { KeyPickerDialog } from './KeyPickerDialog'
import { KeyPickerRequiredError, NoRecoveryAvailableError } from '@/e2ee/recoveryErrors'
import type { KeyBundle } from '@/e2ee/OpenPGPPluginBase'
```

Replace the `isFirstTime` state with mode + recovery state:
```ts
  type DialogMode = 'unlock' | 'restore' | 'setup'
  const [mode, setMode] = useState<DialogMode | null>(null)
  const [recovered, setRecovered] = useState(false)
  const [noRecovery, setNoRecovery] = useState<{ hadLocalKey: boolean } | null>(null)
  const [picker, setPicker] = useState<{
    candidates: KeyBundle[]
    backupContext: { message: string; passphrase: string }
  } | null>(null)
```

- [ ] **Step 2: Resolve the mode (local key? backup?)**

Replace the `useEffect` that sets `isFirstTime` with:
```ts
  useEffect(() => {
    const plugin = client.e2ee?.getPlugin('openpgp') as
      | { hasNoLocalKey?: () => Promise<boolean>; hasSecretKeyBackup?: () => Promise<boolean> }
      | null
      | undefined
    if (!plugin?.hasNoLocalKey) {
      setMode('unlock')
      return
    }
    let cancelled = false
    void (async () => {
      try {
        const noLocal = await plugin.hasNoLocalKey!()
        if (!noLocal) {
          if (!cancelled) setMode('unlock')
          return
        }
        const hasBackup = plugin.hasSecretKeyBackup ? await plugin.hasSecretKeyBackup() : false
        if (!cancelled) setMode(hasBackup ? 'restore' : 'setup')
      } catch {
        if (!cancelled) setMode('unlock')
      }
    })()
    return () => {
      cancelled = true
    }
  }, [client])
```

Update the focus effect dependency from `[isFirstTime]` to `[mode]`.

- [ ] **Step 3: Rewrite `handleConfirm` to consume the outcome**

```ts
  const handleConfirm = useCallback(async () => {
    if (!passphrase.trim()) return
    if (passphrase.length < 8) {
      setError(t('settings.encryption.unlockPassphraseTooShort'))
      return
    }
    if (mode === 'setup' && passphrase !== confirmPassphrase) {
      setError(t('settings.encryption.unlockPassphraseMismatch'))
      return
    }

    setIsWorking(true)
    setError(null)
    try {
      const plugin = client.e2ee?.getPlugin('openpgp') as
        | { unlock?: (pp: string) => Promise<{ recovered: boolean }> }
        | null
        | undefined
      if (!plugin?.unlock) {
        throw new Error(t('settings.encryption.backupPluginUnavailable'))
      }
      const result = await plugin.unlock(passphrase)
      client.notifyE2EEKeyUnlocked()
      if (result?.recovered) {
        // Tell the user re-provisioning happened, then close.
        setRecovered(true)
        setTimeout(() => onClose(true), 1500)
        return
      }
      onClose(true)
    } catch (err) {
      if (err instanceof KeyPickerRequiredError) {
        setPicker({ candidates: err.candidates, backupContext: err.backupContext })
        setIsWorking(false)
        return
      }
      if (err instanceof NoRecoveryAvailableError) {
        setNoRecovery({ hadLocalKey: err.hadLocalKey })
        setIsWorking(false)
        return
      }
      setError(err instanceof Error ? err.message : String(err))
      setIsWorking(false)
    }
  }, [passphrase, confirmPassphrase, mode, client, onClose, t])
```

- [ ] **Step 4: Derive title/body/action from mode + render edges**

Replace the `title`/`body`/`confirmLabel`/`loading` derivation:
```ts
  const title =
    mode === 'setup'
      ? t('settings.encryption.unlockDialogSetupTitle')
      : mode === 'restore'
        ? t('settings.encryption.unlockDialogRestoreTitle')
        : t('settings.encryption.unlockDialogTitle')

  const body =
    mode === 'setup'
      ? t('settings.encryption.unlockDialogSetupBody')
      : mode === 'restore'
        ? t('settings.encryption.unlockDialogRestoreBody')
        : t('settings.encryption.unlockDialogBody')

  const confirmLabel =
    mode === 'setup'
      ? t('settings.encryption.unlockSetupAction')
      : mode === 'restore'
        ? t('settings.encryption.restoreAction')
        : t('settings.encryption.unlockAction')

  const loading = mode === null
```

Change the confirm-field render condition from `isFirstTime &&` to `mode === 'setup' &&` so only Setup shows the confirm input.

Add, just above the existing `{error && (...)}` block, a recovered note, a no-recovery affordance, and the picker mount:
```ts
          {recovered && (
            <p className="text-xs text-green-600 dark:text-green-400 mb-3">
              {t('settings.encryption.unlockRecoveredNote')}
            </p>
          )}
          {noRecovery && (
            <div className="mb-3 space-y-2">
              <p className="text-xs text-fluux-text">
                {noRecovery.hadLocalKey
                  ? t('settings.encryption.unlockNoRecoveryBody')
                  : t('settings.encryption.unlockNoKeyNoBackupBody')}
              </p>
              <button
                type="button"
                onClick={() => { void handleImportKeyFile() }}
                className="px-3 py-1.5 text-sm bg-fluux-hover hover:bg-fluux-active text-fluux-text rounded transition-colors"
              >
                {t('settings.encryption.importFileAction')}
              </button>
            </div>
          )}
```

And render the picker near the end of the component (just before the final closing `</div>` of the modal root):
```ts
      {picker && (
        <KeyPickerDialog
          candidates={picker.candidates}
          onConfirm={async (selectedFingerprint) => {
            const plugin = client.e2ee?.getPlugin('openpgp') as
              | { installSelectedKey?: (msg: string, pp: string, fp: string) => Promise<{ fingerprint: string }> }
              | null
              | undefined
            if (!plugin?.installSelectedKey) return
            await plugin.installSelectedKey(
              picker.backupContext.message,
              picker.backupContext.passphrase,
              selectedFingerprint,
            )
            setPicker(null)
            client.notifyE2EEKeyUnlocked()
            onClose(true)
          }}
          onCancel={() => setPicker(null)}
        />
      )}
```

Add the file-import handler (used by the no-recovery affordance) alongside `handleConfirm`:
```ts
  const handleImportKeyFile = useCallback(async () => {
    const plugin = client.e2ee?.getPlugin('openpgp') as
      | {
          pickKeyFile?: () => Promise<string | null>
          importKeyFromFile?: (armored: string, pp: string) => Promise<
            | { fingerprint: string }
            | { needsPicker: true; candidates: KeyBundle[]; backupContext: { message: string; passphrase: string } }
          >
        }
      | null
      | undefined
    if (!plugin?.pickKeyFile || !plugin.importKeyFromFile) return
    const content = await plugin.pickKeyFile()
    if (!content) return
    try {
      const result = await plugin.importKeyFromFile(content, passphrase)
      if ('needsPicker' in result) {
        setPicker({ candidates: result.candidates, backupContext: result.backupContext })
        setNoRecovery(null)
        return
      }
      client.notifyE2EEKeyUnlocked()
      onClose(true)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }, [client, passphrase, onClose])
```

- [ ] **Step 5: Verify build + types + existing app tests**

Run: `npm run typecheck`
Expected: PASS.

Run: `cd apps/fluux && npx vitest run`
Expected: PASS (no test imports the removed `isFirstTime`; if a dialog test references it, update it to `mode`).

- [ ] **Step 6: Manual verification (demo or web)**

Run the web app, enable encryption, and confirm in a returning-browser locked state the dialog still shows the **Skip — send without encryption** button. (Full recovery is covered by the Task 3 unit tests; this step only confirms the skip invariant and that the dialog renders in each mode.)

- [ ] **Step 7: Commit**

```bash
git add apps/fluux/src/components/UnlockEncryptionDialog.tsx
git commit -m "feat(e2ee): unlock dialog modes + auto-recovery feedback"
```

---

## Task 5: Settings status — stop showing "Generating" while merely locked

**Files:**
- Modify: `apps/fluux/src/components/settings-components/EncryptionSettings.tsx`

- [ ] **Step 1: Add a `locked` status to the union and derivation**

Change the `PluginStatus` type (~line 26) to add `'locked'`:
```ts
type PluginStatus =
  | 'disabled'
  | 'locked'
  | 'generating'
  | 'ready'
  | 'waiting-online'
  | 'generation-failed'
```

Update the `pluginStatus` derivation (~lines 119-127) so a web-locked key reads as `locked`, not `generating`:
```ts
  const pluginStatus: PluginStatus = !openpgpEnabled
    ? 'disabled'
    : !online
      ? 'waiting-online'
      : fingerprint
        ? 'ready'
        : webLocked
          ? 'locked'
          : generationFailed
            ? 'generation-failed'
            : 'generating'
```

- [ ] **Step 2: Render the locked status string**

In the status block (~lines 842-849), add a branch:
```ts
                {pluginStatus === 'locked' &&
                  t('settings.encryption.statusLocked')}
```

- [ ] **Step 3: Verify**

Run: `npm run typecheck`
Expected: PASS.

Manual: with encryption enabled and the key locked, the status now reads "Locked — enter your passphrase to unlock." instead of "Generating your key…". (The existing `webLocked` banner already offers the Unlock button.)

- [ ] **Step 4: Commit**

```bash
git add apps/fluux/src/components/settings-components/EncryptionSettings.tsx
git commit -m "fix(e2ee): show locked status instead of 'generating' when key is locked"
```

---

## Task 6: i18n keys (all 33 locales)

**Files:**
- Modify: `apps/fluux/src/i18n/locales/*.json` (33 files)

New keys under `settings.encryption`:

| Key | English (en.json) | French (fr.json) |
|-----|-------------------|------------------|
| `unlockDialogRestoreTitle` | `Restore End-to-End Encryption` | `Restaurer le chiffrement de bout en bout` |
| `unlockDialogRestoreBody` | `Enter your existing passphrase to restore your key on this device from your server backup.` | `Saisissez votre phrase de passe existante pour restaurer votre clé sur cet appareil depuis votre sauvegarde serveur.` |
| `unlockRecoveredNote` | `Key restored from your server backup.` | `Clé restaurée depuis votre sauvegarde serveur.` |
| `unlockNoRecoveryBody` | `That passphrase didn't unlock your key, and no server backup was found to recover from. You can import your key from a file.` | `Cette phrase de passe n'a pas déverrouillé votre clé, et aucune sauvegarde serveur n'a été trouvée. Vous pouvez importer votre clé depuis un fichier.` |
| `unlockNoKeyNoBackupBody` | `No key is stored on this device and no server backup was found. You can import your key from a file.` | `Aucune clé n'est stockée sur cet appareil et aucune sauvegarde serveur n'a été trouvée. Vous pouvez importer votre clé depuis un fichier.` |
| `statusLocked` | `Locked — enter your passphrase to unlock.` | `Verrouillé — saisissez votre phrase de passe pour déverrouiller.` |

- [ ] **Step 1: Add the six keys with real `en` and `fr` values**

Edit `apps/fluux/src/i18n/locales/en.json` and `apps/fluux/src/i18n/locales/fr.json`, adding the six keys above inside the existing `settings.encryption` object (place them next to `unlockDialogSetupBody` / `statusReady`).

- [ ] **Step 2: Add the keys to the remaining 31 locales**

For every other file in `apps/fluux/src/i18n/locales/` (ar, be, bg, ca, cs, da, de, el, es, et, fi, ga, he, hr, hu, is, it, lt, lv, mt, nb, nl, pl, pt, ro, ru, sk, sl, sv, uk, zh-CN), add the same six keys under `settings.encryption` with a **genuine translation** for that language (project rule: real translations, not placeholders — see `feedback_i18n_real_translations`). Mirror the tone of the existing nearby `unlock*` / `status*` strings in each file.

- [ ] **Step 3: Run the i18n parity test**

Run: `cd apps/fluux && npx vitest run src/i18n/i18n.test.ts`
Expected: PASS — every locale has all keys; no missing-key failures.

- [ ] **Step 4: Commit**

```bash
git add apps/fluux/src/i18n/locales/
git commit -m "i18n: add web key recovery strings (restore mode, recovered note, locked status)"
```

---

## Final verification

- [ ] **Full suite + typecheck + lint**

```bash
npm run typecheck
cd apps/fluux && npx vitest run
cd ../.. && npm run lint
```
Expected: all green, no stderr.

- [ ] **Confirm the opt-in invariant by inspection**

Grep that nothing new sets the toggle and the skip survives:
```bash
rg -n "setOpenpgpEnabled\(true\)" apps/fluux/src   # only the Settings toggle handler
rg -n "unlockSkip" apps/fluux/src/components/UnlockEncryptionDialog.tsx   # skip still rendered
```

---

## Self-Review (completed by plan author)

- **Spec coverage:** §1 plugin orchestration → Tasks 1–3; §2 dialog three modes + failure handling → Task 4; §3 status → Task 5; §4 error model (de-mask + typed errors) → Tasks 1–3; i18n → Task 6; opt-in invariant → enforced in Task 4 (skip retained) + Final verification grep. All covered.
- **Placeholders:** none — every code step shows the code; i18n provides real en/fr and an explicit per-locale translation instruction (33 named files).
- **Type consistency:** `unlock` returns `{ recovered: boolean }` (Task 3) and is consumed as such (Task 4); `KeyPickerRequiredError`/`NoRecoveryAvailableError` defined in Task 1 and imported by the plugin (Task 3) and dialog (Task 4); `RestoreResult`/`KeyBundle` imported from `OpenPGPPluginBase`; `DialogMode` used consistently in Task 4; `PluginStatus` gains `'locked'` and the matching `statusLocked` key exists in Task 6.
