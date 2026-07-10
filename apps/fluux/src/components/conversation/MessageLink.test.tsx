// @vitest-environment jsdom
import { describe, it, expect } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { MessageLink } from './MessageLink'

describe('MessageLink', () => {
  it('renders an anchor to the href', () => {
    render(<MessageLink href="https://example.com" />)
    const a = screen.getByRole('link', { name: 'https://example.com' })
    expect(a).toHaveAttribute('href', 'https://example.com')
    expect(a).toHaveAttribute('target', '_blank')
  })

  it('opens the context menu on right-click', () => {
    render(<MessageLink href="https://example.com" />)
    // menu is closed initially
    expect(screen.queryByText('Copy link')).toBeNull()
    fireEvent.contextMenu(screen.getByRole('link'))
    expect(screen.getByText('Copy link')).toBeInTheDocument()
  })
})
