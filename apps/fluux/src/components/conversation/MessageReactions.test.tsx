import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, act } from '@testing-library/react'
import { MessageReactions } from './MessageReactions'

// Mock the Tooltip component to make content testable
vi.mock('../Tooltip', () => ({
  Tooltip: ({ content, children }: { content: React.ReactNode; children: React.ReactNode }) => (
    <div data-tooltip={typeof content === 'string' ? content : undefined}>
      {typeof content !== 'string' && <div data-testid="tooltip-content">{content}</div>}
      {children}
    </div>
  ),
}))

describe('MessageReactions', () => {
  const defaultProps = {
    reactions: { '👍': ['alice', 'bob'], '❤️': ['charlie'] },
    myReactions: [] as string[],
    onReaction: vi.fn(),
    getReactorName: (id: string) => id.charAt(0).toUpperCase() + id.slice(1),
    isRetracted: false,
  }

  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('opens overflow reactors on hold and cancels holds when scrolling', () => {
    vi.useFakeTimers()
    try {
      const onShowReactors = vi.fn()
      const reactions = Object.fromEntries(['👍', '❤️', '😂', '🎉', '🔥', '👀', '👏', '🚀', '✅', '💯'].map((emoji) => [emoji, ['alice']]))
      render(<MessageReactions {...defaultProps} reactions={reactions} onShowReactors={onShowReactors} />)
      const overflow = screen.getByText('+1')
      fireEvent.touchStart(overflow)
      act(() => vi.advanceTimersByTime(500))
      fireEvent.touchEnd(overflow)
      fireEvent.click(overflow)
      expect(onShowReactors).toHaveBeenCalledExactlyOnceWith('💯')
      const chip = screen.getByText('👍').closest('button')!
      fireEvent.touchStart(chip)
      fireEvent.touchMove(chip)
      act(() => vi.advanceTimersByTime(500))
      expect(onShowReactors).toHaveBeenCalledTimes(1)
    } finally { vi.useRealTimers() }
  })

  it('keeps a short touch tap toggling the reaction', () => {
    vi.useFakeTimers()
    try {
      const onReaction = vi.fn()
      const onShowReactors = vi.fn()
      render(<MessageReactions {...defaultProps} onReaction={onReaction} onShowReactors={onShowReactors} />)
      const chip = screen.getByText('👍').closest('button')!
      fireEvent.touchStart(chip)
      act(() => vi.advanceTimersByTime(200))
      fireEvent.touchEnd(chip)
      fireEvent.click(chip)
      act(() => vi.advanceTimersByTime(500))
      expect(onReaction).toHaveBeenCalledExactlyOnceWith('👍')
      expect(onShowReactors).not.toHaveBeenCalled()
    } finally { vi.useRealTimers() }
  })

  it('does not open overflow reactors on a short tap', () => {
    const onShowReactors = vi.fn()
    const reactions = Object.fromEntries(Array.from({ length: 10 }, (_, index) => [String(index), ['alice']]))
    render(<MessageReactions {...defaultProps} reactions={reactions} onShowReactors={onShowReactors} />)
    fireEvent.touchStart(screen.getByText('+1'))
    fireEvent.touchEnd(screen.getByText('+1'))
    fireEvent.click(screen.getByText('+1'))
    expect(onShowReactors).not.toHaveBeenCalled()
  })

  it.each(['removed', 'no-reactions', 'empty', 'retracted', 'overflow'] as const)('cancels a pending hold when its target is %s', (change) => {
    vi.useFakeTimers()
    try {
      const onShowReactors = vi.fn()
      const reactions: Record<string, string[]> = change === 'overflow'
        ? Object.fromEntries(Array.from({ length: 10 }, (_, index) => [String(index), ['alice']]))
        : { '👍': ['alice'], '❤️': ['bob'] }
      const { rerender } = render(<MessageReactions {...defaultProps} reactions={reactions} onShowReactors={onShowReactors} />)
      const chip = change === 'overflow' ? screen.getByText('+1') : screen.getByText('👍').closest('button')!
      fireEvent.touchStart(chip)
      act(() => vi.advanceTimersByTime(200))
      const updated: Record<string, string[]> = change === 'overflow' ? { '9': ['alice'] }
        : change === 'no-reactions' ? {}
        : change === 'empty' ? { '👍': [], '❤️': ['bob'] }
        : change === 'removed' ? { '❤️': ['bob'] } : reactions
      rerender(<MessageReactions {...defaultProps} reactions={updated} isRetracted={change === 'retracted'} onShowReactors={onShowReactors} />)
      act(() => vi.advanceTimersByTime(500))
      expect(onShowReactors).not.toHaveBeenCalled()
    } finally { vi.useRealTimers() }
  })

  it('keeps a pending hold when the held emoji still has reactors', () => {
    vi.useFakeTimers()
    try {
      const onShowReactors = vi.fn()
      const { rerender } = render(<MessageReactions {...defaultProps} onShowReactors={onShowReactors} />)
      fireEvent.touchStart(screen.getByText('👍').closest('button')!)
      rerender(<MessageReactions {...defaultProps} reactions={{ '👍': ['alice'], '❤️': ['bob'] }} onShowReactors={onShowReactors} />)
      act(() => vi.advanceTimersByTime(500))
      expect(onShowReactors).toHaveBeenCalledExactlyOnceWith('👍')
    } finally { vi.useRealTimers() }
  })

  it.each(['removed', 'empty', 'reordered'] as const)('cancels an overflow hold when its captured emoji is %s and the button survives', (change) => {
    vi.useFakeTimers()
    try {
      const emojis = ['👍', '❤️', '😂', '🎉', '🔥', '👀', '👏', '🚀', '✅', '💯', '😎']
      const reactions = Object.fromEntries(emojis.map(emoji => [emoji, ['alice']]))
      const onShowReactors = vi.fn()
      const { rerender } = render(<MessageReactions {...defaultProps} reactions={reactions} onShowReactors={onShowReactors} />)
      const overflow = screen.getByText('+2')
      expect(overflow).toHaveAttribute('data-reaction-emoji', '💯')
      fireEvent.touchStart(overflow)
      act(() => vi.advanceTimersByTime(200))
      const updated = change === 'removed' ? Object.fromEntries(Object.entries(reactions).filter(([emoji]) => emoji !== '💯'))
        : { ...reactions, '💯': change === 'empty' ? [] : ['alice', 'bob'] }
      rerender(<MessageReactions {...defaultProps} reactions={updated} onShowReactors={onShowReactors} />)
      const survivingOverflow = screen.getByText(change === 'reordered' ? '+2' : '+1')
      expect(survivingOverflow).toBe(overflow)
      expect(survivingOverflow).toHaveAttribute('data-reaction-emoji', change === 'reordered' ? '✅' : '😎')
      act(() => vi.advanceTimersByTime(500))
      expect(onShowReactors).not.toHaveBeenCalled()
      fireEvent.touchEnd(survivingOverflow)
      fireEvent.click(survivingOverflow)
      expect(onShowReactors).not.toHaveBeenCalled()
      fireEvent.touchStart(survivingOverflow)
      act(() => vi.advanceTimersByTime(500))
      expect(onShowReactors).toHaveBeenCalledExactlyOnceWith(change === 'reordered' ? '✅' : '😎')
    } finally { vi.useRealTimers() }
  })

  it.each(['touchMove', 'touchCancel'] as const)('cancels the hold on %s', (event) => {
    vi.useFakeTimers()
    try {
      const onShowReactors = vi.fn()
      render(<MessageReactions {...defaultProps} onShowReactors={onShowReactors} />)
      const chip = screen.getByText('👍').closest('button')!
      fireEvent.touchStart(chip)
      fireEvent[event](chip)
      act(() => vi.advanceTimersByTime(500))
      expect(onShowReactors).not.toHaveBeenCalled()
    } finally { vi.useRealTimers() }
  })

  describe('Rendering', () => {
    it('should render reaction pills', () => {
      render(<MessageReactions {...defaultProps} />)

      expect(screen.getByText('👍')).toBeInTheDocument()
      expect(screen.getByText('❤️')).toBeInTheDocument()
    })

    it('should show reaction counts', () => {
      render(<MessageReactions {...defaultProps} />)

      // 👍 has 2 reactors, ❤️ has 1
      expect(screen.getByText('2')).toBeInTheDocument()
      expect(screen.getByText('1')).toBeInTheDocument()
    })

    it('should show reactor names in tooltip', () => {
      render(<MessageReactions {...defaultProps} />)

      const thumbsWrapper = screen.getByText('👍').closest('[data-tooltip]')
      expect(thumbsWrapper).toHaveAttribute('data-tooltip', 'Alice, Bob')

      const heartWrapper = screen.getByText('❤️').closest('[data-tooltip]')
      expect(heartWrapper).toHaveAttribute('data-tooltip', 'Charlie')
    })

    it('should not render when no reactions', () => {
      const { container } = render(
        <MessageReactions {...defaultProps} reactions={{}} />
      )

      expect(container.firstChild).toBeNull()
    })

    it('should not render when isRetracted is true', () => {
      const { container } = render(
        <MessageReactions {...defaultProps} isRetracted={true} />
      )

      expect(container.firstChild).toBeNull()
    })
  })

  describe('User reactions highlighting', () => {
    it('should highlight reactions user has made', () => {
      render(<MessageReactions {...defaultProps} myReactions={['👍']} />)

      const thumbsButton = screen.getByText('👍').closest('button')
      const heartButton = screen.getByText('❤️').closest('button')

      expect(thumbsButton).toHaveClass('bg-fluux-brand/20')
      expect(thumbsButton).toHaveClass('border-fluux-brand')
      expect(heartButton).not.toHaveClass('bg-fluux-brand/20')
    })

    it('should highlight multiple user reactions', () => {
      render(<MessageReactions {...defaultProps} myReactions={['👍', '❤️']} />)

      const thumbsButton = screen.getByText('👍').closest('button')
      const heartButton = screen.getByText('❤️').closest('button')

      expect(thumbsButton).toHaveClass('bg-fluux-brand/20')
      expect(heartButton).toHaveClass('bg-fluux-brand/20')
    })
  })

  describe('Interaction', () => {
    it('should call onReaction when clicking a reaction', () => {
      const onReaction = vi.fn()
      render(<MessageReactions {...defaultProps} onReaction={onReaction} />)

      fireEvent.click(screen.getByText('👍'))

      expect(onReaction).toHaveBeenCalledWith('👍')
    })

    it('should call onReaction with correct emoji', () => {
      const onReaction = vi.fn()
      render(<MessageReactions {...defaultProps} onReaction={onReaction} />)

      fireEvent.click(screen.getByText('❤️'))

      expect(onReaction).toHaveBeenCalledWith('❤️')
    })
  })

  describe('Reactor name formatting', () => {
    it('should use getReactorName for tooltip', () => {
      const getReactorName = vi.fn((id: string) => `User: ${id}`)
      render(
        <MessageReactions
          {...defaultProps}
          reactions={{ '🎉': ['user1', 'user2'] }}
          getReactorName={getReactorName}
        />
      )

      // Verify getReactorName was called (map passes extra args, so just check it was called)
      expect(getReactorName).toHaveBeenCalledTimes(2)

      const wrapper = screen.getByText('🎉').closest('[data-tooltip]')
      expect(wrapper).toHaveAttribute('data-tooltip', 'User: user1, User: user2')
    })

    it('should handle "You" for current user in tooltip', () => {
      const getReactorName = (id: string) => id === 'me' ? 'You' : id
      render(
        <MessageReactions
          {...defaultProps}
          reactions={{ '👍': ['me', 'alice'] }}
          getReactorName={getReactorName}
        />
      )

      const wrapper = screen.getByText('👍').closest('[data-tooltip]')
      expect(wrapper).toHaveAttribute('data-tooltip', 'You, alice')
    })
  })

  describe('Multiple reactions', () => {
    it('should render many reactions', () => {
      render(
        <MessageReactions
          {...defaultProps}
          reactions={{
            '👍': ['a'],
            '❤️': ['b'],
            '😂': ['c'],
            '🎉': ['d'],
            '🔥': ['e'],
          }}
        />
      )

      expect(screen.getByText('👍')).toBeInTheDocument()
      expect(screen.getByText('❤️')).toBeInTheDocument()
      expect(screen.getByText('😂')).toBeInTheDocument()
      expect(screen.getByText('🎉')).toBeInTheDocument()
      expect(screen.getByText('🔥')).toBeInTheDocument()
    })

    it('should handle single reactor', () => {
      render(
        <MessageReactions
          {...defaultProps}
          reactions={{ '👍': ['alice'] }}
        />
      )

      const wrapper = screen.getByText('👍').closest('[data-tooltip]')
      expect(wrapper).toHaveAttribute('data-tooltip', 'Alice')
      expect(screen.getByText('1')).toBeInTheDocument()
    })

    it('should handle many reactors on one emoji', () => {
      render(
        <MessageReactions
          {...defaultProps}
          reactions={{ '👍': ['a', 'b', 'c', 'd', 'e'] }}
        />
      )

      expect(screen.getByText('5')).toBeInTheDocument()
    })
  })

  describe('Sorting by count', () => {
    it('should sort reactions by decreasing count', () => {
      render(
        <MessageReactions
          {...defaultProps}
          reactions={{
            '😂': ['a'],
            '👍': ['a', 'b', 'c'],
            '❤️': ['a', 'b'],
          }}
        />
      )

      const buttons = screen.getAllByRole('button')
      expect(buttons[0]).toHaveTextContent('👍')
      expect(buttons[1]).toHaveTextContent('❤️')
      expect(buttons[2]).toHaveTextContent('😂')
    })
  })

  describe('Overflow limiting', () => {
    const manyReactions: Record<string, string[]> = {
      '1️⃣': ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j'], // 10
      '2️⃣': ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i'],       // 9
      '3️⃣': ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'],             // 8
      '4️⃣': ['a', 'b', 'c', 'd', 'e', 'f', 'g'],                   // 7
      '5️⃣': ['a', 'b', 'c', 'd', 'e', 'f'],                        // 6
      '6️⃣': ['a', 'b', 'c', 'd', 'e'],                              // 5
      '7️⃣': ['a', 'b', 'c', 'd'],                                    // 4
      '8️⃣': ['a', 'b', 'c'],                                         // 3
      '9️⃣': ['a', 'b'],                                               // 2
      '🔟': ['a'],                                                     // 1 — overflow
      '🅰️': ['a'],                                                     // 1 — overflow
      '🅱️': ['a'],                                                     // 1 — overflow
    }

    it('should show only top 9 reactions inline', () => {
      render(<MessageReactions {...defaultProps} reactions={manyReactions} />)

      // First 9 should be visible as buttons
      const buttons = screen.getAllByRole('button').filter((button) => button.textContent?.includes('+') === false)
      expect(buttons).toHaveLength(9)
    })

    it('should show overflow indicator with correct count', () => {
      render(<MessageReactions {...defaultProps} reactions={manyReactions} />)

      expect(screen.getByText('+3')).toBeInTheDocument()
    })

    it('should show overflow reactions in tooltip', () => {
      render(<MessageReactions {...defaultProps} reactions={manyReactions} />)

      const tooltipContents = screen.getAllByTestId('tooltip-content')
      // The overflow tooltip is the last one
      const overflowTooltip = tooltipContents[tooltipContents.length - 1]
      expect(overflowTooltip).toBeInTheDocument()
      // Each overflow emoji should be listed in the tooltip
      expect(overflowTooltip).toHaveTextContent('🔟')
      expect(overflowTooltip).toHaveTextContent('🅰️')
      expect(overflowTooltip).toHaveTextContent('🅱️')
    })

    it('should not show overflow when 9 or fewer reactions', () => {
      const nineReactions: Record<string, string[]> = {}
      const emojis = ['👍', '❤️', '😂', '🎉', '🔥', '👏', '😎', '🙌', '💯']
      emojis.forEach((e) => { nineReactions[e] = ['a'] })

      render(<MessageReactions {...defaultProps} reactions={nineReactions} />)

      const buttons = screen.getAllByRole('button').filter((button) => button.textContent?.includes('+') === false)
      expect(buttons).toHaveLength(9)
      expect(screen.queryByText(/^\+\d+$/)).not.toBeInTheDocument()
    })

    it('should cap overflow at 9 more reactions', () => {
      // 20 reactions total: 9 visible + 9 overflow (2 hidden beyond cap)
      const twentyReactions: Record<string, string[]> = {}
      const emojis = ['👍','❤️','😂','🎉','🔥','👏','😎','🙌','💯','🤔','🥳','🤩','😊','🥰','😇','🤗','🫡','🫶','🙏','✌️']
      emojis.forEach((e, i) => { twentyReactions[e] = Array.from({ length: 20 - i }, (_, j) => `user${j}`) })

      render(<MessageReactions {...defaultProps} reactions={twentyReactions} />)

      // Overflow should show +9 (capped), not +11
      expect(screen.getByText('+9')).toBeInTheDocument()
    })
  })
})
