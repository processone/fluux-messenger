import { describe, it, expect, beforeEach } from 'vitest'
import { useWrappedCodeBlocksStore, wrapIdentityMatches, type WrapIdentity } from './wrappedCodeBlocksStore'

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

  it('keeps the choice when backfill supplies archive and origin ids later', () => {
    s().toggle(ident('m1'), 0)
    const enriched = ident('m1', { stanzaId: 'sA', originId: 'o1' })
    expect(s().isWrapped(enriched, 0)).toBe(true)
    s().claim(enriched)
    // once claimed, a twin with another archive id no longer matches it
    expect(s().isWrapped(ident('m1', { stanzaId: 'sB' }), 0)).toBe(false)
    expect(s().isWrapped(enriched, 0)).toBe(true)
  })

  it('keeps a choice made after an origin id was known when the message is later backfilled', () => {
    s().toggle(ident('m1', { originId: 'o1' }), 0)
    expect(s().isWrapped(ident('m1', { originId: 'o1', stanzaId: 'sA' }), 0)).toBe(true)
    expect(s().isWrapped(ident('m1', { originId: 'o2' }), 0)).toBe(false)
  })

  it('clear resets everything', () => {
    s().toggle(ident('m1'), 0)
    s().clear()
    expect(s().isWrapped(ident('m1'), 0)).toBe(false)
  })
})

describe('wrapIdentityMatches', () => {
  it('requires the fixed fields to be equal', () => {
    expect(wrapIdentityMatches(ident('m1'), ident('m1', { scope: 'b@x.org' }))).toBe(false)
    expect(wrapIdentityMatches(ident('m1'), ident('m1', { from: 'me@x.org' }))).toBe(false)
    expect(wrapIdentityMatches(ident('m1', { instant: 1 }), ident('m1', { instant: 2 }))).toBe(false)
  })
})
