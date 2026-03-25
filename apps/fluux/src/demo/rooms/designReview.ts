import type { RoomMessage } from '@fluux/sdk'
import type { DemoRoomData } from '@fluux/sdk'
import { hoursAgo } from '@fluux/sdk'
import { DOMAIN, SELF_JID, SELF_NICK, DESIGN_ROOM_JID } from '../constants'

export const DESIGN_ROOM_MESSAGES: RoomMessage[] = [
  {
    type: 'groupchat', id: 'demo-design-1', from: `${DESIGN_ROOM_JID}/Oliver`, nick: 'Oliver',
    body: 'Let\'s review the component library before the sprint ends', timestamp: hoursAgo(5), isOutgoing: false, roomJid: DESIGN_ROOM_JID,
  },
  {
    type: 'groupchat', id: 'demo-design-2', from: `${DESIGN_ROOM_JID}/Emma`, nick: 'Emma',
    body: 'I updated the color tokens — the primary palette now has better contrast in dark mode',
    timestamp: hoursAgo(4.8), isOutgoing: false, roomJid: DESIGN_ROOM_JID,
  },
  {
    type: 'groupchat', id: 'demo-design-3', from: `${DESIGN_ROOM_JID}/${SELF_NICK}`, nick: SELF_NICK,
    body: 'Looks great. Did you test the colors against WCAG AAA?', timestamp: hoursAgo(4.5), isOutgoing: true, roomJid: DESIGN_ROOM_JID,
    replyTo: { id: 'demo-design-2', to: `${DESIGN_ROOM_JID}/Emma`, fallbackBody: 'I updated the color tokens — the primary palette now has better contrast in dark mode' },
  },
  {
    type: 'groupchat', id: 'demo-design-4', from: `${DESIGN_ROOM_JID}/Emma`, nick: 'Emma',
    body: 'AA for body text, AAA for headings and buttons — all passing',
    timestamp: hoursAgo(4.3), isOutgoing: false, roomJid: DESIGN_ROOM_JID,
    reactions: { '✨': [SELF_NICK, 'Oliver'] },
  },
  {
    type: 'groupchat', id: 'demo-design-5', from: `${DESIGN_ROOM_JID}/Oliver`, nick: 'Oliver',
    body: 'The typography scale is using a 1.25 ratio — works well for both mobile and desktop',
    timestamp: hoursAgo(4), isOutgoing: false, roomJid: DESIGN_ROOM_JID,
  },
  {
    type: 'groupchat', id: 'demo-design-6', from: `${DESIGN_ROOM_JID}/Mia`, nick: 'Mia',
    body: 'Love the progress! Can we add a section on icon guidelines to the style guide?',
    timestamp: hoursAgo(3.5), isOutgoing: false, roomJid: DESIGN_ROOM_JID,
  },
  {
    type: 'groupchat', id: 'demo-design-7', from: `${DESIGN_ROOM_JID}/Oliver`, nick: 'Oliver',
    body: 'Already drafted — icons use a 24px grid with 2px stroke weight for consistency',
    timestamp: hoursAgo(3.2), isOutgoing: false, roomJid: DESIGN_ROOM_JID,
    replyTo: { id: 'demo-design-6', to: `${DESIGN_ROOM_JID}/Mia`, fallbackBody: 'Love the progress! Can we add a section on icon guidelines to the style guide?' },
  },
  // Moderated/retracted message — showcases moderator deletion
  {
    type: 'groupchat', id: 'demo-design-7b', from: `${DESIGN_ROOM_JID}/Mia`, nick: 'Mia',
    body: '', timestamp: hoursAgo(3.1), isOutgoing: false, roomJid: DESIGN_ROOM_JID,
    isRetracted: true,
    retractedAt: hoursAgo(3.05),
    isModerated: true,
    moderatedBy: 'Oliver',
    moderationReason: 'Contained draft credentials — removed for security',
  },
  {
    type: 'groupchat', id: 'demo-design-8', from: `${DESIGN_ROOM_JID}/${SELF_NICK}`, nick: SELF_NICK,
    body: 'The spacing system looks clean. Let\'s make sure the border radius tokens match across all components',
    timestamp: hoursAgo(3), isOutgoing: true, roomJid: DESIGN_ROOM_JID,
    reactions: { '👍': ['Oliver', 'Emma'] },
  },
  {
    type: 'groupchat', id: 'demo-design-9', from: `${DESIGN_ROOM_JID}/Emma`, nick: 'Emma',
    body: 'I\'ll export the final Figma file tonight so we can integrate the tokens into the build',
    timestamp: hoursAgo(2.5), isOutgoing: false, roomJid: DESIGN_ROOM_JID,
  },
  {
    type: 'groupchat', id: 'demo-design-10', from: `${DESIGN_ROOM_JID}/Mia`, nick: 'Mia',
    body: 'Perfect — I\'ll add the design review to the release checklist for v0.14',
    timestamp: hoursAgo(2), isOutgoing: false, roomJid: DESIGN_ROOM_JID,
    reactions: { '📋': [SELF_NICK] },
  },
]

export function getDesignRoom(): DemoRoomData {
  return {
    room: {
      jid: DESIGN_ROOM_JID,
      name: 'Design Review',
      nickname: SELF_NICK,
      joined: true,
      isBookmarked: true,
      autojoin: true,
      supportsMAM: true,
      supportsReactions: true,
      unreadCount: 0,
      mentionsCount: 0,
      typingUsers: new Set(),
      occupants: new Map(),
      messages: [],
      lastMessage: DESIGN_ROOM_MESSAGES.at(-1),
    },
    occupants: [
      { nick: SELF_NICK, jid: SELF_JID, affiliation: 'owner', role: 'moderator' },
      { nick: 'Emma', jid: `emma@${DOMAIN}`, affiliation: 'member', role: 'participant' },
      { nick: 'Oliver', jid: `oliver@${DOMAIN}`, affiliation: 'admin', role: 'moderator' },
      { nick: 'Mia', jid: `mia@${DOMAIN}`, affiliation: 'member', role: 'participant' },
    ],
    messages: DESIGN_ROOM_MESSAGES,
  }
}
