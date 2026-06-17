# Unified OpenPGP Key Export with Passphrase-Format Hint

Status: approved (design), pending implementation plan.
Date: 2026-06-17.

## Problem

The encryption settings expose **two** key-export buttons that produce **two
different file formats**, which is confusing and asymmetric:

| Button | Plugin method | File format | Consumers | Passphrase |
| --- | --- | --- | --- | --- |
| Export backup | `exportKeyToFile` | XEP-0373 §5 encrypted **MESSAGE** (SKESK) — the OpenKeychain shape | Fluux restore, other XMPP clients, OpenKeychain "restore backup" | generated XEP-0373 backup code (or BIP-39 under v6) |
| Export to external tool | `exportPrivateKeyToFile` | raw **PRIVATE KEY BLOCK** | `gpg --import`, Kleopatra, OpenKeychain "import key" — one step | free-form, or unprotected |

Separately, the import work in PR #565 (`project_e2ee_import_passphrase_mask`)
showed that OpenKeychain tags its backup with a `Passphrase-Format: numeric9x4`
armor header, and that **guessing** the passphrase input mask on import is a
recurring bug source (Bug 1: the XEP-0373 mask stripped `0`s and truncated a
foreign passphrase). Fluux emits no such header today.

## Goals

1. Collapse the two file exports into **one**, producing the OpenKeychain-style
   encrypted `.asc` (XEP-0373 §5 SKESK MESSAGE) — the format Fluux already
   restores from and that round-trips to other XMPP clients and OpenKeychain.
2. Tag the exported file with a `Passphrase-Format` armor header describing the
   passphrase family.
3. **Consume** that header (ours and OpenKeychain's `numeric9x4`) on import to
   select the passphrase input affordance instead of guessing — permanently
   retiring the mask-mismatch bug class.
4. Delete the now-unused raw private-key export end to end.

## Non-goals (follow-ups)

- Re-adding a raw `PRIVATE KEY BLOCK` export. gpg/Kleopatra users decrypt the
  backup first (`gpg --decrypt backup.asc | gpg --import`); this recipe should
  be documented but no UI carries it.
- A dedicated digit-only masked input for OpenKeychain's `numeric9x4` files.
  Free-text entry is byte-exact and correct; a tailored mask is optional polish.
- Emitting the header on the PEP **server** backup. PEP carries dearmored,
  Base64-encoded raw bytes (`base64EncodeOpenPgpBlock` dearmors), so any armor
  header is stripped in transit — the header lives only on the **file** export.

## Approach

Three decisions, settled during brainstorming:

- **Format:** single export = encrypted backup MESSAGE (not raw key, not a
  format-picker dialog).
- **Hint:** emit **and** consume.
- **Raw export:** delete fully.

A key simplification surfaced while verifying the dialogs: `BackupPassphraseDialog`
has **no custom-passphrase mode** — it only ever shows a *generated* code
(XEP-0373 code when `!USE_V6_KEYS`, BIP-39 words when `USE_V6_KEYS`). So the
export passphrase family is fully determined by `USE_V6_KEYS`; nothing needs to
be threaded from the dialog, and `exportKeyToFile`'s signature is unchanged.

## Design

### Export — add the armor header

`exportKeyToFile(passphrase)` survives unchanged in signature and remains *the*
export. The only change to the bytes is a new armor header line inserted
immediately after `-----BEGIN PGP MESSAGE-----`.

Header logic is **single-sourced in TypeScript** as a pure helper (sibling to
`armorDetect.ts`, e.g. `passphraseFormatHeader.ts` exporting both
`withPassphraseFormatHeader(armored): string` for emit and
`parseArmorPassphraseFormat(armored): string | null` for consume). Both
platforms' `exportKeyToFile` call the injector after they obtain the armored
message from `backupEncrypt`:

- **Web** (`WebOpenPGPPlugin.exportKeyToFile`): post-process the armored string
  returned by `backupEncrypt` before the browser download.
- **Desktop** (`SequoiaPgpPlugin.exportKeyToFile`): `backupEncrypt` returns the
  armored message from Rust; inject the header in TS before `writeTextFile`.
  **The Rust armorer is not touched for this** — keeping header logic in one
  place avoids diverging openpgp.js and Sequoia armor APIs and keeps the server
  (PEP) path byte-identical.

Header **key** is `Passphrase-Format` — the exact name OpenKeychain uses, so a
single parser reads both. Header **value** is derived from `USE_V6_KEYS`:

| Condition | Value emitted |
| --- | --- |
| `!USE_V6_KEYS` (v4 default) — XEP-0373 §5.4 backup code | `xep0373` |
| `USE_V6_KEYS` (v6) — BIP-39 word passphrase | `bip39` |

The values are Fluux-defined. Other tools (OpenKeychain, gpg) ignore unknown
values and prompt normally, so emission is one-directional and safe; we are the
primary consumer.

### Import — consume the header

A small pure parser `parseArmorPassphraseFormat(armored): string | null` reads
the header value (handles a leading BOM / `\r\n` like `armorDetect`).

The import-from-file flow (`mode="import"` on `RestorePassphraseDialog`, fed from
`pendingImportFileArmored` in `EncryptionSettings.tsx` and the equivalent in
`App.tsx`) parses the header and selects the input affordance:

| Header value | Input affordance |
| --- | --- |
| `xep0373` | masked XEP-0373 backup-code field (dashed `XXXX-XXXX-…`) |
| `bip39`, `numeric9x4`, any other value, or **absent** | free-text field (current import behavior; preserves the Bug-1 fix) |

Today `RestorePassphraseDialog` forces free text whenever `mode === 'import'`
(`useBackupCode = !isImport && isBackupCode`). The change lets a **known Fluux
format** (`xep0373`) re-enable the masked field even in import mode — strictly
better than today's always-free-text: Fluux's own exported files get the helpful
dashed mask, while foreign/headerless files stay unmasked (never stripping `0`s).
The exact prop shape (a new `backupCodeFormat` prop vs. making `isBackupCode`
authoritative over import mode) is an implementation detail for the plan.

**Unaffected paths:** server-restore and `OwnKeyConflictBanner` use
`mode="restore"`; the header never reaches them (PEP strips armor), so their
behavior is unchanged.

### Deletions (raw private-key export)

End-to-end removal, all references confirmed isolated to the one settings button:

- `exportPrivateKeyToFile` — abstract in `OpenPGPPluginBase.ts`, impls in
  `SequoiaPgpPlugin.ts` and `WebOpenPGPPlugin.ts`.
- `ExternalKeyExportDialog.tsx` (whole file).
- `EncryptionSettings.tsx`: `showExternalExportDialog` state, the
  `handleExternalExportConfirm` callback, the `<ExternalKeyExportDialog>` render,
  and the second export button.
- Rust: the entire `openpgp_export.rs` module (`export_tsk_as_private_key_block`
  + its 5 tests), the `openpgp_export_private_key` command (`openpgp.rs:829`), the
  `export_private_key` method (`openpgp.rs:374`, which only delegates to that
  module), and the registration in `main.rs:1320`.
- i18n: the `externalExport*` keys in every locale file under
  `apps/fluux/src/i18n/locales/`.

### Naming / UI

- `keyExportNaming.ts`: drop the `'openpgp-private-key'` kind. With one kind
  remaining, simplify the signature to `keyExportFilename(jid): string` returning
  `openpgp-backup-<jid>.asc`; update `keyExportNaming.test.ts`.
- The surviving export button is now the only one — relabel it to a single
  "Export key to file…" and drop any backup-vs-external distinction copy. New /
  changed i18n values translated into all locales (no English placeholders, no
  em-dash clause connectors).

### Security note

The header reveals the passphrase *family* in cleartext beside the ciphertext:
`xep0373` ⇒ ~121-bit alphanumeric code, `bip39` ⇒ 88-bit word list. Both are far
beyond brute-force and are already the app's visible defaults, so there is no
meaningful confidentiality loss. Because the export has no custom-passphrase
mode, we never advertise a potentially weaker user-chosen passphrase. This
matches OpenKeychain's existing behavior.

## Testing

Existing suites already cover the crypto/format/import core and are reused as-is:
`backupInterop.test.ts` (export wire format), `consumeMigrationVectors.test.ts`
(real OpenKeychain `numeric9x4` + TSK import, full decrypt round-trip),
`consumeSequoiaVectors.test.ts`, `armorDetect.test.ts`, `passphraseGenerator.test.ts`,
Rust `openpgp_backup.rs` (incl. `imports_real_openkeychain_numeric9x4_backup`),
and the `RestorePassphraseDialog` / `EncryptionSettings` import-mask tests. The
new work adds:

- **Parser** (`parseArmorPassphraseFormat`): reads Fluux `xep0373`, OpenKeychain
  `numeric9x4` (existing `openkeychain_numeric9x4_backup.asc` fixture), and
  returns `null` when absent / for a raw `PRIVATE KEY BLOCK`.
- **Header helper** (`withPassphraseFormatHeader`): inserts the line in the right
  place; idempotent / well-formed armor.
- **Export wrapper** (`exportKeyToFile`): **first direct test of this method** —
  the file-write wrappers have no coverage today, so this needs a harness that
  stubs the Tauri save dialog (desktop) / browser download (web) and asserts the
  emitted armor carries `Passphrase-Format: xep0373` (v4) / `bip39` (v6).
- **Round-trip (web):** export emits the header; re-importing that file selects
  the masked field for `xep0373`, free text for `bip39`.
- **Mask selection, two levels:** (a) a new `RestorePassphraseDialog` case —
  masked backup-code field in *import* mode when the format is `xep0373`, free
  text otherwise; (b) extend the `EncryptionSettings` "import-from-file passphrase"
  test for header-driven selection (the existing `numeric9x4`-verbatim case
  remains valid as the free-text branch and is the Bug-1 regression guard).
- **Server-path guard:** assert the PEP/server backup (`backupSecretKey`) armor
  carries **no** `Passphrase-Format` header — protects the byte-identical claim
  (header lives only on the file export).
- `keyExportNaming.test.ts`: updated for the simplified signature.
- **EncryptionSettings:** exactly one export button; no `ExternalKeyExportDialog`.
- **Deletion:** `openpgp_export.rs` and its 5 tests are removed with the module;
  the surviving `encrypt_tsk_to_passphrase` tests are untouched. No TS test
  references `exportPrivateKeyToFile` / `ExternalKeyExportDialog`, so the cut is
  clean.

## File reference index

- `apps/fluux/src/e2ee/passphraseFormatHeader.ts` (+ `.test.ts`) — **new** pure
  module: `withPassphraseFormatHeader` (emit) and `parseArmorPassphraseFormat`
  (consume), sibling to and following the `armorDetect.ts` pattern.
- `apps/fluux/src/e2ee/OpenPGPPluginBase.ts` — remove `exportPrivateKeyToFile`
  abstract.
- `apps/fluux/src/e2ee/WebOpenPGPPlugin.ts` — header on export; remove raw export.
- `apps/fluux/src/e2ee/SequoiaPgpPlugin.ts` — header on export; remove raw export.
- `apps/fluux/src/e2ee/keyExportNaming.ts` (+ `.test.ts`) — single kind.
- `apps/fluux/src/components/ExternalKeyExportDialog.tsx` — delete.
- `apps/fluux/src/components/RestorePassphraseDialog.tsx` — allow a known Fluux
  format to drive the masked field in import mode.
- `apps/fluux/src/components/settings-components/EncryptionSettings.tsx` — remove
  second export button + handler + dialog; parse header at the import site;
  relabel the export button.
- `apps/fluux/src/App.tsx` — parse header at its import-file site.
- `apps/fluux/src-tauri/src/openpgp_export.rs` — **delete** the whole module
  (export logic + 5 tests).
- `apps/fluux/src-tauri/src/openpgp.rs`, `main.rs` — remove the
  `export_private_key` method + `openpgp_export_private_key` command + registration.
- `apps/fluux/src/i18n/locales/*.json` — remove `externalExport*`; relabel export.
