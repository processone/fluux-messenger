import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { MessageBody } from './MessageBody'

// Mock i18next
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, string>) => {
      if (key === 'chat.originalMessage' && options?.body) {
        return `Original: ${options.body}`
      }
      if (key === 'chat.messageWasEdited') return 'Message was edited'
      if (key === 'chat.messageDeleted') return 'Message deleted'
      if (key === 'chat.edited') return '(edited)'
      return key
    },
  }),
}))

// Mock messageStyles
vi.mock('@/utils/messageStyles', () => ({
  renderStyledMessage: (text: string) => text,
}))

describe('MessageBody', () => {
  const defaultProps = {
    body: 'Hello, world!',
    senderName: 'Alice',
    senderColor: '#ff0000',
  }

  describe('Regular messages', () => {
    it('should render regular message body', () => {
      render(<MessageBody {...defaultProps} />)

      expect(screen.getByText('Hello, world!')).toBeInTheDocument()
    })

    it('should render message with styling', () => {
      render(<MessageBody {...defaultProps} body="Check this **bold** text" />)

      expect(screen.getByText('Check this **bold** text')).toBeInTheDocument()
    })

    it('should render raw text when noStyling is true', () => {
      render(<MessageBody {...defaultProps} body="No **styling** here" noStyling={true} />)

      expect(screen.getByText('No **styling** here')).toBeInTheDocument()
    })
  })

  describe('Retracted messages', () => {
    it('should show deleted placeholder for retracted messages', () => {
      render(<MessageBody {...defaultProps} isRetracted={true} />)

      expect(screen.getByText('Message deleted')).toBeInTheDocument()
      expect(screen.queryByText('Hello, world!')).not.toBeInTheDocument()
    })
  })

  describe('Action messages (/me)', () => {
    it('should render /me action message with sender name inline', () => {
      render(<MessageBody {...defaultProps} body="/me waves hello" />)

      expect(screen.getByText('Alice')).toBeInTheDocument()
      expect(screen.getByText('waves hello')).toBeInTheDocument()
      expect(screen.getByText('*')).toBeInTheDocument()
    })

    it('should apply sender color to name in /me message', () => {
      render(<MessageBody {...defaultProps} body="/me is here" />)

      const nameElement = screen.getByText('Alice')
      expect(nameElement).toHaveStyle({ color: '#ff0000' })
    })

    it('should render /me message as italic', () => {
      const { container } = render(<MessageBody {...defaultProps} body="/me dances" />)

      const italicDiv = container.querySelector('.italic')
      expect(italicDiv).toBeInTheDocument()
    })
  })

  describe('Edited indicator', () => {
    it('should show edited indicator when isEdited is true', () => {
      render(<MessageBody {...defaultProps} isEdited={true} />)

      expect(screen.getByText('(edited)')).toBeInTheDocument()
    })

    it('should not show edited indicator when isEdited is false', () => {
      render(<MessageBody {...defaultProps} isEdited={false} />)

      expect(screen.queryByText('(edited)')).not.toBeInTheDocument()
    })

    it('should show original body in tooltip when provided', () => {
      render(
        <MessageBody
          {...defaultProps}
          isEdited={true}
          originalBody="Original text"
        />
      )

      const editedSpan = screen.getByText('(edited)')
      expect(editedSpan).toHaveAttribute('title', 'Original: Original text')
    })

    it('should show generic tooltip when no original body', () => {
      render(<MessageBody {...defaultProps} isEdited={true} />)

      const editedSpan = screen.getByText('(edited)')
      expect(editedSpan).toHaveAttribute('title', 'Message was edited')
    })

    it('should show edited indicator on /me messages', () => {
      render(
        <MessageBody
          {...defaultProps}
          body="/me waves"
          isEdited={true}
        />
      )

      expect(screen.getByText('(edited)')).toBeInTheDocument()
    })
  })

  describe('Empty body handling', () => {
    it('should return null when body is empty (SDK stripped attachment URL)', () => {
      const { container } = render(
        <MessageBody {...defaultProps} body="" />
      )

      expect(container.firstChild).toBeNull()
    })

    it('should render body when it has content', () => {
      render(<MessageBody {...defaultProps} />)

      expect(screen.getByText('Hello, world!')).toBeInTheDocument()
    })
  })

  describe('Edge cases', () => {
    it('should return null for empty body', () => {
      const { container } = render(<MessageBody {...defaultProps} body="" />)

      // Empty body returns null (body was likely just an attachment URL stripped by SDK)
      expect(container.firstChild).toBeNull()
    })

    it('should handle /me without action text', () => {
      render(<MessageBody {...defaultProps} body="/me " />)

      expect(screen.getByText('Alice')).toBeInTheDocument()
    })

    it('should not treat /me in middle of message as action', () => {
      render(<MessageBody {...defaultProps} body="I said /me waves" />)

      // Should render as regular message, not as action
      expect(screen.getByText('I said /me waves')).toBeInTheDocument()
      expect(screen.queryByText('*')).not.toBeInTheDocument()
    })
  })
})
