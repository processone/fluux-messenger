# OMEMO Per-Device Verification (Milestone 2, sub-project M2c-1)

**Date:** 2026-07-16
**Status:** Approved (design) — pending implementation plan
**Branch:** `features/omemo`
**Depends on:** M2b — OMEMO desktop integration (registrar, keychain-sealed store, `omemoEnabled` opt-in, `useConversationEncryptionState` OMEMO branch returning `encrypted{protocolId:'omemo:2', omemoTrust, fingerprint:''}`). Complete, final-reviewed.

> Sensitive strategic context lives in `private/E2EE_PLUGIN_ARCHITECTURE.md`. Keep public artifacts free of strategy detail.

## Background

M2b made OMEMO 1:1 encryption work on desktop and shows a chat's **aggregate** trust (tofu / untrusted / unknown), but there is no way to **verify** a peer's device. That is the actual security guarantee of OMEMO's Blind-Trust-Before-Verification (BTBV) model: until a device is verified, trust is blind; once you verify one device, newly-appearing devices must be checked rather than silently trusted.

Today "verified" is **unrepresentable**:
- The `@fluux/omemo` library `TrustRecord.state` is only `undecided | trusted | untrusted`.
- The plugin's `BtbvState` (`trust.ts`) mirrors that — no `verified`.
- `OmemoPlugin.peerHasVerifiedDevice()` is hardcoded `return false`.
- `OmemoPlugin.startVerification()` throws (`"…a later sub-project"`).
- No method lists a peer's devices with per-device fingerprints.

M2c-1 fills those gaps and adds the contact-profile UI to verify/revoke a peer's devices. It also fixes **G-1** (from M2b's final review): `ChatHeader` and `SecurityTab` label OMEMO chats as "OpenPGP" and render an empty fingerprint.

Separately, the app has drifted into **four overlapping trust vocabularies** (see Component 0). Since M2c-1 is where trust becomes multi-protocol and per-device, it also **unifies all consumer-facing trust onto the shared SDK `TrustState`** — a cross-cutting change that touches the shipped OpenPGP trust UI, done here so we don't build the new per-device surfaces on a divergent foundation. This makes the slice larger than a pure feature add; the implementation plan sequences the trust-vocabulary migration (Component 0) first, with regression coverage locking OpenPGP's rendering, before the per-device work builds on it.

**Scope note (sequencing):** M2c-1 is deliberately built with a trait seam shaped to fit *both* protocols. The `@fluux/openpgp-plugin` extraction is the **next** slice after M2c-1; at that point OpenPGP's verified-trust migrates behind its plugin and the temporary trust-store asymmetry (below) is retired. M2c-1 does not perform that extraction.

## Locked-in decisions (from the brainstorming session)

1. **Verification method: fingerprint / safety-number compare.** Reuse the existing `VerifyPeerDialog`, driven per device. The user compares the device's fingerprint out-of-band and confirms. QR-scan verification is out of scope.
2. **Full BTBV trust model.** Verify a device **and** mark-untrusted/revoke. Once a peer has any verified device, newly-appearing unverified devices resolve to `untrusted` and are **excluded from encryption** until verified. Wire the plugin's existing `peerHasVerifiedDevice` hook.
3. **Verified marker is plugin-owned; the crypto core stays untouched.** The `verified` state lives entirely in `@fluux/omemo-plugin` (over `PluginStorage`), keyed by `(peer, deviceId, fingerprint)`. `@fluux/omemo`'s `TrustRecord` schema is unchanged. Rationale: "verified" is a trust-*policy* concern belonging to the adapter layer, not the security-reviewed cleanroom crypto.
4. **Trait seam shaped for both protocols.** The two new methods are modeled as an *identity* list (OMEMO: devices; OpenPGP later: a single-element list = the key), so the UI renders one uniform per-identity list. Added as **optional** `E2EEPlugin` trait methods; the app feature-detects.
5. **Own-device management, QR verification, and the protocol picker are out of scope** (later slices M2c-2 / M2c-3).
6. **Unify all consumer-facing trust onto the shared `TrustState`.** The SDK plugin API already standardizes trust as `TrustState = verified | introduced | tofu | untrusted | unknown` (`getPeerTrust`/`getDeviceTrust`/`VerificationFlow.result`). M2c-1 migrates the app's divergent conversation-level union (`encrypted.trust: 'verified'|'unverified'|'tofu-new'`) and every consumer onto `TrustState`, with **one** shared `TrustState → visual/label` mapping. No new fifth vocabulary; no more `untrusted → unverified` information loss.

## Component 0 — Unified trust vocabulary (`TrustState` everywhere)

**Foundational; lands before the per-device work depends on it.** Today four overlapping trust vocabularies coexist: (1) SDK `TrustState` — the shared plugin-API contract; (2) SDK per-message `SecurityContext.trust` (`…| rejected`, no `unknown`); (3) the app hook's conversation-level `encrypted.trust` (`verified | unverified | tofu-new`); (4) the presentation enum `TrustVisualState` in `apps/fluux/src/e2ee/trustVisual.ts`. Consumers read a mix, and the hook's `mapOmemoTrust` collapses `untrusted → unverified` (information loss flagged in M2b review).

Changes:
- **Conversation-level trust becomes `TrustState`.** `useConversationEncryptionState`'s `encrypted` variant carries `trust: TrustState` (drop the 3-value union, the separate `omemoTrust` field, and `mapOmemoTrust`). The OpenPGP branch maps its state to `TrustState`: an explicitly-verified key → `verified`; encrypted-but-not-verified (today's `unverified`/`tofu-new`) → `tofu`. The **"new contact" nudge**, if the UI still wants it, becomes a separate boolean (e.g. `firstSeen`) — "new" is not a trust *level* and must not be encoded as one. OMEMO passes the plugin's `TrustState` through unchanged (no collapse), so `untrusted` stays `untrusted`.
- **One shared trust mapping.** Refactor `trustVisual` so the *trust* dimension is keyed on `TrustState` (add `tofu` → calm, `untrusted` → danger, `unknown` → calm/muted, `introduced` → calm; `verified` stays). The genuinely non-trust presentation states (`decryptFailed`, `keyChanged`, `keyLocked`, `plaintext`, `checking`, `rejected`) remain a distinct presentation concern layered alongside — they are message-lock / cert states, not trust levels. Add a parallel `trustLabel(TrustState)` i18n helper. Both are the single source used by OMEMO device rows, the OMEMO/OpenPGP aggregate, and the message lock.
- **Per-message `SecurityContext.trust` (#2)** stays SDK-set but its values are reconciled to `TrustState` semantics; `rejected` (OpenPGP cert-validation outcome) is treated as an orthogonal presentation state in `trustVisual`, not a trust level — no destabilizing rewrite of message-lock rendering, just shared labels/visuals.
- **Update all consumers** (~8: `ChatHeader`, `SecurityTab`, `SecurityGlanceCard`, `MessageComposer`, `ContactProfileView`, `ContactSecurityDetail`, `ContactProfileGrid`, message lock) to read `TrustState` via the shared mapping. The OpenPGP path must render **equivalently** to today (regression-tested), just sourced from `TrustState`.

## Component 1 — Verified-trust store (plugin-owned)

New persisted structure in `@fluux/omemo-plugin`, over the existing `PluginStorage` the plugin already uses (namespaced `e2ee/omemo:2/…`). It records, per peer, the set of **verified** `(deviceId, fingerprint)` pairs.

- **Key by fingerprint, not just deviceId.** A verified marker is `{ deviceId, fingerprint }`. When a device's identity key (hence fingerprint) changes, the stored marker no longer matches → the device reverts to unverified and must be re-verified. This is the same security property `verifiedPeerKeysStore` gives OpenPGP (verified is bound to the exact key).
- **Storage shape:** a small serializable record per peer, e.g. `verified/<peerBareJid>` → `{ [deviceId: string]: fingerprintHex }`. Reads/writes go through the plugin's `OmemoStore`/`PluginStorage` layer (async), sealed at rest on desktop via the M2b keychain backend automatically (it is just another key under the plugin's namespace).
- **`untrusted` is NOT stored here** — it is already representable in the library `TrustRecord.state='untrusted'` and continues to persist there via `saveTrust`. Only `verified` is the new, plugin-local concept.

## Component 2 — Plugin trust API (+ optional SDK trait methods)

### New `OmemoPlugin` methods

- **`listPeerIdentities(peer: BareJID): Promise<PeerIdentity[]>`** where `PeerIdentity = { id: string; fingerprint: string; trust: TrustState }`. For OMEMO, one `PeerIdentity` per device: `id` = deviceId string, `fingerprint` = hex fingerprint derived from the device's identity key, `trust` = resolved per-device trust (see Component 3). Assembly:
  1. `fetchDeviceList(ctx.xmpp, peer)` → device ids.
  2. For each device, obtain its identity key: prefer the persisted `TrustRecord.identityKey` (already bound on first session), else `fetchBundle(ctx.xmpp, peer, deviceId).ik`. If neither is available (device advertised but no bundle yet), include the device with `fingerprint: ''` and `trust: 'unknown'` so the UI can show "no key yet".
  3. Derive the fingerprint from the identity key via the library's existing `fingerprint(edPub)` helper (`ed25519PubToMontgomery`), formatted to the same hex the UI already renders.
  4. Resolve trust (Component 3).
- **`setIdentityTrust(peer: BareJID, id: string, decision: 'verified' | 'untrusted'): Promise<void>`** — `id` is the deviceId string. `'verified'` writes the plugin verified-store marker `(deviceId, currentFingerprint)` and clears any prior `untrusted` library state for that device. `'untrusted'` writes `saveTrust(peer, deviceId, { state:'untrusted', identityKey })` and removes any verified marker. Both operations are idempotent.

### Optional `E2EEPlugin` trait methods

Add to the `E2EEPlugin` interface in `@fluux/sdk` as **optional**:

```ts
listPeerIdentities?(peer: BareJID): Promise<PeerIdentity[]>
setIdentityTrust?(peer: BareJID, id: string, decision: 'verified' | 'untrusted'): Promise<void>
```

`PeerIdentity` is exported from `@fluux/sdk`. OpenPGP does not implement these in this slice (the app keeps its existing OpenPGP verify path); the OpenPGP extraction slice makes it conform (its list is length-1 = the key). The app feature-detects (`if (plugin.listPeerIdentities) …`).

## Component 3 — BTBV trust resolution + encrypt exclusion

- **Per-device trust resolution** (used by `listPeerIdentities`, `getDeviceTrust`, and the aggregate `getPeerTrust`):
  - If `(peer, deviceId, currentFingerprint)` is in the verified store → `'verified'`.
  - Else fall back to the library trust (`loadTrust`): `trusted → 'tofu'`, `untrusted → 'untrusted'`, `undecided/none → 'unknown'`.
- **Wire `peerHasVerifiedDevice(peer)`** to the verified store: returns `true` iff the peer has ≥1 verified marker. This activates the plugin's *existing* `resolveInboundTrust` logic: with a verified device present, a newly-seen device resolves to `untrusted` instead of blind-`trusted`.
- **`getPeerTrust` aggregate** already prioritizes `untrusted > verified > tofu > unknown`; with `'verified'` now producible, the `verified` branch becomes live. A peer with a verified device and no untrusted devices surfaces `verified`.
- **Encrypt exclusion:** in the plugin's encrypt path, filter out peer devices whose resolved trust is `'untrusted'`. Own devices are unaffected (auto-trusted; own-device trust is M2c-3). If, after exclusion, a peer has **zero** encryptable devices (all untrusted — e.g. they replaced every device after you verified one, or you revoked all), encryption to that peer cannot proceed: surface this as a distinct, actionable state rather than a silent failure (Component 4). Before any verification exists for a peer, nothing is excluded (all blind-trusted, current M2b behavior preserved).

## Component 4 — UI: contact-profile per-identity verification (+ G-1 fix)

### `SecurityTab` OMEMO branch → per-identity list

`apps/fluux/src/components/contact-profile/tabs/SecurityTab.tsx`'s `encrypted` branch is currently single-fingerprint and protocol-blind. Make it `protocolId`-aware:

- **OMEMO (`state.protocolId === 'omemo:2'`):** render a **per-identity list** from `listPeerIdentities(peerJid)`. Each row: a short device id, the formatted safety-number/fingerprint, a trust badge rendered via the **shared `TrustState` mapping** from Component 0 (`verified` / `tofu` / `untrusted` / `unknown`, each with its shared label + color/tone), and an action:
  - **Verify** (device not yet verified) → opens `VerifyPeerDialog` driven with that device's fingerprint; on confirm → `setIdentityTrust(peer, deviceId, 'verified')`, then refresh the list.
  - **Revoke** (verified or trusted device) → `setIdentityTrust(peer, deviceId, 'untrusted')`, then refresh.
  - An aggregate summary line at the top (reuse the existing trust wording; "N devices, M verified").
- **OpenPGP (`protocolId` absent / `'openpgp'`):** unchanged — the existing single-fingerprint + verify/revoke path.
- Loading and error states while `listPeerIdentities` resolves (async network fetch of device list / bundles).

### `VerifyPeerDialog` reuse

Drive the existing dialog per device: `peerFingerprint` = the device's fingerprint, `ownFingerprint` = our OMEMO identity fingerprint. Read own fingerprint via a **read-only** accessor (add a small `getOwnFingerprint(): string | null` to `OmemoPlugin` over `acc.identityFingerprint()` if none exists) — do **not** call the publishing `ensureIdentity()` on the dialog hot path (it has PEP side effects). The SAS derivation (`deriveSas`/`splitSas`) works with any two fingerprints. The confirm callback targets a device (`setIdentityTrust(peer, deviceId, 'verified')`) rather than writing `verifiedPeerKeysStore`. Minimal changes to the dialog: it must accept a device-scoped confirm target instead of assuming the OpenPGP JID-string contract.

### G-1 fix — `ChatHeader` + `SecurityTab` labels

`apps/fluux/src/components/ChatHeader.tsx` (the two tooltip blocks ~L386-390 and ~L415-418) hardcode `t('chat.encryption.openpgpTooltip')` and `formatFingerprint(state.fingerprint)` regardless of `state.protocolId`. Make them `protocolId`-aware:

- OMEMO: tooltip reads **"OMEMO"** + aggregate trust; **suppress** the empty single-fingerprint block (OMEMO has no single fingerprint; per-device fingerprints live in the profile).
- OpenPGP: unchanged.

Use the M2b i18n keys where present (`chat.encryption.tooltip.protocol."omemo:2"` = "OMEMO") and add any new copy (per-device trust badges, "verify a device to send", aggregate summary) across all 33 locales.

### "Verify a device to send" state

When Component 3 determines a peer has zero encryptable (non-untrusted) devices, the composer/lock surface must show an explicit, actionable prompt — the conversation is OMEMO but cannot send until at least one device is verified. This threads through `useConversationEncryptionState` (a distinct state on the OMEMO branch) and renders near the composer lock. It links to the contact's Security tab.

## Error handling & edge cases

- **Device advertised but no bundle/key yet** → row shows `fingerprint: ''`, trust `unknown`, verify disabled (nothing to compare).
- **Fingerprint (identity key) change on a verified device** → the marker no longer matches → device reverts to unverified; if the peer had that as their only verified device, `peerHasVerifiedDevice` may flip, and other devices re-blind-trust per BTBV. The UI reflects the new unverified state on next `listPeerIdentities`.
- **All peer devices untrusted** → send blocked with the Component-4 actionable state; never silent-drop or silent-plaintext.
- **`listPeerIdentities` network failure** (device-list/bundle fetch) → the tab shows an error with retry; existing trust is unaffected.
- **Own devices** are always encryptable in this slice (own-device trust deferred to M2c-3).
- **Web** — this UI is desktop-first like the rest of OMEMO; on web (no OMEMO plugin registered) the OMEMO branch is unreachable, so the tab shows the OpenPGP path as today.

## Testing & verification

- **Trust-vocabulary migration (Component 0)**: `trustVisual`/`trustLabel` map every `TrustState` value; the OpenPGP path renders **equivalently to before** (regression tests pinning today's badge/color/label output for each OpenPGP state, now sourced from `TrustState`); OMEMO `untrusted` no longer displays as `unverified`; the hook's `encrypted.trust` is `TrustState` and the `firstSeen` nudge (if kept) is a separate flag.
- **Plugin unit tests** (`@fluux/omemo-plugin`): `listPeerIdentities` assembles `{id, fingerprint, trust}` from a mocked device-list + bundles; `setIdentityTrust('verified')` round-trips through `PluginStorage` and is fingerprint-bound; a fingerprint change invalidates a prior verified marker; `peerHasVerifiedDevice` flips a newly-seen device to `untrusted`; encrypt excludes untrusted devices; the all-untrusted → zero-recipient path surfaces (does not silently succeed). `getPeerTrust` now surfaces `verified`.
- **SDK**: the optional trait methods typecheck; `PeerIdentity` exported.
- **App unit tests**: `SecurityTab` OMEMO branch renders per-identity rows + verify/revoke wiring against a mocked plugin; `ChatHeader` shows "OMEMO" (not "OpenPGP") and no empty fingerprint for an OMEMO `state`; the "verify a device to send" state renders; OpenPGP `SecurityTab`/`ChatHeader` paths unchanged (via the regression tests above).
- **Manual E2E gate** (with M2b's Task 10, not automatable here): in `tauri:dev`, with a live OMEMO peer that has ≥2 devices, verify one device (fingerprint matches the other client), confirm the badge flips to Verified and the aggregate reflects it; add a new device on the peer and confirm it appears as Untrusted and is excluded from encryption until verified; revoke and confirm exclusion.

## Out of scope (YAGNI)

Own-device management (list/rename/remove own devices, PEP retraction) — **M2c-3**. Per-conversation OpenPGP↔OMEMO protocol picker — **M2c-2**. QR-code verification. Cross-device sync of verified markers (XEP-0373 backup node). The `@fluux/openpgp-plugin` extraction (the **next** slice after M2c-1) — but M2c-1's trait seam is shaped so OpenPGP can conform then.

## Future work (recorded, not this spec)

- **`@fluux/openpgp-plugin` extraction (next slice):** move the app-side OpenPGP plugin into a package adopting the M2a/M2b pattern, implement the optional `listPeerIdentities`/`setIdentityTrust` trait methods (single-identity), and migrate `verifiedPeerKeysStore` behind the plugin — retiring M2c-1's temporary app-store/plugin-store trust asymmetry.
- **M2c-2** protocol picker (persist `setPinnedStrategy` + per-conversation control).
- **M2c-3** own-device management (enumerate own devices + fingerprints, PEP retraction).
