import { useCallback } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { ignoreStore, type IgnoredUser } from '../stores/ignoreStore'
import { useIgnoreStore } from '../react/storeHooks'

/**
 * Hook for managing per-room ignored users (client-side).
 *
 * Ignored users' messages are hidden in the room view.
 * State is persisted to localStorage.
 *
 * Identifier priority for matching: occupantId (XEP-0421) > bareJid > nick.
 *
 * @returns An object containing ignore state and actions
 *
 * @example Ignoring an occupant in a room
 * ```tsx
 * function OccupantActions({ roomJid, occupant }: Props) {
 *   const { isIgnored, addIgnored, removeIgnored } = useIgnore()
 *   const identifier = occupant.occupantId || occupant.jid || occupant.nick
 *   const ignored = isIgnored(roomJid, identifier)
 *
 *   return (
 *     <button onClick={() => ignored
 *       ? removeIgnored(roomJid, identifier)
 *       : addIgnored(roomJid, { identifier, displayName: occupant.nick })
 *     }>
 *       {ignored ? 'Stop ignoring' : 'Ignore'}
 *     </button>
 *   )
 * }
 * ```
 *
 * @category Hooks
 */
export function useIgnore() {
  const ignoredUsers = useIgnoreStore(useShallow((s) => s.ignoredUsers))

  const addIgnored = useCallback(
    (roomJid: string, user: IgnoredUser) => {
      ignoreStore.getState().addIgnored(roomJid, user)
    },
    []
  )

  const removeIgnored = useCallback(
    (roomJid: string, identifier: string) => {
      ignoreStore.getState().removeIgnored(roomJid, identifier)
    },
    []
  )

  const isIgnored = useCallback(
    (roomJid: string, identifier: string): boolean => {
      return ignoreStore.getState().isIgnored(roomJid, identifier)
    },
    []
  )

  const getIgnoredForRoom = useCallback(
    (roomJid: string): IgnoredUser[] => {
      return ignoreStore.getState().getIgnoredForRoom(roomJid)
    },
    []
  )

  return {
    ignoredUsers,
    addIgnored,
    removeIgnored,
    isIgnored,
    getIgnoredForRoom,
  }
}
