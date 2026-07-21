# OpenPGP Trust-State Storage + Sync-Race Hardening (Phase B3) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the three remaining verification-sync races, then move the last of OpenPGP's trust state (the integrity seal blob, its init flag, and the sync-version counter) out of `localStorage` into the plugin's `PluginStorage`.

**Architecture:** Races first, on the current synchronous storage, where they are easy to reason about and test. Then the storage move, as a mechanical swap that must preserve the now-correct behavior. The version counter is the hinge: it is read **synchronously** inside `buildCanonicalSnapshot`, so moving it needs the same in-memory-cache-over-async-storage treatment `VerifiedKeysCache` got in B1.

**Tech Stack:** TypeScript, `PluginStorage`, Vitest.

**Spec:** `docs/superpowers/specs/2026-07-20-fluux-openpgp-trust-behind-plugin-phase-b-design.md` §B3 (and the §6 race list). Depends on B0 (`61f26dbb..66ceb153`), B1 (`2efa3d90..fadac020`), B2 (`2cc927ca..09f9b167`).

## Grounding: what is actually left (the spec's §B3 predates B0–B2)

Re-checked against current code. Two of the spec's four races are already closed:

| Race | State |
|---|---|
| Guard preserved across async writes | **CLOSED (B1/B2).** `VerifiedKeysCache` notifies synchronously on mutation, so the notification lands inside `_syncingFromRemoteCount`'s window. B2 Task 7 re-verified it against an unmodified end-to-end test. |
| Stale-map republish | **CLOSED (B2 Task 7).** `scheduleVerificationsPublish` now reads `this.verifiedKeys.getAll()` at fire time (`OpenPGPPluginBase.ts:1474`) instead of capturing at schedule time. |
| **Version-counter regression** | **OPEN** — Task 1. |
| **Dropped local write** | **OPEN** — Task 2. |
| **Optimistic-publish edge** (new, introduced by B2 Task 7) | **OPEN** — Task 3. |

Storage targets confirmed present: `fluux-e2ee-trust-state-seal` and `fluux-e2ee-trust-integrity-init` (`trustStateIntegrity.ts:21-22`), `fluux-e2ee-verifications-version` (`verificationSync.ts:69`).

**Out of scope but worth recording:** `backupMarker.ts:11` justifies its own use of `localStorage` with *"because the SDK's `PluginStorage` backend is currently in-memory; a marker that evaporates on app restart would defeat the entire UX benefit."* **B0 made that false** — desktop OpenPGP now has a persistent, dedicated sealed store. The comment is stale and the marker is a candidate to move, but it is not trust state and not in this slice. Fix the comment if you touch the file; do not migrate it here. Same for the peer-key cache (`OpenPGPPluginBase.ts:132-164`), which is a performance cache, not trust state.

## Global Constraints

- **`buildCanonicalSnapshot` and `storesAreEmpty` must stay synchronous.** They are called from `sealTrustState`/`verifyTrustStateSeal`, and the snapshot must be takeable without awaiting. This is what forces the version counter's in-memory cache in Task 4.
- **Never widen the seal's tamper-detection into a false positive.** The seal exists to detect `localStorage` tampering; every change here must keep "equivalent state ⇒ `sealed`" true. A migration that moves the seal but not the init flag makes `verifyTrustStateSeal` report **`compromised`** ("seal was removed but stores contain data") — that is a user-facing tamper warning produced by our own refactor. The seal blob and init flag therefore move **together**, in one task.
- **Version monotonicity is the correctness property**, not contiguity. Gaps are harmless; going backwards is not — a lower persisted version re-opens the replay gate and desyncs `TrustStateSnapshot.syncVersion`, surfacing as `compromised`.
- **No cross-device republish loop.** `_syncingFromRemoteCount` must keep suppressing publish-on-apply. Every change in Tasks 1–3 touches that path; the guard test must keep passing and must stay falsifiable.
- **Upgrade path.** Existing installs hold all three values in `localStorage`. Moving them without a one-shot migration silently resets the sync version (replay window reopens) and destroys the seal (false `compromised`). Follow B2 Task 8's established pattern in `legacyVerifiedPeersSeed.ts`: read the legacy key(s) — **scoped and pre-migration unscoped** — seed once, then remove **all** keys that held the data (B2's review found that leaving an unscoped orphan behind resurrects stale state on a later relaunch).
- Crypto untouched: no change to the encrypt-to-self seal format, `TrustStateSnapshot`'s shape, or the AEAD. No Sequoia vector regeneration.
- Commits `--no-gpg-sign`; never push; no Claude footer.
- **Every test guarding a data-loss, trust-downgrade, or false-tamper property must be proven with a deliberate-break check** — introduce the exact regression the test names, confirm it FAILS, revert, confirm green, report both outputs. B0+B1+B2 shipped **seven** tests that could not fail; every one was caught by this check and none by review alone.
- **Worktree:** `.claude/worktrees/openpgp-phase-b` has its own `node_modules`; SDK and branch-only packages are built. Do NOT run `npm install`.

## Sequencing

Tasks 1–3 (races) are independent of the storage move and each independently shippable. Task 4 (version counter) and Task 5 (seal + flag) are the migration. **If the branch needs to pause, stop after Task 3** — the races are fixed and nothing has moved.

## File Structure

- `packages/openpgp-plugin/src/OpenPGPPluginBase.ts` — publish scheduler + guard (Tasks 1–3); wiring for the moved stores (Tasks 4–5).
- `packages/openpgp-plugin/src/verificationSync.ts` — version counter accessors (Tasks 1, 4).
- `packages/openpgp-plugin/src/syncVersionCache.ts` — **new**: sync-read/async-persist version cache (Task 4).
- `packages/openpgp-plugin/src/trustStateIntegrity.ts` — seal + init-flag storage (Task 5).
- `packages/openpgp-plugin/src/legacyTrustStateSeed.ts` — **new**: one-shot migration for all three legacy keys (Tasks 4–5).

---

### Task 1: Version-counter regression

**Files:** Modify `OpenPGPPluginBase.ts` (publish scheduler ~`:1470-1493`); test in `SequoiaPgpPlugin.test.ts` or `OpenPGPPluginBase.verifiedCache.test.ts`.

**The bug:** `nextVersion` is reserved at fire time (`:1478`) but `saveAppliedVerificationsVersion(nextVersion)` runs only **after** the network round-trip (`:1488`). If a remote apply persists version 7 during that round-trip, the in-flight publish then writes 6 back — lowering the persisted counter, re-opening the replay gate for the version-7 snapshot, and desyncing `TrustStateSnapshot.syncVersion` (surfacing as a spurious `compromised`).

**Fix:** persist the reserved version **before** publishing. Monotonicity is what matters; a gap from a failed publish is harmless.

- [ ] **Step 1: Write the failing test.** Reserve a version, begin a publish, apply a *higher* remote version mid-flight, let the publish resolve → assert the persisted version is the **higher** one, never lowered. Drive it through the real publish path with a controllable (gated) publish promise, not by calling the save function directly.
- [ ] **Step 2: RED. Step 3: Implement** (save before `publishVerificationsToServer`; keep the reseal in `.then`). **Step 4: GREEN** + package suite.
- [ ] **Step 5: Deliberate-break.** Restore save-after-publish; confirm the test FAILS; revert; confirm green.
- [ ] **Step 6: Typecheck + commit.**
```bash
git commit --no-gpg-sign -m "fix(openpgp-plugin): reserve the verifications version before publishing"
```

---

### Task 2: Dropped local write

**Files:** Modify `OpenPGPPluginBase.ts` (the guarded subscription ~`:639` and `syncVerificationsFromServer`'s `finally` ~`:1390`); tests alongside Task 1's.

**The bug:** when a user verifies a peer *while* a remote sync is in flight, the subscription's `if (this._syncingFromRemoteCount === 0)` guard suppresses the publish — and **nothing ever reschedules it**. The local verification lands in the cache but is never published to the account's other devices; it survives only until some later unrelated mutation happens to trigger a publish.

**Fix:** when the guard suppresses a notification, set a `_pendingRepublish` flag; when the counter returns to zero (in `syncVerificationsFromServer`'s `finally`), schedule a publish if the flag is set, then clear it.

Be careful with nesting: the counter is a *counter* precisely because syncs can overlap. Only schedule when it actually reaches zero, and make sure a suppressed notification during an inner sync isn't lost when the outer one completes.

- [ ] **Step 1: Write the failing tests.** (a) A local verify during an in-flight sync IS published once the sync completes. (b) The remote-applied entries themselves are still NOT republished (the guard's original purpose survives). (c) Nested/overlapping syncs: a suppression during an inner sync still publishes after the outermost completes.
- [ ] **Step 2: RED. Step 3: Implement. Step 4: GREEN** + package suite.
- [ ] **Step 5: Deliberate-break.** Remove the `finally` reschedule; confirm test (a) FAILS while (b) stays green — that combination proves you fixed the drop without reopening the loop. Revert; confirm green.
- [ ] **Step 6: Typecheck + commit.**
```bash
git commit --no-gpg-sign -m "fix(openpgp-plugin): republish a local verification suppressed during remote sync"
```

---

### Task 3: Optimistic-publish edge

**Files:** Modify `OpenPGPPluginBase.ts` (publish scheduler); tests alongside.

**The bug (introduced by B2 Task 7):** the publish subscription now fires on the cache's **optimistic** in-memory mutation, before write-behind persistence resolves. If persistence then fails, the rollback notification reschedules and the fire-time read publishes the corrected map — self-healing — **unless** the persist takes longer than the 500 ms debounce, in which case an unpersisted verification is briefly published to other devices. Before B2 Task 7 the subscription fired only after a successful persist.

**Fix — decide deliberately and justify in the report.** Two credible options:
- **(a)** Have the publish path await the pending write before reading the map (e.g. expose a "settled" promise from the cache), so a publish only ever reflects persisted state.
- **(b)** Accept the optimistic publish and rely on the rollback republish, but make the correction unconditional and prompt rather than debounce-dependent.

**(a) is preferred** — it restores the pre-B2 invariant (published ⇒ persisted) instead of relying on a self-healing race. If you choose (b), justify why, and cover the >500 ms-persist case explicitly.

Do not change the debounce interval as the "fix"; that only narrows the window.

- [ ] **Step 1: Write the failing test.** Gate persistence so it resolves *after* the debounce fires; assert no publish carries an entry that never persisted (or, under (b), that the correction lands regardless of timing).
- [ ] **Step 2: RED. Step 3: Implement. Step 4: GREEN** + package suite.
- [ ] **Step 5: Deliberate-break.** Revert to the optimistic read; confirm the test FAILS; revert; confirm green.
- [ ] **Step 6: Typecheck + commit.**
```bash
git commit --no-gpg-sign -m "fix(openpgp-plugin): publish only persisted verification state"
```

> **Safe stopping point.** Races fixed, nothing moved.

---

### Task 4: Sync-version counter → `PluginStorage` (with a synchronous cache)

**Files:** Create `syncVersionCache.ts` + test; create `legacyTrustStateSeed.ts` + test; modify `verificationSync.ts`, `OpenPGPPluginBase.ts`, `trustStateIntegrity.ts`.

**The hinge:** `loadAppliedVerificationsVersion()` is **synchronous** and is called from `buildCanonicalSnapshot` (`trustStateIntegrity.ts:45`), which must stay synchronous, and from the publish scheduler (`OpenPGPPluginBase.ts:1478`). So the counter cannot simply become an async `PluginStorage` read.

**Design** — mirror `VerifiedKeysCache` (B1), which solved exactly this shape:
- `SyncVersionCache` holding the number in memory: `hydrate(): Promise<void>`, synchronous `get(): number`, async `set(v: number): Promise<void>` that updates memory synchronously then persists write-behind.
- **Roll back the in-memory value if the persist rejects**, exactly as `VerifiedKeysCache` does — B1 established that memory running ahead of disk is what manufactures a false `compromised` verdict on the next launch, and the version counter feeds the same snapshot.
- Hydrate in `init` **before** anything can read it (`init` has early returns that skip `activateSubscriptions`; hydration must not live there — see B1's Task 3).
- Keep the exported `loadAppliedVerificationsVersion`/`saveAppliedVerificationsVersion` names if practical, now delegating to the cache, so call sites don't churn.

**Migration** (`legacyTrustStateSeed.ts`, following `legacyVerifiedPeersSeed.ts`'s shape): read `fluux-e2ee-verifications-version` — scoped **and** unscoped — seed once when `PluginStorage` has no value, then remove **all** keys that held it. Never lower the version during migration (take the max if both exist).

- [ ] **Step 1: Write the failing tests.** Cache: sync `get` after an awaited `set`; memory updates before persistence resolves; rollback on persist failure; hydrate loads a persisted value. Migration: scoped present → seeded; unscoped present → seeded; both → higher wins and **both** keys removed; `PluginStorage` already populated → legacy not read; a second `init` is a no-op. Integration: `buildCanonicalSnapshot` still returns the right `syncVersion` synchronously.
- [ ] **Step 2: RED. Step 3: Implement. Step 4: GREEN** + package suite.
- [ ] **Step 5: Deliberate-break — two.** (i) Disable the migration; confirm the scoped-key upgrade test FAILS; restore; green. (ii) Remove the rollback-on-persist-failure; confirm that test FAILS; restore; green.
- [ ] **Step 6: Typecheck + commit.**
```bash
git commit --no-gpg-sign -m "feat(openpgp-plugin): move the verifications version counter into PluginStorage"
```

---

### Task 5: Seal blob + init flag → `PluginStorage`

**Files:** Modify `trustStateIntegrity.ts`, `OpenPGPPluginBase.ts`; extend `legacyTrustStateSeed.ts`; tests.

**Why these two move together:** `verifyTrustStateSeal` treats "no seal present, but the init flag says we've sealed before, and the stores hold data" as **`compromised`** (`trustStateIntegrity.ts` — the "seal was removed but stores contain data" branch). Migrating the blob without the flag, or either without the other, produces a **false tamper warning generated by our own refactor**. Move both in one commit, migrate both in one step.

The seal's read/write sites are already in async contexts (verified during B1 grounding: every path into `buildCanonicalSnapshot` is reached from an `async` function), so `sealTrustState`/`verifyTrustStateSeal` may become async-storage-backed — but `buildCanonicalSnapshot` itself must stay synchronous, which Task 4 already guarantees for the version field.

**Migration ordering matters:** write the seal into `PluginStorage`, confirm it is durable, and only then remove the legacy keys. Removing first and failing to persist would destroy the seal and produce `compromised` on the next launch.

- [ ] **Step 1: Write the failing tests.** Post-migration `verifyTrustStateSeal` returns **`sealed`** (not `compromised`) for unchanged state — this is the headline assertion. Plus: seal round-trips through `PluginStorage`; the init flag survives; both legacy keys (scoped and unscoped) are read and removed; a failed persist leaves the legacy keys intact.
- [ ] **Step 2: RED. Step 3: Implement. Step 4: GREEN** + package suite.
- [ ] **Step 5: Deliberate-break — two.** (i) Migrate the seal but skip the init flag; confirm a test reports `compromised` (proving the together-ness is guarded, then restore). (ii) Remove the legacy keys *before* the persist resolves and force a persist failure; confirm the "legacy keys intact on failure" test FAILS; restore; green.
- [ ] **Step 6: Typecheck + commit.**
```bash
git commit --no-gpg-sign -m "feat(openpgp-plugin): move the trust-state seal and init flag into PluginStorage"
```

---

### Task 6: Full verification gate

- [ ] **Step 1:** `npm run typecheck` → clean (5 workspaces).
- [ ] **Step 2:** `cd packages/openpgp-plugin && npx vitest run` → green, no stderr.
- [ ] **Step 3:** `cd packages/fluux-sdk && npx vitest run` → green.
- [ ] **Step 4:** `cd apps/fluux && npx vitest run` → green.
- [ ] **Step 5: Grep-guard.** `grep -rn "localStorage" packages/openpgp-plugin/src/ | grep -v test` — the only remaining hits must be the legacy migration modules, `backupMarker.ts`, and the peer-key cache. No trust-state key (`trust-state-seal`, `trust-integrity-init`, `verifications-version`) may be read or written outside a migration module.
- [ ] **Step 6:** Record completion in the SDD ledger.

---

## Non-Autonomous Gates

1. **Manual E2E (`tauri:dev` and web).** The two that matter:
   - **Upgrade check.** Launch a build from *before this branch* so all three values exist in `localStorage`, then launch this branch: verifications still verified, **no "trust state compromised" banner**, and the trust-state status reads `sealed`. This is the only real-data exercise of the migration and the one most likely to surface a false tamper alarm.
   - **Two-device sync.** Verify on device A while device B is syncing; confirm it reaches B (Task 2's dropped-write fix), that neither device loops republishing (the guard), and that the version counter only ever increases.
2. **Re-sign** the `--no-gpg-sign` commits from RustRover before merge.

## Follow-up (not this plan)

- `backupMarker.ts`'s stale rationale + possible move to `PluginStorage` (B0 invalidated its stated reason).
- The peer-key cache (`OpenPGPPluginBase.ts:132-164`) — a performance cache, not trust state; move only if there's a reason beyond tidiness.
- Phase B's remaining follow-ups: pins and key-change alerts still live app-side behind `hostStores` (spec decision 3); the earlier-noted `notify` granularity (re-verifying an identical fingerprint schedules a redundant publish).
