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
import type { ActivityEventInput } from '../core/types/activity'

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

/** Days ago from now */
function daysAgo(days: number): Date {
  return new Date(Date.now() - days * 86_400_000)
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DOMAIN = 'fluux.chat'
const CONFERENCE = `conference.${DOMAIN}`
const SELF_JID = `you@${DOMAIN}`
const SELF_NICK = 'You'
const ROOM_JID = `team@${CONFERENCE}`
const DESIGN_ROOM_JID = `design@${CONFERENCE}`

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
    // Earlier conversation about animations (yesterday)
    {
      type: 'chat', id: 'demo-emma-0a', from: conv, body: 'I\'ve been experimenting with the transition animations for the sidebar',
      timestamp: daysAgo(1), isOutgoing: false, conversationId: conv,
    },
    {
      type: 'chat', id: 'demo-emma-0b', from: SELF_JID, body: 'How\'s the performance? We need to keep it under 16ms per frame',
      timestamp: daysAgo(1), isOutgoing: true, conversationId: conv,
    },
    {
      type: 'chat', id: 'demo-emma-0c', from: conv, body: 'Running smooth — I used CSS transforms instead of layout properties so the GPU handles it',
      timestamp: daysAgo(1), isOutgoing: false, conversationId: conv,
      reactions: { '👏': [SELF_JID] } as Record<string, string[]>,
    },
    {
      type: 'chat', id: 'demo-emma-0d', from: SELF_JID, body: 'Smart. We should also add a reduced-motion media query fallback for accessibility',
      timestamp: daysAgo(1), isOutgoing: true, conversationId: conv,
    },
    {
      type: 'chat', id: 'demo-emma-0e', from: conv, body: 'Already done! I tested it with VoiceOver too — screen readers skip the animation entirely',
      timestamp: daysAgo(1), isOutgoing: false, conversationId: conv,
    },
    // Today's conversation
    {
      type: 'chat', id: 'demo-emma-1', from: SELF_JID, body: 'Hey Emma, did you see the latest mockups?',
      timestamp: minutesAgo(45), isOutgoing: true, conversationId: conv,
    },
    {
      type: 'chat', id: 'demo-emma-2', from: conv, body: 'Yes! The new sidebar looks fantastic 🎨',
      timestamp: minutesAgo(43), isOutgoing: false, conversationId: conv,
      reactions: { '🔥': [SELF_JID] } as Record<string, string[]>,
    },
    {
      type: 'chat', id: 'demo-emma-3', from: SELF_JID, body: 'Great — I was thinking we could ship it in the next beta',
      timestamp: minutesAgo(42), isOutgoing: true, conversationId: conv,
      reactions: { '🚀': [conv], '👍': [conv] } as Record<string, string[]>,
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
    // Earlier conversation about testing (2 days ago)
    {
      type: 'chat', id: 'demo-james-0a', from: conv, body: 'I set up the end-to-end test suite for the chat module',
      timestamp: daysAgo(2), isOutgoing: false, conversationId: conv,
    },
    {
      type: 'chat', id: 'demo-james-0b', from: SELF_JID, body: 'What framework did you go with? Playwright or Cypress?',
      timestamp: daysAgo(2), isOutgoing: true, conversationId: conv,
    },
    {
      type: 'chat', id: 'demo-james-0c', from: conv, body: 'Playwright — better for testing WebSocket connections and it runs headless in CI',
      timestamp: daysAgo(2), isOutgoing: false, conversationId: conv,
    },
    {
      type: 'chat', id: 'demo-james-0d', from: SELF_JID, body: 'Good call. Can you add a test for the reconnection flow? That\'s been flaky',
      timestamp: daysAgo(2), isOutgoing: true, conversationId: conv,
    },
    {
      type: 'chat', id: 'demo-james-0e', from: conv, body: 'On it. I\'ll simulate a network drop and verify the message queue is flushed after reconnect',
      timestamp: daysAgo(2), isOutgoing: false, conversationId: conv,
      reactions: { '🙌': [SELF_JID] } as Record<string, string[]>,
    },
    // Today's conversation
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
    {
      type: 'chat', id: 'demo-james-6', from: conv,
      body: 'Here\'s how I wired up the reconnect handler:\n\n```typescript\nclient.on(\'disconnect\', async (reason) => {\n  if (reason === \'stream-error\') {\n    await client.resume({ prevId: session.id })\n  }\n})\n```\n\nPretty clean with the new SDK hooks!',
      timestamp: hoursAgo(3.5), isOutgoing: false, conversationId: conv,
    },
    {
      type: 'chat', id: 'demo-james-7', from: SELF_JID,
      body: 'Nice! You can simplify it even further:\n\n```typescript\nconst { status } = useConnection({\n  autoResume: true,\n  onReconnect: () => console.log(\'Back online\'),\n})\n```',
      timestamp: hoursAgo(3), isOutgoing: true, conversationId: conv,
    },
    {
      type: 'chat', id: 'demo-james-8', from: conv, body: 'By the way, I found a bug in the error handling — when the server returns a 503, we retry immediately instead of backing off',
      timestamp: hoursAgo(2), isOutgoing: false, conversationId: conv,
    },
    {
      type: 'chat', id: 'demo-james-9', from: SELF_JID, body: 'Good catch. Let\'s add exponential backoff with jitter to avoid thundering herd',
      timestamp: hoursAgo(1.8), isOutgoing: true, conversationId: conv,
    },
  ]
})()

const SOPHIA_MESSAGES: Message[] = (() => {
  const conv = `sophia@${DOMAIN}`
  return [
    // Earlier conversation about migration guide (2 days ago)
    {
      type: 'chat', id: 'demo-sophia-0a', from: conv, body: 'Started working on the migration guide for SDK v2',
      timestamp: daysAgo(2), isOutgoing: false, conversationId: conv,
    },
    {
      type: 'chat', id: 'demo-sophia-0b', from: SELF_JID, body: 'Make sure to cover the breaking changes in the store API',
      timestamp: daysAgo(2), isOutgoing: true, conversationId: conv,
    },
    {
      type: 'chat', id: 'demo-sophia-0c', from: conv, body: 'Yes — I\'m documenting each deprecated method with its replacement and a code example',
      timestamp: daysAgo(2), isOutgoing: false, conversationId: conv,
    },
    {
      type: 'chat', id: 'demo-sophia-0d', from: SELF_JID, body: 'We should also add a section about the new versioning strategy and the changelog format',
      timestamp: daysAgo(2), isOutgoing: true, conversationId: conv,
    },
    {
      type: 'chat', id: 'demo-sophia-0e', from: conv, body: 'Good idea. I\'ll follow the Keep a Changelog convention so it\'s easy to parse',
      timestamp: daysAgo(2), isOutgoing: false, conversationId: conv,
      reactions: { '👍': [SELF_JID] } as Record<string, string[]>,
    },
    // Today's conversation
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

const OLIVER_MESSAGES: Message[] = (() => {
  const conv = `oliver@${DOMAIN}`
  return [
    {
      type: 'chat', id: 'demo-oliver-1', from: conv, body: 'Hey! I\'ve been putting together the component library for the design system',
      timestamp: daysAgo(1), isOutgoing: false, conversationId: conv,
    },
    {
      type: 'chat', id: 'demo-oliver-2', from: SELF_JID, body: 'Awesome — are you using Figma tokens for the color palette?',
      timestamp: daysAgo(1), isOutgoing: true, conversationId: conv,
    },
    {
      type: 'chat', id: 'demo-oliver-3', from: conv, body: 'Yes! I exported the design tokens as JSON so we can import them directly into our theme config',
      timestamp: daysAgo(1), isOutgoing: false, conversationId: conv,
      reactions: { '🎯': [SELF_JID] } as Record<string, string[]>,
    },
    {
      type: 'chat', id: 'demo-oliver-4', from: SELF_JID, body: 'That\'s exactly what we need. How\'s the dark mode variant looking?',
      timestamp: daysAgo(1), isOutgoing: true, conversationId: conv,
    },
    {
      type: 'chat', id: 'demo-oliver-5', from: conv, body: 'Dark mode is working well — I adjusted the contrast ratios to meet WCAG AA for accessibility',
      timestamp: daysAgo(1), isOutgoing: false, conversationId: conv,
    },
    {
      type: 'chat', id: 'demo-oliver-6', from: SELF_JID, body: 'Can you share the Figma link? I want to review the button variants',
      timestamp: hoursAgo(8), isOutgoing: true, conversationId: conv,
    },
    {
      type: 'chat', id: 'demo-oliver-7', from: conv, body: 'Sure thing — I also added hover states and focus ring styles for keyboard navigation',
      timestamp: hoursAgo(7.5), isOutgoing: false, conversationId: conv,
    },
    {
      type: 'chat', id: 'demo-oliver-8', from: conv, body: 'The spacing system uses an 8px grid — keeps everything aligned and consistent across breakpoints',
      timestamp: hoursAgo(7), isOutgoing: false, conversationId: conv,
      replyTo: { id: 'demo-oliver-6', fallbackBody: 'Can you share the Figma link? I want to review the button variants' },
    },
    {
      type: 'chat', id: 'demo-oliver-9', from: SELF_JID, body: 'This is really solid work. Let\'s present it at the design review tomorrow',
      timestamp: hoursAgo(6.5), isOutgoing: true, conversationId: conv,
      reactions: { '🙌': [conv] } as Record<string, string[]>,
    },
  ]
})()

const MIA_MESSAGES: Message[] = (() => {
  const conv = `mia@${DOMAIN}`
  return [
    {
      type: 'chat', id: 'demo-mia-1', from: conv, body: 'Sprint planning is done — I\'ve assigned the tickets for this week',
      timestamp: daysAgo(2), isOutgoing: false, conversationId: conv,
    },
    {
      type: 'chat', id: 'demo-mia-2', from: SELF_JID, body: 'Thanks! What\'s the priority order? I want to tackle the critical bugs first',
      timestamp: daysAgo(2), isOutgoing: true, conversationId: conv,
    },
    {
      type: 'chat', id: 'demo-mia-3', from: conv, body: 'Top priority is the notification bug on Android — users are missing messages when the app is backgrounded',
      timestamp: daysAgo(2), isOutgoing: false, conversationId: conv,
    },
    {
      type: 'chat', id: 'demo-mia-4', from: SELF_JID, body: 'Got it. I\'ll look at the push notification service config — might be a Firebase issue',
      timestamp: daysAgo(2), isOutgoing: true, conversationId: conv,
    },
    {
      type: 'chat', id: 'demo-mia-5', from: conv, body: 'Second priority is the deployment pipeline — staging deploys have been failing intermittently',
      timestamp: daysAgo(1), isOutgoing: false, conversationId: conv,
    },
    {
      type: 'chat', id: 'demo-mia-6', from: SELF_JID, body: 'I saw that too. The Docker build cache seems to be invalidating on every push',
      timestamp: daysAgo(1), isOutgoing: true, conversationId: conv,
      reactions: { '🔍': [conv] } as Record<string, string[]>,
    },
    {
      type: 'chat', id: 'demo-mia-7', from: conv, body: 'Also — release notes for v0.14 are due Friday. Can you draft the technical changes section?',
      timestamp: hoursAgo(4), isOutgoing: false, conversationId: conv,
    },
    {
      type: 'chat', id: 'demo-mia-8', from: SELF_JID, body: 'Sure, I\'ll have it ready by Thursday. Anything else for the release checklist?',
      timestamp: hoursAgo(3.5), isOutgoing: true, conversationId: conv,
    },
    {
      type: 'chat', id: 'demo-mia-9', from: conv, body: 'Just the regression test pass — James is running it now. We should be good to ship on schedule',
      timestamp: hoursAgo(3), isOutgoing: false, conversationId: conv,
      reactions: { '✅': [SELF_JID] } as Record<string, string[]>,
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
    {
      id: `oliver@${DOMAIN}`,
      name: 'Oliver Park',
      type: 'chat',
      unreadCount: 0,
      lastMessage: OLIVER_MESSAGES.at(-1),
    },
    {
      id: `mia@${DOMAIN}`,
      name: 'Mia Thompson',
      type: 'chat',
      unreadCount: 1,
      lastMessage: MIA_MESSAGES.at(-1),
    },
  ]
}

export function getDemoMessages(): Map<string, Message[]> {
  const map = new Map<string, Message[]>()
  map.set(`emma@${DOMAIN}`, EMMA_MESSAGES)
  map.set(`james@${DOMAIN}`, JAMES_MESSAGES)
  map.set(`sophia@${DOMAIN}`, SOPHIA_MESSAGES)
  map.set(`oliver@${DOMAIN}`, OLIVER_MESSAGES)
  map.set(`mia@${DOMAIN}`, MIA_MESSAGES)
  return map
}

// ---------------------------------------------------------------------------
// Room data
// ---------------------------------------------------------------------------

export interface DemoRoomData {
  room: Room
  occupants: RoomOccupant[]
  messages: RoomMessage[]
}

const TEAM_ROOM_MESSAGES: RoomMessage[] = [
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
    type: 'groupchat', id: 'demo-room-5b', from: `${ROOM_JID}/James`, nick: 'James',
    body: 'The regression tests are passing. I\'m running the full performance benchmark now',
    timestamp: hoursAgo(1.3), isOutgoing: false, roomJid: ROOM_JID,
  },
  {
    type: 'groupchat', id: 'demo-room-5c', from: `${ROOM_JID}/${SELF_NICK}`, nick: SELF_NICK,
    body: 'Quick reminder: the security audit report is due next Monday. Sophia and I will handle the documentation side',
    timestamp: hoursAgo(1.2), isOutgoing: true, roomJid: ROOM_JID,
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
    type: 'groupchat', id: 'demo-room-7b', from: `${ROOM_JID}/James`, nick: 'James',
    body: 'Found a memory leak in the notification handler — working on a fix now',
    timestamp: minutesAgo(40), isOutgoing: false, roomJid: ROOM_JID,
  },
  {
    type: 'groupchat', id: 'demo-room-7c', from: `${ROOM_JID}/Emma`, nick: 'Emma',
    body: 'Feature request from the beta testers: they want message search to support date filters',
    timestamp: minutesAgo(35), isOutgoing: false, roomJid: ROOM_JID,
    reactions: { '👀': [SELF_NICK, 'Oliver'] },
  },
  {
    type: 'groupchat', id: 'demo-room-8', from: `${ROOM_JID}/Emma`, nick: 'Emma',
    body: 'I\'ll sync with Sophia on the API docs — we should align the examples with the new SDK hooks',
    timestamp: minutesAgo(30), isOutgoing: false, roomJid: ROOM_JID,
  },
]

const DESIGN_ROOM_MESSAGES: RoomMessage[] = [
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

export function getDemoRooms(): DemoRoomData[] {
  return [
    {
      room: {
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
        lastMessage: TEAM_ROOM_MESSAGES.at(-1),
      },
      occupants: [
        { nick: SELF_NICK, jid: SELF_JID, affiliation: 'owner', role: 'moderator' },
        { nick: 'Emma', jid: `emma@${DOMAIN}`, affiliation: 'member', role: 'participant' },
        { nick: 'Oliver', jid: `oliver@${DOMAIN}`, affiliation: 'member', role: 'participant' },
        { nick: 'James', jid: `james@${DOMAIN}`, affiliation: 'member', role: 'participant', show: 'away' },
      ],
      messages: TEAM_ROOM_MESSAGES,
    },
    {
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
        { nick: 'Oliver', jid: `oliver@${DOMAIN}`, affiliation: 'member', role: 'participant' },
        { nick: 'Mia', jid: `mia@${DOMAIN}`, affiliation: 'member', role: 'participant' },
      ],
      messages: DESIGN_ROOM_MESSAGES,
    },
  ]
}

// Keep backward-compatible exports for any code still using the old API
export function getDemoRoom(): Room {
  return getDemoRooms()[0].room
}

export function getDemoRoomOccupants(): RoomOccupant[] {
  return getDemoRooms()[0].occupants
}

export function getDemoRoomMessages(): RoomMessage[] {
  return getDemoRooms()[0].messages
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
// Activity log demo events
// ---------------------------------------------------------------------------

export function getDemoActivityEvents(): ActivityEventInput[] {
  return [
    // Yesterday: a contact request was accepted
    {
      type: 'subscription-request',
      kind: 'actionable',
      timestamp: new Date(Date.now() - 26 * 3_600_000),
      resolution: 'accepted',
      payload: { type: 'subscription-request', from: `oliver@${DOMAIN}` },
    },
    // Yesterday: joined a room from invitation
    {
      type: 'muc-invitation',
      kind: 'actionable',
      timestamp: new Date(Date.now() - 25 * 3_600_000),
      resolution: 'accepted',
      payload: {
        type: 'muc-invitation',
        roomJid: ROOM_JID,
        from: `emma@${DOMAIN}`,
        reason: 'Come join the team channel!',
        isDirect: true,
        isQuickChat: false,
      },
    },
    // Today: reactions on your messages
    {
      type: 'reaction-received',
      kind: 'informational',
      timestamp: hoursAgo(3),
      payload: {
        type: 'reaction-received',
        conversationId: `emma@${DOMAIN}`,
        messageId: 'demo-emma-3',
        reactors: [
          { reactorJid: `emma@${DOMAIN}`, emojis: ['🚀', '👍'] },
        ],
        messagePreview: 'Great — I was thinking we could ship it in the next beta',
      },
    },
    {
      type: 'reaction-received',
      kind: 'informational',
      timestamp: hoursAgo(2),
      payload: {
        type: 'reaction-received',
        conversationId: ROOM_JID,
        messageId: 'demo-room-6',
        reactors: [
          { reactorJid: 'Emma', emojis: ['✅'] },
          { reactorJid: 'Oliver', emojis: ['✅'] },
        ],
        messagePreview: "Great work everyone. Let's aim to wrap up the remaining tasks by end of week",
      },
    },
    // Today: a pending contact request
    {
      type: 'subscription-request',
      kind: 'actionable',
      timestamp: hoursAgo(1),
      resolution: 'pending',
      payload: { type: 'subscription-request', from: `alex@${DOMAIN}` },
    },
    // Today: reaction on a 1:1 message
    {
      type: 'reaction-received',
      kind: 'informational',
      timestamp: minutesAgo(30),
      payload: {
        type: 'reaction-received',
        conversationId: `james@${DOMAIN}`,
        messageId: 'demo-james-5',
        reactors: [
          { reactorJid: `james@${DOMAIN}`, emojis: ['💪'] },
        ],
        messagePreview: 'Already on it — session resumption is working nicely in the latest build',
      },
    },
    // Today: a stranger message
    {
      type: 'stranger-message',
      kind: 'actionable',
      timestamp: minutesAgo(15),
      resolution: 'pending',
      payload: { type: 'stranger-message', from: `recruiter@jobs.example`, body: 'Hi, I saw your open source work and would love to chat!' },
    },
  ]
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

export const SELF = { jid: SELF_JID, nick: SELF_NICK, domain: DOMAIN }
export const ROOM = { jid: ROOM_JID, conference: CONFERENCE }
