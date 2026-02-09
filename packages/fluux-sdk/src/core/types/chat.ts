/**
 * Chat and messaging type definitions.
 *
 * @packageDocumentation
 * @module Types/Chat
 */

import type { BaseMessage } from './message-base'

/**
 * Chat state notification types (XEP-0085).
 *
 * Used to indicate typing status in conversations.
 *
 * @remarks
 * - `active` - User is actively participating
 * - `composing` - User is currently typing
 * - `paused` - User was typing but has stopped
 * - `inactive` - User has not interacted recently
 * - `gone` - User has left the conversation
 *
 * @category Chat
 */
export type ChatStateNotification = 'active' | 'composing' | 'paused' | 'inactive' | 'gone'

/**
 * Reply information for threaded messages (XEP-0461).
 *
 * Contains metadata about which message is being replied to.
 *
 * @category Chat
 */
export interface ReplyInfo {
  /** ID of the message being replied to */
  id: string
  /** JID of the original message author (for MUC context) */
  to?: string
  /** XEP-0428: Fallback text to display when original message is not available */
  fallbackBody?: string
}

/**
 * Mention reference for \@mentions in messages (XEP-0372).
 *
 * Identifies a mention within the message body by character position.
 *
 * @category Chat
 */
export interface MentionReference {
  /** Start index (inclusive, Unicode code points) */
  begin: number
  /** End index (exclusive, Unicode code points) */
  end: number
  /** Reference type (always 'mention' for mentions) */
  type: 'mention'
  /** XMPP URI: 'xmpp:room@conf/nick' for user, 'xmpp:room@conf' for \@all */
  uri: string
}

/**
 * A chat message in a 1:1 conversation.
 *
 * Extends {@link BaseMessage} with 1:1 chat specific fields.
 * Use the `type: 'chat'` discriminator to distinguish from {@link RoomMessage}.
 *
 * @category Chat
 */
export interface Message extends Omit<BaseMessage, 'type'> {
  /** Message type discriminator - always 'chat' for 1:1 messages */
  type: 'chat'
  /** Bare JID of the conversation partner */
  conversationId: string
}

/**
 * Stable conversation identity - rarely changes after creation.
 *
 * Entity data is separated from metadata to enable fine-grained subscriptions.
 * Components that only need identity info can subscribe to entities without
 * re-rendering when metadata (unreadCount, lastMessage) changes.
 *
 * @category Chat
 */
export interface ConversationEntity {
  /** Conversation ID (bare JID for 1:1, room JID for MUC) */
  id: string
  /** Display name for the conversation */
  name: string
  /** Conversation type */
  type: 'chat' | 'groupchat'
}

/**
 * Frequently-changing conversation state.
 *
 * Metadata is separated from entity data to enable fine-grained subscriptions.
 * The sidebar can subscribe to metadata without re-rendering when entity
 * data changes, and vice versa.
 *
 * @category Chat
 */
export interface ConversationMetadata {
  /** Number of unread messages */
  unreadCount: number
  /** Most recent message in the conversation */
  lastMessage?: Message
  /** When conversation was last marked as read (for new messages marker) */
  lastReadAt?: Date
  /** ID of the last message the user saw in the viewport (persisted, only advances forward) */
  lastSeenMessageId?: string
  /** ID of the first unread message (calculated when switching to conversation) */
  firstNewMessageId?: string
}

/**
 * A chat conversation (1:1 or group).
 *
 * Represents a conversation entry in the inbox/conversation list.
 * This is the combined type that includes both entity and metadata fields.
 *
 * @remarks
 * Internally, the store separates entity and metadata into different maps
 * for performance optimization. This combined type is provided for convenience
 * and backward compatibility.
 *
 * @category Chat
 */
export interface Conversation extends ConversationEntity, ConversationMetadata {}
