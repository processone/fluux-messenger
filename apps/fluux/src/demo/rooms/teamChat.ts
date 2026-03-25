import type { RoomMessage } from '@fluux/sdk'
import type { DemoRoomData } from '@fluux/sdk'
import { minutesAgo, hoursAgo } from '@fluux/sdk'
import { DOMAIN, SELF_JID, SELF_NICK, ROOM_JID } from '../constants'

export const TEAM_ROOM_MESSAGES: RoomMessage[] = [
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
  // Rust code block — showcases syntax highlighting in rooms
  {
    type: 'groupchat', id: 'demo-room-5c-code', from: `${ROOM_JID}/James`, nick: 'James',
    body: 'Here\'s the Rust benchmark harness I\'m using:\n\n```rust\nuse criterion::{criterion_group, Criterion};\nuse fluux_core::protocol::StanzaParser;\n\nfn bench_parse_message(c: &mut Criterion) {\n    let raw = include_str!("fixtures/message.xml");\n    c.bench_function("parse_message", |b| {\n        b.iter(|| StanzaParser::parse(raw).unwrap())\n    });\n}\n\ncriterion_group!(benches, bench_parse_message);\n```\n\nParsing 10k stanzas in under 50ms 🚀',
    timestamp: hoursAgo(1.2), isOutgoing: false, roomJid: ROOM_JID,
    reactions: { '🔥': [SELF_NICK, 'Oliver'] },
  },
  {
    type: 'groupchat', id: 'demo-room-5d', from: `${ROOM_JID}/${SELF_NICK}`, nick: SELF_NICK,
    body: 'Quick reminder: the security audit report is due next Monday. Sophia and I will handle the documentation side',
    timestamp: hoursAgo(1.1), isOutgoing: true, roomJid: ROOM_JID,
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
  // Poll — showcases poll feature
  {
    type: 'groupchat', id: 'demo-room-poll-1', from: `${ROOM_JID}/${SELF_NICK}`, nick: SELF_NICK,
    body: '', timestamp: minutesAgo(25), isOutgoing: true, roomJid: ROOM_JID,
    poll: {
      title: 'When should we ship v0.14?',
      options: [
        { emoji: '1️⃣', label: 'This Friday — move fast' },
        { emoji: '2️⃣', label: 'Next Monday — more testing' },
        { emoji: '3️⃣', label: 'Next Wednesday — polish + docs' },
      ],
      settings: { allowMultiple: false, hideResultsBeforeVote: false },
    },
    reactions: {
      '1️⃣': ['Emma', 'Liam'],
      '2️⃣': ['Oliver', 'James'],
      '3️⃣': [SELF_NICK],
    },
  },
]

export function getTeamRoom(): DemoRoomData {
  return {
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
      { nick: 'Emma', jid: `emma@${DOMAIN}`, affiliation: 'admin', role: 'moderator' },
      { nick: 'Oliver', jid: `oliver@${DOMAIN}`, affiliation: 'member', role: 'participant' },
      { nick: 'James', jid: `james@${DOMAIN}`, affiliation: 'member', role: 'participant', show: 'away' },
      { nick: 'Sophia', jid: `sophia@${DOMAIN}`, affiliation: 'member', role: 'participant', show: 'dnd' },
      { nick: 'Liam', jid: `liam@${DOMAIN}`, affiliation: 'member', role: 'participant' },
    ],
    messages: TEAM_ROOM_MESSAGES,
  }
}
