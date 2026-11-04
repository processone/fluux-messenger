import { describe, it, expect } from 'vitest'
import { messageOccurrenceKey, messageRowId } from './messageRowIdentity'

// Source: review FLM-404 R2/R3 — per-message UI state (wrapped code blocks) is
// scoped to the conversation and survives archive-id enrichment.
describe('messageOccurrenceKey', () => {
  const chat = { type: 'chat' as const, id: 'm1', conversationId: 'a@x.org' }
  const room = { type: 'groupchat' as const, id: 'm1', roomJid: 'r@muc.x.org', timestamp: new Date(2026, 0, 1, 10), receivedAt: new Date(2026, 0, 1, 10, 0, 5) }

  it('separates legacy messages sharing an id across conversations', () => {
    expect(messageOccurrenceKey(chat)).not.toBe(messageOccurrenceKey({ ...chat, conversationId: 'b@x.org' }))
    expect(messageOccurrenceKey(room)).not.toBe(messageOccurrenceKey({ ...room, roomJid: 'other@muc.x.org' }))
  })

  it('separates room deliveries sharing a handle but received at different times', () => {
    const later = { ...room, receivedAt: new Date(2026, 0, 1, 10, 7) }
    expect(messageRowId(room)).toBe(messageRowId(later))
    expect(messageOccurrenceKey(room)).not.toBe(messageOccurrenceKey(later))
  })

  it('stays the same when an archive id enriches the row handle', () => {
    const enriched = { ...chat, stanzaId: 'archive-1', originId: 'o1' }
    expect(messageRowId(enriched)).not.toBe(messageRowId(chat))
    expect(messageOccurrenceKey(enriched)).toBe(messageOccurrenceKey(chat))
    const roomEnriched = { ...room, stanzaId: 'archive-2', timestamp: new Date(2026, 0, 1, 9, 59) }
    expect(messageOccurrenceKey(roomEnriched)).toBe(messageOccurrenceKey(room))
  })

  it('has no key for an id-less message', () => {
    expect(messageOccurrenceKey({ type: 'chat', conversationId: 'a@x.org' })).toBeUndefined()
  })
})
