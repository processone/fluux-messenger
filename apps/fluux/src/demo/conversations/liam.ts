import type { Message } from '@fluux/sdk'
import { hoursAgo, daysAgo } from '@fluux/sdk'
import { DOMAIN, SELF_JID } from '../constants'

const conv = `liam@${DOMAIN}`

export const LIAM_MESSAGES: Message[] = [
  // Casual DevOps banter (yesterday)
  {
    type: 'chat', id: 'demo-liam-1', from: conv, body: 'Anyone else\'s Docker build taking forever today? My CI pipeline has been stuck for 20 minutes',
    timestamp: daysAgo(1), isOutgoing: false, conversationId: conv,
  },
  {
    type: 'chat', id: 'demo-liam-2', from: SELF_JID, body: 'Yeah the registry has been slow. Try using the --cache-from flag with the previous image tag',
    timestamp: daysAgo(1), isOutgoing: true, conversationId: conv,
  },
  {
    type: 'chat', id: 'demo-liam-3', from: conv, body: 'Oh that\'s genius, saved like 8 minutes per build 🏎️',
    timestamp: daysAgo(1), isOutgoing: false, conversationId: conv,
    reactions: { '💨': [SELF_JID] } as Record<string, string[]>,
  },
  // Mix of work and casual (today)
  {
    type: 'chat', id: 'demo-liam-4', from: conv, body: 'BTW are you going to the team lunch on Friday?',
    timestamp: hoursAgo(5), isOutgoing: false, conversationId: conv,
  },
  {
    type: 'chat', id: 'demo-liam-5', from: SELF_JID, body: 'Definitely! I heard they booked that ramen place downtown 🍜',
    timestamp: hoursAgo(4.5), isOutgoing: true, conversationId: conv,
  },
  {
    type: 'chat', id: 'demo-liam-6', from: conv, body: 'Nice. Also here\'s a quick voice note about the Terraform issue I mentioned earlier',
    timestamp: hoursAgo(4), isOutgoing: false, conversationId: conv,
    attachment: {
      url: './demo/voice-note.ogg',
      name: 'terraform-issue.ogg',
      mediaType: 'audio/ogg',
      size: 42_000,
      duration: 12,
    },
  },
  {
    type: 'chat', id: 'demo-liam-7', from: SELF_JID, body: 'Got it, I\'ll take a look after lunch. The state drift has been a pain lately',
    timestamp: hoursAgo(3.8), isOutgoing: true, conversationId: conv,
  },
]
