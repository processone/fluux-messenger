# Import GnuPG-Exported Private Key Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extend the "Import from file" flow in `WebOpenPGPPlugin` so it accepts a raw armored OpenPGP private key block (the output of `gpg --export-secret-keys --armor`) in addition to the current Fluux/Sequoia backup format (an SKESK-wrapped OpenPGP MESSAGE). Format is detected from the armor header; the rest of the install pipeline is unchanged.

**Architecture:** A small pure helper `detectArmorKind()` inspects the armor preamble. `WebOpenPGPPlugin.backupImportAll()` branches on the result: either decrypt the SKESK wrapper (existing path), or parse the armored TSK directly and call `decryptKey()` on each contained `PrivateKey` (new path). Both paths converge on a `PrivateKey[]` stored in `pendingImportKeys`, so `selectKeyFromBackup` / `backupImportSelected` need no changes. A pre-validation step rejects keys lacking a usable encryption subkey (catches DSA/ElGamal-only keys early instead of failing later in `encryptToRecipient`).

**Tech Stack:** TypeScript, `openpgp` v6.x (already a dep of `apps/fluux`), Vitest (`node` environment for openpgp.js compatibility), i18next for the 33-locale string updates. **Out of scope for this plan:** Sequoia/Rust (`SequoiaPgpPlugin` + `openpgp_backup.rs`) parity — tracked as a follow-up since the desktop file picker can reach the same Rust IPC and a parallel `decrypt_raw_tsk_with_passphrase` is straightforward but mechanically distinct.

---

## File Structure

**New files:**
- `apps/fluux/src/e2ee/armorDetect.ts` — pure helper, no openpgp.js dependency
- `apps/fluux/src/e2ee/armorDetect.test.ts` — unit tests for the helper

**Modified files:**
- `apps/fluux/src/e2ee/WebOpenPGPPlugin.ts` — extract existing decrypt path into a helper, add raw-TSK path, branch in `backupImportAll`, pre-validate imported keys
- `apps/fluux/src/e2ee/WebOpenPGPPlugin.test.ts` — add coverage for the new path and error cases
- `apps/fluux/src/components/settings-components/EncryptionSettings.tsx` — update import dialog body text
- `apps/fluux/src/i18n/locales/*.json` — 33 locale files: update existing key `settings.encryption.importFileDialogBody`, add new key `settings.encryption.unsupportedKeyAlgorithm`

---

## Task 1: Pure armor-format detector

**Files:**
- Create: `apps/fluux/src/e2ee/armorDetect.ts`
- Create: `apps/fluux/src/e2ee/armorDetect.test.ts`

- [ ] **Step 1: Write the failing test**

Write `apps/fluux/src/e2ee/armorDetect.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { detectArmorKind } from './armorDetect'

describe('detectArmorKind', () => {
  it('detects a Fluux backup (PGP MESSAGE)', () => {
    const armored = `-----BEGIN PGP MESSAGE-----\nVersion: OpenPGP.js\n\nwcDM...\n-----END PGP MESSAGE-----\n`
    expect(detectArmorKind(armored)).toBe('message')
  })

  it('detects a raw private key block (gpg --export-secret-keys)', () => {
    const armored = `-----BEGIN PGP PRIVATE KEY BLOCK-----\nVersion: GnuPG v2\n\nlQOY...\n-----END PGP PRIVATE KEY BLOCK-----\n`
    expect(detectArmorKind(armored)).toBe('private-key')
  })

  it('tolerates leading whitespace and BOM', () => {
    const armored = `﻿\n   \n-----BEGIN PGP PRIVATE KEY BLOCK-----\n\nlQOY...\n-----END PGP PRIVATE KEY BLOCK-----\n`
    expect(detectArmorKind(armored)).toBe('private-key')
  })

  it('returns "unknown" for a public-key block', () => {
    const armored = `-----BEGIN PGP PUBLIC KEY BLOCK-----\n\nmQGN...\n-----END PGP PUBLIC KEY BLOCK-----\n`
    expect(detectArmorKind(armored)).toBe('unknown')
  })

  it('returns "unknown" for empty input', () => {
    expect(detectArmorKind('')).toBe('unknown')
  })

  it('returns "unknown" for garbage', () => {
    expect(detectArmorKind('this is not an armored block')).toBe('unknown')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/fluux && npx vitest run src/e2ee/armorDetect.test.ts`
Expected: FAIL — `Failed to load url ./armorDetect` (module not found).

- [ ] **Step 3: Write the helper**

Write `apps/fluux/src/e2ee/armorDetect.ts`:

```ts
/**
 * Identify what an ASCII-armored OpenPGP blob contains, based on its
 * armor preamble. Used by the import flow to route either to the
 * passphrase-wrapped Fluux backup decoder or to the raw transferable
 * secret key decoder.
 *
 * The check is intentionally lenient: it tolerates a BOM and leading
 * whitespace/blank lines, since text-mode file readers occasionally
 * prepend them. It does NOT parse the body — that's the caller's job.
 */
export type ArmorKind = 'message' | 'private-key' | 'unknown'

const MESSAGE_HEADER = '-----BEGIN PGP MESSAGE-----'
const PRIVATE_KEY_HEADER = '-----BEGIN PGP PRIVATE KEY BLOCK-----'

export function detectArmorKind(armored: string): ArmorKind {
  if (!armored) return 'unknown'
  const trimmed = armored.replace(/^﻿/, '').trimStart()
  if (trimmed.startsWith(MESSAGE_HEADER)) return 'message'
  if (trimmed.startsWith(PRIVATE_KEY_HEADER)) return 'private-key'
  return 'unknown'
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/fluux && npx vitest run src/e2ee/armorDetect.test.ts`
Expected: PASS, 6 tests green.

- [ ] **Step 5: Commit**

```bash
git add apps/fluux/src/e2ee/armorDetect.ts apps/fluux/src/e2ee/armorDetect.test.ts
git commit -m "feat(e2ee): add armor-kind detector for OpenPGP import routing"
```

---

## Task 2: Extract the existing backup-message decryption into a helper

This is a pure refactor so Task 3 can add a sibling helper without entangling the two paths. No behavior change.

**Files:**
- Modify: `apps/fluux/src/e2ee/WebOpenPGPPlugin.ts:269-314` (the `backupImportAll` method)

- [ ] **Step 1: Confirm existing tests pass before refactor**

Run: `cd apps/fluux && npx vitest run src/e2ee/WebOpenPGPPlugin.test.ts`
Expected: PASS. Note the green count — Task 3 will keep this number unchanged.

- [ ] **Step 2: Extract `decryptBackupMessage` helper inside the class**

In `apps/fluux/src/e2ee/WebOpenPGPPlugin.ts`, find the existing `backupImportAll` (around line 269) and replace it with the refactored version below. Move the SKESK decryption logic into a new private method `decryptBackupMessage`:

```ts
  /**
   * Decrypt a Fluux/Sequoia backup container (an OpenPGP MESSAGE wrapping
   * a binary TSK under a passphrase-derived SKESK) and return the
   * decrypted PrivateKey objects found inside.
   *
   * Wrong-passphrase failures are translated to E2EEPluginError; parse
   * failures propagate so the caller can decide whether to retry with a
   * different format.
   */
  private async decryptBackupMessage(
    backupMessage: string,
    passphrase: string,
  ): Promise<PrivateKey[]> {
    const { readMessage, decrypt, readPrivateKeys } = await import('openpgp')

    const message = await readMessage({ armoredMessage: backupMessage })
    let tskBytes: Uint8Array
    try {
      const { data } = await decrypt({
        message,
        passwords: [normalizeBackupPassphrase(passphrase)],
        format: 'binary',
      })
      tskBytes = data as Uint8Array
    } catch (err) {
      throw new E2EEPluginError(
        'permanent',
        'wrong-passphrase',
        'WebOpenPGPPlugin: backup decryption failed — wrong passphrase',
        err,
      )
    }

    try {
      return await readPrivateKeys({ binaryKeys: tskBytes })
    } catch {
      return await readPrivateKeys({
        armoredKeys: new TextDecoder().decode(tskBytes),
      })
    }
  }

  protected async backupImportAll(
    _accountJid: string,
    backupMessage: string,
    passphrase: string,
  ): Promise<KeyBundle[]> {
    const keys = await this.decryptBackupMessage(backupMessage, passphrase)

    this.pendingImportKeys.clear()
    for (const key of keys) {
      this.pendingImportKeys.set(key.getFingerprint(), key)
    }

    return keys.map((k) => ({
      fingerprint: k.getFingerprint(),
      publicArmored: k.toPublic().armor(),
      keychainBacked: false,
      createdAt: k.getCreationTime().toISOString(),
    }))
  }
```

- [ ] **Step 3: Run all WebOpenPGPPlugin tests**

Run: `cd apps/fluux && npx vitest run src/e2ee/WebOpenPGPPlugin.test.ts`
Expected: PASS — same number of green tests as Step 1.

- [ ] **Step 4: Commit**

```bash
git add apps/fluux/src/e2ee/WebOpenPGPPlugin.ts
git commit -m "refactor(e2ee): extract decryptBackupMessage helper from backupImportAll"
```

---

## Task 3: Add the raw-private-key-block decryption helper + branch

**Files:**
- Modify: `apps/fluux/src/e2ee/WebOpenPGPPlugin.ts` (add helper, update `backupImportAll` to branch)
- Modify: `apps/fluux/src/e2ee/WebOpenPGPPlugin.test.ts` (add happy-path test)

- [ ] **Step 1: Write the failing test**

In `apps/fluux/src/e2ee/WebOpenPGPPlugin.test.ts`, after the existing `backupImportAll` tests, add:

```ts
  it('imports a raw armored TSK (gpg --export-secret-keys --armor)', async () => {
    // Generate a fresh key and serialize it as a raw armored
    // PRIVATE KEY BLOCK — exactly what `gpg --export-secret-keys --armor`
    // produces. The key is encrypted with a user passphrase via S2K, NOT
    // wrapped in an SKESK message.
    const { generateKey, encryptKey } = await import('openpgp')
    const { privateKey } = await generateKey({
      type: 'ecc',
      curve: 'curve25519',
      userIDs: [{ name: 'Alice', email: 'alice@example.com' }],
      passphrase: 'gnupg-secret',
      format: 'object',
    })
    const armoredPrivateKey = privateKey.armor()
    expect(armoredPrivateKey.startsWith('-----BEGIN PGP PRIVATE KEY BLOCK-----')).toBe(true)

    const plugin = await makePlugin('alice@example.com')

    const bundles = await plugin.callBackupImportAll(
      'alice@example.com',
      armoredPrivateKey,
      'gnupg-secret',
    )

    expect(bundles).toHaveLength(1)
    expect(bundles[0].fingerprint).toBe(privateKey.getFingerprint())
    expect(bundles[0].publicArmored.startsWith('-----BEGIN PGP PUBLIC KEY BLOCK-----')).toBe(true)
  })
```

Note: `makePlugin` is the existing factory used by the other tests in this file (search the file for its definition; it returns a `TestableWebOpenPGPPlugin` bound to an `InMemoryStorageBackend`). If it doesn't exist under that exact name, use whatever factory pattern the other `callBackupImportAll` tests already use — match style locally.

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd apps/fluux && npx vitest run src/e2ee/WebOpenPGPPlugin.test.ts -t "raw armored TSK"`
Expected: FAIL — the existing `decryptBackupMessage` path calls `readMessage` on a PRIVATE KEY BLOCK, which throws because the armor header is `PRIVATE KEY BLOCK`, not `MESSAGE`. The exact error will be an openpgp.js parse error — confirming the new path isn't yet wired.

- [ ] **Step 3: Add the raw-TSK helper and wire the branch**

In `apps/fluux/src/e2ee/WebOpenPGPPlugin.ts`, add the import for the detector at the top of the file (with the other imports):

```ts
import { detectArmorKind } from './armorDetect'
```

Then add this method next to `decryptBackupMessage`:

```ts
  /**
   * Decrypt a raw armored OpenPGP transferable secret key (the output of
   * `gpg --export-secret-keys --armor`). Each key's secret material is
   * S2K-protected with the user's GnuPG passphrase; we unlock them all
   * up front so the rest of the import pipeline sees decrypted keys, the
   * same shape `decryptBackupMessage` returns.
   */
  private async decryptRawPrivateKeys(
    armoredKey: string,
    passphrase: string,
  ): Promise<PrivateKey[]> {
    const { readPrivateKeys, decryptKey } = await import('openpgp')

    let keys: PrivateKey[]
    try {
      keys = await readPrivateKeys({ armoredKeys: armoredKey })
    } catch (err) {
      throw new E2EEPluginError(
        'permanent',
        'malformed-data',
        'WebOpenPGPPlugin: could not parse private key block',
        err,
      )
    }

    const decrypted: PrivateKey[] = []
    for (const key of keys) {
      if (key.isDecrypted()) {
        decrypted.push(key)
        continue
      }
      try {
        decrypted.push(await decryptKey({ privateKey: key, passphrase }))
      } catch (err) {
        throw new E2EEPluginError(
          'permanent',
          'wrong-passphrase',
          'WebOpenPGPPlugin: private key decryption failed — wrong passphrase',
          err,
        )
      }
    }
    return decrypted
  }
```

Then update `backupImportAll` to branch on the detected format:

```ts
  protected async backupImportAll(
    _accountJid: string,
    backupMessage: string,
    passphrase: string,
  ): Promise<KeyBundle[]> {
    const kind = detectArmorKind(backupMessage)
    let keys: PrivateKey[]
    if (kind === 'private-key') {
      keys = await this.decryptRawPrivateKeys(backupMessage, passphrase)
    } else if (kind === 'message') {
      keys = await this.decryptBackupMessage(backupMessage, passphrase)
    } else {
      throw new E2EEPluginError(
        'permanent',
        'malformed-data',
        'WebOpenPGPPlugin: file is neither an OpenPGP message nor a private key block',
      )
    }

    this.pendingImportKeys.clear()
    for (const key of keys) {
      this.pendingImportKeys.set(key.getFingerprint(), key)
    }

    return keys.map((k) => ({
      fingerprint: k.getFingerprint(),
      publicArmored: k.toPublic().armor(),
      keychainBacked: false,
      createdAt: k.getCreationTime().toISOString(),
    }))
  }
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd apps/fluux && npx vitest run src/e2ee/WebOpenPGPPlugin.test.ts -t "raw armored TSK"`
Expected: PASS.

- [ ] **Step 5: Run the full WebOpenPGPPlugin test suite to confirm no regression**

Run: `cd apps/fluux && npx vitest run src/e2ee/WebOpenPGPPlugin.test.ts`
Expected: PASS, all tests green (existing + 1 new).

- [ ] **Step 6: Commit**

```bash
git add apps/fluux/src/e2ee/WebOpenPGPPlugin.ts apps/fluux/src/e2ee/WebOpenPGPPlugin.test.ts
git commit -m "feat(e2ee): import raw armored OpenPGP private key (gpg --export-secret-keys)"
```

---

## Task 4: Error-path tests on the new import branch

**Files:**
- Modify: `apps/fluux/src/e2ee/WebOpenPGPPlugin.test.ts`

- [ ] **Step 1: Write the failing tests**

Add three tests in the same file, next to the happy-path test from Task 3:

```ts
  it('rejects a raw armored TSK with wrong passphrase', async () => {
    const { generateKey } = await import('openpgp')
    const { privateKey } = await generateKey({
      type: 'ecc',
      curve: 'curve25519',
      userIDs: [{ name: 'Bob', email: 'bob@example.com' }],
      passphrase: 'correct-horse-battery-staple',
      format: 'object',
    })
    const armoredPrivateKey = privateKey.armor()

    const plugin = await makePlugin('bob@example.com')

    await expect(
      plugin.callBackupImportAll('bob@example.com', armoredPrivateKey, 'wrong-passphrase'),
    ).rejects.toMatchObject({ code: 'wrong-passphrase', kind: 'permanent' })
  })

  it('rejects a malformed armored input (neither MESSAGE nor PRIVATE KEY BLOCK)', async () => {
    const plugin = await makePlugin('carol@example.com')
    const garbage = `-----BEGIN PGP PUBLIC KEY BLOCK-----\n\nmQGN...\n-----END PGP PUBLIC KEY BLOCK-----\n`

    await expect(
      plugin.callBackupImportAll('carol@example.com', garbage, 'any'),
    ).rejects.toMatchObject({ code: 'malformed-data', kind: 'permanent' })
  })

  it('rejects an unparseable private-key block', async () => {
    const plugin = await makePlugin('dave@example.com')
    const broken = `-----BEGIN PGP PRIVATE KEY BLOCK-----\n\nnot-real-base64-data\n-----END PGP PRIVATE KEY BLOCK-----\n`

    await expect(
      plugin.callBackupImportAll('dave@example.com', broken, 'any'),
    ).rejects.toMatchObject({ code: 'malformed-data', kind: 'permanent' })
  })
```

- [ ] **Step 2: Run the tests to verify they fail or pass as expected**

Run: `cd apps/fluux && npx vitest run src/e2ee/WebOpenPGPPlugin.test.ts -t "raw armored TSK with wrong passphrase|malformed armored input|unparseable private-key block"`

Expected: All 3 tests PASS — Task 3's implementation already handles these cases correctly. This task locks in those error contracts so we don't regress them later.

If any FAILs, the most likely cause is openpgp.js producing a different error path than expected; adjust the `decryptRawPrivateKeys` helper (Task 3 Step 3) to map the openpgp.js error to the right `E2EEPluginError` code.

- [ ] **Step 3: Commit**

```bash
git add apps/fluux/src/e2ee/WebOpenPGPPlugin.test.ts
git commit -m "test(e2ee): cover error paths for raw private-key import"
```

---

## Task 5: Pre-validate that the imported key has an encryption-capable subkey

DSA/ElGamal keys (the user's 2001/2005 GnuPG keys are an example) currently parse and decrypt fine but fail later at `encryptToRecipient` time with an opaque openpgp.js error. Surface the failure at import time with a clear error code so the dialog can render a helpful message.

**Files:**
- Modify: `apps/fluux/src/e2ee/WebOpenPGPPlugin.ts` (`backupImportAll` — add validation pass)
- Modify: `apps/fluux/src/e2ee/WebOpenPGPPlugin.test.ts` (add test)

- [ ] **Step 1: Write the failing test**

Add to `apps/fluux/src/e2ee/WebOpenPGPPlugin.test.ts`:

```ts
  it('rejects a key with no encryption-capable subkey (e.g. DSA sign-only)', async () => {
    // Synthesize a sign-only ECC key by generating a normal key then
    // stripping its subkeys. openpgp.js will then reject getEncryptionKey().
    const { generateKey } = await import('openpgp')
    const { privateKey } = await generateKey({
      type: 'ecc',
      curve: 'curve25519',
      userIDs: [{ name: 'Eve', email: 'eve@example.com' }],
      passphrase: 'pw',
      format: 'object',
    })
    // Drop subkeys to leave only the (signing) primary key.
    privateKey.subkeys = []
    const armoredPrivateKey = privateKey.armor()

    const plugin = await makePlugin('eve@example.com')

    await expect(
      plugin.callBackupImportAll('eve@example.com', armoredPrivateKey, 'pw'),
    ).rejects.toMatchObject({ code: 'unsupported-key-algorithm', kind: 'permanent' })
  })
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd apps/fluux && npx vitest run src/e2ee/WebOpenPGPPlugin.test.ts -t "no encryption-capable subkey"`
Expected: FAIL — the test expects code `'unsupported-key-algorithm'` but the current code returns the key bundles without validation (so the call succeeds, no rejection).

- [ ] **Step 3: Add the validation pass**

In `apps/fluux/src/e2ee/WebOpenPGPPlugin.ts`, update `backupImportAll` to validate each decrypted key before populating `pendingImportKeys`. Replace the body after `keys = ...` with:

```ts
    this.pendingImportKeys.clear()
    const bundles: KeyBundle[] = []
    for (const key of keys) {
      try {
        // openpgp.js applies `rejectPublicKeyAlgorithms` here, so a key
        // whose only encryption-capable subkey is ElGamal (or whose
        // primary key alone has no encryption subkey) throws.
        await key.getEncryptionKey()
      } catch (err) {
        throw new E2EEPluginError(
          'permanent',
          'unsupported-key-algorithm',
          `WebOpenPGPPlugin: imported key ${key.getFingerprint()} has no usable encryption subkey`,
          err,
        )
      }
      this.pendingImportKeys.set(key.getFingerprint(), key)
      bundles.push({
        fingerprint: key.getFingerprint(),
        publicArmored: key.toPublic().armor(),
        keychainBacked: false,
        createdAt: key.getCreationTime().toISOString(),
      })
    }
    return bundles
```

- [ ] **Step 4: Run the failing test plus the full suite**

Run: `cd apps/fluux && npx vitest run src/e2ee/WebOpenPGPPlugin.test.ts`
Expected: PASS — the new test passes, no prior tests regress.

- [ ] **Step 5: Commit**

```bash
git add apps/fluux/src/e2ee/WebOpenPGPPlugin.ts apps/fluux/src/e2ee/WebOpenPGPPlugin.test.ts
git commit -m "feat(e2ee): reject imported keys with no usable encryption subkey"
```

---

## Task 6: Update import dialog body + add unsupported-algorithm toast string (33 locales)

**Files:**
- Modify: `apps/fluux/src/i18n/locales/en.json` (canonical strings)
- Modify: `apps/fluux/src/i18n/locales/{ar,be,bg,ca,cs,da,de,el,es,et,fi,fr,ga,he,hr,hu,is,it,lt,lv,mt,nb,nl,pl,pt,ro,ru,sk,sl,sv,uk,zh-CN}.json` (all 32 other locales)
- Modify: `apps/fluux/src/components/settings-components/EncryptionSettings.tsx` (toast on unsupported-algorithm error)

- [ ] **Step 1: Update the English copy**

In `apps/fluux/src/i18n/locales/en.json`, update the existing key `settings.encryption.importFileDialogBody` (around line 670) and add a new one `unsupportedKeyAlgorithm`:

```json
"importFileDialogBody": "Enter the passphrase used when this key file was created. The file can be a Fluux backup (created with \"Export key file\") or a GnuPG private key exported with `gpg --export-secret-keys --armor`. The imported key will replace the one currently stored on this device.",
"unsupportedKeyAlgorithm": "Imported key uses an algorithm that is no longer supported (e.g. DSA or ElGamal). Use a modern OpenPGP key (Curve25519, Ed25519, or RSA ≥ 2048 bits).",
```

(Place `unsupportedKeyAlgorithm` immediately after `importFileFailed` to keep related keys grouped.)

- [ ] **Step 2: Translate to all 32 other locales**

For each of the 32 non-English locale files, update `importFileDialogBody` and add `unsupportedKeyAlgorithm` with proper translations (per the project's i18n convention — translate, do NOT leave English placeholders). Match the locale-specific tone and terminology already used in surrounding strings; the existing `exportFileSuccess` / `importFileFailed` translations are a good reference for register.

The 32 locales to translate: `ar, be, bg, ca, cs, da, de, el, es, et, fi, fr, ga, he, hr, hu, is, it, lt, lv, mt, nb, nl, pl, pt, ro, ru, sk, sl, sv, uk, zh-CN`.

- [ ] **Step 3: Wire the new toast in EncryptionSettings**

In `apps/fluux/src/components/settings-components/EncryptionSettings.tsx`, locate `handleImportFileConfirm` (around line 715). The catch path currently surfaces a generic toast; add a branch for the new error code. Replace the body of `handleImportFileConfirm`'s try/catch (or add a wrapping try/catch if absent) so that:

```ts
  const handleImportFileConfirm = useCallback(
    async (passphrase: string) => {
      if (!pendingImportFileArmored) return
      const plugin = client.e2ee?.getPlugin('openpgp') as
        | {
            importKeyFromFile?: (armored: string, pp: string) => Promise<
              { fingerprint: string } | { needsPicker: true; candidates: KeyBundle[]; backupContext: { message: string; passphrase: string } }
            >
          }
        | null
        | undefined
      if (!plugin?.importKeyFromFile) {
        throw new Error(t('settings.encryption.backupPluginUnavailable'))
      }
      try {
        const result = await plugin.importKeyFromFile(pendingImportFileArmored, passphrase)
        if ('needsPicker' in result) {
          setPendingKeyPicker({
            candidates: result.candidates,
            backupMessage: result.backupContext.message,
            passphrase: result.backupContext.passphrase,
          })
          setShowImportFileDialog(false)
          return
        }
        setFingerprint(result.fingerprint)
        setShowImportFileDialog(false)
        setPendingImportFileArmored(null)
        setBackupProbeNonce((n) => n + 1)
        addToast('success', t('settings.encryption.importFileSuccess'))
      } catch (err) {
        const code = (err as { code?: string } | null)?.code
        if (code === 'unsupported-key-algorithm') {
          addToast('error', t('settings.encryption.unsupportedKeyAlgorithm'))
          setShowImportFileDialog(false)
          setPendingImportFileArmored(null)
          return
        }
        throw err
      }
    },
    [pendingImportFileArmored, client, addToast, t],
  )
```

- [ ] **Step 4: Typecheck and run the full app test suite**

Run: `cd apps/fluux && npm run typecheck`
Expected: PASS.

Run: `cd apps/fluux && npx vitest run`
Expected: PASS — no regressions.

- [ ] **Step 5: Commit**

```bash
git add apps/fluux/src/i18n/locales apps/fluux/src/components/settings-components/EncryptionSettings.tsx
git commit -m "feat(e2ee): explain GnuPG key import support in i18n + handle unsupported algos"
```

---

## Task 7: End-to-end manual verification

This task validates the full chain with a real openpgp.js-backed dev server. No code changes — only running the app and exercising the flow.

**Files:** (no edits)

- [ ] **Step 1: Build the SDK and start the dev server**

Run from repo root:

```bash
npm run build:sdk
npm run dev
```

Expected: dev server listening on `localhost:5173`.

- [ ] **Step 2: Produce a modern GnuPG-compatible test key**

In a separate terminal:

```bash
# Generate a fresh ed25519 key via openpgp.js (independent of GnuPG)
node -e '
const op = require("openpgp");
(async () => {
  const { privateKey } = await op.generateKey({
    type: "ecc", curve: "curve25519",
    userIDs: [{ name: "Test", email: "test@example.com" }],
    passphrase: "test-passphrase",
    format: "object",
  });
  console.log(privateKey.armor());
})();
' > /tmp/test-modern-key.asc
```

- [ ] **Step 3: Import via the UI**

Open `http://localhost:5173`, log in to a dev XMPP account (or use `demo.html` if you can't reach a server), navigate to Settings → Encryption → "Import from file". Pick `/tmp/test-modern-key.asc`. Enter `test-passphrase`.

Expected: Success toast, fingerprint in Encryption settings matches the one openpgp.js printed during key generation.

- [ ] **Step 4: Negative test — wrong passphrase**

Repeat Step 3 but type a wrong passphrase. Expected: an error toast, no fingerprint change.

- [ ] **Step 5: Negative test — unsupported algorithm**

If you have access to one of your old DSA/ElGamal keys, export it:

```bash
gpg --export-secret-keys --armor 6BDBF3B8C6B8B627227613E5E6F6045D79965AA3 > /tmp/test-legacy-key.asc
```

Import via the UI, enter the right passphrase. Expected: the `unsupportedKeyAlgorithm` toast fires, dialog closes, no fingerprint change.

If no legacy key is available, skip this step and note that Task 5's unit test already covers the contract.

- [ ] **Step 6: Final cleanup commit (only if anything was tweaked during verification)**

If verification surfaced no issues, no commit is needed. If a small fix was required, commit it with a focused message.

---

## Out-of-Scope Follow-ups (do NOT do in this plan)

1. **Sequoia/desktop parity** — `SequoiaPgpPlugin` currently routes the import through `openpgp_backup_import_all` (Rust). To support raw armored TSK there, add a `decrypt_raw_tsk_with_passphrase` in `apps/fluux/src-tauri/src/openpgp_backup.rs` and a matching armor-kind detector in Rust (or do the detection in TS and dispatch to either `openpgp_backup_import_all` or a new `openpgp_import_raw_tsk_all` Tauri command). Worth its own plan: ~3-4 tasks (Rust helper + Rust unit tests + Tauri command + TS dispatch).
2. **Binary (non-armored) `gpg --export-secret-keys`** — current `pickKeyFile` calls `reader.readAsText`, which corrupts binary input. Adding a binary path means changing the file picker plumbing and the helper signature. Defer until users ask.
3. **Picker UX hint** — when the import succeeds but the key file contained multiple TSKs (rare with `gpg --export-secret-keys`, common with `gpg --export-secret-keys --armor` if no UID was specified), the existing picker dialog opens. Consider showing a small "Detected: GnuPG key file" badge to confirm what was loaded. Not a blocker.

---

## Self-review notes

- Spec coverage: ✅ format detection (Task 1), happy path (Tasks 2-3), error paths (Tasks 4-5), UI/i18n (Task 6), end-to-end (Task 7).
- No placeholders: All code blocks contain complete, runnable content. Test names are concrete. Locale list is exhaustive.
- Type consistency: `detectArmorKind` / `ArmorKind` used identically across tasks. `decryptBackupMessage` / `decryptRawPrivateKeys` names stable from Task 2 onward. Error code `'unsupported-key-algorithm'` used identically in plugin (Task 5) and UI (Task 6).
- Architectural risk: ElGamal/DSA primary keys *might* throw earlier than `getEncryptionKey()` — at `readPrivateKeys` time if openpgp.js refuses to parse them. Task 4's "unparseable" test partially covers this; if it surfaces during Task 5 development, the existing `malformed-data` path is the appropriate fallback.
