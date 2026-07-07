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
 * use the core SDK: `import { XMPPClient } from '@fluux/sdk/core'`
 *
 * @packageDocumentation
 * @module React
 */

// Provider - wraps application with XMPP context
export { XMPPProvider, useXMPPContext } from '../provider'
export type { XMPPProviderProps } from '../provider'

// High-level React hooks
export { useConnection } from '../hooks/useConnection'
export { useConnectionStatus } from '../hooks/useConnectionStatus'
export { useConnectionActions } from '../hooks/useConnectionActions'
export { useChat } from '../hooks/useChat'
export { useChatActive } from '../hooks/useChatActive'
export { useChatActions } from '../hooks/useChatActions'
export { useRoster } from '../hooks/useRoster'
export { useRosterActions } from '../hooks/useRosterActions'
export { useContactIdentities, type ContactIdentity } from '../hooks/useContactIdentities'
export { useConsole } from '../hooks/useConsole'
export { useEvents } from '../hooks/useEvents'
export { useRoom } from '../hooks/useRoom'
export { useRoomActive } from '../hooks/useRoomActive'
export { useRoomActions } from '../hooks/useRoomActions'
export { usePolls } from '../hooks/usePolls'
export { useRoomModeration } from '../hooks/useRoomModeration'
export { useRoomManagement } from '../hooks/useRoomManagement'
export { useReferencedMessage, type ReferencedMessageParams } from '../hooks/useReferencedMessage'
export { useXMPP } from '../hooks/useXMPP'
export { useAdmin } from '../hooks/useAdmin'
export { useAdminPermissions } from '../hooks/useAdminPermissions'
export { useBlocking } from '../hooks/useBlocking'
export { useIgnore } from '../hooks/useIgnore'
export { usePresence } from '../hooks/usePresence'
export type { UsePresenceReturn } from '../hooks/usePresence'
export { useSystemState } from '../hooks/useSystemState'
export type { UseSystemStateReturn, SystemState } from '../hooks/useSystemState'
export { useNotificationEvents } from '../hooks/useNotificationEvents'
export type { NotificationEventHandlers } from '../hooks/useNotificationEvents'
export { useContactTime } from '../hooks/useContactTime'
export { useLastActivity } from '../hooks/useLastActivity'
export { useSearch } from '../hooks/useSearch'
export type { SearchResult, SearchResultContext, SearchFilterType, InPrefixSuggestion } from '../hooks/useSearch'

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
  useRoomOccupantCount,
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
  useIgnoreStore,
  useSearchStore,
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
