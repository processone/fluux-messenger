import { describe, expect, it } from 'vitest'
import { decideMediaBatchOutcome } from './mediaGrowthDecisions'

describe('decideMediaBatchOutcome', () => {
  it('follows the live edge when the reader was there and never moved', () => {
    expect(
      decideMediaBatchOutcome({
        wasAtBottom: true,
        userScrolled: false,
        hasAnchor: true,
      }),
    ).toEqual({ kind: 'live-edge' })
  })

  it('preserves the reading anchor when the reader was up in history', () => {
    // Paired with the case above: only wasAtBottom differs.
    expect(
      decideMediaBatchOutcome({
        wasAtBottom: false,
        userScrolled: false,
        hasAnchor: true,
      }),
    ).toEqual({ kind: 'preserve-anchor' })
  })

  it('respects a genuine move regardless of where the batch started', () => {
    // A reader who scrolled during decoding chose their position; neither correction may fire.
    expect(
      decideMediaBatchOutcome({
        wasAtBottom: true,
        userScrolled: true,
        hasAnchor: true,
      }),
    ).toEqual({ kind: 'respect-user' })
    expect(
      decideMediaBatchOutcome({
        wasAtBottom: false,
        userScrolled: true,
        hasAnchor: true,
      }),
    ).toEqual({ kind: 'respect-user' })
  })

  it('does nothing when scrolled up with no anchor captured', () => {
    expect(
      decideMediaBatchOutcome({
        wasAtBottom: false,
        userScrolled: false,
        hasAnchor: false,
      }),
    ).toEqual({ kind: 'none' })
  })

  it('still follows the live edge without an anchor, which it does not need', () => {
    expect(
      decideMediaBatchOutcome({
        wasAtBottom: true,
        userScrolled: false,
        hasAnchor: false,
      }),
    ).toEqual({ kind: 'live-edge' })
  })
})
