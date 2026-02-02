import { describe, expect, it } from 'vitest'
import { shouldUpdateLastMessage } from './lastMessageUtils'

describe('shouldUpdateLastMessage', () => {
  it('should return true when existing is undefined', () => {
    const newMessage = { timestamp: new Date('2024-01-15T10:00:00Z') }
    expect(shouldUpdateLastMessage(undefined, newMessage)).toBe(true)
  })

  it('should return true when new message is newer', () => {
    const existing = { timestamp: new Date('2024-01-15T09:00:00Z') }
    const newMessage = { timestamp: new Date('2024-01-15T10:00:00Z') }
    expect(shouldUpdateLastMessage(existing, newMessage)).toBe(true)
  })

  it('should return false when new message is older', () => {
    const existing = { timestamp: new Date('2024-01-15T10:00:00Z') }
    const newMessage = { timestamp: new Date('2024-01-15T09:00:00Z') }
    expect(shouldUpdateLastMessage(existing, newMessage)).toBe(false)
  })

  it('should return false when timestamps are equal', () => {
    const timestamp = new Date('2024-01-15T10:00:00Z')
    const existing = { timestamp }
    const newMessage = { timestamp: new Date(timestamp.getTime()) }
    expect(shouldUpdateLastMessage(existing, newMessage)).toBe(false)
  })

  it('should return true when existing has no timestamp but new message does', () => {
    const existing = {} // No timestamp
    const newMessage = { timestamp: new Date('2024-01-15T10:00:00Z') }
    expect(shouldUpdateLastMessage(existing, newMessage)).toBe(true)
  })

  it('should return false when neither has a timestamp', () => {
    const existing = {}
    const newMessage = {}
    expect(shouldUpdateLastMessage(existing, newMessage)).toBe(false)
  })

  it('should handle messages with additional properties', () => {
    const existing = {
      id: 'old-1',
      body: 'Old message',
      timestamp: new Date('2024-01-15T09:00:00Z'),
    }
    const newMessage = {
      id: 'new-1',
      body: 'New message',
      timestamp: new Date('2024-01-15T10:00:00Z'),
    }
    expect(shouldUpdateLastMessage(existing, newMessage)).toBe(true)
  })
})
