import { describe, it, expect } from 'vitest'
import { decideRowGrowth, type RowGrowthFacts } from './rowGrowthDecision'

/** At the bottom, with a 260px card just mounted — the canonical fastening case. */
const atBottomAfterCard = (over: Partial<RowGrowthFacts> = {}): RowGrowthFacts => ({
  distanceFromBottom: 260,
  heightDelta: 260,
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
    expect(decideRowGrowth(atBottomAfterCard({ distanceFromBottom: 900, heightDelta: 900 }))).toBe('pin')
  })

  // A distance of ~0 means the spacer has not taken the growth yet, not that the bottom is pinned.
  it('pins when the growth is not measured yet', () => {
    expect(decideRowGrowth(atBottomAfterCard({ distanceFromBottom: 0, heightDelta: 0 }))).toBe('pin')
  })

  // An untrustworthy baseline (stale, or captured before the list had real geometry) is reported as
  // null, and must stay eligible — a genuine growth not yet measured looks the same from here.
  it('pins with no trustworthy baseline when the list still reads as near the bottom', () => {
    expect(decideRowGrowth(atBottomAfterCard({ distanceFromBottom: 20, heightDelta: null }))).toBe('pin')
  })

  it('skips with no trustworthy baseline when the reader is plainly scrolled up', () => {
    expect(decideRowGrowth(atBottomAfterCard({ distanceFromBottom: 900, heightDelta: null }))).toBe('skip')
  })

  // THE SIGN REGRESSION. Clamping the delta at 0 made a measured SHRINK indistinguishable from an
  // unmeasured growth. A reader sitting 300px up, a retraction (or a reaction removed) shrinking the
  // content by 250px: the post-shrink distance is 50px, a clamped delta is 0, and 50 - 0 lands under
  // the threshold — so the reader was yanked to the bottom by content DISAPPEARING.
  it('skips a measured shrink instead of reading it as an unmeasured growth', () => {
    expect(
      decideRowGrowth(atBottomAfterCard({ distanceFromBottom: 50, heightDelta: -250 })),
    ).toBe('skip')
  })

  // Nothing was pushed below the fold, and the browser clamps scrollTop itself when content shrinks
  // past it — the same reason a typing indicator turning off needs no re-pin.
  it('skips a shrink even for a reader sitting exactly at the bottom', () => {
    expect(
      decideRowGrowth(atBottomAfterCard({ distanceFromBottom: 0, heightDelta: -120 })),
    ).toBe('skip')
  })

  it('skips when the reader was genuinely scrolled up before the growth', () => {
    expect(decideRowGrowth(atBottomAfterCard({ distanceFromBottom: 1360, heightDelta: 260 }))).toBe('skip')
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
      decideRowGrowth(atBottomAfterCard({ distanceFromBottom: 1360, heightDelta: 260, pinClaimHeld: true })),
    ).toBe('skip')
  })
})
