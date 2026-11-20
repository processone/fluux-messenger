import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { MessageActionSheet } from './MessageActionSheet'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (k: string) => k }),
}))

const base = {
  open: true, onClose: vi.fn(), onReaction: vi.fn(), myReactions: [] as string[], body: 'hello',
  onReply: vi.fn(), onEdit: vi.fn(), onDelete: vi.fn(), canReply: true, canEdit: false, canDelete: false,
}

describe('MessageActionSheet saved entry', () => {
  it('offers Save message and toggles it', () => {
    const onToggleSaved = vi.fn()
    render(<MessageActionSheet {...base} onToggleSaved={onToggleSaved} isSaved={false} anchor={document.createElement('div')} />)
    fireEvent.click(screen.getByText('chat.saveMessage'))
    expect(onToggleSaved).toHaveBeenCalled()
  })
  it('offers Remove from saved for a saved message', () => {
    render(<MessageActionSheet {...base} onToggleSaved={vi.fn()} isSaved anchor={document.createElement('div')} />)
    expect(screen.getByText('chat.removeFromSaved')).toBeInTheDocument()
  })
  it('offers nothing without a toggle', () => {
    render(<MessageActionSheet {...base} anchor={document.createElement('div')} />)
    expect(screen.queryByText('chat.saveMessage')).toBeNull()
    expect(screen.queryByText('chat.removeFromSaved')).toBeNull()
  })
})
