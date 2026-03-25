/**
 * Act 1 — Warm Start (0:00–0:30)
 * Shows the app is alive. Typing indicator, incoming message, presence change.
 */

import type { DemoAnimationStep } from '@fluux/sdk'
import { DOMAIN } from '../constants'

export const act1Steps: DemoAnimationStep[] = [
  // Emma starts typing
  {
    delayMs: 3_000,
    action: 'typing',
    data: { conversationId: `emma@${DOMAIN}`, jid: `emma@${DOMAIN}`, isTyping: true },
  },
  // Emma sends a message
  {
    delayMs: 5_500,
    action: 'stop-typing',
    data: { conversationId: `emma@${DOMAIN}`, jid: `emma@${DOMAIN}`, isTyping: false },
  },
  {
    delayMs: 5_600,
    action: 'message',
    data: {
      message: {
        type: 'chat', id: 'demo-anim-emma-reply', from: `emma@${DOMAIN}`,
        body: '4pm works for me! See you then 😊',
        timestamp: new Date(), isOutgoing: false, conversationId: `emma@${DOMAIN}`,
      },
    },
  },
  // Tutorial: lightbox hint
  {
    delayMs: 10_000,
    action: 'custom',
    data: { type: 'tutorial', stepId: 'lightbox-hint' },
  },
  // James comes online
  {
    delayMs: 15_000,
    action: 'presence',
    data: { fullJid: `james@${DOMAIN}/mobile`, show: null, priority: 5, client: 'Fluux' },
  },
]
