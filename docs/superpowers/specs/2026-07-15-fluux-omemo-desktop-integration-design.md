# OMEMO Desktop Integration (Milestone 2, sub-project M2b)

**Date:** 2026-07-15
**Status:** Approved (design) — pending implementation plan
**Branch:** `features/omemo`
**Depends on:** M2a — `@fluux/omemo-plugin` (`OmemoPlugin implements E2EEPlugin`, id `omemo:2`, securityLevel 80), body-level interop validated vs twomemo. Complete, headless, wired to nothing yet.

> Sensitive strategic context lives in `private/E2EE_PLUGIN_ARCHITECTURE.md`. Keep public artifacts free of strategy detail.

## Background

M2a delivered the headless OMEMO adapter (`@fluux/omemo-plugin`) on top of the cleanroom TS crypto core (`@fluux/omemo`). It is not referenced anywhere in `apps/fluux/src` — zero registration, zero storage wiring, zero UI. This sub-project makes **encrypted OMEMO 1:1 actually work in the desktop (Tauri) app**.

The app already has a mature, protocol-agnostic E2EE host and a real OpenPGP plugin (`SequoiaPgpPlugin` desktop / `WebOpenPGPPlugin` web). Milestone #2's job is to register a *second* plugin (OMEMO) and provide what it needs — it is NOT to build the host.

**Why desktop-first (not web):** the strategy invariant is "web never generates identity material" — a compromised first-load web bundle could choose the OMEMO root identity, and no CSP/SRI defends against that. OMEMO identity keygen in a browser crosses that invariant, so **OMEMO ships desktop-first; web OMEMO is out of scope** for this slice.

## Locked-in decisions (from the brainstorming session)

1. **Desktop-first.** Register + ship OMEMO on Tauri; web OMEMO out of scope (identity-keygen invariant).
2. **Tier-1 Rust hardening only.** The whole OMEMO crypto (X3DH + Double Ratchet + payload cipher + SCE) stays in **TypeScript** on every platform — one cleanroom, interop-validated engine. Rust owns only a thin **seal/unseal** boundary: a keychain-backed at-rest store. Identity keygen and the ratchet run in TS; Rust seals their output at rest. (A full Tier-2 Rust engine remains a deliberate future option — the `@fluux/omemo` content-agnostic `encrypt(recipients, content)`/`decrypt(senderJid, sid, msg)` API is the preserved seam for it.)
3. **Generic keychain `StorageBackend`.** The new Rust KV backend is protocol-agnostic (reusable; doubles as the Tier-2 seam), not OMEMO-cert-shaped.
4. **Coexistence:** `omemoEnabled` opt-in, **off by default**; the SDK's existing `securityLevel` ranking auto-prefers OMEMO (80) over OpenPGP (30) when both are enabled and the peer supports OMEMO; a **one-time protocol-switch notice** fires when a conversation flips `openpgp → omemo:2`.

## Component 1 — Registration refactor

`apps/fluux/src/e2ee/registerPlugins.ts` is single-OpenPGP-hardcoded today: `registerE2EEPlugins` gates on `isOpenpgpEnabled()`, guards on `getPlugin('openpgp')`, and `unregisterE2EEPlugins` calls `unregister('openpgp')`. Generalize to **a list of independently-gated plugins**:

- Add an `omemoEnabled` setting to `apps/fluux/src/stores/encryptionSettingsStore.ts` (parallel to `openpgpEnabled`, persisted, **default false**), with an `isOmemoEnabled()` accessor and a toggle surfaced in `EncryptionSettings.tsx`.
- Refactor `registerE2EEPlugins(client)` to iterate over a small registry of `{ id, isEnabled(), makePlugin(platform), needsStorageBackend }` entries. For each enabled entry not already registered (`getPlugin(id)` check per-id), register it. OMEMO's entry: enabled on Tauri when `isOmemoEnabled()`, requires the keychain `StorageBackend` (Component 2). OpenPGP's entry preserves today's exact behavior (its own Rust/web crypto, no generic StorageBackend on desktop).
- `unregisterE2EEPlugins` unregisters per-id for whichever plugins are toggled off (no hardcoded `'openpgp'`).
- Add `EME_NAMESPACE_PLUGIN_IDS['urn:xmpp:omemo:2'] = 'omemo:2'` in `packages/fluux-sdk/src/core/e2ee/stanzaDecrypt.ts` so an inbound OMEMO stanza is *claimed and decrypted*, not classed "unsupported" (the EME *name* map already recognizes `urn:xmpp:omemo:2`).
- Add the `chat.encryption.tooltip.protocol.omemo:2` (and any `chat.encryption` OMEMO copy) i18n keys across all locales (the per-message lock already falls back to the raw id).

## Component 2 — Tier-1 Rust keychain `StorageBackend` (load-bearing new infra)

Today desktop has **no generic secure storage**: `SequoiaPgpPlugin` owns bespoke Rust persistence and never touches `ctx.storage`, and `registerPlugins.ts` never calls `client.setE2EEStorageBackend` on Tauri — so the generic path defaults to `InMemoryStorageBackend` (`XMPPClient.ts` constructor). A registered `OmemoPlugin` on desktop would therefore **lose every identity/session/prekey on restart**. This component builds the missing backend.

- **Rust side** (`apps/fluux/src-tauri/src/`): a new module exposing generic keyed-KV Tauri commands — `e2ee_store_get(account, key) -> bytes|null`, `e2ee_store_put(account, key, bytes)`, `e2ee_store_delete(account, key)`, `e2ee_store_list(account, prefix) -> string[]`. Each stored value is **AEAD-sealed** with a per-account master key held in the OS keychain (`keyring::Entry`), following the existing `openpgp_storage.rs` pattern (Argon2/S2K envelope, `keyring` for the key, `0600` file-backed store) but **generalized to arbitrary keys/values**, namespaced by account JID. On platforms where the keychain is unavailable (mostly Linux), fall back to a passphrase-wrapped file with a persistent UI warning (reuse the strategy doc's keychain-fallback posture).
- **TS side** (`apps/fluux/src/e2ee/`): `TauriKeychainStorageBackend implements StorageBackend` (the SDK interface: `get/put/delete/list`) that calls the four commands via `@tauri-apps/api` `invoke`, threading the account JID.
- **Wiring**: in `registerPlugins.ts` on Tauri, before registering `OmemoPlugin`, `client.setE2EEStorageBackend(new TauriKeychainStorageBackend(accountJid))`. `createPluginStorage` already namespaces per plugin id (`e2ee/omemo:2/…`), so OMEMO's records land under a stable, sealed prefix.
- **Boundary note (Tier-2 seam):** this backend is generic and OMEMO-agnostic. It is the same seam a future Tier-2 Rust engine (or an OpenPGP migration off its bespoke store) would use. Documented here; not built.

## Component 3 — Coexistence + protocol-switch notice

- `omemoEnabled` opt-in drives registration (Component 1). The SDK's `E2EEManager.selectStrategy` already ranks mutually-supported plugins by `securityLevel` (OMEMO 80 > OpenPGP 30) and never falls back to plaintext — so when OMEMO is enabled and the peer supports it, OMEMO is chosen automatically. **No SDK selection change.**
- **Protocol-switch notice:** add a small `protocolSwitchStore` (app store) that records, per peer, the last-seen selected `protocolId`. When a conversation's selected strategy changes from `openpgp` to `omemo:2`, surface a **one-time, dismissible notice** (a composer/header banner, modeled on `keyChangeAlertsStore`) explaining the switch — so a previously OpenPGP-*verified* peer dropping to OMEMO-*tofu* is not silent. Dismissal is persisted per peer.

## Component 4 — Composer / lock UI wiring (minimal generalization)

`apps/fluux/src/hooks/useConversationEncryptionState.ts` is OpenPGP-shaped (hardcodes `getPlugin('openpgp')`, single-fingerprint stores, `keyLocked`). Generalize the minimum:

- Query the **selected** plugin for the conversation (via the manager / `selectStrategy`) rather than hardcoding `'openpgp'`, and produce the `encrypted`/`checking`/`unsupported`/`plaintextForced` states for whichever protocol is active. For OMEMO, `encrypted` carries the peer's **aggregate trust** from `OmemoPlugin.getPeerTrust` (tofu/verified/untrusted) rather than a single fingerprint.
- OpenPGP-only states (`keyLocked`, pinned-fingerprint `blocked`, cert-rejection `rejected`) branch on `protocolId` and simply don't apply to OMEMO in this slice.
- The **per-message lock is already protocol-agnostic** (`MessageSecurityContext.protocolId` → `messageTrust.ts` → `trustVisual.ts`); it only needs the `omemo:2` tooltip i18n from Component 1. No per-message rendering change beyond i18n.
- **Full per-device BTBV verification UI and device management are M2c** — this slice shows *that* a chat is OMEMO-encrypted and its aggregate trust, not per-device fingerprints.

## Error handling & edge cases

- **Keychain unavailable** (Linux without Secret Service) → passphrase-wrapped file fallback + a persistent UI warning; never store OMEMO secrets in plaintext.
- **Store read/write failure** → `OmemoPlugin.probePeer`/`ensureIdentity` fail; the host's existing send-policy path handles it (never silent plaintext).
- **Restart persistence** (the payoff): after enabling OMEMO and exchanging a message, an app restart MUST restore the sealed store so identity + established Double-Ratchet sessions survive — this is the concrete difference from today's `InMemoryStorageBackend` default.
- **Both plugins active on the same peer**: OMEMO wins (securityLevel); the switch notice (Component 3) covers the UX; OpenPGP remains for OMEMO-less peers.

## Testing & verification

- **Rust unit tests** for the keychain KV backend: seal/unseal round-trip (values with 0x00/0xff bytes), per-account namespacing (account A's keys invisible to account B), missing-key → null, delete, `list(prefix)`, and the keychain-absent file fallback.
- **TS unit tests**: the registration refactor (multi-plugin registration; `omemoEnabled` gate on/off; per-id idempotency; `unregister` per-id; `EME_NAMESPACE_PLUGIN_IDS` includes `omemo:2`); `TauriKeychainStorageBackend` against a mocked `invoke`; `useConversationEncryptionState` OMEMO branch (encrypted/checking/unsupported); the `protocolSwitchStore` transition logic.
- **Manual E2E gate (the real proof, not automatable here):** `npm run tauri:dev`, enable OMEMO in settings, exchange an encrypted 1:1 with a live ejabberd account and a second OMEMO client (Conversations or a second Fluux instance), verify the message shows the OMEMO lock and decrypts, and **confirm the session survives an app restart** (sealed-store payoff). The body-level *crypto* interop is already proven at the plugin level (M2a vs twomemo); this gate validates app wiring + at-rest persistence, not the crypto.

## Out of scope (YAGNI)

Web OMEMO (identity-keygen invariant); per-device fingerprint/verification UI + device management + the per-conversation protocol picker (**M2c**); MUC/group OMEMO (`Chat.ts` is 1:1-only, matches `groupChat:false`); the Tier-2 full-Rust engine (seam preserved, not built); legacy `axolotl` bridge (milestone 3); migrating OpenPGP onto the generic keychain backend.

## Future work (recorded, not this spec)

- **M2c**: per-device BTBV verification UI (device id + fingerprint + trust each), device-management screen, and the per-conversation OpenPGP↔OMEMO protocol picker (wire the SDK's existing `setPinnedStrategy`).
- **Tier-2 desktop hardening** (deliberate later decision): move the whole `@fluux/omemo` engine behind the Rust boundary on desktop so per-message ratchet keys never touch the JS heap — via the content-agnostic `encrypt`/`decrypt` seam. This is a second cleanroom implementation (AGPL rules out libsignal-rust), maintained alongside the TS engine (web keeps TS); a strategic fork, not a tail task. The generic keychain backend (Component 2) is already the storage seam for it.
- **`@fluux/openpgp-plugin`**: extract the app-side OpenPGP plugin into a package adopting the M2a pattern (user-requested).
