/**
 * Core type definitions for the Fluux SDK.
 *
 * This module re-exports all public types and interfaces used throughout the SDK,
 * organized by domain for better maintainability.
 *
 * @packageDocumentation
 * @module Types
 */

// Connection types
export type { ConnectionStatus, ConnectionMethod, ConnectOptions, SystemState } from './connection'

// Base message type (shared between chat and room messages)
export type { BaseMessage } from './message-base'

// Chat types
export type {
  ChatStateNotification,
  ReplyInfo,
  MentionReference,
  Message,
  ConversationEntity,
  ConversationMetadata,
  Conversation,
} from './chat'

// Roster types
export type {
  PresenceStatus,
  PresenceShow,
  ResourcePresence,
  Contact,
} from './roster'

// Room/MUC types
export type {
  RoomAffiliation,
  RoomRole,
  Hat,
  RoomOccupant,
  RoomMessage,
  RoomEntity,
  RoomMetadata,
  RoomRuntime,
  Room,
} from './room'

// Event types
export type {
  SubscriptionRequest,
  StrangerMessage,
  MucInvitation,
  SystemNotificationType,
  SystemNotification,
} from './events'

// Console types
export type {
  ConsoleEntryType,
  XmppPacket,
} from './console'

// Discovery types
export type {
  ServerIdentity,
  ServerInfo,
} from './discovery'

// Web Push types
export type {
  WebPushService,
  WebPushRegistration,
  WebPushStatus,
} from './webpush'

// Upload/attachment types
export type {
  HttpUploadService,
  UploadSlot,
  ThumbnailInfo,
  OobInfo,
  FileAttachment,
} from './upload'

// Media types
export type { LinkPreview } from './media'

// Pagination types
export type {
  RSMRequest,
  RSMResponse,
  MAMQueryOptions,
  MAMResult,
  MAMQueryState,
  RoomMAMQueryOptions,
  RoomMAMResult,
} from './pagination'

// Admin types
export type {
  AdminCommandCategory,
  AdminCommand,
  DataFormFieldType,
  DataFormFieldOption,
  DataFormField,
  DataFormType,
  DataForm,
  AdminSessionStatus,
  AdminNoteType,
  AdminNote,
  AdminSession,
  AdminUser,
  AdminRoom,
  EntityListState,
  EntityCounts,
  AdminCategory,
} from './admin'

// Client types
export type {
  StoreBindings,
  XMPPClientEvents,
  XMPPClientConfig,
  PresenceOptions,
  PrivacyOptions,
} from './client'

// Storage types
export type {
  JoinedRoomInfo,
  SessionState,
  StoredCredentials,
  StorageAdapter,
} from './storage'

// Proxy types
export type {
  ProxyStartResult,
  ProxyAdapter,
} from './proxy'

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
} from './sdk-events'

// ----- Discriminated Union Types -----

import type { Message } from './chat'
import type { RoomMessage } from './room'

/**
 * Union type for any message (1:1 chat or MUC room).
 *
 * Use the `type` discriminator to narrow:
 * - `'chat'` - {@link Message} (1:1 conversation)
 * - `'groupchat'` - {@link RoomMessage} (MUC room)
 *
 * @example
 * ```typescript
 * function getMessageContext(msg: AnyMessage): string {
 *   if (isChatMessage(msg)) {
 *     return `Chat with ${msg.conversationId}`
 *   } else {
 *     return `Room ${msg.roomJid} by ${msg.nick}`
 *   }
 * }
 * ```
 *
 * @category Chat
 */
export type AnyMessage = Message | RoomMessage

/**
 * Type guard for 1:1 chat messages.
 *
 * @param msg - Message to check
 * @returns True if message is a 1:1 chat message
 *
 * @example
 * ```typescript
 * if (isChatMessage(msg)) {
 *   console.log('Conversation:', msg.conversationId)
 * }
 * ```
 *
 * @category Chat
 */
export function isChatMessage(msg: AnyMessage): msg is Message {
  return msg.type === 'chat'
}

/**
 * Type guard for MUC room messages.
 *
 * @param msg - Message to check
 * @returns True if message is a MUC room message
 *
 * @example
 * ```typescript
 * if (isRoomMessage(msg)) {
 *   console.log('Room:', msg.roomJid, 'Nick:', msg.nick)
 * }
 * ```
 *
 * @category MUC
 */
export function isRoomMessage(msg: AnyMessage): msg is RoomMessage {
  return msg.type === 'groupchat'
}
