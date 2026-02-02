/**
 * XMPP client type definitions including store bindings and events.
 *
 * @packageDocumentation
 * @module Types/Client
 */

import type { Element } from '@xmpp/client'
import type { ConnectionStatus } from './connection'
import type { Message, Conversation } from './chat'
import type { PresenceStatus, PresenceShow, Contact } from './roster'
import type { Room, RoomOccupant, RoomMessage } from './room'
import type { SystemNotificationType } from './events'
import type { ServerInfo } from './discovery'
import type { HttpUploadService } from './upload'
import type { RSMResponse, MAMQueryState } from './pagination'
import type { MAMQueryDirection } from '../../stores/shared/mamState'
import type { AdminCommand, AdminSession, EntityCounts } from './admin'
import type { StorageAdapter } from './storage'

// ============================================================================
// Store Bindings (Internal)
// ============================================================================

/**
 * Store bindings interface for injecting store methods into XMPPClient.
 *
 * @internal
 * This interface is used internally by XMPPProvider to bind Zustand stores
 * to the XMPP client. Application code should use the React hooks instead.
 *
 * @category Internal
 */
export interface StoreBindings {
  connection: {
    setStatus: (status: ConnectionStatus) => void
    getStatus: () => ConnectionStatus
    setJid: (jid: string | null) => void
    setError: (error: string | null) => void
    setReconnectState: (attempt: number, reconnectIn: number | null) => void
    setPresenceState: (show: PresenceStatus, message?: string | null) => void
    setAutoAway: (isAuto: boolean) => void
    setServerInfo: (info: ServerInfo | null) => void
    // Getters for presence preservation on reconnect
    getPresenceShow: () => PresenceStatus
    getStatusMessage: () => string | null
    getIsAutoAway: () => boolean
    // Pre-auto-away state (for restoring from auto-away/sleep)
    getPreAutoAwayState: () => PresenceStatus | null
    getPreAutoAwayStatusMessage: () => string | null
    clearPreAutoAwayState: () => void
    // Own profile state
    setOwnAvatar: (avatar: string | null, hash?: string | null) => void
    setOwnNickname: (nickname: string | null) => void
    getOwnNickname: () => string | null
    updateOwnResource: (resource: string, show: PresenceShow | null, priority: number, status?: string, lastInteraction?: Date, client?: string) => void
    removeOwnResource: (resource: string) => void
    clearOwnResources: () => void
    getJid: () => string | null
    // HTTP Upload (XEP-0363)
    setHttpUploadService: (service: HttpUploadService | null) => void
    getHttpUploadService: () => HttpUploadService | null
    // Server info getter (for MAM support detection)
    getServerInfo?: () => ServerInfo | null
  }
  chat: {
    addMessage: (message: Message) => void
    addConversation: (conversation: Conversation) => void
    updateConversationName: (id: string, name: string) => void
    hasConversation: (id: string) => boolean
    setTyping: (conversationId: string, jid: string, isTyping: boolean) => void
    updateReactions: (conversationId: string, messageId: string, reactorJid: string, emojis: string[]) => void
    updateMessage: (conversationId: string, messageId: string, updates: Partial<Message>) => void
    getMessage: (conversationId: string, messageId: string) => Message | undefined
    triggerAnimation?: (conversationId: string, animation: string) => void
    // XEP-0313: MAM support
    setMAMLoading: (conversationId: string, isLoading: boolean) => void
    setMAMError: (conversationId: string, error: string | null) => void
    mergeMAMMessages: (conversationId: string, messages: Message[], rsm: RSMResponse, complete: boolean, direction: MAMQueryDirection) => void
    getMAMQueryState: (conversationId: string) => MAMQueryState
    resetMAMStates: () => void
    // Lazy MAM: mark conversations as needing catch-up after reconnect
    markAllNeedsCatchUp: () => void
    clearNeedsCatchUp: (conversationId: string) => void
    // Update sidebar preview without affecting message history
    updateLastMessagePreview: (conversationId: string, lastMessage: Message) => void
    // Get all conversations for MAM catch-up
    getAllConversations: () => Array<{ id: string; messages: Message[] }>
  }
  roster: {
    setContacts: (contacts: Contact[]) => void
    addOrUpdateContact: (contact: Contact) => void
    updateContact: (jid: string, update: Partial<Contact>) => void
    updatePresence: (
      fullJid: string,  // Full JID with resource (e.g., user@example.com/mobile)
      show: PresenceShow | null,  // null = online, or 'away'/'xa'/'dnd'/'chat'
      priority: number,
      statusMessage?: string,
      lastInteraction?: Date,
      client?: string  // Client name from XEP-0115 Entity Capabilities
    ) => void
    removePresence: (fullJid: string) => void  // Called on unavailable presence
    setPresenceError: (jid: string, error: string) => void
    updateAvatar: (jid: string, avatar: string | null, avatarHash?: string) => void
    removeContact: (jid: string) => void
    hasContact: (jid: string) => boolean
    getContact: (jid: string) => Contact | undefined
    getOfflineContacts: () => Contact[]
    sortedContacts: () => Contact[]
    resetAllPresence: () => void
  }
  console: {
    addPacket: (direction: 'incoming' | 'outgoing', xml: string) => void
    addEvent: (message: string, category?: 'connection' | 'error' | 'sm' | 'presence') => void
  }
  events: {
    addSubscriptionRequest: (from: string) => void
    removeSubscriptionRequest: (from: string) => void
    addStrangerMessage: (from: string, body: string) => void
    removeStrangerMessages: (from: string) => void
    addMucInvitation: (roomJid: string, from: string, reason?: string, password?: string, isDirect?: boolean, isQuickChat?: boolean) => void
    removeMucInvitation: (roomJid: string) => void
    addSystemNotification: (type: SystemNotificationType, title: string, message: string) => void
    clearSystemNotifications: () => void
  }
  room: {
    addRoom: (room: Room) => void
    updateRoom: (roomJid: string, update: Partial<Room>) => void
    removeRoom: (roomJid: string) => void
    setRoomJoined: (roomJid: string, joined: boolean) => void
    addOccupant: (roomJid: string, occupant: RoomOccupant) => void
    batchAddOccupants: (roomJid: string, occupants: RoomOccupant[]) => void
    removeOccupant: (roomJid: string, nick: string) => void
    setSelfOccupant: (roomJid: string, occupant: RoomOccupant) => void
    getRoom: (roomJid: string) => Room | undefined
    addMessage: (roomJid: string, message: RoomMessage, options?: {
      incrementUnread?: boolean
      incrementMentions?: boolean
    }) => void
    updateReactions: (roomJid: string, messageId: string, reactorNick: string, emojis: string[]) => void
    updateMessage: (roomJid: string, messageId: string, updates: Partial<RoomMessage>) => void
    getMessage: (roomJid: string, messageId: string) => RoomMessage | undefined
    markAsRead: (roomJid: string) => void
    getActiveRoomJid: () => string | null
    setTyping: (roomJid: string, nick: string, isTyping: boolean) => void
    // Bookmark methods
    setBookmark: (roomJid: string, bookmark: { name: string; nick: string; autojoin?: boolean; password?: string; notifyAll?: boolean }) => void
    removeBookmark: (roomJid: string) => void
    // Notification settings
    setNotifyAll: (roomJid: string, notifyAll: boolean, persistent?: boolean) => void
    // Query methods
    joinedRooms: () => Room[]
    // Easter egg animations
    triggerAnimation?: (roomJid: string, animation: string) => void
    // XEP-0313: MAM support for MUC rooms
    setRoomMAMLoading: (roomJid: string, isLoading: boolean) => void
    setRoomMAMError: (roomJid: string, error: string | null) => void
    mergeRoomMAMMessages: (roomJid: string, messages: RoomMessage[], rsm: RSMResponse, complete: boolean, direction: MAMQueryDirection) => void
    getRoomMAMQueryState: (roomJid: string) => MAMQueryState
    resetRoomMAMStates: () => void
    // Lazy MAM: mark rooms as needing catch-up after reconnect
    markAllRoomsNeedsCatchUp: () => void
    clearRoomNeedsCatchUp: (roomJid: string) => void
    // Preview refresh: update lastMessage without affecting message history
    updateLastMessagePreview: (roomJid: string, lastMessage: RoomMessage) => void
    // Load preview from cache for non-MAM rooms (only updates lastMessage, not messages array)
    loadPreviewFromCache: (roomJid: string) => Promise<RoomMessage | null>
  }
  admin: {
    setIsAdmin: (isAdmin: boolean) => void
    setCommands: (commands: AdminCommand[]) => void
    getCommands: () => AdminCommand[]
    setCurrentSession: (session: AdminSession | null) => void
    setIsDiscovering: (loading: boolean) => void
    setIsExecuting: (loading: boolean) => void
    getCurrentSession: () => AdminSession | null
    setEntityCounts: (counts: Partial<EntityCounts>) => void
    setMucServiceJid: (jid: string | null) => void
    getMucServiceJid: () => string | null
    setMucServiceSupportsMAM: (supportsMAM: boolean | null) => void
    getMucServiceSupportsMAM: () => boolean | null
    // Vhost management
    setVhosts: (vhosts: string[]) => void
    setSelectedVhost: (vhost: string | null) => void
    selectedVhost: string | null
    reset: () => void
  }
  blocking: {
    setBlocklist: (jids: string[]) => void
    addBlockedJids: (jids: string[]) => void
    removeBlockedJids: (jids: string[]) => void
    clearBlocklist: () => void
    isBlocked: (jid: string) => boolean
    getBlockedJids: () => string[]
  }
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
}
