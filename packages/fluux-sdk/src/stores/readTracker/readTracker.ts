import { getStorageScopeJid } from '../../utils/storageScope'
import { createPendingEntityWrites } from '../shared/pendingEntityWrites'
import { createRecountRetryScheduler } from '../shared/recountRetry'
import { createMdsSessionGate } from '../shared/readMarkerSync'
import { createRemoteDividerAdvanceTracker } from '../shared/dividerAdvance'
import { clearTransientEntity, clearTransientScope } from '../shared/transientUnread'
import { clearViewportEvidence } from '../shared/viewportEvidence'
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

export interface ReadTrackerPorts {
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

    bumpRecountVersion(entityId: string): number {
      const next = (recountVersions.get(entityId) ?? 0) + 1
      recountVersions.set(entityId, next)
      return next
    },

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
