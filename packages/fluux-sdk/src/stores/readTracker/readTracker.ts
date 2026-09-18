import { getStorageScopeJid } from '../../utils/storageScope'
import { findMessageRowIndex } from '../../utils/messageIdentity'
import type { MessageRowRef } from '../../core/types/messageRow'
import { connectionStore } from '../connectionStore'
import { onMessageSeen } from '../shared/notificationState'
import type { PointerSource, ReadPointer } from '../shared/readPointer'
import { createPendingEntityWrites } from '../shared/pendingEntityWrites'
import { createRecountRetryScheduler } from '../shared/recountRetry'
import { createMdsSessionGate } from '../shared/readMarkerSync'
import { createRemoteDividerAdvanceTracker } from '../shared/dividerAdvance'
import { clearTransientEntity, clearTransientScope, pruneTransient } from '../shared/transientUnread'
import { clearViewportEvidence, currentViewportEvidence } from '../shared/viewportEvidence'
import { clearPurgedMarkers } from '../shared/purgedMarkers'

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
  messages: PointerSource[]
  /** Whether the resident slice reaches the newest message. */
  atLiveEdge: boolean
  isActive: boolean
  /** The row the new-message divider sits above, if one is parked. */
  divider: MessageRowRef | undefined
}

export interface ReadStatePatch {
  readPointer: ReadPointer | undefined
  unreadCount: number
  mentionsCount: number
  /** Whether `readPointer` differs from the view's; a store persists only then. */
  pointerAdvanced: boolean
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
}

export interface ReadTrackerPorts {
  storage: ReadTrackerStorage
  /**
   * Starts the archive-backed unread recount for an entity the user may be
   * viewing. Unseen messages can lie beyond the resident slice, so a partial
   * read cannot compute the count itself.
   */
  recount(entityId: string): void
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

  const bumpRecountVersion = (entityId: string): number => {
    const next = (recountVersions.get(entityId) ?? 0) + 1
    recountVersions.set(entityId, next)
    return next
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

    bumpUnreadInputVersion(entityId: string): void {
      unreadInputVersions.set(entityId, (unreadInputVersions.get(entityId) ?? 0) + 1)
    },

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
        const seen = onMessageSeen(
          {
            unreadCount: view.unreadCount,
            mentionsCount: view.mentionsCount,
            readPointer: view.readPointer,
            firstNewMessageRow: view.divider,
          },
          row,
          view.messages,
          kind,
          { atLiveEdge: view.atLiveEdge },
        )
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

        return { readPointer: seen.readPointer, unreadCount, mentionsCount, pointerAdvanced }
      })

      // A witnessed live tail already committed its zero and needs no archive round trip.
      if (pointerAdvanced && !readThrough) ports.recount(entityId)
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
