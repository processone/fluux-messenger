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
 * Everything the SDK observes reaches you through one bus: `client.subscribe`,
 * or the hooks built on it. Raw stanzas have their own named door,
 * `client.onStanza`.
 *
 * None of those describes XMPP on the wire: conversations, rooms, contacts and
 * presence are the vocabulary, and no XEP has to be read to use them. Raw
 * namespaces, the stanza builder and the wire parsers are the escape hatch on
 * **`@fluux/sdk/xmpp`**, for speaking a protocol the SDK does not model yet.
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
 *   const { isConnected } = useConnection()
 *   const { conversations } = useChat()
 *
 *   if (!isConnected) return <p>Connecting…</p>
 *   return <p>{conversations.length} conversations</p>
 * }
 * ```
 *
 * ## Headless Usage (Bots/CLI)
 *
 * ```typescript
 * import { XMPPClient } from '@fluux/sdk/core'
 *
 * // The constructor wires the default store bindings automatically —
 * // no React and no extra setup needed.
 * const client = new XMPPClient()
 * await client.connect({ jid: 'bot@example.com', password: 'secret', server: 'example.com' })
 * client.messages.sendMessage('user@example.com', 'Hello!')
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
export { useConnectionStatus } from './hooks/useConnectionStatus'
export { useConnectionActions } from './hooks/useConnectionActions'
export { useChat } from './hooks/useChat'
export { useChatActive } from './hooks/useChatActive'
export { useChatActions } from './hooks/useChatActions'
export { useRoster } from './hooks/useRoster'
export { useRosterActions } from './hooks/useRosterActions'
export { useContactIdentities, type ContactIdentity } from './hooks/useContactIdentities'
export { useConsole } from './hooks/useConsole'
export { useEvents } from './hooks/useEvents'
export { useRoom } from './hooks/useRoom'
export { useRoomActive } from './hooks/useRoomActive'
export { useRoomActions } from './hooks/useRoomActions'
export { usePolls } from './hooks/usePolls'
export { useRoomModeration } from './hooks/useRoomModeration'
export { useRoomManagement } from './hooks/useRoomManagement'
export { useReferencedMessage, type ReferencedMessageParams } from './hooks/useReferencedMessage'
export { useXMPP } from './hooks/useXMPP'
export { useAdmin } from './hooks/useAdmin'
export { useAdminPermissions } from './hooks/useAdminPermissions'
export { useBlocking } from './hooks/useBlocking'
export { useIgnore } from './hooks/useIgnore'
export { usePresence } from './hooks/usePresence'
export type { UsePresenceReturn } from './hooks/usePresence'
export { useSystemState } from './hooks/useSystemState'
export type { UseSystemStateReturn, SystemState } from './hooks/useSystemState'
export { useNotificationEvents } from './hooks/useNotificationEvents'
export type { NotificationEventHandlers } from './hooks/useNotificationEvents'
export { useContactTime } from './hooks/useContactTime'
export { useLastActivity } from './hooks/useLastActivity'
export { useSearch } from './hooks/useSearch'
export type { SearchResult, SearchResultContext, SearchFilterType, InPrefixSuggestion } from './hooks/useSearch'
export { rebuildSearchIndex, clearSearchIndex, parseSearchQuery } from './utils/searchIndex'
export type { RebuildProgress, ParsedQuery } from './utils/searchIndex'
export { buildScopedStorageKey, getStorageScopeJid } from './utils/storageScope'

// Read-only diagnostic: why an unread recount declined to commit (issue #1211).
// A tally of reasons — no entity ids or unread totals — so a dev build can
// attribute a stale badge instead of guessing which of ~20 guards stood down.
export { readRecountDeferrals } from './stores/shared/recountDiagnostics'
export type {
  RecountDeferralReason,
  RecountEntityKind,
} from './stores/shared/recountDiagnostics'

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

// Connection state machine types (for advanced usage)
export type {
  ConnectionMachineContext,
  ConnectionMachineEvent,
  ConnectionStateValue,
  ConnectionActor,
} from './core/connectionMachine'
export {
  connectionMachine,
  getConnectionStatusFromState,
  isTerminalState,
  getReconnectInfoFromContext,
} from './core/connectionMachine'

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
  searchStore,
} from './stores'

// React hook wrappers are available from '@fluux/sdk/react':
// useConnectionStore, useChatStore, useRosterStore, useConsoleStore,
// useEventsStore, useRoomStore, useAdminStore, useBlockingStore
// These are NOT exported from the main entry point to avoid React initialization
// issues in some environments (e.g., Tauri WebView).

// Granular selectors for reduced re-renders (use with shallow comparison)
export { chatSelectors, roomSelectors, rosterSelectors } from './stores'

// Per-room sidebar activity tone (shared by the icon-rail indicator and the room list)
export { roomActivityTone } from './stores'
export type { RoomActivityTone } from './stores'

// Admin dashboard types
export type { AdminStats } from './stores/adminStore'

// Room ignore store types and utilities
export type { IgnoredUser } from './stores/ignoreStore'

// Conversation sync types
export type { SyncedConversation } from './core/modules/ConversationSync'
export { isMessageFromIgnoredUser, isReplyToIgnoredUser, filterIgnoredReactions } from './stores/ignoreStore'

// Notification state utilities (pure functions for badge computation, etc.)
export { computeBadgeCount, shouldNotifyConversation, shouldNotifyRoom } from './stores/shared/notificationState'
export type { EntityNotificationState, NotificationMessage, EntityContext, BadgeInput } from './stores/shared/notificationState'

// Read pointer (canonical read position; supersedes lastSeenMessageId + lastReadAt, issue #1081).
//
// A pointer is `{ order, identity }`: one ORDER, and two NAMES that answer
// different questions. `identity` is a DISCRIMINATED union — `addressable`
// carries the XEP-0359 archive id that XEP-0490 publishes, `local` says the
// position has no wire name yet — so a consumer that wants to publish a position
// has to say what it does when there isn't one. `order` is likewise `exact` or
// `floor`. The shapes are declared in `core/types/readState.ts`, which explains
// why neither name can replace the other; the constructors and comparators live
// in `stores/shared/readPointer.ts`.
export type {
  ReadPointer,
  PointerIdentity,
  CacheOrderKey,
  PointerOrder,
  ExactPosition,
  FloorPosition,
} from './core/types'
export type { PointerSource } from './stores/shared/readPointer'
export { makeReadPointer, withArchiveId, isAhead, advance } from './stores/shared/readPointer'

// Viewport evidence: SDK-owned, generation-scoped
// "is the viewport genuinely at the live edge" state. `beginViewportGeneration`
// is deliberately NOT exported here — the SDK's activation path
// (setActiveConversation/setActiveRoom) is its sole caller; the app only ever
// reads the current generation and reports against it.
export type { ViewportEvidence, EvidenceKey as ViewportEvidenceKey } from './stores/shared/viewportEvidence'
export { currentViewportGeneration, reportViewport } from './stores/shared/viewportEvidence'

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
  MessageSecurityContext,
  UnsupportedEncryptionInfo,

  // Chat types
  Message,
  Conversation,
  ReplyInfo,
  ReplyTarget,
  SendMessageOptions,
  ChatStateNotification,

  // Roster types
  Contact,
  VCardInfo,
  PresenceStatus,
  PresenceShow,
  ResourcePresence,

  // Room types (MUC)
  Room,
  RoomMessage,
  RoomSystemEvent,
  RoomOccupant,
  RoomMember,
  RoomAffiliation,
  RoomRole,
  RoomFeatures,
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

  // Web Push types (p1:push)
  WebPushService,
  WebPushRegistration,
  WebPushStatus,

  // File attachment types (XEP-0264, XEP-0454). `OobInfo` is the raw XEP-0066
  // shape and no attachment field carries it, so it lives on `@fluux/sdk/xmpp`.
  FileAttachment,
  FileEncryption,
  ThumbnailInfo,

  // Link preview types (XEP-0422 + OGP)
  LinkPreview,

  // Poll types (reaction-based voting)
  PollData,
  PollOption,
  PollSettings,
  PollClosedData,

  // Client types (XMPPClientConfig is exported separately, below)
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
  AdminCategory,
  ServerStats,
  LastActivityResult,
  LastActivityEntry,

  // XEP-0313: Message Archive Management
  HistoryQueryOptions,
  HistoryResult,
  HistoryQueryState,
  HistorySearchOptions,
  RoomHistorySearchOptions,
  HistoryPagingSearchOptions,
} from './core/types'

// Client construction options live beside the client rather than in the
// shared domain-type barrel.
export type { XMPPClientConfig } from './core/clientConfig'

// Events types
export type { SubscriptionRequest, StrangerMessage, RoomInvitation, SystemNotification, SystemNotificationType } from './core/types'

// EventHook base class (Obsidian-inspired plugin pattern)
export { EventHook } from './core/EventHook'

// Media encryption helpers (XEP-0454-style encrypted file attachments).
// Apps wrap HTTP Upload bytes in AES-256-GCM and carry the key/IV in the
// FileAttachment; Chat.sendMessage moves the resulting OOB URL inside the
// OpenPGP `<payload/>`. See docs/ENCRYPTION.md §Media sharing.
export { encryptFile, decryptFile } from './core/modules/MediaEncryption'
export type { EncryptedFile } from './core/modules/MediaEncryption'
export {
  buildAesgcmUri,
  parseAesgcmUri,
  isAesgcmUri,
} from './core'
export type { AesgcmUriParts } from './core/modules/AesgcmUri'

// SDK Events (for event-based decoupling)
export type {
  SDKEvents,
  SDKEventPayload,
  SDKEventHandler,
  ConnectionEvents,
  ChatEvents,
  RoomEvents,
  ContactsEvents,
  NotificationEvents,
  BlockingEvents,
  AdminEvents,
  ConsoleEvents,
  StanzaEvents,
} from './core/types'

// Message type guards
export { isChatMessage, isRoomMessage } from './core/types'

// The stanza builder (`xml`) and the ltx `Element` type are NOT exported here.
// Typing consumer code against ltx would couple every app to an internal
// dependency the SDK wants to keep replaceable. They live on the
// `@fluux/sdk/xmpp` escape hatch, with the namespaces and the wire parsers.

// =============================================================================
// E2EE PLUGIN ARCHITECTURE
// =============================================================================

// Host, plugin trait, and supporting types. See core/e2ee/index.ts for details.
// Consumers register E2EEPlugin implementations with an E2EEManager; the
// manager handles strategy selection and dispatch. Integration with the
// message send/receive path is intentionally not wired in this slice.
// Note: DummyPlaintextPlugin is intentionally NOT re-exported. It is an
// internal validation tool; pinning it from an app would send plaintext
// while the UI suggests encryption. Tests import it via relative path.
export {
  E2EEManager,
  E2EEEncryptionRequiredError,
  E2EEPluginError,
  isE2EEPluginError,
  CapabilityCache,
  InMemoryStorageBackend,
  createPluginStorage,
  serializePayloadEnvelope,
  parsePayloadEnvelope,
  isPayloadEnvelope,
  wrapForSigncrypt,
  unwrapSigncrypt,
  SigncryptEnvelopeError,
  deriveSas,
  splitSas,
} from './core/e2ee'
export type { SigncryptEnvelope } from './core/e2ee'
export type {
  AccountInfo,
  ArchiveDecryptItem,
  BareJID,
  CapabilityCacheOptions,
  ConversationHandle,
  ConversationTarget,
  DecryptFailureReason,
  DecryptResult,
  DecryptStatus,
  DeviceIdentifier,
  DiscoFeature,
  DiscoResult,
  E2EEErrorKind,
  E2EEManagerOptions,
  E2EEPlugin,
  E2EEProtocolDescriptor,
  EncryptedPayload,
  IdentityInfo,
  InboundDecryptContext,
  InboundSource,
  Logger as E2EELogger,
  PEPItem,
  PeerSupport,
  PinnedStrategy,
  PluginConfiguration,
  PluginContext,
  PluginStorage,
  ProtocolFeatures,
  SecurityContext,
  SecurityContextUpdate,
  SecurityContextUpdateListener,
  StorageBackend,
  Subscription as E2EESubscription,
  TrustState,
  VerificationFlow,
  VerificationMethod,
  XMLElementData,
  XMPPPrimitives,
} from './core/e2ee'

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

// Poll utilities
export {
  POLL_OPTION_EMOJIS,
  MAX_POLL_OPTIONS,
  tallyPollResults,
  getTotalVoters,
  getMyReactions,
  hasVotedOnPoll,
  getPollOptionEmojis,
  isPollExpired,
} from './core/poll'
export type { PollTally } from './core/poll'

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
  validateBareJid,
} from './core/jid'
export type { ParsedJid, JidValidation } from './core/jid'

// MUC nickname hygiene / display (impersonation hardening)
export { stripNickWhitespace, splitNickForDisplay, resolveDefaultMucNick } from './core/nick'
export type { NickDisplay } from './core/nick'

// Service discovery utilities (XEP-0030 / XEP-0163)
export { discoSupportsPep } from './core/modules/Discovery'

// XMPP URI utilities (RFC 5122)
export { parseXmppUri, isMucJid } from './utils/xmppUri'
export type { XmppUri } from './utils/xmppUri'

// Login prefill utilities
export { normalizeLoginPrefill } from './utils/loginPrefill'
export type { LoginPrefill } from './utils/loginPrefill'

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
export { isPreviewableMessage } from './stores/shared/lastMessageUtils'

// Configuration constants
export { WELL_KNOWN_MUC_SERVERS } from './core/config'
export type { WellKnownMucServer } from './core/config'
// The resident-window bound (getResidentWindowSize/setResidentWindowSize) is a
// DEV/DEMO/TEST-only seam; it lives on the `@fluux/sdk/demo` dev-tooling entry,
// not the product API. SDK internals use it via a relative import.

// =============================================================================
// XMPP NAMESPACE CONSTANTS
// =============================================================================

// The 73 `NS_*` protocol namespaces are NOT exported here. A consumer that
// needs one is writing XMPP by hand, which the curated entry does not ask
// anyone to do; they live on the `@fluux/sdk/xmpp` escape hatch.

// =============================================================================
// XMPP PROTOCOL UTILITIES
// =============================================================================

// UUID generation utility
export { generateUUID, generateStableMessageId } from './utils/uuid'

// XEP-0426 character counting: wire offsets are code points, JS indices are
// UTF-16 units. These convert between the two and touch no stanza, so they
// stay here rather than on the escape hatch.
export { codePointLength, toCodePointOffset, fromCodePointOffset } from './utils/xep0426'

// A stanza delivery error, as carried by `BaseMessage.deliveryError`, and the
// human-readable rendering of one. Formatting is a product concern: by the time
// an app holds this value it is an ordinary field of a message. PARSING one out
// of a stanza is not, and lives on `@fluux/sdk/xmpp` with the other wire
// parsers (data forms, RSM, fallback indication).
export { formatXMPPError } from './utils/xmppError'
export type { XMPPStanzaError, XMPPErrorType } from './utils/xmppError'

// The per-key latest-wins coalescing buffer (keyedCoalescer) is a generic,
// non-XMPP primitive and is intentionally NOT part of the product API — the
// app owns its own notification coalescer, and the SDK keeps an internal copy
// for side effects (core/mdsSideEffects) via a relative import.

// Transport error classification and humanization
export { classifyConnectionError, extractTransportErrorClass, humanizeTransportError } from './core/modules/transportErrors'
export type { ConnectionErrorKind } from './core/modules/transportErrors'

// The failures a caller distinguishes by type rather than by message.
export { FastTokenLogoutError, RoomJoinError, WhisperCounterpartGoneError, HatCommandError, RequestTimeoutError } from './core/errors'
// The reason a join failed, stated in the application's terms. Exported with
// its resolver so a consumer can classify a condition it obtained elsewhere.
export { roomJoinReasonFor } from './core/errors'
export type { RoomJoinReason } from './core/errors'

// XEP-0045: MUC Permission Utilities
export { canSetAffiliation, canSetRole, canKick, canBan, canModerate, getAvailableAffiliations, getAvailableRoles } from './utils/mucPermissions'

// XEP-0156: Discovering Alternative XMPP Connection Methods
export { discoverWebSocket, discoverXmppEndpoints } from './utils/websocketDiscovery'
export type { DiscoveryResult } from './utils/websocketDiscovery'

// =============================================================================
// PLATFORM UTILITIES
// =============================================================================

// FAST token utilities (XEP-0484)
export { createInMemoryFastTokenStorage, hasFastToken, deleteFastToken } from './core/fastTokenStorage'
export type { FastToken, FastTokenStorageAdapter } from './core/fastTokenStorage'

// SASL2 user-agent identity (XEP-0388 §2.2)
// - id: stable per-device UUID, bound to by FAST tokens
// - device name: user-visible label in other clients' session lists
export {
  getUserAgentId,
  clearUserAgentIdentity,
  getUserAgentDeviceName,
  setUserAgentDeviceName,
  getEffectiveDeviceName,
} from './core/userAgent'

// Storage adapters for session persistence
export { sessionStorageAdapter } from './utils/sessionStorageAdapter'
export type { StorageAdapter, SessionState, StoredCredentials, JoinedRoomInfo } from './core/types'

// Flush throttled localStorage writes. Call synchronously on app quit — the
// generic `flush` name is meaningless at the package boundary.
export { flush as flushPersistentStorage } from './stores/shared/throttledStorage'

// Proxy adapter for WebSocket-to-TCP bridging (desktop apps)
export type { ProxyAdapter, ProxyStartResult } from './core/types'

// Emoji shortcode utilities (for clients that send :shortcodes: instead of Unicode)
export { shortcodeToEmoji, convertShortcodes } from './core/emoji'

// Mention detection utilities (for clients detecting IRC-style mentions)
export { checkForMention, findMentionRanges, findIrcPrefixRange } from './core/mentionDetection'

// =============================================================================
// INDEXEDDB MESSAGE / AVATAR CACHE
// =============================================================================

// The low-level IndexedDB cache accessors live on the `@fluux/sdk/cache`
// subpath — an advanced escape hatch, kept off the curated main entry because
// their write/delete ops bypass store invariants. See src/cache/index.ts.

// =============================================================================
// DEMO MODE
// =============================================================================

// Demo mode is a dev-only tool and lives on the `@fluux/sdk/demo` subpath so it
// is tree-shaken out of production app bundles. It is intentionally NOT
// re-exported here — see src/demo/index.ts.
