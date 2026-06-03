import { useMemo } from 'react'
import { useConnectionStore } from '../react/storeHooks'
import { NS_REGISTER } from '../core/namespaces'
import { useConnectionActions } from './useConnectionActions'

/**
 * Hook for managing XMPP connection state and actions.
 *
 * This is the primary hook for connecting to an XMPP server, managing
 * connection lifecycle, and accessing connection-related state.
 *
 * **Note:** For presence state (presenceShow, statusMessage, isAutoAway),
 * use the `usePresence` hook instead. This hook focuses on connection lifecycle.
 *
 * **Performance:** `useConnection()` subscribes to the full connection store
 * (~16 fields). Components that only need the connection lifecycle should
 * prefer `useConnectionStatus()` (status/jid/error) and `useConnectionActions()`
 * (connect/disconnect/...) to avoid re-rendering on unrelated field changes
 * such as `connectionMethod`, `serverInfo`, or own-profile updates.
 *
 * @returns An object containing connection state and actions
 *
 * @example Basic connection
 * ```tsx
 * function LoginForm() {
 *   const { connect, status, error, isConnected } = useConnection()
 *
 *   const handleLogin = async () => {
 *     try {
 *       await connect('user@example.com', 'password', 'example.com')
 *     } catch (err) {
 *       console.error('Login failed:', err)
 *     }
 *   }
 *
 *   if (isConnected) return <div>Connected!</div>
 *
 *   return (
 *     <button onClick={handleLogin} disabled={status === 'connecting'}>
 *       {status === 'connecting' ? 'Connecting...' : 'Login'}
 *     </button>
 *   )
 * }
 * ```
 *
 * @example Managing presence (use usePresence hook)
 * ```tsx
 * function PresenceSelector() {
 *   const { presenceStatus, setOnline, setAway, setDnd } = usePresence()
 *
 *   return (
 *     <select
 *       value={presenceStatus}
 *       onChange={(e) => {
 *         if (e.target.value === 'online') setOnline()
 *         else if (e.target.value === 'away') setAway()
 *         else if (e.target.value === 'dnd') setDnd()
 *       }}
 *     >
 *       <option value="online">Online</option>
 *       <option value="away">Away</option>
 *       <option value="dnd">Do Not Disturb</option>
 *     </select>
 *   )
 * }
 * ```
 *
 * @example Session resumption with Stream Management (XEP-0198)
 * ```tsx
 * function App() {
 *   const { connect, getStreamManagementState } = useConnection()
 *
 *   // Save SM state before page unload
 *   useEffect(() => {
 *     const handleUnload = () => {
 *       const smState = getStreamManagementState()
 *       if (smState) {
 *         sessionStorage.setItem('sm', JSON.stringify(smState))
 *       }
 *     }
 *     window.addEventListener('beforeunload', handleUnload)
 *     return () => window.removeEventListener('beforeunload', handleUnload)
 *   }, [getStreamManagementState])
 *
 *   // Restore on reconnect
 *   const handleReconnect = async () => {
 *     const saved = sessionStorage.getItem('sm')
 *     const smState = saved ? JSON.parse(saved) : undefined
 *     await connect('user@example.com', 'pass', 'example.com', smState)
 *   }
 * }
 * ```
 *
 * @category Hooks
 */
export function useConnection() {
  const status = useConnectionStore((s) => s.status)
  const jid = useConnectionStore((s) => s.jid)
  const error = useConnectionStore((s) => s.error)
  const reconnectAttempt = useConnectionStore((s) => s.reconnectAttempt)
  const reconnectTargetTime = useConnectionStore((s) => s.reconnectTargetTime)
  const serverInfo = useConnectionStore((s) => s.serverInfo)
  const connectionMethod = useConnectionStore((s) => s.connectionMethod)
  const authMechanism = useConnectionStore((s) => s.authMechanism)
  // Own profile state
  const ownAvatar = useConnectionStore((s) => s.ownAvatar)
  const ownAvatarHash = useConnectionStore((s) => s.ownAvatarHash)
  const ownNickname = useConnectionStore((s) => s.ownNickname)
  const ownVCard = useConnectionStore((s) => s.ownVCard)
  const ownResources = useConnectionStore((s) => s.ownResources)
  // HTTP Upload (XEP-0363)
  const httpUploadService = useConnectionStore((s) => s.httpUploadService)
  // Web Push (p1:push:webpush)
  const webPushStatus = useConnectionStore((s) => s.webPushStatus)
  const webPushEnabled = useConnectionStore((s) => s.webPushEnabled)

  // Connection actions (no store subscriptions of their own)
  const actions = useConnectionActions()

  // Check if server supports password change via XEP-0077 In-Band Registration
  const supportsPasswordChange = useMemo(() => {
    return serverInfo?.features?.includes(NS_REGISTER) ?? false
  }, [serverInfo?.features])

  // Memoize the entire return value to prevent render loops
  // Components that destructure specific properties will still re-render
  // only when their selected properties change, but object identity is stable
  return useMemo(
    () => ({
      // State
      status,
      jid,
      error,
      reconnectAttempt,
      reconnectTargetTime,
      serverInfo,
      connectionMethod,
      authMechanism,
      // Own profile state
      ownAvatar,
      ownAvatarHash,
      ownNickname,
      ownVCard,
      ownResources,
      // HTTP Upload (XEP-0363)
      httpUploadService,
      // Web Push (p1:push:webpush)
      webPushStatus,
      webPushEnabled,

      // Computed
      isConnected: status === 'online',
      isConnecting: status === 'connecting',
      isReconnecting: status === 'reconnecting',
      supportsPasswordChange,

      // Actions (spread memoized actions)
      ...actions,
    }),
    [
      status,
      jid,
      error,
      reconnectAttempt,
      reconnectTargetTime,
      serverInfo,
      connectionMethod,
      authMechanism,
      ownAvatar,
      ownAvatarHash,
      ownNickname,
      ownVCard,
      ownResources,
      httpUploadService,
      webPushStatus,
      webPushEnabled,
      supportsPasswordChange,
      actions,
    ]
  )
}
