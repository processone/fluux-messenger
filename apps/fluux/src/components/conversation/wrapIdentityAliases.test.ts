import { describe, it, expect } from 'vitest'
import { inPlaceEnrichments } from './wrapIdentityAliases'

// Source: captain's choices on review FLM-404 — twins stay separate; a choice that cannot be proven
// to belong to the same occurrence is dropped, never transferred (R6, R10).
const at = new Date('2026-01-01T12:00:00Z')
const dm = (o: object = {}) => ({ id: 'm1', type: 'chat' as const, conversationId: 'bob@x.org', from: 'bob@x.org', timestamp: at, ...o })
const other = (id: string) => dm({ id })
const wanted = new Set(['m1'])

describe('inPlaceEnrichments', () => {
  it('pairs a message replaced by its enriched self in the same slot', () => {
    const pairs = inPlaceEnrichments([other('a'), dm(), other('b')], [other('a'), dm({ stanzaId: 'A' }), other('b')], wanted)
    expect(pairs).toHaveLength(1)
    expect(pairs[0][1].stanzaId).toBe('A')
  })

  it('proves nothing when the list shape changes (arrival, trim, shift)', () => {
    expect(inPlaceEnrichments([dm()], [dm({ stanzaId: 'A' }), dm({ stanzaId: 'B' })], wanted)).toEqual([])
    expect(inPlaceEnrichments([other('a'), dm()], [dm({ stanzaId: 'A' }), other('c')], wanted)).toEqual([])
    expect(inPlaceEnrichments([dm()], [other('c')], wanted)).toEqual([])
  })

  it('does not follow a look-alike whose ids contradict the stored ones', () => {
    expect(inPlaceEnrichments([dm({ stanzaId: 'A' })], [dm({ stanzaId: 'B' })], wanted)).toEqual([])
  })

  it('ignores slots that changed without touching a wrapped message', () => {
    expect(inPlaceEnrichments([other('a')], [other('a')], wanted)).toEqual([])
    expect(inPlaceEnrichments([other('a'), dm()], [{ ...other('a') }, dm()], wanted)).toEqual([])
  })
})
