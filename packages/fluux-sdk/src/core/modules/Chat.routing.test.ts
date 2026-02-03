/**
 * Message Routing Tests
 *
 * Tests that verify messages are correctly routed to the appropriate store:
 * - type='chat' messages → chatStore.addMessage
 * - type='groupchat' messages → roomStore.addMessage
 *
 * These tests are critical safety checks before any type unification refactoring.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { XMPPClient } from '../XMPPClient'
import {
  createMockXmppClient,
  createMockStores,
  createMockElement,
  createMockRoom,
  type MockXmppClient,
  type MockStoreBindings,
} from '../test-utils'

let mockXmppClientInstance: MockXmppClient

// Mock @xmpp/client module
vi.mock('@xmpp/client', () => ({
  client: vi.fn(() => mockXmppClientInstance),
  xml: vi.fn((name: string, attrs?: Record<string, string>, ...children: unknown[]) => ({
    name,
    attrs: attrs || {},
    children,
    toString: () => `<${name}/>`,
  })),
}))

// Mock @xmpp/debug
vi.mock('@xmpp/debug', () => ({
  default: vi.fn(),
}))

// Import after mocking
import { client as xmppClientFactory } from '@xmpp/client'

describe('Message Routing', () => {
  let xmppClient: XMPPClient
  let mockStores: MockStoreBindings
  let emitSDKSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    vi.useFakeTimers()
    mockXmppClientInstance = createMockXmppClient()
    vi.mocked(xmppClientFactory).mockReturnValue(mockXmppClientInstance as any)

    mockStores = createMockStores()
    xmppClient = new XMPPClient({ debug: false })
    xmppClient.bindStores(mockStores)
    emitSDKSpy = vi.spyOn(xmppClient, 'emitSDK')
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.clearAllMocks()
  })

  // Helper to connect the client before testing message handling
  async function connectClient() {
    const connectPromise = xmppClient.connect({
      jid: 'user@example.com',
      password: 'secret',
      server: 'example.com',
      skipDiscovery: true,
    })
    mockXmppClientInstance._emit('online')
    await connectPromise
    vi.clearAllMocks()
  }

  describe('1:1 chat messages (type=chat)', () => {
    it('should route chat message to chatStore.addMessage', async () => {
      await connectClient()

      const messageStanza = createMockElement('message', {
        from: 'contact@example.com/resource',
        to: 'user@example.com',
        type: 'chat',
        id: 'msg-123',
      }, [
        { name: 'body', text: 'Hello from 1:1 chat!' },
      ])

      mockXmppClientInstance._emit('stanza', messageStanza)

      // Should route via chat:message event
      const chatCalls = emitSDKSpy.mock.calls.filter(call => call[0] === 'chat:message')
      expect(chatCalls).toHaveLength(1)
      expect(emitSDKSpy).toHaveBeenCalledWith('chat:message', {
        message: expect.objectContaining({
          id: 'msg-123',
          conversationId: 'contact@example.com',
          body: 'Hello from 1:1 chat!',
        })
      })

      // Should NOT route to room:message event
      expect(emitSDKSpy).not.toHaveBeenCalledWith('room:message', expect.anything())
    })

    it('should route chat message without explicit type to chatStore', async () => {
      await connectClient()

      // Some servers may omit type attribute for chat messages
      const messageStanza = createMockElement('message', {
        from: 'contact@example.com/resource',
        to: 'user@example.com',
        id: 'msg-no-type',
      }, [
        { name: 'body', text: 'Message without type attribute' },
      ])

      mockXmppClientInstance._emit('stanza', messageStanza)

      // Should default to chat:message event
      const chatCalls = emitSDKSpy.mock.calls.filter(call => call[0] === 'chat:message')
      expect(chatCalls).toHaveLength(1)
      expect(emitSDKSpy).not.toHaveBeenCalledWith('room:message', expect.anything())
    })

    it('should route received carbon (XEP-0280) to chatStore', async () => {
      await connectClient()

      const carbonStanza = createMockElement('message', {
        from: 'user@example.com',
        to: 'user@example.com/resource',
      }, [
        {
          name: 'received',
          attrs: { xmlns: 'urn:xmpp:carbons:2' },
          children: [
            {
              name: 'forwarded',
              attrs: { xmlns: 'urn:xmpp:forward:0' },
              children: [
                {
                  name: 'message',
                  attrs: {
                    from: 'contact@example.com/phone',
                    to: 'user@example.com/desktop',
                    type: 'chat',
                    id: 'carbon-msg-123',
                  },
                  children: [
                    { name: 'body', text: 'Carbon copy message' },
                  ],
                },
              ],
            },
          ],
        },
      ])

      mockXmppClientInstance._emit('stanza', carbonStanza)

      const chatCalls = emitSDKSpy.mock.calls.filter(call => call[0] === 'chat:message')
      expect(chatCalls).toHaveLength(1)
      expect(emitSDKSpy).toHaveBeenCalledWith('chat:message', {
        message: expect.objectContaining({
          conversationId: 'contact@example.com',
          body: 'Carbon copy message',
        })
      })
      expect(emitSDKSpy).not.toHaveBeenCalledWith('room:message', expect.anything())
    })
  })

  describe('MUC room messages (type=groupchat)', () => {
    it('should route groupchat message to roomStore.addMessage', async () => {
      await connectClient()

      // Set up a joined room so the message is processed
      const mockRoom = createMockRoom('room@conference.example.com', {
        joined: true,
        nickname: 'user',
      })
      vi.mocked(mockStores.room.getRoom).mockReturnValue(mockRoom)

      const messageStanza = createMockElement('message', {
        from: 'room@conference.example.com/sender',
        to: 'user@example.com',
        type: 'groupchat',
        id: 'room-msg-123',
      }, [
        { name: 'body', text: 'Hello from the room!' },
      ])

      mockXmppClientInstance._emit('stanza', messageStanza)

      // Should route via room:message event
      const roomCalls = emitSDKSpy.mock.calls.filter(call => call[0] === 'room:message')
      expect(roomCalls).toHaveLength(1)
      expect(emitSDKSpy).toHaveBeenCalledWith('room:message', expect.objectContaining({
        roomJid: 'room@conference.example.com',
        message: expect.objectContaining({
          id: 'room-msg-123',
          roomJid: 'room@conference.example.com',
          nick: 'sender',
          body: 'Hello from the room!',
        })
      }))

      // Should NOT route to chat:message event
      expect(emitSDKSpy).not.toHaveBeenCalledWith('chat:message', expect.anything())
    })

    it('should NOT route groupchat message from unknown room', async () => {
      await connectClient()

      // Room does not exist in store
      vi.mocked(mockStores.room.getRoom).mockReturnValue(undefined)

      const messageStanza = createMockElement('message', {
        from: 'unknown-room@conference.example.com/sender',
        to: 'user@example.com',
        type: 'groupchat',
        id: 'unknown-room-msg',
      }, [
        { name: 'body', text: 'Message from unknown room' },
      ])

      mockXmppClientInstance._emit('stanza', messageStanza)

      // Should not route to either event
      expect(emitSDKSpy).not.toHaveBeenCalledWith('room:message', expect.anything())
      expect(emitSDKSpy).not.toHaveBeenCalledWith('chat:message', expect.anything())
    })

    it('should detect own messages in room by nickname', async () => {
      await connectClient()

      const mockRoom = createMockRoom('room@conference.example.com', {
        joined: true,
        nickname: 'myname', // Our nickname in the room
      })
      vi.mocked(mockStores.room.getRoom).mockReturnValue(mockRoom)

      const messageStanza = createMockElement('message', {
        from: 'room@conference.example.com/myname', // From our own nickname
        to: 'user@example.com',
        type: 'groupchat',
        id: 'own-room-msg',
      }, [
        { name: 'body', text: 'My own message' },
      ])

      mockXmppClientInstance._emit('stanza', messageStanza)

      expect(emitSDKSpy).toHaveBeenCalledWith('room:message', expect.objectContaining({
        roomJid: 'room@conference.example.com',
        message: expect.objectContaining({
          isOutgoing: true,
          nick: 'myname',
        })
      }))
    })

    it('should detect own messages with different case (case-insensitive match)', async () => {
      await connectClient()

      const mockRoom = createMockRoom('room@conference.example.com', {
        joined: true,
        nickname: 'MyName', // Mixed case stored nickname
      })
      vi.mocked(mockStores.room.getRoom).mockReturnValue(mockRoom)

      const messageStanza = createMockElement('message', {
        from: 'room@conference.example.com/myname', // Lowercase from server
        to: 'user@example.com',
        type: 'groupchat',
        id: 'own-room-msg-case',
      }, [
        { name: 'body', text: 'My own message' },
      ])

      mockXmppClientInstance._emit('stanza', messageStanza)

      expect(emitSDKSpy).toHaveBeenCalledWith('room:message', expect.objectContaining({
        roomJid: 'room@conference.example.com',
        message: expect.objectContaining({
          isOutgoing: true, // Should still be detected as own message
          nick: 'myname',
        })
      }))
    })

    it('should detect other user messages in room', async () => {
      await connectClient()

      const mockRoom = createMockRoom('room@conference.example.com', {
        joined: true,
        nickname: 'myname',
      })
      vi.mocked(mockStores.room.getRoom).mockReturnValue(mockRoom)

      const messageStanza = createMockElement('message', {
        from: 'room@conference.example.com/otherperson', // Different nickname
        to: 'user@example.com',
        type: 'groupchat',
        id: 'other-room-msg',
      }, [
        { name: 'body', text: 'Someone else message' },
      ])

      mockXmppClientInstance._emit('stanza', messageStanza)

      expect(emitSDKSpy).toHaveBeenCalledWith('room:message', expect.objectContaining({
        roomJid: 'room@conference.example.com',
        message: expect.objectContaining({
          isOutgoing: false,
          nick: 'otherperson',
        })
      }))
    })
  })

  describe('Message type discrimination', () => {
    it('should never send chat message to roomStore', async () => {
      await connectClient()

      // Send multiple chat messages
      for (let i = 0; i < 5; i++) {
        const stanza = createMockElement('message', {
          from: `contact${i}@example.com/resource`,
          to: 'user@example.com',
          type: 'chat',
          id: `chat-msg-${i}`,
        }, [
          { name: 'body', text: `Chat message ${i}` },
        ])
        mockXmppClientInstance._emit('stanza', stanza)
      }

      const chatCalls = emitSDKSpy.mock.calls.filter(call => call[0] === 'chat:message')
      expect(chatCalls).toHaveLength(5)
      expect(emitSDKSpy).not.toHaveBeenCalledWith('room:message', expect.anything())
    })

    it('should never send groupchat message to chatStore', async () => {
      await connectClient()

      const mockRoom = createMockRoom('room@conference.example.com', {
        joined: true,
        nickname: 'user',
      })
      vi.mocked(mockStores.room.getRoom).mockReturnValue(mockRoom)

      // Send multiple room messages
      for (let i = 0; i < 5; i++) {
        const stanza = createMockElement('message', {
          from: `room@conference.example.com/sender${i}`,
          to: 'user@example.com',
          type: 'groupchat',
          id: `room-msg-${i}`,
        }, [
          { name: 'body', text: `Room message ${i}` },
        ])
        mockXmppClientInstance._emit('stanza', stanza)
      }

      const roomCalls = emitSDKSpy.mock.calls.filter(call => call[0] === 'room:message')
      expect(roomCalls).toHaveLength(5)
      expect(emitSDKSpy).not.toHaveBeenCalledWith('chat:message', expect.anything())
    })

    it('should correctly route mixed message types', async () => {
      await connectClient()

      const mockRoom = createMockRoom('room@conference.example.com', {
        joined: true,
        nickname: 'user',
      })
      vi.mocked(mockStores.room.getRoom).mockReturnValue(mockRoom)

      // Interleave chat and groupchat messages
      const chatStanza1 = createMockElement('message', {
        from: 'contact@example.com/resource',
        to: 'user@example.com',
        type: 'chat',
        id: 'chat-1',
      }, [{ name: 'body', text: 'Chat 1' }])

      const roomStanza1 = createMockElement('message', {
        from: 'room@conference.example.com/sender',
        to: 'user@example.com',
        type: 'groupchat',
        id: 'room-1',
      }, [{ name: 'body', text: 'Room 1' }])

      const chatStanza2 = createMockElement('message', {
        from: 'contact@example.com/resource',
        to: 'user@example.com',
        type: 'chat',
        id: 'chat-2',
      }, [{ name: 'body', text: 'Chat 2' }])

      const roomStanza2 = createMockElement('message', {
        from: 'room@conference.example.com/sender',
        to: 'user@example.com',
        type: 'groupchat',
        id: 'room-2',
      }, [{ name: 'body', text: 'Room 2' }])

      mockXmppClientInstance._emit('stanza', chatStanza1)
      mockXmppClientInstance._emit('stanza', roomStanza1)
      mockXmppClientInstance._emit('stanza', chatStanza2)
      mockXmppClientInstance._emit('stanza', roomStanza2)

      // Verify correct routing
      const chatCalls = emitSDKSpy.mock.calls.filter(call => call[0] === 'chat:message')
      const roomCalls = emitSDKSpy.mock.calls.filter(call => call[0] === 'room:message')
      expect(chatCalls).toHaveLength(2)
      expect(roomCalls).toHaveLength(2)

      // Verify specific messages
      expect(emitSDKSpy).toHaveBeenCalledWith('chat:message', {
        message: expect.objectContaining({ id: 'chat-1', body: 'Chat 1' })
      })
      expect(emitSDKSpy).toHaveBeenCalledWith('chat:message', {
        message: expect.objectContaining({ id: 'chat-2', body: 'Chat 2' })
      })
      expect(emitSDKSpy).toHaveBeenCalledWith('room:message', expect.objectContaining({
        roomJid: 'room@conference.example.com',
        message: expect.objectContaining({ id: 'room-1', body: 'Room 1' })
      }))
      expect(emitSDKSpy).toHaveBeenCalledWith('room:message', expect.objectContaining({
        roomJid: 'room@conference.example.com',
        message: expect.objectContaining({ id: 'room-2', body: 'Room 2' })
      }))
    })
  })

  describe('Delayed/historical messages', () => {
    it('should route delayed chat message to chatStore', async () => {
      await connectClient()

      const delayedStanza = createMockElement('message', {
        from: 'contact@example.com/resource',
        to: 'user@example.com',
        type: 'chat',
        id: 'delayed-chat',
      }, [
        { name: 'body', text: 'Delayed message' },
        { name: 'delay', attrs: { xmlns: 'urn:xmpp:delay', stamp: '2024-01-01T12:00:00Z' } },
      ])

      mockXmppClientInstance._emit('stanza', delayedStanza)

      expect(emitSDKSpy).toHaveBeenCalledWith('chat:message', {
        message: expect.objectContaining({
          id: 'delayed-chat',
          isDelayed: true,
        })
      })
      expect(emitSDKSpy).not.toHaveBeenCalledWith('room:message', expect.anything())
    })

    it('should route delayed groupchat message to roomStore', async () => {
      await connectClient()

      const mockRoom = createMockRoom('room@conference.example.com', {
        joined: true,
        nickname: 'user',
      })
      vi.mocked(mockStores.room.getRoom).mockReturnValue(mockRoom)

      const delayedStanza = createMockElement('message', {
        from: 'room@conference.example.com/sender',
        to: 'user@example.com',
        type: 'groupchat',
        id: 'delayed-room',
      }, [
        { name: 'body', text: 'Delayed room message' },
        { name: 'delay', attrs: { xmlns: 'urn:xmpp:delay', stamp: '2024-01-01T12:00:00Z' } },
      ])

      mockXmppClientInstance._emit('stanza', delayedStanza)

      expect(emitSDKSpy).toHaveBeenCalledWith('room:message', expect.objectContaining({
        roomJid: 'room@conference.example.com',
        message: expect.objectContaining({
          id: 'delayed-room',
          isDelayed: true,
        })
      }))
      expect(emitSDKSpy).not.toHaveBeenCalledWith('chat:message', expect.anything())
    })
  })

  describe('Message field validation', () => {
    it('should set conversationId (not roomJid) on chat messages', async () => {
      await connectClient()

      const stanza = createMockElement('message', {
        from: 'contact@example.com/resource',
        to: 'user@example.com',
        type: 'chat',
        id: 'chat-field-test',
      }, [{ name: 'body', text: 'Test' }])

      mockXmppClientInstance._emit('stanza', stanza)

      const chatCall = emitSDKSpy.mock.calls.find(call => call[0] === 'chat:message')
      expect(chatCall).toBeDefined()
      const addedMessage = (chatCall![1] as { message: Record<string, unknown> }).message
      expect(addedMessage).toHaveProperty('conversationId', 'contact@example.com')
      expect(addedMessage).not.toHaveProperty('roomJid')
      expect(addedMessage).not.toHaveProperty('nick')
    })

    it('should set roomJid and nick (not conversationId) on groupchat messages', async () => {
      await connectClient()

      const mockRoom = createMockRoom('room@conference.example.com', {
        joined: true,
        nickname: 'user',
      })
      vi.mocked(mockStores.room.getRoom).mockReturnValue(mockRoom)

      const stanza = createMockElement('message', {
        from: 'room@conference.example.com/sender',
        to: 'user@example.com',
        type: 'groupchat',
        id: 'room-field-test',
      }, [{ name: 'body', text: 'Test' }])

      mockXmppClientInstance._emit('stanza', stanza)

      const roomCall = emitSDKSpy.mock.calls.find(call => call[0] === 'room:message')
      expect(roomCall).toBeDefined()
      const addedMessage = (roomCall![1] as { message: Record<string, unknown> }).message
      expect(addedMessage).toHaveProperty('roomJid', 'room@conference.example.com')
      expect(addedMessage).toHaveProperty('nick', 'sender')
      expect(addedMessage).not.toHaveProperty('conversationId')
    })
  })
})
