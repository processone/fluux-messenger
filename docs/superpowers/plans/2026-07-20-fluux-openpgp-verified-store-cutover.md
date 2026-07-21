# OpenPGP Verified-Store Cutover (Phase B2) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move the app's remaining verified-key readers onto a plugin-backed reactive view, then delete the legacy `verifiedPeerKeysStore`, the `hostStores.verifiedPeers` coupling, and B1's dual-write mirror — leaving the plugin as the sole owner of verified-key state.

**Architecture:** `VerifiedKeysCache` gains a synchronous `subscribe` and a referentially-stable snapshot. The plugin exposes a narrow public `VerifiedKeysView` (read + subscribe only). An app-side adapter holds the registered plugin's view and exposes `useVerifiedFingerprint(jid)` via `useSyncExternalStore`, returning a **primitive** so existing dependency arrays keep their semantics. Readers migrate one at a time (each independently green, dual-write still active). Only then does the mirror come out: the plugin's two internal subscriptions move from the mirror to the cache, the dual-write helpers collapse to plain cache writes, and the store is deleted.

**Tech Stack:** TypeScript, React (`useSyncExternalStore`), Vitest + Testing Library.

**Spec:** `docs/superpowers/specs/2026-07-20-fluux-openpgp-trust-behind-plugin-phase-b-design.md` §B2. Depends on B0 (`61f26dbb..66ceb153`) and B1 (`2efa3d90..fadac020`).

## Four things grounding found that the spec's §B2 did not anticipate

Read these before Task 1; each drives a task.

1. **`VerifiedKeysCache` has no `subscribe`.** The spec assumed a plugin-backed view could just be built. The cache has `isVerified`/`getAll` and async writes, no notification. Task 1 adds it.
2. **`verifiedKeys` is `protected`** (`OpenPGPPluginBase.ts:404`) — the app cannot reach it. Task 2 adds a narrow public view; do NOT widen the field to public or hand the app the raw cache (writes must keep going through `setIdentityTrust`).
3. **`DemoOpenPGPPlugin` now writes the legacy store** (`DemoOpenPGPPlugin.ts:181,183`) — a consumer **B1's own final fix created**. It `implements E2EEPlugin` standalone, has no `PluginStorage` and no cache, so deleting the store breaks demo verify a second time. Task 6 gives it its own holder.
4. **`getAll()` returns a new object every call** (`Object.fromEntries`, `verifiedKeysCache.ts:95`). Passing that to `useSyncExternalStore`'s `getSnapshot` trips React's *"The result of getSnapshot should be cached to avoid an infinite loop"* guard. Task 1 adds a cached snapshot invalidated on mutation, and the app hook returns a **primitive** per JID rather than a map.

## Global Constraints

- **Reads stay synchronous inside the plugin.** `evaluatePeerTrust`, `buildInboundSecurityContext`, `buildCanonicalSnapshot`, `storesAreEmpty` must not become async.
- **The app hook must return a primitive** (`string | null`). `useConversationEncryptionState` puts it in two dependency arrays (`:288`, `:422`) and the memo compares it; returning an object/handle re-fires the probe effect (a network round-trip) on every render.
- **The warm-start fast path must keep working.** `useConversationEncryptionState:247-263` reads the verified fingerprint **synchronously** and `return`s before `setBase({kind:'checking'})` at `:265`. If the value can only arrive asynchronously, the chip flashes "checking" on every reconnect and a verified peer transiently renders `firstSeen`.
- **Notification must be synchronous on mutation, and must also fire on rollback.** B1's writes mutate memory synchronously then persist write-behind, rolling the mutation back if persistence fails. Subscribers must see both edges, or the UI shows a verification that did not survive.
- **The `_syncingFromRemoteCount` guard must keep working after the subscription move.** It works today because the mirror's Zustand notification fires synchronously inside the guarded window; the cache's notification must have the same timing property.
- **Unregistered-plugin contract** (no OpenPGP plugin registered — before registration completes, OpenPGP disabled, OMEMO-only): `useVerifiedFingerprint` returns `null`, `subscribe` is a no-op returning an unsubscribe function, and the snapshot is a **stable** empty value. When a plugin later registers, subscribers must be notified so mounted components re-render — reuse the existing `pluginRegisteredAt` signal (`useConversationEncryptionState.ts:134`) rather than inventing a second mechanism.
- **Fingerprint normalization stays in the cache** (`fingerprintsEqual`). Do not add a stricter comparison at a call site.
- Crypto untouched; no Sequoia vector regeneration. Commits `--no-gpg-sign`; never push; no Claude footer.
- **Every test guarding a data-loss or trust-downgrade property must be proven with a deliberate-break check** — introduce the exact regression the test names, confirm it FAILS, revert, confirm green, and report both outputs. B0 and B1 shipped five tests that could not fail, all plan-prescribed and all review-passing until someone tried to break them. This is the gate that catches them.
- **Worktree:** `.claude/worktrees/openpgp-phase-b` has its own `node_modules`; SDK and the three branch-only packages are built. Do NOT run `npm install`. If types go stale: `npm run build:sdk` and `npm run build -w <pkg>`.

## Sequencing and the safe stopping point

Tasks 1–6 are **additive and behavior-preserving** — the dual-write mirror stays live throughout, so every task is independently green and shippable. Tasks 7–8 are the **cutover**: they move the plugin's internal subscriptions to the cache and delete the mirror. If the branch needs to pause, **stop after Task 6** — that is a coherent, working state.

## File Structure

- `packages/openpgp-plugin/src/verifiedKeysCache.ts` — `subscribe` + cached snapshot + notify-on-rollback (Task 1).
- `packages/openpgp-plugin/src/OpenPGPPluginBase.ts` — public `getVerifiedKeysView()` (Task 2); subscription rewire + dual-write collapse (Task 7).
- `packages/openpgp-plugin/src/index.ts` — export the `VerifiedKeysView` type (Task 2).
- `apps/fluux/src/e2ee/verifiedPeersView.ts` — **new**: app-side adapter + `useVerifiedFingerprint` (Task 3).
- `apps/fluux/src/hooks/useConversationEncryptionState.ts` — reader migration (Task 4).
- `apps/fluux/src/components/conversation/MessageBubble.tsx` — reader migration (Task 5).
- `apps/fluux/src/demo/DemoOpenPGPPlugin.ts` — own verified holder (Task 6).
- Deletions (Task 8): `apps/fluux/src/stores/verifiedPeerKeysStore.ts` + test, the `verifiedPeers` group in `packages/openpgp-plugin/src/hostStores.ts`, its adapter in `apps/fluux/src/e2ee/registerPlugins.ts`, the `rehydrateVerifiedPeerKeys()` call in `apps/fluux/src/hooks/useAccountScopeRehydration.ts`.

---

### Task 1: `VerifiedKeysCache` — subscribe + stable snapshot

**Files:**
- Modify: `packages/openpgp-plugin/src/verifiedKeysCache.ts`
- Test: `packages/openpgp-plugin/src/verifiedKeysCache.test.ts`

**Interfaces produced** (Tasks 2, 3, 7 depend on these exactly):
- `subscribe(listener: () => void): () => void` — synchronous notification; returns an unsubscribe.
- `getSnapshot(): Record<string, string>` — **referentially stable** between mutations (same object identity on repeated calls until something changes).
- `getAll()` keeps its current behavior (fresh copy) for existing internal callers.

- [ ] **Step 1: Write the failing tests.**

```ts
it('notifies subscribers synchronously on setVerified, before persistence resolves', async () => {
  // gate storage.put behind a promise (the pattern already used in this file);
  // assert the listener fired and getSnapshot() reflects the change BEFORE releasing the gate
})

it('notifies again on rollback when persistence fails, so the UI reverts', async () => {
  // storage.put rejects -> listener fires twice (mutation, then rollback) and the
  // final snapshot no longer contains the entry
})

it('getSnapshot returns the SAME object identity when nothing changed', async () => {
  const c = new VerifiedKeysCache(memStorage()); await c.hydrate()
  await c.setVerified('bob@x', 'ABCD')
  expect(c.getSnapshot()).toBe(c.getSnapshot())   // identity, not deep-equality
})

it('getSnapshot returns a NEW identity after a mutation', async () => { /* … */ })

it('unsubscribe stops further notifications', async () => { /* … */ })

it('a listener that throws does not prevent other listeners from being notified', async () => { /* … */ })

it('notifies on clearVerified and on seed', async () => { /* … */ })
```

The identity tests are the ones that matter — they are what stands between this and React's infinite-loop guard.

- [ ] **Step 2: Run, verify RED.** `cd packages/openpgp-plugin && npx vitest run src/verifiedKeysCache.test.ts`

- [ ] **Step 3: Implement.** Add to the class:

```ts
  private listeners = new Set<() => void>()
  /** Cached immutable snapshot; invalidated (set to null) on every mutation. */
  private snapshot: Record<string, string> | null = null

  /**
   * Subscribe to verified-state changes. Notification is SYNCHRONOUS and fires
   * on the in-memory mutation — before write-behind persistence resolves — and
   * again on rollback if that persistence fails. Both edges matter: the first
   * makes the UI update immediately, the second makes it revert honestly rather
   * than showing a verification that never reached disk.
   *
   * The synchronous timing is also load-bearing for the plugin's own
   * verification-sync guard, which relies on the notification landing inside
   * the `_syncingFromRemoteCount` window.
   */
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  /**
   * Referentially stable snapshot for `useSyncExternalStore`: repeated calls
   * return the SAME object until a mutation invalidates it. Returning a fresh
   * object each call (as `getAll()` does) trips React's
   * "getSnapshot should be cached" infinite-loop guard.
   */
  getSnapshot(): Record<string, string> {
    if (this.snapshot === null) this.snapshot = Object.fromEntries(this.map)
    return this.snapshot
  }

  private notify(): void {
    this.snapshot = null
    for (const l of [...this.listeners]) {
      try {
        l()
      } catch {
        // One bad subscriber must not stop the others (or abort a write).
      }
    }
  }
```

Call `this.notify()` in `setVerified`/`clearVerified`/`seed` immediately after the in-memory mutation **and** inside each `catch` after the rollback, before rethrowing.

- [ ] **Step 4: Run, verify GREEN**, then the whole package suite.

- [ ] **Step 5: Deliberate-break.** Make `getSnapshot` return `Object.fromEntries(this.map)` unconditionally; confirm the identity test FAILS; revert; confirm green. Then remove the `notify()` from a rollback `catch`; confirm the rollback-notification test FAILS; revert; confirm green. Report all four outputs.

- [ ] **Step 6: Typecheck + commit.**

```bash
git commit --no-gpg-sign -m "feat(openpgp-plugin): subscribable verified-keys cache with a stable snapshot"
```

---

### Task 2: Public `VerifiedKeysView` on the plugin

**Files:**
- Modify: `packages/openpgp-plugin/src/verifiedKeysCache.ts` (export the interface) and `OpenPGPPluginBase.ts` (accessor)
- Modify: `packages/openpgp-plugin/src/index.ts`
- Test: `packages/openpgp-plugin/src/OpenPGPPluginBase.verifiedCache.test.ts`

**Interfaces produced** (Task 3 and Task 6 both implement/consume this):
```ts
export interface VerifiedKeysView {
  isVerified(jid: string, fingerprint: string): boolean
  getVerifiedFingerprint(jid: string): string | null
  getSnapshot(): Record<string, string>
  subscribe(listener: () => void): () => void
}
```
plus `OpenPGPPluginBase.getVerifiedKeysView(): VerifiedKeysView`.

**Read-only by design:** the view exposes no writes. App writes must keep going through `setIdentityTrust` (that is what B1's Critical fix established). Do not widen `verifiedKeys` to public and do not return the raw cache.

- [ ] **Step 1: Write the failing tests.** `getVerifiedKeysView()` reflects the cache (verified after a write, `null` fingerprint for an unknown peer, snapshot stable, subscribe fires). Add `getVerifiedFingerprint(jid)` to `VerifiedKeysCache` if it isn't there — it returns the stored fingerprint or `null`, with no comparison.

- [ ] **Step 2: RED.**

- [ ] **Step 3: Implement.** Declare `VerifiedKeysView` in `verifiedKeysCache.ts`, have `VerifiedKeysCache` satisfy it structurally, add:
```ts
  /**
   * Narrow, READ-ONLY view of verified-key state for the host app's reactive
   * reads. Deliberately exposes no writes: app-side verify/revoke must go
   * through `setIdentityTrust` so the plugin stays the single writer.
   */
  getVerifiedKeysView(): VerifiedKeysView {
    return this.verifiedKeys
  }
```
Export the type from `index.ts`.

- [ ] **Step 4: GREEN** + package suite. **Step 5: Typecheck + commit.**

```bash
git commit --no-gpg-sign -m "feat(openpgp-plugin): expose a read-only verified-keys view"
```

---

### Task 3: App-side adapter + `useVerifiedFingerprint`

**Files:**
- Create: `apps/fluux/src/e2ee/verifiedPeersView.ts`
- Create: `apps/fluux/src/e2ee/verifiedPeersView.test.ts`
- Modify: `apps/fluux/src/e2ee/registerPlugins.ts` (set the view on register; clear on unregister)

**Interfaces produced** (Tasks 4 and 5 consume these):
- `setVerifiedKeysView(view: VerifiedKeysView | null): void` — called at registration/unregistration.
- `useVerifiedFingerprint(jid: string | null): string | null` — reactive, **primitive**.
- `getVerifiedFingerprintNow(jid: string): string | null` — non-reactive imperative read (for effect bodies that need a synchronous value).

**The unregistered-plugin contract is the substance of this task** (see Global Constraints). Implement it as a module-level holder with its own listener set, so subscribers registered before the plugin exists stay valid and get notified when `setVerifiedKeysView` is called with a real view.

- [ ] **Step 1: Write the failing tests.**
- Returns `null` for every JID when no view is set, and `subscribe` is a safe no-op.
- Notifies subscribers when a view is later set (mounted components re-render).
- With a view set, returns the peer's fingerprint and updates when the underlying cache changes.
- Returns `null` for a `null` JID (the hook is called unconditionally with a possibly-null peer).
- **Stability:** repeated renders with unchanged state do not loop — assert `getSnapshot`-equivalent identity stability through the hook, e.g. render a component that counts renders and confirm it does not grow without state changes. This is the React-loop guard; make it a real assertion, not a smoke test.
- Clearing the view (unregister) reverts to `null` and notifies.

- [ ] **Step 2: RED.**

- [ ] **Step 3: Implement.** A module holder + `useSyncExternalStore`. Sketch (adapt to the file's conventions):

```ts
let currentView: VerifiedKeysView | null = null
const holderListeners = new Set<() => void>()
let unsubscribeFromView: (() => void) | null = null

export function setVerifiedKeysView(view: VerifiedKeysView | null): void {
  unsubscribeFromView?.()
  currentView = view
  unsubscribeFromView = view ? view.subscribe(notifyHolder) : null
  notifyHolder()   // plugin (un)registered — mounted components must re-read
}

function subscribe(listener: () => void): () => void {
  holderListeners.add(listener)
  return () => holderListeners.delete(listener)
}

export function useVerifiedFingerprint(jid: string | null): string | null {
  return useSyncExternalStore(
    subscribe,
    // Primitive result: Object.is-comparable, so React re-renders only on a
    // real change and the value stays safe to put in dependency arrays.
    () => (jid ? (currentView?.getVerifiedFingerprint(jid) ?? null) : null),
  )
}
```
Note the snapshot here is a **primitive**, so the identity trap does not apply to this hook — but keep `getSnapshot` on the view for anything that later needs the whole map, and do not add a map-returning hook in this task (YAGNI).

In `registerPlugins.ts`, call `setVerifiedKeysView(plugin.getVerifiedKeysView())` after a successful OpenPGP `register`, and `setVerifiedKeysView(null)` in `unregisterE2EEPlugins` when the OpenPGP plugin is removed. Check how `notifyPluginRegistered()` is already sequenced there and place the call consistently.

- [ ] **Step 4: GREEN** + `cd apps/fluux && npx vitest run src/e2ee`. **Step 5: Typecheck + commit.**

```bash
git commit --no-gpg-sign -m "feat(e2ee): app-side plugin-backed verified-keys view"
```

---

### Task 4: Migrate `useConversationEncryptionState`

**Files:**
- Modify: `apps/fluux/src/hooks/useConversationEncryptionState.ts`
- Test: `apps/fluux/src/hooks/useConversationEncryptionState.test.tsx`

Replace the Zustand selector at `:148-150`:
```ts
const verifiedFingerprint = useVerifiedPeerKeysStore((s) =>
  peerJid ? (s.verifiedFingerprintByJid[peerJid] ?? null) : null,
)
```
with `const verifiedFingerprint = useVerifiedFingerprint(peerJid)`.

**Everything else stays.** The value is still a primitive, so both dependency arrays (`:288`, `:422`) and the `memoResult` derivation (`:413-421`, including `fingerprintsEqual` and the `firstSeen`/`isTofuNew` logic) are unchanged. The warm-start fast path at `:247-263` keeps reading it synchronously.

- [ ] **Step 1: Adapt the tests.** The existing suite seeds the legacy store directly (two blocks, ~`:262-350` and ~`:548-611`) — they are the regression net for the warm-start fast path and the trust derivation. Re-point them at the new view (seed a fake `VerifiedKeysView` via `setVerifiedKeysView`) **without weakening a single assertion**. If an assertion cannot be expressed against the new seam, say so in the report rather than dropping it.
- [ ] **Step 2: RED.** (They should fail while the hook still reads the store and the tests seed the view.)
- [ ] **Step 3: Implement** the one-line swap plus the import.
- [ ] **Step 4: GREEN**, then `cd apps/fluux && npx vitest run src/hooks`.
- [ ] **Step 5: Deliberate-break.** Make `useVerifiedFingerprint` always return `null`; confirm both the warm-start test and the verified-trust test FAIL; revert; confirm green. Report both.
- [ ] **Step 6: Typecheck + commit.**

```bash
git commit --no-gpg-sign -m "refactor(e2ee): read conversation verified state from the plugin view"
```

---

### Task 5: Migrate `MessageBubble`

**Files:**
- Modify: `apps/fluux/src/components/conversation/MessageBubble.tsx` (`:11` import, `:367-370`)
- Test: `apps/fluux/src/components/conversation/MessageBubble.test.tsx`

This is the per-row live trust color — the file's own comment records why it must track verification **live** rather than freezing at decrypt time. Swap the selector for `useVerifiedFingerprint(getBareJid(message.from))`, keeping `resolveDisplayTrust(...)` unchanged.

The existing test toggles verification around renders (`setPeerVerified`/`clearPeerVerified`) to assert the color updates; re-point that at the view seam, preserving the live-update assertion — that is the whole point of the test.

- [ ] **Step 1: Adapt tests. Step 2: RED. Step 3: Implement. Step 4: GREEN** + `npx vitest run src/components/conversation`.
- [ ] **Step 5: Deliberate-break.** Freeze the value (return a constant); confirm the live-update assertion FAILS; revert; confirm green.
- [ ] **Step 6: Typecheck + commit.**

```bash
git commit --no-gpg-sign -m "refactor(e2ee): read message trust color from the plugin view"
```

---

### Task 6: Give `DemoOpenPGPPlugin` its own verified holder

**Files:**
- Modify: `apps/fluux/src/demo/DemoOpenPGPPlugin.ts`
- Modify: `apps/fluux/src/demo.tsx` (`:22`, `:135` — the seed)
- Test: `apps/fluux/src/demo/DemoOpenPGPPlugin.test.ts`

`DemoOpenPGPPlugin implements E2EEPlugin` standalone — no base class, no `PluginStorage`, no cache — and B1's fix made it write `useVerifiedPeerKeysStore` directly. That store is about to be deleted, so it needs its own holder.

Give it a small in-memory map that satisfies `VerifiedKeysView` (`isVerified`/`getVerifiedFingerprint`/`getSnapshot`/`subscribe`, with the same stable-snapshot property), have its `setIdentityTrust` write that map, and add `getVerifiedKeysView()` so `registerPlugins`' Task-3 wiring treats it like any other plugin. Move `demo.tsx:135`'s seed onto the same holder (seed it at construction, or expose a seam the demo can call) and drop the store import.

Demo mode is user-visible (`demo.fluux.io` tracks `main`, and it drives the screenshot script and promo reel), so verify the demo verify flow still flips the chip.

- [ ] **Step 1: Write the failing tests** — demo `setIdentityTrust('verified')` makes `getVerifiedKeysView().isVerified(...)` true and notifies; `'untrusted'` clears; the Ava seed is present at boot.
- [ ] **Step 2: RED. Step 3: Implement. Step 4: GREEN** + `npx vitest run src/demo`.
- [ ] **Step 5: Typecheck + commit.**

```bash
git commit --no-gpg-sign -m "feat(demo): demo OpenPGP plugin owns its verified state"
```

> **Safe stopping point.** Everything through here is additive; the mirror is still live and the branch is coherent. Tasks 7–8 are the cutover.

---

### Task 7: Move the plugin's internal subscriptions to the cache

**Files:**
- Modify: `packages/openpgp-plugin/src/OpenPGPPluginBase.ts`
- Test: `packages/openpgp-plugin/src/OpenPGPPluginBase.verifiedCache.test.ts` (+ the sync tests in `SequoiaPgpPlugin.test.ts`)

Two registrations currently hang off the mirror and must move to `this.verifiedKeys.subscribe(...)`:
- `~:623` → `scheduleVerificationsPublish(verifiedMap)`, guarded by `if (this._syncingFromRemoteCount === 0)`.
- `~:633` → `scheduleTrustStateSeal()`.

The publish callback currently receives the map as an argument. The cache's `subscribe` passes no argument, so read `this.verifiedKeys.getSnapshot()` (or `getAll()`) inside the callback instead — which is also **more correct**: B1's re-review found `scheduleVerificationsPublish` was publishing a map captured 500 ms earlier, able to clobber a newer remote snapshot. Reading at fire time removes that capture. (The remaining sync-race hardening is B3's job; do not take it on here.)

**The guard is the risk.** `_syncingFromRemoteCount` works because the notification lands synchronously inside the guarded window. Task 1's `notify()` is synchronous on mutation, so this holds — but it must be **tested**, not assumed.

- [ ] **Step 1: Write the failing tests.**
- A local verify triggers a publish; a remote-sync apply does **not** (the guard still suppresses it).
- A verified-state change still schedules a trust-state reseal.
- The published map reflects state **at fire time**, not at schedule time.
- [ ] **Step 2: RED. Step 3: Implement. Step 4: GREEN** + package suite.
- [ ] **Step 5: Deliberate-break.** Remove the `_syncingFromRemoteCount` check from the new subscription; confirm the "remote apply does not republish" test FAILS; revert; confirm green. This is the one that prevents a cross-device republish loop.
- [ ] **Step 6: Typecheck + commit.**

```bash
git commit --no-gpg-sign -m "refactor(openpgp-plugin): drive publish and reseal from the verified cache"
```

---

### Task 8: Delete the mirror

**Files:**
- Modify: `packages/openpgp-plugin/src/OpenPGPPluginBase.ts` — collapse `setVerifiedDual`/`clearVerifiedDual` to plain cache writes (keep the helpers as the single write funnel, just without the mirror leg), drop the `seed(...)` call's legacy argument (see below).
- Modify: `packages/openpgp-plugin/src/hostStores.ts` — remove the `verifiedPeers` group.
- Modify: `packages/openpgp-plugin/src/dualWriteInvariant.test.ts` — the sanctioned list shrinks to zero; either retarget it (assert **no** `hostStores.verifiedPeers` reference remains anywhere in the package) or delete it with a note. Retargeting is preferred — it keeps a live guard against the coupling coming back.
- Modify: `apps/fluux/src/e2ee/registerPlugins.ts` — remove the adapter block and the now-unused imports.
- Modify: `apps/fluux/src/hooks/useAccountScopeRehydration.ts` — remove the `rehydrateVerifiedPeerKeys()` call (`:3`, `:31`). Per-account isolation now comes from the plugin's per-account `ctx.storage` and `init` re-running per account.
- Delete: `apps/fluux/src/stores/verifiedPeerKeysStore.ts` and `apps/fluux/src/stores/verifiedPeerKeysStore.test.ts`.

**The seeding question — resolve it explicitly, do not guess.** `init` currently seeds the cache from `hostStores.verifiedPeers.getAll()` (`~:566`), which is the **upgrade path for existing installs**: their verifications live in that localStorage key and B1 copies them into `PluginStorage` on first run. Deleting the store naively would strand anyone who has not launched a B1 build. Choose and justify one:
- **(a)** Keep a one-shot localStorage read in the plugin (or a small app-side shim passed at registration) that reads the legacy scoped key `fluux-e2ee-verified-peers` directly, seeds, and then removes it. Note the store also had its own unscoped→scoped migration (`verifiedPeerKeysStore.ts:47-55`), so unmigrated blobs may still exist — handle both keys.
- **(b)** Declare B1 the required intermediate build and delete the seed outright.

**(a) is the safe choice** and the plan's recommendation: this is a long-running branch heading for a 0.18.0 alpha, and a user upgrading from a released build has never run B1. Whichever you pick, state it in the report and cover it with a test.

- [ ] **Step 1: Write the failing tests** — the seed path you chose and the retargeted invariant guard. The seeding tests are the ones that protect real users' data, so they must be specific, not a smoke test:
  - a legacy **scoped** key (`fluux-e2ee-verified-peers:<bare-jid>`) present and `PluginStorage` empty → after `init`, the verification is readable through the plugin AND persisted (a fresh cache over the same storage sees it);
  - a legacy **unscoped** key present (the pre-migration blob) → same outcome;
  - both present → the scoped one wins, and no entry is lost;
  - `PluginStorage` already populated → the legacy key is **not** re-read and cannot clobber plugin-owned data;
  - after a successful seed, the legacy key is removed (if you chose to remove it) and a second `init` is a no-op.
- [ ] **Step 2: RED. Step 3: Implement the deletions.**
- [ ] **Step 4: GREEN** — package suite, then the **full app suite** (this is where a missed consumer surfaces as a module-resolution failure).
- [ ] **Step 5: Deliberate-break — two of them.**
  - Re-introduce a `hostStores.verifiedPeers`-style reference (or whatever the retargeted guard now forbids); confirm the guard FAILS; revert; confirm green.
  - **Disable the legacy seed** (skip the read); confirm the scoped-key upgrade test FAILS; revert; confirm green. This is the one that proves existing users' verifications actually survive the deletion rather than the test passing because the data happened to be somewhere else.
- [ ] **Step 6: Typecheck + commit.**

```bash
git commit --no-gpg-sign -m "refactor(e2ee): delete the legacy verified-peers store and dual-write mirror"
```

---

### Task 9: Full verification gate

**Files:** none (verification only).

- [ ] **Step 1:** `npm run typecheck` → clean (5 workspaces).
- [ ] **Step 2:** `cd packages/openpgp-plugin && npx vitest run` → green, no stderr.
- [ ] **Step 3:** `cd packages/fluux-sdk && npx vitest run` → green.
- [ ] **Step 4:** `cd apps/fluux && npx vitest run` → green.
- [ ] **Step 5: Grep-guards.** All must return nothing:
  - `grep -rn "verifiedPeerKeysStore\|setPeerVerified\|clearPeerVerified\|rehydrateVerifiedPeerKeys" apps/fluux/src packages/` — the store is gone, including from tests.
  - `grep -rn "verifiedPeers" packages/openpgp-plugin/src/` — the host-store coupling is gone.
- [ ] **Step 6:** Record completion in the SDD ledger.

---

## Non-Autonomous Gates

1. **Manual E2E (`tauri:dev` and web).** Verify a peer → chip, ChatHeader, and message bubbles all flip to verified **live** (this is the reactive path B2 rewires; a stale read shows up here and nowhere else). Quit and relaunch → still verified. Revoke → back to TOFU everywhere. Two-device: verify on device A, confirm it appears on B and that neither device loops republishing. **Upgrade check (the risky one):** launch a build from *before* B1 to write a verification into the old localStorage key, then launch this branch and confirm the verification survives — that exercises the Task-8 seeding path on real data. Finally, check demo mode still verifies.
2. **Re-sign** the `--no-gpg-sign` commits from RustRover before merge.

## Follow-up (not this plan)

**B3:** move the seal blob, its init flag, and the sync-version counter into `PluginStorage`, and harden the four verification-sync races (guard preserved across async writes, stale-map republish — partly addressed by Task 7, version-counter regression, dropped local write).
