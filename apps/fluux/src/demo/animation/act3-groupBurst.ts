/**
 * Act 3 — Rich Media & Files (1:30–2:15)
 * Demonstrates images, file sharing, and upload progress.
 */

import type { DemoAnimationStep } from '@fluux/sdk/demo'
import { DOMAIN, ROOM_JID } from '../constants'

export const act3Steps: DemoAnimationStep[] = [
  // Olivia starts typing a DM
  {
    delayMs: 90_000,
    action: 'typing',
    data: { conversationId: `olivia@${DOMAIN}`, jid: `olivia@${DOMAIN}`, isTyping: true },
  },
  // Olivia sends an image
  {
    delayMs: 93_000,
    action: 'stop-typing',
    data: { conversationId: `olivia@${DOMAIN}`, jid: `olivia@${DOMAIN}`, isTyping: false },
  },
  {
    delayMs: 93_100,
    action: 'message',
    data: {
      message: {
        type: 'chat', id: 'demo-anim-olivia-img', from: `olivia@${DOMAIN}`,
        body: 'Here\'s how the dark mode turned out — the contrast ratios are all passing now',
        timestamp: new Date(), isOutgoing: false, conversationId: `olivia@${DOMAIN}`,
        attachment: {
          url: './demo/screenshot-chat-dark.png',
          name: 'chat-dark-mode.png',
          mediaType: 'image/png',
          size: 157_430,
          width: 1280,
          height: 800,
        },
      },
    },
  },
  // Tutorial: image lightbox
  {
    delayMs: 100_000,
    action: 'custom',
    data: { type: 'tutorial', stepId: 'image-hint' },
  },
  // Team room: Emma shares a PDF
  {
    delayMs: 105_000,
    action: 'room-message',
    data: {
      roomJid: ROOM_JID,
      message: {
        type: 'groupchat', id: 'demo-anim-room-pdf', from: `${ROOM_JID}/Emma`, nick: 'Emma',
        body: 'Design spec for the new onboarding flow — take a look when you get a chance',
        timestamp: new Date(), isOutgoing: false, roomJid: ROOM_JID,
        attachment: {
          url: './demo/fluux-sdk-api-reference.pdf',
          name: 'onboarding-design-spec.pdf',
          mediaType: 'application/pdf',
          size: 2_450_000,
        },
      },
      incrementUnread: true,
    },
  },
  // Tutorial: file upload
  {
    delayMs: 110_000,
    action: 'custom',
    data: { type: 'tutorial', stepId: 'file-upload-hint' },
  },
  // Simulated upload progress
  {
    delayMs: 115_000,
    action: 'custom',
    data: {
      type: 'upload-start',
      conversationId: `emma@${DOMAIN}`,
      file: { name: 'performance-report.png', size: 450_000, mediaType: 'image/png' },
    },
  },
  // Olivia reacts to the uploaded file
  {
    delayMs: 125_000,
    action: 'chat-reaction',
    data: {
      conversationId: `olivia@${DOMAIN}`,
      messageId: 'demo-anim-olivia-img',
      reactorJid: `olivia@${DOMAIN}`,
      emojis: ['🔥'],
    },
  },
]
