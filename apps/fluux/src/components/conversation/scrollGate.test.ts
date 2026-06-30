import { describe, it, expect } from 'vitest'
import { isProgrammaticScroll, PROGRAMMATIC_SETTLE_MS } from './scrollGate'

// The save gate opens on a "genuine user scroll": not programmatic + content height unchanged.
// `reassertLoopRef !== null` alone marked only scrolls DURING a re-assert loop as programmatic —
// but the measurement settle that fires just AFTER a one-shot restore (or after the re-pin loop
// ends) has no loop running and an unchanged height, so it looked exactly like a scrollbar drag
// and wrongly opened the gate, persisting a drifted position that crept older every re-open.
// isProgrammaticScroll closes that window: a programmatic write keeps subsequent scrolls
// programmatic for PROGRAMMATIC_SETTLE_MS, covering the settle without swallowing a real scroll.
describe('isProgrammaticScroll', () => {
  it('is true while a re-assert loop owns scrollTop (regardless of timing)', () => {
    // loop active, write was long ago — still programmatic.
    expect(isProgrammaticScroll(true, 10_000, 0)).toBe(true)
  })

  it('is true within the settle window after a programmatic write (no loop running)', () => {
    const now = 10_000
    expect(isProgrammaticScroll(false, now, now - (PROGRAMMATIC_SETTLE_MS - 1))).toBe(true)
  })

  it('is false once the settle window has elapsed, so a genuine user scroll registers', () => {
    const now = 10_000
    expect(isProgrammaticScroll(false, now, now - PROGRAMMATIC_SETTLE_MS)).toBe(false)
  })

  it('is false when no programmatic write has happened (a plain user scroll)', () => {
    expect(isProgrammaticScroll(false, 10_000, 0)).toBe(false)
  })
})
