// Intent: FLM-229 keeps hit areas fixed without freezing action permissions or losing keyboard focus.
import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { useState } from 'react'
import { MessageToolbar } from './MessageToolbar'
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }))

function props() {
  return {
    onReaction: vi.fn(), onReply: vi.fn(), onEdit: vi.fn(), onDelete: vi.fn(),
    myReactions: [], canReply: false, canEdit: true, canDelete: true,
    isHidden: false, isSelected: false, hasKeyboardSelection: false,
    showToolbarForSelection: false, showReactionPicker: false, setShowReactionPicker: vi.fn(),
    showMoreMenu: false, setShowMoreMenu: vi.fn(), isHovered: true,
  }
}

describe('held toolbar actions', () => {
  it('keeps the original slots but denies newly forbidden edit, reaction and deletion actions', () => {
    const original = props()
    const { rerender, container } = render(<MessageToolbar {...original} />)
    const slots = [...container.querySelectorAll('button')].map(button => button.getAttribute('aria-label'))
    rerender(<MessageToolbar {...original} interactionHeld showMoreMenu />)
    rerender(<MessageToolbar {...original} interactionHeld showMoreMenu canReply canEdit={false} canDelete={false} onReaction={undefined} />)
    expect([...container.querySelectorAll('button[aria-label]')].map(button => button.getAttribute('aria-label'))).toEqual(slots)
    const edit = screen.getByLabelText('chat.editMessage')
    const reaction = screen.getAllByLabelText('chat.reactWith')[0]
    const deletion = screen.getByText('chat.deleteMessage')
    expect(edit).toBeDisabled()
    expect(reaction).toBeDisabled()
    expect(deletion).toBeDisabled()
    fireEvent.click(edit); fireEvent.click(reaction); fireEvent.click(deletion)
    expect(original.onEdit).not.toHaveBeenCalled()
    expect(original.onReaction).not.toHaveBeenCalled()
    expect(original.onDelete).not.toHaveBeenCalled()
    expect(screen.queryByLabelText('chat.reply')).not.toBeInTheDocument()
    rerender(<MessageToolbar {...original} canReply canEdit={false} onReaction={undefined} />)
    expect(screen.getByLabelText('chat.reply')).toBeInTheDocument()
    expect(screen.queryByLabelText('chat.editMessage')).not.toBeInTheDocument()
  })

  it('Escape closes More and restores its trigger before a broader conversation shortcut runs', () => {
    const outer = vi.fn()
    function Toolbar() {
      const [open, setOpen] = useState(false)
      return <MessageToolbar {...props()} showMoreMenu={open} setShowMoreMenu={setOpen} />
    }
    window.addEventListener('keydown', outer)
    render(<Toolbar />)
    const trigger = screen.getByLabelText('chat.moreOptions')
    fireEvent.click(trigger)
    const deletion = screen.getByText('chat.deleteMessage')
    deletion.focus()
    fireEvent.keyDown(deletion, { key: 'Escape' })
    expect(screen.queryByText('chat.deleteMessage')).not.toBeInTheDocument()
    expect(trigger).toHaveFocus()
    expect(outer).not.toHaveBeenCalled()
    fireEvent.keyDown(trigger, { key: 'Escape' })
    expect(outer).toHaveBeenCalledOnce()
    window.removeEventListener('keydown', outer)
  })
})
