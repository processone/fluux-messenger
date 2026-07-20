# OpenPGP Plugin-Owned Verified Store (Phase B1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the OpenPGP plugin the source of truth for verified-key data, persisted in its own `PluginStorage`, with a synchronous in-memory mirror — while keeping every existing consumer correct.

**Architecture:** The plugin gains a `VerifiedKeysCache`: an in-memory `Map<bareJid, fpHex>` hydrated from `PluginStorage` during `init`, exposing **synchronous** reads (the plugin's trust paths and the integrity seal need them) and writes that update the map synchronously then persist asynchronously. All plugin **reads** switch to the cache. All plugin **writes dual-write**: cache (source of truth) *and* the existing `hostStores.verifiedPeers` (legacy mirror), so the app's three reactive readers keep working untouched. Phase B2 flips those readers to a plugin-backed view and drops the mirror.

**Tech Stack:** TypeScript, `PluginStorage` (async `get/put/delete/list`, `Uint8Array` values), Vitest.

**Spec:** `docs/superpowers/specs/2026-07-20-fluux-openpgp-trust-behind-plugin-phase-b-design.md` §B1. Depends on Phase B0 (`61f26dbb..66ceb153`), which made `ctx.storage` persistent and dedicated on desktop.

## Why dual-write (a deviation from the spec's B1, recorded)

The spec's B1 switched the plugin's writes to its own store while the app's readers still read the Zustand store — which would have shipped a **broken intermediate state**: verifying a peer would stop updating the composer chip, ChatHeader, and message trust colors until B2 landed. Dual-writing during B1 keeps every existing reader correct, so B1 is independently shippable and green. It also means B1 does **not** touch the verification-sync publish/subscribe wiring at all: `_syncingFromRemoteCount` and both `hostStores.verifiedPeers.subscribe(...)` registrations keep working exactly as today, because the legacy store still receives every write. The end state is unchanged.

## Global Constraints

- **Reads must stay synchronous.** `evaluatePeerTrust`, `buildInboundSecurityContext`, the sync-apply `getAll`, and `buildCanonicalSnapshot` are all synchronous today and must remain so. The cache is what makes that possible; never make a read `await`.
- **Hydration must complete before `init` resolves.** A read against a cold cache returns "not verified", which would silently downgrade a verified peer to `tofu` (and mark inbound messages `tofu` instead of `verified`). Hydrate early — right after `this.ctx = ctx` — and `await` it before `init` returns. Note `init` has early returns (`~:537`, `~:548`, `~:558`) that skip `activateSubscriptions()`; hydration must NOT be tied to `activateSubscriptions`, because trust can be read in those states.
- **Every write dual-writes** to the cache AND `hostStores.verifiedPeers`. Missing the mirror silently breaks app UI; missing the cache silently breaks the plugin's own trust decisions.
- **Fingerprint comparison keeps its normalization.** The legacy store compares with `fingerprintsEqual` (whitespace-insensitive, case-insensitive) because a fingerprint verified on Sequoia (UPPERCASE) may be synced from openpgp.js (lowercase). The cache MUST use `fingerprintsEqual`, not `===`.
- **Crypto untouched.** No changes to sealing, key derivation, or the OMEMO plugin. Sequoia vectors untouched — no vector regeneration.
- **Where the seal blob lives is unchanged** in B1. Only its `verified` *snapshot source* moves to the cache; the blob, its init flag, and the sync-version counter stay in `localStorage` (moving them is B2/B3).
- **Commits `--no-gpg-sign`** (sandbox ssh-agent broken; re-signed from RustRover). Never push. No Claude footer.
- **Gate each task:** the touched workspace's typecheck + its tests green, no stderr.
- **Every new test that guards a data-loss or trust-downgrade property must be proven with a deliberate-break check.** Temporarily introduce the exact regression the test names, confirm the test FAILS, revert, confirm green again, and report both outputs. This is not ceremony: the preceding phase (B0) shipped three tests that could not fail — one compared an expression to itself, one counted files on a code path that never writes them, and one relied on a matcher that treats an absent key as equal to `undefined`. All three were prescribed by a plan and all three passed review until someone actually tried to break them. Tasks 3–5 below specify tests by their **required assertions** rather than literal code (the harness shape must be read first), which makes this check the real quality gate.
- **Worktree note:** `.claude/worktrees/openpgp-phase-b` has its own `node_modules`; the SDK and the three branch-only packages are built. Do NOT run `npm install`. If types go stale, rebuild with `npm run build:sdk` and `npm run build -w <pkg>`.

## File Structure

- `packages/openpgp-plugin/src/verifiedKeys.ts` — **new**: `PluginStorage` persistence for the JID→fingerprint map (Task 1).
- `packages/openpgp-plugin/src/verifiedKeysCache.ts` — **new**: the synchronous in-memory mirror (Task 2).
- `packages/openpgp-plugin/src/OpenPGPPluginBase.ts` — hydration + seed-from-legacy in `init`; reads → cache; writes dual-write (Tasks 3–5).
- `packages/openpgp-plugin/src/trustStateIntegrity.ts` — snapshot `verified` from an injected map instead of `hostStores` (Task 4).

**Storage shape decision:** a single `PluginStorage` key `verified` holding the whole `Record<bareJid, fpHex>` map (JSON, UTF-8 encoded). Unlike OMEMO's per-peer keys, this map must be readable *in full and synchronously* (the seal snapshot and the sync-apply both need `getAll`), it is small (one entry per verified peer), and it is written only on a deliberate verify/revoke. One read at hydration, one write per change.

---

### Task 1: `verifiedKeys.ts` — PluginStorage persistence

**Files:**
- Create: `packages/openpgp-plugin/src/verifiedKeys.ts`
- Test: `packages/openpgp-plugin/src/verifiedKeys.test.ts`

**Interfaces:**
- Consumes: `PluginStorage` from `@fluux/sdk`.
- Produces (Task 2 relies on these):
  - `loadVerifiedMap(storage: PluginStorage): Promise<Record<string, string>>` — `{}` when absent or corrupt.
  - `persistVerifiedMap(storage: PluginStorage, map: Record<string, string>): Promise<void>`
  - `VERIFIED_STORAGE_KEY = 'verified'` (exported for tests).

- [ ] **Step 1: Write the failing tests.**

```ts
import { describe, it, expect } from 'vitest'
import { loadVerifiedMap, persistVerifiedMap, VERIFIED_STORAGE_KEY } from './verifiedKeys'
import type { PluginStorage } from '@fluux/sdk'

function memStorage(seed?: Record<string, Uint8Array>): PluginStorage {
  const m = new Map<string, Uint8Array>(Object.entries(seed ?? {}))
  return {
    get: async (k) => m.get(k) ?? null,
    put: async (k, v) => void m.set(k, v),
    delete: async (k) => void m.delete(k),
    list: async (p) => [...m.keys()].filter((k) => k.startsWith(p)),
  }
}
const enc = (o: unknown) => new TextEncoder().encode(JSON.stringify(o))

describe('verifiedKeys persistence', () => {
  it('returns {} when nothing is stored', async () => {
    expect(await loadVerifiedMap(memStorage())).toEqual({})
  })

  it('round-trips a map', async () => {
    const s = memStorage()
    await persistVerifiedMap(s, { 'bob@x': 'ABCD', 'carol@x': 'EF01' })
    expect(await loadVerifiedMap(s)).toEqual({ 'bob@x': 'ABCD', 'carol@x': 'EF01' })
  })

  it('returns {} on a corrupt blob rather than throwing', async () => {
    const s = memStorage({ [VERIFIED_STORAGE_KEY]: new TextEncoder().encode('not json{') })
    expect(await loadVerifiedMap(s)).toEqual({})
  })

  it('drops non-string entries defensively', async () => {
    const s = memStorage({ [VERIFIED_STORAGE_KEY]: enc({ 'bob@x': 'ABCD', 'bad@x': 42, 'null@x': null }) })
    expect(await loadVerifiedMap(s)).toEqual({ 'bob@x': 'ABCD' })
  })

  it('returns {} for a JSON array (wrong shape)', async () => {
    const s = memStorage({ [VERIFIED_STORAGE_KEY]: enc(['bob@x']) })
    expect(await loadVerifiedMap(s)).toEqual({})
  })
})
```

- [ ] **Step 2: Run, verify RED.**

Run: `cd packages/openpgp-plugin && npx vitest run src/verifiedKeys.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement.**

```ts
import type { PluginStorage } from '@fluux/sdk'

/**
 * Plugin-owned persistence for the verified-key map (bare JID → fingerprint
 * hex). The whole map lives under ONE storage key because every consumer that
 * matters — the trust-state integrity snapshot and the verification-sync
 * apply — needs it in full and synchronously, and it is small (one entry per
 * verified peer) and written only on a deliberate verify/revoke.
 *
 * Compare with OMEMO's `verifiedDevices.ts`, which keys per peer because it
 * holds a device map per peer.
 */
export const VERIFIED_STORAGE_KEY = 'verified'

const enc = new TextEncoder()
const dec = new TextDecoder()

export async function loadVerifiedMap(storage: PluginStorage): Promise<Record<string, string>> {
  const bytes = await storage.get(VERIFIED_STORAGE_KEY)
  if (!bytes) return {}
  try {
    const parsed = JSON.parse(dec.decode(bytes)) as unknown
    // Defensive: tolerate a corrupt/legacy blob rather than throwing on read.
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    const out: Record<string, string> = {}
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof v === 'string' && v.length > 0) out[k] = v
    }
    return out
  } catch {
    return {}
  }
}

export async function persistVerifiedMap(
  storage: PluginStorage,
  map: Record<string, string>,
): Promise<void> {
  await storage.put(VERIFIED_STORAGE_KEY, enc.encode(JSON.stringify(map)))
}
```

- [ ] **Step 4: Run, verify GREEN.** Same command; expect 5/5 PASS.

- [ ] **Step 5: Commit.**

```bash
git add packages/openpgp-plugin/src/verifiedKeys.ts packages/openpgp-plugin/src/verifiedKeys.test.ts
git commit --no-gpg-sign -m "feat(openpgp-plugin): PluginStorage persistence for the verified-key map"
```

---

### Task 2: `verifiedKeysCache.ts` — the synchronous mirror

**Files:**
- Create: `packages/openpgp-plugin/src/verifiedKeysCache.ts`
- Test: `packages/openpgp-plugin/src/verifiedKeysCache.test.ts`

**Interfaces:**
- Consumes: Task 1's `loadVerifiedMap`/`persistVerifiedMap`; `fingerprintsEqual` from `./fingerprintCompare`.
- Produces (Tasks 3–5 rely on these exact signatures):
  - `class VerifiedKeysCache`
  - `constructor(storage: PluginStorage)`
  - `hydrate(): Promise<void>` — loads from storage; idempotent.
  - `isVerified(jid: string, fingerprint: string): boolean` — **sync**, `fingerprintsEqual` comparison.
  - `getAll(): Record<string, string>` — **sync**, returns a snapshot copy.
  - `setVerified(jid: string, fingerprint: string): Promise<void>` — updates the map synchronously, then persists.
  - `clearVerified(jid: string): Promise<void>` — same shape.
  - `seed(map: Record<string, string>): Promise<void>` — one-time seeding (Task 3), only meaningful when empty.

- [ ] **Step 1: Write the failing tests.**

```ts
import { describe, it, expect } from 'vitest'
import { VerifiedKeysCache } from './verifiedKeysCache'
// reuse memStorage() from verifiedKeys.test.ts — extract it into a shared
// test helper module if you prefer, but do not export it from the package index.

describe('VerifiedKeysCache', () => {
  it('reads are synchronous immediately after an awaited write', async () => {
    const c = new VerifiedKeysCache(memStorage())
    await c.hydrate()
    await c.setVerified('bob@x', 'ABCD')
    expect(c.isVerified('bob@x', 'ABCD')).toBe(true)   // no await on the read
  })

  it('the in-memory map updates BEFORE persistence resolves', async () => {
    let release: () => void = () => {}
    const gate = new Promise<void>((r) => { release = r })
    const slow = memStorage()
    const put = slow.put.bind(slow)
    slow.put = async (k, v) => { await gate; return put(k, v) }

    const c = new VerifiedKeysCache(slow)
    await c.hydrate()
    const pending = c.setVerified('bob@x', 'ABCD')
    // Persistence has NOT resolved yet, but the sync read must already see it.
    expect(c.isVerified('bob@x', 'ABCD')).toBe(true)
    release()
    await pending
  })

  it('compares fingerprints case- and whitespace-insensitively', async () => {
    const c = new VerifiedKeysCache(memStorage())
    await c.hydrate()
    await c.setVerified('bob@x', 'ABCD1234')
    expect(c.isVerified('bob@x', 'abcd1234')).toBe(true)
    expect(c.isVerified('bob@x', 'ABCD 1234')).toBe(true)
  })

  it('a different fingerprint is NOT verified (fingerprint-binding)', async () => {
    const c = new VerifiedKeysCache(memStorage())
    await c.hydrate()
    await c.setVerified('bob@x', 'ABCD')
    expect(c.isVerified('bob@x', 'BEEF')).toBe(false)
  })

  it('an empty fingerprint is never verified', async () => {
    const c = new VerifiedKeysCache(memStorage())
    await c.hydrate()
    await c.setVerified('bob@x', 'ABCD')
    expect(c.isVerified('bob@x', '')).toBe(false)
  })

  it('clearVerified removes the entry', async () => {
    const c = new VerifiedKeysCache(memStorage())
    await c.hydrate()
    await c.setVerified('bob@x', 'ABCD')
    await c.clearVerified('bob@x')
    expect(c.isVerified('bob@x', 'ABCD')).toBe(false)
    expect(c.getAll()).toEqual({})
  })

  it('hydrate loads previously persisted data', async () => {
    const s = memStorage()
    const a = new VerifiedKeysCache(s)
    await a.hydrate()
    await a.setVerified('bob@x', 'ABCD')
    const b = new VerifiedKeysCache(s)
    await b.hydrate()
    expect(b.isVerified('bob@x', 'ABCD')).toBe(true)
  })

  it('getAll returns a snapshot that does not alias internal state', async () => {
    const c = new VerifiedKeysCache(memStorage())
    await c.hydrate()
    await c.setVerified('bob@x', 'ABCD')
    const snap = c.getAll()
    snap['evil@x'] = 'X'
    expect(c.getAll()).toEqual({ 'bob@x': 'ABCD' })
  })

  it('seed populates an empty cache and persists it', async () => {
    const s = memStorage()
    const c = new VerifiedKeysCache(s)
    await c.hydrate()
    await c.seed({ 'bob@x': 'ABCD' })
    expect(c.isVerified('bob@x', 'ABCD')).toBe(true)
    const reloaded = new VerifiedKeysCache(s)
    await reloaded.hydrate()
    expect(reloaded.isVerified('bob@x', 'ABCD')).toBe(true)
  })

  it('seed does NOT overwrite an already-populated cache', async () => {
    const c = new VerifiedKeysCache(memStorage())
    await c.hydrate()
    await c.setVerified('bob@x', 'REAL')
    await c.seed({ 'bob@x': 'STALE', 'carol@x': 'ALSOSTALE' })
    expect(c.getAll()).toEqual({ 'bob@x': 'REAL' })
  })
})
```

- [ ] **Step 2: Run, verify RED.**

Run: `cd packages/openpgp-plugin && npx vitest run src/verifiedKeysCache.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement.**

```ts
import type { PluginStorage } from '@fluux/sdk'
import { fingerprintsEqual } from './fingerprintCompare'
import { loadVerifiedMap, persistVerifiedMap } from './verifiedKeys'

/**
 * Plugin-owned verified-key state with a SYNCHRONOUS read surface.
 *
 * The plugin's trust paths (`evaluatePeerTrust`, `buildInboundSecurityContext`)
 * and the trust-state integrity snapshot are all synchronous and cannot become
 * async without restructuring, so the authoritative copy lives in memory and
 * `PluginStorage` is write-behind. Mutations update the map and are visible to
 * readers BEFORE persistence resolves — deliberate: it keeps the existing
 * `_syncingFromRemoteCount` re-entrancy guard valid, which depends on the
 * store notification firing inside the guarded (synchronous) window.
 */
export class VerifiedKeysCache {
  private map = new Map<string, string>()
  private hydrated = false

  constructor(private readonly storage: PluginStorage) {}

  async hydrate(): Promise<void> {
    if (this.hydrated) return
    const stored = await loadVerifiedMap(this.storage)
    this.map = new Map(Object.entries(stored))
    this.hydrated = true
  }

  /**
   * Normalized comparison: a fingerprint verified on one OpenPGP backend
   * (Sequoia, UPPERCASE) and synced from another (openpgp.js, lowercase) must
   * still count as verified. An empty fingerprint is never verified.
   */
  isVerified(jid: string, fingerprint: string): boolean {
    if (!fingerprint) return false
    const stored = this.map.get(jid)
    return stored !== undefined && fingerprintsEqual(stored, fingerprint)
  }

  /** Snapshot copy — callers must not be able to mutate internal state. */
  getAll(): Record<string, string> {
    return Object.fromEntries(this.map)
  }

  async setVerified(jid: string, fingerprint: string): Promise<void> {
    this.map.set(jid, fingerprint)
    await this.persist()
  }

  async clearVerified(jid: string): Promise<void> {
    if (!this.map.delete(jid)) return
    await this.persist()
  }

  /**
   * One-time seeding from the legacy app-side store. No-op when the cache
   * already holds data, so it can never clobber plugin-owned state.
   */
  async seed(map: Record<string, string>): Promise<void> {
    if (this.map.size > 0) return
    const entries = Object.entries(map)
    if (entries.length === 0) return
    this.map = new Map(entries)
    await this.persist()
  }

  private persist(): Promise<void> {
    return persistVerifiedMap(this.storage, this.getAll())
  }
}
```

- [ ] **Step 4: Run, verify GREEN.** Expect 10/10 PASS.

- [ ] **Step 5: Typecheck + commit.**

Run: `npm run typecheck`
Expected: clean.

```bash
git add packages/openpgp-plugin/src/verifiedKeysCache.ts packages/openpgp-plugin/src/verifiedKeysCache.test.ts
git commit --no-gpg-sign -m "feat(openpgp-plugin): synchronous verified-keys cache over PluginStorage"
```

---

### Task 3: Hydrate in `init` and seed from the legacy store

**Files:**
- Modify: `packages/openpgp-plugin/src/OpenPGPPluginBase.ts` (field + `init` at `~:521`)
- Test: `packages/openpgp-plugin/src/OpenPGPPluginBase.verifiedCache.test.ts` (new)

**Interfaces:**
- Consumes: Task 2's `VerifiedKeysCache`.
- Produces: `protected verifiedKeys: VerifiedKeysCache` on the base, hydrated and seeded before `init` resolves. Tasks 4–5 read and write it.

**Why seeding here is trivial:** the legacy `hostStores.verifiedPeers` adapter is still live in B1, and it already handles per-account scoping and the old unscoped→scoped localStorage migration. So seeding is `cache.seed(this.hostStores.verifiedPeers.getAll())` — no localStorage archaeology, and B2 needs no migration because the data is already in `PluginStorage` by then.

- [ ] **Step 1: Write the failing tests.**

Read the existing base-test harness first (`packages/openpgp-plugin/src/testSupport/baseHarness.ts` and its users, added in Phase A) and extend it so a test can supply a `ctx.storage`. Then:

```ts
it('hydrates the verified cache before init resolves', async () => {
  // storage pre-populated with a verified entry; after init, a SYNC read sees it
})

it('seeds the cache from the legacy store on first run', async () => {
  // hostStores.verifiedPeers.getAll() returns { 'bob@x': 'ABCD' }, plugin storage empty
  // -> after init, cache.isVerified('bob@x','ABCD') === true, and it was persisted
})

it('does NOT re-seed when the plugin store already has data', async () => {
  // storage has { 'bob@x': 'REAL' }; legacy returns { 'bob@x': 'STALE' }
  // -> cache keeps 'REAL'
})

it('a verified peer reads as verified immediately after init (no cold-cache window)', async () => {
  // guards the "hydration must finish before init resolves" constraint:
  // evaluatePeerTrust must return 'verified', not 'tofu', on the first call
})
```

Write these against the real `init` path. If the harness cannot currently drive `init`, extend it — do not weaken the assertions.

- [ ] **Step 2: Run, verify RED.**

Run: `cd packages/openpgp-plugin && npx vitest run src/OpenPGPPluginBase.verifiedCache.test.ts`

- [ ] **Step 3: Implement.**

Add the field beside the other base state:
```ts
  /** Plugin-owned verified-key state; the source of truth from B1 onward. */
  protected verifiedKeys!: VerifiedKeysCache
```

In `init`, immediately after `this.ctx = ctx` (`~:521`) — **before** any early return, and NOT inside `activateSubscriptions()`:
```ts
    // Hydrate the verified-key cache before init resolves. Trust can be read
    // (evaluatePeerTrust / buildInboundSecurityContext) even on the paths that
    // return early below without activating subscriptions, and a cold cache
    // would silently downgrade a verified peer to `tofu`.
    this.verifiedKeys = new VerifiedKeysCache(ctx.storage)
    await this.verifiedKeys.hydrate()
    // One-time seed from the legacy app-side store (still live in B1). `seed`
    // is a no-op once the plugin owns data, so this cannot clobber it.
    await this.verifiedKeys.seed(this.hostStores.verifiedPeers.getAll())
```

- [ ] **Step 4: Run, verify GREEN**, then run the whole package suite: `cd packages/openpgp-plugin && npx vitest run`.

- [ ] **Step 5: Typecheck + commit.**

```bash
git add packages/openpgp-plugin/src/OpenPGPPluginBase.ts packages/openpgp-plugin/src/OpenPGPPluginBase.verifiedCache.test.ts packages/openpgp-plugin/src/testSupport/baseHarness.ts
git commit --no-gpg-sign -m "feat(openpgp-plugin): hydrate and seed the plugin-owned verified cache in init"
```

---

### Task 4: Switch all READS to the cache (including the seal snapshot)

**Files:**
- Modify: `packages/openpgp-plugin/src/OpenPGPPluginBase.ts` (`:1316`, `:2042`, `:2204`)
- Modify: `packages/openpgp-plugin/src/trustStateIntegrity.ts` (`:41`, `:58`, and the signatures that reach them)
- Test: extend `OpenPGPPluginBase.verifiedCache.test.ts`; add/extend a `trustStateIntegrity` test

**Interfaces:**
- `buildCanonicalSnapshot(hostStores, verified)` — takes the verified map as an explicit argument instead of reading `hostStores.verifiedPeers.getAll()`. Same for `storesAreEmpty`. `sealTrustState` and `verifyTrustStateSeal` thread it through from their callers, which pass `this.verifiedKeys.getAll()`.

The four read sites:
| Site | Today | Becomes |
|---|---|---|
| `:2042` `evaluatePeerTrust` | `hostStores.verifiedPeers.isVerified(peer, cached.fingerprint)` | `this.verifiedKeys.isVerified(...)` |
| `:2204` `buildInboundSecurityContext` | same | `this.verifiedKeys.isVerified(...)` |
| `:1316` verification-sync apply | `hostStores.verifiedPeers.getAll()` | `this.verifiedKeys.getAll()` |
| `trustStateIntegrity:41,58` | `hostStores.verifiedPeers.getAll()` | the injected `verified` argument |

- [ ] **Step 1: Write the failing tests.**

- `evaluatePeerTrust` returns `'verified'` from the CACHE when the legacy store is empty (proves the read moved).
- `buildInboundSecurityContext` marks a message `verified` from the cache under the same condition.
- The seal snapshot's `verified` section reflects the cache, not the legacy store — seed the two differently and assert the snapshot matches the cache.
- A fingerprint change still demotes to `tofu` (fingerprint-binding preserved through the move).

- [ ] **Step 2: Run, verify RED.**

- [ ] **Step 3: Implement.** Change the four read sites and thread the `verified` map through `trustStateIntegrity`'s signatures. Update every caller of `sealTrustState`/`verifyTrustStateSeal`/`clearCompromisedAndReseal` in `OpenPGPPluginBase.ts` (`~:614`, `~:630`, `~:663`) to pass `this.verifiedKeys.getAll()`.

Leave both `hostStores.verifiedPeers.subscribe(...)` registrations (`:578`, `:588`) **unchanged** — they are still fed by the dual-write in Task 5 and keep the sync guard and reseal triggers working.

- [ ] **Step 4: Run, verify GREEN**, then the whole package suite.

- [ ] **Step 5: Typecheck + commit.**

```bash
git commit --no-gpg-sign -m "refactor(openpgp-plugin): read verified state from the plugin-owned cache"
```

---

### Task 5: Dual-write at every write site

**Files:**
- Modify: `packages/openpgp-plugin/src/OpenPGPPluginBase.ts` (`:1319`, `:1320`, `:1739`, `:1757`, `:2070`, `:2072`)
- Test: extend `OpenPGPPluginBase.verifiedCache.test.ts`

The six write sites — each must update **both** the cache and the legacy mirror:
| Site | Context |
|---|---|
| `:1319` / `:1320` | verification-sync apply (`plan.toSet` / `plan.toClear`) |
| `:1739` | `acceptPeerKeyChange` — clear on rotation |
| `:1757` | `acceptPeerKeyChange` — set when accepting as verified |
| `:2070` / `:2072` | `setIdentityTrust` (Phase A trait method) |

**Ordering rule:** update the **cache first, then the mirror**. The mirror write is what fires the Zustand subscription that drives the sync-publish guard, so the cache must already be consistent when that fires.

**Async note:** cache writes return promises. At `:1319-1320` the surrounding code is inside the `_syncingFromRemoteCount`-guarded region — `await` them there so the guard still covers the whole apply (it is an `async` function; verify before changing). Do not fire-and-forget a cache write anywhere: a dropped write silently diverges the source of truth from the mirror.

- [ ] **Step 1: Write the failing tests.**
- `setIdentityTrust('verified')` writes to BOTH the cache and the legacy mirror (assert both).
- `setIdentityTrust('untrusted')` clears BOTH.
- `acceptPeerKeyChange` clears both, and sets both when `asVerified`.
- A verification-sync apply (`toSet` + `toClear`) lands in both.
- After a dual-write, a fresh `VerifiedKeysCache` over the same storage sees the value (persistence actually happened).

- [ ] **Step 2: Run, verify RED.**

- [ ] **Step 3: Implement** the six sites, cache-then-mirror.

- [ ] **Step 4: Run, verify GREEN**, then the whole package suite.

- [ ] **Step 5: Typecheck + commit.**

```bash
git commit --no-gpg-sign -m "feat(openpgp-plugin): dual-write verified state to cache and legacy mirror"
```

---

### Task 6: Full verification gate

**Files:** none (verification only).

- [ ] **Step 1:** `npm run typecheck` → clean (5 workspaces).
- [ ] **Step 2:** `cd packages/openpgp-plugin && npx vitest run` → green, no stderr.
- [ ] **Step 3:** `cd packages/fluux-sdk && npx vitest run` → green.
- [ ] **Step 4:** `cd apps/fluux && npx vitest run` → green. **This is the key non-regression signal**: the app still reads the legacy store, so a broken dual-write shows up here.
- [ ] **Step 5: Grep-guard.** `grep -rn "verifiedPeers\." packages/openpgp-plugin/src/ | grep -v test` — every remaining hit must be a WRITE (the mirror) or a `subscribe`. Any remaining **read** (`isVerified`/`getAll`) outside `trustStateIntegrity`'s injected argument means Task 4 missed a site.
- [ ] **Step 6:** Record completion in the SDD ledger.

---

## Non-Autonomous Gates

1. **Manual E2E (`tauri:dev` and web).** Verify a peer → the chip/header/message colors flip to verified as before (proves the dual-write mirror still drives the app). Fully quit and relaunch → the verification is still shown. Then confirm the plugin-owned copy really exists: on desktop the sealed store `<jid>__openpgp.json` should now be **created** (B1 is the first thing to write to it — unlike B0, which was inert). Revoke → returns to TOFU in both the UI and the plugin. On a second device, confirm verification-sync still round-trips and neither device loops republishing.
2. **Re-sign** the `--no-gpg-sign` commits from RustRover before merge.

## Follow-up (not this plan)

**B2:** app readers move to a plugin-backed `useSyncExternalStore` view (with the unregistered-plugin contract from the spec), then delete `verifiedPeerKeysStore`, the `hostStores.verifiedPeers` group, its adapter, and the dual-write mirror. **B3:** move the seal blob, init flag, and sync-version counter into `PluginStorage`, and harden the four verification-sync races (guard preserved across async writes, stale-map republish, version-counter regression, dropped local write).
