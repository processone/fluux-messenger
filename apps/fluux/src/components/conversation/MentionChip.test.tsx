import { render, screen, fireEvent } from '@testing-library/react'
import { describe, it, expect, vi } from 'vitest'
import { MentionChip } from './MentionChip'

describe('MentionChip', () => {
  it('renders label + action and fires callbacks', () => {
    const onAction = vi.fn()
    const onDismiss = vi.fn()
    render(<MentionChip label="Ava sent fireworks" actionLabel="Replay" onAction={onAction} onDismiss={onDismiss} />)
    expect(screen.getByText('Ava sent fireworks')).toBeInTheDocument()
    fireEvent.click(screen.getByText('Replay'))
    expect(onAction).toHaveBeenCalledOnce()
    fireEvent.click(screen.getByLabelText('Dismiss'))
    expect(onDismiss).toHaveBeenCalledOnce()
  })
})
