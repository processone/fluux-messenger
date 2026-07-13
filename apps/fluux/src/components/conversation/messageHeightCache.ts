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
 * Last REAL width bucket (px) each conversation's entries were written under. The seed is built at
 * synchronous mount when `rowMetricsRef.current.contentWidthPx` is still the 560 fallback (the live
 * width is only sampled in a rAF after layout), but the write-back stores entries under the real
 * sampled bucket. Persisting the real bucket here lets the seed filter by it, so same-width
 * re-entry hits the cache instead of missing every entry.
 */
const widthBucketByConversation = new Map<string, number>()

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

/**
 * Record the REAL width bucket (px) a conversation's entries are written under. Called from the
 * write-back path alongside recordMeasuredHeight, using the same real bucket as the key.
 */
export function noteConversationWidthBucket(conversationId: string, widthBucketPx: number): void {
  widthBucketByConversation.set(conversationId, widthBucketPx)
}

/**
 * Read the last real width bucket persisted for a conversation, or undefined if none recorded yet.
 * The seed uses this (falling back to the mount-time bucket) to filter cached entries.
 */
export function getConversationWidthBucket(conversationId: string): number | undefined {
  return widthBucketByConversation.get(conversationId)
}

/**
 * Resolve one row's cached measured height by item key, using the conversation's real width
 * bucket (falling back to the caller's mount-time bucket). Lets estimateSize return the real
 * height for rows that appear AFTER mount (e.g. messages streaming in from MAM on a reload),
 * which the mount-time initialMeasurements seed cannot cover.
 */
export function getCachedHeight(
  conversationId: string,
  itemKey: string,
  scalePct: number,
  fallbackBucketPx: number,
): number | undefined {
  const m = cache.get(conversationId)
  if (!m) return undefined
  const bucket = widthBucketByConversation.get(conversationId) ?? fallbackBucketPx
  return m.get(heightCacheKey(itemKey, bucket, scalePct))
}

// --------------------------------------------------------------------------
// PERSISTENCE ACROSS RELOADS
// --------------------------------------------------------------------------
// The in-memory cache dies with the page, so after a reload every conversation
// mounts unseeded: the bottom pin lands on estimates, the rows then measure
// their real heights, and the re-pin is a visible one-time jump on WebKit
// (the "blink on reload"). Persisting the settled window snapshot per
// conversation lets the reload mount seed real heights, so nothing reflows.
// The payload is version-stamped: an app update may change row CSS, and stale
// heights would recreate the exact jump this exists to prevent.

/** localStorage key for the persisted snapshot payload. */
export const HEIGHT_CACHE_STORAGE_KEY = 'fluux:msg-heights'

const MAX_PERSISTED_CONVERSATIONS = 8
/** A settled snapshot is one mounted window (~window+overscan rows); cap defensively. */
const MAX_PERSISTED_ENTRIES_PER_CONVERSATION = 120

interface StorageLike {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
}

interface PersistedConversation {
  bucket: number
  at: number
  entries: Record<string, number>
}

interface PersistedPayload {
  v: 1
  app: string
  conversations: Record<string, PersistedConversation>
}

function defaultStorage(): StorageLike | undefined {
  try {
    return typeof window === 'undefined' ? undefined : window.localStorage
  } catch {
    return undefined // privacy mode / storage disabled
  }
}

function defaultVersion(): string {
  return typeof __APP_VERSION__ !== 'undefined' ? __APP_VERSION__ : 'dev'
}

function readPayload(storage: StorageLike, version: string): PersistedPayload | undefined {
  const raw = storage.getItem(HEIGHT_CACHE_STORAGE_KEY)
  if (!raw) return undefined
  try {
    const parsed = JSON.parse(raw) as PersistedPayload
    if (parsed?.v !== 1 || parsed.app !== version || typeof parsed.conversations !== 'object') {
      return undefined
    }
    return parsed
  } catch {
    return undefined // corrupt payload — treated as absent
  }
}

/**
 * Persist one conversation's settled-height snapshot (the mounted rows read on unmount or
 * pagehide) so the next session's first mount seeds real heights instead of estimates.
 * Merges into the stored payload; conversations beyond the cap are evicted oldest-first.
 * An empty snapshot is ignored (never clobbers a previous good one). Never throws.
 */
export function persistHeightSnapshot(
  conversationId: string,
  entries: ReadonlyMap<string, number>,
  widthBucketPx: number,
  opts: { storage?: StorageLike; version?: string; now?: number } = {},
): void {
  if (entries.size === 0) return
  const storage = opts.storage ?? defaultStorage()
  if (!storage) return
  const version = opts.version ?? defaultVersion()
  try {
    const payload: PersistedPayload = readPayload(storage, version) ?? {
      v: 1,
      app: version,
      conversations: {},
    }
    const record: Record<string, number> = {}
    let count = 0
    for (const [key, px] of entries) {
      if (!(px > 0)) continue
      record[key] = px
      if (++count >= MAX_PERSISTED_ENTRIES_PER_CONVERSATION) break
    }
    if (count === 0) return
    payload.conversations[conversationId] = {
      bucket: widthBucketPx,
      at: opts.now ?? Date.now(),
      entries: record,
    }
    const ids = Object.keys(payload.conversations)
    if (ids.length > MAX_PERSISTED_CONVERSATIONS) {
      ids
        .sort((a, b) => payload.conversations[a].at - payload.conversations[b].at)
        .slice(0, ids.length - MAX_PERSISTED_CONVERSATIONS)
        .forEach((id) => delete payload.conversations[id])
    }
    storage.setItem(HEIGHT_CACHE_STORAGE_KEY, JSON.stringify(payload))
  } catch {
    // storage quota / privacy mode — persistence is best-effort
  }
}

let hydrated = false

/**
 * One-shot hydration of the in-memory cache from the persisted payload (call before building
 * the first seed). No-op after the first call so stale persisted values never override
 * in-session measurements. A payload from a different app version is discarded. Never throws.
 */
export function hydrateHeightCache(opts: { storage?: StorageLike; version?: string } = {}): void {
  if (hydrated) return
  hydrated = true
  const storage = opts.storage ?? defaultStorage()
  if (!storage) return
  const version = opts.version ?? defaultVersion()
  try {
    const payload = readPayload(storage, version)
    if (!payload) {
      // Absent is normal; corrupt or version-mismatched payloads are cleared so they
      // don't linger across sessions.
      if (storage.getItem(HEIGHT_CACHE_STORAGE_KEY) !== null) {
        storage.removeItem(HEIGHT_CACHE_STORAGE_KEY)
      }
      return
    }
    for (const [conversationId, snap] of Object.entries(payload.conversations)) {
      for (const [key, px] of Object.entries(snap.entries)) {
        recordMeasuredHeight(conversationId, key, px)
      }
      noteConversationWidthBucket(conversationId, snap.bucket)
    }
  } catch {
    // storage unavailable — start unseeded, same as today
  }
}

/** Test-only reset — clears the entire module-level cache. */
export function __clearHeightCache(): void {
  cache.clear()
  widthBucketByConversation.clear()
  hydrated = false
}
