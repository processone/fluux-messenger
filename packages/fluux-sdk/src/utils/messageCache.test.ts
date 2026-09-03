import { describe, it, expect, expectTypeOf, beforeEach, afterEach } from 'vitest'
import 'fake-indexeddb/auto'
import { IDBFactory } from 'fake-indexeddb'
import { openDB } from 'idb'
import type { Message, RoomMessage } from '../core/types'
import { _resetStorageScopeForTesting, setStorageScopeJid } from './storageScope'
import { selectCatchUpQuery } from './mamCatchUpUtils'
import { canonicalKey, identityKeys, roomScope, type RoomIdentityFields } from './messageIdentity'
import {
  _clearRetractedIdentitiesForTesting,
} from './retractedIdentities'

/** Room-scoped bindings of the shared ladder, as the cache itself uses them. */
const roomIdentityKeys = (m: RoomIdentityFields) => identityKeys(roomScope(m.roomJid), m)
const roomCanonicalKey = (m: RoomIdentityFields) => canonicalKey(roomScope(m.roomJid), m)

// Must import after fake-indexeddb/auto
import * as messageCache from './messageCache'
import * as cacheApi from '../cache'
import { mergeRoomRows, _contentProjectionForTesting } from './messageCache'
import type { StoredRoomMessage } from './messageCache'

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
  it('preserves public single-message save return types', () => {
    expectTypeOf(cacheApi.saveMessage).returns.toEqualTypeOf<Promise<void>>()
    expectTypeOf(cacheApi.saveRoomMessage).returns.toEqualTypeOf<Promise<void>>()
  })

  beforeEach(async () => {
    _resetStorageScopeForTesting()
    _clearRetractedIdentitiesForTesting()
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

  it('gets mixed chat and sender-scoped room references in one batch', async () => {
    const roomJid = 'team@conference.example.com'
    await messageCache.saveMessage(createMockMessage('alice@example.com', {
      id: 'chat-found',
      body: 'chat body',
    }))
    await messageCache.saveRoomMessages([
      createMockRoomMessage(roomJid, {
        id: 'shared-id',
        from: `${roomJid}/Alice`,
        nick: 'Alice',
        body: 'Alice body',
      }),
      createMockRoomMessage(roomJid, {
        id: 'shared-id',
        from: `${roomJid}/Bob`,
        nick: 'Bob',
        body: 'Bob body',
      }),
    ])

    const result = await messageCache.getMessagesByReferences(
      ['chat-found', 'chat-missing'],
      [
        { roomJid, id: 'shared-id', from: `${roomJid}/Alice` },
        { roomJid, id: 'shared-id', from: `${roomJid}/Bob` },
        { roomJid, id: 'room-missing', from: `${roomJid}/Alice` },
      ]
    )

    expect(result.chatMessages.map(message => message?.body ?? null)).toEqual(['chat body', null])
    expect(result.roomMessages.map(message => message?.body ?? null)).toEqual([
      'Alice body',
      'Bob body',
      null,
    ])
  })

  // fluux-room-nick-reuse-false-deletion: a departed occupant's row and a new
  // occupant's message share room, nick and client id, so they share the from+id
  // rung of the ladder. Only the XEP-0421 occupant-id separates them, and without
  // that guard the merge folds the newcomer into the tombstoned row and scrubs a
  // body the user never deleted.
  it('does not merge a reused nick across an occupant-id conflict', async () => {
    const roomJid = 'team@conference.example.com'
    const departed = createMockRoomMessage(roomJid, {
      id: 'collide',
      from: `${roomJid}/Alice`,
      nick: 'Alice',
      occupantId: 'occupant-departed',
      body: 'the departed occupant said this',
      isRetracted: true,
      retractedAt: new Date(1000),
    })
    const newcomer = createMockRoomMessage(roomJid, {
      id: 'collide',
      from: `${roomJid}/Alice`,
      nick: 'Alice',
      occupantId: 'occupant-newcomer',
      body: 'the new occupant said this',
    })
    // Same ladder keys — the collision is real, not an artefact of the fixture.
    expect(roomIdentityKeys(departed)).toEqual(roomIdentityKeys(newcomer))

    await messageCache.saveRoomMessage(departed)
    await messageCache.saveRoomMessage(newcomer)

    const stored = await messageCache.getRoomMessages(roomJid)
    const original = stored.find((m) => m.occupantId === 'occupant-departed')
    const survivor = stored.find((m) => m.occupantId === 'occupant-newcomer')
    expect(stored).toHaveLength(2)
    expect(original?.body).toBe('')
    expect(original?.isRetracted).toBe(true)
    expect(survivor?.body).toBe('the new occupant said this')
    expect(survivor?.isRetracted).toBeFalsy()
  })

  it('expands only the compatible component across mixed weaker-tier matches', async () => {
    const roomJid = 'component@conference.example.com'
    const shared = { id: 'collide', from: `${roomJid}/Alice`, nick: 'Alice' }
    const departed = createMockRoomMessage(roomJid, {
      ...shared,
      stanzaId: 'ARCHIVE-OLD',
      occupantId: 'occupant-departed',
    })
    const target = createMockRoomMessage(roomJid, {
      ...shared,
      stanzaId: 'ARCHIVE-NEW',
      occupantId: 'occupant-newcomer',
    })
    const compatible = createMockRoomMessage(roomJid, {
      ...shared,
      originId: 'ORIGIN-NEW',
      occupantId: 'occupant-newcomer',
    })

    await messageCache.getRoomMessages(roomJid)
    const db = await openDB('fluux-message-cache', 4)
    const tx = db.transaction('room-messages-canonical', 'readwrite')
    for (const message of [departed, target, compatible]) {
      await tx.store.put(rrow({
        ...message,
        timestamp: message.timestamp.getTime(),
        // Stored rows keep epoch millis, not Dates — mirror serializeRoomMessage
        // exactly so a fixture round-trips the way production does.
        retractedAt: message.retractedAt?.getTime(),
        pollClosedAt: message.pollClosedAt?.getTime(),
      }) as never)
    }
    await tx.done
    db.close()
    const copies = await messageCache.findRoomMessageCopies(roomJid, {
      ...target,
      occupantId: undefined,
    })

    expect(copies.map((copy) => copy.message.occupantId)).toEqual([
      'occupant-newcomer',
      'occupant-newcomer',
    ])
    expect(copies.map((copy) => copy.message.stanzaId ?? copy.message.originId).sort())
      .toEqual(['ARCHIVE-NEW', 'ORIGIN-NEW'])
  })

  it('does not let an occupant-less copy bridge conflicting cached rows', async () => {
    const roomJid = 'bridge@conference.example.com'
    const shared = { id: 'collide', from: `${roomJid}/Alice`, nick: 'Alice' }
    const departed = createMockRoomMessage(roomJid, {
      ...shared,
      stanzaId: 'ARCHIVE-OLD',
      occupantId: 'occupant-departed',
      body: '',
      isRetracted: true,
      retractedAt: new Date(1000),
    })
    const newcomer = createMockRoomMessage(roomJid, {
      ...shared,
      stanzaId: 'ARCHIVE-NEW',
      occupantId: 'occupant-newcomer',
      body: 'visible newcomer body',
    })
    const ambiguousArchiveCopy = createMockRoomMessage(roomJid, {
      ...shared,
      stanzaId: 'ARCHIVE-NEW',
      occupantId: undefined,
      body: 'visible newcomer body',
    })

    await messageCache.saveRoomMessage(departed)
    await messageCache.saveRoomMessage(newcomer)
    await messageCache.saveRoomMessage(ambiguousArchiveCopy)

    const stored = await messageCache.getRoomMessages(roomJid)
    const visible = stored.find((message) => message.occupantId === 'occupant-newcomer')
    expect(stored).toHaveLength(2)
    expect(visible?.body).toBe('visible newcomer body')
    expect(visible?.isRetracted).toBeFalsy()
  })

  it('resolves an authoritative room tier before a fallback occupant collision', async () => {
    const roomJid = 'tiered@conference.example.com'
    const shared = { id: 'collide', from: `${roomJid}/Alice`, nick: 'Alice' }
    await messageCache.saveRoomMessage(createMockRoomMessage(roomJid, {
      ...shared,
      stanzaId: 'ARCHIVE-OLD',
      occupantId: 'occupant-departed',
      body: 'old occupant body',
    }))
    await messageCache.saveRoomMessage(createMockRoomMessage(roomJid, {
      ...shared,
      stanzaId: 'ARCHIVE-NEW',
      occupantId: 'occupant-newcomer',
      body: '',
      isRetracted: true,
      retractedAt: new Date(1000),
    }))
    const archiveCopy = createMockRoomMessage(roomJid, {
      ...shared,
      stanzaId: 'ARCHIVE-NEW',
      originId: 'ORIGIN-NEW',
      occupantId: undefined,
      body: 'body that must stay retracted',
    })

    expect(await messageCache.areRetractedInCache([archiveCopy])).toEqual([true])
    await messageCache.saveRoomMessage(archiveCopy)

    const stored = await messageCache.getRoomMessages(roomJid)
    const target = stored.find((message) => message.stanzaId === 'ARCHIVE-NEW')
    expect(stored).toHaveLength(2)
    expect(target?.originId).toBe('ORIGIN-NEW')
    expect(target?.occupantId).toBe('occupant-newcomer')
    expect(target?.isRetracted).toBe(true)
    expect(target?.body).toBe('')
  })

  // The complement: two copies of ONE message still merge. A local echo carries
  // no occupant-id, so an absent id must never be read as a conflict.
  it('still merges copies when only one carries an occupant-id', async () => {
    const roomJid = 'team@conference.example.com'
    await messageCache.saveRoomMessage(createMockRoomMessage(roomJid, {
      id: 'echo', from: `${roomJid}/Alice`, nick: 'Alice', originId: 'ORIGIN-1', body: 'hello',
    }))
    await messageCache.saveRoomMessage(createMockRoomMessage(roomJid, {
      id: 'echo', from: `${roomJid}/Alice`, nick: 'Alice', originId: 'ORIGIN-1',
      stanzaId: 'ARCHIVE-1', occupantId: 'occupant-alice', body: 'hello',
    }))

    const stored = await messageCache.getRoomMessages(roomJid)
    expect(stored).toHaveLength(1)
    expect(stored[0].stanzaId).toBe('ARCHIVE-1')
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

        await expect(messageCache.saveMessage(message)).resolves.toBeUndefined()

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

        await expect(messageCache.saveMessage(message)).resolves.toBeUndefined()

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

      it('resolves true when the transaction commits', async () => {
        await expect(
          messageCache.saveMessages([createMockMessage(conversationId, { id: 'commit-1' })])
        ).resolves.toBe(true)
      })

      it('resolves true for an empty batch', async () => {
        await expect(messageCache.saveMessages([])).resolves.toBe(true)
      })

      it('resolves false when the write fails', async () => {
        // Break IndexedDB for this call so getDB rejects.
        messageCache._resetDBForTesting()
        const original = globalThis.indexedDB
        globalThis.indexedDB = { open: () => { throw new Error('quota exceeded') } } as unknown as IDBFactory
        try {
          await expect(
            messageCache.saveMessages([createMockMessage(conversationId, { id: 'fail-1' })])
          ).resolves.toBe(false)
        } finally {
          globalThis.indexedDB = original
          messageCache._resetDBForTesting()
        }
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

    describe('updateMessageReactions', () => {
      it('should add reactions to a message found by id', async () => {
        const message = createMockMessage(conversationId, { id: 'react-1' })
        await messageCache.saveMessage(message)

        const found = await messageCache.updateMessageReactions(conversationId, 'react-1', 'bob@example.com', ['👍'])

        expect(found).toBe(true)
        const retrieved = await messageCache.getMessage('react-1')
        expect(retrieved?.reactions).toEqual({ '👍': ['bob@example.com'] })
      })

      it('should find the message by stanzaId when the reaction references the server-assigned id', async () => {
        const message = createMockMessage(conversationId, { id: 'react-2', stanzaId: 'server-stanza-id-1' })
        await messageCache.saveMessage(message)

        const found = await messageCache.updateMessageReactions(conversationId, 'server-stanza-id-1', 'bob@example.com', ['👍'])

        expect(found).toBe(true)
        const retrieved = await messageCache.getMessage('react-2')
        expect(retrieved?.reactions).toEqual({ '👍': ['bob@example.com'] })
      })

      it('should find the message by originId', async () => {
        const message = createMockMessage(conversationId, { id: 'react-origin', originId: 'origin-reaction-id' })
        await messageCache.saveMessage(message)

        const found = await messageCache.updateMessageReactions(conversationId, 'origin-reaction-id', 'bob@example.com', ['👍'])

        expect(found).toBe(true)
        const retrieved = await messageCache.getMessage(message.id)
        expect(retrieved?.reactions).toEqual({ '👍': ['bob@example.com'] })
      })

      it('should replace reactions from the same reactor', async () => {
        const message = createMockMessage(conversationId, { id: 'react-3', reactions: { '👍': ['bob@example.com'] } })
        await messageCache.saveMessage(message)

        await messageCache.updateMessageReactions(conversationId, 'react-3', 'bob@example.com', ['❤️'])

        const retrieved = await messageCache.getMessage('react-3')
        expect(retrieved?.reactions).toEqual({ '❤️': ['bob@example.com'] })
      })

      it('should remove all reactions from the reactor when an empty array is passed', async () => {
        const message = createMockMessage(conversationId, {
          id: 'react-4',
          reactions: { '👍': ['bob@example.com', 'carol@example.com'] },
        })
        await messageCache.saveMessage(message)

        await messageCache.updateMessageReactions(conversationId, 'react-4', 'bob@example.com', [])

        const retrieved = await messageCache.getMessage('react-4')
        expect(retrieved?.reactions).toEqual({ '👍': ['carol@example.com'] })
      })

      it('should return false when the message is not found', async () => {
        const found = await messageCache.updateMessageReactions(conversationId, 'nonexistent', 'bob@example.com', ['👍'])
        expect(found).toBe(false)
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

    describe('getMessagesAround', () => {
      // Ten messages, one minute apart, ids a0..a9 in chronological order.
      const around = (i: number) => new Date(`2024-03-01T10:0${i}:00Z`)
      async function seedTen() {
        await messageCache.saveMessages(
          Array.from({ length: 10 }, (_, i) =>
            createMockMessage(conversationId, { id: `a${i}`, timestamp: around(i) })
          )
        )
      }

      it('loads the anchor plus context above it AND the full tail through the latest', async () => {
        await seedTen()
        // Anchor a5, two messages of context above it, tail uncapped → reach a9.
        const slice = await messageCache.getMessagesAround(conversationId, { id: 'a5' }, { before: 2 })
        expect(slice.map((m) => m.id)).toEqual(['a3', 'a4', 'a5', 'a6', 'a7', 'a8', 'a9'])
      })

      it('honours an explicit forward cap (windowed load for search)', async () => {
        await seedTen()
        const slice = await messageCache.getMessagesAround(conversationId, { id: 'a5' }, { before: 2, after: 2 })
        expect(slice.map((m) => m.id)).toEqual(['a3', 'a4', 'a5', 'a6', 'a7'])
      })

      it('returns the anchor at the head when there is no older context', async () => {
        await seedTen()
        const slice = await messageCache.getMessagesAround(conversationId, { id: 'a0' }, { before: 5 })
        expect(slice[0].id).toBe('a0')
        expect(slice.map((m) => m.id)).toEqual(['a0', 'a1', 'a2', 'a3', 'a4', 'a5', 'a6', 'a7', 'a8', 'a9'])
      })

      it('returns an empty array when the anchor id is not cached', async () => {
        await seedTen()
        const slice = await messageCache.getMessagesAround(conversationId, { id: 'not-here' }, { before: 2 })
        expect(slice).toEqual([])
      })

      it('resolves the anchor by stanzaId when the id is a server stanza id', async () => {
        await messageCache.saveMessages([
          createMockMessage(conversationId, { id: 'sa0', timestamp: around(0) }),
          createMockMessage(conversationId, { id: 'sa1', stanzaId: 'stanza-anchor', timestamp: around(1) }),
          createMockMessage(conversationId, { id: 'sa2', timestamp: around(2) }),
        ])
        const slice = await messageCache.getMessagesAround(conversationId, { id: 'stanza-anchor' }, { before: 5 })
        expect(slice.map((m) => m.id)).toEqual(['sa0', 'sa1', 'sa2'])
      })
    })
  })

  describe('Room Messages', () => {
    const roomJid = 'room@conference.example.com'

    describe('saveRoomMessage', () => {
      it('should save a room message to IndexedDB', async () => {
        const message = createMockRoomMessage(roomJid, { id: 'room-1' })

        await expect(messageCache.saveRoomMessage(message)).resolves.toBeUndefined()

        const retrieved = await messageCache.getRoomMessage(roomJid, 'room-1')
        expect(retrieved).not.toBeNull()
        expect(retrieved?.id).toBe('room-1')
      })

      it('should handle messages with stanzaId', async () => {
        const message = createMockRoomMessage(roomJid, {
          id: 'room-stanza',
          stanzaId: 'room-stanza-123',
        })

        await expect(messageCache.saveRoomMessage(message)).resolves.toBeUndefined()

        const byStanzaId = await messageCache.getRoomMessageByStanzaId(roomJid, 'room-stanza-123')
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

      it('resolves true when the transaction commits', async () => {
        await expect(
          messageCache.saveRoomMessages([createMockRoomMessage(roomJid, { id: 'room-commit-1' })])
        ).resolves.toBe(true)
      })

      it('resolves true for an empty batch', async () => {
        await expect(messageCache.saveRoomMessages([])).resolves.toBe(true)
      })

      it('resolves false when the write fails', async () => {
        messageCache._resetDBForTesting()
        const original = globalThis.indexedDB
        globalThis.indexedDB = { open: () => { throw new Error('quota exceeded') } } as unknown as IDBFactory
        try {
          await expect(
            messageCache.saveRoomMessages([createMockRoomMessage(roomJid, { id: 'room-fail-1' })])
          ).resolves.toBe(false)
        } finally {
          globalThis.indexedDB = original
          messageCache._resetDBForTesting()
        }
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

        await messageCache.updateRoomMessage(roomJid, 'room-update', {
          body: 'Updated',
          isEdited: true,
        })

        const retrieved = await messageCache.getRoomMessage(roomJid, 'room-update')
        expect(retrieved?.body).toBe('Updated')
        expect(retrieved?.isEdited).toBe(true)
      })
    })

    describe('deleteRoomMessage', () => {
      it('should delete a room message', async () => {
        const message = createMockRoomMessage(roomJid, { id: 'room-delete' })
        await messageCache.saveRoomMessage(message)

        await messageCache.deleteRoomMessage(roomJid, 'room-delete')

        const retrieved = await messageCache.getRoomMessage(roomJid, 'room-delete')
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

    describe('getRoomMessagesAround', () => {
      const around = (i: number) => new Date(`2024-03-01T10:0${i}:00Z`)
      async function seedTen() {
        await messageCache.saveRoomMessages(
          Array.from({ length: 10 }, (_, i) =>
            createMockRoomMessage(roomJid, { id: `r${i}`, timestamp: around(i) })
          )
        )
      }

      it('loads the anchor plus context above it AND the full tail through the latest', async () => {
        await seedTen()
        const slice = await messageCache.getRoomMessagesAround(roomJid, { id: 'r5' }, { before: 2 })
        expect(slice.map((m) => m.id)).toEqual(['r3', 'r4', 'r5', 'r6', 'r7', 'r8', 'r9'])
      })

      it('returns an empty array when the anchor id is not cached', async () => {
        await seedTen()
        const slice = await messageCache.getRoomMessagesAround(roomJid, { id: 'not-here' }, { before: 2 })
        expect(slice).toEqual([])
      })

      // A reused nick puts two rows under one client id. The anchor carries the
      // XEP-0421 occupant-id, so the slice is centred on the row the caller meant
      // rather than on whichever copy the index returns first.
      it('centres the slice on the anchor OCCUPANT, not the first same-id row', async () => {
        const nick = `${roomJid}/alice`
        await messageCache.saveRoomMessages([
          createMockRoomMessage(roomJid, { id: 'early', timestamp: around(0) }),
          createMockRoomMessage(roomJid, { id: 'shared', from: nick, occupantId: 'occupant-a', timestamp: around(1) }),
          createMockRoomMessage(roomJid, { id: 'shared', from: nick, occupantId: 'occupant-b', timestamp: around(8) }),
          createMockRoomMessage(roomJid, { id: 'late', timestamp: around(9) }),
        ])

        const onB = await messageCache.getRoomMessagesAround(
          roomJid,
          { id: 'shared', occupantId: 'occupant-b' },
          { before: 1, after: 1 }
        )
        expect(onB.map((m) => m.occupantId ?? m.id)).toEqual(['occupant-a', 'occupant-b', 'late'])

        const onA = await messageCache.getRoomMessagesAround(
          roomJid,
          { id: 'shared', occupantId: 'occupant-a' },
          { before: 1, after: 1 }
        )
        expect(onA.map((m) => m.occupantId ?? m.id)).toEqual(['early', 'occupant-a', 'occupant-b'])
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

const rrow = (over: Partial<StoredRoomMessage> = {}): StoredRoomMessage => {
  const base = { type: 'groupchat', id: 'origin-1', roomJid: 'r@c', from: 'r@c/alice', body: 'hi', timestamp: 1000, isOutgoing: false, ...over } as StoredRoomMessage
  return { ...base, cacheKey: roomCanonicalKey(base), identityKeys: roomIdentityKeys(base), ids: [base.id], ...over } as StoredRoomMessage
}
const both = (a: StoredRoomMessage, b: StoredRoomMessage) => [mergeRoomRows(a, b), mergeRoomRows(b, a)]

describe('mergeRoomRows — commutative, associative, field-complete', () => {
  it('never downgrades decrypted content, both orders', () => {
    for (const m of both(rrow({ body: 'plaintext' }), rrow({ body: '', unsupportedEncryption: { kind: 'x' } as never }))) expect(m.body).toBe('plaintext')
  })
  it('keeps an edit from either row', () => {
    for (const m of both(rrow({ body: 'v1' }), rrow({ body: 'v2', isEdited: true, originalBody: 'v1' }))) { expect(m.isEdited).toBe(true); expect(m.body).toBe('v2') }
  })
  it('keeps a poll closure from either row', () => {
    for (const m of both(rrow({}), rrow({ pollClosed: { by: 'alice' } as never, pollClosedAt: 8000 }))) expect(m.pollClosed).toBeTruthy()
  })
  it('resolves a both-closed-with-different-records tie order-independently', () => {
    const [m1, m2] = both(
      rrow({ pollClosed: { by: 'alice' } as never, pollClosedAt: 8000 }),
      rrow({ pollClosed: { by: 'bob' } as never, pollClosedAt: 9000 })
    )
    expect(m1).toEqual(m2)
  })
  it('resolves a both-carry-a-different-deliveryError tie order-independently', () => {
    const [m1, m2] = both(
      rrow({ deliveryError: { text: 'x' } as never }),
      rrow({ deliveryError: { text: 'y' } as never })
    )
    // Both present → deterministic stableStringify-min pick, same in both orders.
    expect(m1).toEqual(m2)
    expect(m1.deliveryError).toEqual({ text: 'x' })
  })
  it('prefers the stanza-bearing timestamp, both orders', () => {
    for (const m of both(rrow({ timestamp: 5000 }), rrow({ timestamp: 4000, stanzaId: 'S' }))) expect(m.timestamp).toBe(4000)
  })
  it('unions reactions', () => {
    for (const m of both(rrow({ reactions: { a: ['alice'] } }), rrow({ reactions: { a: ['bob'], b: ['c'] } }))) { expect(new Set(m.reactions!.a)).toEqual(new Set(['alice','bob'])); expect(m.reactions!.b).toEqual(['c']) }
  })
  it('preserves a retraction from either row', () => {
    const [m] = both(rrow({}), rrow({ isRetracted: true, retractedAt: 7000 })); expect(m.isRetracted).toBe(true); expect(m.retractedAt).toBe(7000)
  })
  // isMention is set only on the live stanza path (Chat.ts) and never recomputed
  // for a MAM copy of the same message, so a merge of a live-counted row (flag
  // true) with its MAM counterpart (no flag) must not erase it. The mentioning
  // row is given a strictly LOWER decryption rank so contentOwner picks the
  // non-mentioning row as content owner in BOTH orders (contentOwner's rank
  // comparison is symmetric) — a naive `...owner` read would drop the mention
  // in both directions, which is exactly what an owner-sourced bug would do.
  // Checked in both orders because mergeRoomRows is required to be commutative.
  it('keeps isMention true from either row, in both merge orders (monotonic)', () => {
    const mentioning = rrow({ id: 'm1', isMention: true, unsupportedEncryption: { kind: 'x' } as never, body: '' })
    const mam = rrow({ id: 'm1', body: 'hi' })
    for (const m of both(mentioning, mam)) expect(m.isMention).toBe(true)
  })
  it('preserves occupant evidence when the content owner lacks it', () => {
    const tombstone = rrow({
      occupantId: 'old-occupant',
      isRetracted: true,
      body: '',
      unsupportedEncryption: { kind: 'x' } as never,
    })
    const bodyBearing = rrow({ occupantId: undefined, body: 'visible body' })

    for (const m of both(tombstone, bodyBearing)) {
      expect(m.body).toBe('visible body')
      expect(m.occupantId).toBe('old-occupant')
    }
  })
  it('clears a delivery error when either copy delivered cleanly', () => {
    expect(both(rrow({ deliveryError: { text: 'x' } as never }), rrow({}))[0].deliveryError).toBeUndefined()
  })
  it('unions identityKeys/ids and recomputes cacheKey to the highest tier', () => {
    const echo = rrow({ originId: 'O', id: 'client-1' })
    const refl = rrow({ originId: 'O', stanzaId: 'S', id: 'server-9' })
    const [m] = both(echo, refl)
    expect(m.cacheKey).toBe(roomCanonicalKey({ roomJid: 'r@c', from: 'r@c/alice', id: 'server-9', stanzaId: 'S', originId: 'O' }))
    expect(new Set(m.ids)).toEqual(new Set(['client-1','server-9']))
  })

  it('is commutative on a mixed pair with EQUAL ids', () => {
    const a = rrow({ body: 'plain', originId: 'O', id: 'client-1', timestamp: 5000, reactions: { a: ['alice'] } })
    const b = rrow({ body: '', unsupportedEncryption: { kind: 'x' } as never, stanzaId: 'S', id: 'client-1', timestamp: 4000, reactions: { a: ['bob'] } })
    expect(mergeRoomRows(a, b)).toEqual(mergeRoomRows(b, a))
  })

  // The tie the old contentOwner got wrong: identical id/body/rank/edit, DIFFERENT attachment.
  it('is commutative when rows tie on rank/body/id but differ in attachment', () => {
    const a = rrow({ id: 'x', body: 'same', attachment: { url: 'a://1' } as never })
    const b = rrow({ id: 'x', body: 'same', attachment: { url: 'a://2' } as never })
    expect(mergeRoomRows(a, b)).toEqual(mergeRoomRows(b, a))
  })

  it('is associative and order-independent across three rows', () => {
    const a = rrow({ originId: 'O', id: 'c1', timestamp: 5000, reactions: { a: ['a'] } })
    const b = rrow({ stanzaId: 'S', id: 'c2', timestamp: 4000, reactions: { r: ['b'] } })
    const c = rrow({ body: 'edited', isEdited: true, id: 'c1', timestamp: 4500, reactions: { a: ['d'] } })
    const rs = [mergeRoomRows(mergeRoomRows(a,b),c), mergeRoomRows(a,mergeRoomRows(b,c)), mergeRoomRows(mergeRoomRows(b,a),c), mergeRoomRows(mergeRoomRows(c,b),a)]
    for (const r of rs) expect(r).toEqual(rs[0])
  })

  // Direct contract check on the tiebreak's serialized input. The associativity test above
  // can't discriminate the projection from a whole-row serialization — its fixture's
  // isEdited:true row dominates by rank at every grouping, so the tiebreak is never reached.
  // This asserts the CONTRACT contentProjection relies on directly: every field mergeRoomRows
  // computes separately must be absent (those fields change value during a merge, which is
  // exactly what would break associativity if they leaked into the tiebreak serialization),
  // and representative immutable content fields must remain present.
  it('contentProjection omits every separately-merged field and keeps immutable content', () => {
    const row = rrow({
      stanzaId: 'S1',
      originId: 'O1',
      timestamp: 1234,
      reactions: { thumbsup: ['alice'] },
      isRetracted: true,
      retractedAt: 5678,
      isModerated: true,
      moderatedBy: 'mod-nick',
      moderationReason: 'spam',
      pollClosed: { by: 'alice' } as never,
      pollClosedAt: 9999,
      deliveryError: { text: 'failed' } as never,
      body: 'hello world',
      id: 'client-1',
      attachment: { url: 'a://file' } as never,
    })
    const proj = _contentProjectionForTesting(row) as Record<string, unknown>
    const projectedKeys = Object.keys(proj)

    for (const field of [
      'stanzaId', 'originId', 'timestamp', 'reactions', 'identityKeys', 'ids',
      'isRetracted', 'retractedAt', 'isModerated', 'moderatedBy', 'moderationReason',
      'pollClosed', 'pollClosedAt', 'deliveryError', 'cacheKey',
    ]) {
      expect(projectedKeys).not.toContain(field)
    }

    for (const field of ['body', 'id', 'attachment']) {
      expect(projectedKeys).toContain(field)
    }
  })

  // A control that BITES the load-bearing invariant: contentOwner's tiebreak must
  // serialize the content PROJECTION, not the whole row. The associativity test
  // above can't catch a regression to whole-row serialization (its isEdited:true row
  // dominates by rank, so the tiebreak never runs) and the contentProjection test
  // only checks the projection's SHAPE, not that contentOwner CONSUMES it — so
  // mutating contentOwner to `stableStringify(a) <= stableStringify(b)` (whole row)
  // passes both while reintroducing the associativity bug. Here three rows tie on
  // rank (all decrypted, non-empty body, isEdited:false) and differ ONLY in
  // `reactions` (a MERGED field — unioned during a merge) and `systemEvent` (a
  // CONTENT field, which contentOwner must own). The projection EXCLUDES reactions,
  // so its tiebreak sees only systemEvent and keeps row a's in EVERY grouping. A
  // whole-row tiebreak lets the unioned reactions (and the merged rows' extra keys)
  // decide first; because c's reactions are exactly a's ∪ b's keys, that choice
  // becomes grouping-dependent — e.g. (a∘b)∘c keeps a's systemEvent while a∘(b∘c)
  // keeps c's. Verified: the whole-row mutation makes this test FAIL.
  it('resolves the content winner from the projection, not the whole row (associativity control)', () => {
    const evt = (n: string) => ({ kind: 'nick-changed', oldNick: 'o', newNick: n }) as never
    const a = rrow({ body: 'same', reactions: { '1': ['n'] }, systemEvent: evt('a') })
    const b = rrow({ body: 'same', reactions: { '2': ['n'] }, systemEvent: evt('b') })
    const c = rrow({ body: 'same', reactions: { '1': ['n'], '2': ['n'] }, systemEvent: evt('c') })
    const groupings = [
      mergeRoomRows(mergeRoomRows(a, b), c),
      mergeRoomRows(a, mergeRoomRows(b, c)),
      mergeRoomRows(mergeRoomRows(b, a), c),
      mergeRoomRows(mergeRoomRows(c, b), a),
      mergeRoomRows(mergeRoomRows(a, c), b),
      mergeRoomRows(c, mergeRoomRows(a, b)),
    ]
    for (const g of groupings) {
      // Projection tiebreak keeps row a's systemEvent in every grouping (a's is the
      // lexicographically-smallest projection). A whole-row tiebreak diverges here.
      expect(g.systemEvent).toEqual(a.systemEvent)
      expect(g).toEqual(groupings[0])
    }
  })
})

describe('v4 migration — identity-resolving canonicalization (streaming)', () => {
  const JID = 'me@example.com', ROOM = 'r@c', FROM = 'r@c/alice'
  const dbName = `fluux-message-cache:${JID}`
  async function seedV3(rows: Array<Record<string, unknown>>) {
    const db = await openDB(dbName, 3, {
      upgrade(d) {
        if (!d.objectStoreNames.contains('messages')) {
          const s = d.createObjectStore('messages', { keyPath: 'id' })
          for (const [n, kp] of [['conversationId','conversationId'],['stanzaId','stanzaId'],['timestamp','timestamp'],['conv_timestamp',['conversationId','timestamp']],['encryptedPayload','encryptedPayload']] as const) s.createIndex(n, kp as never)
        }
        const r = d.createObjectStore('room-messages', { keyPath: 'cacheKey' })
        for (const [n, kp] of [['roomJid','roomJid'],['stanzaId','stanzaId'],['timestamp','timestamp'],['room_timestamp',['roomJid','timestamp']],['id','id']] as const) r.createIndex(n, kp as never)
      },
    })
    const tx = db.transaction('room-messages', 'readwrite')
    for (const row of rows) await tx.objectStore('room-messages').put(row as never)
    await tx.done; db.close()
  }
  beforeEach(() => { globalThis.indexedDB = new IDBFactory(); messageCache._resetDBForTesting(); _resetStorageScopeForTesting(); setStorageScopeJid(JID) })

  it('collapses an originId echo pair (rewritten id) into one row; both ids + stanzaId resolvable', async () => {
    await seedV3([
      { cacheKey: 'k1', originId: 'O', type: 'groupchat', id: 'client-1', roomJid: ROOM, from: FROM, body: 'hi', timestamp: 1000, isOutgoing: true },
      { cacheKey: 'k2', stanzaId: 'S', originId: 'O', type: 'groupchat', id: 'server-9', roomJid: ROOM, from: FROM, body: 'hi', timestamp: 2000, isOutgoing: true },
    ])
    const mine = (await messageCache.getRoomMessages(ROOM, {})).filter((m) => m.originId === 'O')
    expect(mine).toHaveLength(1)
    expect(mine[0].timestamp.getTime()).toBe(2000)
    expect(await messageCache.getRoomMessage(ROOM, 'client-1')).not.toBeNull()
    expect(await messageCache.getRoomMessage(ROOM, 'server-9')).not.toBeNull()
    // Room-scoped getRoomMessageByStanzaId(roomJid, stanzaId): the merged row
    // stays resolvable by its stanzaId within its own room.
    expect(await messageCache.getRoomMessageByStanzaId(ROOM, 'S')).not.toBeNull()
  })

  it('does not merge identical stanzaIds across different rooms', async () => {
    await seedV3([
      { cacheKey: 'a', stanzaId: '1', type: 'groupchat', id: 'i', roomJid: 'A@c', from: 'A@c/x', body: 'a', timestamp: 1000, isOutgoing: false },
      { cacheKey: 'b', stanzaId: '1', type: 'groupchat', id: 'i', roomJid: 'B@c', from: 'B@c/x', body: 'b', timestamp: 1000, isOutgoing: false },
    ])
    expect(await messageCache.getRoomMessages('A@c', {})).toHaveLength(1)
    expect(await messageCache.getRoomMessages('B@c', {})).toHaveLength(1)
  })

  it('does not downgrade a decrypted body during migration', async () => {
    await seedV3([
      { cacheKey: 'x', stanzaId: 'S1', type: 'groupchat', id: 'o2', roomJid: ROOM, from: FROM, body: '', unsupportedEncryption: { kind: 'x' }, timestamp: 3000, isOutgoing: false },
      { cacheKey: 'y', stanzaId: 'S1', type: 'groupchat', id: 'o2', roomJid: ROOM, from: FROM, body: 'decrypted', timestamp: 3000, isOutgoing: false },
    ])
    expect((await messageCache.getRoomMessages(ROOM, {})).find((m) => m.stanzaId === 'S1')!.body).toBe('decrypted')
  })

  it('aborts the whole upgrade if the migration throws — DB stays at v3', async () => {
    await seedV3([{ cacheKey: 'z', stanzaId: 'S9', type: 'groupchat', id: 'o9', roomJid: ROOM, from: FROM, body: 'x', timestamp: 5000, isOutgoing: false }])
    messageCache._setMigrationFaultForTesting(true)
    await expect(messageCache.getRoomMessages(ROOM, {})).resolves.toEqual([])
    messageCache._setMigrationFaultForTesting(false); messageCache._resetDBForTesting()
    const raw = await openDB(dbName)
    expect(raw.version).toBe(3)
    expect(raw.objectStoreNames.contains('room-messages-canonical')).toBe(false)
    expect(await raw.get('room-messages', 'z')).toBeTruthy()
    raw.close()
  })
})

describe('live paths — identity-resolving upsert + alias lookups + mutations', () => {
  const ROOM = 'r@c', FROM = 'r@c/alice'
  const mk = (over: Partial<RoomMessage> = {}): RoomMessage => ({ type: 'groupchat', id: 'client-1', roomJid: ROOM, from: FROM, body: 'hello', timestamp: new Date(5000), isOutgoing: true, originId: 'O', ...over }) as RoomMessage
  beforeEach(() => { globalThis.indexedDB = new IDBFactory(); messageCache._resetDBForTesting(); _resetStorageScopeForTesting() })

  it('merges a reflection (rewritten id + stanzaId) into the optimistic echo', async () => {
    await messageCache.saveRoomMessage(mk())
    await messageCache.saveRoomMessage(mk({ id: 'server-9', stanzaId: 'S', timestamp: new Date(4000) }))
    const mine = (await messageCache.getRoomMessages(ROOM, {})).filter((m) => m.originId === 'O')
    expect(mine).toHaveLength(1); expect(mine[0].timestamp.getTime()).toBe(4000)
  })
  it('the discarded optimistic id still resolves after the merge', async () => {
    await messageCache.saveRoomMessage(mk()); await messageCache.saveRoomMessage(mk({ id: 'server-9', stanzaId: 'S' }))
    expect(await messageCache.getRoomMessage(ROOM, 'client-1')).not.toBeNull()
    expect(await messageCache.getRoomMessage(ROOM, 'server-9')).not.toBeNull()
    expect(await messageCache.getRoomMessageByStanzaId(ROOM, 'S')).not.toBeNull()
  })
  it('updateRoomMessage that ADDS a stanzaId re-keys and merges with any matching row', async () => {
    // A separate MAM copy already carries stanzaId S and NO originId — so it shares
    // no identity tier with the optimistic echo (originId O, id client-1) and the two
    // stay SEPARATE at save time. If the MAM copy also carried originId O they would
    // merge on save, making updateRoomMessage a no-op and the re-key branch untested.
    await messageCache.saveRoomMessage(mk({ id: 'server-9', stanzaId: 'S', originId: undefined }))
    // ...and the optimistic row is only now confirmed via an identity-adding update.
    await messageCache.saveRoomMessage(mk()) // optimistic: originId O, no stanzaId
    await messageCache.updateRoomMessage(ROOM, 'client-1', { stanzaId: 'S', originId: 'O' })
    expect((await messageCache.getRoomMessages(ROOM, {})).filter((m) => m.originId === 'O')).toHaveLength(1)
  })
  it('updateRoomMessage that ADDS an originId (canonical key UNCHANGED) still merges a row already at that originId', async () => {
    // Row 1 has stanzaId S, no originId → canonical key stanzaId:S.
    await messageCache.saveRoomMessage(mk({ id: 'a1', stanzaId: 'S', originId: undefined }))
    // Row 2 is a separate copy already carrying originId O (no stanzaId).
    await messageCache.saveRoomMessage(mk({ id: 'a2', originId: 'O', stanzaId: undefined }))
    // Confirm row 1 also carries originId O — its canonical key stays stanzaId:S,
    // so a key-only identityChanged check would MISS this and leave two rows.
    await messageCache.updateRoomMessage(ROOM, 'a1', { originId: 'O' })
    expect((await messageCache.getRoomMessages(ROOM, {})).filter((m) => m.stanzaId === 'S' || m.originId === 'O')).toHaveLength(1)
    expect(await messageCache.getRoomMessage(ROOM, 'a1')).not.toBeNull()          // every alias
    expect(await messageCache.getRoomMessage(ROOM, 'a2')).not.toBeNull()          // preserved
    expect(await messageCache.getRoomMessageByStanzaId(ROOM, 'S')).not.toBeNull()
  })
  it('re-keys a fallback row when an occupant id is added', async () => {
    await messageCache.saveRoomMessage(mk({ originId: undefined, occupantId: undefined }))

    await messageCache.updateRoomMessage(ROOM, 'client-1', { occupantId: 'occupant-alice' })

    const stored = await messageCache.getRoomMessages(ROOM, {})
    expect(stored).toHaveLength(1)
    expect(stored[0].occupantId).toBe('occupant-alice')
  })
  it('removes a deliberately cleared stale stanzaId alias (clearMessageStanzaId)', async () => {
    await messageCache.saveRoomMessage(mk({ stanzaId: 'stale-S' })) // has stanzaId + originId O + id client-1
    await messageCache.updateRoomMessage(ROOM, 'client-1', { stanzaId: undefined }) // revoke the stanzaId
    // The scoped stanza alias must be GONE — else a later message with 'stale-S' merges wrongly.
    expect(await messageCache.getRoomMessageByStanzaId(ROOM, 'stale-S')).toBeNull()
    // ...but the message itself, and its other aliases, remain.
    expect(await messageCache.getRoomMessage(ROOM, 'client-1')).not.toBeNull()
    expect(await messageCache.getRoomMessages(ROOM, {})).toHaveLength(1)
  })
  it('updateRoomMessageReactions resolves a pre-merge id and is authoritative (does not un-remove)', async () => {
    await messageCache.saveRoomMessage(mk()); await messageCache.saveRoomMessage(mk({ id: 'server-9', stanzaId: 'S' }))
    await messageCache.updateRoomMessageReactions(ROOM, 'client-1', 'r@c/bob', ['👍'])
    expect((await messageCache.getRoomMessage(ROOM, 'server-9'))!.reactions?.['👍']).toContain('r@c/bob')
    await messageCache.updateRoomMessageReactions(ROOM, 'client-1', 'r@c/bob', []) // removal
    expect((await messageCache.getRoomMessage(ROOM, 'server-9'))!.reactions?.['👍'] ?? []).not.toContain('r@c/bob')
  })
  it('updateRoomMessageReactions resolves an origin id', async () => {
    await messageCache.saveRoomMessage(mk({ id: 'origin-reaction-target', originId: 'reaction-origin' }))
    const found = await messageCache.updateRoomMessageReactions(ROOM, 'reaction-origin', 'r@c/bob', ['👍'])
    expect(found).toBe(true)
    expect((await messageCache.getRoomMessage(ROOM, 'origin-reaction-target'))!.reactions?.['👍']).toContain('r@c/bob')
  })
  it('getRoomMessagesAround returns each logical message once', async () => {
    await messageCache.saveRoomMessage(mk({ stanzaId: 'S' }))
    expect((await messageCache.getRoomMessagesAround(ROOM, { id: 'client-1' }, { before: 5, after: 5 })).filter((m) => m.originId === 'O')).toHaveLength(1)
  })
  it('updateRoomMessageReactions on a stanza-id fallback is room-scoped — a same-stanzaId message in another room is untouched', async () => {
    // Two DIFFERENT rooms each cache a message under the SAME server-assigned
    // stanzaId (stanzaIds are per-archive, so this collision is routine). Neither
    // row is reachable via the `ids` index for this reaction (the reaction only
    // knows the stanza-id), so the lookup MUST fall through to the room-scoped
    // stanza alias — a global stanzaId index would resolve to whichever row it
    // hits first, independent of which room the reaction actually belongs to.
    const ROOM_B = 'other-room@c', FROM_B = 'other-room@c/carol'
    await messageCache.saveRoomMessage(mk({ id: 'a-room-msg', stanzaId: 'DUP', originId: undefined }))
    await messageCache.saveRoomMessage({
      type: 'groupchat', id: 'b-room-msg', roomJid: ROOM_B, from: FROM_B, body: 'hi',
      timestamp: new Date(5000), isOutgoing: false, stanzaId: 'DUP',
    } as RoomMessage)

    const ok = await messageCache.updateRoomMessageReactions(ROOM, 'DUP', 'r@c/bob', ['🔥'])
    expect(ok).toBe(true)

    const roomAMsg = (await messageCache.getRoomMessages(ROOM, {})).find((m) => m.id === 'a-room-msg')
    const roomBMsg = (await messageCache.getRoomMessages(ROOM_B, {})).find((m) => m.id === 'b-room-msg')
    expect(roomAMsg!.reactions?.['🔥']).toContain('r@c/bob')
    expect(roomBMsg!.reactions).toBeUndefined()
  })
  it('updateRoomMessageReactions is room-scoped on the CLIENT-id path — a same-id message in another room is untouched', async () => {
    // Two rooms each cache a message under the SAME client id (ids collide across
    // rooms just like stanzaIds). Here the reaction references that client id, so
    // it resolves through the store-wide `ids` index — which must be filtered to
    // this room. ROOM_B sorts before ROOM by cacheKey, so an unscoped
    // getFromIndex('ids', …) returns ROOM_B's row first and writes the reaction to
    // the wrong room.
    const ROOM_B = 'other-room@c', FROM_B = 'other-room@c/carol'
    await messageCache.saveRoomMessage(mk({ id: 'SAME', originId: undefined }))
    await messageCache.saveRoomMessage({
      type: 'groupchat', id: 'SAME', roomJid: ROOM_B, from: FROM_B, body: 'hi',
      timestamp: new Date(5000), isOutgoing: false,
    } as RoomMessage)

    const ok = await messageCache.updateRoomMessageReactions(ROOM, 'SAME', 'r@c/bob', ['🔥'])
    expect(ok).toBe(true)

    const roomAMsg = (await messageCache.getRoomMessages(ROOM, {})).find((m) => m.id === 'SAME')
    const roomBMsg = (await messageCache.getRoomMessages(ROOM_B, {})).find((m) => m.id === 'SAME')
    expect(roomAMsg!.reactions?.['🔥']).toContain('r@c/bob')
    expect(roomBMsg!.reactions).toBeUndefined()
  })
  it('getRoomMessage is room-scoped — a same-id message in another room is not returned', async () => {
    // Same client id in two rooms; the store-wide `ids` index must be filtered to
    // the requested room. ROOM_B sorts before ROOM by cacheKey, so an unscoped
    // index `get` would return ROOM_B's row for a ROOM lookup.
    const ROOM_B = 'other-room@c'
    await messageCache.saveRoomMessage(mk({ id: 'SAME', originId: undefined }))
    await messageCache.saveRoomMessage({
      type: 'groupchat', id: 'SAME', roomJid: ROOM_B, from: `${ROOM_B}/carol`, body: 'decoy',
      timestamp: new Date(5000), isOutgoing: false,
    } as RoomMessage)
    expect((await messageCache.getRoomMessage(ROOM, 'SAME'))!.from).toBe(FROM)
    expect((await messageCache.getRoomMessage(ROOM_B, 'SAME'))!.from).toBe(`${ROOM_B}/carol`)
  })
  it('getRoomMessage uses occupant evidence for a colliding room id and nick', async () => {
    await messageCache.saveRoomMessage(mk({
      id: 'SAME',
      originId: undefined,
      occupantId: 'old-occupant',
      body: 'departed',
    }))
    await messageCache.saveRoomMessage(mk({
      id: 'SAME',
      originId: undefined,
      occupantId: 'new-occupant',
      body: 'newcomer',
      timestamp: new Date(6000),
    }))

    expect((await messageCache.getRoomMessage(
      ROOM,
      'SAME',
      FROM,
      'new-occupant'
    ))?.body).toBe('newcomer')
  })
  it('does not guess between conflicting occupants without evidence', async () => {
    await messageCache.saveRoomMessage(mk({
      id: 'AMBIGUOUS',
      originId: undefined,
      stanzaId: 'OLD',
      occupantId: 'old-occupant',
    }))
    await messageCache.saveRoomMessage(mk({
      id: 'AMBIGUOUS',
      originId: undefined,
      stanzaId: 'NEW',
      occupantId: 'new-occupant',
      timestamp: new Date(6500),
    }))

    expect(await messageCache.getRoomMessage(ROOM, 'AMBIGUOUS', FROM)).toBeNull()
  })
  it('does not inherit cached retraction state across an occupant conflict', async () => {
    await messageCache.saveRoomMessage(mk({
      id: 'REUSED',
      originId: undefined,
      occupantId: 'old-occupant',
      isRetracted: true,
      body: '',
    }))
    const newcomer = mk({
      id: 'REUSED',
      originId: undefined,
      occupantId: 'new-occupant',
      body: 'visible newcomer body',
      timestamp: new Date(7000),
    })

    expect(await messageCache.areRetractedInCache([newcomer])).toEqual([false])
  })
  it('updateRoomMessage is room-scoped — a same-id message in another room is not mutated', async () => {
    // A retraction (non-identity update) targeting ROOM must not land on ROOM_B's
    // same-id message. The assertions read each room through the room-scoped
    // getRoomMessages cursor, independent of the id resolver under test.
    const ROOM_B = 'other-room@c'
    await messageCache.saveRoomMessage(mk({ id: 'SAME', originId: undefined }))
    await messageCache.saveRoomMessage({
      type: 'groupchat', id: 'SAME', roomJid: ROOM_B, from: `${ROOM_B}/carol`, body: 'hi',
      timestamp: new Date(5000), isOutgoing: false,
    } as RoomMessage)

    await messageCache.updateRoomMessage(ROOM, 'SAME', { isRetracted: true })

    const a = (await messageCache.getRoomMessages(ROOM, {})).find((m) => m.id === 'SAME')
    const b = (await messageCache.getRoomMessages(ROOM_B, {})).find((m) => m.id === 'SAME')
    expect(a!.isRetracted).toBe(true)
    expect(b!.isRetracted).toBeFalsy()
  })
  it('deleteRoomMessage is room-scoped — a same-id message in another room survives', async () => {
    const ROOM_B = 'other-room@c'
    await messageCache.saveRoomMessage(mk({ id: 'SAME', originId: undefined }))
    await messageCache.saveRoomMessage({
      type: 'groupchat', id: 'SAME', roomJid: ROOM_B, from: `${ROOM_B}/carol`, body: 'keep',
      timestamp: new Date(5000), isOutgoing: false,
    } as RoomMessage)

    await messageCache.deleteRoomMessage(ROOM, 'SAME') // delete THIS room's copy

    expect((await messageCache.getRoomMessages(ROOM_B, {})).some((m) => m.id === 'SAME')).toBe(true)
    expect((await messageCache.getRoomMessages(ROOM, {})).some((m) => m.id === 'SAME')).toBe(false)
  })
  it('getRoomMessagesAround resolves the anchor in the REQUESTED room, not a same-id decoy elsewhere', async () => {
    // ROOM holds the real anchor (t=1000) plus later fillers. ROOM_B holds a same-id
    // decoy far in the future (t=10000) whose cacheKey sorts first. An unscoped anchor
    // lookup builds the window around t=10000, dropping the real anchor at t=1000.
    const ROOM_B = 'other-room@c'
    await messageCache.saveRoomMessage(mk({ id: 'ANCH', originId: undefined, timestamp: new Date(1000) }))
    for (const [i, t] of [[1, 2000], [2, 3000], [3, 4000], [4, 5000]] as const) {
      await messageCache.saveRoomMessage(mk({ id: `f${i}`, originId: undefined, timestamp: new Date(t) }))
    }
    await messageCache.saveRoomMessage({
      type: 'groupchat', id: 'ANCH', roomJid: ROOM_B, from: `${ROOM_B}/carol`, body: 'decoy',
      timestamp: new Date(10000), isOutgoing: false,
    } as RoomMessage)

    const around = await messageCache.getRoomMessagesAround(ROOM, { id: 'ANCH' }, { before: 2, after: 2 })
    expect(around.some((m) => m.timestamp.getTime() === 1000)).toBe(true)
  })
})

// =============================================================================
// Archive count primitive (countUnreadInArchive / countRoomUnreadInArchive)
// =============================================================================

describe('countUnreadInArchive (chat)', () => {
  const CONV = 'alice@example.com'
  beforeEach(() => { globalThis.indexedDB = new IDBFactory(); messageCache._resetDBForTesting(); _resetStorageScopeForTesting() })

  it('counts renderable incoming messages after the pointer', async () => {
    await messageCache.saveMessages([
      createMockMessage(CONV, { id: 'm1', timestamp: new Date(1000), isOutgoing: false }),
      createMockMessage(CONV, { id: 'm2', timestamp: new Date(2000), isOutgoing: false }),
      createMockMessage(CONV, { id: 'm3', timestamp: new Date(3000), isOutgoing: false }),
    ])
    const res = await messageCache.countUnreadInArchive(CONV, {
      floor: new Date(1000),
      pointer: { role: 'exact', timestamp: new Date(1000).getTime(), tiebreak: { kind: 'chat', id: 'm1' } },
    })
    expect(res).toEqual({ unread: 2 })
  })

  it('excludes outgoing messages', async () => {
    await messageCache.saveMessages([
      createMockMessage(CONV, { id: 'm1', timestamp: new Date(1000), isOutgoing: false }),
      createMockMessage(CONV, { id: 'm2', timestamp: new Date(2000), isOutgoing: true }),
      createMockMessage(CONV, { id: 'm3', timestamp: new Date(3000), isOutgoing: false }),
    ])
    const res = await messageCache.countUnreadInArchive(CONV, {
      floor: new Date(1000),
      pointer: { role: 'exact', timestamp: new Date(1000).getTime(), tiebreak: { kind: 'chat', id: 'm1' } },
    })
    expect(res).toEqual({ unread: 1 })
  })

  it('excludes non-renderable (blank legacy) rows', async () => {
    await messageCache.saveMessages([
      createMockMessage(CONV, { id: 'm1', timestamp: new Date(1000), isOutgoing: false }),
      createMockMessage(CONV, { id: 'm2', timestamp: new Date(2000), isOutgoing: false, body: '' }),
      createMockMessage(CONV, { id: 'm3', timestamp: new Date(3000), isOutgoing: false }),
    ])
    const res = await messageCache.countUnreadInArchive(CONV, {
      floor: new Date(1000),
      pointer: { role: 'exact', timestamp: new Date(1000).getTime(), tiebreak: { kind: 'chat', id: 'm1' } },
    })
    expect(res).toEqual({ unread: 1 })
  })

  it('same-ms: pointer at m1@t, unread m2@t later by id, counts exactly 1', async () => {
    const t = new Date(5000)
    await messageCache.saveMessages([
      createMockMessage(CONV, { id: 'm1', timestamp: t, isOutgoing: false }),
      createMockMessage(CONV, { id: 'm2', timestamp: t, isOutgoing: false }),
    ])
    const res = await messageCache.countUnreadInArchive(CONV, {
      floor: t,
      pointer: { role: 'exact', timestamp: t.getTime(), tiebreak: { kind: 'chat', id: 'm1' } },
    })
    expect(res).toEqual({ unread: 1 })
  })

  it('saturates unread at unreadCap and stops the walk there', async () => {
    // `unreadCap` is freely parameterized, so the invariant needs rows > cap —
    // not a large archive. Ten rows against a cap of five: without the cursor
    // `break` this counts 10.
    await messageCache.saveMessages(
      Array.from({ length: 10 }, (_, i) => createMockMessage(CONV, { id: `m${i}`, timestamp: new Date(1000 + i), isOutgoing: false }))
    )
    const res = await messageCache.countUnreadInArchive(CONV, { floor: new Date(0), unreadCap: 5 })
    expect(res!.unread).toBe(5)
  })

  it('does not saturate below unreadCap — reports the true count when rows < cap', async () => {
    await messageCache.saveMessages(
      Array.from({ length: 3 }, (_, i) => createMockMessage(CONV, { id: `m${i}`, timestamp: new Date(1000 + i), isOutgoing: false }))
    )
    const res = await messageCache.countUnreadInArchive(CONV, { floor: new Date(0), unreadCap: 5 })
    expect(res!.unread).toBe(3)
  })

  it('missing tiebreak falls back to at-or-after-timestamp (over-counts, safe)', async () => {
    const t = new Date(5000)
    await messageCache.saveMessages([
      createMockMessage(CONV, { id: 'm1', timestamp: t, isOutgoing: false }),
      createMockMessage(CONV, { id: 'm2', timestamp: t, isOutgoing: false }),
      createMockMessage(CONV, { id: 'm3', timestamp: new Date(6000), isOutgoing: false }),
    ])
    // No tiebreak on the pointer (migrated legacy pointer): per isAfterBoundary,
    // a keyless boundary means at-or-after its own millisecond, so BOTH
    // m1 (the pointer's own message) and m2 (its same-ms sibling) resolve as "after"
    // the pointer — the read boundary itself gets re-counted rather than a genuinely
    // unread sibling being silently dropped. m3 (a later timestamp) counts regardless.
    const res = await messageCache.countUnreadInArchive(CONV, {
      floor: t,
      pointer: { role: 'floor', timestamp: t.getTime() },
    })
    expect(res).toEqual({ unread: 3 })
  })

  it('returns null on IndexedDB error', async () => {
    messageCache._resetDBForTesting()
    const original = globalThis.indexedDB
    globalThis.indexedDB = { open: () => { throw new Error('boom') } } as unknown as IDBFactory
    try {
      const res = await messageCache.countUnreadInArchive(CONV, { floor: new Date(0) })
      expect(res).toBeNull()
    } finally {
      globalThis.indexedDB = original
      messageCache._resetDBForTesting()
    }
  })
})

describe('countRoomUnreadInArchive (room)', () => {
  const ROOM = 'room@conference.example.com'
  beforeEach(() => { globalThis.indexedDB = new IDBFactory(); messageCache._resetDBForTesting(); _resetStorageScopeForTesting() })

  it('counts renderable incoming messages after the pointer', async () => {
    await messageCache.saveRoomMessages([
      createMockRoomMessage(ROOM, { id: 'm1', timestamp: new Date(1000), isOutgoing: false }),
      createMockRoomMessage(ROOM, { id: 'm2', timestamp: new Date(2000), isOutgoing: false }),
      createMockRoomMessage(ROOM, { id: 'm3', timestamp: new Date(3000), isOutgoing: false }),
    ])
    const res = await messageCache.countRoomUnreadInArchive(ROOM, {
      floor: new Date(1000),
      pointer: { role: 'exact', timestamp: new Date(1000).getTime(), tiebreak: { kind: 'room', from: `${ROOM}/user`, id: 'm1' } },
    })
    expect(res).toEqual({ unread: 2 })
  })

  it('excludes outgoing messages', async () => {
    await messageCache.saveRoomMessages([
      createMockRoomMessage(ROOM, { id: 'm1', timestamp: new Date(1000), isOutgoing: false }),
      createMockRoomMessage(ROOM, { id: 'm2', timestamp: new Date(2000), isOutgoing: true }),
      createMockRoomMessage(ROOM, { id: 'm3', timestamp: new Date(3000), isOutgoing: false }),
    ])
    const res = await messageCache.countRoomUnreadInArchive(ROOM, {
      floor: new Date(1000),
      pointer: { role: 'exact', timestamp: new Date(1000).getTime(), tiebreak: { kind: 'room', from: `${ROOM}/user`, id: 'm1' } },
    })
    expect(res).toEqual({ unread: 1 })
  })

  it('excludes non-renderable (blank legacy) rows', async () => {
    await messageCache.saveRoomMessages([
      createMockRoomMessage(ROOM, { id: 'm1', timestamp: new Date(1000), isOutgoing: false }),
      createMockRoomMessage(ROOM, { id: 'm2', timestamp: new Date(2000), isOutgoing: false, body: '' }),
      createMockRoomMessage(ROOM, { id: 'm3', timestamp: new Date(3000), isOutgoing: false }),
    ])
    const res = await messageCache.countRoomUnreadInArchive(ROOM, {
      floor: new Date(1000),
      pointer: { role: 'exact', timestamp: new Date(1000).getTime(), tiebreak: { kind: 'room', from: `${ROOM}/user`, id: 'm1' } },
    })
    expect(res).toEqual({ unread: 1 })
  })

  it('same-ms: pointer at m1@t (from alice), unread m2@t (from bob, sorts after) counts exactly 1', async () => {
    const t = new Date(5000)
    await messageCache.saveRoomMessages([
      createMockRoomMessage(ROOM, { id: 'm1', from: `${ROOM}/alice`, timestamp: t, isOutgoing: false }),
      createMockRoomMessage(ROOM, { id: 'm2', from: `${ROOM}/bob`, timestamp: t, isOutgoing: false }),
    ])
    const res = await messageCache.countRoomUnreadInArchive(ROOM, {
      floor: t,
      pointer: { role: 'exact', timestamp: t.getTime(), tiebreak: { kind: 'room', from: `${ROOM}/alice`, id: 'm1' } },
    })
    expect(res).toEqual({ unread: 1 })
  })

  /**
   * The nick `alice` was reassigned, so two occupants produced rows sharing this
   * room, `from`, client id and millisecond. Only the XEP-0421 occupant-id
   * separates them, and without it in the order key the walk compared them EQUAL
   * and dropped the second — a silently swallowed unread message.
   */
  it('same-ms, same from AND same id: counts the row the OTHER occupant wrote', async () => {
    const t = new Date(5000)
    const shared = { id: 'm1', from: `${ROOM}/alice`, timestamp: t, isOutgoing: false }
    await messageCache.saveRoomMessages([
      createMockRoomMessage(ROOM, { ...shared, stanzaId: 'arch-a', occupantId: 'occ-a' }),
      createMockRoomMessage(ROOM, { ...shared, stanzaId: 'arch-b', occupantId: 'occ-b' }),
    ])
    // Two rows, not one: conflicting occupant-ids block the merge.
    expect(await messageCache.getRoomMessageCount(ROOM)).toBe(2)

    const res = await messageCache.countRoomUnreadInArchive(ROOM, {
      floor: t,
      pointer: {
        role: 'exact',
        timestamp: t.getTime(),
        tiebreak: { kind: 'room', from: `${ROOM}/alice`, id: 'm1', occupantId: 'occ-a' },
      },
    })
    expect(res).toEqual({ unread: 1 })
  })

  /**
   * The same pair under a pointer written before the occupant rung existed. It
   * cannot say which row it sits on, so BOTH count: an over-count the user
   * clears by reading, never an unread message hidden for good.
   */
  it('same-ms pair under an occupant-less pointer over-counts rather than swallowing', async () => {
    const t = new Date(5000)
    const shared = { id: 'm1', from: `${ROOM}/alice`, timestamp: t, isOutgoing: false }
    await messageCache.saveRoomMessages([
      createMockRoomMessage(ROOM, { ...shared, stanzaId: 'arch-a', occupantId: 'occ-a' }),
      createMockRoomMessage(ROOM, { ...shared, stanzaId: 'arch-b', occupantId: 'occ-b' }),
    ])
    const res = await messageCache.countRoomUnreadInArchive(ROOM, {
      floor: t,
      pointer: { role: 'exact', timestamp: t.getTime(), tiebreak: { kind: 'room', from: `${ROOM}/alice`, id: 'm1' } },
    })
    expect(res).toEqual({ unread: 2 })
  })

  it('missing tiebreak falls back to at-or-after-timestamp (over-counts, safe)', async () => {
    const t = new Date(5000)
    await messageCache.saveRoomMessages([
      createMockRoomMessage(ROOM, { id: 'm1', from: `${ROOM}/alice`, timestamp: t, isOutgoing: false }),
      createMockRoomMessage(ROOM, { id: 'm2', from: `${ROOM}/bob`, timestamp: t, isOutgoing: false }),
      createMockRoomMessage(ROOM, { id: 'm3', from: `${ROOM}/bob`, timestamp: new Date(6000), isOutgoing: false }),
    ])
    // Same over-count rationale as the chat case: both same-ms rows (m1, m2) resolve
    // as "after" an unresolved pointer position; m3 counts regardless of the key.
    const res = await messageCache.countRoomUnreadInArchive(ROOM, { floor: t, pointer: { role: 'floor', timestamp: t.getTime() } })
    expect(res).toEqual({ unread: 3 })
  })

  it('saturates unread at unreadCap and stops the walk there', async () => {
    await messageCache.saveRoomMessages(
      Array.from({ length: 10 }, (_, i) =>
        createMockRoomMessage(ROOM, { id: `m${i}`, from: `${ROOM}/alice`, timestamp: new Date(1000 + i), isOutgoing: false })
      )
    )
    const res = await messageCache.countRoomUnreadInArchive(ROOM, { floor: new Date(0), unreadCap: 5 })
    expect(res!.unread).toBe(5)
  })

  it('does not saturate below unreadCap — reports the true count when rows < cap', async () => {
    await messageCache.saveRoomMessages(
      Array.from({ length: 3 }, (_, i) =>
        createMockRoomMessage(ROOM, { id: `m${i}`, from: `${ROOM}/alice`, timestamp: new Date(1000 + i), isOutgoing: false })
      )
    )
    const res = await messageCache.countRoomUnreadInArchive(ROOM, { floor: new Date(0), unreadCap: 5 })
    expect(res!.unread).toBe(3)
  })

  it('returns null on IndexedDB error', async () => {
    messageCache._resetDBForTesting()
    const original = globalThis.indexedDB
    globalThis.indexedDB = { open: () => { throw new Error('boom') } } as unknown as IDBFactory
    try {
      const res = await messageCache.countRoomUnreadInArchive(ROOM, { floor: new Date(0) })
      expect(res).toBeNull()
    } finally {
      globalThis.indexedDB = original
      messageCache._resetDBForTesting()
    }
  })
})

/**
 * Cursor-range scoping.
 *
 * `conv_timestamp` / `room_timestamp` are COMPOUND indexes keyed
 * `[entityId, timestamp]`. A half-open range over a compound key is only
 * half-scoped: `upperBound([id, t])` admits every row of every entity sorting
 * BEFORE `id`, and `lowerBound([id, t])` admits every row of every entity
 * sorting AFTER it. The read loop skips foreign rows but cannot stop on them —
 * `results.length < limit` never trips once the walk has left the entity — so
 * the cursor walks the rest of the store, one awaited `continue()` per row.
 * That is the conversation-activation stall: `getMessagesAround` issues exactly
 * these two shapes, and returning ~150 rows costs a scan of the whole archive.
 *
 * The returned ROWS are correct either way (the loop skips foreign rows), so
 * asserting on them cannot catch this. These tests assert on the key range
 * handed to `openCursor`: an unscoped range is one missing a bound, or one
 * whose bounds straddle two different entity ids.
 */
describe('cursor ranges stay scoped to one entity', () => {
  const FIRST = 'aaa@example.com'
  const MIDDLE = 'mmm@example.com'
  const LAST = 'zzz@example.com'
  const PER = 200
  const BASE = Date.UTC(2026, 0, 1)
  const ANCHOR = 100

  let ranges: IDBKeyRange[] = []
  let realOpenCursor: typeof IDBIndex.prototype.openCursor
  let scope = 0

  beforeEach(() => {
    // A distinct account scope per test = a distinct database name, so no test
    // can read another's rows however the shared connection cache behaves.
    _resetStorageScopeForTesting()
    globalThis.indexedDB = new IDBFactory()
    ;(messageCache as { _resetDBForTesting?: () => void })._resetDBForTesting?.()
    setStorageScopeJid(`scope${scope++}@example.com`)

    ranges = []
    realOpenCursor = IDBIndex.prototype.openCursor
    IDBIndex.prototype.openCursor = function (
      this: IDBIndex,
      query?: IDBValidKey | IDBKeyRange | null,
      direction?: IDBCursorDirection,
    ) {
      if (query && typeof query === 'object' && 'lower' in query) ranges.push(query as IDBKeyRange)
      else ranges.push({ lower: undefined, upper: undefined } as unknown as IDBKeyRange)
      return realOpenCursor.call(this, query, direction)
    }
  })

  afterEach(() => {
    IDBIndex.prototype.openCursor = realOpenCursor
  })

  /**
   * The range must pin BOTH ends to `entityId`. A bound that is absent, or that
   * names a different entity, lets the cursor walk out of the entity's rows.
   */
  function expectScopedTo(range: IDBKeyRange | undefined, entityId: string): void {
    expect(range).toBeDefined()
    expect(Array.isArray(range!.lower)).toBe(true)
    expect(Array.isArray(range!.upper)).toBe(true)
    expect((range!.lower as unknown[])[0]).toBe(entityId)
    expect((range!.upper as unknown[])[0]).toBe(entityId)
  }

  /** Seed and CONFIRM the rows landed — a silent seeding failure would make
   *  the assertions below pass vacuously. */
  async function seedChats(): Promise<void> {
    for (const id of [FIRST, MIDDLE, LAST]) {
      await messageCache.saveMessages(
        Array.from({ length: PER }, (_, i) =>
          createMockMessage(id, { id: `${id}-${i}`, timestamp: new Date(BASE + i * 60_000) })
        )
      )
    }
    for (const id of [FIRST, MIDDLE, LAST]) {
      expect(await messageCache.getMessageCount(id)).toBe(PER)
    }
  }

  async function seedRooms(): Promise<void> {
    for (const jid of [FIRST, MIDDLE, LAST]) {
      await messageCache.saveRoomMessages(
        Array.from({ length: PER }, (_, i) =>
          createMockRoomMessage(jid, { id: `${jid}-${i}`, timestamp: new Date(BASE + i * 60_000) })
        )
      )
    }
    for (const jid of [FIRST, MIDDLE, LAST]) {
      expect(await messageCache.getRoomMessageCount(jid)).toBe(PER)
    }
  }

  it('scopes an `after`-only read to the conversation', async () => {
    await seedChats()

    // The uncapped tail read `getMessagesAround` issues — so the read
    // `activateConversation` issues whenever the read pointer sits below the
    // latest-100 slice. FIRST sorts before every other conversation, so an
    // unscoped lowerBound walk crosses all 400 of their rows.
    ranges = []
    const tail = await messageCache.getMessages(FIRST, {
      after: new Date(BASE + ANCHOR * 60_000),
    })

    expect(tail).toHaveLength(PER - ANCHOR - 1)
    expect(tail.every((m) => m.conversationId === FIRST)).toBe(true)
    expectScopedTo(ranges[0], FIRST)
  })

  it('scopes a `before`-limited read to the conversation', async () => {
    await seedChats()

    // A limit the conversation cannot fill: only 10 rows sit at or before the
    // cutoff, so the walk never satisfies `results.length < limit` and — with an
    // unscoped upperBound — keeps descending through the 400 earlier-sorting rows.
    ranges = []
    const head = await messageCache.getMessages(LAST, {
      before: new Date(BASE + 10 * 60_000),
      limit: 51,
    })

    expect(head).toHaveLength(10)
    expect(head.every((m) => m.conversationId === LAST)).toBe(true)
    expectScopedTo(ranges[0], LAST)
  })

  it('scopes room reads the same way (room_timestamp is compound too)', async () => {
    await seedRooms()

    ranges = []
    const tail = await messageCache.getRoomMessages(FIRST, {
      after: new Date(BASE + ANCHOR * 60_000),
    })
    expect(tail).toHaveLength(PER - ANCHOR - 1)
    expect(tail.every((m) => m.roomJid === FIRST)).toBe(true)
    expectScopedTo(ranges[0], FIRST)

    ranges = []
    const head = await messageCache.getRoomMessages(LAST, {
      before: new Date(BASE + 10 * 60_000),
      limit: 51,
    })
    expect(head).toHaveLength(10)
    expect(head.every((m) => m.roomJid === LAST)).toBe(true)
    expectScopedTo(ranges[0], LAST)
  })

  it('leaves the already-scoped read shapes alone', async () => {
    await seedChats()

    ranges = []
    await messageCache.getMessages(FIRST, { limit: 100, latest: true })
    expectScopedTo(ranges[0], FIRST)

    ranges = []
    await messageCache.getMessages(FIRST, {
      after: new Date(BASE),
      before: new Date(BASE + 10 * 60_000),
    })
    expectScopedTo(ranges[0], FIRST)
  })
})
