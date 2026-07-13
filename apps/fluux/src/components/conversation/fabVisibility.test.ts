import { describe, it, expect } from 'vitest'
import { shouldShowScrollToBottomFab } from './fabVisibility'

describe('shouldShowScrollToBottomFab', () => {
  it('shows the FAB when scrolled past the threshold and not pinning', () => {
    expect(shouldShowScrollToBottomFab(400, 300, false)).toBe(true)
  })

  it('hides the FAB within the threshold', () => {
    expect(shouldShowScrollToBottomFab(100, 300, false)).toBe(false)
  })

  it('never shows the FAB while pinning to the bottom, even when a transient measurement reports a large distance', () => {
    // On WebKit, late row measurement grows scrollHeight and fires a 'scroll' event with a
    // transiently large distFromBottom DURING the open pin-to-bottom loop, before the loop re-pins.
    // The loop's whole purpose is to settle AT the bottom, so the FAB must stay hidden — otherwise
    // it flashes on open (intermittent, timing-dependent).
    expect(shouldShowScrollToBottomFab(1300, 300, true)).toBe(false)
  })
})
