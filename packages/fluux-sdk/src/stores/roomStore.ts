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
import { setTypingTimeout, clearTypingTimeout } from './typingTimeout'
import { findMessageById, findMessageIndexById } from '../utils/messageLookup'
import { getBareJid } from '../core/jid'
import { logInfo } from '../core/logger'
import * as messageCache from '../utils/messageCache'
import * as searchIndex from '../utils/searchIndex'
import type { GetMessagesOptions } from '../utils/messageCache'
import * as mamState from './shared/mamState'
import type { MAMQueryDirection } from './shared/mamState'
import { computeGapEnd, syncGap, serializeGaps, deserializeGaps, type GapInterval } from './shared/mamGap'
import * as draftState from './shared/draftState'
import { buildMessageKeySet, isMessageDuplicate, sortMessagesByTimestamp, trimMessages, trimMessagesKeepOldest, prependOlderMessages, mergeAndProcessMessages } from './shared/messageArrayUtils'
import { shouldUpdateLastMessage, shouldReplaceLastMessage, isPreviewableMessage, findLastNonIgnoredMessage } from './shared/lastMessageUtils'
import { ignoreStore, isMessageFromIgnoredUser } from './ignoreStore'
import { roomActivityTone } from './roomSelectors'
import * as notifState from './shared/notificationState'
import { markerDebugLog } from '../utils/markerDebug'
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

// Rooms whose pending XEP-0490 read marker has already been consumed for divider positioning
// THIS session (parity with chatStore). XEP-0490 markers broadcast live over PEP, so after the
// first open's fold the live `read:displayed-synced` notifies keep us current; re-folding on
// every open would reposition the divider on each return. Cleared on reset() (logout).
const mdsConsumedThisSession = new Set<string>()

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

  // Build key set from in-memory messages (they take precedence)
  const existingKeys = buildMessageKeySet(existing.messages, getRoomMessageKeys)

  // Filter out duplicates from cached messages
  const newFromCache = cachedMessages.filter(
    (msg) => !isMessageDuplicate(msg, existingKeys, getRoomMessageKeys)
  )

  // Merge, sort, and trim using shared utilities
  const combined = [...newFromCache, ...existing.messages]
  const sorted = sortMessagesByTimestamp(combined)
  const merged = trimMessages(sorted, getResidentWindowSize())

  // Get last non-ignored message from merged messages for sidebar preview
  const lastMessage = (merged.length > 0 ? findLastNonIgnoredMessage(merged, roomJid, existing.nickToJidCache) : undefined) ?? existing.lastMessage

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
  activeAnimation: { roomJid: string; animation: string } | null
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
  triggerAnimation: (roomJid: string, animation: string) => void
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

  // IndexedDB cache loading
  loadMessagesFromCache: (roomJid: string, options?: GetMessagesOptions & { peek?: boolean }) => Promise<RoomMessage[]>
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
  mergeRoomMAMMessages: (roomJid: string, messages: RoomMessage[], rsm: RSMResponse, complete: boolean, direction: MAMQueryDirection, preserveGapMarker?: boolean) => void
  getRoomMAMQueryState: (roomJid: string) => MAMQueryState
  resetRoomMAMStates: () => void
  /** Mark all rooms as needing a catch-up MAM query (called on reconnect) */
  markAllRoomsNeedsCatchUp: () => void
  /** Clear the needsCatchUp flag for a specific room */
  clearRoomNeedsCatchUp: (roomJid: string) => void
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
): Pick<RoomState, 'rooms' | 'roomEntities' | 'roomMeta' | 'roomRuntime' | 'activeRoomJid' | 'activationPending' | 'activeAnimation' | 'drafts' | 'votedPollIds' | 'dismissedPollIds' | 'mamQueryStates' | 'roomGaps' | 'acknowledgedNonAnonymousRooms' | 'targetMessageId' | 'firstNewMessageMarkers'> {
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
    acknowledgedNonAnonymousRooms,
    targetMessageId: null,
    firstNewMessageMarkers: new Map(),
  }
}

export const roomStore = createStore<RoomState>()(
  subscribeWithSelector((set, get) => ({
  ...createEmptyRoomState(loadDraftsFromStorage(), loadVotedPollsFromStorage(), loadDismissedPollsFromStorage(), loadGapsFromStorage(), loadNonAnonAckFromStorage()), // Restore drafts, poll state, history gaps, and non-anon acks from localStorage

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
    set((state) => {
      const newRooms = new Map(state.rooms)
      const existing = newRooms.get(roomJid)
      if (!existing) return state

      const updatedRoom = { ...existing, ...update }
      newRooms.set(roomJid, updatedRoom)

      // Update entity fields if any changed
      const entityFields = ['name', 'nickname', 'joined', 'isJoining', 'subject', 'avatar',
        'avatarHash', 'avatarFromPresence', 'isBookmarked', 'autojoin', 'password', 'isQuickChat',
        'supportsMAM', 'supportsReactions', 'supportsHats', 'supportsModeration', 'isIrcGateway', 'isNonAnonymous', 'isPrivate', 'muted'] as const
      const hasEntityUpdate = entityFields.some((f) => f in update)

      // Update metadata fields if any changed
      const metaFields = ['unreadCount', 'mentionsCount', 'typingUsers', 'notifyAll',
        'notifyAllPersistent', 'lastReadAt', 'lastInteractedAt'] as const
      const hasMetaUpdate = metaFields.some((f) => f in update)

      // Update runtime fields if any changed
      const runtimeFields = ['occupants', 'nickToJidCache', 'nickToAvatarCache', 'affiliatedMembers', 'selfOccupant', 'messages'] as const
      const hasRuntimeUpdate = runtimeFields.some((f) => f in update)

      const result: Partial<RoomState> = { rooms: newRooms }

      if (hasEntityUpdate) {
        const newEntities = new Map(state.roomEntities)
        const existingEntity = newEntities.get(roomJid)
        if (existingEntity) {
          newEntities.set(roomJid, {
            jid: updatedRoom.jid,
            name: updatedRoom.name,
            nickname: updatedRoom.nickname,
            joined: updatedRoom.joined,
            isJoining: updatedRoom.isJoining,
            subject: updatedRoom.subject,
            avatar: updatedRoom.avatar,
            avatarHash: updatedRoom.avatarHash,
            avatarFromPresence: updatedRoom.avatarFromPresence,
            isBookmarked: updatedRoom.isBookmarked,
            autojoin: updatedRoom.autojoin,
            password: updatedRoom.password,
            isQuickChat: updatedRoom.isQuickChat,
            supportsMAM: updatedRoom.supportsMAM,
            supportsReactions: updatedRoom.supportsReactions,
            supportsHats: updatedRoom.supportsHats,
            supportsModeration: updatedRoom.supportsModeration,
            isIrcGateway: updatedRoom.isIrcGateway,
            isNonAnonymous: updatedRoom.isNonAnonymous,
            isPrivate: updatedRoom.isPrivate,
            muted: updatedRoom.muted,
          })
        }
        result.roomEntities = newEntities
      }

      if (hasMetaUpdate) {
        const newMeta = new Map(state.roomMeta)
        const existingMeta = newMeta.get(roomJid)
        if (existingMeta) {
          newMeta.set(roomJid, {
            unreadCount: updatedRoom.unreadCount,
            mentionsCount: updatedRoom.mentionsCount,
            typingUsers: updatedRoom.typingUsers,
            notifyAll: updatedRoom.notifyAll,
            notifyAllPersistent: updatedRoom.notifyAllPersistent,
            lastReadAt: updatedRoom.lastReadAt,
            lastInteractedAt: updatedRoom.lastInteractedAt,
          })
        }
        result.roomMeta = newMeta
      }

      if (hasRuntimeUpdate) {
        const newRuntime = new Map(state.roomRuntime)
        const existingRuntime = newRuntime.get(roomJid)
        if (existingRuntime) {
          newRuntime.set(roomJid, {
            occupants: updatedRoom.occupants,
            nickToJidCache: updatedRoom.nickToJidCache,
            nickToAvatarCache: updatedRoom.nickToAvatarCache,
            affiliatedMembers: updatedRoom.affiliatedMembers,
            selfOccupant: updatedRoom.selfOccupant,
            messages: updatedRoom.messages,
            // Preserve the live-edge flag across an entity/meta update (a plain field
            // update must not silently recenter the window).
            windowAtLiveEdge: existingRuntime.windowAtLiveEdge,
          })
        }
        result.roomRuntime = newRuntime
      }

      return result
    })
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
    set(createEmptyRoomState(loadDraftsFromStorage(jid), loadVotedPollsFromStorage(jid), loadDismissedPollsFromStorage(jid), loadGapsFromStorage(jid), loadNonAnonAckFromStorage(jid)))
  },

  reset: () => {
    // Note: We don't clear IndexedDB on reset - room messages are valuable cache
    // They will be cleared when rooms are explicitly removed or user logs out
    // (The connection store's reset handles full logout cleanup via clearAllMessages)
    // New session → the XEP-0490 synced read marker may be folded again on first open.
    mdsConsumedThisSession.clear()
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
    const messageToAdd = room?.isQuickChat
      ? { ...message, noLocalStore: true }
      : message

    // Save to IndexedDB only if the message is locally persistable
    if (!messageToAdd.noLocalStore) {
      void messageCache.saveRoomMessage(messageToAdd)
      searchIndex.indexMessage(messageToAdd).catch((e) => console.warn('[searchIndex] indexMessage failed:', e))
    }

    set((state) => {
      const newRooms = new Map(state.rooms)
      const existing = newRooms.get(roomJid)
      if (!existing) return state

      // XEP-0359: Deduplicate messages using shared utility
      const existingKeys = buildMessageKeySet(existing.messages, getRoomMessageKeys)
      if (isMessageDuplicate(messageToAdd, existingKeys, getRoomMessageKeys)) {
        return state // Don't add duplicate message
      }

      // Sliding window: only append the live message to the resident array when the
      // window is at the live edge. If load-older slid the window up (evicting the
      // newest tail), appending here would splice a fresh message directly after an
      // OLD one — a visible false-adjacency gap. When gated we leave the resident
      // array untouched; the message is still persisted to IndexedDB (above) and the
      // sidebar preview / unread badge still update. It reloads on jump-to-latest.
      const atLiveEdge = state.roomRuntime.get(roomJid)?.windowAtLiveEdge !== false
      // The append is also the basis for the newest-message preview; compute it either
      // way (it is only STORED when at the live edge).
      const appendedMessages = trimMessages([...existing.messages, messageToAdd], getResidentWindowSize())
      const newMessages = atLiveEdge ? appendedMessages : existing.messages

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

      const updated = notifState.onMarkAsRead(notifInput, lastMessageTimestamp)

      // Skip update if no change
      if (updated === notifInput) return {}

      const newRooms = new Map(state.rooms)
      newRooms.set(roomJid, { ...existing, unreadCount: updated.unreadCount, mentionsCount: updated.mentionsCount, lastReadAt: updated.lastReadAt })

      const newMeta = new Map(state.roomMeta)
      const newMetaEntry = {
        ...(meta ?? { unreadCount: 0, mentionsCount: 0, typingUsers: new Set<string>() }),
        unreadCount: updated.unreadCount,
        mentionsCount: updated.mentionsCount,
        lastReadAt: updated.lastReadAt,
      }
      newMeta.set(roomJid, newMetaEntry)

      return { rooms: newRooms, roomMeta: newMeta }
    })
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
        const activated = notifState.onActivate(notifInput, messages)

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
      // chatStore.activateConversation). Forward-only against the loaded messages.
      // Fold a pending XEP-0490 synced read position into lastSeenMessageId BEFORE setActiveRoom
      // derives the divider — but only on the FIRST open of this room this session (parity with
      // chatStore.activateConversation). XEP-0490 markers broadcast live over PEP, so re-folding on
      // every open would reposition the divider on each return.
      const firstConsumeThisSession = !mdsConsumedThisSession.has(roomJid)
      mdsConsumedThisSession.add(roomJid)
      const pending = get().roomMeta.get(roomJid)?.pendingRemoteDisplayedStanzaId
      if (pending && firstConsumeThisSession) {
        const lastSeenBefore = get().roomMeta.get(roomJid)?.lastSeenMessageId
        get().applyRemoteDisplayed(roomJid, pending)
        markerDebugLog('activation fold (XEP-0490 pending → divider, first open this session)', {
          roomJid,
          pendingStanzaId: pending,
          lastSeenBefore,
          lastSeenAfter: get().roomMeta.get(roomJid)?.lastSeenMessageId,
          advanced: lastSeenBefore !== get().roomMeta.get(roomJid)?.lastSeenMessageId,
        })
      } else if (pending) {
        markerDebugLog('activation fold SKIPPED (already consumed this session — PEP keeps it live)', {
          roomJid,
          pendingStanzaId: pending,
        })
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
      const updated = notifState.onMessageSeen(notifInput, messageId, messages)
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
    set((state) => {
      const meta = state.roomMeta.get(roomJid)
      const existing = state.rooms.get(roomJid)
      if (!meta) return state

      const runtime = state.roomRuntime.get(roomJid)
      // A non-active room keeps no resident array (memory windowing), so
      // mergeRoomMAMMessages passes the just-merged array here; else read runtime/rooms.
      const messages = messagesOverride ?? runtime?.messages ?? existing?.messages ?? []
      const match = messages.find((m) => m.stanzaId === stanzaId)

      if (!match) {
        const newMeta = new Map(state.roomMeta)
        newMeta.set(roomJid, { ...meta, pendingRemoteDisplayedStanzaId: stanzaId })
        if (existing) {
          const newRooms = new Map(state.rooms)
          newRooms.set(roomJid, { ...existing, pendingRemoteDisplayedStanzaId: stanzaId })
          return { roomMeta: newMeta, rooms: newRooms }
        }
        return { roomMeta: newMeta }
      }

      const updated = notifState.onMessageSeen(
        {
          unreadCount: meta.unreadCount,
          mentionsCount: meta.mentionsCount,
          lastReadAt: meta.lastReadAt,
          lastSeenMessageId: meta.lastSeenMessageId,
          firstNewMessageId: state.firstNewMessageMarkers.get(roomJid),
        },
        match.id,
        messages
      )

      // No advance: the matching message is loaded and the local position is at
      // or past it — the marker is resolved; clear any stale pending mark.
      if (updated.lastSeenMessageId === meta.lastSeenMessageId) {
        if (meta.pendingRemoteDisplayedStanzaId === undefined) return state
        const newMeta = new Map(state.roomMeta)
        newMeta.set(roomJid, { ...meta, pendingRemoteDisplayedStanzaId: undefined })
        if (existing) {
          const newRooms = new Map(state.rooms)
          newRooms.set(roomJid, { ...existing, pendingRemoteDisplayedStanzaId: undefined })
          return { roomMeta: newMeta, rooms: newRooms }
        }
        return { roomMeta: newMeta }
      }

      const newMeta = new Map(state.roomMeta)
      newMeta.set(roomJid, {
        ...meta,
        lastSeenMessageId: updated.lastSeenMessageId,
        pendingRemoteDisplayedStanzaId: undefined,
      })

      // XEP-0490: if this marker advances the CURRENTLY ACTIVE room, its new-message
      // divider was already derived at activation from the (now stale) local read
      // position — the fresh-session seed can land just after the room opens, so the
      // fold at activation missed it. Recompute the divider from the advanced position
      // (rooms treat delayed messages as history replay, so no treatDelayedAsNew) so it
      // reflects the synced read instead of freezing at the local one. Inactive rooms
      // recompute on their next activation, so leave the map untouched.
      let newMarkers = state.firstNewMessageMarkers
      if (state.activeRoomJid === roomJid) {
        const divider = notifState.onActivate(
          {
            unreadCount: 0,
            mentionsCount: 0,
            lastReadAt: meta.lastReadAt,
            lastSeenMessageId: updated.lastSeenMessageId,
            firstNewMessageId: undefined,
          },
          messages
        ).firstNewMessageId
        newMarkers = new Map(state.firstNewMessageMarkers)
        if (divider) newMarkers.set(roomJid, divider)
        else newMarkers.delete(roomJid)
      }

      if (existing) {
        const newRooms = new Map(state.rooms)
        newRooms.set(roomJid, {
          ...existing,
          lastSeenMessageId: updated.lastSeenMessageId,
          pendingRemoteDisplayedStanzaId: undefined,
        })
        return { roomMeta: newMeta, rooms: newRooms, firstNewMessageMarkers: newMarkers }
      }
      return { roomMeta: newMeta, firstNewMessageMarkers: newMarkers }
    })
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
  triggerAnimation: (roomJid, animation) => {
    set({ activeAnimation: { roomJid, animation } })
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
        // When loading without 'before', get the latest messages (most recent)
        latest: !options.before,
      }
      const cachedMessages = await messageCache.getRoomMessages(roomJid, queryOptions)
      // `peek`: a pure read that returns the messages WITHOUT pulling them into the
      // store. Used to compute a catch-up cursor for a non-active room without
      // breaking the invariant that only the active room is resident in RAM.
      if (!options.peek && cachedMessages.length > 0) {
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
        // Prepend to existing messages using shared utilities
        set((state) => {
          const newRooms = new Map(state.rooms)
          const existing = newRooms.get(roomJid)
          if (!existing) return state

          // Build key set from in-memory messages (they take precedence)
          const existingKeys = buildMessageKeySet(existing.messages, getRoomMessageKeys)

          // Filter out duplicates from cached messages
          const newFromCache = cachedMessages.filter(
            (msg) => !isMessageDuplicate(msg, existingKeys, getRoomMessageKeys)
          )

          // Merge, sort, and trim using shared utilities.
          // Load-older slides the window (keep oldest) so scroll-back past the bound works.
          const combined = [...newFromCache, ...existing.messages]
          const sorted = sortMessagesByTimestamp(combined)
          const merged = trimMessagesKeepOldest(sorted, getResidentWindowSize())

          // If keep-oldest evicted the newest resident message, the window has slid off
          // the live edge → gate live appends in addMessage. If the batch fit under the
          // bound (newest unchanged), leave the flag as-is.
          const newestEvicted =
            merged[merged.length - 1]?.id !== existing.messages[existing.messages.length - 1]?.id

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
        // Append to existing messages using shared utilities
        set((state) => {
          const newRooms = new Map(state.rooms)
          const existing = newRooms.get(roomJid)
          if (!existing) return state

          // Build key set from in-memory messages (they take precedence)
          const existingKeys = buildMessageKeySet(existing.messages, getRoomMessageKeys)

          // Filter out duplicates from cached messages
          const newFromCache = cachedMessages.filter(
            (msg) => !isMessageDuplicate(msg, existingKeys, getRoomMessageKeys)
          )

          // Merge, sort, and trim using shared utilities.
          // Load-newer slides the window (keep newest) so sliding back down works.
          const combined = [...existing.messages, ...newFromCache]
          const sorted = sortMessagesByTimestamp(combined)
          const merged = trimMessages(sorted, getResidentWindowSize())

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

  mergeRoomMAMMessages: (roomJid, mamMessages, rsm, complete, direction, preserveGapMarker = false) => {
    // Captured from inside set() so the post-set MDS marker resolution can read the
    // merged array even for a non-active room (whose array isn't resident).
    let mergedForMarker: RoomMessage[] = []
    set((state) => {
      const room = state.rooms.get(roomJid)
      if (!room) return state

      // Get existing messages for this room
      const existingMessages = room.messages || []

      // Choose merge strategy based on direction:
      // - Backward (scroll up for older): optimized prepend avoids full re-sort
      // - Forward (catching up with newer): requires full sort since messages are newer
      const { merged, newMessages: newFromMAM } =
        direction === 'backward'
          ? prependOlderMessages(
              existingMessages,
              mamMessages,
              getRoomMessageKeys,
              getResidentWindowSize()
            )
          : mergeAndProcessMessages(
              existingMessages,
              mamMessages,
              getRoomMessageKeys,
              getResidentWindowSize()
            )
      mergedForMarker = merged

      // Compute the newest fetched timestamp for gap marker positioning.
      // When a forward catch-up ends incomplete, this marks where the gap starts.
      const newestFetchedTimestamp = direction === 'forward' && mamMessages.length > 0
        ? Math.max(...mamMessages.map(m => m.timestamp?.getTime() ?? 0))
        : undefined

      // Update MAM query state using the two-marker approach
      // This must always be updated to track query completion and cursors
      const newStates = mamState.setMAMQueryCompleted(
        state.mamQueryStates,
        roomJid,
        complete,
        direction,
        rsm.first, // Pagination cursor for fetching older messages
        newestFetchedTimestamp,
        preserveGapMarker
      )

      // Mirror the (reliable, complete=false-driven) forward gap into the PERSISTED
      // roomGaps map so the marker survives a reload. `end` = oldest message held
      // above the gap. preserveGapMarker (bounded force repair) leaves it untouched.
      let newGaps = state.roomGaps
      if (direction === 'forward' && !preserveGapMarker) {
        const gapStart = newStates.get(roomJid)?.forwardGapTimestamp
        const gapEnd = gapStart !== undefined ? computeGapEnd(merged, gapStart) : undefined
        newGaps = syncGap(state.roomGaps, roomJid, gapStart, gapEnd)
        if (newGaps !== state.roomGaps) saveGapsToStorage(newGaps)
      }

      // If no new messages (all duplicates), only update MAM state - skip room messages
      // This prevents unnecessary re-renders when merging duplicates
      if (newFromMAM.length === 0) {
        return { mamQueryStates: newStates, roomGaps: newGaps }
      }

      // Persist to IndexedDB regardless of active state — this is the durable
      // history that rehydrates on open (search index too).
      const persistableMessages = newFromMAM.filter(msg => !msg.noLocalStore)
      if (persistableMessages.length > 0) {
        void messageCache.saveRoomMessages(persistableMessages)
        searchIndex.indexMessages(persistableMessages).catch((e) => console.warn('[searchIndex] indexMessages failed:', e))
      }

      // Sidebar preview = newest non-ignored across the merged set.
      const lastMessage = (merged.length > 0 ? findLastNonIgnoredMessage(merged, roomJid, room.nickToJidCache) : undefined) ?? room.lastMessage

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
        // roomRuntime deliberately untouched.
        return { rooms: newRooms, roomMeta: newMeta, mamQueryStates: newStates, roomGaps: newGaps }
      }

      // ACTIVE room: populate the resident array (foreground catch-up / scroll-up).
      const newRooms = new Map(state.rooms)
      newRooms.set(roomJid, { ...room, messages: merged, lastMessage })

      // A backward (scroll-up) merge uses keep-oldest and can evict the newest tail,
      // sliding the window off the live edge (same gate as loadOlderMessagesFromCache).
      // Forward catch-up keeps the newest, so it never slides.
      const newestEvicted =
        direction === 'backward' &&
        merged[merged.length - 1]?.id !== existingMessages[existingMessages.length - 1]?.id

      const newRuntime = new Map(state.roomRuntime)
      const existingRuntime = newRuntime.get(roomJid)
      if (existingRuntime) {
        newRuntime.set(roomJid, {
          ...existingRuntime,
          messages: merged,
          ...(newestEvicted ? { windowAtLiveEdge: false } : {}),
        })
      }

      return { rooms: newRooms, roomRuntime: newRuntime, roomMeta: newMeta, mamQueryStates: newStates, roomGaps: newGaps }
    })

    // XEP-0490: a remote room marker may have arrived before its message.
    // Now that messages are merged, try to resolve it forward-only.
    const pending = get().roomMeta.get(roomJid)?.pendingRemoteDisplayedStanzaId
    if (pending) {
      get().applyRemoteDisplayed(roomJid, pending, mergedForMarker)
    }
  },

  getRoomMAMQueryState: (roomJid) => {
    return mamState.getMAMQueryState(get().mamQueryStates, roomJid)
  },

  resetRoomMAMStates: () => {
    set({ mamQueryStates: new Map() })
  },

  markAllRoomsNeedsCatchUp: () => {
    set((state) => ({
      mamQueryStates: mamState.markAllNeedsCatchUp(state.mamQueryStates),
    }))
  },

  clearRoomNeedsCatchUp: (roomJid) => {
    set((state) => ({
      mamQueryStates: mamState.clearNeedsCatchUp(state.mamQueryStates, roomJid),
    }))
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
