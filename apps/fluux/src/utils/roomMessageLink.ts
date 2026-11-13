import { buildRoomMessageLink, getRoomModerationId, type BaseMessage, type RoomMessage } from '@fluux/sdk'

/** Only public, confirmed room messages in an archived room can be linked. */
export function roomMessageLinkFor(message: BaseMessage, supportsMAM: boolean): string | undefined {
  if (message.type !== 'groupchat' || !supportsMAM || message.isRetracted || message.deliveryError) return undefined
  const roomMessage = message as RoomMessage
  if (roomMessage.isPrivate) return undefined
  const stanzaId = getRoomModerationId(roomMessage)
  return stanzaId ? buildRoomMessageLink(roomMessage.roomJid, stanzaId) : undefined
}
