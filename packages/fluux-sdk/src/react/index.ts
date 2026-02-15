/**
 * # Fluux SDK - React Bindings
 *
 * React-specific components and hooks for the Fluux SDK.
 * Import from `@fluux/sdk/react` for React applications.
 *
 * ## Quick Start
 *
 * ```tsx
 * import { XMPPProvider, useConnection, useChat } from '@fluux/sdk/react'
 *
 * function App() {
 *   return (
 *     <XMPPProvider>
 *       <Chat />
 *     </XMPPProvider>
 *   )
 * }
 *
 * function Chat() {
 *   const { connect, status } = useConnection()
 *   const { conversations, sendMessage } = useChat()
 *   // ...
 * }
 * ```
 *
 * For framework-agnostic usage (bots, CLI tools, other frameworks),
 * use the core SDK: `import { XMPPClient } from '@fluux/sdk'`
 *
 * @packageDocumentation
 * @module React
 */

// Provider - wraps application with XMPP context
export { XMPPProvider, useXMPPContext } from '../provider'
export type { XMPPProviderProps } from '../provider'

// High-level React hooks
export { useConnection } from '../hooks/useConnection'
export { useChat } from '../hooks/useChat'
export { useRoster } from '../hooks/useRoster'
export { useRosterActions } from '../hooks/useRosterActions'
export { useConsole } from '../hooks/useConsole'
export { useEvents } from '../hooks/useEvents'
export { useRoom } from '../hooks/useRoom'
export { useRoomActive } from '../hooks/useRoomActive'
export { useXMPP } from '../hooks/useXMPP'
export { useAdmin } from '../hooks/useAdmin'
export { useBlocking } from '../hooks/useBlocking'
export { usePresence } from '../hooks/usePresence'
export type { UsePresenceReturn } from '../hooks/usePresence'
export { useSystemState } from '../hooks/useSystemState'
export type { UseSystemStateReturn, SystemState } from '../hooks/useSystemState'
export { useNotificationEvents } from '../hooks/useNotificationEvents'
export type { NotificationEventHandlers } from '../hooks/useNotificationEvents'

// Fine-grained metadata subscription hooks
export {
  // Chat metadata hooks
  useConversationEntity,
  useConversationMetadata,
  useChatSidebarItems,
  useArchivedSidebarItems,
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
} from '../hooks/useMetadataSubscriptions'

// React hooks for direct store access (for advanced usage)
// These are React-bound versions of the vanilla stores
export {
  useConnectionStore,
  useChatStore,
  useRosterStore,
  useConsoleStore,
  useEventsStore,
  useRoomStore,
  useAdminStore,
  useBlockingStore,
} from './storeHooks'

// Presence state machine types (for XState integration)
export type {
  UserPresenceShow,
  AutoAwaySavedState,
  PresenceEvent,
  PresenceContext,
  PresenceStateValue,
  AutoAwayConfig,
} from '../core/presenceMachine'
export {
  getPresenceShowFromState,
  getPresenceStatusFromState,
  isAutoAwayState,
  getConnectedStateName,
  DEFAULT_AUTO_AWAY_CONFIG,
} from '../core/presenceMachine'
