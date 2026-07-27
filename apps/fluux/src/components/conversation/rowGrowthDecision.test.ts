import { describe, it, expect } from 'vitest'
import { decideRowGrowth, type RowGrowthFacts } from './rowGrowthDecision'

/** At the bottom, with a 260px card just mounted — the canonical fastening case. */
const atBottomAfterCard = (over: Partial<RowGrowthFacts> = {}): RowGrowthFacts => ({
  distanceFromBottom: 260,
  growth: 260,
  atBottomThreshold: 150,
  pinClaimHeld: false,
  navigationInFlight: false,
  ...over,
})

describe('decideRowGrowth', () => {
  it('pins when the reader was at the bottom before the row grew', () => {
    expect(decideRowGrowth(atBottomAfterCard())).toBe('pin')
  })

  // The growth lands in the measured distance. Without subtracting it, a card taller than the
  // threshold reads as "scrolled away" and the re-pin is refused in the very case it exists for.
  it('pins even when the growth alone exceeds the at-bottom threshold', () => {
    expect(decideRowGrowth(atBottomAfterCard({ distanceFromBottom: 900, growth: 900 }))).toBe('pin')
  })

  // A distance of ~0 means the spacer has not taken the growth yet, not that the bottom is pinned.
  it('pins when the growth is not measured yet', () => {
    expect(decideRowGrowth(atBottomAfterCard({ distanceFromBottom: 0, growth: 0 }))).toBe('pin')
  })

  it('skips when the reader was genuinely scrolled up before the growth', () => {
    expect(decideRowGrowth(atBottomAfterCard({ distanceFromBottom: 1360, growth: 260 }))).toBe('skip')
  })

  it('skips rather than cancel a navigation the reader asked for', () => {
    expect(decideRowGrowth(atBottomAfterCard({ navigationInFlight: true }))).toBe('skip')
  })

  // ACCEPTED GAP, pinned here so it is a decision and not a surprise: a held claim skips, betting
  // the running loop absorbs the growth. If that loop was abandoned the bet is wrong and THIS growth
  // is never pinned — the claim's expiry bounds how long further growths stay suppressed, but it
  // does not replay one already consumed. See the module doc.
  it('skips while a pin loop holds the claim, betting that loop absorbs the growth', () => {
    expect(decideRowGrowth(atBottomAfterCard({ pinClaimHeld: true }))).toBe('skip')
  })

  it('lets the reader-scrolled-up check win over a held claim', () => {
    expect(
      decideRowGrowth(atBottomAfterCard({ distanceFromBottom: 1360, growth: 260, pinClaimHeld: true })),
    ).toBe('skip')
  })
})
