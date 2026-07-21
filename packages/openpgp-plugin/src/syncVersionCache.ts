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
 * value back to the last value actually confirmed written to disk — see
 * "Overlapping writes and the durable rollback target" below for why that
 * is not simply "what it was before the call" — in a `catch`, before
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
 *
 * ## Overlapping writes and the durable rollback target
 *
 * Serialization alone does not make "roll back to the value captured before
 * this call" safe, because two `set()` calls can overlap: `set(6)` runs
 * (`previous = 5`), then `set(7)` runs (`previous = 6`) before either
 * enqueued persist has fired. `set(6)`'s persist runs first (queue order)
 * but reads the LIVE value, which by then is `7` — so it writes `7` to disk
 * and succeeds. `set(7)`'s own persist then fails. Rolling back to its
 * captured `previous` (`6`) would strand memory BELOW what disk durably
 * holds (`7`) — exactly the "seal sealed too low" failure mode this class
 * exists to prevent, just approached from the other direction. `durable`
 * tracks the value each successful `persist()` call actually wrote (not a
 * per-call snapshot), so a failed persist always rolls back to a value that
 * cannot be behind, and cannot be ahead of, what is genuinely on disk.
 *
 * ## Rollback can still leave a seal ahead of disk
 *
 * `set()` updates `this.value` synchronously, before `persist()` even starts
 * (see above) — and the trust-state seal's synchronous snapshot builder
 * (`buildCanonicalSnapshot`) can read `this.value` via `get()` in that same
 * window, before `persist()` resolves either way. If `persist()` then
 * rejects, the rollback below restores the durable value in memory, but a
 * seal captured during the window already sealed the higher, never-persisted
 * value — so the seal now runs AHEAD of disk instead of the usual "disk
 * behind seal, memory ahead" case the rollback itself was built to prevent.
 * Rolling back memory alone cannot fix that: something already read the
 * stale-in-hindsight value. `onRollback`, when supplied, gives the caller a
 * chance to trigger a fresh seal against the now-rolled-back (durable) value,
 * so the seal converges back onto disk instead of staying stuck ahead of it.
 * `OpenPGPPluginBase` wires this to `scheduleTrustStateSeal()`.
 */
export class SyncVersionCache {
  private value = -1
  /**
   * Last version actually confirmed written to disk — updated only after a
   * `persist()` call resolves successfully, to exactly the value that call
   * wrote. Rollback restores `this.value` to `this.durable`, never to a
   * caller-captured `previous`, so it can never land on a value disk never
   * saw. See the class doc's "Rollback can still leave a seal ahead of disk"
   * section.
   */
  private durable = -1
  private hydrated = false
  /** Promise-chain mutex — see the class doc's "Write serialization" section. */
  private writeChain: Promise<void> = Promise.resolve()

  /**
   * @param onRollback Optional hook invoked synchronously whenever `set()`
   * rolls a failed persist back — see the class doc's "Rollback can still
   * leave a seal ahead of disk" section.
   */
  constructor(
    private readonly storage: PluginStorage,
    private readonly onRollback?: () => void,
  ) {}

  async hydrate(): Promise<void> {
    if (this.hydrated) return
    this.value = await loadSyncVersion(this.storage)
    this.durable = this.value
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
   * On a `persist()` rejection, the in-memory mutation is rolled back to the
   * last *durably persisted* value — NOT to this call's captured `previous`
   * — before rethrowing. `previous` is only a snapshot of memory at call
   * time; because `persist()` reads `this.value` live (see "Write
   * serialization" above), an overlapping, earlier-queued `set()` can
   * already have persisted a value higher than this call's `previous` by
   * the time this call's own persist fails. Rolling back to `previous` in
   * that case would strand memory BELOW what disk already holds, which then
   * gets sealed at the wrong (lower) version. Rolling back to the tracked
   * durable value instead guarantees memory can never end up on either side
   * of disk after a failed persist. If the caller supplied one, `onRollback`
   * fires synchronously right after the rollback, before rethrowing. See
   * the class doc's "Rollback can still leave a seal ahead of disk" section
   * for why a caller needs that hook at all.
   */
  async set(version: number): Promise<void> {
    const previous = this.value
    this.value = Math.max(previous, version)
    return this.enqueueWrite(async () => {
      try {
        const written = await this.persist()
        if (written > this.durable) this.durable = written
      } catch (err) {
        this.value = this.durable
        this.onRollback?.()
        throw err
      }
    })
  }

  /** Persists the live `this.value` and returns exactly what was written. */
  private async persist(): Promise<number> {
    const toWrite = this.value
    await persistSyncVersion(this.storage, toWrite)
    return toWrite
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
