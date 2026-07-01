/**
 * Act 6 — Admin & Wrap-up (4:15–5:00)
 * Admin showcase, XMPP console, presence changes, narrative closure.
 */

import type { DemoAnimationStep } from '@fluux/sdk'
import { DOMAIN, SELF_NICK, ROOM_JID } from '../constants'

export const act6Steps: DemoAnimationStep[] = [
  // Presence changes
  {
    delayMs: 250_000,
    action: 'presence',
    data: { fullJid: `sophia@${DOMAIN}/laptop`, show: 'dnd', priority: 5, statusMessage: 'Do not disturb — wrapping up docs', client: 'Fluux' },
  },
  {
    delayMs: 252_000,
    action: 'presence',
    data: { fullJid: `james@${DOMAIN}/mobile`, show: 'away', priority: 0, statusMessage: 'Grabbing coffee', client: 'Fluux' },
  },
  // Tutorial: admin panel
  {
    delayMs: 255_000,
    action: 'custom',
    data: { type: 'tutorial', stepId: 'admin-hint' },
  },
  // Emma summary in Team room
  {
    delayMs: 262_000,
    action: 'room-message',
    data: {
      roomJid: ROOM_JID,
      message: {
        type: 'groupchat', id: 'demo-anim-emma-summary', from: `${ROOM_JID}/Emma`, nick: 'Emma',
        body: 'Quick EOD summary: icon set shipped, memory leak fixed, design tokens exported, poll running on release timing. Great day team! 🎉',
        timestamp: new Date(), isOutgoing: false, roomJid: ROOM_JID,
      },
      incrementUnread: true,
    },
  },
  // Ava sends a DM
  {
    delayMs: 271_000,
    action: 'typing',
    data: { conversationId: `ava@${DOMAIN}`, jid: `ava@${DOMAIN}`, isTyping: true },
  },
  {
    delayMs: 274_000,
    action: 'stop-typing',
    data: { conversationId: `ava@${DOMAIN}`, jid: `ava@${DOMAIN}`, isTyping: false },
  },
  {
    delayMs: 274_200,
    action: 'message',
    data: {
      message: {
        type: 'chat', id: 'demo-anim-ava-roadmap', from: `ava@${DOMAIN}`,
        body: 'Just published the Q2 roadmap! The team survey results are in — voice/video topped the list. I\'ll schedule a kickoff meeting next week.',
        timestamp: new Date(), isOutgoing: false, conversationId: `ava@${DOMAIN}`,
      },
    },
  },
  // Tutorial: XMPP console (for developers)
  {
    delayMs: 278_000,
    action: 'custom',
    data: { type: 'tutorial', stepId: 'xmpp-console-hint' },
  },
  // Poll closed
  {
    delayMs: 283_000,
    action: 'room-message',
    data: {
      roomJid: ROOM_JID,
      message: {
        type: 'groupchat', id: 'demo-anim-poll-closed', from: `${ROOM_JID}/${SELF_NICK}`, nick: SELF_NICK,
        body: '', timestamp: new Date(), isOutgoing: true, roomJid: ROOM_JID,
        pollClosed: {
          pollMessageId: 'demo-anim-poll',
          title: 'Release v0.14 — when are we ready?',
          results: [
            { emoji: '1️⃣', label: 'Ship this Friday', count: 3 },
            { emoji: '2️⃣', label: 'Next Monday after testing', count: 2 },
            { emoji: '3️⃣', label: 'Need one more week', count: 0 },
          ],
        },
      },
    },
  },
  // Final Emma DM wrapping up
  {
    delayMs: 287_000,
    action: 'message',
    data: {
      message: {
        type: 'chat', id: 'demo-anim-emma-final', from: `emma@${DOMAIN}`,
        body: 'Looks like Friday wins! I\'ll start the release branch tonight. Have a good evening! 🌙',
        timestamp: new Date(), isOutgoing: false, conversationId: `emma@${DOMAIN}`,
      },
    },
  },
  // Tutorial: closing
  {
    delayMs: 290_000,
    action: 'custom',
    data: { type: 'tutorial', stepId: 'tour-complete' },
  },
]
