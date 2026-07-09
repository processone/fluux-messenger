/**
 * XMPP client type definitions including store bindings and events.
 *
 * @packageDocumentation
 * @module Types/Client
 */

import type { Element } from '@xmpp/client'
import type { ConnectionStatus } from './connection'
import type { Message } from './chat'
import type { RoomMessage } from './room'
import type { PresenceStatus, Contact } from './roster'
import type { ServerInfo } from './discovery'
import type { HttpUploadService } from './upload'
import type { WebPushService } from './webpush'
import type { AdminCommand, AdminSession } from './admin'
import type { StorageAdapter } from './storage'
import type { ProxyAdapter } from './proxy'
import type {
  ConnectionState,
  ChatState,
  RosterState,
  ConsoleState,
  EventsState,
  RoomState,
  AdminState,
  BlockingState,
} from '../../stores'
import {
  connectionBindingMethodKeys,
  chatBindingMethodKeys,
  rosterBindingMethodKeys,
  consoleBindingMethodKeys,
  eventsBindingMethodKeys,
  roomBindingMethodKeys,
  adminBindingMethodKeys,
  blockingBindingMethodKeys,
} from '../storeBindingKeys'

// ============================================================================
// Store Bindings (Internal)
// ============================================================================

/**
 * Store bindings interface for injecting store methods into XMPPClient.
 *
 * The bulk of each namespace is DERIVED from the corresponding store state
 * type via the key lists in storeBindingKeys.ts — the store's method
 * signature is the binding's signature, by construction. Only three kinds of
 * members are declared here by hand:
 *
 * - presence-machine bridge members (`Required<PresenceOptions>`) — they come
 *   from an external state machine, not a store
 * - plain state getters (`getStatus`, `getJid`, …)
 * - composite getters with real logic (`getAllConversations`, …)
 *
 * @internal
 * This interface is used internally by XMPPProvider to bind Zustand stores
 * to the XMPP client. Application code should use the React hooks instead.
 *
 * @category Internal
 */
export interface StoreBindings {
  connection: Pick<ConnectionState, (typeof connectionBindingMethodKeys)[number]> & {
      // State getters
      getStatus: () => ConnectionStatus
      getOwnNickname: () => string | null
      getJid: () => string | null
      getHttpUploadService: () => HttpUploadService | null
      getWebPushServices: () => WebPushService[]
      getWebPushEnabled: () => boolean
      // Server info getter (for MAM support detection)
      getServerInfo?: () => ServerInfo | null
    }
  chat: Pick<ChatState, (typeof chatBindingMethodKeys)[number]> & {
    // Get all conversations for MAM catch-up
    getAllConversations: () => Array<{ id: string; messages: Message[] }>
    // Persisted forward-gap boundary for automatic catch-up recovery
    getConversationGapStart?: (conversationId: string) => number | undefined
    // XEP-0490 stanza-id of the remote read position, kept unresolved when it
    // can't be matched locally — seeds a forward `after` catch-up on an
    // empty-cache new device.
    getConversationPendingStanzaId?: (conversationId: string) => string | undefined
    // Smart MAM: archived conversation preview refresh
    getArchivedConversations?: () => Array<{ id: string; messages: Message[] }>
    getLastMessage?: (conversationId: string) => Message | undefined
    // Every stored conversation (archived INCLUDED) with its in-memory
    // messages. Read seam for the deferred-decrypt engine, which must retry
    // pending encrypted payloads regardless of archive state — unlike
    // getAllConversations, which returns only the active set.
    getAllStoredMessages: () => Array<{ id: string; messages: Message[] }>
    // In-memory messages for a single conversation (archived included). Read
    // seam for peer-scoped deferred-decrypt retry on a PEP key change.
    getConversationMessages: (conversationId: string) => Message[]
  }
  roster: Pick<RosterState, (typeof rosterBindingMethodKeys)[number]>
  console: Pick<ConsoleState, (typeof consoleBindingMethodKeys)[number]>
  events: Pick<EventsState, (typeof eventsBindingMethodKeys)[number]>
  room: Pick<RoomState, (typeof roomBindingMethodKeys)[number]> & {
    // Persisted forward-gap boundary for automatic catch-up recovery
    getRoomGapStart?: (roomJid: string) => number | undefined
    // XEP-0490 stanza-id of the remote read position, kept unresolved when it
    // can't be matched locally — seeds a forward `after` catch-up on an
    // empty-cache new device.
    getRoomPendingStanzaId?: (roomJid: string) => string | undefined
    // Every room with its in-memory runtime messages. Read seam for the
    // deferred-decrypt engine (mirrors chat.getAllStoredMessages for MUC).
    getAllRoomMessages: () => Array<{ jid: string; messages: RoomMessage[] }>
  }
  admin: Pick<AdminState, (typeof adminBindingMethodKeys)[number]> & {
    // State getters
    getCommands: () => AdminCommand[]
    getCurrentSession: () => AdminSession | null
    getMucServiceJid: () => string | null
    selectedVhost: string | null
  }
  blocking: Pick<BlockingState, (typeof blockingBindingMethodKeys)[number]>
}

// ============================================================================
// XMPP Client Events
// ============================================================================

/**
 * Events emitted by XMPPClient.
 *
 * Use `client.on(event, handler)` to subscribe to these events.
 *
 * @example
 * ```typescript
 * client.on('message', (msg) => console.log('New message:', msg.body))
 * client.on('online', () => console.log('Connected!'))
 * client.on('error', (err) => console.error('Error:', err))
 * ```
 *
 * @category Core
 */
export interface XMPPClientEvents {
  /** Raw XMPP stanza received */
  stanza: (stanza: Element) => void
  /** New chat message received */
  message: (message: Message) => void
  /** Contact presence changed */
  presence: (jid: string, presence: PresenceStatus, statusMessage?: string) => void
  /** Roster (contact list) updated */
  roster: (contacts: Contact[]) => void
  /** Client is now online and ready */
  online: () => void
  /** Client disconnected */
  offline: () => void
  /** Stream Management session resumed */
  resumed: () => void
  /** Attempting to reconnect */
  reconnecting: (attempt: number, delayMs: number) => void
  /** Error occurred */
  error: (error: Error) => void
  /** Avatar metadata update received (XEP-0084) - hash is null when avatar removed */
  avatarMetadataUpdate: (jid: string, hash: string | null) => void
  /** Contact presence has empty XEP-0153 photo - may use XEP-0084 instead */
  contactMissingXep0153Avatar: (jid: string) => void
  /** Successfully joined a MUC room */
  mucJoined: (roomJid: string, nickname: string) => void
  /** Room avatar updated */
  roomAvatarUpdate: (roomJid: string, photoHash: string) => void
  /** MUC occupant avatar hash received (XEP-0398) */
  occupantAvatarUpdate: (roomJid: string, nick: string, hash: string, realJid?: string) => void
  /** Roster (contact list) fully loaded from server */
  rosterLoaded: () => void
}

/**
 * Options for integrating an external presence state machine.
 *
 * When using XState for presence management (like in React apps with XMPPProvider),
 * provide these getters and setters to integrate the presence machine with XMPP.
 *
 * @category Core
 */
export interface PresenceOptions {
  /** Get current presence status from the state machine */
  getPresenceShow?: () => 'online' | 'away' | 'dnd' | 'offline'
  /** Get current status message */
  getStatusMessage?: () => string | null
  /** Check if currently in auto-away state */
  getIsAutoAway?: () => boolean
  /** Get the state before auto-away was triggered */
  getPreAutoAwayState?: () => 'online' | 'away' | 'dnd' | 'offline' | null
  /** Get the status message before auto-away */
  getPreAutoAwayStatusMessage?: () => string | null
  /** Set presence state (sends event to state machine) */
  setPresenceState?: (show: 'online' | 'away' | 'dnd' | 'offline', message?: string | null) => void
  /** Set auto-away flag */
  setAutoAway?: (isAuto: boolean) => void
  /** Clear pre-auto-away state */
  clearPreAutoAwayState?: () => void
}

/**
 * Privacy options for the XMPP client.
 *
 * These options control privacy-sensitive behaviors that users may want to disable
 * in certain contexts, such as semi-anonymous MUC rooms.
 *
 * @category Core
 */
export interface PrivacyOptions {
  /**
   * Disable automatic avatar fetching for MUC occupants in semi-anonymous rooms.
   *
   * In semi-anonymous MUC rooms, the user's real JID is not exposed. Fetching
   * avatars via the occupant's room JID (room@conf/nick) reveals to the server
   * that you're interested in that user's vCard, which may be a privacy concern.
   *
   * When enabled:
   * - Avatars are still fetched for non-anonymous rooms (where real JIDs are visible)
   * - Avatars are still fetched from roster contacts
   * - Only avatar fetching via room occupant JIDs is disabled
   *
   * @default false
   */
  disableOccupantAvatarsInAnonymousRooms?: boolean
}

/**
 * XMPPClient configuration options.
 *
 * @category Core
 */
export interface XMPPClientConfig {
  /** Enable debug logging */
  debug?: boolean
  /**
   * Options for integrating an external presence state machine.
   * Only needed when using XState for presence management (e.g., in React apps).
   * Bots typically don't need this - default presence handling is sufficient.
   */
  presenceOptions?: PresenceOptions
  /**
   * Privacy options for controlling data exposure.
   * @see {@link PrivacyOptions}
   */
  privacyOptions?: PrivacyOptions
  /**
   * Storage adapter for session persistence.
   *
   * Provides platform-specific storage for:
   * - XEP-0198 Stream Management session state (for fast reconnection)
   * - User credentials (for "Remember Me" functionality)
   * - Cached roster, rooms, and server info (for faster startup)
   *
   * The SDK provides `sessionStorageAdapter` as a default for web apps.
   * Desktop apps can provide a custom adapter using OS keychain.
   *
   * @example
   * ```tsx
   * // Web app - uses default sessionStorageAdapter
   * <XMPPProvider>
   *   <App />
   * </XMPPProvider>
   *
   * // Desktop app with OS keychain
   * <XMPPProvider storageAdapter={tauriStorageAdapter}>
   *   <App />
   * </XMPPProvider>
   * ```
   */
  storageAdapter?: StorageAdapter
  /**
   * Proxy adapter for WebSocket-to-TCP bridging.
   *
   * Desktop apps can provide a proxy adapter to enable native TCP/TLS
   * connections to XMPP servers instead of WebSocket.
   *
   * When provided, the SDK will use this adapter to start/stop the proxy
   * for each connection. When not provided, connections use WebSocket directly.
   *
   * @example
   * ```tsx
   * <XMPPProvider proxyAdapter={tauriProxyAdapter}>
   *   <App />
   * </XMPPProvider>
   * ```
   */
  proxyAdapter?: ProxyAdapter
  /**
   * Pull-based predicate the SDK evaluates before each automatic reconnect
   * attempt. Return `false` to suppress auto-reconnect (e.g., after an
   * explicit logout). Evaluated live — no cached copy. Defaults to always-on.
   */
  shouldAutoReconnect?: () => boolean
}
