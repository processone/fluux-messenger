/**
 * Act 6 — Grand Finale (4:15–5:00)
 * Fill end state, admin showcase, XMPP console, last flurry.
 */

import type { DemoAnimationStep } from '@fluux/sdk'
import { DOMAIN, SELF_NICK, ROOM_JID } from '../constants'

export const act6Steps: DemoAnimationStep[] = [
  // Presence changes
  {
    delayMs: 255_000,
    action: 'presence',
    data: { fullJid: `sophia@${DOMAIN}/laptop`, show: 'dnd', priority: 5, statusMessage: 'Do not disturb — wrapping up docs', client: 'Fluux' },
  },
  {
    delayMs: 257_000,
    action: 'presence',
    data: { fullJid: `james@${DOMAIN}/mobile`, show: 'away', priority: 0, statusMessage: 'Grabbing coffee', client: 'Fluux' },
  },
  // Tutorial: admin panel
  {
    delayMs: 260_000,
    action: 'custom',
    data: { type: 'tutorial', stepId: 'admin-hint' },
  },
  // Emma summary in Team room
  {
    delayMs: 265_000,
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
  // New subscription request
  {
    delayMs: 270_000,
    action: 'activity-event',
    data: {
      type: 'subscription-request',
      kind: 'actionable',
      timestamp: new Date(),
      resolution: 'pending',
      payload: { type: 'subscription-request', from: `nina@${DOMAIN}` },
    },
  },
  // MUC invitation
  {
    delayMs: 273_000,
    action: 'activity-event',
    data: {
      type: 'muc-invitation',
      kind: 'actionable',
      timestamp: new Date(),
      resolution: 'pending',
      payload: {
        type: 'muc-invitation',
        roomJid: `releases@conference.${DOMAIN}`,
        from: `ava@${DOMAIN}`,
        reason: 'Join us for the v0.14 release planning!',
        isDirect: true,
        isQuickChat: false,
      },
    },
  },
  // Ava sends a DM
  {
    delayMs: 275_000,
    action: 'typing',
    data: { conversationId: `ava@${DOMAIN}`, jid: `ava@${DOMAIN}`, isTyping: true },
  },
  {
    delayMs: 278_000,
    action: 'stop-typing',
    data: { conversationId: `ava@${DOMAIN}`, jid: `ava@${DOMAIN}`, isTyping: false },
  },
  {
    delayMs: 278_200,
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
    delayMs: 282_000,
    action: 'custom',
    data: { type: 'tutorial', stepId: 'xmpp-console-hint' },
  },
  // Tutorial: history/MAM hint
  {
    delayMs: 286_000,
    action: 'custom',
    data: { type: 'tutorial', stepId: 'history-hint' },
  },
  // Poll closed
  {
    delayMs: 288_000,
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
    delayMs: 292_000,
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
    delayMs: 295_000,
    action: 'custom',
    data: { type: 'tutorial', stepId: 'tour-complete' },
  },
]
