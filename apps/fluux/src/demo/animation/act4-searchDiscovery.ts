/**
 * Act 4 — Activity, Search & Mentions (2:15–3:15)
 * Stranger messages, polls, search, link previews, @mentions.
 */

import type { DemoAnimationStep } from '@fluux/sdk/demo'
import { DOMAIN, SELF_JID, SELF_NICK, ROOM_JID } from '../constants'

export const act4Steps: DemoAnimationStep[] = [
  // Poll creation in Team Chat
  {
    delayMs: 140_000,
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
    delayMs: 145_000,
    action: 'room-reaction',
    data: {
      roomJid: ROOM_JID,
      messageId: 'demo-anim-poll',
      reactorNick: 'Emma',
      emojis: ['1️⃣'],
    },
  },
  {
    delayMs: 147_000,
    action: 'room-reaction',
    data: {
      roomJid: ROOM_JID,
      messageId: 'demo-anim-poll',
      reactorNick: 'Olivia',
      emojis: ['2️⃣'],
    },
  },
  // Tutorial: search
  {
    delayMs: 155_000,
    action: 'custom',
    data: { type: 'tutorial', stepId: 'search-hint' },
  },
  // Emma DM with a link
  {
    delayMs: 160_000,
    action: 'typing',
    data: { conversationId: `emma@${DOMAIN}`, jid: `emma@${DOMAIN}`, isTyping: true },
  },
  {
    delayMs: 163_000,
    action: 'stop-typing',
    data: { conversationId: `emma@${DOMAIN}`, jid: `emma@${DOMAIN}`, isTyping: false },
  },
  {
    delayMs: 163_200,
    action: 'message',
    data: {
      message: {
        type: 'chat', id: 'demo-anim-emma-link', from: `emma@${DOMAIN}`,
        body: 'Found this great article on XMPP federation — relevant to the multi-server work we\'re planning:\nhttps://www.process-one.net/blog/fluux-messenger-0-13/',
        timestamp: new Date(), isOutgoing: false, conversationId: `emma@${DOMAIN}`,
        linkPreview: {
          url: 'https://www.process-one.net/blog/fluux-messenger-0-13/',
          title: 'Fluux Messenger 0.13: group chat, reactions and more',
          description: 'Fluux Messenger 0.13 adds group chat support (MUC), emoji reactions, message replies, and improved file sharing — all built on XMPP standards.',
          siteName: 'ProcessOne',
          image: './demo/link-preview-fluux-013.png',
        },
      },
    },
  },
  // Olivia mentions @You in Team Chat
  {
    delayMs: 170_000,
    action: 'room-message',
    data: {
      roomJid: ROOM_JID,
      message: {
        type: 'groupchat', id: 'demo-anim-olivia-mention', from: `${ROOM_JID}/Olivia`, nick: 'Olivia',
        body: `@${SELF_NICK} can you review the PR for the icon update? I tagged you on GitHub`,
        timestamp: new Date(), isOutgoing: false, roomJid: ROOM_JID,
        mentions: [{ jid: SELF_JID, nick: SELF_NICK }],
      },
      incrementUnread: true,
      incrementMentions: true,
    },
  },
  // Tutorial: mention
  {
    delayMs: 175_000,
    action: 'custom',
    data: { type: 'tutorial', stepId: 'mention-hint' },
  },
  // Liam sends a casual DM
  {
    delayMs: 180_000,
    action: 'message',
    data: {
      message: {
        type: 'chat', id: 'demo-anim-liam-dm', from: `liam@${DOMAIN}`,
        body: 'Docker build is killing me today 😤 anyone else having issues?',
        timestamp: new Date(), isOutgoing: false, conversationId: `liam@${DOMAIN}`,
      },
    },
  },
  // James edits his earlier message
  {
    delayMs: 185_000,
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
]
