import { useCallback, useMemo } from 'react'
import { connectionStore } from '../stores'
import { useConnectionStore } from '../react/storeHooks'
import { useXMPPContext } from '../provider'
import type { LinkPreview } from '../core/types'
import { NS_REGISTER } from '../core/namespaces'

/**
 * Hook for managing XMPP connection state and actions.
 *
 * This is the primary hook for connecting to an XMPP server, managing
 * connection lifecycle, and accessing connection-related state.
 *
 * **Note:** For presence state (presenceShow, statusMessage, isAutoAway),
 * use the `usePresence` hook instead. This hook focuses on connection lifecycle.
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
  const { client } = useXMPPContext()

  const status = useConnectionStore((s) => s.status)
  const jid = useConnectionStore((s) => s.jid)
  const error = useConnectionStore((s) => s.error)
  const reconnectAttempt = useConnectionStore((s) => s.reconnectAttempt)
  const reconnectIn = useConnectionStore((s) => s.reconnectIn)
  const serverInfo = useConnectionStore((s) => s.serverInfo)
  const connectionMethod = useConnectionStore((s) => s.connectionMethod)
  // Own profile state
  const ownAvatar = useConnectionStore((s) => s.ownAvatar)
  const ownAvatarHash = useConnectionStore((s) => s.ownAvatarHash)
  const ownNickname = useConnectionStore((s) => s.ownNickname)
  const ownResources = useConnectionStore((s) => s.ownResources)
  // HTTP Upload (XEP-0363)
  const httpUploadService = useConnectionStore((s) => s.httpUploadService)

  const connect = useCallback(
    async (
      jid: string,
      password: string,
      server: string,
      smState?: { id: string; inbound: number },
      resource?: string,
      lang?: string,
      disableSmKeepalive?: boolean
    ) => {
      connectionStore.getState().setStatus('connecting')
      connectionStore.getState().setError(null)
      try {
        await client.connect({ jid, password, server, resource, smState, lang, disableSmKeepalive })
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Connection failed'
        connectionStore.getState().setStatus('error')
        connectionStore.getState().setError(message)
        throw err
      }
    },
    [client]
  )

  const getStreamManagementState = useCallback(() => {
    return client.getStreamManagementState()
  }, [client])

  const disconnect = useCallback(async () => {
    await client.disconnect()
  }, [client])

  const cancelReconnect = useCallback(() => {
    client.cancelReconnect()
    connectionStore.getState().setStatus('disconnected')
    connectionStore.getState().setReconnectState(0, null)
  }, [client])


  const setOwnNickname = useCallback(
    async (nickname: string) => {
      await client.profile.publishOwnNickname(nickname)
    },
    [client]
  )

  const setOwnAvatar = useCallback(
    async (imageData: Uint8Array, mimeType: string, width: number, height: number) => {
      // Convert Uint8Array to base64 data URL
      const base64 = btoa(String.fromCharCode(...Array.from(imageData)))
      const dataUrl = `data:${mimeType};base64,${base64}`
      await client.profile.publishOwnAvatar(dataUrl, mimeType, width, height)
    },
    [client]
  )

  const clearOwnAvatar = useCallback(async () => {
    await client.profile.clearOwnAvatar()
  }, [client])

  const clearOwnNickname = useCallback(async () => {
    await client.profile.clearOwnNickname()
  }, [client])

  const restoreOwnAvatarFromCache = useCallback(
    async (avatarHash: string) => {
      return client.profile.restoreOwnAvatarFromCache(avatarHash)
    },
    [client]
  )

  const changePassword = useCallback(
    async (newPassword: string): Promise<void> => {
      await client.profile.changePassword(newPassword)
    },
    [client]
  )

  const requestUploadSlot = useCallback(
    async (filename: string, size: number, contentType: string) => {
      return client.discovery.requestUploadSlot(filename, size, contentType)
    },
    [client]
  )

  const sendLinkPreview = useCallback(
    async (
      to: string,
      originalMessageId: string,
      preview: LinkPreview,
      type: 'chat' | 'groupchat' = 'chat'
    ) => {
      await client.chat.sendLinkPreview(to, originalMessageId, preview, type)
    },
    [client]
  )

  /**
   * Notify the SDK of a system state change.
   *
   * This is the recommended way to signal platform-specific events to the SDK.
   * The app detects events (wake from sleep, visibility changes), the SDK handles
   * the protocol response.
   *
   * @param state - 'awake' | 'sleeping' | 'visible' | 'hidden'
   */
  const notifySystemState = useCallback(
    async (state: 'awake' | 'sleeping' | 'visible' | 'hidden') => {
      await client.notifySystemState(state)
    },
    [client]
  )

  // Check if server supports password change via XEP-0077 In-Band Registration
  const supportsPasswordChange = useMemo(() => {
    return serverInfo?.features?.includes(NS_REGISTER) ?? false
  }, [serverInfo?.features])

  // Memoize actions object to prevent re-renders when only state changes
  const actions = useMemo(
    () => ({
      connect,
      disconnect,
      cancelReconnect,
      setOwnNickname,
      setOwnAvatar,
      clearOwnNickname,
      clearOwnAvatar,
      restoreOwnAvatarFromCache,
      changePassword,
      getStreamManagementState,
      requestUploadSlot,
      sendLinkPreview,
      notifySystemState,
    }),
    [
      connect,
      disconnect,
      cancelReconnect,
      setOwnNickname,
      setOwnAvatar,
      clearOwnNickname,
      clearOwnAvatar,
      restoreOwnAvatarFromCache,
      changePassword,
      getStreamManagementState,
      requestUploadSlot,
      sendLinkPreview,
      notifySystemState,
    ]
  )

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
      reconnectIn,
      serverInfo,
      connectionMethod,
      // Own profile state
      ownAvatar,
      ownAvatarHash,
      ownNickname,
      ownResources,
      // HTTP Upload (XEP-0363)
      httpUploadService,

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
      reconnectIn,
      serverInfo,
      connectionMethod,
      ownAvatar,
      ownAvatarHash,
      ownNickname,
      ownResources,
      httpUploadService,
      supportsPasswordChange,
      actions,
    ]
  )
}
