/**
 * Pagination type definitions (XEP-0059 RSM, XEP-0313 MAM).
 *
 * @packageDocumentation
 * @module Types/Pagination
 */

import type { Message } from './chat'
import type { RoomMessage } from './room'

/**
 * The page to ask a server for.
 *
 * A page is addressed by the item it sits next to, not by an offset: pass the
 * id of the item to read forward from, or the one to read backward from. Ids
 * come from the {@link PageInfo} of a previous page.
 *
 * Carried over XEP-0059 Result Set Management.
 *
 * @category Pagination
 */
export interface PageRequest {
  /** Maximum items per page (default 50) */
  max?: number
  /** Read forward from this item id */
  after?: string
  /** Read backward from this item id */
  before?: string
  /** Start index, where the server supports offset addressing */
  index?: number
}

/**
 * Where the page that came back sits in the whole set.
 *
 * Every field is optional because a server reports only what it chooses to:
 * `count` in particular is an estimate on many servers, and absent on others,
 * so it must not be treated as a reliable total.
 *
 * @category Pagination
 */
export interface PageInfo {
  /** Id of the first item, the cursor to read backward from */
  first?: string
  /** Index of the first item, where the server reports one */
  firstIndex?: number
  /** Id of the last item, the cursor to read forward from */
  last?: string
  /** Total items in the whole set, where the server reports one */
  count?: number
}

/**
 * Options for querying message archive (XEP-0313).
 *
 * @category MAM
 */
export interface HistoryQueryOptions {
  /** Bare JID of conversation partner */
  with: string
  /** Maximum results to return (default 50) */
  max?: number
  /** Pagination cursor (empty string = get latest, ID = get messages before) */
  before?: string
  /** RSM cursor for forward pagination (get messages after this archive id).
   *  Also selects forward-pagination mode, like `start`. Used to seed a
   *  catch-up from a XEP-0490 MDS stanza-id when the local cache is empty. */
  after?: string
  /** Start timestamp - only fetch messages after this time (ISO 8601 format) */
  start?: string
  /** End timestamp - only fetch messages before this time (ISO 8601 format) */
  end?: string
  /**
   * Opt-in forward auto-pagination for catch-up (parity with rooms). When set
   * (with `start`), the query paginates OLDEST-first via the `after` cursor up to
   * this many pages until `complete`, instead of the default single newest-first
   * page. Omit for all other callers (targeted range / context fetch) to keep the
   * existing single-page behavior.
   */
  maxAutoPages?: number
  /**
   * When true, the resulting merge leaves the recorded history gaps untouched.
   * Used by windowed context queries, whose completion says nothing about
   * contiguity outside the window.
   */
  preserveGapMarker?: boolean
  /**
   * Epoch ms a forward walk starts from: the timestamp of the message named by
   * `after`, or of `start`. Its pages heal the recorded history gaps at or above
   * it, and the walk reaching live clears them. Without it the walk leaves the
   * gaps untouched. Ignored for backward queries and when `end` bounds the walk.
   */
  walkOriginTs?: number
  /**
   * The forward walk may close recorded gaps but must not open one. Set it when
   * the walk does not start at the top of held history (a fixed-window repair).
   */
  healGapsOnly?: boolean
}

/**
 * Result from a MAM query.
 *
 * @category MAM
 */
export interface HistoryResult {
  /** Retrieved messages */
  messages: Message[]
  /** True if no more messages before this batch */
  complete: boolean
  /** Pagination info for next query */
  page: PageInfo
  /**
   * Set when a purged `after`-anchored cursor (item-not-found) degraded this
   * query to a `before:''` fetch-latest — the result IS that fetch-latest
   * page, not the originally requested forward page.
   */
  degradedToFetchLatest?: boolean
}

/**
 * Options for querying room message archive (XEP-0313 MUC MAM).
 *
 * @category MAM
 */
export interface RoomHistoryQueryOptions {
  /** Room JID to query archive for */
  roomJid: string
  /** Maximum results to return (default 50) */
  max?: number
  /** Pagination cursor (empty string = get latest, ID = get messages before) */
  before?: string
  /** RSM cursor for forward pagination (get messages after this ID) */
  after?: string
  /** Filter messages after this timestamp (ISO 8601 format) */
  start?: string
  /**
   * When true, the resulting merge leaves the recorded history gaps untouched.
   * Used by windowed context queries, whose completion says nothing about
   * contiguity outside the window.
   */
  preserveGapMarker?: boolean
  /**
   * Epoch ms a forward walk starts from: the timestamp of the message named by
   * `after`, or of `start`. Its pages heal the recorded history gaps at or above
   * it, and the walk reaching live clears them. Without it the walk leaves the
   * gaps untouched. Ignored for backward queries and when `end` bounds the walk.
   */
  walkOriginTs?: number
  /**
   * The forward walk may close recorded gaps but must not open one. Set it when
   * the walk does not start at the top of held history (a fixed-window repair).
   */
  healGapsOnly?: boolean
  /**
   * Max auto-pagination pages for a forward catch-up. Defaults to the background
   * cap; user-initiated repair passes a higher value to paginate large gaps to
   * completion. Ignored for backward (single-page) queries.
   */
  maxAutoPages?: number
}

/**
 * Result from a room MAM query.
 *
 * @category MAM
 */
export interface RoomHistoryResult {
  /** Retrieved room messages */
  messages: RoomMessage[]
  /** True if no more messages before this batch */
  complete: boolean
  /** Pagination info for next query */
  page: PageInfo
  /**
   * Set when a purged `after`-anchored cursor (item-not-found) degraded this
   * query to a `before:''` fetch-latest — the result IS that fetch-latest
   * page, not the originally requested forward page.
   */
  degradedToFetchLatest?: boolean
}

/**
 * Options for fulltext search in message archive (XEP-0313 with fulltext extension).
 *
 * @category MAM
 */
export interface HistorySearchOptions {
  /** Fulltext search query */
  query: string
  /** Optional: scope to a specific conversation (bare JID) */
  with?: string
  /** Maximum results to return (default 20) */
  max?: number
  /** RSM cursor for backward pagination */
  before?: string
}

/**
 * Options for fulltext search in room message archive.
 *
 * @category MAM
 */
export interface RoomHistorySearchOptions {
  /** Fulltext search query */
  query: string
  /** Room JID to search */
  roomJid: string
  /** Maximum results to return (default 20) */
  max?: number
  /** RSM cursor for backward pagination */
  before?: string
}

/**
 * Options for paging-based conversation search (client-side text matching).
 *
 * Used when server doesn't support fulltext MAM search.
 *
 * @category MAM
 */
export interface HistoryPagingSearchOptions {
  /** Text query to match against message bodies */
  query: string
  /** Conversation partner bare JID */
  with: string
  /** Timestamp to start searching backward from (ISO 8601), defaults to now */
  end?: string
  /** Maximum pages to scan (default 20, each page ~100 messages) */
  maxPages?: number
  /** Maximum matching results to collect (default 50) */
  maxResults?: number
}

/**
 * State of MAM queries for a conversation.
 *
 * MAM queries can go in two directions:
 * - **Backward** (using `before` cursor): Load older history when scrolling up
 * - **Forward** (using `start` filter): Catch up to present time after reconnect
 *
 * The two completion markers track these independently:
 * - `isHistoryComplete`: No more older messages to load (reached beginning of archive)
 * - `isCaughtUpToLive`: Synced with real-time, no gap between stored messages and now
 *
 * @category MAM
 */
export interface HistoryQueryState {
  loadingRequestId?: string
  /** True while query is in progress */
  isLoading: boolean
  /** Error message if query failed */
  error: string | null
  /** True after first query has been made */
  hasQueried: boolean
  /**
   * True if all older history has been fetched (reached beginning of archive).
   * Set when a backward query (using `before` cursor) returns complete=true.
   * Used to determine if scroll-up should trigger more loading.
   */
  isHistoryComplete: boolean
  /**
   * True if we've caught up to real-time (no gap between stored messages and now).
   * Set when a forward query (using `start` filter) returns complete=true.
   * Also set after initial load with `before=""` since that fetches latest messages.
   */
  isCaughtUpToLive: boolean
  /** ID of oldest fetched message (page.first) - use as 'before' cursor for pagination */
  oldestFetchedId?: string
  /**
   * Epoch ms where the newest recorded history gap starts (the newest message
   * held below it). The active-entity hooks read it from the persisted gaps;
   * {@link gaps} lists every gap.
   */
  forwardGapTimestamp?: number
  /**
   * Every recorded history gap, oldest first. A message list shows one
   * "missing messages" marker per gap whose upper edge it holds.
   * Set by the active-entity hooks; absent when no gap is recorded.
   */
  gaps?: readonly GapInterval[]
  /**
   * True when a `before:''` fetch-latest landed DISJOINT above held-below
   * history without a proven lower boundary to anchor a seam — the preview
   * timestamp alone must never form a seam (it may be an unarchived message),
   * yet its presence proves held-below history exists. So no gap is recorded,
   * and this flag records that the contiguous coverage BOTTOM is unproven.
   *
   * Consumed by the catch-up Phase B seeder: with no gap upper edge AND this
   * flag set, the cache-oldest row is NOT provably contiguous with live, so the
   * backward descent is skipped this pass. Cleared when a merge later proves a
   * boundary (a non-empty resident extent, or a recorded gap gains an `endId`).
   */
  coverageBottomUnproven?: boolean
}

/**
 * Query direction for MAM queries.
 *
 * @category MAM
 */
export type HistoryQueryDirection = 'backward' | 'forward'

/**
 * Persisted contiguous-with-live coverage.
 *
 * A `CoverageRecord` is POSITIVE, DURABLE data: the archive id of the oldest
 * entry proven contiguous with the live edge for this device. Unlike a gap
 * interval (which describes a hole and vanishes when the hole closes) or
 * {@link HistoryQueryState.coverageBottomUnproven} (session-scoped), the record
 * survives fresh sessions and gap closure, so:
 * - the read-pointer stitch seeds its backward walk from it and never from a
 *   disjoint cache island (e.g. a fetchContext window);
 * - a signal-only fetch-latest walk resumes BELOW prior coverage instead of
 *   re-walking the same newest pages every session (`topId` marks re-entry
 *   into covered territory; the walk jumps to `bottomId`).
 *
 * Advancing `bottomId` past a page that carries persistable messages must be
 * gated on the durable IndexedDB commit of that page (same invariant as gap
 * transitions): the record must never point past data that was never stored.
 *
 * @category MAM
 */
/**
 * How a page was fetched, as the caller knows it. Named rather than positional: the two merges
 * took the same two flags in opposite orders, which is the kind of difference that is invisible
 * until it produces a bug.
 */
export interface ArchiveMergeOptions {
  /** The page came from a `before:''` query asking the archive for its newest rows. */
  isFetchLatest?: boolean
  /** Keep a recorded gap where it is; this page is not evidence about it. */
  preserveGapMarker?: boolean
  /** What the walk that produced this page knows about itself. */
  extras?: MergeArchiveExtras
}

/**
 * A known hole in the archived history of a room or conversation.
 *
 * @category MAM
 */
export interface GapInterval {
  /** Epoch ms of the newest message held *below* the gap (where it starts). */
  start: number
  /** Epoch ms of the oldest message held *above* the gap, or undefined if the
   *  gap extends to the live edge (nothing newer is held yet). */
  end?: number
  /** Archive id of the newest downloaded message below the gap — the per-device
   *  COVERAGE marker; id-exact resume cursor for the heal. Optional: legacy
   *  persisted gaps simply lack it and fall back to `start` (timestamp). */
  startId?: string
  /** Archive id of the oldest message held above the gap (mirrors `end`).
   *  Optional for the same legacy-tolerance reason as `startId`. */
  endId?: string
}

export interface CoverageRecord {
  /** Archive id of the OLDEST entry proven contiguous with the live edge. */
  bottomId: string
  /** Archive id of the NEWEST entry seen by the fetch-latest walk that
   *  established this record (page-1 page.last). */
  topId?: string
  /** Oldest persisted message proven contiguous with live for unread counting.
   *  null means the walk has no materialized anchor; absent on legacy records,
   *  whose bottomId must still be checked against the cache. */
  countBottomId?: string | null
}

/**
 * Extra merge inputs carried on the mam-messages emit (both entity kinds).
 *
 * @category MAM
 */
export interface MergeArchiveExtras {
  /** The `before` cursor the query was started with ('' = fetch-latest). */
  initialBefore?: string
  /** page.last of the FIRST page of a backward walk (newest covered entry). */
  fetchLatestTopId?: string
  /** The walk contained the existing coverage record's top entry — the only
   *  accepted proof of contiguity with the record. */
  sawCoverageTop?: boolean
  /** The walk carried corrections/retractions/reactions/fastenings, whose
   *  cache effects are fire-and-forget — certification is blocked. */
  walkCarriedModifications?: boolean
  /** FORWARD only: the `after` cursor the catch-up resumed from — the bootstrap
   *  anchor when that catch-up reports complete. */
  initialAfter?: string
  /** FORWARD only: the oldest persistable archive id carried by the whole walk. */
  walkOldestId?: string
  /** FORWARD only: epoch ms the walk started from (its resume cursor's
   *  timestamp). Pages heal the recorded gaps at or above it. Absent for
   *  bounded walks, whose pages are no evidence about gaps. */
  walkOriginTs?: number
  /** FORWARD only: the walk may close gaps but must not open one, because it
   *  did not start at the top of held history. */
  healGapsOnly?: boolean
}
