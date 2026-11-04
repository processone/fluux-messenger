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
    const sent = { ...chat, originId: 'o1' }
    const enriched = { ...sent, stanzaId: 'archive-1' }
    expect(messageRowId(enriched)).not.toBe(messageRowId(sent))
    expect(messageOccurrenceKey(enriched)).toBe(messageOccurrenceKey(sent))
    const roomEnriched = { ...room, stanzaId: 'archive-2', timestamp: new Date(2026, 0, 1, 9, 59) }
    expect(messageOccurrenceKey(roomEnriched)).toBe(messageOccurrenceKey(room))
  })

  it('keeps supported twins with one client id apart, in chats and rooms', () => {
    // direct-chat twins: own copy vs peer copy, and sender-assigned origin ids
    expect(messageOccurrenceKey({ ...chat, from: 'me@x.org' })).not.toBe(messageOccurrenceKey({ ...chat, from: 'a@x.org' }))
    expect(messageOccurrenceKey({ ...chat, from: 'a@x.org', originId: 'o1' })).not.toBe(messageOccurrenceKey({ ...chat, from: 'a@x.org', originId: 'o2' }))
    // room twins: different occupants or nicks with one id and receipt instant
    const twin = { ...room, from: 'r@muc.x.org/Alice', occupantId: 'occ-a' }
    expect(messageOccurrenceKey(twin)).not.toBe(messageOccurrenceKey({ ...twin, occupantId: 'occ-b' }))
    expect(messageOccurrenceKey(twin)).not.toBe(messageOccurrenceKey({ ...twin, from: 'r@muc.x.org/Bob' }))
    // ...while enrichment with an archive id alone keeps the state
    expect(messageOccurrenceKey({ ...twin, stanzaId: 's1' })).toBe(messageOccurrenceKey(twin))
  })

  it('has no key for an id-less message', () => {
    expect(messageOccurrenceKey({ type: 'chat', conversationId: 'a@x.org' })).toBeUndefined()
  })
})
