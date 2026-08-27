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
  HistoryQueryState,
  PageInfo,
} from '../core/types'
import { isNoLocalStore, type StoredRoomMessage } from '../core/types/message-internal'
import { setTypingTimeout, clearTypingTimeout } from './typingTimeout'
import { findMessageById, findMessageIndexById } from '../utils/messageLookup'
import { roomIdentityKeys } from '../utils/roomMessageIdentity'
import { getBareJid } from '../core/jid'
import { logInfo } from '../core/logger'
import * as messageCache from '../utils/messageCache'
import * as searchIndex from '../utils/searchIndex'
import type { GetMessagesOptions } from '../utils/messageCache'
import * as mamState from './shared/mamState'
import type { HistoryQueryDirection } from './shared/mamState'
import { syncGapAfterArchiveMerge, messagePageExtent, newestMessageStanzaId, serializeGaps, deserializeGaps, type GapInterval } from './shared/mamGap'
import {
  syncCoverageAfterArchiveMerge,
  isCaughtUpForCounting,
  resolveCoverageBottom,
  serializeCoverage,
  deserializeCoverage,
  type CoverageRecord,
  type CoverageTransition,
  type MergeArchiveExtras,
} from './shared/mamCoverage'
import {
  computeFloor,
  pointerlessDefers,
  worthReconcilingOnDeactivate,
  isAfterBoundary,
  exactPosition,
  isRenderableStoredMessage,
  type PointerOrder,
} from './shared/readState'
import {
  transientCounts,
  noteTransient,
  pruneTransient,
  removeTransient,
  clearTransientScope,
  clearTransientEntity,
  transientIdentity,
  transientAliases,
  type ScopeKey as TransientScopeKey,
} from './shared/transientUnread'
import {
  beginViewportGeneration,
  currentViewportEvidence,
  clearViewportEvidence,
  type EvidenceKey as ViewportEvidenceKey,
} from './shared/viewportEvidence'
import { createArchiveSaveChain } from './shared/archiveSaveChain'
import * as draftState from './shared/draftState'
import * as timeline from './shared/messageTimeline'
import { shouldUpdateLastMessage, shouldReplaceLastMessage, isPreviewableMessage, findLastNonIgnoredMessage } from './shared/lastMessageUtils'
import { derivePreviewAfterMerge } from './shared/previewState'
import { addPendingRetraction, applyPendingRetractions, type PendingRetraction } from './shared/pendingRetractions'
import { createRemoteDividerAdvanceTracker } from './shared/dividerAdvance'
import { locallyPublishedDisplayed } from '../core/localMdsPublishes'
import { isAhead } from './shared/readPointer'
import { resolveRemoteDisplayed, createMdsSessionGate, foldPendingRemoteDisplayed } from './shared/readMarkerSync'
import { advance, makeReadPointer } from './shared/readPointer'
import { loadRoomReadState, saveRoomReadState, clearRoomReadState, _clearAllRoomReadStateForTesting, type RoomReadState } from './shared/readStateStorage'
import { ignoreStore, isMessageFromIgnoredUser } from './ignoreStore'
import { roomActivityTone } from './roomSelectors'
import * as notifState from './shared/notificationState'
import { markerDebugLog } from '../utils/markerDebug'
import { connectionStore } from './connectionStore'
import { buildScopedStorageKey, getStorageScopeJid } from '../utils/storageScope'
import {
  recordRecountDeferral,
  type RecountDeferralReason,
} from './shared/recountDiagnostics'
import { createRecountRetryScheduler } from './shared/recountRetry'
import { createPendingEntityWrites } from './shared/pendingEntityWrites'
import { schedule, flush as flushThrottledStorage } from './shared/throttledStorage'
import { scheduleDurableMaps, cancelDurableMaps, forgetAllDurableMapBaselines, noteCoverageTransition } from './shared/durableMapPersist'
// Sliding-window bound (messages kept resident per room; rest live in IndexedDB + MAM). Read via
// getResidentWindowSize() so a DEV/DEMO/TEST caller can shrink it — see shared/residentWindow.ts.
import { getResidentWindowSize } from './shared/residentWindow'
import { clearMarker, lastMessageTimestamp, clearCoverageEntry, clearGapAnchor } from './shared/keyedMapEdits'

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
  // Lazy: a coalesced write never pays for the stringify. Error absorption
  // lives in the throttle.
  schedule(getRoomDraftsStorageKey(jid), () => JSON.stringify(Array.from(drafts.entries())))
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
  schedule(storageKey, () =>
    JSON.stringify(
      Array.from(pollIds.entries()).map(([k, v]) => [k, Array.from(v)] as [string, string[]])
    )
  )
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
  // A gap FORMATION must not sit in the throttle window — nothing re-detects
  // it next session. Shrink/close/removal stays throttled. See durableMapPersist.
  const key = getRoomGapsStorageKey(jid)
  scheduleDurableMaps(key, { gaps }, () => serializeGaps(gaps))
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

/**
 * @param transition - What the merge that produced `coverage` did to
 *   `transition.roomJid`'s record. `durableMapPersist` owns the policy of which
 *   transitions must escape the throttle window (#1138); this only reports.
 *   Removal IS derivable there, so the clear paths pass nothing.
 */
function saveCoverageToStorage(
  coverage: Map<string, CoverageRecord>,
  jid?: string | null,
  transition?: { roomJid: string; kind: CoverageTransition },
): void {
  // A record being invalidated must not sit in the throttle window: the stale
  // one on disk asserts a contiguity that was just disproven. Creation, a
  // `bottomId` deepening and a `topId`-only refresh all stay throttled.
  const key = getRoomCoverageStorageKey(jid)
  if (transition) noteCoverageTransition(key, transition.roomJid, transition.kind)
  scheduleDurableMaps(key, { coverage }, () => serializeCoverage(coverage))
}

/**
 * Durable room read state (see shared/readStateStorage). Rooms had none: the
 * read position was rebuilt every session from MAM catch-up plus the XEP-0490
 * marker, so a restart lost it (issue #1081).
 *
 * The map lives here rather than in `roomMeta` because rooms arrive from
 * bookmarks LONG after the store initialises — `addRoom` is what folds a
 * persisted row back into `roomMeta`, and until then the row has to wait
 * somewhere. Hydrating `roomMeta` with placeholder entries instead would put
 * rooms that may never be re-added in front of every `roomMeta` iterator (the
 * XEP-0490 publisher walks `roomMeta.keys()`).
 *
 * Reloaded on `switchAccount`, dropped on `reset` (logout).
 */
let persistedRoomReadState = loadRoomReadState()

/**
 * Persist the read state, projecting the CURRENT `roomMeta` over the map above.
 *
 * Projecting the whole map (rather than writing the one room that changed)
 * means `roomMeta` stays the single source of truth for every room the session
 * knows about: a write site that forgets to call this loses nothing permanently,
 * because the next call from any other room picks its pointer up too.
 *
 * Rooms absent from `roomMeta` keep their persisted row — at startup a pointer
 * can advance before every bookmark has landed, and a room that is not loaded
 * yet must not be garbage-collected by another room's save. `removeRoom` is
 * what drops a row for good.
 */
function persistRoomReadState(roomMeta: Map<string, RoomMetadata>): void {
  for (const [roomJid, meta] of roomMeta) {
    if (!meta.readPointer && !meta.historyFloor) continue
    persistedRoomReadState.set(roomJid, {
      ...(meta.readPointer ? { readPointer: meta.readPointer } : {}),
      ...(meta.historyFloor ? { historyFloor: meta.historyFloor } : {}),
    })
  }
  saveRoomReadState(persistedRoomReadState)
}

/**
 * The read position a room should start (or restart) with, resolved from ONE
 * source and written as a whole.
 *
 * Priority: what the store already holds → then the LATER of what the caller
 * supplied and what survived the last run. Never a field-by-field merge across
 * sources: a read position is one `readPointer`, and mixing halves of two of
 * them is exactly the drift #1081 undid — `advance` picks one whole pointer.
 *
 * The store's own value wins because `addRoom` runs again on rejoin and on
 * bookmark reload, and those Room objects are rebuilt from presence/bookmark
 * data that carries no read state — taking them at face value would wipe a
 * live pointer.
 *
 * Between the other two, neither can be ahead of the user's true position, so
 * the later one is right. They are two mirrors of the same store and either can
 * be the stale one: the SDK state snapshot is debounced by 500 ms and the
 * durable `readStateStorage` row is throttled by 1000 ms, so after a crash
 * EITHER can be the older. Taking one at face value would then have
 * `persistRoomReadState` write an older position back over the row.
 *
 * The rule holds because both are LAGGING mirrors — throttling the row makes it
 * lag more, never lead — so "later" only ever recovers the freshest one.
 *
 * INVARIANT this "take the later" rule depends on: both `room` (from the state
 * snapshot) and `restored` (the durable row) are lagging MIRRORS of one store
 * pointer, so neither can be ahead of the user's true position — "later" only
 * ever recovers the freshest mirror. If a later PR makes either an INDEPENDENT
 * writer, this precedence is no longer safe and must be revisited: "later" would
 * then be able to pick a genuinely-ahead position, the unrecoverable direction.
 */
function resolveRoomReadPosition(
  existingMeta: RoomMetadata | undefined,
  room: Room,
  restored: RoomReadState | undefined
): Pick<RoomMetadata, 'readPointer'> {
  if (existingMeta?.readPointer) return { readPointer: existingMeta.readPointer }
  // `advance` is forward-only and keeps `restored` on a tie — the direction that
  // shows more unread, which is the recoverable one.
  if (room.readPointer) return { readPointer: advance(restored?.readPointer, room.readPointer) }
  return { readPointer: restored?.readPointer }
}

/**
 * localStorage persistence for XEP-0424 retractions still waiting for their
 * target to load. Scoped per account like the gap/coverage maps.
 */
const ROOM_PENDING_RETRACTIONS_STORAGE_KEY_BASE = 'fluux-room-pending-retractions'

function getRoomPendingRetractionsStorageKey(jid?: string | null): string {
  return buildScopedStorageKey(ROOM_PENDING_RETRACTIONS_STORAGE_KEY_BASE, jid)
}

function loadPendingRetractionsFromStorage(jid?: string | null): Map<string, PendingRetraction[]> {
  try {
    const stored = localStorage.getItem(getRoomPendingRetractionsStorageKey(jid))
    if (stored) return new Map(JSON.parse(stored) as [string, PendingRetraction[]][])
  } catch {
    // Ignore parse/storage errors
  }
  return new Map()
}

function savePendingRetractionsToStorage(pending: Map<string, PendingRetraction[]>, jid?: string | null): void {
  try {
    localStorage.setItem(getRoomPendingRetractionsStorageKey(jid), JSON.stringify([...pending.entries()]))
  } catch {
    // Ignore storage errors (quota exceeded, etc.)
  }
}

// Serializes this store's archive-page writes; see shared/archiveSaveChain.ts.
const roomArchiveSaves = createArchiveSaveChain()

// Cache epoch (Codex r4 #5): bumped whenever the room cache lifecycle resets
// (logout reset or account switch). Deferred gap/coverage commits
// capture the epoch at merge time and no-op when it moved — a gate that was
// already in flight when the state was torn down must not resurrect entries.
let roomCacheEpoch = 0

/**
 * The account scope this store last saw its OWN transient-overlay
 * entries filed under. Tracked separately from `getStorageScopeJid()` because
 * by the time `switchAccount` runs, the global scope has ALREADY flipped to
 * the incoming account (XMPPClient calls `setStorageScopeJid` before
 * `switchAccount`) — `getStorageScopeJid()` there would name the NEW account,
 * not the one being torn down.
 */
let lastRoomTransientScope: string | null = null

/** Test-only: drop all per-room archive-save chain entries. */
export function _resetRoomArchiveSavesForTesting(): void {
  roomArchiveSaves.clear()
  roomCacheEpoch++
}

// Per-room recount version for `recomputeUnreadForRoom`'s latest-wins
// commit. Mirrors chatStore's `chatRecountVersion` — see that doc for the
// race it guards against. Cleared on logout/account switch: a stale version
// surviving into a new account can only ever cause an extra discarded
// recompute, never a wrong write (the recompute also re-checks `roomMeta`
// under the same key).
const roomRecountVersion = new Map<string, number>()
const roomUnreadInputVersion = new Map<string, number>()
const roomPendingUnreadWrites = createPendingEntityWrites()
const roomEntityEpoch = new Map<string, number>()
const roomRecountRetry = createRecountRetryScheduler((error) => {
  console.warn('Unread recount retry failed for a room:', error)
})

function bumpRoomRecountVersion(roomJid: string): number {
  const next = (roomRecountVersion.get(roomJid) ?? 0) + 1
  roomRecountVersion.set(roomJid, next)
  return next
}

function bumpRoomUnreadInputVersion(roomJid: string): void {
  roomUnreadInputVersion.set(roomJid, (roomUnreadInputVersion.get(roomJid) ?? 0) + 1)
}

function roomRecountReady(roomJid: string): boolean {
  const mam = mamState.getMAMQueryState(roomStore.getState().mamQueryStates, roomJid)
  return !roomPendingUnreadWrites.has(roomJid) &&
    !roomArchiveSaves.has(roomJid) &&
    isCaughtUpForCounting(mam)
}

function currentRoomEntityEpoch(roomJid: string): number {
  return roomEntityEpoch.get(roomJid) ?? 0
}

/**
 * The transient-overlay scope key for a room. `accountScope` mirrors
 * chatStore's `chatTransientScopeKey` — a bare room JID can collide across
 * accounts, so the overlay is scoped by the account JID, never a bare room JID.
 */
function roomTransientScopeKey(roomJid: string): TransientScopeKey {
  return { accountScope: getStorageScopeJid() ?? '', kind: 'room', entityId: roomJid }
}

function invalidateRoomEntity(roomJid: string): void {
  roomEntityEpoch.set(roomJid, currentRoomEntityEpoch(roomJid) + 1)
  roomArchiveSaves.cancel(roomJid)
  roomPendingUnreadWrites.cancel(roomJid)
  roomRecountRetry.cancel(roomJid)
  roomRecountVersion.delete(roomJid)
  roomUnreadInputVersion.delete(roomJid)
  clearTransientEntity(roomTransientScopeKey(roomJid))
}

/**
 * The viewport-evidence key for a room. Same shape/rationale as
 * {@link roomTransientScopeKey}: scoped by account JID.
 */
function roomViewportEvidenceKey(roomJid: string): ViewportEvidenceKey {
  return { accountScope: getStorageScopeJid() ?? '', kind: 'room', entityId: roomJid }
}

/**
 * Test-only: forget every persisted room read position, in memory and on disk.
 *
 * Room read state is durable, so wiping `roomMeta` with a bare `setState` does
 * not give a test a clean room: the next `addRoom` folds the previous test's
 * pointer back in — which is the whole point in production. A test that resets
 * the store by hand needs this too.
 *
 * Clears the rows for EVERY account scope written this session, not just the
 * ambient one: callers reset the storage scope first, so the ambient key at this
 * moment is the unscoped one, which nothing writes once an account is set.
 */
export function _resetRoomReadStateForTesting(): void {
  persistedRoomReadState = new Map()
  _clearAllRoomReadStateForTesting()
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
const remoteDividerAdvances = createRemoteDividerAdvanceTracker()

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
  return roomIdentityKeys(m)
}

/** Timeline config for the shared resident-window machine (see shared/messageTimeline.ts). */
function roomTimelineConfig(): timeline.TimelineConfig<RoomMessage> {
  return { getKeys: getRoomMessageKeys, windowSize: getResidentWindowSize(), kind: 'room' }
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
  notifyAllPersistent: true, readPointer: true, historyFloor: true,
  pendingRemoteDisplayedStanzaId: true, lastMessage: true, lastInteractedAt: true,
} satisfies Record<keyof RoomMetadata, true>) as readonly (keyof RoomMetadata)[]

const ROOM_RUNTIME_FIELD_ROUTING = {
  occupants: 'sync', nickToJidCache: 'sync', occupantIdToJidCache: 'sync',
  occupantIdToNick: 'sync', nickToAvatarCache: 'sync', occupantIdToAvatarCache: 'sync',
  affiliatedMembers: 'sync', selfOccupant: 'sync',
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
      // Same placement as saveGapsToStorage after a gap mutation: persist from
      // inside the commit, so every caller routing a read-state field through
      // updateRoom/markReadToNewest is covered without each one remembering to.
      if ('readPointer' in metaPatch || 'historyFloor' in metaPatch) {
        persistRoomReadState(newMeta)
      }
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
/**
 * XEP-0424 authorship gate, room flavour. XEP-0421 occupant-id is the stable,
 * unforgeable author identity and wins whenever BOTH sides carry one — a nick
 * can be reassigned once its owner leaves. Mirrors Chat.isSameMucAuthor.
 */
export const roomRetractionAuthor = (message: StoredRoomMessage, record: PendingRetraction): boolean =>
  message.occupantId && record.actorOccupantId
    ? message.occupantId === record.actorOccupantId
    : message.from === record.actorJid

/**
 * Room twin of chatStore's resolvePendingRetractions: replay a room's pending
 * retractions against a slice, writing every tombstone through to the durable
 * cache. `persist: false` is for a message not yet saved — its own write carries
 * the tombstone, and a concurrent update would race it.
 */
function resolveRoomPendingRetractions(
  state: RoomState,
  roomJid: string,
  slice: StoredRoomMessage[],
  options: { persist?: boolean } = {}
): { messages: StoredRoomMessage[]; pendingRetractions?: RoomState['pendingRetractions'] } {
  const pending = state.pendingRetractions.get(roomJid)
  if (!pending || pending.length === 0) return { messages: slice }

  const { messages, applied, remaining } = applyPendingRetractions(slice, pending, roomRetractionAuthor)
  if (remaining.length === pending.length) return { messages }

  if (options.persist !== false) {
    for (const { messageId, retractedAt } of applied) {
      const retracted = findMessageById(messages, messageId)
      void messageCache.updateRoomMessage(roomJid, messageId, { isRetracted: true, retractedAt }, retracted?.from)
      if (retracted) void searchIndex.removeMessage(retracted)
    }
  }

  const nextPending = new Map(state.pendingRetractions)
  if (remaining.length === 0) nextPending.delete(roomJid)
  else nextPending.set(roomJid, remaining)
  savePendingRetractionsToStorage(nextPending)
  return { messages, pendingRetractions: nextPending }
}

/**
 * The single writer for a room's resident message window.
 *
 * It changes `rooms` only for the caller's `roomPatch`, and keeps the `messages`
 * map reference stable when the requested slice is already resident.
 *
 * @returns the maps to return from `set()`, or `null` when the room is unknown
 *   — the same miss the call sites already guarded on.
 */
function withRoomMessageWindow(
  state: Pick<RoomState, 'rooms' | 'messages' | 'windowAtLiveEdge'>,
  roomJid: string,
  messages: RoomMessage[],
  options: {
    /** Fields to patch on the room entry alongside the window, e.g. a preview. */
    roomPatch?: Partial<Room>
    /** Move the live-edge flag. Absent leaves it as it was. */
    atLiveEdge?: boolean
  } = {}
): Pick<RoomState, 'rooms' | 'messages' | 'windowAtLiveEdge'> | null {
  const existing = state.rooms.get(roomJid)
  if (!existing) return null

  // `rooms` is touched only for the caller's own patch. The resident window
  // itself lives in `messages` and nowhere else.
  const rooms = options.roomPatch
    ? new Map(state.rooms).set(roomJid, { ...existing, ...options.roomPatch })
    : state.rooms

  const current = state.messages.get(roomJid)
  const sameSlice =
    current === messages || ((current?.length ?? 0) === 0 && messages.length === 0)
  if (sameSlice && options.atLiveEdge === undefined) {
    return { rooms, messages: state.messages, windowAtLiveEdge: state.windowAtLiveEdge }
  }

  const nextMessages = sameSlice ? state.messages : new Map(state.messages).set(roomJid, messages)
  const nextEdge =
    options.atLiveEdge === undefined
      ? state.windowAtLiveEdge
      : new Map(state.windowAtLiveEdge).set(roomJid, options.atLiveEdge)
  return { rooms, messages: nextMessages, windowAtLiveEdge: nextEdge }
}

function mergeCachedRoomMessages(
  state: RoomState,
  roomJid: string,
  cachedMessages: RoomMessage[]
): Partial<Pick<RoomState, 'rooms' | 'messages' | 'windowAtLiveEdge' | 'roomMeta' | 'pendingRetractions'>> | null {
  const newRooms = new Map(state.rooms)
  const existing = newRooms.get(roomJid)
  if (!existing) return null

  // Shared timeline machine: dedupe (in-memory messages take precedence),
  // sort, and keep-newest trim.
  const resident = state.messages.get(roomJid) ?? []
  const { merged: rawMerged } = timeline.latestSlice(resident, cachedMessages, roomTimelineConfig())

  // XEP-0424: a retraction recorded while this room was unloaded applies here,
  // the moment its target becomes resident.
  const resolvedRetractions = resolveRoomPendingRetractions(state, roomJid, rawMerged)
  const merged = resolvedRetractions.messages

  // Sidebar preview via the shared policy: only replace when the merged set's
  // newest non-ignored message genuinely supersedes (or heals) the current
  // preview — a deep-history slice (scroll-position restore) must not regress it.
  const { lastMessage } = derivePreviewAfterMerge(existing.lastMessage, merged, (msgs) =>
    findLastNonIgnoredMessage(msgs, roomJid, existing.nickToJidCache)
  )

  const written = withRoomMessageWindow(state, roomJid, merged, { roomPatch: { lastMessage } })
  if (!written) return null

  // Update metadata with lastMessage for sidebar
  const newMeta = new Map(state.roomMeta)
  const existingMeta = newMeta.get(roomJid)
  if (existingMeta) {
    newMeta.set(roomJid, { ...existingMeta, lastMessage })
  }

  return {
    ...written,
    roomMeta: newMeta,
    ...(resolvedRetractions.pendingRetractions ? { pendingRetractions: resolvedRetractions.pendingRetractions } : {}),
  }
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
 * import { roomStore } from '@fluux/sdk'
 *
 * // Get all bookmarked rooms
 * const bookmarked = roomStore.getState().bookmarkedRooms()
 *
 * // Subscribe to room updates
 * roomStore.subscribe(
 *   (state) => state.rooms,
 *   (rooms) => console.log('Rooms updated:', rooms.size)
 * )
 *
 * // Get total unread mentions
 * const mentions = roomStore.getState().totalMentionsCount()
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
  /**
   * The resident message window per room: the slice of history currently held
   * in memory. Top-level maps, like `chatStore`'s — the window is not
   * MUC-specific, and a per-room subscriber to occupancy should not re-render
   * when a message lands. `withRoomMessageWindow` is the only writer.
   */
  messages: Map<string, RoomMessage[]>
  /**
   * Whether a room's resident window still holds the newest history, so an
   * incoming live message can be appended. Sliding the window up via load-older
   * evicts the newest tail and sets this `false`, gating the append in
   * {@link RoomState.addMessage}: appending onto a window that no longer touches
   * the tail would create a visible false-adjacency gap. The gated message is
   * still persisted and still updates the preview and unread badge; it reloads
   * on jump-to-latest / recenter.
   *
   * EPHEMERAL: never persisted. On reload the resident array is rebuilt from the
   * newest window (= live edge), so a stored "scrolled-up" value would wrongly
   * gate live messages.
   *
   * A missing entry means "at the live edge"; only an explicit `false` gates.
   */
  windowAtLiveEdge: Map<string, boolean>
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
  mamQueryStates: Map<string, HistoryQueryState>
  // Persisted history-gap intervals per room (survives reload; drives the gap marker)
  roomGaps: Map<string, GapInterval>
  // Persisted contiguous-with-live coverage per room (positive twin of roomGaps;
  // survives fresh sessions and gap closure). See shared/mamCoverage.ts.
  roomCoverage: Map<string, CoverageRecord>
  // Rooms the user has acknowledged as non-anonymous (issue #37) — warn once, not
  // on every reconnect. Persisted to localStorage separately and scoped per account.
  acknowledgedNonAnonymousRooms: Set<string>
  // XEP-0424 retractions whose target was not resident when they arrived (only the
  // ACTIVE room keeps messages in RAM, and a target older than the loaded slice is
  // absent even there). Persisted (scoped, like roomGaps) so the tombstone still
  // lands after a reload; each record clears the moment its target loads. Twin of
  // chatStore.pendingRetractions — see shared/pendingRetractions.ts.
  pendingRetractions: Map<string, PendingRetraction[]>
  // Target message to scroll to after navigation (ephemeral)
  targetMessageId: string | null
  // Session-only new-message divider per room (jid -> messageId). Derived at
  // activation from the read pointer; never persisted.
  firstNewMessageMarkers: Map<string, string>
  /**
   * Monotonic per-room versions incremented whenever `appendLive` places a
   * genuine arrival before the resident timeline's live edge.
   *
   * @remarks
   * Stable public API. The versions are ephemeral and reset with the store.
   */
  interiorPlacementVersions: Map<string, number>

  // Actions
  /**
   * @param resident - the room's initial message window. Defaults to empty:
   *   only the snapshot restore arrives with history already in hand.
   */
  addRoom: (room: Room, resident?: RoomMessage[]) => void
  updateRoom: (roomJid: string, update: Partial<Room>) => void
  removeRoom: (roomJid: string) => void
  setRoomJoined: (roomJid: string, joined: boolean) => void
  /** Reset joined/isJoining for all rooms (called on fresh session after reconnect) */
  markAllRoomsNotJoined: () => void
  addOccupant: (roomJid: string, occupant: RoomOccupant) => void
  batchAddOccupants: (roomJid: string, occupants: RoomOccupant[]) => void
  removeOccupant: (roomJid: string, nick: string) => void
  updateOccupantAvatar: (roomJid: string, nick: string, avatar: string | null, avatarHash: string | null, occupantId?: string) => void
  /** Batch variant of updateOccupantAvatar — one state update for N resolved avatars (e.g. after joining a large room) */
  updateOccupantAvatars: (roomJid: string, updates: Array<{ nick?: string; occupantId?: string; avatar: string | null; avatarHash: string | null }>) => void
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
   * Reconcile a non-active room's unread count against the durable archive
   *: a coverage-gated cursor count from the effective read boundary,
   * plus the transient (`noLocalStore`) overlay, capped at 999 — never a
   * bounded resident/cache slice. Commits only on an exact derivation; every
   * uncertain case (pointerless-with-count, incomplete coverage) leaves the
   * last TRUSTED count untouched rather than writing a provisional one.
   * `mentionsCount` is never written here (see `readState.ts`'s
   * `RecomputeOutcome` doc) — rooms keep it on the live `+1` path. Latest-wins
   * across concurrent recounts for the same room.
   *
   * Called after a deferred-decrypt resolves an encrypted room message (the
   * badge it may have provisionally inflated needs reconciling once the
   * message settles), after a forward MAM merge past the floor, after a
   * remote read-marker advance, at cold-start rehydrate, and after any
   * transient-overlay mutation that reports a change.
   *
   * No-op for the active room by default: most triggers are already
   * reconciled for the active room by their own synchronous path
   * (`onMessageReceived`'s live-edge convergence). The one exception
   * is `{ allowActive: true }`: a remote XEP-0490 marker can advance the
   * ACTIVE room's read position without that convergence path running at
   * all, and activation writes no unconditional zero, so nothing re-derives the
   * active room's count after such an advance — pass `allowActive: true`
   * ONLY from that trigger.
   */
  recomputeUnreadForRoom: (roomJid: string, options?: { allowActive?: boolean }) => Promise<void>
  /**
   * XEP-0424: apply an incoming retraction, deferring it when its target is not
   * resident. Applies immediately (and writes through to the durable cache) when
   * the target is in the window; otherwise records it and replays it the moment
   * the target arrives live or loads from the cache. Only the message's own
   * author can retract it — a mismatched actor is dropped, never tombstoned.
   *
   * @param actorJid - Full room JID (room@service/nick) the retraction came from.
   * @param actorOccupantId - XEP-0421 occupant-id when advertised; preferred over the nick.
   */
  recordPendingRetraction: (roomJid: string, targetId: string, actorJid: string, actorOccupantId?: string) => void
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
   *  for this room. Forward-only and idempotent: repositions the divider to the
   *  first unread message after the pointer when one exists. Never clears an existing divider when
   *  the pointer is at the newest (nothing unread) — that state is kept alive deliberately after a
   *  FAB jump-to-present so the jump-to-last-read pill can offer a return; clearing is owned by the
   *  explicit read-through / mark-read paths. No-op when no divider exists.
   *  Touches nothing but firstNewMessageMarkers.
   *  Only meaningful for the ACTIVE room: deactivation clears its marker and evicts its resident
   *  `messages` window, so the recompute would see an empty array and SILENTLY clear the divider —
   *  callers must only invoke this for the active room. */
  resyncDividerToReadPointer: (roomJid: string) => void
  advanceReadPointer: (roomJid: string, messageId: string) => void
  /**
   * XEP-0490: apply a remote device's last-displayed marker. Advances
   * the read pointer forward-only. Pending and ordering semantics are owned by
   * the shared `readMarkerSync` resolver.
   */
  applyRemoteDisplayed: (
    roomJid: string,
    stanzaId: string,
    messagesOverride?: RoomMessage[],
  ) => void
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
   * @param page - RSM pagination response
   * @param complete - Whether server indicated query is complete
   * @param direction - Query direction: 'backward' for older history, 'forward' for catching up
   */
  mergeRoomMAMMessages: (roomJid: string, messages: RoomMessage[], page: PageInfo, complete: boolean, direction: HistoryQueryDirection, preserveGapMarker?: boolean, isFetchLatest?: boolean, extras?: MergeArchiveExtras) => void
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
  getRoomMAMQueryState: (roomJid: string) => HistoryQueryState
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
  pendingRetractions: Map<string, PendingRetraction[]> = new Map(),
): Pick<RoomState, 'rooms' | 'roomEntities' | 'roomMeta' | 'roomRuntime' | 'messages' | 'windowAtLiveEdge' | 'activeRoomJid' | 'activationPending' | 'activeAnimation' | 'drafts' | 'votedPollIds' | 'dismissedPollIds' | 'mamQueryStates' | 'roomGaps' | 'roomCoverage' | 'acknowledgedNonAnonymousRooms' | 'pendingRetractions' | 'targetMessageId' | 'firstNewMessageMarkers' | 'interiorPlacementVersions'> {
  return {
    rooms: new Map(),
    roomEntities: new Map(),
    roomMeta: new Map(),
    roomRuntime: new Map(),
    messages: new Map(),
    windowAtLiveEdge: new Map(),
    activeRoomJid: null,
    activationPending: false,
    activeAnimation: null,
    drafts,
    votedPollIds,
    dismissedPollIds,
    mamQueryStates: new Map(),
    roomGaps,
    roomCoverage,
    pendingRetractions,
    acknowledgedNonAnonymousRooms,
    targetMessageId: null,
    firstNewMessageMarkers: new Map(),
    interiorPlacementVersions: new Map(),
  }
}

export const roomStore = createStore<RoomState>()(
  subscribeWithSelector((set, get) => ({
  ...createEmptyRoomState(loadDraftsFromStorage(), loadVotedPollsFromStorage(), loadDismissedPollsFromStorage(), loadGapsFromStorage(), loadNonAnonAckFromStorage(), loadCoverageFromStorage(), loadPendingRetractionsFromStorage()), // Restore drafts, poll state, history gaps, coverage, and non-anon acks from localStorage

  addRoom: (room, resident = []) => {
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
      const existingMeta = state.roomMeta.get(room.jid)
      const restoredReadState = persistedRoomReadState.get(room.jid)
      const occupantIdToNick = room.occupantIdToNick ?? (() => {
        const index = new Map<string, string>()
        for (const occupant of room.occupants?.values() ?? []) {
          if (occupant.occupantId) index.set(occupant.occupantId, occupant.nick)
        }
        return index.size > 0 ? index : undefined
      })()
      const meta: RoomMetadata = {
        unreadCount: room.unreadCount,
        mentionsCount: room.mentionsCount,
        typingUsers: room.typingUsers,
        notifyAll: room.notifyAll,
        notifyAllPersistent: room.notifyAllPersistent,
        ...resolveRoomReadPosition(existingMeta, room, restoredReadState),
        // Written ONCE, when the room enters our world, and never again — that
        // is what makes it a lifecycle fact rather than a second read position.
        // addRoom runs again on rejoin and on bookmark reload, and it runs again
        // on every app start, so both the in-memory value and the persisted one
        // outrank a fresh stamp: a floor that moved would silently bury whatever
        // arrived while we were away.
        historyFloor: existingMeta?.historyFloor ?? restoredReadState?.historyFloor ?? new Date(),
        lastMessage: resident.length > 0 ? findLastNonIgnoredMessage(resident, room.jid, room.nickToJidCache) : undefined,
        lastInteractedAt: room.lastInteractedAt,
      }
      const runtime: RoomRuntime = {
        occupants: room.occupants,
        nickToJidCache: room.nickToJidCache,
        occupantIdToJidCache: room.occupantIdToJidCache,
        occupantIdToNick,
        occupantIdToAvatarCache: room.occupantIdToAvatarCache,
        selfOccupant: room.selfOccupant,
      }

      const newRooms = new Map(state.rooms)
      // Keep the combined mirror coherent with the read position resolved above
      // — several call sites still read `rooms` as the fallback for these
      // fields, and an incoming Room carries none of them.
      newRooms.set(room.jid, {
        ...room,
        ...(occupantIdToNick && { occupantIdToNick }),
        readPointer: meta.readPointer,
        historyFloor: meta.historyFloor,
      })

      const newEntities = new Map(state.roomEntities)
      newEntities.set(room.jid, entity)

      const newMeta = new Map(state.roomMeta)
      newMeta.set(room.jid, meta)

      const newRuntime = new Map(state.roomRuntime)
      newRuntime.set(room.jid, runtime)

      // Seed the window from the incoming Room. An upsert always lands the
      // newest slice, so it is at the live edge by construction; the map's
      // convention is that absent means edge, so only a room arriving with an
      // explicit `false` records anything.
      const newMessages = new Map(state.messages)
      newMessages.set(room.jid, resident)

      // Creation stamps the history floor, so the durable copy is written here
      // too — a room joined and never opened still gets its floor recorded.
      persistRoomReadState(newMeta)

      return {
        rooms: newRooms,
        roomEntities: newEntities,
        roomMeta: newMeta,
        roomRuntime: newRuntime,
        messages: newMessages,
      }
    })
  },

  updateRoom: (roomJid, update) => {
    set((state) => commitRoomUpdate(state, roomJid, update) ?? state)
  },

  removeRoom: (roomJid) => {
    // Delete messages from IndexedDB (non-blocking)
    void messageCache.deleteRoomMessages(roomJid)
    // The durable cursors describe messages that no longer exist (Codex r4
    // #5): drop them with the cache, and invalidate in-flight deferred
    // commits so one can't resurrect an entry for the removed room.
    invalidateRoomEntity(roomJid)

    set((state) => {
      const newRooms = new Map(state.rooms)
      newRooms.delete(roomJid)

      const newEntities = new Map(state.roomEntities)
      newEntities.delete(roomJid)

      const newMeta = new Map(state.roomMeta)
      newMeta.delete(roomJid)

      const newRuntime = new Map(state.roomRuntime)
      newRuntime.delete(roomJid)

      const newMessages = new Map(state.messages)
      newMessages.delete(roomJid)

      const newLiveEdge = new Map(state.windowAtLiveEdge)
      newLiveEdge.delete(roomJid)

      const out: Partial<RoomState> = {
        rooms: newRooms,
        roomEntities: newEntities,
        roomMeta: newMeta,
        roomRuntime: newRuntime,
        messages: newMessages,
        windowAtLiveEdge: newLiveEdge,
      }
      if (state.roomGaps.has(roomJid)) {
        const newGaps = new Map(state.roomGaps)
        newGaps.delete(roomJid)
        saveGapsToStorage(newGaps)
        out.roomGaps = newGaps
      }
      if (state.roomCoverage.has(roomJid)) {
        const newCoverage = new Map(state.roomCoverage)
        newCoverage.delete(roomJid)
        saveCoverageToStorage(newCoverage)
        out.roomCoverage = newCoverage
      }
      // The read position describes messages that no longer exist. This is the
      // ONLY place a persisted row is dropped — saves elsewhere never prune, so
      // that a room whose bookmark has not loaded yet keeps its state.
      if (persistedRoomReadState.delete(roomJid)) {
        saveRoomReadState(persistedRoomReadState)
      }
      return out
    })
  },

  setRoomJoined: (roomJid, joined) => {
    set((state) => {
      const newRooms = new Map(state.rooms)
      const existing = newRooms.get(roomJid)
      if (!existing) return state

      // DON'T set lastInteractedAt on join - only setActiveRoom (user clicking) should set it.
      // MUC history messages arrive before the join confirmation, so the resident window may
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
      const previousAtNick = existing.occupants.get(occupant.nick)
      const merged = preserveOccupantAvatar(previousAtNick, occupant)
      newOccupants.set(merged.nick, merged)

      let occupantIdToNick = existing.occupantIdToNick
      const previousIdNeedsRemoval = previousAtNick?.occupantId
        && previousAtNick.occupantId !== merged.occupantId
        && occupantIdToNick?.get(previousAtNick.occupantId) === previousAtNick.nick
      const currentIdNeedsUpdate = merged.occupantId
        && occupantIdToNick?.get(merged.occupantId) !== merged.nick
      if (previousIdNeedsRemoval || currentIdNeedsUpdate) {
        occupantIdToNick = new Map(occupantIdToNick || [])
        if (previousIdNeedsRemoval) occupantIdToNick.delete(previousAtNick.occupantId!)
        if (merged.occupantId) occupantIdToNick.set(merged.occupantId, merged.nick)
      }

      // Update nick→jid cache for non-anonymous rooms (when real JID is visible)
      let nickToJidCache = existing.nickToJidCache
      if (merged.jid) {
        nickToJidCache = new Map(nickToJidCache || [])
        nickToJidCache.set(merged.nick, getBareJid(merged.jid))
      }
      let occupantIdToJidCache = existing.occupantIdToJidCache
      if (merged.occupantId && merged.jid) {
        occupantIdToJidCache = new Map(occupantIdToJidCache || [])
        occupantIdToJidCache.set(merged.occupantId, getBareJid(merged.jid))
      }

      // Update nick→avatar cache if occupant has avatar
      let nickToAvatarCache = existing.nickToAvatarCache
      if (merged.avatar) {
        nickToAvatarCache = new Map(nickToAvatarCache || [])
        nickToAvatarCache.set(merged.nick, merged.avatar)
      }
      let occupantIdToAvatarCache = existing.occupantIdToAvatarCache
      if (merged.occupantId && merged.avatar) {
        occupantIdToAvatarCache = new Map(occupantIdToAvatarCache || [])
        occupantIdToAvatarCache.set(merged.occupantId, merged.avatar)
      }

      newRooms.set(roomJid, {
        ...existing,
        occupants: newOccupants,
        nickToJidCache,
        occupantIdToJidCache,
        occupantIdToNick,
        nickToAvatarCache,
        occupantIdToAvatarCache,
      })

      // Update runtime
      const newRuntime = new Map(state.roomRuntime)
      const existingRuntime = newRuntime.get(roomJid)
      if (existingRuntime) {
        newRuntime.set(roomJid, {
          ...existingRuntime,
          occupants: newOccupants,
          nickToJidCache,
          occupantIdToJidCache,
          occupantIdToNick,
          nickToAvatarCache,
          occupantIdToAvatarCache,
        })
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
      let occupantIdToJidCache = existing.occupantIdToJidCache
      let occupantIdToNick = existing.occupantIdToNick
      let nickToAvatarCache = existing.nickToAvatarCache
      let occupantIdToAvatarCache = existing.occupantIdToAvatarCache

      // Add all occupants in a single update
      for (const occupant of occupants) {
        // Presence carries only the avatar hash — keep an already-fetched blob alive.
        const previousAtNick = newOccupants.get(occupant.nick)
        const merged = preserveOccupantAvatar(previousAtNick, occupant)
        newOccupants.set(merged.nick, merged)

        const previousIdNeedsRemoval = previousAtNick?.occupantId
          && previousAtNick.occupantId !== merged.occupantId
          && occupantIdToNick?.get(previousAtNick.occupantId) === previousAtNick.nick
        const currentIdNeedsUpdate = merged.occupantId
          && occupantIdToNick?.get(merged.occupantId) !== merged.nick
        if (previousIdNeedsRemoval || currentIdNeedsUpdate) {
          if (!occupantIdToNick || occupantIdToNick === existing.occupantIdToNick) {
            occupantIdToNick = new Map(occupantIdToNick || [])
          }
          if (previousIdNeedsRemoval) occupantIdToNick.delete(previousAtNick.occupantId!)
          if (merged.occupantId) occupantIdToNick.set(merged.occupantId, merged.nick)
        }

        // Update nick→jid cache for non-anonymous rooms
        if (merged.jid) {
          if (!nickToJidCache || nickToJidCache === existing.nickToJidCache) {
            nickToJidCache = new Map(nickToJidCache || [])
          }
          nickToJidCache.set(merged.nick, getBareJid(merged.jid))
        }
        if (merged.occupantId && merged.jid) {
          if (!occupantIdToJidCache || occupantIdToJidCache === existing.occupantIdToJidCache) {
            occupantIdToJidCache = new Map(occupantIdToJidCache || [])
          }
          occupantIdToJidCache.set(merged.occupantId, getBareJid(merged.jid))
        }

        // Update nick→avatar cache
        if (merged.avatar) {
          if (!nickToAvatarCache || nickToAvatarCache === existing.nickToAvatarCache) {
            nickToAvatarCache = new Map(nickToAvatarCache || [])
          }
          nickToAvatarCache.set(merged.nick, merged.avatar)
        }
        if (merged.occupantId && merged.avatar) {
          if (!occupantIdToAvatarCache || occupantIdToAvatarCache === existing.occupantIdToAvatarCache) {
            occupantIdToAvatarCache = new Map(occupantIdToAvatarCache || [])
          }
          occupantIdToAvatarCache.set(merged.occupantId, merged.avatar)
        }
      }

      newRooms.set(roomJid, {
        ...existing,
        occupants: newOccupants,
        nickToJidCache,
        occupantIdToJidCache,
        occupantIdToNick,
        nickToAvatarCache,
        occupantIdToAvatarCache,
      })

      // Update runtime
      const newRuntime = new Map(state.roomRuntime)
      const existingRuntime = newRuntime.get(roomJid)
      if (existingRuntime) {
        newRuntime.set(roomJid, {
          ...existingRuntime,
          occupants: newOccupants,
          nickToJidCache,
          occupantIdToJidCache,
          occupantIdToNick,
          nickToAvatarCache,
          occupantIdToAvatarCache,
        })
      }

      return { rooms: newRooms, roomRuntime: newRuntime }
    })
  },

  removeOccupant: (roomJid, nick) => {
    set((state) => {
      const newRooms = new Map(state.rooms)
      const existing = newRooms.get(roomJid)
      if (!existing) return state

      const leavingOccupant = existing.occupants.get(nick)
      const newOccupants = new Map(existing.occupants)
      newOccupants.delete(nick)
      let occupantIdToNick = existing.occupantIdToNick
      if (
        leavingOccupant?.occupantId
        && occupantIdToNick?.get(leavingOccupant.occupantId) === nick
      ) {
        occupantIdToNick = new Map(occupantIdToNick)
        occupantIdToNick.delete(leavingOccupant.occupantId)
      }
      // Also remove from typing users when they leave
      const newTypingUsers = new Set(existing.typingUsers)
      newTypingUsers.delete(nick)
      newRooms.set(roomJid, {
        ...existing,
        occupants: newOccupants,
        occupantIdToNick,
        typingUsers: newTypingUsers,
      })

      // Update runtime (occupants)
      const newRuntime = new Map(state.roomRuntime)
      const existingRuntime = newRuntime.get(roomJid)
      if (existingRuntime) {
        newRuntime.set(roomJid, { ...existingRuntime, occupants: newOccupants, occupantIdToNick })
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

  updateOccupantAvatar: (roomJid, nick, avatar, avatarHash, occupantId) => {
    get().updateOccupantAvatars(roomJid, [{ nick, occupantId, avatar, avatarHash }])
  },

  updateOccupantAvatars: (roomJid, updates) => {
    set((state) => {
      const existing = state.rooms.get(roomJid)
      if (!existing) return state

      let newOccupants: Map<string, RoomOccupant> | null = null
      // Update nick→avatar cache so avatars persist after occupants leave
      let nickToAvatarCache = existing.nickToAvatarCache
      // Stable XEP-0421 cache survives nick changes and can be hydrated for
      // occupants who are already offline when the room is joined.
      let occupantIdToAvatarCache = existing.occupantIdToAvatarCache
      let cacheChanged = false

      for (const { nick, occupantId, avatar, avatarHash } of updates) {
        const occupantAtNick = nick
          ? (newOccupants ?? existing.occupants).get(nick)
          : undefined
        // An async avatar fetch may finish after the old occupant left and a
        // different person recycled the nick. Never write the old avatar into
        // that new live occupant.
        const occupant = occupantId && occupantAtNick?.occupantId
          && occupantAtNick.occupantId !== occupantId
          ? undefined
          : occupantAtNick
        const stableOccupantId = occupantId ?? occupant?.occupantId

        if (occupant && nick) {
          if (!newOccupants) newOccupants = new Map(existing.occupants)
          newOccupants.set(nick, {
            ...occupant,
            avatar: avatar ?? undefined,
            avatarHash: avatarHash ?? undefined,
          })
        }

        if (avatar && nick && (occupant || !occupantId)) {
          if (!nickToAvatarCache || nickToAvatarCache === existing.nickToAvatarCache) {
            nickToAvatarCache = new Map(nickToAvatarCache || [])
          }
          nickToAvatarCache.set(nick, avatar)
          cacheChanged = true
        }

        if (stableOccupantId) {
          if (!occupantIdToAvatarCache || occupantIdToAvatarCache === existing.occupantIdToAvatarCache) {
            occupantIdToAvatarCache = new Map(occupantIdToAvatarCache || [])
          }
          if (avatar) {
            occupantIdToAvatarCache.set(stableOccupantId, avatar)
          } else {
            occupantIdToAvatarCache.delete(stableOccupantId)
          }
          cacheChanged = true
        }
      }

      if (!newOccupants && !cacheChanged) return state

      const newRooms = new Map(state.rooms)
      newRooms.set(roomJid, {
        ...existing,
        occupants: newOccupants ?? existing.occupants,
        nickToAvatarCache,
        occupantIdToAvatarCache,
      })

      // Update runtime (occupants + avatar cache)
      const newRuntime = new Map(state.roomRuntime)
      const existingRuntime = newRuntime.get(roomJid)
      if (existingRuntime) {
        newRuntime.set(roomJid, {
          ...existingRuntime,
          occupants: newOccupants ?? existingRuntime.occupants,
          nickToAvatarCache,
          occupantIdToAvatarCache,
        })
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
    // Freshness on an immediate return: without this, a fast A -> B -> A runs
    // loadRoomReadState(A) against a blob predating A's last mutations, and
    // that stale load becomes the live state.
    flushThrottledStorage()
    // Free after the flush above: every window is closed, so the next write's
    // force-flush finds no pending thunk.
    forgetAllDurableMapBaselines()
    // In-flight archive-save gates belong to the previous account; their
    // deferred commits must not land in the new account's maps.
    roomArchiveSaves.clear()
    roomCacheEpoch++
    roomRecountVersion.clear()
    roomUnreadInputVersion.clear()
    roomPendingUnreadWrites.clear()
    roomEntityEpoch.clear()
    roomRecountRetry.clear()
    remoteDividerAdvances.reset()
    // Tear down the OUTGOING account's transient overlay entries
    // before adopting the new scope — see lastRoomTransientScope's doc for
    // why this can't just read getStorageScopeJid() here.
    if (lastRoomTransientScope !== null) {
      clearTransientScope(lastRoomTransientScope)
      // Viewport evidence is scoped the same way — same teardown timing.
      clearViewportEvidence(lastRoomTransientScope)
    }
    lastRoomTransientScope = getStorageScopeJid()
    // Read state is folded into roomMeta by addRoom, not held in the state
    // object — reload the account's rows so the rooms this account is about to
    // add find theirs.
    persistedRoomReadState = loadRoomReadState(jid)
    set(createEmptyRoomState(loadDraftsFromStorage(jid), loadVotedPollsFromStorage(jid), loadDismissedPollsFromStorage(jid), loadGapsFromStorage(jid), loadNonAnonAckFromStorage(jid), loadCoverageFromStorage(jid), loadPendingRetractionsFromStorage(jid)))
  },

  reset: () => {
    // In-flight archive-save gates from the old session must not commit
    // cursors into the fresh state.
    roomArchiveSaves.clear()
    roomCacheEpoch++
    roomRecountVersion.clear()
    roomUnreadInputVersion.clear()
    roomPendingUnreadWrites.clear()
    roomEntityEpoch.clear()
    roomRecountRetry.clear()
    remoteDividerAdvances.reset()
    // Logout tears down this account's transient overlay too.
    // Unlike switchAccount, nothing flips the global scope before reset()
    // runs (clearLocalData calls it directly), so getStorageScopeJid() here
    // is still the account being logged out — read it directly rather than
    // through lastRoomTransientScope.
    clearTransientScope(getStorageScopeJid() ?? '')
    // Viewport evidence, same account-scoped teardown.
    clearViewportEvidence(getStorageScopeJid() ?? '')
    lastRoomTransientScope = null
    // Note: We don't clear IndexedDB on reset - room messages are valuable cache
    // They will be cleared when rooms are explicitly removed or user logs out
    // (The connection store's reset handles full logout cleanup via clearAllMessages)
    // New session → the XEP-0490 synced read marker may be folded again on first open.
    mdsGate.reset()
    // Clear persisted room drafts and poll state on logout.
    //
    // Cancel BEFORE removing. Unlike chatStore, nothing after this re-triggers
    // these helper writes, so a pending thunk would resurrect logged-out data.
    for (const key of [
      getRoomDraftsStorageKey(),
      getRoomVotedPollsStorageKey(),
      getRoomDismissedPollsStorageKey(),
      getRoomGapsStorageKey(),
      getRoomCoverageStorageKey(),
      getRoomNonAnonAckStorageKey(),
    ]) {
      // `cancelDurableMaps` for every key: it is `cancel` plus the structural
      // baseline, and the gap/coverage baselines describe exactly the write
      // being cancelled here. Keeping one would let a formation after a
      // re-login compare equal to a state that was never persisted and skip
      // its flush (durableMapPersist). A no-op for the keys that have none.
      cancelDurableMaps(key)
      localStorage.removeItem(key)
    }
    // Logout forgets read positions for rooms exactly as chatStore.reset()
    // forgets them for 1:1 conversations (it drops the whole chat storage key,
    // pointers included) — one kind of conversation must not outlive the other.
    persistedRoomReadState = new Map()
    clearRoomReadState()
    set(createEmptyRoomState())
  },

  // Message actions
  addMessage: (roomJid, message, options = {}) => {
    bumpRoomUnreadInputVersion(roomJid)

    const { incrementUnread = true, incrementMentions = false } = options

    // Get room to check if it's a Quick Chat (transient history)
    const room = get().rooms.get(roomJid)

    // Quick Chat rooms are transient: keep their messages in memory only
    const incoming: StoredRoomMessage = room?.isQuickChat
      ? { ...message, noLocalStore: true }
      : message

    // XEP-0424: a retraction can outrun its target (live retraction against a
    // non-resident message, out-of-order delivery). Tombstone BEFORE the save
    // below so it persists the tombstone — patching afterwards would race it.
    const arrival = resolveRoomPendingRetractions(get(), roomJid, [incoming], { persist: false })
    const messageToAdd = arrival.messages[0]
    if (arrival.pendingRetractions) set({ pendingRetractions: arrival.pendingRetractions })

    // Unread messages that are not yet durable use the transient overlay:
    // permanently for `noLocalStore`, and until a live cache write commits
    // for ordinary messages. It is computed once here, before the state update, so
    // `noteTransient` (a side-effecting Map mutation) runs exactly once per
    // arrival. Gated on `isUnseenIncomingMessage` so we never note an
    // outgoing/seen/historical arrival that `onMessageReceived` would not
    // have incremented for anyway — mirrors that pure function's own
    // branching exactly (see its doc). Also respects the caller's own
    // `incrementUnread: false` (e.g. MUC.ts's nick-change system message).
    //
     // `viewportAtLiveEdge` is read here
    // too (not just inside `onMessageReceived`'s own `set()` below) so
    // `isUnseenIncomingMessage` sees the SAME evidence and genuinely mirrors
    // `onMessageReceived`'s `userSeesMessage` check — an active, focused, but
    // SCROLLED-UP room (not at the live edge) is "unseen" here too, so a
    // noLocalStore message arriving in that state gets recorded in the
    // overlay instead of being representable ONLY by the live `+1`, which an
    // archive-only recount can never see again.
    const priorMeta = get().roomMeta.get(roomJid)
    const viewportAtLiveEdgeForNote = currentViewportEvidence(roomViewportEvidenceKey(roomJid)) === 'at-edge'
    const unseen = notifState.isUnseenIncomingMessage(messageToAdd, {
      isActive: get().activeRoomJid === roomJid,
      windowVisible: connectionStore.getState().windowVisible,
      viewportAtLiveEdge: viewportAtLiveEdgeForNote,
    })
    const noteAsTransient = incrementUnread && unseen && isRenderableStoredMessage(messageToAdd)
    let overlayUnreadDelta = 0
    let overlayRequiresRecount = false
    let acceptedMessage = false
    if (noteAsTransient && priorMeta) {
      const scopeKey = roomTransientScopeKey(roomJid)
      // No boundary here: `isUnseenIncomingMessage` above already establishes
      // this is a genuine new arrival relative to the read state, so only the
      // BEFORE/AFTER *delta* matters — adding one brand-new logical entry
      // always changes the raw (unbounded) count by exactly 1. (The real
      // floor would be redundant AND riskier: a fresh room's historyFloor is
      // stamped "now" at creation, so a message arriving within the same
      // millisecond would tie rather than compare strictly-after it,
      // undercounting the very message this branch exists to count.)
      const before = transientCounts(scopeKey, undefined).unread
      const identityFields = {
        roomJid,
        from: messageToAdd.from,
        id: messageToAdd.id,
        stanzaId: messageToAdd.stanzaId,
        originId: messageToAdd.originId,
      }
      const result = noteTransient(
        scopeKey,
        { position: exactPosition(messageToAdd, 'room') },
        transientIdentity(identityFields, 'room'),
        transientAliases(identityFields, 'room')
      )
      // `added` drives the +1 (case 1: brand-new logical entry). Re-reading
      // transientCounts rather than hardcoding +1 keeps this delta honest
      // against the SAME primitive the async recount uses.
      if (result.added) {
        overlayUnreadDelta = Math.max(0, transientCounts(scopeKey, undefined).unread - before)
      }
      // Handled by the archive-derived recompute scheduled after the set()
      // below; see `noteTransient`'s doc on `requiresRecount`.
      overlayRequiresRecount = result.requiresRecount
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
      const atLiveEdge = state.windowAtLiveEdge.get(roomJid) !== false
      const resident = state.messages.get(roomJid) ?? []
      const appendObservation: timeline.AppendLiveObservation = {}
      const append = timeline.appendLive(
        resident,
        messageToAdd,
        atLiveEdge,
        roomTimelineConfig(),
        appendObservation
      )

      if (append.kind === 'duplicate-unchanged') return state
      if (append.kind === 'duplicate-backfilled') {
        // Persist the backfilled archive ids so pagination cursors survive a reload.
        for (const p of append.patched) {
          void messageCache.updateRoomMessage(roomJid, p.id, { stanzaId: p.stanzaId!, ...(p.originId ? { originId: p.originId } : {}) }, p.from)
        }
        const backfilled = withRoomMessageWindow(state, roomJid, append.messages)
        if (!backfilled) return state
        return backfilled
      }
      acceptedMessage = true

      // The appended set is also the basis for the newest-message preview even
      // when the append was gated (the preview must still advance to the
      // incoming message after the window slid off the live edge).
      const appendedMessages = append.kind === 'appended' ? append.messages : [...resident, messageToAdd]
      const newMessages = append.kind === 'appended' ? append.messages : resident
      const interiorPlacementPatch = appendObservation.placement === 'interior'
        ? {
            interiorPlacementVersions: new Map(state.interiorPlacementVersions).set(
              roomJid,
              (state.interiorPlacementVersions.get(roomJid) ?? 0) + 1
            ),
          }
        : {}

      // Delegate notification state to pure function
      const isActive = state.activeRoomJid === roomJid
      const windowVisible = connectionStore.getState().windowVisible
      // See chatStore's addMessage twin — missing/stale/unknown evidence
      // conservatively resolves to false, never authorizing the pointer advance.
      const viewportAtLiveEdge = currentViewportEvidence(roomViewportEvidenceKey(roomJid)) === 'at-edge'
      const existingMeta = state.roomMeta.get(roomJid)

      const notifInput: notifState.EntityNotificationState = {
        unreadCount: existingMeta?.unreadCount ?? existing.unreadCount,
        mentionsCount: existingMeta?.mentionsCount ?? existing.mentionsCount,
        readPointer: existingMeta?.readPointer ?? existing.readPointer,
        firstNewMessageId: state.firstNewMessageMarkers.get(roomJid),
      }

      // When this arrival is being noted in the transient overlay above,
      // `incrementUnread: false` suppresses this branch's OWN +1 — its
      // contribution is `overlayUnreadDelta` (applied to `unreadCount`
      // below), so the two paths can never double-count the same message.
      const updated = notifState.onMessageReceived(
        notifInput,
        {
          id: messageToAdd.id,
          from: messageToAdd.from,
          timestamp: messageToAdd.timestamp,
          // The room-assigned archive id when the reflection carries one, so a
          // pointer this arrival advances is `addressable` immediately rather
          // than needing the publisher to look it back up.
          stanzaId: messageToAdd.stanzaId,
          isOutgoing: messageToAdd.isOutgoing ?? false,
          isDelayed: messageToAdd.isDelayed,
          isMention: messageToAdd.isMention,
          body: messageToAdd.body,
          attachment: messageToAdd.attachment,
          poll: messageToAdd.poll,
          pollClosed: messageToAdd.pollClosed,
          isRetracted: messageToAdd.isRetracted,
          encryptedPayload: messageToAdd.encryptedPayload,
          unsupportedEncryption: messageToAdd.unsupportedEncryption,
        },
        { isActive, windowVisible, viewportAtLiveEdge },
        'room',
        { incrementUnread: incrementUnread && !noteAsTransient, incrementMentions }
      )
      const unreadCount = Math.min(999, updated.unreadCount + overlayUnreadDelta)

      // Get the last non-ignored message for sidebar preview. Use the appended set
      // (not the possibly-gated resident array) so the preview still advances to the
      // incoming message even when the window has slid off the live edge.
      //
      // appendLive sorts its result into cache order
      // (`sortMessagesByTimestamp`) rather than appending in arrival
      // order — so on the ordinary `append.kind ===
      // 'appended'` path, `appendedMessages` is already chronological and
      // `findLastNonIgnoredMessage`'s backward scan finds the true newest
      // message directly. The GATED path is the one that still concatenates
      // naively (`[...resident, messageToAdd]`, no timeline/sort
      // involved at all — the window has slid off the live edge), so a DELAYED
      // arrival (gateway/offline replay, or the MAM {ids} fetch behind deferred
      // poll-closed verification, which emits the ORIGINAL POLL — older than the
      // poll-closed that triggered it) can still land as the array's last
      // element there and would drag the preview backwards. Dedupe can't
      // protect us: appendLive keys off the RESIDENT array, which is empty off
      // the active room. roomMeta is persisted, so an ungated assignment
      // survives a reload. `shouldReplaceLastMessage`'s own timestamp check
      // below is the guard for that case (and remains harmless belt-and-braces
      // on the sorted path); tie: 'replace' so a replay burst sharing one
      // second-precision <delay/> stamp still advances.
      const heldLastMessage = existingMeta?.lastMessage ?? existing.lastMessage
      const previewCandidate = findLastNonIgnoredMessage(appendedMessages, roomJid, existing.nickToJidCache)
      const lastMessage =
        previewCandidate && shouldReplaceLastMessage(heldLastMessage, previewCandidate, 'replace')
          ? previewCandidate
          : heldLastMessage

      // Update lastInteractedAt so the room bubbles up in the sidebar:
      // - Active room: always update (user is viewing it)
      // - Non-active, non-muted: update so room bubbles to top on new messages
      // - Non-active, muted: keep current value (only updates when user opens room)
      const entity = state.roomEntities.get(roomJid)
      const isMuted = entity?.muted ?? existing.muted ?? false
      const newLastInteractedAt = isActive || !isMuted
        ? (lastMessage?.timestamp ?? existing.lastInteractedAt)
        : existing.lastInteractedAt

      // `updated.readPointer` is now committed atomically with `unreadCount` in
      // the very same write: `unreadCount` above is DERIVED from `updated`
      // (plus the overlay delta), so storing it against any pointer other than
      // `updated.readPointer` would re-open the exact divergence this file's
      // last regression review caught (room-pointer-count-divergence) — a
      // count computed relative to one position, filed under a different one.
      // This is also what makes the outgoing-message unread clear (and any
      // other pointer-advancing branch of `onMessageReceived`) stick, keeping a
      // room's read position at parity with chatStore.addMessage on send.
      // `onMessageReceived` only ever advances via `advance()`, which is
      // forward-only, so committing it here unconditionally cannot regress it.
      const written = withRoomMessageWindow(state, roomJid, newMessages, {
        roomPatch: {
          unreadCount,
          mentionsCount: updated.mentionsCount,
          readPointer: updated.readPointer,
          lastMessage,
          lastInteractedAt: newLastInteractedAt,
        },
      })
      if (!written) return state

      // Update metadata
      const newMeta = new Map(state.roomMeta)
      if (existingMeta) {
        newMeta.set(roomJid, {
          ...existingMeta,
          unreadCount,
          mentionsCount: updated.mentionsCount,
          readPointer: updated.readPointer,
          lastMessage,
          lastInteractedAt: newLastInteractedAt,
        })
        // Durable read state (other pointer-committing sites: addRoom,
        // markAsRead, markReadToNewest, advanceReadPointer) all persist
        // through this same helper whenever roomMeta's pointer moves — a live
        // arrival is no exception, or a reload would resurrect the
        // pre-message count.
        persistRoomReadState(newMeta)
      }

      // Session-only divider (parity with chatStore.addMessage).
      const newMarkers = new Map(state.firstNewMessageMarkers)
      if (updated.firstNewMessageId) newMarkers.set(roomJid, updated.firstNewMessageId)
      else newMarkers.delete(roomJid)

      return { ...written, roomMeta: newMeta, firstNewMessageMarkers: newMarkers, ...interiorPlacementPatch }
    })

    const transientMessageIdentity = () => transientIdentity({
      roomJid,
      from: messageToAdd.from,
      id: messageToAdd.id,
      stanzaId: messageToAdd.stanzaId,
      originId: messageToAdd.originId,
    }, 'room')

    if (!acceptedMessage && overlayUnreadDelta > 0) {
      removeTransient(roomTransientScopeKey(roomJid), transientMessageIdentity())
    }

    if (acceptedMessage && !isNoLocalStore(messageToAdd)) {
      const scopeAtSave = getStorageScopeJid()
      const writeToken = roomPendingUnreadWrites.begin(roomJid)
      const save = messageCache.saveRoomMessageWithResult(messageToAdd)
      void save.then((committed) => {
        const owned = roomPendingUnreadWrites.finish(roomJid, writeToken)
        if (!owned || getStorageScopeJid() !== scopeAtSave) return
        if (committed && noteAsTransient) {
          const removed = removeTransient(roomTransientScopeKey(roomJid), transientMessageIdentity())
          if (removed.removed) bumpRoomUnreadInputVersion(roomJid)
        }
        roomRecountRetry.resume(roomJid)
      })
      searchIndex.indexMessage(messageToAdd).catch((e) => console.warn('[searchIndex] indexMessage failed:', e))
    }

    // See `noteTransient`'s doc on `requiresRecount`: only the archive-derived
    // recompute can fold this change back into the stored count. No-ops for
    // the active room.
    if (overlayRequiresRecount) {
      void get().recomputeUnreadForRoom(roomJid)
    }
  },

  updateReactions: (roomJid, messageId, reactorNick, emojis) => {
    set((state) => {
      const newRooms = new Map(state.rooms)
      const existing = newRooms.get(roomJid)
      if (!existing) return state

      // Resolve to a single target: id/stanzaId win, origin-id is fallback only.
      const resident = state.messages.get(roomJid) ?? []
      const targetIdx = findMessageIndexById(resident, messageId)
      let updatedMessage: RoomMessage | undefined
      const newMessages = targetIdx === -1 ? resident : resident.map((msg, i) => {
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
        void messageCache.updateRoomMessage(roomJid, updatedMessage.id, {
          reactions: updatedMessage.reactions,
        }, updatedMessage.from)
      } else {
        // Message not in memory — update reactions directly in IndexedDB cache
        // so the correct state is restored when the message is loaded later
        logInfo(`Reaction for message ${messageId} not in memory — updating in cache`)
        void messageCache.updateRoomMessageReactions(roomJid, messageId, reactorNick, emojis)
      }

      const written = withRoomMessageWindow(state, roomJid, newMessages)
      if (!written) return state
      return written
    })
  },

  updateMessage: (roomJid, messageId, updates) => {
    let recountNeeded = false
    set((state) => {
      const newRooms = new Map(state.rooms)
      const existing = newRooms.get(roomJid)
      if (!existing) return state

      // Resolve to a single target: id/stanzaId win, origin-id is fallback only.
      // Retractions (XEP-0424) reference the MUC stanza-id; corrections (XEP-0308)
      // reference the sender-assigned origin-id (a MUC may rewrite the message id).
      const resident = state.messages.get(roomJid) ?? []
      const targetIdx = findMessageIndexById(resident, messageId)
      let updatedMessage: RoomMessage | undefined
      const newMessages = targetIdx === -1 ? resident : resident.map((msg, i) => {
        if (i !== targetIdx) return msg
        updatedMessage = { ...msg, ...updates }
        return updatedMessage
      })

      // Update IndexedDB (non-blocking) — use actual message id, not the lookup key
      if (updatedMessage) {
        void messageCache.updateRoomMessage(roomJid, updatedMessage.id, updates, updatedMessage.from)

        // Update search index: re-index if body changed, remove if retracted
        if (updates.isRetracted) {
          void searchIndex.removeMessage(updatedMessage)
        } else if (updates.body) {
          void searchIndex.updateMessage(updatedMessage)
        }

        // A retraction may target a `noLocalStore` message noted in
        // the transient overlay (e.g. a Quick Chat message) — drop it so it
        // stops contributing, and schedule a recount if it actually left
        // (safe to call for every retraction: removeTransient is a no-op
        // when the alias was never noted).
        if (updates.isRetracted) {
          const identityFields = {
            roomJid,
            from: updatedMessage.from,
            id: updatedMessage.id,
            stanzaId: updatedMessage.stanzaId,
            originId: updatedMessage.originId,
          }
          const removal = removeTransient(roomTransientScopeKey(roomJid), transientIdentity(identityFields, 'room'))
          if (removal.removed) recountNeeded = true
        }
      }

      const written = withRoomMessageWindow(state, roomJid, newMessages)
      if (!written) return state

      // Update metadata's lastMessage if the updated message is the last one
      const lastMessage = newMessages[newMessages.length - 1]
      const result: Partial<RoomState> = { ...written }
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

    if (recountNeeded) void get().recomputeUnreadForRoom(roomJid)
  },

  clearMessageStanzaId: (roomJid, stanzaId) => {
    set((state) => {
      const existing = state.rooms.get(roomJid)
      if (!existing) return state

      const resident = state.messages.get(roomJid) ?? []
      const targetIdx = resident.findIndex((message) => message.stanzaId === stanzaId)
      if (targetIdx === -1) return state

      const newMessages = [...resident]
      const { stanzaId: _staleStanzaId, ...updatedMessage } = resident[targetIdx]
      newMessages[targetIdx] = updatedMessage

      void messageCache.updateRoomMessage(roomJid, resident[targetIdx].id, { stanzaId: undefined }, resident[targetIdx].from)

      const written = withRoomMessageWindow(state, roomJid, newMessages)
      if (!written) return state

      const result: Partial<RoomState> = { ...written }
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

  recordPendingRetraction: (roomJid, targetId, actorJid, actorOccupantId) => {
    const record: PendingRetraction = {
      targetId,
      actorJid,
      ...(actorOccupantId ? { actorOccupantId } : {}),
      retractedAt: Date.now(),
    }
    const resident = get().messages.get(roomJid) ?? []
    const target = findMessageById(resident, targetId)
    if (target) {
      // Resolved on the spot — updateMessage carries the write-through to
      // IndexedDB and the search-index removal.
      if (!target.isRetracted && roomRetractionAuthor(target, record)) {
        get().updateMessage(roomJid, target.id, { isRetracted: true, retractedAt: new Date() })
      }
      return
    }

    set((state) => {
      const existing = state.pendingRetractions.get(roomJid) ?? []
      const next = addPendingRetraction(existing, record)
      if (next === existing) return state
      const nextPending = new Map(state.pendingRetractions)
      nextPending.set(roomJid, next)
      savePendingRetractionsToStorage(nextPending)
      return { pendingRetractions: nextPending }
    })
  },

  getMessage: (roomJid, messageId) => {
    return findMessageById(get().messages.get(roomJid) ?? [], messageId)
  },

  recomputeUnreadForRoom: async (roomJid, options) => {
    const allowActive = options?.allowActive ?? false
    const defer = (reason: RecountDeferralReason): void => {
      recordRecountDeferral('room', reason)
      if (reason === 'input-version-changed') {
        roomRecountRetry.schedule(
          roomJid,
          allowActive,
          (retryOptions) => get().recomputeUnreadForRoom(roomJid, retryOptions),
          () => roomRecountReady(roomJid)
        )
      }
    }
    // Active room counts are usually reconciled by their own synchronous path
    // (the live-edge convergence) — skip here to avoid a redundant
    // race, UNLESS the caller explicitly opted in (a remote XEP-0490
    // advance on the active room, which that convergence path never runs for).
    if (!allowActive && get().activeRoomJid === roomJid) return defer('active-skipped')

    // --- Defer conditions -----------------------------------------------
    //
    // ONE snapshot, read once, and every defer below decided against it — the
    // same object the derivation itself computes from. Do NOT add a second
    // `get()` and a second copy of a guard up here (#1174). Two reads make
    // "which snapshot did we check?" answerable two ways, and they make each
    // copy unfalsifiable: both read the same state and evaluate the same pure
    // predicate, so disabling one leaves the other deferring and the whole
    // suite green. With one read, deleting the guard fails a test.
    //
    // The duplicate this replaced was justified as being "the correct check the
    // moment anything above it starts to await". That was not true: both copies
    // sat on the same side of every await, so the duplication straddled nothing
    // — it bought a coincidence, not a defence.
    //
    // Every guard here still sits ABOVE the first await
    // (`resolveCoverageBottom` below), so nothing can move underneath them
    // while they run. State that moves AFTER them is caught on the far side by
    // `recountContextDeferral()` and by the `pointerIdAtCompute` re-check at
    // the final commit. That is where a post-await guard belongs — so if an
    // await is ever inserted above this block, the fix is a re-check after THAT
    // await, not a second copy on this side.
    //
    // One guard also means ONE emission site for the `pointerless-defer` reason
    // (#1214), so a recorded pointerless defer is unambiguous about which check
    // produced it.
    //
    // Pointerless-with-a-trusted-nonzero-count stands down — see chatStore's
    // `recomputeUnreadForConversation` for the full rationale (mirrored here
    // verbatim): a bare zero derived for a room that has never established a
    // read position cannot be told apart from a real "all read", and the count
    // it would overwrite was accumulated live.
    //
    // This derivation NEVER writes the read pointer. Neither snapping a
    // pointerless room to the newest message nor advancing the pointer onto an
    // outgoing message in range belongs here, and the second is worse in a MUC
    // than anywhere else: `isOutgoing` is attributed by nick, so a
    // misattribution would silently destroy the read position, permanently (the
    // pointer is forward-only). A pointerless room counts from its
    // `historyFloor` creation watermark, and a reply sent from another device
    // moves the read position only through XEP-0490.
    const metaNow = get().roomMeta.get(roomJid)
    if (!metaNow) return defer('no-meta')
    if (metaNow.pendingRemoteDisplayedStanzaId !== undefined) return defer('pending-remote-displayed')
    if (pointerlessDefers(metaNow.readPointer, metaNow.unreadCount)) return defer('pointerless-defer')

    // Latest-wins: bumped once this call is committed to
    // running — AFTER the defers above, so a call that stands down cannot
    // cancel a recount already in flight for the same room — and still before
    // the first await, then re-checked immediately before every commit below,
    // so a slow recount that resolves after a faster, newer one for the SAME
    // room is discarded instead of overwriting the newer (correct) result.
    const version = bumpRoomRecountVersion(roomJid)
    const cacheEpochAtStart = roomCacheEpoch
    const entityEpochAtStart = currentRoomEntityEpoch(roomJid)
    const storageScopeAtStart = getStorageScopeJid()
    const unreadInputVersionAtStart = roomUnreadInputVersion.get(roomJid) ?? 0
    const recountContextDeferral = (): RecountDeferralReason | undefined => {
      if (roomCacheEpoch !== cacheEpochAtStart || currentRoomEntityEpoch(roomJid) !== entityEpochAtStart || getStorageScopeJid() !== storageScopeAtStart) {
        return 'context-changed'
      }
      if (roomRecountVersion.get(roomJid) !== version) return 'recount-superseded'
      if ((roomUnreadInputVersion.get(roomJid) ?? 0) !== unreadInputVersionAtStart) {
        return 'input-version-changed'
      }
      return undefined
    }

    // Snapshot the pointer identity the archive-derived count below is
    // computed against. Re-check it at the final commit because an
    // allowActive recount can race advanceReadPointer.
    const pointerIdAtCompute = metaNow.readPointer?.identity.messageId
    const unreadInputVersionAtCompute = roomUnreadInputVersion.get(roomJid) ?? 0

    const floor = computeFloor(metaNow.readPointer, metaNow.historyFloor)
    if (!floor) return defer('no-floor')

    // --- Coverage gate: every uncertain branch defers -
    const mam = mamState.getMAMQueryState(get().mamQueryStates, roomJid)
    if (!isCaughtUpForCounting(mam)) return defer('history-not-caught-up')

    const record = get().roomCoverage.get(roomJid)
    const bottom = await resolveCoverageBottom(roomJid, record, true)
    const coverageContextDeferral = recountContextDeferral()
    if (coverageContextDeferral) return defer(coverageContextDeferral)
    if (bottom === 'missing') return defer('coverage-missing')
    if (bottom === 'unresolvable') {
      // Invalidate the stale record so a later merge can re-establish it,
      // guarded on the SAME bottomId so a record that already moved on (a
      // concurrent merge) is not clobbered.
      if (record) get().clearRoomCoverage(roomJid, record.bottomId)
      return defer('coverage-unresolvable')
    }
    // The boundary: the pointer's own order when there is one, so the
    // comparison is not blind to a coverage bottom sharing its exact
    // millisecond; a historyFloor-derived boundary knows only a millisecond and
    // says so (unresolved sorts conservatively).
    const floorPos: PointerOrder = metaNow.readPointer?.order ?? { role: 'floor', timestamp: floor.getTime() }

    // Safety net: this recompute is one of the "pointer advance / content
    // settled" triggers, and not every trigger path calls pruneTransient
    // directly.
    pruneTransient(roomTransientScopeKey(roomJid), floorPos)

    // A BOUNDARY test: a FLOOR (migrated) boundary reads as at-or-after its
    // millisecond, so an equal-ms bottom counts as not reaching it (#1173).
    if (isAfterBoundary(bottom, floorPos)) return defer('coverage-short-of-floor') // coverage doesn't reach the floor

    const res = await messageCache.countRoomUnreadInArchive(roomJid, {
      floor,
      pointer: metaNow.readPointer?.order,
    })
    const countContextDeferral = recountContextDeferral()
    if (countContextDeferral) return defer(countContextDeferral)
    if (res === null) return defer('cache-unavailable') // unavailable — IndexedDB error

    // --- Latest-wins commit ---------------------------
    if (roomRecountVersion.get(roomJid) !== version) return defer('recount-superseded')
    if ((roomUnreadInputVersion.get(roomJid) ?? 0) !== unreadInputVersionAtCompute) {
      return defer('input-version-changed')
    }

    const transient = transientCounts(roomTransientScopeKey(roomJid), floorPos)
    const unreadCount = Math.min(999, res.unread + transient.unread)

    set((state) => {
      // The commit-time twins of the guards above. A recount can pass every
      // pre-commit check and still be superseded during the final `set`.
      const commitContextDeferral = recountContextDeferral()
      if (commitContextDeferral) { defer(commitContextDeferral); return state }
      if (roomRecountVersion.get(roomJid) !== version) { defer('recount-superseded'); return state }
      if ((roomUnreadInputVersion.get(roomJid) ?? 0) !== unreadInputVersionAtCompute) {
        defer('input-version-changed')
        return state
      }
      if (!allowActive && state.activeRoomJid === roomJid) { defer('active-skipped'); return state }
      const meta = state.roomMeta.get(roomJid)
      if (!meta) { defer('no-meta'); return state }

      // `res.unread` was derived against `pointerIdAtCompute`
      // (metaNow.readPointer, captured before the coverage-bottom and
      // countRoomUnreadInArchive awaits). roomRecountVersion only orders this
      // recompute against ANOTHER recompute for the same room — it does NOT
      // order it against a direct writer like onMessageReceived's own
      // live-edge convergence, which advances the pointer and commits a
      // fresh, correct unreadCount without bumping the version. An
      // allowActive recompute (this trigger's whole point is to run while
      // still active) can therefore be in flight exactly when that direct
      // write lands. Re-reading the pointer here and bailing if it moved
      // means a result computed against a now-stale pointer never clobbers
      // the newer, correct value. An input change queues the bounded trailing
      // retry; a direct pointer advance launches its own recount.
      if (meta.readPointer?.identity.messageId !== pointerIdAtCompute) {
        defer('pointer-changed')
        return state
      }

      // Re-derive only to decide whether a background marker remains valid. The active visit's
      // landmark is preserved below.
      let newMarkers = state.firstNewMessageMarkers
      const parkedDivider = state.firstNewMessageMarkers.get(roomJid)
      if (parkedDivider !== undefined) {
        // No `historyFloor` here, deliberately: this rederivation runs only when
        // a marker is still parked, and deactivation deletes the marker for
        // every non-active room — so the only recounts that get here are the
        // `allowActive` ones, both triggered by a pointer advance.
        // `computeFloor` is pointer-wins.
        // This also reads only the resident `messages` array, with
        // no cache fallback. For a room holding a parked marker over an EMPTY
        // resident array `onActivate` finds no divider position, and the
        // `parkedDivider` fallback below then decides by activity: an ACTIVE
        // room keeps the divider the reader is looking at, while a BACKGROUND
        // one has its stale marker retired. That empty-slice case is unreachable
        // today — activation is the sole owner of the marker, and it always
        // hydrates the resident array before ever setting one — but if that
        // invariant ever breaks, the failure direction is at worst a lost "new
        // messages" divider for a background room, not a miscounted or corrupted
        // read pointer.
        const slice = state.messages.get(roomJid) ?? []
        const divider = notifState.onActivate(
          { unreadCount: 0, mentionsCount: 0, readPointer: meta.readPointer, firstNewMessageId: undefined },
          slice,
          'room'
        ).firstNewMessageId
        // The ACTIVE room's divider does not move. It marks where the unread messages began when
        // this view was opened, so it has to outlive the reading that follows: the pointer advances
        // under it as the viewport reports rows seen, and re-deriving a position from that pointer
        // would walk the line down the screen while the reader is looking at it. Only activation
        // places it; the explicit read-through, Esc, mark-all-read and deactivation paths remove
        // it. A BACKGROUND room still gets its stale marker retired.
        const nextDivider = state.activeRoomJid === roomJid ? parkedDivider : divider
        if (nextDivider !== parkedDivider) {
          newMarkers = new Map(state.firstNewMessageMarkers)
          if (nextDivider) newMarkers.set(roomJid, nextDivider)
          else newMarkers.delete(roomJid)
        }
      }

      // unreadCount commits unconditionally on `exact`; mentionsCount is
      // never written — the spread below preserves it (and
      // anything else on `meta`) untouched.
      if (meta.unreadCount === unreadCount && newMarkers === state.firstNewMessageMarkers) return state

      const newMeta = new Map(state.roomMeta)
      newMeta.set(roomJid, { ...meta, unreadCount })
      const room = state.rooms.get(roomJid)
      if (!room) return { roomMeta: newMeta, firstNewMessageMarkers: newMarkers }
      const newRooms = new Map(state.rooms)
      newRooms.set(roomJid, { ...room, unreadCount })
      return { roomMeta: newMeta, rooms: newRooms, firstNewMessageMarkers: newMarkers }
    })
  },

  getRoomLastTimestamp: (roomJid) => {
    const state = get()
    return lastMessageTimestamp(state.roomMeta, state.rooms, roomJid)
  },

  markAsRead: (roomJid) => {
    set((state) => {
      const existing = state.rooms.get(roomJid)
      if (!existing) return {}

      const meta = state.roomMeta.get(roomJid)
      const notifInput: notifState.EntityNotificationState = {
        unreadCount: meta?.unreadCount ?? existing.unreadCount,
        mentionsCount: meta?.mentionsCount ?? existing.mentionsCount,
        readPointer: meta?.readPointer ?? existing.readPointer,
        firstNewMessageId: state.firstNewMessageMarkers.get(roomJid),
      }

      const messages = state.messages.get(roomJid) ?? []

      const windowAtLiveEdge = state.windowAtLiveEdge.get(roomJid) !== false
      const viewportAtLiveEdge =
        currentViewportEvidence(roomViewportEvidenceKey(roomJid)) === 'at-edge'
      const updated = notifState.onMarkAsRead(notifInput, messages, 'room', {
        windowAtLiveEdge,
        viewportAtLiveEdge,
      })

      // Skip update if no change
      if (updated === notifInput) return {}

      // The read pointer just moved (or the counts were cleared) — bound the
      // transient overlay's memory now rather than waiting for a later
      // recompute trigger.
      if (updated.readPointer && updated.readPointer !== notifInput.readPointer) {
        pruneTransient(roomTransientScopeKey(roomJid), updated.readPointer.order)
      }

      const newRooms = new Map(state.rooms)
      newRooms.set(roomJid, { ...existing, unreadCount: updated.unreadCount, mentionsCount: updated.mentionsCount, readPointer: updated.readPointer })

      const newMeta = new Map(state.roomMeta)
      const newMetaEntry = {
        ...(meta ?? { unreadCount: 0, mentionsCount: 0, typingUsers: new Set<string>() }),
        unreadCount: updated.unreadCount,
        mentionsCount: updated.mentionsCount,
        readPointer: updated.readPointer,
      }
      newMeta.set(roomJid, newMetaEntry)
      persistRoomReadState(newMeta)

      return { rooms: newRooms, roomMeta: newMeta }
    })
  },

  markReadToNewest: (roomJid) => {
    remoteDividerAdvances.clear(roomJid)
    set((state) => {
      const existing = state.rooms.get(roomJid)
      if (!existing) return state

      const slice = state.messages.get(roomJid)
      const resident = slice?.length ? slice : (state.messages.get(roomJid) ?? [])
      const newest = resident[resident.length - 1] ?? existing.lastMessage
      if (!newest) return state

      // Skip update if already fully read: pointer at the computed newest id,
      // no unread/mentions, and no "new messages" divider to clear.
      const meta = state.roomMeta.get(roomJid)
      const currentSeenMessageId = (meta?.readPointer ?? existing.readPointer)?.identity.messageId
      const currentUnreadCount = meta?.unreadCount ?? existing.unreadCount
      const currentMentionsCount = meta?.mentionsCount ?? existing.mentionsCount
      if (
        currentSeenMessageId === newest.id &&
        currentUnreadCount === 0 &&
        currentMentionsCount === 0 &&
        !state.firstNewMessageMarkers.has(roomJid)
      ) {
        return state
      }

      const read = {
        readPointer: makeReadPointer(newest, 'room'),
        unreadCount: 0,
        mentionsCount: 0,
      }

      // Mark-all-read jumps the pointer straight to the newest message —
      // prune the overlay now rather than leaving every noted entry to a
      // later recompute trigger.
      pruneTransient(roomTransientScopeKey(roomJid), read.readPointer.order)

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
    if (prevJid) remoteDividerAdvances.clear(prevJid)
    if (roomJid) remoteDividerAdvances.clear(roomJid)

    // Deactivating the previous room clears its "new messages" marker (if any)
    // and evicts its resident window. The durable copy stays in IndexedDB and
    // is rehydrated by `activateRoom` on return.
    if (prevJid && prevJid !== roomJid) {
      const hadMarker = get().firstNewMessageMarkers.has(prevJid)

      set((state) => {
        // Drop the deactivated room's window; the writer keeps the `messages`
        // map reference stable when that window is already empty.
        const evicted = withRoomMessageWindow(state, prevJid, [])

        const newMarkers = new Map(state.firstNewMessageMarkers)
        if (hadMarker) newMarkers.delete(prevJid)

        return { ...evicted, firstNewMessageMarkers: newMarkers }
      })
    }

    if (roomJid) {
      // Begin a fresh viewport-evidence generation SYNCHRONOUSLY, before the
      // `set()` calls below make this activation visible to subscribers/renders — the
      // SOLE call site for `beginViewportGeneration` (mirrors chatStore's
      // setActiveConversation). Runs whether or not `room` resolves below.
      beginViewportGeneration(roomViewportEvidenceKey(roomJid))

      const room = get().rooms.get(roomJid)
      if (room) {
        const meta = get().roomMeta.get(roomJid)
        const notifInput: notifState.EntityNotificationState = {
          unreadCount: meta?.unreadCount ?? room.unreadCount,
          mentionsCount: meta?.mentionsCount ?? room.mentionsCount,
          readPointer: meta?.readPointer ?? room.readPointer,
          // The read BOUNDARY, not just the pointer: a room that has never been
          // read has no pointer, and the join watermark is then the only floor
          // the divider can derive from. `computeFloor` is
          // pointer-wins, so this only matters for the pointerless case.
          historyFloor: meta?.historyFloor ?? room.historyFloor,
          firstNewMessageId: get().firstNewMessageMarkers.get(roomJid),
        }

        const messages = get().messages.get(roomJid) ?? []
        // Position the divider at the first message the canonical count would
        // count — same floor, same predicate (see onActivate).
        const activated = notifState.onActivate(notifInput, messages, 'room')

        // Determine lastInteractedAt for sidebar sorting
        const lastMessage = messages[messages.length - 1]
        const lastMessageTimestamp = room.lastMessage?.timestamp ?? lastMessage?.timestamp
        const newLastInteractedAt = lastMessageTimestamp ?? room.lastInteractedAt

        set((state) => {
          const newMetaEntry = {
            ...(meta ?? { unreadCount: 0, mentionsCount: 0, typingUsers: new Set<string>() }),
            unreadCount: activated.unreadCount,
            mentionsCount: activated.mentionsCount,
            readPointer: activated.readPointer,
            lastInteractedAt: newLastInteractedAt,
          }
          const newMeta = new Map(state.roomMeta)
          newMeta.set(roomJid, newMetaEntry)
          persistRoomReadState(newMeta)
          const newRooms = new Map(state.rooms)
          newRooms.set(roomJid, {
            ...room,
            unreadCount: activated.unreadCount,
            mentionsCount: activated.mentionsCount,
            readPointer: activated.readPointer,
            lastInteractedAt: newLastInteractedAt,
          })
          const newMarkers = new Map(state.firstNewMessageMarkers)
          if (activated.firstNewMessageId) newMarkers.set(roomJid, activated.firstNewMessageId)
          else newMarkers.delete(roomJid)
          return { roomMeta: newMeta, rooms: newRooms, activeRoomJid: roomJid, firstNewMessageMarkers: newMarkers }
        })
        // final-fix-2: reconcile the room we just LEFT (see the trigger below
        // the final fallback `set()` for the full rationale, including the
        // `worthReconcilingOnDeactivate` guard). By this point activeRoomJid
        // already reads `roomJid`, not `prevJid`, so the ordinary
        // (non-allowActive) guard in recomputeUnreadForRoom does not see
        // prevJid as active and proceeds normally.
        if (prevJid && prevJid !== roomJid && worthReconcilingOnDeactivate(get().roomMeta.get(prevJid))) {
          void get().recomputeUnreadForRoom(prevJid)
        }
        // ...and reconcile the room we just ENTERED. That convergence is
        // implemented as a SIDE EFFECT of the read pointer moving:
        // advanceReadPointer only schedules a recount `if (pointerAdvanced)`,
        // and onMessageSeen returns its input unchanged once the pointer sits
        // on the newest loaded message. So a reader who opens a room already at
        // the live edge, with the pointer already at the newest message, makes
        // every viewport report a no-op — the pointer has nowhere left to move,
        // no recount is ever scheduled, and a stale count sits in the sidebar
        // for as long as the room stays open. Activation was the one entry
        // point with no recount of its own (arrival, remote XEP-0490 marker,
        // MAM merge and DEACTIVATION all had one), which is exactly why the
        // gap was invisible: leaving the room repaired it, so the badge only
        // looked stuck while you were looking at it.
        //
        // This does NOT reinstate an unconditional zero.
        // Such a zero is a WRITE — it forces 0 while snapping the pointer only
        // to just-before-the-divider, leaving a count of zero beside a divider
        // marking genuinely unread messages. This is a DERIVATION against the
        // current pointer: a room with real unread keeps a real count, and the
        // divider is repositioned, never retired, while the room is active (see
        // the reposition-only branch in recomputeUnreadForRoom). `allowActive`
        // is required — the room is active by the `set()` above — and mirrors
        // advanceReadPointer's own trigger.
        //
        // Guarded on a nonzero count: with the badge already clear there is
        // nothing to correct downward, and an arrival would recount anyway, so
        // an unguarded call would buy a cache read on every room open.
        if (activated.unreadCount > 0) {
          void get().recomputeUnreadForRoom(roomJid, { allowActive: true })
        }
        return
      }
    }
    // Clearing active room or room not found
    set({ activeRoomJid: roomJid })
    // final-fix-2: deactivation is the other trigger this fix adds (the twin
    // of advanceReadPointer's live-edge trigger below). That convergence
    // advances the READ POINTER while a room is active but never re-derives
    // the COUNT for it — advanceReadPointer now schedules that recount itself
    // while still active, but a room that never received another arrival
    // after the pointer advanced would otherwise carry its stale count
    // forward until the NEXT arrival bumped it. Reconciling on deactivation
    // closes that gap: the ordinary (non-allowActive) form is correct here —
    // activeRoomJid has just been set above (to `roomJid`, possibly null), so
    // prevJid reads as genuinely inactive and the guard proceeds rather than
    // skipping.
    //
    // `worthReconcilingOnDeactivate` skips a truly fresh room (no read pointer
    // ever established AND unreadCount already 0) — there is nothing this
    // recompute could correct, and calling it anyway would cost a real cache
    // read for every close of a never-opened, never-unread room. A room that
    // was genuinely read (a pointer exists) or genuinely has unread (a
    // nonzero count) still triggers, which is what the acceptance scenario
    // needs.
    if (prevJid && prevJid !== roomJid && worthReconcilingOnDeactivate(get().roomMeta.get(prevJid))) {
      void get().recomputeUnreadForRoom(prevJid)
    }
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
      // XEP-0490: fold any pending remote read position into the read pointer
      // BEFORE setActiveRoom derives the new-message divider (parity with
      // chatStore.activateConversation). Forward-only against the loaded
      // messages, and applied only once per distinct RESOLVED marker this
      // session — a fold that could not order the marker against the local
      // pointer stays retryable, while a resolved one is never re-folded (that
      // would reposition the divider on every return). Gate + retry policy live
      // in shared/readMarkerSync.
      const foldOnce = (stage: string) => {
        const lastSeenBefore = get().roomMeta.get(roomJid)?.readPointer?.identity.messageId
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
            lastSeenAfter: get().roomMeta.get(roomJid)?.readPointer?.identity.messageId,
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
      // slice, reload the window AROUND it (IndexedDB only) so the entry
      // scroll can anchor on the divider with the history the user already
      // read sitting above it. The fold above ran first — it may have advanced
      // the pointer to the synced position.
      //
      // The DIVIDER does not depend on this load. `onActivate` derives it by
      // cache POSITION — the first renderable incoming message strictly after
      // the pointer in `(timestamp, tiebreak)` order — so an off-slice
      // pointer places it exactly as well as a resident one. The stale-pointer
      // fallback ladder that made an off-slice pointer a degraded case is gone.
      // What a cache miss costs is CONTEXT: the latest slice is kept, the
      // divider lands wherever the boundary falls inside it, and MAM catch-up
      // heals the cache for the next open.
      const pointer = get().roomMeta.get(roomJid)?.readPointer?.identity.messageId
      if (pointer) {
        const loaded = get().messages.get(roomJid) ?? []
        if (!loaded.some((m) => m.id === pointer)) {
          await get().loadMessagesAroundFromCache(roomJid, pointer)
          if (token !== activationToken) return
          // Retry against the post-load slice: it may now contain both the
          // local pointer and remote marker needed for archive-index ordering.
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
    remoteDividerAdvances.clear(roomJid)
    set((state) => {
      const next = clearMarker(state.firstNewMessageMarkers, roomJid)
      return next ? { firstNewMessageMarkers: next } : state
    })
  },

  resyncDividerToReadPointer: (roomJid) => {
    set((state) => {
      if (!state.firstNewMessageMarkers.has(roomJid)) return state
      const meta = state.roomMeta.get(roomJid)
      const existing = state.rooms.get(roomJid)
      if (!meta && !existing) return state
      const messages = state.messages.get(roomJid) ?? []
      const readPointer = meta?.readPointer ?? existing?.readPointer

      const divider = notifState.onActivate(
        {
          unreadCount: 0,
          mentionsCount: 0,
          readPointer,
          // Pointerless rooms reach this too (the divider can be parked by an
          // arrival while the window was hidden), and their only boundary is
          // the join watermark.
          historyFloor: meta?.historyFloor ?? existing?.historyFloor,
          firstNewMessageId: undefined,
        },
        messages,
        'room'
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

  advanceReadPointer: (roomJid, messageId) => {
    // Presence gate (issue #1076): the viewport observer reports what is PAINTED,
    // and the list auto-scrolls to arriving messages whether or not the user is
    // at the window. Without this check a backgrounded client marks every new
    // message read in real time — the pointer rides the live edge, the "new
    // messages" divider never survives to the next open, and the bogus position
    // is published to other devices over XEP-0490. Rendered is not seen.
    //
    // This gate is independent of
    // where the count comes from — painted is not seen — so nothing in the
    // derived-count model makes it redundant.
    if (!connectionStore.getState().windowVisible) return

    let pointerAdvanced = false
    set((state) => {
      const existing = state.rooms.get(roomJid)
      const meta = state.roomMeta.get(roomJid)
      if (!existing) return state

      const messages = state.messages.get(roomJid) ?? []

      const notifInput: notifState.EntityNotificationState = {
        unreadCount: meta?.unreadCount ?? existing.unreadCount,
        mentionsCount: meta?.mentionsCount ?? existing.mentionsCount,
        readPointer: meta?.readPointer ?? existing.readPointer,
        firstNewMessageId: state.firstNewMessageMarkers.get(roomJid),
      }
      const atLiveEdge = state.windowAtLiveEdge.get(roomJid) !== false
      const updated = notifState.onMessageSeen(notifInput, messageId, messages, 'room', { atLiveEdge })
      if (updated === notifInput) return state

      pointerAdvanced = true

      // The viewport-driven pointer just advanced — bound the transient
      // overlay's memory.
      if (updated.readPointer) {
        pruneTransient(roomTransientScopeKey(roomJid), updated.readPointer.order)
      }

      const newRooms = new Map(state.rooms)
      newRooms.set(roomJid, { ...existing, readPointer: updated.readPointer })

      const newMeta = new Map(state.roomMeta)
      if (meta) {
        newMeta.set(roomJid, { ...meta, readPointer: updated.readPointer })
        persistRoomReadState(newMeta)
      }

      return { rooms: newRooms, roomMeta: newMeta }
    })

    // onMessageSeen only ever moves the
    // pointer — it never recomputes unreadCount. Without this trigger, an
    // active room's pointer could converge to the live edge (acceptance
    // scenario 5) while the sidebar badge kept its stale pre-convergence
    // value until the next arrival or the next activation. `allowActive:
    // true` is safe here because a pointer only ever advances against the
    // RESIDENT messages array, which only the active room keeps (setActiveRoom
    // evicts everyone else's) — this trigger only ever fires for the room
    // that is, in practice, active.
    if (pointerAdvanced) {
      void get().recomputeUnreadForRoom(roomJid, { allowActive: true })
    }
  },

  applyRemoteDisplayed: (roomJid, stanzaId, messagesOverride) => {
    // Set when the resolution advanced the pointer on a NON-active room —
    // triggers the archive-derived recount below.
    let advancedNonActive = false
    // Set when the resolution advanced the pointer on the ACTIVE room.
    // Activation writes no unconditional zero, so the active room's count is
    // not "already zero" here — it needs the same archive-derived re-derivation
    // as the non-active case, just with the active-room skip in
    // recomputeUnreadForRoom explicitly bypassed (`allowActive: true`).
    let advancedActive = false
    set((state) => {
      const meta = state.roomMeta.get(roomJid)
      const existing = state.rooms.get(roomJid)
      if (!meta) return state

      // A non-active room keeps no resident array (memory windowing), so
      // mergeRoomMAMMessages passes the just-merged array here; else read the
      // window map, falling back to the compat entry.
      // The resolution state machine (stash / clear-pending / forward-only
      // advance) is shared — see shared/readMarkerSync.
      const messages = messagesOverride ?? state.messages.get(roomJid) ?? []
      const resolution = resolveRemoteDisplayed(
        {
          unreadCount: meta.unreadCount,
          mentionsCount: meta.mentionsCount,
          readPointer: meta.readPointer,
          pendingRemoteDisplayedStanzaId: meta.pendingRemoteDisplayedStanzaId,
        },
        messages,
        state.firstNewMessageMarkers.get(roomJid),
        stanzaId,
        'room',
        // Rooms treat delayed history the same as chats treat offline delivery
        // (unified divider semantics) — delayed messages after the pointer are new.
        { isActive: state.activeRoomJid === roomJid }
      )
      if (resolution.kind === 'unchanged') return state

      const clearsPending = meta.pendingRemoteDisplayedStanzaId === stanzaId
      const metaPatch =
        resolution.kind === 'stash-pending'
          ? { pendingRemoteDisplayedStanzaId: stanzaId }
          : resolution.kind === 'clear-pending'
            ? { pendingRemoteDisplayedStanzaId: undefined }
            : resolution.kind === 'resolved-active'
              ? clearsPending
                ? { pendingRemoteDisplayedStanzaId: undefined }
                : undefined
            : {
                readPointer: resolution.readPointer,
                ...(clearsPending && { pendingRemoteDisplayedStanzaId: undefined }),
              }

      // Inbound read-state sync (spec §4): a marker published by another
      // client advances this room's read position now, not on the next
      // activation. The pointer keeps the forward-only position resolved
      // above (metaPatch.readPointer) — the unread COUNT is not derived
      // from this page-scoped slice (it may be a single merged page of
      // a multi-page pointer-stitch walk, which undercounts): both advance
      // kinds instead schedule the archive-derived recount below, which is
      // ALSO what makes a not-yet-caught-up room defer rather than commit a
      // wrong number. mentionsCount is left untouched (the spread above
      // preserves it) — archive recounts never write it either.
      // 'advanced-active' (the active room) is NOT exempted here: its
      // counts are not "already zero", so the active room needs this
      // re-derivation exactly as much as a non-active one does.
      if (resolution.kind === 'advanced') {
        advancedNonActive = true
      } else if (resolution.kind === 'advanced-active') {
        advancedActive = true
      }

      // The line follows a marker another client published: that marker states those messages were
      // read, so leaving the divider in front of them would mark as new what the user has already
      // seen. Scrolling THIS view is not such evidence and does not come through here.
      let newMarkers = state.firstNewMessageMarkers
      // The line follows a marker only when it reaches FURTHER than anything this client has told
      // the account it read. Publishing pushes to every resource of the account, so a marker at or
      // behind our own last published position is our own scroll coming back — live, replayed, or
      // re-read from the node on reconnect — and letting it move the line would make scrolling move
      // it through a loop. Past that position it carries something we never claimed, whoever sent
      // it. The wire cannot name the publisher; this is the question that can be answered.
      if (resolution.kind === 'advanced-active' || resolution.kind === 'resolved-active') {
        const markerPointer = resolution.kind === 'resolved-active'
          ? resolution.markerPointer
          : resolution.readPointer
        const claimed = locallyPublishedDisplayed(
          getBareJid(connectionStore.getState().jid ?? ''),
          roomJid,
        )
        if (claimed === undefined || isAhead(markerPointer, claimed)) {
          const dividerAdvance = remoteDividerAdvances.apply(
            roomJid,
            state.firstNewMessageMarkers.get(roomJid),
            markerPointer,
            messages,
            'room',
          )
          if (dividerAdvance.kind === 'advanced') {
            newMarkers = new Map(state.firstNewMessageMarkers)
            newMarkers.set(roomJid, dividerAdvance.divider)
          }
        }
      }
      // `resolved-active` exists only to give a live divider a chance to move; it advances no
      // pointer. When the divider did not move and no pending marker needed clearing, nothing
      // changed — and rebuilding the entry here would re-derive it and re-render every consumer on
      // each echo of this client's own scrolling.
      if (
        resolution.kind === 'resolved-active' &&
        newMarkers === state.firstNewMessageMarkers &&
        metaPatch === undefined
      ) {
        return state
      }

      const newMeta = metaPatch ? new Map(state.roomMeta) : state.roomMeta
      if (metaPatch) newMeta.set(roomJid, { ...meta, ...metaPatch })

      // A position another device read to is a read position like any other —
      // persist it. The stash/clear kinds move no pointer.
      if (resolution.kind === 'advanced' || resolution.kind === 'advanced-active') {
        persistRoomReadState(newMeta)
      }

      if (existing && metaPatch) {
        // Keep the combined map coherent with roomMeta.
        const newRooms = new Map(state.rooms)
        newRooms.set(roomJid, { ...existing, ...metaPatch })
        return { roomMeta: newMeta, rooms: newRooms, firstNewMessageMarkers: newMarkers }
      }
      return { roomMeta: newMeta, firstNewMessageMarkers: newMarkers }
    })

    // Archive-derived recount (trigger: pointer advance / inbound
    // marker). recomputeUnreadForRoom re-derives the count from the durable
    // archive (its own resident-or-cache slice, independent of
    // `roomRuntime`/`rooms` above), deferring — leaving the last TRUSTED
    // count untouched — whenever coverage isn't proven down to the new floor,
    // rather than committing a page-scoped undercount.
    if (advancedNonActive) {
      void get().recomputeUnreadForRoom(roomJid)
    } else if (advancedActive) {
      // The active room gets the SAME re-derivation, with the
      // active-room skip explicitly bypassed — see this method's doc and
      // recomputeUnreadForRoom's.
      void get().recomputeUnreadForRoom(roomJid, { allowActive: true })
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
        // Create a new room entry from bookmark. This is the SECOND place a
        // room entity is born — a bookmark pushed from another device
        // materialises a room we have never joined — so it stamps the history
        // floor and folds any persisted read state exactly like addRoom.
        const restoredReadState = persistedRoomReadState.get(roomJid)
        const readPosition = resolveRoomReadPosition(undefined, { jid: roomJid } as Room, restoredReadState)
        const historyFloor = restoredReadState?.historyFloor ?? new Date()
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
          unreadCount: 0,
          mentionsCount: 0,
          typingUsers: new Set(),
          ...readPosition,
          historyFloor,
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
          ...readPosition,
          historyFloor,
        })
        persistRoomReadState(newMeta)

        // Create runtime
        newRuntime.set(roomJid, { occupants: new Map() })
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
          const base = update?.windowAtLiveEdge ?? state.windowAtLiveEdge
          if (base.get(roomJid) === true) return update ?? state
          return { ...(update ?? {}), windowAtLiveEdge: new Map(base).set(roomJid, true) }
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
      const resident = get().messages.get(roomJid) ?? []
      if (!get().rooms.has(roomJid) || resident.length === 0) {
        return []
      }

      // Get the oldest message timestamp we have in memory
      const oldestInMemory = resident[0]
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
          const resident = state.messages.get(roomJid) ?? []

          // Dedupe (in-memory messages take precedence), sort, keep-oldest trim
          // (load-older slides the window so scroll-back past the bound works).
          // If keep-oldest evicted the newest resident message, the window has
          // slid off the live edge → gate live appends in addMessage.
          const { merged, newestEvicted } = timeline.loadOlderSlice(
            resident,
            cachedMessages,
            roomTimelineConfig()
          )

          const written = withRoomMessageWindow(state, roomJid, merged,
            newestEvicted ? { atLiveEdge: false } : {})
          if (!written) return state
          return written
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
      const resident = get().messages.get(roomJid) ?? []
      if (!get().rooms.has(roomJid) || resident.length === 0) {
        return []
      }

      // Get the newest message timestamp we have in memory
      const newestInMemory = resident[resident.length - 1]
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
          const resident = state.messages.get(roomJid) ?? []

          // Dedupe (in-memory messages take precedence), sort, keep-newest trim
          // (load-newer slides the window back down toward the live edge).
          const { merged } = timeline.loadNewerSlice(
            resident,
            cachedMessages,
            roomTimelineConfig()
          )

          const written = withRoomMessageWindow(state, roomJid, merged,
            reachedTail ? { atLiveEdge: true } : {})
          if (!written) return state
          return written
        })
      } else if (reachedTail) {
        // Empty batch: still need to flip the flag if the room isn't already at the edge.
        set((state) => {
          if (state.windowAtLiveEdge.get(roomJid) !== false) return state
          return { windowAtLiveEdge: new Map(state.windowAtLiveEdge).set(roomJid, true) }
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
      if (state.windowAtLiveEdge.get(roomJid) === true) return state
      return { windowAtLiveEdge: new Map(state.windowAtLiveEdge).set(roomJid, true) }
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

  mergeRoomMAMMessages: (roomJid, archivePage, page, complete, direction, preserveGapMarker = false, isFetchLatest = false, extras = undefined) => {
    bumpRoomUnreadInputVersion(roomJid)
    const cacheEpochAtMerge = roomCacheEpoch
    const entityEpochAtMerge = currentRoomEntityEpoch(roomJid)
    const storageScopeAtMerge = getStorageScopeJid()

    // XEP-0424: a retraction recorded earlier can target a message arriving in
    // THIS page (the live pass missed it because nothing was resident). Patch
    // the page BEFORE it merges, so the tombstone rides the same saveRoomMessages
    // write instead of racing it. Same array back when nothing matches.
    // Guarded on the room existing: the merge below no-ops for an unknown room,
    // and consuming the record against a page that is never stored would lose it.
    const replay = get().rooms.has(roomJid)
      ? resolveRoomPendingRetractions(get(), roomJid, archivePage, { persist: false })
      : { messages: archivePage, pendingRetractions: undefined }
    const mamMessages = replay.messages
    if (replay.pendingRetractions) set({ pendingRetractions: replay.pendingRetractions })

    // Newest persisted timestamp (entity preview) — the seam-formation fallback
    // when the resident array is empty this run (fresh session, history on disk).
    const fallbackHeldTs = get().getRoomLastTimestamp(roomJid)
    // Captured from inside set() so the post-set MDS marker resolution can read the
    // merged array even for a non-active room (whose array isn't resident).
    let mergedForMarker: RoomMessage[] = []
    // Set when a forward catch-up merge for a non-active room extends
    // contiguous history past the read pointer with new messages — triggers
    // the archive-derived recount after this set().
    let shouldRecountAfterMerge = false
    let archiveCommitGate: Promise<boolean> | undefined
    let durableMessages: RoomMessage[] = []
    set((state) => {
      const room = state.rooms.get(roomJid)
      if (!room) return state

      // Get existing messages for this room
      const existingMessages = state.messages.get(roomJid) ?? []

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
        void messageCache.updateRoomMessage(roomJid, p.id, { stanzaId: p.stanzaId!, ...(p.originId ? { originId: p.originId } : {}) }, p.from)
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
        page.first, // Pagination cursor for fetching older messages
        newestFetchedTimestamp,
        preserveGapMarker,
        isFetchLatest,
        mamState.isDisjointFromResidentWindow(existingMessages, extras?.initialBefore, isFetchLatest)
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
        lastFetchedArchiveId: page.last,
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
      // Crash-window safety (Codex r3 #1/#2, r4 #1): the gap map is persisted
      // synchronously (localStorage) while saveRoomMessages to IndexedDB is
      // fire-and-forget AND absorbs errors. Persisting a transition whose
      // cursors reference THIS merge's page before the write commits lets a
      // crash — or a silently failed write — skip the page forever: the
      // resume cursor would point past data that was never stored. That
      // covers deletion, forward startId advance, backward end/endId shrink
      // AND formation (a formed forward gap carries this page's page.last as
      // startId). So EVERY gap transition defers until the durable write
      // reports success when the merge carries persistable messages; with
      // nothing persistable there is no crash window and the transition
      // applies immediately.
      const prevGap = state.roomGaps.get(roomJid)
      const persistableMessages = newFromMAM.filter(msg => !isNoLocalStore(msg))
      durableMessages = persistableMessages
      // A merge with nothing persistable still defers when earlier pages of
      // this room are in flight (or failed): its cursor must not leap them.
      const mustGateOnChain = persistableMessages.length > 0 || roomArchiveSaves.has(roomJid)
      const deferGapCommit =
        newGaps !== state.roomGaps &&
        mustGateOnChain
      const gapsAfterMerge = deferGapCommit ? state.roomGaps : newGaps
      if (gapsAfterMerge !== state.roomGaps) saveGapsToStorage(gapsAfterMerge)

      // Persisted coverage record; see mamCoverage.ts for the durability
      // invariant this defers on. A merge with nothing persistable
      // (signal-only give-up) applies now.
      const { coverage: newCoverage, transition: coverageTransition } = syncCoverageAfterArchiveMerge({
        coverage: state.roomCoverage,
        id: roomJid,
        direction,
        isFetchLatest,
        preserveGapMarker,
        rsmFirst: page.first,
        fetchLatestTopId: extras?.fetchLatestTopId,
        initialBefore: extras?.initialBefore,
        sawCoverageTop: extras?.sawCoverageTop ?? false,
        walkCarriedModifications: extras?.walkCarriedModifications ?? false,
        complete,
        initialAfter: extras?.initialAfter,
      })
      const prevCoverage = state.roomCoverage.get(roomJid)
      const deferCoverageCommit =
        newCoverage !== state.roomCoverage &&
        mustGateOnChain
      const coverageAfterMerge = deferCoverageCommit ? state.roomCoverage : newCoverage
      if (coverageAfterMerge !== state.roomCoverage) {
        saveCoverageToStorage(coverageAfterMerge, undefined, { roomJid, kind: coverageTransition })
      }

      // Deferred commit of the gap/coverage transitions, gated on the given
      // promise (this page's write chained behind every earlier in-flight
      // page — see roomArchiveSaves). Shared by the with-messages path and
      // the nothing-persistable-but-chain-pending path below.
      const epochAtMerge = roomCacheEpoch
      const scheduleDeferredCommit = (gate: Promise<boolean>) => {
        void gate.then((committed) => {
          if (!committed) return
          if (roomCacheEpoch !== epochAtMerge || currentRoomEntityEpoch(roomJid) !== entityEpochAtMerge) return
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
                // Signalled HERE, not at merge time: this is the first write
                // that carries the replacing record.
                saveCoverageToStorage(next, undefined, { roomJid, kind: coverageTransition })
                out.roomCoverage = next
              }
            }
            return Object.keys(out).length > 0 ? out : s
          })
        })
      }

      // If no new messages (all duplicates), only update MAM state - skip room messages
      // This prevents unnecessary re-renders when merging duplicates.
      // Exception: a stanzaId backfill onto existing RAM messages must persist —
      // but only for the ACTIVE room (non-active rooms keep no resident array).
      if (newFromMAM.length === 0) {
        // Nothing of our own to persist, but earlier in-flight pages may
        // still gate this merge's transitions: chain a no-op save so the
        // transition applies (or is dropped) with the same ordering rules.
        if (deferGapCommit || deferCoverageCommit) {
          archiveCommitGate = roomArchiveSaves.chain(roomJid, Promise.resolve(true))
          scheduleDeferredCommit(archiveCommitGate)
        }
        if (patched.length === 0 || state.activeRoomJid !== roomJid) {
          return { mamQueryStates: newStates, roomGaps: gapsAfterMerge, roomCoverage: coverageAfterMerge }
        }
        const backfilled = withRoomMessageWindow(state, roomJid, merged)
        return { ...backfilled, mamQueryStates: newStates, roomGaps: gapsAfterMerge, roomCoverage: coverageAfterMerge }
      }

      // Persist to IndexedDB regardless of active state — this is the durable
      // history that rehydrates on open (search index too).
      if (persistableMessages.length > 0) {
        const savePromise = messageCache.saveRoomMessages(persistableMessages)
        // Serialize through the per-room chain: the gate resolves true only
        // when THIS page and every earlier in-flight page committed.
        const commitGate = roomArchiveSaves.chain(roomJid, savePromise)
        archiveCommitGate = commitGate
        if (deferGapCommit || deferCoverageCommit) {
          scheduleDeferredCommit(commitGate)
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
        // history past the read pointer, so an unopened room may regain its
        // badge after catch-up — the COUNT is derived from the archive (see
        // recomputeUnreadForRoom), never from this page-scoped merged slice.
        // The merge itself writes NO read pointer: a fresh entity's floor
        // comes from the room's `historyFloor`, and an outgoing-message advance
        // would be an inference built on nick-attributed `isOutgoing` that the
        // forward-only pointer cannot take back. Backward merges only prepend
        // older history (nothing after the pointer changes).
        if (direction === 'forward' && newFromMAM.length > 0) shouldRecountAfterMerge = true

        // roomRuntime deliberately untouched.
        return { rooms: newRooms, roomMeta: newMeta, mamQueryStates: newStates, roomGaps: gapsAfterMerge }
      }

      // ACTIVE room: populate the resident array (foreground catch-up / scroll-up).
      const written = withRoomMessageWindow(state, roomJid, merged, {
        roomPatch: { lastMessage },
        ...(newestEvicted
          ? { atLiveEdge: false }
          : isFetchLatest && newFromMAM.length > 0
            ? { atLiveEdge: true }
            : {}),
      })

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

      return { ...written, roomMeta: newMeta, mamQueryStates: newStates, roomGaps: gapsAfterMerge }
    })

    if (archiveCommitGate) {
      void archiveCommitGate.then((committed) => {
        if (!committed || roomCacheEpoch !== cacheEpochAtMerge || currentRoomEntityEpoch(roomJid) !== entityEpochAtMerge || getStorageScopeJid() !== storageScopeAtMerge) return
        let removed = false
        for (const message of durableMessages) {
          const aliases = transientAliases({
            roomJid,
            from: message.from,
            id: message.id,
            stanzaId: message.stanzaId,
            originId: message.originId,
          }, 'room')
          for (const alias of aliases) {
            if (removeTransient(roomTransientScopeKey(roomJid), alias).removed) {
              removed = true
              break
            }
          }
        }
        if (removed) bumpRoomUnreadInputVersion(roomJid)
        roomRecountRetry.resume(roomJid)
      })
    }

    // XEP-0490: a pending marker was not orderable in an earlier slice.
    // Retry against the merged messages; the shared resolver clears it only
    // when the comparison resolves.
    const pending = get().roomMeta.get(roomJid)?.pendingRemoteDisplayedStanzaId
    if (pending) {
      get().applyRemoteDisplayed(roomJid, pending, mergedForMarker)
    }

    // Archive-derived recount (trigger: forward MAM merge past the
    // floor). A forward catch-up merge for a non-active room may have
    // extended contiguous history past the read pointer — re-derive the
    // badge from the archive rather than trusting this page alone.
    if (shouldRecountAfterMerge) {
      void get().recomputeUnreadForRoom(roomJid)
    }
    if (direction === 'forward' && complete) {
      if (!archiveCommitGate && roomArchiveSaves.has(roomJid)) {
        archiveCommitGate = roomArchiveSaves.chain(roomJid, Promise.resolve(true))
      }
      const resume = () => {
        if (roomCacheEpoch !== cacheEpochAtMerge || currentRoomEntityEpoch(roomJid) !== entityEpochAtMerge || getStorageScopeJid() !== storageScopeAtMerge) return
        roomRecountRetry.resume(roomJid)
      }
      if (archiveCommitGate) void archiveCommitGate.then((committed) => { if (committed) resume() })
      else resume()
    }
  },

  clearRoomGapAnchor: (roomJid, purgedStartId) => {
    set((state) => {
      const next = clearGapAnchor(state.roomGaps, roomJid, purgedStartId)
      if (!next) return state
      saveGapsToStorage(next)
      return { roomGaps: next }
    })
  },

  getRoomCoverage: (roomJid) => get().roomCoverage.get(roomJid),

  clearRoomCoverage: (roomJid, ifBottomId) => {
    set((state) => {
      const next = clearCoverageEntry(state.roomCoverage, roomJid, ifBottomId)
      if (!next) return state
      // roomStore has no persist middleware: it writes this map itself.
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
    const jid = get().activeRoomJid
    return (jid ? get().messages.get(jid) : undefined) ?? EMPTY_MESSAGE_ARRAY
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

roomStore.subscribe((state, previous) => {
  const roomJid = state.activeRoomJid
  if (!roomJid || !remoteDividerAdvances.has(roomJid)) return
  const parked = state.firstNewMessageMarkers.get(roomJid)
  if (parked === undefined) {
    remoteDividerAdvances.clear(roomJid)
    return
  }
  if (state.messages.get(roomJid) === previous.messages.get(roomJid)) return

  const result = remoteDividerAdvances.retry(
    roomJid,
    parked,
    state.messages.get(roomJid) ?? [],
    'room',
    locallyPublishedDisplayed(
      getBareJid(connectionStore.getState().jid ?? ''),
      roomJid,
    ),
  )
  if (result.kind === 'advanced') {
    roomStore.setState((current) => ({
      firstNewMessageMarkers: new Map(current.firstNewMessageMarkers).set(
        roomJid,
        result.divider,
      ),
    }))
  }
})
