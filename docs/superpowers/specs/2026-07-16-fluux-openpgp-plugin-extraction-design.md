# `@fluux/openpgp-plugin` Extraction (E2EE plugin packaging)

**Date:** 2026-07-16
**Status:** Approved (design) — pending implementation plan
**Branch:** `features/omemo`
**Depends on:** M2a/M2b (`@fluux/omemo-plugin` package pattern), M2c-1 (per-device verification + shared `TrustState`; established the optional `E2EEPlugin.listPeerIdentities?`/`setIdentityTrust?` seam this plugin will conform to in a LATER slice).

> Sensitive strategic context lives in `private/E2EE_PLUGIN_ARCHITECTURE.md`. Keep public artifacts free of strategy detail.

## Background

The OpenPGP E2EE plugin is the app's original, mature encryption backend: `SequoiaPgpPlugin` (desktop, Rust-Sequoia crypto over Tauri IPC), `WebOpenPGPPlugin` (web, openpgp.js + IndexedDB), both extending `OpenPGPPluginBase` (an 86 KB shared base). It lives inline in `apps/fluux/src/e2ee/`. OMEMO was built the modern way — a standalone `@fluux/omemo-plugin` package implementing the `E2EEPlugin` trait — so the app now has an **asymmetric** plugin architecture: OMEMO is a package, OpenPGP is app-inline.

This sub-project extracts OpenPGP into a standalone `@fluux/openpgp-plugin` package mirroring the `@fluux/omemo-plugin` pattern, so both protocols share a uniform package/trait structure. It is a **behavior-preserving structural refactor** — no user-visible change.

**Why not everything at once:** the base both *writes* six app Zustand/localStorage stores and its data is *read directly by the UI* (`verifiedPeerKeysStore`, `certRejectionStore`, `keyChangeAlertsStore`, `ownKeyConflictStore`, `pinnedPrimaryFingerprintsStore`, `trustStateStatusStore`). Moving that store data behind the plugin — plus implementing the `listPeerIdentities?`/`setIdentityTrust?` single-identity methods and routing OpenPGP through M2c-1's shared per-identity UI — is a large, higher-risk change that rewires ~10 UI consumers. That is the **next slice**. This slice does the extraction with the store data left app-side, reached through an injected adapter, so it stays behavior-preserving.

## Locked-in decisions (from the brainstorming session)

1. **Extraction only.** This spec produces the package and moves the plugin + helpers into it, with **zero behavior change**. It does NOT add the `listPeerIdentities?`/`setIdentityTrust?` trait methods and does NOT move any store data behind the plugin.
2. **Break the 6 store couplings via an injected `OpenPGPHostStores` adapter.** The package defines the interface; the plugin calls host state only through it; the app implements it (wiring to the real stores) at registration. Store data stays app-side; the UI keeps reading it exactly as today.
3. **Injection via the constructor** (mirroring `SequoiaPgpPlugin({ invoke })`), not by extending the SDK `PluginContext` (which is protocol-agnostic and must stay clean).
4. **Tauri file I/O becomes injected callbacks** so the package is platform-free (no `@tauri-apps/*` imports in the package).
5. **The trust-behind-the-plugin migration is the following slice** (retires M2c-1's temporary app-store/plugin-store asymmetry).

## Component 1 — Package scaffold

New `packages/openpgp-plugin/` (`@fluux/openpgp-plugin`, MIT), mirroring `packages/omemo-plugin/`:
- `package.json`: `"name": "@fluux/openpgp-plugin"`, `"type": "module"`, dual `main`/`module`/`types` → `dist/index.{cjs,js,d.ts}`, conditional `exports`, `"files": ["dist"]`, built with `tsup`, tested with `vitest`. Runtime deps: `@fluux/sdk: "*"` and `openpgp` (the version the app currently resolves; used only by the web class, dynamically imported). Dev deps mirror omemo-plugin (eslint/tsup/typescript/typescript-eslint/vitest).
- **No `@xmpp` ambient shim** — the base imports only `@fluux/sdk`/`@fluux/sdk/core` (`unwrapSigncrypt`, `wrapForSigncrypt`, `discoSupportsPep`, `getBareJid` + types), never `@xmpp/client`/`ltx` directly, so the omemo-plugin's `src/xmpp.d.ts` shim is not required. (If the implementation surfaces an `@xmpp/client` type dependency during extraction, add the same shim the omemo-plugin uses; otherwise omit it.)
- `src/index.ts` exports the public surface only:
  - Plugin classes: `SequoiaPgpPlugin`, `WebOpenPGPPlugin`.
  - `OPENPGP_DESCRIPTOR`, `classifyBoundaryError`.
  - PEP probe: `probeRemoteIdentityState`, `probeRemotePublishedFingerprints`, `SecretKeyBackupProbeError`.
  - Fingerprint utils: `fingerprintsEqual`, `toXep0373Fingerprint`, `pubkeyMetadataFingerprintAttrs`.
  - Shared types: `KeyBundle`, `RestoreResult`, `DecryptOutput`, `CertValidation`, `InvokeFn`, `SequoiaPgpPluginOptions`, `WebOpenPGPPluginOptions`, `OpenPGPHostStores`, `OpenPGPFileIO`.
  - Web recovery: `KeyPickerRequiredError`, `NoRecoveryAvailableError`.
  - Everything else (backup markers, passphrase format, user-id helpers, etc.) stays internal.

## Component 2 — What moves vs. stays

**Moves into `@fluux/openpgp-plugin/src/`:** `OpenPGPPluginBase.ts`, `SequoiaPgpPlugin.ts`, `WebOpenPGPPlugin.ts`, and the relative-imported helpers: `fingerprintCompare.ts`, `openpgpUserId.ts`, `keyExportNaming.ts`, `armorDetect.ts`, `backupMarker.ts`, `backupKeyMaterial.ts`, `passphraseFormatHeader.ts`, `passphraseGenerator.ts`, `secretKeyProbe.ts`, `verificationSync.ts`, `trustStateIntegrity.ts`, `recoveryErrors.ts`, `keyUnavailable.ts`, `webPassphraseStore.ts`, `webPassphraseCache.ts` — plus each file's colocated test.

**Stays app-side:** `EncryptionSettings.tsx`, `ContactProfileView.tsx`, `VerifyPeerDialog.tsx`, `UnlockEncryptionDialog.tsx`, `App.tsx`, `trustVisual.ts` (M2c-1 shared trust presentation — UI, not plugin logic), `encryptionSendError.ts`, `silentRestore.ts` (app orchestration that calls `plugin.unlock()`), `registerPlugins.ts`, `IndexedDBStorageBackend.ts`, and **the six stores** (`verifiedPeerKeysStore`, `certRejectionStore`, `keyChangeAlertsStore`, `ownKeyConflictStore`, `pinnedPrimaryFingerprintsStore`, `trustStateStatusStore`).

> Note on `silentRestore.ts`: it imports the plugin's web `unlock()` via the plugin instance, not a static import, so it stays app-side and calls through the registered plugin. Confirm during implementation whether it needs any package export beyond the plugin instance; if it only touches `webPassphraseCache`/`recoveryErrors`, those are package exports.

## Component 3 — The `OpenPGPHostStores` adapter (the load-bearing seam)

`OpenPGPPluginBase` today has eight `@/stores/*` imports; these are the only thing preventing it from compiling outside `apps/fluux/src`. The package defines an interface bundling exactly the store operations the base performs, and the base calls host state **only** through an injected instance of it. Store data stays in the app; the interface is the contract.

Derive the exact members by enumerating every call the base (and its moved helpers `verificationSync.ts`, `trustStateIntegrity.ts`) makes into those stores. The interface groups them by store, e.g.:

```ts
// packages/openpgp-plugin/src/hostStores.ts (exact members finalized against the real call sites)
export interface OpenPGPHostStores {
  verifiedPeers: {
    isVerified(jid: string, fingerprint: string): boolean
    getVerifiedFingerprint(jid: string): string | null
    setVerified(jid: string, fingerprint: string): void
    clearVerified(jid: string): void
    // whole-map read/write if verificationSync/trustStateIntegrity need it
  }
  certRejections: {
    record(jid: string, rejections: CertRejection[]): void
    clear(jid: string): void
  }
  keyChangeAlerts: { /* the exact methods the base calls */ }
  ownKeyConflict: { /* … */ }
  pinnedPrimaryFingerprints: { /* … */ }
  trustStateStatus: { /* … */ }
}
```

- **Injection:** the base constructor takes `{ hostStores }`; subclasses thread it (`SequoiaPgpPlugin({ invoke, hostStores, fileIO })`, `WebOpenPGPPlugin({ hostStores })`). `CertRejection` and related types the interface references are re-exported from the package (or the SDK where they already live).
- **App implementation:** `registerPlugins.ts` builds one `OpenPGPHostStores` object whose methods delegate to the real Zustand stores' imperative helpers (`isPeerVerified`, `setPeerVerified`, `recordCertRejections`, …), and passes it into the plugin constructor. This is the ONLY new app-side code of substance; it is a thin, mechanical delegation layer.
- **Result:** the six stores keep their app-side identity and localStorage keys; every existing UI subscription and every persisted value is untouched → behavior-preserving.

## Component 4 — Tauri file I/O injection

`SequoiaPgpPlugin.exportKeyToFile`/`pickKeyFile` dynamically import `@tauri-apps/plugin-dialog`/`plugin-fs`. To keep the package free of `@tauri-apps/*`:
- Add an `OpenPGPFileIO` interface to the desktop options: `{ saveFile(defaultName: string, bytes/armored): Promise<void>; pickFile(): Promise<string | null> }` (exact shapes matched to the current method bodies).
- `SequoiaPgpPlugin({ invoke, hostStores, fileIO })` uses `fileIO` for those two operations instead of importing Tauri.
- `registerPlugins.ts` supplies the Tauri-backed `fileIO` impl (the small current dynamic-import bodies move to the app registration site).

## Component 5 — App import rewiring + registration

- `registerPlugins.ts`: `import { SequoiaPgpPlugin, WebOpenPGPPlugin } from '@fluux/openpgp-plugin'`; construct with the new options (`hostStores`, and for desktop `invoke` + `fileIO`). The desktop/web branch structure is unchanged; only the construction args grow.
- Rewire every app consumer that imported from `apps/fluux/src/e2ee/<openpgp helper>` to import from `@fluux/openpgp-plugin`: `EncryptionSettings.tsx` (`probeRemoteIdentityState`, `classifyBoundaryError`), `ContactProfileView.tsx` / `useConversationEncryptionState.ts` / `MessageBubble.tsx` (`fingerprintsEqual`, `toXep0373Fingerprint`), `App.tsx` / `UnlockEncryptionDialog.tsx` (recovery-error types / plugin `unlock`), any others surfaced by grepping the moved files' old paths.
- Add `"@fluux/openpgp-plugin": "*"` to `apps/fluux/package.json` dependencies (npm workspace symlink; no reinstall needed if the workspace links it — same as the omemo-plugin dep add).
- Delete the moved files from `apps/fluux/src/e2ee/` once nothing imports them by the old path (grep to confirm zero stragglers).

## Error handling & edge cases

- **`classifyBoundaryError`** must produce byte-identical `{kind, code}` output post-move (it string-matches Rust/openpgp.js/XMPP error text) — its existing tests move with it and must stay green.
- **Fingerprint normalization** (`fingerprintsEqual`, Sequoia uppercase vs openpgp.js lowercase) is used by both the package and app UI — exported from the package, imported by the UI; a single source of truth, no duplication.
- **`hostStores` completeness:** if the interface misses a store method the base calls, the base won't compile — that is the desired forcing function (typecheck is the completeness gate). The plan derives members by enumerating actual call sites, not guessing.
- **No new persisted data / no key-material movement:** desktop keys stay in `src-tauri` (Rust); web keys stay in IndexedDB via `ctx.storage`; all six stores keep their localStorage keys. Nothing about at-rest state changes.

## Testing & verification

- **Package unit tests:** the moved plugin/helper tests run inside the package against a **mock `hostStores`** (an in-memory object implementing `OpenPGPHostStores`) and, for desktop, a **mock `invoke`** + mock `fileIO` — mirroring how `SequoiaPgpPlugin` tests already inject a mock `invoke`. `classifyBoundaryError`, `fingerprintCompare`, backup/passphrase-format, and `secretKeyProbe` tests come along and stay green.
- **App suite unchanged & green:** `EncryptionSettings`, `ContactProfileView`, `VerifyPeerDialog`, the Task-1 OpenPGP characterization net (`openpgpTrustRendering.regression.test.tsx`), and the OMEMO suites all pass without assertion changes — the extraction changes structure, not behavior.
- **Typecheck gate:** `npm run build -w @fluux/openpgp-plugin` then `npm run typecheck` clean across all workspaces. A clean typecheck proves the `hostStores`/`fileIO` interfaces are complete (the base has no remaining `@/` import).
- **Behavior parity:** because no store data moved and no UI read changed, the manual proof is light — desktop OpenPGP encrypt/decrypt + backup/restore + web unlock still work exactly as before (covered by existing tests; a quick `tauri:dev` smoke is the human gate, not automatable here).

## Out of scope (YAGNI / next slice)

- **`listPeerIdentities?`/`setIdentityTrust?` single-identity methods** and routing OpenPGP through M2c-1's shared per-identity UI path.
- **Moving `verifiedPeerKeysStore` (and/or the other stores') data behind the plugin** to retire the app-store/plugin-store asymmetry, and the ~10 UI-read rewires that entails.
- Any change to the Rust Sequoia crypto (`src-tauri`), the web openpgp.js crypto, backup/rotation/recovery behavior, or the OpenPGP UI.
- OMEMO changes.

## Future work (recorded, not this spec)

- **Trust-behind-the-plugin (the next slice):** implement `OpenPGPPluginBase.listPeerIdentities?`/`setIdentityTrust?` as single-identity (one `PeerIdentity` per peer from `getPeerFingerprint` + `getPeerTrust`), route `SecurityTab`/`ContactProfileView` OpenPGP through the shared per-identity path, and migrate `verifiedPeerKeysStore`'s data behind the plugin — retiring M2c-1's temporary asymmetry. The `OpenPGPHostStores` adapter from this slice becomes the seam that migration works against (some of its members disappear as their data moves inside the plugin).
- Consider whether `certRejectionStore` and the other alert stores also move behind the plugin, or remain host-owned UI state fed by the plugin.
