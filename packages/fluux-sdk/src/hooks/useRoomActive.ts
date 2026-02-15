import { useCallback, useMemo } from 'react'
import { roomStore } from '../stores'
import { useRoomStore } from '../react/storeHooks'
import { useXMPPContext } from '../provider'
import type { Room, RoomMessage, MentionReference, ChatStateNotification, FileAttachment, MAMQueryState } from '../core/types'
import { createFetchOlderHistory } from './shared'

/**
 * Stable empty array references to prevent infinite re-renders.
 */
const EMPTY_MESSAGE_ARRAY: RoomMessage[] = []
const EMPTY_TYPING_ARRAY: string[] = []

/**
 * Lightweight hook for components that display the active room.
 *
 * Unlike `useRoom()`, this hook does NOT subscribe to list-level selectors
 * (`joinedRooms`, `bookmarkedRooms`, `allRooms`, `quickChatRooms`, etc.),
 * which prevents re-renders when background sync updates other rooms.
 * Use this in RoomView, MessageComposer, and other components that only
 * need active room state + actions.
 *
 * For sidebar/room list rendering, use `useRoom()` which provides
 * the full room lists and navigation actions.
 *
 * @returns Active room state and room actions
 *
 * @example
 * ```tsx
 * function RoomView() {
 *   const { activeRoom, activeMessages, sendMessage } = useRoomActive()
 *   // Only re-renders when active room changes, not on background sync
 * }
 * ```
 *
 * @category Hooks
 */
export function useRoomActive() {
  const { client } = useXMPPContext()

  // --- Active room state (focused selectors) ---

  const activeRoomJid = useRoomStore((s) => s.activeRoomJid)

  // Use focused selectors from separated entity/meta/runtime maps to avoid
  // re-renders when unrelated rooms change. Each Map.get() returns the same
  // object reference for unchanged entries, so Zustand's Object.is check
  // prevents re-renders when other rooms are mutated.
  const activeRoomEntity = useRoomStore((s) => {
    if (!s.activeRoomJid) return undefined
    return s.roomEntities.get(s.activeRoomJid)
  })

  const activeRoomMeta = useRoomStore((s) => {
    if (!s.activeRoomJid) return undefined
    return s.roomMeta.get(s.activeRoomJid)
  })

  const activeRoomRuntime = useRoomStore((s) => {
    if (!s.activeRoomJid) return undefined
    return s.roomRuntime.get(s.activeRoomJid)
  })

  // Reconstruct the full Room object from entity + meta + runtime.
  // Room extends RoomEntity, RoomMetadata, RoomRuntime — so spreading works.
  const activeRoom = useMemo((): Room | undefined => {
    if (!activeRoomEntity || !activeRoomMeta || !activeRoomRuntime) return undefined
    return {
      ...activeRoomEntity,
      ...activeRoomMeta,
      ...activeRoomRuntime,
    }
  }, [activeRoomEntity, activeRoomMeta, activeRoomRuntime])

  // Messages from runtime (avoids subscribing to the combined rooms Map)
  const activeMessages = useMemo((): RoomMessage[] => {
    return activeRoomRuntime?.messages ?? EMPTY_MESSAGE_ARRAY
  }, [activeRoomRuntime])

  // Easter egg animation state
  const activeAnimation = useRoomStore((s) => s.activeAnimation)

  // Get MAM query state for active room (individual fields for granularity)
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

  // Get typing users for the active room as an array
  const activeTypingUsers = useMemo(() => {
    if (!activeRoomMeta?.typingUsers || activeRoomMeta.typingUsers.size === 0) {
      return EMPTY_TYPING_ARRAY
    }
    return Array.from(activeRoomMeta.typingUsers)
  }, [activeRoomMeta?.typingUsers])

  // --- Actions (all stable callbacks) ---

  const markAsRead = useRoomStore((s) => s.markAsRead)
  const clearFirstNewMessageId = useRoomStore((s) => s.clearFirstNewMessageId)
  const updateLastSeenMessageId = useRoomStore((s) => s.updateLastSeenMessageId)

  const joinRoom = useCallback(
    async (roomJid: string, nickname: string, options?: { maxHistory?: number; password?: string }) => {
      await client.muc.joinRoom(roomJid, nickname, options)
    },
    [client]
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
   * Fetch older room history (pagination) - for lazy loading on scroll up.
   */
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
        getOldestMessageId: (id) => {
          const room = roomStore.getState().rooms.get(id)
          const messages = room?.messages
          if (!messages || messages.length === 0) return undefined
          return messages[0].stanzaId || messages[0].id
        },
        queryMAM: async (id, beforeId) => {
          await client.chat.queryRoomMAM({ roomJid: id, before: beforeId })
        },
        errorLogPrefix: 'Failed to fetch older room history',
      }),
    [client]
  )

  // --- Return ---

  // Memoize actions object to prevent re-renders when only state changes
  const actions = useMemo(
    () => ({
      joinRoom,
      markAsRead,
      sendMessage,
      sendReaction,
      sendCorrection,
      retractMessage,
      sendChatState,
      setRoomNotifyAll,
      sendEasterEgg,
      clearAnimation,
      restoreRoomAvatarFromCache,
      setRoomAvatar,
      clearRoomAvatar,
      setDraft,
      getDraft,
      clearDraft,
      clearFirstNewMessageId,
      updateLastSeenMessageId,
      fetchOlderHistory,
    }),
    [
      joinRoom,
      markAsRead,
      sendMessage,
      sendReaction,
      sendCorrection,
      retractMessage,
      sendChatState,
      setRoomNotifyAll,
      sendEasterEgg,
      clearAnimation,
      restoreRoomAvatarFromCache,
      setRoomAvatar,
      clearRoomAvatar,
      setDraft,
      getDraft,
      clearDraft,
      clearFirstNewMessageId,
      updateLastSeenMessageId,
      fetchOlderHistory,
    ]
  )

  // Memoize the entire return value to prevent render loops
  return useMemo(
    () => ({
      // State
      activeRoomJid,
      activeRoom,
      activeMessages,
      activeTypingUsers,
      activeAnimation,
      activeMAMState,

      // Actions (spread memoized actions)
      ...actions,
    }),
    [
      activeRoomJid,
      activeRoom,
      activeMessages,
      activeTypingUsers,
      activeAnimation,
      activeMAMState,
      actions,
    ]
  )
}
