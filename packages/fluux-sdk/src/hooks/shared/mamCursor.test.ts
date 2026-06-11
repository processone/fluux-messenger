import { describe, it, expect } from 'vitest'
import { pickOldestArchiveId, isItemNotFoundError } from './mamCursor'

// Minimal message shape the helper operates on; `id` mirrors the real
// client-generated id that must never be used as a cursor.
type TestMessage = { stanzaId?: string; id?: string }

describe('pickOldestArchiveId', () => {
  it('returns undefined for an empty list', () => {
    expect(pickOldestArchiveId([])).toBeUndefined()
  })

  it('returns the oldest message stanzaId when present', () => {
    const messages: TestMessage[] = [
      { stanzaId: 'archive-1', id: 'uuid-1' },
      { stanzaId: 'archive-2', id: 'uuid-2' },
    ]
    expect(pickOldestArchiveId(messages)).toBe('archive-1')
  })

  it('skips leading messages without a stanzaId and returns the first archived one', () => {
    // Oldest message is an outgoing message with no server archive id.
    const messages: TestMessage[] = [
      { id: 'uuid-sent' }, // outgoing, never assigned a stanzaId
      { stanzaId: 'archive-2', id: 'uuid-2' },
    ]
    expect(pickOldestArchiveId(messages)).toBe('archive-2')
  })

  it('returns undefined when no message carries a stanzaId (never falls back to client id)', () => {
    // This is the item-not-found trigger: a client UUID is not a valid archive id.
    const messages: TestMessage[] = [{ id: 'uuid-sent' }, { id: 'uuid-2' }]
    expect(pickOldestArchiveId(messages)).toBeUndefined()
  })

  it('treats an empty-string stanzaId as absent', () => {
    const messages: TestMessage[] = [
      { stanzaId: '', id: 'uuid-1' },
      { stanzaId: 'archive-2', id: 'uuid-2' },
    ]
    expect(pickOldestArchiveId(messages)).toBe('archive-2')
  })
})

describe('isItemNotFoundError', () => {
  it('detects a StanzaError by its condition', () => {
    expect(isItemNotFoundError({ condition: 'item-not-found' })).toBe(true)
  })

  it('detects item-not-found from the error message', () => {
    expect(isItemNotFoundError(new Error('item-not-found'))).toBe(true)
  })

  it('returns false for other conditions', () => {
    expect(isItemNotFoundError({ condition: 'forbidden' })).toBe(false)
    expect(isItemNotFoundError(new Error('timeout'))).toBe(false)
    expect(isItemNotFoundError(null)).toBe(false)
    expect(isItemNotFoundError(undefined)).toBe(false)
  })
})
