import { chatStore, roomStore } from '@fluux/sdk'
import type { Message, RoomMessage } from '@fluux/sdk'

export interface McpConversationSummary {
  conversationId: string
  displayName: string
  type: 'chat' | 'groupchat'
  isEncrypted: boolean
  lastMessageTimestamp: string | null
}

export interface McpHistoryMessage {
  from: string
  body: string
  timestamp: string
  isOutgoing: boolean
  isEncrypted: boolean
}

const MAX_HISTORY_LIMIT = 200
const DEFAULT_HISTORY_LIMIT = 50

export function listConversations(): McpConversationSummary[] {
  const chats: McpConversationSummary[] = Array.from(chatStore.getState().conversations.values()).map((conv) => ({
    conversationId: conv.id,
    displayName: conv.name,
    type: 'chat',
    isEncrypted: conv.lastMessage?.securityContext !== undefined,
    lastMessageTimestamp: conv.lastMessage?.timestamp.toISOString() ?? null,
  }))

  const rooms: McpConversationSummary[] = Array.from(roomStore.getState().rooms.values()).map((room) => ({
    conversationId: room.jid,
    displayName: room.name ?? room.jid,
    type: 'groupchat',
    isEncrypted: room.lastMessage?.securityContext !== undefined,
    lastMessageTimestamp: room.lastMessage?.timestamp.toISOString() ?? null,
  }))

  return [...chats, ...rooms].sort((a, b) => {
    if (!a.lastMessageTimestamp) return 1
    if (!b.lastMessageTimestamp) return -1
    return b.lastMessageTimestamp.localeCompare(a.lastMessageTimestamp)
  })
}

function toHistoryMessage(message: Message | RoomMessage): McpHistoryMessage {
  return {
    from: message.from,
    body: message.body,
    timestamp: message.timestamp.toISOString(),
    isOutgoing: message.isOutgoing,
    isEncrypted: message.securityContext !== undefined,
  }
}

export async function getHistory(
  conversationId: string,
  limit?: number,
  before?: string
): Promise<McpHistoryMessage[]> {
  const cappedLimit = Math.min(limit ?? DEFAULT_HISTORY_LIMIT, MAX_HISTORY_LIMIT)
  const beforeDate = before ? new Date(before) : undefined
  const isRoom = roomStore.getState().rooms.has(conversationId)

  const messages = isRoom
    ? await roomStore.getState().loadMessagesFromCache(conversationId, { limit: cappedLimit, before: beforeDate, peek: true })
    : await chatStore.getState().loadMessagesFromCache(conversationId, { limit: cappedLimit, before: beforeDate, peek: true })

  return messages.map(toHistoryMessage)
}
