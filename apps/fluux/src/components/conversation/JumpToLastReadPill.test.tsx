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
})
