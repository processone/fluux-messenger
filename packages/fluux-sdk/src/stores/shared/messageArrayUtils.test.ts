import { describe, it, expect } from 'vitest'
import {
  deduplicateMessages,
  buildMessageKeySet,
  isMessageDuplicate,
  sortMessagesByTimestamp,
  trimMessages,
  mergeAndProcessMessages,
  prependOlderMessages,
} from './messageArrayUtils'

// Test message type
interface TestMessage {
  id: string
  stanzaId?: string
  originId?: string
  from: string
  body: string
  timestamp: Date
}

// Helper to create test messages
function createMessage(
  id: string,
  body: string,
  timestamp: Date,
  options?: { stanzaId?: string; originId?: string; from?: string }
): TestMessage {
  return {
    id,
    body,
    timestamp,
    from: options?.from ?? 'user@example.com',
    stanzaId: options?.stanzaId,
    originId: options?.originId,
  }
}

describe('messageArrayUtils', () => {
  describe('deduplicateMessages', () => {
    it('should filter out messages with duplicate keys', () => {
      const existing = [
        createMessage('msg-1', 'Hello', new Date('2024-01-15T10:00:00Z')),
        createMessage('msg-2', 'World', new Date('2024-01-15T11:00:00Z')),
      ]
      const incoming = [
        createMessage('msg-2', 'World (dupe)', new Date('2024-01-15T11:00:00Z')),
        createMessage('msg-3', 'New', new Date('2024-01-15T12:00:00Z')),
      ]

      const result = deduplicateMessages(existing, incoming, (m) => m.id)

      expect(result).toHaveLength(1)
      expect(result[0].id).toBe('msg-3')
    })

    it('should return all incoming messages when no duplicates', () => {
      const existing = [createMessage('msg-1', 'Hello', new Date())]
      const incoming = [
        createMessage('msg-2', 'World', new Date()),
        createMessage('msg-3', 'New', new Date()),
      ]

      const result = deduplicateMessages(existing, incoming, (m) => m.id)

      expect(result).toHaveLength(2)
    })

    it('should return empty array when all incoming are duplicates', () => {
      const existing = [
        createMessage('msg-1', 'Hello', new Date()),
        createMessage('msg-2', 'World', new Date()),
      ]
      const incoming = [
        createMessage('msg-1', 'Hello (dupe)', new Date()),
        createMessage('msg-2', 'World (dupe)', new Date()),
      ]

      const result = deduplicateMessages(existing, incoming, (m) => m.id)

      expect(result).toHaveLength(0)
    })

    it('should work with custom key functions', () => {
      const existing = [
        createMessage('a', 'Hello', new Date(), { from: 'alice@example.com' }),
      ]
      const incoming = [
        createMessage('a', 'Dupe', new Date(), { from: 'alice@example.com' }),
        createMessage('a', 'Different', new Date(), { from: 'bob@example.com' }),
      ]

      // Key by from+id combo
      const result = deduplicateMessages(
        existing,
        incoming,
        (m) => `${m.from}:${m.id}`
      )

      expect(result).toHaveLength(1)
      expect(result[0].from).toBe('bob@example.com')
    })
  })

  describe('buildMessageKeySet', () => {
    it('should build set with single key per message', () => {
      const messages = [
        createMessage('msg-1', 'Hello', new Date()),
        createMessage('msg-2', 'World', new Date()),
      ]

      const keySet = buildMessageKeySet(messages, (m) => [m.id])

      expect(keySet.size).toBe(2)
      expect(keySet.has('msg-1')).toBe(true)
      expect(keySet.has('msg-2')).toBe(true)
    })

    it('should build set with multiple keys per message', () => {
      const messages = [
        createMessage('msg-1', 'Hello', new Date(), { stanzaId: 'stanza-1' }),
      ]

      const keySet = buildMessageKeySet(messages, (m) => {
        const keys = [`id:${m.id}`]
        if (m.stanzaId) keys.push(`stanzaId:${m.stanzaId}`)
        return keys
      })

      expect(keySet.size).toBe(2)
      expect(keySet.has('id:msg-1')).toBe(true)
      expect(keySet.has('stanzaId:stanza-1')).toBe(true)
    })

    it('should handle empty array', () => {
      const keySet = buildMessageKeySet([], (m: TestMessage) => [m.id])
      expect(keySet.size).toBe(0)
    })
  })

  describe('isMessageDuplicate', () => {
    it('should return true when any key matches', () => {
      const keySet = new Set(['stanzaId:abc', 'id:msg-1'])
      const message = createMessage('msg-2', 'Test', new Date(), { stanzaId: 'abc' })

      const result = isMessageDuplicate(message, keySet, (m) => {
        const keys = [`id:${m.id}`]
        if (m.stanzaId) keys.push(`stanzaId:${m.stanzaId}`)
        return keys
      })

      expect(result).toBe(true)
    })

    it('should return false when no keys match', () => {
      const keySet = new Set(['stanzaId:abc', 'id:msg-1'])
      const message = createMessage('msg-2', 'Test', new Date(), { stanzaId: 'xyz' })

      const result = isMessageDuplicate(message, keySet, (m) => {
        const keys = [`id:${m.id}`]
        if (m.stanzaId) keys.push(`stanzaId:${m.stanzaId}`)
        return keys
      })

      expect(result).toBe(false)
    })
  })

  describe('sortMessagesByTimestamp', () => {
    it('should sort messages by timestamp ascending', () => {
      const messages = [
        createMessage('msg-3', 'Third', new Date('2024-01-15T12:00:00Z')),
        createMessage('msg-1', 'First', new Date('2024-01-15T10:00:00Z')),
        createMessage('msg-2', 'Second', new Date('2024-01-15T11:00:00Z')),
      ]

      const sorted = sortMessagesByTimestamp(messages)

      expect(sorted[0].id).toBe('msg-1')
      expect(sorted[1].id).toBe('msg-2')
      expect(sorted[2].id).toBe('msg-3')
    })

    it('should not mutate original array', () => {
      const messages = [
        createMessage('msg-2', 'Second', new Date('2024-01-15T11:00:00Z')),
        createMessage('msg-1', 'First', new Date('2024-01-15T10:00:00Z')),
      ]
      const originalFirst = messages[0]

      sortMessagesByTimestamp(messages)

      expect(messages[0]).toBe(originalFirst)
    })

    it('should handle empty array', () => {
      const sorted = sortMessagesByTimestamp([])
      expect(sorted).toHaveLength(0)
    })

    it('should handle single message', () => {
      const messages = [createMessage('msg-1', 'Only', new Date())]
      const sorted = sortMessagesByTimestamp(messages)
      expect(sorted).toHaveLength(1)
      expect(sorted[0].id).toBe('msg-1')
    })
  })

  describe('trimMessages', () => {
    it('should keep only the most recent messages', () => {
      const messages = [
        createMessage('msg-1', 'Oldest', new Date('2024-01-15T10:00:00Z')),
        createMessage('msg-2', 'Middle', new Date('2024-01-15T11:00:00Z')),
        createMessage('msg-3', 'Newest', new Date('2024-01-15T12:00:00Z')),
      ]

      const trimmed = trimMessages(messages, 2)

      expect(trimmed).toHaveLength(2)
      expect(trimmed[0].id).toBe('msg-2')
      expect(trimmed[1].id).toBe('msg-3')
    })

    it('should return all messages when under limit', () => {
      const messages = [
        createMessage('msg-1', 'First', new Date()),
        createMessage('msg-2', 'Second', new Date()),
      ]

      const trimmed = trimMessages(messages, 5)

      expect(trimmed).toHaveLength(2)
    })

    it('should return same array reference when under limit', () => {
      const messages = [createMessage('msg-1', 'First', new Date())]
      const trimmed = trimMessages(messages, 5)
      expect(trimmed).toBe(messages)
    })

    it('should handle empty array', () => {
      const trimmed = trimMessages([], 5)
      expect(trimmed).toHaveLength(0)
    })

    it('should handle maxCount of 0', () => {
      const messages = [createMessage('msg-1', 'First', new Date())]
      const trimmed = trimMessages(messages, 0)
      expect(trimmed).toHaveLength(0)
    })
  })

  describe('mergeAndProcessMessages', () => {
    it('should merge, deduplicate, and sort messages', () => {
      const existing = [
        createMessage('msg-2', 'Existing', new Date('2024-01-15T11:00:00Z')),
      ]
      const incoming = [
        createMessage('msg-1', 'Older', new Date('2024-01-15T10:00:00Z')),
        createMessage('msg-3', 'Newer', new Date('2024-01-15T12:00:00Z')),
      ]

      const { merged, newMessages } = mergeAndProcessMessages(
        existing,
        incoming,
        (m) => [m.id]
      )

      expect(merged).toHaveLength(3)
      expect(merged[0].id).toBe('msg-1')
      expect(merged[1].id).toBe('msg-2')
      expect(merged[2].id).toBe('msg-3')
      expect(newMessages).toHaveLength(2)
    })

    it('should filter duplicates based on key function', () => {
      const existing = [
        createMessage('msg-1', 'Existing', new Date('2024-01-15T10:00:00Z'), {
          stanzaId: 'stanza-1',
        }),
      ]
      const incoming = [
        createMessage('msg-1-dupe', 'Dupe', new Date('2024-01-15T10:00:00Z'), {
          stanzaId: 'stanza-1',
        }),
        createMessage('msg-2', 'New', new Date('2024-01-15T11:00:00Z')),
      ]

      const { merged, newMessages } = mergeAndProcessMessages(
        existing,
        incoming,
        (m) => {
          const keys = [`id:${m.id}`]
          if (m.stanzaId) keys.push(`stanzaId:${m.stanzaId}`)
          return keys
        }
      )

      expect(merged).toHaveLength(2)
      expect(newMessages).toHaveLength(1)
      expect(newMessages[0].id).toBe('msg-2')
    })

    it('should trim when maxCount is provided', () => {
      const existing = [
        createMessage('msg-1', 'First', new Date('2024-01-15T10:00:00Z')),
      ]
      const incoming = [
        createMessage('msg-2', 'Second', new Date('2024-01-15T11:00:00Z')),
        createMessage('msg-3', 'Third', new Date('2024-01-15T12:00:00Z')),
      ]

      const { merged } = mergeAndProcessMessages(
        existing,
        incoming,
        (m) => [m.id],
        2 // maxCount
      )

      expect(merged).toHaveLength(2)
      expect(merged[0].id).toBe('msg-2')
      expect(merged[1].id).toBe('msg-3')
    })

    it('should not trim when maxCount is undefined', () => {
      const existing = [
        createMessage('msg-1', 'First', new Date('2024-01-15T10:00:00Z')),
      ]
      const incoming = [
        createMessage('msg-2', 'Second', new Date('2024-01-15T11:00:00Z')),
        createMessage('msg-3', 'Third', new Date('2024-01-15T12:00:00Z')),
      ]

      const { merged } = mergeAndProcessMessages(existing, incoming, (m) => [m.id])

      expect(merged).toHaveLength(3)
    })

    it('should return empty newMessages when all are duplicates', () => {
      const existing = [
        createMessage('msg-1', 'First', new Date('2024-01-15T10:00:00Z')),
      ]
      const incoming = [
        createMessage('msg-1', 'Dupe', new Date('2024-01-15T10:00:00Z')),
      ]

      const { merged, newMessages } = mergeAndProcessMessages(
        existing,
        incoming,
        (m) => [m.id]
      )

      expect(merged).toHaveLength(1)
      expect(newMessages).toHaveLength(0)
    })
  })

  describe('chat-style deduplication (stanzaId + from:id)', () => {
    // This test simulates the chatStore deduplication pattern
    it('should deduplicate using chat-style keys', () => {
      const existing = [
        createMessage('client-id-1', 'Msg 1', new Date('2024-01-15T10:00:00Z'), {
          stanzaId: 'mam-stanza-1',
          from: 'alice@example.com',
        }),
        createMessage('client-id-2', 'Msg 2', new Date('2024-01-15T11:00:00Z'), {
          from: 'bob@example.com',
        }),
      ]

      const incoming = [
        // Duplicate by stanzaId
        createMessage('different-id', 'Dupe by stanza', new Date(), {
          stanzaId: 'mam-stanza-1',
          from: 'alice@example.com',
        }),
        // Duplicate by from+id
        createMessage('client-id-2', 'Dupe by from+id', new Date(), {
          from: 'bob@example.com',
        }),
        // New message
        createMessage('client-id-3', 'New', new Date('2024-01-15T12:00:00Z'), {
          from: 'charlie@example.com',
        }),
      ]

      // Chat-style key function
      const getChatKeys = (m: TestMessage): string[] => {
        const keys: string[] = []
        if (m.stanzaId) keys.push(`stanzaId:${m.stanzaId}`)
        keys.push(`from:${m.from}:id:${m.id}`)
        return keys
      }

      const { newMessages } = mergeAndProcessMessages(existing, incoming, getChatKeys)

      expect(newMessages).toHaveLength(1)
      expect(newMessages[0].id).toBe('client-id-3')
    })
  })

  describe('room-style deduplication (stanzaId || id)', () => {
    // This test simulates the roomStore deduplication pattern
    it('should deduplicate using room-style keys', () => {
      const existing = [
        createMessage('msg-1', 'Room msg 1', new Date('2024-01-15T10:00:00Z'), {
          stanzaId: 'room-stanza-1',
        }),
        createMessage('msg-2', 'Room msg 2', new Date('2024-01-15T11:00:00Z')),
      ]

      const incoming = [
        // Duplicate by stanzaId
        createMessage('different-id', 'Dupe', new Date(), { stanzaId: 'room-stanza-1' }),
        // Duplicate by id
        createMessage('msg-2', 'Dupe by id', new Date()),
        // New message
        createMessage('msg-3', 'New', new Date('2024-01-15T12:00:00Z')),
      ]

      // Room-style key function
      const getRoomKey = (m: TestMessage): string[] => [m.stanzaId || m.id]

      const { newMessages } = mergeAndProcessMessages(existing, incoming, getRoomKey)

      expect(newMessages).toHaveLength(1)
      expect(newMessages[0].id).toBe('msg-3')
    })
  })

  describe('origin-id deduplication (XEP-0359)', () => {
    it('should deduplicate using originId in chat-style key function', () => {
      // Outgoing message stored locally with originId
      const existing = [
        createMessage('client-uuid-1', 'Hello', new Date('2024-01-15T10:00:00Z'), {
          originId: 'client-uuid-1',
          from: 'me@example.com',
        }),
      ]

      // Echo comes back from server with stanzaId + matching originId
      const incoming = [
        createMessage('client-uuid-1', 'Hello', new Date('2024-01-15T10:00:00Z'), {
          stanzaId: 'server-stanza-999',
          originId: 'client-uuid-1',
          from: 'me@example.com',
        }),
      ]

      // Chat-style key function with originId support
      const getChatKeys = (m: TestMessage): string[] => {
        const keys: string[] = []
        if (m.stanzaId) keys.push(`stanzaId:${m.stanzaId}`)
        if (m.originId) keys.push(`originId:${m.originId}`)
        keys.push(`from:${m.from}:id:${m.id}`)
        return keys
      }

      const { newMessages } = mergeAndProcessMessages(existing, incoming, getChatKeys)

      // Echo should be deduplicated via originId match
      expect(newMessages).toHaveLength(0)
    })

    it('should deduplicate echo when stanzaId differs but originId matches', () => {
      // Message stored without stanzaId (optimistic local)
      const existing = [
        createMessage('uuid-abc', 'Test', new Date('2024-01-15T10:00:00Z'), {
          originId: 'uuid-abc',
          from: 'me@example.com',
        }),
      ]

      // MAM returns same message with server-assigned stanzaId and different client id
      const incoming = [
        createMessage('different-id', 'Test', new Date('2024-01-15T10:00:00Z'), {
          stanzaId: 'mam-id-123',
          originId: 'uuid-abc',
          from: 'me@example.com',
        }),
      ]

      const getChatKeys = (m: TestMessage): string[] => {
        const keys: string[] = []
        if (m.stanzaId) keys.push(`stanzaId:${m.stanzaId}`)
        if (m.originId) keys.push(`originId:${m.originId}`)
        keys.push(`from:${m.from}:id:${m.id}`)
        return keys
      }

      const { newMessages } = mergeAndProcessMessages(existing, incoming, getChatKeys)

      expect(newMessages).toHaveLength(0)
    })

    it('should not deduplicate when originIds differ', () => {
      const existing = [
        createMessage('msg-1', 'Hello', new Date('2024-01-15T10:00:00Z'), {
          originId: 'origin-aaa',
          from: 'alice@example.com',
        }),
      ]

      const incoming = [
        createMessage('msg-2', 'World', new Date('2024-01-15T11:00:00Z'), {
          originId: 'origin-bbb',
          from: 'bob@example.com',
        }),
      ]

      const getChatKeys = (m: TestMessage): string[] => {
        const keys: string[] = []
        if (m.stanzaId) keys.push(`stanzaId:${m.stanzaId}`)
        if (m.originId) keys.push(`originId:${m.originId}`)
        keys.push(`from:${m.from}:id:${m.id}`)
        return keys
      }

      const { newMessages } = mergeAndProcessMessages(existing, incoming, getChatKeys)

      expect(newMessages).toHaveLength(1)
      expect(newMessages[0].id).toBe('msg-2')
    })
  })

  describe('prependOlderMessages', () => {
    it('should prepend older messages to existing array without full re-sort', () => {
      // Existing messages (most recent, already in memory)
      const existing = [
        createMessage('msg-3', 'Third', new Date('2024-01-15T12:00:00Z')),
        createMessage('msg-4', 'Fourth', new Date('2024-01-15T13:00:00Z')),
      ]

      // Older messages from MAM (to be prepended)
      const older = [
        createMessage('msg-1', 'First', new Date('2024-01-15T10:00:00Z')),
        createMessage('msg-2', 'Second', new Date('2024-01-15T11:00:00Z')),
      ]

      const { merged, newMessages } = prependOlderMessages(
        existing,
        older,
        (m) => [m.id]
      )

      // Should be in correct order: older messages first, then existing
      expect(merged).toHaveLength(4)
      expect(merged[0].id).toBe('msg-1')
      expect(merged[1].id).toBe('msg-2')
      expect(merged[2].id).toBe('msg-3')
      expect(merged[3].id).toBe('msg-4')
      expect(newMessages).toHaveLength(2)
    })

    it('should sort older messages among themselves', () => {
      const existing = [
        createMessage('msg-3', 'Third', new Date('2024-01-15T12:00:00Z')),
      ]

      // Older messages in wrong order (as they might arrive from MAM)
      const older = [
        createMessage('msg-2', 'Second', new Date('2024-01-15T11:00:00Z')),
        createMessage('msg-1', 'First', new Date('2024-01-15T10:00:00Z')),
      ]

      const { merged } = prependOlderMessages(existing, older, (m) => [m.id])

      // Should be sorted correctly
      expect(merged[0].id).toBe('msg-1')
      expect(merged[1].id).toBe('msg-2')
      expect(merged[2].id).toBe('msg-3')
    })

    it('should filter duplicates from older messages', () => {
      const existing = [
        createMessage('msg-2', 'Existing', new Date('2024-01-15T11:00:00Z')),
      ]

      const older = [
        createMessage('msg-1', 'New old', new Date('2024-01-15T10:00:00Z')),
        createMessage('msg-2', 'Duplicate', new Date('2024-01-15T11:00:00Z')),
      ]

      const { merged, newMessages } = prependOlderMessages(
        existing,
        older,
        (m) => [m.id]
      )

      expect(merged).toHaveLength(2)
      expect(newMessages).toHaveLength(1)
      expect(newMessages[0].id).toBe('msg-1')
    })

    it('should return existing array unchanged when all older are duplicates', () => {
      const existing = [
        createMessage('msg-1', 'Existing', new Date('2024-01-15T10:00:00Z')),
      ]

      const older = [
        createMessage('msg-1', 'Duplicate', new Date('2024-01-15T10:00:00Z')),
      ]

      const { merged, newMessages } = prependOlderMessages(
        existing,
        older,
        (m) => [m.id]
      )

      expect(merged).toBe(existing) // Same reference
      expect(newMessages).toHaveLength(0)
    })

    it('should trim when maxCount is provided', () => {
      const existing = [
        createMessage('msg-4', 'Fourth', new Date('2024-01-15T13:00:00Z')),
      ]

      const older = [
        createMessage('msg-1', 'First', new Date('2024-01-15T10:00:00Z')),
        createMessage('msg-2', 'Second', new Date('2024-01-15T11:00:00Z')),
        createMessage('msg-3', 'Third', new Date('2024-01-15T12:00:00Z')),
      ]

      const { merged } = prependOlderMessages(
        existing,
        older,
        (m) => [m.id],
        2 // maxCount - keep only newest 2
      )

      expect(merged).toHaveLength(2)
      // Should keep newest 2: msg-3 and msg-4
      expect(merged[0].id).toBe('msg-3')
      expect(merged[1].id).toBe('msg-4')
    })

    it('should handle empty older array', () => {
      const existing = [
        createMessage('msg-1', 'Existing', new Date('2024-01-15T10:00:00Z')),
      ]

      const { merged, newMessages } = prependOlderMessages(
        existing,
        [],
        (m) => [m.id]
      )

      expect(merged).toBe(existing) // Same reference
      expect(newMessages).toHaveLength(0)
    })

    it('should handle empty existing array', () => {
      const older = [
        createMessage('msg-1', 'First', new Date('2024-01-15T10:00:00Z')),
        createMessage('msg-2', 'Second', new Date('2024-01-15T11:00:00Z')),
      ]

      const { merged, newMessages } = prependOlderMessages(
        [],
        older,
        (m) => [m.id]
      )

      expect(merged).toHaveLength(2)
      expect(merged[0].id).toBe('msg-1')
      expect(merged[1].id).toBe('msg-2')
      expect(newMessages).toHaveLength(2)
    })

    it('should preserve existing message order', () => {
      // Existing messages are already sorted - this should not change
      const existing = [
        createMessage('msg-3', 'Third', new Date('2024-01-15T12:00:00Z')),
        createMessage('msg-4', 'Fourth', new Date('2024-01-15T13:00:00Z')),
        createMessage('msg-5', 'Fifth', new Date('2024-01-15T14:00:00Z')),
      ]

      const older = [
        createMessage('msg-1', 'First', new Date('2024-01-15T10:00:00Z')),
      ]

      const { merged } = prependOlderMessages(existing, older, (m) => [m.id])

      // Existing messages should maintain their exact order
      expect(merged[1].id).toBe('msg-3')
      expect(merged[2].id).toBe('msg-4')
      expect(merged[3].id).toBe('msg-5')
    })

    it('should place newer messages at wrong position (known limitation for backward queries)', () => {
      // This test documents a known limitation of prependOlderMessages:
      // If "older" messages are actually NEWER than existing ones, they end up
      // at the wrong position (prepended before existing instead of appended after).
      //
      // This is why catch-up queries must use forward direction (with 'start' filter)
      // when cached messages exist — mergeAndProcessMessages does a full sort.
      const existing = [
        createMessage('msg-1', 'Old cached', new Date('2024-01-15T10:00:00Z')),
        createMessage('msg-2', 'Old cached', new Date('2024-01-15T11:00:00Z')),
      ]

      // "Older" messages that are actually newer (e.g., sent from another client while offline)
      const newer = [
        createMessage('msg-3', 'Sent from Gajim', new Date('2024-01-15T12:00:00Z')),
      ]

      const { merged } = prependOlderMessages(existing, newer, (m) => [m.id])

      // BUG: msg-3 (newer) is placed BEFORE msg-1 and msg-2 (older)
      // This is why the catch-up cursor fix is essential — it prevents this scenario
      // by always using forward queries (mergeAndProcessMessages) when cached msgs exist
      expect(merged[0].id).toBe('msg-3') // Wrong: should be at end
      expect(merged[1].id).toBe('msg-1')
      expect(merged[2].id).toBe('msg-2')
    })
  })

  describe('mergeAndProcessMessages correctly handles catch-up scenario', () => {
    it('should sort messages sent from another client while offline into correct position', () => {
      // Simulates the catch-up scenario with forward direction (mergeAndProcessMessages):
      // - Existing messages loaded from IndexedDB cache (all delayed from previous MAM)
      // - MAM catch-up returns messages sent from another client while Fluux was offline
      const existing = [
        createMessage('msg-1', 'Previous session', new Date('2024-01-15T10:00:00Z')),
        createMessage('msg-2', 'Previous session', new Date('2024-01-15T11:00:00Z')),
      ]

      const fromMAM = [
        // Message sent by user from another client while Fluux was closed
        createMessage('msg-3', '[OMEMO encrypted]', new Date('2024-01-15T12:00:00Z')),
        // Reply received while Fluux was closed
        createMessage('msg-4', '[OMEMO encrypted]', new Date('2024-01-15T13:00:00Z')),
      ]

      const { merged, newMessages } = mergeAndProcessMessages(
        existing,
        fromMAM,
        (m) => [m.id]
      )

      // Full sort ensures correct chronological order
      expect(merged).toHaveLength(4)
      expect(merged[0].id).toBe('msg-1')
      expect(merged[1].id).toBe('msg-2')
      expect(merged[2].id).toBe('msg-3') // Correctly at position 3 (not prepended)
      expect(merged[3].id).toBe('msg-4') // Correctly at position 4 (newest)
      expect(newMessages).toHaveLength(2)

      // The last message in the array should be the newest — this is used for
      // lastMessage sidebar preview in mergeMAMMessages
      expect(merged[merged.length - 1].id).toBe('msg-4')
    })
  })
})
