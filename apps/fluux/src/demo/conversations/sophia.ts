import type { Message } from '@fluux/sdk'
import { hoursAgo, daysAgo } from '@fluux/sdk'
import { DOMAIN, SELF_JID } from '../constants'

const conv = `sophia@${DOMAIN}`

export const SOPHIA_MESSAGES: Message[] = [
  // Earlier conversation about migration guide (2 days ago)
  {
    type: 'chat', id: 'demo-sophia-0a', from: conv, body: 'Started working on the migration guide for SDK v2',
    timestamp: daysAgo(2), isOutgoing: false, conversationId: conv,
  },
  {
    type: 'chat', id: 'demo-sophia-0b', from: SELF_JID, body: 'Make sure to cover the breaking changes in the store API',
    timestamp: daysAgo(2), isOutgoing: true, conversationId: conv,
  },
  {
    type: 'chat', id: 'demo-sophia-0c', from: conv, body: 'Yes — I\'m documenting each deprecated method with its replacement and a code example',
    timestamp: daysAgo(2), isOutgoing: false, conversationId: conv,
  },
  {
    type: 'chat', id: 'demo-sophia-0d', from: SELF_JID, body: 'We should also add a section about the new versioning strategy and the changelog format',
    timestamp: daysAgo(2), isOutgoing: true, conversationId: conv,
  },
  {
    type: 'chat', id: 'demo-sophia-0e', from: conv, body: 'Good idea. I\'ll follow the Keep a Changelog convention so it\'s easy to parse',
    timestamp: daysAgo(2), isOutgoing: false, conversationId: conv,
    reactions: { '👍': [SELF_JID] } as Record<string, string[]>,
  },
  // Today's conversation
  {
    type: 'chat', id: 'demo-sophia-1', from: conv, body: 'I\'ve finished the API docs for the SDK',
    timestamp: hoursAgo(2), isOutgoing: false, conversationId: conv,
  },
  {
    type: 'chat', id: 'demo-sophia-2', from: conv,
    body: 'Here\'s the PDF with the full reference',
    timestamp: hoursAgo(2), isOutgoing: false, conversationId: conv,
    attachment: {
      url: './demo/fluux-sdk-api-reference.pdf',
      name: 'fluux-sdk-api-reference.pdf',
      mediaType: 'application/pdf',
      size: 2_450_000,
    },
  },
  {
    type: 'chat', id: 'demo-sophia-3', from: SELF_JID, body: 'This is thorough — nice work!',
    timestamp: hoursAgo(1.5), isOutgoing: true, conversationId: conv,
    replyTo: { id: 'demo-sophia-2', fallbackBody: 'Here\'s the PDF with the full reference' },
  },
  {
    type: 'chat', id: 'demo-sophia-4', from: SELF_JID, body: 'I\'ll review it this evening and add comments',
    timestamp: hoursAgo(1.5), isOutgoing: true, conversationId: conv,
  },
  {
    type: 'chat', id: 'demo-sophia-5', from: conv, body: 'Also recorded a quick walkthrough of the key changes',
    timestamp: hoursAgo(1.2), isOutgoing: false, conversationId: conv,
    reactions: { '🙏': [SELF_JID] },
    attachment: {
      url: './demo/sdk-walkthrough.mp4',
      name: 'sdk-walkthrough.mp4',
      mediaType: 'video/mp4',
      size: 18_700_000,
      width: 1920,
      height: 1080,
      duration: 245,
    },
  },
  {
    type: 'chat', id: 'demo-sophia-6', from: conv, body: 'Take your time, no rush 👍',
    timestamp: hoursAgo(1), isOutgoing: false, conversationId: conv,
  },
]
