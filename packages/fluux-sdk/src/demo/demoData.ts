/**
 * Demo data for populating the Fluux UI with realistic content.
 *
 * All data is generated with relative timestamps so the demo always
 * looks fresh. Used by {@link DemoClient} to seed stores.
 *
 * @packageDocumentation
 * @module Demo
 */

import type { Contact } from '../core/types/roster'
import type { Message, Conversation } from '../core/types/chat'
import type { Room, RoomMessage, RoomOccupant } from '../core/types/room'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Minutes ago from now */
function minutesAgo(minutes: number): Date {
  return new Date(Date.now() - minutes * 60_000)
}

/** Hours ago from now */
function hoursAgo(hours: number): Date {
  return new Date(Date.now() - hours * 3_600_000)
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DOMAIN = 'fluux.chat'
const CONFERENCE = `conference.${DOMAIN}`
const SELF_JID = `you@${DOMAIN}`
const SELF_NICK = 'You'
const ROOM_JID = `team@${CONFERENCE}`

// ---------------------------------------------------------------------------
// Contacts
// ---------------------------------------------------------------------------

// Avatar base path — files are served from apps/fluux/public/demo/
const AVATAR_BASE = './demo'

export const DEMO_CONTACTS: Contact[] = [
  {
    jid: `emma@${DOMAIN}`,
    name: 'Emma Wilson',
    presence: 'online',
    subscription: 'both',
    groups: ['Team'],
    avatar: `${AVATAR_BASE}/avatar-emma.webp`,
  },
  {
    jid: `james@${DOMAIN}`,
    name: 'James Chen',
    presence: 'away',
    statusMessage: 'In a meeting until 3pm',
    subscription: 'both',
    groups: ['Team'],
    avatar: `${AVATAR_BASE}/avatar-james.webp`,
  },
  {
    jid: `sophia@${DOMAIN}`,
    name: 'Sophia Rodriguez',
    presence: 'dnd',
    statusMessage: 'Deep work — ping me only if urgent',
    subscription: 'both',
    groups: ['Team'],
    avatar: `${AVATAR_BASE}/avatar-sophia.webp`,
  },
  {
    jid: `oliver@${DOMAIN}`,
    name: 'Oliver Park',
    presence: 'online',
    subscription: 'both',
    groups: ['Design'],
    avatar: `${AVATAR_BASE}/avatar-oliver.webp`,
  },
  {
    jid: `mia@${DOMAIN}`,
    name: 'Mia Thompson',
    presence: 'offline',
    subscription: 'both',
    groups: ['Design'],
    lastSeen: hoursAgo(3),
    avatar: `${AVATAR_BASE}/avatar-mia.webp`,
  },
]

// ---------------------------------------------------------------------------
// Presence events (for roster:presence bindings — fullJid required)
// ---------------------------------------------------------------------------

export interface DemoPresence {
  fullJid: string
  show: 'chat' | 'away' | 'xa' | 'dnd' | null
  priority: number
  statusMessage?: string
  client?: string
}

export const DEMO_PRESENCES: DemoPresence[] = [
  { fullJid: `emma@${DOMAIN}/desktop`, show: null, priority: 5, client: 'Fluux' },
  { fullJid: `james@${DOMAIN}/mobile`, show: 'away', priority: 0, statusMessage: 'In a meeting until 3pm', client: 'Fluux' },
  { fullJid: `sophia@${DOMAIN}/laptop`, show: 'dnd', priority: 5, statusMessage: 'Deep work — ping me only if urgent', client: 'Fluux' },
  { fullJid: `oliver@${DOMAIN}/desktop`, show: null, priority: 5, client: 'Fluux' },
]

// ---------------------------------------------------------------------------
// Chat messages — stable IDs to avoid duplicates across reloads
// ---------------------------------------------------------------------------

const EMMA_MESSAGES: Message[] = (() => {
  const conv = `emma@${DOMAIN}`
  return [
    {
      type: 'chat', id: 'demo-emma-1', from: SELF_JID, body: 'Hey Emma, did you see the latest mockups?',
      timestamp: minutesAgo(45), isOutgoing: true, conversationId: conv,
    },
    {
      type: 'chat', id: 'demo-emma-2', from: conv, body: 'Yes! The new sidebar looks fantastic 🎨',
      timestamp: minutesAgo(43), isOutgoing: false, conversationId: conv,
      reactions: { '🔥': [SELF_JID] },
    },
    {
      type: 'chat', id: 'demo-emma-3', from: SELF_JID, body: 'Great — I was thinking we could ship it in the next beta',
      timestamp: minutesAgo(42), isOutgoing: true, conversationId: conv,
      reactions: { '🚀': [conv], '👍': [conv] },
    },
    {
      type: 'chat', id: 'demo-emma-4', from: conv, body: 'Sounds good. I\'ll update the design tokens this afternoon',
      timestamp: minutesAgo(40), isOutgoing: false, conversationId: conv,
    },
    {
      type: 'chat', id: 'demo-emma-5', from: SELF_JID, body: 'Perfect, let me know when it\'s ready for review',
      timestamp: minutesAgo(38), isOutgoing: true, conversationId: conv,
    },
    {
      type: 'chat', id: 'demo-emma-6', from: conv, body: 'Here\'s a screenshot of the contacts view',
      timestamp: minutesAgo(15), isOutgoing: false, conversationId: conv,
      attachment: {
        url: './demo/screenshot-fluux-contacts.png',
        name: 'fluux-contacts-screenshot.png',
        mediaType: 'image/png',
        size: 206_620,
        width: 1456,
        height: 816,
      },
    },
    {
      type: 'chat', id: 'demo-emma-8', from: conv, body: 'Will do! Also, Oliver mentioned he has some icon suggestions',
      timestamp: minutesAgo(8), isOutgoing: false, conversationId: conv,
      replyTo: { id: 'demo-emma-5', fallbackBody: 'Perfect, let me know when it\'s ready for review' },
    },
    {
      type: 'chat', id: 'demo-emma-9', from: conv, body: 'Can we do a quick sync at 4?',
      timestamp: minutesAgo(5), isOutgoing: false, conversationId: conv,
    },
  ]
})()

const JAMES_MESSAGES: Message[] = (() => {
  const conv = `james@${DOMAIN}`
  return [
    {
      type: 'chat', id: 'demo-james-1', from: conv, body: 'Have you seen the blog post about the latest release?',
      timestamp: hoursAgo(6), isOutgoing: false, conversationId: conv,
    },
    {
      type: 'chat', id: 'demo-james-2', from: conv,
      body: 'https://www.process-one.net/blog/fluux-messenger-0-13/',
      timestamp: hoursAgo(6), isOutgoing: false, conversationId: conv,
      linkPreview: {
        url: 'https://www.process-one.net/blog/fluux-messenger-0-13/',
        title: 'Fluux Messenger 0.13: group chat, reactions and more',
        description: 'Fluux Messenger 0.13 adds group chat support (MUC), emoji reactions, message replies, and improved file sharing — all built on XMPP standards.',
        siteName: 'ProcessOne',
        image: './demo/link-preview-fluux-013.png',
      },
    },
    {
      type: 'chat', id: 'demo-james-3', from: SELF_JID, body: 'Nice! The part about stream management is very relevant to what we\'re building next',
      timestamp: hoursAgo(5), isOutgoing: true, conversationId: conv,
    },
    {
      type: 'chat', id: 'demo-james-4', from: conv, body: 'Exactly what I thought. We should leverage more of XEP-0198',
      timestamp: hoursAgo(5), isOutgoing: false, conversationId: conv,
      replyTo: { id: 'demo-james-3', fallbackBody: 'Nice! The part about stream management is very relevant to what we\'re building next' },
    },
    {
      type: 'chat', id: 'demo-james-5', from: SELF_JID, body: 'Already on it — session resumption is working nicely in the latest build 🚀',
      timestamp: hoursAgo(4), isOutgoing: true, conversationId: conv,
      reactions: { '💪': [conv] },
    },
  ]
})()

const SOPHIA_MESSAGES: Message[] = (() => {
  const conv = `sophia@${DOMAIN}`
  return [
    {
      type: 'chat', id: 'demo-sophia-1', from: conv, body: 'I\'ve finished the API docs for the SDK',
      timestamp: hoursAgo(2), isOutgoing: false, conversationId: conv,
    },
    {
      type: 'chat', id: 'demo-sophia-2', from: conv,
      body: 'Here\'s the PDF with the full reference',
      timestamp: hoursAgo(2), isOutgoing: false, conversationId: conv,
      attachment: {
        url: './demo/fluux-sdk-api-reference.pdf',
        name: 'fluux-sdk-api-reference.pdf',
        mediaType: 'application/pdf',
        size: 2_450_000,
      },
    },
    {
      type: 'chat', id: 'demo-sophia-3', from: SELF_JID, body: 'This is thorough — nice work!',
      timestamp: hoursAgo(1.5), isOutgoing: true, conversationId: conv,
      replyTo: { id: 'demo-sophia-2', fallbackBody: 'Here\'s the PDF with the full reference' },
    },
    {
      type: 'chat', id: 'demo-sophia-4', from: SELF_JID, body: 'I\'ll review it this evening and add comments',
      timestamp: hoursAgo(1.5), isOutgoing: true, conversationId: conv,
    },
    {
      type: 'chat', id: 'demo-sophia-5', from: conv, body: 'Also recorded a quick walkthrough of the key changes',
      timestamp: hoursAgo(1.2), isOutgoing: false, conversationId: conv,
      reactions: { '🙏': [SELF_JID] },
      attachment: {
        url: './demo/sdk-walkthrough.mp4',
        name: 'sdk-walkthrough.mp4',
        mediaType: 'video/mp4',
        size: 18_700_000,
        width: 1920,
        height: 1080,
        duration: 245,
      },
    },
    {
      type: 'chat', id: 'demo-sophia-6', from: conv, body: 'Take your time, no rush 👍',
      timestamp: hoursAgo(1), isOutgoing: false, conversationId: conv,
    },
  ]
})()

// ---------------------------------------------------------------------------
// Conversations
// ---------------------------------------------------------------------------

export function getDemoConversations(): Conversation[] {
  return [
    {
      id: `emma@${DOMAIN}`,
      name: 'Emma Wilson',
      type: 'chat',
      unreadCount: 2,
      lastMessage: EMMA_MESSAGES.at(-1),
    },
    {
      id: `james@${DOMAIN}`,
      name: 'James Chen',
      type: 'chat',
      unreadCount: 0,
      lastMessage: JAMES_MESSAGES.at(-1),
    },
    {
      id: `sophia@${DOMAIN}`,
      name: 'Sophia Rodriguez',
      type: 'chat',
      unreadCount: 0,
      lastMessage: SOPHIA_MESSAGES.at(-1),
    },
  ]
}

export function getDemoMessages(): Map<string, Message[]> {
  const map = new Map<string, Message[]>()
  map.set(`emma@${DOMAIN}`, EMMA_MESSAGES)
  map.set(`james@${DOMAIN}`, JAMES_MESSAGES)
  map.set(`sophia@${DOMAIN}`, SOPHIA_MESSAGES)
  return map
}

// ---------------------------------------------------------------------------
// Room data
// ---------------------------------------------------------------------------

export function getDemoRoom(): Room {
  return {
    jid: ROOM_JID,
    name: 'Team Chat',
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
    lastMessage: ROOM_MESSAGES.at(-1),
  }
}

export function getDemoRoomOccupants(): RoomOccupant[] {
  return [
    { nick: SELF_NICK, jid: SELF_JID, affiliation: 'owner', role: 'moderator' },
    { nick: 'Emma', jid: `emma@${DOMAIN}`, affiliation: 'member', role: 'participant' },
    { nick: 'Oliver', jid: `oliver@${DOMAIN}`, affiliation: 'member', role: 'participant' },
    { nick: 'James', jid: `james@${DOMAIN}`, affiliation: 'member', role: 'participant', show: 'away' },
  ]
}

const ROOM_MESSAGES: RoomMessage[] = [
  {
    type: 'groupchat', id: 'demo-room-1', from: `${ROOM_JID}/Emma`, nick: 'Emma',
    body: 'Good morning everyone! 🌅', timestamp: hoursAgo(3), isOutgoing: false, roomJid: ROOM_JID,
  },
  {
    type: 'groupchat', id: 'demo-room-2', from: `${ROOM_JID}/Oliver`, nick: 'Oliver',
    body: 'Morning! I just pushed the new icon set to the repo', timestamp: hoursAgo(2.8), isOutgoing: false, roomJid: ROOM_JID,
  },
  {
    type: 'groupchat', id: 'demo-room-3', from: `${ROOM_JID}/${SELF_NICK}`, nick: SELF_NICK,
    body: 'Nice — I saw the notification. The new icons look sharp!', timestamp: hoursAgo(2.5), isOutgoing: true, roomJid: ROOM_JID,
    replyTo: { id: 'demo-room-2', to: `${ROOM_JID}/Oliver`, fallbackBody: 'Morning! I just pushed the new icon set to the repo' },
  },
  {
    type: 'groupchat', id: 'demo-room-4', from: `${ROOM_JID}/James`, nick: 'James',
    body: 'Agreed, big improvement over the old set', timestamp: hoursAgo(2.3), isOutgoing: false, roomJid: ROOM_JID,
    reactions: { '👍': [SELF_NICK, 'Emma'], '💯': ['Oliver'] },
  },
  {
    type: 'groupchat', id: 'demo-room-5', from: `${ROOM_JID}/Emma`, nick: 'Emma',
    body: 'Quick update: the deployment pipeline is green again after the fix this morning',
    timestamp: hoursAgo(1.5), isOutgoing: false, roomJid: ROOM_JID,
    reactions: { '🎉': [SELF_NICK, 'Oliver', 'James'] },
  },
  {
    type: 'groupchat', id: 'demo-room-6', from: `${ROOM_JID}/${SELF_NICK}`, nick: SELF_NICK,
    body: 'Great work everyone. Let\'s aim to wrap up the remaining tasks by end of week',
    timestamp: hoursAgo(1), isOutgoing: true, roomJid: ROOM_JID,
    reactions: { '✅': ['Emma', 'Oliver'] },
  },
  {
    type: 'groupchat', id: 'demo-room-7', from: `${ROOM_JID}/Oliver`, nick: 'Oliver',
    body: 'Sounds good — I\'ll have the responsive layout ready by Thursday',
    timestamp: minutesAgo(50), isOutgoing: false, roomJid: ROOM_JID,
    replyTo: { id: 'demo-room-6', to: `${ROOM_JID}/${SELF_NICK}`, fallbackBody: 'Great work everyone. Let\'s aim to wrap up the remaining tasks by end of week' },
  },
  {
    type: 'groupchat', id: 'demo-room-8', from: `${ROOM_JID}/Emma`, nick: 'Emma',
    body: 'I\'ll sync with Sophia on the API docs — we should align the examples with the new SDK hooks',
    timestamp: minutesAgo(30), isOutgoing: false, roomJid: ROOM_JID,
  },
]

export function getDemoRoomMessages(): RoomMessage[] {
  return ROOM_MESSAGES
}

// ---------------------------------------------------------------------------
// Animation data (timed events for live demo)
// ---------------------------------------------------------------------------

export interface DemoAnimationStep {
  delayMs: number
  action: 'typing' | 'message' | 'presence' | 'stop-typing' | 'room-message' | 'reaction'
  data: Record<string, unknown>
}

export function getDemoAnimation(): DemoAnimationStep[] {
  return [
    // Emma starts typing
    {
      delayMs: 3000,
      action: 'typing',
      data: { conversationId: `emma@${DOMAIN}`, jid: `emma@${DOMAIN}`, isTyping: true },
    },
    // Emma sends a message
    {
      delayMs: 5500,
      action: 'stop-typing',
      data: { conversationId: `emma@${DOMAIN}`, jid: `emma@${DOMAIN}`, isTyping: false },
    },
    {
      delayMs: 5600,
      action: 'message',
      data: {
        message: {
          type: 'chat', id: 'demo-anim-emma-reply', from: `emma@${DOMAIN}`,
          body: '4pm works for me! See you then 😊',
          timestamp: new Date(), isOutgoing: false, conversationId: `emma@${DOMAIN}`,
        },
      },
    },
    // Room message from Oliver
    {
      delayMs: 8000,
      action: 'room-message',
      data: {
        roomJid: ROOM_JID,
        message: {
          type: 'groupchat', id: 'demo-anim-room-oliver', from: `${ROOM_JID}/Oliver`, nick: 'Oliver',
          body: 'Just finished the responsive breakpoints — looks great on mobile 📱',
          timestamp: new Date(), isOutgoing: false, roomJid: ROOM_JID,
        },
        incrementUnread: true,
      },
    },
    // Reaction on the room message
    {
      delayMs: 11000,
      action: 'reaction',
      data: {
        roomJid: ROOM_JID,
        messageId: 'demo-room-6', // "Great work everyone"
        reactorNick: 'Oliver',
        emojis: ['🎉'],
      },
    },
  ]
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

export const SELF = { jid: SELF_JID, nick: SELF_NICK, domain: DOMAIN }
export const ROOM = { jid: ROOM_JID, conference: CONFERENCE }
