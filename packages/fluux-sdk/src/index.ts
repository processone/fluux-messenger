// Polyfill crypto.randomUUID for older browsers/webviews
// Must run before @xmpp/client is imported (it uses crypto.randomUUID internally)
// Supports: old Chromium (<92), old WebKitGTK, and other legacy environments
if (typeof globalThis !== 'undefined') {
  if (typeof globalThis.crypto === 'undefined') {
    // @ts-expect-error - polyfill for environments without crypto
    globalThis.crypto = {}
  }
  if (typeof globalThis.crypto.randomUUID !== 'function') {
    globalThis.crypto.randomUUID = (): `${string}-${string}-${string}-${string}-${string}` => {
      const bytes = new Uint8Array(16)
      crypto.getRandomValues(bytes)
      // Set version (4) and variant (RFC 4122)
      bytes[6] = (bytes[6] & 0x0f) | 0x40
      bytes[8] = (bytes[8] & 0x3f) | 0x80
      const hex = [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('')
      return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}` as `${string}-${string}-${string}-${string}-${string}`
    }
  }
}

/**
 * # Fluux SDK
 *
 * A headless XMPP SDK for building chat applications.
 *
 * ## Installation
 *
 * ```bash
 * npm install @fluux/sdk
 * ```
 *
 * ## Bundle Structure
 *
 * The SDK is split into focused bundles:
 *
 * - **`@fluux/sdk`** - Full SDK with React bindings (this bundle)
 * - **`@fluux/sdk/react`** - React-only: Provider, hooks (smaller bundle)
 * - **`@fluux/sdk/core`** - Core-only: XMPPClient, types (for bots/CLI/other frameworks)
 * - **`@fluux/sdk/stores`** - Direct Zustand store access
 *
 * ## Quick Start (React)
 *
 * ```tsx
 * import { XMPPProvider, useConnection, useChat } from '@fluux/sdk'
 * // Or: import { XMPPProvider, useConnection, useChat } from '@fluux/sdk/react'
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
 *   const { connect, isConnected } = useConnection()
 *   const { conversations, sendMessage } = useChat()
 *   // ...
 * }
 * ```
 *
 * ## Headless Usage (Bots/CLI)
 *
 * ```typescript
 * import { XMPPClient, createDefaultStoreBindings } from '@fluux/sdk/core'
 *
 * const client = new XMPPClient()
 * await client.connect({ jid: 'bot@example.com', password: 'secret', server: 'example.com' })
 * client.chat.sendMessage('user@example.com', 'Hello!')
 * ```
 *
 * @packageDocumentation
 */

// =============================================================================
// REACT BINDINGS (re-exported for convenience)
// For smaller bundles, import from '@fluux/sdk/react' directly
// =============================================================================

// Provider - wraps application with XMPP context
export { XMPPProvider, useXMPPContext } from './provider'
export type { XMPPProviderProps } from './provider'

// High-level React hooks
export { useConnection } from './hooks/useConnection'
export { useChat } from './hooks/useChat'
export { useChatActive } from './hooks/useChatActive'
export { useRoster } from './hooks/useRoster'
export { useRosterActions } from './hooks/useRosterActions'
export { useConsole } from './hooks/useConsole'
export { useEvents } from './hooks/useEvents'
export { useRoom } from './hooks/useRoom'
export { useXMPP } from './hooks/useXMPP'
export { useAdmin } from './hooks/useAdmin'
export { useBlocking } from './hooks/useBlocking'
export { usePresence } from './hooks/usePresence'
export type { UsePresenceReturn } from './hooks/usePresence'
export { useSystemState } from './hooks/useSystemState'
export type { UseSystemStateReturn, SystemState } from './hooks/useSystemState'
export { useNotificationEvents } from './hooks/useNotificationEvents'
export type { NotificationEventHandlers } from './hooks/useNotificationEvents'

// Fine-grained metadata subscription hooks (Phase 6)
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
} from './hooks/useMetadataSubscriptions'

// Presence state machine types (for advanced usage)
export type { UserPresenceShow, AutoAwaySavedState, PresenceEvent, PresenceContext, PresenceStateValue, AutoAwayConfig } from './core/presenceMachine'
export {
  getPresenceShowFromState,
  getPresenceStatusFromState,
  isAutoAwayState,
  getConnectedStateName,
  DEFAULT_AUTO_AWAY_CONFIG,
} from './core/presenceMachine'

// =============================================================================
// ZUSTAND STORES (framework-agnostic state management)
// =============================================================================

// Vanilla stores (framework-agnostic, for imperative .getState() access)
export {
  connectionStore,
  chatStore,
  rosterStore,
  consoleStore,
  eventsStore,
  roomStore,
  adminStore,
  blockingStore,
} from './stores'

// React hook wrappers are available from '@fluux/sdk/react':
// useConnectionStore, useChatStore, useRosterStore, useConsoleStore,
// useEventsStore, useRoomStore, useAdminStore, useBlockingStore
// These are NOT exported from the main entry point to avoid React initialization
// issues in some environments (e.g., Tauri WebView).

// Granular selectors for reduced re-renders (use with shallow comparison)
export { chatSelectors, roomSelectors, rosterSelectors } from './stores'

// Admin dashboard types
export type { AdminStats } from './stores/adminStore'

// Notification state utilities (pure functions for badge computation, etc.)
export { computeBadgeCount, shouldNotifyConversation, shouldNotifyRoom } from './stores/shared/notificationState'
export type { EntityNotificationState, NotificationMessage, EntityContext, BadgeInput } from './stores/shared/notificationState'

// Store bindings (wire SDK events to Zustand stores)
export { createStoreBindings } from './bindings'
export type { StoreRefs, UnsubscribeBindings } from './bindings'

// =============================================================================
// CORE SDK (framework-agnostic)
// =============================================================================

// Types
export type {
  // Connection types
  ConnectionStatus,
  ConnectionMethod,
  ConnectOptions,

  // Base message type (shared between chat and room messages)
  BaseMessage,

  // Chat types
  Message,
  Conversation,
  ReplyInfo,
  ChatStateNotification,

  // Roster types
  Contact,
  PresenceStatus,
  PresenceShow,
  ResourcePresence,

  // Room types (MUC)
  Room,
  RoomMessage,
  RoomOccupant,
  RoomAffiliation,
  RoomRole,
  MentionReference,
  Hat,

  // Discriminated union type for any message
  AnyMessage,

  // Console types
  XmppPacket,

  // Server discovery types
  ServerInfo,
  ServerIdentity,

  // HTTP Upload types (XEP-0363)
  HttpUploadService,
  UploadSlot,

  // File attachment types (XEP-0066, XEP-0264)
  FileAttachment,
  ThumbnailInfo,
  OobInfo,

  // Link preview types (XEP-0422 + OGP)
  LinkPreview,

  // Client types
  XMPPClientConfig,
  XMPPClientEvents,
  StoreBindings,
  PresenceOptions,
  PrivacyOptions,

  // Admin types (XEP-0133, XEP-0050, XEP-0004)
  AdminCommand,
  AdminCommandCategory,
  AdminSession,
  AdminSessionStatus,
  AdminNote,
  DataForm,
  DataFormType,
  DataFormField,
  DataFormFieldType,
  DataFormFieldOption,

  // Admin entity list types (XEP-0059 RSM)
  RSMRequest,
  RSMResponse,
  AdminUser,
  AdminRoom,
  EntityListState,
  EntityCounts,
  AdminCategory,

  // XEP-0313: Message Archive Management
  MAMQueryOptions,
  MAMResult,
  MAMQueryState,
} from './core/types'

// Events types
export type { SubscriptionRequest, StrangerMessage, MucInvitation, SystemNotification, SystemNotificationType } from './core/types'

// SDK Events (for event-based decoupling)
export type {
  SDKEvents,
  SDKEventPayload,
  SDKEventHandler,
  ConnectionEvents,
  ChatEvents,
  RoomEvents,
  RosterEvents,
  NotificationEvents,
  BlockingEvents,
  AdminEvents,
  ConsoleEvents,
  StanzaEvents,
} from './core/types'

// Message type guards
export { isChatMessage, isRoomMessage } from './core/types'

// Re-export xml builder for stanza construction
export { xml } from '@xmpp/client'
export type { Element } from '@xmpp/client'

// =============================================================================
// UTILITIES
// =============================================================================

// Utility functions
export { getLastSeenInfo, getPresenceLabel, getStatusText } from './utils/lastSeen'
export type { LastSeenInfo } from './utils/lastSeen'

// Presence utilities
export { getPresenceRank, getBestPresenceShow, getPresenceFromShow } from './utils/presenceUtils'

// Message lookup utilities
export { createMessageLookup, findMessageById } from './utils/messageLookup'

// JID utilities
export {
  parseJid,
  getBareJid,
  getResource,
  getLocalPart,
  getDomain,
  splitFullJid,
  hasResource,
  createFullJid,
  matchJidUsername,
  matchNameOrJid,
  getUniqueOccupantCount,
} from './core/jid'
export type { ParsedJid } from './core/jid'

// XMPP URI utilities (RFC 5122)
export { parseXmppUri, isMucJid } from './utils/xmppUri'
export type { XmppUri } from './utils/xmppUri'

// Client identification utilities
export { getClientType } from './core/clients'
export type { ClientType } from './core/clients'

// Consistent color generation (XEP-0392)
export {
  hsluvToRgb,
  generateHueAngle,
  generateHueAngleSync,
  generateConsistentColor,
  generateConsistentColorSync,
  generateConsistentColorCss,
  generateConsistentColorCssSync,
  generateConsistentColorHex,
  generateConsistentColorHexSync,
  LIGHT_THEME_DEFAULTS,
  DARK_THEME_DEFAULTS,
} from './core/consistentColor'
export type { ConsistentColorOptions } from './core/consistentColor'

// Message preview utilities
export { getAttachmentEmoji, formatMessagePreview, stripReplyQuote } from './utils/messagePreview'
export type { AttachmentDisplay } from './utils/messagePreview'

// Configuration constants
export { WELL_KNOWN_MUC_SERVERS } from './core/config'
export type { WellKnownMucServer } from './core/config'

// =============================================================================
// XMPP NAMESPACE CONSTANTS
// =============================================================================

export {
  // XEP-0030: Service Discovery
  NS_DISCO_INFO,
  NS_DISCO_ITEMS,
  // XEP-0363: HTTP File Upload
  NS_HTTP_UPLOAD,
  // XEP-0066: Out of Band Data
  NS_OOB,
  // XEP-0264: Jingle Content Thumbnails
  NS_THUMBS,
  // XEP-0085: Chat State Notifications
  NS_CHATSTATES,
  // XEP-0115: Entity Capabilities
  NS_CAPS,
  // XEP-0054: vcard-temp
  NS_VCARD_TEMP,
  // XEP-0153: vCard-Based Avatars
  NS_VCARD_UPDATE,
  // XEP-0280: Message Carbons
  NS_CARBONS,
  // XEP-0297: Stanza Forwarding
  NS_FORWARD,
  // XEP-0393: Message Styling
  NS_STYLING,
  // XEP-0428: Fallback Indication
  NS_FALLBACK,
  NS_FALLBACK_LEGACY,
  // XEP-0444: Message Reactions
  NS_REACTIONS,
  // XEP-0461: Message Replies
  NS_REPLY,
  // XEP-0308: Last Message Correction
  NS_CORRECTION,
  // XEP-0424: Message Retraction
  NS_RETRACT,
  // XEP-0319: Last User Interaction in Presence
  NS_IDLE,
  // PubSub namespaces
  NS_PUBSUB,
  NS_PUBSUB_EVENT,
  // XEP-0084: User Avatar (PEP)
  NS_AVATAR_DATA,
  NS_AVATAR_METADATA,
  NS_AVATAR_METADATA_NOTIFY,
  // XEP-0172: User Nickname
  NS_NICK,
  // XEP-0045: Multi-User Chat (MUC)
  NS_MUC,
  NS_MUC_USER,
  NS_MUC_OWNER,
  // XEP-0249: Direct MUC Invitations
  NS_CONFERENCE,
  // XEP-0402: PEP Native Bookmarks
  NS_BOOKMARKS,
  NS_BOOKMARKS_NOTIFY,
  // XEP-0203: Delayed Delivery
  NS_DELAY,
  // XEP-0359: Unique and Stable Stanza IDs
  NS_STANZA_ID,
  // XEP-0372: References
  NS_REFERENCE,
  // XEP-0334: Message Processing Hints
  NS_HINTS,
  // XEP-0422: Message Fastening
  NS_FASTEN,
  // XEP-0050: Ad-Hoc Commands
  NS_COMMANDS,
  // XEP-0133: Service Administration
  NS_ADMIN,
  // XEP-0004: Data Forms
  NS_DATA_FORMS,
  // XEP-0059: Result Set Management
  NS_RSM,
  // XEP-0313: Message Archive Management
  NS_MAM,
  // XEP-0077: In-Band Registration
  NS_REGISTER,
  // XEP-0317: Hats
  NS_HATS,
  // XEP-0199: XMPP Ping
  NS_PING,
  // XEP-0191: Blocking Command
  NS_BLOCKING,
} from './core/namespaces'

// =============================================================================
// XMPP PROTOCOL UTILITIES
// =============================================================================

// XEP-0004: Data Form utilities
export { parseDataForm, getFormFieldValue, getFormFieldValues } from './utils/dataForm'

// XEP-0059: Result Set Management utilities
export { parseRSMResponse, buildRSMElement } from './utils/rsm'

// UUID generation utility
export { generateUUID, generateStableMessageId } from './utils/uuid'

// XEP-0428: Fallback Indication utilities
export { processFallback, getFallbackElement } from './utils/fallbackUtils'
export type { FallbackProcessingResult, FallbackProcessingOptions } from './utils/fallbackUtils'

// RFC 6120: XMPP Stanza Error parsing
export { parseXMPPError, formatXMPPError } from './utils/xmppError'
export type { XMPPStanzaError, XMPPErrorType } from './utils/xmppError'

// XEP-0156: Discovering Alternative XMPP Connection Methods
export { discoverWebSocket, discoverXmppEndpoints } from './utils/websocketDiscovery'
export type { DiscoveryResult } from './utils/websocketDiscovery'

// =============================================================================
// PLATFORM UTILITIES
// =============================================================================

// Storage adapters for session persistence
export { sessionStorageAdapter } from './utils/sessionStorageAdapter'
export type { StorageAdapter, SessionState, StoredCredentials, JoinedRoomInfo } from './core/types'

// Proxy adapter for WebSocket-to-TCP bridging (desktop apps)
export type { ProxyAdapter, ProxyStartResult } from './core/types'

// Emoji shortcode utilities (for clients that send :shortcodes: instead of Unicode)
export { shortcodeToEmoji, convertShortcodes } from './core/emoji'

// =============================================================================
// INDEXEDDB MESSAGE CACHE
// =============================================================================

export {
  // Chat message operations
  saveMessage,
  saveMessages,
  getMessage,
  getMessageByStanzaId,
  getMessages,
  getMessageCount,
  updateMessage,
  deleteMessage,
  deleteConversationMessages,
  getOldestMessageTimestamp,
  // Room message operations
  saveRoomMessage,
  saveRoomMessages,
  getRoomMessage,
  getRoomMessageByStanzaId,
  getRoomMessages,
  getRoomMessageCount,
  updateRoomMessage,
  deleteRoomMessage,
  deleteRoomMessages,
  getOldestRoomMessageTimestamp,
  flushPendingRoomMessages,
  // Utility
  clearAllMessages,
  isMessageCacheAvailable,
} from './utils/messageCache'
export type { GetMessagesOptions } from './utils/messageCache'

// Avatar cache operations
export {
  clearAllAvatarData,
} from './utils/avatarCache'
