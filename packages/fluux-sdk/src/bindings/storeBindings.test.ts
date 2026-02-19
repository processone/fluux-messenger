import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createStoreBindings, StoreRefs } from './storeBindings'
import { XMPPClient } from '../core/XMPPClient'
import {
  createMockClientWithSDKEvents,
  createMockStoreRefs,
  type MockSDKClient,
  type MockStoreRefs,
} from '../core/test-utils'
import type { Message, RoomMessage, RoomOccupant, Contact, Room, AdminCommand, AdminSession, SystemNotificationType } from '../core/types'

describe('createStoreBindings', () => {
  let mockClient: MockSDKClient
  let mockStores: MockStoreRefs
  let unsubscribe: () => void

  beforeEach(() => {
    mockClient = createMockClientWithSDKEvents()
    mockStores = createMockStoreRefs()
    unsubscribe = createStoreBindings(
      mockClient as unknown as XMPPClient,
      () => mockStores as unknown as StoreRefs
    )
  })

  describe('connection events', () => {
    // Note: connection:status and connection:authenticated store updates are
    // handled directly by Connection.ts to avoid duplicate store mutations.
    // The SDK events are still emitted for external consumers, but storeBindings
    // no longer updates the store for these events.

    it('should NOT update store for connection:status (handled directly by Connection.ts)', () => {
      mockClient.emit('connection:status', { status: 'online' })
      expect(mockStores.connection.setStatus).not.toHaveBeenCalled()
    })

    it('should NOT update store for connection:authenticated (handled directly by Connection.ts)', () => {
      mockClient.emit('connection:authenticated', { jid: 'user@example.com' })
      expect(mockStores.connection.setJid).not.toHaveBeenCalled()
    })

    it('should handle connection:server-info', () => {
      const info = { domain: 'example.com', features: ['feature1'], identities: [] }
      mockClient.emit('connection:server-info', { info })
      expect(mockStores.connection.setServerInfo).toHaveBeenCalledWith(info)
    })

    it('should handle connection:http-upload-service', () => {
      const service = { jid: 'upload.example.com', maxFileSize: 10000000 }
      mockClient.emit('connection:http-upload-service', { service })
      expect(mockStores.connection.setHttpUploadService).toHaveBeenCalledWith(service)
    })

    it('should handle connection:own-avatar', () => {
      mockClient.emit('connection:own-avatar', { avatar: 'data:image/png...', hash: 'abc123' })
      expect(mockStores.connection.setOwnAvatar).toHaveBeenCalledWith('data:image/png...', 'abc123')
    })

    it('should handle connection:own-nickname', () => {
      mockClient.emit('connection:own-nickname', { nickname: 'Alice' })
      expect(mockStores.connection.setOwnNickname).toHaveBeenCalledWith('Alice')
    })

    it('should handle connection:own-resource', () => {
      mockClient.emit('connection:own-resource', {
        resource: 'mobile',
        show: 'away',
        priority: 5,
        status: 'BRB',
        lastInteraction: new Date(1234567890),
        client: 'MobileApp',
      })
      expect(mockStores.connection.updateOwnResource).toHaveBeenCalledWith(
        'mobile', 'away', 5, 'BRB', new Date(1234567890), 'MobileApp'
      )
    })

    it('should handle connection:own-resource-offline', () => {
      mockClient.emit('connection:own-resource-offline', { resource: 'tablet' })
      expect(mockStores.connection.removeOwnResource).toHaveBeenCalledWith('tablet')
    })
  })

  describe('chat events', () => {
    it('should handle chat:message', () => {
      const message: Message = {
        id: 'msg1',
        from: 'bob@example.com',
        body: 'Hello',
        timestamp: new Date(),
        type: 'chat',
        conversationId: 'bob@example.com',
        isOutgoing: false,
      }
      mockClient.emit('chat:message', { message })
      expect(mockStores.chat.addMessage).toHaveBeenCalledWith(message)
    })

    it('should handle chat:conversation', () => {
      const conversation = { id: 'bob@example.com', name: 'Bob', type: 'chat' as const, unreadCount: 0 }
      mockClient.emit('chat:conversation', { conversation })
      expect(mockStores.chat.addConversation).toHaveBeenCalledWith(conversation)
    })

    it('should handle chat:conversation-name', () => {
      mockClient.emit('chat:conversation-name', { conversationId: 'bob@example.com', name: 'Bob' })
      expect(mockStores.chat.updateConversationName).toHaveBeenCalledWith('bob@example.com', 'Bob')
    })

    it('should handle chat:typing', () => {
      mockClient.emit('chat:typing', { conversationId: 'bob@example.com', jid: 'bob@example.com', isTyping: true })
      expect(mockStores.chat.setTyping).toHaveBeenCalledWith('bob@example.com', 'bob@example.com', true)
    })

    it('should handle chat:reactions', () => {
      mockClient.emit('chat:reactions', {
        conversationId: 'bob@example.com',
        messageId: 'msg1',
        reactorJid: 'bob@example.com',
        emojis: ['thumbsup'],
      })
      expect(mockStores.chat.updateReactions).toHaveBeenCalledWith(
        'bob@example.com', 'msg1', 'bob@example.com', ['thumbsup']
      )
    })

    it('should handle chat:message-updated', () => {
      mockClient.emit('chat:message-updated', {
        conversationId: 'bob@example.com',
        messageId: 'msg1',
        updates: { body: 'Edited message' },
      })
      expect(mockStores.chat.updateMessage).toHaveBeenCalledWith(
        'bob@example.com', 'msg1', { body: 'Edited message' }
      )
    })

    it('should handle chat:animation', () => {
      mockClient.emit('chat:animation', { conversationId: 'bob@example.com', animation: 'shake' })
      expect(mockStores.chat.triggerAnimation).toHaveBeenCalledWith('bob@example.com', 'shake')
    })
  })

  describe('room events', () => {
    it('should handle room:added', () => {
      const room: Room = {
        jid: 'room@conference.example.com',
        name: 'Test Room',
        nickname: 'Me',
        joined: false,
        isBookmarked: false,
        unreadCount: 0,
        mentionsCount: 0,
        typingUsers: new Set(),
        occupants: new Map(),
        messages: [],
      }
      mockClient.emit('room:added', { room })
      expect(mockStores.room.addRoom).toHaveBeenCalledWith(room)
    })

    it('should handle room:updated', () => {
      mockClient.emit('room:updated', { roomJid: 'room@conference.example.com', updates: { subject: 'New subject' } })
      expect(mockStores.room.updateRoom).toHaveBeenCalledWith('room@conference.example.com', { subject: 'New subject' })
    })

    it('should handle room:removed', () => {
      mockClient.emit('room:removed', { roomJid: 'room@conference.example.com' })
      expect(mockStores.room.removeRoom).toHaveBeenCalledWith('room@conference.example.com')
    })

    it('should handle room:joined', () => {
      mockClient.emit('room:joined', { roomJid: 'room@conference.example.com', joined: true })
      expect(mockStores.room.setRoomJoined).toHaveBeenCalledWith('room@conference.example.com', true)
    })

    it('should handle room:occupant-joined', () => {
      const occupant: RoomOccupant = { nick: 'Alice', affiliation: 'member', role: 'participant' }
      mockClient.emit('room:occupant-joined', { roomJid: 'room@conference.example.com', occupant })
      expect(mockStores.room.addOccupant).toHaveBeenCalledWith('room@conference.example.com', occupant)
    })

    it('should handle room:occupants-batch', () => {
      const occupants: RoomOccupant[] = [
        { nick: 'Alice', affiliation: 'member', role: 'participant' },
        { nick: 'Bob', affiliation: 'member', role: 'participant' },
      ]
      mockClient.emit('room:occupants-batch', { roomJid: 'room@conference.example.com', occupants })
      expect(mockStores.room.batchAddOccupants).toHaveBeenCalledWith('room@conference.example.com', occupants)
    })

    it('should handle room:occupant-left', () => {
      mockClient.emit('room:occupant-left', { roomJid: 'room@conference.example.com', nick: 'Alice' })
      expect(mockStores.room.removeOccupant).toHaveBeenCalledWith('room@conference.example.com', 'Alice')
    })

    it('should handle room:self-occupant', () => {
      const occupant: RoomOccupant = { nick: 'Me', affiliation: 'owner', role: 'moderator' }
      mockClient.emit('room:self-occupant', { roomJid: 'room@conference.example.com', occupant })
      expect(mockStores.room.setSelfOccupant).toHaveBeenCalledWith('room@conference.example.com', occupant)
    })

    it('should handle room:message with options', () => {
      const message: RoomMessage = {
        id: 'msg1',
        from: 'Alice',
        body: 'Hello room',
        timestamp: new Date(),
        type: 'groupchat',
        roomJid: 'room@conference.example.com',
        nick: 'Alice',
        isOutgoing: false,
      }
      mockClient.emit('room:message', {
        roomJid: 'room@conference.example.com',
        message,
        incrementUnread: true,
        incrementMentions: true,
      })
      expect(mockStores.room.addMessage).toHaveBeenCalledWith(
        'room@conference.example.com',
        message,
        { incrementUnread: true, incrementMentions: true }
      )
    })

    it('should handle room:message-updated', () => {
      mockClient.emit('room:message-updated', {
        roomJid: 'room@conference.example.com',
        messageId: 'msg1',
        updates: { body: 'Edited' },
      })
      expect(mockStores.room.updateMessage).toHaveBeenCalledWith(
        'room@conference.example.com', 'msg1', { body: 'Edited' }
      )
    })

    it('should handle room:reactions', () => {
      mockClient.emit('room:reactions', {
        roomJid: 'room@conference.example.com',
        messageId: 'msg1',
        reactorNick: 'Alice',
        emojis: ['heart'],
      })
      expect(mockStores.room.updateReactions).toHaveBeenCalledWith(
        'room@conference.example.com', 'msg1', 'Alice', ['heart']
      )
    })

    it('should handle room:typing', () => {
      mockClient.emit('room:typing', {
        roomJid: 'room@conference.example.com',
        nick: 'Alice',
        isTyping: true,
      })
      expect(mockStores.room.setTyping).toHaveBeenCalledWith(
        'room@conference.example.com', 'Alice', true
      )
    })

    it('should handle room:subject', () => {
      mockClient.emit('room:subject', { roomJid: 'room@conference.example.com', subject: 'New topic' })
      expect(mockStores.room.updateRoom).toHaveBeenCalledWith('room@conference.example.com', { subject: 'New topic' })
    })

    it('should handle room:bookmark', () => {
      const bookmark = { name: 'Test Room', nick: 'Me', autojoin: true }
      mockClient.emit('room:bookmark', { roomJid: 'room@conference.example.com', bookmark })
      expect(mockStores.room.setBookmark).toHaveBeenCalledWith('room@conference.example.com', bookmark)
    })

    it('should handle room:bookmark-removed', () => {
      mockClient.emit('room:bookmark-removed', { roomJid: 'room@conference.example.com' })
      expect(mockStores.room.removeBookmark).toHaveBeenCalledWith('room@conference.example.com')
    })

    it('should handle room:animation', () => {
      mockClient.emit('room:animation', { roomJid: 'room@conference.example.com', animation: 'confetti' })
      expect(mockStores.room.triggerAnimation).toHaveBeenCalledWith('room@conference.example.com', 'confetti')
    })
  })

  describe('roster events', () => {
    it('should handle roster:loaded', () => {
      const contacts: Contact[] = [{ jid: 'alice@example.com', name: 'Alice', presence: 'offline', subscription: 'both' }]
      mockClient.emit('roster:loaded', { contacts })
      expect(mockStores.roster.setContacts).toHaveBeenCalledWith(contacts)
    })

    it('should handle roster:contact', () => {
      const contact: Contact = { jid: 'bob@example.com', name: 'Bob', presence: 'offline', subscription: 'both' }
      mockClient.emit('roster:contact', { contact })
      expect(mockStores.roster.addOrUpdateContact).toHaveBeenCalledWith(contact)
    })

    it('should handle roster:contact-removed', () => {
      mockClient.emit('roster:contact-removed', { jid: 'bob@example.com' })
      expect(mockStores.roster.removeContact).toHaveBeenCalledWith('bob@example.com')
    })

    it('should handle roster:presence', () => {
      const lastInteraction = new Date(1234567890)
      mockClient.emit('roster:presence', {
        fullJid: 'alice@example.com/phone',
        show: 'away',
        priority: 0,
        statusMessage: 'AFK',
        lastInteraction,
        client: 'PhoneClient',
      })
      expect(mockStores.roster.updatePresence).toHaveBeenCalledWith(
        'alice@example.com/phone', 'away', 0, 'AFK', lastInteraction, 'PhoneClient'
      )
    })

    it('should handle roster:presence-offline', () => {
      mockClient.emit('roster:presence-offline', { fullJid: 'alice@example.com/phone' })
      expect(mockStores.roster.removePresence).toHaveBeenCalledWith('alice@example.com/phone')
    })

    it('should handle roster:presence-error', () => {
      mockClient.emit('roster:presence-error', { jid: 'alice@example.com', error: 'Remote server not found' })
      expect(mockStores.roster.setPresenceError).toHaveBeenCalledWith('alice@example.com', 'Remote server not found')
    })

    it('should handle roster:avatar', () => {
      mockClient.emit('roster:avatar', {
        jid: 'alice@example.com',
        avatar: 'data:image/png...',
        avatarHash: 'hash123',
      })
      expect(mockStores.roster.updateAvatar).toHaveBeenCalledWith('alice@example.com', 'data:image/png...', 'hash123')
    })
  })

  describe('events store events', () => {
    it('should handle events:subscription-request', () => {
      mockClient.emit('events:subscription-request', { from: 'stranger@example.com' })
      expect(mockStores.events.addSubscriptionRequest).toHaveBeenCalledWith('stranger@example.com')
    })

    it('should handle events:subscription-request-removed', () => {
      mockClient.emit('events:subscription-request-removed', { from: 'stranger@example.com' })
      expect(mockStores.events.removeSubscriptionRequest).toHaveBeenCalledWith('stranger@example.com')
    })

    it('should handle events:stranger-message', () => {
      mockClient.emit('events:stranger-message', { from: 'stranger@example.com', body: 'Hi!' })
      expect(mockStores.events.addStrangerMessage).toHaveBeenCalledWith('stranger@example.com', 'Hi!')
    })

    it('should handle events:stranger-messages-removed', () => {
      mockClient.emit('events:stranger-messages-removed', { from: 'stranger@example.com' })
      expect(mockStores.events.removeStrangerMessages).toHaveBeenCalledWith('stranger@example.com')
    })

    it('should handle events:muc-invitation', () => {
      mockClient.emit('events:muc-invitation', {
        roomJid: 'room@conference.example.com',
        from: 'alice@example.com',
        reason: 'Join us!',
        password: 'secret',
        isDirect: true,
        isQuickChat: false,
      })
      expect(mockStores.events.addMucInvitation).toHaveBeenCalledWith(
        'room@conference.example.com',
        'alice@example.com',
        'Join us!',
        'secret',
        true,
        false
      )
    })

    it('should handle events:muc-invitation-removed', () => {
      mockClient.emit('events:muc-invitation-removed', { roomJid: 'room@conference.example.com' })
      expect(mockStores.events.removeMucInvitation).toHaveBeenCalledWith('room@conference.example.com')
    })

    it('should handle events:system-notification', () => {
      mockClient.emit('events:system-notification', {
        type: 'connection-error' as SystemNotificationType,
        title: 'Server Update',
        message: 'Maintenance in 5 minutes',
      })
      expect(mockStores.events.addSystemNotification).toHaveBeenCalledWith(
        'connection-error', 'Server Update', 'Maintenance in 5 minutes'
      )
    })
  })

  describe('blocking events', () => {
    it('should handle blocking:list', () => {
      mockClient.emit('blocking:list', { jids: ['spam@example.com', 'troll@example.com'] })
      expect(mockStores.blocking.setBlocklist).toHaveBeenCalledWith(['spam@example.com', 'troll@example.com'])
    })

    it('should handle blocking:added', () => {
      mockClient.emit('blocking:added', { jids: ['spam@example.com'] })
      expect(mockStores.blocking.addBlockedJids).toHaveBeenCalledWith(['spam@example.com'])
    })

    it('should handle blocking:removed', () => {
      mockClient.emit('blocking:removed', { jids: ['friend@example.com'] })
      expect(mockStores.blocking.removeBlockedJids).toHaveBeenCalledWith(['friend@example.com'])
    })

    it('should handle blocking:cleared', () => {
      mockClient.emit('blocking:cleared', {})
      expect(mockStores.blocking.clearBlocklist).toHaveBeenCalled()
    })
  })

  describe('admin events', () => {
    it('should handle admin:is-admin', () => {
      mockClient.emit('admin:is-admin', { isAdmin: true })
      expect(mockStores.admin.setIsAdmin).toHaveBeenCalledWith(true)
    })

    it('should handle admin:commands', () => {
      const commands: AdminCommand[] = [{ name: 'List Users', node: 'http://jabber.org/protocol/admin#get-user-list', category: 'user' }]
      mockClient.emit('admin:commands', { commands })
      expect(mockStores.admin.setCommands).toHaveBeenCalledWith(commands)
    })

    it('should handle admin:session', () => {
      const session: AdminSession = { status: 'executing', sessionId: 'abc123', node: 'http://jabber.org/protocol/admin#get-user-list' }
      mockClient.emit('admin:session', { session })
      expect(mockStores.admin.setCurrentSession).toHaveBeenCalledWith(session)
    })

    it('should handle admin:discovering', () => {
      mockClient.emit('admin:discovering', { isDiscovering: true })
      expect(mockStores.admin.setIsDiscovering).toHaveBeenCalledWith(true)
    })

    it('should handle admin:executing', () => {
      mockClient.emit('admin:executing', { isExecuting: true })
      expect(mockStores.admin.setIsExecuting).toHaveBeenCalledWith(true)
    })
  })

  describe('console events', () => {
    it('should handle console:event', () => {
      mockClient.emit('console:event', { message: 'Connected to server', category: 'connection' })
      expect(mockStores.console.addEvent).toHaveBeenCalledWith('Connected to server', 'connection')
    })

    it('should handle console:packet', () => {
      const xml = '<message to="user@example.com"><body>Hello</body></message>'
      mockClient.emit('console:packet', { direction: 'outgoing', xml })
      expect(mockStores.console.addPacket).toHaveBeenCalledWith('outgoing', xml)
    })
  })

  describe('unsubscribe', () => {
    it('should unsubscribe all handlers when called', () => {
      // Emit an event before unsubscribe
      const contacts = [{ jid: 'alice@example.com', name: 'Alice', presence: 'online' as const, subscription: 'both' as const }]
      mockClient.emit('roster:loaded', { contacts })
      expect(mockStores.roster.setContacts).toHaveBeenCalledTimes(1)

      // Call unsubscribe
      unsubscribe()

      // Clear the mock
      vi.mocked(mockStores.roster.setContacts).mockClear()

      // Emit the event again - should not be handled
      mockClient.emit('roster:loaded', { contacts })
      expect(mockStores.roster.setContacts).not.toHaveBeenCalled()
    })
  })
})
