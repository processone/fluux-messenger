import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import 'fake-indexeddb/auto'
import { IDBFactory } from 'fake-indexeddb'
import type { Message, RoomMessage } from '../core/types'
import { setStorageScopeJid, _resetStorageScopeForTesting } from './storageScope'

// Must import after fake-indexeddb/auto
import {
  initSearchIndex,
  indexMessage,
  indexMessages,
  removeMessage,
  updateMessage,
  search,
  backfillFromMessageCache,
  rebuildSearchIndex,
  clearSearchIndex,
  closeSearchIndex,
  tokenize,
  _resetDBForTesting,
} from './searchIndex'
import { _resetDBForTesting as _resetMessageCacheDB, flushPendingRoomMessages } from './messageCache'

// =============================================================================
// Test helpers
// =============================================================================

function createChatMessage(conversationId: string, overrides: Partial<Message> = {}): Message {
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

function createRoomMessage(roomJid: string, overrides: Partial<RoomMessage> = {}): RoomMessage {
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

// =============================================================================
// Tests
// =============================================================================

describe('searchIndex', () => {
  beforeEach(() => {
    _resetStorageScopeForTesting()
    globalThis.indexedDB = new IDBFactory()
    _resetDBForTesting()
    _resetMessageCacheDB()
    setStorageScopeJid('test@example.com')
  })

  afterEach(async () => {
    await closeSearchIndex()
  })

  // ===========================================================================
  // tokenize
  // ===========================================================================

  describe('tokenize', () => {
    it('should split text into lowercase tokens', () => {
      expect(tokenize('Hello World')).toEqual(['hello', 'world'])
    })

    it('should drop single-character tokens', () => {
      expect(tokenize('I am a test')).toEqual(['am', 'test'])
    })

    it('should handle punctuation', () => {
      expect(tokenize('hello, world! how are you?')).toEqual(['hello', 'world', 'how', 'are', 'you'])
    })

    it('should handle empty string', () => {
      expect(tokenize('')).toEqual([])
    })

    it('should handle unicode text', () => {
      expect(tokenize('café résumé')).toEqual(['café', 'résumé'])
    })

    it('should split on hyphens and underscores', () => {
      expect(tokenize('well-known under_score')).toEqual(['well', 'known', 'under', 'score'])
    })
  })

  // ===========================================================================
  // indexMessage + search
  // ===========================================================================

  describe('indexMessage and search', () => {
    it('should index a chat message and find it by keyword', async () => {
      const msg = createChatMessage('alice@example.com', {
        id: 'chat-msg-42',
        body: 'Hello world from Alice',
      })

      await indexMessage(msg)

      const results = await search('hello')
      expect(results).toHaveLength(1)
      expect(results[0].body).toBe('Hello world from Alice')
      expect(results[0].conversationId).toBe('alice@example.com')
      expect(results[0].messageId).toBe('chat-msg-42')
      expect(results[0].isRoom).toBe(false)
    })

    it('should index a room message and find it', async () => {
      const msg = createRoomMessage('room@conference.example.com', {
        id: 'room-msg-77',
        body: 'Meeting notes for today',
        stanzaId: 'stanza-123',
      })

      await indexMessage(msg)

      const results = await search('meeting')
      expect(results).toHaveLength(1)
      expect(results[0].conversationId).toBe('room@conference.example.com')
      expect(results[0].isRoom).toBe(true)
      expect(results[0].messageId).toBe('room-msg-77')
    })

    it('should find messages matching ALL query terms (AND logic)', async () => {
      await indexMessage(createChatMessage('alice@example.com', {
        body: 'The quick brown fox',
      }))
      await indexMessage(createChatMessage('bob@example.com', {
        body: 'The quick red car',
      }))

      const results = await search('quick brown')
      expect(results).toHaveLength(1)
      expect(results[0].body).toBe('The quick brown fox')
    })

    it('should support prefix matching on the last query term', async () => {
      await indexMessage(createChatMessage('alice@example.com', {
        body: 'conversation about coffee',
      }))

      const results = await search('coff')
      expect(results).toHaveLength(1)
      expect(results[0].body).toBe('conversation about coffee')
    })

    it('should support prefix matching with multi-word queries', async () => {
      await indexMessage(createChatMessage('alice@example.com', {
        body: 'quarterly report deadline approaching',
      }))
      await indexMessage(createChatMessage('bob@example.com', {
        body: 'quarterly earnings report',
      }))

      // 'quarterly' exact, 'rep' prefix → matches both
      const results = await search('quarterly rep')
      expect(results).toHaveLength(2)
    })

    it('should return empty for non-matching query', async () => {
      await indexMessage(createChatMessage('alice@example.com', {
        body: 'Hello world',
      }))

      const results = await search('nonexistent')
      expect(results).toHaveLength(0)
    })

    it('should return empty for empty query', async () => {
      await indexMessage(createChatMessage('alice@example.com', {
        body: 'Hello world',
      }))

      const results = await search('')
      expect(results).toHaveLength(0)
    })

    it('should return empty for single-char query', async () => {
      await indexMessage(createChatMessage('alice@example.com', {
        body: 'Hello world',
      }))

      // Single char tokens are filtered out
      const results = await search('h')
      expect(results).toHaveLength(0)
    })

    it('should be case-insensitive', async () => {
      await indexMessage(createChatMessage('alice@example.com', {
        body: 'HELLO World',
      }))

      const results = await search('hello')
      expect(results).toHaveLength(1)
    })
  })

  // ===========================================================================
  // Result ordering and limits
  // ===========================================================================

  describe('result ordering and limits', () => {
    it('should sort results by timestamp descending (newest first)', async () => {
      const older = new Date('2024-01-01T10:00:00Z')
      const newer = new Date('2024-06-01T10:00:00Z')

      await indexMessage(createChatMessage('alice@example.com', {
        id: 'old-msg',
        body: 'hello from the past',
        timestamp: older,
      }))
      await indexMessage(createChatMessage('alice@example.com', {
        id: 'new-msg',
        body: 'hello from the future',
        timestamp: newer,
      }))

      const results = await search('hello')
      expect(results).toHaveLength(2)
      expect(results[0].timestamp).toBe(newer.getTime())
      expect(results[1].timestamp).toBe(older.getTime())
    })

    it('should respect limit option', async () => {
      for (let i = 0; i < 10; i++) {
        await indexMessage(createChatMessage('alice@example.com', {
          id: `msg-${i}`,
          body: `test message number ${i}`,
          timestamp: new Date(Date.now() - i * 1000),
        }))
      }

      const results = await search('test', { limit: 3 })
      expect(results).toHaveLength(3)
    })
  })

  // ===========================================================================
  // Conversation filtering
  // ===========================================================================

  describe('conversation filtering', () => {
    it('should filter results by conversationId', async () => {
      await indexMessage(createChatMessage('alice@example.com', {
        body: 'secret plans for lunch',
      }))
      await indexMessage(createChatMessage('bob@example.com', {
        body: 'secret meeting agenda',
      }))

      const results = await search('secret', { conversationId: 'alice@example.com' })
      expect(results).toHaveLength(1)
      expect(results[0].conversationId).toBe('alice@example.com')
    })

    it('should filter room messages by roomJid', async () => {
      await indexMessage(createRoomMessage('dev@conference.example.com', {
        body: 'deploy the feature branch',
        stanzaId: 'stanza-1',
      }))
      await indexMessage(createRoomMessage('general@conference.example.com', {
        body: 'deploy to production',
        stanzaId: 'stanza-2',
      }))

      const results = await search('deploy', { conversationId: 'dev@conference.example.com' })
      expect(results).toHaveLength(1)
      expect(results[0].conversationId).toBe('dev@conference.example.com')
    })
  })

  // ===========================================================================
  // Idempotency and deduplication
  // ===========================================================================

  describe('idempotency', () => {
    it('should not duplicate when indexing the same message twice', async () => {
      const msg = createChatMessage('alice@example.com', {
        id: 'same-id',
        body: 'Hello world',
      })

      await indexMessage(msg)
      await indexMessage(msg)

      const results = await search('hello')
      expect(results).toHaveLength(1)
    })
  })

  // ===========================================================================
  // Skipped messages
  // ===========================================================================

  describe('message filtering', () => {
    it('should skip messages with no body', async () => {
      await indexMessage(createChatMessage('alice@example.com', {
        body: '',
      }))

      const results = await search('')
      expect(results).toHaveLength(0)
    })

    it('should skip retracted messages', async () => {
      await indexMessage(createChatMessage('alice@example.com', {
        body: 'This was retracted',
        isRetracted: true,
      }))

      const results = await search('retracted')
      expect(results).toHaveLength(0)
    })

    it('should skip noStore messages', async () => {
      await indexMessage(createChatMessage('alice@example.com', {
        body: 'Ephemeral message',
        noStore: true,
      }))

      const results = await search('ephemeral')
      expect(results).toHaveLength(0)
    })
  })

  // ===========================================================================
  // removeMessage
  // ===========================================================================

  describe('removeMessage', () => {
    it('should remove a message from the index', async () => {
      const msg = createChatMessage('alice@example.com', {
        body: 'Temporary message',
      })

      await indexMessage(msg)
      expect(await search('temporary')).toHaveLength(1)

      await removeMessage(msg)
      expect(await search('temporary')).toHaveLength(0)
    })

    it('should not affect other messages when removing one', async () => {
      const msg1 = createChatMessage('alice@example.com', {
        body: 'Keep this hello',
      })
      const msg2 = createChatMessage('bob@example.com', {
        body: 'Remove this hello',
      })

      await indexMessage(msg1)
      await indexMessage(msg2)
      expect(await search('hello')).toHaveLength(2)

      await removeMessage(msg2)
      const results = await search('hello')
      expect(results).toHaveLength(1)
      expect(results[0].conversationId).toBe('alice@example.com')
    })

    it('should handle removing non-existent message gracefully', async () => {
      const msg = createChatMessage('alice@example.com', {
        body: 'Never indexed',
      })

      // Should not throw
      await removeMessage(msg)
    })
  })

  // ===========================================================================
  // updateMessage
  // ===========================================================================

  describe('updateMessage', () => {
    it('should update the body of a corrected message', async () => {
      const msg = createChatMessage('alice@example.com', {
        id: 'correctable',
        body: 'Original text',
      })

      await indexMessage(msg)
      expect(await search('original')).toHaveLength(1)

      const corrected = { ...msg, body: 'Corrected text', isEdited: true }
      await updateMessage(corrected)

      expect(await search('original')).toHaveLength(0)
      expect(await search('corrected')).toHaveLength(1)
    })
  })

  // ===========================================================================
  // indexMessages (batch)
  // ===========================================================================

  describe('indexMessages (batch)', () => {
    it('should index multiple messages in one call', async () => {
      const messages = [
        createChatMessage('alice@example.com', { body: 'Batch message one' }),
        createChatMessage('alice@example.com', { body: 'Batch message two' }),
        createChatMessage('bob@example.com', { body: 'Batch message three' }),
      ]

      await indexMessages(messages)

      const results = await search('batch')
      expect(results).toHaveLength(3)
    })

    it('should skip non-indexable messages in batch', async () => {
      const messages = [
        createChatMessage('alice@example.com', { body: 'Valid message' }),
        createChatMessage('alice@example.com', { body: '', }), // empty body
        createChatMessage('alice@example.com', { body: 'Retracted', isRetracted: true }),
        createChatMessage('alice@example.com', { body: 'No store', noStore: true }),
      ]

      await indexMessages(messages)

      const results = await search('message')
      expect(results).toHaveLength(1)
    })

    it('should handle empty array', async () => {
      await indexMessages([])
      // Should not throw
    })
  })

  // ===========================================================================
  // Multi-account isolation
  // ===========================================================================

  describe('multi-account isolation', () => {
    it('should isolate search indexes per account', async () => {
      // Index as alice
      setStorageScopeJid('alice@example.com')
      _resetDBForTesting()
      await indexMessage(createChatMessage('friend@example.com', {
        body: 'Alice private message',
      }))

      // Switch to bob
      await closeSearchIndex()
      setStorageScopeJid('bob@example.com')
      _resetDBForTesting()
      await indexMessage(createChatMessage('friend@example.com', {
        body: 'Bob private message',
      }))

      // Search as bob should only find bob's message
      const bobResults = await search('private')
      expect(bobResults).toHaveLength(1)
      expect(bobResults[0].body).toBe('Bob private message')

      // Switch back to alice
      await closeSearchIndex()
      setStorageScopeJid('alice@example.com')
      _resetDBForTesting()
      const aliceResults = await search('private')
      expect(aliceResults).toHaveLength(1)
      expect(aliceResults[0].body).toBe('Alice private message')
    })
  })

  // ===========================================================================
  // Mixed chat and room messages
  // ===========================================================================

  describe('mixed message types', () => {
    it('should search across both chat and room messages', async () => {
      await indexMessage(createChatMessage('alice@example.com', {
        body: 'project update from DM',
      }))
      await indexMessage(createRoomMessage('dev@conference.example.com', {
        body: 'project update from room',
        stanzaId: 'stanza-room-1',
      }))

      const results = await search('project update')
      expect(results).toHaveLength(2)

      const roomResult = results.find((r) => r.isRoom)
      const chatResult = results.find((r) => !r.isRoom)
      expect(roomResult).toBeDefined()
      expect(chatResult).toBeDefined()
    })
  })

  // ===========================================================================
  // initSearchIndex
  // ===========================================================================

  describe('initSearchIndex', () => {
    it('should create the database without errors', async () => {
      await closeSearchIndex()
      _resetDBForTesting()
      await expect(initSearchIndex('user@example.com')).resolves.not.toThrow()
    })
  })

  // ===========================================================================
  // backfillFromMessageCache
  // ===========================================================================

  describe('backfillFromMessageCache', () => {
    // We need to populate the messageCache IDB directly, then call backfill.
    // Import messageCache after fake-indexeddb is set up.
    let messageCache: typeof import('./messageCache')

    beforeEach(async () => {
      messageCache = await import('./messageCache')
    })

    it('should index existing chat messages from messageCache', async () => {
      // Seed messageCache with some messages
      await messageCache.saveMessage(createChatMessage('alice@example.com', {
        id: 'old-chat-1',
        body: 'Historical chat message one',
      }))
      await messageCache.saveMessage(createChatMessage('bob@example.com', {
        id: 'old-chat-2',
        body: 'Historical chat message two',
      }))

      await backfillFromMessageCache()

      const results = await search('historical')
      expect(results).toHaveLength(2)
    })

    it('should index existing room messages from messageCache', async () => {
      await messageCache.saveRoomMessage(createRoomMessage('dev@conference.example.com', {
        id: 'old-room-1',
        stanzaId: 'stanza-old-1',
        body: 'Historical room discussion',
      }))
      await flushPendingRoomMessages()

      await backfillFromMessageCache()

      const results = await search('discussion')
      expect(results).toHaveLength(1)
      expect(results[0].isRoom).toBe(true)
    })

    it('should not run twice (idempotent)', async () => {
      await messageCache.saveMessage(createChatMessage('alice@example.com', {
        id: 'backfill-msg',
        body: 'Backfill test message',
      }))

      await backfillFromMessageCache()
      expect(await search('backfill')).toHaveLength(1)

      // Add another message to messageCache after backfill
      await messageCache.saveMessage(createChatMessage('alice@example.com', {
        id: 'post-backfill-msg',
        body: 'Post backfill only message',
      }))

      // Second backfill should be a no-op (flag is set)
      await backfillFromMessageCache()

      // The post-backfill message should NOT be in the index
      // (it was added to messageCache after backfill, and backfill didn't re-run)
      expect(await search('post backfill only')).toHaveLength(0)
    })

    it('should handle mixed chat and room messages', async () => {
      await messageCache.saveMessage(createChatMessage('alice@example.com', {
        id: 'mixed-chat',
        body: 'Searchable content in chat',
      }))
      await messageCache.saveRoomMessage(createRoomMessage('room@conference.example.com', {
        id: 'mixed-room',
        stanzaId: 'stanza-mixed',
        body: 'Searchable content in room',
      }))
      await flushPendingRoomMessages()

      await backfillFromMessageCache()

      const results = await search('searchable content')
      expect(results).toHaveLength(2)
    })

    it('should handle empty messageCache gracefully', async () => {
      await backfillFromMessageCache()

      const results = await search('anything')
      expect(results).toHaveLength(0)
    })
  })

  // ===========================================================================
  // rebuildSearchIndex
  // ===========================================================================

  describe('rebuildSearchIndex', () => {
    let messageCache: typeof import('./messageCache')

    beforeEach(async () => {
      messageCache = await import('./messageCache')
    })

    it('should clear existing index and re-index from messageCache', async () => {
      // Index a message directly
      await indexMessage(createChatMessage('alice@example.com', {
        id: 'direct-indexed',
        body: 'Directly indexed message',
      }))
      expect(await search('directly')).toHaveLength(1)

      // Seed messageCache with different messages
      await messageCache.saveMessage(createChatMessage('bob@example.com', {
        id: 'cache-msg',
        body: 'Message from cache only',
      }))

      // Rebuild: should clear the direct-indexed message and only have cache messages
      const count = await rebuildSearchIndex()

      // The directly indexed message is NOT in messageCache, so it's gone
      expect(await search('directly')).toHaveLength(0)
      // The cache message should now be indexed
      expect(await search('cache')).toHaveLength(1)
      expect(count).toBe(1)
    })

    it('should return total count of messages indexed', async () => {
      await messageCache.saveMessage(createChatMessage('alice@example.com', {
        id: 'count-1', body: 'First message',
      }))
      await messageCache.saveMessage(createChatMessage('alice@example.com', {
        id: 'count-2', body: 'Second message',
      }))
      await messageCache.saveRoomMessage(createRoomMessage('room@conference.example.com', {
        id: 'count-3', stanzaId: 'stanza-count-3', body: 'Third message',
      }))
      await flushPendingRoomMessages()

      const count = await rebuildSearchIndex()
      expect(count).toBe(3)
    })

    it('should allow backfill to run again after rebuild', async () => {
      // First backfill
      await messageCache.saveMessage(createChatMessage('alice@example.com', {
        id: 'phase1', body: 'Phase one message',
      }))
      await backfillFromMessageCache()
      expect(await search('phase')).toHaveLength(1)

      // Add more messages
      await messageCache.saveMessage(createChatMessage('alice@example.com', {
        id: 'phase2', body: 'Phase two message',
      }))

      // Rebuild clears everything and re-indexes all
      await rebuildSearchIndex()

      // Both messages should be found (rebuild re-indexed everything)
      expect(await search('phase')).toHaveLength(2)
    })

    it('should handle empty messageCache', async () => {
      // Index something first
      await indexMessage(createChatMessage('alice@example.com', {
        body: 'Will be cleared',
      }))

      const count = await rebuildSearchIndex()
      expect(count).toBe(0)
      expect(await search('cleared')).toHaveLength(0)
    })

    it('should complete when message count exceeds batch size', async () => {
      // Populate messageCache with more messages than BACKFILL_BATCH_SIZE (500).
      // This exercises the batch-flush path in iterateAllMessages: the IDB
      // read transaction must not expire while onBatch writes to the search
      // index database.
      const totalMessages = 520
      for (let i = 0; i < totalMessages; i++) {
        await messageCache.saveMessage(createChatMessage('alice@example.com', {
          id: `bulk-${i}`,
          body: `Searchable bulk message number ${i}`,
          timestamp: new Date(Date.now() - i * 1000),
        }))
      }

      const count = await rebuildSearchIndex()

      expect(count).toBe(totalMessages)
      // Verify messages are actually searchable
      const results = await search('searchable bulk', { limit: totalMessages })
      expect(results.length).toBeGreaterThan(0)
    })

    it('should complete when room message count exceeds batch size', async () => {
      const totalMessages = 520
      for (let i = 0; i < totalMessages; i++) {
        await messageCache.saveRoomMessage(createRoomMessage('dev@conference.example.com', {
          id: `bulk-room-${i}`,
          stanzaId: `stanza-bulk-${i}`,
          body: `Searchable bulk room message ${i}`,
          timestamp: new Date(Date.now() - i * 1000),
        }))
      }
      await flushPendingRoomMessages()

      const count = await rebuildSearchIndex()

      expect(count).toBe(totalMessages)
      const results = await search('searchable bulk room', { limit: totalMessages })
      expect(results.length).toBeGreaterThan(0)
    })

    it('should invoke onProgress callback with indexed count and total', async () => {
      await messageCache.saveMessage(createChatMessage('alice@example.com', {
        id: 'prog-1', body: 'First progress message',
      }))
      await messageCache.saveMessage(createChatMessage('bob@example.com', {
        id: 'prog-2', body: 'Second progress message',
      }))
      await messageCache.saveRoomMessage(createRoomMessage('room@conference.example.com', {
        id: 'prog-3', stanzaId: 'stanza-prog-3', body: 'Third progress message',
      }))
      await flushPendingRoomMessages()

      const progressUpdates: Array<{ indexed: number; total: number }> = []
      await rebuildSearchIndex((p) => progressUpdates.push({ ...p }))

      // Should have received at least one progress update per batch (chat + room)
      expect(progressUpdates.length).toBeGreaterThanOrEqual(2)
      // All updates should report the same total
      expect(progressUpdates.every((p) => p.total === 3)).toBe(true)
      // Last update should have indexed all messages
      expect(progressUpdates[progressUpdates.length - 1].indexed).toBe(3)
      // Indexed should be monotonically increasing
      for (let i = 1; i < progressUpdates.length; i++) {
        expect(progressUpdates[i].indexed).toBeGreaterThanOrEqual(progressUpdates[i - 1].indexed)
      }
    })

    it('should not fail when onProgress is not provided', async () => {
      await messageCache.saveMessage(createChatMessage('alice@example.com', {
        id: 'no-prog', body: 'No progress callback',
      }))

      // Should work without onProgress (backward compat)
      const count = await rebuildSearchIndex()
      expect(count).toBe(1)
    })
  })

  // ===========================================================================
  // clearSearchIndex
  // ===========================================================================

  describe('clearSearchIndex', () => {
    it('should wipe all indexed data', async () => {
      await indexMessage(createChatMessage('alice@example.com', {
        body: 'Message to be wiped',
      }))
      await indexMessage(createRoomMessage('room@conference.example.com', {
        body: 'Room message to be wiped',
        stanzaId: 'stanza-wipe',
      }))
      expect(await search('wiped')).toHaveLength(2)

      await clearSearchIndex()

      expect(await search('wiped')).toHaveLength(0)
    })

    it('should reset the backfill flag so backfill can run again', async () => {
      // Run backfill to set the flag
      await backfillFromMessageCache()

      await clearSearchIndex()

      // Seed messageCache with a message after clear
      const messageCache = await import('./messageCache')
      await messageCache.saveMessage(createChatMessage('alice@example.com', {
        id: 'post-clear',
        body: 'Post clear backfill message',
      }))

      // Backfill should run again since flag was cleared
      await backfillFromMessageCache()
      expect(await search('post clear')).toHaveLength(1)
    })

    it('should not throw on empty index', async () => {
      await clearSearchIndex()
      // Should not throw
    })
  })
})
