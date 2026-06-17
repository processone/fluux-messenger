import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { MessageActionSheet } from './MessageActionSheet'

// Local i18n mock — return readable labels so we can query by text.
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) => {
      if (key === 'chat.reactWith') return `React with ${opts?.emoji}`
      const map: Record<string, string> = {
        'chat.reply': 'Reply',
        'chat.copyMessage': 'Copy text',
        'chat.editMessage': 'Edit message',
        'chat.deleteMessage': 'Delete message',
        'chat.moreReactions': 'More reactions',
        'chat.moreOptions': 'More options',
      }
      return map[key] ?? key
    },
  }),
}))

const baseProps = {
  open: true,
  onClose: vi.fn(),
  onReaction: vi.fn(),
  myReactions: [] as string[],
  body: 'hello world',
  onReply: vi.fn(),
  onEdit: vi.fn(),
  onDelete: vi.fn(),
  canReply: true,
  canEdit: true,
  canDelete: true,
}

describe('MessageActionSheet', () => {
  it('renders nothing when closed', () => {
    render(<MessageActionSheet {...baseProps} open={false} />)
    expect(screen.queryByText('Reply')).toBeNull()
  })

  it('shows reactions and every action for an editable, deletable message with a body', () => {
    render(<MessageActionSheet {...baseProps} />)
    expect(screen.getByLabelText('React with 👍')).toBeTruthy()
    expect(screen.getByLabelText('More reactions')).toBeTruthy()
    expect(screen.getByText('Reply')).toBeTruthy()
    expect(screen.getByText('Copy text')).toBeTruthy()
    expect(screen.getByText('Edit message')).toBeTruthy()
    expect(screen.getByText('Delete message')).toBeTruthy()
  })

  it('hides the reaction row when reactions are disabled (no stable identity)', () => {
    render(<MessageActionSheet {...baseProps} onReaction={undefined} />)
    expect(screen.queryByLabelText('React with 👍')).toBeNull()
    expect(screen.getByText('Reply')).toBeTruthy()
  })

  it('gates edit/delete on permission and copy on a non-empty body', () => {
    render(<MessageActionSheet {...baseProps} canEdit={false} canDelete={false} body="" />)
    expect(screen.queryByText('Edit message')).toBeNull()
    expect(screen.queryByText('Delete message')).toBeNull()
    expect(screen.queryByText('Copy text')).toBeNull()
    expect(screen.getByText('Reply')).toBeTruthy()
  })

  it('invokes the action and closes when an action row is tapped', () => {
    const onReply = vi.fn()
    const onClose = vi.fn()
    render(<MessageActionSheet {...baseProps} onReply={onReply} onClose={onClose} />)
    fireEvent.click(screen.getByText('Reply'))
    expect(onReply).toHaveBeenCalledTimes(1)
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('reacts with the chosen emoji and closes when a quick reaction is tapped', () => {
    const onReaction = vi.fn()
    const onClose = vi.fn()
    render(<MessageActionSheet {...baseProps} onReaction={onReaction} onClose={onClose} />)
    fireEvent.click(screen.getByLabelText('React with ❤️'))
    expect(onReaction).toHaveBeenCalledWith('❤️')
    expect(onClose).toHaveBeenCalledTimes(1)
  })
})
