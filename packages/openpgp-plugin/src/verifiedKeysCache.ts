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

  /**
   * Sets `jid`'s verified fingerprint and persists it. On a `persist()`
   * rejection, the in-memory mutation is rolled back before rethrowing —
   * see the class doc comment for why memory must never run ahead of disk.
   */
  async setVerified(jid: string, fingerprint: string): Promise<void> {
    const hadEntry = this.map.has(jid)
    const previous = this.map.get(jid)
    this.map.set(jid, fingerprint)
    try {
      await this.persist()
    } catch (err) {
      if (hadEntry) this.map.set(jid, previous as string)
      else this.map.delete(jid)
      throw err
    }
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
    try {
      await this.persist()
    } catch (err) {
      this.map.set(jid, previous)
      throw err
    }
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
    try {
      await this.persist()
    } catch (err) {
      this.map = new Map()
      throw err
    }
  }

  private persist(): Promise<void> {
    return persistVerifiedMap(this.storage, this.getAll())
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
