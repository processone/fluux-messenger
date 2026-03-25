/**
 * Act 3 — Group Chat Burst (1:30–2:30)
 * Intense room activity: replies, reactions, edits, code, polls.
 */

import type { DemoAnimationStep } from '@fluux/sdk'
import { DOMAIN, SELF_NICK, ROOM_JID } from '../constants'

export const act3Steps: DemoAnimationStep[] = [
  // James sends a bug fix message
  {
    delayMs: 90_000,
    action: 'room-message',
    data: {
      roomJid: ROOM_JID,
      message: {
        type: 'groupchat', id: 'demo-anim-james-fix', from: `${ROOM_JID}/James`, nick: 'James',
        body: 'Just pushed a fix for the notification handler memory leak — turns out we were holding stale refs in the event listener cleanup',
        timestamp: new Date(), isOutgoing: false, roomJid: ROOM_JID,
      },
      incrementUnread: true,
    },
  },
  // Emma replies to James
  {
    delayMs: 95_000,
    action: 'room-message',
    data: {
      roomJid: ROOM_JID,
      message: {
        type: 'groupchat', id: 'demo-anim-emma-reply-room', from: `${ROOM_JID}/Emma`, nick: 'Emma',
        body: 'Nice catch! That explains the growing heap I was seeing in the profiler',
        timestamp: new Date(), isOutgoing: false, roomJid: ROOM_JID,
        replyTo: { id: 'demo-anim-james-fix', to: `${ROOM_JID}/James`, fallbackBody: 'Just pushed a fix for the notification handler memory leak' },
      },
      incrementUnread: true,
    },
  },
  // Oliver reacts with party emoji
  {
    delayMs: 98_000,
    action: 'room-reaction',
    data: {
      roomJid: ROOM_JID,
      messageId: 'demo-anim-james-fix',
      reactorNick: 'Oliver',
      emojis: ['🎉'],
    },
  },
  // Sophia comes online and sends a Rust code block
  {
    delayMs: 102_000,
    action: 'presence',
    data: { fullJid: `sophia@${DOMAIN}/laptop`, show: null, priority: 5, client: 'Fluux' },
  },
  {
    delayMs: 104_000,
    action: 'room-typing',
    data: { roomJid: ROOM_JID, nick: 'Sophia', isTyping: true },
  },
  {
    delayMs: 108_000,
    action: 'room-typing',
    data: { roomJid: ROOM_JID, nick: 'Sophia', isTyping: false },
  },
  {
    delayMs: 108_200,
    action: 'room-message',
    data: {
      roomJid: ROOM_JID,
      message: {
        type: 'groupchat', id: 'demo-anim-sophia-code', from: `${ROOM_JID}/Sophia`, nick: 'Sophia',
        body: 'While we\'re on performance, I optimized the XML parser:\n\n```rust\npub fn parse_stanza(input: &[u8]) -> Result<Stanza, Error> {\n    let mut reader = Reader::from_reader(input);\n    reader.config_mut().trim_text(true);\n    let mut buf = Vec::with_capacity(256);\n\n    loop {\n        match reader.read_event_into(&mut buf)? {\n            Event::Start(e) => return Stanza::from_element(e),\n            Event::Eof => return Err(Error::UnexpectedEof),\n            _ => buf.clear(),\n        }\n    }\n}\n```\n\n3x faster than the previous approach 🏎️',
        timestamp: new Date(), isOutgoing: false, roomJid: ROOM_JID,
      },
      incrementUnread: true,
    },
  },
  // Poll creation
  {
    delayMs: 110_000,
    action: 'room-message',
    data: {
      roomJid: ROOM_JID,
      message: {
        type: 'groupchat', id: 'demo-anim-poll', from: `${ROOM_JID}/${SELF_NICK}`, nick: SELF_NICK,
        body: '', timestamp: new Date(), isOutgoing: true, roomJid: ROOM_JID,
        poll: {
          title: 'Release v0.14 — when are we ready?',
          options: [
            { emoji: '1️⃣', label: 'Ship this Friday' },
            { emoji: '2️⃣', label: 'Next Monday after testing' },
            { emoji: '3️⃣', label: 'Need one more week' },
          ],
          settings: { allowMultiple: false, hideResultsBeforeVote: false },
        },
      },
    },
  },
  // Votes come in
  {
    delayMs: 115_000,
    action: 'room-reaction',
    data: {
      roomJid: ROOM_JID,
      messageId: 'demo-anim-poll',
      reactorNick: 'Emma',
      emojis: ['1️⃣'],
    },
  },
  {
    delayMs: 117_000,
    action: 'room-reaction',
    data: {
      roomJid: ROOM_JID,
      messageId: 'demo-anim-poll',
      reactorNick: 'Oliver',
      emojis: ['2️⃣'],
    },
  },
  // Tutorial: poll hint
  {
    delayMs: 120_000,
    action: 'custom',
    data: { type: 'tutorial', stepId: 'poll-hint' },
  },
  // James edits his earlier message
  {
    delayMs: 125_000,
    action: 'room-message-updated',
    data: {
      roomJid: ROOM_JID,
      messageId: 'demo-anim-james-fix',
      updates: {
        body: 'Just pushed a fix for the notification handler memory leak — turns out we were holding stale refs in the event listener cleanup. Also added a WeakRef-based cache to prevent it from recurring.',
        isEdited: true,
        originalBody: 'Just pushed a fix for the notification handler memory leak — turns out we were holding stale refs in the event listener cleanup',
      },
    },
  },
  // Liam sends a casual DM
  {
    delayMs: 130_000,
    action: 'message',
    data: {
      message: {
        type: 'chat', id: 'demo-anim-liam-dm', from: `liam@${DOMAIN}`,
        body: 'Docker build is killing me today 😤 anyone else having issues?',
        timestamp: new Date(), isOutgoing: false, conversationId: `liam@${DOMAIN}`,
      },
    },
  },
  // Stranger message in activity log
  {
    delayMs: 135_000,
    action: 'activity-event',
    data: {
      type: 'stranger-message',
      kind: 'actionable',
      timestamp: new Date(),
      resolution: 'pending',
      payload: { type: 'stranger-message', from: 'hiring@techcorp.example', body: 'We loved your Fluux talk at FOSDEM — are you open to discussing a role?' },
    },
  },
  // Tutorial: activity log
  {
    delayMs: 140_000,
    action: 'custom',
    data: { type: 'tutorial', stepId: 'activity-log-hint' },
  },
]
