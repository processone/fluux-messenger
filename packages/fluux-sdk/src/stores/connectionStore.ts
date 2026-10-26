import type { UpdateScope } from '../core/types/storeBindings'
import type { DiscoveryFailure } from '../core/types/connection'
import { createStore } from 'zustand/vanilla'
import { subscribeWithSelector } from 'zustand/middleware'
import type { ConnectionStatus, ConnectionMethod, PresenceShow, ServerInfo, ResourcePresence, HttpUploadService, WebPushService, WebPushStatus, PushStatus, ProfileDetails } from '../core/types'

// Re-export for convenience
export type { ServerInfo, ServerIdentity, HttpUploadService, WebPushService, WebPushStatus } from '../core/types'

export interface ScopeUpdate {
  startedAt: number
  owners: number
  phase: 'silent' | 'brief' | 'icon' | 'idle'
  announcement: 'started' | 'ended' | null
}

/**
 * Connection state interface for the XMPP connection store.
 *
 * Manages connection lifecycle, own profile data, and server capabilities.
 *
 * **Note:** Presence state (presenceShow, statusMessage, isAutoAway) is now managed
 * by the XState presence machine. Use the `usePresence` hook to access presence state.
 *
 * @remarks
 * Most applications should use the `useConnection` hook instead of accessing this
 * store directly. The hook provides a cleaner API with memoized actions.
 *
 * @example Direct store access (framework-agnostic)
 * ```ts
 * import { connectionStore } from '@fluux/sdk/stores'
 *
 * // Subscribe to state changes
 * const unsubscribe = connectionStore.subscribe(
 *   (state) => console.log('State changed:', state.status)
 * )
 *
 * // Get current state
 * const { jid, serverInfo } = connectionStore.getState()
 *
 * // Update state
 * connectionStore.getState().setStatus('online')
 * ```
 *
 * @example React usage
 * ```tsx
 * import { useConnectionStore } from '@fluux/sdk/react'
 *
 * function Component() {
 *   const status = useConnectionStore((state) => state.status)
 *   return <div>{status}</div>
 * }
 * ```
 *
 * @category Stores
 */
interface ConnectionState {
  /** Single owner for every retrieval scope, including its presentation deadlines. Never persisted. */
  replayOwners: number
  beginReplay: () => () => void
  isReceivingReplay: () => boolean
  updates: Partial<Record<UpdateScope, ScopeUpdate>>
  beginUpdate: (scopes: readonly UpdateScope[]) => () => void
  status: ConnectionStatus
  /** True while the machine is in connected.verifying (wake verification in progress) */
  isVerifying: boolean
  /** Derived from the same work handles as updates, including unknown-target preparation. */
  isCatchingUp: boolean
  /** Start of the aggregate work episode, retained until its last handle ends. */
  catchUpStartedAt: number | null
  /** Registered work handles, counted once regardless of their number of scopes. */
  catchUpOwners: number
  catchUpEpoch: number
  jid: string | null
  error: string | null
  discoveryFailure: DiscoveryFailure | null
  reconnectAttempt: number
  reconnectTargetTime: number | null
  serverInfo: ServerInfo | null
  connectionMethod: ConnectionMethod | null
  authMechanism: string | null
  /** Human-readable auth strategy: 'fast-token' (XEP-0484) or 'password' (SCRAM) */
  authMethod: 'fast-token' | 'password' | null
  // Own profile data
  ownAvatar: string | null  // Avatar URL for display
  ownAvatarHash: string | null  // Hash for cache lookup
  ownNickname: string | null  // XEP-0172 User Nickname
  ownProfileDetails: ProfileDetails | null
  ownResources: Map<string, ResourcePresence>  // Other connected resources
  // XEP-0363: HTTP File Upload service
  httpUploadService: HttpUploadService | null
  // p1:push Web Push
  webPushStatus: WebPushStatus
  webPushServices: WebPushService[]
  /** Whether push notifications are enabled (persisted in localStorage) */
  webPushEnabled: boolean
  // XEP-0357 push through an app server
  pushStatus: PushStatus
  // MAM fulltext search capability
  mamFulltextSearch: boolean
  // Window visibility - used to determine if user can see new messages
  windowVisible: boolean

  // Actions - state setters only (connect/disconnect moved to hooks)
  setStatus: (status: ConnectionStatus) => void
  setIsVerifying: (isVerifying: boolean) => void
  /**
   * Compatibility alias for beginUpdate([]), with no local presentation scope.
   * Producers register once with beginUpdate(scopes); its handles also derive
   * isCatchingUp and catchUpStartedAt. Old callers retain the same lifecycle.
   */
  beginCatchUp: () => () => void
  /** Drop every owner (the connection left online). */
  resetCatchUp: () => void
  setJid: (jid: string | null) => void
  setDiscoveryFailure: (failure: DiscoveryFailure | null) => void
  setError: (error: string | null) => void
  setReconnectState: (attempt: number, reconnectTargetTime: number | null) => void
  setServerInfo: (info: ServerInfo | null) => void
  setConnectionMethod: (method: ConnectionMethod | null) => void
  setAuthMechanism: (mechanism: string | null) => void
  setAuthMethod: (method: 'fast-token' | 'password' | null) => void
  // Own profile actions
  setOwnAvatar: (avatar: string | null, hash?: string | null) => void
  setOwnNickname: (nickname: string | null) => void
  setOwnProfileDetails: (details: ProfileDetails | null) => void
  updateOwnResource: (resource: string, show: PresenceShow | null, priority: number, status?: string, lastInteraction?: Date, client?: string) => void
  removeOwnResource: (resource: string) => void
  clearOwnResources: () => void
  // HTTP Upload actions
  setHttpUploadService: (service: HttpUploadService | null) => void
  // Web Push actions
  setWebPushStatus: (status: WebPushStatus) => void
  setWebPushServices: (services: WebPushService[]) => void
  setWebPushServicesAndStatus: (services: WebPushService[], status: WebPushStatus) => void
  setPushStatus: (status: PushStatus) => void
  setWebPushEnabled: (enabled: boolean) => void
  // MAM fulltext search capability
  setMAMFulltextSearch: (supported: boolean) => void
  // Window visibility actions
  setWindowVisible: (visible: boolean) => void
  reset: () => void
}

const initialState = {
  status: 'disconnected' as ConnectionStatus,
  isVerifying: false,
  isCatchingUp: false,
  replayOwners: 0,
  updates: {} as ConnectionState['updates'],
  catchUpStartedAt: null as number | null,
  catchUpOwners: 0,
  catchUpEpoch: 0,
  jid: null,
  error: null,
  discoveryFailure: null as DiscoveryFailure | null,
  reconnectAttempt: 0,
  reconnectTargetTime: null,
  serverInfo: null as ServerInfo | null,
  connectionMethod: null as ConnectionMethod | null,
  authMechanism: null as string | null,
  authMethod: null as 'fast-token' | 'password' | null,
  ownAvatar: null as string | null,
  ownAvatarHash: null as string | null,
  ownNickname: null as string | null,
  ownProfileDetails: null as ProfileDetails | null,
  ownResources: new Map<string, ResourcePresence>(),
  httpUploadService: null as HttpUploadService | null,
  webPushStatus: 'unavailable' as WebPushStatus,
  webPushServices: [] as WebPushService[],
  pushStatus: 'unknown' as PushStatus,
  webPushEnabled: (() => {
    try {
      const stored = localStorage.getItem('fluux-webpush-enabled')
      return stored !== null ? stored === 'true' : true
    } catch { return true }
  })(),
  mamFulltextSearch: false,
  windowVisible: true, // Assume visible on startup
}

let catchUpEpochSeq = 0
// Only this module schedules update presentation. Views merely select a phase.
const updateTimers = new Map<UpdateScope, ReturnType<typeof setTimeout>[]>()
function clearUpdateTimers(scope?: UpdateScope): void {
  if (scope !== undefined) {
    updateTimers.get(scope)?.forEach(clearTimeout)
    updateTimers.delete(scope)
  } else {
    for (const key of updateTimers.keys()) clearUpdateTimers(key)
  }
}

export const connectionStore = createStore<ConnectionState>()(
  subscribeWithSelector((set, get) => ({
  ...initialState,

  isReceivingReplay: () => get().replayOwners > 0,
  beginReplay: () => {
    const epoch = get().catchUpEpoch
    set({ replayOwners: get().replayOwners + 1 })
    let ended = false
    return () => {
      if (ended || get().catchUpEpoch !== epoch) return
      ended = true
      set({ replayOwners: Math.max(0, get().replayOwners - 1) })
    }
  },
  beginUpdate: (requestedScopes) => {
    const scopes = [...new Set(requestedScopes)]
    const epoch = get().catchUpEpoch
    const updates = { ...get().updates }
    for (const scope of scopes) {
      const existing = updates[scope]
      if (existing && existing.owners > 0) {
        updates[scope] = { ...existing, owners: existing.owners + 1 }
        continue
      }
      const startedAt = Date.now()
      updates[scope] = { startedAt, owners: 1, phase: 'silent', announcement: null }
      const advance = () => {
        const current = get()
        const activity = current.updates[scope]
        if (current.catchUpEpoch !== epoch || !activity?.owners) return
        const phase = Date.now() - activity.startedAt >= 5000 ? 'icon' : 'brief'
        set({ updates: { ...current.updates, [scope]: { ...activity, phase, announcement: 'started' } } })
      }
      updateTimers.set(scope, [
        setTimeout(advance, 2000),
        setTimeout(advance, 5000),
      ])
    }
    set({
      updates,
      catchUpOwners: get().catchUpOwners + 1,
      isCatchingUp: true,
      catchUpStartedAt: get().catchUpStartedAt ?? Date.now(),
    })
    let ended = false
    return () => {
      if (ended || get().catchUpEpoch !== epoch) return
      ended = true
      const updates = { ...get().updates }
      for (const scope of scopes) {
        const activity = updates[scope]
        if (!activity?.owners) continue
        const owners = activity.owners - 1
        updates[scope] = { ...activity, owners, ...(owners === 0 ? {
          phase: 'idle' as const,
          // Neutral end, not a claim of success: error/cancellation also release work.
          announcement: activity.phase === 'silent' ? null : 'ended' as const,
        } : {}) }
        if (owners === 0) clearUpdateTimers(scope)
      }
      const catchUpOwners = Math.max(0, get().catchUpOwners - 1)
      set({
        updates,
        catchUpOwners,
        isCatchingUp: catchUpOwners > 0,
        catchUpStartedAt: catchUpOwners > 0 ? get().catchUpStartedAt : null,
      })
    }
  },
  setStatus: (status) => {
    if (status !== 'online') get().resetCatchUp()
    set({ status })
  },
  setIsVerifying: (isVerifying) => set({ isVerifying }),
  beginCatchUp: () => get().beginUpdate([]),
  resetCatchUp: () => {
    clearUpdateTimers()
    set({
      updates: {},
      replayOwners: 0,
      isCatchingUp: false,
      catchUpStartedAt: null,
      catchUpOwners: 0,
      catchUpEpoch: ++catchUpEpochSeq,
    })
  },
  setJid: (jid) => set({ jid }),
  setDiscoveryFailure: (discoveryFailure) => set({ discoveryFailure }),
  setError: (error) => set({ error }),
  setReconnectState: (attempt, reconnectTargetTime) => set({ reconnectAttempt: attempt, reconnectTargetTime }),
  setServerInfo: (info) => set({ serverInfo: info }),
  setConnectionMethod: (method) => set({ connectionMethod: method }),
  setAuthMechanism: (mechanism) => set({ authMechanism: mechanism }),
  setAuthMethod: (method) => set({ authMethod: method }),

  setOwnAvatar: (avatar, hash) => set({
    ownAvatar: avatar,
    ownAvatarHash: hash ?? null,
  }),

  setOwnNickname: (nickname) => set({ ownNickname: nickname }),
  setOwnProfileDetails: (details) => set({ ownProfileDetails: details }),

  updateOwnResource: (resource, show, priority, status, lastInteraction, client) => set((state) => {
    const newResources = new Map(state.ownResources)
    newResources.set(resource, {
      show,
      status,
      priority,
      lastInteraction,
      client,
    })
    return { ownResources: newResources }
  }),

  removeOwnResource: (resource) => set((state) => {
    const newResources = new Map(state.ownResources)
    newResources.delete(resource)
    return { ownResources: newResources }
  }),

  clearOwnResources: () => set({ ownResources: new Map() }),

  setHttpUploadService: (service) => set({ httpUploadService: service }),

  setWebPushStatus: (status) => set({ webPushStatus: status }),
  setWebPushServices: (services) => set({ webPushServices: services }),
  setWebPushServicesAndStatus: (services, status) => set({ webPushServices: services, webPushStatus: status }),
  setPushStatus: (status) => set({ pushStatus: status }),
  setWebPushEnabled: (enabled) => {
    try { localStorage.setItem('fluux-webpush-enabled', String(enabled)) } catch { /* ignore storage errors */ }
    set({ webPushEnabled: enabled })
  },

  setMAMFulltextSearch: (supported) => set({ mamFulltextSearch: supported }),
  setWindowVisible: (visible) => set({ windowVisible: visible }),

  reset: () => {
    clearUpdateTimers()
    set((state) => ({
      ...initialState,
      catchUpEpoch: ++catchUpEpochSeq,
      ownResources: new Map(), // Create new Map instance on reset
      webPushEnabled: state.webPushEnabled, // Preserve persisted preference
    }))
  },
})))

export type { ConnectionState }
