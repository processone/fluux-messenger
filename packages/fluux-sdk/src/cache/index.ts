/**
 * # Fluux SDK — Durable Cache (escape hatch)
 *
 * Low-level IndexedDB message-cache and avatar-cache accessors. Import from
 * `@fluux/sdk/cache`.
 *
 * This is an ADVANCED escape hatch, deliberately kept off the curated main
 * `@fluux/sdk` entry: the Zustand stores are the source of truth, and the
 * write/delete operations here bypass their invariants. Reach for it only to
 * read cached history the stores don't currently surface (e.g. resolving a
 * reacted-to message that has slid out of the resident window). Prefer the
 * store actions and hooks for everything else.
 *
 * @packageDocumentation
 * @module Cache
 */

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
  // Utility
  clearAllMessages,
  isMessageCacheAvailable,
} from '../utils/messageCache'
export type { GetMessagesOptions } from '../utils/messageCache'

// Avatar cache operations
export {
  clearAllAvatarData,
  revokeAllBlobUrls,
  getBlobUrlPoolSize,
  bumpAvatarResumeCount,
  getAvatarResumeCount,
} from '../utils/avatarCache'
