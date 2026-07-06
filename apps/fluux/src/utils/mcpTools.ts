import { chatStore, roomStore } from '@fluux/sdk'
import type { Message, RoomMessage } from '@fluux/sdk'
import type { XMPPClient } from '@fluux/sdk/core'

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
  // isEncrypted reflects the last message only (the SDK has no per-thread encryption flag),
  // so a mostly-encrypted conversation whose latest message was cleartext reports false here.
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

const SEND_RATE_LIMIT = 10
const SEND_RATE_WINDOW_MS = 60_000
let sendTimestamps: number[] = []

function checkSendRateLimit(): void {
  const now = Date.now()
  sendTimestamps = sendTimestamps.filter((t) => now - t < SEND_RATE_WINDOW_MS)
  if (sendTimestamps.length >= SEND_RATE_LIMIT) {
    throw new Error(`Rate limit exceeded: max ${SEND_RATE_LIMIT} messages per minute via MCP`)
  }
  sendTimestamps.push(now)
}

/** Test-only: clears the in-memory send-rate-limit window between tests. */
export function __resetSendRateLimitForTests(): void {
  sendTimestamps = []
}

export async function sendMessageTool(
  client: XMPPClient,
  conversationId: string,
  body: string
): Promise<{ messageId: string }> {
  checkSendRateLimit()

  const isRoom = roomStore.getState().rooms.has(conversationId)
  const isChat = chatStore.getState().conversations.has(conversationId)
  if (!isRoom && !isChat) {
    throw new Error(`Unknown conversationId: ${conversationId}`)
  }

  const messageId = await client.chat.sendMessage(conversationId, body, isRoom ? 'groupchat' : 'chat')
  return { messageId }
}
