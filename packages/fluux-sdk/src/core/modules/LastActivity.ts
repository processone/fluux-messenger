import { xml, Element } from '@xmpp/client'
import { BaseModule } from './BaseModule'
import { NS_LAST } from '../namespaces'
import { getBareJid } from '../jid'
import type { StanzaClaim } from '../stanzaRouting'

/**
 * Cached last activity result for a contact.
 * Supports both successful queries and negative caching (unsupported/failed).
 */
export type LastActivityCacheEntry =
  | { supported: true; seconds: number; queriedAt: number }
  | { supported: false; queriedAt: number }

/**
 * Last Activity module (XEP-0012).
 *
 * Queries the server for when an offline contact was last active and writes
 * the result into the roster store's `lastSeen` field. This allows existing
 * UI code to display "Last seen X ago" without modification.
 *
 * Features:
 * - Lazy querying: only queries when requested (typically by `useLastActivity` hook)
 * - Negative caching: contacts whose servers don't support XEP-0012 are remembered
 * - Inflight dedup: prevents duplicate queries for the same contact
 * - Auto-invalidation: clears cache when a contact comes back online
 *
 * Consumers refresh this through `client.contacts.refreshLastActivity()`.
 */
export class LastActivity extends BaseModule {
  private cache = new Map<string, LastActivityCacheEntry>()
  private inflight = new Set<string>()

  /**
   * Passively watch for available presence stanzas to invalidate cache.
   * When a contact comes back online, their cached last-activity is stale.
   */
  /**
   * Available presence, as an observer rather than a claimant: this module
   * never consumes a stanza, it only drops a cache entry when a contact comes
   * back online. Routing it as an observer means Roster claiming the same
   * presence cannot stop it from running.
   */
  readonly observes: readonly StanzaClaim[] = [{ kind: 'presence', type: null }]

  observe(stanza: Element): void {
    const from = stanza.attrs.from
    if (from) this.invalidate(getBareJid(from))
  }

  /**
   * Query last activity for a bare JID via the server.
   * Returns cached result if available, otherwise sends an IQ query.
   * Returns null if contact is online (no need to query).
   *
   * On success, writes `lastSeen` to the roster store so existing
   * UI formatting functions display the result automatically.
   */
  async queryLastActivity(bareJid: string): Promise<LastActivityCacheEntry | null> {
    const contact = this.deps.stores?.roster.getContact(bareJid)
    if (!contact || contact.presence !== 'offline') return null

    const cached = this.cache.get(bareJid)
    if (cached) return cached

    if (this.inflight.has(bareJid)) return null

    this.inflight.add(bareJid)
    try {
      const iq = xml('iq', { type: 'get', to: bareJid },
        xml('query', { xmlns: NS_LAST })
      )
      const response = await this.deps.sendIQ(iq)

      const query = response.getChild('query', NS_LAST)
      const secondsStr = query?.attrs?.seconds

      if (!query || secondsStr === undefined) {
        const failed: LastActivityCacheEntry = { supported: false, queriedAt: Date.now() }
        this.cache.set(bareJid, failed)
        return failed
      }

      const seconds = parseInt(secondsStr, 10)
      if (isNaN(seconds)) {
        const failed: LastActivityCacheEntry = { supported: false, queriedAt: Date.now() }
        this.cache.set(bareJid, failed)
        return failed
      }

      const result: LastActivityCacheEntry = {
        supported: true,
        seconds,
        queriedAt: Date.now(),
      }
      this.cache.set(bareJid, result)

      // Write lastSeen into roster store so existing UI works
      const lastSeen = new Date(Date.now() - seconds * 1000)
      this.deps.stores?.roster.updateContact(bareJid, { lastSeen })

      return result
    } catch {
      const failed: LastActivityCacheEntry = { supported: false, queriedAt: Date.now() }
      this.cache.set(bareJid, failed)
      return failed
    } finally {
      this.inflight.delete(bareJid)
    }
  }

  /** Get cached result for a bare JID without querying. */
  getCached(bareJid: string): LastActivityCacheEntry | null {
    return this.cache.get(bareJid) ?? null
  }

  /** Clear a single entry (e.g., when contact comes back online). */
  invalidate(bareJid: string): void {
    this.cache.delete(bareJid)
  }

  /** Clear all cached last activity data. */
  clearCache(): void {
    this.cache.clear()
    this.inflight.clear()
  }
}
