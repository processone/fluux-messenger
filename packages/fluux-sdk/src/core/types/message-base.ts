/**
 * Base message type definitions shared between chat and room messages.
 *
 * @packageDocumentation
 * @module Types/MessageBase
 */

import type { FileAttachment } from './upload'
import type { LinkPreview } from './media'
import type { ReplyInfo } from './chat'
import type { XMPPStanzaError } from '../../utils/xmppError'

/**
 * A single option within a poll.
 * @category Poll
 */
export interface PollOption {
  /** The numbered emoji for this option (e.g., "1️⃣", "2️⃣") */
  emoji: string
  /** The option text */
  label: string
}

/**
 * Poll voting settings.
 * @category Poll
 */
export interface PollSettings {
  /** Whether voters can select multiple options (default: false = single vote) */
  allowMultiple: boolean
  /** Whether results are hidden until the user has voted (default: false) */
  hideResultsBeforeVote: boolean
}

/**
 * Poll data embedded in a message.
 *
 * When present on a message, indicates this message is a poll.
 * Voting is done via XEP-0444 reactions — each option maps to a numbered emoji.
 *
 * @category Poll
 */
export interface PollData {
  /** The poll title (typically a question) */
  title: string
  /** Optional longer description providing context for the poll */
  description?: string
  /** 2-9 options, each mapped to a numbered emoji */
  options: PollOption[]
  /** Voting settings */
  settings: PollSettings
  /** Optional deadline as ISO 8601 string — voting is blocked after this time */
  deadline?: string
  /** Occupant ID or nick of the poll creator (for MUC rooms) */
  creatorId?: string
}

/**
 * Frozen results published when a poll is closed by its creator.
 * This is embedded in a separate `poll-closed` message, referencing the original poll.
 *
 * @category Poll
 */
export interface PollClosedData {
  /** The poll title (for display without needing the original message) */
  title: string
  /** Optional description (for display without needing the original message) */
  description?: string
  /** The original poll message ID */
  pollMessageId: string
  /** Frozen results: emoji + label → vote count + optional voter nicks */
  results: { emoji: string; label: string; count: number; voters?: string[] }[]
}

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
  /** XEP-0359: Server-assigned unique ID (for MAM deduplication and cross-client references) */
  stanzaId?: string
  /** XEP-0359: Sender-assigned stable ID (for echo deduplication before server assigns stanzaId) */
  originId?: string
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
  /**
   * XEP-0308 + XEP-0359: Stanza-IDs from correction stanzas.
   * When a message is corrected, the MUC service archives the correction as a
   * new stanza with its own stanza-id. Other clients may reference this
   * correction stanza-id in replies (XEP-0461), so we track them to ensure
   * reply lookups resolve correctly.
   */
  correctionStanzaIds?: string[]
  /** XEP-0424: Message has been retracted (deleted) */
  isRetracted?: boolean
  /** XEP-0424: When the message was retracted */
  retractedAt?: Date
  /** XEP-0425: Message was retracted by a moderator (not the sender) */
  isModerated?: boolean
  /** XEP-0425: Nick of the moderator who retracted the message */
  moderatedBy?: string
  /** XEP-0425: Reason provided by the moderator for the retraction */
  moderationReason?: string
  /** XEP-0066/XEP-0264: File attachment with optional thumbnail */
  attachment?: FileAttachment
  /** XEP-0422 + OGP: Link preview metadata for URLs in message */
  linkPreview?: LinkPreview
  /**
   * Local persistence opt-out. When true, this message is kept in the in-memory
   * store only — it is NOT written to the local IndexedDB cache or the search
   * index. Automatically set for messages in Quick Chat (transient) rooms.
   *
   * Independent of server archival: the XEP-0334 `<no-store>` wire hint that
   * asks the server not to archive is added at the send site, not derived from
   * this field. A message can be kept off the server archive yet still persisted
   * locally (e.g. MUC whispers), or vice versa.
   */
  noLocalStore?: boolean
  /**
   * Delivery error received from the server for this message.
   * Set when the server returns a `<message type="error">` stanza,
   * indicating the message could not be delivered to the recipient.
   */
  deliveryError?: XMPPStanzaError
  /**
   * Poll data — when present, this message is a poll.
   * Voting is done via XEP-0444 reactions mapped to option emojis.
   */
  poll?: PollData
  /**
   * Poll closed data — when present, this message announces frozen poll results.
   * Sent by the poll creator when they close the poll.
   */
  pollClosed?: PollClosedData
  /**
   * Timestamp when this poll was closed. Set on the original poll message
   * when a poll-closed announcement referencing it is received.
   * When set, voting is disabled on this poll.
   */
  pollClosedAt?: Date
  /**
   * End-to-end encryption context for this message.
   * - Present on incoming messages that a plugin successfully decrypted;
   *   carries the protocol id and the trust evaluation the plugin returned.
   * - Present on outgoing messages that were encrypted; the host synthesizes
   *   it from the plugin descriptor at send time.
   * - Absent when the message was handled as cleartext.
   *
   * The UI uses this to render per-message indicators (lock icon, trust
   * state, protocol badge).
   */
  securityContext?: MessageSecurityContext
  /**
   * Serialized encrypted stanza element XML for deferred decryption.
   *
   * Present when an E2EE-tagged message could not be decrypted at receive
   * time — either because no plugin was registered yet (race at startup)
   * or because the private key was locked (web passphrase not entered).
   *
   * {@link XMPPClient.retryPendingDecrypts} iterates messages carrying this
   * field, reconstructs a minimal stanza, and re-attempts decryption.  On
   * success the field is cleared and `body` / `securityContext` are updated.
   *
   * Persisted in IndexedDB so deferred decrypt survives page navigations
   * within the same session.
   */
  encryptedPayload?: string
  /**
   * Set when an incoming message used an end-to-end encryption protocol this
   * client has no plugin for (e.g. OMEMO when only OpenPGP is wired). Unlike
   * {@link encryptedPayload} there is nothing to retry — we will never decrypt
   * it — so the SDK surfaces the sender's XEP-0380 fallback `<body>` verbatim
   * and tags the message with the protocol it couldn't handle, letting the UI
   * show a muted "unsupported method" hint. Mutually exclusive with
   * `encryptedPayload` in practice.
   */
  unsupportedEncryption?: UnsupportedEncryptionInfo
}

/**
 * Identity of an E2EE protocol this client cannot decrypt. `name` is a
 * human-readable label (e.g. "OMEMO"); `namespace` is the XEP-0380 EME
 * namespace (e.g. `eu.siacs.conversations.axolotl`).
 */
export interface UnsupportedEncryptionInfo {
  namespace: string
  name: string
}

/**
 * Per-message E2EE context surfaced to the UI. Mirrors the `SecurityContext`
 * returned by E2EE plugins but is redeclared here to avoid an import cycle
 * between message types and the e2ee module.
 */
export interface MessageSecurityContext {
  /** Plugin identifier, e.g. `openpgp`, `omemo:2`. */
  protocolId: string
  /** Trust evaluation from the plugin. */
  trust: 'verified' | 'introduced' | 'tofu' | 'untrusted' | 'rejected'
  /** Optional display notes (e.g. "subkey 3 days old"). */
  notes?: string[]
  /**
   * Fingerprint of the key that signed this message, when the protocol exposes
   * one (OpenPGP). Lets the UI confirm the verified lock against the ACTUAL
   * signing key rather than "some key for this JID was verified once" — a
   * rotated or server-substituted key must not inherit a stale verification.
   */
  fingerprint?: string
}
