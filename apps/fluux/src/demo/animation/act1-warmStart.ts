/**
 * Act 1 — Welcome & Navigation (0:00–0:45)
 * Orients the user, then shows the app is alive with typing and presence.
 */

import type { DemoAnimationStep } from '@fluux/sdk/demo'
import { DOMAIN } from '../constants'

export const act1Steps: DemoAnimationStep[] = [
  // Tutorial: welcome orientation
  {
    delayMs: 3_000,
    action: 'custom',
    data: { type: 'tutorial', stepId: 'welcome-hint' },
  },
  // Tutorial: conversations sidebar
  {
    delayMs: 12_000,
    action: 'custom',
    data: { type: 'tutorial', stepId: 'conversations-hint' },
  },
  // Emma starts typing
  {
    delayMs: 25_000,
    action: 'typing',
    data: { conversationId: `emma@${DOMAIN}`, jid: `emma@${DOMAIN}`, isTyping: true },
  },
  // Emma sends a message
  {
    delayMs: 28_000,
    action: 'stop-typing',
    data: { conversationId: `emma@${DOMAIN}`, jid: `emma@${DOMAIN}`, isTyping: false },
  },
  {
    delayMs: 28_100,
    action: 'message',
    data: {
      message: {
        type: 'chat', id: 'demo-anim-emma-reply', from: `emma@${DOMAIN}`,
        body: '4pm works for me! See you then 😊',
        timestamp: new Date(), isOutgoing: false, conversationId: `emma@${DOMAIN}`,
      },
    },
  },
  // James comes online
  {
    delayMs: 35_000,
    action: 'presence',
    data: { fullJid: `james@${DOMAIN}/mobile`, show: null, priority: 5, client: 'Fluux' },
  },
]
