import { useCallback, useMemo } from 'react'
import { roomStore } from '../stores'
import { useXMPPContext } from '../provider'
import type {
  MentionReference,
  ChatStateNotification,
  FileAttachment,
  RSMRequest,
  AdminRoom,
  RSMResponse,
  RoomAffiliation,
  RoomRole,
  PollData,
  PollSettings,
  RoomFeatures,
} from '../core/types'
import { createFetchOlderHistory, pickOldestArchiveId } from './shared'

/**
 * Action-only counterpart to `useRoom()`.
 *
 * Returns the same actions as `useRoom()` but performs ZERO store subscriptions.
 * Use this in components that only need to invoke room actions and do not need
 * to react to room state changes (e.g. modals that fire-and-close).
 *
 * Calling `useRoom()` subscribes the component to ~15 room store values
 * (`activeRoom`, `activeMessages`, `joinedRooms`, `roomsWithUnreadCount`, etc.),
 * causing it to re-render on every room store update. During background MAM
 * sync this can produce hundreds of re-renders per second. `useRoomActions()`
 * avoids this by reading actions directly via `roomStore.getState()`.
 *
 * @returns A stable object of room action callbacks
 *
 * @example
 * ```tsx
 * function InviteModal({ room }) {
 *   const { inviteMultipleToRoom } = useRoomActions()
 *   // No re-render when other rooms update during sync
 * }
 * ```
 *
 * @category Hooks
 */
export function useRoomActions() {
  const { client } = useXMPPContext()

  const joinRoom = useCallback(
    async (roomJid: string, nickname: string, options?: { maxHistory?: number; password?: string; knownFeatures?: RoomFeatures | null }) => {
      await client.muc.joinRoom(roomJid, nickname, options)
    },
    [client]
  )

  /**
   * Inspect a room via disco#info WITHOUT joining (no side effects). Use before
   * joining to decide whether to warn about real-JID exposure (issue #37). The
   * returned object can be passed back to `joinRoom` as `knownFeatures` to avoid
   * a second disco query. Returns null if the room cannot be reached.
   */
  const getRoomInfo = useCallback(
    async (roomJid: string): Promise<RoomFeatures | null> => {
      return await client.muc.queryRoomFeatures(roomJid)
    },
    [client]
  )

  /** Record that the user accepted joining a room that exposes their real JID. */
  const acknowledgeNonAnonymousRoom = useCallback((roomJid: string) => {
    roomStore.getState().acknowledgeNonAnonymousRoom(roomJid)
  }, [])

  /** Whether the user has already acknowledged this room's real-JID exposure. */
  const isNonAnonymousRoomAcknowledged = useCallback((roomJid: string) => {
    return roomStore.getState().isNonAnonymousRoomAcknowledged(roomJid)
  }, [])

  const createQuickChat = useCallback(
    async (nickname: string, topic?: string, invitees?: string[]): Promise<string> => {
      return await client.muc.createQuickChat(nickname, topic, invitees)
    },
    [client]
  )

  const leaveRoom = useCallback(
    async (roomJid: string) => {
      await client.muc.leaveRoom(roomJid)
    },
    [client]
  )

  const getRoom = useCallback(
    (roomJid: string) => roomStore.getState().rooms.get(roomJid),
    []
  )

  // Hydrates the message cache before marking active (see roomStore.activateRoom)
  const setActiveRoom = useCallback(async (roomJid: string | null) => {
    await roomStore.getState().activateRoom(roomJid)
  }, [])

  const markAsRead = useCallback((roomJid: string) => {
    roomStore.getState().markAsRead(roomJid)
  }, [])

  const sendMessage = useCallback(
    async (
      roomJid: string,
      body: string,
      replyTo?: { id: string; to: string; fallback?: { author: string; body: string } },
      references?: MentionReference[],
      attachment?: FileAttachment
    ): Promise<string> => {
      return await client.chat.sendMessage(roomJid, body, 'groupchat', replyTo, references, attachment)
    },
    [client]
  )

  const sendReaction = useCallback(
    async (roomJid: string, messageId: string, emojis: string[]) => {
      await client.chat.sendReaction(roomJid, messageId, emojis, 'groupchat')
    },
    [client]
  )

  const sendPoll = useCallback(
    async (roomJid: string, title: string, options: string[], settings?: Partial<PollSettings>, description?: string, deadline?: string, customEmojis?: string[]) => {
      return await client.poll.sendPoll(roomJid, title, options, settings, description, deadline, customEmojis)
    },
    [client]
  )

  const votePoll = useCallback(
    async (roomJid: string, messageId: string, optionEmoji: string, currentMyReactions: string[], poll: PollData, isClosed?: boolean) => {
      await client.poll.vote(roomJid, messageId, optionEmoji, currentMyReactions, poll, isClosed)
    },
    [client]
  )

  const closePoll = useCallback(
    async (roomJid: string, messageId: string) => {
      return await client.poll.closePoll(roomJid, messageId)
    },
    [client]
  )

  const sendCorrection = useCallback(
    async (roomJid: string, messageId: string, newBody: string, attachment?: FileAttachment) => {
      await client.chat.sendCorrection(roomJid, messageId, newBody, 'groupchat', attachment)
    },
    [client]
  )

  const retractMessage = useCallback(
    async (roomJid: string, messageId: string) => {
      await client.chat.sendRetraction(roomJid, messageId, 'groupchat')
    },
    [client]
  )

  const moderateMessage = useCallback(
    async (roomJid: string, stanzaId: string, reason?: string) => {
      await client.muc.moderateMessage(roomJid, stanzaId, reason)
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

  const sendChatState = useCallback(
    async (roomJid: string, state: ChatStateNotification) => {
      await client.chat.sendChatState(roomJid, state, 'groupchat')
    },
    [client]
  )

  const sendEasterEgg = useCallback(
    async (roomJid: string, animation: string) => {
      await client.chat.sendEasterEgg(roomJid, 'groupchat', animation)
    },
    [client]
  )

  const clearAnimation = useCallback(() => {
    roomStore.getState().clearAnimation()
  }, [])

  const setDraft = useCallback((roomJid: string, text: string) => {
    roomStore.getState().setDraft(roomJid, text)
  }, [])

  const getDraft = useCallback((roomJid: string) => {
    return roomStore.getState().getDraft(roomJid)
  }, [])

  const clearDraft = useCallback((roomJid: string) => {
    roomStore.getState().clearDraft(roomJid)
  }, [])

  const clearFirstNewMessageId = useCallback((roomJid: string) => {
    roomStore.getState().clearFirstNewMessageId(roomJid)
  }, [])

  const updateLastSeenMessageId = useCallback((roomJid: string, messageId: string) => {
    roomStore.getState().updateLastSeenMessageId(roomJid, messageId)
  }, [])

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

  const browsePublicRooms = useCallback(
    async (mucServiceJid?: string, rsm?: RSMRequest): Promise<{ rooms: AdminRoom[]; pagination: RSMResponse }> => {
      return client.admin.fetchRoomList(mucServiceJid, rsm)
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

  const fetchOlderHistory = useMemo(
    () =>
      createFetchOlderHistory({
        getActiveId: () => roomStore.getState().activeRoomJid,
        isValidTarget: (id) => {
          const room = roomStore.getState().rooms.get(id)
          return !!room && !room.isQuickChat
        },
        getMAMState: (id) => roomStore.getState().getRoomMAMQueryState(id),
        setMAMLoading: (id, loading) => roomStore.getState().setRoomMAMLoading(id, loading),
        loadFromCache: (id, limit) => roomStore.getState().loadOlderMessagesFromCache(id, limit),
        getOldestMessageId: (id) => pickOldestArchiveId(roomStore.getState().rooms.get(id)?.messages ?? []),
        clearInvalidArchiveCursor: (id, cursor) => roomStore.getState().clearMessageStanzaId(id, cursor),
        queryMAM: async (id, beforeId) => {
          await client.chat.queryRoomMAM({ roomJid: id, before: beforeId })
        },
        errorLogPrefix: 'Failed to fetch older room history',
      }),
    [client]
  )

  return useMemo(
    () => ({
      joinRoom,
      getRoomInfo,
      acknowledgeNonAnonymousRoom,
      isNonAnonymousRoomAcknowledged,
      createQuickChat,
      leaveRoom,
      getRoom,
      setActiveRoom,
      markAsRead,
      sendMessage,
      sendReaction,
      sendPoll,
      votePoll,
      closePoll,
      sendCorrection,
      retractMessage,
      moderateMessage,
      sendChatState,
      setBookmark,
      removeBookmark,
      setRoomNotifyAll,
      sendEasterEgg,
      clearAnimation,
      setDraft,
      getDraft,
      clearDraft,
      clearFirstNewMessageId,
      updateLastSeenMessageId,
      setRoomAvatar,
      clearRoomAvatar,
      restoreRoomAvatarFromCache,
      browsePublicRooms,
      inviteToRoom,
      inviteMultipleToRoom,
      submitRoomConfig,
      setSubject,
      createRoom,
      destroyRoom,
      roomExists,
      setAffiliation,
      setRole,
      queryAffiliationList,
      listHats,
      createHat,
      destroyHat,
      listHatAssignments,
      assignHat,
      unassignHat,
      fetchOlderHistory,
    }),
    [
      joinRoom,
      getRoomInfo,
      acknowledgeNonAnonymousRoom,
      isNonAnonymousRoomAcknowledged,
      createQuickChat,
      leaveRoom,
      getRoom,
      setActiveRoom,
      markAsRead,
      sendMessage,
      sendReaction,
      sendPoll,
      votePoll,
      closePoll,
      sendCorrection,
      retractMessage,
      moderateMessage,
      sendChatState,
      setBookmark,
      removeBookmark,
      setRoomNotifyAll,
      sendEasterEgg,
      clearAnimation,
      setDraft,
      getDraft,
      clearDraft,
      clearFirstNewMessageId,
      updateLastSeenMessageId,
      setRoomAvatar,
      clearRoomAvatar,
      restoreRoomAvatarFromCache,
      browsePublicRooms,
      inviteToRoom,
      inviteMultipleToRoom,
      submitRoomConfig,
      setSubject,
      createRoom,
      destroyRoom,
      roomExists,
      setAffiliation,
      setRole,
      queryAffiliationList,
      listHats,
      createHat,
      destroyHat,
      listHatAssignments,
      assignHat,
      unassignHat,
      fetchOlderHistory,
    ]
  )
}
