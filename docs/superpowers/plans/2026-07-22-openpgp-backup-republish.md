# OpenPGP Backup Re-publish Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a user re-publish their XEP-0373 secret-key backup at any time, including when the local marker says it is already in sync with the server.

**Architecture:** UI-only change in `apps/fluux`. The backup/restore button row stops being hidden by the `inSync` derived boolean and renders whenever the server probe has settled. Because publishing always overwrites the server blob *and* always mints a fresh passphrase, the pre-publish confirmation widens from "a backup exists that this device did not create" to "a backup exists at all", with two copy variants selected by whether the local marker matches the current fingerprint.

**Tech Stack:** React 19 + TypeScript, Zustand, Vitest + @testing-library/react, i18next (33 locales).

**Spec:** [docs/superpowers/specs/2026-07-22-openpgp-backup-republish-design.md](../specs/2026-07-22-openpgp-backup-republish-design.md)

## Global Constraints

- **Scope is UI only.** Do not modify `apps/fluux/src/e2ee/**`, the SDK, or any Rust. If a change seems to require it, stop and re-read the spec — §4 explains why the plugin layer is deliberately untouched.
- **Do not remove or alter heal-on-restore.** `healLegacyBackupEncoding` and `backupImportAllWithLegacyFallback` in `OpenPGPPluginBase.ts` stay exactly as they are.
- **Do not change backup encryption bytes.** `consumeSequoiaVectors.test.ts` and `consumeMigrationVectors.test.ts` must pass without regenerating golden vectors.
- **All 33 locales** in `apps/fluux/src/i18n/locales/` get every new key. The full list: `ar be bg ca cs da de el en es et fi fr ga he hr hu is it lt lv mt nb nl pl pt ro ru sk sl sv uk zh-CN`.
- **Locale files:** 4-space indent, trailing newline. Edit by parse → mutate → `JSON.stringify(data, null, 4) + "\n"`. Never hand-edit the JSON text.
- **No em-dash connectors in user-facing copy.** Use a comma, a colon, or a full stop.
- **No hardcoded Tailwind palette colors** (`red-500`, `green-600`, …) in `EncryptionSettings.tsx`. An existing test greps the source for `/(?:red|green|yellow)-\d{2,3}/` and asserts zero matches. Use `fluux-` design tokens.
- **Before every commit:** tests pass with no stderr, `npm run typecheck` passes, `npm run lint` passes.

## Preflight (run once, before Task 1)

This worktree has no `node_modules`. A symlink to the main checkout would resolve `@fluux/sdk` to the wrong branch, so install *inside* the worktree.

- [ ] **Install and build the SDK**

```bash
cd /Users/mremond/AIProjects/fluux-messenger/.claude/worktrees/openpgp-gajim-passphrase-52a1af && npm install && npm run build:sdk
```

Expected: install completes, `packages/fluux-sdk/dist/` exists. This takes a few minutes.

- [ ] **Confirm the app suite runs green before you change anything**

```bash
cd /Users/mremond/AIProjects/fluux-messenger/.claude/worktrees/openpgp-gajim-passphrase-52a1af/apps/fluux && npx vitest run src/components/settings-components/EncryptionSettings.test.tsx
```

Expected: PASS, 10 tests. If this fails, stop — the baseline is broken and nothing below is trustworthy.

**Note on shell state:** the Bash working directory persists between calls, so every command below is written from an absolute path. Do not assume you are where the previous step left you.

---

## File Structure

| File | Responsibility | Change |
|---|---|---|
| `apps/fluux/src/i18n/locales/*.json` (33) | User-facing copy | Add 3 keys under `settings.encryption` |
| `apps/fluux/src/components/settings-components/EncryptionSettings.tsx` | Backup section UI + confirm routing | Row visibility, confirm-variant state, dialog render |
| `apps/fluux/src/components/settings-components/EncryptionSettings.test.tsx` | Behaviour lock | Add one `describe` block |

No new files. No file is large enough to warrant splitting.

---

## Task 1: Add the confirm-variant copy to all 33 locales

Ships independently: adding unused keys is inert, and it means Task 2 never renders a raw key string.

**Files:**
- Modify: `apps/fluux/src/i18n/locales/en.json` and the other 32 locale files

**Interfaces:**
- Consumes: nothing
- Produces: three i18n keys under `settings.encryption`, referenced by Task 2:
  - `backupReplaceOwnTitle`
  - `backupReplaceOwnMessage`
  - `backupReplaceOwnAction`

- [ ] **Step 1: Add the English copy**

Insert into `apps/fluux/src/i18n/locales/en.json` under `settings.encryption`, immediately after `backupConflictAction`, using the parse/mutate/stringify rule from Global Constraints:

```json
"backupReplaceOwnTitle": "Replace your backup?",
"backupReplaceOwnMessage": "A new passphrase will be generated and your server backup re-encrypted with it. The passphrase you saved for the current backup will stop working, including in any other client you set it up in. Your key itself is unchanged.",
"backupReplaceOwnAction": "Replace backup"
```

- [ ] **Step 2: Translate into the other 32 locales**

Translate all three strings into each remaining locale. Match the register of the neighbouring `backupConflict*` keys already in that file, which are the closest existing analogue. Reuse each locale's established vocabulary for "passphrase" and "backup" rather than inventing new terms: check what `backupConflictMessage` and `rotateConfirmMessageWithBackup` already use in that file.

No em-dash connectors. For reference, the French `backupConflictMessage` uses "phrase secrète" while `rotateConfirmMessageWithBackup` uses "phrase de passe" — prefer whichever term dominates in that locale's backup copy, and be internally consistent within the three new strings.

- [ ] **Step 3: Verify every locale has all three keys**

```bash
cd /Users/mremond/AIProjects/fluux-messenger/.claude/worktrees/openpgp-gajim-passphrase-52a1af/apps/fluux && node -e "
const fs=require('fs');const d='src/i18n/locales';
const need=['backupReplaceOwnTitle','backupReplaceOwnMessage','backupReplaceOwnAction'];
let bad=0;
for(const f of fs.readdirSync(d).filter(f=>f.endsWith('.json'))){
  const e=JSON.parse(fs.readFileSync(d+'/'+f,'utf8')).settings.encryption;
  const miss=need.filter(k=>typeof e[k]!=='string'||!e[k].trim());
  if(miss.length){console.log(f,'MISSING',miss.join(','));bad++}
  const em=need.filter(k=>typeof e[k]==='string'&&e[k].includes(String.fromCharCode(8212)));
  if(em.length){console.log(f,'EM-DASH',em.join(','));bad++}
}
console.log(bad?'FAIL':'OK all 33 locales');
"
```

Expected: `OK all 33 locales`

- [ ] **Step 4: Verify formatting survived**

```bash
cd /Users/mremond/AIProjects/fluux-messenger/.claude/worktrees/openpgp-gajim-passphrase-52a1af && git diff --stat apps/fluux/src/i18n/locales/
```

Expected: exactly 33 files changed, each `+3` insertions and `-1/+1` on the preceding line (the comma). If a file shows hundreds of changed lines, the indent or key order was destroyed — revert that file and redo it with the parse/mutate/stringify rule.

- [ ] **Step 5: Commit**

```bash
cd /Users/mremond/AIProjects/fluux-messenger/.claude/worktrees/openpgp-gajim-passphrase-52a1af
git add apps/fluux/src/i18n/locales/
git commit -m "i18n(encryption): add copy for replacing your own key backup"
```

---

## Task 2: Render the backup row unconditionally and route the confirm variant

**Files:**
- Modify: `apps/fluux/src/components/settings-components/EncryptionSettings.tsx`
- Test: `apps/fluux/src/components/settings-components/EncryptionSettings.test.tsx`

**Interfaces:**
- Consumes: the three i18n keys from Task 1
- Produces: nothing consumed by later tasks (this is the last task)

- [ ] **Step 1: Write the failing tests**

Append this `describe` block inside the top-level `describe('EncryptionSettings PEP support', …)` in `EncryptionSettings.test.tsx`, after the `import-from-file passphrase` block and before the `Aurora color tokenization` block:

```tsx
  // The backup row used to be hidden once the local marker matched the
  // current fingerprint, which made "in sync" a dead end: a backup encoded
  // by Fluux <=0.17.1 (legacy-normalized passphrase, #1021) sits behind a
  // green status line that no other XEP-0373 client can open, with no way
  // to re-publish it. The row now always renders, and because publishing
  // mints a FRESH passphrase, replacing an existing backup is confirmed.
  describe('re-publishing an in-sync backup', () => {
    const FP = 'AAAABBBBCCCCDDDDEEEEFFFF0000111122223333'
    const mockBackupSecretKey = vi.fn<(pp: string) => Promise<void>>()

    beforeEach(() => {
      vi.clearAllMocks()
      localStorage.clear()
      mockStatus = 'online'
      mockCheckPepSupport.mockResolvedValue(true)
      mockBackupSecretKey.mockResolvedValue(undefined)
      mockPlugin = {
        getOwnFingerprint: () => FP,
        // Marker matches the live fingerprint => the UI considers local and
        // server in sync, which is exactly the state that used to hide the row.
        getBackedUpFingerprint: () => FP,
        hasSecretKeyBackup: vi.fn().mockResolvedValue(true),
        backupSecretKey: mockBackupSecretKey,
      }
      useEncryptionSettingsStore.setState({
        openpgpEnabled: true,
        pluginRegisteredAt: 1,
        registrationError: null,
      })
    })

    it('offers the backup button even while in sync', async () => {
      render(<EncryptionSettings />)

      // Precondition: we really are in the in-sync state, not merely unprobed.
      await screen.findByText('settings.encryption.backupStatusInSync')

      expect(
        screen.getByRole('button', { name: 'settings.encryption.backupAction' }),
      ).toBeInTheDocument()
    })

    it('offers the restore button even while in sync', async () => {
      render(<EncryptionSettings />)

      await screen.findByText('settings.encryption.backupStatusInSync')

      expect(
        screen.getByRole('button', { name: 'settings.encryption.restoreAction' }),
      ).toBeInTheDocument()
    })

    it('confirms with the own-backup copy, not the foreign-backup copy', async () => {
      render(<EncryptionSettings />)

      const backupButton = await screen.findByRole('button', {
        name: 'settings.encryption.backupAction',
      })
      fireEvent.click(backupButton)

      expect(
        screen.getByText('settings.encryption.backupReplaceOwnTitle'),
      ).toBeInTheDocument()
      expect(
        screen.queryByText('settings.encryption.backupConflictTitle'),
      ).not.toBeInTheDocument()
    })

    it('does not publish until the confirmation is accepted', async () => {
      render(<EncryptionSettings />)

      const backupButton = await screen.findByRole('button', {
        name: 'settings.encryption.backupAction',
      })
      fireEvent.click(backupButton)

      await screen.findByText('settings.encryption.backupReplaceOwnTitle')
      expect(mockBackupSecretKey).not.toHaveBeenCalled()
    })

    it('uses the foreign-backup copy when the marker does not match', async () => {
      // Server holds a backup this device did not publish.
      mockPlugin!.getBackedUpFingerprint = () => null

      render(<EncryptionSettings />)

      const backupButton = await screen.findByRole('button', {
        name: 'settings.encryption.backupAction',
      })
      fireEvent.click(backupButton)

      expect(
        screen.getByText('settings.encryption.backupConflictTitle'),
      ).toBeInTheDocument()
      expect(
        screen.queryByText('settings.encryption.backupReplaceOwnTitle'),
      ).not.toBeInTheDocument()
    })
  })
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
cd /Users/mremond/AIProjects/fluux-messenger/.claude/worktrees/openpgp-gajim-passphrase-52a1af/apps/fluux && npx vitest run src/components/settings-components/EncryptionSettings.test.tsx -t "re-publishing an in-sync backup"
```

Expected: 4 of 5 FAIL. `offers the backup button even while in sync`, `offers the restore button even while in sync`, `confirms with the own-backup copy…`, and `does not publish until…` all fail with a testing-library "Unable to find an accessible element with the role button and name settings.encryption.backupAction" error, because the row is still hidden by `!inSync`.

`uses the foreign-backup copy when the marker does not match` should already PASS — that path renders today. If it fails, the test fixture is wrong, not the implementation; fix the fixture before continuing.

- [ ] **Step 3: Add the confirm-variant key map**

At module scope in `EncryptionSettings.tsx`, after the imports and before the component, add:

```tsx
/**
 * Copy for the pre-publish confirmation. Publishing always overwrites the
 * server blob AND always mints a fresh passphrase, so both variants are
 * destructive; they differ only in what the user is losing.
 *   own     — this device published the current backup. The passphrase the
 *             user saved (and may have configured in other clients) dies.
 *   foreign — the server copy came from somewhere else. Whoever holds ITS
 *             passphrase loses access.
 */
const BACKUP_CONFIRM_KEYS = {
  own: {
    title: 'settings.encryption.backupReplaceOwnTitle',
    message: 'settings.encryption.backupReplaceOwnMessage',
    action: 'settings.encryption.backupReplaceOwnAction',
  },
  foreign: {
    title: 'settings.encryption.backupConflictTitle',
    message: 'settings.encryption.backupConflictMessage',
    action: 'settings.encryption.backupConflictAction',
  },
} as const

type BackupConfirmVariant = keyof typeof BACKUP_CONFIRM_KEYS
```

- [ ] **Step 4: Replace the boolean confirm state with the variant**

Find this state declaration and its comment (around line 78-84):

```tsx
  // Surfaced when the user clicks "Back up to server" while a backup
  // already lives on PEP for a fingerprint we don't have a local "this
  // device backed it up" marker for. Overwriting that backup is what
  // the user is asking for, but we want to confirm — the existing
  // ciphertext belongs to whoever knows ITS passphrase, and replacing
  // it makes that copy unrecoverable.
  const [showBackupConflictConfirm, setShowBackupConflictConfirm] = useState(false)
```

Replace with:

```tsx
  // Surfaced when the user clicks "Back up to server" while ANY backup
  // already lives on PEP. Publishing overwrites it and mints a fresh
  // passphrase, so the old code stops working either way; the variant
  // decides which consequence we spell out. null = no confirmation open.
  const [backupConfirmVariant, setBackupConfirmVariant] =
    useState<BackupConfirmVariant | null>(null)
```

- [ ] **Step 5: Widen the confirmation gate**

Replace `handleBackupRequest` and its doc comment (around line 599-618) with:

```tsx
  /**
   * Entry point for the "Back up to server" button. Publishing replaces
   * whatever is on the server and always generates a NEW passphrase
   * (BackupPassphraseDialog draws a fresh one on every open), so any
   * existing backup gets a confirmation first — the user is about to
   * invalidate a code they may have written down or configured in another
   * client. Which copy we show depends on whose backup it is: `own` when
   * our local marker says this device published the current one,
   * `foreign` otherwise (a sibling device, or a stale copy of an earlier
   * key). With nothing on the server there is nothing to lose, so we go
   * straight to the passphrase dialog.
   */
  const handleBackupRequest = useCallback(() => {
    if (remoteBackupExists !== true) {
      setShowBackupDialog(true)
      return
    }
    const isOwnBackup = !!backedUpFingerprint && backedUpFingerprint === fingerprint
    setBackupConfirmVariant(isOwnBackup ? 'own' : 'foreign')
  }, [remoteBackupExists, backedUpFingerprint, fingerprint])
```

- [ ] **Step 6: Render the row unconditionally**

Find the row wrapper (around line 1090). Change:

```tsx
                  {!checking && !inSync && (
                    <div className="flex flex-wrap gap-2">
```

to:

```tsx
                  {!checking && (
                    <div className="flex flex-wrap gap-2">
```

Leave everything inside untouched, including the `{remoteBackupExists === true && (` guard on the restore button. Leave the status-line block above it untouched: `inSync` still drives which line shows.

Also update the stale comment in the same IIFE (around line 1054-1060), replacing:

```tsx
              //   inSync    → server has a backup AND it matches this
              //               device's current fingerprint (by our local
              //               marker). Buttons are redundant.
              //   outOfSync → backup is missing, or present but for a
              //               different fingerprint — show backup, and
              //               show restore when something is there to
              //               restore from.
```

with:

```tsx
              //   inSync    → server has a backup AND it matches this
              //               device's current fingerprint (by our local
              //               marker).
              //   outOfSync → backup is missing, or present but for a
              //               different fingerprint.
              // The three states drive the STATUS LINE only. The buttons
              // render regardless: the marker records a fingerprint, not
              // the blob's encoding, so an in-sync backup can still be one
              // no other XEP-0373 client can open (#1021) and the user
              // needs a way to re-publish it.
```

- [ ] **Step 7: Render the confirm dialog from the variant**

Replace the `showBackupConflictConfirm` block (around line 1221-1233) with:

```tsx
      {backupConfirmVariant && (
        <ConfirmDialog
          title={t(BACKUP_CONFIRM_KEYS[backupConfirmVariant].title)}
          message={t(BACKUP_CONFIRM_KEYS[backupConfirmVariant].message)}
          confirmLabel={t(BACKUP_CONFIRM_KEYS[backupConfirmVariant].action)}
          variant="danger"
          onConfirm={() => {
            setBackupConfirmVariant(null)
            setShowBackupDialog(true)
          }}
          onCancel={() => setBackupConfirmVariant(null)}
        />
      )}
```

- [ ] **Step 8: Run the tests to verify they pass**

```bash
cd /Users/mremond/AIProjects/fluux-messenger/.claude/worktrees/openpgp-gajim-passphrase-52a1af/apps/fluux && npx vitest run src/components/settings-components/EncryptionSettings.test.tsx
```

Expected: PASS, 15 tests (10 pre-existing + 5 new), no stderr.

- [ ] **Step 9: Deliberate-break check**

Hollow tests are the recurring defect in this area — assertions that cannot fail have shipped here before, and review alone has never caught them. Prove each new test can fail.

Break 1 — restore the old visibility rule. In `EncryptionSettings.tsx` change `{!checking && (` back to `{!checking && !inSync && (`, then:

```bash
cd /Users/mremond/AIProjects/fluux-messenger/.claude/worktrees/openpgp-gajim-passphrase-52a1af/apps/fluux && npx vitest run src/components/settings-components/EncryptionSettings.test.tsx -t "re-publishing an in-sync backup"
```

Expected: FAIL — `offers the backup button even while in sync`, `offers the restore button even while in sync`, `confirms with the own-backup copy…`, `does not publish until…`. Revert the break and re-run: PASS.

Break 2 — collapse the variant. Change `setBackupConfirmVariant(isOwnBackup ? 'own' : 'foreign')` to `setBackupConfirmVariant('foreign')`, then re-run the same command.

Expected: FAIL — `confirms with the own-backup copy, not the foreign-backup copy`. Revert and re-run: PASS.

If a test stays green under its break, it is hollow. Fix the test before continuing.

- [ ] **Step 10: Full verification**

```bash
cd /Users/mremond/AIProjects/fluux-messenger/.claude/worktrees/openpgp-gajim-passphrase-52a1af && npm test
```

Expected: all workspaces PASS, no stderr. Pay attention to `consumeSequoiaVectors.test.ts`, `consumeMigrationVectors.test.ts`, and the heal tests in `SequoiaPgpPlugin.test.ts` / `WebOpenPGPPlugin.test.ts` — these are the regression check that the encrypt path and heal-on-restore were left alone. If any of them fail, the change strayed outside the UI.

```bash
cd /Users/mremond/AIProjects/fluux-messenger/.claude/worktrees/openpgp-gajim-passphrase-52a1af && npm run typecheck && npm run lint
```

Expected: both PASS.

- [ ] **Step 11: Commit**

```bash
cd /Users/mremond/AIProjects/fluux-messenger/.claude/worktrees/openpgp-gajim-passphrase-52a1af
git add apps/fluux/src/components/settings-components/EncryptionSettings.tsx apps/fluux/src/components/settings-components/EncryptionSettings.test.tsx
git commit -m "fix(e2ee): allow re-publishing the OpenPGP key backup when in sync

The backup row was hidden once the local marker matched the current
fingerprint, so in-sync was a dead end. The marker records only a
fingerprint and cannot see the blob's encoding, so a backup written by
Fluux <=0.17.1 with the legacy-normalized passphrase (#1021) sat behind a
green status line that Gajim and other XEP-0373 clients could not open,
with no way to re-publish it.

The row now renders whenever the server probe has settled; the status line
keeps carrying the in-sync/mismatch/none distinction. Since publishing
overwrites the server copy and always mints a fresh passphrase, any
existing backup is confirmed first, with distinct copy for replacing your
own backup versus one this device did not create."
```

---

## Manual verification

Not automatable — it needs a real server and a second client. Run it before opening the PR.

- [ ] On an account whose backup predates 0.17.2, open Settings → Encryption. Confirm the status line reads green in-sync **and** the button row is present.
- [ ] Click "Back up to server". Confirm the dialog is the own-backup wording, not the foreign one. Accept, then save the new passphrase.
- [ ] Import the account into Gajim and confirm the backup opens with the displayed code. This is the interop check the whole change exists for.
- [ ] Separately, confirm "Restore from server" with the *old* code still works and still heals the blob without changing the passphrase — that path is untouched and must stay that way.
