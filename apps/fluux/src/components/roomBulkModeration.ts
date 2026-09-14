import type { ContactIdentity, Room, RoomMessage } from '@fluux/sdk'
import { resolveRoomSender } from './conversation/roomSenderResolution'

const EMPTY_CONTACTS: ReadonlyMap<string, ContactIdentity> = new Map()

export function canBulkModerate(room: Room): boolean {
  return room.joined && !room.isIrcGateway && room.supportsModeration !== false
    && room.occupants.get(room.nickname)?.role === 'moderator'
}

export function bulkModerationCandidates(room: Room, messages: readonly RoomMessage[]): RoomMessage[] {
  if (!canBulkModerate(room)) return []
  const seen = new Set<string>()
  const self = room.occupants.get(room.nickname)
  return messages.filter(message => {
    // A moderation request must name the room's server-assigned stanza ID,
    // never a client ID that another occupant can reuse (XEP-0425 §3.1).
    if (message.roomJid !== room.jid || !message.stanzaId || message.isOutgoing
      || message.isPrivate || message.isRetracted || message.systemEvent
      || seen.has(message.stanzaId)) return false
    if (!resolveRoomSender(message, room, EMPTY_CONTACTS, self).canModerate) return false
    seen.add(message.stanzaId)
    return true
  })
}
