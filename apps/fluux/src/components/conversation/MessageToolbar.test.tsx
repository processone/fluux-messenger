import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { MessageToolbar } from './MessageToolbar'

// Mock i18next
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, string>) => {
      if (key === 'chat.reactWith' && options?.emoji) {
        return `React with ${options.emoji}`
      }
      return key
    },
  }),
}))

// Mock lucide-react icons
vi.mock('lucide-react', () => ({
  SmilePlus: () => <span data-testid="icon-smile-plus">SmilePlus</span>,
  Pencil: () => <span data-testid="icon-pencil">Pencil</span>,
  Forward: () => <span data-testid="icon-forward">Forward</span>,
  MoreHorizontal: () => <span data-testid="icon-more">More</span>,
  Reply: () => <span data-testid="icon-reply">Reply</span>,
  Trash2: () => <span data-testid="icon-trash">Trash</span>,
}))

// Mock useClickOutside hook
vi.mock('@/hooks', () => ({
  useClickOutside: vi.fn(),
}))

// Mock lazy-loaded EmojiPicker — must export as default for React.lazy()
vi.mock('../EmojiPicker', () => ({
  default: ({ onSelect, onClose }: { onSelect: (emoji: string) => void; onClose: () => void }) => (
    <div data-testid="emoji-picker">
      <button onClick={() => onSelect('🎉')} data-testid="emoji-picker-select">Select emoji</button>
      <button onClick={onClose} data-testid="emoji-picker-close">Close</button>
    </div>
  ),
  EmojiPicker: ({ onSelect, onClose }: { onSelect: (emoji: string) => void; onClose: () => void }) => (
    <div data-testid="emoji-picker">
      <button onClick={() => onSelect('🎉')} data-testid="emoji-picker-select">Select emoji</button>
      <button onClick={onClose} data-testid="emoji-picker-close">Close</button>
    </div>
  ),
}))

describe('MessageToolbar', () => {
  const defaultProps = {
    onReaction: vi.fn(),
    onReply: vi.fn(),
    onEdit: vi.fn(),
    onDelete: vi.fn(),
    myReactions: [] as string[],
    canReply: true,
    canEdit: false,
    canDelete: true,
    isHidden: false,
    isSelected: false,
    hasKeyboardSelection: false,
    showToolbarForSelection: false,
    showAvatar: false,
    showReactionPicker: false,
    setShowReactionPicker: vi.fn(),
    showMoreMenu: false,
    setShowMoreMenu: vi.fn(),
  }

  beforeEach(() => {
    vi.clearAllMocks()
  })

  describe('Rendering', () => {
    it('should render quick reaction emojis', () => {
      render(<MessageToolbar {...defaultProps} />)

      expect(screen.getByLabelText('React with 👍')).toBeInTheDocument()
      expect(screen.getByLabelText('React with ❤️')).toBeInTheDocument()
      expect(screen.getByLabelText('React with 😂')).toBeInTheDocument()
    })

    it('should render more reactions button', () => {
      render(<MessageToolbar {...defaultProps} />)

      expect(screen.getByTestId('icon-smile-plus')).toBeInTheDocument()
    })

    it('should render reply button when canReply is true', () => {
      render(<MessageToolbar {...defaultProps} canReply={true} />)

      expect(screen.getByTestId('icon-reply')).toBeInTheDocument()
    })

    it('should not render reply button when canReply is false', () => {
      render(<MessageToolbar {...defaultProps} canReply={false} />)

      expect(screen.queryByTestId('icon-reply')).not.toBeInTheDocument()
    })

    it('should render edit button when canEdit is true', () => {
      render(<MessageToolbar {...defaultProps} canEdit={true} />)

      expect(screen.getByTestId('icon-pencil')).toBeInTheDocument()
    })

    it('should not render edit button when canEdit is false', () => {
      render(<MessageToolbar {...defaultProps} canEdit={false} />)

      expect(screen.queryByTestId('icon-pencil')).not.toBeInTheDocument()
    })

    it('should render disabled forward button', () => {
      render(<MessageToolbar {...defaultProps} />)

      const forwardButton = screen.getByTestId('icon-forward').closest('button')
      expect(forwardButton).toBeDisabled()
    })

    it('should render more options button', () => {
      render(<MessageToolbar {...defaultProps} />)

      expect(screen.getByTestId('icon-more')).toBeInTheDocument()
    })
  })

  describe('Quick Reactions', () => {
    it('should call onReaction when quick reaction is clicked', () => {
      const onReaction = vi.fn()
      render(<MessageToolbar {...defaultProps} onReaction={onReaction} />)

      fireEvent.click(screen.getByLabelText('React with 👍'))

      expect(onReaction).toHaveBeenCalledWith('👍')
    })

    it('should highlight reactions the user has already used', () => {
      render(<MessageToolbar {...defaultProps} myReactions={['👍', '❤️']} />)

      const thumbsUp = screen.getByLabelText('React with 👍')
      const heart = screen.getByLabelText('React with ❤️')
      const laugh = screen.getByLabelText('React with 😂')

      expect(thumbsUp).toHaveClass('bg-fluux-brand/20')
      expect(heart).toHaveClass('bg-fluux-brand/20')
      expect(laugh).not.toHaveClass('bg-fluux-brand/20')
    })
  })

  describe('Emoji Reaction Picker', () => {
    it('should show emoji picker when showReactionPicker is true', async () => {
      render(<MessageToolbar {...defaultProps} showReactionPicker={true} />)

      expect(await screen.findByTestId('emoji-picker')).toBeInTheDocument()
    })

    it('should not show emoji picker when showReactionPicker is false', () => {
      render(<MessageToolbar {...defaultProps} showReactionPicker={false} />)

      expect(screen.queryByTestId('emoji-picker')).not.toBeInTheDocument()
    })

    it('should toggle picker when more reactions button clicked', () => {
      const setShowReactionPicker = vi.fn()
      render(
        <MessageToolbar
          {...defaultProps}
          showReactionPicker={false}
          setShowReactionPicker={setShowReactionPicker}
        />
      )

      const moreReactionsButton = screen.getByLabelText('chat.moreReactions')
      fireEvent.click(moreReactionsButton)

      expect(setShowReactionPicker).toHaveBeenCalledWith(true)
    })

    it('should call onReaction and close picker when emoji selected', async () => {
      const onReaction = vi.fn()
      const setShowReactionPicker = vi.fn()
      render(
        <MessageToolbar
          {...defaultProps}
          onReaction={onReaction}
          showReactionPicker={true}
          setShowReactionPicker={setShowReactionPicker}
        />
      )

      const selectButton = await screen.findByTestId('emoji-picker-select')
      fireEvent.click(selectButton)

      expect(onReaction).toHaveBeenCalledWith('🎉')
      expect(setShowReactionPicker).toHaveBeenCalledWith(false)
    })
  })

  describe('Reply', () => {
    it('should call onReply when reply button clicked', () => {
      const onReply = vi.fn()
      render(<MessageToolbar {...defaultProps} canReply={true} onReply={onReply} />)

      fireEvent.click(screen.getByLabelText('chat.reply'))

      expect(onReply).toHaveBeenCalled()
    })
  })

  describe('Edit', () => {
    it('should call onEdit when edit button clicked', () => {
      const onEdit = vi.fn()
      render(<MessageToolbar {...defaultProps} canEdit={true} onEdit={onEdit} />)

      fireEvent.click(screen.getByLabelText('chat.editMessage'))

      expect(onEdit).toHaveBeenCalled()
    })
  })

  describe('More Options Menu', () => {
    it('should show menu when showMoreMenu is true and canDelete', () => {
      render(
        <MessageToolbar
          {...defaultProps}
          canDelete={true}
          showMoreMenu={true}
        />
      )

      expect(screen.getByText('chat.deleteMessage')).toBeInTheDocument()
    })

    it('should not show menu when showMoreMenu is false', () => {
      render(
        <MessageToolbar
          {...defaultProps}
          canDelete={true}
          showMoreMenu={false}
        />
      )

      expect(screen.queryByText('chat.deleteMessage')).not.toBeInTheDocument()
    })

    it('should toggle menu when more button clicked', () => {
      const setShowMoreMenu = vi.fn()
      render(
        <MessageToolbar
          {...defaultProps}
          canDelete={true}
          showMoreMenu={false}
          setShowMoreMenu={setShowMoreMenu}
        />
      )

      fireEvent.click(screen.getByLabelText('chat.moreOptions'))

      expect(setShowMoreMenu).toHaveBeenCalledWith(true)
    })

    it('should disable more button when canDelete is false', () => {
      render(<MessageToolbar {...defaultProps} canDelete={false} />)

      const moreButton = screen.getByLabelText('chat.moreOptions')
      expect(moreButton).toBeDisabled()
    })

    it('should call onDelete and close menu when delete clicked', () => {
      const onDelete = vi.fn()
      const setShowMoreMenu = vi.fn()
      render(
        <MessageToolbar
          {...defaultProps}
          canDelete={true}
          showMoreMenu={true}
          onDelete={onDelete}
          setShowMoreMenu={setShowMoreMenu}
        />
      )

      fireEvent.click(screen.getByText('chat.deleteMessage'))

      expect(onDelete).toHaveBeenCalled()
      expect(setShowMoreMenu).toHaveBeenCalledWith(false)
    })
  })

  describe('Visibility', () => {
    it('should be hidden when isHidden is true', () => {
      const { container } = render(<MessageToolbar {...defaultProps} isHidden={true} />)

      const toolbar = container.firstChild as HTMLElement
      expect(toolbar).toHaveClass('opacity-0')
      expect(toolbar).toHaveClass('pointer-events-none')
    })

    it('should be visible when picker or menu is open', () => {
      const { container } = render(
        <MessageToolbar {...defaultProps} showReactionPicker={true} />
      )

      const toolbar = container.firstChild as HTMLElement
      expect(toolbar).toHaveClass('opacity-100')
    })

    it('should be visible when selected and showToolbarForSelection', () => {
      const { container } = render(
        <MessageToolbar
          {...defaultProps}
          isSelected={true}
          showToolbarForSelection={true}
        />
      )

      const toolbar = container.firstChild as HTMLElement
      expect(toolbar).toHaveClass('opacity-100')
    })

    it('should be hidden when hasKeyboardSelection but not selected', () => {
      const { container } = render(
        <MessageToolbar
          {...defaultProps}
          hasKeyboardSelection={true}
          isSelected={false}
        />
      )

      const toolbar = container.firstChild as HTMLElement
      expect(toolbar).toHaveClass('opacity-0')
      expect(toolbar).not.toHaveClass('pointer-events-none')
    })

    it('should show on hover when no keyboard selection', () => {
      const { container } = render(
        <MessageToolbar {...defaultProps} hasKeyboardSelection={false} />
      )

      const toolbar = container.firstChild as HTMLElement
      expect(toolbar).toHaveClass('group-hover:opacity-100')
    })
  })

  describe('Positioning', () => {
    it('should position differently when showAvatar is true', () => {
      const { container } = render(
        <MessageToolbar {...defaultProps} showAvatar={true} />
      )

      // Outer hover zone has extended positioning to provide larger hit area
      const toolbar = container.firstChild as HTMLElement
      expect(toolbar).toHaveClass('-top-7')
    })

    it('should position normally when showAvatar is false', () => {
      const { container } = render(
        <MessageToolbar {...defaultProps} showAvatar={false} />
      )

      // Outer hover zone has extended positioning to provide larger hit area
      const toolbar = container.firstChild as HTMLElement
      expect(toolbar).toHaveClass('-top-12')
    })
  })
})
