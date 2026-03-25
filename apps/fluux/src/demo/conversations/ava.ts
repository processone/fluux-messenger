import type { Message } from '@fluux/sdk'
import { hoursAgo, daysAgo } from '@fluux/sdk'
import { DOMAIN, SELF_JID } from '../constants'

const conv = `ava@${DOMAIN}`

export const AVA_MESSAGES: Message[] = [
  // Professional product discussion (yesterday)
  {
    type: 'chat', id: 'demo-ava-1', from: conv, body: 'I\'ve been reviewing the Q1 user feedback — a few themes keep coming up',
    timestamp: daysAgo(1), isOutgoing: false, conversationId: conv,
  },
  {
    type: 'chat', id: 'demo-ava-2', from: SELF_JID, body: 'What are the top asks?',
    timestamp: daysAgo(1), isOutgoing: true, conversationId: conv,
  },
  {
    type: 'chat', id: 'demo-ava-3', from: conv, body: 'Message search is #1 by far. Users want to find old conversations quickly. Reactions and threads are close behind.',
    timestamp: daysAgo(1), isOutgoing: false, conversationId: conv,
    reactions: { '📊': [SELF_JID] } as Record<string, string[]>,
  },
  {
    type: 'chat', id: 'demo-ava-4', from: SELF_JID, body: 'Good news — search shipped last week with full archive support. I\'ll demo it at the next all-hands',
    timestamp: daysAgo(1), isOutgoing: true, conversationId: conv,
  },
  {
    type: 'chat', id: 'demo-ava-5', from: conv, body: 'That\'s great timing! I\'ll update the roadmap and send the changelog to beta testers',
    timestamp: daysAgo(1), isOutgoing: false, conversationId: conv,
  },
  // Today — roadmap discussion
  {
    type: 'chat', id: 'demo-ava-6', from: conv, body: 'For Q2, I\'m thinking we prioritize: voice/video calls, end-to-end encryption, and mobile apps',
    timestamp: hoursAgo(6), isOutgoing: false, conversationId: conv,
  },
  {
    type: 'chat', id: 'demo-ava-7', from: SELF_JID, body: 'Voice/video is the biggest lift. We\'d need to integrate Jingle (XEP-0166) for that',
    timestamp: hoursAgo(5.5), isOutgoing: true, conversationId: conv,
  },
  {
    type: 'chat', id: 'demo-ava-8', from: conv, body: 'What about OMEMO for E2EE? The privacy-focused users have been very vocal about it',
    timestamp: hoursAgo(5), isOutgoing: false, conversationId: conv,
    replyTo: { id: 'demo-ava-7', fallbackBody: 'Voice/video is the biggest lift. We\'d need to integrate Jingle (XEP-0166) for that' },
  },
  {
    type: 'chat', id: 'demo-ava-9', from: SELF_JID, body: 'OMEMO (XEP-0384) is on the list — it\'s well-specified and we have a good crypto library ready. Should be feasible in Q2.',
    timestamp: hoursAgo(4.5), isOutgoing: true, conversationId: conv,
    reactions: { '🔐': [conv], '🙌': [conv] } as Record<string, string[]>,
  },
]
