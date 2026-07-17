import { createStore } from 'zustand/vanilla'
import { subscribeWithSelector } from 'zustand/middleware'
import type {
  Room,
  RoomEntity,
  RoomMetadata,
  RoomRuntime,
  RoomOccupant,
  RoomAffiliation,
  RoomMember,
  RoomMessage,
  MAMQueryState,
  RSMResponse,
} from '../core/types'
import { isNoLocalStore, type StoredRoomMessage } from '../core/types/message-internal'
import { setTypingTimeout, clearTypingTimeout } from './typingTimeout'
import { findMessageById, findMessageIndexById } from '../utils/messageLookup'
import { getBareJid } from '../core/jid'
import { logInfo } from '../core/logger'
import * as messageCache from '../utils/messageCache'
import * as searchIndex from '../utils/searchIndex'
import type { GetMessagesOptions } from '../utils/messageCache'
import * as mamState from './shared/mamState'
import type { MAMQueryDirection } from './shared/mamState'
import { syncGapAfterArchiveMerge, messagePageExtent, newestMessageStanzaId, serializeGaps, deserializeGaps, type GapInterval } from './shared/mamGap'
import { syncCoverageAfterArchiveMerge, serializeCoverage, deserializeCoverage, type CoverageRecord, type MergeArchiveExtras } from './shared/mamCoverage'
import * as draftState from './shared/draftState'
import * as timeline from './shared/messageTimeline'
import { shouldUpdateLastMessage, shouldReplaceLastMessage, isPreviewableMessage, findLastNonIgnoredMessage } from './shared/lastMessageUtils'
import { derivePreviewAfterMerge } from './shared/previewState'
import { resolveRemoteDisplayed, createMdsSessionGate, foldPendingRemoteDisplayed } from './shared/readMarkerSync'
import { ignoreStore, isMessageFromIgnoredUser } from './ignoreStore'
import { roomActivityTone } from './roomSelectors'
import * as notifState from './shared/notificationState'
import { markerDebugLog } from '../utils/markerDebug'
import { MAM_POINTER_RECOUNT_CACHE_LIMIT } from '../utils/mamCatchUpUtils'
import { connectionStore } from './connectionStore'
import { buildScopedStorageKey } from '../utils/storageScope'
// Sliding-window bound (messages kept resident per room; rest live in IndexedDB + MAM). Read via
// getResidentWindowSize() so a DEV/DEMO/TEST caller can shrink it — see shared/residentWindow.ts.
import { getResidentWindowSize } from './shared/residentWindow'

/**
 * Carry a previously-resolved avatar across a presence update.
 *
 * Presence stanzas only carry the XEP-0153 avatar *hash*; the resolved blob URL
 * arrives asynchronously and is written via `updateOccupantAvatar`. Without this,
 * every plain presence refresh (status/role change) would overwrite the occupant
 * with the freshly-parsed, blob-less object — silently dropping the avatar. Message
 * rows survive via `nickToAvatarCache`, but the members panel reads `occupant.avatar`
 * directly, so the avatar would vanish there until the hash next changes.
 *
 * Keep the existing blob when the incoming presence has no blob and its hash is
 * unchanged or absent. Drop it only when the hash actually changed, so the async
 * XEP-0398 fetch repopulates a fresh one.
 */
function preserveOccupantAvatar(existing: RoomOccupant | undefined, incoming: RoomOccupant): RoomOccupant {
  if (!existing?.avatar || incoming.avatar) return incoming
  const hashUnchanged = !incoming.avatarHash || incoming.avatarHash === existing.avatarHash
  if (!hashUnchanged) return incoming
  return { ...incoming, avatar: existing.avatar, avatarHash: incoming.avatarHash ?? existing.avatarHash }
}

/**
 * localStorage key for persisting room drafts.
 * Room drafts are stored separately from the main room state because
 * room data is restored from server bookmarks on reconnect, but drafts
 * should survive page reloads.
 */
const ROOM_DRAFTS_STORAGE_KEY_BASE = 'fluux-room-drafts'

function getRoomDraftsStorageKey(jid?: string | null): string {
  return buildScopedStorageKey(ROOM_DRAFTS_STORAGE_KEY_BASE, jid)
}

/**
 * Load room drafts from localStorage.
 */
function loadDraftsFromStorage(jid?: string | null): Map<string, string> {
  const storageKey = getRoomDraftsStorageKey(jid)
  try {
    const stored = localStorage.getItem(storageKey)
    if (stored) {
      const entries = JSON.parse(stored) as [string, string][]
      return new Map(entries)
    }
  } catch {
    // Ignore parse errors
  }
  return new Map()
}

/**
 * Save room drafts to localStorage.
 */
function saveDraftsToStorage(drafts: Map<string, string>, jid?: string | null): void {
  const storageKey = getRoomDraftsStorageKey(jid)
  try {
    const entries = Array.from(drafts.entries())
    localStorage.setItem(storageKey, JSON.stringify(entries))
  } catch {
    // Ignore storage errors (quota exceeded, etc.)
  }
}

/**
 * localStorage persistence helpers for poll state.
 *
 * Two separate maps are persisted:
 * - votedPollIds: polls the user has voted on (set by SDK after successful vote)
 * - dismissedPollIds: polls the user dismissed with X (UI preference)
 *
 * Both use the same serialization pattern as drafts: [roomJid, messageId[]][].
 */
const ROOM_VOTED_POLLS_STORAGE_KEY_BASE = 'fluux-room-voted-polls'
const ROOM_DISMISSED_POLLS_STORAGE_KEY_BASE = 'fluux-room-dismissed-polls'

function getRoomVotedPollsStorageKey(jid?: string | null): string {
  return buildScopedStorageKey(ROOM_VOTED_POLLS_STORAGE_KEY_BASE, jid)
}

function getRoomDismissedPollsStorageKey(jid?: string | null): string {
  return buildScopedStorageKey(ROOM_DISMISSED_POLLS_STORAGE_KEY_BASE, jid)
}

function loadPollIdsFromStorage(storageKey: string): Map<string, Set<string>> {
  try {
    const stored = localStorage.getItem(storageKey)
    if (stored) {
      const entries = JSON.parse(stored) as [string, string[]][]
      return new Map(entries.map(([k, v]) => [k, new Set(v)]))
    }
  } catch {
    // Ignore parse errors
  }
  return new Map()
}

function savePollIdsToStorage(pollIds: Map<string, Set<string>>, storageKey: string): void {
  try {
    const entries = Array.from(pollIds.entries()).map(
      ([k, v]) => [k, Array.from(v)] as [string, string[]]
    )
    localStorage.setItem(storageKey, JSON.stringify(entries))
  } catch {
    // Ignore storage errors (quota exceeded, etc.)
  }
}

function loadVotedPollsFromStorage(jid?: string | null): Map<string, Set<string>> {
  return loadPollIdsFromStorage(getRoomVotedPollsStorageKey(jid))
}

function saveVotedPollsToStorage(votedPolls: Map<string, Set<string>>, jid?: string | null): void {
  savePollIdsToStorage(votedPolls, getRoomVotedPollsStorageKey(jid))
}

function loadDismissedPollsFromStorage(jid?: string | null): Map<string, Set<string>> {
  return loadPollIdsFromStorage(getRoomDismissedPollsStorageKey(jid))
}

function saveDismissedPollsToStorage(dismissedPolls: Map<string, Set<string>>, jid?: string | null): void {
  savePollIdsToStorage(dismissedPolls, getRoomDismissedPollsStorageKey(jid))
}

/**
 * localStorage persistence for room history gaps (`GapInterval` per room).
 * Persisted separately (like drafts) so the "Load missing messages" marker
 * survives a reload — the next session's catch-up cursor sits above the gap and
 * would not re-detect it.
 */
const ROOM_GAPS_STORAGE_KEY_BASE = 'fluux-room-gaps'

function getRoomGapsStorageKey(jid?: string | null): string {
  return buildScopedStorageKey(ROOM_GAPS_STORAGE_KEY_BASE, jid)
}

function loadGapsFromStorage(jid?: string | null): Map<string, GapInterval> {
  try {
    const stored = localStorage.getItem(getRoomGapsStorageKey(jid))
    if (stored) return deserializeGaps(stored)
  } catch {
    // Ignore parse/storage errors
  }
  return new Map()
}

function saveGapsToStorage(gaps: Map<string, GapInterval>, jid?: string | null): void {
  try {
    localStorage.setItem(getRoomGapsStorageKey(jid), serializeGaps(gaps))
  } catch {
    // Ignore storage errors (quota exceeded, etc.)
  }
}

/**
 * localStorage persistence for room coverage records (contiguous-with-live
 * bottom per room — positive twin of the gap map; Codex r3 #3). Survives
 * fresh sessions and gap closure so Phase B and the signal-only walk resume
 * id-exactly across reloads.
 */
const ROOM_COVERAGE_STORAGE_KEY_BASE = 'fluux-room-coverage'

function getRoomCoverageStorageKey(jid?: string | null): string {
  return buildScopedStorageKey(ROOM_COVERAGE_STORAGE_KEY_BASE, jid)
}

function loadCoverageFromStorage(jid?: string | null): Map<string, CoverageRecord> {
  try {
    const stored = localStorage.getItem(getRoomCoverageStorageKey(jid))
    if (stored) return deserializeCoverage(stored)
  } catch {
    // Ignore parse/storage errors
  }
  return new Map()
}

function saveCoverageToStorage(coverage: Map<string, CoverageRecord>, jid?: string | null): void {
  try {
    localStorage.setItem(getRoomCoverageStorageKey(jid), serializeCoverage(coverage))
  } catch {
    // Ignore storage errors (quota exceeded, etc.)
  }
}

/**
 * localStorage persistence for rooms the user has acknowledged as non-anonymous
 * (issue #37). Once a user accepts joining a room that exposes their real JID, we
 * record it here so the warning is shown once per room, not on every reconnect.
 * Persisted separately (like drafts) and scoped per account.
 */
const ROOM_NONANON_ACK_STORAGE_KEY_BASE = 'fluux-room-nonanon-ack'

function getRoomNonAnonAckStorageKey(jid?: string | null): string {
  return buildScopedStorageKey(ROOM_NONANON_ACK_STORAGE_KEY_BASE, jid)
}

function loadNonAnonAckFromStorage(jid?: string | null): Set<string> {
  try {
    const stored = localStorage.getItem(getRoomNonAnonAckStorageKey(jid))
    if (stored) {
      const entries = JSON.parse(stored) as string[]
      return new Set(entries)
    }
  } catch {
    // Ignore parse errors
  }
  return new Set()
}

function saveNonAnonAckToStorage(acked: Set<string>, jid?: string | null): void {
  try {
    localStorage.setItem(getRoomNonAnonAckStorageKey(jid), JSON.stringify(Array.from(acked)))
  } catch {
    // Ignore storage errors (quota exceeded, etc.)
  }
}

/**
 * Stable empty array references to prevent infinite re-renders.
 * When computed selectors return empty results, they should return these
 * constants instead of creating new [] instances each time.
 */
const EMPTY_ROOM_ARRAY: Room[] = []
const EMPTY_SIDEBAR_JIDS: string[] = []

// Monotonic token so a slow cache read from a superseded activateRoom call
// can't overwrite a newer activation when it finally resolves
let activationToken = 0

// XEP-0490 first-open-per-session fold gate (see shared/readMarkerSync;
// parity with chatStore). Reset on reset() (logout).
const mdsGate = createMdsSessionGate()

// Selector memoization caches.
// Store selectors (joinedRooms, allRooms, etc.) are called on every Zustand subscription check.
// Without caching, each call runs O(n) filter + O(n log n) sort even when the rooms Map hasn't changed.
// Since Zustand creates new Map references on mutations, we can cache by Map identity.
let _cachedJoinedRooms: Room[] = EMPTY_ROOM_ARRAY
let _cachedJoinedRoomsSource: Map<string, Room> | null = null
let _cachedBookmarkedRooms: Room[] = EMPTY_ROOM_ARRAY
let _cachedBookmarkedRoomsSource: Map<string, Room> | null = null
let _cachedAllRooms: Room[] = EMPTY_ROOM_ARRAY
let _cachedAllRoomsSource: Map<string, Room> | null = null
let _cachedQuickChatRooms: Room[] = EMPTY_ROOM_ARRAY
let _cachedQuickChatRoomsSource: Map<string, Room> | null = null
const EMPTY_MESSAGE_ARRAY: RoomMessage[] = []
const EMPTY_SET: Set<string> = new Set()

/**
 * Extract deduplication keys from a room message.
 * Room messages use three tiers of identity (XEP-0359):
 * - stanzaId: server/MUC-assigned canonical ID (most reliable, from MAM)
 * - originId: sender-assigned stable ID (survives archiving, for echo dedup)
 * - from+id: stanza attribute combo (fallback for legacy/bridge messages)
 */
function getRoomMessageKeys(m: RoomMessage): string[] {
  const keys: string[] = []
  if (m.stanzaId) keys.push(`stanzaId:${m.stanzaId}`)
  if (m.originId) keys.push(`originId:${m.originId}`)
  keys.push(`from:${m.from}:id:${m.id}`)
  return keys
}

/** Timeline config for the shared resident-window machine (see shared/messageTimeline.ts). */
function roomTimelineConfig(): timeline.TimelineConfig<RoomMessage> {
  return { getKeys: getRoomMessageKeys, windowSize: getResidentWindowSize() }
}

// ============================================================================
// Split-map field routing (single source of truth for the entity/meta/runtime
// fan-out). Exhaustive by construction: the `satisfies Record<keyof X, …>`
// clauses error when a field is missing or extra, so adding a field to a type
// forces a routing decision here. The previous hand-maintained lists silently
// went stale — `lastMessage` was missing, so `updateRoom({ lastMessage })`
// never reached roomMeta, and the full-projection rebuild wiped the fields the
// list didn't know about.
// ============================================================================

const ROOM_ENTITY_FIELDS = Object.keys({
  jid: true, name: true, nickname: true, joined: true, isJoining: true,
  subject: true, avatar: true, avatarHash: true, avatarFromPresence: true,
  isBookmarked: true, autojoin: true, password: true, isQuickChat: true,
  supportsMAM: true, supportsReactions: true, supportsHats: true,
  supportsModeration: true, isIrcGateway: true, isNonAnonymous: true,
  isPrivate: true, muted: true,
} satisfies Record<keyof RoomEntity, true>) as readonly (keyof RoomEntity)[]

const ROOM_META_FIELDS = Object.keys({
  unreadCount: true, mentionsCount: true, typingUsers: true, notifyAll: true,
  notifyAllPersistent: true, lastReadAt: true, lastSeenMessageId: true,
  pendingRemoteDisplayedStanzaId: true, lastMessage: true, lastInteractedAt: true,
} satisfies Record<keyof RoomMetadata, true>) as readonly (keyof RoomMetadata)[]

const ROOM_RUNTIME_FIELD_ROUTING = {
  occupants: 'sync', nickToJidCache: 'sync', nickToAvatarCache: 'sync',
  affiliatedMembers: 'sync', selfOccupant: 'sync', messages: 'sync',
  // A plain field update must never silently recenter the window — the
  // live-edge flag only changes through window operations (see
  // RoomRuntime.windowAtLiveEdge).
  windowAtLiveEdge: 'preserve',
} satisfies Record<keyof RoomRuntime, 'sync' | 'preserve'>

const ROOM_RUNTIME_FIELDS = (Object.keys(ROOM_RUNTIME_FIELD_ROUTING) as readonly (keyof RoomRuntime)[])
  .filter((key) => ROOM_RUNTIME_FIELD_ROUTING[key] === 'sync')

/** The subset of `source`'s own keys that appear in `fields`. */
function pickFields<T extends object>(source: object, fields: readonly (keyof T & string)[]): Partial<T> {
  const picked: Record<string, unknown> = {}
  for (const field of fields) {
    if (field in source) picked[field] = (source as Record<string, unknown>)[field]
  }
  return picked as Partial<T>
}

/**
 * Fan a Partial<Room> update out to the four room maps: the combined `rooms`
 * map always, and each split map only when the patch carries one of its
 * fields — merging the patched fields onto the EXISTING split value (never a
 * full projection from the combined map, which regresses fresher split state
 * and wipes fields the projection forgets).
 *
 * Returns the partial state update, or null when the room is unknown.
 */
function commitRoomUpdate(
  state: RoomState,
  roomJid: string,
  update: Partial<Room>
): Partial<RoomState> | null {
  const existing = state.rooms.get(roomJid)
  if (!existing) return null

  const newRooms = new Map(state.rooms)
  newRooms.set(roomJid, { ...existing, ...update })
  const result: Partial<RoomState> = { rooms: newRooms }

  const entityPatch = pickFields<RoomEntity>(update, ROOM_ENTITY_FIELDS as readonly (keyof RoomEntity & string)[])
  if (Object.keys(entityPatch).length > 0) {
    const existingEntity = state.roomEntities.get(roomJid)
    if (existingEntity) {
      const newEntities = new Map(state.roomEntities)
      newEntities.set(roomJid, { ...existingEntity, ...entityPatch })
      result.roomEntities = newEntities
    }
  }

  const metaPatch = pickFields<RoomMetadata>(update, ROOM_META_FIELDS as readonly (keyof RoomMetadata & string)[])
  if (Object.keys(metaPatch).length > 0) {
    const existingMeta = state.roomMeta.get(roomJid)
    if (existingMeta) {
      const newMeta = new Map(state.roomMeta)
      newMeta.set(roomJid, { ...existingMeta, ...metaPatch })
      result.roomMeta = newMeta
    }
  }

  const runtimePatch = pickFields<RoomRuntime>(update, ROOM_RUNTIME_FIELDS as readonly (keyof RoomRuntime & string)[])
  if (Object.keys(runtimePatch).length > 0) {
    const existingRuntime = state.roomRuntime.get(roomJid)
    if (existingRuntime) {
      const newRuntime = new Map(state.roomRuntime)
      newRuntime.set(roomJid, { ...existingRuntime, ...runtimePatch })
      result.roomRuntime = newRuntime
    }
  }

  return result
}

/**
 * Merge a batch of cached room messages into a room's resident array (and runtime mirror),
 * returning the partial state update (or `null` when the room is not present). Shared by
 * {@link RoomState.loadMessagesFromCache} and {@link RoomState.loadMessagesAroundFromCache}: both
 * dedupe, merge/sort/trim, and refresh the sidebar preview. The only difference between the two
 * callers is WHICH cache slice they fetch (latest-N vs the slice around an anchor).
 */
function mergeCachedRoomMessages(
  state: RoomState,
  roomJid: string,
  cachedMessages: RoomMessage[]
): Pick<RoomState, 'rooms' | 'roomRuntime' | 'roomMeta'> | null {
  const newRooms = new Map(state.rooms)
  const existing = newRooms.get(roomJid)
  if (!existing) return null

  // Shared timeline machine: dedupe (in-memory messages take precedence),
  // sort, and keep-newest trim.
  const { merged } = timeline.latestSlice(existing.messages, cachedMessages, roomTimelineConfig())

  // Sidebar preview via the shared policy: only replace when the merged set's
  // newest non-ignored message genuinely supersedes (or heals) the current
  // preview — a deep-history slice (scroll-position restore) must not regress it.
  const { lastMessage } = derivePreviewAfterMerge(existing.lastMessage, merged, (msgs) =>
    findLastNonIgnoredMessage(msgs, roomJid, existing.nickToJidCache)
  )

  newRooms.set(roomJid, { ...existing, messages: merged, lastMessage })

  // Update runtime
  const newRuntime = new Map(state.roomRuntime)
  const existingRuntime = newRuntime.get(roomJid)
  if (existingRuntime) {
    newRuntime.set(roomJid, { ...existingRuntime, messages: merged })
  }

  // Update metadata with lastMessage for sidebar
  const newMeta = new Map(state.roomMeta)
  const existingMeta = newMeta.get(roomJid)
  if (existingMeta) {
    newMeta.set(roomJid, { ...existingMeta, lastMessage })
  }

  return { rooms: newRooms, roomRuntime: newRuntime, roomMeta: newMeta }
}

/**
 * Room state interface for Multi-User Chat (MUC) rooms.
 *
 * Manages group chat rooms, occupants, messages, bookmarks, typing indicators,
 * and notification settings. Room data is ephemeral (not persisted) as it's
 * restored from server bookmarks and MAM on reconnect.
 *
 * @remarks
 * Most applications should use the `useRoom` hook instead of accessing this
 * store directly. The hook provides a cleaner API with memoized actions.
 *
 * @example Direct store access (advanced)
 * ```ts
 * import { useRoomStore } from '@fluux/sdk'
 *
 * // Get all bookmarked rooms
 * const bookmarked = useRoomStore.getState().bookmarkedRooms()
 *
 * // Subscribe to room updates
 * useRoomStore.subscribe(
 *   (state) => state.rooms,
 *   (rooms) => console.log('Rooms updated:', rooms.size)
 * )
 *
 * // Get total unread mentions
 * const mentions = useRoomStore.getState().totalMentionsCount()
 * ```
 *
 * @category Stores
 */
export interface RoomState {
  /** @deprecated Use roomEntities, roomMeta, and roomRuntime for fine-grained subscriptions */
  rooms: Map<string, Room>
  /** Stable room identity - changes on bookmark/join operations */
  roomEntities: Map<string, RoomEntity>
  /** Frequently-changing room state (unread counts, typing, etc.) */
  roomMeta: Map<string, RoomMetadata>
  /** Runtime room data - occupants, messages (rebuilt on join) */
  roomRuntime: Map<string, RoomRuntime>
  activeRoomJid: string | null
  // True while activateRoom() is hydrating a room's cache before it becomes active.
  // Lets the UI hold a neutral loading surface during the async gap instead of
  // flashing the "nothing selected" empty state on tab switch.
  activationPending: boolean
  // Easter egg animation state (ephemeral)
  activeAnimation: { roomJid: string; animation: string; senderName?: string } | null
  // Message drafts per room (persisted to localStorage separately)
  drafts: Map<string, string>
  // Poll state per room (persisted to localStorage separately)
  // votedPollIds: polls the local user has voted on — safety net when reactions are not yet loaded from MAM
  // dismissedPollIds: polls the user dismissed with X — UI preference
  votedPollIds: Map<string, Set<string>>
  dismissedPollIds: Map<string, Set<string>>
  // MAM query states per room (for rooms with MAM enabled)
  mamQueryStates: Map<string, MAMQueryState>
  // Persisted history-gap intervals per room (survives reload; drives the gap marker)
  roomGaps: Map<string, GapInterval>
  // Persisted contiguous-with-live coverage per room (positive twin of roomGaps;
  // survives fresh sessions and gap closure). See shared/mamCoverage.ts.
  roomCoverage: Map<string, CoverageRecord>
  // Rooms the user has acknowledged as non-anonymous (issue #37) — warn once, not
  // on every reconnect. Persisted to localStorage separately and scoped per account.
  acknowledgedNonAnonymousRooms: Set<string>
  // Target message to scroll to after navigation (ephemeral)
  targetMessageId: string | null
  // Session-only new-message divider per room (jid -> messageId). Derived at
  // activation from lastSeenMessageId; never persisted.
  firstNewMessageMarkers: Map<string, string>

  // Actions
  addRoom: (room: Room) => void
  updateRoom: (roomJid: string, update: Partial<Room>) => void
  removeRoom: (roomJid: string) => void
  setRoomJoined: (roomJid: string, joined: boolean) => void
  /** Reset joined/isJoining for all rooms (called on fresh session after reconnect) */
  markAllRoomsNotJoined: () => void
  addOccupant: (roomJid: string, occupant: RoomOccupant) => void
  batchAddOccupants: (roomJid: string, occupants: RoomOccupant[]) => void
  removeOccupant: (roomJid: string, nick: string) => void
  updateOccupantAvatar: (roomJid: string, nick: string, avatar: string | null, avatarHash: string | null) => void
  /** Batch variant of updateOccupantAvatar — one state update for N resolved avatars (e.g. after joining a large room) */
  updateOccupantAvatars: (roomJid: string, updates: Array<{ nick: string; avatar: string | null; avatarHash: string | null }>) => void
  setSelfOccupant: (roomJid: string, occupant: RoomOccupant) => void
  mergeRoomMembers: (roomJid: string, members: Array<{ jid: string; nick?: string; affiliation: RoomAffiliation }>, contactAvatarLookup?: (jid: string) => string | null) => void
  /**
   * Apply a single affiliation change to the cached `affiliatedMembers` list (XEP-0045 admin set).
   * owner/admin/member upsert the member; none/outcast remove them. Keeps the occupant
   * sidebar's offline-member list in sync after a change without a full member re-query.
   */
  updateMemberAffiliation: (roomJid: string, userJid: string, affiliation: RoomAffiliation) => void
  getRoom: (roomJid: string) => Room | undefined
  switchAccount: (jid: string | null) => void
  reset: () => void

  // Message actions
  addMessage: (roomJid: string, message: RoomMessage, options?: {
    incrementUnread?: boolean
    incrementMentions?: boolean
  }) => void
  updateReactions: (roomJid: string, messageId: string, reactorNick: string, emojis: string[]) => void
  updateMessage: (roomJid: string, messageId: string, updates: Partial<RoomMessage>) => void
  clearMessageStanzaId: (roomJid: string, stanzaId: string) => void
  getMessage: (roomJid: string, messageId: string) => RoomMessage | undefined
  /**
   * Epoch ms of the room's persisted last-known message (the entity preview),
   * or undefined. Used as a last-resort forward catch-up cursor so a persisted
   * room whose message cache is empty this run still forward-fills its offline
   * gap instead of a `before:''` fetch-latest.
   */
  getRoomLastTimestamp: (roomJid: string) => number | undefined
  markAsRead: (roomJid: string) => void
  /** Esc / mark-all-read: advance the read pointer to the newest known
   *  message, zero the counts, drop the divider. The MDS publisher picks up
   *  the pointer advance via the roomMeta watch. */
  markReadToNewest: (roomJid: string) => void
  /** Bulk vacation-recovery: markReadToNewest for every joined room with unread. */
  markAllRoomsRead: () => void
  setActiveRoom: (roomJid: string | null) => void
  /**
   * Hydrate the room's recent history from the IndexedDB cache, then mark it active.
   *
   * Prefer this over `setActiveRoom` for user-facing activation: only live messages are
   * kept in memory, so activating without hydration renders an empty view (until a manual
   * scroll loads history) and computes the unread marker without historical context.
   * If a newer activation starts while the cache read is in flight, the stale one is dropped.
   * Passing `null` deactivates immediately without touching the cache.
   */
  activateRoom: (roomJid: string | null) => Promise<void>
  getActiveRoomJid: () => string | null
  clearFirstNewMessageId: (roomJid: string) => void
  /** Recompute the session-only "New messages" divider from the current read pointer
   *  (lastSeenMessageId) for this room. Forward-only and idempotent: repositions the divider to the
   *  first unread message after the pointer when one exists. Never clears an existing divider when
   *  the pointer is at the newest (nothing unread) — that state is kept alive deliberately after a
   *  FAB jump-to-present so the jump-to-last-read pill can offer a return; clearing is owned by the
   *  explicit read-through / mark-read paths. No-op when no divider exists.
   *  Touches nothing but firstNewMessageMarkers.
   *  Only meaningful for the ACTIVE room: that is where the resident `messages` array lives. On a
   *  deactivated room `setActiveRoom` empties the roomRuntime/rooms messages, so the recompute sees
   *  an empty array and would SILENTLY clear the divider — callers must only invoke this for the
   *  active room. */
  resyncDividerToReadPointer: (roomJid: string) => void
  updateLastSeenMessageId: (roomJid: string, messageId: string) => void
  /**
   * XEP-0490: apply a remote device's last-displayed marker. Advances
   * lastSeenMessageId forward-only by resolving the stanza-id to a local
   * message id; stores a pending high-water mark if not yet loaded.
   */
  applyRemoteDisplayed: (roomJid: string, stanzaId: string, messagesOverride?: RoomMessage[]) => void
  setTyping: (roomJid: string, nick: string, isTyping: boolean) => void

  // Bookmark actions
  setBookmark: (roomJid: string, bookmark: { name: string; nick: string; autojoin?: boolean; password?: string; notifyAll?: boolean }) => void
  removeBookmark: (roomJid: string) => void

  // Non-anonymous room acknowledgement (issue #37)
  /** Record that the user accepted joining a room that exposes their real JID (persisted, scoped per account). */
  acknowledgeNonAnonymousRoom: (roomJid: string) => void
  /** Whether the user has already acknowledged this room's real-JID exposure. */
  isNonAnonymousRoomAcknowledged: (roomJid: string) => boolean

  // Notification settings
  setNotifyAll: (roomJid: string, notifyAll: boolean, persistent?: boolean) => void

  // Easter egg animations
  triggerAnimation: (roomJid: string, animation: string, senderName?: string) => void
  clearAnimation: () => void

  // Draft management
  setDraft: (roomJid: string, text: string) => void
  getDraft: (roomJid: string) => string
  clearDraft: (roomJid: string) => void

  // Poll state tracking (persisted to localStorage)
  recordPollVote: (roomJid: string, messageId: string) => void
  removePollVote: (roomJid: string, messageId: string) => void
  getVotedPollIds: (roomJid: string) => Set<string>
  dismissPoll: (roomJid: string, messageId: string) => void
  getDismissedPollIds: (roomJid: string) => Set<string>

  // IndexedDB cache loading. `oldest` flips the latest-N default to the
  // OLDEST-N ascending slice (true cache bottom) — pointer-walk seeding; use
  // with `peek` (an oldest slice must never become the resident window).
  loadMessagesFromCache: (roomJid: string, options?: GetMessagesOptions & { peek?: boolean; oldest?: boolean }) => Promise<RoomMessage[]>
  /**
   * Hydrate the resident array with the contiguous cache slice that CONTAINS a specific message
   * (the anchor), rather than the latest-N slice. Room counterpart of
   * {@link ChatState.loadMessagesAroundFromCache} — used by scroll-position restore on return to a
   * room the user had scrolled deep into, and by search/activity navigation. Returns the loaded
   * slice (empty if the anchor is not in the cache).
   */
  loadMessagesAroundFromCache: (roomJid: string, anchorMessageId: string, options?: { before?: number; after?: number }) => Promise<RoomMessage[]>
  loadOlderMessagesFromCache: (roomJid: string, limit?: number) => Promise<RoomMessage[]>
  /**
   * Mirror of {@link loadOlderMessagesFromCache} for the opposite direction: loads the next-newer
   * cache slice AFTER the resident newest message and appends it, evicting the OLDEST resident
   * messages at the bound (keep-newest) instead of the newest. Used to slide the window back down
   * after a scroll-back has moved it off the live edge. Sets `windowAtLiveEdge = true` when the
   * cache has nothing newer left (the window has reached the tail).
   */
  loadNewerMessagesFromCache: (roomJid: string, limit?: number) => Promise<RoomMessage[]>
  /**
   * Jump-to-latest: reset the resident window to the newest slice from cache and mark the window
   * at the live edge. Thin wrapper around {@link loadMessagesFromCache}'s latest-N path (which
   * already sets `windowAtLiveEdge = true` on recenter); kept as its own action for the UI's
   * jump-to-latest affordance.
   */
  recenterToLatest: (roomJid: string) => Promise<void>
  /** Load only the latest message from cache for sidebar preview (doesn't modify messages array) */
  loadPreviewFromCache: (roomJid: string) => Promise<RoomMessage | null>
  /**
   * Populate sidebar-ordering previews for all bookmarked/joined rooms from the
   * durable IndexedDB cache in a SINGLE batched store write.
   *
   * At launch the room list is rebuilt from bookmarks with no `lastMessage`, so
   * every room sorts at epoch 0 until its per-room preview lands (on join, or the
   * delayed catch-up) - leaving the sidebar mis-ordered and making the active room
   * "jump" to the top once opened. This reads each room's newest cached message in
   * parallel (network-free) and applies all previews at once, so the sidebar
   * re-sorts a single time instead of once per room. Never downgrades a fresher
   * preview, so it is safe alongside the join / catch-up preview paths.
   */
  hydratePreviewsFromCache: () => Promise<void>

  // MAM state management (XEP-0313 for MUC rooms)
  setRoomMAMLoading: (roomJid: string, isLoading: boolean) => void
  setRoomMAMError: (roomJid: string, error: string | null) => void
  /**
   * Merge MAM messages into room and update query state.
   * @param roomJid - Room JID
   * @param messages - Messages from MAM query
   * @param rsm - RSM pagination response
   * @param complete - Whether server indicated query is complete
   * @param direction - Query direction: 'backward' for older history, 'forward' for catching up
   */
  mergeRoomMAMMessages: (roomJid: string, messages: RoomMessage[], rsm: RSMResponse, complete: boolean, direction: MAMQueryDirection, preserveGapMarker?: boolean, isFetchLatest?: boolean, extras?: MergeArchiveExtras) => void
  /**
   * Strip a purged archive id from the persisted gap anchor (`startId`),
   * keeping the `start` timestamp so the next catch-up resume uses the
   * timestamp fallback and progresses. Called via the `room:mam-anchor-purged`
   * binding when an `after:`-anchored query hit item-not-found. Only strips a
   * MATCHING id — a gap whose anchor already advanced is left untouched.
   */
  clearRoomGapAnchor: (roomJid: string, purgedStartId: string) => void
  /** Persisted contiguous-with-live coverage record, if any. */
  getRoomCoverage: (roomJid: string) => CoverageRecord | undefined
  /** Drop the coverage record; with `ifBottomId`, only when it matches
   *  `bottomId` (purge-event guard — the anchor is known gone). */
  clearRoomCoverage: (roomJid: string, ifBottomId?: string) => void
  getRoomMAMQueryState: (roomJid: string) => MAMQueryState
  resetRoomMAMStates: () => void
  /** Update only the lastMessage preview without affecting message history */
  updateLastMessagePreview: (roomJid: string, lastMessage: RoomMessage) => void
  setTargetMessageId: (id: string | null) => void

  // Computed
  joinedRooms: () => Room[]
  bookmarkedRooms: () => Room[]
  allRooms: () => Room[] // All rooms (bookmarked or joined)
  /**
   * Sidebar-ordered, section-encoded room JIDs ("<section> <jid>", where section
   * is quick | joined | bookmarked). Subscribe via useShallow so the sidebar list
   * re-renders only when membership / order / section changes — NOT on every
   * message or unread update. Each row subscribes to its own room by JID.
   */
  roomSidebarJids: () => string[]
  quickChatRooms: () => Room[] // All quick chat rooms
  activeRoom: () => Room | undefined
  activeMessages: () => RoomMessage[]
  totalMentionsCount: () => number // Total mentions across all joined rooms
  totalUnreadCount: () => number // Total unread messages across all joined rooms
  totalNotifiableUnreadCount: () => number // Total unread in rooms with notifyAll enabled
  roomsWithUnreadCount: () => number // Number of rooms with unread activity (for dock badge)
  roomTabIndicator: () => 'none' | 'neutral' | 'accent' // Rooms tab dot tone
}

function createEmptyRoomState(
  drafts: Map<string, string> = new Map(),
  votedPollIds: Map<string, Set<string>> = new Map(),
  dismissedPollIds: Map<string, Set<string>> = new Map(),
  roomGaps: Map<string, GapInterval> = new Map(),
  acknowledgedNonAnonymousRooms: Set<string> = new Set(),
  roomCoverage: Map<string, CoverageRecord> = new Map(),
): Pick<RoomState, 'rooms' | 'roomEntities' | 'roomMeta' | 'roomRuntime' | 'activeRoomJid' | 'activationPending' | 'activeAnimation' | 'drafts' | 'votedPollIds' | 'dismissedPollIds' | 'mamQueryStates' | 'roomGaps' | 'roomCoverage' | 'acknowledgedNonAnonymousRooms' | 'targetMessageId' | 'firstNewMessageMarkers'> {
  return {
    rooms: new Map(),
    roomEntities: new Map(),
    roomMeta: new Map(),
    roomRuntime: new Map(),
    activeRoomJid: null,
    activationPending: false,
    activeAnimation: null,
    drafts,
    votedPollIds,
    dismissedPollIds,
    mamQueryStates: new Map(),
    roomGaps,
    roomCoverage,
    acknowledgedNonAnonymousRooms,
    targetMessageId: null,
    firstNewMessageMarkers: new Map(),
  }
}

export const roomStore = createStore<RoomState>()(
  subscribeWithSelector((set, get) => ({
  ...createEmptyRoomState(loadDraftsFromStorage(), loadVotedPollsFromStorage(), loadDismissedPollsFromStorage(), loadGapsFromStorage(), loadNonAnonAckFromStorage(), loadCoverageFromStorage()), // Restore drafts, poll state, history gaps, coverage, and non-anon acks from localStorage

  addRoom: (room) => {
    set((state) => {
      // Split room into entity, metadata, and runtime components
      const entity: RoomEntity = {
        jid: room.jid,
        name: room.name,
        nickname: room.nickname,
        joined: room.joined,
        isJoining: room.isJoining,
        subject: room.subject,
        avatar: room.avatar,
        avatarHash: room.avatarHash,
        avatarFromPresence: room.avatarFromPresence,
        isBookmarked: room.isBookmarked,
        autojoin: room.autojoin,
        password: room.password,
        isQuickChat: room.isQuickChat,
        supportsMAM: room.supportsMAM,
        supportsReactions: room.supportsReactions,
        supportsHats: room.supportsHats,
        supportsModeration: room.supportsModeration,
        isIrcGateway: room.isIrcGateway,
        isNonAnonymous: room.isNonAnonymous,
        isPrivate: room.isPrivate,
        muted: room.muted,
      }
      const meta: RoomMetadata = {
        unreadCount: room.unreadCount,
        mentionsCount: room.mentionsCount,
        typingUsers: room.typingUsers,
        notifyAll: room.notifyAll,
        notifyAllPersistent: room.notifyAllPersistent,
        lastReadAt: room.lastReadAt,
        lastSeenMessageId: room.lastSeenMessageId,
        lastMessage: room.messages?.length > 0 ? findLastNonIgnoredMessage(room.messages, room.jid, room.nickToJidCache) : undefined,
        lastInteractedAt: room.lastInteractedAt,
      }
      const runtime: RoomRuntime = {
        occupants: room.occupants,
        nickToJidCache: room.nickToJidCache,
        selfOccupant: room.selfOccupant,
        messages: room.messages,
        // A room upsert seeds the newest window → at the live edge by default.
        windowAtLiveEdge: room.windowAtLiveEdge ?? true,
      }

      const newRooms = new Map(state.rooms)
      newRooms.set(room.jid, room)

      const newEntities = new Map(state.roomEntities)
      newEntities.set(room.jid, entity)

      const newMeta = new Map(state.roomMeta)
      newMeta.set(room.jid, meta)

      const newRuntime = new Map(state.roomRuntime)
      newRuntime.set(room.jid, runtime)

      return {
        rooms: newRooms,
        roomEntities: newEntities,
        roomMeta: newMeta,
        roomRuntime: newRuntime,
      }
    })
  },

  updateRoom: (roomJid, update) => {
    set((state) => commitRoomUpdate(state, roomJid, update) ?? state)
  },

  removeRoom: (roomJid) => {
    // Delete messages from IndexedDB (non-blocking)
    void messageCache.deleteRoomMessages(roomJid)

    set((state) => {
      const newRooms = new Map(state.rooms)
      newRooms.delete(roomJid)

      const newEntities = new Map(state.roomEntities)
      newEntities.delete(roomJid)

      const newMeta = new Map(state.roomMeta)
      newMeta.delete(roomJid)

      const newRuntime = new Map(state.roomRuntime)
      newRuntime.delete(roomJid)

      return {
        rooms: newRooms,
        roomEntities: newEntities,
        roomMeta: newMeta,
        roomRuntime: newRuntime,
      }
    })
  },

  setRoomJoined: (roomJid, joined) => {
    set((state) => {
      const newRooms = new Map(state.rooms)
      const existing = newRooms.get(roomJid)
      if (!existing) return state

      // DON'T set lastInteractedAt on join - only setActiveRoom (user clicking) should set it.
      // MUC history messages arrive before the join confirmation, so existing.messages may
      // contain history whose timestamps don't reflect actual user interaction.
      // Leaving lastInteractedAt undefined lets allRooms() fall back to lastMessage.timestamp
      // (populated by MAM preview), which correctly reflects each room's latest activity.
      const updatedRoom = {
        ...existing,
        joined,
        // Clear isJoining flag when join completes (success or failure)
        isJoining: false,
        // Reset counts and session-only notifyAll when leaving (joined = false)
        unreadCount: joined ? existing.unreadCount : 0,
        mentionsCount: joined ? existing.mentionsCount : 0,
        notifyAll: joined ? existing.notifyAll : undefined,
      }
      newRooms.set(roomJid, updatedRoom)

      // Update entity (joined, isJoining)
      const newEntities = new Map(state.roomEntities)
      const existingEntity = newEntities.get(roomJid)
      if (existingEntity) {
        newEntities.set(roomJid, { ...existingEntity, joined, isJoining: false })
      }

      // Update metadata (unreadCount, mentionsCount, notifyAll)
      const newMeta = new Map(state.roomMeta)
      const existingMeta = newMeta.get(roomJid)
      if (existingMeta) {
        newMeta.set(roomJid, {
          ...existingMeta,
          unreadCount: joined ? existingMeta.unreadCount : 0,
          mentionsCount: joined ? existingMeta.mentionsCount : 0,
          notifyAll: joined ? existingMeta.notifyAll : undefined,
        })
      }

      return { rooms: newRooms, roomEntities: newEntities, roomMeta: newMeta }
    })
  },

  markAllRoomsNotJoined: () => {
    set((state) => {
      const newRooms = new Map(state.rooms)
      const newEntities = new Map(state.roomEntities)

      for (const [jid, room] of newRooms) {
        if (room.joined || room.isJoining) {
          newRooms.set(jid, { ...room, joined: false, isJoining: false })
        }
      }
      for (const [jid, entity] of newEntities) {
        if (entity.joined || entity.isJoining) {
          newEntities.set(jid, { ...entity, joined: false, isJoining: false })
        }
      }

      return { rooms: newRooms, roomEntities: newEntities }
    })
  },

  addOccupant: (roomJid, occupant) => {
    set((state) => {
      const newRooms = new Map(state.rooms)
      const existing = newRooms.get(roomJid)
      if (!existing) return state

      const newOccupants = new Map(existing.occupants)
      // Presence carries only the avatar hash — keep an already-fetched blob alive.
      const merged = preserveOccupantAvatar(existing.occupants.get(occupant.nick), occupant)
      newOccupants.set(merged.nick, merged)

      // Update nick→jid cache for non-anonymous rooms (when real JID is visible)
      let nickToJidCache = existing.nickToJidCache
      if (merged.jid) {
        nickToJidCache = new Map(nickToJidCache || [])
        nickToJidCache.set(merged.nick, getBareJid(merged.jid))
      }

      // Update nick→avatar cache if occupant has avatar
      let nickToAvatarCache = existing.nickToAvatarCache
      if (merged.avatar) {
        nickToAvatarCache = new Map(nickToAvatarCache || [])
        nickToAvatarCache.set(merged.nick, merged.avatar)
      }

      newRooms.set(roomJid, { ...existing, occupants: newOccupants, nickToJidCache, nickToAvatarCache })

      // Update runtime
      const newRuntime = new Map(state.roomRuntime)
      const existingRuntime = newRuntime.get(roomJid)
      if (existingRuntime) {
        newRuntime.set(roomJid, { ...existingRuntime, occupants: newOccupants, nickToJidCache, nickToAvatarCache })
      }

      return { rooms: newRooms, roomRuntime: newRuntime }
    })
  },

  batchAddOccupants: (roomJid, occupants) => {
    if (occupants.length === 0) return

    set((state) => {
      const newRooms = new Map(state.rooms)
      const existing = newRooms.get(roomJid)
      if (!existing) return state

      const newOccupants = new Map(existing.occupants)
      let nickToJidCache = existing.nickToJidCache
      let nickToAvatarCache = existing.nickToAvatarCache

      // Add all occupants in a single update
      for (const occupant of occupants) {
        // Presence carries only the avatar hash — keep an already-fetched blob alive.
        const merged = preserveOccupantAvatar(newOccupants.get(occupant.nick), occupant)
        newOccupants.set(merged.nick, merged)

        // Update nick→jid cache for non-anonymous rooms
        if (merged.jid) {
          if (!nickToJidCache || nickToJidCache === existing.nickToJidCache) {
            nickToJidCache = new Map(nickToJidCache || [])
          }
          nickToJidCache.set(merged.nick, getBareJid(merged.jid))
        }

        // Update nick→avatar cache
        if (merged.avatar) {
          if (!nickToAvatarCache || nickToAvatarCache === existing.nickToAvatarCache) {
            nickToAvatarCache = new Map(nickToAvatarCache || [])
          }
          nickToAvatarCache.set(merged.nick, merged.avatar)
        }
      }

      newRooms.set(roomJid, { ...existing, occupants: newOccupants, nickToJidCache, nickToAvatarCache })

      // Update runtime
      const newRuntime = new Map(state.roomRuntime)
      const existingRuntime = newRuntime.get(roomJid)
      if (existingRuntime) {
        newRuntime.set(roomJid, { ...existingRuntime, occupants: newOccupants, nickToJidCache, nickToAvatarCache })
      }

      return { rooms: newRooms, roomRuntime: newRuntime }
    })
  },

  removeOccupant: (roomJid, nick) => {
    set((state) => {
      const newRooms = new Map(state.rooms)
      const existing = newRooms.get(roomJid)
      if (!existing) return state

      const newOccupants = new Map(existing.occupants)
      newOccupants.delete(nick)
      // Also remove from typing users when they leave
      const newTypingUsers = new Set(existing.typingUsers)
      newTypingUsers.delete(nick)
      newRooms.set(roomJid, { ...existing, occupants: newOccupants, typingUsers: newTypingUsers })

      // Update runtime (occupants)
      const newRuntime = new Map(state.roomRuntime)
      const existingRuntime = newRuntime.get(roomJid)
      if (existingRuntime) {
        newRuntime.set(roomJid, { ...existingRuntime, occupants: newOccupants })
      }

      // Update metadata (typingUsers)
      const newMeta = new Map(state.roomMeta)
      const existingMeta = newMeta.get(roomJid)
      if (existingMeta) {
        newMeta.set(roomJid, { ...existingMeta, typingUsers: newTypingUsers })
      }

      return { rooms: newRooms, roomRuntime: newRuntime, roomMeta: newMeta }
    })
  },

  updateOccupantAvatar: (roomJid, nick, avatar, avatarHash) => {
    get().updateOccupantAvatars(roomJid, [{ nick, avatar, avatarHash }])
  },

  updateOccupantAvatars: (roomJid, updates) => {
    set((state) => {
      const existing = state.rooms.get(roomJid)
      if (!existing) return state

      let newOccupants: Map<string, RoomOccupant> | null = null
      // Update nick→avatar cache so avatars persist after occupants leave
      let nickToAvatarCache = existing.nickToAvatarCache

      for (const { nick, avatar, avatarHash } of updates) {
        const occupant = (newOccupants ?? existing.occupants).get(nick)
        if (!occupant) continue

        if (!newOccupants) newOccupants = new Map(existing.occupants)
        newOccupants.set(nick, {
          ...occupant,
          avatar: avatar ?? undefined,
          avatarHash: avatarHash ?? undefined,
        })

        if (avatar) {
          if (!nickToAvatarCache || nickToAvatarCache === existing.nickToAvatarCache) {
            nickToAvatarCache = new Map(nickToAvatarCache || [])
          }
          nickToAvatarCache.set(nick, avatar)
        }
      }

      if (!newOccupants) return state

      const newRooms = new Map(state.rooms)
      newRooms.set(roomJid, { ...existing, occupants: newOccupants, nickToAvatarCache })

      // Update runtime (occupants + avatar cache)
      const newRuntime = new Map(state.roomRuntime)
      const existingRuntime = newRuntime.get(roomJid)
      if (existingRuntime) {
        newRuntime.set(roomJid, { ...existingRuntime, occupants: newOccupants, nickToAvatarCache })
      }

      return { rooms: newRooms, roomRuntime: newRuntime }
    })
  },

  setSelfOccupant: (roomJid, occupant) => {
    set((state) => {
      const newRooms = new Map(state.rooms)
      const existing = newRooms.get(roomJid)
      if (!existing) return state

      // Update nickname with server-reflected value to ensure message comparison works
      // The server may normalize the nickname (e.g., case changes), so we use what it sends back
      newRooms.set(roomJid, { ...existing, selfOccupant: occupant, nickname: occupant.nick })

      // Update entities (includes nickname)
      const newEntities = new Map(state.roomEntities)
      const existingEntity = newEntities.get(roomJid)
      if (existingEntity) {
        newEntities.set(roomJid, { ...existingEntity, nickname: occupant.nick })
      }

      // Update runtime
      const newRuntime = new Map(state.roomRuntime)
      const existingRuntime = newRuntime.get(roomJid)
      if (existingRuntime) {
        newRuntime.set(roomJid, { ...existingRuntime, selfOccupant: occupant })
      }

      return { rooms: newRooms, roomEntities: newEntities, roomRuntime: newRuntime }
    })
  },

  mergeRoomMembers: (roomJid, members, contactAvatarLookup) => {
    if (members.length === 0) return

    set((state) => {
      const newRooms = new Map(state.rooms)
      const existing = newRooms.get(roomJid)
      if (!existing) return state

      // Build updated caches with member data
      let nickToJidCache = existing.nickToJidCache
      let nickToAvatarCache = existing.nickToAvatarCache
      let cacheChanged = false

      for (const member of members) {
        if (member.nick) {
          // Only add if nick is not already mapped (online occupant data takes precedence)
          if (!nickToJidCache?.has(member.nick)) {
            if (!cacheChanged) {
              nickToJidCache = new Map(nickToJidCache || [])
              nickToAvatarCache = new Map(nickToAvatarCache || [])
              cacheChanged = true
            }
            nickToJidCache!.set(member.nick, member.jid)

            // Populate avatar cache from roster contact if available
            if (contactAvatarLookup) {
              const avatar = contactAvatarLookup(member.jid)
              if (avatar && !nickToAvatarCache!.has(member.nick)) {
                nickToAvatarCache!.set(member.nick, avatar)
              }
            }
          }
        }
      }

      const updatedRoom = {
        ...existing,
        affiliatedMembers: members,
        ...(cacheChanged && { nickToJidCache, nickToAvatarCache }),
      }
      newRooms.set(roomJid, updatedRoom)

      // Update runtime
      const newRuntime = new Map(state.roomRuntime)
      const existingRuntime = newRuntime.get(roomJid)
      if (existingRuntime) {
        newRuntime.set(roomJid, {
          ...existingRuntime,
          affiliatedMembers: members,
          ...(cacheChanged && { nickToJidCache, nickToAvatarCache }),
        })
      }

      return { rooms: newRooms, roomRuntime: newRuntime }
    })
  },

  updateMemberAffiliation: (roomJid, userJid, affiliation) => {
    set((state) => {
      const existing = state.rooms.get(roomJid)
      if (!existing) return state

      const current = existing.affiliatedMembers ?? []
      // owner/admin/member are the tiers shown as offline members; none/outcast are not.
      const isAffiliated =
        affiliation === 'owner' || affiliation === 'admin' || affiliation === 'member'

      let next: RoomMember[]
      if (isAffiliated) {
        const idx = current.findIndex((m) => m.jid === userJid)
        if (idx >= 0) {
          if (current[idx].affiliation === affiliation) return state // no change
          next = current.map((m) => (m.jid === userJid ? { ...m, affiliation } : m))
        } else {
          next = [...current, { jid: userJid, affiliation }]
        }
      } else {
        next = current.filter((m) => m.jid !== userJid)
        if (next.length === current.length) return state // nothing to remove
      }

      const newRooms = new Map(state.rooms)
      newRooms.set(roomJid, { ...existing, affiliatedMembers: next })

      const newRuntime = new Map(state.roomRuntime)
      const existingRuntime = newRuntime.get(roomJid)
      if (existingRuntime) {
        newRuntime.set(roomJid, { ...existingRuntime, affiliatedMembers: next })
      }

      return { rooms: newRooms, roomRuntime: newRuntime }
    })
  },

  getRoom: (roomJid) => get().rooms.get(roomJid),

  switchAccount: (jid) => {
    set(createEmptyRoomState(loadDraftsFromStorage(jid), loadVotedPollsFromStorage(jid), loadDismissedPollsFromStorage(jid), loadGapsFromStorage(jid), loadNonAnonAckFromStorage(jid), loadCoverageFromStorage(jid)))
  },

  reset: () => {
    // Note: We don't clear IndexedDB on reset - room messages are valuable cache
    // They will be cleared when rooms are explicitly removed or user logs out
    // (The connection store's reset handles full logout cleanup via clearAllMessages)
    // New session → the XEP-0490 synced read marker may be folded again on first open.
    mdsGate.reset()
    // Clear persisted room drafts and poll state on logout
    localStorage.removeItem(getRoomDraftsStorageKey())
    localStorage.removeItem(getRoomVotedPollsStorageKey())
    localStorage.removeItem(getRoomDismissedPollsStorageKey())
    localStorage.removeItem(getRoomGapsStorageKey())
    localStorage.removeItem(getRoomNonAnonAckStorageKey())
    set(createEmptyRoomState())
  },

  // Message actions
  addMessage: (roomJid, message, options = {}) => {
    const { incrementUnread = true, incrementMentions = false } = options

    // Get room to check if it's a Quick Chat (transient history)
    const room = get().rooms.get(roomJid)

    // Quick Chat rooms are transient: keep their messages in memory only
    const messageToAdd: StoredRoomMessage = room?.isQuickChat
      ? { ...message, noLocalStore: true }
      : message

    // Save to IndexedDB only if the message is locally persistable
    if (!isNoLocalStore(messageToAdd)) {
      void messageCache.saveRoomMessage(messageToAdd)
      searchIndex.indexMessage(messageToAdd).catch((e) => console.warn('[searchIndex] indexMessage failed:', e))
    }

    set((state) => {
      const newRooms = new Map(state.rooms)
      const existing = newRooms.get(roomJid)
      if (!existing) return state

      // Shared timeline machine: dedupe (XEP-0359 keys), archive-id backfill
      // on duplicate reflected/archived echoes, live-edge gating (a slid
      // window gates the append so a fresh message never splices after an OLD
      // one), and window trim. Gated messages are still persisted to
      // IndexedDB (above) and the preview/unread updates below still run;
      // they reload on jump-to-latest.
      const atLiveEdge = state.roomRuntime.get(roomJid)?.windowAtLiveEdge !== false
      const append = timeline.appendLive(existing.messages, messageToAdd, atLiveEdge, roomTimelineConfig())

      if (append.kind === 'duplicate-unchanged') return state
      if (append.kind === 'duplicate-backfilled') {
        // Persist the backfilled archive ids so pagination cursors survive a reload.
        for (const p of append.patched) {
          void messageCache.updateRoomMessage(p.id, { stanzaId: p.stanzaId!, ...(p.originId ? { originId: p.originId } : {}) })
        }
        newRooms.set(roomJid, { ...existing, messages: append.messages })
        const patchedRuntime = new Map(state.roomRuntime)
        const runtimeEntry = patchedRuntime.get(roomJid)
        if (runtimeEntry) {
          patchedRuntime.set(roomJid, { ...runtimeEntry, messages: append.messages })
        }
        return { rooms: newRooms, roomRuntime: patchedRuntime }
      }

      // The appended set is also the basis for the newest-message preview even
      // when the append was gated (the preview must still advance to the
      // incoming message after the window slid off the live edge).
      const appendedMessages = append.kind === 'appended' ? append.messages : [...existing.messages, messageToAdd]
      const newMessages = append.kind === 'appended' ? append.messages : existing.messages

      // Delegate notification state to pure function
      const isActive = state.activeRoomJid === roomJid
      const windowVisible = connectionStore.getState().windowVisible
      const existingMeta = state.roomMeta.get(roomJid)

      const notifInput: notifState.EntityNotificationState = {
        unreadCount: existingMeta?.unreadCount ?? existing.unreadCount,
        mentionsCount: existingMeta?.mentionsCount ?? existing.mentionsCount,
        lastReadAt: existingMeta?.lastReadAt ?? existing.lastReadAt,
        lastSeenMessageId: existingMeta?.lastSeenMessageId ?? existing.lastSeenMessageId,
        firstNewMessageId: state.firstNewMessageMarkers.get(roomJid),
      }

      const updated = notifState.onMessageReceived(
        notifInput,
        {
          id: messageToAdd.id,
          timestamp: messageToAdd.timestamp,
          isOutgoing: messageToAdd.isOutgoing ?? false,
          isDelayed: messageToAdd.isDelayed,
          isMention: messageToAdd.isMention,
        },
        { isActive, windowVisible },
        { incrementUnread, incrementMentions }
      )

      // Get the last non-ignored message for sidebar preview. Use the appended set
      // (not the possibly-gated resident array) so the preview still advances to the
      // incoming message even when the window has slid off the live edge.
      const lastMessage = findLastNonIgnoredMessage(appendedMessages, roomJid, existing.nickToJidCache) ?? existing.lastMessage

      // Update lastInteractedAt so the room bubbles up in the sidebar:
      // - Active room: always update (user is viewing it)
      // - Non-active, non-muted: update so room bubbles to top on new messages
      // - Non-active, muted: keep current value (only updates when user opens room)
      const entity = state.roomEntities.get(roomJid)
      const isMuted = entity?.muted ?? existing.muted ?? false
      const newLastInteractedAt = isActive || !isMuted
        ? (lastMessage?.timestamp ?? existing.lastInteractedAt)
        : existing.lastInteractedAt

      newRooms.set(roomJid, {
        ...existing,
        messages: newMessages,
        unreadCount: updated.unreadCount,
        mentionsCount: updated.mentionsCount,
        lastReadAt: updated.lastReadAt,
        lastMessage,
        lastInteractedAt: newLastInteractedAt,
      })

      // Update runtime (messages)
      const newRuntime = new Map(state.roomRuntime)
      const existingRuntime = newRuntime.get(roomJid)
      if (existingRuntime) {
        newRuntime.set(roomJid, { ...existingRuntime, messages: newMessages })
      }

      // Update metadata
      const newMeta = new Map(state.roomMeta)
      if (existingMeta) {
        newMeta.set(roomJid, {
          ...existingMeta,
          unreadCount: updated.unreadCount,
          mentionsCount: updated.mentionsCount,
          lastReadAt: updated.lastReadAt,
          lastMessage,
          lastInteractedAt: newLastInteractedAt,
        })
      }

      // Session-only divider (parity with chatStore.addMessage).
      const newMarkers = new Map(state.firstNewMessageMarkers)
      if (updated.firstNewMessageId) newMarkers.set(roomJid, updated.firstNewMessageId)
      else newMarkers.delete(roomJid)

      return { rooms: newRooms, roomRuntime: newRuntime, roomMeta: newMeta, firstNewMessageMarkers: newMarkers }
    })
  },

  updateReactions: (roomJid, messageId, reactorNick, emojis) => {
    set((state) => {
      const newRooms = new Map(state.rooms)
      const existing = newRooms.get(roomJid)
      if (!existing) return state

      // Resolve to a single target: id/stanzaId win, origin-id is fallback only.
      const targetIdx = findMessageIndexById(existing.messages, messageId)
      let updatedMessage: RoomMessage | undefined
      const newMessages = targetIdx === -1 ? existing.messages : existing.messages.map((msg, i) => {
        if (i !== targetIdx) return msg

        // Build new reactions map
        const newReactions: Record<string, string[]> = {}

        // Copy existing reactions, removing this reactor from all
        if (msg.reactions) {
          for (const [emoji, reactors] of Object.entries(msg.reactions)) {
            const filtered = reactors.filter((nick) => nick !== reactorNick)
            if (filtered.length > 0) {
              newReactions[emoji] = filtered
            }
          }
        }

        // Add reactor to new emojis
        for (const emoji of emojis) {
          if (!newReactions[emoji]) {
            newReactions[emoji] = []
          }
          newReactions[emoji].push(reactorNick)
        }

        updatedMessage = {
          ...msg,
          reactions: Object.keys(newReactions).length > 0 ? newReactions : undefined,
        }
        return updatedMessage
      })

      // Update IndexedDB (non-blocking) — use actual message id, not the lookup key
      if (updatedMessage) {
        void messageCache.updateRoomMessage(updatedMessage.id, {
          reactions: updatedMessage.reactions,
        })
      } else {
        // Message not in memory — update reactions directly in IndexedDB cache
        // so the correct state is restored when the message is loaded later
        logInfo(`Reaction for message ${messageId} not in memory — updating in cache`)
        void messageCache.updateRoomMessageReactions(messageId, reactorNick, emojis)
      }

      newRooms.set(roomJid, { ...existing, messages: newMessages })

      // Update runtime
      const newRuntime = new Map(state.roomRuntime)
      const existingRuntime = newRuntime.get(roomJid)
      if (existingRuntime) {
        newRuntime.set(roomJid, { ...existingRuntime, messages: newMessages })
      }

      return { rooms: newRooms, roomRuntime: newRuntime }
    })
  },

  updateMessage: (roomJid, messageId, updates) => {
    set((state) => {
      const newRooms = new Map(state.rooms)
      const existing = newRooms.get(roomJid)
      if (!existing) return state

      // Resolve to a single target: id/stanzaId win, origin-id is fallback only.
      // Retractions (XEP-0424) reference the MUC stanza-id; corrections (XEP-0308)
      // reference the sender-assigned origin-id (a MUC may rewrite the message id).
      const targetIdx = findMessageIndexById(existing.messages, messageId)
      let updatedMessage: RoomMessage | undefined
      const newMessages = targetIdx === -1 ? existing.messages : existing.messages.map((msg, i) => {
        if (i !== targetIdx) return msg
        updatedMessage = { ...msg, ...updates }
        return updatedMessage
      })

      // Update IndexedDB (non-blocking) — use actual message id, not the lookup key
      if (updatedMessage) {
        void messageCache.updateRoomMessage(updatedMessage.id, updates)

        // Update search index: re-index if body changed, remove if retracted
        if (updates.isRetracted) {
          void searchIndex.removeMessage(updatedMessage)
        } else if (updates.body) {
          void searchIndex.updateMessage(updatedMessage)
        }
      }

      newRooms.set(roomJid, { ...existing, messages: newMessages })

      // Update runtime
      const newRuntime = new Map(state.roomRuntime)
      const existingRuntime = newRuntime.get(roomJid)
      if (existingRuntime) {
        newRuntime.set(roomJid, { ...existingRuntime, messages: newMessages })
      }

      // Update metadata's lastMessage if the updated message is the last one
      const lastMessage = newMessages[newMessages.length - 1]
      const result: Partial<RoomState> = { rooms: newRooms, roomRuntime: newRuntime }
      if (updatedMessage && lastMessage === updatedMessage) {
        const newMeta = new Map(state.roomMeta)
        const existingMeta = newMeta.get(roomJid)
        if (existingMeta) {
          newMeta.set(roomJid, { ...existingMeta, lastMessage })
          result.roomMeta = newMeta
        }
      }

      return result
    })
  },

  clearMessageStanzaId: (roomJid, stanzaId) => {
    set((state) => {
      const existing = state.rooms.get(roomJid)
      if (!existing) return state

      const targetIdx = existing.messages.findIndex((message) => message.stanzaId === stanzaId)
      if (targetIdx === -1) return state

      const newMessages = [...existing.messages]
      const { stanzaId: _staleStanzaId, ...updatedMessage } = existing.messages[targetIdx]
      newMessages[targetIdx] = updatedMessage

      void messageCache.updateRoomMessage(existing.messages[targetIdx].id, { stanzaId: undefined })

      const newRooms = new Map(state.rooms)
      newRooms.set(roomJid, { ...existing, messages: newMessages })

      const newRuntime = new Map(state.roomRuntime)
      const existingRuntime = newRuntime.get(roomJid)
      if (existingRuntime) {
        newRuntime.set(roomJid, { ...existingRuntime, messages: newMessages })
      }

      const result: Partial<RoomState> = { rooms: newRooms, roomRuntime: newRuntime }
      const meta = state.roomMeta.get(roomJid)
      const wasLastMessage =
        !!meta?.lastMessage &&
        (meta.lastMessage.id === updatedMessage.id || meta.lastMessage.stanzaId === stanzaId)

      if (meta && wasLastMessage) {
        const newMeta = new Map(state.roomMeta)
        newMeta.set(roomJid, { ...meta, lastMessage: updatedMessage })
        result.roomMeta = newMeta
      }

      return result
    })
  },

  getMessage: (roomJid, messageId) => {
    const room = get().rooms.get(roomJid)
    if (!room) return undefined
    return findMessageById(room.messages, messageId)
  },

  getRoomLastTimestamp: (roomJid) => {
    const state = get()
    // Prefer roomMeta (frequently-updated); fall back to the combined rooms map
    // for backward compat with persist/tests.
    const lastMessage =
      state.roomMeta.get(roomJid)?.lastMessage ??
      state.rooms.get(roomJid)?.lastMessage
    return lastMessage?.timestamp?.getTime()
  },

  markAsRead: (roomJid) => {
    set((state) => {
      const existing = state.rooms.get(roomJid)
      if (!existing) return {}

      const meta = state.roomMeta.get(roomJid)
      const notifInput: notifState.EntityNotificationState = {
        unreadCount: meta?.unreadCount ?? existing.unreadCount,
        mentionsCount: meta?.mentionsCount ?? existing.mentionsCount,
        lastReadAt: meta?.lastReadAt ?? existing.lastReadAt,
        lastSeenMessageId: meta?.lastSeenMessageId ?? existing.lastSeenMessageId,
        firstNewMessageId: state.firstNewMessageMarkers.get(roomJid),
      }

      const runtime = state.roomRuntime.get(roomJid)
      const messages = runtime?.messages ?? existing.messages
      const lastMessage = messages[messages.length - 1]
      const lastMessageTimestamp = lastMessage?.timestamp

      // At the live edge the newest loaded message is the true newest and clearing
      // the badge means the user caught up — advance the read pointer so the
      // XEP-0490 publisher syncs the marker. Slid up into history we leave it put.
      const atLiveEdge = runtime?.windowAtLiveEdge !== false
      const advanceSeenTo = atLiveEdge ? lastMessage?.id : undefined

      const updated = notifState.onMarkAsRead(notifInput, lastMessageTimestamp, advanceSeenTo)

      // Skip update if no change
      if (updated === notifInput) return {}

      const newRooms = new Map(state.rooms)
      newRooms.set(roomJid, { ...existing, unreadCount: updated.unreadCount, mentionsCount: updated.mentionsCount, lastReadAt: updated.lastReadAt, lastSeenMessageId: updated.lastSeenMessageId })

      const newMeta = new Map(state.roomMeta)
      const newMetaEntry = {
        ...(meta ?? { unreadCount: 0, mentionsCount: 0, typingUsers: new Set<string>() }),
        unreadCount: updated.unreadCount,
        mentionsCount: updated.mentionsCount,
        lastReadAt: updated.lastReadAt,
        lastSeenMessageId: updated.lastSeenMessageId,
      }
      newMeta.set(roomJid, newMetaEntry)

      return { rooms: newRooms, roomMeta: newMeta }
    })
  },

  markReadToNewest: (roomJid) => {
    set((state) => {
      const existing = state.rooms.get(roomJid)
      if (!existing) return state

      const runtime = state.roomRuntime.get(roomJid)
      const resident = runtime?.messages?.length ? runtime.messages : existing.messages
      const newest = resident[resident.length - 1] ?? existing.lastMessage
      if (!newest) return state

      // Skip update if already fully read: pointer at the computed newest id,
      // no unread/mentions, and no "new messages" divider to clear.
      const meta = state.roomMeta.get(roomJid)
      const currentLastSeenMessageId = meta?.lastSeenMessageId ?? existing.lastSeenMessageId
      const currentUnreadCount = meta?.unreadCount ?? existing.unreadCount
      const currentMentionsCount = meta?.mentionsCount ?? existing.mentionsCount
      if (
        currentLastSeenMessageId === newest.id &&
        currentUnreadCount === 0 &&
        currentMentionsCount === 0 &&
        !state.firstNewMessageMarkers.has(roomJid)
      ) {
        return state
      }

      const read = {
        lastSeenMessageId: newest.id,
        unreadCount: 0,
        mentionsCount: 0,
        lastReadAt: newest.timestamp,
      }
      const committed = commitRoomUpdate(state, roomJid, read)
      if (!committed) return state

      const newMarkers = new Map(state.firstNewMessageMarkers)
      newMarkers.delete(roomJid)

      return { ...committed, firstNewMessageMarkers: newMarkers }
    })
  },

  markAllRoomsRead: () => {
    for (const room of get().joinedRooms()) {
      const meta = get().roomMeta.get(room.jid)
      const unread = (meta?.unreadCount ?? room.unreadCount ?? 0) + (meta?.mentionsCount ?? room.mentionsCount ?? 0)
      if (unread > 0) get().markReadToNewest(room.jid)
    }
  },

  setActiveRoom: (roomJid) => {
    const prevJid = get().activeRoomJid
    // Skip if already the active room (prevents duplicate side effects)
    if (roomJid === prevJid) return

    // Deactivate previous room: clear its "new messages" marker (if any) and
    // EVICT its message array from RAM. Only the active room keeps its messages
    // resident — the durable copy stays in IndexedDB and is rehydrated by
    // activateRoom on return. Entity / meta / lastMessage / occupants are kept,
    // so the sidebar preview and unread badge are unaffected. This bounds memory
    // (no longer every visited room holds up to getResidentWindowSize()) and shrinks
    // the DOM mounted on the next switch into a large room.
    if (prevJid && prevJid !== roomJid) {
      const hadMarker = get().firstNewMessageMarkers.has(prevJid)

      set((state) => {
        // Evict from the runtime mirror (messages live here).
        const newRuntime = new Map(state.roomRuntime)
        const prevRuntime = newRuntime.get(prevJid)
        if (prevRuntime && prevRuntime.messages.length > 0) {
          newRuntime.set(prevJid, { ...prevRuntime, messages: [] })
        }

        // Evict from the combined map mirror.
        const newRooms = new Map(state.rooms)
        const prevRoom = newRooms.get(prevJid)
        if (prevRoom) {
          newRooms.set(prevJid, { ...prevRoom, messages: [] })
        }

        const newMarkers = new Map(state.firstNewMessageMarkers)
        if (hadMarker) newMarkers.delete(prevJid)

        return { roomRuntime: newRuntime, rooms: newRooms, firstNewMessageMarkers: newMarkers }
      })
    }

    if (roomJid) {
      const room = get().rooms.get(roomJid)
      if (room) {
        const meta = get().roomMeta.get(roomJid)
        const notifInput: notifState.EntityNotificationState = {
          unreadCount: meta?.unreadCount ?? room.unreadCount,
          mentionsCount: meta?.mentionsCount ?? room.mentionsCount,
          lastReadAt: meta?.lastReadAt ?? room.lastReadAt,
          lastSeenMessageId: meta?.lastSeenMessageId ?? room.lastSeenMessageId,
          firstNewMessageId: get().firstNewMessageMarkers.get(roomJid),
        }

        const runtime = get().roomRuntime.get(roomJid)
        const messages = runtime?.messages ?? room.messages
        const activated = notifState.onActivate(notifInput, messages, { treatDelayedAsNew: true })

        // Determine lastInteractedAt for sidebar sorting
        const lastMessage = room.messages?.[room.messages.length - 1]
        const lastMessageTimestamp = room.lastMessage?.timestamp ?? lastMessage?.timestamp
        const newLastInteractedAt = lastMessageTimestamp ?? room.lastInteractedAt

        set((state) => {
          const newMetaEntry = {
            ...(meta ?? { unreadCount: 0, mentionsCount: 0, typingUsers: new Set<string>() }),
            unreadCount: activated.unreadCount,
            mentionsCount: activated.mentionsCount,
            lastReadAt: activated.lastReadAt,
            lastSeenMessageId: activated.lastSeenMessageId,
            lastInteractedAt: newLastInteractedAt,
          }
          const newMeta = new Map(state.roomMeta)
          newMeta.set(roomJid, newMetaEntry)
          const newRooms = new Map(state.rooms)
          newRooms.set(roomJid, {
            ...room,
            unreadCount: activated.unreadCount,
            mentionsCount: activated.mentionsCount,
            lastReadAt: activated.lastReadAt,
            lastSeenMessageId: activated.lastSeenMessageId,
            lastInteractedAt: newLastInteractedAt,
          })
          const newMarkers = new Map(state.firstNewMessageMarkers)
          if (activated.firstNewMessageId) newMarkers.set(roomJid, activated.firstNewMessageId)
          else newMarkers.delete(roomJid)
          return { roomMeta: newMeta, rooms: newRooms, activeRoomJid: roomJid, firstNewMessageMarkers: newMarkers }
        })
        return
      }
    }
    // Clearing active room or room not found
    set({ activeRoomJid: roomJid })
  },

  activateRoom: async (roomJid) => {
    const token = ++activationToken
    if (roomJid) {
      // Signal the hydration window so the UI can hold a neutral surface
      // instead of flashing the empty state while the cache read is in flight.
      set({ activationPending: true })
      await get().loadMessagesFromCache(roomJid, { limit: 100 })
      // A newer activation started while the cache read was in flight: it owns
      // the pending flag now, so bail without clearing it.
      if (token !== activationToken) return
      // XEP-0490: fold any pending remote read position into lastSeenMessageId
      // BEFORE setActiveRoom derives the new-message divider (parity with
      // chatStore.activateConversation). Forward-only against the loaded
      // messages, and applied only once per distinct RESOLVED marker this
      // session — a fold that stashed (message not loaded) stays retryable, a
      // resolved one is never re-folded (that would reposition the divider on
      // every return). Gate + retry policy live in shared/readMarkerSync.
      const foldOnce = (stage: string) => {
        const lastSeenBefore = get().roomMeta.get(roomJid)?.lastSeenMessageId
        const fold = foldPendingRemoteDisplayed(
          mdsGate,
          roomJid,
          () => get().roomMeta.get(roomJid)?.pendingRemoteDisplayedStanzaId,
          (stanzaId) => get().applyRemoteDisplayed(roomJid, stanzaId)
        )
        if (fold.attempted) {
          markerDebugLog(`activation fold (XEP-0490 pending → divider, ${stage})`, {
            roomJid,
            pendingStanzaId: fold.pending,
            lastSeenBefore,
            lastSeenAfter: get().roomMeta.get(roomJid)?.lastSeenMessageId,
            resolved: fold.resolved,
          })
        } else if (fold.pending) {
          markerDebugLog('activation fold SKIPPED (marker already resolved this session — PEP keeps it live)', {
            roomJid,
            pendingStanzaId: fold.pending,
          })
        }
      }
      foldOnce('latest slice')

      // Resume anchor: if the read pointer is deeper than the latest-100
      // slice, reload the window AROUND it (IndexedDB only) so the divider
      // derives inside the slice and the entry scroll can anchor on it. The
      // fold above ran first — it may have advanced the pointer to the synced
      // position. A cache miss keeps the latest slice; the divider then
      // degrades via the stale-pointer fallback (spec §5) and MAM catch-up
      // heals the cache for the next open.
      const pointer = get().roomMeta.get(roomJid)?.lastSeenMessageId
      if (pointer) {
        const loaded = get().roomRuntime.get(roomJid)?.messages ?? get().rooms.get(roomJid)?.messages ?? []
        if (!loaded.some((m) => m.id === pointer)) {
          await get().loadMessagesAroundFromCache(roomJid, pointer)
          if (token !== activationToken) return
          // The around-slice sits just past the stale pointer — exactly where a
          // marker too deep for the latest-100 window lives. Retry a fold that
          // stashed above so the divider derives from the synced position.
          foldOnce('around slice')
        }
      }
    }
    // Set active and clear pending atomically (same React commit) so the view
    // swaps straight from loading surface to content with no empty-state frame.
    get().setActiveRoom(roomJid)
    set({ activationPending: false })
  },

  getActiveRoomJid: () => get().activeRoomJid,

  clearFirstNewMessageId: (roomJid) => {
    set((state) => {
      if (!state.firstNewMessageMarkers.has(roomJid)) return state
      const newMarkers = new Map(state.firstNewMessageMarkers)
      newMarkers.delete(roomJid)
      return { firstNewMessageMarkers: newMarkers }
    })
  },

  resyncDividerToReadPointer: (roomJid) => {
    set((state) => {
      if (!state.firstNewMessageMarkers.has(roomJid)) return state
      const meta = state.roomMeta.get(roomJid)
      const existing = state.rooms.get(roomJid)
      if (!meta && !existing) return state
      const runtime = state.roomRuntime.get(roomJid)
      const messages = runtime?.messages ?? existing?.messages ?? []
      const lastSeenMessageId = meta?.lastSeenMessageId ?? existing?.lastSeenMessageId
      const lastReadAt = meta?.lastReadAt ?? existing?.lastReadAt

      const divider = notifState.onActivate(
        { unreadCount: 0, mentionsCount: 0, lastReadAt, lastSeenMessageId, firstNewMessageId: undefined },
        messages,
        { treatDelayedAsNew: true }
      ).firstNewMessageId

      // Only ever reposition the divider FORWARD to a real unread message. When there is no unread
      // after the pointer (divider undefined — reader is at the newest), do NOT clear it here: the
      // divider is deliberately kept alive after a FAB jump-to-present so the jump-to-last-read pill
      // can offer a return, and the explicit read-through / mark-read paths own clearing.
      if (!divider || divider === state.firstNewMessageMarkers.get(roomJid)) return state
      const newMarkers = new Map(state.firstNewMessageMarkers)
      newMarkers.set(roomJid, divider)
      return { firstNewMessageMarkers: newMarkers }
    })
  },

  updateLastSeenMessageId: (roomJid, messageId) => {
    set((state) => {
      const existing = state.rooms.get(roomJid)
      const meta = state.roomMeta.get(roomJid)
      if (!existing) return state

      const runtime = state.roomRuntime.get(roomJid)
      const messages = runtime?.messages ?? existing.messages

      const notifInput: notifState.EntityNotificationState = {
        unreadCount: meta?.unreadCount ?? existing.unreadCount,
        mentionsCount: meta?.mentionsCount ?? existing.mentionsCount,
        lastReadAt: meta?.lastReadAt ?? existing.lastReadAt,
        lastSeenMessageId: meta?.lastSeenMessageId ?? existing.lastSeenMessageId,
        firstNewMessageId: state.firstNewMessageMarkers.get(roomJid),
      }
      const atLiveEdge = state.roomRuntime.get(roomJid)?.windowAtLiveEdge !== false
      const updated = notifState.onMessageSeen(notifInput, messageId, messages, { atLiveEdge })
      if (updated === notifInput) return state

      const newRooms = new Map(state.rooms)
      newRooms.set(roomJid, { ...existing, lastSeenMessageId: updated.lastSeenMessageId })

      const newMeta = new Map(state.roomMeta)
      if (meta) {
        newMeta.set(roomJid, { ...meta, lastSeenMessageId: updated.lastSeenMessageId })
      }

      return { rooms: newRooms, roomMeta: newMeta }
    })
  },

  applyRemoteDisplayed: (roomJid, stanzaId, messagesOverride) => {
    // Set when the resolution advanced the pointer on a NON-active room —
    // triggers the exact cache recount below.
    let advancedNonActive = false
    set((state) => {
      const meta = state.roomMeta.get(roomJid)
      const existing = state.rooms.get(roomJid)
      if (!meta) return state

      const runtime = state.roomRuntime.get(roomJid)
      // A non-active room keeps no resident array (memory windowing), so
      // mergeRoomMAMMessages passes the just-merged array here; else read runtime/rooms.
      // The resolution state machine (stash / clear-pending / forward-only
      // advance / active-divider recompute) is shared — see shared/readMarkerSync.
      const messages = messagesOverride ?? runtime?.messages ?? existing?.messages ?? []
      const resolution = resolveRemoteDisplayed(
        {
          unreadCount: meta.unreadCount,
          mentionsCount: meta.mentionsCount,
          lastReadAt: meta.lastReadAt,
          lastSeenMessageId: meta.lastSeenMessageId,
          pendingRemoteDisplayedStanzaId: meta.pendingRemoteDisplayedStanzaId,
        },
        messages,
        state.firstNewMessageMarkers.get(roomJid),
        stanzaId,
        // Rooms treat delayed history the same as chats treat offline delivery
        // (unified divider semantics) — delayed messages after the pointer are new.
        { isActive: state.activeRoomJid === roomJid, treatDelayedAsNew: true }
      )
      if (resolution.kind === 'unchanged') return state

      const metaPatch =
        resolution.kind === 'stash-pending'
          ? { pendingRemoteDisplayedStanzaId: stanzaId }
          : resolution.kind === 'clear-pending'
            ? { pendingRemoteDisplayedStanzaId: undefined }
            : { lastSeenMessageId: resolution.lastSeenMessageId, pendingRemoteDisplayedStanzaId: undefined }

      const newMeta = new Map(state.roomMeta)
      newMeta.set(roomJid, { ...meta, ...metaPatch })

      // Inbound read-state sync (spec §4): a marker published by another client
      // clears this room's badge now, not on the next activation. 'advanced' is
      // exactly the non-active pointer-advance kind (the active room's counts
      // are already zero and resolves as 'advanced-with-divider'). Only the
      // counts are folded — the pointer keeps the forward-only position
      // resolved above (the helper's outgoing-boundary rule never regresses
      // it: the pointer resolves inside `messages`, so its internal scan only
      // ever looks past it).
      let recomputed: notifState.EntityNotificationState | undefined
      if (resolution.kind === 'advanced') {
        advancedNonActive = true
        recomputed = notifState.recomputeCountsFromPointer(
          {
            unreadCount: meta.unreadCount,
            mentionsCount: meta.mentionsCount,
            lastReadAt: meta.lastReadAt,
            lastSeenMessageId: resolution.lastSeenMessageId,
            firstNewMessageId: state.firstNewMessageMarkers.get(roomJid),
          },
          messages,
          { countMentions: true }
        )
        newMeta.set(roomJid, {
          ...newMeta.get(roomJid)!,
          unreadCount: recomputed.unreadCount,
          mentionsCount: recomputed.mentionsCount,
        })
      }

      // The divider is recomputed only for the active room; inactive rooms
      // recompute on their next activation.
      let newMarkers = state.firstNewMessageMarkers
      if (resolution.kind === 'advanced-with-divider') {
        newMarkers = new Map(state.firstNewMessageMarkers)
        if (resolution.firstNewMessageId) newMarkers.set(roomJid, resolution.firstNewMessageId)
        else newMarkers.delete(roomJid)
      }

      if (existing) {
        // Keep the combined map coherent with roomMeta.
        const newRooms = new Map(state.rooms)
        newRooms.set(roomJid, {
          ...existing,
          ...metaPatch,
          // Keep the combined map coherent with the recomputed roomMeta counts.
          ...(recomputed
            ? { unreadCount: recomputed.unreadCount, mentionsCount: recomputed.mentionsCount }
            : {}),
        })
        return { roomMeta: newMeta, rooms: newRooms, firstNewMessageMarkers: newMarkers }
      }
      return { roomMeta: newMeta, firstNewMessageMarkers: newMarkers }
    })

    // EXACT badge recount for a non-resident room: the sync recount above ran
    // over only the messages slice it was handed — for a non-resident room
    // that is just the final merged page (mergedForMarker), excluding the
    // fetch-latest page and earlier backward pages of the same pointer-stitch
    // walk (badge undercount: 60 unread → ~10). Re-count asynchronously over
    // the newest cached window, sized to everything one catch-up pass can
    // download. Runs from where the resolution lands so it also covers a
    // live-notify marker resolving against a partial resident slice.
    if (advancedNonActive) {
      void (async () => {
        try {
          const cached = await messageCache.getRoomMessages(roomJid, {
            limit: MAM_POINTER_RECOUNT_CACHE_LIMIT,
            latest: true,
          })
          if (cached.length === 0) return
          set((state) => {
            // Re-read state: the room may have become active while the cache
            // read was in flight — activation recomputes counts itself, and a
            // stale recount must not clobber it.
            if (state.activeRoomJid === roomJid) return state
            const meta = state.roomMeta.get(roomJid)
            if (!meta) return state
            const pointerState: notifState.EntityNotificationState = {
              unreadCount: meta.unreadCount,
              mentionsCount: meta.mentionsCount,
              lastReadAt: meta.lastReadAt,
              lastSeenMessageId: meta.lastSeenMessageId,
              firstNewMessageId: state.firstNewMessageMarkers.get(roomJid),
            }
            const exact = notifState.recomputeCountsFromPointer(pointerState, cached, { countMentions: true })
            if (exact === pointerState) return state
            const newMeta = new Map(state.roomMeta)
            newMeta.set(roomJid, {
              ...meta,
              unreadCount: exact.unreadCount,
              mentionsCount: exact.mentionsCount,
              lastSeenMessageId: exact.lastSeenMessageId,
            })
            const room = state.rooms.get(roomJid)
            if (!room) return { roomMeta: newMeta }
            const newRooms = new Map(state.rooms)
            newRooms.set(roomJid, {
              ...room,
              unreadCount: exact.unreadCount,
              mentionsCount: exact.mentionsCount,
              lastSeenMessageId: exact.lastSeenMessageId,
            })
            return { roomMeta: newMeta, rooms: newRooms }
          })
        } catch {
          // Cache read failed — keep the page-scoped count (an undercount,
          // corrected on the next merge/activation).
        }
      })()
    }
  },

  setTyping: (roomJid, nick, isTyping) => {
    if (isTyping) {
      // Set auto-clear timeout in case "paused" is missed
      setTypingTimeout(roomJid, nick, () => {
        // Auto-clear this user's typing state after timeout
        get().setTyping(roomJid, nick, false)
      })
    } else {
      // Clear the timeout when explicitly stopping
      clearTypingTimeout(roomJid, nick)
    }

    set((state) => {
      const newRooms = new Map(state.rooms)
      const existing = newRooms.get(roomJid)
      if (!existing) return state

      const newTypingUsers = new Set(existing.typingUsers)
      if (isTyping) {
        newTypingUsers.add(nick)
      } else {
        newTypingUsers.delete(nick)
      }
      newRooms.set(roomJid, { ...existing, typingUsers: newTypingUsers })

      // Update metadata
      const newMeta = new Map(state.roomMeta)
      const existingMeta = newMeta.get(roomJid)
      if (existingMeta) {
        newMeta.set(roomJid, { ...existingMeta, typingUsers: newTypingUsers })
      }

      return { rooms: newRooms, roomMeta: newMeta }
    })
  },

  // Bookmark actions
  setBookmark: (roomJid, bookmark) => {
    set((state) => {
      const newRooms = new Map(state.rooms)
      const newEntities = new Map(state.roomEntities)
      const newMeta = new Map(state.roomMeta)
      const newRuntime = new Map(state.roomRuntime)

      const existing = newRooms.get(roomJid)
      if (existing) {
        // Update existing room with bookmark info
        const updatedRoom = {
          ...existing,
          name: bookmark.name || existing.name,
          nickname: bookmark.nick || existing.nickname,
          isBookmarked: true,
          autojoin: bookmark.autojoin,
          password: bookmark.password,
          notifyAllPersistent: bookmark.notifyAll,
        }
        newRooms.set(roomJid, updatedRoom)

        // Update entity
        const existingEntity = newEntities.get(roomJid)
        if (existingEntity) {
          newEntities.set(roomJid, {
            ...existingEntity,
            name: bookmark.name || existingEntity.name,
            nickname: bookmark.nick || existingEntity.nickname,
            isBookmarked: true,
            autojoin: bookmark.autojoin,
            password: bookmark.password,
          })
        }

        // Update metadata (notifyAllPersistent)
        const existingMeta = newMeta.get(roomJid)
        if (existingMeta) {
          newMeta.set(roomJid, { ...existingMeta, notifyAllPersistent: bookmark.notifyAll })
        }
      } else {
        // Create a new room entry from bookmark
        const newRoom: Room = {
          jid: roomJid,
          name: bookmark.name,
          nickname: bookmark.nick,
          joined: false,
          isBookmarked: true,
          autojoin: bookmark.autojoin,
          password: bookmark.password,
          notifyAllPersistent: bookmark.notifyAll,
          occupants: new Map(),
          messages: [],
          windowAtLiveEdge: true,
          unreadCount: 0,
          mentionsCount: 0,
          typingUsers: new Set(),
        }
        newRooms.set(roomJid, newRoom)

        // Create entity
        newEntities.set(roomJid, {
          jid: roomJid,
          name: bookmark.name,
          nickname: bookmark.nick,
          joined: false,
          isBookmarked: true,
          autojoin: bookmark.autojoin,
          password: bookmark.password,
        })

        // Create metadata
        newMeta.set(roomJid, {
          unreadCount: 0,
          mentionsCount: 0,
          typingUsers: new Set(),
          notifyAllPersistent: bookmark.notifyAll,
        })

        // Create runtime
        newRuntime.set(roomJid, {
          occupants: new Map(),
          messages: [],
          windowAtLiveEdge: true,
        })
      }
      return { rooms: newRooms, roomEntities: newEntities, roomMeta: newMeta, roomRuntime: newRuntime }
    })
  },

  removeBookmark: (roomJid) => {
    set((state) => {
      const newRooms = new Map(state.rooms)
      const newEntities = new Map(state.roomEntities)
      const newMeta = new Map(state.roomMeta)
      const newRuntime = new Map(state.roomRuntime)

      const existing = newRooms.get(roomJid)
      if (existing) {
        if (existing.joined) {
          // Room is joined, just remove bookmark flag and persistent notify setting
          newRooms.set(roomJid, {
            ...existing,
            isBookmarked: false,
            autojoin: undefined,
            password: undefined,
            notifyAllPersistent: undefined,
          })

          // Update entity
          const existingEntity = newEntities.get(roomJid)
          if (existingEntity) {
            newEntities.set(roomJid, {
              ...existingEntity,
              isBookmarked: false,
              autojoin: undefined,
              password: undefined,
            })
          }

          // Update metadata
          const existingMeta = newMeta.get(roomJid)
          if (existingMeta) {
            newMeta.set(roomJid, { ...existingMeta, notifyAllPersistent: undefined })
          }
        } else {
          // Room not joined and no longer bookmarked, remove it
          newRooms.delete(roomJid)
          newEntities.delete(roomJid)
          newMeta.delete(roomJid)
          newRuntime.delete(roomJid)
        }
      }
      return { rooms: newRooms, roomEntities: newEntities, roomMeta: newMeta, roomRuntime: newRuntime }
    })
  },

  // Non-anonymous room acknowledgement (issue #37)
  acknowledgeNonAnonymousRoom: (roomJid) => {
    set((state) => {
      if (state.acknowledgedNonAnonymousRooms.has(roomJid)) return {}
      const acked = new Set(state.acknowledgedNonAnonymousRooms)
      acked.add(roomJid)
      saveNonAnonAckToStorage(acked)
      return { acknowledgedNonAnonymousRooms: acked }
    })
  },

  isNonAnonymousRoomAcknowledged: (roomJid) => get().acknowledgedNonAnonymousRooms?.has(roomJid) ?? false,

  // Notification settings
  setNotifyAll: (roomJid, notifyAll, persistent = false) => {
    set((state) => {
      const newRooms = new Map(state.rooms)
      const existing = newRooms.get(roomJid)
      if (!existing) return state

      newRooms.set(roomJid, {
        ...existing,
        notifyAll: persistent ? undefined : notifyAll, // Session-only if not persistent
        notifyAllPersistent: persistent ? notifyAll : existing.notifyAllPersistent,
      })

      // Update metadata
      const newMeta = new Map(state.roomMeta)
      const existingMeta = newMeta.get(roomJid)
      if (existingMeta) {
        newMeta.set(roomJid, {
          ...existingMeta,
          notifyAll: persistent ? undefined : notifyAll,
          notifyAllPersistent: persistent ? notifyAll : existingMeta.notifyAllPersistent,
        })
      }

      return { rooms: newRooms, roomMeta: newMeta }
    })
  },

  // Easter egg animations
  triggerAnimation: (roomJid, animation, senderName) => {
    set({ activeAnimation: { roomJid, animation, senderName } })
  },

  clearAnimation: () => {
    set({ activeAnimation: null })
  },

  setTargetMessageId: (id) => {
    set({ targetMessageId: id })
  },

  // Draft management (persisted to localStorage)
  setDraft: (roomJid, text) => {
    set((state) => {
      const newDrafts = draftState.setDraft(state.drafts, roomJid, text)
      saveDraftsToStorage(newDrafts)
      return { drafts: newDrafts }
    })
  },

  getDraft: (roomJid) => {
    return draftState.getDraft(get().drafts, roomJid)
  },

  clearDraft: (roomJid) => {
    set((state) => {
      const newDrafts = draftState.clearDraft(state.drafts, roomJid)
      saveDraftsToStorage(newDrafts)
      return { drafts: newDrafts }
    })
  },

  // Poll vote tracking
  recordPollVote: (roomJid, messageId) => {
    set((state) => {
      const newVotedPolls = new Map(state.votedPollIds)
      const roomSet = new Set(newVotedPolls.get(roomJid) ?? [])
      roomSet.add(messageId)
      newVotedPolls.set(roomJid, roomSet)
      saveVotedPollsToStorage(newVotedPolls)
      return { votedPollIds: newVotedPolls }
    })
  },

  removePollVote: (roomJid, messageId) => {
    set((state) => {
      const newVotedPolls = new Map(state.votedPollIds)
      const existing = newVotedPolls.get(roomJid)
      if (!existing?.has(messageId)) return state
      const roomSet = new Set(existing)
      roomSet.delete(messageId)
      if (roomSet.size === 0) {
        newVotedPolls.delete(roomJid)
      } else {
        newVotedPolls.set(roomJid, roomSet)
      }
      saveVotedPollsToStorage(newVotedPolls)
      return { votedPollIds: newVotedPolls }
    })
  },

  getVotedPollIds: (roomJid) => {
    return get().votedPollIds.get(roomJid) ?? EMPTY_SET
  },

  dismissPoll: (roomJid, messageId) => {
    set((state) => {
      const newDismissed = new Map(state.dismissedPollIds)
      const roomSet = new Set(newDismissed.get(roomJid) ?? [])
      roomSet.add(messageId)
      newDismissed.set(roomJid, roomSet)
      saveDismissedPollsToStorage(newDismissed)
      return { dismissedPollIds: newDismissed }
    })
  },

  getDismissedPollIds: (roomJid) => {
    return get().dismissedPollIds.get(roomJid) ?? EMPTY_SET
  },

  // IndexedDB cache loading
  // For initial load (no 'before'), loads the LATEST 100 messages to show most recent first
  loadMessagesFromCache: async (roomJid, options = {}) => {
    if (!messageCache.isMessageCacheAvailable()) {
      return []
    }

    try {
      // Default to 100 messages and latest=true for initial load
      const queryOptions = {
        limit: options.limit ?? 100,
        before: options.before,
        after: options.after,
        // When loading without 'before', get the latest messages (most recent).
        // `oldest` opts out: ascending oldest-N (the true cache bottom).
        latest: !options.before && !options.oldest,
      }
      const cachedMessages = await messageCache.getRoomMessages(roomJid, queryOptions)
      // `peek`: a pure read that returns the messages WITHOUT pulling them into the
      // store. Used to compute a catch-up cursor for a non-active room without
      // breaking the invariant that only the active room is resident in RAM.
      // `oldest` is always a pure read too: the cache bottom must never become
      // the resident window (that would tear the UI off the live edge).
      if (!options.peek && !options.oldest && cachedMessages.length > 0) {
        // A latest-N load (no `before` cursor) makes the newest window resident — this
        // is the activation / recenter path, so the window is back at the live edge.
        // A `before`-anchored load (deep scroll-back restore) is NOT the live edge.
        const recenter = queryOptions.latest
        // Merge with existing messages in memory using the shared helper
        set((state) => {
          const update = mergeCachedRoomMessages(state, roomJid, cachedMessages)
          if (!recenter) return update ?? state
          // Recenter: force the flag true (even when the merge was a no-op because the
          // newest window was already resident).
          const baseRuntime = update?.roomRuntime ?? state.roomRuntime
          const runtime = baseRuntime.get(roomJid)
          if (!runtime) return update ?? state
          const newRuntime = new Map(baseRuntime)
          newRuntime.set(roomJid, { ...runtime, windowAtLiveEdge: true })
          return { ...(update ?? {}), roomRuntime: newRuntime }
        })
      }
      return cachedMessages
    } catch (error) {
      console.error('Failed to load room messages from IndexedDB:', error)
      return []
    }
  },

  loadMessagesAroundFromCache: async (roomJid, anchorMessageId, options = {}) => {
    if (!messageCache.isMessageCacheAvailable()) {
      return []
    }

    try {
      const slice = await messageCache.getRoomMessagesAround(roomJid, anchorMessageId, options)
      if (slice.length > 0) {
        set((state) => mergeCachedRoomMessages(state, roomJid, slice) ?? state)
      }
      return slice
    } catch (error) {
      console.error('Failed to load room messages around anchor from IndexedDB:', error)
      return []
    }
  },

  loadOlderMessagesFromCache: async (roomJid, limit = 50) => {
    if (!messageCache.isMessageCacheAvailable()) {
      return []
    }

    try {
      const room = get().rooms.get(roomJid)
      if (!room || room.messages.length === 0) {
        return []
      }

      // Get the oldest message timestamp we have in memory
      const oldestInMemory = room.messages[0]
      const beforeDate = oldestInMemory.timestamp

      // Load older messages from IndexedDB
      const cachedMessages = await messageCache.getRoomMessages(roomJid, {
        before: beforeDate,
        limit,
      })

      if (cachedMessages.length > 0) {
        // Prepend to existing messages via the shared timeline machine
        set((state) => {
          const newRooms = new Map(state.rooms)
          const existing = newRooms.get(roomJid)
          if (!existing) return state

          // Dedupe (in-memory messages take precedence), sort, keep-oldest trim
          // (load-older slides the window so scroll-back past the bound works).
          // If keep-oldest evicted the newest resident message, the window has
          // slid off the live edge → gate live appends in addMessage.
          const { merged, newestEvicted } = timeline.loadOlderSlice(
            existing.messages,
            cachedMessages,
            roomTimelineConfig()
          )

          newRooms.set(roomJid, { ...existing, messages: merged })

          // Update runtime
          const newRuntime = new Map(state.roomRuntime)
          const existingRuntime = newRuntime.get(roomJid)
          if (existingRuntime) {
            newRuntime.set(roomJid, {
              ...existingRuntime,
              messages: merged,
              ...(newestEvicted ? { windowAtLiveEdge: false } : {}),
            })
          }

          return { rooms: newRooms, roomRuntime: newRuntime }
        })
      }

      return cachedMessages
    } catch (error) {
      console.error('Failed to load older room messages from IndexedDB:', error)
      return []
    }
  },

  loadNewerMessagesFromCache: async (roomJid, limit = 50) => {
    if (!messageCache.isMessageCacheAvailable()) {
      return []
    }

    try {
      const room = get().rooms.get(roomJid)
      if (!room || room.messages.length === 0) {
        return []
      }

      // Get the newest message timestamp we have in memory
      const newestInMemory = room.messages[room.messages.length - 1]
      const afterDate = newestInMemory.timestamp

      // Load newer messages from IndexedDB
      const cachedMessages = await messageCache.getRoomMessages(roomJid, {
        after: afterDate,
        limit,
      })

      // Fewer than the requested limit came back ⇒ nothing more newer remains in the
      // cache, so the window has reached the tail (live edge) regardless of whether the
      // batch was empty or partial.
      const reachedTail = cachedMessages.length < limit

      if (cachedMessages.length > 0) {
        // Append to existing messages via the shared timeline machine
        set((state) => {
          const newRooms = new Map(state.rooms)
          const existing = newRooms.get(roomJid)
          if (!existing) return state

          // Dedupe (in-memory messages take precedence), sort, keep-newest trim
          // (load-newer slides the window back down toward the live edge).
          const { merged } = timeline.loadNewerSlice(
            existing.messages,
            cachedMessages,
            roomTimelineConfig()
          )

          newRooms.set(roomJid, { ...existing, messages: merged })

          // Update runtime
          const newRuntime = new Map(state.roomRuntime)
          const existingRuntime = newRuntime.get(roomJid)
          if (existingRuntime) {
            newRuntime.set(roomJid, {
              ...existingRuntime,
              messages: merged,
              ...(reachedTail ? { windowAtLiveEdge: true } : {}),
            })
          }

          return { rooms: newRooms, roomRuntime: newRuntime }
        })
      } else if (reachedTail) {
        // Empty batch: still need to flip the flag if the room isn't already at the edge.
        set((state) => {
          const existingRuntime = state.roomRuntime.get(roomJid)
          if (!existingRuntime || existingRuntime.windowAtLiveEdge !== false) return state
          const newRuntime = new Map(state.roomRuntime)
          newRuntime.set(roomJid, { ...existingRuntime, windowAtLiveEdge: true })
          return { roomRuntime: newRuntime }
        })
      }

      return cachedMessages
    } catch (error) {
      console.error('Failed to load newer room messages from IndexedDB:', error)
      return []
    }
  },

  recenterToLatest: async (roomJid) => {
    await get().loadMessagesFromCache(roomJid, { limit: getResidentWindowSize() })
    // loadMessagesFromCache's latest-N path (no `before`) already sets the flag true when
    // the merge changed the resident array. Force it true here too so a jump-to-latest is
    // unambiguously at the live edge even when the cache had nothing new to merge (the
    // newest window was already fully resident).
    set((state) => {
      const existingRuntime = state.roomRuntime.get(roomJid)
      if (!existingRuntime || existingRuntime.windowAtLiveEdge === true) return state
      const newRuntime = new Map(state.roomRuntime)
      newRuntime.set(roomJid, { ...existingRuntime, windowAtLiveEdge: true })
      return { roomRuntime: newRuntime }
    })
  },

  // Load the latest non-ignored message from cache for sidebar preview
  // This doesn't modify the messages array - it only updates lastMessage
  loadPreviewFromCache: async (roomJid) => {
    if (!messageCache.isMessageCacheAvailable()) {
      return null
    }

    // Check if room exists first - no point querying cache for non-existent rooms
    const room = get().rooms.get(roomJid)
    if (!room) {
      return null
    }

    try {
      // Fetch a small batch so we can skip ignored users' messages
      const cachedMessages = await messageCache.getRoomMessages(roomJid, {
        limit: 10,
        latest: true,
      })

      if (cachedMessages.length > 0) {
        const latestMessage = findLastNonIgnoredMessage(cachedMessages, roomJid, room.nickToJidCache)
        if (!latestMessage) return null

        // Update only lastMessage in metadata and combined room
        set((state) => {
          const room = state.rooms.get(roomJid)
          const meta = state.roomMeta.get(roomJid)
          if (!room || !meta) return state

          // Only update if we don't already have a lastMessage or if cached is newer
          if (!shouldUpdateLastMessage(meta.lastMessage, latestMessage)) return state

          const newMeta = new Map(state.roomMeta)
          newMeta.set(roomJid, { ...meta, lastMessage: latestMessage })

          const newRooms = new Map(state.rooms)
          newRooms.set(roomJid, { ...room, lastMessage: latestMessage })

          return { roomMeta: newMeta, rooms: newRooms }
        })

        return latestMessage
      }

      return null
    } catch (error) {
      console.error('Failed to load room preview from IndexedDB:', error)
      return null
    }
  },

  // Batched sidebar-preview hydration from the durable cache (see interface doc).
  // Reads every bookmarked/joined room's newest cached message in parallel, then
  // applies all previews in ONE set() so the sidebar re-sorts exactly once.
  hydratePreviewsFromCache: async () => {
    if (!messageCache.isMessageCacheAvailable()) return

    // Snapshot the rooms the sidebar actually orders (bookmarked or joined).
    const rooms = Array.from(get().rooms.values()).filter((r) => r.isBookmarked || r.joined)
    if (rooms.length === 0) return

    // Read caches in parallel (IndexedDB reads are cheap and non-blocking).
    const previews = await Promise.all(
      rooms.map(async (room) => {
        try {
          const cachedMessages = await messageCache.getRoomMessages(room.jid, { limit: 10, latest: true })
          if (cachedMessages.length === 0) return null
          const latest = findLastNonIgnoredMessage(cachedMessages, room.jid, room.nickToJidCache)
          return latest ? { roomJid: room.jid, latest } : null
        } catch {
          // Best-effort per room - one room's cache failure shouldn't block others.
          return null
        }
      })
    )

    const updates = previews.filter((p): p is { roomJid: string; latest: RoomMessage } => p !== null)
    if (updates.length === 0) return

    // Apply every preview in a single write. shouldUpdateLastMessage guards against
    // clobbering a fresher preview that a join/catch-up may have set in the meantime.
    set((state) => {
      const newMeta = new Map(state.roomMeta)
      const newRooms = new Map(state.rooms)
      let changed = false
      for (const { roomJid, latest } of updates) {
        const room = state.rooms.get(roomJid)
        const meta = state.roomMeta.get(roomJid)
        if (!room || !meta) continue
        if (!shouldUpdateLastMessage(meta.lastMessage, latest)) continue
        newMeta.set(roomJid, { ...meta, lastMessage: latest })
        newRooms.set(roomJid, { ...room, lastMessage: latest })
        changed = true
      }
      if (!changed) return state
      return { roomMeta: newMeta, rooms: newRooms }
    })
  },

  // MAM state management (XEP-0313 for MUC rooms)
  setRoomMAMLoading: (roomJid, isLoading) => {
    set((state) => ({
      mamQueryStates: mamState.setMAMLoading(state.mamQueryStates, roomJid, isLoading),
    }))
  },

  setRoomMAMError: (roomJid, error) => {
    set((state) => ({
      mamQueryStates: mamState.setMAMError(state.mamQueryStates, roomJid, error),
    }))
  },

  mergeRoomMAMMessages: (roomJid, mamMessages, rsm, complete, direction, preserveGapMarker = false, isFetchLatest = false, extras = undefined) => {
    // Newest persisted timestamp (entity preview) — the seam-formation fallback
    // when the resident array is empty this run (fresh session, history on disk).
    const fallbackHeldTs = get().getRoomLastTimestamp(roomJid)
    // Captured from inside set() so the post-set MDS marker resolution can read the
    // merged array even for a non-active room (whose array isn't resident).
    let mergedForMarker: RoomMessage[] = []
    set((state) => {
      const room = state.rooms.get(roomJid)
      if (!room) return state

      // Get existing messages for this room
      const existingMessages = room.messages || []

      // Shared timeline machine: archive-id backfill onto resident messages
      // (so an outgoing reflection gains its MAM cursor — was a chat-only
      // behavior before the extraction), direction-aware merge (backward =
      // optimized prepend + keep-oldest, forward = full sort + keep-newest),
      // dedupe, and eviction reporting.
      const { merged, newMessages: newFromMAM, patched, newestEvicted } = timeline.mergeArchive(
        existingMessages,
        mamMessages,
        direction,
        roomTimelineConfig(),
        isFetchLatest
      )
      // Persist backfilled archive ids so pagination cursors survive a reload.
      for (const p of patched) {
        void messageCache.updateRoomMessage(p.id, { stanzaId: p.stanzaId!, ...(p.originId ? { originId: p.originId } : {}) })
      }
      mergedForMarker = merged

      // Compute the newest fetched timestamp for gap marker positioning.
      // When a forward catch-up ends incomplete, this marks where the gap starts.
      const newestFetchedTimestamp = mamState.computeNewestFetchedTimestamp(mamMessages, direction)

      // Update MAM query state using the two-marker approach
      // This must always be updated to track query completion and cursors
      let newStates = mamState.setMAMQueryCompleted(
        state.mamQueryStates,
        roomJid,
        complete,
        direction,
        rsm.first, // Pagination cursor for fetching older messages
        newestFetchedTimestamp,
        preserveGapMarker,
        isFetchLatest
      )

      // Newest PROVEN in-memory boundary (resident extent). Undefined when the
      // resident array is empty (background/non-active room, fresh session).
      const residentNewestTs = messagePageExtent(existingMessages).newestTs

      // Persisted gap sync (shared transition, both directions):
      // - forward: mirror the complete=false-driven forwardGapTimestamp (marker
      //   survives a reload);
      // - backward: close/shrink a recorded gap when a scroll-up page reaches
      //   into or across it, or plant a seam when a `before:''` fetch-latest
      //   page lands disjoint above held history (formation).
      const newGaps = syncGapAfterArchiveMerge({
        gaps: state.roomGaps,
        id: roomJid,
        direction,
        complete,
        forwardGapTimestamp: newStates.get(roomJid)?.forwardGapTimestamp,
        merged,
        fetched: mamMessages,
        newMessagesCount: newFromMAM.length,
        patchedCount: patched.length,
        isFetchLatest,
        // ONLY a proven boundary (resident extent) anchors a seam — never the
        // preview timestamp, which may be an unarchived message (noLocalStore/
        // tombstone) above the true archive newest and would plant a spurious
        // seam. When the resident array is empty there is no proven boundary:
        // detectFetchLatestSeam returns undefined and coverageBottomUnproven is
        // flagged below instead (finding 10).
        newestHeldBelowTs: residentNewestTs,
        newestHeldBelowId: newestMessageStanzaId(existingMessages),
        lastFetchedArchiveId: rsm.last,
        preserveGapMarker,
      })

      // Coverage-bottom proof (finding 10). A merge proves the contiguous bottom
      // when a resident boundary exists OR a recorded gap now carries a proven
      // upper edge (endId) — clear any stale unproven flag. Otherwise, when a
      // disjoint fetch-latest lands above held-below history (proven by the
      // preview) with no seam formed, the bottom is unproven — flag it so the
      // catch-up seeder won't trust cache-oldest as contiguous-to-live.
      const coverageProven = residentNewestTs !== undefined || newGaps.get(roomJid)?.endId !== undefined
      if (coverageProven) {
        newStates = mamState.setCoverageBottomUnproven(newStates, roomJid, false)
      } else if (direction === 'backward' && isFetchLatest && !newGaps.has(roomJid)) {
        const structurallyDisjoint = newFromMAM.length === mamMessages.length && patched.length === 0
        const pageOldestTs = messagePageExtent(mamMessages).oldestTs
        const previewBelow = fallbackHeldTs !== undefined && pageOldestTs !== undefined && pageOldestTs > fallbackHeldTs
        if (structurallyDisjoint && previewBelow) {
          newStates = mamState.setCoverageBottomUnproven(newStates, roomJid, true)
        }
      }
      // Crash-window safety (Codex r3 #1/#2): the gap map is persisted
      // synchronously (localStorage) while saveRoomMessages to IndexedDB is
      // fire-and-forget AND absorbs errors. Persisting a transition that
      // SHRINKS the recorded hole (deletion, forward startId advance,
      // backward end/endId shrink) before the page write commits lets a
      // crash — or a silently failed write — skip the page forever: the
      // resume cursor would point past data that was never stored. So ANY
      // transition of an EXISTING gap defers until the durable write reports
      // success. Formation (prevGap undefined) records a hole — conservative
      // — and applies immediately. A merge with nothing persistable has no
      // crash window and applies immediately.
      const prevGap = state.roomGaps.get(roomJid)
      const persistableMessages = newFromMAM.filter(msg => !isNoLocalStore(msg))
      const deferGapCommit =
        newGaps !== state.roomGaps &&
        prevGap !== undefined &&
        persistableMessages.length > 0
      const gapsAfterMerge = deferGapCommit ? state.roomGaps : newGaps
      if (gapsAfterMerge !== state.roomGaps) saveGapsToStorage(gapsAfterMerge)

      // Persisted coverage record (Codex r3 #3/#4) — positive durable twin of
      // the gap machinery; see mamCoverage.ts. Advancing the bottom past a
      // page with persistable messages must wait for the durable commit: the
      // record must never point past unstored data. A merge with nothing
      // persistable (signal-only give-up) applies now.
      const newCoverage = syncCoverageAfterArchiveMerge({
        coverage: state.roomCoverage,
        id: roomJid,
        direction,
        isFetchLatest,
        preserveGapMarker,
        rsmFirst: rsm.first,
        fetchLatestTopId: extras?.fetchLatestTopId,
        initialBefore: extras?.initialBefore,
        connectedToHeld: newFromMAM.length < mamMessages.length || patched.length > 0,
      })
      const prevCoverage = state.roomCoverage.get(roomJid)
      const deferCoverageCommit =
        newCoverage !== state.roomCoverage &&
        persistableMessages.length > 0
      const coverageAfterMerge = deferCoverageCommit ? state.roomCoverage : newCoverage
      if (coverageAfterMerge !== state.roomCoverage) saveCoverageToStorage(coverageAfterMerge)

      // If no new messages (all duplicates), only update MAM state - skip room messages
      // This prevents unnecessary re-renders when merging duplicates.
      // Exception: a stanzaId backfill onto existing RAM messages must persist —
      // but only for the ACTIVE room (non-active rooms keep no resident array).
      if (newFromMAM.length === 0) {
        if (patched.length === 0 || state.activeRoomJid !== roomJid) {
          return { mamQueryStates: newStates, roomGaps: gapsAfterMerge, roomCoverage: coverageAfterMerge }
        }
        const backfilledRooms = new Map(state.rooms)
        backfilledRooms.set(roomJid, { ...room, messages: merged })
        const backfilledRuntime = new Map(state.roomRuntime)
        const runtimeEntry = backfilledRuntime.get(roomJid)
        if (runtimeEntry) {
          backfilledRuntime.set(roomJid, { ...runtimeEntry, messages: merged })
        }
        return { rooms: backfilledRooms, roomRuntime: backfilledRuntime, mamQueryStates: newStates, roomGaps: gapsAfterMerge, roomCoverage: coverageAfterMerge }
      }

      // Persist to IndexedDB regardless of active state — this is the durable
      // history that rehydrates on open (search index too).
      if (persistableMessages.length > 0) {
        const savePromise = messageCache.saveRoomMessages(persistableMessages)
        if (deferGapCommit || deferCoverageCommit) {
          // The page is durably cached — now the transitions are safe.
          void savePromise.then((committed) => {
            if (!committed) return
            set((s) => {
              // State may have moved on (a later merge advanced or re-planted
              // the gap/record): only transition the exact value this merge
              // computed from. Reference equality suffices — every transition
              // creates a new object. A lost race leaves a LAGGING
              // (conservative) cursor, never a skipping one.
              const out: Partial<RoomState> = {}
              if (deferGapCommit && s.roomGaps.get(roomJid) === prevGap) {
                const next = new Map(s.roomGaps)
                const target = newGaps.get(roomJid)
                if (target) next.set(roomJid, target)
                else next.delete(roomJid)
                saveGapsToStorage(next)
                out.roomGaps = next
              }
              if (deferCoverageCommit && s.roomCoverage.get(roomJid) === prevCoverage) {
                const target = newCoverage.get(roomJid)
                if (target) {
                  const next = new Map(s.roomCoverage)
                  next.set(roomJid, target)
                  saveCoverageToStorage(next)
                  out.roomCoverage = next
                }
              }
              return Object.keys(out).length > 0 ? out : s
            })
          })
        } else {
          void savePromise
        }
        searchIndex.indexMessages(persistableMessages).catch((e) => console.warn('[searchIndex] indexMessages failed:', e))
      }

      // Sidebar preview via the shared policy: only replace when the merged set's
      // newest non-ignored message genuinely supersedes the current preview (a
      // backward merge whose keep-oldest trim evicted the newest tail must not
      // regress the sidebar) or heals its encrypted fallback after a deferred decrypt.
      const { lastMessage } = derivePreviewAfterMerge(room.lastMessage, merged, (msgs) =>
        findLastNonIgnoredMessage(msgs, roomJid, room.nickToJidCache)
      )

      const newMeta = new Map(state.roomMeta)
      const existingMeta = newMeta.get(roomJid)
      if (existingMeta) {
        newMeta.set(roomJid, { ...existingMeta, lastMessage })
      }

      // NON-ACTIVE room (background catch-up): the messages are now durable in
      // IndexedDB and the preview / gap / cursor are updated — but we do NOT
      // populate the resident array. Only the active room is kept in RAM, so a
      // reconnect's forward catch-up can't refill a backgrounded room toward the
      // cap (the switch-mount freeze). It rehydrates from cache on open.
      if (state.activeRoomJid !== roomJid) {
        const newRooms = new Map(state.rooms)
        newRooms.set(roomJid, { ...room, lastMessage })

        // Badge hydration (spec §1): a forward merge extends contiguous
        // history past the read pointer — recompute unread/mention counts so
        // an unopened room regains its badge after catch-up. Backward merges
        // only prepend older history (nothing after the pointer changes).
        // The live path (addMessage/onMessageReceived) keeps owning
        // incremental counting; this reconciles bulk archive delivery.
        if (direction === 'forward' && existingMeta) {
          const recomputed = notifState.recomputeCountsFromPointer(
            {
              unreadCount: existingMeta.unreadCount,
              mentionsCount: existingMeta.mentionsCount,
              lastReadAt: existingMeta.lastReadAt,
              lastSeenMessageId: existingMeta.lastSeenMessageId,
              firstNewMessageId: state.firstNewMessageMarkers.get(roomJid),
            },
            mergedForMarker,
            { countMentions: true }
          )
          newMeta.set(roomJid, {
            ...newMeta.get(roomJid)!,
            unreadCount: recomputed.unreadCount,
            mentionsCount: recomputed.mentionsCount,
            lastSeenMessageId: recomputed.lastSeenMessageId,
          })
          newRooms.set(roomJid, {
            ...newRooms.get(roomJid)!,
            unreadCount: recomputed.unreadCount,
            mentionsCount: recomputed.mentionsCount,
            lastSeenMessageId: recomputed.lastSeenMessageId,
          })
        }

        // roomRuntime deliberately untouched.
        return { rooms: newRooms, roomMeta: newMeta, mamQueryStates: newStates, roomGaps: gapsAfterMerge }
      }

      // ACTIVE room: populate the resident array (foreground catch-up / scroll-up).
      const newRooms = new Map(state.rooms)
      newRooms.set(roomJid, { ...room, messages: merged, lastMessage })

      // A backward (scroll-up) merge uses keep-oldest and can evict the newest tail
      // (newestEvicted from the timeline machine), sliding the window off the live
      // edge (same gate as loadOlderMessagesFromCache). Forward catch-up keeps the
      // newest, so it never slides. Fetch-latest lands the window AT the live edge
      // by construction.
      // Accepted edge case: a fresh-session bail fetch-latest while the user
      // is deep-scrolled in THIS active room can evict resident messages via
      // keep-newest and jump the window to live — same class as
      // jump-to-latest. The content-anchor scroll restore then degrades to an
      // estimate rather than an exact reposition.
      const newRuntime = new Map(state.roomRuntime)
      const existingRuntime = newRuntime.get(roomJid)
      if (existingRuntime) {
        newRuntime.set(roomJid, {
          ...existingRuntime,
          messages: merged,
          ...(newestEvicted
            ? { windowAtLiveEdge: false }
            : isFetchLatest && newFromMAM.length > 0
              ? { windowAtLiveEdge: true }
              : {}),
        })
      }

      return { rooms: newRooms, roomRuntime: newRuntime, roomMeta: newMeta, mamQueryStates: newStates, roomGaps: gapsAfterMerge }
    })

    // XEP-0490: a remote room marker may have arrived before its message.
    // Now that messages are merged, try to resolve it forward-only.
    const pending = get().roomMeta.get(roomJid)?.pendingRemoteDisplayedStanzaId
    if (pending) {
      get().applyRemoteDisplayed(roomJid, pending, mergedForMarker)
    }
  },

  clearRoomGapAnchor: (roomJid, purgedStartId) => {
    set((state) => {
      const gap = state.roomGaps.get(roomJid)
      if (!gap || gap.startId !== purgedStartId) return state
      const newGaps = new Map(state.roomGaps)
      const { startId: _purged, ...withoutAnchor } = gap
      newGaps.set(roomJid, withoutAnchor)
      saveGapsToStorage(newGaps)
      return { roomGaps: newGaps }
    })
  },

  getRoomCoverage: (roomJid) => get().roomCoverage.get(roomJid),

  clearRoomCoverage: (roomJid, ifBottomId) => {
    set((state) => {
      const existing = state.roomCoverage.get(roomJid)
      if (!existing) return state
      if (ifBottomId !== undefined && existing.bottomId !== ifBottomId) return state
      const next = new Map(state.roomCoverage)
      next.delete(roomJid)
      saveCoverageToStorage(next)
      return { roomCoverage: next }
    })
  },

  getRoomMAMQueryState: (roomJid) => {
    return mamState.getMAMQueryState(get().mamQueryStates, roomJid)
  },

  resetRoomMAMStates: () => {
    set({ mamQueryStates: new Map() })
  },

  /**
   * Update only the lastMessage preview for a room without affecting message history.
   * Used by MAM preview refresh to update sidebar displays.
   */
  updateLastMessagePreview: (roomJid, lastMessage) => {
    set((state) => {
      const room = state.rooms.get(roomJid)
      const meta = state.roomMeta.get(roomJid)
      if (!room || !meta) return state

      // Skip messages from ignored users
      const ignoredUsers = ignoreStore.getState().getIgnoredForRoom(roomJid)
      if (isMessageFromIgnoredUser(ignoredUsers, lastMessage, room.nickToJidCache)) return state

      // Never let a bodiless signal placeholder (e.g. an encrypted reaction
      // replayed from MAM before its key was available) become the sidebar
      // preview — parity with chatStore.updateLastMessagePreview (#524).
      if (!isPreviewableMessage(lastMessage)) return state

      // Update if newer, OR if the existing preview is itself a stuck
      // non-previewable placeholder that a real message should heal.
      if (!shouldReplaceLastMessage(meta.lastMessage, lastMessage)) return state

      // Update metadata map
      const newMeta = new Map(state.roomMeta)
      newMeta.set(roomJid, { ...meta, lastMessage })

      // Update combined map for backward compatibility
      const newRooms = new Map(state.rooms)
      newRooms.set(roomJid, { ...room, lastMessage })

      return { roomMeta: newMeta, rooms: newRooms }
    })
  },

  // Computed
  // Note: These return stable references (EMPTY_*_ARRAY) when empty to prevent infinite re-renders
  joinedRooms: () => {
    const rooms = get().rooms
    if (rooms === _cachedJoinedRoomsSource) return _cachedJoinedRooms
    _cachedJoinedRoomsSource = rooms
    const result = Array.from(rooms.values()).filter(r => r.joined)
    _cachedJoinedRooms = result.length > 0 ? result : EMPTY_ROOM_ARRAY
    return _cachedJoinedRooms
  },

  bookmarkedRooms: () => {
    const rooms = get().rooms
    if (rooms === _cachedBookmarkedRoomsSource) return _cachedBookmarkedRooms
    _cachedBookmarkedRoomsSource = rooms
    const result = Array.from(rooms.values()).filter(r => r.isBookmarked)
    _cachedBookmarkedRooms = result.length > 0 ? result : EMPTY_ROOM_ARRAY
    return _cachedBookmarkedRooms
  },

  allRooms: () => {
    const rooms = get().rooms
    if (rooms === _cachedAllRoomsSource) return _cachedAllRooms
    _cachedAllRoomsSource = rooms
    // Return all rooms that are either bookmarked or joined
    const result = Array.from(rooms.values()).filter(r => r.isBookmarked || r.joined)
    if (result.length === 0) {
      _cachedAllRooms = EMPTY_ROOM_ARRAY
      return EMPTY_ROOM_ARRAY
    }

    // Sort by lastInteractedAt descending (most recent first)
    // For non-muted rooms, this updates on every new message (like 1:1 conversations)
    // For muted rooms, this only updates when the user explicitly opens the room
    result.sort((a, b) => {
      // Use lastInteractedAt if available, fall back to lastMessage timestamp, then creation/join time
      const aTime = a.lastInteractedAt?.getTime() ?? a.lastMessage?.timestamp?.getTime() ?? 0
      const bTime = b.lastInteractedAt?.getTime() ?? b.lastMessage?.timestamp?.getTime() ?? 0
      return bTime - aTime // Descending (most recent first)
    })
    _cachedAllRooms = result
    return result
  },

  roomSidebarJids: () => {
    const all = get().allRooms() // activity-sorted; bookmarked || joined
    if (all.length === 0) return EMPTY_SIDEBAR_JIDS
    // Partition into the sidebar's three sections. Section + JID are encoded into a
    // single string (space-separated; JIDs and section codes never contain spaces)
    // so the result is a flat string[] that compares cleanly under useShallow — the
    // list re-renders only when membership, order, or section actually changes, not
    // when a room's messages / unread / last-message-preview change.
    const quick: string[] = []
    const joined: string[] = []
    const bookmarkedNotJoined: Room[] = []
    for (const r of all) {
      if (r.isQuickChat) quick.push(`quick ${r.jid}`)
      else if (r.joined || r.isJoining) joined.push(`joined ${r.jid}`)
      else if (r.isBookmarked) bookmarkedNotJoined.push(r)
    }
    // Bookmarked-but-not-joined rooms are listed alphabetically by name.
    bookmarkedNotJoined.sort((a, b) =>
      (a.name || a.jid).toLowerCase().localeCompare((b.name || b.jid).toLowerCase())
    )
    return [
      ...quick,
      ...joined,
      ...bookmarkedNotJoined.map(r => `bookmarked ${r.jid}`),
    ]
  },

  quickChatRooms: () => {
    const rooms = get().rooms
    if (rooms === _cachedQuickChatRoomsSource) return _cachedQuickChatRooms
    _cachedQuickChatRoomsSource = rooms
    const result = Array.from(rooms.values()).filter(r => r.isQuickChat)
    _cachedQuickChatRooms = result.length > 0 ? result : EMPTY_ROOM_ARRAY
    return _cachedQuickChatRooms
  },

  activeRoom: () => {
    const { rooms, activeRoomJid } = get()
    return activeRoomJid ? rooms.get(activeRoomJid) : undefined
  },

  activeMessages: () => {
    const room = get().activeRoom()
    return room?.messages ?? EMPTY_MESSAGE_ARRAY
  },

  totalMentionsCount: () => {
    let total = 0
    for (const [jid, entity] of get().roomEntities) {
      if (entity.joined) {
        const meta = get().roomMeta.get(jid)
        if (meta) total += meta.mentionsCount
      }
    }
    return total
  },

  totalUnreadCount: () => {
    let total = 0
    for (const [jid, entity] of get().roomEntities) {
      if (entity.joined) {
        const meta = get().roomMeta.get(jid)
        if (meta) total += meta.unreadCount
      }
    }
    return total
  },

  totalNotifiableUnreadCount: () => {
    let total = 0
    for (const [jid, entity] of get().roomEntities) {
      if (entity.joined) {
        const meta = get().roomMeta.get(jid)
        if (meta && (meta.notifyAll || meta.notifyAllPersistent)) {
          total += meta.unreadCount
        }
      }
    }
    return total
  },

  roomsWithUnreadCount: () => {
    // Count rooms that would show a badge in the UI:
    // - Rooms with mentions (always show badge)
    // - Rooms with notifyAll enabled and any unread messages
    let count = 0
    for (const [jid, entity] of get().roomEntities) {
      if (entity.joined) {
        const meta = get().roomMeta.get(jid)
        if (meta) {
          const hasActivity =
            meta.mentionsCount > 0 ||
            ((meta.notifyAll || meta.notifyAllPersistent) && meta.unreadCount > 0)
          if (hasActivity) count++
        }
      }
    }
    return count
  },
  roomTabIndicator: () => {
    let hasNeutral = false
    for (const [jid, entity] of get().roomEntities) {
      const meta = get().roomMeta.get(jid)
      if (!meta) continue
      // Same per-room predicate the room list uses, so rail and list agree.
      const tone = roomActivityTone({ ...entity, ...meta })
      if (tone === 'accent') return 'accent'
      if (tone === 'neutral') hasNeutral = true
    }
    return hasNeutral ? 'neutral' : 'none'
  },
}))
)
