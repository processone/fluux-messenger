/**
 * The generation a conversation's read state belongs to, for either entity kind.
 *
 * Read state is forward-only WITHIN one generation: a cache wipe or an entity
 * invalidation replaces a pointer wholesale, and a consumer caching anything derived
 * from read state needs the pair to know what to discard. Both counters live in the
 * store that owns them, because both are bumped by that store's own teardown paths.
 *
 * The two stores' readers are identical apart from which module-scope counters they
 * name, so the kind is a parameter here rather than a second exported function —
 * the same shape `readPointer` and `transientUnread` already use for the chat/room
 * split.
 *
 * Unlike `conversationLens`, this resolves nothing: the caller says which kind it
 * holds. It binds to both store modules, so it is a barrel export for consumers
 * rather than something SDK-internal code reaches for after it already knows the
 * kind's own reader.
 *
 * @module Stores/ReadStateGeneration
 */
import type { ReadStateGeneration } from '../core/types/readStateGeneration'
import { chatReadStateGeneration } from './chatStore'
import { roomReadStateGeneration } from './roomStore'

/**
 * The generation this entity's read state belongs to.
 *
 * Read it in the SAME turn as the pointer it describes. Both counters are plain
 * reads, so a caller that samples them together cannot see a pointer from one
 * generation carrying the number of another.
 */
export function readStateGeneration(
  kind: 'chat' | 'room',
  entityId: string
): ReadStateGeneration {
  return kind === 'room' ? roomReadStateGeneration(entityId) : chatReadStateGeneration(entityId)
}
