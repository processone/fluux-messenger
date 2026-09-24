/**
 * Tests for type guards and discriminated union types.
 *
 * These tests verify that the type system correctly distinguishes
 * between chat messages and room messages.
 */
import { describe, it, expect } from 'vitest'
import { isChatMessage, isRoomMessage, type Message, type RoomMessage, type AnyMessage } from './index'

describe('Message Type Guards', () => {
  // Helper to create minimal chat message
  const createChatMessage = (overrides: Partial<Message> = {}): Message => ({
    stanzaId: undefined, originId: undefined,
    type: 'chat',
    id: 'msg-1',
    conversationId: 'contact@example.com',
    from: 'contact@example.com',
    body: 'Hello',
    timestamp: new Date(),
    isOutgoing: false,
    ...overrides,
  })

  // Helper to create minimal room message
  const createRoomMessage = (overrides: Partial<RoomMessage> = {}): RoomMessage => ({
    stanzaId: undefined, originId: undefined, occupantId: undefined,
    type: 'groupchat',
    id: 'msg-1',
    roomJid: 'room@conference.example.com',
    from: 'room@conference.example.com/nick',
    nick: 'nick',
    body: 'Hello',
    timestamp: new Date(),
    isOutgoing: false,
    ...overrides,
  })

  describe('isChatMessage', () => {
    it('should return true for chat messages', () => {
      const msg = createChatMessage()
      expect(isChatMessage(msg)).toBe(true)
    })

    it('should return false for room messages', () => {
      const msg = createRoomMessage()
      expect(isChatMessage(msg)).toBe(false)
    })

    it('should narrow type to Message', () => {
      const msg: AnyMessage = createChatMessage()
      if (isChatMessage(msg)) {
        // TypeScript should allow accessing conversationId
        expect(msg.conversationId).toBe('contact@example.com')
      }
    })

    it('should work with array of mixed messages', () => {
      const messages: AnyMessage[] = [
        createChatMessage({ id: 'chat-1' }),
        createRoomMessage({ id: 'room-1' }),
        createChatMessage({ id: 'chat-2' }),
      ]

      const chatMessages = messages.filter(isChatMessage)
      expect(chatMessages).toHaveLength(2)
      expect(chatMessages[0].id).toBe('chat-1')
      expect(chatMessages[1].id).toBe('chat-2')
    })
  })

  describe('isRoomMessage', () => {
    it('should return true for room messages', () => {
      const msg = createRoomMessage()
      expect(isRoomMessage(msg)).toBe(true)
    })

    it('should return false for chat messages', () => {
      const msg = createChatMessage()
      expect(isRoomMessage(msg)).toBe(false)
    })

    it('should narrow type to RoomMessage', () => {
      const msg: AnyMessage = createRoomMessage()
      if (isRoomMessage(msg)) {
        // TypeScript should allow accessing roomJid and nick
        expect(msg.roomJid).toBe('room@conference.example.com')
        expect(msg.nick).toBe('nick')
      }
    })

    it('should work with array of mixed messages', () => {
      const messages: AnyMessage[] = [
        createChatMessage({ id: 'chat-1' }),
        createRoomMessage({ id: 'room-1' }),
        createRoomMessage({ id: 'room-2' }),
      ]

      const roomMessages = messages.filter(isRoomMessage)
      expect(roomMessages).toHaveLength(2)
      expect(roomMessages[0].id).toBe('room-1')
      expect(roomMessages[1].id).toBe('room-2')
    })
  })

  describe('Type discrimination', () => {
    it('should correctly identify message type by discriminator', () => {
      const chatMsg = createChatMessage()
      const roomMsg = createRoomMessage()

      expect(chatMsg.type).toBe('chat')
      expect(roomMsg.type).toBe('groupchat')
    })

    it('should allow pattern matching on type', () => {
      const processMessage = (msg: AnyMessage): string => {
        switch (msg.type) {
          case 'chat':
            return `Chat with ${msg.conversationId}`
          case 'groupchat':
            return `Room ${msg.roomJid} by ${msg.nick}`
        }
      }

      expect(processMessage(createChatMessage())).toBe('Chat with contact@example.com')
      expect(processMessage(createRoomMessage())).toBe('Room room@conference.example.com by nick')
    })

    it('should partition messages by type', () => {
      const messages: AnyMessage[] = [
        createChatMessage({ id: 'c1' }),
        createRoomMessage({ id: 'r1' }),
        createChatMessage({ id: 'c2' }),
        createRoomMessage({ id: 'r2' }),
        createRoomMessage({ id: 'r3' }),
      ]

      const chats = messages.filter(isChatMessage)
      const rooms = messages.filter(isRoomMessage)

      expect(chats).toHaveLength(2)
      expect(rooms).toHaveLength(3)
      expect(chats.length + rooms.length).toBe(messages.length)
    })
  })

  describe('Shared fields (BaseMessage)', () => {
    it('should have common fields accessible on both types', () => {
      const chatMsg = createChatMessage({
        body: 'Shared body',
        isOutgoing: true,
        isEdited: true,
      })
      const roomMsg = createRoomMessage({
        body: 'Shared body',
        isOutgoing: true,
        isEdited: true,
      })

      // Both should have these BaseMessage fields
      expect(chatMsg.body).toBe('Shared body')
      expect(roomMsg.body).toBe('Shared body')
      expect(chatMsg.isOutgoing).toBe(true)
      expect(roomMsg.isOutgoing).toBe(true)
      expect(chatMsg.isEdited).toBe(true)
      expect(roomMsg.isEdited).toBe(true)
    })

    it('should work with functions accepting BaseMessage fields', () => {
      // Function that only uses BaseMessage fields
      const isEditable = (msg: { isOutgoing: boolean; isRetracted?: boolean }): boolean => {
        return msg.isOutgoing && !msg.isRetracted
      }

      const editableChatMsg = createChatMessage({ isOutgoing: true })
      const retractedRoomMsg = createRoomMessage({ isOutgoing: true, isRetracted: true })
      const incomingMsg = createChatMessage({ isOutgoing: false })

      expect(isEditable(editableChatMsg)).toBe(true)
      expect(isEditable(retractedRoomMsg)).toBe(false)
      expect(isEditable(incomingMsg)).toBe(false)
    })
  })
})
