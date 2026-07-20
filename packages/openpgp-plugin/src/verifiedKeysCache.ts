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
