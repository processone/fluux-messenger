/**
 * The resident-window timeline machine — one implementation of the sliding
 * message window shared by chatStore (1:1 conversations) and roomStore (MUC).
 *
 * Each transition is a pure function over the resident array: dedupe (by the
 * caller's XEP-0359 identity keys), archive-id backfill, timestamp sort, and
 * the keep-oldest/keep-newest trims that make the window slide. The stores
 * keep everything else (cache persistence, notification state, previews,
 * live-edge bookkeeping in their own state shape) and act on the returned
 * flags.
 *
 * Historical context: every transition here previously existed twice — once
 * per store — and drifted (chat missed the live-append trim and pagination
 * dedupe; room missed the archive-id backfill). See messageTimeline.test.ts
 * for the single behavioral specification.
 */

import type { ArchiveIdentifiableMessage, TimestampedMessage } from './messageArrayUtils'
import {
  buildMessageKeySet,
  isMessageDuplicate,
  sortMessagesByTimestamp,
  trimMessages,
  trimMessagesKeepOldest,
  prependOlderMessages,
  mergeAndProcessMessages,
  backfillArchiveIds,
} from './messageArrayUtils'

/** Minimal message shape the timeline needs (both Message and RoomMessage satisfy it). */
export interface TimelineMessage extends ArchiveIdentifiableMessage, TimestampedMessage {
  id: string
}

export interface TimelineConfig<T> {
  /** XEP-0359 identity keys for deduplication (stanzaId / originId / from+id). */
  getKeys: (message: T) => string[]
  /** The resident-window bound (getResidentWindowSize() in production). */
  windowSize: number
}

// ============================================================================
// appendLive — a live message arrives (Chat/MUC live path)
// ============================================================================

export type AppendLiveResult<T> =
  /** Duplicate carrying nothing new — resident array untouched. */
  | { kind: 'duplicate-unchanged' }
  /**
   * Duplicate that donated its server archive id (XEP-0359) to a resident
   * message that lacked one (outgoing echo/MAM copy). `patched` lists the
   * updated messages so the caller can persist the backfill to its cache.
   */
  | { kind: 'duplicate-backfilled'; messages: T[]; patched: T[] }
  /** Appended at the live edge; array is trimmed to the window bound. */
  | { kind: 'appended'; messages: T[] }
  /**
   * The window slid off the live edge (load-older evicted the newest tail) —
   * appending would create a false adjacency, so the resident array is left
   * untouched. Callers still persist the message durably and update
   * previews/unread; it reloads on jump-to-latest.
   */
  | { kind: 'gated' }

export function appendLive<T extends TimelineMessage>(
  messages: T[],
  incoming: T,
  atLiveEdge: boolean,
  config: TimelineConfig<T>
): AppendLiveResult<T> {
  const existingKeys = buildMessageKeySet(messages, config.getKeys)
  if (isMessageDuplicate(incoming, existingKeys, config.getKeys)) {
    const { messages: backfilled, patched } = backfillArchiveIds(messages, [incoming], config.getKeys)
    if (patched.length === 0) return { kind: 'duplicate-unchanged' }
    return { kind: 'duplicate-backfilled', messages: backfilled, patched }
  }

  if (!atLiveEdge) return { kind: 'gated' }

  return { kind: 'appended', messages: trimMessages([...messages, incoming], config.windowSize) }
}

// ============================================================================
// mergeArchive — a MAM page arrives (scroll-up pagination or forward catch-up)
// ============================================================================

export interface MergeArchiveResult<T> {
  /** The new resident array. Same reference as the input when nothing changed. */
  merged: T[]
  /** Genuinely new messages (non-duplicates) — for cache persistence and previews. */
  newMessages: T[]
  /**
   * Resident messages that gained their server archive id from a duplicate
   * archive copy — persist these to the durable cache.
   */
  patched: T[]
  /**
   * True when a backward (keep-oldest) merge evicted the newest resident
   * message: the window slid off the live edge and live appends must be gated.
   * Forward merges keep the newest, so they never slide.
   */
  newestEvicted: boolean
}

export function mergeArchive<T extends TimelineMessage>(
  messages: T[],
  incoming: T[],
  direction: 'backward' | 'forward',
  config: TimelineConfig<T>
): MergeArchiveResult<T> {
  // Backfill server stanzaIds from archived copies onto stanzaId-less resident
  // messages (e.g. own outgoing) BEFORE merging, so the live copy gains a valid
  // backward-pagination cursor. The archived copy itself still dedups away.
  const { messages: existing, patched } = backfillArchiveIds(messages, incoming, config.getKeys)

  const { merged, newMessages } =
    direction === 'backward'
      ? prependOlderMessages(existing, incoming, config.getKeys, config.windowSize)
      : mergeAndProcessMessages(existing, incoming, config.getKeys, config.windowSize)

  // Nothing new and nothing patched: hand back the ORIGINAL array reference so
  // callers can cheaply skip a state write (the forward path re-sorts into a
  // fresh array even when every incoming message deduped away).
  if (newMessages.length === 0 && patched.length === 0) {
    return { merged: messages, newMessages, patched, newestEvicted: false }
  }

  const newestEvicted =
    direction === 'backward' &&
    merged[merged.length - 1]?.id !== existing[existing.length - 1]?.id

  return { merged, newMessages, patched, newestEvicted }
}

// ============================================================================
// Cache-slice loads (IndexedDB pagination and rehydration)
// ============================================================================

export interface LoadOlderResult<T> {
  merged: T[]
  /** Genuinely new messages from the batch (non-duplicates). */
  newMessages: T[]
  /** True when keep-oldest evicted the newest resident message (window slid). */
  newestEvicted: boolean
}

/**
 * Merge an older cache batch below the window: dedupe against the resident
 * array (a slice can overlap at the `before:` boundary), sort, and keep the
 * OLDEST window-size messages so scroll-back past the bound slides the window.
 */
export function loadOlderSlice<T extends TimelineMessage>(
  messages: T[],
  cached: T[],
  config: TimelineConfig<T>
): LoadOlderResult<T> {
  const existingKeys = buildMessageKeySet(messages, config.getKeys)
  const newFromCache = cached.filter((m) => !isMessageDuplicate(m, existingKeys, config.getKeys))

  if (newFromCache.length === 0) return { merged: messages, newMessages: [], newestEvicted: false }

  const merged = trimMessagesKeepOldest(
    sortMessagesByTimestamp([...newFromCache, ...messages]),
    config.windowSize
  )
  const newestEvicted = merged[merged.length - 1]?.id !== messages[messages.length - 1]?.id

  return { merged, newMessages: newFromCache, newestEvicted }
}

export interface LoadNewerResult<T> {
  merged: T[]
  /** Genuinely new messages from the batch (non-duplicates). */
  newMessages: T[]
}

/**
 * Merge a newer cache batch above the window: dedupe (overlap at the `after:`
 * boundary), sort, and keep the NEWEST window-size messages so sliding back
 * down toward the live edge works.
 */
export function loadNewerSlice<T extends TimelineMessage>(
  messages: T[],
  cached: T[],
  config: TimelineConfig<T>
): LoadNewerResult<T> {
  const existingKeys = buildMessageKeySet(messages, config.getKeys)
  const newFromCache = cached.filter((m) => !isMessageDuplicate(m, existingKeys, config.getKeys))
  if (newFromCache.length === 0) return { merged: messages, newMessages: [] }

  return {
    merged: trimMessages(sortMessagesByTimestamp([...messages, ...newFromCache]), config.windowSize),
    newMessages: newFromCache,
  }
}

export interface LatestSliceResult<T> {
  merged: T[]
  /** Genuinely new messages from the slice (non-duplicates). */
  newMessages: T[]
}

/**
 * Merge a latest-N cache slice into the resident array (activation rehydrate,
 * jump-to-latest): dedupe, sort, keep newest.
 */
export function latestSlice<T extends TimelineMessage>(
  messages: T[],
  cached: T[],
  config: TimelineConfig<T>
): LatestSliceResult<T> {
  const existingKeys = buildMessageKeySet(messages, config.getKeys)
  const newFromCache = cached.filter((m) => !isMessageDuplicate(m, existingKeys, config.getKeys))
  if (newFromCache.length === 0) return { merged: messages, newMessages: [] }

  return {
    merged: trimMessages(sortMessagesByTimestamp([...newFromCache, ...messages]), config.windowSize),
    newMessages: newFromCache,
  }
}
