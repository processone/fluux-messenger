/**
 * NewMessageMarker's count-driven label. Uses the REAL react-i18next
 * (via the global test-setup.ts init), unlike NewMessageMarker.test.tsx's `t: (k) => k` echo mock,
 * because these assertions need the actual interpolated/pluralized text.
 */
import { describe, it, expect } from 'vitest'
import { render } from '@testing-library/react'
import { NewMessageMarker } from './NewMessageMarker'

describe('NewMessageMarker — count label', () => {
  it('falls back to the generic label when no count is given', () => {
    const { container } = render(<NewMessageMarker />)
    expect(container.querySelector('[data-new-message-marker]')?.textContent).toBe('New messages')
  })

  it('labels the canonical count, singular and plural', () => {
    const { container, rerender } = render(<NewMessageMarker count={1} />)
    expect(container.querySelector('[data-new-message-marker]')?.textContent).toBe('1 new message')

    rerender(<NewMessageMarker count={2} />)
    expect(container.querySelector('[data-new-message-marker]')?.textContent).toBe('2 new messages')
  })

  // Every numeric surface needs a 998/999/1000 test: the store saturates at 999 and never
  // reaches 1000, so `formatUnreadCount` must render 999 as "999+", not the exact "999".
  it('caps the label at 999+ for a saturated count (998/999/1000)', () => {
    const { container, rerender } = render(<NewMessageMarker count={998} />)
    expect(container.querySelector('[data-new-message-marker]')?.textContent).toBe('998 new messages')

    rerender(<NewMessageMarker count={999} />)
    expect(container.querySelector('[data-new-message-marker]')?.textContent).toBe('999+ new messages')

    rerender(<NewMessageMarker count={1000} />)
    expect(container.querySelector('[data-new-message-marker]')?.textContent).toBe('999+ new messages')
  })
})
