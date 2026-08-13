import { describe, it, expect } from 'vitest'
import { decideTypingIndicator, type TypingIndicatorFacts } from './typingIndicatorDecision'

/** The indicator has just appeared under a reader glued to the bottom. */
const appearing: TypingIndicatorFacts = {
  staticMode: false,
  sameConversation: true,
  hasTypingIndicator: true,
  hadTypingIndicator: false,
  distanceFromBottom: 0,
  atBottomThreshold: 100,
}

describe('decideTypingIndicator', () => {
  it('pins when the band appears under a reader at the bottom', () => {
    expect(decideTypingIndicator(appearing)).toBe('pin')
  })

  it('skips in static mode, which has no positioning owner', () => {
    expect(decideTypingIndicator({ ...appearing, staticMode: true })).toBe('skip')
  })

  it('skips across a conversation switch', () => {
    expect(decideTypingIndicator({ ...appearing, sameConversation: false })).toBe('skip')
  })

  // Only the off -> on edge shrinks the scrollport. Typing stopping grows it back and the browser
  // clamps scrollTop itself, so there is nothing to correct.
  it('skips when the indicator was already showing', () => {
    expect(decideTypingIndicator({ ...appearing, hadTypingIndicator: true })).toBe('skip')
  })

  it('skips when the indicator turned off', () => {
    expect(decideTypingIndicator({
      ...appearing, hasTypingIndicator: false, hadTypingIndicator: true,
    })).toBe('skip')
  })

  it('skips when the reader is scrolled away from the bottom', () => {
    expect(decideTypingIndicator({ ...appearing, distanceFromBottom: 500 })).toBe('skip')
  })

  it('treats the threshold as exclusive, matching row growth', () => {
    expect(decideTypingIndicator({ ...appearing, distanceFromBottom: 99 })).toBe('pin')
    expect(decideTypingIndicator({ ...appearing, distanceFromBottom: 100 })).toBe('skip')
  })

  // The call site reports an absent scroller as infinitely far from the bottom.
  it('skips when there is no geometry to judge', () => {
    expect(decideTypingIndicator({
      ...appearing, distanceFromBottom: Number.POSITIVE_INFINITY,
    })).toBe('skip')
  })
})
