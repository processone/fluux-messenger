import { describe, it, expect } from 'vitest'
import { generateUUID, generateStableMessageId } from './uuid'

describe('uuid utilities', () => {
  describe('generateUUID', () => {
    it('should generate a valid UUID v4 format', () => {
      const uuid = generateUUID()
      expect(uuid).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
    })

    it('should generate unique UUIDs', () => {
      const uuids = new Set<string>()
      for (let i = 0; i < 100; i++) {
        uuids.add(generateUUID())
      }
      expect(uuids.size).toBe(100)
    })
  })

  describe('generateStableMessageId', () => {
    it('should generate the same ID for the same input', () => {
      const from = 'user@example.com'
      const timestamp = '2024-01-15T10:30:00.000Z'
      const body = 'Hello, world!'

      const id1 = generateStableMessageId(from, timestamp, body)
      const id2 = generateStableMessageId(from, timestamp, body)

      expect(id1).toBe(id2)
    })

    it('should generate different IDs for different senders', () => {
      const timestamp = '2024-01-15T10:30:00.000Z'
      const body = 'Hello, world!'

      const id1 = generateStableMessageId('user1@example.com', timestamp, body)
      const id2 = generateStableMessageId('user2@example.com', timestamp, body)

      expect(id1).not.toBe(id2)
    })

    it('should generate different IDs for different timestamps', () => {
      const from = 'user@example.com'
      const body = 'Hello, world!'

      const id1 = generateStableMessageId(from, '2024-01-15T10:30:00.000Z', body)
      const id2 = generateStableMessageId(from, '2024-01-15T10:31:00.000Z', body)

      expect(id1).not.toBe(id2)
    })

    it('should generate different IDs for different bodies', () => {
      const from = 'user@example.com'
      const timestamp = '2024-01-15T10:30:00.000Z'

      const id1 = generateStableMessageId(from, timestamp, 'Hello')
      const id2 = generateStableMessageId(from, timestamp, 'Goodbye')

      expect(id1).not.toBe(id2)
    })

    it('should accept Date objects for timestamp', () => {
      const from = 'user@example.com'
      const date = new Date('2024-01-15T10:30:00.000Z')
      const body = 'Hello'

      const id1 = generateStableMessageId(from, date, body)
      const id2 = generateStableMessageId(from, date.toISOString(), body)

      expect(id1).toBe(id2)
    })

    it('should have stable- prefix', () => {
      const id = generateStableMessageId('user@example.com', '2024-01-15T10:30:00.000Z', 'Hello')
      expect(id).toMatch(/^stable-[0-9a-f]{8}-[0-9a-f]{8}$/)
    })

    it('should handle empty body', () => {
      const id = generateStableMessageId('user@example.com', '2024-01-15T10:30:00.000Z', '')
      expect(id).toMatch(/^stable-[0-9a-f]{8}-[0-9a-f]{8}$/)
    })

    it('should handle very long body (truncates to first 100 chars)', () => {
      const from = 'user@example.com'
      const timestamp = '2024-01-15T10:30:00.000Z'
      const shortBody = 'A'.repeat(100)
      const longBody = 'A'.repeat(200)

      // Both should produce the same ID since we only use first 100 chars
      const id1 = generateStableMessageId(from, timestamp, shortBody)
      const id2 = generateStableMessageId(from, timestamp, longBody)

      expect(id1).toBe(id2)
    })
  })
})
