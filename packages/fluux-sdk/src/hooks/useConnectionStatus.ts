import { useMemo } from 'react'
import { useConnectionStore } from '../react/storeHooks'
import type { ConnectionStatus } from '../core/types'

/**
 * Focused, low-subscription counterpart to `useConnection()` for components
 * that only need the connection lifecycle (status / jid / error).
 *
 * `useConnection()` subscribes to ~16 connection store fields, so a component
 * that only reads `status` still re-renders whenever `connectionMethod`,
 * `authMechanism`, `serverInfo`, own-profile fields, etc. change. During a
 * connect/reconnect handshake several of those change in quick succession,
 * producing a burst of avoidable re-renders (enough to trip the dev render-loop
 * warning before the post-`online` sync grace period arms).
 *
 * This hook subscribes to ONLY `status`, `jid`, and `error`, so it re-renders
 * just a handful of times across a full connect. Pair with
 * `useConnectionActions()` when the component also needs to call `connect`,
 * `disconnect`, etc. without the broad subscription.
 *
 * Analogous to `useChatActive()` / `useRoomActive()`.
 *
 * @returns Connection lifecycle state plus convenience booleans
 *
 * @category Hooks
 */
export function useConnectionStatus(): {
  status: ConnectionStatus
  jid: string | null
  error: string | null
  isConnected: boolean
  isConnecting: boolean
  isReconnecting: boolean
} {
  const status = useConnectionStore((s) => s.status)
  const jid = useConnectionStore((s) => s.jid)
  const error = useConnectionStore((s) => s.error)

  return useMemo(
    () => ({
      status,
      jid,
      error,
      isConnected: status === 'online',
      isConnecting: status === 'connecting',
      isReconnecting: status === 'reconnecting',
    }),
    [status, jid, error]
  )
}
