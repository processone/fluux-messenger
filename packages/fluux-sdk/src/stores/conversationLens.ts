/**
 * A read lens over both conversation stores.
 *
 * A conversation is either a 1:1 chat or a MUC room, and the two live in
 * different stores because their entity models genuinely differ — occupancy,
 * affiliations and nicknames mean nothing to a 1:1 conversation. What they hold
 * identically, keyed by conversation id, is the message window and the churny
 * metadata: read pointer, unread count, preview.
 *
 * This resolves an id to whichever store owns it and reads those, so a caller
 * that only wants "the unread count for this conversation" does not have to
 * know which kind it is.
 *
 * Reads only. The two write paths differ in ways a lens would have to paper
 * over, so a caller that writes picks its store.
 *
 * SDK-internal, deliberately not exported from the package barrel: these bind
 * to the store modules directly, so a consumer that swaps the stores out — as
 * the app's tests do at the `@fluux/sdk` boundary — would keep the real stores
 * here and read an empty world. A caller that already knows the kind should
 * branch on it rather than pay a second resolution.
 *
 * @example
 * ```ts
 * import { conversationKind, conversationMetadata } from './conversationLens'
 *
 * const unread = conversationMetadata('team@conference.example.com')?.unreadCount ?? 0
 * const kind = conversationKind('alice@example.com') // 'chat'
 * ```
 *
 * @packageDocumentation
 * @module Stores/ConversationLens
 */
import { chatStore } from './chatStore'
import { roomStore } from './roomStore'
import type { BaseMessage } from '../core/types/message-base'
import type { ReadPointer } from '../core/types/readState'
import type { HistoryQueryState } from '../core/types/pagination'

/** Which store owns a conversation id. */
export type ConversationKind = 'chat' | 'room'

/**
 * The metadata both stores keep, under the same names.
 *
 * Not `ConversationMetadata` itself: the two records diverge on `lastMessage`,
 * a `Message` for a 1:1 conversation and a `RoomMessage` for a room. Widened
 * here to the base every message shares, which is what a caller reading through
 * the lens can rely on.
 */
export interface ConversationMetadataView {
  /** Number of unread messages. */
  unreadCount: number
  /** Most recent message, as the sidebar preview shows it. */
  lastMessage?: BaseMessage
  /** Where the user has read to. Only ever advances forward. */
  readPointer?: ReadPointer
  /** When this conversation entered our world — the floor for unread counting. */
  historyFloor?: Date
  /**
   * XEP-0490: a remote device reported reading up to this stanza-id, but the
   * message is not yet in the local cache.
   */
  pendingRemoteDisplayedStanzaId?: string
}

/** Shared so a caller that finds nothing does not allocate a fresh array. */
const EMPTY_MESSAGES: readonly BaseMessage[] = Object.freeze([])

/**
 * Which kind of conversation `id` names, or `undefined` when neither store
 * knows it.
 *
 * A room is known once it is bookmarked or joined, which can be long after the
 * session starts — bookmarks load late. Treat `undefined` as "not yet
 * classifiable", not as "1:1".
 */
export function conversationKind(id: string): ConversationKind | undefined {
  if (roomStore.getState().rooms.has(id)) return 'room'
  if (chatStore.getState().conversationEntities.has(id)) return 'chat'
  return undefined
}

/**
 * The conversation's resident message window — the slice of history currently
 * held in memory, empty for a conversation that has none loaded.
 */
export function conversationMessages(id: string): readonly BaseMessage[] {
  if (roomStore.getState().rooms.has(id)) {
    return roomStore.getState().messages.get(id) ?? EMPTY_MESSAGES
  }
  return chatStore.getState().messages.get(id) ?? EMPTY_MESSAGES
}

/**
 * The conversation's metadata, falling back to the combined entry.
 *
 * The split map is the authority, but it can be empty while the combined entry
 * is populated: the persist middleware rehydrates the combined map, and a room
 * arriving from a bookmark has an entry before `roomMeta` is written.
 */
export function conversationMetadata(id: string): ConversationMetadataView | undefined {
  const rooms = roomStore.getState()
  if (rooms.rooms.has(id)) return rooms.roomMeta.get(id) ?? rooms.rooms.get(id)
  const chats = chatStore.getState()
  return chats.conversationMeta.get(id) ?? chats.conversations.get(id)
}

/**
 * The newest message this conversation knows of, preview included.
 *
 * Field-wise fallback rather than {@link conversationMetadata}'s record-wise
 * one: a metadata record can exist with no preview on it while the combined
 * entry still carries the last message.
 */
export function conversationLastMessage(id: string): BaseMessage | undefined {
  const rooms = roomStore.getState()
  if (rooms.rooms.has(id)) {
    return rooms.roomMeta.get(id)?.lastMessage ?? rooms.rooms.get(id)?.lastMessage
  }
  const chats = chatStore.getState()
  return chats.conversationMeta.get(id)?.lastMessage ?? chats.conversations.get(id)?.lastMessage
}

/** The conversation's MAM query state. */
export function conversationHistoryState(id: string): HistoryQueryState {
  return roomStore.getState().rooms.has(id)
    ? roomStore.getState().getRoomMAMQueryState(id)
    : chatStore.getState().getMAMQueryState(id)
}

/** Every conversation either store currently knows: 1:1 entities and rooms. */
export function conversationIds(): Set<string> {
  const ids = new Set<string>()
  for (const id of chatStore.getState().conversationEntities.keys()) ids.add(id)
  for (const id of roomStore.getState().rooms.keys()) ids.add(id)
  return ids
}
