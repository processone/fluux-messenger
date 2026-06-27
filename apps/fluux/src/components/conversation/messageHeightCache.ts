/**
 * Module-level measured-height cache, keyed by messageId + widthBucket + scale.
 *
 * @tanstack/react-virtual caches measured row heights by item key for the SESSION, but loses
 * them when MessageList unmounts (conversation switch). Re-entering a conversation then
 * re-snaps from estimates ("jumpy when you just opened it"). This module-level cache survives
 * remounts and seeds the virtualizer so resident rows start at their real measured height.
 *
 * Cache structure: conversationId -> Map<heightCacheKey -> px>
 * LRU eviction per conversation (max 8 conversations, max 6000 entries each).
 */

const MAX_CONVERSATIONS = 8
const MAX_ENTRIES_PER_CONVERSATION = 6000

/** module-level cache: conversationId -> (key -> px) */
const cache = new Map<string, Map<string, number>>()

/**
 * Build the lookup key for a single row.
 * Format: `messageId@widthBucketPx@scalePct`
 */
export function heightCacheKey(
  messageId: string,
  widthBucketPx: number,
  scalePct: number,
): string {
  return `${messageId}@${widthBucketPx}@${scalePct}`
}

/**
 * Return the Map<key, px> for a conversation, creating it if needed.
 * Marks the conversation as most-recently-used (LRU touch).
 * Evicts the oldest conversation when the limit is exceeded.
 */
export function getCachedHeights(conversationId: string): Map<string, number> {
  let m = cache.get(conversationId)
  if (!m) {
    m = new Map()
  }
  // LRU: re-insert to move to most-recently-used position (Map preserves insertion order)
  cache.delete(conversationId)
  cache.set(conversationId, m)
  // Evict oldest conversations beyond the limit
  while (cache.size > MAX_CONVERSATIONS) {
    const oldest = cache.keys().next().value
    if (oldest === undefined) break
    cache.delete(oldest)
  }
  return m
}

/**
 * Record a measured pixel height for a row.
 * Only sizes > 0 are recorded.
 * Evicts the oldest entry when the per-conversation limit is exceeded.
 */
export function recordMeasuredHeight(
  conversationId: string,
  key: string,
  px: number,
): void {
  if (!(px > 0)) return
  const m = getCachedHeights(conversationId)
  if (m.size >= MAX_ENTRIES_PER_CONVERSATION && !m.has(key)) {
    const oldest = m.keys().next().value
    if (oldest !== undefined) m.delete(oldest)
  }
  m.set(key, px)
}

/** Test-only reset — clears the entire module-level cache. */
export function __clearHeightCache(): void {
  cache.clear()
}
