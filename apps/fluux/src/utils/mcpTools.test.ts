import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { type Conversation, type Message, type Room } from '@fluux/sdk'
import type { XMPPClient } from '@fluux/sdk/core'
import { listConversations, getHistory, sendMessageTool, MCP_TOOL_NAMES, __resetSendRateLimitForTests } from './mcpTools'

// Override the SDK mock to provide setState on stores
const mockChatState = {
  conversations: new Map(),
  messages: new Map(),
  loadMessagesFromCache: vi.fn(),
}
const mockRoomState = {
  rooms: new Map(),
  roomRuntime: new Map(),
  loadMessagesFromCache: vi.fn(),
}

vi.mock('@fluux/sdk', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@fluux/sdk')>()
  return {
    ...actual,
    chatStore: {
      getState: () => mockChatState,
      setState: (update: any) => Object.assign(mockChatState, update),
      subscribe: vi.fn(() => vi.fn()),
    },
    roomStore: {
      getState: () => mockRoomState,
      setState: (update: any) => Object.assign(mockRoomState, update),
      subscribe: vi.fn(() => vi.fn()),
    },
  }
})

// Import after the mock is set up
import { chatStore, roomStore } from '@fluux/sdk'

function makeMessage(overrides: Partial<Message> = {}): Message {
  return {
    type: 'chat',
    id: 'msg-1',
    from: 'alice@example.com',
    body: 'hello',
    timestamp: new Date('2026-07-01T10:00:00Z'),
    isOutgoing: false,
    ...overrides,
  } as Message
}

describe('mcpTools', () => {
  beforeEach(() => {
    chatStore.setState({ conversations: new Map(), messages: new Map() })
    roomStore.setState({ rooms: new Map(), roomRuntime: new Map() })
  })

  describe('tool registry parity', () => {
    it('matches the tool names advertised by the Rust tool_definitions()', () => {
      // The Rust side owns the wire-visible tools/list; the JS side owns the
      // dispatch map and activity-log types via MCP_TOOL_NAMES. This test is
      // the tripwire that keeps the two languages from drifting apart.
      const protocolRs = readFileSync(
        resolve(__dirname, '../../src-tauri/src/mcp/protocol.rs'),
        'utf-8'
      )
      const toolDefinitions = protocolRs.slice(
        protocolRs.indexOf('pub fn tool_definitions'),
        protocolRs.indexOf('const PROTOCOL_VERSION')
      )
      expect(toolDefinitions.length).toBeGreaterThan(0)

      const rustToolNames = [...toolDefinitions.matchAll(/"name":\s*"([a-z_]+)"/g)].map((m) => m[1])
      expect(rustToolNames.sort()).toEqual([...MCP_TOOL_NAMES].sort())
    })
  })

  describe('listConversations', () => {
    it('returns chat conversations with encryption status from the last message', () => {
      const conversation = {
        id: 'alice@example.com',
        name: 'Alice',
        type: 'chat',
        unreadCount: 0,
        lastMessage: makeMessage({ securityContext: { protocolId: 'omemo:2', trust: 'verified' } }),
      } as Conversation
      chatStore.setState({ conversations: new Map([[conversation.id, conversation]]) })

      const result = listConversations()

      expect(result).toEqual([
        expect.objectContaining({
          conversationId: 'alice@example.com',
          displayName: 'Alice',
          type: 'chat',
          isEncrypted: true,
        }),
      ])
    })

    it('keeps message-less conversations in insertion order after ones with messages', () => {
      chatStore.setState({
        conversations: new Map([
          ['empty-a@example.com', { id: 'empty-a@example.com', name: 'Empty A' } as Conversation],
          ['empty-b@example.com', { id: 'empty-b@example.com', name: 'Empty B' } as Conversation],
          [
            'active@example.com',
            { id: 'active@example.com', name: 'Active', lastMessage: makeMessage() } as Conversation,
          ],
        ]),
      })

      const result = listConversations()

      expect(result.map((c) => c.conversationId)).toEqual([
        'active@example.com',
        'empty-a@example.com',
        'empty-b@example.com',
      ])
    })

    it('returns groupchat rooms, falling back to the room jid for the display name', () => {
      const room = { jid: 'room@conference.example.com', name: undefined, lastMessage: undefined } as unknown as Room
      roomStore.setState({ rooms: new Map([[room.jid, room]]) })

      const result = listConversations()

      expect(result).toEqual([
        expect.objectContaining({
          conversationId: 'room@conference.example.com',
          displayName: 'room@conference.example.com',
          type: 'groupchat',
          isEncrypted: false,
        }),
      ])
    })
  })

  describe('getHistory', () => {
    it('reads chat history via a peek load and reports per-message encryption', async () => {
      chatStore.setState({
        conversations: new Map([['alice@example.com', { id: 'alice@example.com' } as Conversation]]),
      })
      const loadSpy = vi
        .spyOn(chatStore.getState(), 'loadMessagesFromCache')
        .mockResolvedValue([makeMessage({ securityContext: { protocolId: 'openpgp', trust: 'tofu' } })])

      const result = await getHistory('alice@example.com', 10)

      expect(loadSpy).toHaveBeenCalledWith('alice@example.com', { limit: 10, before: undefined, peek: true })
      expect(result).toEqual([
        expect.objectContaining({ from: 'alice@example.com', body: 'hello', isEncrypted: true }),
      ])
    })

    it('caps the limit at 200 and routes room ids to roomStore', async () => {
      roomStore.setState({
        rooms: new Map([['room@conference.example.com', { jid: 'room@conference.example.com' } as Room]]),
      })
      const loadSpy = vi.spyOn(roomStore.getState(), 'loadMessagesFromCache').mockResolvedValue([])

      await getHistory('room@conference.example.com', 500)

      expect(loadSpy).toHaveBeenCalledWith('room@conference.example.com', {
        limit: 200,
        before: undefined,
        peek: true,
      })
    })

    it('clamps zero, negative, and non-finite limits instead of passing them through', async () => {
      chatStore.setState({
        conversations: new Map([['alice@example.com', { id: 'alice@example.com' } as Conversation]]),
      })
      const loadSpy = vi.spyOn(chatStore.getState(), 'loadMessagesFromCache').mockResolvedValue([])

      // limit 0 must NOT reach the cache layer, which treats falsy limits as "unlimited"
      await getHistory('alice@example.com', 0)
      expect(loadSpy).toHaveBeenLastCalledWith('alice@example.com', { limit: 1, before: undefined, peek: true })

      await getHistory('alice@example.com', -5)
      expect(loadSpy).toHaveBeenLastCalledWith('alice@example.com', { limit: 1, before: undefined, peek: true })

      await getHistory('alice@example.com', Number.NaN)
      expect(loadSpy).toHaveBeenLastCalledWith('alice@example.com', { limit: 50, before: undefined, peek: true })

      await getHistory('alice@example.com', Number.POSITIVE_INFINITY)
      expect(loadSpy).toHaveBeenLastCalledWith('alice@example.com', { limit: 50, before: undefined, peek: true })
    })

    it('rejects a malformed before timestamp instead of silently returning empty history', async () => {
      chatStore.setState({
        conversations: new Map([['alice@example.com', { id: 'alice@example.com' } as Conversation]]),
      })
      const loadSpy = vi.spyOn(chatStore.getState(), 'loadMessagesFromCache').mockResolvedValue([])
      loadSpy.mockClear() // the store mock is shared module state; drop calls from earlier tests

      await expect(getHistory('alice@example.com', 10, 'not-a-date')).rejects.toThrow("Invalid 'before' timestamp")
      expect(loadSpy).not.toHaveBeenCalled()

      // A valid ISO string still goes through as a Date.
      await getHistory('alice@example.com', 10, '2026-07-01T10:00:00Z')
      expect(loadSpy).toHaveBeenCalledWith('alice@example.com', {
        limit: 10,
        before: new Date('2026-07-01T10:00:00Z'),
        peek: true,
      })
    })
  })

  describe('sendMessageTool', () => {
    beforeEach(() => {
      __resetSendRateLimitForTests()
    })

    it('sends to a known chat conversation as type chat', async () => {
      chatStore.setState({ conversations: new Map([['alice@example.com', { id: 'alice@example.com' } as Conversation]]) })
      const sendMessage = vi.fn().mockResolvedValue('msg-123')
      const client = { chat: { sendMessage } } as unknown as XMPPClient

      const result = await sendMessageTool(client, 'alice@example.com', 'hi')

      expect(sendMessage).toHaveBeenCalledWith('alice@example.com', 'hi', 'chat')
      expect(result).toEqual({ messageId: 'msg-123' })
    })

    it('sends to a joined room as type groupchat', async () => {
      roomStore.setState({
        rooms: new Map([['room@conference.example.com', { jid: 'room@conference.example.com', joined: true } as Room]]),
      })
      const sendMessage = vi.fn().mockResolvedValue('msg-456')
      const client = { chat: { sendMessage } } as unknown as XMPPClient

      await sendMessageTool(client, 'room@conference.example.com', 'hi room')

      expect(sendMessage).toHaveBeenCalledWith('room@conference.example.com', 'hi room', 'groupchat')
    })

    it('rejects sending to a known room the user is not joined to', async () => {
      roomStore.setState({
        rooms: new Map([['room@conference.example.com', { jid: 'room@conference.example.com', joined: false } as Room]]),
      })
      const sendMessage = vi.fn()
      const client = { chat: { sendMessage } } as unknown as XMPPClient

      await expect(sendMessageTool(client, 'room@conference.example.com', 'hi')).rejects.toThrow('Not joined to room')
      expect(sendMessage).not.toHaveBeenCalled()
    })

    it('rejects an unknown conversationId', async () => {
      const client = { chat: { sendMessage: vi.fn() } } as unknown as XMPPClient
      await expect(sendMessageTool(client, 'ghost@example.com', 'hi')).rejects.toThrow('Unknown conversationId')
    })

    it('throws after 10 sends within a 60s window and recovers once it passes', async () => {
      vi.useFakeTimers()
      chatStore.setState({ conversations: new Map([['alice@example.com', { id: 'alice@example.com' } as Conversation]]) })
      const sendMessage = vi.fn().mockResolvedValue('msg-id')
      const client = { chat: { sendMessage } } as unknown as XMPPClient

      for (let i = 0; i < 10; i++) {
        await sendMessageTool(client, 'alice@example.com', `msg ${i}`)
      }
      await expect(sendMessageTool(client, 'alice@example.com', 'one too many')).rejects.toThrow('Rate limit exceeded')

      vi.advanceTimersByTime(60_001)
      await expect(sendMessageTool(client, 'alice@example.com', 'ok now')).resolves.toEqual({ messageId: 'msg-id' })

      vi.useRealTimers()
    })
  })
})
