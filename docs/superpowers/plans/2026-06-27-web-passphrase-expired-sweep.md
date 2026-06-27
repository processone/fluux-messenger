# Web Passphrase Cache — Proactive Expired-Record Sweep Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Delete outdated web OpenPGP passphrase cache records as soon as the app boots, instead of only lazily on next access for the matching JID.

**Architecture:** Add one best-effort function `sweepExpiredPassphrases()` to the existing `webPassphraseCache.ts` module that walks all IndexedDB records and deletes any past their `expiresAt`. Call it once, fire-and-forget, in the web-only boot block of `main.tsx`. The existing lazy on-access deletion stays as additive defense-in-depth.

**Tech Stack:** TypeScript, IndexedDB (raw `idb` request API as already used in the module), Vitest + `fake-indexeddb`.

## Global Constraints

- Web-only feature. Tauri uses the OS keychain and must be unaffected — the boot call lives inside the existing `if (!isTauri) { … }` block in `main.tsx`.
- Every cache operation is **best-effort**: wrap in `try/catch`, log via `console.warn('[Fluux] webPassphraseCache: …', err)`, never throw, never block login/logout/startup.
- Do not change the happy path or the existing lazy deletion in `loadCachedPassphrase`. This change is additive.
- No new dependencies. No live timer / `setInterval` (explicitly out of scope).
- Before committing: `npm run typecheck` and the cache test file must pass with no errors or stderr.

**Reference spec:** `docs/superpowers/specs/2026-06-27-web-passphrase-expired-sweep-design.md`

---

## File Structure

- **Modify** `apps/fluux/src/e2ee/webPassphraseCache.ts` — add the exported `sweepExpiredPassphrases()` function alongside the existing record helpers.
- **Modify** `apps/fluux/src/e2ee/webPassphraseCache.test.ts` — add sweep tests.
- **Modify** `apps/fluux/src/main.tsx` — call the sweep once at web boot.

---

### Task 1: `sweepExpiredPassphrases()` in the cache module

**Files:**
- Modify: `apps/fluux/src/e2ee/webPassphraseCache.ts` (add function near the other DB helpers / exported ops; reuse the existing `openDb`, `STORE_NAME`, `CacheRecord`)
- Test: `apps/fluux/src/e2ee/webPassphraseCache.test.ts`

**Interfaces:**
- Consumes (already in the module): `openDb(): Promise<IDBDatabase>`, `STORE_NAME` constant, `CacheRecord` interface with `{ jid: string; expiresAt: number; … }`, and existing exports `cachePassphrase(jid, passphrase, ttlMs?)`, `loadCachedPassphrase(jid): Promise<string|null>`.
- Produces (for Task 2): `export async function sweepExpiredPassphrases(): Promise<void>` — deletes every record whose `expiresAt < Date.now()`; resolves on completion; never rejects.

- [ ] **Step 1: Write the failing tests**

Add to `apps/fluux/src/e2ee/webPassphraseCache.test.ts`. The file already imports `'fake-indexeddb/auto'`, `{ IDBFactory }` from `'fake-indexeddb'`, and resets `globalThis.indexedDB` between tests. Add `sweepExpiredPassphrases` to the existing import from `'./webPassphraseCache'`.

```ts
describe('sweepExpiredPassphrases', () => {
  it('deletes expired records and keeps fresh ones', async () => {
    // Fresh record: 24h default TTL.
    await cachePassphrase('alice@example.com', 'fresh-secret')
    // Expired record: negative TTL puts expiresAt in the past.
    await cachePassphrase('bob@example.com', 'stale-secret', -1000)

    await sweepExpiredPassphrases()

    expect(await loadCachedPassphrase('alice@example.com')).toBe('fresh-secret')
    expect(await loadCachedPassphrase('bob@example.com')).toBeNull()
  })

  it('is a safe no-op on an empty database', async () => {
    await expect(sweepExpiredPassphrases()).resolves.toBeUndefined()
  })

  it('never throws when indexedDB is unavailable', async () => {
    const original = globalThis.indexedDB
    // @ts-expect-error force the failure path
    globalThis.indexedDB = undefined
    try {
      await expect(sweepExpiredPassphrases()).resolves.toBeUndefined()
    } finally {
      globalThis.indexedDB = original
    }
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run from `apps/fluux`:
```bash
cd apps/fluux && npx vitest run src/e2ee/webPassphraseCache.test.ts -t sweepExpiredPassphrases
```
Expected: FAIL — `sweepExpiredPassphrases is not a function` / import is `undefined`.

- [ ] **Step 3: Implement `sweepExpiredPassphrases`**

Add to `apps/fluux/src/e2ee/webPassphraseCache.ts` (e.g. directly after `clearAllCachedPassphrases`). Use a readwrite cursor so the scan + deletes happen in one transaction:

```ts
/** Delete every cached passphrase whose expiry has passed (best-effort sweep). */
export async function sweepExpiredPassphrases(): Promise<void> {
  try {
    const db = await openDb()
    try {
      const now = Date.now()
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, 'readwrite')
        const req = tx.objectStore(STORE_NAME).openCursor()
        req.onsuccess = () => {
          const cursor = req.result
          if (!cursor) return
          const record = cursor.value as CacheRecord
          if (now > record.expiresAt) cursor.delete()
          cursor.continue()
        }
        req.onerror = () => reject(req.error)
        tx.oncomplete = () => resolve()
        tx.onerror = () => reject(tx.error)
      })
    } finally {
      db.close()
    }
  } catch (err) {
    console.warn('[Fluux] webPassphraseCache: sweep failed', err)
  }
}
```

Note: resolution is driven by `tx.oncomplete` (fires once the cursor walk and all `cursor.delete()` calls finish), so the promise resolves only after deletions commit.

- [ ] **Step 4: Run tests to verify they pass**

Run from `apps/fluux`:
```bash
cd apps/fluux && npx vitest run src/e2ee/webPassphraseCache.test.ts
```
Expected: PASS — the new `sweepExpiredPassphrases` block plus all pre-existing cache tests.

- [ ] **Step 5: Typecheck**

Run from repo root:
```bash
npm run typecheck
```
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add apps/fluux/src/e2ee/webPassphraseCache.ts apps/fluux/src/e2ee/webPassphraseCache.test.ts
git commit -m "feat(e2ee): sweep expired web passphrase cache records"
```

---

### Task 2: Run the sweep at web boot

**Files:**
- Modify: `apps/fluux/src/main.tsx`

**Interfaces:**
- Consumes (from Task 1): `sweepExpiredPassphrases(): Promise<void>` from `'@/e2ee/webPassphraseCache'` (or the relative path that matches sibling imports in `main.tsx`).
- Produces: nothing consumed by later tasks.

- [ ] **Step 1: Add the import**

In `apps/fluux/src/main.tsx`, add to the existing import group near the other `./utils` / `./e2ee` imports:
```ts
import { sweepExpiredPassphrases } from '@/e2ee/webPassphraseCache'
```
Match the import-path style already used in the file (alias `@/…` vs relative). If `main.tsx` uses relative paths, use `'./e2ee/webPassphraseCache'`.

- [ ] **Step 2: Call it inside the existing web-only boot block**

`main.tsx` already has `const isTauri = '__TAURI_INTERNALS__' in window` and at least one `if (!isTauri) { … }` block at boot. Add the fire-and-forget sweep inside such a block (e.g. next to `registerServiceWorker()`):
```ts
if (!isTauri) {
  // Purge any cached passphrases that have passed their 24h expiry, as early
  // as possible (covers reopen-after-24h and stale cross-account records).
  void sweepExpiredPassphrases()
}
```
It must remain `void`-ed / not awaited so it never delays startup.

- [ ] **Step 3: Typecheck**

Run from repo root:
```bash
npm run typecheck
```
Expected: no errors.

- [ ] **Step 4: Build the app to confirm boot wiring compiles**

Run from repo root:
```bash
npm run build
```
Expected: build succeeds (SDK + app), no errors.

- [ ] **Step 5: Commit**

```bash
git add apps/fluux/src/main.tsx
git commit -m "feat(e2ee): sweep expired passphrase cache on web boot"
```

---

## Self-Review

**Spec coverage:**
- Spec §Design.1 `sweepExpiredPassphrases()` → Task 1. ✓
- Spec §Design.2 call once at boot in `main.tsx` web-only block → Task 2. ✓
- Spec §Design.3 keep existing lazy deletion → enforced by Global Constraints ("do not change … existing lazy deletion"); no task modifies `loadCachedPassphrase`. ✓
- Spec §Out of scope (no timer/interval) → Global Constraints. ✓
- Spec §Testing (expired+fresh, empty-DB no-op, never throws) → Task 1 Step 1. ✓

**Placeholder scan:** No TBD/TODO; all code shown in full; commands and expected outputs given. ✓

**Type consistency:** `sweepExpiredPassphrases(): Promise<void>` named identically in Task 1 (definition), Task 1 Interfaces (Produces), and Task 2 (Consumes/import/call). Reuses existing `openDb`, `STORE_NAME`, `CacheRecord`, `cachePassphrase`, `loadCachedPassphrase` with their current signatures. ✓
