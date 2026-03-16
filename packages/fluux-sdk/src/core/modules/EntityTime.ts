import { xml, Element } from '@xmpp/client'
import { BaseModule } from './BaseModule'
import { NS_TIME } from '../namespaces'
import { getPresenceRank } from '../../utils/presenceUtils'
import type { ResourcePresence } from '../types'

/**
 * Cached entity time result for a contact.
 * Supports both successful queries and negative caching (unsupported/failed).
 */
export type EntityTimeCacheEntry =
  | { supported: true; offsetMinutes: number; resource: string; queriedAt: number }
  | { supported: false; queriedAt: number }

/**
 * Parse a timezone offset string (e.g., "+01:00", "-05:30", "Z") to minutes.
 */
export function parseTzo(tzo: string): number {
  if (tzo === 'Z' || tzo === '+00:00' || tzo === '-00:00') return 0
  const match = tzo.match(/^([+-])(\d{2}):(\d{2})$/)
  if (!match) return 0
  const sign = match[1] === '+' ? 1 : -1
  return sign * (parseInt(match[2]) * 60 + parseInt(match[3]))
}

/**
 * Pick the best (most available, highest priority) resource from a resources map.
 * Returns the resource key, or null if no resources.
 */
export function getBestResource(resources: Map<string, ResourcePresence>): string | null {
  if (resources.size === 0) return null

  let bestResource: string | null = null
  let bestPriority = -129  // XMPP priority range is -128 to 127
  let bestRank = Infinity

  for (const [resource, presence] of resources) {
    const rank = getPresenceRank(presence.show)
    // Higher priority wins; on tie, more available presence wins
    if (
      presence.priority > bestPriority ||
      (presence.priority === bestPriority && rank < bestRank)
    ) {
      bestResource = resource
      bestPriority = presence.priority
      bestRank = rank
    }
  }

  return bestResource
}

/**
 * Entity Time module (XEP-0202).
 *
 * Queries contacts for their local time and caches timezone offsets.
 * The cache is session-scoped and cleared on disconnect.
 *
 * Features:
 * - Negative caching: contacts that don't support XEP-0202 are remembered
 * - Resource tracking: re-queries when the best resource changes (different timezone)
 *
 * @example
 * ```typescript
 * const result = await client.entityTime.queryTime('alice@example.com')
 * if (result?.supported) {
 *   console.log(`Alice's offset: ${result.offsetMinutes} minutes from UTC`)
 * }
 * ```
 */
export class EntityTime extends BaseModule {
  private cache = new Map<string, EntityTimeCacheEntry>()
  private inflight = new Set<string>()

  /** No incoming stanza handling needed — responses are handled by iqCallee. */
  handle(_stanza: Element): boolean | void {
    return false
  }

  /**
   * Query entity time for a bare JID by selecting the best available resource.
   * Returns cached result if available, otherwise sends an IQ query.
   * Returns null if contact is offline. Returns a cache entry with
   * `supported: false` if the contact doesn't support XEP-0202.
   *
   * When the best resource changes (e.g., desktop goes offline and mobile
   * in a different timezone becomes best), the cache is invalidated and
   * a fresh query is sent.
   */
  async queryTime(bareJid: string): Promise<EntityTimeCacheEntry | null> {
    // Find the best resource for this contact
    const contact = this.deps.stores?.roster.getContact(bareJid)
    if (!contact?.resources || contact.resources.size === 0) return null

    const resource = getBestResource(contact.resources)
    if (!resource) return null

    // Check cache — invalidate if best resource changed
    const cached = this.cache.get(bareJid)
    if (cached) {
      if (!cached.supported) return cached  // Negative cache: don't re-query
      if (cached.resource === resource) return cached  // Same resource, use cache
      // Best resource changed — invalidate and re-query
      this.cache.delete(bareJid)
    }

    // Avoid duplicate in-flight queries
    if (this.inflight.has(bareJid)) return null

    const fullJid = `${bareJid}/${resource}`

    this.inflight.add(bareJid)
    try {
      const iq = xml('iq', { type: 'get', to: fullJid },
        xml('time', { xmlns: NS_TIME })
      )
      const response = await this.deps.sendIQ(iq)

      const time = response.getChild('time', NS_TIME)
      if (!time) {
        const failed: EntityTimeCacheEntry = { supported: false, queriedAt: Date.now() }
        this.cache.set(bareJid, failed)
        return failed
      }

      const tzoStr = time.getChildText('tzo')
      if (!tzoStr) {
        const failed: EntityTimeCacheEntry = { supported: false, queriedAt: Date.now() }
        this.cache.set(bareJid, failed)
        return failed
      }

      const result: EntityTimeCacheEntry = {
        supported: true,
        offsetMinutes: parseTzo(tzoStr),
        resource,
        queriedAt: Date.now(),
      }

      this.cache.set(bareJid, result)
      return result
    } catch {
      // Contact doesn't support XEP-0202, is offline, or timed out
      const failed: EntityTimeCacheEntry = { supported: false, queriedAt: Date.now() }
      this.cache.set(bareJid, failed)
      return failed
    } finally {
      this.inflight.delete(bareJid)
    }
  }

  /** Get cached time for a bare JID without querying. */
  getCached(bareJid: string): EntityTimeCacheEntry | null {
    return this.cache.get(bareJid) ?? null
  }

  /** Clear all cached entity time data. */
  clearCache(): void {
    this.cache.clear()
    this.inflight.clear()
  }
}
