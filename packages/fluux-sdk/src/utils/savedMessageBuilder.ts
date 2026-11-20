import { getBareJid } from '../core/jid'
import { savedItemId } from './savedMessageKeys'
import type { Message } from '../core/types/chat'
import type { RoomMessage } from '../core/types/room'
import type { SavedMessage } from '../core/types/saved'

const MAX_SAVED_CODE_POINTS = 4000

/**
 * A message can be saved once the server has accepted it and it is not a
 * whisper or a deleted message. Pending or failed outgoing messages and rows
 * with nothing to open are not offered.
 */
export function canSaveMessage(message: Message | RoomMessage): boolean {
  if (message.isRetracted || message.deliveryError) return false
  if ('isPrivate' in message && message.isPrivate) return false
  // An outgoing message with no archive id and no origin id has not been confirmed yet.
  if (message.isOutgoing && !message.stanzaId && !message.originId && !message.ownArchiveId) return false
  return true
}

/**
 * Build the entry for a message, with its text (up to 4000 characters, as Forward).
 * An end-to-end encrypted message that this device decrypted keeps its text too;
 * it leaves the device only sealed to the account's own key, never in clear
 * (SavedMessages writes none of it without OpenPGP).
 */
export function buildSavedMessage(message: Message | RoomMessage, ownJid: string, now: number = Date.now()): SavedMessage {
  const ownBare = getBareJid(ownJid)
  const encrypted = Boolean(message.securityContext || message.encryptedPayload)
  // An encrypted message keeps its text only once this device has really decrypted it (or wrote it itself, which carries no availability state): a message still waiting, or one
  // that failed, has an internal placeholder as its body, which is not what the sender wrote.
  const readable = !encrypted || (!message.encryptedPayload && (message.contentAvailability?.state === 'ready' || (message.isOutgoing && !message.contentAvailability)))
  const text = readable ? Array.from(message.body ?? '').slice(0, MAX_SAVED_CODE_POINTS).join('') : ''
  const base = {
    text, savedAt: now, sentAt: message.timestamp.getTime(), messageId: message.id,
    ...(encrypted && { encrypted: true as const }),
    ...(message.originId && { originId: message.originId }),
  }
  let entry: Omit<SavedMessage, 'id'>
  if (message.type === 'groupchat') {
    entry = {
      ...base, conversationJid: message.roomJid, type: 'groupchat', from: `${message.roomJid}/${message.nick}`,
      ...(message.occupantId && { occupantId: message.occupantId }),
      ...(message.stanzaId && { stanzaId: message.stanzaId, stanzaIdBy: message.roomJid }),
    }
  } else {
    // Only the account archive's own id names the message for a later exact lookup:
    // `stanzaId` may have been stamped by a foreign archive.
    const own = message.ownArchiveId && message.ownArchiveBy ? { id: message.ownArchiveId, by: message.ownArchiveBy } : undefined
    entry = {
      ...base, conversationJid: message.conversationId, type: 'chat',
      from: message.isOutgoing ? ownBare : getBareJid(message.from),
      to: message.isOutgoing ? message.conversationId : ownBare,
      ...(own && { stanzaId: own.id, stanzaIdBy: own.by }),
    }
  }
  return { id: savedItemId(entry), ...entry }
}
