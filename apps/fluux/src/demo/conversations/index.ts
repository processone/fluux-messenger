import type { Message, Conversation } from '@fluux/sdk'
import { DOMAIN } from '../constants'
import { EMMA_MESSAGES } from './emma'
import { JAMES_MESSAGES } from './james'
import { SOPHIA_MESSAGES } from './sophia'
import { OLIVER_MESSAGES } from './oliver'
import { MIA_MESSAGES } from './mia'
import { LIAM_MESSAGES } from './liam'
import { AVA_MESSAGES } from './ava'

export { EMMA_MESSAGES } from './emma'
export { JAMES_MESSAGES } from './james'
export { SOPHIA_MESSAGES } from './sophia'
export { OLIVER_MESSAGES } from './oliver'
export { MIA_MESSAGES } from './mia'
export { LIAM_MESSAGES } from './liam'
export { AVA_MESSAGES } from './ava'

const CONVERSATION_ENTRIES: Array<{
  jid: string
  name: string
  unreadCount: number
  messages: Message[]
}> = [
  { jid: `emma@${DOMAIN}`, name: 'Emma Wilson', unreadCount: 2, messages: EMMA_MESSAGES },
  { jid: `james@${DOMAIN}`, name: 'James Chen', unreadCount: 0, messages: JAMES_MESSAGES },
  { jid: `sophia@${DOMAIN}`, name: 'Sophia Rodriguez', unreadCount: 0, messages: SOPHIA_MESSAGES },
  { jid: `oliver@${DOMAIN}`, name: 'Oliver Park', unreadCount: 0, messages: OLIVER_MESSAGES },
  { jid: `mia@${DOMAIN}`, name: 'Mia Thompson', unreadCount: 1, messages: MIA_MESSAGES },
  { jid: `liam@${DOMAIN}`, name: 'Liam Brooks', unreadCount: 0, messages: LIAM_MESSAGES },
  { jid: `ava@${DOMAIN}`, name: 'Ava Martinez', unreadCount: 0, messages: AVA_MESSAGES },
]

export function getDemoConversations(): Conversation[] {
  return CONVERSATION_ENTRIES.map(({ jid, name, unreadCount, messages }) => ({
    id: jid,
    name,
    type: 'chat' as const,
    unreadCount,
    lastMessage: messages.at(-1),
  }))
}

export function getDemoMessages(): Map<string, Message[]> {
  const map = new Map<string, Message[]>()
  for (const { jid, messages } of CONVERSATION_ENTRIES) {
    map.set(jid, messages)
  }
  return map
}
