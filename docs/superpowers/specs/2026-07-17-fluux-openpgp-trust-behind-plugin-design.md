# OpenPGP Trust-Behind-the-Plugin — Design Spec

**Date:** 2026-07-17
**Branch:** `features/omemo` (long-running; becomes the 0.18.0 head)
**Status:** Approved design, ready for implementation planning
**Follow-up to:** `2026-07-16-fluux-omemo-per-device-verification-design.md` (M2c-1) and `2026-07-16-fluux-openpgp-plugin-extraction-design.md` (the structural extraction this builds on)

## Goal

Make the OpenPGP plugin a first-class conformant consumer of the shared per-identity trust API (`PeerIdentity` / `TrustState` / `listPeerIdentities` / `setIdentityTrust`) that OMEMO already implements, and move OpenPGP's verified-key data behind the plugin so each E2EE plugin owns its verified-marker state in its own `PluginStorage` under one shared fingerprint-bound pattern. This retires the temporary asymmetry M2c-1 left behind and removes the `hostStores.verifiedPeers` app↔plugin coupling entirely.

## Background & Motivation

M2c-1 unified the app's trust vocabulary onto the shared SDK `TrustState` and built per-device BTBV verification for OMEMO, routing OMEMO through the shared `PeerIdentity` API and the shared verify UI. OpenPGP was left conformant only at the *aggregate* level (`getPeerTrust`/`getDeviceTrust`) and was **not** wired into the per-identity API:

- OpenPGP does not implement `listPeerIdentities` / `setIdentityTrust`.
- `startVerification` throws `'verification UI not wired yet'`.
- The app-side verify UI (`SecurityTab`) and the encryption-state hook (`useConversationEncryptionState`) hard-gate the per-identity path on the literal string `protocolId === 'omemo:2'`, so the shared verify UI is OMEMO-only.
- OpenPGP's verified-key data lives app-side in a Zustand store (`verifiedPeerKeysStore`, localStorage `fluux-e2ee-verified-peers`) reached through an injected `hostStores.verifiedPeers` adapter, whereas OMEMO owns its verified data inside the plugin (`verifiedDevices.ts` over `PluginStorage`).

`features/omemo` is a long-running branch that becomes the 0.18.0 head, with a long alpha/beta window. This is the right place to take on a breaking storage migration: it can be validated on real data before 0.18.0 ships.

## Design Decisions (resolved during brainstorming)

1. **Plugin-owned data (full migration).** Each plugin owns its verified-marker data in its own `PluginStorage`. OpenPGP gets a `verifiedKeys.ts` parallel to OMEMO's `verifiedDevices.ts`. The `hostStores.verifiedPeers` group is deleted. Chosen over "keep data app-side" for long-term modularity — Fluux is intended as a reference client maintained for years.

2. **Revoke → TOFU for OpenPGP.** OpenPGP is single-key per peer. `setIdentityTrust(peer, id, 'untrusted')` maps to `clearVerified` (retract the out-of-band confirmation; the key returns to `trust: 'tofu'` and messaging continues via TOFU). No new persistent untrusted state, no new `encrypt()` gating. This preserves current OpenPGP behavior exactly and matches the natural meaning of "revoke verification." It differs from OMEMO (which persists an untrusted verdict), and that difference is intentional and documented.

3. **Hook unification.** `useConversationEncryptionState` routes OpenPGP trust through the plugin trait (`getPeerTrust` / `listPeerIdentities`), retiring the app-side fingerprint-comparison derivation (that crypto belongs in the plugin). `firstSeen` (new-contact hint, OpenPGP-only, via `isTofuNew`) is preserved unchanged. Because OpenPGP revoke→TOFU means its single identity is never all-untrusted, `needsDeviceVerification` correctly never fires for OpenPGP.

4. **Two-phase sequencing on one branch** (see Architecture).

## Global Constraints

- **Crypto core untouched.** No changes to `@fluux/omemo` or the Rust Sequoia crypto in `src-tauri`. No backup-byte changes → **no Sequoia interop vector regeneration**.
- **Behavior-preserving where stated.** OpenPGP rendering across the composer, ChatHeader, glance, and SecurityTab must remain visually identical, pinned by characterization tests (the M2c-1 Task-1 pattern). The single intentional behavior change: the hook may surface `trust: 'unknown'` (no cached key) where the old path forced `'tofu'`; both map to `calm`/muted in `trustStateVisual`, so the rendering is unchanged.
- **Shared trust vocabulary only.** Trust rendering changes go through `trustStateVisual` / `trustLabel` only. Do not reintroduce a parallel OpenPGP trust vocabulary.
- **SDK types unchanged.** `TrustState` and `PeerIdentity` are already protocol-generic; this slice adds no new SDK types. `listPeerIdentities?` / `setIdentityTrust?` are already-optional trait members.
- **Single `@xmpp` version.** No new independent `@xmpp/xml` pins (see repo convention).
- **Security invariants (Phase B) must be test-pinned** — see §Security Invariants.
- **Commits `--no-gpg-sign`** (sandbox ssh-agent broken; re-signed later from RustRover). Never push. No Claude footer in commits or PRs.

## Architecture

Two independently-reviewable phases, both on `features/omemo`. Phase A ends at a proven-green, behavior-preserving checkpoint; Phase B lands the security-sensitive storage move as a small focused diff on top.

### Phase A — Trait conformance (behavior-preserving, low risk)

Implement the per-identity trait for OpenPGP against the **existing** `hostStores.verifiedPeers` seam, and generalize the app-side consumers so they are capability-driven rather than `'omemo:2'`-gated. No storage change.

#### A1. `OpenPGPPluginBase` trait methods

Add to `packages/openpgp-plugin/src/OpenPGPPluginBase.ts`:

- **`listPeerIdentities(peer: BareJID): Promise<PeerIdentity[]>`**
  - If no key is cached for the peer (`getPeerFingerprint(peer)` is `null`), return `[]`.
  - Otherwise return a length-1 list: `[{ id: fp, fingerprint: fp, trust: await this.evaluatePeerTrust(peer) }]`, where `fp = getPeerFingerprint(peer)` (primary-key fingerprint hex). `id` equals the fingerprint (self-describing; stable per key).
- **`setIdentityTrust(peer: BareJID, id: string, decision: 'verified' | 'untrusted'): Promise<void>`**
  - Resolve the current cached fingerprint `cur = getPeerFingerprint(peer)`. If `cur` is `null`, no-op (nothing to verify).
  - Guard against TOCTOU: if `id` is non-empty and `!fingerprintsEqual(id, cur)`, no-op (the identity the caller intended to act on is no longer current).
  - `decision === 'verified'` → `this.hostStores.verifiedPeers.setVerified(peer, cur)`.
  - `decision === 'untrusted'` → `this.hostStores.verifiedPeers.clearVerified(peer)` (revoke → TOFU).
  - Idempotent.
- `getPeerTrust` / `getDeviceTrust` / `evaluatePeerTrust` / `encrypt` / pin / key-change-alert / own-key-conflict logic: **unchanged**.
- `startVerification`: left as-is unless the shared UI path requires it (the shared verify flow drives verify/revoke through `setIdentityTrust`, not `startVerification`; confirm during implementation and only touch it if the UI reaches it).

#### A2. `SecurityTab` generalization

`apps/fluux/src/components/contact-profile/tabs/SecurityTab.tsx`:

- Rename the OMEMO-specific `omemo` prop to a protocol-neutral `identities` prop with the same shape (`listPeerIdentities` / `onVerifyDevice` / `onRevokeDevice` / `reloadKey`).
- Rename `OmemoDeviceList` → `PeerIdentityList`; it renders any plugin's identities via `PeerIdentity` (already generic over `trustStateVisual` / `trustLabel` / `formatFingerprint`). For OpenPGP it renders the single key in the same list UI.
- Replace the hard `protocolId === 'omemo:2'` branch with a **capability check** (the `identities` prop is present ⇔ the selected plugin implements `listPeerIdentities`). Both OMEMO and OpenPGP flow through the same branch.
- Make the `contacts.encryption.omemo.*` i18n keys used by the list protocol-neutral (e.g. `contacts.encryption.identity.*`). Translate all 33 locales (surgical locale edits; parse → mutate → `stringify(,,4)+"\n"`).

#### A3. `useConversationEncryptionState` unification

`apps/fluux/src/hooks/useConversationEncryptionState.ts`:

- Route OpenPGP trust through the plugin trait: derive `encrypted.trust` from `getPeerTrust(peerJid)` (and, where the per-identity list is needed, `listPeerIdentities`), retiring the app-side verified-fingerprint-vs-cached-cert comparison.
- Preserve `firstSeen` (OpenPGP-only, via `isTofuNew` on `pinnedPrimaryFingerprintsStore`) unchanged — "new" is not a trust level.
- `needsDeviceVerification` stays OMEMO-only in effect (OpenPGP single identity is never all-untrusted), but the derivation should be expressed capability-generically (any plugin whose `listPeerIdentities` yields a non-empty all-untrusted set) rather than string-gated on `'omemo:2'`.
- Pin equivalence with characterization tests (extend/mirror the M2c-1 `openpgpTrustRendering.regression.test.tsx` net) so composer / ChatHeader / glance / SecurityTab render identically.

#### A4. `ContactProfileView` wiring

`apps/fluux/src/components/contact-profile/...`: pass OpenPGP conversations the same per-identity props (memoized `identities` handle) that OMEMO receives; verify → `VerifyPeerDialog` fingerprint compare → `setIdentityTrust(peer, id, 'verified')`; revoke → `setIdentityTrust(peer, id, 'untrusted')`.

### Phase B — Storage migration (security-sensitive, isolated)

Move OpenPGP verified-key data behind the plugin. The Phase A trait-method bodies get their storage backend swapped (hostStores → plugin store); method shapes and Phase A tests carry over unchanged.

#### B1. `verifiedKeys.ts` over `PluginStorage`

New `packages/openpgp-plugin/src/verifiedKeys.ts`, mirroring `packages/omemo-plugin/src/verifiedDevices.ts` but single-key:

- Storage key: `verified/<peer>` → the verified fingerprint hex (a single string value per peer, not a map).
- `loadVerified(storage, peer): Promise<string | null>` — defensive against corrupt/legacy blobs (returns `null`).
- `isVerified(storage, peer, fpHex): Promise<boolean>` — `fpHex` non-empty AND stored value `fingerprintsEqual` fpHex (fingerprint-binding: a changed key silently reverts to unverified).
- `setVerified(storage, peer, fpHex): Promise<void>`, `clearVerified(storage, peer): Promise<void>`, `hasVerified(storage, peer): Promise<boolean>`.

#### B2. Rewire trait methods + in-memory cache

- `OpenPGPPluginBase` holds an **in-memory verified-map cache** (`Map<peer, fpHex>`), loaded on init from `PluginStorage` and updated on every set/clear. This keeps the integrity-seal snapshot synchronous (see B3).
- `evaluatePeerTrust`, `listPeerIdentities`, `setIdentityTrust` read/write the cache + `verifiedKeys.ts` instead of `hostStores.verifiedPeers`.

#### B3. Integrity-seal rework

`packages/openpgp-plugin/src/trustStateIntegrity.ts` + its callers in `OpenPGPPluginBase`:

- The seal snapshots `verified: Record<string, string>` synchronously. Source that snapshot from the in-memory verified-map cache (B2) instead of `hostStores.verifiedPeers.getAll()`.
- The seal LOGIC (encrypt-to-self `TrustStateSnapshot`, reseal-on-mutation, `verifyTrustStateSeal`, `isTofuBlockedByCompromise`, the five `TrustStateStatus` outcomes) is **byte-identical** — only the data source moves.
- Reseal triggers move from the `verifiedPeers.subscribe` host-store subscription to the plugin's own set/clear mutation points.

#### B4. One-time migration

- At registration, if the plugin's `PluginStorage` has no verified data yet, the app seeds it once from `useVerifiedPeerKeysStore.getState().verifiedFingerprintByJid` via a plugin `migrateVerifiedKeys(map: Record<string, string>): Promise<void>` call.
- Idempotent and safe to re-run: migration only writes when the target is empty; it never overwrites plugin-owned data.
- After migration, the app stops writing the old store. The old localStorage key (`fluux-e2ee-verified-peers`, scoped) is read-only during the migration window, then removed.

#### B5. Delete the coupling

- Remove the `verifiedPeers` group from `OpenPGPHostStores` (`packages/openpgp-plugin/src/hostStores.ts`).
- Remove its adapter from `apps/fluux/src/e2ee/registerPlugins.ts`.
- Remove `apps/fluux/src/stores/verifiedPeerKeysStore.ts` and its `storeBindingKeys` entry (retain only whatever thin read the one-time migration needs, then delete once the migration seeds unconditionally on first run of 0.18.0 alpha).

## Data Flow

**Verify (both protocols, unified):** user opens ContactProfile → SecurityTab → `PeerIdentityList` calls `plugin.listPeerIdentities(peer)` → renders each `PeerIdentity` with `trustStateVisual(trust)` → user clicks Verify → `VerifyPeerDialog` fingerprint compare → `plugin.setIdentityTrust(peer, id, 'verified')` → (Phase A) `hostStores.verifiedPeers.setVerified` / (Phase B) plugin `verifiedKeys.setVerified` + cache update + reseal → list reloads → badge flips to `verified`.

**Trust read for conversation state:** `useConversationEncryptionState` → `plugin.getPeerTrust(peer)` (+ `listPeerIdentities` for the all-untrusted check) → `encrypted.trust: TrustState` (+ OpenPGP `firstSeen`) → composer/header/glance render via `trustStateVisual`.

## Security Invariants (Phase B — test-pinned)

1. Fingerprint-binding invalidates a verified marker at every read path (a key whose current fingerprint ≠ stored reverts to unverified).
2. The integrity seal covers the verified map exactly as before the move; `verifyTrustStateSeal` verdicts are unchanged for equivalent state.
3. The one-time migration never loses or fabricates a verified marker (round-trip test: app-store map → migrate → `listPeerIdentities` reflects it).
4. `encrypt()` gating (pin-mismatch, own-key-conflict) is untouched.
5. Crypto core and Sequoia vectors untouched.

## Testing Strategy

- **Characterization net (both phases):** extend the M2c-1 `openpgpTrustRendering.regression.test.tsx` to pin OpenPGP rendering equivalence across composer / ChatHeader / glance / SecurityTab through the trait migration.
- **Phase A unit tests:** `listPeerIdentities` (length-0 no-key, length-1 with-key, trust values); `setIdentityTrust` (verified sets marker, untrusted clears to tofu, TOCTOU guard no-ops on stale id, idempotency).
- **Phase B unit tests:** `verifiedKeys.ts` (set/clear/isVerified/fingerprint-binding/corrupt-blob); migration round-trip; seal snapshot-equivalence (cache source vs old host-store source produce the same snapshot).
- **App mock upkeep:** new SDK/plugin surface used by the app → update app mocks via `importOriginal` spread (respect the `RoomView.test.tsx` barrel-free exception).
- Gate: root `npm run typecheck` (5 workspaces), app suite, package suites all green at the end of each phase.

## Non-Autonomous Gates (post-implementation)

1. **Manual E2E** (`tauri:dev`): OpenPGP verify a peer key via the shared SecurityTab list → badge flips; revoke → returns to TOFU and messaging continues; restart survives (Phase B: verified marker persists in `PluginStorage`); a quick OpenPGP encrypt/decrypt/backup + web unlock smoke.
2. **Re-sign** all unsigned commits from RustRover before the branch merges (sandbox ssh-agent broken).

## Out of Scope

- Adding a persistent untrusted state to OpenPGP (revoke→TOFU by decision #2).
- M2c-2 (protocol picker) and M2c-3 (own-device management) — separate later slices.
- Any change to OMEMO's verified-device storage or trust semantics.
- The pre-existing `_syncingFromRemoteCount` verification-sync race follow-up ticket (tracked separately).
