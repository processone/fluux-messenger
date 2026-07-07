import { useMemo } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { useRoomStore, useAdminStore } from '../react/storeHooks'
import type { MAMQueryState } from '../core/types'
import { useRoomActions } from './useRoomActions'

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
  // Actions live in useRoomActions (zero store subscriptions). useRoom composes
  // it and adds the room-list/active-room state subscriptions below — so the
  // action definitions exist ONCE (they previously drifted between the two).
  const actions = useRoomActions()

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
