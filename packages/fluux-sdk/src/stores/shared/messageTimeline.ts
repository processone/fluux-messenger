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
 * One implementation deliberately, not one per store: a second copy of these
 * transitions drifts from the first, and the drift is silent — a missing
 * live-append trim, a missing pagination dedupe, a missing archive-id
 * backfill. See messageTimeline.test.ts for the single behavioral
 * specification.
 */

import { measured } from '../../utils/measure'
import type { ArchiveIdentifiableMessage, TimestampedMessage } from './messageArrayUtils'
import {
  sortMessagesByTimestamp,
  trimMessages,
  trimMessagesKeepOldest,
  prependOlderMessages,
  mergeAndProcessMessages,
  backfillArchiveIds,
  findMessagesSharingIdentity,
} from './messageArrayUtils'

/** Minimal message shape the timeline needs (both Message and RoomMessage satisfy it). */
export interface TimelineMessage extends ArchiveIdentifiableMessage, TimestampedMessage {
  id: string
}

export interface TimelineConfig<T> {
  /** XEP-0359 identity keys for deduplication (stanzaId / originId / from+id). */
  getKeys: (message: T) => string[]
  /** Shared message-identity predicate, including room occupant conflicts. */
  sameMessage: (a: T, b: T) => boolean
  getMergeCandidates: (incoming: T, candidates: readonly T[]) => T[]
  mergeIdentity?: (current: T, donor: T) => T
  /** The resident-window bound (getResidentWindowSize() in production). */
  windowSize: number
  /** Hidden interior rows may leave RAM; durable records and pagination endpoints remain. */
  isHidden?: (message: T) => boolean
  /**
   * Which same-millisecond tie-break rule applies to this store's messages
   * (see `messageArrayUtils.ts`'s `sortMessagesByTimestamp`). Explicit per
   * store rather than inferred, because chat messages also carry `from` and
   * would otherwise be misclassified as room messages.
   */
  kind: 'chat' | 'room'
}

/** Hidden records must not evict visible anchors while a history walk crosses spam. */
function compactHidden<T>(messages: T[], config: TimelineConfig<T>): T[] {
  return config.isHidden && messages.length > config.windowSize
    ? messages.filter((message, index) => index === 0 || index === messages.length - 1 || !config.isHidden!(message))
    : messages
}

function trimWindow<T>(messages: T[], config: TimelineConfig<T>, oldest = false): T[] {
  const compacted = compactHidden(messages, config)
  return oldest
    ? trimMessagesKeepOldest(compacted, config.windowSize)
    : trimMessages(compacted, config.windowSize)
}

/**
 * A resident window that has slid off the live edge. Newer messages must not attach to it:
 * they would splice after an old message and hide everything cached between them.
 */
export function isParkedOffLiveEdge(resident: readonly unknown[], atLiveEdge: boolean): boolean {
  return !atLiveEdge && resident.length > 0
}

/**
 * The messages a catch-up cursor is chosen from: the newest held ones. A parked window holds
 * none of them, so the latest cached slice stands in for it. Without a cached slice the parked
 * window is still the newest edge held.
 */
export function catchUpSeed<T>(resident: T[], atLiveEdge: boolean, latestCached: T[]): T[] {
  return isParkedOffLiveEdge(resident, atLiveEdge) && latestCached.length > 0 ? latestCached : resident
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

export interface AppendLiveObservation {
  placement?: 'live-edge' | 'interior'
}

export function appendLive<T extends TimelineMessage>(
  messages: T[],
  incoming: T,
  atLiveEdge: boolean,
  config: TimelineConfig<T>,
  observation?: AppendLiveObservation
): AppendLiveResult<T> {
  const candidates = findMessagesSharingIdentity(messages, incoming, config.getKeys)
  const matches = config.getMergeCandidates(incoming, candidates)
  if (matches.some((resident) => config.sameMessage(resident, incoming))) {
    const { messages: backfilled, patched } = backfillArchiveIds(
      messages,
      [incoming],
      config.getKeys,
      config.sameMessage,
      config.getMergeCandidates,
      config.mergeIdentity,
    )
    if (patched.length === 0) return { kind: 'duplicate-unchanged' }
    return { kind: 'duplicate-backfilled', messages: backfilled, patched }
  }

  if (!atLiveEdge) return { kind: 'gated' }

  // Sort before trimming.
  // Live arrivals land in ARRIVAL order, but the cache orders same-millisecond
  // rows by the shared comparator (id for chat, (from, id, occupantId) for room
  // — see `compareExact`/`makeCacheOrderKey`). The viewport observer advances the
  // read pointer by RESIDENT INDEX, so an unsorted resident array can place a
  // same-ms sibling later than the cache would — the pointer then advances
  // past it while the cache walk still counts it as unread: a silent
  // under-count, the unrecoverable direction. `sortMessagesByTimestamp` is the
  // SAME comparator `loadOlderSlice`/`loadNewerSlice`/`latestSlice` already use
  // here, so all resident-array construction paths agree with the cache walk.
  const sorted = sortMessagesByTimestamp([...messages, incoming], config.kind)
  const trimmed = trimWindow(sorted, config)
  const residentIndex = trimmed.indexOf(incoming)
  if (observation && residentIndex >= 0) {
    observation.placement =
      residentIndex === trimmed.length - 1 ? 'live-edge' : 'interior'
  }
  return {
    kind: 'appended',
    messages: trimmed,
  }
}

// ============================================================================
// mergeArchive — a MAM page arrives (scroll-up pagination or forward catch-up)
// ============================================================================

export interface MergeArchiveResult<T> {
  /**
   * The input merged with the page. Same reference as the input when nothing changed. It drives
   * previews and gap bookkeeping even when {@link resident} does not take the page.
   */
  merged: T[]
  /**
   * The array to write as the resident window: `merged`, or, when {@link gated}, the input with
   * archive-id backfills only.
   */
  resident: T[]
  /**
   * True when a newer-side page (forward catch-up or fetch-latest) met a window parked off the
   * live edge. Attaching it would splice the newest messages after an old one and hide
   * everything cached between them, the false adjacency {@link appendLive} gates for live
   * arrivals; the page still reaches the cache and reloads on jump-to-latest.
   */
  gated: boolean
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
  config: TimelineConfig<T>,
  isFetchLatest = false,
  atLiveEdge = true
): MergeArchiveResult<T> {
  return measured('mergeArchive', () => {
    // Backfill server stanzaIds from archived copies onto stanzaId-less resident
    // messages (e.g. own outgoing) BEFORE merging, so the live copy gains a valid
    // backward-pagination cursor. The archived copy itself still dedups away.
    const { messages: existing, patched } = backfillArchiveIds(
      messages,
      incoming,
      config.getKeys,
      config.sameMessage,
      config.getMergeCandidates,
      config.mergeIdentity,
    )

    // Fetch-latest pages land at the LIVE edge and may sit entirely ABOVE the
    // resident window (bail after an incomplete forward catch-up). The backward
    // prepend assumes incoming pages are older — it would misorder them and
    // keep-oldest could evict the fresh page — so fetch-latest gets dedupe +
    // full sort + keep-NEWEST for previews and gap bookkeeping. The live-edge
    // gate below separately decides whether this merge becomes resident.
    const { merged: untrimmed, newMessages } =
      direction === 'backward' && !isFetchLatest
        ? prependOlderMessages(existing, incoming, config.getKeys, config.kind, config.isHidden ? Infinity : config.windowSize, config.sameMessage, config.getMergeCandidates)
        : mergeAndProcessMessages(existing, incoming, config.getKeys, config.kind, config.isHidden ? Infinity : config.windowSize, config.sameMessage, config.getMergeCandidates)

    // Nothing new and nothing patched: hand back the ORIGINAL array reference so
    // callers can cheaply skip a state write (the forward path re-sorts into a
    // fresh array even when every incoming message deduped away).
    if (newMessages.length === 0 && patched.length === 0) {
      return { merged: messages, resident: messages, gated: false, newMessages, patched, newestEvicted: false }
    }

    const merged = trimWindow(untrimmed, config, direction === 'backward' && !isFetchLatest)
    const gated = isParkedOffLiveEdge(existing, atLiveEdge) && (direction === 'forward' || isFetchLatest)
    if (gated) {
      return { merged, resident: existing, gated, newMessages, patched, newestEvicted: false }
    }

    const previousNewest = existing[existing.length - 1]
    const newestEvicted =
      direction === 'backward' &&
      !isFetchLatest &&
      !!previousNewest &&
      !merged.some((candidate) => config.sameMessage(previousNewest, candidate))

    return { merged, resident: merged, gated, newMessages, patched, newestEvicted }
  })
}

// ============================================================================
// Cache-slice loads (IndexedDB pagination and rehydration)
// ============================================================================

function newCachedMessages<T>(messages: T[], cached: T[], config: TimelineConfig<T>): T[] {
  const residentByKey = new Map<string, number[]>()
  messages.forEach((message, index) => {
    for (const key of config.getKeys(message)) {
      const positions = residentByKey.get(key)
      if (positions) positions.push(index)
      else residentByKey.set(key, [index])
    }
  })

  return cached.filter(message => {
    // Occupant ambiguity must see every matching row, once and in resident order.
    const positions = new Set<number>()
    for (const key of config.getKeys(message)) {
      for (const index of residentByKey.get(key) ?? []) positions.add(index)
    }
    const candidates = [...positions].sort((a, b) => a - b).map(index => messages[index])
    const matches = config.getMergeCandidates(message, candidates)
    return !matches.some(resident => config.sameMessage(resident, message))
  })
}

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
  const newFromCache = newCachedMessages(messages, cached, config)

  if (newFromCache.length === 0) return { merged: messages, newMessages: [], newestEvicted: false }

  const merged = trimWindow(
    sortMessagesByTimestamp([...newFromCache, ...messages], config.kind), config, true
  )
  const previousNewest = messages[messages.length - 1]
  const newestEvicted =
    !!previousNewest &&
    !merged.some((candidate) => config.sameMessage(previousNewest, candidate))

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
  const newFromCache = newCachedMessages(messages, cached, config)
  if (newFromCache.length === 0) return { merged: messages, newMessages: [] }

  return {
    merged: trimWindow(sortMessagesByTimestamp([...messages, ...newFromCache], config.kind), config),
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
  const newFromCache = newCachedMessages(messages, cached, config)
  if (newFromCache.length === 0) return { merged: messages, newMessages: [] }

  return {
    merged: trimWindow(sortMessagesByTimestamp([...newFromCache, ...messages], config.kind), config),
    newMessages: newFromCache,
  }
}

export interface AroundSliceResult<T> {
  merged: T[]
  /** Genuinely new messages from the slice (non-duplicates). */
  newMessages: T[]
  /** True when the bound evicted the newest merged message (window left the live edge). */
  newestEvicted: boolean
}

/**
 * Merge the cache slice around an anchor (search, activity and scroll-restore
 * navigation, resume at a deep read pointer): dedupe, sort, and on overflow keep
 * a window holding the anchor, aiming for `contextBefore` older messages above
 * it while filling the bounded window. A keep-newest trim would evict the anchor
 * whenever more than the bound of cached messages are newer than it. `findAnchor` returns -1 when the
 * anchor is not in the merged array; the trim then keeps the newest.
 */
export function aroundSlice<T extends TimelineMessage>(
  messages: T[],
  cached: T[],
  findAnchor: (messages: readonly T[]) => number,
  contextBefore: number,
  config: TimelineConfig<T>
): AroundSliceResult<T> {
  const newFromCache = newCachedMessages(messages, cached, config)
  if (newFromCache.length === 0) return { merged: messages, newMessages: [], newestEvicted: false }

  const compacted = compactHidden(
    sortMessagesByTimestamp([...newFromCache, ...messages], config.kind), config
  )
  const anchor = findAnchor(compacted)
  if (anchor === -1 || compacted.length <= config.windowSize) {
    return { merged: trimWindow(compacted, config), newMessages: newFromCache, newestEvicted: false }
  }

  const start = Math.max(0, Math.min(
    anchor - Math.min(contextBefore, config.windowSize - 1),
    compacted.length - config.windowSize,
  ))
  const merged = compacted.slice(start, start + config.windowSize)
  return {
    merged,
    newMessages: newFromCache,
    newestEvicted: merged[merged.length - 1] !== compacted[compacted.length - 1],
  }
}
