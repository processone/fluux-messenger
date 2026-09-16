import { describe, it, expect } from 'vitest'
import { isProgrammaticScroll, PROGRAMMATIC_SETTLE_MS } from './scrollGate'

// These cases cover the time-window predicate. Live-list movement attribution follows
// docs/2026-07-23-scroll-positioning-contract.md.
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
