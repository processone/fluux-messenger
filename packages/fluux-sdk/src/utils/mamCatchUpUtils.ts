/**
 * Shared MAM catch-up utilities.
 *
 * Extracted from chatSideEffects, roomSideEffects, MAM, and backgroundSync
 * to provide a single source of truth for catch-up logic, constants, and
 * error classification.
 *
 * @module Utils/MAMCatchUp
 */

// ============================================================================
// Constants
// ============================================================================

/** Max messages per forward catch-up query (used in side effects and background sync). */
export const MAM_CATCHUP_FORWARD_MAX = 100

/** Max messages for backward queries when no cached messages exist. */
export const MAM_CATCHUP_BACKWARD_MAX = 50

/** Max concurrent MAM queries during background sync. */
export const MAM_BACKGROUND_CONCURRENCY = 2

/** Number of messages to load from IndexedDB cache before a MAM query. */
export const MAM_CACHE_LOAD_LIMIT = 100

/** Delay (ms) before room catch-up starts, to let rooms finish joining. */
export const MAM_ROOM_CATCHUP_DELAY_MS = 10_000

/** Max auto-pagination pages for forward room MAM catch-up.
 *  Room traffic is typically higher than 1:1, so we allow many more pages
 *  (50 × 100 = 5 000 stanzas) to close the gap after long offline periods.
 *  The loop still breaks early on `complete=true`. */
export const MAM_ROOM_FORWARD_MAX_PAGES = 50

/** Max auto-pagination pages for a USER-INITIATED forward catch-up (manual "Catch up
 *  all rooms" repair and the "Load missing messages" continue action). Far higher than
 *  the background cap (500 × 100 = 50 000 stanzas) so a deliberate repair paginates to
 *  completion instead of silently stopping mid-gap. The loop still breaks on
 *  `complete=true`; this is only a runaway backstop. */
export const MAM_ROOM_FORWARD_MAX_PAGES_MANUAL = 500

// ============================================================================
// Functions
// ============================================================================

/**
 * Find the newest message in an array (regardless of delay status).
 *
 * Walks the array backwards (most recent first) and returns the first
 * entry that has a `timestamp`. Including delayed messages ensures the
 * catch-up always uses a forward query, which merges correctly via full
 * sort. Previously skipping delayed messages caused backward queries
 * whose prepend-based merge put newer messages at the wrong position.
 */
export function findNewestMessage(messages: Array<{ timestamp?: Date }>): { timestamp: Date } | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].timestamp) return messages[i] as { timestamp: Date }
  }
  return undefined
}

/**
 * Pick the forward catch-up cursor message: the newest message that predates
 * the current session.
 *
 * Forward catch-up fetches everything *after* a cursor, so the cursor must be
 * the end of the history we already hold contiguously — NOT the global newest
 * message. After a long offline period the cache ends at the last pre-offline
 * message, but a live message arriving in the catch-up window (or any message
 * received this session) is newer. Using `findNewestMessage` there would start
 * the forward query from "now", return zero results, complete immediately, and
 * **silently skip the entire offline gap** (no gap marker, because a completed
 * forward query clears `forwardGapTimestamp`).
 *
 * By excluding messages with `timestamp >= sessionStartTime`, the cursor stays
 * on the pre-session edge, so the forward query fills the gap up to live.
 *
 * Robust to unsorted input: scans for the maximum timestamp strictly before
 * `sessionStartTime`.
 *
 * @param messages - Candidate messages (cache + live), any order
 * @param sessionStartTime - Epoch ms when the current session connected; messages
 *   at or after this are treated as this-session traffic and excluded
 * @returns The newest pre-session message, or undefined if none predate the session
 */
export function findCatchUpCursorMessage(
  messages: Array<{ timestamp?: Date }>,
  sessionStartTime: number
): { timestamp: Date } | undefined {
  let cursor: { timestamp: Date } | undefined
  for (const message of messages) {
    const ts = message.timestamp?.getTime()
    if (ts === undefined || ts >= sessionStartTime) continue
    if (!cursor || ts > cursor.timestamp.getTime()) {
      cursor = message as { timestamp: Date }
    }
  }
  return cursor
}

/** Result of {@link selectCatchUpQuery}: a forward `start` filter, a forward RSM
 *  `after` cursor (XEP-0490 pointer seed), or a backward `before: ''` (fetch
 *  latest) when there is no usable pre-session cursor. */
export interface CatchUpQuery {
  start?: string
  before?: string
  after?: string
}

/**
 * Optional inputs for {@link selectCatchUpQuery}. All are epoch-ms timestamps;
 * grouped into an options object (rather than positional args) so the three
 * `number | undefined` values can't be transposed at a call site.
 */
export interface CatchUpQueryOptions {
  /** Epoch ms the session connected. The cached cursor excludes this-session
   *  messages so a live message can't poison it. Omitted → use the global newest. */
  sessionStartTime?: number
  /** Epoch ms of a recorded forward gap. When set it WINS: resume from the hole
   *  boundary instead of from newer cached messages above it. */
  forwardGapTimestamp?: number
  /** Epoch ms of the entity's persisted preview (`lastMessage`). Last resort —
   *  used only when no cached message and no gap give a cursor — so a persisted
   *  conversation whose message cache is empty this run still FORWARD-fills its
   *  offline gap instead of a `{ before: '' }` fetch-latest that grabs only the
   *  newest page and silently skips a large gap (issue #135). */
  fallbackNewestTimestamp?: number
  /** XEP-0490 stanza-id of the remote read position (pendingRemoteDisplayedStanzaId).
   *  Last-but-one resort — the MDS marker IS an archive id, so an empty-cache
   *  catch-up on a new device can forward-page `after` it instead of a
   *  `before: ''` fetch-latest that manufactures a "pointer beyond window". */
  pointerStanzaId?: string
}

/**
 * The single, shared catch-up cursor policy for BOTH 1:1 and MUC forward
 * catch-up (background sync + active-entity side effects). Centralized so the
 * cursor logic can't drift between the chat and room paths — which is exactly
 * how the session-start fix once landed in rooms but not 1:1.
 *
 * Picks a forward `{ start }` from the highest-priority available anchor —
 * recorded gap boundary, else newest pre-session cached message, else the
 * persisted preview timestamp — or `{ before: '' }` to fetch the latest when
 * none is held. A fallback at/after `sessionStartTime` is ignored so a live
 * preview update arriving post-connect can't poison the cursor.
 */
export function selectCatchUpQuery(
  messages: Array<{ timestamp?: Date }>,
  options: CatchUpQueryOptions = {},
): CatchUpQuery {
  const { sessionStartTime, forwardGapTimestamp, fallbackNewestTimestamp, pointerStanzaId } = options

  // A recorded forward gap wins: resume from the hole boundary.
  if (forwardGapTimestamp !== undefined) {
    return { start: buildCatchUpStartTime(new Date(forwardGapTimestamp)) }
  }

  // Normal case: forward from the newest message that predates the session.
  const cursor = sessionStartTime !== undefined
    ? findCatchUpCursorMessage(messages, sessionStartTime)
    : findNewestMessage(messages)
  if (cursor?.timestamp) return { start: buildCatchUpStartTime(cursor.timestamp) }

  // Last resort: the persisted preview timestamp (cache empty this run), guarded
  // so a live preview update can't poison the cursor.
  if (
    fallbackNewestTimestamp !== undefined &&
    (sessionStartTime === undefined || fallbackNewestTimestamp < sessionStartTime)
  ) {
    return { start: buildCatchUpStartTime(new Date(fallbackNewestTimestamp)) }
  }

  // Last-but-one resort: the XEP-0490 MDS stanza-id is itself an archive id, so
  // a new device with an empty local cache can forward-page `after` it instead
  // of a `before: ''` fetch-latest that would manufacture a "pointer beyond
  // window" degrade (the read marker points past whatever the fetch-latest page
  // happens to return).
  if (pointerStanzaId) return { after: pointerStanzaId }

  return { before: '' }
}

/**
 * Pick the joined rooms that need a MAM catch-up on SM resumption.
 *
 * The fresh-session background room catch-up (`catchUpAllRooms`) runs only on a
 * fresh `'online'` event, never on an SM `'resumed'` one. So a room not caught up
 * to live this session — an autojoined room the user never opened, or a room whose
 * forward catch-up left an open gap — keeps an empty or stale sidebar preview (and
 * stale ordering) until the user opens it manually. This picks exactly those rooms
 * so a resume handler can catch them up.
 *
 * Stays out of Stream Management's way: it targets ONLY rooms NOT caught up to live
 * (`isCaughtUpToLive` false). A room already synced to the live edge is skipped — SM
 * replays undelivered stanzas for it — so a caught-up room is never re-queried on
 * every resume. Both a never-fetched room and a gap-open room qualify; a
 * genuinely-empty room caught up via a completed `before:''` query has
 * `isCaughtUpToLive` true and is skipped.
 *
 * @param rooms - Candidate rooms (typically `roomStore.joinedRooms()`)
 * @param isCaughtUpToLive - Predicate: is this room synced to the live edge with no
 *   open forward gap (`getRoomMAMQueryState(jid).isCaughtUpToLive`)? Session-scoped,
 *   so it resets false on each app load and a reload correctly re-catches-up.
 * @param activeRoomJid - The active room, skipped here because roomSideEffects
 *   drives its own catch-up.
 * @returns The subset of `rooms` needing catch-up, preserving element type.
 */
export function selectRoomsNeedingResumeSeed<
  R extends {
    jid: string
    joined?: boolean
    supportsMAM?: boolean
    isQuickChat?: boolean
  },
>(
  rooms: R[],
  isCaughtUpToLive: (jid: string) => boolean,
  activeRoomJid: string | null | undefined,
): R[] {
  return rooms.filter((r) => {
    if (!r.joined) return false
    if (!r.supportsMAM) return false
    if (r.isQuickChat) return false
    if (r.jid === activeRoomJid) return false
    if (isCaughtUpToLive(r.jid)) return false
    return true
  })
}

/**
 * Pick the cursor for a user-initiated "continue catch-up" (the "Load missing
 * messages" button).
 *
 * When a forward gap marker exists (`forwardGapTimestamp`), the cursor must be
 * the gap boundary so the forward query fills the HOLE — the global newest
 * message sits *after* the hole, so resuming from it would skip the gap entirely
 * (the original "Load missing" bug). Falls back to the newest message when there
 * is no recorded gap.
 *
 * @param messages - Candidate messages (any order)
 * @param forwardGapTimestamp - Epoch ms of the recorded forward gap, or undefined
 * @returns The message-like cursor to start the forward query from, or undefined
 */
export function findContinueCatchUpCursor(
  messages: Array<{ timestamp?: Date }>,
  forwardGapTimestamp: number | undefined
): { timestamp: Date } | undefined {
  if (forwardGapTimestamp !== undefined) return { timestamp: new Date(forwardGapTimestamp) }
  return findNewestMessage(messages)
}

/**
 * Build a MAM `start` filter value from the newest cached message.
 *
 * Adds 1 ms to avoid re-fetching the cursor message itself. This
 * pattern is used in every catch-up site (chat side effects, room side
 * effects, MAM background catch-up).
 */
export function buildCatchUpStartTime(newestTimestamp: Date): string {
  return new Date(newestTimestamp.getTime() + 1).toISOString()
}

/**
 * Classify whether an error is a transient connection error.
 *
 * Connection errors are expected during reconnection cycles and should
 * be logged at info level rather than error level.
 */
export function isConnectionError(error: unknown): boolean {
  if (!(error instanceof Error)) return false
  const msg = error.message
  return (
    msg.includes('disconnected') ||
    msg.includes('Not connected') ||
    msg.includes('Socket not available')
  )
}
