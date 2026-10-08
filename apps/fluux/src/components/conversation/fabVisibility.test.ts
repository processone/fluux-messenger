import { describe, it, expect } from 'vitest'
import { shouldShowScrollToBottomFab } from './fabVisibility'
import { AT_BOTTOM_THRESHOLD } from '@/utils/scrollStateManager'

describe('shouldShowScrollToBottomFab', () => {
  it('shows the FAB at or beyond the threshold and not pinning', () => {
    for (const distance of [AT_BOTTOM_THRESHOLD, AT_BOTTOM_THRESHOLD + 0.5, AT_BOTTOM_THRESHOLD + 1]) {
      expect(shouldShowScrollToBottomFab(distance, AT_BOTTOM_THRESHOLD, false)).toBe(true)
    }
  })

  it('hides the FAB within the threshold', () => {
    for (const distance of [0, AT_BOTTOM_THRESHOLD - 1, AT_BOTTOM_THRESHOLD - 0.5]) {
      expect(shouldShowScrollToBottomFab(distance, AT_BOTTOM_THRESHOLD, false)).toBe(false)
    }
  })

  it('never shows the FAB while pinning to the bottom, even when a transient measurement reports a large distance', () => {
    // On WebKit, late row measurement grows scrollHeight and fires a 'scroll' event with a
    // transiently large distFromBottom DURING the open pin-to-bottom loop, before the loop re-pins.
    // The loop's whole purpose is to settle AT the bottom, so the FAB must stay hidden — otherwise
    // it flashes on open (intermittent, timing-dependent).
    for (const distance of [AT_BOTTOM_THRESHOLD - 1, AT_BOTTOM_THRESHOLD, AT_BOTTOM_THRESHOLD + 1, 1300]) {
      expect(shouldShowScrollToBottomFab(distance, AT_BOTTOM_THRESHOLD, true)).toBe(false)
    }
  })
})
