import { useCallback, useMemo } from 'react'
import { roomStore } from '../stores'
import { roomSelectors } from '../stores/roomSelectors'
import { useRoomStore } from '../react/storeHooks'
import { useXMPPContext } from '../provider'
import type { Room, RoomMessage, MentionReference, ChatStateNotification, FileAttachment, MAMQueryState, RoomFeatures } from '../core/types'
import { createFetchOlderHistory, createContinueCatchUp, pickOldestArchiveId } from './shared'
import { usePolls } from './usePolls'
import { useRoomModeration } from './useRoomModeration'
import { useRoomManagement } from './useRoomManagement'

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

  // Slice actions sourced from the focused hooks (each subscribes to no store,
  // so they add no re-render triggers). Only the actions this hook already
  // exposed are destructured — the public surface is unchanged.
  const { sendPoll, votePoll, closePoll } = usePolls()
  const { moderateMessage, setAffiliation, setRole } = useRoomModeration()
  const {
    setRoomNotifyAll,
    submitRoomConfig,
    setSubject,
    destroyRoom,
    setRoomAvatar,
    clearRoomAvatar,
    restoreRoomAvatarFromCache,
  } = useRoomManagement()

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

  const activeFirstNewMessageId = useRoomStore((s) => {
    if (!s.activeRoomJid) return undefined
    return s.firstNewMessageMarkers.get(s.activeRoomJid)
  })

  // Persisted read pointer (XEP-0490 sync marker) for the active room. Drives the FAB badge count
  // and the divider resync-on-scroll-up trigger in MessageList.
  const activeLastSeenMessageId = useRoomStore((s) => {
    if (!s.activeRoomJid) return undefined
    return s.roomMeta.get(s.activeRoomJid)?.lastSeenMessageId
  })

  // Provisional divider: derived from the local pointer while a synced XEP-0490
  // read position is still unresolved — rendered muted until confirmed.
  const activeFirstNewMessageIsProvisional = useRoomStore((s) => {
    if (!s.activeRoomJid) return false
    return roomSelectors.firstNewMessageIsProvisionalFor(s.activeRoomJid)(s)
  })

  const activeRoomRuntime = useRoomStore((s) => {
    if (!s.activeRoomJid) return undefined
    return s.roomRuntime.get(s.activeRoomJid)
  })

  // Sliding window: whether the resident window includes the newest message. `false` = slid up
  // (the load-newer scroll trigger and the jump-to-latest affordance turn on). Absent ⇒ at edge.
  const activeWindowAtLiveEdge = useRoomStore((s) => {
    if (!s.activeRoomJid) return true
    return s.roomRuntime.get(s.activeRoomJid)?.windowAtLiveEdge ?? true
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

  // Target message for scroll-to (from activity log click, etc.)
  const targetMessageId = useRoomStore((s) => s.targetMessageId)

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
  // Source the gap marker from the PERSISTED roomGaps (survives reload), not the
  // ephemeral mamQueryStates.forwardGapTimestamp which is lost on reload.
  const mamForwardGapTimestamp = useRoomStore((s) => {
    if (!s.activeRoomJid) return undefined
    return s.roomGaps.get(s.activeRoomJid)?.start
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
      forwardGapTimestamp: mamForwardGapTimestamp,
      error: null,
    }
  }, [activeRoomJid, mamIsLoading, mamIsHistoryComplete, mamIsCaughtUpToLive, mamOldestFetchedId, mamForwardGapTimestamp])

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
  const resyncDividerToReadPointer = useRoomStore((s) => s.resyncDividerToReadPointer)
  const updateLastSeenMessageId = useRoomStore((s) => s.updateLastSeenMessageId)

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
    [client],
  )

  const changeNick = useCallback(
    async (roomJid: string, newNick: string): Promise<void> => {
      await client.muc.changeNick(roomJid, newNick)
    },
    [client],
  )

  // Pre-join room inspection + real-JID-exposure acknowledgement (issue #37)
  const getRoomInfo = useCallback(
    async (roomJid: string): Promise<RoomFeatures | null> => client.muc.queryRoomFeatures(roomJid),
    [client]
  )
  const acknowledgeNonAnonymousRoom = useCallback((roomJid: string) => {
    roomStore.getState().acknowledgeNonAnonymousRoom(roomJid)
  }, [])
  const isNonAnonymousRoomAcknowledged = useCallback(
    (roomJid: string) => roomStore.getState().isNonAnonymousRoomAcknowledged(roomJid),
    []
  )

  const sendMessage = useCallback(
    async (
      roomJid: string,
      body: string,
      options?: {
        replyTo?: { id: string; to: string; fallback?: { author: string; body: string } }
        references?: MentionReference[]
        attachment?: FileAttachment
      }
    ): Promise<string> => {
      return await client.chat.sendMessage(roomJid, body, 'groupchat', options?.replyTo, options?.references, options?.attachment)
    },
    [client]
  )

  const sendWhisper = useCallback(
    async (roomJid: string, nick: string, body: string): Promise<string> => {
      return await client.chat.sendWhisper(roomJid, nick, body)
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

  const clearTargetMessageId = useCallback(() => {
    roomStore.getState().setTargetMessageId(null)
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
        getOldestMessageId: (id) => pickOldestArchiveId(roomStore.getState().rooms.get(id)?.messages ?? []),
        clearInvalidArchiveCursor: (id, cursor) => roomStore.getState().clearMessageStanzaId(id, cursor),
        queryMAM: async (id, beforeId) => {
          await client.chat.queryRoomMAM({ roomJid: id, before: beforeId })
        },
        errorLogPrefix: 'Failed to fetch older room history',
      }),
    [client]
  )

  /**
   * Continue forward MAM catch-up for the active room ("Load missing
   * messages"). Used when a previous catch-up was incomplete (gap marker
   * visible). Cursor policy in createContinueCatchUp.
   */
  const continueRoomCatchUp = useMemo(
    () =>
      createContinueCatchUp({
        getActiveId: () => roomStore.getState().activeRoomJid,
        getMAMState: (id) => roomStore.getState().getRoomMAMQueryState(id),
        setMAMLoading: (id, loading) => roomStore.getState().setRoomMAMLoading(id, loading),
        loadFromCache: (id, limit) => roomStore.getState().loadMessagesFromCache(id, { limit }),
        getMessages: (id) => roomStore.getState().rooms.get(id)?.messages || [],
        getGap: (id) => roomStore.getState().roomGaps.get(id),
        queryMAM: async (id, options) => {
          await client.chat.queryRoomMAM({ roomJid: id, ...options })
        },
      }),
    [client]
  )

  // Hydrate the resident array with the cache slice CONTAINING a specific message, used by scroll
  // restore / search navigation when the target/anchor isn't in the latest-N slice. Bound to the
  // currently-active room (the one being viewed when restore runs).
  const loadMessagesAround = useCallback(
    (anchorMessageId: string) => {
      const id = roomStore.getState().activeRoomJid
      if (!id) return Promise.resolve([])
      return roomStore.getState().loadMessagesAroundFromCache(id, anchorMessageId)
    },
    []
  )

  // Sliding window: load the next-newer cache slice for the active room and append it (evicting
  // the oldest). Driven by the load-newer scroll trigger when the reader scrolls back down.
  const loadNewer = useCallback(() => {
    const id = roomStore.getState().activeRoomJid
    if (!id) return Promise.resolve([])
    return roomStore.getState().loadNewerMessagesFromCache(id)
  }, [])

  // Sliding window: reset the resident window to the newest slice (jump-to-latest affordance).
  const recenterToLatest = useCallback(() => {
    const id = roomStore.getState().activeRoomJid
    if (!id) return Promise.resolve()
    return roomStore.getState().recenterToLatest(id)
  }, [])

  // --- Return ---

  // Memoize actions object to prevent re-renders when only state changes
  const actions = useMemo(
    () => ({
      joinRoom,
      joinResult,
      changeNick,
      getRoomInfo,
      acknowledgeNonAnonymousRoom,
      isNonAnonymousRoomAcknowledged,
      markAsRead,
      sendMessage,
      sendWhisper,
      sendReaction,
      sendPoll,
      votePoll,
      closePoll,
      sendCorrection,
      retractMessage,
      moderateMessage,
      sendChatState,
      sendWhisperChatState,
      setRoomNotifyAll,
      sendEasterEgg,
      clearAnimation,
      clearTargetMessageId,
      restoreRoomAvatarFromCache,
      setRoomAvatar,
      clearRoomAvatar,
      setDraft,
      getDraft,
      clearDraft,
      clearFirstNewMessageId,
      resyncDividerToReadPointer,
      updateLastSeenMessageId,
      fetchOlderHistory,
      loadMessagesAround,
      loadNewer,
      recenterToLatest,
      continueRoomCatchUp,
      submitRoomConfig,
      setSubject,
      destroyRoom,
      setAffiliation,
      setRole,
    }),
    [
      joinRoom,
      joinResult,
      changeNick,
      getRoomInfo,
      acknowledgeNonAnonymousRoom,
      isNonAnonymousRoomAcknowledged,
      markAsRead,
      sendMessage,
      sendWhisper,
      sendReaction,
      sendPoll,
      votePoll,
      closePoll,
      sendCorrection,
      retractMessage,
      moderateMessage,
      sendChatState,
      sendWhisperChatState,
      setRoomNotifyAll,
      sendEasterEgg,
      clearAnimation,
      clearTargetMessageId,
      restoreRoomAvatarFromCache,
      setRoomAvatar,
      clearRoomAvatar,
      setDraft,
      getDraft,
      clearDraft,
      clearFirstNewMessageId,
      resyncDividerToReadPointer,
      updateLastSeenMessageId,
      fetchOlderHistory,
      loadMessagesAround,
      loadNewer,
      recenterToLatest,
      continueRoomCatchUp,
      submitRoomConfig,
      setSubject,
      destroyRoom,
      setAffiliation,
      setRole,
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
      targetMessageId,
      activeMAMState,
      firstNewMessageId: activeFirstNewMessageId,
      firstNewMessageIsProvisional: activeFirstNewMessageIsProvisional,
      lastSeenMessageId: activeLastSeenMessageId,
      windowAtLiveEdge: activeWindowAtLiveEdge,

      // Actions (spread memoized actions)
      ...actions,
    }),
    [
      activeRoomJid,
      activeRoom,
      activeMessages,
      activeTypingUsers,
      activeAnimation,
      targetMessageId,
      activeMAMState,
      activeFirstNewMessageId,
      activeFirstNewMessageIsProvisional,
      activeLastSeenMessageId,
      activeWindowAtLiveEdge,
      actions,
    ]
  )
}
