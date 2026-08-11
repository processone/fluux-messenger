import { describe, expect, it } from 'vitest'
import {
  decideMediaBatchOutcome,
  isGenuineScrollDuringBatch,
} from './mediaGrowthDecisions'

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

describe('isGenuineScrollDuringBatch', () => {
  const base = {
    batchActive: true,
    controllerOwnsPixels: false,
    previousScrollHeight: 5_000,
    scrollHeight: 5_000,
  }

  it('counts a move that left the content height alone', () => {
    expect(isGenuineScrollDuringBatch(base)).toBe(true)
  })

  it('ignores the scroll event media growth fires as it decodes', () => {
    // This is the whole defect it guards: a growth event marking userScrolled made the handler
    // "respect" a position the reader never chose, leaving the view drifted.
    expect(
      isGenuineScrollDuringBatch({ ...base, scrollHeight: 5_400 }),
    ).toBe(false)
  })

  it('ignores a scroll the controller itself is driving', () => {
    expect(
      isGenuineScrollDuringBatch({ ...base, controllerOwnsPixels: true }),
    ).toBe(false)
  })

  it('ignores everything when no batch is open', () => {
    expect(isGenuineScrollDuringBatch({ ...base, batchActive: false })).toBe(false)
  })

  it('ignores the first observation, which has no previous height to compare', () => {
    expect(
      isGenuineScrollDuringBatch({ ...base, previousScrollHeight: undefined }),
    ).toBe(false)
    expect(
      isGenuineScrollDuringBatch({ ...base, previousScrollHeight: null }),
    ).toBe(false)
  })
})
