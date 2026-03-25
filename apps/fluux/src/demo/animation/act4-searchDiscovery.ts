/**
 * Act 4 — Search, Mentions & Discovery (2:30–3:15)
 * Prompts user to try search, showcases mentions and muting.
 */

import type { DemoAnimationStep } from '@fluux/sdk'
import { DOMAIN, SELF_JID, SELF_NICK, ROOM_JID } from '../constants'

export const act4Steps: DemoAnimationStep[] = [
  // Tutorial: search
  {
    delayMs: 150_000,
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
  // Oliver mentions @You in Team Chat
  {
    delayMs: 180_000,
    action: 'room-message',
    data: {
      roomJid: ROOM_JID,
      message: {
        type: 'groupchat', id: 'demo-anim-oliver-mention', from: `${ROOM_JID}/Oliver`, nick: 'Oliver',
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
    delayMs: 185_000,
    action: 'custom',
    data: { type: 'tutorial', stepId: 'mention-hint' },
  },
  // Tutorial: keyboard shortcut hint (Cmd+K / ?)
  {
    delayMs: 190_000,
    action: 'custom',
    data: { type: 'tutorial', stepId: 'keyboard-shortcuts-hint' },
  },
]
