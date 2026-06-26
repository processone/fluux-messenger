import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import 'fake-indexeddb/auto'
import { IDBFactory } from 'fake-indexeddb'
import type { Message, RoomMessage } from '../core/types'
import { _resetStorageScopeForTesting, setStorageScopeJid } from './storageScope'
import { selectCatchUpQuery } from './mamCatchUpUtils'

// Must import after fake-indexeddb/auto
import * as messageCache from './messageCache'

/**
 * Create a mock Message for testing
 */
function createMockMessage(conversationId: string, overrides: Partial<Message> = {}): Message {
  return {
    type: 'chat',
    id: `msg-${Math.random().toString(36).slice(2)}`,
    conversationId,
    from: 'user@example.com',
    body: 'Test message',
    timestamp: new Date(),
    isOutgoing: false,
    ...overrides,
  }
}

/**
 * Create a mock RoomMessage for testing
 */
function createMockRoomMessage(roomJid: string, overrides: Partial<RoomMessage> = {}): RoomMessage {
  return {
    type: 'groupchat',
    id: `room-msg-${Math.random().toString(36).slice(2)}`,
    roomJid,
    from: `${roomJid}/user`,
    body: 'Test room message',
    timestamp: new Date(),
    isOutgoing: false,
    nick: 'user',
    ...overrides,
  }
}

describe('messageCache', () => {
  beforeEach(async () => {
    _resetStorageScopeForTesting()
    // Reset IndexedDB completely before each test
    // This ensures test isolation with fake-indexeddb
    globalThis.indexedDB = new IDBFactory()
    // Reset the module's internal db reference
    ;(messageCache as { _resetDBForTesting?: () => void })._resetDBForTesting?.()
  })

  afterEach(async () => {
    // Clean up
    try {
      await messageCache.clearAllMessages()
    } catch {
      // Ignore errors during cleanup
    }
  })

  describe('isMessageCacheAvailable', () => {
    it('should return true when IndexedDB is available', () => {
      expect(messageCache.isMessageCacheAvailable()).toBe(true)
    })
  })

  describe('Chat Messages', () => {
    const conversationId = 'alice@example.com'

    it('should isolate messages per account scope', async () => {
      setStorageScopeJid('alice@example.com')
      await messageCache.saveMessage(createMockMessage(conversationId, { id: 'shared-id', body: 'Alice message' }))

      setStorageScopeJid('bob@example.com')
      await messageCache.saveMessage(createMockMessage(conversationId, { id: 'shared-id', body: 'Bob message' }))

      setStorageScopeJid('alice@example.com')
      const aliceMessage = await messageCache.getMessage('shared-id')
      expect(aliceMessage?.body).toBe('Alice message')

      setStorageScopeJid('bob@example.com')
      const bobMessage = await messageCache.getMessage('shared-id')
      expect(bobMessage?.body).toBe('Bob message')
    })

    describe('saveMessage', () => {
      it('should save a message to IndexedDB', async () => {
        const message = createMockMessage(conversationId, { id: 'msg-1' })

        await messageCache.saveMessage(message)

        const retrieved = await messageCache.getMessage('msg-1')
        expect(retrieved).not.toBeNull()
        expect(retrieved?.id).toBe('msg-1')
        expect(retrieved?.body).toBe('Test message')
      })

      it('should handle messages with stanzaId', async () => {
        const message = createMockMessage(conversationId, {
          id: 'msg-2',
          stanzaId: 'stanza-123',
        })

        await messageCache.saveMessage(message)

        const byStanzaId = await messageCache.getMessageByStanzaId('stanza-123')
        expect(byStanzaId).not.toBeNull()
        expect(byStanzaId?.id).toBe('msg-2')
      })

      it('should preserve Date objects', async () => {
        const timestamp = new Date('2024-01-15T10:30:00Z')
        const message = createMockMessage(conversationId, {
          id: 'msg-date',
          timestamp,
        })

        await messageCache.saveMessage(message)

        const retrieved = await messageCache.getMessage('msg-date')
        expect(retrieved?.timestamp).toBeInstanceOf(Date)
        expect(retrieved?.timestamp.getTime()).toBe(timestamp.getTime())
      })

      it('should handle messages with reactions', async () => {
        const message = createMockMessage(conversationId, {
          id: 'msg-reactions',
          reactions: { '👍': ['alice@example.com'], '❤️': ['bob@example.com'] },
        })

        await messageCache.saveMessage(message)

        const retrieved = await messageCache.getMessage('msg-reactions')
        expect(retrieved?.reactions).toEqual({
          '👍': ['alice@example.com'],
          '❤️': ['bob@example.com'],
        })
      })

      it('should handle messages with attachments', async () => {
        const message = createMockMessage(conversationId, {
          id: 'msg-attachment',
          attachment: {
            url: 'https://example.com/file.jpg',
            name: 'file.jpg',
            size: 12345,
            mediaType: 'image/jpeg',
          },
        })

        await messageCache.saveMessage(message)

        const retrieved = await messageCache.getMessage('msg-attachment')
        expect(retrieved?.attachment).toBeDefined()
        expect(retrieved?.attachment?.url).toBe('https://example.com/file.jpg')
      })
    })

    describe('saveMessages', () => {
      it('should save multiple messages at once', async () => {
        const messages = [
          createMockMessage(conversationId, { id: 'batch-1' }),
          createMockMessage(conversationId, { id: 'batch-2' }),
          createMockMessage(conversationId, { id: 'batch-3' }),
        ]

        await messageCache.saveMessages(messages)

        const retrieved = await messageCache.getMessages(conversationId)
        expect(retrieved.length).toBe(3)
      })
    })

    describe('getMessages', () => {
      it('should retrieve messages for a conversation', async () => {
        const messages = [
          createMockMessage(conversationId, { id: 'get-1', timestamp: new Date('2024-01-01T10:00:00Z') }),
          createMockMessage(conversationId, { id: 'get-2', timestamp: new Date('2024-01-01T11:00:00Z') }),
        ]

        await messageCache.saveMessages(messages)

        const retrieved = await messageCache.getMessages(conversationId)
        expect(retrieved.length).toBe(2)
        // Should be sorted by timestamp ascending
        expect(retrieved[0].id).toBe('get-1')
        expect(retrieved[1].id).toBe('get-2')
      })

      it('should return empty array for non-existent conversation', async () => {
        const retrieved = await messageCache.getMessages('nonexistent@example.com')
        expect(retrieved).toEqual([])
      })

      it('skips legacy blank rows (empty body, no payload) left by older builds', async () => {
        await messageCache.saveMessages([
          createMockMessage(conversationId, { id: 'real-1', body: 'hello', timestamp: new Date('2024-02-01T10:00:00Z') }),
          // The stale artifact: empty body, nothing renderable.
          createMockMessage(conversationId, { id: 'blank-1', body: '', timestamp: new Date('2024-02-01T11:00:00Z') }),
        ])

        const retrieved = await messageCache.getMessages(conversationId)
        expect(retrieved.map((m) => m.id)).toEqual(['real-1'])
      })

      it('keeps an empty-body retraction tombstone', async () => {
        await messageCache.saveMessages([
          createMockMessage(conversationId, { id: 'tomb-1', body: '', isRetracted: true, timestamp: new Date('2024-02-02T10:00:00Z') }),
        ])

        const retrieved = await messageCache.getMessages(conversationId)
        expect(retrieved.map((m) => m.id)).toEqual(['tomb-1'])
      })

      it('should respect limit option', async () => {
        const messages = Array.from({ length: 10 }, (_, i) =>
          createMockMessage(conversationId, {
            id: `limit-${i}`,
            timestamp: new Date(Date.now() + i * 1000),
          })
        )

        await messageCache.saveMessages(messages)

        const retrieved = await messageCache.getMessages(conversationId, { limit: 5 })
        expect(retrieved.length).toBe(5)
      })

      it('should respect before option', async () => {
        const cutoff = new Date('2024-01-15T12:00:00Z')
        const messages = [
          createMockMessage(conversationId, { id: 'before-1', timestamp: new Date('2024-01-15T10:00:00Z') }),
          createMockMessage(conversationId, { id: 'before-2', timestamp: new Date('2024-01-15T11:00:00Z') }),
          createMockMessage(conversationId, { id: 'after-1', timestamp: new Date('2024-01-15T13:00:00Z') }),
          createMockMessage(conversationId, { id: 'after-2', timestamp: new Date('2024-01-15T14:00:00Z') }),
        ]

        await messageCache.saveMessages(messages)

        const retrieved = await messageCache.getMessages(conversationId, { before: cutoff })
        expect(retrieved.length).toBe(2)
        expect(retrieved.every(m => m.timestamp < cutoff)).toBe(true)
      })

      it('should respect after option', async () => {
        const cutoff = new Date('2024-01-15T12:00:00Z')
        const messages = [
          createMockMessage(conversationId, { id: 'before-1', timestamp: new Date('2024-01-15T10:00:00Z') }),
          createMockMessage(conversationId, { id: 'after-1', timestamp: new Date('2024-01-15T13:00:00Z') }),
          createMockMessage(conversationId, { id: 'after-2', timestamp: new Date('2024-01-15T14:00:00Z') }),
        ]

        await messageCache.saveMessages(messages)

        const retrieved = await messageCache.getMessages(conversationId, { after: cutoff })
        expect(retrieved.length).toBe(2)
        expect(retrieved.every(m => m.timestamp > cutoff)).toBe(true)
      })
    })

    describe('updateMessage', () => {
      it('should update an existing message', async () => {
        const message = createMockMessage(conversationId, { id: 'update-1', body: 'Original' })
        await messageCache.saveMessage(message)

        await messageCache.updateMessage('update-1', {
          body: 'Updated',
          isEdited: true,
        })

        const retrieved = await messageCache.getMessage('update-1')
        expect(retrieved?.body).toBe('Updated')
        expect(retrieved?.isEdited).toBe(true)
      })

      it('should update reactions', async () => {
        const message = createMockMessage(conversationId, { id: 'react-update' })
        await messageCache.saveMessage(message)

        await messageCache.updateMessage('react-update', {
          reactions: { '🎉': ['user@example.com'] },
        })

        const retrieved = await messageCache.getMessage('react-update')
        expect(retrieved?.reactions).toEqual({ '🎉': ['user@example.com'] })
      })

      it('should handle updating non-existent message gracefully', async () => {
        // Should not throw
        await expect(
          messageCache.updateMessage('nonexistent', { body: 'Test' })
        ).resolves.not.toThrow()
      })
    })

    describe('deleteMessage', () => {
      it('should delete a message', async () => {
        const message = createMockMessage(conversationId, { id: 'delete-1' })
        await messageCache.saveMessage(message)

        await messageCache.deleteMessage('delete-1')

        const retrieved = await messageCache.getMessage('delete-1')
        expect(retrieved).toBeNull()
      })
    })

    describe('deleteConversationMessages', () => {
      it('should delete all messages for a conversation', async () => {
        const messages = [
          createMockMessage(conversationId, { id: 'conv-del-1' }),
          createMockMessage(conversationId, { id: 'conv-del-2' }),
        ]
        await messageCache.saveMessages(messages)

        // Save message in another conversation
        const otherConv = 'other@example.com'
        await messageCache.saveMessage(
          createMockMessage(otherConv, { id: 'other-conv' })
        )

        await messageCache.deleteConversationMessages(conversationId)

        const deleted = await messageCache.getMessages(conversationId)
        expect(deleted.length).toBe(0)

        // Other conversation should be unaffected
        const other = await messageCache.getMessages(otherConv)
        expect(other.length).toBe(1)
      })
    })

    describe('getMessageCount', () => {
      it('should return correct message count', async () => {
        const messages = [
          createMockMessage(conversationId, { id: 'count-1' }),
          createMockMessage(conversationId, { id: 'count-2' }),
          createMockMessage(conversationId, { id: 'count-3' }),
        ]
        await messageCache.saveMessages(messages)

        const count = await messageCache.getMessageCount(conversationId)
        expect(count).toBe(3)
      })

      it('should return 0 for empty conversation', async () => {
        const count = await messageCache.getMessageCount('empty@example.com')
        expect(count).toBe(0)
      })
    })

    describe('getOldestMessageTimestamp', () => {
      it('should return oldest timestamp', async () => {
        const oldest = new Date('2024-01-01T00:00:00Z')
        const messages = [
          createMockMessage(conversationId, { id: 'oldest-1', timestamp: oldest }),
          createMockMessage(conversationId, { id: 'oldest-2', timestamp: new Date('2024-06-15T00:00:00Z') }),
          createMockMessage(conversationId, { id: 'oldest-3', timestamp: new Date('2024-12-31T00:00:00Z') }),
        ]
        await messageCache.saveMessages(messages)

        const timestamp = await messageCache.getOldestMessageTimestamp(conversationId)
        expect(timestamp?.getTime()).toBe(oldest.getTime())
      })

      it('should return null for empty conversation', async () => {
        const timestamp = await messageCache.getOldestMessageTimestamp('empty@example.com')
        expect(timestamp).toBeNull()
      })
    })
  })

  describe('Room Messages', () => {
    const roomJid = 'room@conference.example.com'

    describe('saveRoomMessage', () => {
      it('should save a room message to IndexedDB', async () => {
        const message = createMockRoomMessage(roomJid, { id: 'room-1' })

        await messageCache.saveRoomMessage(message)

        const retrieved = await messageCache.getRoomMessage('room-1')
        expect(retrieved).not.toBeNull()
        expect(retrieved?.id).toBe('room-1')
      })

      it('should handle messages with stanzaId', async () => {
        const message = createMockRoomMessage(roomJid, {
          id: 'room-stanza',
          stanzaId: 'room-stanza-123',
        })

        await messageCache.saveRoomMessage(message)

        const byStanzaId = await messageCache.getRoomMessageByStanzaId('room-stanza-123')
        expect(byStanzaId).not.toBeNull()
        expect(byStanzaId?.id).toBe('room-stanza')
      })
    })

    describe('saveRoomMessages', () => {
      it('should save multiple room messages at once', async () => {
        const messages = [
          createMockRoomMessage(roomJid, { id: 'room-batch-1' }),
          createMockRoomMessage(roomJid, { id: 'room-batch-2' }),
        ]

        await messageCache.saveRoomMessages(messages)

        const retrieved = await messageCache.getRoomMessages(roomJid)
        expect(retrieved.length).toBe(2)
      })
    })

    describe('getRoomMessages', () => {
      it('should retrieve messages for a room', async () => {
        const messages = [
          createMockRoomMessage(roomJid, { id: 'room-get-1', timestamp: new Date('2024-01-01T10:00:00Z') }),
          createMockRoomMessage(roomJid, { id: 'room-get-2', timestamp: new Date('2024-01-01T11:00:00Z') }),
        ]

        await messageCache.saveRoomMessages(messages)

        const retrieved = await messageCache.getRoomMessages(roomJid)
        expect(retrieved.length).toBe(2)
        // Should be sorted by timestamp ascending
        expect(retrieved[0].id).toBe('room-get-1')
        expect(retrieved[1].id).toBe('room-get-2')
      })

      it('should respect limit and before options', async () => {
        const cutoff = new Date('2024-01-15T12:00:00Z')
        const messages = [
          createMockRoomMessage(roomJid, { id: 'rb-1', timestamp: new Date('2024-01-15T10:00:00Z') }),
          createMockRoomMessage(roomJid, { id: 'rb-2', timestamp: new Date('2024-01-15T11:00:00Z') }),
          createMockRoomMessage(roomJid, { id: 'ra-1', timestamp: new Date('2024-01-15T13:00:00Z') }),
        ]

        await messageCache.saveRoomMessages(messages)

        const retrieved = await messageCache.getRoomMessages(roomJid, { before: cutoff, limit: 1 })
        expect(retrieved.length).toBe(1)
        expect(retrieved[0].timestamp < cutoff).toBe(true)
      })

      it('skips a legacy blank room row so it cannot render or seed the catch-up cursor', async () => {
        // Mirrors the reported XSF case: the newest cached row is an empty-body
        // leftover. It must be filtered so the newest returned row is the real one.
        await messageCache.saveRoomMessages([
          createMockRoomMessage(roomJid, { id: 'room-real', body: 'real text', timestamp: new Date('2024-02-01T10:00:00Z') }),
          createMockRoomMessage(roomJid, { id: 'room-blank', body: '', timestamp: new Date('2024-02-01T11:00:00Z') }),
        ])

        const retrieved = await messageCache.getRoomMessages(roomJid)
        expect(retrieved.map((m) => m.id)).toEqual(['room-real'])
      })
    })

    describe('updateRoomMessage', () => {
      it('should update an existing room message', async () => {
        const message = createMockRoomMessage(roomJid, { id: 'room-update', body: 'Original' })
        await messageCache.saveRoomMessage(message)

        await messageCache.updateRoomMessage('room-update', {
          body: 'Updated',
          isEdited: true,
        })

        const retrieved = await messageCache.getRoomMessage('room-update')
        expect(retrieved?.body).toBe('Updated')
        expect(retrieved?.isEdited).toBe(true)
      })
    })

    describe('deleteRoomMessage', () => {
      it('should delete a room message', async () => {
        const message = createMockRoomMessage(roomJid, { id: 'room-delete' })
        await messageCache.saveRoomMessage(message)

        await messageCache.deleteRoomMessage('room-delete')

        const retrieved = await messageCache.getRoomMessage('room-delete')
        expect(retrieved).toBeNull()
      })
    })

    describe('deleteRoomMessages', () => {
      it('should delete all messages for a room', async () => {
        const messages = [
          createMockRoomMessage(roomJid, { id: 'room-del-1' }),
          createMockRoomMessage(roomJid, { id: 'room-del-2' }),
        ]
        await messageCache.saveRoomMessages(messages)

        // Save message in another room
        const otherRoom = 'other@conference.example.com'
        await messageCache.saveRoomMessage(
          createMockRoomMessage(otherRoom, { id: 'other-room' })
        )

        await messageCache.deleteRoomMessages(roomJid)

        const deleted = await messageCache.getRoomMessages(roomJid)
        expect(deleted.length).toBe(0)

        // Other room should be unaffected
        const other = await messageCache.getRoomMessages(otherRoom)
        expect(other.length).toBe(1)
      })
    })

    describe('getRoomMessageCount', () => {
      it('should return correct room message count', async () => {
        const messages = [
          createMockRoomMessage(roomJid, { id: 'room-count-1' }),
          createMockRoomMessage(roomJid, { id: 'room-count-2' }),
        ]
        await messageCache.saveRoomMessages(messages)

        const count = await messageCache.getRoomMessageCount(roomJid)
        expect(count).toBe(2)
      })
    })

    describe('getOldestRoomMessageTimestamp', () => {
      it('should return oldest timestamp for room', async () => {
        const oldest = new Date('2024-01-01T00:00:00Z')
        const messages = [
          createMockRoomMessage(roomJid, { id: 'room-oldest-1', timestamp: oldest }),
          createMockRoomMessage(roomJid, { id: 'room-oldest-2', timestamp: new Date('2024-12-31T00:00:00Z') }),
        ]
        await messageCache.saveRoomMessages(messages)

        const timestamp = await messageCache.getOldestRoomMessageTimestamp(roomJid)
        expect(timestamp?.getTime()).toBe(oldest.getTime())
      })
    })
  })

  describe('getTotalMessageCount', () => {
    it('should count all chat messages across conversations', async () => {
      await messageCache.saveMessage(createMockMessage('alice@example.com', { id: 'total-1' }))
      await messageCache.saveMessage(createMockMessage('alice@example.com', { id: 'total-2' }))
      await messageCache.saveMessage(createMockMessage('bob@example.com', { id: 'total-3' }))

      const count = await messageCache.getTotalMessageCount()
      expect(count).toBe(3)
    })

    it('should return 0 when no messages exist', async () => {
      const count = await messageCache.getTotalMessageCount()
      expect(count).toBe(0)
    })
  })

  describe('getTotalRoomMessageCount', () => {
    it('should count all room messages across rooms', async () => {
      await messageCache.saveRoomMessage(
        createMockRoomMessage('room1@conference.example.com', { id: 'rtotal-1' })
      )
      await messageCache.saveRoomMessage(
        createMockRoomMessage('room2@conference.example.com', { id: 'rtotal-2' })
      )

      const count = await messageCache.getTotalRoomMessageCount()
      expect(count).toBe(2)
    })

    it('should return 0 when no room messages exist', async () => {
      const count = await messageCache.getTotalRoomMessageCount()
      expect(count).toBe(0)
    })
  })

  describe('iterateAllRoomMessages', () => {
    it('should iterate a saved room message without any flush dance', async () => {
      // Direct-write semantics: a single save is visible immediately,
      // no buffer to drain. This is the guarantee that fixes the
      // reload-loses-notified-message race.
      await messageCache.saveRoomMessage(
        createMockRoomMessage('room@conference.example.com', { id: 'iter-direct-1', body: 'Direct write' })
      )

      const collected: RoomMessage[] = []
      await messageCache.iterateAllRoomMessages(100, async (batch) => {
        collected.push(...batch)
      })

      expect(collected.length).toBe(1)
      expect(collected[0].body).toBe('Direct write')
    })
  })

  describe('clearAllMessages', () => {
    it('should clear all messages from both stores', async () => {
      const conversationId = 'alice@example.com'
      const roomJid = 'room@example.com'

      // Add chat messages
      await messageCache.saveMessage(createMockMessage(conversationId, { id: 'clear-chat' }))

      // Add room messages
      await messageCache.saveRoomMessage(
        createMockRoomMessage(roomJid, { id: 'clear-room' })
      )

      await messageCache.clearAllMessages()

      const chatMessages = await messageCache.getMessages(conversationId)
      const roomMessages = await messageCache.getRoomMessages(roomJid)

      expect(chatMessages.length).toBe(0)
      expect(roomMessages.length).toBe(0)
    })
  })

  describe('non-destructive E2EE save (never degrade decrypted cache)', () => {
    const conversationId = 'peer@example.com'

    it('does not let an undecryptable re-ingest overwrite an already-decrypted message', async () => {
      setStorageScopeJid('me@example.com')

      // Session 1: the message was decrypted live and persisted as plaintext.
      await messageCache.saveMessage(
        createMockMessage(conversationId, {
          id: 'm1',
          body: 'Bonjour en clair',
          // no encryptedPayload — fully decrypted
        })
      )

      // Reload → fresh-session MAM catch-up re-ingests the SAME message (same
      // id) while the OpenPGP key is still locked: it arrives undecryptable,
      // carrying the encrypted placeholder. This must NOT clobber the plaintext.
      await messageCache.saveMessages([
        createMockMessage(conversationId, {
          id: 'm1',
          body: '[OpenPGP-encrypted message]',
          encryptedPayload: '<openpgp xmlns="urn:xmpp:openpgp:0">CIPHER</openpgp>',
        }),
      ])

      const stored = await messageCache.getMessage('m1')
      expect(stored?.body).toBe('Bonjour en clair')
      expect(stored?.encryptedPayload).toBeUndefined()
    })

    it('still lets a decrypted message upgrade a previously-undecryptable one', async () => {
      setStorageScopeJid('me@example.com')

      // Received while locked → stored undecryptable.
      await messageCache.saveMessage(
        createMockMessage(conversationId, {
          id: 'm2',
          body: '[OpenPGP-encrypted message]',
          encryptedPayload: '<openpgp xmlns="urn:xmpp:openpgp:0">CIPHER</openpgp>',
        })
      )

      // Deferred decrypt succeeds → plaintext, no stash. Upgrade must apply.
      await messageCache.saveMessage(
        createMockMessage(conversationId, {
          id: 'm2',
          body: 'Coucou déchiffré',
        })
      )

      const stored = await messageCache.getMessage('m2')
      expect(stored?.body).toBe('Coucou déchiffré')
      expect(stored?.encryptedPayload).toBeUndefined()
    })

    it('refreshes an undecryptable message with another undecryptable version', async () => {
      setStorageScopeJid('me@example.com')

      await messageCache.saveMessage(
        createMockMessage(conversationId, {
          id: 'm3',
          body: '[OpenPGP-encrypted message]',
          encryptedPayload: '<openpgp xmlns="urn:xmpp:openpgp:0">OLD</openpgp>',
        })
      )
      await messageCache.saveMessage(
        createMockMessage(conversationId, {
          id: 'm3',
          body: '[OpenPGP-encrypted message]',
          encryptedPayload: '<openpgp xmlns="urn:xmpp:openpgp:0">NEW</openpgp>',
        })
      )

      const stored = await messageCache.getMessage('m3')
      expect(stored?.encryptedPayload).toContain('NEW')
    })

    it('does not let an unsupported-encryption fallback overwrite an already-decrypted message', async () => {
      setStorageScopeJid('me@example.com')
      await messageCache.saveMessage(
        createMockMessage(conversationId, { id: 'u1', body: 'Texte clair' })
      )
      // Peer toggled their encryption off → re-ingest arrives as a fallback
      // with no ciphertext to retry. Must not clobber the decrypted plaintext.
      await messageCache.saveMessage(
        createMockMessage(conversationId, {
          id: 'u1',
          body: '[Encrypted message]',
          unsupportedEncryption: { namespace: 'urn:xmpp:openpgp:0', name: 'OpenPGP' },
        })
      )

      const stored = await messageCache.getMessage('u1')
      expect(stored?.body).toBe('Texte clair')
      expect(stored?.unsupportedEncryption).toBeUndefined()
    })

    it('does not let an unsupported fallback overwrite a retriable encryptedPayload message', async () => {
      setStorageScopeJid('me@example.com')
      await messageCache.saveMessage(
        createMockMessage(conversationId, {
          id: 'u2',
          body: '[OpenPGP-encrypted message]',
          encryptedPayload: '<openpgp xmlns="urn:xmpp:openpgp:0">CIPHER</openpgp>',
        })
      )
      // A fallback (no ciphertext) must not destroy the retriable ciphertext.
      await messageCache.saveMessage(
        createMockMessage(conversationId, {
          id: 'u2',
          body: '[Encrypted message]',
          unsupportedEncryption: { namespace: 'eu.siacs.conversations.axolotl', name: 'OMEMO' },
        })
      )

      const stored = await messageCache.getMessage('u2')
      expect(stored?.encryptedPayload).toContain('CIPHER')
      expect(stored?.unsupportedEncryption).toBeUndefined()
    })

    it('lets a retriable encryptedPayload replace an unsupported fallback (upgrade)', async () => {
      setStorageScopeJid('me@example.com')
      await messageCache.saveMessage(
        createMockMessage(conversationId, {
          id: 'u3',
          body: '[Encrypted message]',
          unsupportedEncryption: { namespace: 'eu.siacs.conversations.axolotl', name: 'OMEMO' },
        })
      )
      // Plugin now available → ciphertext arrives and SHOULD take over so the
      // deferred retry can decrypt it.
      await messageCache.saveMessage(
        createMockMessage(conversationId, {
          id: 'u3',
          body: '[OpenPGP-encrypted message]',
          encryptedPayload: '<openpgp xmlns="urn:xmpp:openpgp:0">C3</openpgp>',
        })
      )

      const stored = await messageCache.getMessage('u3')
      expect(stored?.encryptedPayload).toContain('C3')
      expect(stored?.unsupportedEncryption).toBeUndefined()
    })
  })

  describe('getMessagesWithEncryptedPayload', () => {
    it('returns only messages that still carry an encryptedPayload, across conversations', async () => {
      setStorageScopeJid('me@example.com')
      await messageCache.saveMessage(
        createMockMessage('a@example.com', { id: 'plain', body: 'clair' })
      )
      await messageCache.saveMessage(
        createMockMessage('a@example.com', {
          id: 'enc1',
          body: '[OpenPGP-encrypted message]',
          encryptedPayload: '<openpgp xmlns="urn:xmpp:openpgp:0">ONE</openpgp>',
        })
      )
      await messageCache.saveMessage(
        createMockMessage('b@example.com', {
          id: 'enc2',
          body: '[OpenPGP-encrypted message]',
          encryptedPayload: '<openpgp xmlns="urn:xmpp:openpgp:0">TWO</openpgp>',
        })
      )

      const pending = await messageCache.getMessagesWithEncryptedPayload()
      const ids = pending.map((m) => m.id).sort()
      expect(ids).toEqual(['enc1', 'enc2'])
      // Each must keep the data the deferred retry needs.
      expect(pending.every((m) => !!m.encryptedPayload && !!m.conversationId)).toBe(true)
    })

    it('returns an empty array when nothing is pending', async () => {
      setStorageScopeJid('me@example.com')
      await messageCache.saveMessage(
        createMockMessage('a@example.com', { id: 'plain', body: 'clair' })
      )
      expect(await messageCache.getMessagesWithEncryptedPayload()).toEqual([])
    })
  })

  describe('Error handling', () => {
    it('should handle getMessages on empty database gracefully', async () => {
      const messages = await messageCache.getMessages('nonexistent@example.com')
      expect(messages).toEqual([])
    })

    it('should handle getMessage for non-existent ID', async () => {
      const message = await messageCache.getMessage('nonexistent-id')
      expect(message).toBeNull()
    })
  })

  // The reported bug: the room's MAM catch-up `start` is derived from the newest
  // cached message (selectCatchUpQuery). When the newest cached row was a blank
  // leftover, the cursor anchored on it. This composes the two real units —
  // getRoomMessages (read-side prune) feeding selectCatchUpQuery (cursor) — to
  // prove the blank row can no longer poison the cursor.
  describe('catch-up cursor composition (blank row must not anchor the cursor)', () => {
    const cursorRoomJid = 'cursor-room@conference.example.com'
    // The real value seen in the trace: blank row is the NEWEST by timestamp.
    const realTs = new Date('2026-06-25T17:00:00.000Z')
    const blankTs = new Date('2026-06-25T17:15:14.214Z')
    // Session connected well after both, so both count as pre-session history.
    const sessionStartTime = new Date('2026-06-25T22:00:00.000Z').getTime()

    it('anchors the catch-up cursor on the newest renderable row, not the blank one', async () => {
      await messageCache.saveRoomMessages([
        createMockRoomMessage(cursorRoomJid, { id: 'cursor-real', body: 'real text', timestamp: realTs }),
        createMockRoomMessage(cursorRoomJid, { id: 'cursor-blank', body: '', timestamp: blankTs }),
      ])

      const cached = await messageCache.getRoomMessages(cursorRoomJid)
      const query = selectCatchUpQuery(cached, { sessionStartTime })

      // Forward query, anchored exactly as if only the real row existed...
      expect(query.before).toBeUndefined()
      expect(query).toEqual(selectCatchUpQuery([{ timestamp: realTs }], { sessionStartTime }))
      // ...and NOT on the blank row's (newer) timestamp.
      expect(query).not.toEqual(selectCatchUpQuery([{ timestamp: blankTs }], { sessionStartTime }))
    })
  })
})
