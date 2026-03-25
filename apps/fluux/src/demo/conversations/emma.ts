import type { Message } from '@fluux/sdk'
import { minutesAgo, daysAgo } from '@fluux/sdk'
import { DOMAIN, SELF_JID } from '../constants'

const conv = `emma@${DOMAIN}`

export const EMMA_MESSAGES: Message[] = [
  // Earlier conversation about animations (yesterday)
  {
    type: 'chat', id: 'demo-emma-0a', from: conv, body: 'I\'ve been experimenting with the transition animations for the sidebar',
    timestamp: daysAgo(1), isOutgoing: false, conversationId: conv,
  },
  {
    type: 'chat', id: 'demo-emma-0b', from: SELF_JID, body: 'How\'s the performance? We need to keep it under 16ms per frame',
    timestamp: daysAgo(1), isOutgoing: true, conversationId: conv,
  },
  {
    type: 'chat', id: 'demo-emma-0c', from: conv, body: 'Running smooth — I used CSS transforms instead of layout properties so the GPU handles it',
    timestamp: daysAgo(1), isOutgoing: false, conversationId: conv,
    reactions: { '👏': [SELF_JID] } as Record<string, string[]>,
  },
  {
    type: 'chat', id: 'demo-emma-0d', from: SELF_JID, body: 'Smart. We should also add a reduced-motion media query fallback for accessibility',
    timestamp: daysAgo(1), isOutgoing: true, conversationId: conv,
  },
  {
    type: 'chat', id: 'demo-emma-0e', from: conv, body: 'Already done! I tested it with VoiceOver too — screen readers skip the animation entirely',
    timestamp: daysAgo(1), isOutgoing: false, conversationId: conv,
  },
  // Today's conversation
  {
    type: 'chat', id: 'demo-emma-1', from: SELF_JID, body: 'Hey Emma, did you see the latest mockups?',
    timestamp: minutesAgo(45), isOutgoing: true, conversationId: conv,
  },
  {
    type: 'chat', id: 'demo-emma-2', from: conv, body: 'Yes! The new sidebar looks fantastic 🎨',
    timestamp: minutesAgo(43), isOutgoing: false, conversationId: conv,
    reactions: { '🔥': [SELF_JID] } as Record<string, string[]>,
  },
  {
    type: 'chat', id: 'demo-emma-3', from: SELF_JID, body: 'Great — I was thinking we could ship it in the next beta',
    timestamp: minutesAgo(42), isOutgoing: true, conversationId: conv,
    reactions: { '🚀': [conv], '👍': [conv] } as Record<string, string[]>,
  },
  {
    type: 'chat', id: 'demo-emma-4', from: conv, body: 'Sounds good. I\'ll update the design tokens this afternoon',
    timestamp: minutesAgo(40), isOutgoing: false, conversationId: conv,
  },
  {
    type: 'chat', id: 'demo-emma-5', from: SELF_JID, body: 'Perfect, let me know when it\'s ready for review',
    timestamp: minutesAgo(38), isOutgoing: true, conversationId: conv,
  },
  {
    type: 'chat', id: 'demo-emma-6', from: conv, body: 'Here\'s a screenshot of the contacts view',
    timestamp: minutesAgo(15), isOutgoing: false, conversationId: conv,
    attachment: {
      url: './demo/screenshot-fluux-contacts.png',
      name: 'fluux-contacts-screenshot.png',
      mediaType: 'image/png',
      size: 206_620,
      width: 1456,
      height: 816,
    },
  },
  {
    type: 'chat', id: 'demo-emma-8', from: conv, body: 'Will do! Also, Oliver mentioned he has some icon suggestions',
    timestamp: minutesAgo(8), isOutgoing: false, conversationId: conv,
    replyTo: { id: 'demo-emma-5', fallbackBody: 'Perfect, let me know when it\'s ready for review' },
  },
  {
    type: 'chat', id: 'demo-emma-9', from: conv, body: 'Can we do a quick sync at 4?',
    timestamp: minutesAgo(5), isOutgoing: false, conversationId: conv,
  },
]
