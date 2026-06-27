# Web passphrase 24h cache — design

Date: 2026-06-27
Status: Approved (ready for implementation plan)
Scope: `apps/fluux` (web platform only)

## Problem

On the web platform the OpenPGP key passphrase lives exclusively in JS module
memory ([webPassphraseStore.ts](../../../apps/fluux/src/e2ee/webPassphraseStore.ts)).
It is deliberately never persisted, so a page reload or tab close wipes it and
the user must re-enter the passphrase through the unlock dialog every session.
That is good for security but painful in daily use: a reload, a crash, or
reopening the browser forces a fresh passphrase entry.

We want an **opt-in** way to remember the passphrase on-device for 24 hours,
without regressing to a cleartext-on-disk model.

Desktop (Tauri) is unaffected: it already manages the key transparently via the
OS keychain and the Rust backend, and never shows the web unlock dialog.

## Decisions (locked during brainstorming)

- **Storage model:** encrypt the passphrase with a **non-extractable** WebCrypto
  AES-GCM key. Offline storage dumps cannot decrypt it.
- **Expiry:** fixed 24 hours from the moment of caching (not sliding).
- **Scope:** the checkbox appears in **unlock mode only** — not setup or restore.
- **Default checkbox state:** remember the user's last choice (persist the
  boolean preference only, never the passphrase).
- **Logout:** every deliberate logout clears the cache. The 24h cache is meant
  to survive reloads/reopens, not an explicit logout.

## Threat model (honest framing)

Today: passphrase in memory only → an attacker who dumps browser storage gets
the encrypted private key from IndexedDB but not the passphrase, so storage
compromise does not escalate to key compromise without user interaction.

With this feature, when the user opts in:

- The passphrase is stored **encrypted** under a non-extractable AES-GCM
  `CryptoKey`. The `CryptoKey` object persists in IndexedDB via structured
  clone, but `crypto.subtle.exportKey` cannot read its raw bytes. A passive
  offline storage dump or a devtools copy therefore yields only ciphertext it
  cannot decrypt.
- **Limit:** an attacker running live JavaScript on the page (XSS) could call
  `crypto.subtle.decrypt` with the stored key and recover the passphrase. This
  is not mitigated — but such an attacker could equally hook the unlock flow
  directly. The non-extractable key raises the bar against passive/offline
  reads, and the fixed 24h `expiresAt` bounds the exposure window.

This tradeoff is accepted and surfaced to the user in the checkbox sub-label.

## Architecture

### 1. Storage module — new `apps/fluux/src/e2ee/webPassphraseCache.ts`

A small single-purpose module, sibling to `webPassphraseStore.ts`. Public API:

- `cachePassphrase(jid: string, passphrase: string, ttlMs?: number): Promise<void>`
  - `ttlMs` defaults to 24h (`24 * 60 * 60 * 1000`).
  - Generates an AES-GCM 256-bit `CryptoKey` with `extractable: false`.
  - Random 12-byte IV via `crypto.getRandomValues`.
  - `crypto.subtle.encrypt` the UTF-8 passphrase.
  - Stores one record per bare JID: `{ jid, wrapKey, iv, ciphertext, expiresAt }`.
- `loadCachedPassphrase(jid: string): Promise<string | null>`
  - Reads the record. If absent → `null`.
  - If `Date.now() > expiresAt` → delete the record and return `null`.
  - Else `crypto.subtle.decrypt` → passphrase string. On any decrypt error,
    delete the record and return `null` (treat as unusable).
- `clearCachedPassphrase(jid: string): Promise<void>` — delete one record.
- `clearAllCachedPassphrases(): Promise<void>` — delete all records (CLI wipe).

Preference helpers (localStorage, **never** the passphrase):

- `getRememberPassphrasePreference(): boolean` — defaults to `false`.
- `setRememberPassphrasePreference(value: boolean): void`
  - Key: `fluux:openpgp:remember-passphrase`.

Storage backing:

- Dedicated IndexedDB database `fluux-e2ee-passphrase-cache`, single object
  store `cache` keyed by `jid`. Records hold the `CryptoKey` directly
  (structured clone preserves non-extractable keys). Keeping the wrap key and
  ciphertext together is acceptable: non-extractability — not key/ciphertext
  separation — is what defeats the offline-dump threat.

### 2. UI — `apps/fluux/src/components/UnlockEncryptionDialog.tsx`

- Render the checkbox **only when `mode === 'unlock'` and `!isTauri()`**.
- Initialize checked state from `getRememberPassphrasePreference()`.
- In `handleConfirm`, after `plugin.unlock(passphrase)` succeeds and before
  `onClose`:
  - `setRememberPassphrasePreference(checked)` (always — "remember last choice").
  - If checked → `await cachePassphrase(bareJid, passphrase)`.
  - If unchecked → `await clearCachedPassphrase(bareJid)` (unticking purges any
    prior cache for this account).
  - Cache on both `recovered` and non-recovered success outcomes.
- Bare JID: derive from `client` (e.g. `getBareJid(client.jid)`); the dialog
  already receives `client`.

Copy (English, source strings; real translations required in all 33 locales,
no em-dashes or en-dashes, presence enforced by `i18n.test.ts`):

- Label: **"Keep my passphrase on this device for 24 hours"**
- Sub-label (muted): **"Stored encrypted. Anyone with access to this device
  could use it until it expires."**

New i18n keys (proposed): `settings.encryption.rememberPassphrase` and
`settings.encryption.rememberPassphraseHint`.

### 3. Silent restore — `apps/fluux/src/App.tsx` (the connect handler, ~line 278)

Today the connect handler ends with:

```ts
if (!isTauri && isKeyLocked()) {
  openWebUnlockDialog()
}
```

This block is reached only after the recovery-routing checks above it have
returned early, so at this point there is a local key that is merely locked.
Replace it with an async restore attempt:

```ts
if (!isTauri && isKeyLocked()) {
  const cached = accountJid ? await loadCachedPassphrase(accountJid) : null
  if (cached) {
    try {
      const unlockPlugin = client.e2ee?.getPlugin('openpgp') as
        | { unlock?: (pp: string) => Promise<{ recovered: boolean }> }
        | null | undefined
      await unlockPlugin?.unlock?.(cached)
      // success: key unlocked silently, dialog stays closed
    } catch {
      if (accountJid) await clearCachedPassphrase(accountJid)
      openWebUnlockDialog()
    }
  } else {
    openWebUnlockDialog()
  }
}
```

- `accountJid` is already computed at the top of the handler
  (`jid.split('/')[0]`).
- `unlock()` sets the session passphrase, ensures identity, activates
  subscriptions, and notifies deferred decrypts on success; on failure it
  clears the session passphrase and throws. Catching every failure (including
  `KeyPickerRequiredError` / `NoRecoveryAvailableError`) and falling back to the
  interactive dialog keeps the user un-stranded when the cached passphrase is
  stale (e.g. the key was rotated).

### 4. Clearing on logout

- `apps/fluux/src/utils/performLogout.ts` — clear the cache on **every** logout,
  covering both the keep-data and clean-local-data paths. Add
  `clearCachedPassphrase(jid)` (the single logout chokepoint).
- `apps/fluux/src/utils/clearLocalData.ts` — for the CLI `--clear-storage` full
  wipe (`allAccounts`), call `clearAllCachedPassphrases()`; for the scoped path,
  `clearCachedPassphrase(scopedJid)`.

## Testing

New `apps/fluux/src/e2ee/webPassphraseCache.test.ts` (uses `fake-indexeddb` and
Node WebCrypto, same infra as `IndexedDBStorageBackend`):

- Encrypt/decrypt round-trip returns the original passphrase.
- Expired record (`expiresAt` in the past) → `loadCachedPassphrase` returns
  `null` and the record is deleted.
- `clearCachedPassphrase` / `clearAllCachedPassphrases` remove records.
- The raw passphrase string never appears in the stored record (serialize the
  record and assert the cleartext is absent).
- Preference helpers default to `false` and round-trip through localStorage.

Dialog coverage (`UnlockEncryptionDialog` test):

- Checkbox renders in unlock mode and not in setup/restore.
- Confirming with the box checked calls `cachePassphrase`; unchecked calls
  `clearCachedPassphrase`; preference is persisted either way.

## Out of scope (YAGNI)

- Sliding/rolling expiry.
- Caching in setup or restore modes.
- Any Tauri/desktop changes (desktop uses the OS keychain).
- A separate settings-pane toggle (the checkbox + remembered preference covers
  the need).

## Affected files

- New: `apps/fluux/src/e2ee/webPassphraseCache.ts`
- New: `apps/fluux/src/e2ee/webPassphraseCache.test.ts`
- Edit: `apps/fluux/src/components/UnlockEncryptionDialog.tsx`
- Edit: `apps/fluux/src/App.tsx`
- Edit: `apps/fluux/src/utils/performLogout.ts`
- Edit: `apps/fluux/src/utils/clearLocalData.ts`
- Edit: locale files under `apps/fluux/src/i18n/locales/` (33 `.json` files) +
  `apps/fluux/src/i18n/i18n.test.ts` expectations as needed.
