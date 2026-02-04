/**
 * Comprehensive SDK event types for event-based decoupling.
 *
 * These events are emitted by XMPPClient modules and can be subscribed to
 * for store updates (React-SDK) or custom handling (bots, other frameworks).
 *
 * @packageDocumentation
 * @module Types/SDKEvents
 */

import type { Element } from '@xmpp/client'
import type { Message, Conversation } from './chat'
import type { Contact, PresenceShow } from './roster'
import type { Room, RoomOccupant, RoomMessage } from './room'
import type { ServerInfo } from './discovery'
import type { HttpUploadService } from './upload'
import type { AdminCommand, AdminSession } from './admin'
import type { RSMResponse } from './pagination'
import type { MAMQueryDirection } from '../../stores/shared/mamState'
import type { SystemNotificationType } from './events'
import type { XMPPErrorType } from '../../utils/xmppError'

// ============================================================================
// Connection Events
// ============================================================================

export interface ConnectionEvents {
  /** Connection status changed */
  'connection:status': {
    status: 'connecting' | 'online' | 'offline' | 'error' | 'reconnecting'
    error?: string
  }

  /** Successfully authenticated */
  'connection:authenticated': {
    jid: string
  }

  /** Reconnection attempt */
  'connection:reconnecting': {
    attempt: number
    delayMs: number
  }

  /** Server info discovered */
  'connection:server-info': {
    info: ServerInfo | null
  }

  /** HTTP upload service discovered */
  'connection:http-upload-service': {
    service: HttpUploadService | null
  }

  /** Own avatar changed */
  'connection:own-avatar': {
    avatar: string | null
    hash?: string | null
  }

  /** Own nickname changed */
  'connection:own-nickname': {
    nickname: string | null
  }

  /** Own resource presence updated */
  'connection:own-resource': {
    resource: string
    show: PresenceShow | null
    priority: number
    status?: string
    lastInteraction?: Date
    client?: string
  }

  /** Own resource went offline */
  'connection:own-resource-offline': {
    resource: string
  }
}

// ============================================================================
// Chat Events (1:1 Messaging)
// ============================================================================

export interface ChatEvents {
  /** New message received or sent */
  'chat:message': {
    message: Message
  }

  /** New conversation created */
  'chat:conversation': {
    conversation: Conversation
  }

  /** Conversation name updated */
  'chat:conversation-name': {
    conversationId: string
    name: string
  }

  /** Typing indicator changed */
  'chat:typing': {
    conversationId: string
    jid: string
    isTyping: boolean
  }

  /** Reactions updated on a message */
  'chat:reactions': {
    conversationId: string
    messageId: string
    reactorJid: string
    emojis: string[]
  }

  /** Message updated (correction, retraction, link preview) */
  'chat:message-updated': {
    conversationId: string
    messageId: string
    updates: Partial<Message>
  }

  /** Animation triggered (easter egg) */
  'chat:animation': {
    conversationId: string
    animation: string
  }

  /** MAM loading state changed */
  'chat:mam-loading': {
    conversationId: string
    isLoading: boolean
  }

  /** MAM error occurred */
  'chat:mam-error': {
    conversationId: string
    error: string | null
  }

  /** MAM messages loaded */
  'chat:mam-messages': {
    conversationId: string
    messages: Message[]
    rsm: RSMResponse
    complete: boolean
    direction: MAMQueryDirection
  }
}

// ============================================================================
// Room Events (MUC)
// ============================================================================

export interface RoomEvents {
  /** Room added or updated from bookmarks */
  'room:added': {
    room: Room
  }

  /** Room properties updated */
  'room:updated': {
    roomJid: string
    updates: Partial<Room>
  }

  /** Room removed */
  'room:removed': {
    roomJid: string
  }

  /** Room join status changed */
  'room:joined': {
    roomJid: string
    joined: boolean
  }

  /** Occupant joined room */
  'room:occupant-joined': {
    roomJid: string
    occupant: RoomOccupant
  }

  /** Batch of occupants joined (initial presence flood) */
  'room:occupants-batch': {
    roomJid: string
    occupants: RoomOccupant[]
  }

  /** Occupant left room */
  'room:occupant-left': {
    roomJid: string
    nick: string
  }

  /** Self occupant set (own presence in room) */
  'room:self-occupant': {
    roomJid: string
    occupant: RoomOccupant
  }

  /** Room message received */
  'room:message': {
    roomJid: string
    message: RoomMessage
    incrementUnread?: boolean
    incrementMentions?: boolean
  }

  /** Room message updated */
  'room:message-updated': {
    roomJid: string
    messageId: string
    updates: Partial<RoomMessage>
  }

  /** Reactions updated on room message */
  'room:reactions': {
    roomJid: string
    messageId: string
    reactorNick: string
    emojis: string[]
  }

  /** Room subject changed */
  'room:subject': {
    roomJid: string
    subject: string
  }

  /** Typing indicator in room */
  'room:typing': {
    roomJid: string
    nick: string
    isTyping: boolean
  }

  /** Bookmark set/updated */
  'room:bookmark': {
    roomJid: string
    bookmark: {
      name: string
      nick: string
      autojoin?: boolean
      password?: string
      notifyAll?: boolean
    }
  }

  /** Bookmark removed */
  'room:bookmark-removed': {
    roomJid: string
  }

  /** Room animation triggered */
  'room:animation': {
    roomJid: string
    animation: string
  }

  /** Room MAM loading state */
  'room:mam-loading': {
    roomJid: string
    isLoading: boolean
  }

  /** Room MAM error */
  'room:mam-error': {
    roomJid: string
    error: string | null
  }

  /** MUC invitation rejected by server (e.g., forbidden in members-only room) */
  'room:invite-error': {
    roomJid: string
    /** Human-readable error message (prefers server text, falls back to formatted condition) */
    error: string
    /** RFC 6120 error condition (e.g. 'forbidden', 'not-allowed') */
    condition: string
    /** RFC 6120 error type category (cancel, auth, modify, wait, continue) */
    errorType: XMPPErrorType
  }

  /** Room MAM messages loaded */
  'room:mam-messages': {
    roomJid: string
    messages: RoomMessage[]
    rsm: RSMResponse
    complete: boolean
    direction: MAMQueryDirection
  }
}

// ============================================================================
// Roster Events
// ============================================================================

export interface RosterEvents {
  /** Full roster loaded */
  'roster:loaded': {
    contacts: Contact[]
  }

  /** Contact added or updated */
  'roster:contact': {
    contact: Contact
  }

  /** Contact properties updated */
  'roster:contact-updated': {
    jid: string
    updates: Partial<Contact>
  }

  /** Contact removed */
  'roster:contact-removed': {
    jid: string
  }

  /** Contact presence updated */
  'roster:presence': {
    fullJid: string
    show: PresenceShow | null
    priority: number
    statusMessage?: string
    lastInteraction?: Date
    client?: string
  }

  /** Contact went offline */
  'roster:presence-offline': {
    fullJid: string
  }

  /** Presence error for contact */
  'roster:presence-error': {
    jid: string
    error: string
  }

  /** Contact avatar updated */
  'roster:avatar': {
    jid: string
    avatar: string | null
    avatarHash?: string
  }
}

// ============================================================================
// Events Store Events (Notifications)
// ============================================================================

export interface NotificationEvents {
  /** Subscription request received */
  'events:subscription-request': {
    from: string
  }

  /** Subscription request handled */
  'events:subscription-request-removed': {
    from: string
  }

  /** Message from non-contact (stranger) */
  'events:stranger-message': {
    from: string
    body: string
  }

  /** Stranger messages cleared */
  'events:stranger-messages-removed': {
    from: string
  }

  /** MUC invitation received */
  'events:muc-invitation': {
    roomJid: string
    from: string
    reason?: string
    password?: string
    isDirect?: boolean
    isQuickChat?: boolean
  }

  /** MUC invitation handled */
  'events:muc-invitation-removed': {
    roomJid: string
  }

  /** System notification */
  'events:system-notification': {
    type: SystemNotificationType
    title: string
    message: string
  }
}

// ============================================================================
// Blocking Events
// ============================================================================

export interface BlockingEvents {
  /** Full blocklist loaded */
  'blocking:list': {
    jids: string[]
  }

  /** JIDs added to blocklist */
  'blocking:added': {
    jids: string[]
  }

  /** JIDs removed from blocklist */
  'blocking:removed': {
    jids: string[]
  }

  /** Blocklist cleared */
  'blocking:cleared': Record<string, never>
}

// ============================================================================
// Admin Events
// ============================================================================

export interface AdminEvents {
  /** Admin status changed */
  'admin:is-admin': {
    isAdmin: boolean
  }

  /** Admin commands discovered */
  'admin:commands': {
    commands: AdminCommand[]
  }

  /** Admin session changed */
  'admin:session': {
    session: AdminSession | null
  }

  /** Discovering admin commands */
  'admin:discovering': {
    isDiscovering: boolean
  }

  /** Executing admin command */
  'admin:executing': {
    isExecuting: boolean
  }

  /** Entity counts updated */
  'admin:entity-counts': {
    counts: {
      users?: number
      onlineUsers?: number
      rooms?: number
    }
  }

  /** Virtual hosts discovered */
  'admin:vhosts': {
    vhosts: string[]
  }

  /** Selected virtual host changed */
  'admin:selected-vhost': {
    vhost: string
  }

  /** MUC service discovered */
  'admin:muc-service': {
    mucServiceJid: string
  }

  /** MUC service MAM support discovered */
  'admin:muc-service-mam': {
    supportsMAM: boolean
  }
}

// ============================================================================
// Console/Debug Events
// ============================================================================

export interface ConsoleEvents {
  /** Debug event logged */
  'console:event': {
    message: string
    category?: 'connection' | 'error' | 'sm' | 'presence'
  }

  /** Raw packet logged */
  'console:packet': {
    direction: 'incoming' | 'outgoing'
    xml: string
  }
}

// ============================================================================
// Raw Stanza Events (for advanced usage)
// ============================================================================

export interface StanzaEvents {
  /** Raw XMPP stanza received */
  'stanza': {
    stanza: Element
  }
}

// ============================================================================
// Combined SDK Events
// ============================================================================

/**
 * All SDK events combined.
 *
 * This interface defines all events that can be emitted by the SDK.
 * Use with `client.on(event, handler)` to subscribe.
 *
 * @example
 * ```typescript
 * // Bot listening to messages
 * client.on('chat:message', ({ message }) => {
 *   console.log(`${message.from}: ${message.body}`)
 * })
 *
 * // React-SDK wiring events to stores
 * client.on('chat:message', ({ message }) => {
 *   useChatStore.getState().addMessage(message)
 * })
 * ```
 */
export interface SDKEvents
  extends ConnectionEvents,
    ChatEvents,
    RoomEvents,
    RosterEvents,
    NotificationEvents,
    BlockingEvents,
    AdminEvents,
    ConsoleEvents,
    StanzaEvents {}

/**
 * Helper type to get event payload by event name.
 */
export type SDKEventPayload<K extends keyof SDKEvents> = SDKEvents[K]

/**
 * Helper type for event handler function.
 */
export type SDKEventHandler<K extends keyof SDKEvents> = (payload: SDKEvents[K]) => void
