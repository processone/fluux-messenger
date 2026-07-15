/**
 * XMPPClient Message Tests
 *
 * Tests for message handling: regular messages, carbons (XEP-0280),
 * chat state notifications (XEP-0085), message styling (XEP-0393),
 * replies with fallback (XEP-0461 + XEP-0428), and reactions (XEP-0444).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { XMPPClient } from '../XMPPClient'
import { E2EEEncryptionRequiredError } from '../e2ee'
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

  describe('XEP-0359 by-aware stanza-id selection', () => {
    // Connected JID is user@example.com, so the user's own archive `by` is the
    // bare JID. A message can carry several <stanza-id by="..."/> — only the one
    // stamped by the queried archive is a valid MAM cursor / cross-client ref.
    it('1:1: stores the stanza-id stamped by the user\'s own archive, not a foreign one', async () => {
      await connectClient()

      const messageStanza = createMockElement('message', {
        from: 'contact@example.com/resource',
        to: 'user@example.com',
        type: 'chat',
        id: 'msg-1',
      }, [
        { name: 'body', text: 'Hello!' },
        // Foreign id first (e.g. stamped by the sender's server), own id second.
        { name: 'stanza-id', attrs: { xmlns: 'urn:xmpp:sid:0', id: 'foreign-id', by: 'contact-server.example.org' } },
        { name: 'stanza-id', attrs: { xmlns: 'urn:xmpp:sid:0', id: 'own-archive-id', by: 'user@example.com' } },
      ])

      mockXmppClientInstance._emit('stanza', messageStanza)

      expect(emitSDKSpy).toHaveBeenCalledWith('chat:message', {
        message: expect.objectContaining({
          id: 'msg-1',
          stanzaId: 'own-archive-id',
        })
      })
    })

    it('MUC: stores the stanza-id stamped by the room archive, not a foreign one', async () => {
      await connectClient()

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

      const messageStanza = createMockElement('message', {
        from: 'room@conference.example.com/Alice',
        to: 'user@example.com',
        type: 'groupchat',
        id: 'msg-2',
      }, [
        { name: 'body', text: 'Hi room!' },
        // The user's own server may also stamp a stanza-id (carbon-style); the
        // MUC archive id (by = room JID) is the one we must keep.
        { name: 'stanza-id', attrs: { xmlns: 'urn:xmpp:sid:0', id: 'user-server-id', by: 'user@example.com' } },
        { name: 'stanza-id', attrs: { xmlns: 'urn:xmpp:sid:0', id: 'room-archive-id', by: 'room@conference.example.com' } },
      ])

      mockXmppClientInstance._emit('stanza', messageStanza)

      expect(emitSDKSpy).toHaveBeenCalledWith('room:message', expect.objectContaining({
        message: expect.objectContaining({
          id: 'msg-2',
          stanzaId: 'room-archive-id',
        })
      }))
    })

    it('1:1: falls back to the only stanza-id when none matches the own archive', async () => {
      await connectClient()

      const messageStanza = createMockElement('message', {
        from: 'contact@example.com/resource',
        to: 'user@example.com',
        type: 'chat',
        id: 'msg-3',
      }, [
        { name: 'body', text: 'Single archive' },
        { name: 'stanza-id', attrs: { xmlns: 'urn:xmpp:sid:0', id: 'only-id', by: 'user@example.com' } },
      ])

      mockXmppClientInstance._emit('stanza', messageStanza)

      expect(emitSDKSpy).toHaveBeenCalledWith('chat:message', {
        message: expect.objectContaining({ id: 'msg-3', stanzaId: 'only-id' })
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

  describe('easter eggs (animation triggers)', () => {
    it('emits chat:animation with the sender bare JID on receipt', async () => {
      await connectClient()

      const stanza = createMockElement('message', {
        from: 'ava@fluux.chat/phone',
        to: 'me@fluux.chat',
        type: 'chat',
      }, [
        { name: 'easter-egg', attrs: { xmlns: 'urn:fluux:easter-egg:0', animation: 'fireworks' } },
      ])

      mockXmppClientInstance._emit('stanza', stanza)

      expect(emitSDKSpy).toHaveBeenCalledWith('chat:animation', {
        conversationId: 'ava@fluux.chat',
        animation: 'fireworks',
        senderJid: 'ava@fluux.chat',
      })
    })

    it('emits room:animation with the sender nick on receipt', async () => {
      await connectClient()

      const stanza = createMockElement('message', {
        from: 'room@conf.fluux.chat/ava',
        type: 'groupchat',
      }, [
        { name: 'easter-egg', attrs: { xmlns: 'urn:fluux:easter-egg:0', animation: 'fireworks' } },
      ])

      mockXmppClientInstance._emit('stanza', stanza)

      expect(emitSDKSpy).toHaveBeenCalledWith('room:animation', {
        roomJid: 'room@conf.fluux.chat',
        animation: 'fireworks',
        senderNick: 'ava',
      })
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

    it('should NOT store a reply whose body is entirely a fallback (no new text)', async () => {
      await connectClient()

      // "> Alice: Hello there!" is 21 chars and the fallback covers all of it,
      // so processedBody strips to '' — there is no new text. With no attachment
      // or other payload, the message has nothing to render and must be dropped
      // rather than stored as a blank bubble.
      const messageStanza = createMockElement('message', {
        from: 'contact@example.com/resource',
        to: 'user@example.com',
        type: 'chat',
        id: 'msg-empty-reply',
      }, [
        { name: 'body', text: '> Alice: Hello there!' },
        { name: 'reply', attrs: { xmlns: 'urn:xmpp:reply:0', id: 'orig-empty', to: 'alice@example.com' } },
        {
          name: 'fallback',
          attrs: { xmlns: 'urn:xmpp:fallback:0', for: 'urn:xmpp:reply:0' },
          children: [
            { name: 'body', attrs: { xmlns: 'urn:xmpp:fallback:0', start: '0', end: '21' } },
          ],
        },
      ])

      mockXmppClientInstance._emit('stanza', messageStanza)

      expect(emitSDKSpy).not.toHaveBeenCalledWith('chat:message', expect.objectContaining({
        message: expect.objectContaining({ id: 'msg-empty-reply' }),
      }))
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

  describe('incoming reactions (XEP-0444)', () => {
    it('should handle reaction without body (standard case)', async () => {
      await connectClient()

      const stanza = createMockElement('message', {
        from: 'contact@example.com/resource',
        to: 'user@example.com',
        type: 'chat',
        id: 'reaction-1',
      }, [
        {
          name: 'reactions',
          attrs: { xmlns: 'urn:xmpp:reactions:0', id: 'target-msg-1' },
          children: [
            { name: 'reaction', text: '👍' },
          ],
        },
      ])

      mockXmppClientInstance._emit('stanza', stanza)

      expect(emitSDKSpy).toHaveBeenCalledWith('chat:reactions', {
        isLive: true,
        conversationId: 'contact@example.com',
        messageId: 'target-msg-1',
        reactorJid: 'contact@example.com',
        emojis: ['👍'],
      })
      // Should NOT emit a chat:message event
      expect(emitSDKSpy).not.toHaveBeenCalledWith('chat:message', expect.anything())
    })

    it('should extract XEP-0203 delay timestamp from incoming reaction stanza', async () => {
      await connectClient()

      const stanza = createMockElement('message', {
        from: 'contact@example.com/resource',
        to: 'user@example.com',
        type: 'chat',
        id: 'reaction-delayed',
      }, [
        {
          name: 'reactions',
          attrs: { xmlns: 'urn:xmpp:reactions:0', id: 'target-msg-delayed' },
          children: [
            { name: 'reaction', text: '🎉' },
          ],
        },
        { name: 'delay', attrs: { xmlns: 'urn:xmpp:delay', stamp: '2024-01-15T10:30:00.000Z' } },
      ])

      mockXmppClientInstance._emit('stanza', stanza)

      expect(emitSDKSpy).toHaveBeenCalledWith('chat:reactions', {
        // A delay stamp marks a replayed / offline-queued reaction — not live.
        isLive: false,
        conversationId: 'contact@example.com',
        messageId: 'target-msg-delayed',
        reactorJid: 'contact@example.com',
        emojis: ['🎉'],
        timestamp: new Date('2024-01-15T10:30:00.000Z'),
      })
    })

    it('should handle reaction with body and reactions fallback (entire body is fallback)', async () => {
      await connectClient()

      // Real-world stanza: reaction with body for legacy clients, plus fallback indication
      const stanza = createMockElement('message', {
        from: 'contact@example.com/resource',
        to: 'user@example.com',
        type: 'chat',
        id: 'reaction-2',
      }, [
        { name: 'body', text: '> Alice: Original message\n\n👍' },
        {
          name: 'reactions',
          attrs: { xmlns: 'urn:xmpp:reactions:0', id: 'target-msg-2' },
          children: [
            { name: 'reaction', text: '👍' },
          ],
        },
        { name: 'reply', attrs: { xmlns: 'urn:xmpp:reply:0', id: 'target-msg-2', to: 'alice@example.com' } },
        {
          name: 'fallback',
          attrs: { xmlns: 'urn:xmpp:fallback:0', for: 'urn:xmpp:reply:0' },
          children: [
            { name: 'body', attrs: { xmlns: 'urn:xmpp:fallback:0', start: '0', end: '26' } },
          ],
        },
        {
          name: 'fallback',
          attrs: { xmlns: 'urn:xmpp:fallback:0', for: 'urn:xmpp:reactions:0' },
          children: [
            { name: 'body', attrs: { xmlns: 'urn:xmpp:fallback:0' } },
          ],
        },
      ])

      mockXmppClientInstance._emit('stanza', stanza)

      // Should handle as reaction only
      expect(emitSDKSpy).toHaveBeenCalledWith('chat:reactions', {
        isLive: true,
        conversationId: 'contact@example.com',
        messageId: 'target-msg-2',
        reactorJid: 'contact@example.com',
        emojis: ['👍'],
      })
      // Should NOT create a message — body is entirely fallback for reactions
      expect(emitSDKSpy).not.toHaveBeenCalledWith('chat:message', expect.anything())
    })

    it('should handle reaction with body but no reactions fallback (legacy sender)', async () => {
      await connectClient()

      // Legacy sender: includes body + reactions element but no fallback indication
      // The body should be treated as a regular message since we can't tell it's fallback
      const stanza = createMockElement('message', {
        from: 'contact@example.com/resource',
        to: 'user@example.com',
        type: 'chat',
        id: 'reaction-3',
      }, [
        { name: 'body', text: '👍' },
        {
          name: 'reactions',
          attrs: { xmlns: 'urn:xmpp:reactions:0', id: 'target-msg-3' },
          children: [
            { name: 'reaction', text: '👍' },
          ],
        },
      ])

      mockXmppClientInstance._emit('stanza', stanza)

      // Should handle the reaction
      expect(emitSDKSpy).toHaveBeenCalledWith('chat:reactions', expect.anything())
      // Reaction stanzas are always treated as handled — body is assumed to be
      // fallback for legacy clients even without explicit fallback indication
      expect(emitSDKSpy).not.toHaveBeenCalledWith('chat:message', expect.anything())
    })

    it('should handle groupchat reaction with body and reactions fallback', async () => {
      await connectClient()

      const stanza = createMockElement('message', {
        from: 'room@conference.example.com/Kris',
        to: 'user@example.com',
        type: 'groupchat',
        id: 'reaction-muc-1',
      }, [
        { name: 'body', text: '> zeank: Some original text\n\n👍' },
        {
          name: 'reactions',
          attrs: { xmlns: 'urn:xmpp:reactions:0', id: 'target-msg-muc' },
          children: [
            { name: 'reaction', text: '👍' },
          ],
        },
        {
          name: 'fallback',
          attrs: { xmlns: 'urn:xmpp:fallback:0', for: 'urn:xmpp:reply:0' },
          children: [
            { name: 'body', attrs: { xmlns: 'urn:xmpp:fallback:0', start: '0', end: '28' } },
          ],
        },
        {
          name: 'fallback',
          attrs: { xmlns: 'urn:xmpp:fallback:0', for: 'urn:xmpp:reactions:0' },
          children: [
            { name: 'body', attrs: { xmlns: 'urn:xmpp:fallback:0' } },
          ],
        },
      ])

      mockXmppClientInstance._emit('stanza', stanza)

      // Should handle as groupchat reaction only
      expect(emitSDKSpy).toHaveBeenCalledWith('room:reactions', {
        isLive: true,
        roomJid: 'room@conference.example.com',
        messageId: 'target-msg-muc',
        reactorNick: 'Kris',
        emojis: ['👍'],
      })
      // Should NOT create a room message
      expect(emitSDKSpy).not.toHaveBeenCalledWith('room:message', expect.anything())
      expect(emitSDKSpy).not.toHaveBeenCalledWith('chat:message', expect.anything())
    })
  })

  describe('sendReaction (XEP-0444)', () => {
    it('should send a clean bodiless reaction stanza (no reply-quote fallback)', async () => {
      await connectClient()

      mockStores.chat.getMessage = vi.fn().mockReturnValue({
        type: 'chat',
        id: 'msg-123',
        body: 'Hello world',
        from: 'alice@example.com',
      })

      await xmppClient.chat.sendReaction('alice@example.com', 'msg-123', ['👍', '❤️'], 'chat')

      expect(mockXmppClientInstance.send).toHaveBeenCalledTimes(1)

      const sentStanza = mockXmppClientInstance.send.mock.calls[0][0]
      expect(sentStanza.name).toBe('message')
      expect(sentStanza.attrs.to).toBe('alice@example.com')
      expect(sentStanza.attrs.type).toBe('chat')

      // Reactions element with the emoji
      const reactionsEl = sentStanza.children.find((c: any) => c.name === 'reactions')
      expect(reactionsEl).toBeDefined()
      expect(reactionsEl.attrs.xmlns).toBe('urn:xmpp:reactions:0')
      expect(reactionsEl.attrs.id).toBe('msg-123')
      const reactionEls = reactionsEl.children.filter((c: any) => c.name === 'reaction')
      expect(reactionEls.length).toBe(2)
      expect(reactionEls[0].children[0]).toBe('👍')
      expect(reactionEls[1].children[0]).toBe('❤️')

      // No body, no <reply>, no <fallback> — we don't surface reactions as
      // quoted replies and don't force fallback processing on other clients.
      expect(sentStanza.children.find((c: any) => c.name === 'body')).toBeUndefined()
      expect(sentStanza.children.find((c: any) => c.name === 'reply')).toBeUndefined()
      expect(sentStanza.children.filter((c: any) => c.name === 'fallback').length).toBe(0)

      // Store hint so the bodiless reaction is still archived in MAM
      const storeEl = sentStanza.children.find((c: any) => c.name === 'store')
      expect(storeEl).toBeDefined()
      expect(storeEl.attrs.xmlns).toBe('urn:xmpp:hints')
    })

    it('should send simple reaction when original message not found', async () => {
      await connectClient()

      // getMessage returns undefined (default mock behavior)
      await xmppClient.chat.sendReaction('alice@example.com', 'msg-123', ['👍'], 'chat')

      const sentStanza = mockXmppClientInstance.send.mock.calls[0][0]

      // Should have reactions element but no body/reply/fallback
      const reactionsEl = sentStanza.children.find((c: any) => c.name === 'reactions')
      expect(reactionsEl).toBeDefined()
      expect(reactionsEl.attrs.id).toBe('msg-123')

      const bodyEl = sentStanza.children.find((c: any) => c.name === 'body')
      expect(bodyEl).toBeUndefined()

      const replyEl = sentStanza.children.find((c: any) => c.name === 'reply')
      expect(replyEl).toBeUndefined()

      const fallbackEls = sentStanza.children.filter((c: any) => c.name === 'fallback')
      expect(fallbackEls.length).toBe(0)
    })

    it('should send simple reaction when removing all reactions (empty emojis)', async () => {
      await connectClient()

      mockStores.chat.getMessage = vi.fn().mockReturnValue({
        type: 'chat',
        id: 'msg-123',
        body: 'Hello',
        from: 'alice@example.com',
      })

      await xmppClient.chat.sendReaction('alice@example.com', 'msg-123', [], 'chat')

      const sentStanza = mockXmppClientInstance.send.mock.calls[0][0]
      const reactionsEl = sentStanza.children.find((c: any) => c.name === 'reactions')
      expect(reactionsEl.children.length).toBe(0)

      // No body/fallback for empty reactions
      const bodyEl = sentStanza.children.find((c: any) => c.name === 'body')
      expect(bodyEl).toBeUndefined()
    })

    it('should update local store after sending reaction', async () => {
      await connectClient()

      await xmppClient.chat.sendReaction('alice@example.com', 'msg-123', ['👍'], 'chat')

      expect(emitSDKSpy).toHaveBeenCalledWith('chat:reactions', {
        isLive: true,
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

    it('should prefer stanzaId over client id for groupchat reactions', async () => {
      await connectClient()

      mockStores.room.getRoom = vi.fn().mockReturnValue({ jid: 'room@conference.example.com', nickname: 'me' })
      mockStores.room.getMessage = vi.fn().mockReturnValue({
        type: 'groupchat',
        id: 'client-msg-id',
        stanzaId: 'server-stanza-id',
        body: 'Hello',
        from: 'room@conference.example.com/alice',
      })

      await xmppClient.chat.sendReaction('room@conference.example.com', 'client-msg-id', ['👍'], 'groupchat')

      const sentStanza = mockXmppClientInstance.send.mock.calls[0][0]
      const reactionsEl = sentStanza.children.find((c: any) => c.name === 'reactions')
      // Protocol stanza should reference stanzaId
      expect(reactionsEl.attrs.id).toBe('server-stanza-id')
    })

    it('should fall back to client id when message has no stanzaId', async () => {
      await connectClient()

      mockStores.room.getRoom = vi.fn().mockReturnValue({ jid: 'room@conference.example.com', nickname: 'me' })
      mockStores.room.getMessage = vi.fn().mockReturnValue({
        type: 'groupchat',
        id: 'client-msg-id',
        body: 'Hello',
        from: 'room@conference.example.com/alice',
      })

      await xmppClient.chat.sendReaction('room@conference.example.com', 'client-msg-id', ['👍'], 'groupchat')

      const sentStanza = mockXmppClientInstance.send.mock.calls[0][0]
      const reactionsEl = sentStanza.children.find((c: any) => c.name === 'reactions')
      expect(reactionsEl.attrs.id).toBe('client-msg-id')
    })

    it('should fall back to client id when message not found in store', async () => {
      await connectClient()

      mockStores.room.getRoom = vi.fn().mockReturnValue({ jid: 'room@conference.example.com', nickname: 'me' })
      // getMessage returns undefined (default mock behavior)

      await xmppClient.chat.sendReaction('room@conference.example.com', 'unknown-msg-id', ['👍'], 'groupchat')

      const sentStanza = mockXmppClientInstance.send.mock.calls[0][0]
      const reactionsEl = sentStanza.children.find((c: any) => c.name === 'reactions')
      expect(reactionsEl.attrs.id).toBe('unknown-msg-id')
    })

    it('should send a clean bodiless reaction stanza for groupchat (no reply-quote fallback)', async () => {
      await connectClient()

      mockStores.room.getRoom = vi.fn().mockReturnValue({ jid: 'room@conference.example.com', nickname: 'me' })
      mockStores.room.getMessage = vi.fn().mockReturnValue({
        type: 'groupchat',
        id: 'client-msg-id',
        stanzaId: 'server-stanza-id',
        body: 'Hello everyone',
        from: 'room@conference.example.com/alice',
      })

      await xmppClient.chat.sendReaction('room@conference.example.com', 'client-msg-id', ['🎉'], 'groupchat')

      const sentStanza = mockXmppClientInstance.send.mock.calls[0][0]

      // Reactions element references the server stanza-id for MUC
      const reactionsEl = sentStanza.children.find((c: any) => c.name === 'reactions')
      expect(reactionsEl).toBeDefined()
      expect(reactionsEl.attrs.id).toBe('server-stanza-id')

      // No body, no <reply>, no <fallback>
      expect(sentStanza.children.find((c: any) => c.name === 'body')).toBeUndefined()
      expect(sentStanza.children.find((c: any) => c.name === 'reply')).toBeUndefined()
      expect(sentStanza.children.filter((c: any) => c.name === 'fallback').length).toBe(0)

      // Store hint so the bodiless reaction is still archived in MAM
      const storeEl = sentStanza.children.find((c: any) => c.name === 'store')
      expect(storeEl).toBeDefined()
    })
  })

  describe('sendMessage stanzaId preference for replies', () => {
    it('should prefer stanzaId for groupchat reply reference', async () => {
      await connectClient()

      mockStores.room.getMessage = vi.fn().mockReturnValue({
        type: 'groupchat',
        id: 'client-msg-id',
        stanzaId: 'server-stanza-id',
        body: 'Original message',
        from: 'room@conference.example.com/alice',
      })

      await xmppClient.chat.sendMessage(
        'room@conference.example.com',
        'My reply',
        'groupchat',
        { id: 'client-msg-id', to: 'room@conference.example.com/alice', fallback: { author: 'alice', body: 'Original message' } }
      )

      const sentStanza = mockXmppClientInstance.send.mock.calls[0][0]
      const replyEl = sentStanza.children.find((c: any) => c.name === 'reply')
      expect(replyEl).toBeDefined()
      // Protocol stanza should reference stanzaId
      expect(replyEl.attrs.id).toBe('server-stanza-id')
    })

    it('should fall back to client id for reply when no stanzaId', async () => {
      await connectClient()

      mockStores.room.getMessage = vi.fn().mockReturnValue({
        type: 'groupchat',
        id: 'client-msg-id',
        body: 'Original message',
        from: 'room@conference.example.com/alice',
      })

      await xmppClient.chat.sendMessage(
        'room@conference.example.com',
        'My reply',
        'groupchat',
        { id: 'client-msg-id', to: 'room@conference.example.com/alice' }
      )

      const sentStanza = mockXmppClientInstance.send.mock.calls[0][0]
      const replyEl = sentStanza.children.find((c: any) => c.name === 'reply')
      expect(replyEl).toBeDefined()
      expect(replyEl.attrs.id).toBe('client-msg-id')
    })

    it('should use client id for chat reply (stanzaId not preferred for 1:1)', async () => {
      await connectClient()

      vi.mocked(mockStores.chat.getMessage).mockReturnValue({
        type: 'chat',
        id: 'client-msg-id',
        stanzaId: 'server-stanza-id',
        conversationId: 'alice@example.com',
        from: 'alice@example.com',
        body: 'Original message',
        timestamp: new Date(),
        isOutgoing: false,
      })

      await xmppClient.chat.sendMessage(
        'alice@example.com',
        'My reply',
        'chat',
        { id: 'client-msg-id', to: 'alice@example.com' }
      )

      const sentStanza = mockXmppClientInstance.send.mock.calls[0][0]
      const replyEl = sentStanza.children.find((c: any) => c.name === 'reply')
      expect(replyEl).toBeDefined()
      // For chat type, client message id must be used (not stanzaId) per XEP-0461
      expect(replyEl.attrs.id).toBe('client-msg-id')
    })

    it('should use client id for chat reply even when stanzaId differs significantly', async () => {
      // Regression test for https://github.com/processone/fluux-messenger/issues/212
      // stanza-id is server-assigned (e.g. MAM archive id) and should never be used
      // in <reply> for chat-type messages, as other clients won't recognize it
      await connectClient()

      vi.mocked(mockStores.chat.getMessage).mockReturnValue({
        type: 'chat',
        id: 'a1b2c3d4-uuid-style-id',
        stanzaId: '1766999538188692',  // numeric MAM-style stanza-id
        conversationId: 'bob@example.com',
        from: 'bob@example.com',
        body: 'Check this out',
        timestamp: new Date(),
        isOutgoing: false,
      })

      await xmppClient.chat.sendMessage(
        'bob@example.com',
        'Nice!',
        'chat',
        { id: 'a1b2c3d4-uuid-style-id', to: 'bob@example.com', fallback: { author: 'bob', body: 'Check this out' } }
      )

      const sentStanza = mockXmppClientInstance.send.mock.calls[0][0]
      const replyEl = sentStanza.children.find((c: any) => c.name === 'reply')
      expect(replyEl).toBeDefined()
      expect(replyEl.attrs.id).toBe('a1b2c3d4-uuid-style-id')
      expect(replyEl.attrs.id).not.toBe('1766999538188692')
    })
  })

  describe('reference-id selection per XEP (reply / reaction / correction)', () => {
    it('should use client id for chat reaction reference (not stanzaId)', async () => {
      await connectClient()

      mockStores.chat.getMessage = vi.fn().mockReturnValue({
        type: 'chat',
        id: 'client-msg-id',
        stanzaId: 'server-stanza-id',
        body: 'Hello world',
        from: 'alice@example.com',
      })

      await xmppClient.chat.sendReaction('alice@example.com', 'client-msg-id', ['👍'], 'chat')

      const sentStanza = mockXmppClientInstance.send.mock.calls[0][0]
      const reactionsEl = sentStanza.children.find((c: any) => c.name === 'reactions')
      expect(reactionsEl).toBeDefined()
      // Reactions id attribute must use client id for chat type
      expect(reactionsEl.attrs.id).toBe('client-msg-id')
    })

    it('should prefer stanzaId for groupchat reaction reference', async () => {
      await connectClient()

      mockStores.room.getMessage = vi.fn().mockReturnValue({
        type: 'groupchat',
        id: 'client-msg-id',
        stanzaId: 'server-stanza-id',
        body: 'Hello room',
        from: 'room@conference.example.com/alice',
      })

      await xmppClient.chat.sendReaction('room@conference.example.com', 'client-msg-id', ['👍'], 'groupchat')

      const sentStanza = mockXmppClientInstance.send.mock.calls[0][0]
      const reactionsEl = sentStanza.children.find((c: any) => c.name === 'reactions')
      expect(reactionsEl).toBeDefined()
      expect(reactionsEl.attrs.id).toBe('server-stanza-id')
    })

    it('should use client id for chat correction reference (not stanzaId)', async () => {
      await connectClient()

      vi.mocked(mockStores.chat.getMessage).mockReturnValue({
        type: 'chat',
        id: 'client-msg-id',
        stanzaId: 'server-stanza-id',
        conversationId: 'alice@example.com',
        from: 'me@example.com',
        body: 'Original with typo',
        timestamp: new Date(),
        isOutgoing: true,
      })

      await xmppClient.chat.sendCorrection('alice@example.com', 'client-msg-id', 'Original without typo', 'chat')

      const sentStanza = mockXmppClientInstance.send.mock.calls[0][0]
      const replaceEl = sentStanza.children.find((c: any) => c.name === 'replace')
      expect(replaceEl).toBeDefined()
      // Correction id must use client id for chat type
      expect(replaceEl.attrs.id).toBe('client-msg-id')
    })

    it('should reference origin-id for chat correction when the original has one', async () => {
      await connectClient()

      vi.mocked(mockStores.chat.getMessage).mockReturnValue({
        type: 'chat',
        id: 'client-msg-id',
        originId: 'origin-uuid',
        stanzaId: 'server-stanza-id',
        conversationId: 'alice@example.com',
        from: 'me@example.com',
        body: 'Original with typo',
        timestamp: new Date(),
        isOutgoing: true,
      })

      await xmppClient.chat.sendCorrection('alice@example.com', 'client-msg-id', 'Original without typo', 'chat')

      const sentStanza = mockXmppClientInstance.send.mock.calls[0][0]
      const replaceEl = sentStanza.children.find((c: any) => c.name === 'replace')
      // XEP-0308 references the sender-assigned id: origin-id when present.
      expect(replaceEl.attrs.id).toBe('origin-uuid')
      expect(replaceEl.attrs.id).not.toBe('server-stanza-id')
    })

    it('should reference origin-id (not stanzaId) for groupchat correction per XEP-0308', async () => {
      await connectClient()

      // XEP-0308 has NO group-chat carve-out (unlike XEP-0461 replies /
      // XEP-0444 reactions / XEP-0424 retractions, which all switch to the MUC
      // stanza-id). A correction references the id the original SENDER assigned
      // — the origin-id — never the server/MUC stanza-id.
      mockStores.room.getMessage = vi.fn().mockReturnValue({
        type: 'groupchat',
        id: 'client-msg-id',
        originId: 'origin-uuid',
        stanzaId: 'server-stanza-id',
        body: 'Original with typo',
        from: 'room@conference.example.com/me',
      })

      await xmppClient.chat.sendCorrection('room@conference.example.com', 'client-msg-id', 'Original without typo', 'groupchat')

      const sentStanza = mockXmppClientInstance.send.mock.calls[0][0]
      const replaceEl = sentStanza.children.find((c: any) => c.name === 'replace')
      expect(replaceEl).toBeDefined()
      expect(replaceEl.attrs.id).toBe('origin-uuid')
      expect(replaceEl.attrs.id).not.toBe('server-stanza-id')
    })

    it('should fall back to message id (never stanzaId) for groupchat correction without origin-id', async () => {
      await connectClient()

      // Regression guard for the real log scenario: ejabberd preserves the
      // sender id and the store also holds a numeric stanza-id. The correction
      // must reference the message id — using the stanza-id makes compliant
      // clients (e.g. Conversations) render the edit as a brand-new message.
      mockStores.room.getMessage = vi.fn().mockReturnValue({
        type: 'groupchat',
        id: 'client-msg-id',
        stanzaId: '1780677708963770',
        body: 'Original with typo',
        from: 'room@conference.example.com/me',
      })

      await xmppClient.chat.sendCorrection('room@conference.example.com', 'client-msg-id', 'Original without typo', 'groupchat')

      const sentStanza = mockXmppClientInstance.send.mock.calls[0][0]
      const replaceEl = sentStanza.children.find((c: any) => c.name === 'replace')
      expect(replaceEl.attrs.id).toBe('client-msg-id')
      expect(replaceEl.attrs.id).not.toBe('1780677708963770')
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

      // Body is the corrected text verbatim — no "[Corrected] " prefix
      const bodyEl = sentStanza.children.find((c: any) => c.name === 'body')
      expect(bodyEl).toBeDefined()
      expect(bodyEl.children[0]).toBe('Fixed message')

      // Check replace element
      const replaceEl = sentStanza.children.find((c: any) => c.name === 'replace')
      expect(replaceEl).toBeDefined()
      expect(replaceEl.attrs.xmlns).toBe('urn:xmpp:message-correct:0')
      expect(replaceEl.attrs.id).toBe('original-msg-123')

      // No correction fallback indication is sent — compliant clients replace
      // the original from <replace> alone.
      const fallbackEl = sentStanza.children.find(
        (c: any) => c.name === 'fallback' && c.attrs.for === 'urn:xmpp:message-correct:0'
      )
      expect(fallbackEl).toBeUndefined()
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

      // Body should be: "user text\nURL" — no "[Corrected] " prefix
      const expectedBody = userText + '\n' + url
      expect(bodyEl.children[0]).toBe(expectedBody)

      // OOB fallback should mark ONLY the URL portion (after the user text)
      const expectedStart = userText.length + 1 // +1 for newline
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

    it('should reference origin-id (not stanzaId) for groupchat correction', async () => {
      await connectClient()

      mockStores.room.getRoom = vi.fn().mockReturnValue({ jid: 'room@conference.example.com', nickname: 'me' })
      mockStores.room.getMessage = vi.fn().mockReturnValue({
        type: 'groupchat',
        id: 'client-msg-id',
        originId: 'origin-uuid',
        stanzaId: 'server-stanza-id',
        body: 'Original',
        from: 'room@conference.example.com/me',
      })

      await xmppClient.chat.sendCorrection('room@conference.example.com', 'client-msg-id', 'Fixed', 'groupchat')

      const sentStanza = mockXmppClientInstance.send.mock.calls[0][0]
      const replaceEl = sentStanza.children.find((c: any) => c.name === 'replace')
      // XEP-0308 has no group-chat carve-out: reference the origin-id, not the MUC stanza-id.
      expect(replaceEl.attrs.id).toBe('origin-uuid')
      expect(replaceEl.attrs.id).not.toBe('server-stanza-id')
    })
  })

  describe('incoming corrections for missing original (XEP-0308)', () => {
    it('should use replace target ID when original message is not in store for groupchat', async () => {
      await connectClient()

      mockStores.room.getRoom.mockReturnValue({
        jid: 'room@conference.example.com',
        name: 'room',
        nickname: 'me',
        joined: true,
        isBookmarked: false,
        unreadCount: 0,
        mentionsCount: 0,
        typingUsers: new Set<string>(),
        occupants: new Map(),
        messages: [],
      })
      // Original message not in store
      mockStores.room.getMessage = vi.fn().mockReturnValue(undefined)

      // First correction arrives — original was never received
      const correction1 = createMockElement('message', {
        from: 'room@conference.example.com/Alice',
        to: 'user@example.com',
        type: 'groupchat',
        id: 'correction-stanza-1',
      }, [
        { name: 'body', text: 'Corrected text v1' },
        { name: 'replace', attrs: { xmlns: 'urn:xmpp:message-correct:0', id: 'original-msg-id' } },
        { name: 'occupant-id', attrs: { xmlns: 'urn:xmpp:occupant-id:0', id: 'occupant-123' } },
      ])

      mockXmppClientInstance._emit('stanza', correction1)

      // Should create a new message using the replace target ID, not the correction stanza ID
      expect(emitSDKSpy).toHaveBeenCalledWith('room:message', expect.objectContaining({
        roomJid: 'room@conference.example.com',
        message: expect.objectContaining({
          id: 'original-msg-id',
          body: 'Corrected text v1',
          isEdited: true,
        })
      }))
    })

    it('should deduplicate multiple corrections for same missing original in groupchat', async () => {
      await connectClient()

      mockStores.room.getRoom.mockReturnValue({
        jid: 'room@conference.example.com',
        name: 'room',
        nickname: 'me',
        joined: true,
        isBookmarked: false,
        unreadCount: 0,
        mentionsCount: 0,
        typingUsers: new Set<string>(),
        occupants: new Map(),
        messages: [],
      })

      // First call: original not in store. Second call: message now exists (from first correction)
      let callCount = 0
      mockStores.room.getMessage = vi.fn().mockImplementation(() => {
        callCount++
        if (callCount === 1) return undefined // First correction: original not found
        return { // Second correction: first correction's message is now in store
          type: 'groupchat',
          id: 'original-msg-id',
          body: 'Corrected text v1',
          from: 'room@conference.example.com/Alice',
        }
      })

      // First correction
      const correction1 = createMockElement('message', {
        from: 'room@conference.example.com/Alice',
        to: 'user@example.com',
        type: 'groupchat',
        id: 'correction-stanza-1',
      }, [
        { name: 'body', text: 'Corrected text v1' },
        { name: 'replace', attrs: { xmlns: 'urn:xmpp:message-correct:0', id: 'original-msg-id' } },
        { name: 'occupant-id', attrs: { xmlns: 'urn:xmpp:occupant-id:0', id: 'occupant-123' } },
      ])

      mockXmppClientInstance._emit('stanza', correction1)

      // Second correction for same original
      const correction2 = createMockElement('message', {
        from: 'room@conference.example.com/Alice',
        to: 'user@example.com',
        type: 'groupchat',
        id: 'correction-stanza-2',
      }, [
        { name: 'body', text: 'Corrected text v2' },
        { name: 'replace', attrs: { xmlns: 'urn:xmpp:message-correct:0', id: 'original-msg-id' } },
        { name: 'occupant-id', attrs: { xmlns: 'urn:xmpp:occupant-id:0', id: 'occupant-123' } },
      ])

      mockXmppClientInstance._emit('stanza', correction2)

      // Second correction should update via room:message-updated (not create a new message)
      expect(emitSDKSpy).toHaveBeenCalledWith('room:message-updated', {
        roomJid: 'room@conference.example.com',
        messageId: 'original-msg-id',
        updates: expect.objectContaining({
          body: 'Corrected text v2',
          isEdited: true,
        })
      })
    })

    it('should use replace target ID when original message is not in store for chat', async () => {
      await connectClient()

      // Original message not in store
      mockStores.chat.getMessage = vi.fn().mockReturnValue(undefined)

      const correction = createMockElement('message', {
        from: 'contact@example.com/resource',
        to: 'user@example.com',
        type: 'chat',
        id: 'correction-stanza-1',
      }, [
        { name: 'body', text: 'Corrected text' },
        { name: 'replace', attrs: { xmlns: 'urn:xmpp:message-correct:0', id: 'original-msg-id' } },
      ])

      mockXmppClientInstance._emit('stanza', correction)

      expect(emitSDKSpy).toHaveBeenCalledWith('chat:message', {
        message: expect.objectContaining({
          id: 'original-msg-id',
          body: 'Corrected text',
          isEdited: true,
        })
      })
    })
  })

  describe('MUC author verification via occupant-id (XEP-0421)', () => {
    const roomJid = 'room@conference.example.com'

    function buildCorrection(senderNick: string, occupantId?: string, replaceId = 'original-msg-id') {
      const children: any[] = [
        { name: 'body', text: 'Corrected text' },
        { name: 'replace', attrs: { xmlns: 'urn:xmpp:message-correct:0', id: replaceId } },
      ]
      if (occupantId) children.push({ name: 'occupant-id', attrs: { xmlns: 'urn:xmpp:occupant-id:0', id: occupantId } })
      return createMockElement('message', { from: `${roomJid}/${senderNick}`, to: 'user@example.com', type: 'groupchat', id: 'correction-stanza' }, children)
    }

    function buildRetraction(senderNick: string, occupantId?: string, retractId = 'server-stanza-id-999') {
      const children: any[] = [
        { name: 'retract', attrs: { xmlns: 'urn:xmpp:message-retract:1', id: retractId } },
        { name: 'body', text: 'Fallback' },
      ]
      if (occupantId) children.push({ name: 'occupant-id', attrs: { xmlns: 'urn:xmpp:occupant-id:0', id: occupantId } })
      return createMockElement('message', { from: `${roomJid}/${senderNick}`, to: 'user@example.com', type: 'groupchat', id: 'retraction-stanza' }, children)
    }

    it('should reject a correction when occupant-id differs despite a matching nick (nickname takeover)', async () => {
      await connectClient()
      mockStores.room.getRoom = vi.fn().mockReturnValue({ jid: roomJid, nickname: 'me' })
      mockStores.room.getMessage = vi.fn().mockReturnValue({
        type: 'groupchat', id: 'original-msg-id', from: `${roomJid}/Alice`,
        occupantId: 'alice-occ', body: 'Original', nick: 'Alice',
      })

      // Mallory has taken the nick "Alice" but carries a different occupant-id
      mockXmppClientInstance._emit('stanza', buildCorrection('Alice', 'mallory-occ'))

      expect(emitSDKSpy).not.toHaveBeenCalledWith('room:message-updated', expect.anything())
    })

    it('should apply a correction when the occupant-id matches', async () => {
      await connectClient()
      mockStores.room.getRoom = vi.fn().mockReturnValue({ jid: roomJid, nickname: 'me' })
      mockStores.room.getMessage = vi.fn().mockReturnValue({
        type: 'groupchat', id: 'original-msg-id', from: `${roomJid}/Alice`,
        occupantId: 'alice-occ', body: 'Original', nick: 'Alice',
      })

      mockXmppClientInstance._emit('stanza', buildCorrection('Alice', 'alice-occ'))

      expect(emitSDKSpy).toHaveBeenCalledWith('room:message-updated', expect.objectContaining({
        roomJid, messageId: 'original-msg-id', updates: expect.objectContaining({ isEdited: true }),
      }))
    })

    it('should fall back to the full MUC JID when occupant-id is absent (legacy servers)', async () => {
      await connectClient()
      mockStores.room.getRoom = vi.fn().mockReturnValue({ jid: roomJid, nickname: 'me' })
      mockStores.room.getMessage = vi.fn().mockReturnValue({
        type: 'groupchat', id: 'original-msg-id', from: `${roomJid}/Alice`,
        body: 'Original', nick: 'Alice', // no occupantId stored
      })

      // No occupant-id on the stanza either → full-JID check applies
      mockXmppClientInstance._emit('stanza', buildCorrection('Alice', undefined))

      expect(emitSDKSpy).toHaveBeenCalledWith('room:message-updated', expect.objectContaining({
        roomJid, messageId: 'original-msg-id', updates: expect.objectContaining({ isEdited: true }),
      }))
    })

    it('should reject a retraction when occupant-id differs despite a matching nick (nickname takeover)', async () => {
      await connectClient()
      mockStores.room.getRoom = vi.fn().mockReturnValue({ jid: roomJid, nickname: 'me' })
      mockStores.room.getMessage = vi.fn().mockReturnValue({
        type: 'groupchat', id: 'client-msg-id', stanzaId: 'server-stanza-id-999',
        from: `${roomJid}/Alice`, occupantId: 'alice-occ', body: 'Original', nick: 'Alice',
      })

      mockXmppClientInstance._emit('stanza', buildRetraction('Alice', 'mallory-occ'))

      expect(emitSDKSpy).not.toHaveBeenCalledWith('room:message-updated', expect.anything())
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

    it('should prefer stanzaId for groupchat retraction reference', async () => {
      await connectClient()

      vi.mocked(mockStores.room.getMessage).mockReturnValue({
        type: 'groupchat',
        id: 'client-msg-id',
        stanzaId: 'server-stanza-id',
        roomJid: 'room@conference.example.com',
        from: 'room@conference.example.com/me',
        nick: 'me',
        body: 'Message to retract',
        timestamp: new Date(),
        isOutgoing: true,
      })

      await xmppClient.chat.sendRetraction('room@conference.example.com', 'client-msg-id', 'groupchat')

      const sentStanza = mockXmppClientInstance.send.mock.calls[0][0]
      const retractEl = sentStanza.children.find(
        (c: any) => c.name === 'retract' && c.attrs.xmlns === 'urn:xmpp:message-retract:1'
      )
      expect(retractEl.attrs.id).toBe('server-stanza-id')
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

    it('logs an error event to the XMPP console when an invitation is rejected', async () => {
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
          ],
        },
      ])

      mockXmppClientInstance._emit('stanza', errorStanza)

      // The invitation rejection lands in the exportable console as an error
      // event (the transient toast alone wouldn't survive in a shared log).
      const consoleEvent = emitSDKSpy.mock.calls.find((c: unknown[]) => c[0] === 'console:event')
      expect(consoleEvent?.[1]).toMatchObject({ category: 'error' })
      expect(consoleEvent?.[1].message).toContain('room@conference.example.com')
      expect(consoleEvent?.[1].message).toContain('Forbidden')
    })

    it('should not emit room:invite-error for non-invitation errors', async () => {
      await connectClient()

      // A regular error message without muc#user invite
      const errorStanza = createMockElement('message', {
        from: 'contact@example.com',
        to: 'user@example.com',
        type: 'error',
        id: 'msg-123',
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
      // Should emit chat:message-error instead
      expect(emitSDKSpy).toHaveBeenCalledWith('chat:message-error', {
        conversationId: 'contact@example.com',
        messageId: 'msg-123',
        error: { type: 'cancel', condition: 'service-unavailable', text: undefined },
      })
    })

    it('should emit chat:message-error for delivery failure with server text', async () => {
      await connectClient()

      const errorStanza = createMockElement('message', {
        from: 'contact@example.com',
        to: 'user@example.com',
        type: 'error',
        id: 'msg-456',
      }, [
        { name: 'body', text: 'Hello' },
        {
          name: 'error',
          attrs: { type: 'cancel' },
          children: [
            { name: 'remote-server-not-found', attrs: { xmlns: 'urn:ietf:params:xml:ns:xmpp-stanzas' } },
            { name: 'text', attrs: { xmlns: 'urn:ietf:params:xml:ns:xmpp-stanzas' }, text: 'Server-to-server connection failed' },
          ],
        },
      ])

      mockXmppClientInstance._emit('stanza', errorStanza)

      expect(emitSDKSpy).toHaveBeenCalledWith('chat:message-error', {
        conversationId: 'contact@example.com',
        messageId: 'msg-456',
        error: { type: 'cancel', condition: 'remote-server-not-found', text: 'Server-to-server connection failed' },
      })
    })

    it('should not emit chat:message-error when message has no id', async () => {
      await connectClient()

      const errorStanza = createMockElement('message', {
        from: 'contact@example.com',
        to: 'user@example.com',
        type: 'error',
        // no id attribute
      }, [
        {
          name: 'error',
          attrs: { type: 'wait' },
          children: [
            { name: 'resource-constraint', attrs: { xmlns: 'urn:ietf:params:xml:ns:xmpp-stanzas' } },
          ],
        },
      ])

      mockXmppClientInstance._emit('stanza', errorStanza)

      expect(emitSDKSpy).not.toHaveBeenCalledWith('chat:message-error', expect.anything())
    })

    it('should not emit chat:message-error for MUC invitation errors (room:invite-error takes precedence)', async () => {
      await connectClient()

      const errorStanza = createMockElement('message', {
        from: 'room@conference.example.com',
        to: 'user@example.com',
        type: 'error',
        id: 'invite-msg-1',
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

      expect(emitSDKSpy).toHaveBeenCalledWith('room:invite-error', expect.anything())
      expect(emitSDKSpy).not.toHaveBeenCalledWith('chat:message-error', expect.anything())
    })

    it('should ignore recipient-unavailable errors (resource went offline, message already delivered)', async () => {
      await connectClient()

      const errorStanza = createMockElement('message', {
        from: 'contact@example.com',
        to: 'user@example.com',
        type: 'error',
        id: 'msg-789',
      }, [
        {
          name: 'error',
          attrs: { type: 'cancel' },
          children: [
            { name: 'recipient-unavailable', attrs: { xmlns: 'urn:ietf:params:xml:ns:xmpp-stanzas' } },
          ],
        },
      ])

      mockXmppClientInstance._emit('stanza', errorStanza)

      expect(emitSDKSpy).not.toHaveBeenCalledWith('chat:message-error', expect.anything())
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

  describe('XEP-0359 origin-id', () => {
    it('should include origin-id element in outgoing sendMessage stanza', async () => {
      await connectClient()

      const msgId = await xmppClient.chat.sendMessage('alice@example.com', 'Hello', 'chat')

      const sentStanza = mockXmppClientInstance.send.mock.calls[0][0]
      const originIdEl = sentStanza.children.find(
        (c: any) => c.name === 'origin-id' && c.attrs.xmlns === 'urn:xmpp:sid:0'
      )

      expect(originIdEl).toBeDefined()
      expect(originIdEl.attrs.id).toBe(msgId)
    })

    it('should set originId on local message object for outgoing sendMessage', async () => {
      await connectClient()

      const msgId = await xmppClient.chat.sendMessage('alice@example.com', 'Hello', 'chat')

      expect(emitSDKSpy).toHaveBeenCalledWith('chat:message', {
        message: expect.objectContaining({
          id: msgId,
          originId: msgId,
          body: 'Hello',
          isOutgoing: true,
        })
      })
    })

    it('should include origin-id element in outgoing resendMessage stanza', async () => {
      await connectClient()

      await xmppClient.chat.resendMessage('contact@example.com', 'Hello again', 'original-msg-id')

      const sentStanza = mockXmppClientInstance.send.mock.calls[0][0]
      const originIdEl = sentStanza.children.find(
        (c: any) => c.name === 'origin-id' && c.attrs.xmlns === 'urn:xmpp:sid:0'
      )

      expect(originIdEl).toBeDefined()
      expect(originIdEl.attrs.id).toBe('original-msg-id')
    })

    it('should include origin-id element in outgoing reaction stanza', async () => {
      await connectClient()

      await xmppClient.chat.sendReaction('contact@example.com', 'msg-123', ['👍'])

      const sentStanza = mockXmppClientInstance.send.mock.calls[0][0]
      const originIdEl = sentStanza.children.find(
        (c: any) => c.name === 'origin-id' && c.attrs.xmlns === 'urn:xmpp:sid:0'
      )

      expect(originIdEl).toBeDefined()
      expect(originIdEl.attrs.id).toBe(sentStanza.attrs.id)
    })

    it('should include origin-id element in outgoing correction stanza', async () => {
      await connectClient()

      mockStores.chat.getMessage = vi.fn().mockReturnValue({
        id: 'original-msg-123',
        body: 'Original text',
      })

      await xmppClient.chat.sendCorrection('contact@example.com', 'original-msg-123', 'Fixed text')

      const sentStanza = mockXmppClientInstance.send.mock.calls[0][0]
      const originIdEl = sentStanza.children.find(
        (c: any) => c.name === 'origin-id' && c.attrs.xmlns === 'urn:xmpp:sid:0'
      )

      expect(originIdEl).toBeDefined()
      expect(originIdEl.attrs.id).toBe(sentStanza.attrs.id)
    })

    it('should include origin-id element in outgoing retraction stanza', async () => {
      await connectClient()

      mockStores.chat.getMessage = vi.fn().mockReturnValue({
        id: 'original-msg-123',
        body: 'To be retracted',
      })

      await xmppClient.chat.sendRetraction('contact@example.com', 'original-msg-123')

      const sentStanza = mockXmppClientInstance.send.mock.calls[0][0]
      const originIdEl = sentStanza.children.find(
        (c: any) => c.name === 'origin-id' && c.attrs.xmlns === 'urn:xmpp:sid:0'
      )

      expect(originIdEl).toBeDefined()
      expect(originIdEl.attrs.id).toBe(sentStanza.attrs.id)
    })

    it('should parse origin-id from incoming chat message', async () => {
      await connectClient()

      const messageStanza = createMockElement('message', {
        from: 'contact@example.com/resource',
        to: 'user@example.com',
        type: 'chat',
        id: 'msg-456',
      }, [
        { name: 'body', text: 'Hello!' },
        { name: 'origin-id', attrs: { xmlns: 'urn:xmpp:sid:0', id: 'origin-uuid-789' } },
      ])

      mockXmppClientInstance._emit('stanza', messageStanza)

      expect(emitSDKSpy).toHaveBeenCalledWith('chat:message', {
        message: expect.objectContaining({
          id: 'msg-456',
          originId: 'origin-uuid-789',
          body: 'Hello!',
        })
      })
    })

    it('should not include originId when incoming message has no origin-id element', async () => {
      await connectClient()

      const messageStanza = createMockElement('message', {
        from: 'contact@example.com/resource',
        to: 'user@example.com',
        type: 'chat',
        id: 'msg-no-origin',
      }, [
        { name: 'body', text: 'Hello!' },
      ])

      mockXmppClientInstance._emit('stanza', messageStanza)

      const chatCall = emitSDKSpy.mock.calls.find((call: unknown[]) => call[0] === 'chat:message')
      expect(chatCall).toBeDefined()
      const message = (chatCall![1] as { message: Record<string, unknown> }).message
      expect(message).not.toHaveProperty('originId')
    })

    it('should parse origin-id from incoming room message', async () => {
      await connectClient()
      mockStores.room.getRoom = vi.fn().mockReturnValue({ jid: 'room@conference.example.com', nickname: 'testuser', joined: true })

      const messageStanza = createMockElement('message', {
        from: 'room@conference.example.com/alice',
        to: 'user@example.com',
        type: 'groupchat',
        id: 'room-msg-1',
      }, [
        { name: 'body', text: 'Hi room!' },
        { name: 'origin-id', attrs: { xmlns: 'urn:xmpp:sid:0', id: 'room-origin-abc' } },
      ])

      mockXmppClientInstance._emit('stanza', messageStanza)

      expect(emitSDKSpy).toHaveBeenCalledWith('room:message', expect.objectContaining({
        roomJid: 'room@conference.example.com',
        message: expect.objectContaining({
          id: 'room-msg-1',
          originId: 'room-origin-abc',
          body: 'Hi room!',
        })
      }))
    })
  })

  describe('resendMessage', () => {
    it('should send stanza with same message ID and not emit chat:message event', async () => {
      await connectClient()

      await xmppClient.chat.resendMessage('contact@example.com', 'Hello again', 'original-msg-id')

      // Verify the stanza was sent with the same ID
      expect(mockXmppClientInstance.send).toHaveBeenCalledTimes(1)
      const sentStanza = mockXmppClientInstance.send.mock.calls[0][0]
      expect(sentStanza.attrs.to).toBe('contact@example.com')
      expect(sentStanza.attrs.type).toBe('chat')
      expect(sentStanza.attrs.id).toBe('original-msg-id')

      // Should NOT emit chat:message (message already in store)
      expect(emitSDKSpy).not.toHaveBeenCalledWith('chat:message', expect.anything())
    })

    it('should include OOB attachment in resent message', async () => {
      await connectClient()

      const attachment = {
        url: 'https://upload.example.com/file.pdf',
        name: 'document.pdf',
        size: 12345,
        mimeType: 'application/pdf',
      }

      await xmppClient.chat.resendMessage('contact@example.com', 'Check this', 'msg-with-file', attachment)

      const sentStanza = mockXmppClientInstance.send.mock.calls[0][0]
      expect(sentStanza.attrs.id).toBe('msg-with-file')

      // Verify OOB element is present — check for x child with OOB namespace
      const oobChild = sentStanza.children?.find(
        (c: any) => c.name === 'x' && c.attrs?.xmlns === 'jabber:x:oob'
      )
      expect(oobChild).toBeDefined()

      // Verify fallback element
      const fallbackChild = sentStanza.children?.find(
        (c: any) => c.name === 'fallback' && c.attrs?.xmlns === 'urn:xmpp:fallback:0'
      )
      expect(fallbackChild).toBeDefined()
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

  describe('incoming retraction (XEP-0424)', () => {
    it('should retract a MUC message referenced by stanza-id', async () => {
      await connectClient()

      // Mock that the original message exists in the room store
      vi.mocked(mockStores.room.getMessage).mockReturnValue({
        type: 'groupchat',
        id: 'client-msg-id',
        stanzaId: 'server-stanza-id-999',
        roomJid: 'room@conference.example.com',
        from: 'room@conference.example.com/edaveine',
        nick: 'edaveine',
        body: 'Message to retract',
        timestamp: new Date(),
        isOutgoing: false,
      })

      // Simulate incoming retraction from the same user, referencing stanza-id
      const retractionStanza = createMockElement('message', {
        from: 'room@conference.example.com/edaveine',
        type: 'groupchat',
        id: 'retraction-msg-id',
      }, [
        {
          name: 'retract',
          attrs: { xmlns: 'urn:xmpp:message-retract:1', id: 'server-stanza-id-999' },
        },
        { name: 'fallback', attrs: { xmlns: 'urn:xmpp:fallback:0', for: 'urn:xmpp:message-retract:1' } },
        { name: 'body', text: 'This person attempted to retract a previous message, but it\'s unsupported by your client.' },
      ])

      mockXmppClientInstance._emit('stanza', retractionStanza)

      expect(emitSDKSpy).toHaveBeenCalledWith('room:message-updated', {
        roomJid: 'room@conference.example.com',
        messageId: 'server-stanza-id-999',
        updates: {
          isRetracted: true,
          retractedAt: expect.any(Date),
        },
      })
    })

    it('should not retract if sender does not match original message', async () => {
      await connectClient()

      vi.mocked(mockStores.room.getMessage).mockReturnValue({
        type: 'groupchat',
        id: 'client-msg-id',
        stanzaId: 'server-stanza-id-999',
        roomJid: 'room@conference.example.com',
        from: 'room@conference.example.com/alice',
        nick: 'alice',
        body: 'Original message',
        timestamp: new Date(),
        isOutgoing: false,
      })

      // Different user tries to retract alice's message
      const retractionStanza = createMockElement('message', {
        from: 'room@conference.example.com/mallory',
        type: 'groupchat',
      }, [
        {
          name: 'retract',
          attrs: { xmlns: 'urn:xmpp:message-retract:1', id: 'server-stanza-id-999' },
        },
        { name: 'body', text: 'Fallback' },
      ])

      mockXmppClientInstance._emit('stanza', retractionStanza)

      expect(emitSDKSpy).not.toHaveBeenCalledWith('room:message-updated', expect.anything())
    })
  })

  describe('incoming message moderation (XEP-0425)', () => {
    it('should handle moderation broadcast with legacy format (moderated as direct child)', async () => {
      await connectClient()

      // Legacy format: <moderated> as direct child of <message> with id attribute
      const moderationStanza = createMockElement('message', {
        from: 'room@conference.example.com',
        type: 'groupchat',
      }, [
        {
          name: 'moderated',
          attrs: {
            xmlns: 'urn:xmpp:message-moderate:1',
            id: 'retracted-stanza-id',
            by: 'room@conference.example.com/admin',
          },
          children: [
            { name: 'retract', attrs: { xmlns: 'urn:xmpp:message-retract:1' } },
            { name: 'reason', text: 'Spam' },
          ],
        },
      ])

      mockXmppClientInstance._emit('stanza', moderationStanza)

      expect(emitSDKSpy).toHaveBeenCalledWith('room:message-updated', {
        roomJid: 'room@conference.example.com',
        messageId: 'retracted-stanza-id',
        updates: {
          isRetracted: true,
          retractedAt: expect.any(Date),
          isModerated: true,
          moderatedBy: 'admin',
          moderationReason: 'Spam',
        },
      })
    })

    it('should handle moderation v1 format (moderated inside retract)', async () => {
      await connectClient()

      // v1 format: <retract id="..."><moderated by="..." xmlns="...:1"/></retract>
      const moderationStanza = createMockElement('message', {
        from: 'room@conference.example.com',
        type: 'groupchat',
      }, [
        {
          name: 'retract',
          attrs: { xmlns: 'urn:xmpp:message-retract:1', id: 'retracted-stanza-id' },
          children: [
            {
              name: 'moderated',
              attrs: {
                xmlns: 'urn:xmpp:message-moderate:1',
                by: 'room@conference.example.com/moderator',
              },
            },
          ],
        },
      ])

      mockXmppClientInstance._emit('stanza', moderationStanza)

      expect(emitSDKSpy).toHaveBeenCalledWith('room:message-updated', {
        roomJid: 'room@conference.example.com',
        messageId: 'retracted-stanza-id',
        updates: {
          isRetracted: true,
          retractedAt: expect.any(Date),
          isModerated: true,
          moderatedBy: 'moderator',
          moderationReason: undefined,
        },
      })
    })

    it('should handle moderation v0 format (moderated inside apply-to)', async () => {
      await connectClient()

      // v0 format: <apply-to id="..."><moderated by="..." xmlns="...:0"/></apply-to>
      const moderationStanza = createMockElement('message', {
        from: 'room@conference.example.com',
        type: 'groupchat',
      }, [
        {
          name: 'apply-to',
          attrs: { xmlns: 'urn:xmpp:fasten:0', id: 'retracted-stanza-id' },
          children: [
            {
              name: 'moderated',
              attrs: {
                xmlns: 'urn:xmpp:message-moderate:0',
                by: 'room@conference.example.com/admin',
              },
              children: [
                { name: 'retract', attrs: { xmlns: 'urn:xmpp:message-retract:0' } },
              ],
            },
          ],
        },
      ])

      mockXmppClientInstance._emit('stanza', moderationStanza)

      expect(emitSDKSpy).toHaveBeenCalledWith('room:message-updated', {
        roomJid: 'room@conference.example.com',
        messageId: 'retracted-stanza-id',
        updates: {
          isRetracted: true,
          retractedAt: expect.any(Date),
          isModerated: true,
          moderatedBy: 'admin',
          moderationReason: undefined,
        },
      })
    })

    it('should handle ejabberd combined v0+v1 moderation format', async () => {
      await connectClient()

      // ejabberd sends both v0 (apply-to) and v1 (retract) in the same stanza
      const moderationStanza = createMockElement('message', {
        from: 'room@conference.example.com',
        type: 'groupchat',
      }, [
        {
          name: 'apply-to',
          attrs: { xmlns: 'urn:xmpp:fasten:0', id: 'retracted-stanza-id' },
          children: [
            {
              name: 'moderated',
              attrs: {
                xmlns: 'urn:xmpp:message-moderate:0',
                by: 'room@conference.example.com/mickael',
              },
              children: [
                { name: 'retract', attrs: { xmlns: 'urn:xmpp:message-retract:0' } },
              ],
            },
          ],
        },
        {
          name: 'retract',
          attrs: { xmlns: 'urn:xmpp:message-retract:1', id: 'retracted-stanza-id' },
          children: [
            {
              name: 'moderated',
              attrs: {
                xmlns: 'urn:xmpp:message-moderate:1',
                by: 'room@conference.example.com/mickael',
              },
            },
          ],
        },
      ])

      mockXmppClientInstance._emit('stanza', moderationStanza)

      expect(emitSDKSpy).toHaveBeenCalledWith('room:message-updated', {
        roomJid: 'room@conference.example.com',
        messageId: 'retracted-stanza-id',
        updates: {
          isRetracted: true,
          retractedAt: expect.any(Date),
          isModerated: true,
          moderatedBy: 'mickael',
          moderationReason: undefined,
        },
      })
    })

    it('should handle moderation broadcast without reason', async () => {
      await connectClient()

      const moderationStanza = createMockElement('message', {
        from: 'room@conference.example.com',
        type: 'groupchat',
      }, [
        {
          name: 'moderated',
          attrs: {
            xmlns: 'urn:xmpp:message-moderate:1',
            id: 'retracted-stanza-id',
            by: 'room@conference.example.com/moderator',
          },
          children: [
            { name: 'retract', attrs: { xmlns: 'urn:xmpp:message-retract:1' } },
          ],
        },
      ])

      mockXmppClientInstance._emit('stanza', moderationStanza)

      expect(emitSDKSpy).toHaveBeenCalledWith('room:message-updated', {
        roomJid: 'room@conference.example.com',
        messageId: 'retracted-stanza-id',
        updates: {
          isRetracted: true,
          retractedAt: expect.any(Date),
          isModerated: true,
          moderatedBy: 'moderator',
          moderationReason: undefined,
        },
      })
    })

    it('should ignore moderation for non-groupchat messages', async () => {
      await connectClient()

      const moderationStanza = createMockElement('message', {
        from: 'user@example.com',
        type: 'chat',
      }, [
        {
          name: 'moderated',
          attrs: {
            xmlns: 'urn:xmpp:message-moderate:1',
            id: 'some-id',
            by: 'user@example.com/resource',
          },
          children: [
            { name: 'retract', attrs: { xmlns: 'urn:xmpp:message-retract:1' } },
          ],
        },
      ])

      mockXmppClientInstance._emit('stanza', moderationStanza)

      expect(emitSDKSpy).not.toHaveBeenCalledWith('room:message-updated', expect.anything())
    })
  })

  describe('deferred poll-closed verification', () => {
    const roomJid = 'room@conference.example.com'
    const pollMsgId = 'poll-msg-1'

      function buildPollClosedStanza(
        senderNick: string,
        senderOccupantId?: string,
      ) {
        const children: any[] = [
          { name: 'body', text: 'Poll closed: Lunch?' },
          {
            name: 'poll-closed',
            attrs: { xmlns: 'urn:fluux:poll:0', 'message-id': pollMsgId },
            children: [
              { name: 'title', text: 'Lunch?' },
              { name: 'tally', attrs: { emoji: '1️⃣', label: 'Pizza', count: '3', voters: 'alice,bob,carol' } },
              { name: 'tally', attrs: { emoji: '2️⃣', label: 'Sushi', count: '1', voters: 'dave' } },
            ],
          },
        ]
        if (senderOccupantId) {
          children.push({ name: 'occupant-id', attrs: { xmlns: 'urn:xmpp:occupant-id:0', id: senderOccupantId } })
        }
        return createMockElement('message', {
          from: `${roomJid}/${senderNick}`,
          to: 'user@example.com',
          type: 'groupchat',
          id: 'close-msg-1',
        }, children)
      }

      it('should accept poll-closed on trust when original not in store, then verify via MAM', async () => {
        await connectClient()
        mockStores.room.getRoom = vi.fn().mockReturnValue({ jid: roomJid, nickname: 'me' })
        mockStores.room.getMessage = vi.fn().mockReturnValue(undefined)

        // MAM returns original poll confirming the creator
        const fetchSpy = vi.spyOn(xmppClient.mam, 'fetchRoomMessageById').mockResolvedValue({
          id: pollMsgId,
          nick: 'Creator',
          occupantId: 'occ-1',
          poll: {
            title: 'Lunch?',
            options: [{ emoji: '1️⃣', label: 'Pizza' }, { emoji: '2️⃣', label: 'Sushi' }],
            settings: { allowMultiple: false, hideResultsBeforeVote: false },
          },
        } as any)

        const stanza = buildPollClosedStanza('Creator', 'occ-1')
        mockXmppClientInstance._emit('stanza', stanza)

        // Should emit room:message with pollClosed (trust-based acceptance)
        const roomMsgCall = emitSDKSpy.mock.calls.find(
          (c: unknown[]) => c[0] === 'room:message'
        )
        expect(roomMsgCall).toBeDefined()
        const message = (roomMsgCall![1] as { message: { pollClosed?: unknown } }).message
        expect(message.pollClosed).toBeDefined()

        // Wait for deferred verification
        await vi.advanceTimersByTimeAsync(10)
        await Promise.resolve()
        await Promise.resolve()

        expect(fetchSpy).toHaveBeenCalledWith(roomJid, pollMsgId)

        // Verification passed — should emit pollClosedAt on the original poll
        const closedAtCall = emitSDKSpy.mock.calls.find(
          (c: unknown[]) => c[0] === 'room:message-updated'
            && (c[1] as { messageId: string }).messageId === pollMsgId
            && (c[1] as { updates: { pollClosedAt?: unknown } }).updates.pollClosedAt
        )
        expect(closedAtCall).toBeDefined()
      })

      it('should remove pollClosed when deferred verification fails (wrong creator)', async () => {
        await connectClient()
        mockStores.room.getRoom = vi.fn().mockReturnValue({ jid: roomJid, nickname: 'me' })
        mockStores.room.getMessage = vi.fn().mockReturnValue(undefined)

        // MAM returns original poll with a different creator
        vi.spyOn(xmppClient.mam, 'fetchRoomMessageById').mockResolvedValue({
          id: pollMsgId,
          nick: 'RealCreator',
          occupantId: 'occ-real',
          poll: {
            title: 'Lunch?',
            options: [{ emoji: '1️⃣', label: 'Pizza' }, { emoji: '2️⃣', label: 'Sushi' }],
            settings: { allowMultiple: false, hideResultsBeforeVote: false },
          },
        } as any)

        // Sent by 'Impostor' (occ-fake) — different from real creator
        const stanza = buildPollClosedStanza('Impostor', 'occ-fake')
        mockXmppClientInstance._emit('stanza', stanza)

        await vi.advanceTimersByTimeAsync(10)
        await Promise.resolve()
        await Promise.resolve()

        // Should emit removal of pollClosed
        const removeCall = emitSDKSpy.mock.calls.find(
          (c: unknown[]) => c[0] === 'room:message-updated'
            && (c[1] as { messageId: string }).messageId === 'close-msg-1'
            && (c[1] as { updates: { pollClosed?: unknown } }).updates.pollClosed === undefined
        )
        expect(removeCall).toBeDefined()
      })

      it('should keep trust-based poll-closed when MAM fetch fails', async () => {
        await connectClient()
        mockStores.room.getRoom = vi.fn().mockReturnValue({ jid: roomJid, nickname: 'me' })
        mockStores.room.getMessage = vi.fn().mockReturnValue(undefined)

        vi.spyOn(xmppClient.mam, 'fetchRoomMessageById').mockRejectedValue(new Error('timeout'))

        const stanza = buildPollClosedStanza('Creator', 'occ-1')
        mockXmppClientInstance._emit('stanza', stanza)

        await vi.advanceTimersByTimeAsync(10)
        await Promise.resolve()
        await Promise.resolve()

        // No removal update — trust-based acceptance stands
        const removeCall = emitSDKSpy.mock.calls.find(
          (c: unknown[]) => c[0] === 'room:message-updated'
            && (c[1] as { messageId: string }).messageId === 'close-msg-1'
            && (c[1] as { updates: { pollClosed?: unknown } }).updates.pollClosed === undefined
        )
        expect(removeCall).toBeUndefined()
      })
  })

  describe('poll-closed reaction reconciliation', () => {
    const roomJid = 'room@conference.example.com'
    const pollMsgId = 'poll-msg-1'

    function setupRoomWithPoll(opts: {
      reactions?: Record<string, string[]>
      creatorNick?: string
      occupantId?: string
    } = {}) {
      const { reactions, creatorNick = 'Creator', occupantId = 'occ-1' } = opts
      mockStores.room.getRoom = vi.fn().mockReturnValue({
        jid: roomJid,
        nickname: 'me',
      })
      mockStores.room.getMessage = vi.fn().mockReturnValue({
        type: 'groupchat',
        id: pollMsgId,
        from: `${roomJid}/${creatorNick}`,
        nick: creatorNick,
        occupantId,
        poll: {
          title: 'Lunch?',
          options: [
            { emoji: '1️⃣', label: 'Pizza' },
            { emoji: '2️⃣', label: 'Sushi' },
          ],
          settings: { allowMultiple: false, hideResultsBeforeVote: false },
        },
        reactions,
      })
    }

    function buildPollClosedWithVoters(
        senderNick: string,
        voters?: { voters1?: string; voters2?: string },
      ) {
        const tally1Attrs: Record<string, string> = { emoji: '1️⃣', label: 'Pizza', count: '3' }
        if (voters?.voters1) tally1Attrs.voters = voters.voters1
        const tally2Attrs: Record<string, string> = { emoji: '2️⃣', label: 'Sushi', count: '1' }
        if (voters?.voters2) tally2Attrs.voters = voters.voters2

        return createMockElement('message', {
          from: `${roomJid}/${senderNick}`,
          to: 'user@example.com',
          type: 'groupchat',
          id: 'close-msg-2',
        }, [
          { name: 'body', text: 'Poll closed: Lunch?' },
          {
            name: 'poll-closed',
            attrs: { xmlns: 'urn:fluux:poll:0', 'message-id': pollMsgId },
            children: [
              { name: 'title', text: 'Lunch?' },
              { name: 'tally', attrs: tally1Attrs },
              { name: 'tally', attrs: tally2Attrs },
            ],
          },
        ])
      }

      it('should update original poll reactions when poll-closed has voter lists', async () => {
        await connectClient()
        setupRoomWithPoll({ reactions: { '1️⃣': ['alice'] }, creatorNick: 'Creator', occupantId: undefined as any })

        const stanza = buildPollClosedWithVoters('Creator', { voters1: 'alice,bob,carol', voters2: 'dave' })
        mockXmppClientInstance._emit('stanza', stanza)

        // Should emit room:message-updated with pollClosedAt AND reactions from closed results
        const updateCall = emitSDKSpy.mock.calls.find(
          (c: unknown[]) => c[0] === 'room:message-updated'
            && (c[1] as { messageId: string }).messageId === pollMsgId
            && (c[1] as { updates: { pollClosedAt?: unknown } }).updates.pollClosedAt
        )
        expect(updateCall).toBeDefined()
        const updates = (updateCall![1] as { updates: { reactions?: Record<string, string[]>; pollClosedAt?: unknown } }).updates
        expect(updates.pollClosedAt).toBeDefined()
        // Reactions should be set from the closed results
        if (updates.reactions) {
          expect(updates.reactions['1️⃣']).toEqual(['alice', 'bob', 'carol'])
          expect(updates.reactions['2️⃣']).toEqual(['dave'])
        }
      })

      it('should only set pollClosedAt when poll-closed has no voter lists', async () => {
        await connectClient()
        setupRoomWithPoll({ reactions: { '1️⃣': ['alice'] }, creatorNick: 'Creator', occupantId: undefined as any })

        // No voters in tallies
        const stanza = buildPollClosedWithVoters('Creator')
        mockXmppClientInstance._emit('stanza', stanza)

        const updateCall = emitSDKSpy.mock.calls.find(
          (c: unknown[]) => c[0] === 'room:message-updated'
            && (c[1] as { messageId: string }).messageId === pollMsgId
            && (c[1] as { updates: { pollClosedAt?: unknown } }).updates.pollClosedAt
        )
        expect(updateCall).toBeDefined()
        const updates = (updateCall![1] as { updates: { reactions?: unknown; pollClosedAt?: unknown } }).updates
        expect(updates.pollClosedAt).toBeDefined()
        // No reactions update since no voter data
        expect(updates.reactions).toBeUndefined()
      })
  })
})

// ---------------------------------------------------------------------------
// Downgrade-protection tests for applyE2EEToOutboundChat
//
// These tests verify that a peer the user has verified out-of-band never
// silently receives plaintext — regardless of the global send policy —
// when the E2EE encryption step fails or finds no matching plugin.
//
// Strategy: after connectClient(), replace xmppClient.e2ee with a minimal
// duck-typed mock so we can control encryptOutbound / getSendPolicy /
// isPeerVerified without the full Tauri Rust back-end.
// ---------------------------------------------------------------------------
describe('XMPPClient Message — E2EE downgrade protection', () => {
  let xmppClient: XMPPClient
  let mockStores: MockStoreBindings

  beforeEach(() => {
    vi.useFakeTimers()
    mockXmppClientInstance = createMockXmppClient()
    vi.mocked(xmppClientFactory).mockReturnValue(mockXmppClientInstance as any)
    mockStores = createMockStores()
    xmppClient = new XMPPClient({ debug: false })
    xmppClient.bindStores(mockStores)
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.clearAllMocks()
  })

  async function connectClient() {
    const p = xmppClient.connect({
      jid: 'user@example.com',
      password: 'secret',
      server: 'example.com',
      skipDiscovery: true,
    })
    mockXmppClientInstance._emit('online')
    await p
    vi.clearAllMocks()
  }

  function makeE2EEManager(opts: {
    policy?: 'opportunistic' | 'strict'
    encryptResult?: object | null | 'throw'
    isVerified?: boolean
  }) {
    const policy = opts.policy ?? 'opportunistic'
    const isVerified = opts.isVerified ?? false
    return {
      getSendPolicy: vi.fn().mockReturnValue(policy),
      encryptOutbound: vi.fn().mockImplementation(async () => {
        if (opts.encryptResult === 'throw') throw new Error('plugin boom')
        return opts.encryptResult ?? null
      }),
      isPeerVerified: vi.fn().mockResolvedValue(isVerified),
      isForcedPlaintext: vi.fn().mockReturnValue(false),
      assertPlaintextPermitted: vi.fn().mockImplementation(async (target: { kind: string; peer: string }) => {
        if (policy === 'strict') throw new E2EEEncryptionRequiredError(target as any)
        if (isVerified) throw new E2EEEncryptionRequiredError(target as any)
      }),
    }
  }

  it('sends plaintext when policy is opportunistic, peer is unverified, and no plugin matches', async () => {
    await connectClient()
    xmppClient.e2ee = makeE2EEManager({ isVerified: false }) as any

    // Should not throw — opportunistic + unverified = silent plaintext fallback.
    await expect(
      xmppClient.chat.sendMessage('bob@example.com', 'hello', 'chat'),
    ).resolves.not.toThrow()
  })

  it('throws E2EEEncryptionRequiredError when policy is opportunistic but peer is verified and no plugin matches', async () => {
    await connectClient()
    xmppClient.e2ee = makeE2EEManager({ isVerified: true }) as any

    await expect(
      xmppClient.chat.sendMessage('bob@example.com', 'hello', 'chat'),
    ).rejects.toThrow(E2EEEncryptionRequiredError)
  })

  it('throws E2EEEncryptionRequiredError in strict mode regardless of verification status', async () => {
    await connectClient()
    xmppClient.e2ee = makeE2EEManager({ policy: 'strict', isVerified: false }) as any

    await expect(
      xmppClient.chat.sendMessage('bob@example.com', 'hello', 'chat'),
    ).rejects.toThrow(E2EEEncryptionRequiredError)
  })

  it('blocks the send (re-throws the plugin error) when encrypt() throws mid-flight for a verified peer', async () => {
    await connectClient()
    xmppClient.e2ee = makeE2EEManager({ encryptResult: 'throw', isVerified: true }) as any

    // A selected plugin failing to encrypt must never fall back to plaintext;
    // the original plugin error propagates so the UI can surface it.
    await expect(
      xmppClient.chat.sendMessage('bob@example.com', 'hello', 'chat'),
    ).rejects.toThrow('plugin boom')
  })

  it('blocks the send (re-throws the plugin error) when encrypt() throws for an unverified peer in opportunistic mode', async () => {
    await connectClient()
    xmppClient.e2ee = makeE2EEManager({ encryptResult: 'throw', isVerified: false }) as any

    // Core downgrade-protection fix: even opportunistic + unverified must NOT
    // silently send plaintext when a selected plugin fails to encrypt.
    await expect(
      xmppClient.chat.sendMessage('bob@example.com', 'hello', 'chat'),
    ).rejects.toThrow('plugin boom')
  })

  it('allows plaintext for a verified peer when forcedPlaintext is set', async () => {
    await connectClient()
    // isVerified=true would normally block — but isForcedPlaintext overrides.
    const mgr = makeE2EEManager({ isVerified: true })
    mgr.isForcedPlaintext = vi.fn().mockReturnValue(true)
    mgr.assertPlaintextPermitted = vi.fn().mockResolvedValue(undefined)
    xmppClient.e2ee = mgr as any

    await expect(
      xmppClient.chat.sendMessage('bob@example.com', 'hello', 'chat'),
    ).resolves.not.toThrow()
  })

  it('allows plaintext in strict mode when forcedPlaintext is set', async () => {
    await connectClient()
    const mgr = makeE2EEManager({ policy: 'strict', isVerified: false })
    mgr.isForcedPlaintext = vi.fn().mockReturnValue(true)
    mgr.assertPlaintextPermitted = vi.fn().mockResolvedValue(undefined)
    xmppClient.e2ee = mgr as any

    await expect(
      xmppClient.chat.sendMessage('bob@example.com', 'hello', 'chat'),
    ).resolves.not.toThrow()
  })
})
