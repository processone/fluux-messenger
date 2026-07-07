import { useCallback, useMemo } from 'react'
import { roomStore } from '../stores'
import { useXMPPContext } from '../provider'
import type {
  MentionReference,
  ChatStateNotification,
  FileAttachment,
  RoomFeatures,
} from '../core/types'
import { createFetchOlderHistory, pickOldestArchiveId } from './shared'
import { usePolls } from './usePolls'
import { useRoomModeration } from './useRoomModeration'
import { useRoomManagement } from './useRoomManagement'

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
 * The poll / moderation / management slices are the FOCUSED hooks
 * (`usePolls`, `useRoomModeration`, `useRoomManagement`) composed here; prefer
 * those directly in components that only work with one slice.
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

  // Focused action slices (each subscribes to nothing).
  const polls = usePolls()
  const moderation = useRoomModeration()
  const management = useRoomManagement()

  const joinRoom = useCallback(
    async (roomJid: string, nickname: string, options?: { maxHistory?: number; password?: string; knownFeatures?: RoomFeatures | null }) => {
      await client.muc.joinRoom(roomJid, nickname, options)
    },
    [client]
  )

  const joinResult = useCallback(
    async (roomJid: string): Promise<void> => {
      await client.muc.joinResult(roomJid)
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

  const markReadToNewest = useCallback((roomJid: string) => {
    roomStore.getState().markReadToNewest(roomJid)
  }, [])

  const markAllRoomsRead = useCallback(() => {
    roomStore.getState().markAllRoomsRead()
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

  const sendChatState = useCallback(
    async (roomJid: string, state: ChatStateNotification) => {
      await client.chat.sendChatState(roomJid, state, 'groupchat')
    },
    [client]
  )

  const sendWhisperChatState = useCallback(
    async (roomJid: string, nick: string, state: ChatStateNotification) => {
      await client.chat.sendWhisperChatState(roomJid, nick, state)
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
      // Core: messaging / lifecycle / read-state / drafts / history
      joinRoom,
      joinResult,
      getRoomInfo,
      acknowledgeNonAnonymousRoom,
      isNonAnonymousRoomAcknowledged,
      createQuickChat,
      leaveRoom,
      getRoom,
      setActiveRoom,
      markAsRead,
      markReadToNewest,
      markAllRoomsRead,
      sendMessage,
      sendReaction,
      sendCorrection,
      retractMessage,
      sendChatState,
      sendWhisperChatState,
      sendEasterEgg,
      clearAnimation,
      setDraft,
      getDraft,
      clearDraft,
      clearFirstNewMessageId,
      updateLastSeenMessageId,
      fetchOlderHistory,
      // Focused slices (composed)
      ...polls,
      ...moderation,
      ...management,
    }),
    [
      joinRoom,
      joinResult,
      getRoomInfo,
      acknowledgeNonAnonymousRoom,
      isNonAnonymousRoomAcknowledged,
      createQuickChat,
      leaveRoom,
      getRoom,
      setActiveRoom,
      markAsRead,
      markReadToNewest,
      markAllRoomsRead,
      sendMessage,
      sendReaction,
      sendCorrection,
      retractMessage,
      sendChatState,
      sendWhisperChatState,
      sendEasterEgg,
      clearAnimation,
      setDraft,
      getDraft,
      clearDraft,
      clearFirstNewMessageId,
      updateLastSeenMessageId,
      fetchOlderHistory,
      polls,
      moderation,
      management,
    ]
  )
}
