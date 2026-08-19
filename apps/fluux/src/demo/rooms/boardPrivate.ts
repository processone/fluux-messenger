import type { RoomMessage } from '@fluux/sdk'
import type { DemoRoomData } from '@fluux/sdk/demo'
import { hoursAgo } from '@fluux/sdk/demo'
import { DOMAIN, SELF_JID, SELF_NICK, BOARD_ROOM_JID, BOARD_ROOM_PASSWORD } from '../constants'

/**
 * A password-protected room the demo user has bookmarked but is NOT in
 * (issue #1126): the state a private room is in right after a restart.
 *
 * Joining it exercises the whole unlock path offline — the simulated service
 * refuses the join with a 401, the client asks for the password, and a correct
 * one is remembered for the next join.
 */
export const BOARD_ROOM_MESSAGES: RoomMessage[] = [
  {
    type: 'groupchat', id: 'demo-board-1', from: `${BOARD_ROOM_JID}/Olivia`, nick: 'Olivia',
    body: 'Agenda for Thursday is in the shared folder', timestamp: hoursAgo(30), isOutgoing: false, roomJid: BOARD_ROOM_JID,
  },
  {
    type: 'groupchat', id: 'demo-board-2', from: `${BOARD_ROOM_JID}/${SELF_NICK}`, nick: SELF_NICK,
    body: 'Thanks — I will add the hiring plan before the meeting', timestamp: hoursAgo(29.5), isOutgoing: true, roomJid: BOARD_ROOM_JID,
  },
]

export function getBoardRoom(): DemoRoomData {
  return {
    room: {
      jid: BOARD_ROOM_JID,
      name: 'Board',
      nickname: SELF_NICK,
      // Bookmarked, but not currently joined: the room has to be unlocked.
      joined: false,
      isBookmarked: true,
      autojoin: false,
      isPrivate: true,
      supportsMAM: true,
      supportsReactions: true,
      unreadCount: 0,
      mentionsCount: 0,
      typingUsers: new Set(),
      occupants: new Map(),
      lastMessage: BOARD_ROOM_MESSAGES.at(-1),
    },
    occupants: [
      { nick: SELF_NICK, jid: SELF_JID, affiliation: 'member', role: 'participant' },
      { nick: 'Olivia', jid: `olivia@${DOMAIN}`, affiliation: 'owner', role: 'moderator' },
    ],
    messages: BOARD_ROOM_MESSAGES,
    // Deliberately NOT stored on the room: the client has to learn it from the
    // user, exactly as it would after a fresh install.
    requiredPassword: BOARD_ROOM_PASSWORD,
  }
}
