import type { PluginStorage } from '@fluux/sdk'
import { fingerprintsEqual } from './fingerprintCompare'
import { loadVerifiedMap, persistVerifiedMap } from './verifiedKeys'

/**
 * Narrow, READ-ONLY view of verified-key state. Exposes exactly the reads
 * `VerifiedKeysCache` supports for reactive consumers (the app-side hook,
 * `useSyncExternalStore`-style) — deliberately NO write members. B1 shipped
 * a Critical where `ChatView` wrote verified state directly and bypassed the
 * plugin, silently no-opping the chat-header Verify action; app-side writes
 * must keep going through `OpenPGPPluginBase.setIdentityTrust` so the plugin
 * stays the single writer. `VerifiedKeysCache` satisfies this structurally
 * (`implements VerifiedKeysView`) so any accidental drift between the two is
 * a compile error, not a runtime surprise.
 */
export interface VerifiedKeysView {
  isVerified(jid: string, fingerprint: string): boolean
  getVerifiedFingerprint(jid: string): string | null
  getSnapshot(): Record<string, string>
  subscribe(listener: () => void): () => void
}

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
 *
 * ## Persistence failure semantics: rollback, NOT best-effort
 *
 * `setVerified` / `clearVerified` / `seed` roll the in-memory mutation back
 * in a `catch` and rethrow when `persist()` rejects, so memory never runs
 * ahead of disk. This is the OPPOSITE of the legacy mirror's policy
 * (`apps/fluux/src/stores/verifiedPeerKeysStore.ts`'s `persist()`, which
 * swallows a `localStorage` failure and deliberately "still leaves
 * in-memory state consistent" — best-effort by design there).
 *
 * The two stores can afford different policies because they have different
 * consumers. The legacy mirror only feeds UI display; a dropped write just
 * means the user re-verifies next session. This cache also feeds
 * `sealTrustState` (`scheduleTrustStateSeal` → `verifiedKeys.getAll()`),
 * which snapshots the in-memory map and later compares it against what
 * `hydrate()` reloads from disk. If a failed persist were allowed to leave
 * an entry live in memory, an UNRELATED later trust change could trigger a
 * seal that captures the never-persisted entry — and on next launch,
 * `hydrate()` won't reproduce it, `payloadsMatch` fails, and the user gets
 * a false "trust state compromised" tamper banner from what was really a
 * transient disk/keychain error. Rolling back keeps memory and disk
 * consistent at every await boundary, so a seal can never observe state
 * that isn't durable. The caller-visible cost is that the write now
 * surfaces the rejection (see `OpenPGPPluginBase.setVerifiedDual` /
 * `ChatView.tsx` / `ContactProfileView.tsx`, which all show an error toast
 * instead of silently claiming success) — which is the honest outcome for
 * a state change the app told the user succeeded.
 *
 * ## Write serialization: no interleaved persist attempts
 *
 * `persist()` snapshots `getAll()` synchronously and then awaits
 * `storage.put`. If two writes were allowed to have their `persist()` calls
 * in flight at once, they could settle out of order: e.g. write A (bob)
 * starts, write B (carol) starts and its snapshot already includes bob
 * (since B's synchronous mutation always runs after A's), B's `put`
 * resolves first, THEN A's `put` rejects and A's rollback deletes bob from
 * memory — leaving memory BEHIND disk (disk still has bob from B's
 * snapshot). That is the mirror image of the problem the rollback exists to
 * prevent: a seal could now snapshot memory as "not verified" while disk
 * (and a peer's cross-device sync) says otherwise, which is just as capable
 * of manufacturing a false verdict as memory running ahead.
 *
 * `setVerified` / `clearVerified` / `seed` therefore run their
 * persist-and-rollback step through `enqueueWrite`, a promise-chain mutex:
 * each write's persist attempt (and any rollback) only begins once the
 * previous one has fully settled, so two `persist()` calls can never race.
 * The in-memory MUTATION itself stays synchronous and outside the queue
 * (callers must keep observing it immediately, without awaiting) — only the
 * async persist/rollback is serialized. A rejected write does not poison
 * the chain: `enqueueWrite` runs the next step regardless of whether the
 * previous one resolved or rejected, and normalizes the chain back to an
 * always-resolving promise so later `.then` calls never short-circuit.
 */
export class VerifiedKeysCache implements VerifiedKeysView {
  private map = new Map<string, string>()
  private hydrated = false
  /** Promise-chain mutex — see the class doc's "Write serialization" section. */
  private writeChain: Promise<void> = Promise.resolve()
  private listeners = new Set<() => void>()
  /** Cached immutable snapshot; invalidated (set to null) on every mutation. */
  private snapshot: Record<string, string> | null = null

  constructor(private readonly storage: PluginStorage) {}

  async hydrate(): Promise<void> {
    if (this.hydrated) return
    const stored = await loadVerifiedMap(this.storage)
    this.map = new Map(Object.entries(stored))
    this.hydrated = true
    // Invalidate any snapshot cached during the `await` above (e.g. a
    // `getSnapshot()` call that ran while storage I/O was in flight would
    // have cached `{}` from the still-empty map) and notify subscribers so
    // the UI picks up the loaded data instead of being stuck on that stale
    // cached snapshot forever.
    this.notify()
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

  /** Raw stored fingerprint for `jid`, with no comparison — `null` if unverified. */
  getVerifiedFingerprint(jid: string): string | null {
    return this.map.get(jid) ?? null
  }

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
   *
   * Frozen so the "callers must not be able to mutate internal state"
   * contract (see `getAll()`'s doc comment) actually holds here too: unlike
   * `getAll()`, this object is handed out by reference to every caller, so
   * one caller mutating it would silently poison every other caller's view
   * until the next mutation invalidates the cache.
   */
  getSnapshot(): Record<string, string> {
    if (this.snapshot === null) this.snapshot = Object.freeze(Object.fromEntries(this.map))
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

  /**
   * Sets `jid`'s verified fingerprint and persists it. On a `persist()`
   * rejection, the in-memory mutation is rolled back before rethrowing —
   * see the class doc comment for why memory must never run ahead of disk.
   *
   * Rejects an empty `fingerprint` synchronously rather than storing it: an
   * empty-fingerprint entry would live in memory, get swept into a
   * trust-state seal via `getAll()`, and then be silently dropped by
   * `persistVerifiedMap`'s write-side filter — vanishing on the next
   * `hydrate()` and manufacturing the exact seal/reload mismatch the
   * write-side filter exists to close. `isVerified` already treats an empty
   * fingerprint as never-verified, so storing one is meaningless anyway.
   */
  async setVerified(jid: string, fingerprint: string): Promise<void> {
    if (!fingerprint) {
      throw new Error('VerifiedKeysCache.setVerified: fingerprint must not be empty')
    }
    const hadEntry = this.map.has(jid)
    const previous = this.map.get(jid)
    this.map.set(jid, fingerprint)
    this.notify()
    return this.enqueueWrite(async () => {
      try {
        await this.persist()
      } catch (err) {
        if (hadEntry) this.map.set(jid, previous as string)
        else this.map.delete(jid)
        this.notify()
        throw err
      }
    })
  }

  /**
   * Clears `jid`'s verified fingerprint and persists it. On a `persist()`
   * rejection, the in-memory mutation is rolled back before rethrowing —
   * see the class doc comment for why memory must never run ahead of disk.
   */
  async clearVerified(jid: string): Promise<void> {
    if (!this.map.has(jid)) return
    const previous = this.map.get(jid) as string
    this.map.delete(jid)
    this.notify()
    return this.enqueueWrite(async () => {
      try {
        await this.persist()
      } catch (err) {
        this.map.set(jid, previous)
        this.notify()
        throw err
      }
    })
  }

  /**
   * One-time seeding from the legacy app-side store. No-op when the cache
   * already holds data, so it can never clobber plugin-owned state. On a
   * `persist()` rejection, the in-memory seed is rolled back (back to
   * empty — `seed` only ever runs against an empty cache) before
   * rethrowing, for the same reason as `setVerified`/`clearVerified`.
   */
  async seed(map: Record<string, string>): Promise<void> {
    if (this.map.size > 0) return
    const entries = Object.entries(map)
    if (entries.length === 0) return
    this.map = new Map(entries)
    this.notify()
    return this.enqueueWrite(async () => {
      try {
        await this.persist()
      } catch (err) {
        this.map = new Map()
        this.notify()
        throw err
      }
    })
  }

  private persist(): Promise<void> {
    return persistVerifiedMap(this.storage, this.getAll())
  }

  /**
   * Chains `step` (a persist-and-rollback attempt) behind every previously
   * enqueued write, so no two writes' `persist()` calls can ever be in
   * flight at once — see the class doc's "Write serialization" section.
   *
   * `this.writeChain.then(step, step)` runs `step` next regardless of
   * whether the previous link resolved OR rejected, so one write's failure
   * never blocks the next write from running. `writeChain` is then reset to
   * a promise that always resolves (swallowing both outcomes), so a
   * rejection never poisons subsequent `.then` chaining either. The
   * REJECTION itself is still returned to this write's own caller via
   * `result`, unaffected by that normalization.
   */
  private enqueueWrite(step: () => Promise<void>): Promise<void> {
    const result = this.writeChain.then(step, step)
    this.writeChain = result.then(
      () => undefined,
      () => undefined,
    )
    return result
  }
}

/**
 * Stable, READ-ONLY indirection onto whatever `VerifiedKeysCache` is
 * currently live. Solves a call-ordering hazard in
 * `OpenPGPPluginBase.getVerifiedKeysView()`: `init()` unconditionally
 * replaces the base's `verifiedKeys` field with a fresh, `ctx.storage`-backed
 * cache (see that method's doc comment), so a view acquired by *returning
 * the field's current value* would keep pointing at whatever cache was live
 * at the moment of the call — the pre-init in-memory placeholder if acquired
 * early, or a stale cache if `init()` runs again later (multi-account /
 * re-registration). That failure is silent: every read just reports
 * "not verified" forever, with nothing to indicate the view is stale.
 *
 * This class is handed out once per plugin instance and never itself
 * replaced. Reads (`isVerified` / `getVerifiedFingerprint` / `getSnapshot`)
 * always delegate to whatever cache {@link rebind} last pointed at, so they
 * are correct regardless of when the caller acquired the view. `subscribe`
 * relays notifications from the CURRENT underlying cache and re-subscribes
 * to the new one on every {@link rebind}, so a listener registered before an
 * `init()` (or across a second `init()`) keeps firing on the replacement
 * cache's changes without the caller having to know a swap happened.
 */
export class VerifiedKeysViewIndirection implements VerifiedKeysView {
  private current: VerifiedKeysCache
  private readonly listeners = new Set<() => void>()
  private unsubscribeFromCurrent: (() => void) | null = null

  constructor(initial: VerifiedKeysCache) {
    this.current = initial
  }

  isVerified(jid: string, fingerprint: string): boolean {
    return this.current.isVerified(jid, fingerprint)
  }

  getVerifiedFingerprint(jid: string): string | null {
    return this.current.getVerifiedFingerprint(jid)
  }

  getSnapshot(): Record<string, string> {
    return this.current.getSnapshot()
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    if (this.listeners.size === 1) {
      this.unsubscribeFromCurrent = this.current.subscribe(() => this.notifyAll())
    }
    return () => {
      this.listeners.delete(listener)
      if (this.listeners.size === 0) {
        this.unsubscribeFromCurrent?.()
        this.unsubscribeFromCurrent = null
      }
    }
  }

  /**
   * Point this indirection at `next`. Called by
   * `OpenPGPPluginBase.replaceVerifiedKeys()` every time it swaps the live
   * cache (i.e. on every `init()`). No-ops when `next` is already current
   * (defensive; `replaceVerifiedKeys` always constructs a fresh instance
   * today, so this branch is not expected to trigger in practice). Moves any
   * active relay subscription onto `next` BEFORE the caller hydrates it, so
   * a hydrate-triggered notification reaches listeners registered on this
   * indirection.
   */
  rebind(next: VerifiedKeysCache): void {
    if (next === this.current) return
    this.unsubscribeFromCurrent?.()
    this.unsubscribeFromCurrent = null
    this.current = next
    if (this.listeners.size > 0) {
      this.unsubscribeFromCurrent = this.current.subscribe(() => this.notifyAll())
    }
  }

  private notifyAll(): void {
    for (const l of [...this.listeners]) {
      try {
        l()
      } catch {
        // One bad subscriber must not stop the others.
      }
    }
  }
}

function inMemoryPluginStorage(): PluginStorage {
  const map = new Map<string, Uint8Array>()
  return {
    get: async (key) => map.get(key) ?? null,
    put: async (key, value) => void map.set(key, value),
    delete: async (key) => void map.delete(key),
    list: async (prefix) => [...map.keys()].filter((k) => k.startsWith(prefix)),
  }
}

/**
 * An empty, immediately-usable `VerifiedKeysCache` over throwaway in-memory
 * storage — never persisted, never hydrated from anything real.
 *
 * `OpenPGPPluginBase` uses this as `verifiedKeys`'s field initializer so the
 * field is never `undefined` between construction and `init()` (previously
 * a `!`-asserted field: any trust read before `init()` ran — e.g. a test
 * driving trait methods directly — crashed with "Cannot read properties of
 * undefined"). `init()` unconditionally replaces this placeholder with the
 * real `ctx.storage`-backed cache before doing anything else, so a hydrated
 * plugin always reads through the real cache; only the brief pre-init
 * window can observe this placeholder, and it correctly reports "not
 * verified" for everything since it holds no data.
 */
export function createInMemoryVerifiedKeysCache(): VerifiedKeysCache {
  return new VerifiedKeysCache(inMemoryPluginStorage())
}
