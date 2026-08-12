/**
 * Pagination type definitions (XEP-0059 RSM, XEP-0313 MAM).
 *
 * @packageDocumentation
 * @module Types/Pagination
 */

import type { Message } from './chat'
import type { RoomMessage } from './room'

/**
 * Pagination request parameters (XEP-0059).
 *
 * @category Pagination
 */
export interface RSMRequest {
  /** Maximum items per page (default 50) */
  max?: number
  /** Item ID for forward pagination (get items after this) */
  after?: string
  /** Item ID for backward pagination (get items before this) */
  before?: string
  /** Start index (some servers support this) */
  index?: number
}

/**
 * Pagination response from server (XEP-0059).
 *
 * @category Pagination
 */
export interface RSMResponse {
  /** ID of first item in result set */
  first?: string
  /** Index of first item */
  firstIndex?: number
  /** ID of last item (use with `after` for next page) */
  last?: string
  /** Total count of items (if server provides) */
  count?: number
}

/**
 * Options for querying message archive (XEP-0313).
 *
 * @category MAM
 */
export interface MAMQueryOptions {
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
   * When true, the resulting merge leaves the forward gap marker untouched.
   * Used by bounded "force repair"/windowed context queries so a windowed
   * completion can't hide a real gap older than the window (nor plant a
   * spurious one inside it).
   */
  preserveGapMarker?: boolean
}

/**
 * Result from a MAM query.
 *
 * @category MAM
 */
export interface MAMResult {
  /** Retrieved messages */
  messages: Message[]
  /** True if no more messages before this batch */
  complete: boolean
  /** Pagination info for next query */
  rsm: RSMResponse
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
export interface RoomMAMQueryOptions {
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
   * When true, the resulting merge leaves the forward gap marker untouched.
   * Used by bounded "force repair" queries so a windowed completion can't hide
   * a real gap older than the window (nor plant a spurious one inside it).
   */
  preserveGapMarker?: boolean
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
export interface RoomMAMResult {
  /** Retrieved room messages */
  messages: RoomMessage[]
  /** True if no more messages before this batch */
  complete: boolean
  /** Pagination info for next query */
  rsm: RSMResponse
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
export interface MAMSearchOptions {
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
export interface RoomMAMSearchOptions {
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
export interface MAMPagingSearchOptions {
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
export interface MAMQueryState {
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
  /** ID of oldest fetched message (rsm.first) - use as 'before' cursor for pagination */
  oldestFetchedId?: string
  /**
   * Epoch ms of the newest message from an incomplete forward catch-up.
   * Used to position the gap marker in the message list. Set when a forward
   * catch-up query ends with complete=false, cleared when caught up to live.
   */
  forwardGapTimestamp?: number
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
export type MAMQueryDirection = 'backward' | 'forward'

/**
 * Persisted contiguous-with-live coverage.
 *
 * A `CoverageRecord` is POSITIVE, DURABLE data: the archive id of the oldest
 * entry proven contiguous with the live edge for this device. Unlike a gap
 * interval (which describes a hole and vanishes when the hole closes) or
 * {@link MAMQueryState.coverageBottomUnproven} (session-scoped), the record
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
export interface CoverageRecord {
  /** Archive id of the OLDEST entry proven contiguous with the live edge. */
  bottomId: string
  /** Archive id of the NEWEST entry seen by the fetch-latest walk that
   *  established this record (page-1 rsm.last). */
  topId?: string
}

/**
 * Extra merge inputs carried on the mam-messages emit (both entity kinds).
 *
 * @category MAM
 */
export interface MergeArchiveExtras {
  /** The `before` cursor the query was started with ('' = fetch-latest). */
  initialBefore?: string
  /** rsm.last of the FIRST page of a backward walk (newest covered entry). */
  fetchLatestTopId?: string
  /** The walk contained the existing coverage record's top entry — the only
   *  accepted proof of contiguity with the record (Codex r4 #3). */
  sawCoverageTop?: boolean
  /** The walk carried corrections/retractions/reactions/fastenings, whose
   *  cache effects are fire-and-forget — certification is blocked (r4 #2). */
  walkCarriedModifications?: boolean
  /** FORWARD only: the `after` cursor the catch-up resumed from — the bootstrap
   *  anchor when that catch-up reports complete. */
  initialAfter?: string
}
