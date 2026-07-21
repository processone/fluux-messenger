import type { PluginStorage } from '@fluux/sdk'

/**
 * Plugin-owned persistence for the verification-sync applied/published
 * version counter (`fluux-e2ee-verifications-version` pre-B3-Task-4). Lives
 * under its own storage key, separate from {@link VERIFIED_STORAGE_KEY} in
 * `verifiedKeys.ts` — the two are read/written independently (the counter
 * changes on every remote apply AND every local mutation, the map only on
 * local mutation), and mixing them into one blob would make the monotonic
 * clamp below race the map's own write-behind persistence for no reason.
 */
export const SYNC_VERSION_STORAGE_KEY = 'verifications-sync-version'

const enc = new TextEncoder()
const dec = new TextDecoder()

/**
 * `-1` means "nothing applied yet", so a legacy v1 node (which decodes to
 * version `0`) is still picked up exactly once on first sync — mirrors the
 * sentinel the pre-B3-Task-4 localStorage-based accessor used. Tolerates a
 * missing or corrupt value the same way: both read as `-1` rather than
 * throwing.
 */
export async function loadSyncVersion(storage: PluginStorage): Promise<number> {
  const bytes = await storage.get(SYNC_VERSION_STORAGE_KEY)
  if (!bytes) return -1
  try {
    const n = Number.parseInt(dec.decode(bytes), 10)
    return Number.isFinite(n) ? n : -1
  } catch {
    return -1
  }
}

export async function persistSyncVersion(storage: PluginStorage, value: number): Promise<void> {
  await storage.put(SYNC_VERSION_STORAGE_KEY, enc.encode(String(value)))
}

/**
 * Plugin-owned sync-version counter with a SYNCHRONOUS read surface.
 *
 * Mirrors `VerifiedKeysCache` (B1): the counter is read synchronously from
 * two call sites that cannot become async — `buildCanonicalSnapshot`
 * (`trustStateIntegrity.ts`, the seal's snapshot builder) and the publish
 * scheduler's version reservation (`OpenPGPPluginBase.scheduleVerificationsPublish`,
 * a `setTimeout` body) — so the authoritative copy lives in memory and
 * `PluginStorage` is write-behind: `set()` updates memory synchronously
 * before persistence resolves.
 *
 * ## Persistence failure semantics: rollback, NOT best-effort
 *
 * The pre-B3-Task-4 localStorage-backed `saveAppliedVerificationsVersion`
 * was explicitly best-effort ("a failed persist still leaves in-memory
 * state consistent for the rest of the session"). This cache is the
 * opposite, for the same reason `VerifiedKeysCache` is: the counter feeds
 * `buildCanonicalSnapshot`'s `TrustStateSnapshot.syncVersion`, which is
 * compared against a previously sealed snapshot on the next launch. If a
 * failed persist were allowed to leave a higher value live in memory, an
 * UNRELATED later trust-state seal could capture that never-persisted
 * version — and on next launch, `hydrate()` reloads the lower, actually-
 * durable value, `payloadsMatch` sees `syncVersion` differ, and the user
 * gets a false "trust state compromised" tamper banner from what was really
 * a transient disk/keychain error. `set()` therefore rolls the in-memory
 * value back to what it was before the call, in a `catch`, before
 * rethrowing.
 *
 * ## Write serialization: no interleaved persist attempts
 *
 * `persist()` reads `this.value` (live, not a captured snapshot) and awaits
 * `storage.put`. As with `VerifiedKeysCache`, `set()` chains its
 * persist-and-rollback step through `enqueueWrite`, a promise-chain mutex,
 * so two `persist()` calls can never be in flight at once — a slower call's
 * rollback can never land after a faster, genuinely-newer call's persist has
 * already succeeded and moved memory (and disk) ahead.
 */
export class SyncVersionCache {
  private value = -1
  private hydrated = false
  /** Promise-chain mutex — see the class doc's "Write serialization" section. */
  private writeChain: Promise<void> = Promise.resolve()

  constructor(private readonly storage: PluginStorage) {}

  async hydrate(): Promise<void> {
    if (this.hydrated) return
    this.value = await loadSyncVersion(this.storage)
    this.hydrated = true
  }

  /** Highest version applied/published so far, or `-1` before anything has. */
  get(): number {
    return this.value
  }

  /**
   * Persists `version`, clamped so the stored (and in-memory) value can
   * never decrease — preserves the monotonic clamp the pre-B3-Task-4
   * accessor added: `syncVerificationsFromServer`'s post-apply save and
   * `scheduleVerificationsPublish`'s pre-publish reservation both compute
   * the version they intend to save from a `get()` read taken *before* an
   * unbounded `await` (real keychain/file I/O for the remote-apply loop; a
   * network round-trip for the publish). Two such calls can overlap, so a
   * slower call can finish and save *after* a faster, genuinely-newer call
   * already saved a higher version, based on a read that predates that
   * save. Clamping here makes the accessor itself monotonic regardless of
   * call-site interleaving: whichever save lands second can only raise or
   * hold the stored value, never lower it.
   *
   * The clamped value is written to `this.value` SYNCHRONOUSLY, before the
   * write-behind `persist()` — a synchronous `get()` immediately after this
   * call (not awaiting the returned promise) already sees the new value.
   *
   * On a `persist()` rejection, the in-memory mutation is rolled back
   * before rethrowing — see the class doc comment.
   */
  async set(version: number): Promise<void> {
    const previous = this.value
    this.value = Math.max(previous, version)
    return this.enqueueWrite(async () => {
      try {
        await this.persist()
      } catch (err) {
        this.value = previous
        throw err
      }
    })
  }

  private persist(): Promise<void> {
    return persistSyncVersion(this.storage, this.value)
  }

  /**
   * Chains `step` (a persist-and-rollback attempt) behind every previously
   * enqueued write — see the class doc's "Write serialization" section.
   * Mirrors `VerifiedKeysCache.enqueueWrite` exactly: `step` runs next
   * regardless of whether the previous link resolved or rejected, and
   * `writeChain` is reset to an always-resolving promise so a rejection
   * never poisons later chaining. The rejection itself is still returned to
   * this write's own caller via `result`.
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
 * An empty, immediately-usable `SyncVersionCache` over throwaway in-memory
 * storage — never persisted, never hydrated from anything real. Mirrors
 * `createInMemoryVerifiedKeysCache`: used as the module-level default in
 * `verificationSync.ts` so `loadAppliedVerificationsVersion()` never crashes
 * before `OpenPGPPluginBase.init()` binds the real, `ctx.storage`-backed
 * cache — it just correctly reports `-1` ("nothing applied yet").
 */
export function createInMemorySyncVersionCache(): SyncVersionCache {
  return new SyncVersionCache(inMemoryPluginStorage())
}
