import { chatStore, roomStore } from '@fluux/sdk'
import type { Message, RoomMessage } from '@fluux/sdk'
import type { XMPPClient } from '@fluux/sdk/core'

/**
 * The JS-side source of truth for the MCP tool names. The Rust side declares
 * the same list in `tool_definitions()` (src-tauri/src/mcp/protocol.rs) for
 * the wire-visible `tools/list`; a parity test in mcpTools.test.ts asserts the
 * two stay in sync, and the dispatch map in useMcpBridge.ts plus the activity
 * log's type both derive from this constant so the JS side cannot drift
 * internally.
 */
export const MCP_TOOL_NAMES = ['list_conversations', 'get_history', 'send_message'] as const
export type McpToolName = (typeof MCP_TOOL_NAMES)[number]

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
  // Clamp into [1, MAX]: messageCache treats a falsy limit as "no limit", so
  // letting 0 through would return the ENTIRE history instead of zero messages.
  // NaN/Infinity/negatives from an untrusted MCP caller fall back to the default.
  const requested = Number.isFinite(limit) ? Math.floor(limit as number) : DEFAULT_HISTORY_LIMIT
  const cappedLimit = Math.min(Math.max(1, requested), MAX_HISTORY_LIMIT)
  // An Invalid Date becomes a NaN IndexedDB key whose DataError is swallowed
  // deep in the cache layer, silently returning [] — indistinguishable from
  // "no earlier messages". Fail loudly instead so the MCP caller can correct it.
  let beforeDate: Date | undefined
  if (before !== undefined) {
    beforeDate = new Date(before)
    if (Number.isNaN(beforeDate.getTime())) {
      throw new Error(`Invalid 'before' timestamp: ${before} (expected an ISO 8601 date string)`)
    }
  }
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

  const room = roomStore.getState().rooms.get(conversationId)
  const isChat = chatStore.getState().conversations.has(conversationId)
  if (!room && !isChat) {
    throw new Error(`Unknown conversationId: ${conversationId}`)
  }
  // A known-but-unjoined room (bookmarked, or left earlier) would accept the
  // stanza at the transport level and only bounce asynchronously server-side,
  // so sendMessage would report a false success. Reject it up front instead.
  if (room && !room.joined) {
    throw new Error(`Not joined to room: ${conversationId}`)
  }
  const isRoom = room !== undefined

  const messageId = await client.chat.sendMessage(conversationId, body, isRoom ? 'groupchat' : 'chat')
  return { messageId }
}
