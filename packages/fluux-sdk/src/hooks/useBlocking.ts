import { useCallback } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { blockingStore } from '../stores/blockingStore'
import { useBlockingStore } from '../react/storeHooks'
import { useXMPPContext } from '../provider'

/**
 * Hook for managing the user's blocklist (XEP-0191).
 *
 * Provides state and actions for blocking/unblocking JIDs. Blocked contacts
 * cannot send messages, see presence, or subscribe to your presence.
 *
 * @returns An object containing blocking state and actions
 *
 * @example Displaying blocked contacts
 * ```tsx
 * function BlockedList() {
 *   const { blockedJids } = useBlocking()
 *
 *   return (
 *     <ul>
 *       {blockedJids.map(jid => (
 *         <li key={jid}>{jid}</li>
 *       ))}
 *     </ul>
 *   )
 * }
 * ```
 *
 * @example Blocking/unblocking a contact
 * ```tsx
 * function ContactActions({ jid }: { jid: string }) {
 *   const { isBlocked, blockJid, unblockJid } = useBlocking()
 *
 *   const blocked = isBlocked(jid)
 *
 *   return (
 *     <button onClick={() => blocked ? unblockJid(jid) : blockJid(jid)}>
 *       {blocked ? 'Unblock' : 'Block'}
 *     </button>
 *   )
 * }
 * ```
 *
 * @example Fetching blocklist on connect
 * ```tsx
 * function App() {
 *   const { status } = useConnection()
 *   const { fetchBlocklist } = useBlocking()
 *
 *   useEffect(() => {
 *     if (status === 'connected') {
 *       fetchBlocklist()
 *     }
 *   }, [status, fetchBlocklist])
 * }
 * ```
 *
 * @category Hooks
 */
export function useBlocking() {
  const { client } = useXMPPContext()
  const blockedJids = useBlockingStore(useShallow((s) => s.getBlockedJids()))

  const fetchBlocklist = useCallback(async () => {
    return client.blocking.fetchBlocklist()
  }, [client])

  const blockJid = useCallback(
    async (jids: string | string[]) => {
      await client.blocking.blockJid(jids)
    },
    [client]
  )

  const unblockJid = useCallback(
    async (jids: string | string[]) => {
      await client.blocking.unblockJid(jids)
    },
    [client]
  )

  const unblockAll = useCallback(async () => {
    await client.blocking.unblockAll()
  }, [client])

  const isBlocked = useCallback((jid: string): boolean => {
    return blockingStore.getState().isBlocked(jid)
  }, [])

  return {
    // State
    blockedJids,

    // Actions
    fetchBlocklist,
    blockJid,
    unblockJid,
    unblockAll,
    isBlocked,
  }
}
