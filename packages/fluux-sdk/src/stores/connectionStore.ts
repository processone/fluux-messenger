import { createStore } from 'zustand/vanilla'
import { subscribeWithSelector } from 'zustand/middleware'
import type { ConnectionStatus, ConnectionMethod, PresenceShow, ServerInfo, ResourcePresence, HttpUploadService } from '../core/types'

// Re-export for convenience
export type { ServerInfo, ServerIdentity, HttpUploadService } from '../core/types'

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
 * connectionStore.getState().setStatus('connected')
 * ```
 *
 * @example React usage
 * ```tsx
 * import { useConnectionStore } from '@fluux/sdk'
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
  status: ConnectionStatus
  jid: string | null
  error: string | null
  reconnectAttempt: number
  reconnectTargetTime: number | null
  serverInfo: ServerInfo | null
  connectionMethod: ConnectionMethod | null
  authMechanism: string | null
  // Own profile data
  ownAvatar: string | null  // Blob URL for display
  ownAvatarHash: string | null  // Hash for cache lookup
  ownNickname: string | null  // XEP-0172 User Nickname
  ownResources: Map<string, ResourcePresence>  // Other connected resources
  // XEP-0363: HTTP File Upload service
  httpUploadService: HttpUploadService | null
  // Window visibility - used to determine if user can see new messages
  windowVisible: boolean

  // Actions - state setters only (connect/disconnect moved to hooks)
  setStatus: (status: ConnectionStatus) => void
  setJid: (jid: string | null) => void
  setError: (error: string | null) => void
  setReconnectState: (attempt: number, reconnectTargetTime: number | null) => void
  setServerInfo: (info: ServerInfo | null) => void
  setConnectionMethod: (method: ConnectionMethod | null) => void
  setAuthMechanism: (mechanism: string | null) => void
  // Own profile actions
  setOwnAvatar: (avatar: string | null, hash?: string | null) => void
  setOwnNickname: (nickname: string | null) => void
  updateOwnResource: (resource: string, show: PresenceShow | null, priority: number, status?: string, lastInteraction?: Date, client?: string) => void
  removeOwnResource: (resource: string) => void
  clearOwnResources: () => void
  // HTTP Upload actions
  setHttpUploadService: (service: HttpUploadService | null) => void
  // Window visibility actions
  setWindowVisible: (visible: boolean) => void
  reset: () => void
}

const initialState = {
  status: 'disconnected' as ConnectionStatus,
  jid: null,
  error: null,
  reconnectAttempt: 0,
  reconnectTargetTime: null,
  serverInfo: null as ServerInfo | null,
  connectionMethod: null as ConnectionMethod | null,
  authMechanism: null as string | null,
  ownAvatar: null as string | null,
  ownAvatarHash: null as string | null,
  ownNickname: null as string | null,
  ownResources: new Map<string, ResourcePresence>(),
  httpUploadService: null as HttpUploadService | null,
  windowVisible: true, // Assume visible on startup
}

export const connectionStore = createStore<ConnectionState>()(
  subscribeWithSelector((set) => ({
  ...initialState,

  setStatus: (status) => set({ status }),
  setJid: (jid) => set({ jid }),
  setError: (error) => set({ error }),
  setReconnectState: (attempt, reconnectTargetTime) => set({ reconnectAttempt: attempt, reconnectTargetTime }),
  setServerInfo: (info) => set({ serverInfo: info }),
  setConnectionMethod: (method) => set({ connectionMethod: method }),
  setAuthMechanism: (mechanism) => set({ authMechanism: mechanism }),

  setOwnAvatar: (avatar, hash) => set({
    ownAvatar: avatar,
    ownAvatarHash: hash ?? null,
  }),

  setOwnNickname: (nickname) => set({ ownNickname: nickname }),

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

  setWindowVisible: (visible) => set({ windowVisible: visible }),

  reset: () => set({
    ...initialState,
    ownResources: new Map(), // Create new Map instance on reset
  }),
})))

export type { ConnectionState }
