/**
 * XMPPClient Message Tests
 *
 * Tests for message handling: regular messages, carbons (XEP-0280),
 * chat state notifications (XEP-0085), message styling (XEP-0393),
 * replies with fallback (XEP-0461 + XEP-0428), and reactions (XEP-0444).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { XMPPClient } from '../XMPPClient'
import {
  createMockXmppClient,
  createMockStores,
  createMockElement,
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

describe('XMPPClient Message', () => {
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

  describe('regular messages', () => {
    it('should parse incoming message and add to store', async () => {
      await connectClient()

      const messageStanza = createMockElement('message', {
        from: 'contact@example.com/resource',
        to: 'user@example.com',
        type: 'chat',
        id: 'msg-123',
      }, [
        { name: 'body', text: 'Hello!' },
      ])

      mockXmppClientInstance._emit('stanza', messageStanza)

      expect(emitSDKSpy).toHaveBeenCalledWith('chat:message', {
        message: expect.objectContaining({
          id: 'msg-123',
          conversationId: 'contact@example.com',
          from: 'contact@example.com',
          body: 'Hello!',
          isOutgoing: false,
        })
      })
    })

    it('should create conversation if it does not exist', async () => {
      await connectClient()
      vi.mocked(mockStores.chat.hasConversation).mockReturnValue(false)

      const messageStanza = createMockElement('message', {
        from: 'newcontact@example.com',
        to: 'user@example.com',
        type: 'chat',
      }, [
        { name: 'body', text: 'Hi there!' },
      ])

      mockXmppClientInstance._emit('stanza', messageStanza)

      expect(emitSDKSpy).toHaveBeenCalledWith('chat:conversation', {
        conversation: expect.objectContaining({
          id: 'newcontact@example.com',
          name: 'newcontact',
          type: 'chat',
          unreadCount: 0,
        })
      })
    })

    it('should not create conversation if it already exists', async () => {
      await connectClient()
      vi.mocked(mockStores.chat.hasConversation).mockReturnValue(true)

      const messageStanza = createMockElement('message', {
        from: 'contact@example.com',
        to: 'user@example.com',
        type: 'chat',
      }, [
        { name: 'body', text: 'Hello again!' },
      ])

      mockXmppClientInstance._emit('stanza', messageStanza)

      expect(emitSDKSpy).not.toHaveBeenCalledWith('chat:conversation', expect.anything())
    })

    it('should emit message event for incoming messages', async () => {
      await connectClient()
      const messageHandler = vi.fn()
      xmppClient.on('message', messageHandler)

      const messageStanza = createMockElement('message', {
        from: 'contact@example.com',
        to: 'user@example.com',
        type: 'chat',
      }, [
        { name: 'body', text: 'Event test' },
      ])

      mockXmppClientInstance._emit('stanza', messageStanza)

      expect(messageHandler).toHaveBeenCalledWith(
        expect.objectContaining({
          from: 'contact@example.com',
          body: 'Event test',
          isOutgoing: false,
        })
      )
    })

    it('should ignore messages without body', async () => {
      await connectClient()

      const messageStanza = createMockElement('message', {
        from: 'contact@example.com',
        to: 'user@example.com',
        type: 'chat',
      }, [])

      mockXmppClientInstance._emit('stanza', messageStanza)

      expect(emitSDKSpy).not.toHaveBeenCalledWith('chat:message', expect.anything())
    })

    it('should strip resource from sender JID', async () => {
      await connectClient()

      const messageStanza = createMockElement('message', {
        from: 'contact@example.com/mobile',
        to: 'user@example.com',
        type: 'chat',
      }, [
        { name: 'body', text: 'From mobile' },
      ])

      mockXmppClientInstance._emit('stanza', messageStanza)

      expect(emitSDKSpy).toHaveBeenCalledWith('chat:message', {
        message: expect.objectContaining({
          conversationId: 'contact@example.com',
          from: 'contact@example.com',
        })
      })
    })
  })

  describe('message carbons (XEP-0280)', () => {
    it('should process received carbon and extract forwarded message', async () => {
      await connectClient()

      // Received carbon: message from contact, delivered to another resource
      const carbonStanza = createMockElement('message', {
        from: 'user@example.com',
        to: 'user@example.com/desktop',
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
                    to: 'user@example.com/other',
                    type: 'chat',
                    id: 'carbon-msg-1',
                  },
                  children: [
                    { name: 'body', text: 'Message via carbon' },
                  ],
                },
              ],
            },
          ],
        },
      ])

      mockXmppClientInstance._emit('stanza', carbonStanza)

      expect(emitSDKSpy).toHaveBeenCalledWith('chat:message', {
        message: expect.objectContaining({
          id: 'carbon-msg-1',
          conversationId: 'contact@example.com',
          from: 'contact@example.com',
          body: 'Message via carbon',
          isOutgoing: false,
        })
      })
    })

    it('should process sent carbon and mark as outgoing', async () => {
      await connectClient()

      // Sent carbon: message sent from another of our resources
      const carbonStanza = createMockElement('message', {
        from: 'user@example.com',
        to: 'user@example.com/desktop',
      }, [
        {
          name: 'sent',
          attrs: { xmlns: 'urn:xmpp:carbons:2' },
          children: [
            {
              name: 'forwarded',
              attrs: { xmlns: 'urn:xmpp:forward:0' },
              children: [
                {
                  name: 'message',
                  attrs: {
                    from: 'user@example.com/phone',
                    to: 'contact@example.com',
                    type: 'chat',
                    id: 'sent-carbon-1',
                  },
                  children: [
                    { name: 'body', text: 'I sent this from my phone' },
                  ],
                },
              ],
            },
          ],
        },
      ])

      mockXmppClientInstance._emit('stanza', carbonStanza)

      expect(emitSDKSpy).toHaveBeenCalledWith('chat:message', {
        message: expect.objectContaining({
          id: 'sent-carbon-1',
          conversationId: 'contact@example.com',
          from: 'user@example.com',
          body: 'I sent this from my phone',
          isOutgoing: true,
        })
      })
    })

    it('should NOT emit message event for sent carbons', async () => {
      await connectClient()
      const messageHandler = vi.fn()
      xmppClient.on('message', messageHandler)

      const carbonStanza = createMockElement('message', {
        from: 'user@example.com',
        to: 'user@example.com/desktop',
      }, [
        {
          name: 'sent',
          attrs: { xmlns: 'urn:xmpp:carbons:2' },
          children: [
            {
              name: 'forwarded',
              attrs: { xmlns: 'urn:xmpp:forward:0' },
              children: [
                {
                  name: 'message',
                  attrs: {
                    from: 'user@example.com/phone',
                    to: 'contact@example.com',
                    type: 'chat',
                  },
                  children: [
                    { name: 'body', text: 'Sent from phone' },
                  ],
                },
              ],
            },
          ],
        },
      ])

      mockXmppClientInstance._emit('stanza', carbonStanza)

      // Should emit chat:message but NOT emit 'message' event (avoids notification for own messages)
      const chatCalls = emitSDKSpy.mock.calls.filter((call: unknown[]) => call[0] === 'chat:message')
      expect(chatCalls.length).toBeGreaterThan(0)
      expect(messageHandler).not.toHaveBeenCalled()
    })

    it('should skip messages with private element', async () => {
      await connectClient()

      const carbonStanza = createMockElement('message', {
        from: 'user@example.com',
        to: 'user@example.com/desktop',
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
                    from: 'contact@example.com',
                    to: 'user@example.com/other',
                    type: 'chat',
                  },
                  children: [
                    { name: 'body', text: 'Private message' },
                    { name: 'private', attrs: { xmlns: 'urn:xmpp:carbons:2' } },
                  ],
                },
              ],
            },
          ],
        },
      ])

      mockXmppClientInstance._emit('stanza', carbonStanza)

      expect(emitSDKSpy).not.toHaveBeenCalledWith('chat:message', expect.anything())
    })

    it('should ignore carbon without forwarded element', async () => {
      await connectClient()

      const carbonStanza = createMockElement('message', {
        from: 'user@example.com',
        to: 'user@example.com/desktop',
      }, [
        {
          name: 'received',
          attrs: { xmlns: 'urn:xmpp:carbons:2' },
          children: [], // No forwarded element
        },
      ])

      mockXmppClientInstance._emit('stanza', carbonStanza)

      expect(emitSDKSpy).not.toHaveBeenCalledWith('chat:message', expect.anything())
    })
  })

  describe('chat state notifications (XEP-0085)', () => {
    it('should set typing indicator on composing notification', async () => {
      await connectClient()

      const composingStanza = createMockElement('message', {
        from: 'contact@example.com/resource',
        to: 'user@example.com',
        type: 'chat',
      }, [
        { name: 'composing', attrs: { xmlns: 'http://jabber.org/protocol/chatstates' } },
      ])

      mockXmppClientInstance._emit('stanza', composingStanza)

      expect(emitSDKSpy).toHaveBeenCalledWith('chat:typing', {
        conversationId: 'contact@example.com',
        jid: 'contact@example.com',
        isTyping: true
      })
    })

    it('should clear typing indicator on paused notification', async () => {
      await connectClient()

      const pausedStanza = createMockElement('message', {
        from: 'contact@example.com',
        to: 'user@example.com',
        type: 'chat',
      }, [
        { name: 'paused', attrs: { xmlns: 'http://jabber.org/protocol/chatstates' } },
      ])

      mockXmppClientInstance._emit('stanza', pausedStanza)

      expect(emitSDKSpy).toHaveBeenCalledWith('chat:typing', {
        conversationId: 'contact@example.com',
        jid: 'contact@example.com',
        isTyping: false
      })
    })

    it('should clear typing indicator on active notification', async () => {
      await connectClient()

      const activeStanza = createMockElement('message', {
        from: 'contact@example.com',
        to: 'user@example.com',
        type: 'chat',
      }, [
        { name: 'active', attrs: { xmlns: 'http://jabber.org/protocol/chatstates' } },
      ])

      mockXmppClientInstance._emit('stanza', activeStanza)

      expect(emitSDKSpy).toHaveBeenCalledWith('chat:typing', {
        conversationId: 'contact@example.com',
        jid: 'contact@example.com',
        isTyping: false
      })
    })

    it('should clear typing indicator on gone notification', async () => {
      await connectClient()

      const goneStanza = createMockElement('message', {
        from: 'contact@example.com',
        to: 'user@example.com',
        type: 'chat',
      }, [
        { name: 'gone', attrs: { xmlns: 'http://jabber.org/protocol/chatstates' } },
      ])

      mockXmppClientInstance._emit('stanza', goneStanza)

      expect(emitSDKSpy).toHaveBeenCalledWith('chat:typing', {
        conversationId: 'contact@example.com',
        jid: 'contact@example.com',
        isTyping: false
      })
    })

    it('should clear typing indicator when message with body arrives', async () => {
      await connectClient()

      const messageStanza = createMockElement('message', {
        from: 'contact@example.com',
        to: 'user@example.com',
        type: 'chat',
      }, [
        { name: 'body', text: 'Hello!' },
        { name: 'active', attrs: { xmlns: 'http://jabber.org/protocol/chatstates' } },
      ])

      mockXmppClientInstance._emit('stanza', messageStanza)

      // Should clear typing for the sender
      expect(emitSDKSpy).toHaveBeenCalledWith('chat:typing', {
        conversationId: 'contact@example.com',
        jid: 'contact@example.com',
        isTyping: false
      })
    })

    it('should NOT process chat states from carbon copies', async () => {
      await connectClient()

      // Carbon copy with composing - should NOT trigger typing indicator
      const carbonStanza = createMockElement('message', {
        from: 'user@example.com',
        to: 'user@example.com/desktop',
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
                    from: 'contact@example.com',
                    to: 'user@example.com/other',
                    type: 'chat',
                  },
                  children: [
                    { name: 'composing', attrs: { xmlns: 'http://jabber.org/protocol/chatstates' } },
                  ],
                },
              ],
            },
          ],
        },
      ])

      mockXmppClientInstance._emit('stanza', carbonStanza)

      // Should NOT have emitted chat:typing for carbon copies
      expect(emitSDKSpy).not.toHaveBeenCalledWith('chat:typing', expect.anything())
    })

    it('should NOT send chat state to offline users in 1:1 chats', async () => {
      await connectClient()

      // Mock contact as offline
      vi.mocked(mockStores.roster.getContact).mockReturnValue({
        jid: 'offline@example.com',
        name: 'Offline User',
        presence: 'offline',
        subscription: 'both',
      })

      await xmppClient.chat.sendChatState('offline@example.com', 'composing', 'chat')

      // Should NOT have sent any stanza
      expect(mockXmppClientInstance.send).not.toHaveBeenCalled()
    })

    it('should send chat state to online users in 1:1 chats', async () => {
      await connectClient()

      // Mock contact as online
      vi.mocked(mockStores.roster.getContact).mockReturnValue({
        jid: 'online@example.com',
        name: 'Online User',
        presence: 'online',
        subscription: 'both',
      })

      await xmppClient.chat.sendChatState('online@example.com', 'composing', 'chat')

      // Should have sent the chat state
      expect(mockXmppClientInstance.send).toHaveBeenCalled()
    })

    it('should send chat state to away users in 1:1 chats', async () => {
      await connectClient()

      // Mock contact as away (still online, just away)
      vi.mocked(mockStores.roster.getContact).mockReturnValue({
        jid: 'away@example.com',
        name: 'Away User',
        presence: 'away',
        subscription: 'both',
      })

      await xmppClient.chat.sendChatState('away@example.com', 'composing', 'chat')

      // Should have sent the chat state (away users can still receive)
      expect(mockXmppClientInstance.send).toHaveBeenCalled()
    })

    it('should always send chat state to groupchat regardless of presence', async () => {
      await connectClient()

      // For groupchat, we don't check individual presence
      await xmppClient.chat.sendChatState('room@conference.example.com', 'composing', 'groupchat')

      // Should have sent the chat state
      expect(mockXmppClientInstance.send).toHaveBeenCalled()
    })

    it('should emit room:typing for composing notification in MUC room', async () => {
      await connectClient()

      const composingStanza = createMockElement('message', {
        from: 'room@conference.example.com/Alice',
        to: 'user@example.com',
        type: 'groupchat',
      }, [
        { name: 'composing', attrs: { xmlns: 'http://jabber.org/protocol/chatstates' } },
      ])

      mockXmppClientInstance._emit('stanza', composingStanza)

      expect(emitSDKSpy).toHaveBeenCalledWith('room:typing', {
        roomJid: 'room@conference.example.com',
        nick: 'Alice',
        isTyping: true
      })
      // Should NOT emit chat:typing for groupchat messages
      expect(emitSDKSpy).not.toHaveBeenCalledWith('chat:typing', expect.anything())
    })

    it('should emit room:typing with isTyping=false for paused notification in MUC room', async () => {
      await connectClient()

      const pausedStanza = createMockElement('message', {
        from: 'room@conference.example.com/Bob',
        to: 'user@example.com',
        type: 'groupchat',
      }, [
        { name: 'paused', attrs: { xmlns: 'http://jabber.org/protocol/chatstates' } },
      ])

      mockXmppClientInstance._emit('stanza', pausedStanza)

      expect(emitSDKSpy).toHaveBeenCalledWith('room:typing', {
        roomJid: 'room@conference.example.com',
        nick: 'Bob',
        isTyping: false
      })
    })

    it('should emit room:typing with isTyping=false for active notification in MUC room', async () => {
      await connectClient()

      const activeStanza = createMockElement('message', {
        from: 'room@conference.example.com/Charlie',
        to: 'user@example.com',
        type: 'groupchat',
      }, [
        { name: 'active', attrs: { xmlns: 'http://jabber.org/protocol/chatstates' } },
      ])

      mockXmppClientInstance._emit('stanza', activeStanza)

      expect(emitSDKSpy).toHaveBeenCalledWith('room:typing', {
        roomJid: 'room@conference.example.com',
        nick: 'Charlie',
        isTyping: false
      })
    })

    it('should NOT emit room:typing when nick is missing from MUC message', async () => {
      await connectClient()

      // Room-level message without a nick (bare JID)
      const composingStanza = createMockElement('message', {
        from: 'room@conference.example.com',
        to: 'user@example.com',
        type: 'groupchat',
      }, [
        { name: 'composing', attrs: { xmlns: 'http://jabber.org/protocol/chatstates' } },
      ])

      mockXmppClientInstance._emit('stanza', composingStanza)

      expect(emitSDKSpy).not.toHaveBeenCalledWith('room:typing', expect.anything())
    })

    it('should NOT emit room:typing for own typing indicator in MUC room', async () => {
      await connectClient()

      // Mock the room store to return a room where we have the nickname 'TestUser'
      mockStores.room.getRoom.mockReturnValue({
        jid: 'room@conference.example.com',
        name: 'room',
        nickname: 'TestUser',
        joined: true,
        isBookmarked: false,
        unreadCount: 0,
        mentionsCount: 0,
        typingUsers: new Set<string>(),
        occupants: new Map(),
        messages: [],
      })

      // Receive a composing notification from our own nickname
      const composingStanza = createMockElement('message', {
        from: 'room@conference.example.com/TestUser',
        to: 'user@example.com',
        type: 'groupchat',
      }, [
        { name: 'composing', attrs: { xmlns: 'http://jabber.org/protocol/chatstates' } },
      ])

      mockXmppClientInstance._emit('stanza', composingStanza)

      // Should NOT emit room:typing for our own typing indicator
      expect(emitSDKSpy).not.toHaveBeenCalledWith('room:typing', expect.anything())
    })

    it('should NOT emit room:typing for own typing indicator with different case nickname', async () => {
      await connectClient()

      // Mock the room store - our nickname is 'TestUser' but server reflects 'testuser'
      mockStores.room.getRoom.mockReturnValue({
        jid: 'room@conference.example.com',
        name: 'room',
        nickname: 'TestUser',
        joined: true,
        isBookmarked: false,
        unreadCount: 0,
        mentionsCount: 0,
        typingUsers: new Set<string>(),
        occupants: new Map(),
        messages: [],
      })

      // Receive a composing notification with different case
      const composingStanza = createMockElement('message', {
        from: 'room@conference.example.com/testuser',
        to: 'user@example.com',
        type: 'groupchat',
      }, [
        { name: 'composing', attrs: { xmlns: 'http://jabber.org/protocol/chatstates' } },
      ])

      mockXmppClientInstance._emit('stanza', composingStanza)

      // Should NOT emit room:typing (case-insensitive comparison)
      expect(emitSDKSpy).not.toHaveBeenCalledWith('room:typing', expect.anything())
    })
  })

  describe('message styling (XEP-0393)', () => {
    it('should set noStyling flag when no-styling element is present', async () => {
      await connectClient()

      const messageStanza = createMockElement('message', {
        from: 'contact@example.com/resource',
        to: 'user@example.com',
        type: 'chat',
        id: 'msg-no-style',
      }, [
        { name: 'body', text: '*not bold*' },
        { name: 'no-styling', attrs: { xmlns: 'urn:xmpp:styling:0' } },
      ])

      mockXmppClientInstance._emit('stanza', messageStanza)

      expect(emitSDKSpy).toHaveBeenCalledWith('chat:message', {
        message: expect.objectContaining({
          id: 'msg-no-style',
          body: '*not bold*',
          noStyling: true,
        })
      })
    })

    it('should not set noStyling flag when no-styling element is absent', async () => {
      await connectClient()

      const messageStanza = createMockElement('message', {
        from: 'contact@example.com/resource',
        to: 'user@example.com',
        type: 'chat',
        id: 'msg-with-style',
      }, [
        { name: 'body', text: '*bold text*' },
      ])

      mockXmppClientInstance._emit('stanza', messageStanza)

      const chatCall = emitSDKSpy.mock.calls.find((call: unknown[]) => call[0] === 'chat:message')
      expect(chatCall).toBeDefined()
      const message = (chatCall![1] as { message: Record<string, unknown> }).message
      expect(message).not.toHaveProperty('noStyling', true)
    })

    it('should ignore no-styling element with wrong namespace', async () => {
      await connectClient()

      const messageStanza = createMockElement('message', {
        from: 'contact@example.com/resource',
        to: 'user@example.com',
        type: 'chat',
        id: 'msg-wrong-ns',
      }, [
        { name: 'body', text: '*text*' },
        { name: 'no-styling', attrs: { xmlns: 'wrong:namespace' } },
      ])

      mockXmppClientInstance._emit('stanza', messageStanza)

      const chatCall = emitSDKSpy.mock.calls.find((call: unknown[]) => call[0] === 'chat:message')
      expect(chatCall).toBeDefined()
      const message = (chatCall![1] as { message: Record<string, unknown> }).message
      expect(message).not.toHaveProperty('noStyling', true)
    })
  })

  describe('message replies with fallback (XEP-0461 + XEP-0428)', () => {
    it('should parse reply with fallback and preserve fallback body', async () => {
      await connectClient()

      // Message with XEP-0461 reply and XEP-0428 fallback
      // Body: "> Alice: Hello there!\nMy reply" - fallback is first 22 chars
      const messageStanza = createMockElement('message', {
        from: 'contact@example.com/resource',
        to: 'user@example.com',
        type: 'chat',
        id: 'msg-reply-1',
      }, [
        { name: 'body', text: '> Alice: Hello there!\nMy reply' },
        { name: 'reply', attrs: { xmlns: 'urn:xmpp:reply:0', id: 'original-msg-id', to: 'alice@example.com' } },
        {
          name: 'fallback',
          attrs: { xmlns: 'urn:xmpp:fallback:0', for: 'urn:xmpp:reply:0' },
          children: [
            // Note: body inherits the fallback namespace in real XML
            { name: 'body', attrs: { xmlns: 'urn:xmpp:fallback:0', start: '0', end: '22' } },
          ],
        },
      ])

      mockXmppClientInstance._emit('stanza', messageStanza)

      expect(emitSDKSpy).toHaveBeenCalledWith('chat:message', {
        message: expect.objectContaining({
          id: 'msg-reply-1',
          body: 'My reply', // Fallback text stripped
          replyTo: expect.objectContaining({
            id: 'original-msg-id',
            to: 'alice@example.com',
            fallbackBody: 'Hello there!', // Fallback body extracted
          }),
        })
      })
    })

    it('should extract fallback body without author prefix', async () => {
      await connectClient()

      // Body: "> Bob: This is the original message\nAnd my response" - fallback is first 36 chars
      const messageStanza = createMockElement('message', {
        from: 'contact@example.com/resource',
        to: 'user@example.com',
        type: 'chat',
        id: 'msg-reply-2',
      }, [
        { name: 'body', text: '> Bob: This is the original message\nAnd my response' },
        { name: 'reply', attrs: { xmlns: 'urn:xmpp:reply:0', id: 'orig-2' } },
        {
          name: 'fallback',
          attrs: { xmlns: 'urn:xmpp:fallback:0', for: 'urn:xmpp:reply:0' },
          children: [
            // Note: body inherits the fallback namespace in real XML
            { name: 'body', attrs: { xmlns: 'urn:xmpp:fallback:0', start: '0', end: '36' } },
          ],
        },
      ])

      mockXmppClientInstance._emit('stanza', messageStanza)

      expect(emitSDKSpy).toHaveBeenCalledWith('chat:message', {
        message: expect.objectContaining({
          body: 'And my response',
          replyTo: expect.objectContaining({
            id: 'orig-2',
            fallbackBody: 'This is the original message',
          }),
        })
      })
    })

    it('should handle reply without fallback element', async () => {
      await connectClient()

      const messageStanza = createMockElement('message', {
        from: 'contact@example.com/resource',
        to: 'user@example.com',
        type: 'chat',
        id: 'msg-reply-3',
      }, [
        { name: 'body', text: 'Reply without fallback' },
        { name: 'reply', attrs: { xmlns: 'urn:xmpp:reply:0', id: 'orig-3', to: 'someone@example.com' } },
      ])

      mockXmppClientInstance._emit('stanza', messageStanza)

      expect(emitSDKSpy).toHaveBeenCalledWith('chat:message', {
        message: expect.objectContaining({
          body: 'Reply without fallback',
          replyTo: expect.objectContaining({
            id: 'orig-3',
            to: 'someone@example.com',
          }),
        })
      })
      // Should not have fallbackBody when no fallback element present
      const chatCall = emitSDKSpy.mock.calls.find((call: unknown[]) => call[0] === 'chat:message')
      const addedMessage = (chatCall![1] as { message: Record<string, unknown> }).message
      expect((addedMessage.replyTo as Record<string, unknown>)).not.toHaveProperty('fallbackBody')
    })

    it('should handle legacy fallback namespace (urn:xmpp:feature-fallback:0)', async () => {
      await connectClient()

      // Some clients (like Movim) use the older draft namespace
      const messageStanza = createMockElement('message', {
        from: 'contact@example.com/resource',
        to: 'user@example.com',
        type: 'chat',
        id: 'msg-reply-legacy',
      }, [
        { name: 'body', text: '> Carol: Legacy fallback test\nThis uses the old namespace' },
        { name: 'reply', attrs: { xmlns: 'urn:xmpp:reply:0', id: 'orig-legacy', to: 'carol@example.com' } },
        {
          name: 'fallback',
          attrs: { xmlns: 'urn:xmpp:feature-fallback:0', for: 'urn:xmpp:reply:0' },
          children: [
            { name: 'body', attrs: { xmlns: 'urn:xmpp:feature-fallback:0', start: '0', end: '30' } },
          ],
        },
      ])

      mockXmppClientInstance._emit('stanza', messageStanza)

      expect(emitSDKSpy).toHaveBeenCalledWith('chat:message', {
        message: expect.objectContaining({
          id: 'msg-reply-legacy',
          body: 'This uses the old namespace', // Fallback text stripped
          replyTo: expect.objectContaining({
            id: 'orig-legacy',
            to: 'carol@example.com',
            fallbackBody: 'Legacy fallback test', // Fallback body extracted
          }),
        })
      })
    })
  })

  describe('sendReaction (XEP-0444)', () => {
    it('should send reaction message with correct structure', async () => {
      await connectClient()

      await xmppClient.chat.sendReaction('alice@example.com', 'msg-123', ['👍', '❤️'], 'chat')

      expect(mockXmppClientInstance.send).toHaveBeenCalledTimes(1)

      const sentStanza = mockXmppClientInstance.send.mock.calls[0][0]
      expect(sentStanza.name).toBe('message')
      expect(sentStanza.attrs.to).toBe('alice@example.com')
      expect(sentStanza.attrs.type).toBe('chat')

      // Find reactions element
      const reactionsEl = sentStanza.children.find(
        (c: any) => c.name === 'reactions'
      )
      expect(reactionsEl).toBeDefined()
      expect(reactionsEl.attrs.xmlns).toBe('urn:xmpp:reactions:0')
      expect(reactionsEl.attrs.id).toBe('msg-123')

      // Check reaction children
      const reactionEls = reactionsEl.children.filter(
        (c: any) => c.name === 'reaction'
      )
      expect(reactionEls.length).toBe(2)
      expect(reactionEls[0].children[0]).toBe('👍')
      expect(reactionEls[1].children[0]).toBe('❤️')
    })

    it('should send empty reactions to remove all reactions', async () => {
      await connectClient()

      await xmppClient.chat.sendReaction('alice@example.com', 'msg-123', [], 'chat')

      const sentStanza = mockXmppClientInstance.send.mock.calls[0][0]
      const reactionsEl = sentStanza.children.find(
        (c: any) => c.name === 'reactions'
      )

      expect(reactionsEl.children.length).toBe(0)
    })

    it('should update local store after sending reaction', async () => {
      await connectClient()

      await xmppClient.chat.sendReaction('alice@example.com', 'msg-123', ['👍'], 'chat')

      expect(emitSDKSpy).toHaveBeenCalledWith('chat:reactions', {
        conversationId: 'alice@example.com',
        messageId: 'msg-123',
        reactorJid: 'user@example.com',
        emojis: ['👍']
      })
    })

    it('should send to bare JID for chat type', async () => {
      await connectClient()

      // Send with full JID - should be stripped to bare JID
      await xmppClient.chat.sendReaction('alice@example.com/mobile', 'msg-123', ['👍'], 'chat')

      const sentStanza = mockXmppClientInstance.send.mock.calls[0][0]
      expect(sentStanza.attrs.to).toBe('alice@example.com')
    })
  })

  describe('sendMessage with attachments (XEP-0066 + XEP-0428)', () => {
    it('should include OOB element when sending with attachment', async () => {
      await connectClient()

      const attachment = {
        url: 'https://upload.example.com/files/photo.jpg',
        name: 'photo.jpg',
        size: 12345,
        mediaType: 'image/jpeg',
      }

      await xmppClient.chat.sendMessage('alice@example.com', attachment.url, 'chat', undefined, undefined, attachment)

      const sentStanza = mockXmppClientInstance.send.mock.calls[0][0]
      const oobEl = sentStanza.children.find((c: any) => c.name === 'x' && c.attrs.xmlns === 'jabber:x:oob')

      expect(oobEl).toBeDefined()
      expect(oobEl.children.find((c: any) => c.name === 'url')).toBeDefined()
    })

    it('should include thumbnail in OOB when attachment has thumbnail', async () => {
      await connectClient()

      const attachment = {
        url: 'https://upload.example.com/files/photo.jpg',
        name: 'photo.jpg',
        size: 12345,
        mediaType: 'image/jpeg',
        thumbnail: {
          uri: 'https://upload.example.com/thumbs/photo_thumb.jpg',
          mediaType: 'image/jpeg',
          width: 150,
          height: 100,
        },
      }

      await xmppClient.chat.sendMessage('alice@example.com', attachment.url, 'chat', undefined, undefined, attachment)

      const sentStanza = mockXmppClientInstance.send.mock.calls[0][0]
      const oobEl = sentStanza.children.find((c: any) => c.name === 'x' && c.attrs.xmlns === 'jabber:x:oob')
      const thumbnailEl = oobEl?.children.find((c: any) => c.name === 'thumbnail')

      expect(thumbnailEl).toBeDefined()
      expect(thumbnailEl.attrs.xmlns).toBe('urn:xmpp:thumbs:1')
      expect(thumbnailEl.attrs.uri).toBe('https://upload.example.com/thumbs/photo_thumb.jpg')
      expect(thumbnailEl.attrs['media-type']).toBe('image/jpeg')
      expect(thumbnailEl.attrs.width).toBe('150')
      expect(thumbnailEl.attrs.height).toBe('100')
    })

    it('should include XEP-0428 fallback indication for OOB', async () => {
      await connectClient()

      const attachment = {
        url: 'https://upload.example.com/files/photo.jpg',
        name: 'photo.jpg',
        size: 12345,
        mediaType: 'image/jpeg',
      }

      await xmppClient.chat.sendMessage('alice@example.com', attachment.url, 'chat', undefined, undefined, attachment)

      const sentStanza = mockXmppClientInstance.send.mock.calls[0][0]
      const fallbackEl = sentStanza.children.find(
        (c: any) => c.name === 'fallback' && c.attrs.xmlns === 'urn:xmpp:fallback:0'
      )

      expect(fallbackEl).toBeDefined()
      expect(fallbackEl.attrs.for).toBe('jabber:x:oob')
    })

    it('should set correct body range in fallback element', async () => {
      await connectClient()

      const url = 'https://upload.example.com/files/photo.jpg'
      const attachment = {
        url,
        name: 'photo.jpg',
        size: 12345,
        mediaType: 'image/jpeg',
      }

      await xmppClient.chat.sendMessage('alice@example.com', url, 'chat', undefined, undefined, attachment)

      const sentStanza = mockXmppClientInstance.send.mock.calls[0][0]
      const fallbackEl = sentStanza.children.find(
        (c: any) => c.name === 'fallback' && c.attrs.xmlns === 'urn:xmpp:fallback:0'
      )
      const bodyRangeEl = fallbackEl?.children.find((c: any) => c.name === 'body')

      expect(bodyRangeEl).toBeDefined()
      expect(bodyRangeEl.attrs.start).toBe('0')
      expect(bodyRangeEl.attrs.end).toBe(String(url.length))
    })

    it('should store message with attachment and empty body in local store', async () => {
      await connectClient()

      const attachment = {
        url: 'https://upload.example.com/files/photo.jpg',
        name: 'photo.jpg',
        size: 12345,
        mediaType: 'image/jpeg',
        thumbnail: {
          uri: 'https://upload.example.com/thumbs/photo_thumb.jpg',
          mediaType: 'image/jpeg',
          width: 150,
          height: 100,
        },
      }

      await xmppClient.chat.sendMessage('alice@example.com', attachment.url, 'chat', undefined, undefined, attachment)

      // Body should be empty because the URL is fallback text for OOB
      // (our client understands OOB, so we strip the fallback)
      expect(emitSDKSpy).toHaveBeenCalledWith('chat:message', {
        message: expect.objectContaining({
          body: '',
          attachment: expect.objectContaining({
            url: attachment.url,
            name: 'photo.jpg',
            thumbnail: expect.objectContaining({
              uri: 'https://upload.example.com/thumbs/photo_thumb.jpg',
            }),
          }),
        })
      })
    })

    it('should preserve user text when sending attachment with body', async () => {
      // This test verifies the fix for the bug where body text was being stripped
      // when sending a file with accompanying text (e.g., "Check this out" + image)
      await connectClient()

      const userText = 'Check this out!'
      const url = 'https://upload.example.com/files/photo.jpg'
      const attachment = {
        url,
        name: 'photo.jpg',
        size: 12345,
        mediaType: 'image/jpeg',
      }

      await xmppClient.chat.sendMessage('alice@example.com', userText, 'chat', undefined, undefined, attachment)

      const sentStanza = mockXmppClientInstance.send.mock.calls[0][0]
      const bodyEl = sentStanza.children.find((c: any) => c.name === 'body')
      const fallbackEl = sentStanza.children.find(
        (c: any) => c.name === 'fallback' && c.attrs.xmlns === 'urn:xmpp:fallback:0'
      )
      const bodyRangeEl = fallbackEl?.children.find((c: any) => c.name === 'body')

      // Body should contain user text followed by URL (for non-OOB clients)
      const expectedBody = userText + '\n' + url
      expect(bodyEl.children[0]).toBe(expectedBody)

      // Fallback should mark ONLY the URL portion (after newline), NOT the user text
      const expectedStart = userText.length + 1 // +1 for newline
      expect(bodyRangeEl.attrs.start).toBe(String(expectedStart))
      expect(bodyRangeEl.attrs.end).toBe(String(expectedBody.length))

      // Stored message should preserve the user text (not strip it as fallback)
      expect(emitSDKSpy).toHaveBeenCalledWith('chat:message', {
        message: expect.objectContaining({
          body: userText, // User text is preserved
          attachment: expect.objectContaining({
            url,
          }),
        })
      })
    })

    it('should not include fallback when no attachment', async () => {
      await connectClient()

      await xmppClient.chat.sendMessage('alice@example.com', 'Hello, world!', 'chat')

      const sentStanza = mockXmppClientInstance.send.mock.calls[0][0]
      const fallbackEl = sentStanza.children.find(
        (c: any) => c.name === 'fallback' && c.attrs.xmlns === 'urn:xmpp:fallback:0'
      )
      const oobEl = sentStanza.children.find((c: any) => c.name === 'x' && c.attrs.xmlns === 'jabber:x:oob')

      expect(fallbackEl).toBeUndefined()
      expect(oobEl).toBeUndefined()
    })

    it('should work with groupchat type', async () => {
      await connectClient()

      const attachment = {
        url: 'https://upload.example.com/files/photo.jpg',
        name: 'photo.jpg',
        size: 12345,
        mediaType: 'image/jpeg',
      }

      await xmppClient.chat.sendMessage('room@conference.example.com', attachment.url, 'groupchat', undefined, undefined, attachment)

      const sentStanza = mockXmppClientInstance.send.mock.calls[0][0]

      expect(sentStanza.attrs.type).toBe('groupchat')
      expect(sentStanza.attrs.to).toBe('room@conference.example.com')

      const oobEl = sentStanza.children.find((c: any) => c.name === 'x' && c.attrs.xmlns === 'jabber:x:oob')
      const fallbackEl = sentStanza.children.find(
        (c: any) => c.name === 'fallback' && c.attrs.xmlns === 'urn:xmpp:fallback:0'
      )

      expect(oobEl).toBeDefined()
      expect(fallbackEl).toBeDefined()
    })

    it('should preserve user text in groupchat with attachment', async () => {
      // Verify the fix also works for groupchat (MUC) messages
      await connectClient()

      const userText = 'Check this image!'
      const url = 'https://upload.example.com/files/photo.jpg'
      const attachment = {
        url,
        name: 'photo.jpg',
        size: 12345,
        mediaType: 'image/jpeg',
      }

      await xmppClient.chat.sendMessage('room@conference.example.com', userText, 'groupchat', undefined, undefined, attachment)

      const sentStanza = mockXmppClientInstance.send.mock.calls[0][0]
      const bodyEl = sentStanza.children.find((c: any) => c.name === 'body')
      const fallbackEl = sentStanza.children.find(
        (c: any) => c.name === 'fallback' && c.attrs.xmlns === 'urn:xmpp:fallback:0'
      )
      const bodyRangeEl = fallbackEl?.children.find((c: any) => c.name === 'body')

      // Body should contain user text followed by URL
      const expectedBody = userText + '\n' + url
      expect(bodyEl.children[0]).toBe(expectedBody)

      // Fallback should mark ONLY the URL portion (after newline), NOT the user text
      const expectedStart = userText.length + 1 // +1 for newline
      expect(bodyRangeEl.attrs.start).toBe(String(expectedStart))
      expect(bodyRangeEl.attrs.end).toBe(String(expectedBody.length))
    })
  })

  describe('sendCorrection (XEP-0308)', () => {
    it('should throw error if not connected', async () => {
      await expect(
        xmppClient.chat.sendCorrection('contact@example.com', 'msg-123', 'Fixed message', 'chat')
      ).rejects.toThrow('Not connected')
    })

    it('should send correction stanza with correct structure', async () => {
      await connectClient()

      // Add original message to store
      mockStores.chat.getMessage = vi.fn().mockReturnValue({
        type: 'chat',
        id: 'original-msg-123',
        body: 'Original message',
        from: 'me@example.com',
      })

      await xmppClient.chat.sendCorrection('contact@example.com/resource', 'original-msg-123', 'Fixed message', 'chat')

      expect(mockXmppClientInstance.send).toHaveBeenCalled()
      const sentStanza = mockXmppClientInstance.send.mock.calls[0][0]

      expect(sentStanza.name).toBe('message')
      expect(sentStanza.attrs.type).toBe('chat')
      expect(sentStanza.attrs.to).toBe('contact@example.com') // bare JID for chat

      // Check body with [Corrected] prefix
      const bodyEl = sentStanza.children.find((c: any) => c.name === 'body')
      expect(bodyEl).toBeDefined()
      expect(bodyEl.children[0]).toBe('[Corrected] Fixed message')

      // Check replace element
      const replaceEl = sentStanza.children.find((c: any) => c.name === 'replace')
      expect(replaceEl).toBeDefined()
      expect(replaceEl.attrs.xmlns).toBe('urn:xmpp:message-correct:0')
      expect(replaceEl.attrs.id).toBe('original-msg-123')

      // Check fallback for correction prefix
      const fallbackEl = sentStanza.children.find(
        (c: any) => c.name === 'fallback' && c.attrs.for === 'urn:xmpp:message-correct:0'
      )
      expect(fallbackEl).toBeDefined()
    })

    it('should include OOB element when correction includes attachment', async () => {
      await connectClient()

      mockStores.chat.getMessage = vi.fn().mockReturnValue({
        type: 'chat',
        id: 'original-msg-123',
        body: '',
        from: 'me@example.com',
        attachment: { url: 'https://upload.example.com/old.jpg' },
      })

      const attachment = {
        url: 'https://upload.example.com/files/photo.jpg',
        name: 'photo.jpg',
        size: 12345,
        mediaType: 'image/jpeg',
      }

      await xmppClient.chat.sendCorrection('contact@example.com', 'original-msg-123', 'Updated caption', 'chat', attachment)

      const sentStanza = mockXmppClientInstance.send.mock.calls[0][0]
      const oobEl = sentStanza.children.find((c: any) => c.name === 'x' && c.attrs.xmlns === 'jabber:x:oob')

      expect(oobEl).toBeDefined()
      expect(oobEl.children.find((c: any) => c.name === 'url')).toBeDefined()
    })

    it('should include thumbnail in OOB when attachment has thumbnail', async () => {
      await connectClient()

      mockStores.chat.getMessage = vi.fn().mockReturnValue({
        type: 'chat',
        id: 'original-msg-123',
        body: '',
        from: 'me@example.com',
      })

      const attachment = {
        url: 'https://upload.example.com/files/photo.jpg',
        name: 'photo.jpg',
        size: 12345,
        mediaType: 'image/jpeg',
        thumbnail: {
          uri: 'https://upload.example.com/thumbs/photo_thumb.jpg',
          mediaType: 'image/jpeg',
          width: 150,
          height: 100,
        },
      }

      await xmppClient.chat.sendCorrection('contact@example.com', 'original-msg-123', '', 'chat', attachment)

      const sentStanza = mockXmppClientInstance.send.mock.calls[0][0]
      const oobEl = sentStanza.children.find((c: any) => c.name === 'x' && c.attrs.xmlns === 'jabber:x:oob')
      const thumbnailEl = oobEl?.children.find((c: any) => c.name === 'thumbnail')

      expect(thumbnailEl).toBeDefined()
      expect(thumbnailEl.attrs.xmlns).toBe('urn:xmpp:thumbs:1')
      expect(thumbnailEl.attrs.uri).toBe('https://upload.example.com/thumbs/photo_thumb.jpg')
    })

    it('should include XEP-0428 fallback for OOB when attachment provided', async () => {
      await connectClient()

      mockStores.chat.getMessage = vi.fn().mockReturnValue({
        type: 'chat',
        id: 'original-msg-123',
        body: '',
        from: 'me@example.com',
      })

      const attachment = {
        url: 'https://upload.example.com/files/photo.jpg',
        name: 'photo.jpg',
        size: 12345,
        mediaType: 'image/jpeg',
      }

      await xmppClient.chat.sendCorrection('contact@example.com', 'original-msg-123', '', 'chat', attachment)

      const sentStanza = mockXmppClientInstance.send.mock.calls[0][0]
      const oobFallbackEl = sentStanza.children.find(
        (c: any) => c.name === 'fallback' && c.attrs.for === 'jabber:x:oob'
      )

      expect(oobFallbackEl).toBeDefined()
    })

    it('should NOT include OOB when attachment is undefined (removed)', async () => {
      await connectClient()

      mockStores.chat.getMessage = vi.fn().mockReturnValue({
        type: 'chat',
        id: 'original-msg-123',
        body: '',
        from: 'me@example.com',
        attachment: { url: 'https://upload.example.com/old.jpg' },
      })

      // No attachment passed = attachment removed
      await xmppClient.chat.sendCorrection('contact@example.com', 'original-msg-123', 'Message without attachment', 'chat')

      const sentStanza = mockXmppClientInstance.send.mock.calls[0][0]
      const oobEl = sentStanza.children.find((c: any) => c.name === 'x' && c.attrs.xmlns === 'jabber:x:oob')
      const oobFallbackEl = sentStanza.children.find(
        (c: any) => c.name === 'fallback' && c.attrs.for === 'jabber:x:oob'
      )

      expect(oobEl).toBeUndefined()
      expect(oobFallbackEl).toBeUndefined()
    })

    it('should preserve user text when correction includes both body and attachment', async () => {
      // This test verifies the fix for corrections losing body text when attachment is present
      await connectClient()

      mockStores.chat.getMessage = vi.fn().mockReturnValue({
        type: 'chat',
        id: 'original-msg-123',
        body: 'Original message',
        from: 'me@example.com',
      })

      const userText = 'Updated caption for the image'
      const url = 'https://upload.example.com/files/photo.jpg'
      const attachment = {
        url,
        name: 'photo.jpg',
        size: 12345,
        mediaType: 'image/jpeg',
      }

      await xmppClient.chat.sendCorrection('contact@example.com', 'original-msg-123', userText, 'chat', attachment)

      const sentStanza = mockXmppClientInstance.send.mock.calls[0][0]
      const bodyEl = sentStanza.children.find((c: any) => c.name === 'body')
      const oobFallbackEl = sentStanza.children.find(
        (c: any) => c.name === 'fallback' && c.attrs.for === 'jabber:x:oob'
      )
      const bodyRangeEl = oobFallbackEl?.children.find((c: any) => c.name === 'body')

      // Body should be: "[Corrected] user text\nURL"
      const correctionPrefix = '[Corrected] '
      const expectedBody = correctionPrefix + userText + '\n' + url
      expect(bodyEl.children[0]).toBe(expectedBody)

      // OOB fallback should mark ONLY the URL portion (after correction prefix and user text)
      const expectedStart = correctionPrefix.length + userText.length + 1 // +1 for newline
      expect(bodyRangeEl.attrs.start).toBe(String(expectedStart))
      expect(bodyRangeEl.attrs.end).toBe(String(expectedBody.length))

      // Local store should have the user's text preserved
      expect(emitSDKSpy).toHaveBeenCalledWith('chat:message-updated', {
        conversationId: 'contact@example.com',
        messageId: 'original-msg-123',
        updates: expect.objectContaining({
          body: userText, // User text is preserved, not empty
          isEdited: true,
          attachment,
        })
      })
    })

    it('should update local store with attachment when provided', async () => {
      await connectClient()

      mockStores.chat.getMessage = vi.fn().mockReturnValue({
        type: 'chat',
        id: 'original-msg-123',
        body: 'Original',
        from: 'me@example.com',
      })

      const attachment = {
        url: 'https://upload.example.com/files/photo.jpg',
        name: 'photo.jpg',
        size: 12345,
        mediaType: 'image/jpeg',
      }

      await xmppClient.chat.sendCorrection('contact@example.com', 'original-msg-123', 'Updated', 'chat', attachment)

      expect(emitSDKSpy).toHaveBeenCalledWith('chat:message-updated', {
        conversationId: 'contact@example.com',
        messageId: 'original-msg-123',
        updates: expect.objectContaining({
          body: 'Updated',
          isEdited: true,
          attachment,
        })
      })
    })

    it('should update local store with undefined attachment when removed', async () => {
      await connectClient()

      mockStores.chat.getMessage = vi.fn().mockReturnValue({
        type: 'chat',
        id: 'original-msg-123',
        body: '',
        from: 'me@example.com',
        attachment: { url: 'https://upload.example.com/old.jpg' },
      })

      await xmppClient.chat.sendCorrection('contact@example.com', 'original-msg-123', 'Now just text', 'chat')

      expect(emitSDKSpy).toHaveBeenCalledWith('chat:message-updated', {
        conversationId: 'contact@example.com',
        messageId: 'original-msg-123',
        updates: expect.objectContaining({
          body: 'Now just text',
          isEdited: true,
          attachment: undefined,
        })
      })
    })

    it('should work with groupchat type', async () => {
      await connectClient()

      mockStores.room.getRoom = vi.fn().mockReturnValue({ jid: 'room@conference.example.com', nickname: 'me' })
      mockStores.room.getMessage = vi.fn().mockReturnValue({
        type: 'chat',
        id: 'original-msg-123',
        body: 'Original',
        from: 'room@conference.example.com/me',
      })

      const attachment = {
        url: 'https://upload.example.com/files/photo.jpg',
        name: 'photo.jpg',
        size: 12345,
        mediaType: 'image/jpeg',
      }

      await xmppClient.chat.sendCorrection('room@conference.example.com', 'original-msg-123', 'Fixed', 'groupchat', attachment)

      const sentStanza = mockXmppClientInstance.send.mock.calls[0][0]

      expect(sentStanza.attrs.type).toBe('groupchat')
      expect(sentStanza.attrs.to).toBe('room@conference.example.com')

      const oobEl = sentStanza.children.find((c: any) => c.name === 'x' && c.attrs.xmlns === 'jabber:x:oob')
      expect(oobEl).toBeDefined()

      expect(emitSDKSpy).toHaveBeenCalledWith('room:message-updated', {
        roomJid: 'room@conference.example.com',
        messageId: 'original-msg-123',
        updates: expect.objectContaining({
          body: 'Fixed',
          isEdited: true,
          attachment,
        })
      })
    })
  })

  describe('sendRetraction (XEP-0424)', () => {
    it('should throw error if not connected', async () => {
      await expect(
        xmppClient.chat.sendRetraction('contact@example.com', 'msg-123', 'chat')
      ).rejects.toThrow('Not connected')
    })

    it('should send retraction stanza with correct structure for chat', async () => {
      await connectClient()

      await xmppClient.chat.sendRetraction('contact@example.com/resource', 'original-msg-123', 'chat')

      expect(mockXmppClientInstance.send).toHaveBeenCalled()
      const sentStanza = mockXmppClientInstance.send.mock.calls[0][0]

      // Should be a message stanza
      expect(sentStanza.name).toBe('message')
      expect(sentStanza.attrs.type).toBe('chat')
      // Should send to bare JID for chat messages
      expect(sentStanza.attrs.to).toBe('contact@example.com')

      // Should have retract element with correct namespace and ID
      const retractEl = sentStanza.children.find(
        (c: any) => c.name === 'retract' && c.attrs.xmlns === 'urn:xmpp:message-retract:1'
      )
      expect(retractEl).toBeDefined()
      expect(retractEl.attrs.id).toBe('original-msg-123')

      // Should have fallback body for non-supporting clients
      const bodyEl = sentStanza.children.find((c: any) => c.name === 'body')
      expect(bodyEl).toBeDefined()

      // Should have XEP-0428 fallback element
      const fallbackEl = sentStanza.children.find(
        (c: any) => c.name === 'fallback' && c.attrs.xmlns === 'urn:xmpp:fallback:0'
      )
      expect(fallbackEl).toBeDefined()
      expect(fallbackEl.attrs.for).toBe('urn:xmpp:message-retract:1')
    })

    it('should send retraction stanza with full JID for groupchat', async () => {
      await connectClient()

      await xmppClient.chat.sendRetraction('room@conference.example.com', 'original-msg-456', 'groupchat')

      expect(mockXmppClientInstance.send).toHaveBeenCalled()
      const sentStanza = mockXmppClientInstance.send.mock.calls[0][0]

      expect(sentStanza.name).toBe('message')
      expect(sentStanza.attrs.type).toBe('groupchat')
      // Should send to full room JID (not bare JID conversion)
      expect(sentStanza.attrs.to).toBe('room@conference.example.com')

      const retractEl = sentStanza.children.find(
        (c: any) => c.name === 'retract' && c.attrs.xmlns === 'urn:xmpp:message-retract:1'
      )
      expect(retractEl).toBeDefined()
      expect(retractEl.attrs.id).toBe('original-msg-456')
    })

    it('should update chat store with isRetracted for existing message', async () => {
      await connectClient()

      // Mock that the original message exists
      vi.mocked(mockStores.chat.getMessage).mockReturnValue({
        type: 'chat',
        id: 'original-msg-123',
        conversationId: 'contact@example.com',
        from: 'user@example.com',
        body: 'Original message',
        timestamp: new Date(),
        isOutgoing: true,
      })

      await xmppClient.chat.sendRetraction('contact@example.com', 'original-msg-123', 'chat')

      expect(emitSDKSpy).toHaveBeenCalledWith('chat:message-updated', {
        conversationId: 'contact@example.com',
        messageId: 'original-msg-123',
        updates: expect.objectContaining({
          isRetracted: true,
          retractedAt: expect.any(Date),
        })
      })
    })

    it('should update room store with isRetracted for existing room message', async () => {
      await connectClient()

      // Mock that the original room message exists
      vi.mocked(mockStores.room.getMessage).mockReturnValue({
        type: 'groupchat',
        id: 'original-room-msg-456',
        roomJid: 'room@conference.example.com',
        from: 'room@conference.example.com/user',
        nick: 'user',
        body: 'Original room message',
        timestamp: new Date(),
        isOutgoing: true,
      })

      await xmppClient.chat.sendRetraction('room@conference.example.com', 'original-room-msg-456', 'groupchat')

      expect(emitSDKSpy).toHaveBeenCalledWith('room:message-updated', {
        roomJid: 'room@conference.example.com',
        messageId: 'original-room-msg-456',
        updates: expect.objectContaining({
          isRetracted: true,
          retractedAt: expect.any(Date),
        })
      })
    })

    it('should not update chat store if original message not found', async () => {
      await connectClient()

      // Mock that the message doesn't exist
      vi.mocked(mockStores.chat.getMessage).mockReturnValue(undefined)

      await xmppClient.chat.sendRetraction('contact@example.com', 'non-existent-msg', 'chat')

      // Should still send the stanza
      expect(mockXmppClientInstance.send).toHaveBeenCalled()
      // But should not emit message-updated event
      expect(emitSDKSpy).not.toHaveBeenCalledWith('chat:message-updated', expect.anything())
    })

    it('should not update room store if original message not found', async () => {
      await connectClient()

      // Mock that the message doesn't exist
      vi.mocked(mockStores.room.getMessage).mockReturnValue(undefined)

      await xmppClient.chat.sendRetraction('room@conference.example.com', 'non-existent-msg', 'groupchat')

      // Should still send the stanza
      expect(mockXmppClientInstance.send).toHaveBeenCalled()
      // But should not emit message-updated event
      expect(emitSDKSpy).not.toHaveBeenCalledWith('room:message-updated', expect.anything())
    })

    it('should default to chat type when type not specified', async () => {
      await connectClient()

      await xmppClient.chat.sendRetraction('contact@example.com', 'msg-123')

      const sentStanza = mockXmppClientInstance.send.mock.calls[0][0]
      expect(sentStanza.attrs.type).toBe('chat')
    })
  })

  describe('error messages', () => {
    it('should emit room:invite-error for bounced MUC invitation', async () => {
      await connectClient()

      // Simulate a bounced MUC invitation error stanza
      const errorStanza = createMockElement('message', {
        from: 'room@conference.example.com',
        to: 'user@example.com',
        type: 'error',
      }, [
        { name: 'body', text: 'Join us!' },
        {
          name: 'x',
          attrs: { xmlns: 'http://jabber.org/protocol/muc#user' },
          children: [
            { name: 'invite', attrs: { to: 'target@example.com' } },
          ],
        },
        {
          name: 'error',
          attrs: { type: 'auth' },
          children: [
            { name: 'forbidden', attrs: { xmlns: 'urn:ietf:params:xml:ns:xmpp-stanzas' } },
          ],
        },
      ])

      mockXmppClientInstance._emit('stanza', errorStanza)

      expect(emitSDKSpy).toHaveBeenCalledWith('room:invite-error', {
        roomJid: 'room@conference.example.com',
        error: 'Forbidden',
        condition: 'forbidden',
        errorType: 'auth',
      })
    })

    it('should not emit room:invite-error for non-invitation errors', async () => {
      await connectClient()

      // A regular error message without muc#user invite
      const errorStanza = createMockElement('message', {
        from: 'contact@example.com',
        to: 'user@example.com',
        type: 'error',
      }, [
        { name: 'body', text: 'Hello' },
        {
          name: 'error',
          attrs: { type: 'cancel' },
          children: [
            { name: 'service-unavailable', attrs: { xmlns: 'urn:ietf:params:xml:ns:xmpp-stanzas' } },
          ],
        },
      ])

      mockXmppClientInstance._emit('stanza', errorStanza)

      expect(emitSDKSpy).not.toHaveBeenCalledWith('room:invite-error', expect.anything())
    })

    it('should silently handle error messages with no error element', async () => {
      await connectClient()

      const errorStanza = createMockElement('message', {
        from: 'room@conference.example.com',
        to: 'user@example.com',
        type: 'error',
      }, [])

      mockXmppClientInstance._emit('stanza', errorStanza)

      expect(emitSDKSpy).not.toHaveBeenCalledWith('room:invite-error', expect.anything())
    })

    it('should not emit when error message has no from attribute', async () => {
      await connectClient()

      const errorStanza = createMockElement('message', {
        to: 'user@example.com',
        type: 'error',
      }, [
        {
          name: 'x',
          attrs: { xmlns: 'http://jabber.org/protocol/muc#user' },
          children: [
            { name: 'invite', attrs: { to: 'target@example.com' } },
          ],
        },
        {
          name: 'error',
          attrs: { type: 'auth' },
          children: [
            { name: 'forbidden', attrs: { xmlns: 'urn:ietf:params:xml:ns:xmpp-stanzas' } },
          ],
        },
      ])

      mockXmppClientInstance._emit('stanza', errorStanza)

      expect(emitSDKSpy).not.toHaveBeenCalledWith('room:invite-error', expect.anything())
    })

    it('should not emit when error element is missing but MUC invite is present', async () => {
      await connectClient()

      // Stanza has muc#user invite but no <error> child — parseXMPPError returns null
      const errorStanza = createMockElement('message', {
        from: 'room@conference.example.com',
        to: 'user@example.com',
        type: 'error',
      }, [
        {
          name: 'x',
          attrs: { xmlns: 'http://jabber.org/protocol/muc#user' },
          children: [
            { name: 'invite', attrs: { to: 'target@example.com' } },
          ],
        },
      ])

      mockXmppClientInstance._emit('stanza', errorStanza)

      expect(emitSDKSpy).not.toHaveBeenCalledWith('room:invite-error', expect.anything())
    })

    it('should prefer server text over condition name in error field', async () => {
      await connectClient()

      const errorStanza = createMockElement('message', {
        from: 'room@conference.example.com',
        to: 'user@example.com',
        type: 'error',
      }, [
        {
          name: 'x',
          attrs: { xmlns: 'http://jabber.org/protocol/muc#user' },
          children: [
            { name: 'invite', attrs: { to: 'target@example.com' } },
          ],
        },
        {
          name: 'error',
          attrs: { type: 'auth' },
          children: [
            { name: 'forbidden', attrs: { xmlns: 'urn:ietf:params:xml:ns:xmpp-stanzas' } },
            { name: 'text', attrs: { xmlns: 'urn:ietf:params:xml:ns:xmpp-stanzas' }, text: 'You are not allowed to invite users' },
          ],
        },
      ])

      mockXmppClientInstance._emit('stanza', errorStanza)

      expect(emitSDKSpy).toHaveBeenCalledWith('room:invite-error', {
        roomJid: 'room@conference.example.com',
        error: 'You are not allowed to invite users',
        condition: 'forbidden',
        errorType: 'auth',
      })
    })
  })

  /**
   * Regression test for GitHub issue #117
   * Messages from IRC bridges (like Biboumi) may lack XMPP message IDs.
   * Without stable ID generation, these messages get duplicated on room rejoin.
   */
  describe('messages without ID (IRC bridge regression #117)', () => {
    it('should generate stable ID for room messages without stanza id', async () => {
      await connectClient()

      const roomJid = 'irc-channel@biboumi.example.com'
      mockStores.room.getRoom.mockReturnValue({
        jid: roomJid,
        name: '#channel',
        nickname: 'myNick',
        joined: true,
        isBookmarked: false,
        unreadCount: 0,
        mentionsCount: 0,
        typingUsers: new Set<string>(),
        occupants: new Map(),
        messages: [],
      })

      // Simulate message from IRC bridge without id attribute
      const ircMessage = createMockElement('message', {
        from: `${roomJid}/ircUser`,
        to: 'me@example.com',
        type: 'groupchat',
        // Note: no 'id' attribute - this is the bug trigger
      }, [
        { name: 'body', text: 'Hello from IRC!' },
        {
          name: 'delay',
          attrs: { xmlns: 'urn:xmpp:delay', stamp: '2024-01-15T10:30:00.000Z' },
        },
      ])

      mockXmppClientInstance._emit('stanza', ircMessage)

      // Verify SDK event was emitted with stable ID
      expect(emitSDKSpy).toHaveBeenCalledWith('room:message', expect.objectContaining({
        roomJid,
        message: expect.objectContaining({
          id: expect.stringMatching(/^stable-[0-9a-f]{8}-[0-9a-f]{8}$/),
          roomJid,
          body: 'Hello from IRC!',
        })
      }))
    })

    it('should generate same stable ID for identical room messages (deduplication)', async () => {
      await connectClient()

      const roomJid = 'irc-channel@biboumi.example.com'
      mockStores.room.getRoom.mockReturnValue({
        jid: roomJid,
        name: '#channel',
        nickname: 'myNick',
        joined: true,
        isBookmarked: false,
        unreadCount: 0,
        mentionsCount: 0,
        typingUsers: new Set<string>(),
        occupants: new Map(),
        messages: [],
      })

      // Same message received twice (e.g., on room rejoin)
      const createIrcMessage = () => createMockElement('message', {
        from: `${roomJid}/ircUser`,
        to: 'me@example.com',
        type: 'groupchat',
      }, [
        { name: 'body', text: 'Hello from IRC!' },
        {
          name: 'delay',
          attrs: { xmlns: 'urn:xmpp:delay', stamp: '2024-01-15T10:30:00.000Z' },
        },
      ])

      mockXmppClientInstance._emit('stanza', createIrcMessage())
      mockXmppClientInstance._emit('stanza', createIrcMessage())

      // Get the message IDs from both emitted events
      const roomMessageCalls = emitSDKSpy.mock.calls.filter(
        (call: unknown[]) => call[0] === 'room:message'
      )
      expect(roomMessageCalls).toHaveLength(2)

      const firstMessage = roomMessageCalls[0][1].message
      const secondMessage = roomMessageCalls[1][1].message

      // Both should have the same stable ID (enabling deduplication)
      expect(firstMessage.id).toBe(secondMessage.id)
      expect(firstMessage.id).toMatch(/^stable-/)
    })

    it('should generate stable ID for chat messages without stanza id', async () => {
      await connectClient()

      // Simulate message without id attribute
      const chatMessage = createMockElement('message', {
        from: 'contact@example.com/resource',
        to: 'me@example.com',
        type: 'chat',
        // Note: no 'id' attribute
      }, [
        { name: 'body', text: 'Hello!' },
        {
          name: 'delay',
          attrs: { xmlns: 'urn:xmpp:delay', stamp: '2024-01-15T10:30:00.000Z' },
        },
      ])

      mockXmppClientInstance._emit('stanza', chatMessage)

      // Verify SDK event was emitted with stable ID
      expect(emitSDKSpy).toHaveBeenCalledWith('chat:message', {
        message: expect.objectContaining({
          id: expect.stringMatching(/^stable-[0-9a-f]{8}-[0-9a-f]{8}$/),
          conversationId: 'contact@example.com',
          body: 'Hello!',
        })
      })
    })
  })
})
