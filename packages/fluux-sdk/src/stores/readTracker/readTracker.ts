import { getStorageScopeJid } from '../../utils/storageScope'
import { findMessageRowIndex } from '../../utils/messageIdentity'
import type { MessageRowRef } from '../../core/types/messageRow'
import { getBareJid } from '../../core/jid'
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
  isAhead,
  makeReadPointer,
  type PointerSource,
  type ReadPointer,
} from '../shared/readPointer'
import { countOnlyClear, reportUnreadCleared } from '../shared/recountDiagnostics'
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
    pendingUnreadWrites,
    recountsInFlight,
    recountRetry,
    mdsGate,
    remoteDividerAdvances,

    bumpRecountVersion,

    recountVersion(entityId: string): number | undefined {
      return recountVersions.get(entityId)
    },

    bumpUnreadInputVersion,

    unreadInputVersion(entityId: string): number | undefined {
      return unreadInputVersions.get(entityId)
    },

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
