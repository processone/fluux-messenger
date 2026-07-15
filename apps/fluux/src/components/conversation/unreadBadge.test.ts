import { describe, it, expect } from 'vitest'
import { countNewBelowViewport } from './unreadBadge'

const msgs = (...ids: string[]) => ids.map((id) => ({ id }))

// List: a b [c] d e — divider at "c", so the new-message block is c, d, e (3 messages).
// `bottomVisibleId` is the bottom-most message whose top is within the viewport (peeking in at the
// bottom edge); messages STRICTLY below it are the ones still under the fold.
describe('countNewBelowViewport', () => {
  it('returns 0 when there is no new-message divider', () => {
    expect(countNewBelowViewport(msgs('a', 'b', 'c'), undefined, null)).toBe(0)
  })

  it('returns 0 when the divider id is not in the list', () => {
    expect(countNewBelowViewport(msgs('a', 'b', 'c'), 'gone', null)).toBe(0)
  })

  it('reports the full new-message count before any scroll is observed (bottomVisible null)', () => {
    expect(countNewBelowViewport(msgs('a', 'b', 'c', 'd', 'e'), 'c', null)).toBe(3)
  })

  it('reports the full count while the viewport bottom sits above the divider', () => {
    expect(countNewBelowViewport(msgs('a', 'b', 'c', 'd', 'e'), 'c', 'b')).toBe(3)
  })

  it('decrements once the divider peeks in at the bottom edge', () => {
    // c is now partially visible → only d, e remain below the fold
    expect(countNewBelowViewport(msgs('a', 'b', 'c', 'd', 'e'), 'c', 'c')).toBe(2)
  })

  it('keeps decrementing as further new messages scroll into view', () => {
    expect(countNewBelowViewport(msgs('a', 'b', 'c', 'd', 'e'), 'c', 'd')).toBe(1)
  })

  it('returns 0 when the newest message is the bottom-visible one', () => {
    expect(countNewBelowViewport(msgs('a', 'b', 'c', 'd', 'e'), 'c', 'e')).toBe(0)
  })

  it('falls back to the full count when the bottom-visible row was trimmed from the window', () => {
    expect(countNewBelowViewport(msgs('a', 'b', 'c', 'd', 'e'), 'c', 'trimmed')).toBe(3)
  })

  it('handles the divider being the first message', () => {
    expect(countNewBelowViewport(msgs('a', 'b', 'c'), 'a', null)).toBe(3)
    expect(countNewBelowViewport(msgs('a', 'b', 'c'), 'a', 'a')).toBe(2)
    expect(countNewBelowViewport(msgs('a', 'b', 'c'), 'a', 'c')).toBe(0)
  })
})
