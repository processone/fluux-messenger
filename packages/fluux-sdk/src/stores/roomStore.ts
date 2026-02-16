import { createStore } from 'zustand/vanilla'
import { subscribeWithSelector } from 'zustand/middleware'
import type {
  Room,
  RoomEntity,
  RoomMetadata,
  RoomRuntime,
  RoomOccupant,
  RoomMessage,
  MAMQueryState,
  RSMResponse,
} from '../core/types'
import { setTypingTimeout, clearTypingTimeout } from './typingTimeout'
import { findMessageById } from '../utils/messageLookup'
import { getBareJid } from '../core/jid'
import * as messageCache from '../utils/messageCache'
import type { GetMessagesOptions } from '../utils/messageCache'
import * as mamState from './shared/mamState'
import type { MAMQueryDirection } from './shared/mamState'
import * as draftState from './shared/draftState'
import { buildMessageKeySet, isMessageDuplicate, sortMessagesByTimestamp, trimMessages, prependOlderMessages, mergeAndProcessMessages } from './shared/messageArrayUtils'
import { shouldUpdateLastMessage } from './shared/lastMessageUtils'
import * as notifState from './shared/notificationState'
import { connectionStore } from './connectionStore'

/**
 * Maximum messages to keep in memory per room.
 * Older messages are still available in IndexedDB and can be loaded on demand.
 */
const MAX_MESSAGES_PER_ROOM = 1000

/**
 * localStorage key for persisting room drafts.
 * Room drafts are stored separately from the main room state because
 * room data is restored from server bookmarks on reconnect, but drafts
 * should survive page reloads.
 */
const ROOM_DRAFTS_STORAGE_KEY = 'fluux-room-drafts'

/**
 * Load room drafts from localStorage.
 */
function loadDraftsFromStorage(): Map<string, string> {
  try {
    const stored = localStorage.getItem(ROOM_DRAFTS_STORAGE_KEY)
    if (stored) {
      const entries = JSON.parse(stored) as [string, string][]
      return new Map(entries)
    }
  } catch {
    // Ignore parse errors
  }
  return new Map()
}

/**
 * Save room drafts to localStorage.
 */
function saveDraftsToStorage(drafts: Map<string, string>): void {
  try {
    const entries = Array.from(drafts.entries())
    localStorage.setItem(ROOM_DRAFTS_STORAGE_KEY, JSON.stringify(entries))
  } catch {
    // Ignore storage errors (quota exceeded, etc.)
  }
}

/**
 * Stable empty array references to prevent infinite re-renders.
 * When computed selectors return empty results, they should return these
 * constants instead of creating new [] instances each time.
 */
const EMPTY_ROOM_ARRAY: Room[] = []

// Selector memoization caches.
// Store selectors (joinedRooms, allRooms, etc.) are called on every Zustand subscription check.
// Without caching, each call runs O(n) filter + O(n log n) sort even when the rooms Map hasn't changed.
// Since Zustand creates new Map references on mutations, we can cache by Map identity.
let _cachedJoinedRooms: Room[] = EMPTY_ROOM_ARRAY
let _cachedJoinedRoomsSource: Map<string, Room> | null = null
let _cachedBookmarkedRooms: Room[] = EMPTY_ROOM_ARRAY
let _cachedBookmarkedRoomsSource: Map<string, Room> | null = null
let _cachedAllRooms: Room[] = EMPTY_ROOM_ARRAY
let _cachedAllRoomsSource: Map<string, Room> | null = null
let _cachedQuickChatRooms: Room[] = EMPTY_ROOM_ARRAY
let _cachedQuickChatRoomsSource: Map<string, Room> | null = null
const EMPTY_MESSAGE_ARRAY: RoomMessage[] = []

/**
 * Extract deduplication keys from a room message.
 * Room messages use:
 * - stanzaId if present (globally unique, from MAM)
 * - from + id otherwise (message id is only unique per sender)
 */
function getRoomMessageKeys(m: RoomMessage): string[] {
  const keys: string[] = []
  if (m.stanzaId) {
    keys.push(`stanzaId:${m.stanzaId}`)
  }
  // Always include from+id as a key for messages without stanzaId
  keys.push(`from:${m.from}:id:${m.id}`)
  return keys
}

/**
 * Room state interface for Multi-User Chat (MUC) rooms.
 *
 * Manages group chat rooms, occupants, messages, bookmarks, typing indicators,
 * and notification settings. Room data is ephemeral (not persisted) as it's
 * restored from server bookmarks and MAM on reconnect.
 *
 * @remarks
 * Most applications should use the `useRoom` hook instead of accessing this
 * store directly. The hook provides a cleaner API with memoized actions.
 *
 * @example Direct store access (advanced)
 * ```ts
 * import { useRoomStore } from '@fluux/sdk'
 *
 * // Get all bookmarked rooms
 * const bookmarked = useRoomStore.getState().bookmarkedRooms()
 *
 * // Subscribe to room updates
 * useRoomStore.subscribe(
 *   (state) => state.rooms,
 *   (rooms) => console.log('Rooms updated:', rooms.size)
 * )
 *
 * // Get total unread mentions
 * const mentions = useRoomStore.getState().totalMentionsCount()
 * ```
 *
 * @category Stores
 */
export interface RoomState {
  /** @deprecated Use roomEntities, roomMeta, and roomRuntime for fine-grained subscriptions */
  rooms: Map<string, Room>
  /** Stable room identity - changes on bookmark/join operations */
  roomEntities: Map<string, RoomEntity>
  /** Frequently-changing room state (unread counts, typing, etc.) */
  roomMeta: Map<string, RoomMetadata>
  /** Runtime room data - occupants, messages (rebuilt on join) */
  roomRuntime: Map<string, RoomRuntime>
  activeRoomJid: string | null
  // Easter egg animation state (ephemeral)
  activeAnimation: { roomJid: string; animation: string } | null
  // Message drafts per room (persisted to localStorage separately)
  drafts: Map<string, string>
  // MAM query states per room (for rooms with MAM enabled)
  mamQueryStates: Map<string, MAMQueryState>

  // Actions
  addRoom: (room: Room) => void
  updateRoom: (roomJid: string, update: Partial<Room>) => void
  removeRoom: (roomJid: string) => void
  setRoomJoined: (roomJid: string, joined: boolean) => void
  addOccupant: (roomJid: string, occupant: RoomOccupant) => void
  batchAddOccupants: (roomJid: string, occupants: RoomOccupant[]) => void
  removeOccupant: (roomJid: string, nick: string) => void
  updateOccupantAvatar: (roomJid: string, nick: string, avatar: string | null, avatarHash: string | null) => void
  setSelfOccupant: (roomJid: string, occupant: RoomOccupant) => void
  getRoom: (roomJid: string) => Room | undefined
  reset: () => void

  // Message actions
  addMessage: (roomJid: string, message: RoomMessage, options?: {
    incrementUnread?: boolean
    incrementMentions?: boolean
  }) => void
  updateReactions: (roomJid: string, messageId: string, reactorNick: string, emojis: string[]) => void
  updateMessage: (roomJid: string, messageId: string, updates: Partial<RoomMessage>) => void
  getMessage: (roomJid: string, messageId: string) => RoomMessage | undefined
  markAsRead: (roomJid: string) => void
  setActiveRoom: (roomJid: string | null) => void
  getActiveRoomJid: () => string | null
  clearFirstNewMessageId: (roomJid: string) => void
  updateLastSeenMessageId: (roomJid: string, messageId: string) => void
  setTyping: (roomJid: string, nick: string, isTyping: boolean) => void

  // Bookmark actions
  setBookmark: (roomJid: string, bookmark: { name: string; nick: string; autojoin?: boolean; password?: string; notifyAll?: boolean }) => void
  removeBookmark: (roomJid: string) => void

  // Notification settings
  setNotifyAll: (roomJid: string, notifyAll: boolean, persistent?: boolean) => void

  // Easter egg animations
  triggerAnimation: (roomJid: string, animation: string) => void
  clearAnimation: () => void

  // Draft management
  setDraft: (roomJid: string, text: string) => void
  getDraft: (roomJid: string) => string
  clearDraft: (roomJid: string) => void

  // IndexedDB cache loading
  loadMessagesFromCache: (roomJid: string, options?: GetMessagesOptions) => Promise<RoomMessage[]>
  loadOlderMessagesFromCache: (roomJid: string, limit?: number) => Promise<RoomMessage[]>
  /** Load only the latest message from cache for sidebar preview (doesn't modify messages array) */
  loadPreviewFromCache: (roomJid: string) => Promise<RoomMessage | null>

  // MAM state management (XEP-0313 for MUC rooms)
  setRoomMAMLoading: (roomJid: string, isLoading: boolean) => void
  setRoomMAMError: (roomJid: string, error: string | null) => void
  /**
   * Merge MAM messages into room and update query state.
   * @param roomJid - Room JID
   * @param messages - Messages from MAM query
   * @param rsm - RSM pagination response
   * @param complete - Whether server indicated query is complete
   * @param direction - Query direction: 'backward' for older history, 'forward' for catching up
   */
  mergeRoomMAMMessages: (roomJid: string, messages: RoomMessage[], rsm: RSMResponse, complete: boolean, direction: MAMQueryDirection) => void
  getRoomMAMQueryState: (roomJid: string) => MAMQueryState
  resetRoomMAMStates: () => void
  /** Mark all rooms as needing a catch-up MAM query (called on reconnect) */
  markAllRoomsNeedsCatchUp: () => void
  /** Clear the needsCatchUp flag for a specific room */
  clearRoomNeedsCatchUp: (roomJid: string) => void
  /** Update only the lastMessage preview without affecting message history */
  updateLastMessagePreview: (roomJid: string, lastMessage: RoomMessage) => void

  // Computed
  joinedRooms: () => Room[]
  bookmarkedRooms: () => Room[]
  allRooms: () => Room[] // All rooms (bookmarked or joined)
  quickChatRooms: () => Room[] // All quick chat rooms
  activeRoom: () => Room | undefined
  activeMessages: () => RoomMessage[]
  totalMentionsCount: () => number // Total mentions across all joined rooms
  totalUnreadCount: () => number // Total unread messages across all joined rooms
  totalNotifiableUnreadCount: () => number // Total unread in rooms with notifyAll enabled
  roomsWithUnreadCount: () => number // Number of rooms with unread activity (for dock badge)
}

export const roomStore = createStore<RoomState>()(
  subscribeWithSelector((set, get) => ({
  rooms: new Map(),
  roomEntities: new Map(),
  roomMeta: new Map(),
  roomRuntime: new Map(),
  activeRoomJid: null,
  activeAnimation: null,
  drafts: loadDraftsFromStorage(), // Restore drafts from localStorage
  mamQueryStates: new Map(),

  addRoom: (room) => {
    set((state) => {
      // Split room into entity, metadata, and runtime components
      const entity: RoomEntity = {
        jid: room.jid,
        name: room.name,
        nickname: room.nickname,
        joined: room.joined,
        isJoining: room.isJoining,
        subject: room.subject,
        avatar: room.avatar,
        avatarHash: room.avatarHash,
        avatarFromPresence: room.avatarFromPresence,
        isBookmarked: room.isBookmarked,
        autojoin: room.autojoin,
        password: room.password,
        isQuickChat: room.isQuickChat,
        supportsMAM: room.supportsMAM,
      }
      const meta: RoomMetadata = {
        unreadCount: room.unreadCount,
        mentionsCount: room.mentionsCount,
        typingUsers: room.typingUsers,
        notifyAll: room.notifyAll,
        notifyAllPersistent: room.notifyAllPersistent,
        lastReadAt: room.lastReadAt,
        lastSeenMessageId: room.lastSeenMessageId,
        firstNewMessageId: room.firstNewMessageId,
        lastMessage: room.messages?.length > 0 ? room.messages[room.messages.length - 1] : undefined,
        lastInteractedAt: room.lastInteractedAt,
      }
      const runtime: RoomRuntime = {
        occupants: room.occupants,
        nickToJidCache: room.nickToJidCache,
        selfOccupant: room.selfOccupant,
        messages: room.messages,
      }

      const newRooms = new Map(state.rooms)
      newRooms.set(room.jid, room)

      const newEntities = new Map(state.roomEntities)
      newEntities.set(room.jid, entity)

      const newMeta = new Map(state.roomMeta)
      newMeta.set(room.jid, meta)

      const newRuntime = new Map(state.roomRuntime)
      newRuntime.set(room.jid, runtime)

      return {
        rooms: newRooms,
        roomEntities: newEntities,
        roomMeta: newMeta,
        roomRuntime: newRuntime,
      }
    })
  },

  updateRoom: (roomJid, update) => {
    set((state) => {
      const newRooms = new Map(state.rooms)
      const existing = newRooms.get(roomJid)
      if (!existing) return state

      const updatedRoom = { ...existing, ...update }
      newRooms.set(roomJid, updatedRoom)

      // Update entity fields if any changed
      const entityFields = ['name', 'nickname', 'joined', 'isJoining', 'subject', 'avatar',
        'avatarHash', 'avatarFromPresence', 'isBookmarked', 'autojoin', 'password', 'isQuickChat',
        'supportsMAM'] as const
      const hasEntityUpdate = entityFields.some((f) => f in update)

      // Update metadata fields if any changed
      const metaFields = ['unreadCount', 'mentionsCount', 'typingUsers', 'notifyAll',
        'notifyAllPersistent', 'lastReadAt', 'firstNewMessageId', 'lastInteractedAt'] as const
      const hasMetaUpdate = metaFields.some((f) => f in update)

      // Update runtime fields if any changed
      const runtimeFields = ['occupants', 'nickToJidCache', 'selfOccupant', 'messages'] as const
      const hasRuntimeUpdate = runtimeFields.some((f) => f in update)

      const result: Partial<RoomState> = { rooms: newRooms }

      if (hasEntityUpdate) {
        const newEntities = new Map(state.roomEntities)
        const existingEntity = newEntities.get(roomJid)
        if (existingEntity) {
          newEntities.set(roomJid, {
            jid: updatedRoom.jid,
            name: updatedRoom.name,
            nickname: updatedRoom.nickname,
            joined: updatedRoom.joined,
            isJoining: updatedRoom.isJoining,
            subject: updatedRoom.subject,
            avatar: updatedRoom.avatar,
            avatarHash: updatedRoom.avatarHash,
            avatarFromPresence: updatedRoom.avatarFromPresence,
            isBookmarked: updatedRoom.isBookmarked,
            autojoin: updatedRoom.autojoin,
            password: updatedRoom.password,
            isQuickChat: updatedRoom.isQuickChat,
            supportsMAM: updatedRoom.supportsMAM,
          })
        }
        result.roomEntities = newEntities
      }

      if (hasMetaUpdate) {
        const newMeta = new Map(state.roomMeta)
        const existingMeta = newMeta.get(roomJid)
        if (existingMeta) {
          newMeta.set(roomJid, {
            unreadCount: updatedRoom.unreadCount,
            mentionsCount: updatedRoom.mentionsCount,
            typingUsers: updatedRoom.typingUsers,
            notifyAll: updatedRoom.notifyAll,
            notifyAllPersistent: updatedRoom.notifyAllPersistent,
            lastReadAt: updatedRoom.lastReadAt,
            firstNewMessageId: updatedRoom.firstNewMessageId,
            lastInteractedAt: updatedRoom.lastInteractedAt,
          })
        }
        result.roomMeta = newMeta
      }

      if (hasRuntimeUpdate) {
        const newRuntime = new Map(state.roomRuntime)
        const existingRuntime = newRuntime.get(roomJid)
        if (existingRuntime) {
          newRuntime.set(roomJid, {
            occupants: updatedRoom.occupants,
            nickToJidCache: updatedRoom.nickToJidCache,
            selfOccupant: updatedRoom.selfOccupant,
            messages: updatedRoom.messages,
          })
        }
        result.roomRuntime = newRuntime
      }

      return result
    })
  },

  removeRoom: (roomJid) => {
    // Delete messages from IndexedDB (non-blocking)
    void messageCache.deleteRoomMessages(roomJid)

    set((state) => {
      const newRooms = new Map(state.rooms)
      newRooms.delete(roomJid)

      const newEntities = new Map(state.roomEntities)
      newEntities.delete(roomJid)

      const newMeta = new Map(state.roomMeta)
      newMeta.delete(roomJid)

      const newRuntime = new Map(state.roomRuntime)
      newRuntime.delete(roomJid)

      return {
        rooms: newRooms,
        roomEntities: newEntities,
        roomMeta: newMeta,
        roomRuntime: newRuntime,
      }
    })
  },

  setRoomJoined: (roomJid, joined) => {
    set((state) => {
      const newRooms = new Map(state.rooms)
      const existing = newRooms.get(roomJid)
      if (!existing) return state

      // DON'T set lastInteractedAt on join - only setActiveRoom (user clicking) should set it.
      // MUC history messages arrive before the join confirmation, so existing.messages may
      // contain history whose timestamps don't reflect actual user interaction.
      // Leaving lastInteractedAt undefined lets allRooms() fall back to lastMessage.timestamp
      // (populated by MAM preview), which correctly reflects each room's latest activity.
      const updatedRoom = {
        ...existing,
        joined,
        // Clear isJoining flag when join completes (success or failure)
        isJoining: false,
        // Reset counts and session-only notifyAll when leaving (joined = false)
        unreadCount: joined ? existing.unreadCount : 0,
        mentionsCount: joined ? existing.mentionsCount : 0,
        notifyAll: joined ? existing.notifyAll : undefined,
      }
      newRooms.set(roomJid, updatedRoom)

      // Update entity (joined, isJoining)
      const newEntities = new Map(state.roomEntities)
      const existingEntity = newEntities.get(roomJid)
      if (existingEntity) {
        newEntities.set(roomJid, { ...existingEntity, joined, isJoining: false })
      }

      // Update metadata (unreadCount, mentionsCount, notifyAll)
      const newMeta = new Map(state.roomMeta)
      const existingMeta = newMeta.get(roomJid)
      if (existingMeta) {
        newMeta.set(roomJid, {
          ...existingMeta,
          unreadCount: joined ? existingMeta.unreadCount : 0,
          mentionsCount: joined ? existingMeta.mentionsCount : 0,
          notifyAll: joined ? existingMeta.notifyAll : undefined,
        })
      }

      return { rooms: newRooms, roomEntities: newEntities, roomMeta: newMeta }
    })
  },

  addOccupant: (roomJid, occupant) => {
    set((state) => {
      const newRooms = new Map(state.rooms)
      const existing = newRooms.get(roomJid)
      if (!existing) return state

      const newOccupants = new Map(existing.occupants)
      newOccupants.set(occupant.nick, occupant)

      // Update nick→jid cache for non-anonymous rooms (when real JID is visible)
      let nickToJidCache = existing.nickToJidCache
      if (occupant.jid) {
        nickToJidCache = new Map(nickToJidCache || [])
        nickToJidCache.set(occupant.nick, getBareJid(occupant.jid))
      }

      // Update nick→avatar cache if occupant has avatar
      let nickToAvatarCache = existing.nickToAvatarCache
      if (occupant.avatar) {
        nickToAvatarCache = new Map(nickToAvatarCache || [])
        nickToAvatarCache.set(occupant.nick, occupant.avatar)
      }

      newRooms.set(roomJid, { ...existing, occupants: newOccupants, nickToJidCache, nickToAvatarCache })

      // Update runtime
      const newRuntime = new Map(state.roomRuntime)
      const existingRuntime = newRuntime.get(roomJid)
      if (existingRuntime) {
        newRuntime.set(roomJid, { ...existingRuntime, occupants: newOccupants, nickToJidCache, nickToAvatarCache })
      }

      return { rooms: newRooms, roomRuntime: newRuntime }
    })
  },

  batchAddOccupants: (roomJid, occupants) => {
    if (occupants.length === 0) return

    set((state) => {
      const newRooms = new Map(state.rooms)
      const existing = newRooms.get(roomJid)
      if (!existing) return state

      const newOccupants = new Map(existing.occupants)
      let nickToJidCache = existing.nickToJidCache
      let nickToAvatarCache = existing.nickToAvatarCache

      // Add all occupants in a single update
      for (const occupant of occupants) {
        newOccupants.set(occupant.nick, occupant)

        // Update nick→jid cache for non-anonymous rooms
        if (occupant.jid) {
          if (!nickToJidCache || nickToJidCache === existing.nickToJidCache) {
            nickToJidCache = new Map(nickToJidCache || [])
          }
          nickToJidCache.set(occupant.nick, getBareJid(occupant.jid))
        }

        // Update nick→avatar cache
        if (occupant.avatar) {
          if (!nickToAvatarCache || nickToAvatarCache === existing.nickToAvatarCache) {
            nickToAvatarCache = new Map(nickToAvatarCache || [])
          }
          nickToAvatarCache.set(occupant.nick, occupant.avatar)
        }
      }

      newRooms.set(roomJid, { ...existing, occupants: newOccupants, nickToJidCache, nickToAvatarCache })

      // Update runtime
      const newRuntime = new Map(state.roomRuntime)
      const existingRuntime = newRuntime.get(roomJid)
      if (existingRuntime) {
        newRuntime.set(roomJid, { ...existingRuntime, occupants: newOccupants, nickToJidCache, nickToAvatarCache })
      }

      return { rooms: newRooms, roomRuntime: newRuntime }
    })
  },

  removeOccupant: (roomJid, nick) => {
    set((state) => {
      const newRooms = new Map(state.rooms)
      const existing = newRooms.get(roomJid)
      if (!existing) return state

      const newOccupants = new Map(existing.occupants)
      newOccupants.delete(nick)
      // Also remove from typing users when they leave
      const newTypingUsers = new Set(existing.typingUsers)
      newTypingUsers.delete(nick)
      newRooms.set(roomJid, { ...existing, occupants: newOccupants, typingUsers: newTypingUsers })

      // Update runtime (occupants)
      const newRuntime = new Map(state.roomRuntime)
      const existingRuntime = newRuntime.get(roomJid)
      if (existingRuntime) {
        newRuntime.set(roomJid, { ...existingRuntime, occupants: newOccupants })
      }

      // Update metadata (typingUsers)
      const newMeta = new Map(state.roomMeta)
      const existingMeta = newMeta.get(roomJid)
      if (existingMeta) {
        newMeta.set(roomJid, { ...existingMeta, typingUsers: newTypingUsers })
      }

      return { rooms: newRooms, roomRuntime: newRuntime, roomMeta: newMeta }
    })
  },

  updateOccupantAvatar: (roomJid, nick, avatar, avatarHash) => {
    set((state) => {
      const newRooms = new Map(state.rooms)
      const existing = newRooms.get(roomJid)
      if (!existing) return state

      const existingOccupant = existing.occupants.get(nick)
      if (!existingOccupant) return state

      const newOccupants = new Map(existing.occupants)
      newOccupants.set(nick, {
        ...existingOccupant,
        avatar: avatar ?? undefined,
        avatarHash: avatarHash ?? undefined,
      })

      // Update nick→avatar cache so avatar persists after occupant leaves
      let nickToAvatarCache = existing.nickToAvatarCache
      if (avatar) {
        nickToAvatarCache = new Map(nickToAvatarCache || [])
        nickToAvatarCache.set(nick, avatar)
      }

      newRooms.set(roomJid, { ...existing, occupants: newOccupants, nickToAvatarCache })

      // Update runtime (occupants + avatar cache)
      const newRuntime = new Map(state.roomRuntime)
      const existingRuntime = newRuntime.get(roomJid)
      if (existingRuntime) {
        newRuntime.set(roomJid, { ...existingRuntime, occupants: newOccupants, nickToAvatarCache })
      }

      return { rooms: newRooms, roomRuntime: newRuntime }
    })
  },

  setSelfOccupant: (roomJid, occupant) => {
    set((state) => {
      const newRooms = new Map(state.rooms)
      const existing = newRooms.get(roomJid)
      if (!existing) return state

      // Update nickname with server-reflected value to ensure message comparison works
      // The server may normalize the nickname (e.g., case changes), so we use what it sends back
      newRooms.set(roomJid, { ...existing, selfOccupant: occupant, nickname: occupant.nick })

      // Update entities (includes nickname)
      const newEntities = new Map(state.roomEntities)
      const existingEntity = newEntities.get(roomJid)
      if (existingEntity) {
        newEntities.set(roomJid, { ...existingEntity, nickname: occupant.nick })
      }

      // Update runtime
      const newRuntime = new Map(state.roomRuntime)
      const existingRuntime = newRuntime.get(roomJid)
      if (existingRuntime) {
        newRuntime.set(roomJid, { ...existingRuntime, selfOccupant: occupant })
      }

      return { rooms: newRooms, roomEntities: newEntities, roomRuntime: newRuntime }
    })
  },

  getRoom: (roomJid) => get().rooms.get(roomJid),

  reset: () => {
    // Note: We don't clear IndexedDB on reset - room messages are valuable cache
    // They will be cleared when rooms are explicitly removed or user logs out
    // (The connection store's reset handles full logout cleanup via clearAllMessages)
    // Clear persisted room drafts on logout
    localStorage.removeItem(ROOM_DRAFTS_STORAGE_KEY)
    set({
      rooms: new Map(),
      roomEntities: new Map(),
      roomMeta: new Map(),
      roomRuntime: new Map(),
      activeRoomJid: null,
      drafts: new Map(),
      mamQueryStates: new Map(),
    })
  },

  // Message actions
  addMessage: (roomJid, message, options = {}) => {
    const { incrementUnread = true, incrementMentions = false } = options

    // Get room to check if it's a Quick Chat (transient history)
    const room = get().rooms.get(roomJid)

    // XEP-0334: Set noStore hint for Quick Chat room messages
    const messageToAdd = room?.isQuickChat
      ? { ...message, noStore: true }
      : message

    // Save to IndexedDB only if message doesn't have noStore hint
    if (!messageToAdd.noStore) {
      void messageCache.saveRoomMessage(messageToAdd)
    }

    set((state) => {
      const newRooms = new Map(state.rooms)
      const existing = newRooms.get(roomJid)
      if (!existing) return state

      // XEP-0359: Deduplicate messages using shared utility
      const existingKeys = buildMessageKeySet(existing.messages, getRoomMessageKeys)
      if (isMessageDuplicate(messageToAdd, existingKeys, getRoomMessageKeys)) {
        return state // Don't add duplicate message
      }

      // Add message and trim to max count (older ones remain in IndexedDB)
      const newMessages = trimMessages([...existing.messages, messageToAdd], MAX_MESSAGES_PER_ROOM)

      // Delegate notification state to pure function
      const isActive = state.activeRoomJid === roomJid
      const windowVisible = connectionStore.getState().windowVisible
      const existingMeta = state.roomMeta.get(roomJid)

      const notifInput: notifState.EntityNotificationState = {
        unreadCount: existingMeta?.unreadCount ?? existing.unreadCount,
        mentionsCount: existingMeta?.mentionsCount ?? existing.mentionsCount,
        lastReadAt: existingMeta?.lastReadAt ?? existing.lastReadAt,
        lastSeenMessageId: existingMeta?.lastSeenMessageId ?? existing.lastSeenMessageId,
        firstNewMessageId: existingMeta?.firstNewMessageId ?? existing.firstNewMessageId,
      }

      const updated = notifState.onMessageReceived(
        notifInput,
        {
          id: messageToAdd.id,
          timestamp: messageToAdd.timestamp,
          isOutgoing: messageToAdd.isOutgoing ?? false,
          isDelayed: messageToAdd.isDelayed,
          isMention: messageToAdd.isMention,
        },
        { isActive, windowVisible },
        { incrementUnread, incrementMentions }
      )

      // Get the last message for both the combined room and metadata
      const lastMessage = newMessages[newMessages.length - 1]

      newRooms.set(roomJid, {
        ...existing,
        messages: newMessages,
        unreadCount: updated.unreadCount,
        mentionsCount: updated.mentionsCount,
        lastReadAt: updated.lastReadAt,
        firstNewMessageId: updated.firstNewMessageId,
        lastMessage,
      })

      // Update runtime (messages)
      const newRuntime = new Map(state.roomRuntime)
      const existingRuntime = newRuntime.get(roomJid)
      if (existingRuntime) {
        newRuntime.set(roomJid, { ...existingRuntime, messages: newMessages })
      }

      // Update metadata
      const newMeta = new Map(state.roomMeta)
      if (existingMeta) {
        newMeta.set(roomJid, {
          ...existingMeta,
          unreadCount: updated.unreadCount,
          mentionsCount: updated.mentionsCount,
          lastReadAt: updated.lastReadAt,
          firstNewMessageId: updated.firstNewMessageId,
          lastMessage,
        })
      }

      return { rooms: newRooms, roomRuntime: newRuntime, roomMeta: newMeta }
    })
  },

  updateReactions: (roomJid, messageId, reactorNick, emojis) => {
    set((state) => {
      const newRooms = new Map(state.rooms)
      const existing = newRooms.get(roomJid)
      if (!existing) return state

      let updatedMessage: RoomMessage | undefined
      const newMessages = existing.messages.map((msg) => {
        if (msg.id !== messageId) return msg

        // Build new reactions map
        const newReactions: Record<string, string[]> = {}

        // Copy existing reactions, removing this reactor from all
        if (msg.reactions) {
          for (const [emoji, reactors] of Object.entries(msg.reactions)) {
            const filtered = reactors.filter((nick) => nick !== reactorNick)
            if (filtered.length > 0) {
              newReactions[emoji] = filtered
            }
          }
        }

        // Add reactor to new emojis
        for (const emoji of emojis) {
          if (!newReactions[emoji]) {
            newReactions[emoji] = []
          }
          newReactions[emoji].push(reactorNick)
        }

        updatedMessage = {
          ...msg,
          reactions: Object.keys(newReactions).length > 0 ? newReactions : undefined,
        }
        return updatedMessage
      })

      // Update IndexedDB (non-blocking)
      if (updatedMessage) {
        void messageCache.updateRoomMessage(messageId, {
          reactions: updatedMessage.reactions,
        })
      }

      newRooms.set(roomJid, { ...existing, messages: newMessages })

      // Update runtime
      const newRuntime = new Map(state.roomRuntime)
      const existingRuntime = newRuntime.get(roomJid)
      if (existingRuntime) {
        newRuntime.set(roomJid, { ...existingRuntime, messages: newMessages })
      }

      return { rooms: newRooms, roomRuntime: newRuntime }
    })
  },

  updateMessage: (roomJid, messageId, updates) => {
    // Update IndexedDB (non-blocking)
    void messageCache.updateRoomMessage(messageId, updates)

    set((state) => {
      const newRooms = new Map(state.rooms)
      const existing = newRooms.get(roomJid)
      if (!existing) return state

      const newMessages = existing.messages.map((msg) => {
        if (msg.id !== messageId) return msg
        return { ...msg, ...updates }
      })

      newRooms.set(roomJid, { ...existing, messages: newMessages })

      // Update runtime
      const newRuntime = new Map(state.roomRuntime)
      const existingRuntime = newRuntime.get(roomJid)
      if (existingRuntime) {
        newRuntime.set(roomJid, { ...existingRuntime, messages: newMessages })
      }

      // Update metadata's lastMessage if the updated message is the last one
      const lastMessage = newMessages[newMessages.length - 1]
      const result: Partial<RoomState> = { rooms: newRooms, roomRuntime: newRuntime }
      if (lastMessage?.id === messageId) {
        const newMeta = new Map(state.roomMeta)
        const existingMeta = newMeta.get(roomJid)
        if (existingMeta) {
          newMeta.set(roomJid, { ...existingMeta, lastMessage })
          result.roomMeta = newMeta
        }
      }

      return result
    })
  },

  getMessage: (roomJid, messageId) => {
    const room = get().rooms.get(roomJid)
    if (!room) return undefined
    return findMessageById(room.messages, messageId)
  },

  markAsRead: (roomJid) => {
    set((state) => {
      const existing = state.rooms.get(roomJid)
      if (!existing) return {}

      const meta = state.roomMeta.get(roomJid)
      const notifInput: notifState.EntityNotificationState = {
        unreadCount: meta?.unreadCount ?? existing.unreadCount,
        mentionsCount: meta?.mentionsCount ?? existing.mentionsCount,
        lastReadAt: meta?.lastReadAt ?? existing.lastReadAt,
        lastSeenMessageId: meta?.lastSeenMessageId ?? existing.lastSeenMessageId,
        firstNewMessageId: meta?.firstNewMessageId ?? existing.firstNewMessageId,
      }

      const runtime = state.roomRuntime.get(roomJid)
      const messages = runtime?.messages ?? existing.messages
      const lastMessage = messages[messages.length - 1]
      const lastMessageTimestamp = lastMessage?.timestamp

      const updated = notifState.onMarkAsRead(notifInput, lastMessageTimestamp)

      // Skip update if no change
      if (updated === notifInput) return {}

      const newRooms = new Map(state.rooms)
      newRooms.set(roomJid, { ...existing, unreadCount: updated.unreadCount, mentionsCount: updated.mentionsCount, lastReadAt: updated.lastReadAt })

      const newMeta = new Map(state.roomMeta)
      const newMetaEntry = {
        ...(meta ?? { unreadCount: 0, mentionsCount: 0, typingUsers: new Set<string>() }),
        unreadCount: updated.unreadCount,
        mentionsCount: updated.mentionsCount,
        lastReadAt: updated.lastReadAt,
      }
      newMeta.set(roomJid, newMetaEntry)

      return { rooms: newRooms, roomMeta: newMeta }
    })
  },

  setActiveRoom: (roomJid) => {
    // Deactivate previous room (clears marker)
    const prevJid = get().activeRoomJid
    if (prevJid && prevJid !== roomJid) {
      const prevMeta = get().roomMeta.get(prevJid)
      if (prevMeta?.firstNewMessageId) {
        const deactivated = notifState.onDeactivate({
          unreadCount: prevMeta.unreadCount,
          mentionsCount: prevMeta.mentionsCount,
          lastReadAt: prevMeta.lastReadAt,
          lastSeenMessageId: prevMeta.lastSeenMessageId,
          firstNewMessageId: prevMeta.firstNewMessageId,
        })
        set((state) => {
          const newMeta = new Map(state.roomMeta)
          newMeta.set(prevJid, { ...prevMeta, firstNewMessageId: deactivated.firstNewMessageId })
          const newRooms = new Map(state.rooms)
          const prevRoom = newRooms.get(prevJid)
          if (prevRoom) {
            newRooms.set(prevJid, { ...prevRoom, firstNewMessageId: deactivated.firstNewMessageId })
          }
          return { roomMeta: newMeta, rooms: newRooms }
        })
      }
    }

    if (roomJid) {
      const room = get().rooms.get(roomJid)
      if (room) {
        const meta = get().roomMeta.get(roomJid)
        const notifInput: notifState.EntityNotificationState = {
          unreadCount: meta?.unreadCount ?? room.unreadCount,
          mentionsCount: meta?.mentionsCount ?? room.mentionsCount,
          lastReadAt: meta?.lastReadAt ?? room.lastReadAt,
          lastSeenMessageId: meta?.lastSeenMessageId ?? room.lastSeenMessageId,
          firstNewMessageId: meta?.firstNewMessageId ?? room.firstNewMessageId,
        }

        const runtime = get().roomRuntime.get(roomJid)
        const messages = runtime?.messages ?? room.messages
        const activated = notifState.onActivate(notifInput, messages)

        // Determine lastInteractedAt for sidebar sorting
        const lastMessage = room.messages?.[room.messages.length - 1]
        const lastMessageTimestamp = room.lastMessage?.timestamp ?? lastMessage?.timestamp
        const newLastInteractedAt = lastMessageTimestamp ?? room.lastInteractedAt

        set((state) => {
          const newMetaEntry = {
            ...(meta ?? { unreadCount: 0, mentionsCount: 0, typingUsers: new Set<string>() }),
            unreadCount: activated.unreadCount,
            mentionsCount: activated.mentionsCount,
            lastReadAt: activated.lastReadAt,
            lastSeenMessageId: activated.lastSeenMessageId,
            firstNewMessageId: activated.firstNewMessageId,
            lastInteractedAt: newLastInteractedAt,
          }
          const newMeta = new Map(state.roomMeta)
          newMeta.set(roomJid, newMetaEntry)
          const newRooms = new Map(state.rooms)
          newRooms.set(roomJid, {
            ...room,
            unreadCount: activated.unreadCount,
            mentionsCount: activated.mentionsCount,
            lastReadAt: activated.lastReadAt,
            lastSeenMessageId: activated.lastSeenMessageId,
            firstNewMessageId: activated.firstNewMessageId,
            lastInteractedAt: newLastInteractedAt,
          })
          return { roomMeta: newMeta, rooms: newRooms, activeRoomJid: roomJid }
        })
        return
      }
    }
    // Clearing active room or room not found
    set({ activeRoomJid: roomJid })
  },

  getActiveRoomJid: () => get().activeRoomJid,

  clearFirstNewMessageId: (roomJid) => {
    set((state) => {
      const existing = state.rooms.get(roomJid)
      const meta = state.roomMeta.get(roomJid)
      const hasFirstNewMessage = meta?.firstNewMessageId ?? existing?.firstNewMessageId
      if (!existing || !hasFirstNewMessage) return state

      const notifInput: notifState.EntityNotificationState = {
        unreadCount: meta?.unreadCount ?? existing.unreadCount,
        mentionsCount: meta?.mentionsCount ?? existing.mentionsCount,
        lastReadAt: meta?.lastReadAt ?? existing.lastReadAt,
        lastSeenMessageId: meta?.lastSeenMessageId ?? existing.lastSeenMessageId,
        firstNewMessageId: meta?.firstNewMessageId ?? existing.firstNewMessageId,
      }
      const cleared = notifState.onClearMarker(notifInput)

      const newRooms = new Map(state.rooms)
      newRooms.set(roomJid, { ...existing, firstNewMessageId: cleared.firstNewMessageId })

      const newMeta = new Map(state.roomMeta)
      if (meta) {
        newMeta.set(roomJid, { ...meta, firstNewMessageId: cleared.firstNewMessageId })
      }

      return { rooms: newRooms, roomMeta: newMeta }
    })
  },

  updateLastSeenMessageId: (roomJid, messageId) => {
    set((state) => {
      const existing = state.rooms.get(roomJid)
      const meta = state.roomMeta.get(roomJid)
      if (!existing) return state

      const runtime = state.roomRuntime.get(roomJid)
      const messages = runtime?.messages ?? existing.messages

      const notifInput: notifState.EntityNotificationState = {
        unreadCount: meta?.unreadCount ?? existing.unreadCount,
        mentionsCount: meta?.mentionsCount ?? existing.mentionsCount,
        lastReadAt: meta?.lastReadAt ?? existing.lastReadAt,
        lastSeenMessageId: meta?.lastSeenMessageId ?? existing.lastSeenMessageId,
        firstNewMessageId: meta?.firstNewMessageId ?? existing.firstNewMessageId,
      }
      const updated = notifState.onMessageSeen(notifInput, messageId, messages)
      if (updated === notifInput) return state

      const newRooms = new Map(state.rooms)
      newRooms.set(roomJid, { ...existing, lastSeenMessageId: updated.lastSeenMessageId })

      const newMeta = new Map(state.roomMeta)
      if (meta) {
        newMeta.set(roomJid, { ...meta, lastSeenMessageId: updated.lastSeenMessageId })
      }

      return { rooms: newRooms, roomMeta: newMeta }
    })
  },

  setTyping: (roomJid, nick, isTyping) => {
    if (isTyping) {
      // Set auto-clear timeout in case "paused" is missed
      setTypingTimeout(roomJid, nick, () => {
        // Auto-clear this user's typing state after timeout
        get().setTyping(roomJid, nick, false)
      })
    } else {
      // Clear the timeout when explicitly stopping
      clearTypingTimeout(roomJid, nick)
    }

    set((state) => {
      const newRooms = new Map(state.rooms)
      const existing = newRooms.get(roomJid)
      if (!existing) return state

      const newTypingUsers = new Set(existing.typingUsers)
      if (isTyping) {
        newTypingUsers.add(nick)
      } else {
        newTypingUsers.delete(nick)
      }
      newRooms.set(roomJid, { ...existing, typingUsers: newTypingUsers })

      // Update metadata
      const newMeta = new Map(state.roomMeta)
      const existingMeta = newMeta.get(roomJid)
      if (existingMeta) {
        newMeta.set(roomJid, { ...existingMeta, typingUsers: newTypingUsers })
      }

      return { rooms: newRooms, roomMeta: newMeta }
    })
  },

  // Bookmark actions
  setBookmark: (roomJid, bookmark) => {
    set((state) => {
      const newRooms = new Map(state.rooms)
      const newEntities = new Map(state.roomEntities)
      const newMeta = new Map(state.roomMeta)
      const newRuntime = new Map(state.roomRuntime)

      const existing = newRooms.get(roomJid)
      if (existing) {
        // Update existing room with bookmark info
        const updatedRoom = {
          ...existing,
          name: bookmark.name || existing.name,
          nickname: bookmark.nick || existing.nickname,
          isBookmarked: true,
          autojoin: bookmark.autojoin,
          password: bookmark.password,
          notifyAllPersistent: bookmark.notifyAll,
        }
        newRooms.set(roomJid, updatedRoom)

        // Update entity
        const existingEntity = newEntities.get(roomJid)
        if (existingEntity) {
          newEntities.set(roomJid, {
            ...existingEntity,
            name: bookmark.name || existingEntity.name,
            nickname: bookmark.nick || existingEntity.nickname,
            isBookmarked: true,
            autojoin: bookmark.autojoin,
            password: bookmark.password,
          })
        }

        // Update metadata (notifyAllPersistent)
        const existingMeta = newMeta.get(roomJid)
        if (existingMeta) {
          newMeta.set(roomJid, { ...existingMeta, notifyAllPersistent: bookmark.notifyAll })
        }
      } else {
        // Create a new room entry from bookmark
        const newRoom: Room = {
          jid: roomJid,
          name: bookmark.name,
          nickname: bookmark.nick,
          joined: false,
          isBookmarked: true,
          autojoin: bookmark.autojoin,
          password: bookmark.password,
          notifyAllPersistent: bookmark.notifyAll,
          occupants: new Map(),
          messages: [],
          unreadCount: 0,
          mentionsCount: 0,
          typingUsers: new Set(),
        }
        newRooms.set(roomJid, newRoom)

        // Create entity
        newEntities.set(roomJid, {
          jid: roomJid,
          name: bookmark.name,
          nickname: bookmark.nick,
          joined: false,
          isBookmarked: true,
          autojoin: bookmark.autojoin,
          password: bookmark.password,
        })

        // Create metadata
        newMeta.set(roomJid, {
          unreadCount: 0,
          mentionsCount: 0,
          typingUsers: new Set(),
          notifyAllPersistent: bookmark.notifyAll,
        })

        // Create runtime
        newRuntime.set(roomJid, {
          occupants: new Map(),
          messages: [],
        })
      }
      return { rooms: newRooms, roomEntities: newEntities, roomMeta: newMeta, roomRuntime: newRuntime }
    })
  },

  removeBookmark: (roomJid) => {
    set((state) => {
      const newRooms = new Map(state.rooms)
      const newEntities = new Map(state.roomEntities)
      const newMeta = new Map(state.roomMeta)
      const newRuntime = new Map(state.roomRuntime)

      const existing = newRooms.get(roomJid)
      if (existing) {
        if (existing.joined) {
          // Room is joined, just remove bookmark flag and persistent notify setting
          newRooms.set(roomJid, {
            ...existing,
            isBookmarked: false,
            autojoin: undefined,
            password: undefined,
            notifyAllPersistent: undefined,
          })

          // Update entity
          const existingEntity = newEntities.get(roomJid)
          if (existingEntity) {
            newEntities.set(roomJid, {
              ...existingEntity,
              isBookmarked: false,
              autojoin: undefined,
              password: undefined,
            })
          }

          // Update metadata
          const existingMeta = newMeta.get(roomJid)
          if (existingMeta) {
            newMeta.set(roomJid, { ...existingMeta, notifyAllPersistent: undefined })
          }
        } else {
          // Room not joined and no longer bookmarked, remove it
          newRooms.delete(roomJid)
          newEntities.delete(roomJid)
          newMeta.delete(roomJid)
          newRuntime.delete(roomJid)
        }
      }
      return { rooms: newRooms, roomEntities: newEntities, roomMeta: newMeta, roomRuntime: newRuntime }
    })
  },

  // Notification settings
  setNotifyAll: (roomJid, notifyAll, persistent = false) => {
    set((state) => {
      const newRooms = new Map(state.rooms)
      const existing = newRooms.get(roomJid)
      if (!existing) return state

      newRooms.set(roomJid, {
        ...existing,
        notifyAll: persistent ? undefined : notifyAll, // Session-only if not persistent
        notifyAllPersistent: persistent ? notifyAll : existing.notifyAllPersistent,
      })

      // Update metadata
      const newMeta = new Map(state.roomMeta)
      const existingMeta = newMeta.get(roomJid)
      if (existingMeta) {
        newMeta.set(roomJid, {
          ...existingMeta,
          notifyAll: persistent ? undefined : notifyAll,
          notifyAllPersistent: persistent ? notifyAll : existingMeta.notifyAllPersistent,
        })
      }

      return { rooms: newRooms, roomMeta: newMeta }
    })
  },

  // Easter egg animations
  triggerAnimation: (roomJid, animation) => {
    set({ activeAnimation: { roomJid, animation } })
  },

  clearAnimation: () => {
    set({ activeAnimation: null })
  },

  // Draft management (persisted to localStorage)
  setDraft: (roomJid, text) => {
    set((state) => {
      const newDrafts = draftState.setDraft(state.drafts, roomJid, text)
      saveDraftsToStorage(newDrafts)
      return { drafts: newDrafts }
    })
  },

  getDraft: (roomJid) => {
    return draftState.getDraft(get().drafts, roomJid)
  },

  clearDraft: (roomJid) => {
    set((state) => {
      const newDrafts = draftState.clearDraft(state.drafts, roomJid)
      saveDraftsToStorage(newDrafts)
      return { drafts: newDrafts }
    })
  },

  // IndexedDB cache loading
  // For initial load (no 'before'), loads the LATEST 100 messages to show most recent first
  loadMessagesFromCache: async (roomJid, options = {}) => {
    if (!messageCache.isMessageCacheAvailable()) {
      return []
    }

    try {
      // Default to 100 messages and latest=true for initial load
      const queryOptions = {
        limit: options.limit ?? 100,
        before: options.before,
        after: options.after,
        // When loading without 'before', get the latest messages (most recent)
        latest: !options.before,
      }
      const cachedMessages = await messageCache.getRoomMessages(roomJid, queryOptions)
      if (cachedMessages.length > 0) {
        // Merge with existing messages in memory using shared utilities
        set((state) => {
          const newRooms = new Map(state.rooms)
          const existing = newRooms.get(roomJid)
          if (!existing) return state

          // Build key set from in-memory messages (they take precedence)
          const existingKeys = buildMessageKeySet(existing.messages, getRoomMessageKeys)

          // Filter out duplicates from cached messages
          const newFromCache = cachedMessages.filter(
            (msg) => !isMessageDuplicate(msg, existingKeys, getRoomMessageKeys)
          )

          // Merge, sort, and trim using shared utilities
          const combined = [...newFromCache, ...existing.messages]
          const sorted = sortMessagesByTimestamp(combined)
          const merged = trimMessages(sorted, MAX_MESSAGES_PER_ROOM)

          // Get lastMessage from merged messages for sidebar preview
          const lastMessage = merged.length > 0 ? merged[merged.length - 1] : existing.lastMessage

          newRooms.set(roomJid, { ...existing, messages: merged, lastMessage })

          // Update runtime
          const newRuntime = new Map(state.roomRuntime)
          const existingRuntime = newRuntime.get(roomJid)
          if (existingRuntime) {
            newRuntime.set(roomJid, { ...existingRuntime, messages: merged })
          }

          // Update metadata with lastMessage for sidebar
          const newMeta = new Map(state.roomMeta)
          const existingMeta = newMeta.get(roomJid)
          if (existingMeta) {
            newMeta.set(roomJid, { ...existingMeta, lastMessage })
          }

          return { rooms: newRooms, roomRuntime: newRuntime, roomMeta: newMeta }
        })
      }
      return cachedMessages
    } catch (error) {
      console.error('Failed to load room messages from IndexedDB:', error)
      return []
    }
  },

  loadOlderMessagesFromCache: async (roomJid, limit = 50) => {
    if (!messageCache.isMessageCacheAvailable()) {
      return []
    }

    try {
      const room = get().rooms.get(roomJid)
      if (!room || room.messages.length === 0) {
        return []
      }

      // Get the oldest message timestamp we have in memory
      const oldestInMemory = room.messages[0]
      const beforeDate = oldestInMemory.timestamp

      // Load older messages from IndexedDB
      const cachedMessages = await messageCache.getRoomMessages(roomJid, {
        before: beforeDate,
        limit,
      })

      if (cachedMessages.length > 0) {
        // Prepend to existing messages using shared utilities
        set((state) => {
          const newRooms = new Map(state.rooms)
          const existing = newRooms.get(roomJid)
          if (!existing) return state

          // Build key set from in-memory messages (they take precedence)
          const existingKeys = buildMessageKeySet(existing.messages, getRoomMessageKeys)

          // Filter out duplicates from cached messages
          const newFromCache = cachedMessages.filter(
            (msg) => !isMessageDuplicate(msg, existingKeys, getRoomMessageKeys)
          )

          // Merge, sort, and trim using shared utilities
          const combined = [...newFromCache, ...existing.messages]
          const sorted = sortMessagesByTimestamp(combined)
          const merged = trimMessages(sorted, MAX_MESSAGES_PER_ROOM)

          newRooms.set(roomJid, { ...existing, messages: merged })

          // Update runtime
          const newRuntime = new Map(state.roomRuntime)
          const existingRuntime = newRuntime.get(roomJid)
          if (existingRuntime) {
            newRuntime.set(roomJid, { ...existingRuntime, messages: merged })
          }

          return { rooms: newRooms, roomRuntime: newRuntime }
        })
      }

      return cachedMessages
    } catch (error) {
      console.error('Failed to load older room messages from IndexedDB:', error)
      return []
    }
  },

  // Load only the latest message from cache for sidebar preview
  // This doesn't modify the messages array - it only updates lastMessage
  loadPreviewFromCache: async (roomJid) => {
    if (!messageCache.isMessageCacheAvailable()) {
      return null
    }

    // Check if room exists first - no point querying cache for non-existent rooms
    const room = get().rooms.get(roomJid)
    if (!room) {
      return null
    }

    try {
      // Query for just the latest message
      const cachedMessages = await messageCache.getRoomMessages(roomJid, {
        limit: 1,
        latest: true,
      })

      if (cachedMessages.length > 0) {
        const latestMessage = cachedMessages[0]

        // Update only lastMessage in metadata and combined room
        set((state) => {
          const room = state.rooms.get(roomJid)
          const meta = state.roomMeta.get(roomJid)
          if (!room || !meta) return state

          // Only update if we don't already have a lastMessage or if cached is newer
          if (!shouldUpdateLastMessage(meta.lastMessage, latestMessage)) return state

          const newMeta = new Map(state.roomMeta)
          newMeta.set(roomJid, { ...meta, lastMessage: latestMessage })

          const newRooms = new Map(state.rooms)
          newRooms.set(roomJid, { ...room, lastMessage: latestMessage })

          return { roomMeta: newMeta, rooms: newRooms }
        })

        return latestMessage
      }

      return null
    } catch (error) {
      console.error('Failed to load room preview from IndexedDB:', error)
      return null
    }
  },

  // MAM state management (XEP-0313 for MUC rooms)
  setRoomMAMLoading: (roomJid, isLoading) => {
    set((state) => ({
      mamQueryStates: mamState.setMAMLoading(state.mamQueryStates, roomJid, isLoading),
    }))
  },

  setRoomMAMError: (roomJid, error) => {
    set((state) => ({
      mamQueryStates: mamState.setMAMError(state.mamQueryStates, roomJid, error),
    }))
  },

  mergeRoomMAMMessages: (roomJid, mamMessages, rsm, complete, direction) => {
    set((state) => {
      const room = state.rooms.get(roomJid)
      if (!room) return state

      // Get existing messages for this room
      const existingMessages = room.messages || []

      // Choose merge strategy based on direction:
      // - Backward (scroll up for older): optimized prepend avoids full re-sort
      // - Forward (catching up with newer): requires full sort since messages are newer
      const { merged, newMessages: newFromMAM } =
        direction === 'backward'
          ? prependOlderMessages(
              existingMessages,
              mamMessages,
              getRoomMessageKeys,
              MAX_MESSAGES_PER_ROOM
            )
          : mergeAndProcessMessages(
              existingMessages,
              mamMessages,
              getRoomMessageKeys,
              MAX_MESSAGES_PER_ROOM
            )

      // Update MAM query state using the two-marker approach
      // This must always be updated to track query completion and cursors
      const newStates = mamState.setMAMQueryCompleted(
        state.mamQueryStates,
        roomJid,
        complete,
        direction,
        rsm.first // Pagination cursor for fetching older messages
      )

      // If no new messages (all duplicates), only update MAM state - skip room messages
      // This prevents unnecessary re-renders when merging duplicates
      if (newFromMAM.length === 0) {
        return { mamQueryStates: newStates }
      }

      // XEP-0334: Save only messages without noStore hint to IndexedDB
      const persistableMessages = newFromMAM.filter(msg => !msg.noStore)
      if (persistableMessages.length > 0) {
        void messageCache.saveRoomMessages(persistableMessages)
      }

      // Get the last message from merged messages for sidebar preview
      const lastMessage = merged.length > 0 ? merged[merged.length - 1] : room.lastMessage

      // Update room messages (only when we have new messages)
      const newRooms = new Map(state.rooms)
      newRooms.set(roomJid, { ...room, messages: merged, lastMessage })

      // Update runtime
      const newRuntime = new Map(state.roomRuntime)
      const existingRuntime = newRuntime.get(roomJid)
      if (existingRuntime) {
        newRuntime.set(roomJid, { ...existingRuntime, messages: merged })
      }

      // Update metadata with lastMessage for sidebar
      const newMeta = new Map(state.roomMeta)
      const existingMeta = newMeta.get(roomJid)
      if (existingMeta) {
        newMeta.set(roomJid, { ...existingMeta, lastMessage })
      }

      return { rooms: newRooms, roomRuntime: newRuntime, roomMeta: newMeta, mamQueryStates: newStates }
    })
  },

  getRoomMAMQueryState: (roomJid) => {
    return mamState.getMAMQueryState(get().mamQueryStates, roomJid)
  },

  resetRoomMAMStates: () => {
    set({ mamQueryStates: new Map() })
  },

  markAllRoomsNeedsCatchUp: () => {
    set((state) => ({
      mamQueryStates: mamState.markAllNeedsCatchUp(state.mamQueryStates),
    }))
  },

  clearRoomNeedsCatchUp: (roomJid) => {
    set((state) => ({
      mamQueryStates: mamState.clearNeedsCatchUp(state.mamQueryStates, roomJid),
    }))
  },

  /**
   * Update only the lastMessage preview for a room without affecting message history.
   * Used by MAM preview refresh to update sidebar displays.
   */
  updateLastMessagePreview: (roomJid, lastMessage) => {
    set((state) => {
      const room = state.rooms.get(roomJid)
      const meta = state.roomMeta.get(roomJid)
      if (!room || !meta) return state

      // Only update if this message is newer than existing lastMessage
      if (!shouldUpdateLastMessage(meta.lastMessage, lastMessage)) return state

      // Update metadata map
      const newMeta = new Map(state.roomMeta)
      newMeta.set(roomJid, { ...meta, lastMessage })

      // Update combined map for backward compatibility
      const newRooms = new Map(state.rooms)
      newRooms.set(roomJid, { ...room, lastMessage })

      return { roomMeta: newMeta, rooms: newRooms }
    })
  },

  // Computed
  // Note: These return stable references (EMPTY_*_ARRAY) when empty to prevent infinite re-renders
  joinedRooms: () => {
    const rooms = get().rooms
    if (rooms === _cachedJoinedRoomsSource) return _cachedJoinedRooms
    _cachedJoinedRoomsSource = rooms
    const result = Array.from(rooms.values()).filter(r => r.joined)
    _cachedJoinedRooms = result.length > 0 ? result : EMPTY_ROOM_ARRAY
    return _cachedJoinedRooms
  },

  bookmarkedRooms: () => {
    const rooms = get().rooms
    if (rooms === _cachedBookmarkedRoomsSource) return _cachedBookmarkedRooms
    _cachedBookmarkedRoomsSource = rooms
    const result = Array.from(rooms.values()).filter(r => r.isBookmarked)
    _cachedBookmarkedRooms = result.length > 0 ? result : EMPTY_ROOM_ARRAY
    return _cachedBookmarkedRooms
  },

  allRooms: () => {
    const rooms = get().rooms
    if (rooms === _cachedAllRoomsSource) return _cachedAllRooms
    _cachedAllRoomsSource = rooms
    // Return all rooms that are either bookmarked or joined
    const result = Array.from(rooms.values()).filter(r => r.isBookmarked || r.joined)
    if (result.length === 0) {
      _cachedAllRooms = EMPTY_ROOM_ARRAY
      return EMPTY_ROOM_ARRAY
    }

    // Sort by lastInteractedAt (when user opened the room) descending
    // This prevents high-traffic rooms from constantly jumping to the top
    // Rooms only move up when the user explicitly opens them
    result.sort((a, b) => {
      // Use lastInteractedAt if available, fall back to lastMessage timestamp, then creation/join time
      const aTime = a.lastInteractedAt?.getTime() ?? a.lastMessage?.timestamp?.getTime() ?? 0
      const bTime = b.lastInteractedAt?.getTime() ?? b.lastMessage?.timestamp?.getTime() ?? 0
      return bTime - aTime // Descending (most recent first)
    })
    _cachedAllRooms = result
    return result
  },

  quickChatRooms: () => {
    const rooms = get().rooms
    if (rooms === _cachedQuickChatRoomsSource) return _cachedQuickChatRooms
    _cachedQuickChatRoomsSource = rooms
    const result = Array.from(rooms.values()).filter(r => r.isQuickChat)
    _cachedQuickChatRooms = result.length > 0 ? result : EMPTY_ROOM_ARRAY
    return _cachedQuickChatRooms
  },

  activeRoom: () => {
    const { rooms, activeRoomJid } = get()
    return activeRoomJid ? rooms.get(activeRoomJid) : undefined
  },

  activeMessages: () => {
    const room = get().activeRoom()
    return room?.messages ?? EMPTY_MESSAGE_ARRAY
  },

  totalMentionsCount: () => {
    let total = 0
    for (const [jid, entity] of get().roomEntities) {
      if (entity.joined) {
        const meta = get().roomMeta.get(jid)
        if (meta) total += meta.mentionsCount
      }
    }
    return total
  },

  totalUnreadCount: () => {
    let total = 0
    for (const [jid, entity] of get().roomEntities) {
      if (entity.joined) {
        const meta = get().roomMeta.get(jid)
        if (meta) total += meta.unreadCount
      }
    }
    return total
  },

  totalNotifiableUnreadCount: () => {
    let total = 0
    for (const [jid, entity] of get().roomEntities) {
      if (entity.joined) {
        const meta = get().roomMeta.get(jid)
        if (meta && (meta.notifyAll || meta.notifyAllPersistent)) {
          total += meta.unreadCount
        }
      }
    }
    return total
  },

  roomsWithUnreadCount: () => {
    // Count rooms that would show a badge in the UI:
    // - Rooms with mentions (always show badge)
    // - Rooms with notifyAll enabled and any unread messages
    let count = 0
    for (const [jid, entity] of get().roomEntities) {
      if (entity.joined) {
        const meta = get().roomMeta.get(jid)
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
}))
)
