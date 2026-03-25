import type { Message } from '@fluux/sdk'
import { hoursAgo, daysAgo } from '@fluux/sdk'
import { DOMAIN, SELF_JID } from '../constants'

const conv = `mia@${DOMAIN}`

export const MIA_MESSAGES: Message[] = [
  {
    type: 'chat', id: 'demo-mia-1', from: conv, body: 'Sprint planning is done — I\'ve assigned the tickets for this week',
    timestamp: daysAgo(2), isOutgoing: false, conversationId: conv,
  },
  {
    type: 'chat', id: 'demo-mia-2', from: SELF_JID, body: 'Thanks! What\'s the priority order? I want to tackle the critical bugs first',
    timestamp: daysAgo(2), isOutgoing: true, conversationId: conv,
  },
  {
    type: 'chat', id: 'demo-mia-3', from: conv, body: 'Top priority is the notification bug on Android — users are missing messages when the app is backgrounded',
    timestamp: daysAgo(2), isOutgoing: false, conversationId: conv,
  },
  {
    type: 'chat', id: 'demo-mia-4', from: SELF_JID, body: 'Got it. I\'ll look at the push notification service config — might be a Firebase issue',
    timestamp: daysAgo(2), isOutgoing: true, conversationId: conv,
  },
  {
    type: 'chat', id: 'demo-mia-5', from: conv, body: 'Second priority is the deployment pipeline — staging deploys have been failing intermittently',
    timestamp: daysAgo(1), isOutgoing: false, conversationId: conv,
  },
  {
    type: 'chat', id: 'demo-mia-6', from: SELF_JID, body: 'I saw that too. The Docker build cache seems to be invalidating on every push',
    timestamp: daysAgo(1), isOutgoing: true, conversationId: conv,
    reactions: { '🔍': [conv] } as Record<string, string[]>,
  },
  {
    type: 'chat', id: 'demo-mia-7', from: conv, body: 'Also — release notes for v0.14 are due Friday. Can you draft the technical changes section?',
    timestamp: hoursAgo(4), isOutgoing: false, conversationId: conv,
  },
  {
    type: 'chat', id: 'demo-mia-8', from: SELF_JID, body: 'Sure, I\'ll have it ready by Thursday. Anything else for the release checklist?',
    timestamp: hoursAgo(3.5), isOutgoing: true, conversationId: conv,
  },
  // Retracted message — showcases message deletion (XEP-0424)
  {
    type: 'chat', id: 'demo-mia-8b', from: conv,
    body: '',
    timestamp: hoursAgo(3.2), isOutgoing: false, conversationId: conv,
    isRetracted: true,
    retractedAt: hoursAgo(3.1),
  },
  {
    type: 'chat', id: 'demo-mia-9', from: conv, body: 'Just the regression test pass — James is running it now. We should be good to ship on schedule',
    timestamp: hoursAgo(3), isOutgoing: false, conversationId: conv,
    reactions: { '✅': [SELF_JID] } as Record<string, string[]>,
  },
]
