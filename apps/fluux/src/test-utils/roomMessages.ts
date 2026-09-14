import { getStorageScopeJid, type RoomMessage } from '@fluux/sdk'

/** A fixture received with a confirmed room archive identity before caching. */
export function confirmedRoomMessage<T extends RoomMessage>(message: T) {
  return {
    ...message,
    stanzaIdAuthority: message.stanzaId ? {
      stanzaId: message.stanzaId, roomJid: message.roomJid, accountJid: getStorageScopeJid(),
      id: message.id, from: message.from, occupantId: message.occupantId,
    } : undefined,
  }
}
