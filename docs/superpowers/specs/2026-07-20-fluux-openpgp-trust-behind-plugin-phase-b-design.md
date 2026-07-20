# OpenPGP Trust-Behind-the-Plugin — Phase B (Storage Migration) — Design Spec

**Date:** 2026-07-20
**Branch:** `features/omemo` (long-running; becomes the 0.18.0 head)
**Status:** Draft for review
**Follows:** `2026-07-17-fluux-openpgp-trust-behind-plugin-design.md` (the Phase A/B design) and the completed Phase A plan `2026-07-17-fluux-openpgp-trust-behind-plugin-phase-a.md` (commits `91f79c1b`, `4a4d96fe`, `fac0de98`, `1188c18b`).

## Goal

Move OpenPGP's verified-key data (and its integrity seal + sync-version counter) out of app-owned `localStorage` and into the plugin's own `PluginStorage`, so the plugin owns its trust state the way the OMEMO plugin already does — while preserving every synchronous, reactive read the UI depends on. Retires the `hostStores.verifiedPeers` coupling and the `verifiedPeerKeysStore`.

## Why this is not "just move the data"

Grounding against `features/omemo` found three things the Phase A design did not account for. They drive the whole design.

### Finding 1 — `ctx.storage` is NOT persistent for desktop OpenPGP (hard blocker)

`PluginContext.storage` is built once in `E2EEManager.register` (`E2EEManager.ts:150-163`) via `createPluginStorage(this.storage, 'e2ee/' + id)`, which captures the backend **by value**. In `apps/fluux/src/e2ee/registerPlugins.ts`:

- **Web** sets `IndexedDBStorageBackend` *before* registering `WebOpenPGPPlugin` (`:141-146`) → persistent. ✅
- **Desktop** registers `SequoiaPgpPlugin` at `:133-137` with **no** preceding `setE2EEStorageBackend`. The backend in force is the `XMPPClient` default `new InMemoryStorageBackend()` (`XMPPClient.ts:177`) — a `Map` discarded on reconnect/restart. `TauriKeychainStorageBackend` is set only in the OMEMO branch at `:158-160`, *after* the OpenPGP register, and by-value capture makes that too late even when OMEMO is enabled. ❌

Migrating verified data to `PluginStorage` without fixing this would **silently lose every verification on restart** on desktop. `SequoiaPgpPlugin.ts` contains zero `ctx.storage` references today, so nothing has surfaced the defect. The repo already documents the hazard at `registerPlugins.ts:150-157`.

### Finding 2 — three synchronous readers block deleting the store

`PluginStorage` is fully async (`get/put/delete/list` all `Promise`, `types.ts:347-356`) with no SDK-provided sync accessor or cache. But three call sites require a synchronous, reactive read:

| Call site | Why sync is load-bearing |
|---|---|
| `useConversationEncryptionState.ts:148-150` | The value is a **primitive** in two dependency arrays (`:288`, `:422`). It gates the warm-start fast path (`:247-263`) which must `return` synchronously *before* `setBase({kind:'checking'})` at `:265`. Async → the chip flashes "checking" on every reconnect, and a verified peer transiently renders `firstSeen`. |
| `MessageBubble.tsx:363-370` | Per-message-row live trust color, by explicit design ("Trust color must track verification LIVE, not freeze at decrypt time"). Async → N reads per list render. |
| `registerPlugins.ts:49` | The plugin's own `OpenPGPHostStores.verifiedPeers.isVerified` contract is synchronous `(jid, fp) => boolean`, consumed inside sync plugin code (`evaluatePeerTrust`, `buildInboundSecurityContext`). |

**Consequence:** the store's *persistence backend* moves; a synchronous mirror must survive. It moves **into the plugin** (plugin-owned), and the app reads it through a reactive adapter.

### Finding 3 — async writes would break the verification-sync re-entrancy guard

`_syncingFromRemoteCount` (`OpenPGPPluginBase.ts:350`, incremented `:1302` before the first `await`, decremented `:1326` in `finally`) works **only** because the applied writes at `:1319-1320` are synchronous, so the store's change notification fires inside the guarded window and the republish is suppressed. Naively `await`ing PluginStorage writes would let the notification fire after the counter drops → the device republishes what it just received.

**The design neutralizes this:** the mirror's cache update and listener notification are **synchronous**; only persistence is async. The guard's existing semantics are preserved unchanged.

Grounding also documented three *pre-existing* races in this path (see §6) that this slice rewrites around and therefore fixes.

## Design Decisions

1. **Plugin owns the data; the sync mirror lives in the plugin.** A new `verifiedKeys.ts` module + an in-memory `Map` hydrated at init, exposing sync reads, sync-notifying writes, and async persistence.
2. **The seal blob, its init flag, and the sync-version counter move too.** They are plugin-internal (no app consumers) and belong with the data. On desktop this relocates them from `localStorage` to the keychain-backed store — a **security upgrade**, since the seal exists precisely to detect `localStorage` tampering and is now itself much harder to forge.
3. **Pins and key-change alerts stay app-side for now.** They have their own reactive app consumers (`useConversationEncryptionState.ts:176-178`, `:158-163`). The seal continues to snapshot them via `hostStores`. This is *not* incoherent: the seal is the detector, and hardening the detector while the detected data stays in `localStorage` strictly improves tamper detection. Moving them is a recorded follow-up.
4. **Per-account isolation comes from the backend.** Both `TauriKeychainStorageBackend` and `IndexedDBStorageBackend` are constructed with `manager.getAccountJid()`, so each account has its own backend instance; `createPluginStorage` then namespaces per plugin id. The plugin does **not** re-derive scoping. This invariant is documented and test-pinned (it is how OMEMO already works).
5. **Writes are awaited at the UI boundary.** The verify/revoke handlers await the plugin's write before showing the success toast, so a failed persist can no longer report success (`ChatView.tsx:347-355`, `:473-478` today toast synchronously).

## Architecture

Four sub-phases, each independently reviewable and green.

### B0 — Prerequisite: fix desktop storage-backend ordering

`apps/fluux/src/e2ee/registerPlugins.ts`:
- Hoist `client.setE2EEStorageBackend(new TauriKeychainStorageBackend(manager.getAccountJid()))` to run **once, before any `manager.register(...)`**, unconditionally when `isTauri()`.
- Remove the now-redundant `setE2EEStorageBackend` from the OMEMO branch and the stale last-write-wins comment (`:150-157`) — `createPluginStorage` already namespaces `e2ee/openpgp` vs `e2ee/omemo:2`, so one shared per-account instance is correct.
- Web path unchanged (IndexedDB already set before register).
- **Test:** desktop registration yields a `ctx.storage` that survives a simulated restart (round-trip through the keychain backend), and OpenPGP/OMEMO namespaces do not collide.

This lands and ships on its own merit: it fixes a real (currently latent) desktop persistence defect and removes a documented hazard.

### B1 — Plugin-owned verified store with a synchronous mirror

New `packages/openpgp-plugin/src/verifiedKeys.ts`:

```
loadAll(storage): Promise<Record<string,string>>     // hydrate; defensive against corrupt blobs
persist(storage, map): Promise<void>
```

`OpenPGPPluginBase` gains a `VerifiedKeysCache` (in-memory `Map<bareJid, fpHex>`) with:
- `isVerified(jid, fp): boolean` — sync; `fingerprintsEqual` comparison (preserves the Sequoia-UPPERCASE ↔ openpgp.js-lowercase normalization the current store does at `verifiedPeerKeysStore.ts:121-127`).
- `getAll(): Record<string,string>` — sync snapshot (stable reference between mutations, so `useSyncExternalStore` doesn't loop).
- `setVerified(jid, fp): Promise<void>` / `clearVerified(jid): Promise<void>` — **update the Map and notify listeners synchronously**, then `await` persistence.
- `subscribe(listener): () => void` — sync notification, mirroring today's Zustand `subscribe` contract.

Hydration happens in `init` before `activateSubscriptions()` (`ctx.storage` is assigned at `init`'s first statement `:521`; `activateSubscriptions()` is last `:562` — confirmed safe on every path).

The plugin's internal call sites (`evaluatePeerTrust:2041`, `buildInboundSecurityContext:2172`, `acceptPeerKeyChange:1738/1756`, the sync apply `:1315-1321`, and the two `subscribe` registrations `:577/:587`) switch from `this.hostStores.verifiedPeers.*` to the cache. All remain synchronous reads; writes become `await`ed inside already-async contexts.

`trustStateIntegrity.ts` `buildCanonicalSnapshot` keeps reading `verified` **synchronously** — now from the cache instead of `hostStores` — so the seal logic is untouched. (Grounding confirmed every seal caller is already async, so this is belt-and-braces, not a constraint.)

### B2 — App consumers move to the plugin-backed view; store deleted

New `apps/fluux/src/e2ee/verifiedPeersView.ts`: a small app-side adapter holding the registered OpenPGP plugin's sync view (set during `registerE2EEPlugins`, cleared on unregister), exposing:
- `useVerifiedFingerprint(jid: string | null): string | null` — `useSyncExternalStore(subscribe, getSnapshot)`, returning a **primitive** so the existing dependency arrays keep their semantics.
- `useVerifiedMap()` for `MessageBubble`'s per-row read (single subscription, snapshot read per row).
- imperative `verifyPeer(jid, fp)` / `revokePeer(jid)` returning promises.

**Unregistered-plugin behavior (required).** Today's consumers read a module-level Zustand store that always exists. The plugin-backed view must degrade safely when no OpenPGP plugin is registered — during the window after `online` but before `registerE2EEPlugins` completes, when OpenPGP is disabled in settings, and in OMEMO-only setups (`MessageBubble` renders in all of these). Contract: `useVerifiedFingerprint` returns `null` and `useVerifiedMap` returns a stable empty snapshot (the *same* frozen object every call, so `useSyncExternalStore` cannot loop); `subscribe` is a no-op returning an unsubscribe function; the imperative writers reject. When a plugin later registers, the view must notify subscribers so mounted components re-render — mirroring the existing `pluginRegisteredAt` signal that `useConversationEncryptionState.ts:134` already uses to re-run after async plugin init. Test-pinned.

Migrate the three reactive consumers (`useConversationEncryptionState.ts:148`, `MessageBubble.tsx:367`, `ChatView.tsx:318-319`), make the ChatView verify/revoke handlers `await` before toasting, then **delete** `apps/fluux/src/stores/verifiedPeerKeysStore.ts`, its adapter block in `registerPlugins.ts:47-59`, the `verifiedPeers` group from `OpenPGPHostStores` (`hostStores.ts:51-60`), the `rehydrateVerifiedPeerKeys()` call in `useAccountScopeRehydration.ts:31`, and the vestigial mock in `ContactProfileView.test.tsx:55-60`. Update `demo.tsx:135`'s seed to the new imperative path.

**Before-state pinning:** the existing tests that cover these behaviors (`useConversationEncryptionState.test.tsx` blocks at ~`:262-350` and ~`:548-611`, `MessageBubble.test.tsx` verification toggles) are the regression net — rewrite them against the new view while preserving every asserted behavior, especially the warm-start fast path and live trust-color updates.

### B3 — Migrate persisted state + harden the sync path

**One-time migration** (runs in `init`, before `activateSubscriptions`, idempotent, guarded by a `migrated` marker in `PluginStorage`):
- Verified map: read `buildScopedStorageKey('fluux-e2ee-verified-peers')`, falling back to the **unscoped** legacy key (the store has its own unscoped→scoped migration at `verifiedPeerKeysStore.ts:47-55`, so unmigrated blobs still exist in the wild). Seed `PluginStorage` only when it is empty; never overwrite plugin-owned data.
- Seal blob (`fluux-e2ee-trust-state-seal`), init flag (`fluux-e2ee-trust-integrity-init`), and sync-version counter (`fluux-e2ee-verifications-version`) migrate **in the same step**. This matters: migrating the map without the seal+flag would make `verifyTrustStateSeal` report `compromised` ("seal was removed but stores contain data", `trustStateIntegrity.ts:123`). Because the migrated map content is byte-identical, the migrated seal verifies cleanly.
- Legacy `localStorage` keys are read-only during the migration window, then removed.

**Sync-path hardening** (this slice rewrites the publish path, so it must not build on the known races):
1. **Guard preserved** — sync cache-update + sync notify keeps the `_syncingFromRemoteCount` window valid across async persistence. Test-pinned explicitly.
2. **Stale-map republish** — `scheduleVerificationsPublish` currently publishes the map **captured at schedule time** 500 ms earlier, which can clobber a newer remote snapshot with a higher version. Fix: publish `cache.getAll()` read at timer-fire.
3. **Version-counter regression** — `nextVersion` is reserved at timer-fire but `saveAppliedVerificationsVersion` only runs after the network round-trip, so an interleaved remote apply can be overwritten by a lower number (which desyncs `TrustStateSnapshot.syncVersion` and surfaces as a spurious `compromised`). Fix: persist the reserved version before publishing (gaps are harmless; only monotonicity matters).
4. **Dropped local write** — a local verify during an in-flight remote sync is skipped by the guard and never republished. Fix: set a `pendingRepublish` flag when the guard suppresses a notification, and schedule a publish when the counter returns to zero.

## Security Invariants (test-pinned)

1. Fingerprint-binding holds at every read path: a key whose current fingerprint ≠ the stored one is not verified (`fingerprintsEqual` normalization preserved).
2. The migration never loses or fabricates a verified marker; it is idempotent and never overwrites plugin-owned data.
3. Post-migration the seal verifies cleanly (`sealed`, not `compromised`) for unchanged state; `verifyTrustStateSeal` verdicts are unchanged for equivalent inputs.
4. Per-account isolation holds: account A's verified data is unreachable from account B (backend is per-account).
5. Desktop verified data survives an app restart (the B0 defect stays fixed) — this is the regression B0 exists to prevent.
6. The re-entrancy guard still suppresses republish-on-apply across async persistence.
7. `encrypt()` gating (pin-mismatch, own-key-conflict) untouched. Crypto core and Sequoia vectors untouched — no backup-byte change, **no vector regeneration**.

## Testing Strategy

- **B0:** registration-order test (desktop backend persistent + namespace isolation).
- **B1:** `verifiedKeys.ts` unit tests (round-trip, corrupt blob, fingerprint normalization); cache tests (sync read-after-write, sync notify ordering, snapshot stability).
- **B2:** rewritten hook/MessageBubble tests preserving the warm-start fast path, live trust color, and verify→immediate-green behavior; ChatView await-before-toast.
- **B3:** migration round-trip (scoped key, unscoped legacy key, empty, corrupt, re-run idempotency); post-migration seal verifies `sealed`; one regression test per race fixed (2/3/4) plus the guard test (1).
- Gate: root `npm run typecheck` (5 workspaces), `packages/openpgp-plugin` suite, full app suite — green at each sub-phase boundary.

## Non-Autonomous Gates

1. **Manual E2E** (`tauri:dev` **and** web): verify a peer → restart the app → verification **persists** (the B0 regression); revoke → returns to TOFU; two-device verification-sync round-trip (verify on device A, confirm it appears on device B and that neither device republishes in a loop); confirm the trust-state banner does not spuriously show `compromised`.
2. **Re-sign** all `--no-gpg-sign` commits from RustRover before merge.

## Out of Scope

- Moving pins (`pinnedPrimaryFingerprintsStore`) and key-change alerts (`keyChangeAlertsStore`) into `PluginStorage` — recorded follow-up (decision 3).
- Hook unification (routing `useConversationEncryptionState`'s OpenPGP trust through `getPeerTrust`) — still deferred; async-vs-sync churn with no consumer-visible change.
- M2c-2 (protocol picker) and M2c-3 (own-device management).
- The deferred i18n dead-key sweep (`contacts.encryption.removeVerification*`, `contacts.encryption.omemo.*`).

## Open Question for Review

B0 changes where desktop E2EE plugin storage lives for **all** plugins (OMEMO already uses the keychain backend; OpenPGP moves onto it). Confirm this is acceptable rather than, say, giving OpenPGP its own backend instance — the shared-instance choice relies on `createPluginStorage`'s per-plugin-id namespacing, which grounding verified is already in place.
