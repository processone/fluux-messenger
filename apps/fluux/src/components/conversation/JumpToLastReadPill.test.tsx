// @vitest-environment jsdom
import { render, screen, fireEvent } from '@testing-library/react'
import { describe, it, expect, vi } from 'vitest'
import { JumpToLastReadPill } from './JumpToLastReadPill'

describe('JumpToLastReadPill', () => {
  it('renders the count and jumps on click', () => {
    const onJump = vi.fn()
    render(<JumpToLastReadPill visible count={12} onJump={onJump} />)
    const pill = screen.getByRole('button', { name: /12 new messages/i })
    fireEvent.click(pill)
    expect(onJump).toHaveBeenCalled()
  })

  it('degrades to "You were away" when the count is unknown', () => {
    render(<JumpToLastReadPill visible count={0} onJump={() => {}} />)
    expect(screen.getByText('You were away')).toBeInTheDocument()
  })

  it('renders nothing when not visible', () => {
    const { container } = render(<JumpToLastReadPill visible={false} count={3} onJump={() => {}} />)
    expect(container.querySelector('[data-jump-to-last-read]')).toBeNull()
  })

  // The pill is one of the five numeric surfaces routed through the
  // shared formatUnreadCount — the store saturates at 999 (never reaching 1000), so 999 must
  // render as "999+", not the exact "999".
  it('caps the count at 999+ for a saturated value (998/999/1000)', () => {
    const { rerender } = render(<JumpToLastReadPill visible count={998} onJump={() => {}} />)
    expect(screen.getByText('998 new messages')).toBeInTheDocument()

    rerender(<JumpToLastReadPill visible count={999} onJump={() => {}} />)
    expect(screen.getByText('999+ new messages')).toBeInTheDocument()

    rerender(<JumpToLastReadPill visible count={1000} onJump={() => {}} />)
    expect(screen.getByText('999+ new messages')).toBeInTheDocument()
  })
})
