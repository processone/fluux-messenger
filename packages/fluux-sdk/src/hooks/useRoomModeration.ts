import { useCallback, useMemo } from 'react'
import { useXMPPContext } from '../provider'
import type { RoomAffiliation, RoomRole } from '../core/types'

/**
 * Focused hook for MUC room moderation & administration:
 * message moderation (XEP-0425), affiliations/roles (XEP-0045), and hat
 * management (XEP-0317).
 *
 * Performs ZERO store subscriptions — a stable object of action callbacks, so
 * a moderation panel or members modal does not re-render on room state
 * changes. Composed by `useRoomActions()`.
 *
 * @category Hooks
 */
export function useRoomModeration() {
  const { client } = useXMPPContext()

  const moderateMessage = useCallback(
    async (roomJid: string, stanzaId: string, reason?: string) => {
      await client.muc.moderateMessage(roomJid, stanzaId, reason)
    },
    [client]
  )

  const setAffiliation = useCallback(
    async (roomJid: string, userJid: string, affiliation: RoomAffiliation, reason?: string) => {
      await client.muc.setAffiliation(roomJid, userJid, affiliation, reason)
    },
    [client]
  )

  const setRole = useCallback(
    async (roomJid: string, nick: string, role: RoomRole, reason?: string) => {
      await client.muc.setRole(roomJid, nick, role, reason)
    },
    [client]
  )

  const queryAffiliationList = useCallback(
    async (roomJid: string, affiliation: RoomAffiliation) => {
      return client.muc.queryAffiliationList(roomJid, affiliation)
    },
    [client]
  )

  // XEP-0317: Hat management
  const listHats = useCallback(
    async (roomJid: string) => {
      return client.muc.listHats(roomJid)
    },
    [client]
  )

  const createHat = useCallback(
    async (roomJid: string, title: string, uri: string, hue?: number) => {
      await client.muc.createHat(roomJid, title, uri, hue)
    },
    [client]
  )

  const destroyHat = useCallback(
    async (roomJid: string, uri: string) => {
      await client.muc.destroyHat(roomJid, uri)
    },
    [client]
  )

  const listHatAssignments = useCallback(
    async (roomJid: string) => {
      return client.muc.listHatAssignments(roomJid)
    },
    [client]
  )

  const assignHat = useCallback(
    async (roomJid: string, userJid: string, hatUri: string) => {
      await client.muc.assignHat(roomJid, userJid, hatUri)
    },
    [client]
  )

  const unassignHat = useCallback(
    async (roomJid: string, userJid: string, hatUri: string) => {
      await client.muc.unassignHat(roomJid, userJid, hatUri)
    },
    [client]
  )

  return useMemo(
    () => ({
      moderateMessage,
      setAffiliation,
      setRole,
      queryAffiliationList,
      listHats,
      createHat,
      destroyHat,
      listHatAssignments,
      assignHat,
      unassignHat,
    }),
    [
      moderateMessage,
      setAffiliation,
      setRole,
      queryAffiliationList,
      listHats,
      createHat,
      destroyHat,
      listHatAssignments,
      assignHat,
      unassignHat,
    ]
  )
}
