/**
 * MUC room type definitions (XEP-0045).
 *
 * @packageDocumentation
 * @module Types/Room
 */

import type { PresenceShow } from './roster'
import type { MentionReference } from './chat'
import type { BaseMessage } from './message-base'

/**
 * Room affiliation level (XEP-0045).
 *
 * Affiliations are persistent and determine long-term permissions:
 * - `owner` - Full control, can destroy room
 * - `admin` - Can manage members, kick users
 * - `member` - Can enter members-only rooms
 * - `outcast` - Banned from room
 * - `none` - No special affiliation
 *
 * @category MUC
 */
export type RoomAffiliation = 'owner' | 'admin' | 'member' | 'outcast' | 'none'

/**
 * Room role (XEP-0045).
 *
 * Roles are temporary and determine current session permissions:
 * - `moderator` - Can kick visitors, grant voice
 * - `participant` - Can send messages (has "voice")
 * - `visitor` - Can only read messages (no voice)
 * - `none` - Not in room
 *
 * @category MUC
 */
export type RoomRole = 'moderator' | 'participant' | 'visitor' | 'none'

/**
 * Hat definition for room occupants (XEP-0317).
 *
 * Hats are custom role tags that can be assigned to users in a room,
 * like "Staff", "VIP", or "Bot".
 *
 * @category MUC
 */
export interface Hat {
  /** Unique URI identifier for this hat */
  uri: string
  /** Human-readable display name */
  title: string
  /** Optional color hue (0-360) for UI styling */
  hue?: number
}

/**
 * A room occupant (participant in a MUC room).
 *
 * @category MUC
 */
export interface RoomOccupant {
  /** Occupant's nickname in the room */
  nick: string
  /** Real JID (if room is non-anonymous and user has permission to see) */
  jid?: string
  /** Persistent affiliation level */
  affiliation: RoomAffiliation
  /** Current session role */
  role: RoomRole
  /** Presence show state (undefined = online) */
  show?: PresenceShow
  /** XEP-0317: Custom role tags */
  hats?: Hat[]
  /**
   * XEP-0398: Avatar URL (blob URL from cache or data URL).
   * Fetched via XEP-0054 vCard-temp using the avatarHash from presence.
   */
  avatar?: string
  /**
   * XEP-0398: Avatar hash from XEP-0153 vcard-temp:x:update in presence.
   * Used to detect avatar changes and for cache lookup.
   */
  avatarHash?: string
}

/**
 * A message in a MUC room.
 *
 * Extends {@link BaseMessage} with MUC-specific fields like
 * nickname and mention tracking.
 * Use the `type: 'groupchat'` discriminator to distinguish from {@link Message}.
 *
 * @category MUC
 */
export interface RoomMessage extends Omit<BaseMessage, 'type'> {
  /** Message type discriminator - always 'groupchat' for MUC messages */
  type: 'groupchat'
  /** Room JID */
  roomJid: string
  /** Sender's nickname in the room */
  nick: string
  /** True if this message mentions our nickname or \@all */
  isMention?: boolean
  /** True if this message contains \@all mention */
  isMentionAll?: boolean
  /** XEP-0372: Parsed mention references */
  mentions?: MentionReference[]
}

/**
 * Stable room identity - changes on bookmark/join operations.
 *
 * Entity data is separated from metadata to enable fine-grained subscriptions.
 * Components that only need room identity can subscribe to entities without
 * re-rendering when metadata (unreadCount, mentionsCount) changes.
 *
 * @category MUC
 */
export interface RoomEntity {
  /** Room JID (e.g., 'room@conference.example.com') */
  jid: string
  /** Display name */
  name: string
  /** Our nickname in this room */
  nickname: string
  /** Whether we're currently joined to the room */
  joined: boolean
  /** True while join is in progress */
  isJoining?: boolean
  /** Room subject/topic */
  subject?: string
  /** Blob URL for room avatar display (XEP-0054/XEP-0084) */
  avatar?: string
  /** Avatar hash for cache lookup */
  avatarHash?: string
  /** True when avatar info came from room presence (authoritative source) */
  avatarFromPresence?: boolean

  // XEP-0402 bookmark fields
  /** Whether this room is saved as a bookmark */
  isBookmarked: boolean
  /** Auto-join on connect (from bookmark) */
  autojoin?: boolean
  /** Room password (from bookmark) */
  password?: string

  // Quick Chat (transient room)
  /** True for temporary rooms that auto-destroy when empty */
  isQuickChat?: boolean

  // Room capabilities (from disco#info)
  /** True if room supports MAM (XEP-0313) for message archiving */
  supportsMAM?: boolean
}

/**
 * Frequently-changing room state.
 *
 * Metadata is separated from entity data to enable fine-grained subscriptions.
 * The sidebar can subscribe to metadata without re-rendering when entity
 * data or messages change.
 *
 * @category MUC
 */
export interface RoomMetadata {
  /** Number of unread messages */
  unreadCount: number
  /** Number of messages mentioning our nickname */
  mentionsCount: number
  /** Nicknames of users currently typing */
  typingUsers: Set<string>
  /** Notify for all messages, not just mentions (session-only) */
  notifyAll?: boolean
  /** Notify for all messages (persisted in bookmark) */
  notifyAllPersistent?: boolean
  /** When room was last marked as read (for new messages marker) */
  lastReadAt?: Date
  /** ID of the last message the user saw in the viewport (persisted, only advances forward) */
  lastSeenMessageId?: string
  /** ID of the first unread message (calculated when switching to room) */
  firstNewMessageId?: string
  /** Most recent message for sidebar preview */
  lastMessage?: RoomMessage
  /**
   * When user last interacted with this room (opened it).
   * Used for sorting rooms in sidebar - rooms sort by this timestamp
   * so high-traffic rooms don't constantly jump to the top.
   * Only updates when user explicitly opens the room, not when messages arrive.
   */
  lastInteractedAt?: Date
}

/**
 * Runtime room data - not persisted, rebuilt on join.
 *
 * This includes occupants, messages, and caches that are populated
 * when joining a room and cleared when leaving.
 *
 * @category MUC
 */
export interface RoomRuntime {
  /** Map of nickname to occupant info */
  occupants: Map<string, RoomOccupant>
  /** Cache of nick→bareJid for users who have left (non-anonymous rooms only) */
  nickToJidCache?: Map<string, string>
  /** Our own occupant info (when joined) */
  selfOccupant?: RoomOccupant
  /** Messages in this room */
  messages: RoomMessage[]
}

/**
 * A MUC room (group chat).
 *
 * Contains all room state including occupants, messages, and bookmark settings.
 * This is the combined type that includes entity, metadata, and runtime fields.
 *
 * @remarks
 * Internally, the store separates entity, metadata, and runtime into different
 * maps for performance optimization. This combined type is provided for
 * convenience and backward compatibility.
 *
 * @category MUC
 */
export interface Room extends RoomEntity, RoomMetadata, RoomRuntime {}
