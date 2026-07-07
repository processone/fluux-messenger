import { useCallback, useMemo } from 'react'
import { useXMPPContext } from '../provider'
import type { RSMRequest, AdminRoom, RSMResponse } from '../core/types'

/**
 * Focused hook for MUC room lifecycle & settings: create/destroy a room,
 * submit its config, set the subject, manage bookmarks, invitations, avatars,
 * the notify-all preference, and browse public rooms.
 *
 * Performs ZERO store subscriptions — a stable object of action callbacks, so
 * a room-config or invite modal does not re-render on room state changes.
 * Composed by `useRoomActions()`.
 *
 * @category Hooks
 */
export function useRoomManagement() {
  const { client } = useXMPPContext()

  const createRoom = useCallback(
    async (
      roomJid: string,
      nickname: string,
      config: {
        name: string
        description?: string
        isPublic?: boolean
        membersOnly?: boolean
        extraFields?: Record<string, string | string[]>
      },
      options?: { invitees?: string[] }
    ) => {
      await client.muc.createRoom(roomJid, nickname, config, options)
    },
    [client]
  )

  const destroyRoom = useCallback(
    async (roomJid: string, reason?: string, alternateRoomJid?: string) => {
      await client.muc.destroyRoom(roomJid, reason, alternateRoomJid)
    },
    [client]
  )

  const roomExists = useCallback(
    async (roomJid: string): Promise<boolean> => {
      return client.muc.roomExists(roomJid)
    },
    [client]
  )

  const submitRoomConfig = useCallback(
    async (roomJid: string, values: Record<string, string | string[]>) => {
      await client.muc.submitRoomConfig(roomJid, values)
    },
    [client]
  )

  const setSubject = useCallback(
    async (roomJid: string, subject: string) => {
      await client.muc.setSubject(roomJid, subject)
    },
    [client]
  )

  const setBookmark = useCallback(
    async (
      roomJid: string,
      options: { name: string; nick: string; autojoin?: boolean; password?: string }
    ) => {
      await client.muc.setBookmark(roomJid, options)
    },
    [client]
  )

  const removeBookmark = useCallback(
    async (roomJid: string) => {
      await client.muc.removeBookmark(roomJid)
    },
    [client]
  )

  const setRoomNotifyAll = useCallback(
    async (roomJid: string, notifyAll: boolean, persistent: boolean = false) => {
      await client.muc.setRoomNotifyAll(roomJid, notifyAll, persistent)
    },
    [client]
  )

  const inviteToRoom = useCallback(
    async (roomJid: string, inviteeJid: string, reason?: string) => {
      await client.muc.sendMediatedInvitation(roomJid, inviteeJid, reason)
    },
    [client]
  )

  const inviteMultipleToRoom = useCallback(
    async (roomJid: string, inviteeJids: string[], reason?: string) => {
      await client.muc.sendMediatedInvitations(roomJid, inviteeJids, reason)
    },
    [client]
  )

  const browsePublicRooms = useCallback(
    async (mucServiceJid?: string, rsm?: RSMRequest): Promise<{ rooms: AdminRoom[]; pagination: RSMResponse }> => {
      return client.admin.fetchRoomList(mucServiceJid, rsm)
    },
    [client]
  )

  const setRoomAvatar = useCallback(
    async (roomJid: string, imageData: Uint8Array, mimeType: string) => {
      const base64 = btoa(String.fromCharCode(...Array.from(imageData)))
      const dataUrl = `data:${mimeType};base64,${base64}`
      await client.profile.setRoomAvatar(roomJid, dataUrl, mimeType)
    },
    [client]
  )

  const clearRoomAvatar = useCallback(
    async (roomJid: string) => {
      await client.profile.clearRoomAvatar(roomJid)
    },
    [client]
  )

  const restoreRoomAvatarFromCache = useCallback(
    async (roomJid: string, avatarHash: string) => {
      return client.profile.restoreRoomAvatarFromCache(roomJid, avatarHash)
    },
    [client]
  )

  return useMemo(
    () => ({
      createRoom,
      destroyRoom,
      roomExists,
      submitRoomConfig,
      setSubject,
      setBookmark,
      removeBookmark,
      setRoomNotifyAll,
      inviteToRoom,
      inviteMultipleToRoom,
      browsePublicRooms,
      setRoomAvatar,
      clearRoomAvatar,
      restoreRoomAvatarFromCache,
    }),
    [
      createRoom,
      destroyRoom,
      roomExists,
      submitRoomConfig,
      setSubject,
      setBookmark,
      removeBookmark,
      setRoomNotifyAll,
      inviteToRoom,
      inviteMultipleToRoom,
      browsePublicRooms,
      setRoomAvatar,
      clearRoomAvatar,
      restoreRoomAvatarFromCache,
    ]
  )
}
