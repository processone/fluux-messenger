import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { MessagesHeaderActions } from './MessagesHeaderActions'

describe('MessagesHeaderActions', () => {
  it('renders the archive toggle inactive and fires onToggleArchived', () => {
    const onToggleArchived = vi.fn()
    render(
      <MessagesHeaderActions showArchived={false} onToggleArchived={onToggleArchived} onNewMessage={vi.fn()} />,
    )
    const toggle = screen.getByRole('button', { name: 'Show archived conversations' })
    expect(toggle).toHaveAttribute('aria-pressed', 'false')
    fireEvent.click(toggle)
    expect(onToggleArchived).toHaveBeenCalledTimes(1)
  })

  it('reflects the active archived state via aria-pressed and label', () => {
    render(<MessagesHeaderActions showArchived onToggleArchived={vi.fn()} onNewMessage={vi.fn()} />)
    const toggle = screen.getByRole('button', { name: 'Show active conversations' })
    expect(toggle).toHaveAttribute('aria-pressed', 'true')
  })

  it('fires onNewMessage when the create button is clicked', () => {
    const onNewMessage = vi.fn()
    render(<MessagesHeaderActions showArchived={false} onToggleArchived={vi.fn()} onNewMessage={onNewMessage} />)
    fireEvent.click(screen.getByRole('button', { name: 'New message' }))
    expect(onNewMessage).toHaveBeenCalledTimes(1)
  })
})
