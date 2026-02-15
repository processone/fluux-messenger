/**
 * Granular selectors for roomStore to reduce re-renders.
 *
 * Using these selectors with Zustand's shallow comparison allows components
 * to subscribe to specific pieces of state instead of entire Maps/objects.
 *
 * @example
 * ```tsx
 * import { useRoomStore, roomSelectors } from '@fluux/sdk'
 * import { shallow } from 'zustand/shallow'
 *
 * // Only re-renders when room JIDs change (not when occupants/messages change)
 * const roomJids = useRoomStore(roomSelectors.bookmarkedRoomJids, shallow)
 *
 * // Only re-renders when this specific room changes
 * const room = useRoomStore(roomSelectors.roomById('room@conference.example.com'))
 * ```
 *
 * @packageDocumentation
 * @module Stores/RoomSelectors
 */

import type { RoomState } from './roomStore'
import type { Room, RoomEntity, RoomMetadata, RoomRuntime, RoomOccupant, RoomMessage, MAMQueryState } from '../core/types'

/**
 * Stable empty references to prevent infinite re-renders.
 */
const EMPTY_STRING_ARRAY: string[] = []
const EMPTY_MESSAGE_ARRAY: RoomMessage[] = []
const EMPTY_OCCUPANT_MAP: Map<string, RoomOccupant> = new Map()
const EMPTY_TYPING_SET: Set<string> = new Set()

/**
 * Granular selectors for roomStore.
 *
 * These selectors enable fine-grained subscriptions to reduce unnecessary
 * re-renders. Use with Zustand's shallow comparison for array/object returns.
 *
 * @category Selectors
 */
export const roomSelectors = {
  /**
   * Get all room JIDs.
   * Use with shallow() to only re-render when JIDs change.
   */
  roomJids: (state: RoomState): string[] => {
    const jids = Array.from(state.rooms.keys())
    return jids.length > 0 ? jids : EMPTY_STRING_ARRAY
  },

  /**
   * Get bookmarked room JIDs (sorted by name).
   */
  bookmarkedRoomJids: (state: RoomState): string[] => {
    const jids: string[] = []
    for (const [jid, room] of state.rooms) {
      if (room.isBookmarked) {
        jids.push(jid)
      }
    }
    if (jids.length === 0) return EMPTY_STRING_ARRAY

    // Sort by room name
    return jids.sort((a, b) => {
      const roomA = state.rooms.get(a)
      const roomB = state.rooms.get(b)
      const nameA = roomA?.name ?? a
      const nameB = roomB?.name ?? b
      return nameA.localeCompare(nameB)
    })
  },

  /**
   * Get joined room JIDs.
   */
  joinedRoomJids: (state: RoomState): string[] => {
    const jids: string[] = []
    for (const [jid, room] of state.rooms) {
      if (room.joined) {
        jids.push(jid)
      }
    }
    return jids.length > 0 ? jids : EMPTY_STRING_ARRAY
  },

  /**
   * Get quick chat room JIDs.
   */
  quickChatRoomJids: (state: RoomState): string[] => {
    const jids: string[] = []
    for (const [jid, room] of state.rooms) {
      if (room.isQuickChat) {
        jids.push(jid)
      }
    }
    return jids.length > 0 ? jids : EMPTY_STRING_ARRAY
  },

  /**
   * Get a specific room by JID.
   * Returns a selector function for the given room JID.
   */
  roomById: (roomJid: string) => (state: RoomState): Room | undefined => {
    return state.rooms.get(roomJid)
  },

  /**
   * Get messages for a specific room.
   * Returns a selector function for the given room JID.
   */
  messagesForRoom: (roomJid: string) => (state: RoomState): RoomMessage[] => {
    return state.rooms.get(roomJid)?.messages ?? EMPTY_MESSAGE_ARRAY
  },

  /**
   * Get the currently active room JID.
   */
  activeRoomJid: (state: RoomState): string | null => {
    return state.activeRoomJid
  },

  /**
   * Get the currently active room.
   */
  activeRoom: (state: RoomState): Room | undefined => {
    if (!state.activeRoomJid) return undefined
    return state.rooms.get(state.activeRoomJid)
  },

  /**
   * Get messages for the currently active room.
   */
  activeMessages: (state: RoomState): RoomMessage[] => {
    if (!state.activeRoomJid) return EMPTY_MESSAGE_ARRAY
    return state.rooms.get(state.activeRoomJid)?.messages ?? EMPTY_MESSAGE_ARRAY
  },

  /**
   * Get occupants for a specific room.
   */
  occupantsFor: (roomJid: string) => (state: RoomState): Map<string, RoomOccupant> => {
    return state.rooms.get(roomJid)?.occupants ?? EMPTY_OCCUPANT_MAP
  },

  /**
   * Get occupant count for a specific room.
   */
  occupantCountFor: (roomJid: string) => (state: RoomState): number => {
    return state.rooms.get(roomJid)?.occupants.size ?? 0
  },

  /**
   * Get typing users (nicks) for a specific room.
   */
  typingFor: (roomJid: string) => (state: RoomState): Set<string> => {
    return state.rooms.get(roomJid)?.typingUsers ?? EMPTY_TYPING_SET
  },

  /**
   * Get draft text for a specific room.
   */
  draftFor: (roomJid: string) => (state: RoomState): string => {
    return state.drafts.get(roomJid) ?? ''
  },

  /**
   * Check if a room has a draft.
   */
  hasDraft: (roomJid: string) => (state: RoomState): boolean => {
    const draft = state.drafts.get(roomJid)
    return !!draft && draft.length > 0
  },

  /**
   * Get MAM query state for a specific room.
   */
  mamStateFor: (roomJid: string) => (state: RoomState): MAMQueryState | undefined => {
    return state.mamQueryStates.get(roomJid)
  },

  /**
   * Check if MAM is loading for a specific room.
   */
  isMAMLoading: (roomJid: string) => (state: RoomState): boolean => {
    return state.mamQueryStates.get(roomJid)?.isLoading ?? false
  },

  /**
   * Get total mentions count across all joined rooms.
   */
  totalMentionsCount: (state: RoomState): number => {
    let total = 0
    for (const [jid, entity] of state.roomEntities) {
      if (entity.joined) {
        const meta = state.roomMeta.get(jid)
        if (meta) total += meta.mentionsCount
      }
    }
    return total
  },

  /**
   * Get total unread count across all joined rooms.
   */
  totalUnreadCount: (state: RoomState): number => {
    let total = 0
    for (const [jid, entity] of state.roomEntities) {
      if (entity.joined) {
        const meta = state.roomMeta.get(jid)
        if (meta) total += meta.unreadCount
      }
    }
    return total
  },

  /**
   * Get total notifiable unread count (rooms with notifyAll enabled).
   */
  totalNotifiableUnreadCount: (state: RoomState): number => {
    let total = 0
    for (const [jid, entity] of state.roomEntities) {
      if (entity.joined) {
        const meta = state.roomMeta.get(jid)
        if (meta && (meta.notifyAll || meta.notifyAllPersistent)) {
          total += meta.unreadCount
        }
      }
    }
    return total
  },

  /**
   * Get count of rooms with unread activity (mentions or notifyAll with unread).
   */
  roomsWithUnreadCount: (state: RoomState): number => {
    let count = 0
    for (const [jid, entity] of state.roomEntities) {
      if (entity.joined) {
        const meta = state.roomMeta.get(jid)
        if (meta) {
          const hasActivity =
            meta.mentionsCount > 0 ||
            ((meta.notifyAll || meta.notifyAllPersistent) && meta.unreadCount > 0)
          if (hasActivity) count++
        }
      }
    }
    return count
  },

  /**
   * Get unread count for a specific room.
   */
  unreadCountFor: (roomJid: string) => (state: RoomState): number => {
    return state.rooms.get(roomJid)?.unreadCount ?? 0
  },

  /**
   * Get mentions count for a specific room.
   */
  mentionsCountFor: (roomJid: string) => (state: RoomState): number => {
    return state.rooms.get(roomJid)?.mentionsCount ?? 0
  },

  /**
   * Check if a room is joined.
   */
  isJoined: (roomJid: string) => (state: RoomState): boolean => {
    return state.rooms.get(roomJid)?.joined ?? false
  },

  /**
   * Check if a room is bookmarked.
   */
  isBookmarked: (roomJid: string) => (state: RoomState): boolean => {
    return state.rooms.get(roomJid)?.isBookmarked ?? false
  },

  /**
   * Check if a room exists.
   */
  hasRoom: (roomJid: string) => (state: RoomState): boolean => {
    return state.rooms.has(roomJid)
  },

  /**
   * Get the active animation state.
   */
  activeAnimation: (state: RoomState): { roomJid: string; animation: string } | null => {
    return state.activeAnimation
  },

  /**
   * Get room count (total).
   */
  roomCount: (state: RoomState): number => {
    return state.rooms.size
  },

  /**
   * Get bookmarked room count.
   */
  bookmarkedRoomCount: (state: RoomState): number => {
    let count = 0
    for (const room of state.rooms.values()) {
      if (room.isBookmarked) count++
    }
    return count
  },

  /**
   * Get joined room count.
   */
  joinedRoomCount: (state: RoomState): number => {
    let count = 0
    for (const room of state.rooms.values()) {
      if (room.joined) count++
    }
    return count
  },

  /**
   * Get firstNewMessageId for a specific room (for new message marker).
   */
  firstNewMessageIdFor: (roomJid: string) => (state: RoomState): string | undefined => {
    return state.rooms.get(roomJid)?.firstNewMessageId
  },

  /**
   * Get self occupant for a specific room.
   */
  selfOccupantFor: (roomJid: string) => (state: RoomState): RoomOccupant | undefined => {
    return state.rooms.get(roomJid)?.selfOccupant
  },

  /**
   * Check if notifyAll is enabled for a specific room.
   */
  notifyAllFor: (roomJid: string) => (state: RoomState): boolean => {
    const room = state.rooms.get(roomJid)
    return !!(room?.notifyAll || room?.notifyAllPersistent)
  },

  // ============================================================
  // METADATA SELECTORS - Fine-grained subscriptions (Phase 6)
  // ============================================================
  // These selectors use the separated entity/metadata/runtime maps to enable
  // subscriptions that only re-render when specific data changes.

  /**
   * Get room entity by JID (stable identity data only).
   * Use this when you only need jid, name, nickname, joined status - not occupants or messages.
   */
  entityById: (roomJid: string) => (state: RoomState): RoomEntity | undefined => {
    return state.roomEntities.get(roomJid)
  },

  /**
   * Get room metadata by JID (frequently-changing data only).
   * Use this for sidebar badges, unread/mentions counts, typing indicators.
   */
  metadataById: (roomJid: string) => (state: RoomState): RoomMetadata | undefined => {
    return state.roomMeta.get(roomJid)
  },

  /**
   * Get room runtime by JID (session-only data).
   * Use this for occupants, messages, selfOccupant.
   */
  runtimeById: (roomJid: string) => (state: RoomState): RoomRuntime | undefined => {
    return state.roomRuntime.get(roomJid)
  },

  /**
   * Get all room metadata as a Map.
   * Use with shallow() for sidebar list that only needs badge data.
   */
  allMetadata: (state: RoomState): Map<string, RoomMetadata> => {
    return state.roomMeta
  },

  /**
   * Get all room entities as a Map.
   * Use with shallow() for components that only need identity data.
   */
  allEntities: (state: RoomState): Map<string, RoomEntity> => {
    return state.roomEntities
  },

  /**
   * Get all room runtime as a Map.
   * Use with shallow() for components that need occupants/messages.
   */
  allRuntime: (state: RoomState): Map<string, RoomRuntime> => {
    return state.roomRuntime
  },

  /**
   * Get sidebar list items with all data needed for efficient sidebar rendering.
   * Combines entity + metadata + runtime (last message, occupant count) for each room.
   * Use this instead of full rooms when rendering the sidebar list.
   */
  sidebarListItems: (state: RoomState): Array<{
    jid: string
    name: string
    nickname: string
    joined: boolean
    isBookmarked: boolean
    isJoining?: boolean
    isQuickChat?: boolean
    autojoin?: boolean
    avatar?: string
    avatarHash?: string
    unreadCount: number
    mentionsCount: number
    notifyAll: boolean
    draft?: string
    occupantCount: number
    lastMessage?: RoomMessage
  }> => {
    const items: Array<{
      jid: string
      name: string
      nickname: string
      joined: boolean
      isBookmarked: boolean
      isJoining?: boolean
      isQuickChat?: boolean
      autojoin?: boolean
      avatar?: string
      avatarHash?: string
      unreadCount: number
      mentionsCount: number
      notifyAll: boolean
      draft?: string
      occupantCount: number
      lastMessage?: RoomMessage
    }> = []

    for (const [jid, entity] of state.roomEntities) {
      const meta = state.roomMeta.get(jid)
      const runtime = state.roomRuntime.get(jid)
      // Use lastMessage from metadata (updated on addMessage) for optimized sidebar rendering
      items.push({
        jid,
        name: entity.name,
        nickname: entity.nickname,
        joined: entity.joined,
        isBookmarked: entity.isBookmarked,
        isJoining: entity.isJoining,
        isQuickChat: entity.isQuickChat,
        autojoin: entity.autojoin,
        avatar: entity.avatar,
        avatarHash: entity.avatarHash,
        unreadCount: meta?.unreadCount ?? 0,
        mentionsCount: meta?.mentionsCount ?? 0,
        notifyAll: !!(meta?.notifyAll || meta?.notifyAllPersistent),
        draft: state.drafts.get(jid),
        occupantCount: runtime?.occupants.size ?? 0,
        lastMessage: meta?.lastMessage,
      })
    }

    // Sort by room name
    return items.sort((a, b) => a.name.localeCompare(b.name))
  },

  /**
   * Get bookmarked sidebar items with all data needed for sidebar rendering.
   */
  bookmarkedSidebarListItems: (state: RoomState): Array<{
    jid: string
    name: string
    nickname: string
    joined: boolean
    isBookmarked: boolean
    isJoining?: boolean
    isQuickChat?: boolean
    autojoin?: boolean
    avatar?: string
    avatarHash?: string
    unreadCount: number
    mentionsCount: number
    notifyAll: boolean
    draft?: string
    occupantCount: number
    lastMessage?: RoomMessage
  }> => {
    const items: Array<{
      jid: string
      name: string
      nickname: string
      joined: boolean
      isBookmarked: boolean
      isJoining?: boolean
      isQuickChat?: boolean
      autojoin?: boolean
      avatar?: string
      avatarHash?: string
      unreadCount: number
      mentionsCount: number
      notifyAll: boolean
      draft?: string
      occupantCount: number
      lastMessage?: RoomMessage
    }> = []

    for (const [jid, entity] of state.roomEntities) {
      if (!entity.isBookmarked) continue
      const meta = state.roomMeta.get(jid)
      const runtime = state.roomRuntime.get(jid)
      // Use lastMessage from metadata (updated on addMessage) for optimized sidebar rendering
      items.push({
        jid,
        name: entity.name,
        nickname: entity.nickname,
        joined: entity.joined,
        isBookmarked: true, // Always true for bookmarked items
        isJoining: entity.isJoining,
        isQuickChat: entity.isQuickChat,
        autojoin: entity.autojoin,
        avatar: entity.avatar,
        avatarHash: entity.avatarHash,
        unreadCount: meta?.unreadCount ?? 0,
        mentionsCount: meta?.mentionsCount ?? 0,
        notifyAll: !!(meta?.notifyAll || meta?.notifyAllPersistent),
        draft: state.drafts.get(jid),
        occupantCount: runtime?.occupants.size ?? 0,
        lastMessage: meta?.lastMessage,
      })
    }

    // Sort by room name
    return items.sort((a, b) => a.name.localeCompare(b.name))
  },

  /**
   * Get messages for a room using the runtime map.
   * Use this for message list rendering.
   */
  runtimeMessagesFor: (roomJid: string) => (state: RoomState): RoomMessage[] => {
    return state.roomRuntime.get(roomJid)?.messages ?? EMPTY_MESSAGE_ARRAY
  },

  /**
   * Get occupants for a room using the runtime map.
   * Use this for occupant panel rendering.
   */
  runtimeOccupantsFor: (roomJid: string) => (state: RoomState): Map<string, RoomOccupant> => {
    return state.roomRuntime.get(roomJid)?.occupants ?? EMPTY_OCCUPANT_MAP
  },
}
