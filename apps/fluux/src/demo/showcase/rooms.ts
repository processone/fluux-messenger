import type { RoomMessage, RoomOccupant } from '@fluux/sdk'
import type { DemoRoomData } from '@fluux/sdk/demo'
import { daysAgo, hoursAgo, minutesAgo } from '@fluux/sdk/demo'
import { SELF_JID } from '../constants'
import { roomMessage } from './builders'
import {
  ASSETS, AVA, COMMUNITY_ROOM, DESIGN_ROOM, EMMA, JAMES, LAUNCH_ROOM, LIAM, OLIVIA, SHOWCASE_SELF_NICK, SOPHIA,
} from './constants'

const ME = SHOWCASE_SELF_NICK

function occupant(roomJid: string, nick: string, jid: string, extras: Partial<RoomOccupant> = {}): RoomOccupant {
  return { nick, jid, occupantId: `showcase-${roomJid}-${nick}`, affiliation: 'member', role: 'participant', ...extras }
}

function mention(body: string, nick: string, roomJid: string) {
  const begin = body.indexOf(`@${nick}`)
  return { begin, end: begin + nick.length + 1, type: 'mention' as const, uri: `xmpp:${roomJid}/${nick}` }
}

function room(jid: string, name: string, occupants: RoomOccupant[], messages: RoomMessage[], unread = 0, mentions = 0): DemoRoomData {
  return {
    room: {
      jid, name, nickname: ME, joined: true, isBookmarked: true, autojoin: true,
      supportsMAM: true, supportsReactions: true, supportsModeration: true,
      unreadCount: unread, mentionsCount: mentions,
      typingUsers: new Set(), occupants: new Map(), lastMessage: messages.at(-1),
    },
    occupants,
    messages,
  }
}

function launchRoom(): DemoRoomData {
  const r = LAUNCH_ROOM
  const m = (id: string, nick: string, body: string, at: Date, extras = {}) => roomMessage(r, `launch-${id}`, nick, body, at, extras)
  const askOpening = `@${ME} could you say a few opening words? Five minutes max`
  return room(r, 'Launch Crew', [
    occupant(r, ME, SELF_JID, { affiliation: 'owner', role: 'moderator' }),
    occupant(r, 'Emma', EMMA, { affiliation: 'admin', role: 'moderator' }),
    occupant(r, 'Ava', AVA),
    occupant(r, 'Liam', LIAM),
    occupant(r, 'Olivia', OLIVIA),
    occupant(r, 'James', JAMES, { show: 'away' }),
    occupant(r, 'Sophia', SOPHIA, { show: 'dnd' }),
  ], [
    m('1', 'Emma', 'Morning crew! Two days to go 🚀', hoursAgo(3)),
    m('2', 'Olivia', 'Stage backdrop mockup, feedback welcome', hoursAgo(2.5), {
      attachment: { url: `${ASSETS}/stage.jpg`, name: 'stage-backdrop.jpg', mediaType: 'image/jpeg', size: 45_709, width: 1200, height: 750 },
      reactions: { '🔥': [ME, 'Emma', 'Liam'], '😍': ['Ava'] },
    }),
    m('3', 'Liam', 'Livestream is ready, and the backup stream too', hoursAgo(1.5), {
      reactions: { '✅': [ME, 'Emma'] },
    }),
    m('4', 'Emma', '', hoursAgo(1), {
      poll: {
        title: 'Where do we go after the event?',
        options: [
          { emoji: '1️⃣', label: 'Stay on the rooftop' },
          { emoji: '2️⃣', label: 'Jazz bar around the corner' },
          { emoji: '3️⃣', label: 'Taco truck 🌮' },
        ],
        settings: { allowMultiple: false, hideResultsBeforeVote: false },
      },
      reactions: { '1️⃣': ['Ava', 'Liam'], '2️⃣': [ME, 'Olivia', 'Sophia'], '3️⃣': ['James'] },
    }),
    m('5', 'Emma', askOpening, minutesAgo(25), {
      mentions: [mention(askOpening, ME, r)],
      isMention: true,
    }),
    m('6', 'self', 'Happy to! I will keep it short 🎤', minutesAgo(23), {
      replyTo: { id: 'showcase-launch-5', to: `${r}/Emma`, fallbackBody: askOpening },
      reactions: { '👏': ['Emma', 'Ava', 'Olivia'] },
    }),
    m('7', 'self', 'Let\'s surprise the team with a cake at 9 🎂', minutesAgo(9), { isPrivate: true, whisperWith: 'Emma' }),
    m('8', 'Emma', 'Love it. My lips are sealed 🤫', minutesAgo(8), { isPrivate: true, whisperWith: 'Emma' }),
  ])
}

function designRoom(): DemoRoomData {
  const r = DESIGN_ROOM
  const m = (id: string, nick: string, body: string, at: Date, extras = {}) => roomMessage(r, `design-${id}`, nick, body, at, extras)
  return room(r, 'Design Studio', [
    occupant(r, ME, SELF_JID, { affiliation: 'admin', role: 'moderator' }),
    occupant(r, 'Olivia', OLIVIA, { affiliation: 'owner', role: 'moderator' }),
    occupant(r, 'Emma', EMMA),
  ], [
    m('1', 'Olivia', 'Badges are printed and look lovely', hoursAgo(5)),
    m('2', 'Emma', 'New icon set is in the shared folder ✨', minutesAgo(30)),
  ], 3)
}

function communityRoom(): DemoRoomData {
  const r = COMMUNITY_ROOM
  const m = (id: string, nick: string, body: string, at: Date, extras = {}) => roomMessage(r, `community-${id}`, nick, body, at, extras)
  return room(r, 'Community', [
    occupant(r, ME, SELF_JID),
    occupant(r, 'Olivia', OLIVIA),
    occupant(r, 'James', JAMES, { show: 'away' }),
  ], [
    m('1', 'Olivia', 'Who is coming to the launch on Thursday? 🙋', daysAgo(1)),
    m('2', 'James', 'Registered! See you there', hoursAgo(4)),
  ])
}

export function buildShowcaseRooms(): DemoRoomData[] {
  return [launchRoom(), designRoom(), communityRoom()]
}
