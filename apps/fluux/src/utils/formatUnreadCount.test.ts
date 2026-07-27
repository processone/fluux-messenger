import { describe, it, expect } from 'vitest'
import { formatUnreadCount } from './formatUnreadCount'

describe('formatUnreadCount', () => {
  it('renders small counts verbatim', () => {
    expect(formatUnreadCount(0)).toBe('0')
    expect(formatUnreadCount(1)).toBe('1')
    expect(formatUnreadCount(37)).toBe('37')
  })

  // The store's cap (Math.min(999, ...)) never reaches 1000 — 998/999/1000 is the exact
  // boundary every one of the five numeric surfaces must render identically.
  it('renders 998 verbatim, and caps 999 and above at "999+"', () => {
    expect(formatUnreadCount(998)).toBe('998')
    expect(formatUnreadCount(999)).toBe('999+')
    expect(formatUnreadCount(1000)).toBe('999+')
  })

  // Break check for the `>= 999` vs `> 999` distinction called out in the design: a saturated
  // count of exactly 999 must NOT render as the exact number "999" — that would misrepresent a
  // possibly-much-larger count as a precise one. `n > 999` would wrongly pass this.
  it('does not render a bare "999" for the saturated count', () => {
    expect(formatUnreadCount(999)).not.toBe('999')
  })
})
