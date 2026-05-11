import type { ActivityEvent } from '@fluux/sdk'
import { getBareJid } from '@fluux/sdk'

export interface NavigationTarget {
  type: 'conversation' | 'room' | 'contact' | 'auto'
  jid: string
  messageId?: string
}

/**
 * Extract navigation target from an activity event.
 * Returns null for non-navigable events (system errors, denied subscriptions).
 * 'auto' means the caller needs to check if the JID is a room or conversation.
 */
export function getNavigationTarget(event: ActivityEvent): NavigationTarget | null {
  const p = event.payload
  switch (p.type) {
    case 'reaction-received':
      // conversationId could be a 1:1 JID or a room JID — caller determines which
      return { type: 'auto', jid: p.conversationId, messageId: p.messageId }
    case 'subscription-request':
    case 'subscription-accepted':
      return { type: 'contact', jid: getBareJid(p.from) }
    case 'muc-invitation':
      return { type: 'room', jid: p.roomJid }
    case 'stranger-message':
      return { type: 'conversation', jid: getBareJid(p.from) }
    default:
      return null
  }
}
