import * as messageCache from './messageCache'
import { buildSavedMessage } from './savedMessageBuilder'
import { sameSavedMessage } from './savedMessageKeys'
import type { Message } from '../core/types/chat'
import type { RoomMessage } from '../core/types/room'
import type { SavedMessage } from '../core/types/saved'

/**
 * The latest copy of a saved message this device holds in its durable cache, so
 * an edit or deletion received while the conversation was closed shows in the
 * Saved list. Only a copy that is the same message by the shared identity rules
 * counts; `undefined` when the cache holds none.
 */
export async function findLatestCopy(entry: SavedMessage, ownJid: string): Promise<Message | RoomMessage | undefined> {
  const candidates: Array<Message | RoomMessage | null> = []
  try {
    if (entry.type === 'groupchat') {
      if (entry.stanzaId) candidates.push(await messageCache.getRoomMessageByStanzaId(entry.conversationJid, entry.stanzaId))
      for (const reference of [entry.originId, entry.messageId]) {
        if (reference) candidates.push(await messageCache.getRoomMessageByReference(entry.conversationJid, reference, entry.from))
      }
    } else {
      if (entry.stanzaId) candidates.push(await messageCache.getMessageByStanzaId(entry.conversationJid, entry.stanzaId))
      for (const reference of [entry.originId, entry.messageId]) {
        if (reference) candidates.push(await messageCache.getMessageByReference(entry.conversationJid, reference))
      }
    }
  } catch {
    return undefined
  }
  return candidates.find((message): message is Message | RoomMessage =>
    !!message && sameSavedMessage(buildSavedMessage(message, ownJid, 0), entry))
}
