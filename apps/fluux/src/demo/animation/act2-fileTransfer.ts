/**
 * Act 2 — Rooms & Group Chat (0:45–1:30)
 * Introduces group conversations with replies, reactions, and code sharing.
 */

import type { DemoAnimationStep } from '@fluux/sdk/demo'
import { DOMAIN, ROOM_JID } from '../constants'

export const act2Steps: DemoAnimationStep[] = [
  // Tutorial: rooms navigation
  {
    delayMs: 45_000,
    action: 'custom',
    data: { type: 'tutorial', stepId: 'rooms-hint' },
  },
  // James sends a bug fix message in Team Chat
  {
    delayMs: 55_000,
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
    delayMs: 60_000,
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
  // Olivia reacts with party emoji
  {
    delayMs: 63_000,
    action: 'room-reaction',
    data: {
      roomJid: ROOM_JID,
      messageId: 'demo-anim-james-fix',
      reactorNick: 'Olivia',
      emojis: ['🎉'],
    },
  },
  // Sophia comes online and shares a code block
  {
    delayMs: 67_000,
    action: 'presence',
    data: { fullJid: `sophia@${DOMAIN}/laptop`, show: null, priority: 5, client: 'Fluux' },
  },
  {
    delayMs: 69_000,
    action: 'room-typing',
    data: { roomJid: ROOM_JID, nick: 'Sophia', isTyping: true },
  },
  {
    delayMs: 73_000,
    action: 'room-typing',
    data: { roomJid: ROOM_JID, nick: 'Sophia', isTyping: false },
  },
  {
    delayMs: 73_200,
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
]
