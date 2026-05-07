import type { BareJID, PeerSupport } from './types'

interface CacheEntry {
  support: PeerSupport
  /** Absolute expiry timestamp in ms. */
  expiresAt: number
}

export interface CapabilityCacheOptions {
  /** Time source in ms. Overridable for tests. Defaults to `Date.now`. */
  now?: () => number
  /** Upper bound applied to any plugin-supplied TTL. */
  maxTtlSeconds?: number
}

/**
 * TTL cache of `(protocolId, peer) → PeerSupport` results.
 *
 * Plugins decide how long their probe result is valid; the cache stores
 * that TTL and evicts on read. Entries can also be invalidated imperatively
 * when the host receives a PEP change notification.
 *
 * The cache is intentionally small and synchronous — probing is the expensive
 * part; lookups must stay cheap.
 */
export class CapabilityCache {
  private readonly entries = new Map<string, CacheEntry>()
  private readonly now: () => number
  private readonly maxTtlSeconds: number

  constructor(options: CapabilityCacheOptions = {}) {
    this.now = options.now ?? (() => Date.now())
    this.maxTtlSeconds = options.maxTtlSeconds ?? 24 * 60 * 60
  }

  private static keyOf(protocolId: string, peer: BareJID): string {
    return `${protocolId}\u0000${peer}`
  }

  /** Returns a cached support entry if present and not expired. */
  get(protocolId: string, peer: BareJID): PeerSupport | null {
    const key = CapabilityCache.keyOf(protocolId, peer)
    const entry = this.entries.get(key)
    if (!entry) return null
    if (entry.expiresAt <= this.now()) {
      this.entries.delete(key)
      return null
    }
    return entry.support
  }

  /**
   * Store a probe result. TTL is clamped to [0, maxTtlSeconds]; a TTL of 0
   * means "do not cache" and the entry is not stored.
   */
  put(protocolId: string, peer: BareJID, support: PeerSupport): void {
    const ttl = Math.min(Math.max(0, support.ttl), this.maxTtlSeconds)
    if (ttl === 0) return
    this.entries.set(CapabilityCache.keyOf(protocolId, peer), {
      support,
      expiresAt: this.now() + ttl * 1000,
    })
  }

  /** Drop a specific entry — e.g. on a PEP change notification. */
  invalidate(protocolId: string, peer: BareJID): void {
    this.entries.delete(CapabilityCache.keyOf(protocolId, peer))
  }

  /** Drop every entry for a peer across all protocols. */
  invalidatePeer(peer: BareJID): void {
    const suffix = `\u0000${peer}`
    for (const key of this.entries.keys()) {
      if (key.endsWith(suffix)) this.entries.delete(key)
    }
  }

  /** Drop everything. Intended for logout / account switch. */
  clear(): void {
    this.entries.clear()
  }

  /** Number of live entries (does not sweep expired ones). */
  size(): number {
    return this.entries.size
  }
}
