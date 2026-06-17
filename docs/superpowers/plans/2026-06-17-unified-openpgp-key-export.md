# Unified OpenPGP Key Export with Passphrase-Format Hint — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Collapse the two OpenPGP key-export buttons into one encrypted backup `.asc`, tag it with a `Passphrase-Format` armor header that the import flow reads to pick the passphrase input mask, and delete the raw private-key export end to end.

**Architecture:** A pure helper module (`passphraseFormatHeader.ts`) emits and parses the armor header. The header is added only on the file export (in a shared `OpenPGPPluginBase.buildExportArmor`), never on the PEP/server backup. The import dialog (`RestorePassphraseDialog`) becomes authoritative on its `isBackupCode` prop; the two import-from-file sites compute it from the parsed header. The raw export (`exportPrivateKeyToFile`, `ExternalKeyExportDialog`, Rust `openpgp_export.rs`) is removed.

**Tech Stack:** TypeScript + React (app), Vitest + Testing Library (app tests, `node`/jsdom envs), Rust + Sequoia-PGP (`src-tauri`), i18n JSON locales.

Reference spec: [docs/superpowers/specs/2026-06-17-unified-openpgp-key-export-design.md](../specs/2026-06-17-unified-openpgp-key-export-design.md)

## Global Constraints

- **Header key is the literal string `Passphrase-Format`** (matches OpenKeychain so one parser reads both).
- **Header value is derived from `USE_V6_KEYS`** (in `apps/fluux/src/e2ee/passphraseGenerator.ts`, currently `false`): `xep0373` when `!USE_V6_KEYS`, `bip39` when `USE_V6_KEYS`.
- **The header lives only on the file export.** `backupEncrypt` output (used by the PEP/server backup) must stay header-free.
- **Import-mask rule:** header `xep0373` → masked backup-code field; `bip39` / `numeric9x4` / any other value / absent → free-text field.
- **i18n:** this change only *deletes* keys (`externalExport*`), so no translation work; do not add English placeholders. Delete from all 33 locale files to keep `i18n.test.ts` parity green.
- **Commits are SSH-signed** (key already loaded). Never include a Claude footer in commits.
- **Verification commands** (run from repo root unless noted):
  - App tests: `cd apps/fluux && npx vitest run <relative-path>`
  - Typecheck: `npm run typecheck`
  - Lint: `npm run lint`
  - Rust: `cd apps/fluux/src-tauri && cargo test` / `cargo build`
- **Worktree note:** no SDK (`packages/fluux-sdk`) changes are made here, so the app→SDK dist resolution gotcha does not apply.

---

### Task 1: Passphrase-format armor header module (pure)

**Files:**
- Create: `apps/fluux/src/e2ee/passphraseFormatHeader.ts`
- Test: `apps/fluux/src/e2ee/passphraseFormatHeader.test.ts`

**Interfaces:**
- Consumes: `USE_V6_KEYS` from `./passphraseGenerator`.
- Produces:
  - `type PassphraseFormat = 'xep0373' | 'bip39'`
  - `currentPassphraseFormat(): PassphraseFormat`
  - `withPassphraseFormatHeader(armored: string, format?: PassphraseFormat): string`
  - `parseArmorPassphraseFormat(armored: string): string | null`

- [ ] **Step 1: Write the failing test**

Create `apps/fluux/src/e2ee/passphraseFormatHeader.test.ts`:

```typescript
import { describe, it, expect } from 'vitest'
import {
  currentPassphraseFormat,
  withPassphraseFormatHeader,
  parseArmorPassphraseFormat,
} from './passphraseFormatHeader'

const MSG = (headers = '') =>
  `-----BEGIN PGP MESSAGE-----\n${headers}\nwcDMAxk...base64body...\n-----END PGP MESSAGE-----\n`

describe('currentPassphraseFormat', () => {
  it('is xep0373 while USE_V6_KEYS is false (v4 default)', () => {
    expect(currentPassphraseFormat()).toBe('xep0373')
  })
})

describe('withPassphraseFormatHeader', () => {
  it('inserts the header line right after the BEGIN line', () => {
    const out = withPassphraseFormatHeader(MSG('Version: OpenPGP.js'), 'xep0373')
    expect(out).toContain('-----BEGIN PGP MESSAGE-----\nPassphrase-Format: xep0373\n')
    // The original body and Version header survive.
    expect(out).toContain('Version: OpenPGP.js')
    expect(out).toContain('wcDMAxk')
  })

  it('handles a message with no existing armor headers', () => {
    const out = withPassphraseFormatHeader(MSG(''), 'bip39')
    expect(out).toContain('-----BEGIN PGP MESSAGE-----\nPassphrase-Format: bip39\n')
  })

  it('is idempotent — never adds a second header', () => {
    const once = withPassphraseFormatHeader(MSG(), 'xep0373')
    const twice = withPassphraseFormatHeader(once, 'xep0373')
    expect(twice).toBe(once)
  })

  it('defaults the format to currentPassphraseFormat()', () => {
    const out = withPassphraseFormatHeader(MSG())
    expect(out).toContain('Passphrase-Format: xep0373')
  })

  it('leaves a non-MESSAGE blob untouched', () => {
    const key = '-----BEGIN PGP PRIVATE KEY BLOCK-----\n\nbody\n-----END PGP PRIVATE KEY BLOCK-----\n'
    expect(withPassphraseFormatHeader(key, 'xep0373')).toBe(key)
  })
})

describe('parseArmorPassphraseFormat', () => {
  it('reads the Fluux xep0373 header', () => {
    expect(parseArmorPassphraseFormat(withPassphraseFormatHeader(MSG(), 'xep0373'))).toBe('xep0373')
  })

  it("reads OpenKeychain's numeric9x4 header verbatim", () => {
    expect(parseArmorPassphraseFormat(MSG('Passphrase-Format: numeric9x4'))).toBe('numeric9x4')
  })

  it('returns null when the header is absent', () => {
    expect(parseArmorPassphraseFormat(MSG('Version: GnuPG v2'))).toBeNull()
  })

  it('returns null for a raw private key block', () => {
    expect(
      parseArmorPassphraseFormat('-----BEGIN PGP PRIVATE KEY BLOCK-----\n\nx\n-----END PGP PRIVATE KEY BLOCK-----'),
    ).toBeNull()
  })

  it('tolerates a leading BOM/whitespace', () => {
    expect(parseArmorPassphraseFormat('﻿  ' + withPassphraseFormatHeader(MSG(), 'xep0373'))).toBe('xep0373')
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd apps/fluux && npx vitest run src/e2ee/passphraseFormatHeader.test.ts`
Expected: FAIL — `Cannot find module './passphraseFormatHeader'`.

- [ ] **Step 3: Write the implementation**

Create `apps/fluux/src/e2ee/passphraseFormatHeader.ts`:

```typescript
/**
 * Read/write the `Passphrase-Format` ASCII-armor header on a Fluux backup
 * MESSAGE. The header key matches OpenKeychain's verbatim, so a single parser
 * reads both Fluux and OpenKeychain backups; the value tells the importing
 * side which passphrase input mask to show.
 *
 * The header is added only to the *file* export — never to the PEP/server
 * backup, which dearmors to Base64 and would strip it anyway.
 */
import { USE_V6_KEYS } from './passphraseGenerator'

/** Passphrase families Fluux itself generates (see passphraseGenerator). */
export type PassphraseFormat = 'xep0373' | 'bip39'

const HEADER_KEY = 'Passphrase-Format'
const MESSAGE_HEADER = '-----BEGIN PGP MESSAGE-----'

/** The format Fluux generates for backups, fixed by the key-version mode. */
export function currentPassphraseFormat(): PassphraseFormat {
  return USE_V6_KEYS ? 'bip39' : 'xep0373'
}

/**
 * Insert a `Passphrase-Format: <format>` armor header into an armored OpenPGP
 * MESSAGE, immediately after the BEGIN line. Idempotent; a no-op if the input
 * is not a MESSAGE block.
 */
export function withPassphraseFormatHeader(
  armored: string,
  format: PassphraseFormat = currentPassphraseFormat(),
): string {
  if (armored.includes(`${HEADER_KEY}:`)) return armored
  const idx = armored.indexOf(MESSAGE_HEADER)
  if (idx === -1) return armored
  const insertAt = idx + MESSAGE_HEADER.length
  return `${armored.slice(0, insertAt)}\n${HEADER_KEY}: ${format}${armored.slice(insertAt)}`
}

/**
 * Return the `Passphrase-Format` header value, or null when absent. The token
 * (`-`, `:`, space) cannot occur in Base64 body lines, so scanning the whole
 * blob is safe. Tolerates a leading BOM/whitespace.
 */
export function parseArmorPassphraseFormat(armored: string): string | null {
  if (!armored) return null
  const match = armored.match(/^Passphrase-Format:[ \t]*(\S+)[ \t]*$/m)
  return match ? match[1] : null
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd apps/fluux && npx vitest run src/e2ee/passphraseFormatHeader.test.ts`
Expected: PASS (all cases).

- [ ] **Step 5: Commit**

```bash
git add apps/fluux/src/e2ee/passphraseFormatHeader.ts apps/fluux/src/e2ee/passphraseFormatHeader.test.ts
git commit -m "feat(e2ee): add Passphrase-Format armor header emit/parse helper"
```

---

### Task 2: Emit the header on file export

**Files:**
- Modify: `apps/fluux/src/e2ee/OpenPGPPluginBase.ts` (add `buildExportArmor`)
- Modify: `apps/fluux/src/e2ee/WebOpenPGPPlugin.ts:567-579` (`exportKeyToFile`)
- Modify: `apps/fluux/src/e2ee/SequoiaPgpPlugin.ts:185-209` (`exportKeyToFile`)
- Test: `apps/fluux/src/e2ee/WebOpenPGPPlugin.test.ts` (add a `file export header` describe + a `callBuildExportArmor` helper)

**Interfaces:**
- Consumes: `withPassphraseFormatHeader` (Task 1); existing `this.backupEncrypt(accountJid, passphrase)` and `this.requireCtx()` on `OpenPGPPluginBase`.
- Produces: `protected buildExportArmor(passphrase: string): Promise<string>` on `OpenPGPPluginBase` — returns the armored backup MESSAGE with the `Passphrase-Format` header.

- [ ] **Step 1: Write the failing test**

In `apps/fluux/src/e2ee/WebOpenPGPPlugin.test.ts`, add a `callBuildExportArmor` method to the existing `TestableWebOpenPGPPlugin` class (after `callBackupEncrypt`, around line 49):

```typescript
  callBuildExportArmor(passphrase: string) {
    return this.buildExportArmor(passphrase)
  }
```

Then add this new describe block (place it next to the existing `describe('backup round-trip', ...)`):

```typescript
describe('file export header', () => {
  it('exported armor carries Passphrase-Format: xep0373 and round-trips', async () => {
    const source = new TestableWebOpenPGPPlugin()
    const sourceCtx = makeCtx('alice@example.com').ctx
    setSessionPassphrase('source-session-pp')
    await source.init(sourceCtx)
    const original = await source.callEnsureKeyMaterial('alice@example.com')

    const exported = await source.callBuildExportArmor('correct horse battery staple eight words ok')
    expect(exported).toContain('-----BEGIN PGP MESSAGE-----')
    expect(exported).toMatch(/Passphrase-Format: xep0373/)

    // The header must not break import: a fresh plugin recovers the key.
    clearSessionPassphrase()
    const dest = new TestableWebOpenPGPPlugin()
    const destCtx = makeCtx('alice@example.com').ctx
    await dest.init(destCtx)
    const restored = await dest.callBackupImport(
      'alice@example.com',
      exported,
      'correct horse battery staple eight words ok',
    )
    expect(restored.fingerprint).toBe(original.fingerprint)
  })

  it('backupEncrypt output (PEP/server backup) carries NO Passphrase-Format header', async () => {
    const source = new TestableWebOpenPGPPlugin()
    const sourceCtx = makeCtx('alice@example.com').ctx
    setSessionPassphrase('source-session-pp')
    await source.init(sourceCtx)
    await source.callEnsureKeyMaterial('alice@example.com')

    const raw = await source.callBackupEncrypt('alice@example.com', 'some passphrase here ok eight')
    expect(raw).toContain('-----BEGIN PGP MESSAGE-----')
    expect(raw).not.toContain('Passphrase-Format')
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd apps/fluux && npx vitest run src/e2ee/WebOpenPGPPlugin.test.ts -t "file export header"`
Expected: FAIL — `this.buildExportArmor is not a function`.

- [ ] **Step 3: Add `buildExportArmor` to the base class**

In `apps/fluux/src/e2ee/OpenPGPPluginBase.ts`, add the import near the other `./` imports at the top of the file:

```typescript
import { withPassphraseFormatHeader } from './passphraseFormatHeader'
```

Then add this method just above the abstract `exportKeyToFile` declaration (currently around line 463):

```typescript
  /**
   * Build the armored backup MESSAGE for a file export: the XEP-0373 §5 SKESK
   * wrap plus a `Passphrase-Format` armor header describing the passphrase
   * family. Shared by both platforms' {@link exportKeyToFile}. NOT used for the
   * PEP/server backup, which must stay header-free.
   */
  protected async buildExportArmor(passphrase: string): Promise<string> {
    const ctx = this.requireCtx()
    const armored = await this.backupEncrypt(ctx.account.jid, passphrase)
    return withPassphraseFormatHeader(armored)
  }
```

- [ ] **Step 4: Wire the Web plugin's `exportKeyToFile` to it**

In `apps/fluux/src/e2ee/WebOpenPGPPlugin.ts`, replace the body of `exportKeyToFile` (lines 567-579) so it builds via `buildExportArmor`:

```typescript
  async exportKeyToFile(passphrase: string): Promise<boolean> {
    const ctx = this.requireCtx()
    if (!this.ownBundle) {
      throw new E2EEPluginError(
        'permanent',
        'no-identity',
        'WebOpenPGPPlugin: no identity to export',
      )
    }
    const armoredMessage = await this.buildExportArmor(passphrase)
    triggerBrowserDownload(armoredMessage, keyExportFilename('openpgp-backup', ctx.account.jid))
    return true
  }
```

- [ ] **Step 5: Wire the Sequoia plugin's `exportKeyToFile` to it**

In `apps/fluux/src/e2ee/SequoiaPgpPlugin.ts`, change the `try` block in `exportKeyToFile` (lines 194-199) to call `buildExportArmor` instead of `backupEncrypt`:

```typescript
    let armoredMessage: string
    try {
      armoredMessage = await this.buildExportArmor(passphrase)
    } catch (err) {
      throw this.toPluginError('exportKeyToFile', err)
    }
```

(Leave the rest of the method — the `save()` dialog and `writeTextFile` — unchanged.)

- [ ] **Step 6: Run the new test to verify it passes**

Run: `cd apps/fluux && npx vitest run src/e2ee/WebOpenPGPPlugin.test.ts -t "file export header"`
Expected: PASS (both cases).

- [ ] **Step 7: Run the full plugin suite + the interop guard to confirm no regression**

Run: `cd apps/fluux && npx vitest run src/e2ee/WebOpenPGPPlugin.test.ts src/e2ee/backupInterop.test.ts`
Expected: PASS (backupInterop still passes — it asserts `backupEncrypt`, which is unchanged).

- [ ] **Step 8: Typecheck + commit**

```bash
npm run typecheck
git add apps/fluux/src/e2ee/OpenPGPPluginBase.ts apps/fluux/src/e2ee/WebOpenPGPPlugin.ts apps/fluux/src/e2ee/SequoiaPgpPlugin.ts apps/fluux/src/e2ee/WebOpenPGPPlugin.test.ts
git commit -m "feat(e2ee): tag exported key file with Passphrase-Format header"
```

---

### Task 3: Consume the header on import to pick the passphrase mask

**Files:**
- Modify: `apps/fluux/src/components/RestorePassphraseDialog.tsx:45-46,84-87` (make `isBackupCode` authoritative; update JSDoc)
- Modify: `apps/fluux/src/components/settings-components/EncryptionSettings.tsx:1241-1256` (import dialog gets header-derived `isBackupCode`)
- Modify: `apps/fluux/src/App.tsx:438-450` (same)
- Test: `apps/fluux/src/components/RestorePassphraseDialog.test.tsx` (update import-mode cases; add a masked-in-import case)
- Test: `apps/fluux/src/components/settings-components/EncryptionSettings.test.tsx` (add a header-driven masked case)

**Interfaces:**
- Consumes: `parseArmorPassphraseFormat` (Task 1); `RestorePassphraseDialog`'s existing `isBackupCode` and `mode` props.
- Produces: `RestorePassphraseDialog` renders the masked backup-code field iff `isBackupCode` is true (independent of `mode`).

- [ ] **Step 1: Write the failing dialog test**

In `apps/fluux/src/components/RestorePassphraseDialog.test.tsx`, update the first import-mode test to pass `isBackupCode={false}` (foreign files default to free text), and add a new masked case. Replace the first `it(...)` (lines 21-30) with:

```typescript
  it('renders a free-text passphrase field with autofill disabled and no hidden username', () => {
    const { container } = render(
      <RestorePassphraseDialog mode="import" isBackupCode={false} onConfirm={async () => {}} onCancel={noop} />,
    )
    const input = container.querySelector('input[name="passphrase"]') as HTMLInputElement | null
    expect(input).not.toBeNull()
    expect(input!.getAttribute('autocomplete')).toBe('off')
    expect(container.querySelector('input[name="username"]')).toBeNull()
  })

  it('renders the masked backup-code field in import mode when isBackupCode is set', () => {
    const { container } = render(
      <RestorePassphraseDialog mode="import" isBackupCode={true} onConfirm={async () => {}} onCancel={noop} />,
    )
    // A Fluux xep0373 backup file should get the dashed masked input.
    expect(container.querySelector('input[name="backup-code"]')).not.toBeNull()
    expect(container.querySelector('input[name="passphrase"]')).toBeNull()
  })
```

Also update the second and third import-mode tests (lines 32-57) to pass `isBackupCode={false}` on their `<RestorePassphraseDialog>` so they keep exercising the free-text field:

```typescript
      <RestorePassphraseDialog mode="import" isBackupCode={false} onConfirm={async () => {}} onCancel={noop} />,
```

```typescript
      <RestorePassphraseDialog mode="import" isBackupCode={false} onConfirm={onConfirm} onCancel={noop} />,
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd apps/fluux && npx vitest run src/components/RestorePassphraseDialog.test.tsx`
Expected: FAIL — the new masked case finds no `input[name="backup-code"]` because import mode currently forces free text.

- [ ] **Step 3: Make `isBackupCode` authoritative in the dialog**

In `apps/fluux/src/components/RestorePassphraseDialog.tsx`, update the prop JSDoc (lines 45-46):

```typescript
  /**
   * Show the masked XEP-0373 backup-code field (XXXX-XXXX-… format) instead of
   * a free-text field. Authoritative even in import mode: import-from-file sites
   * MUST set this from the file's `Passphrase-Format` header (`xep0373` → true,
   * everything else → false). Defaults to !USE_V6_KEYS for the server-restore flow.
   */
  isBackupCode?: boolean
```

Then change the `useBackupCode` derivation (lines 84-87) from:

```typescript
  const isImport = mode === 'import'
  // A foreign key's passphrase is arbitrary text, never an XEP-0373 backup
  // code — so import always uses the free-text field regardless of the default.
  const useBackupCode = !isImport && isBackupCode
```

to:

```typescript
  const isImport = mode === 'import'
  // The masked field is driven solely by isBackupCode. Import-from-file sites
  // pass it based on the file's Passphrase-Format header (a Fluux xep0373 backup
  // gets the mask; a foreign key's arbitrary passphrase stays free text).
  const useBackupCode = isBackupCode
```

- [ ] **Step 4: Run the dialog test to verify it passes**

Run: `cd apps/fluux && npx vitest run src/components/RestorePassphraseDialog.test.tsx`
Expected: PASS (all four cases).

- [ ] **Step 5: Wire the EncryptionSettings import dialog**

In `apps/fluux/src/components/settings-components/EncryptionSettings.tsx`, add the import near the other `@/` imports (next to the `RestorePassphraseDialog` import on line 11):

```typescript
import { parseArmorPassphraseFormat } from '@/e2ee/passphraseFormatHeader'
```

Then in the import-file dialog render (lines 1241-1256), add the `isBackupCode` prop derived from the picked file. Change:

```tsx
      {showImportFileDialog && pendingImportFileArmored && (
        <RestorePassphraseDialog
          title={t('settings.encryption.importFileDialogTitle')}
          body={t('settings.encryption.importFileDialogBody')}
          confirmLabel={t('settings.encryption.importFileAction')}
          // An imported key (GnuPG / OpenKeychain export) carries an arbitrary
          // passphrase: free-text entry with a reveal toggle, no password-manager
          // autofill, and trimming. See RestorePassphraseDialog 'import' mode.
          mode="import"
          onConfirm={handleImportFileConfirm}
```

to:

```tsx
      {showImportFileDialog && pendingImportFileArmored && (
        <RestorePassphraseDialog
          title={t('settings.encryption.importFileDialogTitle')}
          body={t('settings.encryption.importFileDialogBody')}
          confirmLabel={t('settings.encryption.importFileAction')}
          // Foreign keys (GnuPG / OpenKeychain) carry an arbitrary passphrase:
          // free-text entry with a reveal toggle, no autofill, trimming. A Fluux
          // backup file (Passphrase-Format: xep0373) gets the masked dashed input.
          mode="import"
          isBackupCode={parseArmorPassphraseFormat(pendingImportFileArmored) === 'xep0373'}
          onConfirm={handleImportFileConfirm}
```

- [ ] **Step 6: Wire the App.tsx import dialog**

In `apps/fluux/src/App.tsx`, add the import near the `RestorePassphraseDialog` import (line 12):

```typescript
import { parseArmorPassphraseFormat } from './e2ee/passphraseFormatHeader'
```

Then in the import-file dialog (lines 438-450), add the prop. Change:

```tsx
      {pendingImportFile && (
        <RestorePassphraseDialog
          title={t('settings.encryption.importFileDialogTitle')}
          body={t('settings.encryption.importFileDialogBody')}
          confirmLabel={t('settings.encryption.importFileAction')}
          // An imported key (GnuPG / OpenKeychain export) carries an arbitrary
          // passphrase: free-text entry with a reveal toggle, no password-manager
          // autofill, and trimming. See RestorePassphraseDialog 'import' mode.
          mode="import"
          onConfirm={handleImportFilePassphrase}
```

to:

```tsx
      {pendingImportFile && (
        <RestorePassphraseDialog
          title={t('settings.encryption.importFileDialogTitle')}
          body={t('settings.encryption.importFileDialogBody')}
          confirmLabel={t('settings.encryption.importFileAction')}
          // Foreign keys (GnuPG / OpenKeychain) carry an arbitrary passphrase:
          // free-text entry with a reveal toggle, no autofill, trimming. A Fluux
          // backup file (Passphrase-Format: xep0373) gets the masked dashed input.
          mode="import"
          isBackupCode={parseArmorPassphraseFormat(pendingImportFile) === 'xep0373'}
          onConfirm={handleImportFilePassphrase}
```

- [ ] **Step 7: Add the EncryptionSettings header-driven masked test**

In `apps/fluux/src/components/settings-components/EncryptionSettings.test.tsx`, inside the existing `describe('import-from-file passphrase', ...)` block, add a new test after the existing one (before the closing `})`):

```typescript
    it('shows the masked backup-code field when the file is a Fluux xep0373 backup', async () => {
      mockPickKeyFile.mockResolvedValue(
        '-----BEGIN PGP MESSAGE-----\nPassphrase-Format: xep0373\n\nwcDMfakebody\n-----END PGP MESSAGE-----\n',
      )

      render(<EncryptionSettings />)

      const importButton = await screen.findByRole('button', {
        name: 'settings.encryption.importFileAction',
      })
      fireEvent.click(importButton)

      // The Passphrase-Format header drives the masked dashed input, not free text.
      await waitFor(() => {
        expect(document.querySelector('input[name="backup-code"]')).not.toBeNull()
      })
      expect(document.querySelector('input[name="passphrase"]')).toBeNull()
    })
```

- [ ] **Step 8: Run both component suites to verify they pass**

Run: `cd apps/fluux && npx vitest run src/components/RestorePassphraseDialog.test.tsx src/components/settings-components/EncryptionSettings.test.tsx`
Expected: PASS — including the existing numeric9x4-verbatim test (a PRIVATE KEY BLOCK has no header → free text → unchanged).

- [ ] **Step 9: Typecheck + commit**

```bash
npm run typecheck
git add apps/fluux/src/components/RestorePassphraseDialog.tsx apps/fluux/src/App.tsx apps/fluux/src/components/settings-components/EncryptionSettings.tsx apps/fluux/src/components/RestorePassphraseDialog.test.tsx apps/fluux/src/components/settings-components/EncryptionSettings.test.tsx
git commit -m "feat(e2ee): drive import passphrase mask from Passphrase-Format header"
```

---

### Task 4: Delete the raw private-key export (TypeScript, UI, i18n)

**Files:**
- Delete: `apps/fluux/src/components/ExternalKeyExportDialog.tsx`
- Modify: `apps/fluux/src/e2ee/OpenPGPPluginBase.ts` (remove the `exportPrivateKeyToFile` abstract, lines ~465-477)
- Modify: `apps/fluux/src/e2ee/WebOpenPGPPlugin.ts` (remove `exportPrivateKeyToFile`, lines 581-606)
- Modify: `apps/fluux/src/e2ee/SequoiaPgpPlugin.ts` (remove `exportPrivateKeyToFile`, lines 211-238)
- Modify: `apps/fluux/src/components/settings-components/EncryptionSettings.tsx` (remove `ExternalKeyExportDialog` import line 12, `showExternalExportDialog` state line 105, `handleExternalExportConfirm` lines 727-743, the external-export button lines 1059-1065, the dialog render lines 1234-1239)
- Modify: `apps/fluux/src/e2ee/keyExportNaming.ts` (single-arg signature)
- Modify: `apps/fluux/src/e2ee/keyExportNaming.test.ts`
- Modify: `apps/fluux/src/e2ee/WebOpenPGPPlugin.ts:577` and `SequoiaPgpPlugin.ts:202` (drop the kind arg from `keyExportFilename`)
- Modify: all `apps/fluux/src/i18n/locales/*.json` (remove `externalExport*` keys)

**Interfaces:**
- Produces: `keyExportFilename(jid: string): string` (kind removed; always the `openpgp-backup` stem).

- [ ] **Step 1: Update the keyExportNaming test (single-arg)**

Replace `apps/fluux/src/e2ee/keyExportNaming.test.ts` with:

```typescript
import { describe, it, expect } from 'vitest'
import { keyExportFilename } from './keyExportNaming'

describe('keyExportFilename', () => {
  it('embeds the account JID so exports are self-describing', () => {
    expect(keyExportFilename('alice@example.org')).toBe('openpgp-backup-alice@example.org.asc')
  })

  it('replaces filesystem-unsafe characters (resource separators, slashes)', () => {
    expect(keyExportFilename('alice@example.org/phone')).toBe('openpgp-backup-alice@example.org_phone.asc')
    expect(keyExportFilename('a/b\\c:d')).toBe('openpgp-backup-a_b_c_d.asc')
  })

  it('collapses runs and trims leading/trailing separators (no hidden file, no `..`)', () => {
    expect(keyExportFilename('..weird//jid..')).toBe('openpgp-backup-weird_jid.asc')
  })

  it('falls back to a bare name when the JID sanitizes to nothing', () => {
    expect(keyExportFilename('')).toBe('openpgp-backup.asc')
    expect(keyExportFilename('   ')).toBe('openpgp-backup.asc')
    expect(keyExportFilename('///')).toBe('openpgp-backup.asc')
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd apps/fluux && npx vitest run src/e2ee/keyExportNaming.test.ts`
Expected: FAIL — `keyExportFilename` still requires two args (type error / wrong output).

- [ ] **Step 3: Simplify `keyExportNaming.ts`**

Replace the top of `apps/fluux/src/e2ee/keyExportNaming.ts` (the `KeyExportKind` type and `keyExportFilename` function, lines 12-26) with:

```typescript
/**
 * Build the suggested filename for an exported key backup.
 *
 * @param jid   the account bare JID the key belongs to
 * @returns e.g. `openpgp-backup-alice@example.org.asc`; falls back to
 *          `openpgp-backup.asc` when the JID sanitizes to nothing
 */
export function keyExportFilename(jid: string): string {
  const safeJid = sanitizeForFilename(jid)
  return safeJid ? `openpgp-backup-${safeJid}.asc` : 'openpgp-backup.asc'
}
```

(Leave the `sanitizeForFilename` helper below it unchanged. The file's top-of-file doc comment can keep its existing wording.)

- [ ] **Step 4: Update the two surviving callers**

In `apps/fluux/src/e2ee/WebOpenPGPPlugin.ts`, line 577 becomes:

```typescript
    triggerBrowserDownload(armoredMessage, keyExportFilename(ctx.account.jid))
```

In `apps/fluux/src/e2ee/SequoiaPgpPlugin.ts`, line 202 becomes:

```typescript
      defaultPath: keyExportFilename(ctx.account.jid),
```

- [ ] **Step 5: Run the naming test to verify it passes**

Run: `cd apps/fluux && npx vitest run src/e2ee/keyExportNaming.test.ts`
Expected: PASS.

- [ ] **Step 6: Remove the raw-export plugin methods**

- In `apps/fluux/src/e2ee/OpenPGPPluginBase.ts`, delete the entire `exportPrivateKeyToFile` abstract declaration and its JSDoc (the block ending in `abstract exportPrivateKeyToFile(passphrase: string | null): Promise<boolean>`).
- In `apps/fluux/src/e2ee/WebOpenPGPPlugin.ts`, delete the whole `async exportPrivateKeyToFile(...) { ... }` method (lines 581-606).
- In `apps/fluux/src/e2ee/SequoiaPgpPlugin.ts`, delete the whole `async exportPrivateKeyToFile(...) { ... }` method (lines 211-238).

- [ ] **Step 7: Remove the external-export UI from EncryptionSettings**

In `apps/fluux/src/components/settings-components/EncryptionSettings.tsx`:
- Delete the import on line 12: `import { ExternalKeyExportDialog } from '@/components/ExternalKeyExportDialog'`
- Delete the state on line 105: `const [showExternalExportDialog, setShowExternalExportDialog] = useState(false)`
- Delete the entire `handleExternalExportConfirm` callback (lines 727-743).
- Delete the external-export button (lines 1059-1065):

```tsx
                    <button
                      onClick={() => setShowExternalExportDialog(true)}
                      className="flex items-center gap-1.5 px-3 py-1.5 text-sm bg-fluux-hover hover:bg-fluux-active text-fluux-text rounded transition-colors"
                    >
                      <FileDown className="size-3.5" />
                      {t('settings.encryption.externalExportAction')}
                    </button>
```

- Delete the dialog render (lines 1234-1239):

```tsx
      {showExternalExportDialog && (
        <ExternalKeyExportDialog
          onConfirm={handleExternalExportConfirm}
          onCancel={() => setShowExternalExportDialog(false)}
        />
      )}
```

- If `FileDown` is now unused after this edit, leave it — it is still used by the surviving "Export to file" button (line 1049). Do not remove the import.

- [ ] **Step 8: Delete the dialog component file**

```bash
git rm apps/fluux/src/components/ExternalKeyExportDialog.tsx
```

- [ ] **Step 9: Remove the `externalExport*` i18n keys from all locales**

Run this from the repo root (each `externalExport*` line is mid-object with a trailing comma, so a line delete keeps valid JSON):

```bash
cd apps/fluux/src/i18n/locales
for f in *.json; do
  grep -v '"externalExport' "$f" > "$f.tmp" && mv "$f.tmp" "$f"
done
cd -
# Verify every locale is still valid JSON and no externalExport key survives:
node -e "const fs=require('fs');for(const f of fs.readdirSync('apps/fluux/src/i18n/locales').filter(x=>x.endsWith('.json'))){const p='apps/fluux/src/i18n/locales/'+f;const s=fs.readFileSync(p,'utf8');JSON.parse(s);if(s.includes('externalExport'))throw new Error('externalExport survived in '+f)}console.log('all locales valid, externalExport removed')"
```

Expected: prints `all locales valid, externalExport removed` (no throw).

- [ ] **Step 10: Verify the deletion is clean**

```bash
cd apps/fluux && npx vitest run src/components/settings-components/EncryptionSettings.test.tsx src/e2ee/keyExportNaming.test.ts src/i18n/i18n.test.ts ; cd -
npm run typecheck
```

Expected: PASS. Typecheck confirms no dangling reference to `exportPrivateKeyToFile` / `ExternalKeyExportDialog` (the `DemoOpenPGPPlugin` implements `E2EEPlugin`, which never declared `exportPrivateKeyToFile`, so it is unaffected).

- [ ] **Step 11: Lint + commit**

```bash
npm run lint
git add -A
git commit -m "refactor(e2ee): remove raw private-key export (single backup export)"
```

---

### Task 5: Delete the raw private-key export (Rust)

**Files:**
- Delete: `apps/fluux/src-tauri/src/openpgp_export.rs`
- Modify: `apps/fluux/src-tauri/src/main.rs:202` (remove `mod openpgp_export;`) and `:1320` (remove the command registration)
- Modify: `apps/fluux/src-tauri/src/openpgp.rs` (remove the `export_private_key` method, lines ~374-390, and the `openpgp_export_private_key` command, lines ~828-837)

**Interfaces:**
- Consumes: nothing new.
- Produces: nothing — pure deletion.

- [ ] **Step 1: Delete the export module**

```bash
git rm apps/fluux/src-tauri/src/openpgp_export.rs
```

- [ ] **Step 2: Remove the module declaration and command registration in `main.rs`**

- Delete line 202: `mod openpgp_export;`
- Delete the registration line inside the `tauri::generate_handler!`/`invoke_handler` list (line 1320): `openpgp::openpgp_export_private_key,`

- [ ] **Step 3: Remove the method and command in `openpgp.rs`**

- Delete the `pub async fn export_private_key(...) { ... }` method (the block at lines ~374-390 that calls `crate::openpgp_export::export_tsk_as_private_key_block`).
- Delete the `#[tauri::command] pub async fn openpgp_export_private_key(...) { ... }` (lines ~828-837) and its preceding doc comment.

- [ ] **Step 4: Build to verify nothing references the removed symbols**

Run: `cd apps/fluux/src-tauri && cargo build`
Expected: builds cleanly — no `cannot find function openpgp_export_private_key` or `unresolved module openpgp_export`. If the build flags an unused import of `openpgp_export` anywhere, remove it.

- [ ] **Step 5: Run the Rust test suite**

Run: `cd apps/fluux/src-tauri && cargo test`
Expected: PASS. The 5 `openpgp_export` tests are gone with the module; the surviving `openpgp_backup` tests (incl. `imports_real_openkeychain_numeric9x4_backup`) and `openpgp` tests pass.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "refactor(e2ee): remove Rust raw private-key export command"
```

---

## Self-Review

**Spec coverage:**
- Single encrypted-backup export → Tasks 2 (export kept + header) and 4 (raw export removed, one button remains). ✅
- `Passphrase-Format` emit → Task 1 + Task 2. ✅
- Consume on import (mask selection, both sites) → Task 3. ✅
- Header only on file export, not PEP/server → Task 2 Step 7 guard test + `buildExportArmor` vs `backupEncrypt` split. ✅
- Value vocabulary `xep0373`/`bip39` from `USE_V6_KEYS` → Task 1 `currentPassphraseFormat`. ✅
- Deletions incl. `openpgp_export.rs` module + 5 tests → Task 5; `ExternalKeyExportDialog`, plugin methods, `externalExport*` i18n → Task 4. ✅
- `keyExportNaming` single kind → Task 4. ✅
- Tests: parser, header helper, first `exportKeyToFile`/`buildExportArmor` coverage, mask selection (dialog + ES), server-path no-header guard, naming, single-button, clean deletion → Tasks 1-5. ✅

**Placeholder scan:** No TBD/TODO; every code step shows complete code; every command has an expected result. ✅

**Type consistency:** `withPassphraseFormatHeader`/`parseArmorPassphraseFormat`/`currentPassphraseFormat` names are identical across Task 1 (def), Task 2 (base import), and Task 3 (UI import). `buildExportArmor` defined in Task 2 base, called by both plugins in Task 2, exposed as `callBuildExportArmor` in the Task 2 test. `keyExportFilename(jid)` single-arg defined in Task 4 Step 3 and called consistently in Step 4. ✅
