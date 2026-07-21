import { useCallback, useMemo } from 'react'
import { connectionStore } from '../stores/connectionStore'
import { useXMPPContext } from '../provider'
import type { LinkPreview, VCardInfo, ConnectOptions } from '../core/types'

/**
 * Action-only counterpart to `useConnection()`.
 *
 * Returns the same actions as `useConnection()` but performs ZERO store
 * subscriptions. Use this in components that only need to invoke connection
 * actions (e.g. a login form calling `connect`) and do not need to react to
 * the full connection state.
 *
 * Calling `useConnection()` subscribes the component to ~16 connection store
 * values (`status`, `jid`, `error`, `connectionMethod`, `serverInfo`, own
 * profile fields, etc.). During a connect/reconnect handshake several of those
 * change in quick succession, re-rendering every `useConnection()` consumer
 * even when it only needs an action. `useConnectionActions()` reads the store
 * imperatively via `connectionStore.getState()`, avoiding any subscription.
 *
 * Pair with `useConnectionStatus()` when a component also needs to react to the
 * connection lifecycle (status/error) without the full subscription surface.
 *
 * @returns A stable object of connection action callbacks
 *
 * @category Hooks
 */
export function useConnectionActions() {
  const { client } = useXMPPContext()

  const connect = useCallback(
    async (options: ConnectOptions) => {
      connectionStore.getState().setStatus('connecting')
      connectionStore.getState().setError(null)
      try {
        await client.connect(options)
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

  const disconnect = useCallback(
    async (options: { invalidateFastToken?: boolean } = {}) => {
      await client.disconnect(options)
    },
    [client]
  )

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

  const fetchOwnVCard = useCallback(async () => {
    return client.profile.fetchOwnVCard()
  }, [client])

  const setOwnVCard = useCallback(
    async (info: VCardInfo) => {
      await client.profile.publishOwnVCard(info)
    },
    [client]
  )

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

  // Memoize actions object so the returned identity is stable across renders.
  return useMemo(
    () => ({
      connect,
      disconnect,
      cancelReconnect,
      setOwnNickname,
      setOwnAvatar,
      clearOwnNickname,
      clearOwnAvatar,
      fetchOwnVCard,
      setOwnVCard,
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
      fetchOwnVCard,
      setOwnVCard,
      restoreOwnAvatarFromCache,
      changePassword,
      getStreamManagementState,
      requestUploadSlot,
      sendLinkPreview,
      notifySystemState,
    ]
  )
}
