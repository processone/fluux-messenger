/**
 * Fine-grained metadata subscription hooks.
 *
 * These hooks provide optimized subscriptions to specific pieces of store state,
 * reducing unnecessary re-renders for components that only need metadata (like sidebars)
 * or only need entity data (like headers).
 *
 * @packageDocumentation
 * @module Hooks/MetadataSubscriptions
 */

import { useChatStore, useRoomStore } from '../react/storeHooks'
import { chatSelectors } from '../stores/chatSelectors'
import { roomSelectors } from '../stores/roomSelectors'
import type { Message, ConversationEntity, ConversationMetadata, RoomEntity, RoomMetadata, RoomRuntime, RoomMessage, RoomOccupant } from '../core/types'
// Note: Message is used in the return type of useChatSidebarItems

/**
 * Stable empty references to prevent infinite re-renders.
 */
const EMPTY_ROOM_MESSAGE_ARRAY: RoomMessage[] = []
const EMPTY_OCCUPANT_MAP: Map<string, RoomOccupant> = new Map()

// =============================================================================
// CHAT METADATA HOOKS
// =============================================================================

/**
 * Subscribe to conversation entity (stable identity data only).
 *
 * Use this when you only need id, name, type - not unread counts or last message.
 * Entity data changes rarely (only on conversation creation or rename).
 *
 * @param conversationId - The conversation ID to subscribe to
 * @returns ConversationEntity or undefined if not found
 *
 * @example
 * ```tsx
 * function ConversationHeader({ id }: { id: string }) {
 *   const entity = useConversationEntity(id)
 *   // Only re-renders when name or type changes, not on new messages
 *   return <h2>{entity?.name}</h2>
 * }
 * ```
 */
export function useConversationEntity(conversationId: string): ConversationEntity | undefined {
  return useChatStore(chatSelectors.entityById(conversationId))
}

/**
 * Subscribe to conversation metadata (frequently-changing data only).
 *
 * Use this for sidebar badges, unread counts, last message preview.
 * Metadata changes on every new message, read receipt, etc.
 *
 * @param conversationId - The conversation ID to subscribe to
 * @returns ConversationMetadata or undefined if not found
 *
 * @example
 * ```tsx
 * function UnreadBadge({ id }: { id: string }) {
 *   const meta = useConversationMetadata(id)
 *   // Only re-renders when metadata changes, not entity changes
 *   return <span className="badge">{meta?.unreadCount || 0}</span>
 * }
 * ```
 */
export function useConversationMetadata(conversationId: string): ConversationMetadata | undefined {
  return useChatStore(chatSelectors.metadataById(conversationId))
}

/**
 * Subscribe to all conversation metadata for sidebar list rendering.
 *
 * Returns pre-combined entity + metadata items sorted by last message time.
 * This is optimized for sidebar rendering - use instead of subscribing to
 * the full conversation objects.
 *
 * @returns Array of sidebar list items (non-archived)
 *
 * @example
 * ```tsx
 * function ConversationSidebar() {
 *   const items = useChatSidebarItems()
 *   return (
 *     <ul>
 *       {items.map(item => (
 *         <li key={item.id}>
 *           {item.name} ({item.unreadCount} unread)
 *           {item.hasDraft && <span>Draft</span>}
 *         </li>
 *       ))}
 *     </ul>
 *   )
 * }
 * ```
 */
export function useChatSidebarItems(): Array<{
  id: string
  name: string
  type: 'chat' | 'groupchat'
  unreadCount: number
  lastMessage?: Message
  hasDraft: boolean
}> {
  return useChatStore(chatSelectors.activeSidebarListItems)
}

/**
 * Subscribe to archived conversation metadata for sidebar list rendering.
 *
 * Returns pre-combined entity + metadata items for archived conversations,
 * sorted by last message time. This is the archived counterpart to
 * `useChatSidebarItems()`.
 *
 * @returns Array of archived sidebar list items
 *
 * @example
 * ```tsx
 * function ArchiveSidebar() {
 *   const items = useArchivedSidebarItems()
 *   return (
 *     <ul>
 *       {items.map(item => (
 *         <li key={item.id}>{item.name}</li>
 *       ))}
 *     </ul>
 *   )
 * }
 * ```
 */
export function useArchivedSidebarItems(): Array<{
  id: string
  name: string
  type: 'chat' | 'groupchat'
  unreadCount: number
  lastMessage?: Message
  hasDraft: boolean
}> {
  return useChatStore(chatSelectors.archivedSidebarListItems)
}

/**
 * Subscribe to total unread count across all conversations.
 *
 * Useful for app badges, notification icons.
 *
 * @returns Total unread message count
 */
export function useChatTotalUnreadCount(): number {
  return useChatStore(chatSelectors.totalUnreadCount)
}

/**
 * Subscribe to count of conversations with unread messages.
 *
 * @returns Number of conversations that have unread messages
 */
export function useChatUnreadConversationCount(): number {
  return useChatStore(chatSelectors.conversationsWithUnreadCount)
}

// =============================================================================
// ROOM METADATA HOOKS
// =============================================================================

/**
 * Subscribe to room entity (stable identity data only).
 *
 * Use this when you only need jid, name, nickname, joined status - not unread counts or occupants.
 * Entity data changes on bookmark updates, join/leave, but not on messages.
 *
 * @param roomJid - The room JID to subscribe to
 * @returns RoomEntity or undefined if not found
 *
 * @example
 * ```tsx
 * function RoomHeader({ jid }: { jid: string }) {
 *   const entity = useRoomEntity(jid)
 *   // Only re-renders when room identity changes, not on new messages
 *   return <h2>{entity?.name}</h2>
 * }
 * ```
 */
export function useRoomEntity(roomJid: string): RoomEntity | undefined {
  return useRoomStore(roomSelectors.entityById(roomJid))
}

/**
 * Subscribe to room metadata (frequently-changing data only).
 *
 * Use this for sidebar badges, unread/mention counts, typing indicators.
 * Metadata changes on every new message, typing notification, etc.
 *
 * @param roomJid - The room JID to subscribe to
 * @returns RoomMetadata or undefined if not found
 *
 * @example
 * ```tsx
 * function RoomBadge({ jid }: { jid: string }) {
 *   const meta = useRoomMetadata(jid)
 *   const hasMentions = (meta?.mentionsCount ?? 0) > 0
 *   // Only re-renders when metadata changes, not entity or occupant changes
 *   return hasMentions ? <span className="badge">@{meta?.mentionsCount}</span> : null
 * }
 * ```
 */
export function useRoomMetadata(roomJid: string): RoomMetadata | undefined {
  return useRoomStore(roomSelectors.metadataById(roomJid))
}

/**
 * Subscribe to room runtime data (session-only: occupants, messages).
 *
 * Use this for message list and occupant panel.
 * Runtime data is rebuilt on join and not persisted.
 *
 * @param roomJid - The room JID to subscribe to
 * @returns RoomRuntime or undefined if not found
 *
 * @example
 * ```tsx
 * function OccupantPanel({ jid }: { jid: string }) {
 *   const runtime = useRoomRuntime(jid)
 *   // Only re-renders when occupants or messages change
 *   return <OccupantList occupants={runtime?.occupants} />
 * }
 * ```
 */
export function useRoomRuntime(roomJid: string): RoomRuntime | undefined {
  return useRoomStore(roomSelectors.runtimeById(roomJid))
}

/**
 * Subscribe to room messages using the runtime map.
 *
 * More efficient than subscribing to the full room when you only need messages.
 *
 * @param roomJid - The room JID to subscribe to
 * @returns Array of room messages
 */
export function useRoomMessages(roomJid: string): RoomMessage[] {
  return useRoomStore(roomSelectors.runtimeMessagesFor(roomJid)) ?? EMPTY_ROOM_MESSAGE_ARRAY
}

/**
 * Subscribe to room occupants using the runtime map.
 *
 * More efficient than subscribing to the full room when you only need occupants.
 *
 * @param roomJid - The room JID to subscribe to
 * @returns Map of nick -> RoomOccupant
 */
export function useRoomOccupants(roomJid: string): Map<string, RoomOccupant> {
  return useRoomStore(roomSelectors.runtimeOccupantsFor(roomJid)) ?? EMPTY_OCCUPANT_MAP
}

/**
 * Subscribe to the room occupant COUNT (a primitive) instead of the occupants Map.
 *
 * The occupants Map ref is replaced on every occupant event (join / leave / show /
 * avatar update), so `useRoomOccupants` consumers re-render on all of them. Use this
 * when you only need the size: it re-renders only when the count actually changes
 * (join / leave), bailing on metadata-only churn (e.g. presence flapping in a busy
 * room). Read the occupant data non-reactively (`roomStore.getState()`) if you also
 * need it for a computation that is already recomputed each render.
 *
 * @param roomJid - The room JID to subscribe to
 * @returns The number of occupants currently in the room
 */
export function useRoomOccupantCount(roomJid: string): number {
  return useRoomStore(roomSelectors.runtimeOccupantCountFor(roomJid))
}

/** Room sidebar item type - shared between hooks */
export interface RoomSidebarItem {
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
}

/**
 * Subscribe to ALL rooms sidebar items.
 *
 * Returns pre-combined entity + metadata + runtime items sorted by name.
 * This is optimized for sidebar rendering - use instead of useRoom().allRooms.
 *
 * @returns Array of all room sidebar items
 *
 * @example
 * ```tsx
 * function RoomsSidebar() {
 *   const items = useAllRoomSidebarItems()
 *   const joined = items.filter(r => r.joined)
 *   const bookmarked = items.filter(r => r.isBookmarked && !r.joined)
 *   // ...render lists
 * }
 * ```
 */
export function useAllRoomSidebarItems(): RoomSidebarItem[] {
  return useRoomStore(roomSelectors.sidebarListItems)
}

/**
 * Subscribe to bookmarked rooms sidebar items.
 *
 * Returns pre-combined entity + metadata + runtime items sorted by name.
 * This is optimized for sidebar rendering.
 *
 * @returns Array of bookmarked room sidebar items
 */
export function useRoomSidebarItems(): RoomSidebarItem[] {
  return useRoomStore(roomSelectors.bookmarkedSidebarListItems)
}

/**
 * Subscribe to total mentions count across all joined rooms.
 *
 * Useful for app badges, notification icons.
 *
 * @returns Total mentions count
 */
export function useRoomTotalMentionsCount(): number {
  return useRoomStore(roomSelectors.totalMentionsCount)
}

/**
 * Subscribe to total unread count across all joined rooms.
 *
 * @returns Total unread message count in rooms
 */
export function useRoomTotalUnreadCount(): number {
  return useRoomStore(roomSelectors.totalUnreadCount)
}

/**
 * Subscribe to count of rooms with unread activity (mentions or notifyAll with unread).
 *
 * @returns Number of rooms with unread activity
 */
export function useRoomUnreadRoomCount(): number {
  return useRoomStore(roomSelectors.roomsWithUnreadCount)
}
