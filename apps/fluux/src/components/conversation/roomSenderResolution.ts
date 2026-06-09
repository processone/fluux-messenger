import { getBareJid, getPresenceFromShow, canModerate, canBan } from '@fluux/sdk'
import { whisperCounterpartPresent } from './'
import type { Room, RoomMessage, RoomRole, RoomAffiliation, ContactIdentity, RoomOccupant } from '@fluux/sdk'

export interface ResolvedRoomSender {
  occupant: RoomOccupant | undefined
  occupantIdMatchNick: string | undefined
  avatarPresence: 'online' | 'away' | 'dnd' | 'offline' | undefined
  senderAvatar: string | undefined
  resolvedSenderName: string
  senderRole: RoomRole | undefined
  senderAffiliation: RoomAffiliation | undefined
  senderBareJidForBan: string | undefined
  canModerate: boolean
  canBan: boolean
  counterpartPresent: boolean
}

export function resolveRoomSender(
  message: RoomMessage,
  room: Room,
  contactsByJid: ReadonlyMap<string, ContactIdentity>,
  selfOccupant: RoomOccupant | undefined,
): ResolvedRoomSender {
  let occupant = room.occupants.get(message.nick)
  let occupantIdMatchNick: string | undefined
  if (!occupant && message.occupantId) {
    for (const occ of room.occupants.values()) {
      if (occ.occupantId === message.occupantId) { occupant = occ; occupantIdMatchNick = occ.nick; break }
    }
  }
  const canModerateMsg = !message.isOutgoing && selfOccupant
    ? canModerate(selfOccupant.role, selfOccupant.affiliation, occupant?.affiliation ?? 'none')
    : false
  const senderBareJidForBan = occupant?.jid
    ? getBareJid(occupant.jid)
    : room.nickToJidCache?.get(message.nick)
  const canBanUser = !message.isOutgoing && selfOccupant && senderBareJidForBan
    ? canBan(selfOccupant.affiliation, occupant?.affiliation ?? 'none')
    : false
  const senderBareJid = occupant?.jid
    ? getBareJid(occupant.jid)
    : room.nickToJidCache?.get(message.nick)
      || room.nickToJidCache?.get(occupantIdMatchNick ?? '')
  const contact = senderBareJid ? contactsByJid.get(senderBareJid) : undefined
  const cachedAvatar = room.nickToAvatarCache?.get(message.nick)
    || room.nickToAvatarCache?.get(occupantIdMatchNick ?? '')
  const senderAvatar = occupant?.avatar || cachedAvatar || contact?.avatar
  const resolvedSenderName = occupantIdMatchNick
    || (contact?.name && !occupant ? contact.name : null)
    || message.nick
  return {
    occupant, occupantIdMatchNick,
    avatarPresence: room.joined ? (occupant ? getPresenceFromShow(occupant.show) : 'offline') : undefined,
    senderAvatar, resolvedSenderName,
    senderRole: occupant?.role,
    senderAffiliation: occupant?.affiliation,
    senderBareJidForBan,
    canModerate: canModerateMsg,
    canBan: !!canBanUser,
    counterpartPresent: message.isPrivate ? whisperCounterpartPresent(message, room.occupants) : true,
  }
}

export function selectSelfOccupant(
  occupants: ReadonlyMap<string, RoomOccupant>,
  myNick: string | undefined,
): RoomOccupant | undefined {
  return myNick ? occupants.get(myNick) : undefined
}

export function stableNickSet(
  occupants: ReadonlyMap<string, RoomOccupant>,
  prev: ReadonlySet<string> | undefined,
): ReadonlySet<string> {
  if (prev && prev.size === occupants.size) {
    let same = true
    for (const nick of occupants.keys()) {
      if (!prev.has(nick)) { same = false; break }
    }
    if (same) return prev
  }
  return new Set(occupants.keys())
}
