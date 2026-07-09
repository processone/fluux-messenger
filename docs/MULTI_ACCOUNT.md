# Multi-Account — Design & Migration Spec

**Status:** future work · seam in place, migration not started
**Origin:** [STRATEGIC_REVIEW.md](STRATEGIC_REVIEW.md) §4 · [ROADMAP_2026.md](ROADMAP_2026.md)

Fluux is single-account today. Running several accounts at once (each with its own
connection, roster, rooms, and persisted state) is planned but not built. The SDK already
exposes the *seam* for it — `new XMPPClient({ stores })` — but a working multi-account
client needs more than that seam. This doc records what exists, what's missing, and the
concrete known gaps so they aren't "fixed" piecemeal in ways that don't actually compose.

---

## 1. What exists today: the store-injection seam

The client no longer reaches for the module-global store singletons directly. It takes an
`SDKStores` bundle (`packages/fluux-sdk/src/stores/sdkStores.ts`) via
`new XMPPClient({ stores })`, defaulting to `defaultStores` — the process-wide singletons —
so existing single-account usage is unchanged.

`SDKStores` is a bundle of nine vanilla Zustand **store handles** (get/set/subscribe):
connection, chat, roster, room, events, admin, blocking, console, ignore. (`searchStore` is
intentionally excluded — it is not part of the client's store bindings.)

Accepting a custom bundle is necessary but **not sufficient** for multi-account.

---

## 2. What's still missing

1. **A `createStores()` factory.** Each store is a module singleton today
   (`export const chatStore = createStore(...)`); refactor to `createXStore()` factories
   (keeping the singletons as `defaultStores`) so every account gets an isolated set.

2. **Per-instance storage scope.** `storageScope.ts` holds ONE module-global
   `currentStorageScopeJid`. Persisted stores (chat, ignore), the message cache (IndexedDB)
   and the search index already namespace by it (`buildScopedStorageKey` /
   `getStorageScopeJid`), so the keys are fine — but the scope must become
   per-bundle/per-client instead of a global, since only one account's scope can be active
   at a time right now.

3. **Threading the bundle through direct-global consumers.** Anything that imports the raw
   store singletons instead of reading `client.stores` (some side-effect submodules, utils,
   bindings) must take the bundle instead. See §3 for the known instances.

4. **The app's React layer.** App hooks bind to the global singletons; multi-account needs
   an account-scoped context providing the active client + stores, with hooks resolving from
   it rather than the module singletons.

5. **Tab coordination.** Multi-account is currently *actively prevented* by the
   single-instance tab-coordination logic (STRATEGIC_REVIEW.md §4). That guard has to become
   account-aware.

---

## 3. Known direct-global consumers (§2.3 checklist)

These import a raw store singleton instead of resolving it from the injected bundle. Each
must be threaded through `client.stores` before multi-account works. **Do not "fix" them in
isolation** — several can't be fixed correctly without a signature/plumbing change, and a
naive fix compiles-then-breaks (see the ignore-subscription case below).

### 3.1 `storeBindings.ts` ignore subscription — line ~626

```ts
// Recalculate room lastMessage previews when users are un-ignored
let prevIgnoredUsers = ignoreStoreInstance.getState().ignoredUsers
const unsubIgnore = ignoreStoreInstance.subscribe((state) => { ... })
```

`ignoreStoreInstance` is the **module-global singleton** (imported at the top of the file),
while the handler body correctly resolves `stores.room` through the injected
`getStores()`. So the *trigger* watches the global ignore store while the *effect* writes to
the injected room store.

- **Impact today:** none. Single-account always uses `defaultStores`, so
  `ignoreStoreInstance === client.stores.ignore` — same object, subscription fires correctly.
- **Impact under multi-account:** a non-default account's un-ignore would not recompute its
  room previews (cosmetic, self-healing on the next message).
- **Why the obvious fix is wrong:** `createStoreBindings(client, getStores)` receives
  `getStores: () => StoreRefs`, and `StoreRefs` values are `getState()` **snapshots**, not
  store handles — a snapshot has no `.subscribe`. So `getStores().ignore.subscribe(...)`
  would throw. The correct fix threads the `SDKStores` **handle** bundle into
  `createStoreBindings` (a signature change) so it can subscribe to the injected ignore
  store. Reported by Codex as a "P2 injected-ref inconsistency"; this is the accurate scoping.

_(Add further direct-global consumers here as they're found during the migration audit — a
`grep` for raw `Store` singleton imports outside `sdkStores.ts`/`defaultStores` is the way to
enumerate them.)_

---

## 4. Sequencing

Rough order to keep each step shippable behind the existing single-account default:

1. `createStores()` factories (§2.1) — mechanical, no behavior change; singletons stay as
   `defaultStores`.
2. Per-client storage scope (§2.2) — make scope resolution take the bundle/client.
3. Thread direct-global consumers (§2.3 / §3) — including the `storeBindings` signature
   change so the ignore subscription binds to the injected store.
4. App account-scoped context + hooks (§2.4).
5. Account-aware tab coordination (§2.5).
