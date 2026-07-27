import { describe, it, expect } from 'vitest'
import { decideRowGrowth, type RowGrowthFacts } from './rowGrowthDecision'

/** At the bottom, with a 260px card just mounted — the canonical fastening case. */
const atBottomAfterCard = (over: Partial<RowGrowthFacts> = {}): RowGrowthFacts => ({
  distanceFromBottom: 260,
  growth: 260,
  atBottomThreshold: 150,
  pinnedTolerance: 4,
  pinClaimHeld: false,
  navigationInFlight: false,
  readerTookOver: false,
  isRetry: false,
  eligibilityEstablished: false,
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

  it('skips when the reader was genuinely scrolled up before the growth', () => {
    expect(decideRowGrowth(atBottomAfterCard({ distanceFromBottom: 1360, growth: 260 }))).toBe('skip')
  })

  it('skips when the reader has scrolled since the growth was queued', () => {
    expect(decideRowGrowth(atBottomAfterCard({ readerTookOver: true }))).toBe('skip')
  })

  it('skips rather than cancel a navigation the reader asked for', () => {
    expect(decideRowGrowth(atBottomAfterCard({ navigationInFlight: true }))).toBe('skip')
  })

  it('skips a RETRY whose bottom the deferring loop already pinned', () => {
    expect(decideRowGrowth(atBottomAfterCard({ isRetry: true, distanceFromBottom: 2, growth: 2 }))).toBe('skip')
  })

  // On the first attempt a distance of ~0 means the spacer has not taken the growth yet, not that
  // the bottom is pinned. Skipping there would drop a growth no loop is going to absorb.
  it('still pins a FIRST attempt measuring ~0 distance (spacer has not caught up)', () => {
    expect(decideRowGrowth(atBottomAfterCard({ distanceFromBottom: 0, growth: 0 }))).toBe('pin')
  })

  // THE REGRESSION. A held claim is a BET that the running loop absorbs the growth. If that loop was
  // abandoned its claim lingers until it lapses, and because a signature change is consumed exactly
  // once, `skip` here would drop the fastening for good — it would never be pinned at all.
  it('DEFERS (never skips) while a pin loop holds the claim, so the caller can retry', () => {
    expect(decideRowGrowth(atBottomAfterCard({ pinClaimHeld: true }))).toBe('defer')
  })

  it('defers ahead of the navigation guard — a lapsed claim must still get its retry', () => {
    const decision = decideRowGrowth(
      atBottomAfterCard({ pinClaimHeld: true, navigationInFlight: true }),
    )
    expect(decision).toBe('defer')
  })

  // THE RETRY REGRESSION. By the time a deferred growth is retried, the growth has fired its own
  // scroll event and the baseline has moved forward to the GROWN height — so a freshly derived
  // growth is 0 and the card's own 260px reads as "the reader is scrolled up". Re-deriving
  // eligibility there skips the growth forever and the deferral buys nothing.
  it('pins a retry whose baseline has caught up, so growth now derives as 0', () => {
    const decision = decideRowGrowth(
      atBottomAfterCard({ isRetry: true, eligibilityEstablished: true, growth: 0, distanceFromBottom: 260 }),
    )
    expect(decision).toBe('pin')
  })

  it('still refuses that retry if the reader took over in the meantime', () => {
    const decision = decideRowGrowth(
      atBottomAfterCard({
        isRetry: true, eligibilityEstablished: true, growth: 0, distanceFromBottom: 260,
        readerTookOver: true,
      }),
    )
    expect(decision).toBe('skip')
  })

  it('still refuses that retry if a navigation started in the meantime', () => {
    const decision = decideRowGrowth(
      atBottomAfterCard({
        isRetry: true, eligibilityEstablished: true, growth: 0, distanceFromBottom: 260,
        navigationInFlight: true,
      }),
    )
    expect(decision).toBe('skip')
  })

  // Ordering guard: a reader who has moved, or who was never at the bottom, must lose to nothing —
  // not even a held claim should turn those into a retry that could later yank them.
  it.each([
    ['the reader took over', { readerTookOver: true }],
    ['the reader was scrolled up', { distanceFromBottom: 1360, growth: 260 }],
  ])('skips outright when %s, even with the claim held', (_label, over) => {
    expect(decideRowGrowth(atBottomAfterCard({ ...over, pinClaimHeld: true }))).toBe('skip')
  })
})
