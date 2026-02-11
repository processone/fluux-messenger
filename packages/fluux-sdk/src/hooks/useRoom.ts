import { useCallback, useMemo } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { roomStore } from '../stores'
import { useRoomStore, useAdminStore } from '../react/storeHooks'
import { useXMPPContext } from '../provider'
import type { MentionReference, ChatStateNotification, FileAttachment, RSMRequest, AdminRoom, RSMResponse, MAMQueryState } from '../core/types'
import { createFetchOlderHistory } from './shared'

/**
 * Stable empty array reference to prevent infinite re-renders.
 */
const EMPTY_TYPING_ARRAY: string[] = []

/**
 * Hook for managing Multi-User Chat (MUC) rooms.
 *
 * Provides state and actions for group chat functionality including joining rooms,
 * sending messages, managing bookmarks, and room administration.
 *
 * @returns An object containing room state and actions
 *
 * @example Listing and joining rooms
 * ```tsx
 * function RoomList() {
 *   const { bookmarkedRooms, joinRoom, setActiveRoom } = useRoom()
 *
 *   return (
 *     <ul>
 *       {bookmarkedRooms.map(room => (
 *         <li
 *           key={room.jid}
 *           onClick={() => {
 *             joinRoom(room.jid, 'mynickname')
 *             setActiveRoom(room.jid)
 *           }}
 *         >
 *           {room.name} ({room.unreadCount} unread)
 *         </li>
 *       ))}
 *     </ul>
 *   )
 * }
 * ```
 *
 * @example Sending room messages
 * ```tsx
 * function RoomInput() {
 *   const { sendMessage, activeRoomJid } = useRoom()
 *   const [text, setText] = useState('')
 *
 *   const handleSend = async () => {
 *     if (!activeRoomJid || !text.trim()) return
 *     await sendMessage(activeRoomJid, text)
 *     setText('')
 *   }
 *
 *   return <input value={text} onChange={e => setText(e.target.value)} />
 * }
 * ```
 *
 * @example Managing bookmarks
 * ```tsx
 * function RoomSettings({ roomJid }) {
 *   const { setBookmark, removeBookmark } = useRoom()
 *
 *   const handleBookmark = () => {
 *     setBookmark(roomJid, 'Room Name', 'mynick', true) // autojoin=true
 *   }
 *
 *   const handleRemove = () => {
 *     removeBookmark(roomJid)
 *   }
 * }
 * ```
 *
 * @example Inviting users
 * ```tsx
 * function InviteUser({ roomJid }) {
 *   const { inviteToRoom } = useRoom()
 *
 *   const handleInvite = (userJid: string) => {
 *     inviteToRoom(roomJid, userJid, 'Join our discussion!')
 *   }
 * }
 * ```
 *
 * @category Hooks
 */
export function useRoom() {
  const { client } = useXMPPContext()
  // NOTE: We intentionally do NOT subscribe to the rooms Map here.
  // Subscribing to the entire Map causes render loops during connection when
  // many rooms are loaded. Use the derived selectors (joinedRooms, bookmarkedRooms, etc.)
  // which use useShallow for stable references, or use getRoom() for single room access.
  const mucServiceJid = useAdminStore((s) => s.mucServiceJid)
  // Use useShallow to compare array elements by reference, preventing re-renders
  // when the array contents haven't actually changed
  const joinedRooms = useRoomStore(useShallow((s) => s.joinedRooms()))
  const bookmarkedRooms = useRoomStore(useShallow((s) => s.bookmarkedRooms()))
  const allRooms = useRoomStore(useShallow((s) => s.allRooms()))
  const quickChatRooms = useRoomStore(useShallow((s) => s.quickChatRooms()))
  const activeRoomJid = useRoomStore((s) => s.activeRoomJid)
  const activeRoom = useRoomStore((s) => s.activeRoom())
  // Don't use useShallow for messages - when messages are prepended, we need React to re-render
  // useShallow's element-by-element comparison can miss updates in large arrays
  const activeMessages = useRoomStore((s) => s.activeMessages())
  const setActiveRoomRaw = useRoomStore((s) => s.setActiveRoom)

  // Wrapper that loads messages from IndexedDB cache when switching rooms.
  // Cache is loaded BEFORE setting active room so that setActiveRoom() in the store
  // calculates firstNewMessageId with the full message history (cached + live messages).
  // Without this, rooms that only have live messages (received while viewing another room)
  // would show only new messages without historical context above the marker.
  const setActiveRoom = useCallback(async (roomJid: string | null) => {
    if (roomJid) {
      // Always load from cache first - deduplication is handled by loadMessagesFromCache
      await roomStore.getState().loadMessagesFromCache(roomJid, { limit: 100 })
    }
    setActiveRoomRaw(roomJid)
  }, [setActiveRoomRaw])
  const markAsRead = useRoomStore((s) => s.markAsRead)
  const clearFirstNewMessageId = useRoomStore((s) => s.clearFirstNewMessageId)
  const updateLastSeenMessageId = useRoomStore((s) => s.updateLastSeenMessageId)
  const totalMentionsCount = useRoomStore((s) => s.totalMentionsCount())
  const totalUnreadCount = useRoomStore((s) => s.totalUnreadCount())
  const totalNotifiableUnreadCount = useRoomStore((s) => s.totalNotifiableUnreadCount())
  const roomsWithUnreadCount = useRoomStore((s) => s.roomsWithUnreadCount())
  const activeAnimation = useRoomStore((s) => s.activeAnimation)
  const drafts = useRoomStore((s) => s.drafts)

  // Get MAM query state for active room (for scroll-up pagination)
  // Select individual fields to avoid re-renders when other rooms' MAM states change
  const mamIsLoading = useRoomStore((s) => {
    if (!s.activeRoomJid) return false
    return s.mamQueryStates.get(s.activeRoomJid)?.isLoading ?? false
  })
  const mamIsHistoryComplete = useRoomStore((s) => {
    if (!s.activeRoomJid) return false
    return s.mamQueryStates.get(s.activeRoomJid)?.isHistoryComplete ?? false
  })
  const mamIsCaughtUpToLive = useRoomStore((s) => {
    if (!s.activeRoomJid) return false
    return s.mamQueryStates.get(s.activeRoomJid)?.isCaughtUpToLive ?? false
  })
  const mamOldestFetchedId = useRoomStore((s) => {
    if (!s.activeRoomJid) return undefined
    return s.mamQueryStates.get(s.activeRoomJid)?.oldestFetchedId
  })

  // Memoize the MAM state object to maintain stable reference
  const activeMAMState = useMemo((): MAMQueryState | null => {
    if (!activeRoomJid) return null
    return {
      isLoading: mamIsLoading,
      hasQueried: true, // Rooms always have initial history from join
      isHistoryComplete: mamIsHistoryComplete,
      isCaughtUpToLive: mamIsCaughtUpToLive,
      oldestFetchedId: mamOldestFetchedId,
      error: null,
    }
  }, [activeRoomJid, mamIsLoading, mamIsHistoryComplete, mamIsCaughtUpToLive, mamOldestFetchedId])

  // Note: Auto-load logic (cache loading) has been moved to store subscriptions
  // in sideEffects.ts. This eliminates the useEffect → action → state change pattern
  // that could cause render loops. The side effects now run outside React's render cycle.

  // Get typing users for the active room as an array
  const activeTypingUsers = useMemo(() => {
    if (!activeRoom?.typingUsers || activeRoom.typingUsers.size === 0) {
      return EMPTY_TYPING_ARRAY
    }
    return Array.from(activeRoom.typingUsers)
  }, [activeRoom?.typingUsers])

  const joinRoom = useCallback(
    async (roomJid: string, nickname: string, options?: { maxHistory?: number; password?: string }) => {
      await client.muc.joinRoom(roomJid, nickname, options)
    },
    [client]
  )

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

  /**
   * Set room avatar (XEP-0054 vCard-temp for MUC rooms).
   * Only room owners can change the room avatar.
   */
  const setRoomAvatar = useCallback(
    async (roomJid: string, imageData: Uint8Array, mimeType: string) => {
      // Convert Uint8Array to base64 data URL
      const base64 = btoa(String.fromCharCode(...Array.from(imageData)))
      const dataUrl = `data:${mimeType};base64,${base64}`
      await client.profile.setRoomAvatar(roomJid, dataUrl, mimeType)
    },
    [client]
  )

  /**
   * Clear room avatar (XEP-0054 vCard-temp for MUC rooms).
   * Only room owners can clear the room avatar.
   */
  const clearRoomAvatar = useCallback(
    async (roomJid: string) => {
      await client.profile.clearRoomAvatar(roomJid)
    },
    [client]
  )

  /**
   * Restore room avatar from cache using stored hash.
   */
  const restoreRoomAvatarFromCache = useCallback(
    async (roomJid: string, avatarHash: string) => {
      return client.profile.restoreRoomAvatarFromCache(roomJid, avatarHash)
    },
    [client]
  )

  /**
   * Browse public rooms available on a MUC service.
   * Uses disco#items with RSM pagination.
   * @param mucServiceJid - Optional MUC service JID. If not provided, uses auto-discovered service.
   * @param rsm - Optional RSM pagination parameters.
   */
  const browsePublicRooms = useCallback(
    async (mucServiceJid?: string, rsm?: RSMRequest): Promise<{ rooms: AdminRoom[]; pagination: RSMResponse }> => {
      return client.admin.fetchRoomList(mucServiceJid, rsm)
    },
    [client]
  )

  /**
   * Invite a user to a MUC room (XEP-0045 mediated invitation).
   * The invitation is sent through the room, which forwards it to the invitee.
   * For member-only rooms, the server automatically adds the invitee to the member list.
   * @param roomJid - The room JID
   * @param inviteeJid - The JID of the user to invite
   * @param reason - Optional reason/message for the invitation
   */
  const inviteToRoom = useCallback(
    async (roomJid: string, inviteeJid: string, reason?: string) => {
      await client.muc.sendMediatedInvitation(roomJid, inviteeJid, reason)
    },
    [client]
  )

  /**
   * Invite multiple users to a MUC room (XEP-0045 mediated invitations).
   * @param roomJid - The room JID
   * @param inviteeJids - Array of JIDs to invite
   * @param reason - Optional reason/message for the invitations
   */
  const inviteMultipleToRoom = useCallback(
    async (roomJid: string, inviteeJids: string[], reason?: string) => {
      await client.muc.sendMediatedInvitations(roomJid, inviteeJids, reason)
    },
    [client]
  )

  /**
   * Fetch older room history (pagination) - for lazy loading on scroll up.
   * First checks IndexedDB cache, then falls back to room MAM if:
   * - Cache is empty/exhausted
   * - Room supports MAM (XEP-0313)
   * - MAM query is not already complete
   * @param roomJid - Optional room JID. If not provided, uses active room.
   */
  const fetchOlderHistory = useMemo(
    () =>
      createFetchOlderHistory({
        getActiveId: () => roomStore.getState().activeRoomJid,
        isValidTarget: (id) => {
          // Room just needs to exist - MAM queries don't require being joined
          // Quick Chat rooms don't persist history, so skip MAM for them
          const room = roomStore.getState().rooms.get(id)
          return !!room && !room.isQuickChat
        },
        getMAMState: (id) => roomStore.getState().getRoomMAMQueryState(id),
        setMAMLoading: (id, loading) => roomStore.getState().setRoomMAMLoading(id, loading),
        loadFromCache: (id, limit) => roomStore.getState().loadOlderMessagesFromCache(id, limit),
        getOldestMessageId: (id) => {
          const room = roomStore.getState().rooms.get(id)
          const messages = room?.messages
          if (!messages || messages.length === 0) return undefined
          // Use stanzaId (MAM archive ID) for pagination cursor, fall back to message id
          return messages[0].stanzaId || messages[0].id
        },
        queryMAM: async (id, beforeId) => {
          await client.chat.queryRoomMAM({ roomJid: id, before: beforeId })
        },
        errorLogPrefix: 'Failed to fetch older room history',
      }),
    [client]
  )

  // Memoize actions object to prevent re-renders when only state changes
  const actions = useMemo(
    () => ({
      joinRoom,
      createQuickChat,
      leaveRoom,
      getRoom,
      setActiveRoom,
      markAsRead,
      sendMessage,
      sendReaction,
      sendCorrection,
      retractMessage,
      sendChatState,
      setBookmark,
      removeBookmark,
      setRoomNotifyAll,
      sendEasterEgg,
      clearAnimation,
      restoreRoomAvatarFromCache,
      browsePublicRooms,
      setRoomAvatar,
      clearRoomAvatar,
      setDraft,
      getDraft,
      clearDraft,
      clearFirstNewMessageId,
      updateLastSeenMessageId,
      inviteToRoom,
      inviteMultipleToRoom,
      fetchOlderHistory,
    }),
    [
      joinRoom,
      createQuickChat,
      leaveRoom,
      getRoom,
      setActiveRoom,
      markAsRead,
      sendMessage,
      sendReaction,
      sendCorrection,
      retractMessage,
      sendChatState,
      setBookmark,
      removeBookmark,
      setRoomNotifyAll,
      sendEasterEgg,
      clearAnimation,
      restoreRoomAvatarFromCache,
      browsePublicRooms,
      setRoomAvatar,
      clearRoomAvatar,
      setDraft,
      getDraft,
      clearDraft,
      clearFirstNewMessageId,
      updateLastSeenMessageId,
      inviteToRoom,
      inviteMultipleToRoom,
      fetchOlderHistory,
    ]
  )

  // Memoize the entire return value to prevent render loops
  return useMemo(
    () => ({
      // State
      // NOTE: `rooms` Map is intentionally NOT exposed here to prevent render loops.
      // Use the derived selectors (joinedRooms, bookmarkedRooms, allRooms) for lists,
      // or getRoom() for single room access. For direct Map access in rare cases,
      // use roomStore.getState().rooms
      joinedRooms,
      bookmarkedRooms,
      allRooms,
      quickChatRooms,
      activeRoomJid,
      activeRoom,
      activeMessages,
      activeTypingUsers,
      totalMentionsCount,
      totalUnreadCount,
      totalNotifiableUnreadCount,
      roomsWithUnreadCount,
      activeAnimation,
      drafts,
      mucServiceJid,
      activeMAMState,

      // Actions (spread memoized actions)
      ...actions,
    }),
    [
      joinedRooms,
      bookmarkedRooms,
      allRooms,
      quickChatRooms,
      activeRoomJid,
      activeRoom,
      activeMessages,
      activeTypingUsers,
      totalMentionsCount,
      totalUnreadCount,
      totalNotifiableUnreadCount,
      roomsWithUnreadCount,
      activeAnimation,
      drafts,
      mucServiceJid,
      activeMAMState,
      actions,
    ]
  )
}
