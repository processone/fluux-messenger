import { describe, it, expect } from 'vitest'
import { shouldReplaceOnSelect } from './navigationHistory'

describe('shouldReplaceOnSelect', () => {
  it('pushes (does not replace) when selecting a different item than the active one', () => {
    // Switching from conversation A to B must create a back-able entry.
    expect(shouldReplaceOnSelect('b@example.com', 'a@example.com')).toBe(false)
  })

  it('replaces when re-selecting the already-active item (consecutive dedup)', () => {
    // Clicking the conversation that is already open should not stack a duplicate.
    expect(shouldReplaceOnSelect('a@example.com', 'a@example.com')).toBe(true)
  })

  it('pushes when nothing is active yet (first selection from the list)', () => {
    // The very first selection (list -> detail) is a back-able step to the list.
    expect(shouldReplaceOnSelect('a@example.com', null)).toBe(false)
  })
})
