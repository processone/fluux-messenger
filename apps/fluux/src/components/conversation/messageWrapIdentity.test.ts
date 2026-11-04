import { describe, it, expect } from 'vitest'
import { messageWrapIdentity } from './messageRowIdentity'
import { wrapIdentityMatches } from '@/stores/wrappedCodeBlocksStore'

// Source: review FLM-404 R2/R3/R6 — per-message UI state (wrapped code blocks) is scoped to the
// conversation, separates twins, and survives archive-id enrichment.
describe('messageWrapIdentity', () => {
  const chat = { type: 'chat' as const, id: 'm1', conversationId: 'a@x.org', from: 'a@x.org' }
  const room = { type: 'groupchat' as const, id: 'm1', roomJid: 'r@muc.x.org', from: 'r@muc.x.org/Alice', timestamp: new Date(2026, 0, 1, 10), receivedAt: new Date(2026, 0, 1, 10, 0, 5) }
  const same = (a: object, b: object) => wrapIdentityMatches(messageWrapIdentity(a)!, messageWrapIdentity(b)!)

  it('separates legacy messages sharing an id across conversations', () => {
    expect(same(chat, { ...chat, conversationId: 'b@x.org' })).toBe(false)
    expect(same(room, { ...room, roomJid: 'other@muc.x.org' })).toBe(false)
  })

  it('separates room deliveries received at different times, and different authors', () => {
    expect(same(room, { ...room, receivedAt: new Date(2026, 0, 1, 10, 7) })).toBe(false)
    expect(same(room, { ...room, from: 'r@muc.x.org/Bob' })).toBe(false)
    expect(same({ ...chat, from: 'me@x.org' }, chat)).toBe(false)
  })

  it('separates twins whose known archive, origin or occupant ids differ', () => {
    expect(same({ ...chat, stanzaId: 's1' }, { ...chat, stanzaId: 's2' })).toBe(false)
    expect(same({ ...chat, originId: 'o1' }, { ...chat, originId: 'o2' })).toBe(false)
    expect(same({ ...room, occupantId: 'a' }, { ...room, occupantId: 'b' })).toBe(false)
  })

  it('stays the same message when backfill supplies archive and origin ids', () => {
    expect(same(chat, { ...chat, stanzaId: 's1', originId: 'o1' })).toBe(true)
    expect(same({ ...chat, originId: 'o1' }, { ...chat, originId: 'o1', stanzaId: 's1' })).toBe(true)
    expect(same(room, { ...room, stanzaId: 's2', timestamp: new Date(2026, 0, 1, 9, 59) })).toBe(true)
  })

  it('has no identity for an id-less message', () => {
    expect(messageWrapIdentity({ type: 'chat', conversationId: 'a@x.org' })).toBeUndefined()
  })
})
