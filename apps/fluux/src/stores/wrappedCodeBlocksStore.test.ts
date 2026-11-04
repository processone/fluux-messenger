import { describe, it, expect, beforeEach } from 'vitest'
import { useWrappedCodeBlocksStore, sameWrapIdentity, isWrapIdentityEnrichment, type WrapIdentity } from './wrappedCodeBlocksStore'

// Source: FLM-399 — wrapping is remembered per code block for the session, two blocks in one
// message wrap independently; review FLM-404 R3/R6 — twins stay apart, enrichment keeps the choice.
const ident = (id: string, extra: Partial<WrapIdentity> = {}): WrapIdentity => ({ scope: 'a@x.org', id, from: 'a@x.org', instant: null, ...extra })

describe('useWrappedCodeBlocksStore', () => {
  beforeEach(() => useWrappedCodeBlocksStore.getState().clear())
  const s = () => useWrappedCodeBlocksStore.getState()

  it('starts unwrapped', () => {
    expect(s().isWrapped(ident('m1'), 0)).toBe(false)
  })

  it('toggles one block on and off', () => {
    s().toggle(ident('m1'), 0)
    expect(s().isWrapped(ident('m1'), 0)).toBe(true)
    s().toggle(ident('m1'), 0)
    expect(s().isWrapped(ident('m1'), 0)).toBe(false)
    expect(s().entries).toHaveLength(0)
  })

  it('keeps blocks of the same message and other messages independent', () => {
    s().toggle(ident('m1'), 1)
    expect(s().isWrapped(ident('m1'), 0)).toBe(false)
    expect(s().isWrapped(ident('m1'), 1)).toBe(true)
    expect(s().isWrapped(ident('m2'), 1)).toBe(false)
  })

  it('counts wrapped blocks per message, changing on every toggle', () => {
    s().toggle(ident('m1'), 0)
    s().toggle(ident('m1'), 1)
    expect(s().countFor(ident('m1'))).toBe(2)
    s().toggle(ident('m1'), 0)
    expect(s().countFor(ident('m1'))).toBe(1)
    expect(s().countFor(ident('m2'))).toBe(0)
  })

  it('keeps archive-only twins apart: wrapping one leaves the other alone', () => {
    s().toggle(ident('dup', { stanzaId: 'sA' }), 0)
    expect(s().isWrapped(ident('dup', { stanzaId: 'sA' }), 0)).toBe(true)
    expect(s().isWrapped(ident('dup', { stanzaId: 'sB' }), 0)).toBe(false)
    s().toggle(ident('dup', { stanzaId: 'sB' }), 0)
    expect(s().countFor(ident('dup', { stanzaId: 'sA' }))).toBe(1)
    expect(s().entries).toHaveLength(2)
  })

  it('does not hand a choice stored before backfill to a look-alike twin (strict lookup)', () => {
    s().toggle(ident('m1'), 0)
    // an archive-only twin that mounts while the original is unmounted: no wildcard match
    expect(s().isWrapped(ident('m1', { stanzaId: 'sB' }), 0)).toBe(false)
    expect(s().countFor(ident('m1', { stanzaId: 'sB' }))).toBe(0)
    s().toggle(ident('m1', { stanzaId: 'sB' }), 0)
    expect(s().entries).toHaveLength(2)
    expect(s().isWrapped(ident('m1'), 0)).toBe(true)
  })

  it('promote carries the choice of the same occurrence when backfill supplies ids', () => {
    s().toggle(ident('m1'), 0)
    const enriched = ident('m1', { stanzaId: 'sA', originId: 'o1' })
    s().promote(ident('m1'), enriched)
    expect(s().isWrapped(enriched, 0)).toBe(true)
    expect(s().isWrapped(ident('m1'), 0)).toBe(false)
    expect(s().isWrapped(ident('m1', { stanzaId: 'sB' }), 0)).toBe(false)
    expect(s().entries).toHaveLength(1)
  })

  it('promote refuses anything that is not an enrichment of the same occurrence', () => {
    s().toggle(ident('m1', { stanzaId: 'sA' }), 0)
    s().promote(ident('m1', { stanzaId: 'sA' }), ident('m1', { stanzaId: 'sB' }))   // id changed, not added
    s().promote(ident('m1', { stanzaId: 'sA' }), ident('m2', { stanzaId: 'sA' }))   // another message
    expect(s().isWrapped(ident('m1', { stanzaId: 'sA' }), 0)).toBe(true)
    expect(s().isWrapped(ident('m1', { stanzaId: 'sB' }), 0)).toBe(false)
    expect(s().isWrapped(ident('m2', { stanzaId: 'sA' }), 0)).toBe(false)
  })

  it('promote leaves other entries and unrelated identities alone', () => {
    s().toggle(ident('m1'), 0)
    s().toggle(ident('m1', { stanzaId: 'sB' }), 0)
    s().promote(ident('m1'), ident('m1', { stanzaId: 'sA' }))
    expect(s().isWrapped(ident('m1', { stanzaId: 'sA' }), 0)).toBe(true)
    expect(s().isWrapped(ident('m1', { stanzaId: 'sB' }), 0)).toBe(true)
    s().promote(ident('m9'), ident('m9', { stanzaId: 'x' }))   // nothing stored: no-op
    expect(s().entries).toHaveLength(2)
  })

  it('clear resets everything', () => {
    s().toggle(ident('m1'), 0)
    s().clear()
    expect(s().isWrapped(ident('m1'), 0)).toBe(false)
  })
})

describe('identity comparison', () => {
  it('sameWrapIdentity requires every field to be equal', () => {
    expect(sameWrapIdentity(ident('m1'), ident('m1'))).toBe(true)
    expect(sameWrapIdentity(ident('m1'), ident('m1', { scope: 'b@x.org' }))).toBe(false)
    expect(sameWrapIdentity(ident('m1'), ident('m1', { from: 'me@x.org' }))).toBe(false)
    expect(sameWrapIdentity(ident('m1', { instant: 1 }), ident('m1', { instant: 2 }))).toBe(false)
    expect(sameWrapIdentity(ident('m1'), ident('m1', { stanzaId: 's' }))).toBe(false)
  })

  it('isWrapIdentityEnrichment only allows adding late ids', () => {
    expect(isWrapIdentityEnrichment(ident('m1'), ident('m1', { stanzaId: 's' }))).toBe(true)
    expect(isWrapIdentityEnrichment(ident('m1', { originId: 'o' }), ident('m1', { originId: 'o', stanzaId: 's' }))).toBe(true)
    expect(isWrapIdentityEnrichment(ident('m1', { stanzaId: 's' }), ident('m1'))).toBe(false)
    expect(isWrapIdentityEnrichment(ident('m1', { stanzaId: 's' }), ident('m1', { stanzaId: 't' }))).toBe(false)
    expect(isWrapIdentityEnrichment(ident('m1'), ident('m2', { stanzaId: 's' }))).toBe(false)
  })
})
