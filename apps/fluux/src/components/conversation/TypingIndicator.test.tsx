import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { TypingIndicator } from './TypingIndicator'

describe('TypingIndicator', () => {
  describe('empty state', () => {
    it('should render nothing when typingUsers is empty', () => {
      const { container } = render(<TypingIndicator typingUsers={[]} />)
      expect(container.firstChild).toBeNull()
    })
  })

  describe('single user', () => {
    it('should show "X is typing..." for one user', () => {
      render(<TypingIndicator typingUsers={['Alice']} />)
      expect(screen.getByText('Alice is typing...')).toBeInTheDocument()
    })

    it('should use formatUser when provided', () => {
      const formatUser = (jid: string) => jid.split('@')[0].toUpperCase()
      render(
        <TypingIndicator
          typingUsers={['alice@example.com']}
          formatUser={formatUser}
        />
      )
      expect(screen.getByText('ALICE is typing...')).toBeInTheDocument()
    })
  })

  describe('two users', () => {
    it('should show "X and Y are typing..." for two users', () => {
      render(<TypingIndicator typingUsers={['Alice', 'Bob']} />)
      expect(screen.getByText('Alice and Bob are typing...')).toBeInTheDocument()
    })
  })

  describe('three users', () => {
    it('should show "X, Y, and Z are typing..." for three users', () => {
      render(<TypingIndicator typingUsers={['Alice', 'Bob', 'Charlie']} />)
      expect(screen.getByText('Alice, Bob, and Charlie are typing...')).toBeInTheDocument()
    })
  })

  describe('many users', () => {
    it('should show "X, Y, and N others are typing..." for more than three users', () => {
      render(<TypingIndicator typingUsers={['Alice', 'Bob', 'Charlie', 'Dave']} />)
      expect(screen.getByText('Alice, Bob, and 2 others are typing...')).toBeInTheDocument()
    })

    it('should handle 5+ users correctly', () => {
      render(<TypingIndicator typingUsers={['A', 'B', 'C', 'D', 'E', 'F']} />)
      expect(screen.getByText('A, B, and 4 others are typing...')).toBeInTheDocument()
    })
  })

  describe('animated dots', () => {
    it('should render three aurora typing dots', () => {
      render(<TypingIndicator typingUsers={['Alice']} />)
      const dots = document.querySelectorAll('.typing-dot')
      expect(dots).toHaveLength(3)
      // shape is retained; bounce + aurora-hue shimmer (and their stagger) live in CSS
      dots.forEach((dot) => expect(dot).toHaveClass('rounded-full'))
    })

    it('marks the dots decorative (the text conveys who is typing)', () => {
      render(<TypingIndicator typingUsers={['Alice']} />)
      expect(document.querySelector('.typing-dot')?.closest('[aria-hidden="true"]')).not.toBeNull()
    })
  })

  describe('styling', () => {
    it('should apply default classes', () => {
      render(<TypingIndicator typingUsers={['Alice']} />)
      const container = screen.getByText('Alice is typing...').parentElement
      expect(container).toHaveClass('py-2', 'px-4', 'text-sm', 'text-fluux-muted', 'italic')
    })

    it('should apply custom className', () => {
      render(<TypingIndicator typingUsers={['Alice']} className="custom-class" />)
      const container = screen.getByText('Alice is typing...').parentElement
      expect(container).toHaveClass('custom-class')
    })
  })

  describe('formatUser integration', () => {
    it('should format all users with formatUser function', () => {
      const contacts = new Map([
        ['alice@example.com', 'Alice Smith'],
        ['bob@example.com', 'Bob Jones'],
      ])
      const formatUser = (jid: string) => contacts.get(jid) || jid.split('@')[0]

      render(
        <TypingIndicator
          typingUsers={['alice@example.com', 'bob@example.com']}
          formatUser={formatUser}
        />
      )
      expect(screen.getByText('Alice Smith and Bob Jones are typing...')).toBeInTheDocument()
    })

    it('should fall back gracefully when contact not found', () => {
      const contacts = new Map([['alice@example.com', 'Alice Smith']])
      const formatUser = (jid: string) => contacts.get(jid) || jid.split('@')[0]

      render(
        <TypingIndicator
          typingUsers={['alice@example.com', 'unknown@example.com']}
          formatUser={formatUser}
        />
      )
      expect(screen.getByText('Alice Smith and unknown are typing...')).toBeInTheDocument()
    })
  })

  describe('TypingIndicator variants', () => {
    it('renders nothing when no one is typing', () => {
      const { container } = render(<TypingIndicator typingUsers={[]} />)
      expect(container.firstChild).toBeNull()
    })

    it('uses message-view padding by default', () => {
      const { container } = render(<TypingIndicator typingUsers={['Alice']} />)
      const root = container.firstChild as HTMLElement
      expect(root.className).toContain('py-2')
      expect(root.className).toContain('text-sm')
    })

    it('drops padding and shrinks text in the compact variant', () => {
      const { container } = render(
        <TypingIndicator typingUsers={['Alice']} variant="compact" />,
      )
      const root = container.firstChild as HTMLElement
      expect(root.className).not.toContain('py-2')
      expect(root.className).toContain('text-xs')
    })

    it('still renders three shimmer dots in the compact variant', () => {
      const { container } = render(
        <TypingIndicator typingUsers={['Alice']} variant="compact" />,
      )
      expect(container.querySelectorAll('.typing-dot').length).toBe(3)
    })
  })
})
