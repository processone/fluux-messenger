export { useConnection } from './useConnection'
export { useChat } from './useChat'
export { useChatActive } from './useChatActive'
export { useRoster } from './useRoster'
export { useRosterActions } from './useRosterActions'
export { useConsole } from './useConsole'
export { useEvents } from './useEvents'
export { useRoom } from './useRoom'
export { useXMPP } from './useXMPP'
export { useBlocking } from './useBlocking'
export { usePresence, type UsePresenceReturn } from './usePresence'
export { useSystemState, type UseSystemStateReturn, type SystemState } from './useSystemState'
export { useNotificationEvents, type NotificationEventHandlers } from './useNotificationEvents'

// Fine-grained metadata subscription hooks (Phase 6)
export {
  // Chat metadata hooks
  useConversationEntity,
  useConversationMetadata,
  useChatSidebarItems,
  useChatTotalUnreadCount,
  useChatUnreadConversationCount,
  // Room metadata hooks
  useRoomEntity,
  useRoomMetadata,
  useRoomRuntime,
  useRoomMessages,
  useRoomOccupants,
  useAllRoomSidebarItems,
  useRoomSidebarItems,
  useRoomTotalMentionsCount,
  useRoomTotalUnreadCount,
  useRoomUnreadRoomCount,
  // Types
  type RoomSidebarItem,
} from './useMetadataSubscriptions'
