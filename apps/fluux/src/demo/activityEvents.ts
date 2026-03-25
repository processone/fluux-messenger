import type { ActivityEventInput } from '@fluux/sdk'
import { minutesAgo, hoursAgo } from '@fluux/sdk'
import { DOMAIN, ROOM_JID } from './constants'

export function getDemoActivityEvents(): ActivityEventInput[] {
  return [
    // Yesterday: a contact request was accepted
    {
      type: 'subscription-request',
      kind: 'actionable',
      timestamp: new Date(Date.now() - 26 * 3_600_000),
      resolution: 'accepted',
      payload: { type: 'subscription-request', from: `oliver@${DOMAIN}` },
    },
    // Yesterday: joined a room from invitation
    {
      type: 'muc-invitation',
      kind: 'actionable',
      timestamp: new Date(Date.now() - 25 * 3_600_000),
      resolution: 'accepted',
      payload: {
        type: 'muc-invitation',
        roomJid: ROOM_JID,
        from: `emma@${DOMAIN}`,
        reason: 'Come join the team channel!',
        isDirect: true,
        isQuickChat: false,
      },
    },
    // Today: reactions on your messages
    {
      type: 'reaction-received',
      kind: 'informational',
      timestamp: hoursAgo(3),
      payload: {
        type: 'reaction-received',
        conversationId: `emma@${DOMAIN}`,
        messageId: 'demo-emma-3',
        reactors: [
          { reactorJid: `emma@${DOMAIN}`, emojis: ['🚀', '👍'] },
        ],
        messagePreview: 'Great — I was thinking we could ship it in the next beta',
      },
    },
    {
      type: 'reaction-received',
      kind: 'informational',
      timestamp: hoursAgo(2),
      payload: {
        type: 'reaction-received',
        conversationId: ROOM_JID,
        messageId: 'demo-room-6',
        reactors: [
          { reactorJid: 'Emma', emojis: ['✅'] },
          { reactorJid: 'Oliver', emojis: ['✅'] },
        ],
        messagePreview: "Great work everyone. Let's aim to wrap up the remaining tasks by end of week",
      },
    },
    // Today: a pending contact request
    {
      type: 'subscription-request',
      kind: 'actionable',
      timestamp: hoursAgo(1),
      resolution: 'pending',
      payload: { type: 'subscription-request', from: `alex@${DOMAIN}` },
    },
    // Today: reaction on a 1:1 message
    {
      type: 'reaction-received',
      kind: 'informational',
      timestamp: minutesAgo(30),
      payload: {
        type: 'reaction-received',
        conversationId: `james@${DOMAIN}`,
        messageId: 'demo-james-5',
        reactors: [
          { reactorJid: `james@${DOMAIN}`, emojis: ['💪'] },
        ],
        messagePreview: 'Already on it — session resumption is working nicely in the latest build',
      },
    },
    // Today: a stranger message
    {
      type: 'stranger-message',
      kind: 'actionable',
      timestamp: minutesAgo(15),
      resolution: 'pending',
      payload: { type: 'stranger-message', from: `recruiter@jobs.example`, body: 'Hi, I saw your open source work and would love to chat!' },
    },
  ]
}
