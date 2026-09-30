import { getBareJid, getPresenceFromShow, canModerate, canBan, getRoomModerationId } from '@fluux/sdk'
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

export interface ResolvedRoomAvatar {
  occupant: RoomOccupant | undefined
  matchedNick: string | undefined
  avatarUrl: string | undefined
  avatarIdentifier: string
  senderBareJid: string | undefined
  source: 'own' | 'live' | 'occupant-id' | 'jid' | 'nick' | 'fallback'
}

/**
 * Resolve one room actor through stable identity first.
 *
 * A nickname is only trusted when the message has no XEP-0421 identity, or
 * when the live occupant under that nick proves the same occupant-id. This
 * prevents historical messages from inheriting the avatar/JID of a different
 * person who later recycled the nickname.
 */
export function resolveRoomAvatar(
  subject: { nick: string; occupantId?: string; isOwn?: boolean },
  room: Room,
  contactsByJid: ReadonlyMap<string, ContactIdentity>,
  ownAvatar?: string | null,
): ResolvedRoomAvatar {
  let occupant: RoomOccupant | undefined
  let matchedNick: string | undefined

  if (subject.occupantId) {
    const indexedNick = room.occupantIdToNick?.get(subject.occupantId)
    const indexedOccupant = indexedNick
      ? room.occupants.get(indexedNick)
      : undefined
    const sameNickOccupant = room.occupants.get(subject.nick)
    const candidate = indexedOccupant?.occupantId === subject.occupantId
      ? indexedOccupant
      : sameNickOccupant?.occupantId === subject.occupantId
        ? sameNickOccupant
        : undefined
    if (candidate) {
      occupant = candidate
      matchedNick = candidate.nick
    }
  } else {
    occupant = room.occupants.get(subject.nick)
    matchedNick = occupant?.nick
  }

  const senderBareJid = occupant?.jid
    ? getBareJid(occupant.jid)
    : subject.occupantId
      ? room.occupantIdToJidCache?.get(subject.occupantId)
        || (occupant ? room.nickToJidCache?.get(occupant.nick) : undefined)
      : room.nickToJidCache?.get(subject.nick)
  const contactAvatar = senderBareJid
    ? contactsByJid.get(senderBareJid)?.avatar
    : undefined

  if (subject.isOwn) {
    return {
      occupant,
      matchedNick,
      avatarUrl: ownAvatar || undefined,
      avatarIdentifier: subject.occupantId || senderBareJid || subject.nick,
      senderBareJid,
      source: ownAvatar ? 'own' : 'fallback',
    }
  }

  if (occupant?.avatar) {
    return {
      occupant,
      matchedNick,
      avatarUrl: occupant.avatar,
      avatarIdentifier: subject.occupantId || senderBareJid || subject.nick,
      senderBareJid,
      source: 'live',
    }
  }

  const stableAvatar = subject.occupantId
    ? room.occupantIdToAvatarCache?.get(subject.occupantId)
    : undefined
  if (stableAvatar) {
    return {
      occupant,
      matchedNick,
      avatarUrl: stableAvatar,
      avatarIdentifier: subject.occupantId!,
      senderBareJid,
      source: 'occupant-id',
    }
  }

  if (contactAvatar) {
    return {
      occupant,
      matchedNick,
      avatarUrl: contactAvatar,
      avatarIdentifier: senderBareJid || subject.occupantId || subject.nick,
      senderBareJid,
      source: 'jid',
    }
  }

  // The nick cache is deliberately session-only. With XEP-0421 it is safe
  // only when a live occupant proves that this nick still belongs to the same
  // stable identity.
  const nickCacheIsSafe = !subject.occupantId
    || occupant?.occupantId === subject.occupantId
  const nickAvatar = nickCacheIsSafe
    ? room.nickToAvatarCache?.get(matchedNick || subject.nick)
    : undefined

  return {
    occupant,
    matchedNick,
    avatarUrl: nickAvatar,
    avatarIdentifier: subject.occupantId || senderBareJid || subject.nick,
    senderBareJid,
    source: nickAvatar ? 'nick' : 'fallback',
  }
}

export function resolveRoomSender(
  message: RoomMessage,
  room: Room,
  contactsByJid: ReadonlyMap<string, ContactIdentity>,
  selfOccupant: RoomOccupant | undefined,
): ResolvedRoomSender {
  const avatar = resolveRoomAvatar(
    { nick: message.nick, occupantId: message.occupantId, isOwn: message.isOutgoing },
    room,
    contactsByJid,
  )
  const occupant = avatar.occupant
  const occupantIdMatchNick = avatar.matchedNick !== message.nick
    ? avatar.matchedNick
    : undefined
  // XEP-0425 §2: only offer moderation when the room advertises message-moderate:1
  // on its own disco#info. `room.supportsModeration` is tri-state — `false` means
  // disco confirmed it's unsupported (hide); `undefined` (disco unresolved) stays
  // optimistic so the affordance doesn't flicker on join. See F3.
  const canModerateMsg = message.roomJid === room.jid && !!getRoomModerationId(message) && !message.isOutgoing && selfOccupant && room.supportsModeration !== false
    ? canModerate(selfOccupant.role, selfOccupant.affiliation, occupant?.affiliation ?? 'none')
    : false
  // Ban only through an identity alias that cannot be captured by nickname
  // recycling. XEP-0421 gives departed occupants a stable room-scoped alias;
  // legacy messages retain the historical nick cache fallback.
  const senderBareJidForBan = occupant?.jid
    ? getBareJid(occupant.jid)
    : message.occupantId
      ? room.occupantIdToJidCache?.get(message.occupantId)
      : room.nickToJidCache?.get(message.nick)
  const canBanUser = !message.isOutgoing && selfOccupant && senderBareJidForBan
    ? canBan(selfOccupant.affiliation, occupant?.affiliation ?? 'none')
    : false
  const senderBareJid = avatar.senderBareJid
  const contact = senderBareJid ? contactsByJid.get(senderBareJid) : undefined
  const resolvedSenderName = occupantIdMatchNick
    || (contact?.name && !occupant ? contact.name : null)
    || message.nick
  return {
    occupant,
    avatarPresence: room.joined ? (occupant ? getPresenceFromShow(occupant.show) : 'offline') : undefined,
    senderAvatar: avatar.avatarUrl, resolvedSenderName,
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
  occupantId?: string,
): { avatarUrl: string | undefined; avatarIdentifier: string; senderBareJid: string | undefined } {
  if (!nick) {
    return { avatarUrl: undefined, avatarIdentifier: occupantId || 'unknown', senderBareJid: undefined }
  }
  const avatar = resolveRoomAvatar(
    { nick, occupantId, isOwn: nick === myNick },
    room,
    contactsByJid,
    ownAvatar,
  )
  return {
    avatarUrl: avatar.avatarUrl,
    avatarIdentifier: avatar.avatarIdentifier,
    senderBareJid: avatar.senderBareJid,
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

/** Colour of the local user's own name; a mention of them must match it. */
export const SELF_NICK_COLOR = 'var(--fluux-text-self)'

export interface RoomNickIdentity {
  occupantId?: string
  isSelf: boolean
  lastSeenAt: number
}

type MentionRoom = Pick<Room, 'occupants' | 'nickToJidCache' | 'nickname'>

export function rememberRoomNickIdentities(
  room: MentionRoom,
  messages: readonly RoomMessage[],
  identities: Map<string, RoomNickIdentity>,
): void {
  const selfId = room.nickname ? room.occupants.get(room.nickname)?.occupantId : undefined
  for (const message of messages) {
    if (message.systemEvent) continue
    const previous = identities.get(message.nick)
    const isSelf = message.isOutgoing || !!(message.occupantId && message.occupantId === selfId)
    if (previous && message.occupantId && message.occupantId === previous.occupantId && isSelf) {
      previous.isSelf = true
    }
    const lastSeenAt = message.timestamp.getTime()
    if (!previous || lastSeenAt >= previous.lastSeenAt) {
      identities.set(message.nick, {
        occupantId: message.occupantId,
        isSelf: isSelf || !!(message.occupantId && message.occupantId === previous?.occupantId && previous.isSelf),
        lastSeenAt,
      })
    }
  }
  const now = Date.now()
  for (const occupant of room.occupants.values()) {
    const previous = identities.get(occupant.nick)
    identities.set(occupant.nick, {
      occupantId: occupant.occupantId,
      isSelf: occupant.nick === room.nickname || !!(occupant.occupantId && (occupant.occupantId === selfId
        || (occupant.occupantId === previous?.occupantId && previous.isSelf))),
      lastSeenAt: now,
    })
  }
}

function knownRoomNicks(room: MentionRoom, identities: ReadonlyMap<string, RoomNickIdentity>): Set<string> {
  return new Set([
    ...room.occupants.keys(),
    ...(room.nickname ? [room.nickname] : []),
    ...[...identities].sort((a, b) => b[1].lastSeenAt - a[1].lastSeenAt).map(([nick]) => nick),
    ...(room.nickToJidCache?.keys() ?? []),
  ])
}

export function resolveNickColor(
  nick: string,
  room: MentionRoom,
  contactsByJid: ReadonlyMap<string, ContactIdentity>,
  isDarkMode: boolean,
  identities: ReadonlyMap<string, RoomNickIdentity> = new Map(),
): string {
  const known = room.occupants.has(nick) || identities.has(nick)
    || room.nickname === nick || room.nickToJidCache?.has(nick)
  const canonicalNick = known ? nick : [...knownRoomNicks(room, identities)]
    .find(candidate => candidate.toLowerCase() === nick.toLowerCase()) ?? nick
  const occupant = room.occupants.get(canonicalNick)
  const identity = identities.get(canonicalNick)
  const selfId = room.nickname ? room.occupants.get(room.nickname)?.occupantId : undefined
  const occupantId = occupant ? occupant.occupantId : identity?.occupantId
  const isSelf = occupant
    ? occupant.nick === room.nickname || !!(occupantId && (occupantId === selfId
      || (occupantId === identity?.occupantId && identity.isSelf)))
    : identity?.isSelf || !!(occupantId && occupantId === selfId) || canonicalNick === room.nickname
  if (isSelf) return SELF_NICK_COLOR

  const bareJid = occupant?.jid ? getBareJid(occupant.jid) : room.nickToJidCache?.get(canonicalNick)
  const contact = bareJid ? contactsByJid.get(bareJid) : undefined
  return resolveSenderColor(nickColorSeed({ occupantId, bareJid, nick: canonicalNick }), contact, isDarkMode)
}

export function resolveRoomMentionColors(
  room: MentionRoom,
  contactsByJid: ReadonlyMap<string, ContactIdentity>,
  isDarkMode: boolean,
  identities: ReadonlyMap<string, RoomNickIdentity>,
  previous?: ReadonlyMap<string, string>,
): ReadonlyMap<string, string> {
  const colors = new Map([...knownRoomNicks(room, identities)]
    .map(nick => [nick, resolveNickColor(nick, room, contactsByJid, isDarkMode, identities)]))
  const previousEntries = previous ? [...previous] : []
  if (previous && colors.size === previous.size && [...colors].every(([nick, color], index) =>
    previousEntries[index][0] === nick && previousEntries[index][1] === color)) return previous
  return colors
}

export function selectSelfOccupant(
  occupants: ReadonlyMap<string, RoomOccupant>,
  myNick: string | undefined,
): RoomOccupant | undefined {
  return myNick ? occupants.get(myNick) : undefined
}

export function stableNickSet(
  occupants: ReadonlyMap<string, unknown>,
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
