import { getStorageScopeJid } from '../../utils/storageScope'
import { findMessageRowIndex } from '../../utils/messageIdentity'
import type { MessageRowRef } from '../../core/types/messageRow'
import { getBareJid } from '../../core/jid'
import { getRoomModerationId } from '../../utils/roomStanzaId'
import { isMessageRow, matchesMessageRowAlias, occupantConflict } from '../../utils/messageIdentity'
import {
  compareExact,
  exactPosition,
  isAfterBoundary,
  normalizeRoomRowOrder,
  type ExactPosition,
  type PointerOrder,
} from '../shared/readState'
import type { RoomMessage } from '../../core/types/room'
import { locallyPublishedDisplayed } from '../../core/localMdsPublishes'
import { connectionStore } from '../connectionStore'
import {
  onMarkAsRead,
  onMessageSeen,
  type EntityNotificationState,
  type NotificationMessage,
} from '../shared/notificationState'
import {
  advance,
  hasFloorResolutionEvidence,
  pointerRowRef,
  isAhead,
  makeReadPointer,
  type PointerSource,
  type ReadPointer,
} from '../shared/readPointer'
import { countOnlyClear, recountLedger, reportUnreadCleared } from '../shared/recountDiagnostics'
import type { RecountDeferralReason } from '../../diagnostics/channel'
import type { CoverageRecord } from '../../core/types/pagination'
import type { CoverageBottom } from '../shared/mamCoverage'
import { computeFloor, pointerlessDefers, worthReconcilingOnDeactivate } from '../shared/readState'
import { isMarkerSuperseded } from '../shared/purgedMarkers'
import { noteTransient, removeTransient, transientCounts } from '../shared/transientUnread'
import { sameMessageRow } from '../../utils/messageIdentity'
import { isUnseenIncomingMessage, onActivate, onMessageReceived } from '../shared/notificationState'
import { isRenderableStoredMessage } from '../../utils/messageRenderability'
import { getStorageScopeJid as currentStorageScope } from '../../utils/storageScope'
import { beginViewportGeneration } from '../shared/viewportEvidence'
import { resolveRoomReadPointerOrder } from '../shared/readPointer'
import { findMessageRowIndex as findRow } from '../../utils/messageIdentity'
import { createPendingEntityWrites } from '../shared/pendingEntityWrites'
import { createRecountRetryScheduler } from '../shared/recountRetry'
import {
  createMdsSessionGate,
  resolveRemoteDisplayed,
  resolveStashedRemoteDisplayed,
  supersededPendingMarker,
} from '../shared/readMarkerSync'
import { createRemoteDividerAdvanceTracker } from '../shared/dividerAdvance'
import { clearTransientEntity, clearTransientScope, pruneTransient } from '../shared/transientUnread'
import { clearViewportEvidence, currentViewportEvidence } from '../shared/viewportEvidence'
import { clearPurgedMarkers, isMarkerPurged, notePurgedMarker, noteSupersededMarker } from '../shared/purgedMarkers'

export type ReadTrackerKind = 'chat' | 'room'

/**
 * Keys the account-scoped read-state registries (transient overlay, viewport
 * evidence, purged markers). A bare entity id can collide across accounts, so
 * every key carries the account JID.
 */
export interface ReadTrackerScopeKey {
  accountScope: string
  kind: ReadTrackerKind
  entityId: string
}

/** What the tracker reads of one entity, taken from a single store snapshot. */
export interface ReadStateView {
  readPointer: ReadPointer | undefined
  unreadCount: number
  /** Always 0 for 1:1 conversations. */
  mentionsCount: number
  /** The resident slice, in display order. */
  messages: NotificationMessage[]
  /** Whether the resident slice reaches the newest message. */
  atLiveEdge: boolean
  isActive: boolean
  /** The row the new-message divider sits above, if one is parked. */
  divider: MessageRowRef | undefined
  /** The entity's newest known message, for when the resident slice is empty. */
  lastMessage: PointerSource | undefined
  /** A remote XEP-0490 marker no loaded slice could order yet. */
  pendingRemoteMarker: string | undefined
  /** When the entity entered this client's world. Not a read position. */
  historyFloor: Date | undefined
}

/** A write to one entity. Absent fields are left as they are. */
export interface ReadStatePatch {
  readPointer?: ReadPointer
  unreadCount?: number
  mentionsCount?: number
  /** Stashes a remote marker; `null` drops the stashed one. */
  pendingRemoteMarker?: string | null
  /** Moves the new-message divider; `null` removes it. */
  divider?: MessageRowRef | null
  /**
   * The entity becomes the one being viewed, in this same transaction. Activation derives the
   * divider from the read position, and a store that marked the entity active in a separate
   * write would render it once without the line the reader is about to be shown.
   */
  becomesActive?: true
}

/**
 * The store side of the tracker: one adapter per entity kind, because chats and
 * rooms keep their read fields in different maps.
 */
export interface ReadTrackerStorage {
  /**
   * Reads the entity and applies `change`'s patch in one store transaction.
   * Skips the entity when the store does not hold it, and writes nothing when
   * `change` returns `undefined`.
   */
  update(entityId: string, change: (view: ReadStateView) => ReadStatePatch | undefined): void
  /** The entity's current view, or `undefined` when the store does not hold it. */
  read(entityId: string): ReadStateView | undefined
}

/** A read position that XEP-0490 can publish: an archive id, and the pointer it names. */
export interface PublishPosition {
  stanzaId: string
  readPointer: ReadPointer
}

/**
 * One arrival, threaded through the three steps it takes: the overlay entry noted before the
 * store's write, the read fields that write commits, and the cleanup once the message is durable
 * (or was refused). Created by {@link ReadTracker.beginArrival}.
 */
export interface ArrivalNote {
  readonly entityId: string
  /** How much the transient overlay grew: this arrival's contribution to the count. */
  readonly unreadDelta: number
  /** The overlay change only an archive-derived recount can fold back into the stored count. */
  readonly requiresRecount: boolean
  /** Whether the arrival was noted in the overlay, which suppresses the live increment. */
  readonly noted: boolean
  /** What names the overlay entry, for the removal that ends this arrival. */
  readonly source: string | RoomMessage
}

export interface ReadTrackerPorts {
  storage: ReadTrackerStorage
  /**
   * Starts the archive-backed unread recount. The resident slice may be one
   * page of a longer walk, so no read-state change derives the count from it.
   * The recount skips the entity being viewed unless `allowActive` is set.
   */
  recount(entityId: string, options?: { allowActive?: boolean }): void
  /**
   * Cached rows that can order a stashed remote marker: the marker's own row
   * and, for a floor pointer, the pointer's row. `null` when the cache does not
   * hold the marker.
   */
  loadStashedMarkerRows(entityId: string, stanzaId: string): Promise<NotificationMessage[] | null>
  /** Returns a check that the cache and the entity are still those of this call. */
  captureCacheRead(entityId: string): () => boolean
  /**
   * Cached rows that could carry the archive id for `pointer`: for a room, the rows sharing the
   * pointer's message id; for a chat, a bounded window of rows at or behind it. `null` when the
   * cache could not be read — which is not the same answer as "no such row", and never resolves
   * a position.
   */
  loadPublishCandidates(entityId: string, pointer: ReadPointer): Promise<NotificationMessage[] | null>
  /** Whether catch-up has reached the point where the archive can be counted. */
  historyCaughtUp(entityId: string): boolean
  /** The proof of contiguous history a count is ordered against, if the entity has one. */
  coverageRecord(entityId: string): CoverageRecord | undefined
  /** The oldest position `record` proves contiguous with the live edge. */
  resolveCoverageBottom(entityId: string, record: CoverageRecord | undefined): Promise<CoverageBottom>
  /** Drops a coverage record whose bottom no longer resolves, so a later merge re-establishes it. */
  invalidateCoverage(entityId: string, record: CoverageRecord): void
  /** The archive's unread count at or after `floor`. `null` when the cache is unavailable. */
  countUnreadFromArchive(
    entityId: string,
    range: { floor: Date; pointer: PointerOrder | undefined },
  ): Promise<{ unread: number } | null>
  /**
   * Whether the entity's archive is settled enough to count unread from it:
   * no archive page write in flight and catch-up far enough along. Owned by the
   * store because archive saves and MAM state belong to history, not read state.
   */
  archiveReadyForCounting(entityId: string): boolean
}

/**
 * Read state for one kind of entity (1:1 conversations or rooms): the
 * bookkeeping every read-state writer consults.
 *
 * The recount, unread-input and pending-write registries are per entity and
 * per session: {@link forgetEntity} drops one entity, the two resets drop all.
 */
export function createReadTracker(kind: ReadTrackerKind, ports: ReadTrackerPorts) {
  // Latest-wins ordering for competing recounts of one entity. A recount bumps
  // this before it awaits and re-checks it before committing, so an older
  // recount that resolves last is discarded instead of overwriting a newer one.
  const recountVersions = new Map<string, number>()
  // Bumped whenever an input of the unread count changes outside a recount
  // (a transient entry added or removed, a stashed remote marker), so a
  // recount computed from older inputs defers instead of committing.
  const unreadInputVersions = new Map<string, number>()
  const pendingUnreadWrites = createPendingEntityWrites()
  const recountsInFlight = createPendingEntityWrites()
  const recountRetry = createRecountRetryScheduler((error) => {
    console.warn(`Unread recount retry failed for a ${kind === 'chat' ? 'conversation' : 'room'}:`, error)
  })
  const mdsGate = createMdsSessionGate()
  const remoteDividerAdvances = createRemoteDividerAdvanceTracker()
  // The account scope this tracker last filed registry entries under. Tracked
  // separately from `getStorageScopeJid()` because XMPPClient flips the global
  // scope to the incoming account before the store's `switchAccount` runs, so
  // at teardown the global scope already names the new account.
  let lastScope: string | null = null

  const scopeKey = (entityId: string): ReadTrackerScopeKey =>
    ({ accountScope: getStorageScopeJid() ?? '', kind, entityId })

  const ownBareJid = (): string => {
    const jid = connectionStore.getState().jid
    return jid ? getBareJid(jid) : ''
  }

  /**
   * The newest message carrying an archive id at or behind `boundary`.
   *
   * In a 1:1 the pointer normally comes to rest on the user's OWN send, which never acquires an
   * archive id: the server does not echo our own messages back, so the only id it ever has is the
   * client-generated origin-id, which XEP-0490 cannot publish. Without this fallback such a
   * position is unresolvable permanently, and 1:1 read positions stop reaching the account's other
   * devices as soon as the user replies.
   *
   * It can never publish ahead of the read position: candidates after the pointer are filtered
   * out, by the pointer's own order rather than its index, so its message need not be resident.
   * What it gives up is precision over the user's own trailing sends, which no receiver derives
   * anything from — unread counting excludes outgoing messages everywhere.
   */
  const newestResolvableAtOrBehind = (
    messages: readonly { stanzaId?: string; from?: string; id: string; timestamp: Date }[],
    boundary: PointerOrder,
  ): PublishPosition | undefined => {
    let best: { pos: ExactPosition; publish: PublishPosition } | undefined
    for (const message of messages) {
      if (!message.stanzaId) continue
      const pos = exactPosition(message, 'chat')
      // A BOUNDARY test: a floor pointer reads as at-or-after its millisecond, so withhold that
      // millisecond rather than publish past it (#1173).
      if (isAfterBoundary(pos, boundary)) continue
      if (!best || compareExact(pos, best.pos) > 0) {
        best = { pos, publish: { stanzaId: message.stanzaId, readPointer: makeReadPointer(message, 'chat') } }
      }
    }
    return best?.publish
  }

  /** Whether `candidate` is the very row `pointer` names, by this account, in this room. */
  const matchesRoomPointer = (roomJid: string, pointer: ReadPointer, candidate: RoomMessage): boolean => {
    const { order } = pointer
    if (pointer.identity.state === 'addressable' && pointer.identity.archiveScope &&
      (pointer.identity.archiveScope.roomJid !== roomJid || pointer.identity.archiveScope.accountJid !== ownBareJid())) return false
    if (candidate.roomJid !== roomJid || getStorageScopeJid() !== ownBareJid() ||
      !getRoomModerationId(candidate, ownBareJid())) return false
    const row = pointerRowRef(pointer)
    if (order.role !== 'exact' || order.tiebreak.kind !== 'room' || !order.tiebreak.from ||
      candidate.from !== order.tiebreak.from || candidate.id !== row.id ||
      occupantConflict(candidate, row) || +candidate.timestamp !== order.timestamp ||
      !isMessageRow(candidate, row)) return false
    if (pointer.identity.state === 'local' &&
      !matchesMessageRowAlias(candidate.localRowRef, { ...row, occupantId: row.occupantId ?? candidate.occupantId })) return false
    const position = exactPosition(candidate, 'room')
    return position.tiebreak.kind === 'room' && position.tiebreak.id === order.tiebreak.id &&
      (order.tiebreak.occupantId === undefined || position.tiebreak.occupantId === order.tiebreak.occupantId) &&
      (order.tiebreak.row === undefined || normalizeRoomRowOrder(position.tiebreak.row) === normalizeRoomRowOrder(order.tiebreak.row))
  }

  const resolveRoomPublishPosition = async (
    roomJid: string, pointer: ReadPointer, view: ReadStateView,
  ): Promise<PublishPosition | undefined> => {
    if (pointer.order.role !== 'exact' || pointer.order.tiebreak.kind !== 'room' || !pointer.order.tiebreak.from) return undefined
    const cached = await ports.loadPublishCandidates(roomJid, pointer)
    if (cached === null) return undefined
    const rows = [...view.messages, ...(view.lastMessage ? [view.lastMessage] : []), ...cached] as RoomMessage[]
    const matches = rows.filter(message => matchesRoomPointer(roomJid, pointer, message))
    // One row, or the pointer does not name a single row of this room: publishing the wrong
    // occupant's row would name a foreign position.
    const candidates = [...new Map(matches.map(message => [getRoomModerationId(message, ownBareJid()), message])).values()]
    if (candidates.length !== 1) return undefined
    const message = candidates[0]
    return { stanzaId: message.stanzaId!, readPointer: { order: pointer.order, identity: makeReadPointer(message, 'room').identity } }
  }

  const resolveChatPublishPosition = async (
    conversationId: string, pointer: ReadPointer, view: ReadStateView,
  ): Promise<PublishPosition | undefined> => {
    const seenId = pointer.identity.messageId
    const resident = view.messages.find(message => message.id === seenId)
    if (resident?.stanzaId) return { stanzaId: resident.stanzaId, readPointer: makeReadPointer(resident, 'chat') }
    // Same eviction fallback for a backgrounded conversation, which keeps no resident rows.
    const last = view.lastMessage
    if (last?.id === seenId && last.stanzaId) return { stanzaId: last.stanzaId, readPointer: makeReadPointer(last, 'chat') }
    return newestResolvableAtOrBehind(view.messages, pointer.order)
      // The cache is the same archive without the memory windowing, so it closes the gap a
      // backgrounded conversation leaves (#1175).
      ?? newestResolvableAtOrBehind(await ports.loadPublishCandidates(conversationId, pointer) ?? [], pointer.order)
  }

  /**
   * The divider a recount leaves behind, or `undefined` when it stays as it is.
   *
   * The entity being viewed keeps the divider the reader is looking at: it marks where the
   * unread messages began when the view was opened, and re-deriving it from the pointer would
   * walk the line down the screen as the reader reads. A background entity has a stale marker
   * retired instead.
   */
  const retiredDivider = (view: ReadStateView): MessageRowRef | null | undefined => {
    const parked = view.divider
    if (parked === undefined || view.isActive) return undefined
    const rederived = onActivate(
      { unreadCount: 0, mentionsCount: 0, readPointer: view.readPointer, firstNewMessageRow: undefined },
      view.messages,
      kind,
    ).firstNewMessageRow
    if (sameMessageRow(rederived, parked)) return undefined
    return rederived ?? null
  }

  const notificationInput = (view: ReadStateView): EntityNotificationState => ({
    unreadCount: view.unreadCount,
    mentionsCount: view.mentionsCount,
    readPointer: view.readPointer,
    firstNewMessageRow: view.divider,
  })

  const bumpRecountVersion = (entityId: string): number => {
    const next = (recountVersions.get(entityId) ?? 0) + 1
    recountVersions.set(entityId, next)
    return next
  }

  const bumpUnreadInputVersion = (entityId: string): void => {
    unreadInputVersions.set(entityId, (unreadInputVersions.get(entityId) ?? 0) + 1)
  }

  /**
   * XEP-0490: another device (or this one, echoed back) published how far the
   * account has read. Advances the pointer forward-only when the marker can be
   * ordered against it, and otherwise stashes the marker until a loaded slice
   * or the cache can order it. Pending and ordering rules live in
   * `shared/readMarkerSync`.
   *
   * `messagesOverride` is the slice to order against when the entity keeps no
   * resident messages (a background entity whose archive page just merged).
   */
  const applyRemoteDisplayed = (entityId: string, stanzaId: string, messagesOverride?: NotificationMessage[]): void => {
    // A marker already proven absent from the archive can never be ordered;
    // stashing it again would re-arm the lock its discard released. The node
    // keeps serving it until this client's own position replaces it.
    if (isMarkerPurged(scopeKey(entityId), stanzaId)) return
    let advancedBackground = false
    let advancedActive = false
    let releasedStash = false
    let stashed = false
    let supersededStash: string | undefined
    ports.storage.update(entityId, (view) => {
      const messages = messagesOverride ?? view.messages
      const resolution = resolveRemoteDisplayed(
        {
          unreadCount: view.unreadCount,
          mentionsCount: view.mentionsCount,
          readPointer: view.readPointer,
          pendingRemoteDisplayedStanzaId: view.pendingRemoteMarker,
        },
        messages,
        view.divider,
        stanzaId,
        kind,
        kind === 'room' ? { isActive: view.isActive, roomJid: entityId } : { isActive: view.isActive },
      )
      supersededStash = supersededPendingMarker(view.pendingRemoteMarker, stanzaId, resolution)
      if (resolution.kind === 'unchanged') return undefined

      const clearsPending = view.pendingRemoteMarker === stanzaId
      releasedStash = clearsPending
      const patch: ReadStatePatch = {}
      switch (resolution.kind) {
        case 'stash-pending':
          stashed = true
          patch.pendingRemoteMarker = stanzaId
          break
        case 'clear-pending':
          patch.pendingRemoteMarker = null
          break
        case 'resolved-active':
          if (clearsPending) patch.pendingRemoteMarker = null
          break
        case 'advanced':
        case 'advanced-active':
          // The pointer moves now; the count is re-derived from the archive
          // below, which defers while coverage cannot support it.
          patch.readPointer = resolution.readPointer
          if (clearsPending) patch.pendingRemoteMarker = null
          if (resolution.kind === 'advanced') advancedBackground = true
          else advancedActive = true
          break
      }

      // The divider follows a marker only when it reaches further than anything
      // this client published: publishing reaches every resource of the
      // account, so a marker at or behind our own position is our own scroll
      // coming back, and following it would let scrolling move the divider.
      if (resolution.kind === 'advanced-active' || resolution.kind === 'resolved-active') {
        const markerPointer = resolution.kind === 'resolved-active' ? resolution.markerPointer : resolution.readPointer
        const claimed = locallyPublishedDisplayed(getBareJid(connectionStore.getState().jid ?? ''), entityId)
        if (claimed === undefined || isAhead(markerPointer, claimed)) {
          const dividerAdvance = remoteDividerAdvances.apply(entityId, view.divider, markerPointer, messages, kind)
          if (dividerAdvance.kind === 'advanced') patch.divider = dividerAdvance.divider
        }
      }
      // A `resolved-active` that moved no divider and released no stash changed
      // nothing; writing anyway would re-render every consumer on each echo of
      // this client's own scrolling.
      return Object.keys(patch).length > 0 ? patch : undefined
    })

    if (stashed) bumpUnreadInputVersion(entityId)
    if (supersededStash !== undefined) noteSupersededMarker(scopeKey(entityId), supersededStash)
    if (advancedBackground) {
      ports.recount(entityId)
    } else if (advancedActive || releasedStash || supersededStash !== undefined) {
      // The active entity needs the same re-derivation; a released or
      // superseded stash re-derives the count that deferred on it.
      ports.recount(entityId, { allowActive: true })
    }
    if (stashed) {
      void resolveStashedRemoteDisplayed(
        stanzaId,
        ports.captureCacheRead(entityId),
        () => ports.storage.read(entityId)?.pendingRemoteMarker,
        () => ports.loadStashedMarkerRows(entityId, stanzaId),
        (rows) => applyRemoteDisplayed(entityId, stanzaId, rows),
      )
    }
  }

  const clearSessionRegistries = (): void => {
    recountVersions.clear()
    unreadInputVersions.clear()
    pendingUnreadWrites.clear()
    recountsInFlight.clear()
    recountRetry.clear()
    remoteDividerAdvances.reset()
  }

  const clearAccountRegistries = (accountScope: string): void => {
    clearTransientScope(accountScope)
    clearViewportEvidence(accountScope)
    clearPurgedMarkers(accountScope)
  }

  return {
    kind,
    scopeKey,
    mdsGate,



    recountReady(entityId: string): boolean {
      return !pendingUnreadWrites.has(entityId) && ports.archiveReadyForCounting(entityId)
    },

    /**
     * The viewport reports that the user has seen `row`. Advances the read
     * pointer forward to it, and clears the counts when the row is the newest
     * one and both the resident slice and the measured viewport sit at the live
     * edge of the entity being viewed.
     *
     * Ignored while the window is hidden: the viewport reports what is painted,
     * and the list follows arriving messages whether or not anyone is looking.
     * Painted is not seen (#1076).
     */
    advance(entityId: string, row: MessageRowRef): void {
      if (!connectionStore.getState().windowVisible) return

      let pointerAdvanced = false
      let readThrough = false
      ports.storage.update(entityId, (view) => {
        const seen = onMessageSeen(notificationInput(view), row, view.messages, kind, { atLiveEdge: view.atLiveEdge })
        // Seeing the newest row with the resident slice and the viewport both at
        // the live edge is direct read evidence, even while the archive recount
        // defers. A mounted row alone is not. A complete zero also proves that
        // no unread mention remains.
        readThrough = view.atLiveEdge
          && view.isActive
          && currentViewportEvidence(scopeKey(entityId)) === 'at-edge'
          && view.messages.length > 0
          && findMessageRowIndex(view.messages, row) === view.messages.length - 1
        const unreadCount = readThrough ? 0 : view.unreadCount
        const mentionsCount = readThrough ? 0 : view.mentionsCount
        pointerAdvanced = seen.readPointer !== view.readPointer
        if (!pointerAdvanced && unreadCount === view.unreadCount && mentionsCount === view.mentionsCount) {
          return undefined
        }

        // A count-only clear must also invalidate a recount already in flight;
        // the recount's pointer-reference guard cannot detect this transition.
        if (readThrough) bumpRecountVersion(entityId)
        if (pointerAdvanced && seen.readPointer) pruneTransient(scopeKey(entityId), seen.readPointer.order)

        return { ...(seen.readPointer && { readPointer: seen.readPointer }), unreadCount, mentionsCount }
      })

      // A witnessed live tail already committed its zero and needs no archive round trip.
      if (pointerAdvanced && !readThrough) ports.recount(entityId, { allowActive: true })
    },

    /**
     * The user marked the entity read (opening it, focusing it, or the store's
     * read-on-view paths). Clears the counts, and moves the pointer to the
     * newest row only when the resident slice and the viewport both sit at the
     * live edge. The divider stays: it marks where this visit's unread began.
     */
    markAsRead(entityId: string): void {
      // Published after the update, never from inside the store transaction.
      let clearedFrom: number | undefined
      ports.storage.update(entityId, (view) => {
        const input = notificationInput(view)
        const windowAtLiveEdge = view.atLiveEdge
        const viewportAtLiveEdge = currentViewportEvidence(scopeKey(entityId)) === 'at-edge'
        let updated = onMarkAsRead(input, view.messages, kind, { windowAtLiveEdge, viewportAtLiveEdge })

        // Recounts need an exact boundary for a proven, already-read newest row.
        const lastIndex = view.messages.length - 1
        const newest = view.messages[lastIndex]
        if (windowAtLiveEdge && viewportAtLiveEdge && newest && updated.readPointer
          && hasFloorResolutionEvidence(updated.readPointer, view.messages, lastIndex, kind)) {
          updated = {
            ...updated,
            readPointer: { order: makeReadPointer(newest, kind).order, identity: updated.readPointer.identity },
          }
        }
        if (updated === input) return undefined

        clearedFrom = countOnlyClear(input, updated)
        if (updated.readPointer && updated.readPointer !== input.readPointer) {
          pruneTransient(scopeKey(entityId), updated.readPointer.order)
        }
        return {
          ...(updated.readPointer && { readPointer: updated.readPointer }),
          unreadCount: updated.unreadCount,
          mentionsCount: updated.mentionsCount,
        }
      })
      if (clearedFrom !== undefined) reportUnreadCleared(kind, entityId, clearedFrom)
    },

    /**
     * Mark-all-read (Esc, or the bulk action): reads up to the newest message
     * the entity holds, resident or not, zeroes the counts and removes the
     * divider. A pointer that already names the newest message only has its
     * order resolved; otherwise it advances, never back.
     */
    markReadToNewest(entityId: string): void {
      remoteDividerAdvances.clear(entityId)
      ports.storage.update(entityId, (view) => {
        const lastIndex = view.messages.length - 1
        const newest = view.messages[lastIndex] ?? view.lastMessage
        if (!newest) return undefined

        const current = view.readPointer
        const candidate = makeReadPointer(newest, kind)
        const resolvesCurrent = current && (
          current.identity.state === 'addressable'
            ? hasFloorResolutionEvidence(current, [newest], 0, kind)
            : hasFloorResolutionEvidence(current, view.messages, lastIndex, kind)
        )
        const readPointer = current && resolvesCurrent
          ? { order: candidate.order, identity: current.identity }
          : advance(current, candidate)
        if (readPointer === current && view.unreadCount === 0 && view.mentionsCount === 0 && !view.divider) {
          return undefined
        }

        pruneTransient(scopeKey(entityId), readPointer.order)
        return { readPointer, unreadCount: 0, mentionsCount: 0, divider: null }
      })
    },

    applyRemoteDisplayed,

    /**
     * The reader opened this entity. Places the new-message divider at the first message the
     * canonical count would count, and hands the viewport a fresh evidence generation so reports
     * from the previous visit cannot be taken for this one.
     *
     * Returns false when the store does not hold the entity, which leaves marking it active to
     * the caller.
     */
    activate(entityId: string): boolean {
      remoteDividerAdvances.clear(entityId)
      // Synchronously, before the write below makes this activation visible to renders: the view
      // only ever reports against the generation this produces.
      beginViewportGeneration(scopeKey(entityId))
      let unreadCount = 0
      let found = false
      ports.storage.update(entityId, (view) => {
        found = true
        // A room resolves the order of a pointer whose row is now loaded, so the divider is
        // placed against the position the pointer actually names.
        const readPointer = kind === 'room' && view.readPointer
          ? resolveRoomReadPointerOrder(view.readPointer, view.messages, findRow(view.messages, pointerRowRef(view.readPointer)))
          : view.readPointer
        // `onActivate` re-derives the divider from the read boundary; the parked one is passed
        // for completeness, not as an input it reads.
        const activated = onActivate(
          {
            unreadCount: view.unreadCount,
            mentionsCount: view.mentionsCount,
            readPointer,
            historyFloor: view.historyFloor,
            firstNewMessageRow: view.divider,
          },
          view.messages,
          kind,
        )
        unreadCount = activated.unreadCount
        return {
          ...(activated.readPointer && { readPointer: activated.readPointer }),
          unreadCount: activated.unreadCount,
          mentionsCount: activated.mentionsCount,
          divider: activated.firstNewMessageRow ?? null,
          becomesActive: true,
        }
      })
      // The live-edge convergence advances the pointer, and nothing else re-derives the count for
      // an entity already at the newest message: opening one would strand a stale badge for as
      // long as it stays open. A derivation against the current pointer, never an unconditional
      // zero — real unread keeps a real count, and the divider is repositioned, not retired.
      if (found && unreadCount > 0) ports.recount(entityId, { allowActive: true })
      return found
    },

    /**
     * The reader left this entity. Drops the divider that belonged to that visit and re-derives
     * the count the visit advanced the pointer through. Call it once the store no longer names
     * this entity as the one being viewed, so the recount is not skipped as active.
     */
    deactivate(entityId: string): void {
      remoteDividerAdvances.clear(entityId)
      let reconcile = false
      ports.storage.update(entityId, (view) => {
        // A truly fresh entity — never read, nothing unread — has nothing a recount could
        // correct, and asking for one would cost a cache read on every close.
        reconcile = worthReconcilingOnDeactivate({ readPointer: view.readPointer, unreadCount: view.unreadCount })
        return view.divider === undefined ? undefined : { divider: null }
      })
      if (reconcile) ports.recount(entityId)
    },

    /**
     * XEP-0490: the position to publish for this entity, or `undefined` while it cannot be named
     * on the wire. The pointer's own archive id is published as it stands; otherwise the row it
     * names is looked up among the resident rows, the preview, and the cache.
     */
    async resolvePublishPosition(entityId: string): Promise<PublishPosition | undefined> {
      const view = ports.storage.read(entityId)
      const pointer = view?.readPointer
      if (!view || !pointer) return undefined
      // An addressable pointer already carries the archive id to publish. A room needs one more
      // thing: that the id was that room's own assignment for this account, recorded when the
      // pointer was minted. Requiring a row on top would stop publishing a certain position
      // whenever the row is evicted or the cache is unavailable.
      if (pointer.identity.state === 'addressable' && (kind === 'chat' || (
        pointer.identity.unconfirmed === false &&
        pointer.identity.archiveScope?.roomJid === entityId &&
        pointer.identity.archiveScope.accountJid === ownBareJid() && getStorageScopeJid() === ownBareJid()
      ))) {
        return { stanzaId: pointer.identity.archiveId, readPointer: pointer }
      }
      return kind === 'room'
        ? resolveRoomPublishPosition(entityId, pointer, view)
        : resolveChatPublishPosition(entityId, pointer, view)
    },

    /**
     * XEP-0490: drops a stashed remote marker the archive has proven it no
     * longer holds, and remembers the proof. Moves no read pointer.
     */
    discardPurgedRemoteDisplayed(entityId: string, stanzaId: string): void {
      let discarded = false
      ports.storage.update(entityId, (view) => {
        if (view.pendingRemoteMarker !== stanzaId) return undefined
        discarded = true
        return { pendingRemoteMarker: null }
      })
      if (!discarded) return
      notePurgedMarker(scopeKey(entityId), stanzaId)
      // The count was deferring on the stash.
      ports.recount(entityId, { allowActive: true })
    },

    /**
     * Re-derives the unread count from the durable archive, the only count that survives a
     * reload. Every uncertain branch defers instead of committing a number: a count derived
     * from a slice that may be one page of a longer walk would undercount, and the badge it
     * would overwrite was accumulated live.
     *
     * Never writes the read pointer. Snapping a pointerless entity to the newest row, or
     * advancing onto an outgoing message, are inferences about what the user has read, and the
     * pointer is forward-only, so a wrong one is unrecoverable.
     */
    async recompute(entityId: string, options?: { allowActive?: boolean }): Promise<void> {
      const allowActive = options?.allowActive ?? false
      // Every exit below goes through `defer` or `counted`; the `finally` publishes.
      const ledger = recountLedger(kind, entityId, () =>
        recountRetry.schedule(
          entityId,
          allowActive,
          (retryOptions) => this.recompute(entityId, retryOptions),
          () => this.recountReady(entityId),
        ))
      const { defer, counted } = ledger
      try {
        const view = ports.storage.read(entityId)
        if (!view) return defer('no-meta')
        // The active entity's count is reconciled by its own synchronous path (the live-edge
        // convergence) unless the caller opted into the guarded archive derivation.
        if (!allowActive && view.isActive) return defer('active-skipped')

        // ONE snapshot, read once, and every defer below decided against it — the same view the
        // derivation computes from. A second read would make "which snapshot did we check?"
        // answerable two ways, and each copy unfalsifiable (#1174). Every guard here sits ABOVE
        // the first await, so nothing moves underneath them; what moves after is caught by
        // `contextDeferral()` and by the pointer re-check at the commit.
        if (view.pendingRemoteMarker !== undefined &&
          !isMarkerSuperseded(scopeKey(entityId), view.pendingRemoteMarker)) {
          return defer('pending-remote-displayed')
        }
        if (pointerlessDefers(view.readPointer, view.unreadCount)) return defer('pointerless-defer')

        const recountToken = recountsInFlight.begin(entityId)
        try {
          // Latest-wins, bumped once this call is committed to running — after the defers above,
          // so a call that stands down cannot cancel a recount already in flight — and re-checked
          // before every commit, so a slow recount that resolves after a newer one is discarded.
          const version = bumpRecountVersion(entityId)
          const stillCurrent = ports.captureCacheRead(entityId)
          const record = ports.coverageRecord(entityId)
          const inputVersionAtStart = unreadInputVersions.get(entityId) ?? 0
          const contextDeferral = (): RecountDeferralReason | undefined => {
            if (!stillCurrent()) return 'context-changed'
            if (recountVersions.get(entityId) !== version) return 'recount-superseded'
            if (ports.coverageRecord(entityId) !== record) return 'input-version-changed'
            if ((unreadInputVersions.get(entityId) ?? 0) !== inputVersionAtStart) return 'input-version-changed'
            return undefined
          }

          const pointerAtCompute = view.readPointer
          const floor = computeFloor(view.readPointer, view.historyFloor)
          if (!floor) return defer('no-floor')
          if (!ports.historyCaughtUp(entityId)) return defer('history-not-caught-up')

          const bottom = await ports.resolveCoverageBottom(entityId, record)
          const coverageDeferral = contextDeferral()
          if (coverageDeferral) return defer(coverageDeferral)
          if (bottom === 'missing') return defer('coverage-missing')
          if (bottom === 'unresolvable') {
            if (record) ports.invalidateCoverage(entityId, record)
            return defer('coverage-unresolvable')
          }

          // The boundary: the pointer's own order when there is one, so the comparison is not
          // blind to a coverage bottom sharing its exact millisecond; a historyFloor-derived
          // boundary knows only a millisecond and says so.
          const floorPos: PointerOrder = view.readPointer?.order ?? { role: 'floor', timestamp: floor.getTime() }
          // This recompute is one of the "pointer advance / content settled" triggers, and not
          // every trigger path prunes the overlay itself.
          pruneTransient(scopeKey(entityId), floorPos)
          // A BOUNDARY test: a floor boundary reads as at-or-after its millisecond, so an
          // equal-millisecond bottom counts as not reaching it (#1173).
          if (isAfterBoundary(bottom, floorPos)) return defer('coverage-short-of-floor')

          const counts = await ports.countUnreadFromArchive(entityId, { floor, pointer: view.readPointer?.order })
          const countDeferral = contextDeferral()
          if (countDeferral) return defer(countDeferral)
          if (counts === null) return defer('cache-unavailable')

          const transient = transientCounts(scopeKey(entityId), floorPos)
          const unreadCount = Math.min(999, counts.unread + transient.unread)

          ports.storage.update(entityId, (committed) => {
            const commitDeferral = contextDeferral()
            if (commitDeferral) { defer(commitDeferral); return undefined }
            if (!allowActive && committed.isActive) { defer('active-skipped'); return undefined }
            // The count belongs to the pointer captured before the archive awaits. Compare the
            // whole reference: a floor resolving to exact changes the count even when the
            // message identity stays the same.
            if (committed.readPointer !== pointerAtCompute) { defer('pointer-changed'); return undefined }

            // Past the last guard: this count is the badge's value from here, whether or not the
            // write below changes anything.
            counted(unreadCount, committed.unreadCount)
            // A complete zero proves no unread mention remains; otherwise mentions are left alone.
            const mentionsCount = unreadCount === 0 ? 0 : committed.mentionsCount
            const divider = retiredDivider(committed)
            const dividerChanged = divider !== undefined
            if (committed.unreadCount === unreadCount && committed.mentionsCount === mentionsCount && !dividerChanged) {
              return undefined
            }
            return { unreadCount, mentionsCount, ...(dividerChanged ? { divider } : {}) }
          })
        } finally {
          recountsInFlight.finish(entityId, recountToken)
        }
      } finally {
        ledger.publish()
      }
    },

    /**
     * A message arrived. Records it in the transient overlay when the reader has not seen it —
     * an unread message that is not yet in the archive is invisible to a recount, and for a
     * message that is never stored locally it is the only record there will ever be.
     *
     * Runs before the store's write, so the overlay entry is made exactly once per arrival.
     * Pair it with {@link arrivalCounts} inside that write, and {@link endArrival} after it.
     */
    beginArrival(
      entityId: string,
      message: NotificationMessage,
      evidence: { isActive: boolean; windowVisible: boolean },
      // The overlay entry is named by the caller: a 1:1 row is named by its id, while a room row
      // is named by the message, because a reused nick puts two rows under one id.
      options: { increment?: boolean } & ({ identity: { id: string; aliases: string[] } } | { roomMessage: RoomMessage }),
    ): ArrivalNote {
      bumpUnreadInputVersion(entityId)
      const view = ports.storage.read(entityId)
      // The same evidence `onMessageReceived` reads below, so "unseen" here means what "seen"
      // means there: an entity that is open and focused but scrolled up has NOT seen it.
      const unseen = isUnseenIncomingMessage(
        message,
        {
          isActive: evidence.isActive,
          windowVisible: evidence.windowVisible,
          viewportAtLiveEdge: currentViewportEvidence(scopeKey(entityId)) === 'at-edge',
        },
        { treatDelayedAsNew: kind === 'chat' },
      )
      const source: string | RoomMessage = 'identity' in options ? options.identity.id : options.roomMessage
      const noted = (options.increment ?? true) && unseen && isRenderableStoredMessage(message)
      if (!noted || !view) return { entityId, unreadDelta: 0, requiresRecount: false, noted: false, source }

      const key = scopeKey(entityId)
      // No boundary: the arrival is already established as unread, so only the delta matters.
      // A real floor would be riskier — a fresh entity's watermark is stamped at creation, and a
      // message arriving in that same millisecond would tie rather than sort after it.
      const before = transientCounts(key, undefined).unread
      const result = 'identity' in options
        ? noteTransient(key, { position: exactPosition(message, kind) }, options.identity.id, options.identity.aliases)
        : noteTransient(key, { position: exactPosition(message, kind) }, options.roomMessage)
      const unreadDelta = result.added
        ? Math.max(0, transientCounts(key, undefined).unread - before)
        : 0
      return { entityId, unreadDelta, requiresRecount: result.requiresRecount, noted: true, source }
    },

    /**
     * The read fields the arrival's own store write commits, read from the entity as that write
     * sees it. The count is the pure transition's plus the overlay's contribution: an arrival
     * noted in the overlay does not also increment here, so neither path counts it twice.
     */
    arrivalCounts(
      note: ArrivalNote,
      message: NotificationMessage,
      evidence: { isActive: boolean; windowVisible: boolean },
      options?: { increment?: boolean; incrementMentions?: boolean },
    ): { unreadCount: number; mentionsCount: number; readPointer: ReadPointer | undefined; divider: MessageRowRef | null } | undefined {
      const view = ports.storage.read(note.entityId)
      if (!view) return undefined
      const updated = onMessageReceived(
        notificationInput(view),
        message,
        {
          isActive: evidence.isActive,
          windowVisible: evidence.windowVisible,
          // The on-arrival pointer advance requires demonstrable live-edge evidence for the
          // current activation: unknown or stale evidence resolves to false, conservatively.
          viewportAtLiveEdge: currentViewportEvidence(scopeKey(note.entityId)) === 'at-edge',
        },
        kind,
        {
          treatDelayedAsNew: kind === 'chat',
          incrementUnread: (options?.increment ?? true) && !note.noted,
          incrementMentions: options?.incrementMentions,
        },
      )
      return {
        unreadCount: Math.min(999, updated.unreadCount + note.unreadDelta),
        mentionsCount: updated.mentionsCount,
        readPointer: updated.readPointer,
        divider: updated.firstNewMessageRow ?? null,
      }
    },

    /**
     * Closes the arrival: an overlay entry for a message the store refused is dropped at once,
     * and one for a message being written to the archive is dropped when that write commits —
     * until then the overlay is the only place it is counted.
     */
    endArrival(note: ArrivalNote, outcome: { accepted: boolean; durableWrite?: Promise<boolean> }): void {
      const key = scopeKey(note.entityId)
      if (!outcome.accepted) {
        if (note.unreadDelta > 0) removeTransient(key, note.source)
      } else if (outcome.durableWrite) {
        const scopeAtSave = currentStorageScope()
        const writeToken = pendingUnreadWrites.begin(note.entityId)
        void outcome.durableWrite.then((committed) => {
          const owned = pendingUnreadWrites.finish(note.entityId, writeToken)
          if (!owned || currentStorageScope() !== scopeAtSave) return
          if (committed && note.noted && removeTransient(key, note.source).removed) {
            bumpUnreadInputVersion(note.entityId)
          }
          recountRetry.resume(note.entityId)
        })
      }
      // Only the archive-derived recount can fold an overlay change back into the stored count.
      if (note.requiresRecount) ports.recount(note.entityId)
    },

    /**
     * The reader dismissed the new-message divider. Also drops a remote divider advance still
     * waiting for messages to load: the reader has answered the question it was asked about.
     */
    clearDivider(entityId: string): void {
      remoteDividerAdvances.clear(entityId)
      ports.storage.update(entityId, (view) => (view.divider === undefined ? undefined : { divider: null }))
    },

    /**
     * A message is gone — retracted, corrected into nothing, or dropped — so it stops being
     * counted. Returns whether it was counted in the transient overlay at all.
     */
    dropUnreadMessage(entityId: string, source: string | RoomMessage): boolean {
      const removed = removeTransient(scopeKey(entityId), source).removed
      if (removed) bumpUnreadInputVersion(entityId)
      return removed
    },

    /**
     * Something the unread count is derived from has changed — an archive page merged, a message
     * removed. A recount computed from older inputs defers instead of committing.
     */
    noteUnreadInputsChanged(entityId: string): void {
      bumpUnreadInputVersion(entityId)
    },

    /** Lets recounts that stood down while history was loading, or a write was in flight, run. */
    resumeDeferredRecounts(entityId: string): void {
      recountRetry.resume(entityId)
    },

    /** Asks for a recount as soon as the entity is ready to be counted from the archive. */
    scheduleRecount(entityId: string): void {
      recountRetry.schedule(
        entityId,
        true,
        (options) => this.recompute(entityId, options),
        () => this.recountReady(entityId),
      )
    },

    /**
     * Captures the unread inputs as they are now. The returned check answers whether they still
     * are — an archive walk that took a while must not commit against inputs that have moved.
     */
    captureUnreadInputs(entityId: string): () => boolean {
      const version = unreadInputVersions.get(entityId)
      return () => unreadInputVersions.get(entityId) === version
    },

    /**
     * Retries a remote divider advance that no loaded slice could place. Called when the entity's
     * messages change, which is the only thing that can make it placeable.
     */
    retryRemoteDivider(entityId: string): void {
      if (!remoteDividerAdvances.has(entityId)) return
      const view = ports.storage.read(entityId)
      const parked = view?.divider
      if (!view || parked === undefined) {
        // No line to advance: the reader cleared it, and the marker has nothing left to say.
        remoteDividerAdvances.clear(entityId)
        return
      }
      const result = remoteDividerAdvances.retry(
        entityId,
        parked,
        view.messages,
        kind,
        locallyPublishedDisplayed(getBareJid(connectionStore.getState().jid ?? ''), entityId),
      )
      if (result.kind === 'advanced') ports.storage.update(entityId, () => ({ divider: result.divider }))
    },

    /** Drops one entity's read-state bookkeeping when the entity is invalidated. */
    forgetEntity(entityId: string): void {
      pendingUnreadWrites.cancel(entityId)
      recountsInFlight.cancel(entityId)
      recountRetry.cancel(entityId)
      recountVersions.delete(entityId)
      unreadInputVersions.delete(entityId)
      clearTransientEntity(scopeKey(entityId))
    },

    /**
     * Account switch. Must run after the global storage scope has flipped to
     * the incoming account: it tears down the outgoing account's registries by
     * the scope recorded at the previous switch, then records the new one.
     */
    resetForAccountSwitch(): void {
      clearSessionRegistries()
      if (lastScope !== null) clearAccountRegistries(lastScope)
      lastScope = getStorageScopeJid()
    },

    /**
     * Logout. Nothing flips the global scope before logout, so the current
     * scope is still the account being logged out. A new session may fold the
     * XEP-0490 synced read marker again on first open.
     */
    resetForLogout(): void {
      clearSessionRegistries()
      clearAccountRegistries(getStorageScopeJid() ?? '')
      lastScope = null
      mdsGate.reset()
    },
  }
}

export type ReadTracker = ReturnType<typeof createReadTracker>

/** The fields of a patch that a store keeps on the entity itself. */
export interface ReadFields {
  readPointer?: ReadPointer
  unreadCount?: number
  mentionsCount?: number
  pendingRemoteDisplayedStanzaId?: string
}

/** Picks the entity fields out of a patch, or `undefined` when it carries none. */
export function readFieldsOf(patch: ReadStatePatch): ReadFields | undefined {
  const fields: ReadFields = {}
  if (patch.readPointer) fields.readPointer = patch.readPointer
  if (patch.unreadCount !== undefined) fields.unreadCount = patch.unreadCount
  if (patch.mentionsCount !== undefined) fields.mentionsCount = patch.mentionsCount
  if (patch.pendingRemoteMarker !== undefined) fields.pendingRemoteDisplayedStanzaId = patch.pendingRemoteMarker ?? undefined
  return Object.keys(fields).length > 0 ? fields : undefined
}

/** The divider map with one entity's divider moved (`null` removes it). */
export function withDivider(
  dividers: Map<string, MessageRowRef>,
  entityId: string,
  divider: MessageRowRef | null,
): Map<string, MessageRowRef> {
  const next = new Map(dividers)
  if (divider === null) next.delete(entityId)
  else next.set(entityId, divider)
  return next
}
