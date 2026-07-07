import { getBareJid, getPresenceFromShow, canModerate, canBan } from '@fluux/sdk'
import { whisperCounterpartPresent } from './'
import { auroraSenderColor, nickColorSeed } from '@/utils/senderColor'
import type { Room, RoomMessage, RoomRole, RoomAffiliation, ContactIdentity, RoomOccupant } from '@fluux/sdk'

export interface ResolvedRoomSender {
  occupant: RoomOccupant | undefined
  avatarPresence: 'online' | 'away' | 'dnd' | 'offline' | undefined
  senderAvatar: string | undefined
  resolvedSenderName: string
  senderRole: RoomRole | undefined
  senderAffiliation: RoomAffiliation | undefined
  // Superset JID used for the senderColor contact lookup — has the occupant-id
  // fallback that senderBareJidForBan (ban-permission only) intentionally excludes.
  senderBareJid: string | undefined
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
  // XEP-0425 §2: only offer moderation when the room advertises message-moderate:1
  // on its own disco#info. `room.supportsModeration` is tri-state — `false` means
  // disco confirmed it's unsupported (hide); `undefined` (disco unresolved) stays
  // optimistic so the affordance doesn't flicker on join. See F3.
  const canModerateMsg = !message.isOutgoing && selfOccupant && room.supportsModeration !== false
    ? canModerate(selfOccupant.role, selfOccupant.affiliation, occupant?.affiliation ?? 'none')
    : false
  // senderBareJidForBan intentionally has NO occupant-id fallback — matches pre-refactor ban-permission behavior
  const senderBareJidForBan = occupant?.jid
    ? getBareJid(occupant.jid)
    : room.nickToJidCache?.get(message.nick)
  const canBanUser = !message.isOutgoing && selfOccupant && senderBareJidForBan
    ? canBan(selfOccupant.affiliation, occupant?.affiliation ?? 'none')
    : false
  // reuse senderBareJidForBan, adding only the occupant-id fallback that the ban path intentionally excludes
  const senderBareJid = senderBareJidForBan
    || room.nickToJidCache?.get(occupantIdMatchNick ?? '')
  const contact = senderBareJid ? contactsByJid.get(senderBareJid) : undefined
  const cachedAvatar = room.nickToAvatarCache?.get(message.nick)
    || room.nickToAvatarCache?.get(occupantIdMatchNick ?? '')
  const senderAvatar = occupant?.avatar || cachedAvatar || contact?.avatar
  const resolvedSenderName = occupantIdMatchNick
    || (contact?.name && !occupant ? contact.name : null)
    || message.nick
  return {
    occupant,
    avatarPresence: room.joined ? (occupant ? getPresenceFromShow(occupant.show) : 'offline') : undefined,
    senderAvatar, resolvedSenderName,
    senderRole: occupant?.role,
    senderAffiliation: occupant?.affiliation,
    senderBareJid,
    senderBareJidForBan,
    canModerate: canModerateMsg,
    canBan: canBanUser,
    counterpartPresent: message.isPrivate ? whisperCounterpartPresent(message, room.occupants) : true,
  }
}

export function resolveReplyAvatar(
  nick: string | undefined,
  room: Room,
  contactsByJid: ReadonlyMap<string, ContactIdentity>,
  myNick: string | undefined,
  ownAvatar: string | null | undefined,
): { avatarUrl: string | undefined; avatarIdentifier: string; senderBareJid: string | undefined } {
  if (nick === myNick && nick) {
    return { avatarUrl: ownAvatar || undefined, avatarIdentifier: nick, senderBareJid: undefined }
  }
  const occupantForReply = nick ? room.occupants.get(nick) : undefined
  const senderBareJid = occupantForReply?.jid
    ? getBareJid(occupantForReply.jid)
    : (nick ? room.nickToJidCache?.get(nick) : undefined)
  const contactAvatar = senderBareJid ? contactsByJid.get(senderBareJid)?.avatar : undefined
  const cachedReplyAvatar = nick ? room.nickToAvatarCache?.get(nick) : undefined
  return {
    avatarUrl: occupantForReply?.avatar || cachedReplyAvatar || contactAvatar,
    avatarIdentifier: nick || 'unknown',
    senderBareJid,
  }
}

/**
 * Sender color for a room message: Aurora-tuned per-person color consistent
 * for all senders. The roster contact's pre-calculated color is intentionally
 * not used — one system for everyone keeps rooms visually coherent.
 * Shared by the main message and the reply quote so the same sender always
 * gets the same color in both places.
 */
export function resolveSenderColor(
  identifier: string,
  _contact: Pick<ContactIdentity, 'colorLight' | 'colorDark'> | undefined,
  isDarkMode: boolean,
): string {
  // Aurora: one consistent, AA-tuned per-person color for all senders — the
  // roster's precomputed contact color is intentionally not used for names.
  return auroraSenderColor(identifier, isDarkMode)
}

/**
 * Display color for an arbitrary room nick (e.g. an inline @mention), using the
 * same Aurora-tuned per-person color as the sender-name color. Keeps a mention
 * pill consistent with the mentioned person's name color.
 * Mirrors the senderBareJid resolution in resolveRoomSender (occupant JID, then
 * nickToJidCache) minus the occupant-id fallback, which only applies to the sender.
 */
export function resolveNickColor(
  nick: string,
  room: Pick<Room, 'occupants' | 'nickToJidCache'>,
  contactsByJid: ReadonlyMap<string, ContactIdentity>,
  isDarkMode: boolean,
): string {
  const occupant = room.occupants.get(nick)
  const bareJid = occupant?.jid ? getBareJid(occupant.jid) : room.nickToJidCache?.get(nick)
  const contact = bareJid ? contactsByJid.get(bareJid) : undefined
  // Seed on stable identity so a mention of an impersonating look-alike nick
  // still matches the real person's color (or diverges from it).
  return resolveSenderColor(nickColorSeed({ occupantId: occupant?.occupantId, bareJid, nick }), contact, isDarkMode)
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
