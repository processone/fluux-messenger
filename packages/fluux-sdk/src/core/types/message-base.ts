/**
 * Base message type definitions shared between chat and room messages.
 *
 * @packageDocumentation
 * @module Types/MessageBase
 */

import type { FileAttachment } from './upload'
import type { LinkPreview } from './media'
import type { ReplyInfo } from './chat'

/**
 * Base interface for all message types.
 *
 * Contains fields shared between 1:1 chat messages ({@link Message}) and
 * MUC room messages ({@link RoomMessage}). This allows shared utilities
 * to work with both message types using a single interface.
 *
 * @remarks
 * Use the `type` discriminator field to determine the specific message type:
 * - `'chat'` - 1:1 chat message with `conversationId`
 * - `'groupchat'` - MUC room message with `roomJid` and `nick`
 *
 * @example
 * ```typescript
 * function isEditable(message: BaseMessage): boolean {
 *   return message.isOutgoing && !message.isRetracted
 * }
 * ```
 *
 * @category Chat
 */
export interface BaseMessage {
  /** Message type discriminator */
  type: 'chat' | 'groupchat'
  /** Client-generated message ID */
  id: string
  /** XEP-0359: Server-assigned unique ID (for MAM deduplication) */
  stanzaId?: string
  /** Sender's JID (bare JID for chat, full occupant JID for groupchat) */
  from: string
  /** Message text content */
  body: string
  /** When the message was sent/received */
  timestamp: Date
  /** True if this message was sent by the current user */
  isOutgoing: boolean
  /** XEP-0203: Message was delivered with delay (historical/offline) */
  isDelayed?: boolean
  /** XEP-0393: Sender requested no message styling */
  noStyling?: boolean
  /** XEP-0444: Reactions - emoji to list of reactors (JIDs for chat, nicks for groupchat) */
  reactions?: Record<string, string[]>
  /** XEP-0461: Information about message this replies to */
  replyTo?: ReplyInfo
  /** XEP-0308: Message has been edited/corrected */
  isEdited?: boolean
  /** XEP-0308: Original body before correction */
  originalBody?: string
  /** XEP-0424: Message has been retracted (deleted) */
  isRetracted?: boolean
  /** XEP-0424: When the message was retracted */
  retractedAt?: Date
  /** XEP-0066/XEP-0264: File attachment with optional thumbnail */
  attachment?: FileAttachment
  /** XEP-0422 + OGP: Link preview metadata for URLs in message */
  linkPreview?: LinkPreview
  /**
   * XEP-0334: Message Processing Hint - do not store this message.
   * When true, the message should not be persisted to local cache or server archives.
   * Automatically set for messages in Quick Chat (transient) rooms.
   */
  noStore?: boolean
}
