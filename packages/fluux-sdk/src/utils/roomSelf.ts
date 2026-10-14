/** This account's identity in a room: its nick, and the XEP-0421 occupant-id the room gave it. */
export interface RoomSelf {
  nick: string
  occupantId?: string
}

/** Reads {@link RoomSelf} from the room: our occupant-id rides on the room's presence for us. */
export function roomSelf(room: { nickname?: string; occupants?: Map<string, { occupantId?: string }> } | undefined): RoomSelf {
  const nick = room?.nickname || ''
  const occupantId = nick ? room?.occupants?.get(nick)?.occupantId : undefined
  return { nick, ...(occupantId && { occupantId }) }
}

/**
 * Whether a room message was authored by this account. A matching nick says so (compared
 * case-insensitively, as some servers change case), and so does a matching XEP-0421 occupant-id:
 * the room derives it from the real bare JID, so it also names another of our sessions joined
 * under a different nick. Until the room has given us an occupant-id, none is trusted.
 */
export function isOwnRoomMessage(nick: string, occupantId: string | undefined, self: RoomSelf): boolean {
  if (nick.toLowerCase() === self.nick.toLowerCase()) return true
  return occupantId !== undefined && occupantId === self.occupantId
}
