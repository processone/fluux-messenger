/**
 * Act 2 — File Transfer Showcase (0:30–1:30)
 * Demonstrates receiving and sending files.
 */

import type { DemoAnimationStep } from '@fluux/sdk'
import { DOMAIN, ROOM_JID } from '../constants'

export const act2Steps: DemoAnimationStep[] = [
  // Oliver starts typing
  {
    delayMs: 30_000,
    action: 'typing',
    data: { conversationId: `oliver@${DOMAIN}`, jid: `oliver@${DOMAIN}`, isTyping: true },
  },
  // Oliver sends an image
  {
    delayMs: 33_000,
    action: 'stop-typing',
    data: { conversationId: `oliver@${DOMAIN}`, jid: `oliver@${DOMAIN}`, isTyping: false },
  },
  {
    delayMs: 33_100,
    action: 'message',
    data: {
      message: {
        type: 'chat', id: 'demo-anim-oliver-img', from: `oliver@${DOMAIN}`,
        body: 'Here\'s the updated architecture diagram — the new module layout is much cleaner',
        timestamp: new Date(), isOutgoing: false, conversationId: `oliver@${DOMAIN}`,
        attachment: {
          url: './demo/screenshot-fluux-contacts.png',
          name: 'architecture-diagram.png',
          mediaType: 'image/png',
          size: 206_620,
          width: 1456,
          height: 816,
        },
      },
    },
  },
  // Tutorial: image lightbox
  {
    delayMs: 36_000,
    action: 'custom',
    data: { type: 'tutorial', stepId: 'image-lightbox' },
  },
  // Team room: Emma shares a PDF
  {
    delayMs: 45_000,
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
    delayMs: 55_000,
    action: 'custom',
    data: { type: 'tutorial', stepId: 'file-upload-hint' },
  },
  // Simulated upload progress
  {
    delayMs: 60_000,
    action: 'custom',
    data: {
      type: 'upload-start',
      conversationId: `emma@${DOMAIN}`,
      file: { name: 'performance-report.png', size: 450_000, mediaType: 'image/png' },
    },
  },
  // Oliver reacts to the uploaded file (fires after upload completes ~68s)
  {
    delayMs: 75_000,
    action: 'chat-reaction',
    data: {
      conversationId: `oliver@${DOMAIN}`,
      messageId: 'demo-anim-oliver-img',
      reactorJid: `oliver@${DOMAIN}`,
      emojis: ['🔥'],
    },
  },
]
