import { describe, it, expect } from 'vitest'
import { wrapIdentityAliases } from './wrapIdentityAliases'

// Source: captain's choice on review FLM-404 R3 — a wrap choice survives archive enrichment that
// happens while the message is off screen, without handing it to a look-alike twin (R6).
const at = new Date('2026-01-01T12:00:00Z')
const dm = (o: object = {}) => ({ id: 'm1', type: 'chat' as const, conversationId: 'bob@x.org', from: 'bob@x.org', timestamp: at, ...o })

describe('wrapIdentityAliases', () => {
  it('pairs a message with its enriched self', () => {
    const pairs = wrapIdentityAliases([dm()], [dm({ stanzaId: 'A', originId: 'o1' })])
    expect(pairs).toHaveLength(1)
    expect(pairs[0][0].stanzaId).toBeUndefined()
    expect(pairs[0][1]).toMatchObject({ stanzaId: 'A', originId: 'o1' })
  })

  it('does not pair when nothing changed or the id set is unrelated', () => {
    expect(wrapIdentityAliases([dm()], [dm()])).toEqual([])
    expect(wrapIdentityAliases([dm()], [dm({ id: 'm2' })])).toEqual([])
  })

  it('never treats an already present twin as the enriched original', () => {
    const twin = dm({ stanzaId: 'B' })
    expect(wrapIdentityAliases([dm(), twin], [twin, dm({ stanzaId: 'A' })])).toHaveLength(1)
    // original vanished, only the pre-existing twin remains: nothing arrived, nothing to carry
    expect(wrapIdentityAliases([dm(), twin], [twin])).toEqual([])
  })

  it('stays silent when two arrivals could both be the departed message', () => {
    expect(wrapIdentityAliases([dm()], [dm({ stanzaId: 'A' }), dm({ stanzaId: 'B' })])).toEqual([])
  })
})
