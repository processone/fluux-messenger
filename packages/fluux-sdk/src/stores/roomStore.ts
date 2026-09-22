import { isSpamModerated, moderationMetadata, roomRetractionAuthorized, type ModerationMetadata } from '../utils/moderation'
import { backfillRoomStanzaId, roomStanzaIdsMergeable } from '../utils/roomStanzaId'
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
import type { ReadStateGeneration } from '../core/types/readStateGeneration'
import { isNoLocalStore, resolveCorrectionUpdates, correctionContent, sameCorrection, type StoredRoomMessage } from '../core/types/message-internal'
import { setTypingTimeout, clearTypingTimeout } from './typingTimeout'
import {
  findMessageById,
  findMessageIndexById,
  findMessageRowIndex,
  identityKeys,
  mergeableOccupantCandidates,
  resolveMessageReference,
  messageReferences,
  correctionReferences,
  type CorrectionReferences,
  roomMessageAuthor,
  roomScope,
  sameLogicalMessage,
  type MessageRowRef,
  type MessageActor,
} from '../utils/messageIdentity'
import { getBareJid } from '../core/jid'
import { logInfo, logWarn } from '../core/logger'
import * as messageCache from '../utils/messageCache'
import * as searchIndex from '../utils/searchIndex'
import type { GetMessagesOptions } from '../utils/messageCache'
import * as mamState from './shared/mamState'
import type { HistoryQueryDirection } from './shared/mamState'
import { messagePageExtent, newestMessageStanzaId, serializeGaps, deserializeGaps, type GapInterval } from './shared/mamGap'
import {
  walkExtentBottomId,
  isCaughtUpForCounting,
  recoverCoverageForCounting,
  serializeCoverage,
  deserializeCoverage,
  type CoverageRecord,
  type CoverageTransition,
} from './shared/mamCoverage'
import {
} from './shared/viewportEvidence'
import {
  matchesCorrectionTarget, reconcileCachedCorrections, reconcileCorrectionHandoff, refreshCachedCorrections,
} from './shared/correctionHandoff'
import { createArchiveSaveChain } from './shared/archiveSaveChain'
import { newArchiveMergeTally, reportArchiveMergeWhenDurable } from './shared/archiveMergeDiagnostics'
import * as draftState from './shared/draftState'
import * as timeline from './shared/messageTimeline'
import { shouldUpdateLastMessage, shouldReplaceLastMessage, isPreviewableMessage, findLastNonIgnoredMessage } from './shared/lastMessageUtils'
import { derivePreviewAfterMerge } from './shared/previewState'
import { addPendingRetraction, applyPendingRetractions, removePendingRetraction, type PendingRetraction } from './shared/pendingRetractions'
import { retractRoomMessageInStorage, retractUnresidentRoomTarget } from './shared/retractionStorage'
import { rowRefOfPointer } from './shared/readPointer'
import {
  foldPendingRemoteDisplayed,
} from './shared/readMarkerSync'
import { advance, pointerRowRef } from './shared/readPointer'
import { loadRoomReadState, saveRoomReadState, clearRoomReadState, _clearAllRoomReadStateForTesting, type RoomReadState } from './shared/readStateStorage'
import { ignoreStore, isMessageFromIgnoredUser } from './ignoreStore'
import { roomActivityTone } from './roomSelectors'
import * as notifState from './shared/notificationState'
import { markerDebugLog } from '../utils/markerDebug'
import { connectionStore } from './connectionStore'
import { buildScopedStorageKey, captureStorageScope, getStorageScopeJid } from '../utils/storageScope'
import { resolveCoverageBottom } from './shared/mamCoverage'
import { createArchiveMerge, type ArchiveMergeOptions } from './archiveMerge'
import { createReadTracker, readFieldsOf, withDivider, type ReadStateView } from './readTracker'
import { schedule, flush as flushThrottledStorage } from './shared/throttledStorage'
import { scheduleDurableMaps, cancelDurableMaps, forgetAllDurableMapBaselines, noteCoverageTransition } from './shared/durableMapPersist'
// Sliding-window bound (messages kept resident per room; rest live in IndexedDB + MAM). Read via
// getResidentWindowSize() so a DEV/DEMO/TEST caller can shrink it — see shared/residentWindow.ts.
import { getResidentWindowSize } from './shared/residentWindow'
import { lastMessageTimestamp, clearCoverageEntry, clearGapAnchor } from './shared/keyedMapEdits'
import { sortMessagesByTimestamp } from './shared/messageArrayUtils'

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
 * bottom per room — positive twin of the gap map). Survives
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
const roomMessageArrivals = new Map<string, Promise<void>>()

// Cache epoch: bumped whenever the room cache lifecycle resets
// (logout reset or account switch). Deferred gap/coverage commits
// capture the epoch at merge time and no-op when it moved — a gate that was
// already in flight when the state was torn down must not resurrect entries.
let roomCacheEpoch = 0

/** Test-only: drop all per-room archive-save chain entries. */
export function _resetRoomArchiveSavesForTesting(): void {
  roomArchiveSaves.clear()
  roomMessageArrivals.clear()
  roomCacheEpoch++
}

const roomEntityEpoch = new Map<string, number>()
function roomReadView(state: RoomState, roomJid: string): ReadStateView | undefined {
  const existing = state.rooms.get(roomJid)
  const meta = state.roomMeta.get(roomJid)
  if (!existing && !meta) return undefined
  return {
    readPointer: meta?.readPointer ?? existing?.readPointer,
    unreadCount: meta?.unreadCount ?? existing?.unreadCount ?? 0,
    mentionsCount: meta?.mentionsCount ?? existing?.mentionsCount ?? 0,
    messages: state.messages.get(roomJid) ?? [],
    atLiveEdge: state.windowAtLiveEdge.get(roomJid) !== false,
    isActive: state.activeRoomJid === roomJid,
    divider: state.firstNewMessageMarkers.get(roomJid),
    lastMessage: meta?.lastMessage ?? existing?.lastMessage,
    pendingRemoteMarker: meta?.pendingRemoteDisplayedStanzaId ?? existing?.pendingRemoteDisplayedStanzaId,
    historyFloor: meta?.historyFloor ?? existing?.historyFloor,
  }
}

const roomArchiveMerge = createArchiveMerge('room', {
  // The cache and the entity, not the account scope: a deferred commit is guarded exactly as the
  // merge that computed it was.
  captureEntity: (roomJid) => {
    const cacheEpoch = roomCacheEpoch
    const entityEpoch = currentRoomEntityEpoch(roomJid)
    return () => roomCacheEpoch === cacheEpoch && currentRoomEntityEpoch(roomJid) === entityEpoch
  },
  applyDeferred: (roomJid, change, guards, transition) => roomStore.setState((state) => {
    // A later merge may have moved the gap or the record on; only the exact value this merge
    // computed from may be transitioned, and reference equality is what proves it. A lost race
    // leaves a lagging cursor, never a skipping one.
    const out: Partial<RoomState> = {}
    if ('gaps' in change && state.roomGaps.get(roomJid) === guards.gap) {
      const next = new Map(state.roomGaps)
      if (change.gaps) next.set(roomJid, change.gaps)
      else next.delete(roomJid)
      saveGapsToStorage(next)
      out.roomGaps = next
    }
    if (change.coverage && state.roomCoverage.get(roomJid) === guards.coverage) {
      const next = new Map(state.roomCoverage).set(roomJid, change.coverage)
      // This is the write that first carries the new record.
      saveCoverageToStorage(next, undefined, { roomJid, kind: transition })
      out.roomCoverage = next
    }
    return Object.keys(out).length > 0 ? out : state
  }),
  // A room writes its gaps and coverage itself; the chat twin rides a persisted blob instead.
  noteApplied: (roomJid, applied) => {
    if (applied.gaps) saveGapsToStorage(applied.gaps)
    if (applied.coverage) saveCoverageToStorage(applied.coverage, undefined, { roomJid, kind: applied.transition })
  },
})

export const roomReadTracker = createReadTracker('room', {
  storage: {
    read: (roomJid) => roomReadView(roomStore.getState(), roomJid),
    update: (roomJid, change) => roomStore.setState((state) => {
      const view = roomReadView(state, roomJid)
      if (!view) return state
      const patch = change(view)
      if (!patch) return state
      const next: Partial<RoomState> = {}
      const read = readFieldsOf(patch)
      const existingRoom = state.rooms.get(roomJid)
      if (read) {
        // Read state lives on both the room and its metadata; the metadata is
        // what gets persisted, and only a read pointer is persisted from it.
        const existing = existingRoom
        if (existing) {
          next.rooms = new Map(state.rooms)
          next.rooms.set(roomJid, { ...existing, ...read })
        }
        const meta = state.roomMeta.get(roomJid) ?? { unreadCount: 0, mentionsCount: 0, typingUsers: new Set<string>() }
        next.roomMeta = new Map(state.roomMeta)
        next.roomMeta.set(roomJid, { ...meta, ...read })
        if (patch.readPointer) persistRoomReadState(next.roomMeta)
      }
      if (patch.divider !== undefined) {
        next.firstNewMessageMarkers = withDivider(state.firstNewMessageMarkers, roomJid, patch.divider)
      }
      if (patch.becomesActive) {
        next.activeRoomJid = roomJid
        // Opening a room is an interaction: the sidebar orders by it.
        const lastInteractedAt = view.lastMessage?.timestamp ?? existingRoom?.lastInteractedAt
        if (lastInteractedAt !== undefined) {
          next.roomMeta = new Map(next.roomMeta ?? state.roomMeta)
          const meta = next.roomMeta.get(roomJid)
          if (meta) next.roomMeta.set(roomJid, { ...meta, lastInteractedAt })
          if (existingRoom) {
            next.rooms = new Map(next.rooms ?? state.rooms)
            next.rooms.set(roomJid, { ...(next.rooms.get(roomJid) ?? existingRoom), lastInteractedAt })
          }
        }
      }
      return next
    }),
  },
  recount: (roomJid, options) => {
    const store = roomStore.getState()
    void (options ? store.recomputeUnreadForRoom(roomJid, options) : store.recomputeUnreadForRoom(roomJid))
  },
  loadStashedMarkerRows: async (roomJid, stanzaId) => {
    const marker = await messageCache.getRoomMessageByStanzaId(roomJid, stanzaId)
    if (!marker) return null
    const pointer = roomStore.getState().roomMeta.get(roomJid)?.readPointer
    if (pointer?.order.role !== 'floor') return [marker]
    const pointerRow = await messageCache.getRoomMessageByRowRef(roomJid, pointerRowRef(pointer))
    return sortMessagesByTimestamp(pointerRow && pointerRow.id !== marker.id ? [marker, pointerRow] : [marker], 'room')
  },
  captureCacheRead: captureRoomCacheRead,
  loadPublishCandidates: (roomJid, pointer) =>
    messageCache.getRoomMessageCandidates(roomJid, pointer.identity.messageId),
  historyCaughtUp: (roomJid) =>
    isCaughtUpForCounting(mamState.getMAMQueryState(roomStore.getState().mamQueryStates, roomJid)),
  coverageRecord: (roomJid) => roomStore.getState().roomCoverage.get(roomJid),
  resolveCoverageBottom: (roomJid, record) => resolveCoverageBottom(roomJid, record, true),
  invalidateCoverage: (roomJid, record) => {
    // Guarded on the same bottomId, so a record a concurrent merge already moved on is kept.
    roomStore.getState().clearRoomCoverage(roomJid, record.bottomId)
  },
  countUnreadFromArchive: (roomJid, range) => messageCache.countRoomUnreadInArchive(roomJid, range),
  archiveReadyForCounting: (roomJid) => {
    const mam = mamState.getMAMQueryState(roomStore.getState().mamQueryStates, roomJid)
    return !roomArchiveSaves.has(roomJid) && isCaughtUpForCounting(mam)
  },
})

function currentRoomEntityEpoch(roomJid: string): number {
  return roomEntityEpoch.get(roomJid) ?? 0
}

/**
 * This store's half of `readStateGeneration`, which is what consumers call. Kept
 * here because both counters are module scope, bumped by this store's own teardown.
 */
export function roomReadStateGeneration(roomJid: string): ReadStateGeneration {
  return { store: roomCacheEpoch, entity: currentRoomEntityEpoch(roomJid) }
}

function invalidateRoomEntity(roomJid: string): void {
  roomEntityEpoch.set(roomJid, currentRoomEntityEpoch(roomJid) + 1)
  roomArchiveSaves.cancel(roomJid)
  roomMessageArrivals.delete(roomJid)
  roomReadTracker.forgetEntity(roomJid)
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
  return identityKeys(roomScope(m.roomJid), m)
}

/** Timeline config for the shared resident-window machine (see shared/messageTimeline.ts). */
function roomTimelineConfig(): timeline.TimelineConfig<RoomMessage> {
  return {
    getKeys: getRoomMessageKeys,
    sameMessage: (a, b) => sameLogicalMessage(roomScope(a.roomJid), a, b) && roomStanzaIdsMergeable(a, b),
    getMergeCandidates: (incoming, candidates) => mergeableOccupantCandidates(incoming, candidates).filter(candidate => roomStanzaIdsMergeable(incoming, candidate)),
    mergeIdentity: (current, donor) => {
      const identified = backfillRoomStanzaId(current, donor)
      return donor.isRetracted
        ? reconcileCachedCorrections([identified], [donor], getStorageScopeJid())[0]
        : identified
    },
    windowSize: getResidentWindowSize(),
    kind: 'room',
    isHidden: isSpamModerated,
  }
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

function commitRoomCorrectionPreview(state: RoomState, roomJid: string, message: StoredRoomMessage): Partial<RoomState> | null {
  const existing = state.roomMeta.get(roomJid)?.lastMessage ?? state.rooms.get(roomJid)?.lastMessage ?? state.messages.get(roomJid)?.at(-1)
  const preview = reconcileCorrectionHandoff(existing, message, getStorageScopeJid())
  return preview ? commitRoomUpdate(state, roomJid, { lastMessage: preview }) : null
}

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

  const { messages, resolved, remaining } = applyPendingRetractions(
    slice,
    pending,
    roomRetractionAuthorized
  )
  if (remaining.length === pending.length) return { messages }

  if (options.persist !== false) {
    for (const { message, retractedAt } of resolved) {
      void retractRoomMessageInStorage(roomJid, message, { retractedAt, ...moderationMetadata(message) })
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

/**
 * Merge a latest-N batch of cached room messages into a room's resident array, returning the
 * partial state update (or `null` when the room is not present): dedupe, sort, keep-newest trim,
 * and refresh the sidebar preview. {@link mergeCachedRoomAround} is the load-around counterpart.
 */
function mergeCachedRoomMessages(
  state: RoomState,
  roomJid: string,
  cachedMessages: RoomMessage[]
): Partial<Pick<RoomState, 'rooms' | 'messages' | 'windowAtLiveEdge' | 'roomMeta' | 'pendingRetractions'>> | null {
  const newRooms = new Map(state.rooms)
  const existing = newRooms.get(roomJid)
  if (!existing) return null

  // Reconcile edit revisions before deduplicating and trimming the window.
  const resident = state.messages.get(roomJid) ?? []
  const { merged: rawMerged } = timeline.latestSlice(
    reconcileCachedCorrections(resident, cachedMessages, getStorageScopeJid()),
    cachedMessages,
    roomTimelineConfig()
  )
  return commitCachedRoomMessages(state, roomJid, rawMerged)
}

/**
 * Merge the cache slice around `anchorRow` so the anchor stays resident, leaving the live edge
 * when the resident bound cuts the newer tail.
 */
function mergeCachedRoomAround(
  state: RoomState,
  roomJid: string,
  cachedMessages: RoomMessage[],
  anchorRow: MessageRowRef,
  contextBefore: number
): Partial<Pick<RoomState, 'rooms' | 'messages' | 'windowAtLiveEdge' | 'roomMeta' | 'pendingRetractions'>> | null {
  if (!state.rooms.has(roomJid)) return null
  const resident = state.messages.get(roomJid) ?? []
  const { merged, newestEvicted } = timeline.aroundSlice(
    reconcileCachedCorrections(resident, cachedMessages, getStorageScopeJid()),
    cachedMessages,
    (messages) => findMessageRowIndex(messages, anchorRow),
    contextBefore,
    roomTimelineConfig()
  )
  return commitCachedRoomMessages(state, roomJid, merged, newestEvicted ? false : undefined)
}

function captureRoomCacheRead(roomJid: string): () => boolean {
  const scope = captureStorageScope()
  const epoch = roomCacheEpoch
  const entityEpoch = currentRoomEntityEpoch(roomJid)
  return () => scope.isCurrent() && epoch === roomCacheEpoch && entityEpoch === currentRoomEntityEpoch(roomJid)
}

function commitCachedRoomMessages(state: RoomState, roomJid: string, rawMerged: RoomMessage[], atLiveEdge?: boolean) {
  const existing = state.rooms.get(roomJid)
  if (!existing) return null

  // XEP-0424: a retraction recorded while this room was unloaded applies here,
  // the moment its target becomes resident.
  const resolvedRetractions = resolveRoomPendingRetractions(state, roomJid, rawMerged)
  const merged = resolvedRetractions.messages

  // Sidebar preview via the shared policy: only replace when the merged set's
  // newest non-ignored message genuinely supersedes (or heals) the current
  // preview — a deep-history slice (scroll-position restore) must not regress it.
  const current = existing.lastMessage
    ? reconcileCachedCorrections([existing.lastMessage], merged, getStorageScopeJid())[0]
    : undefined
  const { lastMessage } = derivePreviewAfterMerge(current, merged, (msgs) =>
    findLastNonIgnoredMessage(msgs, roomJid, existing.nickToJidCache)
  )

  const written = withRoomMessageWindow(state, roomJid, merged, { roomPatch: { lastMessage }, atLiveEdge })
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
  /** Newest accepted live arrival per room. Ephemeral and never persisted. */
  lastArrivedMessage: Map<string, RoomMessage>
  /**
   * Whether a room's resident window still holds the newest history, so an
   * incoming live message can be appended. See docs/MAM_CATCHUP.md under
   * "Resident windows away from the live edge" for the transition rules.
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
  targetMessageId: string | MessageRowRef | null
  // Session-only new-message divider per room (jid -> messageId). Derived at
  // activation from the read pointer; never persisted.
  firstNewMessageMarkers: Map<string, MessageRowRef>
  // Session-only: how many messages sit under each room's divider. Seeded when the divider is
  // placed and incremented by rows reaching the bottom below it; see notifState.DividerCount.
  firstNewMessageCounts: Map<string, notifState.DividerCount>
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
    isLiveArrival?: boolean
    incrementUnread?: boolean
    incrementMentions?: boolean
  }) => void
  waitForMessageArrivals: (roomJid: string) => Promise<boolean> | undefined
  updateReactions: (roomJid: string, messageId: string, reactorNick: string, emojis: string[]) => void
  resolveCorrectionReferences: (roomJid: string, targetId: string, actor: MessageActor) => Promise<CorrectionReferences | null | undefined>
  reconcileHistoryMessages: (messages: RoomMessage[], options?: { retractionsOnly?: boolean }) => Promise<RoomMessage[]>
  updateMessage: (
    roomJid: string,
    messageId: string,
    updates: Partial<StoredRoomMessage>,
    retractionReference?: string,
    resolvedRetractionTarget?: RoomMessage,
    correctionActor?: MessageActor,
    onCorrectionMissing?: () => void,
    onCorrectionResolved?: (message: StoredRoomMessage, isCurrent: () => boolean) => void
  ) => void
  clearMessageStanzaId: (roomJid: string, stanzaId: string) => void
  getMessage: (roomJid: string, messageId: string) => RoomMessage | undefined
  /**
   * Reconcile a non-active room's unread count against the durable archive
   *: a coverage-gated cursor count from the effective read boundary,
   * plus the transient (`noLocalStore`) overlay, capped at 999 — never a
   * bounded resident/cache slice. Commits only on an exact derivation; every
   * uncertain case (pointerless-with-count, incomplete coverage) leaves the
   * last TRUSTED count untouched rather than writing a provisional one.
   * Mentions stay on the live `+1` path, but a proven zero unread count
   * clears `mentionsCount` too. Latest-wins across concurrent recounts
   * for the same room.
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
   * is `{ allowActive: true }`: callers that establish new durable counting
   * input while the room is active must opt into the guarded archive
   * derivation.
   */
  recomputeUnreadForRoom: (roomJid: string, options?: { allowActive?: boolean }) => Promise<void>
  /**
   * XEP-0424: apply an incoming retraction, deferring it when its target is not
   * resident. Applies immediately (and writes through to the durable cache) when
   * the target is in the window; otherwise records it and replays it the moment
   * the target arrives live or loads from the cache. Self-retractions require
   * matching authorship; verified moderation addresses the room's archive id.
   *
   * @param actorJid - Author's full room JID, or the bare room service for moderation.
   * @param actorOccupantId - XEP-0421 occupant-id when advertised; preferred over the nick.
   * @param moderation - Metadata from an already verified room-service moderation event.
   */
  recordPendingRetraction: (roomJid: string, targetId: string, actorJid: string, actorOccupantId?: string, moderation?: ModerationMetadata) => void
  /**
   * Epoch ms of the room's persisted last-known message (the entity preview),
   * or undefined. Used as a last-resort forward catch-up cursor so a persisted
   * room whose message cache is empty this run still forward-fills its offline
   * gap instead of a `before:''` fetch-latest.
   */
  getRoomLastTimestamp: (roomJid: string) => number | undefined
  markAsRead: (roomJid: string) => void
  /** Esc / mark-all-read: use the resident tail (lastMessage if empty) as a
   *  candidate under `advance` / `hasFloorResolutionEvidence` in `shared/readPointer.ts`.
   *  Zero the counts and drop the divider. The MDS publisher observes
   *  pointer changes through roomMeta. */
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
  advanceReadPointer: (roomJid: string, row: MessageRowRef) => void
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
  /**
   * XEP-0490: drop a stashed remote marker the archive has proven it no longer
   * holds. Guarded on `stanzaId`; moves no read pointer. See the implementation.
   */
  discardPurgedRemoteDisplayed: (roomJid: string, stanzaId: string) => void
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

  /** Room counterpart of {@link ChatState.loadMessagesFromCache}, with the same resident-window policy. */
  loadMessagesFromCache: (roomJid: string, options?: GetMessagesOptions & { peek?: boolean; oldest?: boolean }) => Promise<RoomMessage[]>
  /**
   * Room counterpart of {@link ChatState.loadMessagesAroundFromCache}, preserving the exact
   * anchor row through {@link timeline.aroundSlice}.
   */
  loadMessagesAroundFromCache: (roomJid: string, anchorRow: MessageRowRef, options?: { before?: number; after?: number }) => Promise<RoomMessage[]>
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
   * Room counterpart of {@link ChatState.recenterToLatest} for the jump-to-latest action.
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
  setRoomMAMLoading: (roomJid: string, isLoading: boolean, requestId?: string) => void
  setRoomMAMError: (roomJid: string, error: string | null, requestId?: string) => void
  /**
   * Merge MAM messages into room and update query state.
   * @param roomJid - Room JID
   * @param messages - Messages from MAM query
   * @param page - RSM pagination response
   * @param complete - Whether server indicated query is complete
   * @param direction - Query direction: 'backward' for older history, 'forward' for catching up
   */
  mergeRoomMAMMessages: (
    roomJid: string,
    messages: RoomMessage[],
    page: PageInfo,
    complete: boolean,
    direction: HistoryQueryDirection,
    options?: ArchiveMergeOptions,
  ) => void
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
  setTargetMessageId: (id: string | MessageRowRef | null) => void

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
): Pick<RoomState, 'rooms' | 'roomEntities' | 'roomMeta' | 'roomRuntime' | 'messages' | 'lastArrivedMessage' | 'windowAtLiveEdge' | 'activeRoomJid' | 'activationPending' | 'activeAnimation' | 'drafts' | 'votedPollIds' | 'dismissedPollIds' | 'mamQueryStates' | 'roomGaps' | 'roomCoverage' | 'acknowledgedNonAnonymousRooms' | 'pendingRetractions' | 'targetMessageId' | 'firstNewMessageMarkers' | 'firstNewMessageCounts' | 'interiorPlacementVersions'> {
  return {
    rooms: new Map(),
    roomEntities: new Map(),
    roomMeta: new Map(),
    roomRuntime: new Map(),
    messages: new Map(),
    lastArrivedMessage: new Map(),
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
    firstNewMessageCounts: new Map(),
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
    // The durable cursors describe messages that no longer exist: drop them
    // with the cache, and invalidate in-flight deferred commits so one can't
    // resurrect an entry for the removed room.
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

      const newLastArrivedMessage = new Map(state.lastArrivedMessage)
      newLastArrivedMessage.delete(roomJid)

      const newLiveEdge = new Map(state.windowAtLiveEdge)
      newLiveEdge.delete(roomJid)

      const out: Partial<RoomState> = {
        rooms: newRooms,
        roomEntities: newEntities,
        roomMeta: newMeta,
        roomRuntime: newRuntime,
        messages: newMessages,
        lastArrivedMessage: newLastArrivedMessage,
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
    roomMessageArrivals.clear()
    roomCacheEpoch++
    roomEntityEpoch.clear()
    roomReadTracker.resetForAccountSwitch()
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
    roomMessageArrivals.clear()
    roomCacheEpoch++
    roomEntityEpoch.clear()
    roomReadTracker.resetForLogout()
    // Note: We don't clear IndexedDB on reset - room messages are valuable cache
    // They will be cleared when rooms are explicitly removed or user logs out
    // (The connection store's reset handles full logout cleanup via clearAllMessages)
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
  addMessage: async (roomJid, message, options = {}) => {
    const { isLiveArrival = true, incrementUnread = true, incrementMentions = false } = options

    // Get room to check if it's a Quick Chat (transient history)
    const room = get().rooms.get(roomJid)

    // Quick Chat rooms are transient: keep their messages in memory only
    let incoming: StoredRoomMessage = room?.isQuickChat
      ? { ...message, noLocalStore: true }
      : message

    const previous = roomMessageArrivals.get(roomJid)
    const needsCache = incoming.isDelayed && !isNoLocalStore(incoming) && messageCache.isMessageCacheAvailable()
    if (previous || needsCache) {
      const isCurrent = captureRoomCacheRead(roomJid)
      let finish!: () => void
      const pending = new Promise<void>(resolve => { finish = resolve })
      roomMessageArrivals.set(roomJid, pending)
      try {
        if (previous) await previous
        if (!isCurrent()) return
        if (needsCache) incoming = (await get().reconcileHistoryMessages([incoming], { retractionsOnly: true }))[0]
        if (!isCurrent()) return
      } catch {
        if (isCurrent()) logWarn('Room replay reconciliation failed')
        return
      } finally {
        if (roomMessageArrivals.get(roomJid) === pending) roomMessageArrivals.delete(roomJid)
        finish()
      }
    }
    for (const current of get().messages.get(roomJid) ?? []) {
      if (roomStanzaIdsMergeable(incoming, current) && sameLogicalMessage(roomScope(roomJid), incoming, current)) {
        incoming = backfillRoomStanzaId(incoming, current)
      }
    }

    // XEP-0424: a retraction can outrun its target (live retraction against a
    // non-resident message, out-of-order delivery). Tombstone BEFORE the save
    // below so it persists the tombstone — patching afterwards would race it.
    const arrival = resolveRoomPendingRetractions(get(), roomJid, [incoming], { persist: false })
    const messageToAdd = messageCache.reconcileRoomRetraction(arrival.messages[0])
    if (arrival.pendingRetractions) set({ pendingRetractions: arrival.pendingRetractions })

    // The read tracker records an arrival the reader has not seen in its transient overlay:
    // until the cache write commits — and for a message never stored locally, for good — the
    // overlay is the only place it is counted. A room row is named by the message, because a
    // reused nick puts two rows under one id. `incrementUnread: false` (MUC.ts's nick-change
    // system message) keeps such an arrival out of the overlay too.
    const arrivalNote = roomReadTracker.beginArrival(
      roomJid,
      messageToAdd,
      { isActive: get().activeRoomJid === roomJid, windowVisible: connectionStore.getState().windowVisible },
      { increment: incrementUnread, roomMessage: messageToAdd },
    )
    let acceptedMessage = false

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
          void messageCache.updateRoomMessage(
            roomJid,
            p.id,
            { stanzaId: p.stanzaId!, localRowRef: p.localRowRef, occupantId: p.occupantId, ...(p.originId ? { originId: p.originId } : {}),
              ...(p.isRetracted && { isRetracted: true, retractedAt: p.retractedAt, ...moderationMetadata(p) }) },
            p.from,
            undefined,
            p,
          )
        }
        const backfilled = withRoomMessageWindow(state, roomJid, append.messages)
        if (!backfilled) return state
        return backfilled
      }
      acceptedMessage = true

      const lastArrivedMessage = isLiveArrival
        ? new Map(state.lastArrivedMessage).set(roomJid, messageToAdd)
        : state.lastArrivedMessage

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
      const existingMeta = state.roomMeta.get(roomJid)
      const read = roomReadTracker.arrivalCounts(arrivalNote, messageToAdd, { isActive, windowVisible }, {
        increment: incrementUnread,
        incrementMentions,
      })
      if (!read) return state
      const { unreadCount } = read

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
          mentionsCount: read.mentionsCount,
          readPointer: read.readPointer,
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
          mentionsCount: read.mentionsCount,
          readPointer: read.readPointer,
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
      const newMarkers = withDivider(state.firstNewMessageMarkers, roomJid, read.divider)

      return {
        ...written,
        roomMeta: newMeta,
        firstNewMessageMarkers: newMarkers,
        lastArrivedMessage,
        ...interiorPlacementPatch,
      }
    })

    const durableWrite = acceptedMessage && !isNoLocalStore(messageToAdd)
      ? messageCache.saveRoomMessageWithResult(messageToAdd)
      : undefined
    roomReadTracker.endArrival(arrivalNote, { accepted: acceptedMessage, durableWrite })
    if (durableWrite) {
      searchIndex.indexMessage(messageToAdd).catch((e) => console.warn('[searchIndex] indexMessage failed:', e))
    }
  },

  waitForMessageArrivals: (roomJid) => {
    const pending = roomMessageArrivals.get(roomJid)
    if (!pending) return undefined
    const isCurrent = captureRoomCacheRead(roomJid)
    return pending.then(isCurrent)
  },

  updateReactions: async (roomJid, messageId, reactorNick, emojis) => {
    const pending = roomMessageArrivals.get(roomJid)
    if (pending) {
      const isCurrent = captureRoomCacheRead(roomJid)
      await pending
      if (!isCurrent()) return
    }
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
        void messageCache.updateRoomMessage(
          roomJid,
          updatedMessage.id,
          { reactions: updatedMessage.reactions },
          updatedMessage.from,
          undefined,
          updatedMessage,
        )
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

  resolveCorrectionReferences: async (roomJid, targetId, actor) => {
    const scope = captureStorageScope()
    const epoch = roomCacheEpoch
    const resolution = resolveMessageReference(get().messages.get(roomJid) ?? [], targetId, 'archive-first')
    const candidates = resolution?.candidates.filter(({ message }) => roomMessageAuthor(message, actor)) ?? []
    const target = candidates[0]?.message
    if (target) return candidates.length === 1 ? correctionReferences(target) : null
    if (resolution?.authoritative) return null
    const references = await messageCache.getCorrectionReferences('room', roomJid, targetId, actor, scope.jid)
    scope.assertCurrent()
    if (epoch !== roomCacheEpoch) throw new DOMException('Correction lookup cancelled', 'AbortError')
    return references
  },

  reconcileHistoryMessages: async (messages, options) => {
    const scope = captureStorageScope()
    const rooms = new Set(messages.map(message => message.roomJid))
    const applyPending = (rows: RoomMessage[]) => {
      for (const jid of rooms) {
        const pending = get().pendingRetractions.get(jid)
        if (pending?.length) rows = applyPendingRetractions(rows, pending,
          (message, record) => message.roomJid === jid && roomRetractionAuthorized(message, record)).messages
      }
      return rows
    }
    const reconciled = await messageCache.reconcileRoomHistoryMessages(messages, () => {
      scope.assertCurrent()
      return Array.from(rooms, jid => get().messages.get(jid) ?? []).flat()
    }, scope.jid, options?.retractionsOnly)
    scope.assertCurrent()
    return applyPending(reconciled)
  },

  updateMessage: async (roomJid, messageId, updates, retractionReference, resolvedRetractionTarget, correctionActor, onCorrectionMissing, onCorrectionResolved) => {
    if (updates.isRetracted && updates.isModerated && !resolvedRetractionTarget) {
      get().recordPendingRetraction(roomJid, messageId, roomJid, undefined, moderationMetadata(updates))
      return
    }
    const pending = roomMessageArrivals.get(roomJid)
    if (pending && !updates.isRetracted) {
      const isCurrent = captureRoomCacheRead(roomJid)
      await pending
      if (!isCurrent()) return
    }
    let recountNeeded = false
    const correctionPayload = updates
    const contentRecovery = updates.contentRecovery
    const liveCorrection = updates.liveCorrection
    const persistCorrection = (pendingUpdates: Partial<StoredRoomMessage>, targetId = messageId) => {
      if (!correctionActor) return
      const scope = captureStorageScope()
      const epoch = roomCacheEpoch
      const entityEpoch = currentRoomEntityEpoch(roomJid)
      const isCurrent = () => scope.isCurrent() && epoch === roomCacheEpoch && entityEpoch === currentRoomEntityEpoch(roomJid)
      const fallback = () => {
        if (!isCurrent() || !onCorrectionMissing) return
        const current = get().messages.get(roomJid) ?? []
        const resolution = resolveMessageReference(current, messageId, 'archive-first')
        if (resolution?.candidates.some(({ message }) => roomMessageAuthor(message, correctionActor))) {
          get().updateMessage(roomJid, messageId, { ...pendingUpdates, liveCorrection: false }, undefined, undefined, correctionActor)
        } else if (!resolution?.authoritative) onCorrectionMissing()
      }
      void messageCache.applyRoomCorrection(roomJid, targetId, pendingUpdates, correctionActor, scope.jid)
        .then(message => {
          if (message) {
            if (isCurrent()) set(current => {
              const rows = current.messages.get(roomJid) ?? []
              const index = rows.findIndex(row => matchesCorrectionTarget(row, message))
              const updated = reconcileCorrectionHandoff(rows[index], message, scope.jid)
              if (!updated) return commitRoomCorrectionPreview(current, roomJid, message) ?? current
              const replay = resolveRoomPendingRetractions(current, roomJid, [updated], { persist: false })
              const completed = replay.messages[0]
              const written = withRoomMessageWindow(current, roomJid, rows.map((row, i) => i === index ? completed : row))
              const previewPatch = commitRoomCorrectionPreview(current, roomJid, completed.isRetracted
                ? { ...message, isRetracted: true, retractedAt: completed.retractedAt } : message)
              return { ...written, ...previewPatch, ...(replay.pendingRetractions && { pendingRetractions: replay.pendingRetractions }) }
            })
            void searchIndex.updateMessage(message, scope.jid).catch(error => logWarn(`Failed to index correction: ${String(error)}`))
            if (isCurrent()) onCorrectionResolved?.(message, isCurrent)
          } else if (message === undefined) {
            if (typeof indexedDB === 'undefined' && isCurrent()) {
              const rows = get().messages.get(roomJid) ?? []
              const current = resolveMessageReference(rows, targetId, 'archive-first')?.candidates
                .find(({ message }) => roomMessageAuthor(message, correctionActor))?.message
              if (current) { onCorrectionResolved?.(current, isCurrent); return }
            }
            fallback()
          }
        }, error => { logWarn(`Failed to persist room correction: ${String(error)}`) })
    }
    set((state) => {
      const newRooms = new Map(state.rooms)
      const existing = newRooms.get(roomJid)
      if (!existing) return state

      const resident = state.messages.get(roomJid) ?? []
      let targetIdx: number
      if (correctionActor) {
        targetIdx = resolveMessageReference(resident, messageId, 'archive-first')?.candidates
          .find(({ message }) => roomMessageAuthor(message, correctionActor))?.index ?? -1
      } else if (resolvedRetractionTarget) {
        targetIdx = resident.indexOf(resolvedRetractionTarget)
      } else if (retractionReference) {
        targetIdx = resident.findIndex((message) => message.id === messageId)
      } else if (updates.isRetracted) {
        targetIdx = resolveMessageReference(resident, messageId, 'archive-first')?.candidates[0]?.index ?? -1
      } else {
        targetIdx = findMessageIndexById(resident, messageId)
      }
      if (targetIdx === -1 && correctionActor) {
        if (resolveMessageReference(resident, messageId, 'archive-first')?.authoritative) return state
        persistCorrection(updates)
        return state
      }
      if (targetIdx !== -1) {
        const target = resident[targetIdx]
        const applicable = resolveCorrectionUpdates(target, {
          ...updates,
          ...(updates.isEdited && { originalBody: target.originalBody ?? target.body }),
        }, getStorageScopeJid())
        if (!applicable) return state
        updates = applicable
      }
      let pendingPatch: Partial<Pick<RoomState, 'pendingRetractions'>> = {}
      let updatedMessage: StoredRoomMessage | undefined
      const newMessages = targetIdx === -1 ? resident : resident.map((msg, i) => {
        if (i !== targetIdx) return msg
        updatedMessage = {
          ...msg,
          ...updates,
          ...(updates.isRetracted && msg.retractedAt ? { retractedAt: msg.retractedAt } : {}),
        }

        const replay = resolveRoomPendingRetractions(state, roomJid, [updatedMessage], { persist: false })
        updatedMessage = replay.messages[0]
        if (updatedMessage.isRetracted) updates = { ...updates, isRetracted: true, retractedAt: updatedMessage.retractedAt }
        if (replay.pendingRetractions) pendingPatch = { pendingRetractions: replay.pendingRetractions }
        return updatedMessage
      })

      // Update IndexedDB (non-blocking) — use actual message id, not the lookup key
      if (updatedMessage) {
        if (updates.isRetracted) {
          // The whole durable side of a retraction — cache row and search
          // document — is the storage sink's, so the resident path and the
          // not-resident path cannot drift.
          void retractRoomMessageInStorage(roomJid, updatedMessage, updates)
        } else if (correctionActor) {
          persistCorrection({ ...correctionPayload, ...(updates.isEdited && { ...correctionContent(updatedMessage), correctionAlternatives: updatedMessage.correctionAlternatives }), liveCorrection: liveCorrection && sameCorrection(correctionPayload, updatedMessage) }, messageReferences(updatedMessage, 'archive-first')[0])
        } else {
          const scope = captureStorageScope()
          const reindex = updates.body !== undefined
          const message = updatedMessage
          void messageCache.updateRoomMessage(
            roomJid,
            updatedMessage.id,
            { ...updates, ...(contentRecovery && { contentRecovery }) },
            updatedMessage.from,
            scope.jid,
            updatedMessage,
          ).then(() => {
            if (reindex && scope.isCurrent()) return searchIndex.updateMessage({ ...message, ...(contentRecovery && { contentRecovery }) }, scope.jid)
          }).catch(error => logWarn(`Failed to index message update: ${String(error)}`))
        }

        // A retraction may target a `noLocalStore` message noted in
        // the transient overlay (e.g. a Quick Chat message) — drop it so it
        // stops contributing, and schedule a recount if it actually left
        // (safe to call for every retraction: removeTransient is a no-op
        // when the alias was never noted).
        if (updates.isRetracted) {
          if (roomReadTracker.dropUnreadMessage(roomJid, updatedMessage)) recountNeeded = true
        }
      }

      const written = withRoomMessageWindow(state, roomJid, newMessages)
      if (!written) return state

      const result: Partial<RoomState> = { ...written, ...pendingPatch }
      if (updatedMessage) {
        if (correctionActor || updates.isEdited || updates.correctionRevision || updates.correctionStanzaIds || contentRecovery) {
          Object.assign(result, commitRoomCorrectionPreview(state, roomJid, { ...updatedMessage, ...(contentRecovery && { contentRecovery }) }))
        } else {
          const preview = state.roomMeta.get(roomJid)?.lastMessage ?? existing.lastMessage
          if (preview && matchesCorrectionTarget(preview, updatedMessage)) {
            Object.assign(result, commitRoomUpdate(state, roomJid, { lastMessage: { ...preview, ...updates } }))
          }
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

      void messageCache.updateRoomMessage(
        roomJid,
        resident[targetIdx].id,
        { stanzaId: undefined },
        resident[targetIdx].from,
        undefined,
        resident[targetIdx],
      )

      const written = withRoomMessageWindow(state, roomJid, newMessages)
      if (!written) return state

      const result: Partial<RoomState> = { ...written }
      // Against the PRE-update copy: `updatedMessage` has just lost the stanza-id
      // tier the preview may be known under.
      const meta = state.roomMeta.get(roomJid)
      const wasLastMessage =
        !!meta?.lastMessage &&
        sameLogicalMessage(roomScope(roomJid), meta.lastMessage, resident[targetIdx]) &&
        roomStanzaIdsMergeable(meta.lastMessage, resident[targetIdx])

      if (meta && wasLastMessage) {
        const newMeta = new Map(state.roomMeta)
        newMeta.set(roomJid, { ...meta, lastMessage: updatedMessage })
        result.roomMeta = newMeta
      }

      return result
    })
  },

  recordPendingRetraction: (roomJid, targetId, actorJid, actorOccupantId, moderation) => {
    const storageScopeAtStart = getStorageScopeJid()
    const record: PendingRetraction = {
      targetId,
      ...(moderation && { moderation }),
      actorJid,
      ...(actorOccupantId ? { actorOccupantId } : {}),
      retractedAt: Date.now(),
    }
    const resident = get().messages.get(roomJid) ?? []
    const resolution = resolveMessageReference(resident, targetId, 'archive-first')
    const target = resolution?.candidates.find(({ message }) =>
      roomRetractionAuthorized(message, record)
    )?.message
    if (target) {
      // Resolved on the spot — updateMessage carries the write-through to
      // IndexedDB and the search-index removal.
      get().updateMessage(
        roomJid,
        target.id,
        {
          ...moderation,
          isRetracted: true,
          retractedAt: target.retractedAt ?? new Date(record.retractedAt),
        },
        targetId,
        target
      )
      return
    }
    if (resolution?.authoritative && !moderation) return

    if (moderation) set(state => {
      const preview = state.roomMeta.get(roomJid)?.lastMessage ?? state.rooms.get(roomJid)?.lastMessage
      if (!preview || !roomRetractionAuthorized(preview, record)) return state
      return commitRoomUpdate(state, roomJid, { lastMessage: {
        ...preview, ...moderation, isRetracted: true,
        retractedAt: preview.retractedAt ?? new Date(record.retractedAt),
      } }) ?? state
    })

    set((state) => {
      const existing = state.pendingRetractions.get(roomJid) ?? []
      const next = addPendingRetraction(existing, record)
      if (next === existing) return state
      const nextPending = new Map(state.pendingRetractions)
      nextPending.set(roomJid, next)
      savePendingRetractionsToStorage(nextPending)
      return { pendingRetractions: nextPending }
    })

    // The target is not resident, but it may well be CACHED — and the cache is
    // where its identity is still canonical. Resolve and tombstone it there now,
    // instead of leaving the body readable until something reloads the message.
    void retractUnresidentRoomTarget(roomJid, record, storageScopeAtStart).then((outcome) => {
      // Switching accounts during this probe leaves a consumed authoritative
      // record persisted for the old account. After switching back, if the
      // authoritative row is not resident, an unrelated lower-tier match can
      // consume the stale record. This window is bounded to the in-flight
      // account switch; closing it requires account-scoped durable mutation
      // after the active scope changes.
      if (outcome === 'pending' || getStorageScopeJid() !== storageScopeAtStart) return
      set((state) => {
        const existing = state.pendingRetractions.get(roomJid) ?? []
        const remaining = removePendingRetraction(existing, record)
        if (remaining === existing) return state
        const nextPending = new Map(state.pendingRetractions)
        if (remaining.length === 0) nextPending.delete(roomJid)
        else nextPending.set(roomJid, remaining)
        savePendingRetractionsToStorage(nextPending)
        return { pendingRetractions: nextPending }
      })
    })
  },

  getMessage: (roomJid, messageId) => {
    return findMessageById(get().messages.get(roomJid) ?? [], messageId)
  },

  recomputeUnreadForRoom: async (roomJid, options) => {
    await roomReadTracker.recompute(roomJid, options)
  },

  getRoomLastTimestamp: (roomJid) => {
    const state = get()
    return lastMessageTimestamp(state.roomMeta, state.rooms, roomJid)
  },

  markAsRead: (roomJid) => {
    roomReadTracker.markAsRead(roomJid)
  },

  markReadToNewest: (roomJid) => {
    roomReadTracker.markReadToNewest(roomJid)
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
    // Skip if already the active room (prevents duplicate side effects).
    if (roomJid === prevJid) return
    // Only the active room keeps a resident window; the durable copy stays in IndexedDB and is
    // rehydrated by activateRoom on return.
    if (prevJid && prevJid !== roomJid) {
      set((state) => withRoomMessageWindow(state, prevJid, []) ?? state)
    }
    // The tracker marks the room active with the divider it derives, in one write.
    if (!roomJid || !roomReadTracker.activate(roomJid)) set({ activeRoomJid: roomJid })
    // After the active id has moved, so the recount does not see this room as active.
    if (prevJid && prevJid !== roomJid) roomReadTracker.deactivate(prevJid)
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
          roomReadTracker.mdsGate,
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
      const pointerRow = rowRefOfPointer(get().roomMeta.get(roomJid)?.readPointer)
      if (pointerRow) {
        const loaded = get().messages.get(roomJid) ?? []
        if (findMessageRowIndex(loaded, pointerRow) === -1) {
          await get().loadMessagesAroundFromCache(roomJid, pointerRow)
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
    roomReadTracker.clearDivider(roomJid)
  },

  resyncDividerToReadPointer: (roomJid) => {
    roomReadTracker.resyncDivider(roomJid)
  },

  advanceReadPointer: (roomJid, row) => {
    roomReadTracker.advance(roomJid, row)
  },

  /**
   * XEP-0490: drop a stashed remote marker the room's archive has proven it no
   * longer holds, so the entity stops waiting for an ordering that can never
   * happen.
   *
   * Guarded on `stanzaId` for the same reason `clearGapAnchor` guards on its
   * anchor: a newer marker may have replaced this one while the proof was being
   * gathered, and nothing has been proven about that one.
   *
   * This moves NO read pointer and writes NO count. It removes a value that
   * blocks two derivations, and both of them then run on their own inputs —
   * the recount from the archive, the publisher from the local pointer. That is
   * what keeps it clear of the forward-only guarantee: nothing here advances or
   * regresses a read position.
   *
   * Publishing the local position over the purged marker is safe for a reason
   * the caller established, not this action: the walk reached the archive start
   * without finding the marker, so it names something older than the oldest
   * message the archive holds — necessarily behind our own pointer.
   */
  discardPurgedRemoteDisplayed: (roomJid, stanzaId) => {
    roomReadTracker.discardPurgedRemoteDisplayed(roomJid, stanzaId)
  },

  applyRemoteDisplayed: (roomJid, stanzaId, messagesOverride) => {
    roomReadTracker.applyRemoteDisplayed(roomJid, stanzaId, messagesOverride)
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
    const isCurrent = captureRoomCacheRead(roomJid)
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
      const cachedMessages = await messageCache.getRoomMessages(roomJid, queryOptions).then(messages => refreshCachedCorrections(messages, isCurrent))
      if (!isCurrent()) return []
      // `peek`: a pure read that returns the messages WITHOUT pulling them into the
      // store. Used to compute a catch-up cursor for a non-active room without
      // breaking the invariant that only the active room is resident in RAM.
      // `oldest` is always a pure read too: the cache bottom must never become
      // the resident window (that would tear the UI off the live edge).
      if (!options.peek && !options.oldest && cachedMessages.length > 0) {
        // A `before`-anchored load does not establish the live edge.
        const recenter = queryOptions.latest
        // Merge with existing messages in memory using the shared helper
        set((state) => {
          // A parked window keeps its place; the latest slice waits in the cache for
          // jump-to-latest (see recenterToLatest).
          if (recenter && timeline.isParkedOffLiveEdge(state.messages.get(roomJid) ?? [], state.windowAtLiveEdge.get(roomJid) !== false)) {
            return state
          }
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

  loadMessagesAroundFromCache: async (roomJid, anchorRow, options = {}) => {
    const isCurrent = captureRoomCacheRead(roomJid)
    if (!messageCache.isMessageCacheAvailable()) {
      return []
    }

    try {
      const slice = await messageCache.getRoomMessagesAround(roomJid, anchorRow, options).then(messages => refreshCachedCorrections(messages, isCurrent))
      if (!isCurrent()) return []
      if (slice.length > 0) {
        set((state) => mergeCachedRoomAround(state, roomJid, slice, anchorRow,
          options.before ?? messageCache.AROUND_CONTEXT_BEFORE) ?? state)
      }
      return slice
    } catch (error) {
      console.error('Failed to load room messages around anchor from IndexedDB:', error)
      return []
    }
  },

  loadOlderMessagesFromCache: async (roomJid, limit = 50) => {
    const isCurrent = captureRoomCacheRead(roomJid)
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
      }).then(messages => refreshCachedCorrections(messages, isCurrent))
      if (!isCurrent()) return []

      if (cachedMessages.length > 0) {
        // Prepend to existing messages via the shared timeline machine
        set((state) => {
          const newRooms = new Map(state.rooms)
          const existing = newRooms.get(roomJid)
          if (!existing) return state
          const resident = state.messages.get(roomJid) ?? []

          // Reconcile edits, preserve resident identity, sort, and keep-oldest trim
          // (load-older slides the window so scroll-back past the bound works).
          // If keep-oldest evicted the newest resident message, the window has
          // slid off the live edge → gate live appends in addMessage.
          const { merged, newestEvicted } = timeline.loadOlderSlice(
            reconcileCachedCorrections(resident, cachedMessages, getStorageScopeJid()),
            cachedMessages,
            roomTimelineConfig()
          )

          const written = commitCachedRoomMessages(state, roomJid, merged,
            newestEvicted ? false : undefined)
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
    const isCurrent = captureRoomCacheRead(roomJid)
    if (!messageCache.isMessageCacheAvailable()) {
      return []
    }

    try {
      while (isCurrent()) {
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
        }).then(messages => refreshCachedCorrections(messages, isCurrent))
        if (!isCurrent()) return []

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

            // Reconcile edits, preserve resident identity, sort, and keep-newest trim
            // (load-newer slides the window back down toward the live edge).
            const { merged } = timeline.loadNewerSlice(
              reconcileCachedCorrections(resident, cachedMessages, getStorageScopeJid()),
              cachedMessages,
              roomTimelineConfig()
            )

            const written = commitCachedRoomMessages(state, roomJid, merged,
              reachedTail ? true : undefined)
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

        if (reachedTail || cachedMessages.some(message => !isSpamModerated(message))) return cachedMessages
        const nextTimestamp = get().messages.get(roomJid)?.at(-1)?.timestamp.getTime()
        if (nextTimestamp === undefined || nextTimestamp <= afterDate.getTime()) return cachedMessages
      }
      return []
    } catch (error) {
      console.error('Failed to load newer room messages from IndexedDB:', error)
      return []
    }
  },

  recenterToLatest: async (roomJid) => {
    // Jump-to-latest is the one latest-slice load that replaces a parked window, which
    // loadMessagesFromCache leaves in place, so it merges the peeked slice itself. A full
    // window's worth keeps the merge contiguous: keep-newest drops the parked rows.
    const latest = await get().loadMessagesFromCache(roomJid, { limit: getResidentWindowSize(), peek: true })
    // The flag is forced true even when the newest window was already fully resident.
    set((state) => {
      const update = latest.length > 0 ? mergeCachedRoomMessages(state, roomJid, latest) : null
      const base = update?.windowAtLiveEdge ?? state.windowAtLiveEdge
      if (base.get(roomJid) === true) return update ?? state
      return { ...(update ?? {}), windowAtLiveEdge: new Map(base).set(roomJid, true) }
    })
  },

  // Load the latest non-ignored message from cache for sidebar preview
  // This doesn't modify the messages array - it only updates lastMessage
  loadPreviewFromCache: async (roomJid) => {
    const isCurrent = captureRoomCacheRead(roomJid)
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

      if (!isCurrent()) return null

      if (cachedMessages.length > 0) {
        const latestMessage = findLastNonIgnoredMessage(cachedMessages, roomJid, room.nickToJidCache)
        if (!latestMessage) return null

        // Update only lastMessage in metadata and combined room
        set((state) => {
          if (!isCurrent()) return state
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

        return isCurrent() ? latestMessage : null
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
        const isCurrent = captureRoomCacheRead(room.jid)
        try {
          const cachedMessages = await messageCache.getRoomMessages(room.jid, { limit: 10, latest: true })
          if (!isCurrent() || cachedMessages.length === 0) return null
          const latest = findLastNonIgnoredMessage(cachedMessages, room.jid, room.nickToJidCache)
          return latest ? { roomJid: room.jid, latest, isCurrent } : null
        } catch {
          // Best-effort per room - one room's cache failure shouldn't block others.
          return null
        }
      })
    )

    const updates = previews.filter((p): p is { roomJid: string; latest: RoomMessage; isCurrent: () => boolean } => p !== null)
    if (updates.length === 0) return

    // Apply every preview in a single write. shouldUpdateLastMessage guards against
    // clobbering a fresher preview that a join/catch-up may have set in the meantime.
    set((state) => {
      const newMeta = new Map(state.roomMeta)
      const newRooms = new Map(state.rooms)
      let changed = false
      for (const { roomJid, latest, isCurrent } of updates) {
        if (!isCurrent()) continue
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
  setRoomMAMLoading: (roomJid, isLoading, requestId) => {
    set((state) => ({
      mamQueryStates: mamState.setMAMLoading(state.mamQueryStates, roomJid, isLoading, requestId),
    }))
    if (!isLoading) roomReadTracker.resumeDeferredRecounts(roomJid)
  },

  setRoomMAMError: (roomJid, error, requestId) => {
    set((state) => ({
      mamQueryStates: mamState.setMAMError(state.mamQueryStates, roomJid, error, requestId),
    }))
  },

  mergeRoomMAMMessages: (roomJid, archivePage, page, complete, direction, options = {}) => {
    const { isFetchLatest = false, preserveGapMarker = false, extras } = options
    roomReadTracker.noteUnreadInputsChanged(roomJid)
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
    // Diagnostics only. A holder rather than bare locals lets the set() callback
    // write the counters without allocating a payload.
    const mergeDiagnostics = newArchiveMergeTally()
    let ownArchiveWrite: Promise<boolean> | undefined
    let coverageBootstrappedFromWalkExtent = false
    let coverageChanged = false
    set((state) => {
      const room = state.rooms.get(roomJid)
      if (!room) return state

      // Get existing messages for this room
      const existingMessages = state.messages.get(roomJid) ?? []

      // Shared timeline machine: archive-id backfill onto resident messages
      // (so an outgoing reflection gains its MAM cursor — was a chat-only
      // behavior before the extraction), direction-aware merge (backward =
      // optimized prepend + keep-oldest, forward = full sort + keep-newest),
      // dedupe, eviction reporting, and the live-edge gate for a parked window.
      const { merged, resident, gated, newMessages: newFromMAM, patched, newestEvicted } = timeline.mergeArchive(
        existingMessages,
        mamMessages,
        direction,
        roomTimelineConfig(),
        isFetchLatest,
        state.windowAtLiveEdge.get(roomJid) !== false
      )
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
      // Crash-window safety: a gap or coverage transition names this page, and the rows it names
      // are written fire-and-forget. Persisting the transition before that write commits lets a
      // crash — or a write that silently failed — skip the page forever, so every transition waits
      // for the write when there is one to wait for.
      const persistableMessages = newFromMAM.filter(msg => !isNoLocalStore(msg))
      const persistablePatches = patched.filter(msg => !isNoLocalStore(msg))
      const archiveWriteMessages = [...persistableMessages, ...persistablePatches]
      durableMessages = archiveWriteMessages
      mergeDiagnostics.returned = mamMessages.length
      mergeDiagnostics.newMessages = newFromMAM.length
      mergeDiagnostics.persistableNew = persistableMessages.length
      mergeDiagnostics.patched = patched.length
      mergeDiagnostics.persistablePatched = persistablePatches.length
      mergeDiagnostics.counted = true
      // A merge with nothing persistable still defers when earlier pages of this room are in
      // flight (or failed): its cursor must not leap them.
      const mustGateOnChain = archiveWriteMessages.length > 0 || roomArchiveSaves.has(roomJid)
      const plan = roomArchiveMerge.planMerge(roomJid, {
        gaps: state.roomGaps,
        coverage: state.roomCoverage,
        mamStates: newStates,
        direction,
        complete,
        isFetchLatest,
        preserveGapMarker,
        page,
        extras,
        merged,
        fetched: mamMessages,
        newMessagesCount: newFromMAM.length,
        patchedCount: patched.length,
        residentNewestTs,
        newestHeldBelowId: newestMessageStanzaId(existingMessages),
        fallbackHeldTs,
        gatedOnDurableWrite: mustGateOnChain,
      })
      newStates = plan.mamStates
      coverageChanged = plan.coverageChanged
      coverageBootstrappedFromWalkExtent = plan.coverageBootstrappedFromWalkExtent
      const gapsAfterMerge = plan.gapsAfterMerge
      const coverageAfterMerge = plan.coverageAfterMerge

      if (archiveWriteMessages.length > 0) {
        const savePromise = messageCache.saveRoomMessages(archiveWriteMessages)
        ownArchiveWrite = savePromise
        archiveCommitGate = roomArchiveSaves.chain(roomJid, savePromise)
        plan.commitWhenDurable(archiveCommitGate)
        if (persistableMessages.length > 0) {
          searchIndex.indexMessages(persistableMessages).catch((e) => console.warn('[searchIndex] indexMessages failed:', e))
        }
      }

      // If no new messages (all duplicates), only update MAM state - skip room messages
      // This prevents unnecessary re-renders when merging duplicates.
      // Exception: a stanzaId backfill onto existing RAM messages must persist —
      // but only for the ACTIVE room (non-active rooms keep no resident array).
      if (newFromMAM.length === 0) {
        // Nothing of our own to persist, but earlier in-flight pages may
        // still gate this merge's transitions: chain a no-op save so the
        // transition applies (or is dropped) with the same ordering rules.
        if (!archiveCommitGate && plan.deferred) {
          archiveCommitGate = roomArchiveSaves.chain(roomJid, Promise.resolve(true))
          plan.commitWhenDurable(archiveCommitGate)
        }
        if (patched.length === 0 || state.activeRoomJid !== roomJid) {
          return { mamQueryStates: newStates, roomGaps: gapsAfterMerge, roomCoverage: coverageAfterMerge }
        }
        const backfilled = withRoomMessageWindow(state, roomJid, resident)
        return { ...backfilled, mamQueryStates: newStates, roomGaps: gapsAfterMerge, roomCoverage: coverageAfterMerge }
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
        if (direction === 'forward' && newFromMAM.length > 0 && !coverageBootstrappedFromWalkExtent) {
          shouldRecountAfterMerge = true
        }

        // roomRuntime deliberately untouched.
        return { rooms: newRooms, roomMeta: newMeta, mamQueryStates: newStates, roomGaps: gapsAfterMerge, roomCoverage: coverageAfterMerge }
      }

      // ACTIVE room: populate the resident array (foreground catch-up / scroll-up).
      const written = withRoomMessageWindow(state, roomJid, resident, {
        roomPatch: { lastMessage },
        ...(newestEvicted
          ? { atLiveEdge: false }
          : isFetchLatest && newFromMAM.length > 0 && !gated
            ? { atLiveEdge: true }
            : {}),
      })

      // Accepted edge case: a fresh-session bail fetch-latest while the user is
      // scrolled up inside a window still at the live edge can evict resident
      // messages via keep-newest and jump the window to live — same class as
      // jump-to-latest. The content-anchor scroll restore then degrades to an
      // estimate rather than an exact reposition.

      return { ...written, roomMeta: newMeta, mamQueryStates: newStates, roomGaps: gapsAfterMerge, roomCoverage: coverageAfterMerge }
    })

    reportArchiveMergeWhenDurable(
      'room',
      roomJid,
      direction,
      complete,
      mergeDiagnostics,
      ownArchiveWrite,
      archiveCommitGate
    )

    if (archiveCommitGate) {
      void archiveCommitGate.then((committed) => {
        if (!committed || roomCacheEpoch !== cacheEpochAtMerge || currentRoomEntityEpoch(roomJid) !== entityEpochAtMerge || getStorageScopeJid() !== storageScopeAtMerge) return
        for (const message of durableMessages) roomReadTracker.dropUnreadMessage(roomJid, message)
        roomReadTracker.resumeDeferredRecounts(roomJid)
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
    if (coverageChanged || (direction === 'forward' && complete)) {
      if (!archiveCommitGate && roomArchiveSaves.has(roomJid)) {
        archiveCommitGate = roomArchiveSaves.chain(roomJid, Promise.resolve(true))
      }
      const resume = async () => {
        if (roomCacheEpoch !== cacheEpochAtMerge || currentRoomEntityEpoch(roomJid) !== entityEpochAtMerge || getStorageScopeJid() !== storageScopeAtMerge) return
        if (direction === 'forward' && complete && !preserveGapMarker && !extras?.walkCarriedModifications) {
          const record = get().roomCoverage.get(roomJid)
          const inputsUnchanged = roomReadTracker.captureUnreadInputs(roomJid)
          const repaired = await recoverCoverageForCounting(roomJid, record,
            [extras?.initialAfter, extras?.walkOldestId ?? walkExtentBottomId(mamMessages)], true)
          if (roomCacheEpoch !== cacheEpochAtMerge || currentRoomEntityEpoch(roomJid) !== entityEpochAtMerge || getStorageScopeJid() !== storageScopeAtMerge || !inputsUnchanged()) return
          if (repaired && get().roomCoverage.get(roomJid) === record) {
            set(state => {
              const next = new Map(state.roomCoverage).set(roomJid, repaired)
              saveCoverageToStorage(next, undefined, { roomJid, kind: record ? 'replaced' : 'created' })
              return { roomCoverage: next }
            })
            coverageChanged = true
          }
        }
        roomReadTracker.resumeDeferredRecounts(roomJid)
        if (coverageChanged) roomReadTracker.scheduleRecount(roomJid)
      }
      if (archiveCommitGate) void archiveCommitGate.then((committed) => { if (committed) return resume() })
      else void resume()
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
  if (state.firstNewMessageMarkers === previous.firstNewMessageMarkers
    && state.messages === previous.messages
    && state.lastArrivedMessage === previous.lastArrivedMessage) return
  const counts = notifState.nextDividerCounts(
    state.firstNewMessageCounts,
    { markers: state.firstNewMessageMarkers, messages: state.messages, lastArrivedMessage: state.lastArrivedMessage },
    { markers: previous.firstNewMessageMarkers, messages: previous.messages, lastArrivedMessage: previous.lastArrivedMessage },
    'room',
  )
  if (counts !== state.firstNewMessageCounts) roomStore.setState({ firstNewMessageCounts: counts })
})

// A remote read marker no loaded slice could place waits for messages; their arrival is the only
// thing that can make it placeable.
roomStore.subscribe((state, previous) => {
  const roomJid = state.activeRoomJid
  if (!roomJid) return
  if (state.messages.get(roomJid) === previous.messages.get(roomJid)) return
  roomReadTracker.retryRemoteDivider(roomJid)
})
